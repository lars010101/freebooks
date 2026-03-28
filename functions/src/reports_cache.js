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
  const fyStart = (fyRows[0] && fyRows[0].fy_start) ? fyRows[0].fy_start : '01-01';
  const startMonth = parseInt(fyStart.split('-')[0], 10);
  const startDay = parseInt(fyStart.split('-')[1], 10);

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

    const monthStr = row.yyyy_mm;
    const d = new Date(row.date.value);
    
    let fyStr;
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const day = d.getDate();
    if (month > startMonth || (month === startMonth && day >= startDay)) {
      fyStr = `FY${year}`;
    } else {
      fyStr = `FY${year - 1}`;
    }

    periods.add(monthStr);
    fyPeriods.add(fyStr);

    balancesByAccount[acct][monthStr] = (balancesByAccount[acct][monthStr] || 0) + row.balance;
    balancesByAccount[acct][fyStr] = (balancesByAccount[acct][fyStr] || 0) + row.balance;
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
    const rowData = [
      a.account_code, a.account_name, a.account_type, a.account_subtype, 
      a.pl_category, a.bs_category, a.cf_category
    ];

    sortedFYs.forEach(fy => rowData.push(bals[fy] || 0));
    sortedMonths.forEach(m => rowData.push(bals[m] || 0));
    rows.push(rowData);
  });

  return {
    queryKey: '_CACHE_BALANCES',
    columns: headers,
    rows: rows
  };
}

module.exports = { buildAccountBalancesCache };
