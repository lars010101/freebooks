'use strict';
const { makeQuery, commonStyle } = require('./common');

async function handleIndex(req, res) {
  const query = makeQuery();
  try {
    const companies = await query(
      `SELECT DISTINCT company_id, company_name FROM companies ORDER BY company_name`
    );
    if (companies.length === 0) {
      return res.redirect(302, '/setup/new-company');
    }
    const html = buildIndexRedirectPage(companies);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function buildIndexRedirectPage(companies) {
  const companiesJson = JSON.stringify(companies.map(c => c.company_id));
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
    <p class="sub">Redirecting…</p>
  </div>
</div>
<script>
  (function() {
    var companies = ${companiesJson};
    var saved = localStorage.getItem('freebooks_company');
    var target = (saved && companies.indexOf(saved) !== -1) ? saved : companies[0];
    if (target) { window.location.replace('/' + target); }
  })();
</script>
</body>
</html>`;
}

module.exports = { handleIndex };
