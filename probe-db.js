const { Database } = require('@duckdb/node-api');
(async () => {
  const db = new Database('/home/ubuntu/freebooks.duckdb');
  const conn = await db.connect();
  const companies = await conn.runAndReadAll(
    'SELECT company_id, company_name, jurisdiction, currency FROM companies ORDER BY created_at DESC LIMIT 20'
  ).then(r => r.getRowObjects());
  console.log('COMPANIES:', JSON.stringify(companies, null, 2));

  // Foreign-currency journal entries (non-home currency) joined to accounts
  const fxBal = await conn.runAndReadAll(
    `SELECT je.company_id, je.account_code, a.account_type, a.account_name, je.currency,
            SUM(je.debit - je.credit) AS foreign_balance
     FROM journal_entries je
     JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
     WHERE je.currency IS NOT NULL AND je.currency != ''
     GROUP BY je.company_id, je.account_code, a.account_type, a.account_name, je.currency
     HAVING SUM(je.debit - je.credit) != 0
     LIMIT 40`
  ).then(r => r.getRowObjects());
  console.log('FX_BALANCES:', JSON.stringify(fxBal, null, 2));

  // FX rates present
  const rates = await conn.runAndReadAll(
    'SELECT DISTINCT from_currency, to_currency, date FROM fx_rates ORDER BY date DESC LIMIT 20'
  ).then(r => r.getRowObjects());
  console.log('RATES:', JSON.stringify(rates, null, 2));

  // Sample company COA account types
  if (companies.length) {
    const co = companies[0].company_id;
    const types = await conn.runAndReadAll(
      `SELECT account_type, COUNT(*) AS n, MIN(account_code) AS sample FROM accounts WHERE company_id = ? GROUP BY account_type ORDER BY account_type`,
      [co]
    ).then(r => r.getRowObjects());
    console.log('COA_TYPES[' + co + ']:', JSON.stringify(types));
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
