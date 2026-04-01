/**
 * Build the _CACHE_BALANCES sheet data.
 *
 * Values are CUMULATIVE: SUM(debit - credit) from inception through end of each period.
 *
 * Calculated (parent/sum) accounts:
 *   Auto-detected by convention: if an account code is a prefix of any longer account code
 *   AND has no journal entries of its own, it is treated as a calculated parent account.
 *   Its value = SUM of all leaf accounts whose code starts with the parent code.
 *   E.g. account "1" = SUM of all accounts starting with "1" (100010, 101220, etc.)
 */
async function buildAccountBalancesCache(ctx) {
  const { dataset, companyId } = ctx;

  const [accounts] = await dataset.query({
    query: `SELECT * FROM (
              SELECT account_code, account_name, account_type, account_subtype, 
                     pl_category, bs_category, cf_category,
                     ROW_NUMBER() OVER(PARTITION BY account_code ORDER BY created_at DESC) as rn
              FROM finance.accounts WHERE company_id = @companyId
            ) WHERE rn = 1 ORDER BY account_code`,
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

  // Step 1: Collect per-period MOVEMENTS
  const periods = new Set();
  const fyPeriods = new Set();
  const movementsByAccount = {};

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

  const sortedMonthsAll = Array.from(periods).sort();
  const sortedFYs = Array.from(fyPeriods).sort();

  // Enforce bounding: all FYxxxx, but limit YYYYP# to trailing 3 full years + current year
  let maxYear = 0;
  sortedFYs.forEach(fy => {
    const y = parseInt(fy.replace('FY', ''), 10);
    if (!isNaN(y) && y > maxYear) maxYear = y;
  });
  
  const cutoffYear = maxYear > 0 ? maxYear - 3 : 0;
  const sortedMonths = sortedMonthsAll.filter(m => {
    const mYear = parseInt(m.substring(0, 4), 10);
    return mYear >= cutoffYear;
  });

  // Step 2: Convert movements to CUMULATIVE balances for leaf accounts
  const cumulativeByAccount = {};

  for (const acct of Object.keys(movementsByAccount)) {
    const movements = movementsByAccount[acct];
    const cumulative = {};

    let fyRunning = 0;
    for (const fy of sortedFYs) {
      fyRunning += movements[fy] || 0;
      cumulative[fy] = fyRunning;
    }

    let monthRunning = 0;
    for (const m of sortedMonthsAll) {
      monthRunning += movements[m] || 0;
      if (sortedMonths.includes(m)) {
        cumulative[m] = monthRunning;
      }
    }

    cumulativeByAccount[acct] = cumulative;
  }

  // Step 3: Auto-detect and resolve calculated (parent) accounts
  // A calculated account is one where:
  //   1. Its code is a prefix of at least one other account's code
  //   2. It has NO journal entries of its own
  const allCodes = accounts.map(a => a.account_code);

  for (const acct of accounts) {
    const code = acct.account_code;
    const hasOwnEntries = movementsByAccount[code] !== undefined;
    const hasChildren = allCodes.some(c => c.startsWith(code) && c !== code);

    if (hasChildren && !hasOwnEntries) {
      // This is a calculated parent — sum all leaf children
      const cumulative = {};

      for (const fy of sortedFYs) {
        let sum = 0;
        for (const childCode of allCodes) {
          if (childCode.startsWith(code) && childCode !== code) {
            const childCum = cumulativeByAccount[childCode];
            if (childCum) sum += childCum[fy] || 0;
          }
        }
        cumulative[fy] = sum;
      }

      for (const m of sortedMonths) {
        let sum = 0;
        for (const childCode of allCodes) {
          if (childCode.startsWith(code) && childCode !== code) {
            const childCum = cumulativeByAccount[childCode];
            if (childCum) sum += childCum[m] || 0;
          }
        }
        cumulative[m] = sum;
      }

      cumulativeByAccount[code] = cumulative;
    }
  }

  // Step 4: Build output
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
