'use strict';
const { makeQuery, commonStyle } = require('./common');

async function handleIndex(req, res) {
  const query = makeQuery();
  try {
    // v_companies_latest, not the raw table — companies is append-versioned
    // (a settings edit inserts a fresh row rather than updating in place),
    // so a plain SELECT DISTINCT company_id, company_name would list a
    // renamed company once per name it's ever had (DISTINCT dedupes the
    // pair, not the company), not once with its current name.
    const companies = await query(
      `SELECT company_id, company_name FROM v_companies_latest ORDER BY company_name`
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
