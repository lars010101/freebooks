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
  const startDay = fsParts.length === 3 ? fsParts[2] : fsParts[1];

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

  const periods = new Set();
  const fyPeriods = new Set();
  const balancesByAccount = {};

  entries.forEach(row => {
    const acct = row.account_code;
    if (!balancesByAccount[acct]) balancesByAccount[acct] = {};

    const d = new Date(row.date.value);
    const month = d.getMonth() + 1; // 1-12
    const year = d.getFullYear();

    // Period number within FY: P01 = first month of FY
    // ((month - startMonth + 12) % 12) + 1
    const periodNum = ((month - startMonth + 12) % 12) + 1;

    // FY end year: the year when this FY ends
    const fyEndYear = (month >= startMonth) ? year + 1 : year;
    const fyStr = `FY${fyEndYear}`;

    // Month label in YYYYPnn format — year is the FY end year
    const periodStr = `${fyEndYear}P${String(periodNum).padStart(2, '0')}`;

    periods.add(periodStr);
    fyPeriods.add(fyStr);

    const bal = Number(row.balance?.value !== undefined ? row.balance.value : row.balance) || 0;

    balancesByAccount[acct][periodStr] = (balancesByAccount[acct][periodStr] || 0) + bal;
    balancesByAccount[acct][fyStr] = (balancesByAccount[acct][fyStr] || 0) + bal;
  });

  const sortedMonths = Array.from(periods).sort();
  const sortedFYs = Array.from(fyPeriods).sort();

  const headers = [
    'Account Code', 'Account Name', 'Type', 'Subtype', 'PL Category', 'BS Category', 'CF Category',
    ...sortedFYs, ...sortedMonths
  ];

  const rows = [];
  accounts.forEach(a => {
    const acctCode = a.account_code;
    const bals = balancesByAccount[acctCode] || {};
    const rowObj = {
      'Account Code': a.account_code, 
      'Account Name': a.account_name, 
      'Type': a.account_type, 
      'Subtype': a.account_subtype, 
      'PL Category': a.pl_category, 
      'BS Category': a.bs_category, 
      'CF Category': a.cf_category
    };

    sortedFYs.forEach(fy => { rowObj[fy] = bals[fy] || 0; });
    sortedMonths.forEach(m => { rowObj[m] = bals[m] || 0; });
    rows.push(rowObj);
  });

  return {
    queryKey: '_CACHE_BALANCES',
    columns: headers,
    rows: rows
  };
}

module.exports = { buildAccountBalancesCache };
