'use strict';
const { makeQuery, commonStyle } = require('./common');

async function handleIndex(req, res) {
  const query = makeQuery();
  try {
    const companies = await query(
      `SELECT DISTINCT company_id, company_name FROM companies ORDER BY company_name`
    );
    const html = buildIndexPage(companies);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function buildIndexPage(companies) {
  const links = companies.map(c =>
    `<li><a href="/${c.company_id}">${c.company_name} <span class="id">(${c.company_id})</span></a></li>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>freeBooks</title>
${commonStyle()}
</head>
<body>
<div class="page">
  <div class="header">
    <h1>📒 freeBooks</h1>
    <p class="sub">Select a company to view reports</p>
  </div>
  <ul class="company-list">
    ${links || '<li><em>No companies found.</em></li>'}
  </ul>
  <div style="margin-top:24px">
    <a href="/setup/new-company" class="btn-primary" style="display:inline-block;text-decoration:none">+ New Company</a>
  </div>
</div>
</body>
</html>`;
}

module.exports = { handleIndex };
