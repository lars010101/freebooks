/**
 * Build the _CACHE_BALANCES sheet data.
 *
 * Values are CUMULATIVE: SUM(debit - credit) from inception through end of each period.
 * This means:
 *   - BS accounts: direct read = balance at period end
 *   - P&L accounts: skuld(FY2026) - skuld(FY2025) = period movement
 *   - CF: same delta approach for movements; direct read for cash positions
 *   - TB: direct read = cumulative balance
 *
 * Period columns:
 *   FY columns (FY2018, FY2019, ...) — cumulative through FY end
 *   Monthly columns (2018P01, 2018P02, ...) — cumulative through month end
 */
async function buildAccountBalancesCache(ctx) {
  const { dataset, companyId } = ctx;

  const [accounts] = await dataset.query({
    query: `SELECT account_code, account_name, account_type, account_subtype, pl_category, bs_category, cf_category 
            FROM finance.accounts WHERE company_id = @companyId ORDER BY account_code`,
    params: { companyId }
  });

  const [fyRows] = await dataset.query({
    query: `SELECT fy_start FROM finance.companies WHERE company_id = @companyId LIMIT 1`,
    params: { companyId }
  });
  const fy_start_raw = fyRows[0]?.fy_start;
  const fyStartStr = String(fy_start_raw?.value || fy_start_raw || '2025-01-01');
  const fsParts = fyStartStr.split('-').map(Number);
  const startMonth = fsParts.length === 3 ? fsParts[1] : fsParts[0];

  const [entries] = await dataset.query({
    query: `
      SELECT account_code, 
             FORMAT_DATE('%Y-%m', date) as yyyy_mm, 
             date,
             SUM(debit - credit) as balance
      FROM finance.journal_entries 
      WHERE company_id = @companyId
      GROUP BY account_code, yyyy_mm, date
    `,
    params: { companyId }
  });

  // Step 1: Collect per-period MOVEMENTS (same as before)
  const periods = new Set();
  const fyPeriods = new Set();
  const movementsByAccount = {};  // account -> { period -> movement }

  entries.forEach(row => {
    const acct = row.account_code;
    if (!movementsByAccount[acct]) movementsByAccount[acct] = {};

    const d = new Date(row.date.value);
    const month = d.getMonth() + 1;
    const year = d.getFullYear();

    const periodNum = ((month - startMonth + 12) % 12) + 1;
    const fyEndYear = (month >= startMonth) ? year + 1 : year;
    const fyStr = `FY${fyEndYear}`;
    const periodStr = `${fyEndYear}P${String(periodNum).padStart(2, '0')}`;

    periods.add(periodStr);
    fyPeriods.add(fyStr);

    const bal = Number(row.balance?.value !== undefined ? row.balance.value : row.balance) || 0;

    movementsByAccount[acct][periodStr] = (movementsByAccount[acct][periodStr] || 0) + bal;
    movementsByAccount[acct][fyStr] = (movementsByAccount[acct][fyStr] || 0) + bal;
  });

  const sortedMonths = Array.from(periods).sort();
  const sortedFYs = Array.from(fyPeriods).sort();

  // Step 2: Convert movements to CUMULATIVE balances
  // For each account, walk through sorted periods and accumulate
  const cumulativeByAccount = {};

  for (const acct of Object.keys(movementsByAccount)) {
    const movements = movementsByAccount[acct];
    const cumulative = {};

    // FY cumulative
    let fyRunning = 0;
    for (const fy of sortedFYs) {
      fyRunning += movements[fy] || 0;
      cumulative[fy] = fyRunning;
    }

    // Monthly cumulative
    let monthRunning = 0;
    for (const m of sortedMonths) {
      monthRunning += movements[m] || 0;
      cumulative[m] = monthRunning;
    }

    cumulativeByAccount[acct] = cumulative;
  }

  // Step 3: Build output
  const headers = [
    'Account Code', 'Account Name', 'Type', 'Subtype', 'PL Category', 'BS Category', 'CF Category',
    ...sortedFYs, ...sortedMonths
  ];

  const rows = [];
  accounts.forEach(a => {
    const acctCode = a.account_code;
    const cum = cumulativeByAccount[acctCode] || {};
    const rowObj = {
      'Account Code': a.account_code, 
      'Account Name': a.account_name, 
      'Type': a.account_type, 
      'Subtype': a.account_subtype, 
      'PL Category': a.pl_category, 
      'BS Category': a.bs_category, 
      'CF Category': a.cf_category
    };

    sortedFYs.forEach(fy => { rowObj[fy] = cum[fy] || 0; });
    sortedMonths.forEach(m => { rowObj[m] = cum[m] || 0; });
    rows.push(rowObj);
  });

  return {
    queryKey: '_CACHE_BALANCES',
    columns: headers,
    rows: rows
  };
}

module.exports = { buildAccountBalancesCache };
