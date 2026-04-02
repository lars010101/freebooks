const fs = require('fs');
let code = fs.readFileSync('functions/src/index.js', 'utf8');

// Add to PERMISSIONS
code = code.replace(
  "'settings.get': 'viewer',",
  "'settings.get': 'viewer',\n  'period.list': 'viewer',\n  'period.save': 'owner',"
);

// Add the handler
const periodHandler = `
  if (action === 'period.list') {
    // We want to return rows showing company_id, company_name, base_currency, period_name, start_date, end_date, locked
    // Left join finance.periods with finance.companies
    const [rows] = await dataset.query({
      query: \\\`
        SELECT 
          c.company_id,
          c.company_name,
          c.base_currency,
          p.period_name as fyxxxx,
          p.start_date,
          p.end_date,
          p.locked
        FROM finance.companies c
        LEFT JOIN finance.periods p ON c.company_id = p.company_id
        ORDER BY c.company_id, p.start_date DESC
      \\\`
    });
    // Format dates cleanly
    const formatted = rows.map(r => ({
      company_id: r.company_id,
      company_name: r.company_name,
      base_currency: r.base_currency,
      fyxxxx: r.fyxxxx || '',
      start_date: r.start_date ? (r.start_date.value || String(r.start_date)) : '',
      end_date: r.end_date ? (r.end_date.value || String(r.end_date)) : '',
      locked: !!r.locked
    }));
    return formatted;
  }
`;

code = code.replace("if (action === 'settings.get') {", periodHandler + "\n  if (action === 'settings.get') {");

fs.writeFileSync('functions/src/index.js', code);
