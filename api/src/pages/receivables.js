'use strict';
const { commonStyle, navBar, layoutEnd } = require('./common');

async function handleReceivablesPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildReceivablesPage(company));
}

function buildReceivablesPage(company) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Receivables — freeBooks</title>
${commonStyle()}
</head>
<body>${navBar(company, 'receivables')}
<div class="page">
  <div class="header">
    <h1>📄 Receivables</h1>
  </div>
  <div style="margin-top:2rem; padding:2rem; background:var(--surface,#fff); border:1px solid var(--border,#e8e8e8); border-radius:0.5rem; text-align:center; color:var(--text-muted,#888);">
    <div style="font-size:2rem; margin-bottom:0.75rem;">🚧</div>
    <div style="font-size:1rem; font-weight:600; color:var(--text); margin-bottom:0.5rem;">Receivables — Coming Soon</div>
    <div style="font-size:0.875rem;">Invoicing, customer management, and AR aging will appear here.</div>
  </div>
</div>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleReceivablesPage };
