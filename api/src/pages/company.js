'use strict';
const { makeQuery, commonStyle } = require('./common');

async function handleCompanyPage(req, res) {
  const { company } = req.params;
  const query = makeQuery();
  try {
    const [co] = await query(
      `SELECT company_id, company_name FROM companies WHERE company_id = ? LIMIT 1`,
      [company]
    );
    if (!co) return res.status(404).send(`<h1>Company not found: ${company}</h1>`);

    const periods = await query(
      `SELECT period_name, start_date, end_date, locked
       FROM periods WHERE company_id = ?
       ORDER BY start_date DESC`,
      [company]
    );

    const html = buildCompanyPage(co, periods);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── HTML builders ─────────────────────────────────────────────────────────────
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


function buildCompanyPage(co, periods) {
  const REPORT_TYPES = [
    { id: 'pl',        label: 'Profit & Loss' },
    { id: 'bs',        label: 'Balance Sheet' },
    { id: 'tb',        label: 'Trial Balance' },
    { id: 'gl',        label: 'General Ledger' },
    { id: 'journal',   label: 'Journal' },
    { id: 'cf',        label: 'Cash Flow' },
    { id: 'sce',       label: 'Equity Changes' },
    { id: 'integrity', label: 'Integrity Check' },
  ];

  const toYMD = d => { if (!d) return ''; const dt = (d instanceof Date) ? d : new Date(d); return dt.toISOString().slice(0, 10); };
  const periodOptions = periods.map(p => {
    const s = toYMD(p.start_date);
    const e = toYMD(p.end_date);
    return `<option value="${s}|${e}">${p.period_name}</option>`;
  }).join('\n');

  const FIN_REPORTS = [
    { id: 'pl',  label: 'Profit & Loss' },
    { id: 'bs',  label: 'Balance Sheet' },
    { id: 'cf',  label: 'Cash Flow' },
    { id: 'sce', label: 'Equity Changes' },
  ];
  const AUDIT_REPORTS = [
    { id: 'tb',        label: 'Trial Balance' },
    { id: 'gl',        label: 'General Ledger' },
    { id: 'journal',   label: 'Journal' },
    { id: 'integrity', label: 'Integrity Check' },
  ];
  const finButtons = FIN_REPORTS.map(r =>
    `<button class="report-btn${r.id === 'pl' ? ' active' : ''}" onclick="setReport('${r.id}')">${r.label}</button>`
  ).join('\n');
  const auditButtons = AUDIT_REPORTS.map(r =>
    `<button class="report-btn" onclick="setReport('${r.id}')">${r.label}</button>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${co.company_name} — freeBooks</title>
${commonStyle()}
<style>
  .controls { display: flex; flex-direction: column; gap: 16px; }
  .control-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .label { font-weight: 600; font-size: 10pt; min-width: 155px; color: #555; }
  button { cursor: pointer; padding: 6px 14px; border: 1px solid #ccc; border-radius: 4px;
           background: #f5f5f5; font-size: 10pt; }
  button.active { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
  button:hover:not(.active) { background: #e8e8e8; }
  input[type=date], select { padding: 7px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 10pt; min-height: 34px; }
  .actions { margin-top: 24px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  a.btn-primary { display: inline-block; padding: 10px 24px; background: #1a1a1a; color: #fff;
                   border-radius: 4px; font-size: 11pt; font-weight: 600; text-decoration: none; cursor: pointer; }
  a.btn-primary:hover { background: #333; }
  a.btn-primary[href=''] { pointer-events: none; opacity: 0.4; }
  .btn-secondary { padding: 10px 24px; background: #fff; color: #1a1a1a; border: 2px solid #1a1a1a;
                   border-radius: 4px; font-size: 11pt; font-weight: 600; cursor: pointer; }
  .btn-secondary:hover { background: #f5f5f5; }
  .back { margin-bottom: 16px; }
  .back a { color: #555; text-decoration: none; font-size: 10pt; }
  .back a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="page">
  <div class="back" style="display:flex;justify-content:space-between;align-items:center">
    <a href="/">← All companies</a>
    <a href="/${co.company_id}/settings">⚙ Settings</a>
    <a href="/${co.company_id}/journal/new">✏ New Entry</a>
    <a href="/${co.company_id}/bank/import">🏦 Bank Import</a>
    <a href="/${co.company_id}/payables">📋 Payables</a>
    <a href="/${co.company_id}/bank/reconcile">✓ Reconcile</a>
  </div>
  <div class="header">
    <h1>${co.company_name}</h1>
    <p class="sub">${co.company_id} · freeBooks Reports</p>
  </div>

  <div class="controls">

    <div class="control-row">
      <span class="label">Period</span>
      <select id="periodSelect" onchange="onPeriodSelect()">
        <option value="">— custom —</option>
        ${periodOptions}
      </select>
      <input type="date" id="startDate" oninput="onDateInput()">
      <span>to</span>
      <input type="date" id="endDate" oninput="onDateInput()">
      <span id="step-buttons">
        <button id="step-mom" class="step-btn" onclick="toggleStep('month')">MoM</button>
        <button id="step-yoy" class="step-btn" onclick="toggleStep('fy')">YoY</button>
      </span>
    </div>

    <div class="control-row">
      <span class="label">Financial Statements</span>
      ${finButtons}
    </div>

    <div class="control-row">
      <span class="label">Audit Reports</span>
      ${auditButtons}
    </div>

    <div id="account-filter-row" class="control-row" style="display:none">
      <span class="label">Account filter</span>
      <select id="accountFilter" onchange="updateLink()">
        <option value="">— all accounts —</option>
      </select>
    </div>

    <div class="control-row">
      <span class="label">Format</span>
      <button id="fmt-html" class="active" onclick="setFormat('html')">HTML</button>
      <button id="fmt-csv" onclick="setFormat('csv')">CSV</button>
    </div>

  </div>

  <div class="actions">
    <a id="open-report" class="btn-primary" href="">Open Report</a>
  </div>
</div>

<script>
  var company = '${co.company_id}';
  var reportType = 'pl';
  var formatType = 'html';
  var stepType   = '';

  function setReport(t) {
    reportType = t;
    document.querySelectorAll('.report-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.report-btn').forEach(b => { if (b.textContent.trim() && b.getAttribute('onclick') === "setReport('" + t + "')") b.classList.add('active'); });
    document.getElementById('account-filter-row').style.display = (t === 'journal' || t === 'gl') ? '' : 'none';
    var noMulti = ['sce','tb','gl','journal','integrity'].includes(t);
    var stepRow = document.getElementById('step-buttons');
    if (stepRow) stepRow.style.display = noMulti ? 'none' : '';
    if (noMulti && stepType) { stepType = ''; document.getElementById('step-mom').classList.remove('active'); document.getElementById('step-yoy').classList.remove('active'); }
    updateLink();
  }

  function setFormat(f) {
    formatType = f;
    document.getElementById('fmt-html').classList.toggle('active', f === 'html');
    document.getElementById('fmt-csv').classList.toggle('active',  f === 'csv');
    updateLink();
  }

  function toggleStep(s) {
    stepType = (stepType === s) ? '' : s;
    document.getElementById('step-mom').classList.toggle('active', stepType === 'month');
    document.getElementById('step-yoy').classList.toggle('active', stepType === 'fy');
    updateLink();
  }

  function onPeriodSelect() {
    var val = document.getElementById('periodSelect').value;
    if (!val) return;
    var parts = val.split('|');
    document.getElementById('startDate').value = parts[0];
    document.getElementById('endDate').value   = parts[1];
    updateLink();
  }

  function onDateInput() {
    document.getElementById('periodSelect').value = '';
    updateLink();
  }

  function buildUrl() {
    var s = document.getElementById('startDate').value;
    var e = document.getElementById('endDate').value;
    if (!s || !e) return null;
    var url = '/api/' + company + '/report?type=' + reportType + '&start=' + s + '&end=' + e;
    if (formatType === 'csv') url += '&format=csv';
    if (stepType) url += '&step=' + stepType;
    if (reportType === 'journal' || reportType === 'gl') {
      var acct = document.getElementById('accountFilter').value;
      if (acct) url += '&account=' + acct;
    }
    return url;
  }

  function updateLink() {
    var url = buildUrl();
    document.getElementById('open-report').href = url || '';
  }

  // Pre-fill with most recent period
  ${periods.length > 0 ? (() => {
    const s = toYMD(periods[0].start_date);
    const e = toYMD(periods[0].end_date);
    return `document.getElementById('startDate').value = '${s}';
  document.getElementById('endDate').value   = '${e}';
  document.getElementById('periodSelect').value = '${s}|${e}';
  updateLink();`;
  })() : ''}

  // Populate account filter
  fetch('/api/${co.company_id}/accounts').then(r => r.json()).then(accounts => {
    accounts.sort((a, b) => String(a.account_code).localeCompare(String(b.account_code)));
    var sel = document.getElementById('accountFilter');
    accounts.forEach(a => {
      var opt = document.createElement('option');
      opt.value = a.account_code;
      opt.textContent = a.account_code + ' — ' + a.account_name;
      sel.appendChild(opt);
    });
  }).catch(() => {});
</script>
</body>
</html>`;
}

module.exports = { handleCompanyPage };
