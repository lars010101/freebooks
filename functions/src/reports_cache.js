/**
 * Build the Period Balances cache sheet.
 *
 * Values are CUMULATIVE: SUM(debit - credit) from inception through the end_date
 * of each defined period. This is computed entirely in BigQuery — no JS-side
 * period matching, so nothing can be missed or double-counted.
 *
 * Calculated (parent/sum) accounts:
 *   Auto-detected by convention: if an account code is a prefix of any longer
 *   account code AND has no journal entries of its own, it is treated as a
 *   calculated parent. Its value = SUM of all leaf accounts whose code starts
 *   with the parent code.
 */
async function buildAccountBalancesCache(ctx) {
  const { dataset, companyId } = ctx;

  // ── 1. Accounts ──────────────────────────────────────────────────────────────
  const [accounts] = await dataset.query({
    query: `
      SELECT account_code, account_name, account_type, account_subtype,
             pl_category, bs_category, cf_category
      FROM (
        SELECT account_code, account_name, account_type, account_subtype,
               pl_category, bs_category, cf_category,
               ROW_NUMBER() OVER(PARTITION BY account_code ORDER BY created_at DESC) AS rn
        FROM finance.accounts
        WHERE company_id = @companyId
      )
      WHERE rn = 1
      ORDER BY account_code
    `,
    params: { companyId }
  });

  // ── 2. Periods ───────────────────────────────────────────────────────────────
  const [periodsRows] = await dataset.query({
    query: `
      SELECT period_name, start_date, end_date
      FROM (
        SELECT period_name, start_date, end_date,
               ROW_NUMBER() OVER (PARTITION BY period_name ORDER BY created_at DESC) AS rn
        FROM finance.periods
        WHERE company_id = @companyId
      )
      WHERE rn = 1
      ORDER BY end_date
    `,
    params: { companyId }
  });

  if (!periodsRows || periodsRows.length === 0) {
    return { queryKey: '_CACHE_BALANCES', columns: ['Account Code','Account Name','Type','Subtype','PL Category','BS Category','CF Category'], rows: [] };
  }

  // ── 3. Cumulative balances via a single cross-join in BigQuery ────────────────
  // For every (account, period) pair, sum all journal entries where
  // date <= period.end_date. This is the one correct definition of
  // "cumulative balance as at end of period".
  const [rawBalances] = await dataset.query({
    query: `
      SELECT
        a.account_code,
        p.period_name,
        COALESCE(SUM(j.debit - j.credit), 0) AS cumulative_balance
      FROM (
        SELECT DISTINCT account_code
        FROM finance.accounts
        WHERE company_id = @companyId
      ) a
      CROSS JOIN (
        SELECT period_name, end_date
        FROM (
          SELECT period_name, end_date,
                 ROW_NUMBER() OVER (PARTITION BY period_name ORDER BY created_at DESC) AS rn
          FROM finance.periods
          WHERE company_id = @companyId
        )
        WHERE rn = 1
      ) p
      LEFT JOIN finance.journal_entries j
        ON  j.company_id   = @companyId
        AND j.account_code = a.account_code
        AND j.date        <= p.end_date
      GROUP BY a.account_code, p.period_name
      ORDER BY a.account_code, p.period_name
    `,
    params: { companyId }
  });

  // ── 4. Pivot into { [acctCode]: { [periodName]: cumulativeBalance } } ─────────
  const leafBalances = {};
  for (const row of rawBalances) {
    const acct = row.account_code;
    const period = row.period_name;
    const bal = Number(
      row.cumulative_balance?.value !== undefined
        ? row.cumulative_balance.value
        : row.cumulative_balance
    ) || 0;
    if (!leafBalances[acct]) leafBalances[acct] = {};
    leafBalances[acct][period] = bal;
  }

  // ── 5. Column order: all periods sorted by end_date (chronological) ──────────
  // periodsRows is already ORDER BY end_date from the query.
  const allPeriodCols = periodsRows.map(p => p.period_name);

  // ── 6. Resolve calculated (parent) accounts ───────────────────────────────────
  const allCodes = accounts.map(a => a.account_code);
  const cumulativeByAccount = { ...leafBalances };

  // Track which accounts have any journal entries of their own
  const hasOwnEntries = new Set(Object.keys(leafBalances).filter(code =>
    Object.values(leafBalances[code]).some(v => v !== 0)
  ));

  for (const acct of accounts) {
    const code = acct.account_code;
    const hasChildren = allCodes.some(c => c.startsWith(code) && c !== code);

    if (hasChildren && !hasOwnEntries.has(code)) {
      // Calculated parent: sum leaf children
      const cumulative = {};
      for (const period of allPeriodCols) {
        let sum = 0;
        for (const childCode of allCodes) {
          if (childCode.startsWith(code) && childCode !== code) {
            sum += (cumulativeByAccount[childCode]?.[period] || 0);
          }
        }
        cumulative[period] = sum;
      }
      cumulativeByAccount[code] = cumulative;
    }
  }

  // ── 7. Build output ───────────────────────────────────────────────────────────
  const headers = [
    'Account Code', 'Account Name', 'Type', 'Subtype',
    'PL Category', 'BS Category', 'CF Category',
    ...allPeriodCols
  ];

  const rows = accounts.map(a => {
    const code = a.account_code;
    const cum = cumulativeByAccount[code] || {};
    const rowObj = {
      'Account Code':  code,
      'Account Name':  a.account_name,
      'Type':          a.account_type,
      'Subtype':       a.account_subtype,
      'PL Category':   a.pl_category,
      'BS Category':   a.bs_category,
      'CF Category':   a.cf_category,
    };
    for (const period of allPeriodCols) {
      rowObj[period] = cum[period] ?? 0;
    }
    return rowObj;
  });

  return {
    queryKey: '_CACHE_BALANCES',
    columns: headers,
    rows,
  };
}

module.exports = { buildAccountBalancesCache };
