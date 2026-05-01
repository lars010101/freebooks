'use strict';
/**
 * freeBooks — Report HTTP routes (no file writes)
 *
 * Mounts on the Express app:
 *   GET /api/:company/report?type=pl&start=YYYY-MM-DD&end=YYYY-MM-DD[&format=csv][&step=month|year]
 *   GET /api/:company/periods
 *   GET /api/:company/accounts
 */

const path = require('path');
const express = require('express');
const { getDb } = require('./db');
const { renderReport, renderComparative, generatePeriods, generateFiscalPeriods } = require(
  path.resolve(__dirname, '../../reports/render.js')
);

// ── DuckDB query helper (positional params) ───────────────────────────────────
function makeQuery() {
  return function query(sql, params = []) {
    return new Promise((resolve, reject) => {
      const conn = getDb().connect();
      conn.all(sql, ...params, (err, rows) => {
        conn.close();
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  };
}

// ── Route: GET /api/:company/report ──────────────────────────────────────────
async function handleReport(req, res) {
  const { company } = req.params;
  const { type, start, end, format, step, account } = req.query;

  if (!type)  return res.status(400).json({ error: 'Missing ?type=' });
  if (!start) return res.status(400).json({ error: 'Missing ?start=' });
  if (!end)   return res.status(400).json({ error: 'Missing ?end=' });

  const query = makeQuery();

  try {
    let result;

    if (step === 'fy') {
      const fyPeriods = await generateFiscalPeriods(query, company);
      if (!fyPeriods.length) return res.status(400).json({ error: 'No fiscal periods defined for this company' });
      result = await renderComparative(query, company, type, fyPeriods);
    } else if (step === 'month' || step === 'year') {
      const periods = generatePeriods(start, end, step);
      result = await renderComparative(query, company, type, periods);
    } else {
      result = await renderReport(query, company, type, start, end, { account });
    }

    const isCsv = format === 'csv';

    if (isCsv) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}.csv"`);
      return res.send(result.csv);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(result.html);
  } catch (err) {
    console.error('Report error:', err);
    res.status(500).json({ error: err.message || 'Report generation failed' });
  }
}

// ── Route: GET /api/:company/periods ─────────────────────────────────────────
async function handlePeriods(req, res) {
  const { company } = req.params;
  const query = makeQuery();
  try {
    const rows = await query(
      `SELECT period_name, start_date, end_date, locked
       FROM periods WHERE company_id = ?
       ORDER BY start_date DESC`,
      [company]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Route: GET /api/:company/accounts ─────────────────────────────────────────
async function handleAccounts(req, res) {
  const { company } = req.params;
  const query = makeQuery();
  try {
    const rows = await query(
      `SELECT account_code, account_name, account_type, account_subtype,
              cf_category, is_active
       FROM accounts WHERE company_id = ?
       ORDER BY account_code`,
      [company]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Route: GET / — company list ───────────────────────────────────────────────
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

// ── Route: GET /:company — company overview ───────────────────────────────────
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

function commonStyle() {
  return `<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 11pt; color: #1a1a1a; background: #f4f4f4; }
  .page { max-width: 860px; margin: 40px auto; padding: 32px 40px; background: #fff; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
  .header { margin-bottom: 28px; }
  .header h1 { font-size: 20pt; font-weight: 700; }
  .header .sub { color: #666; font-size: 10pt; margin-top: 4px; }
  .company-list { list-style: none; margin-top: 8px; }
  .company-list li { border-bottom: 1px solid #f0f0f0; }
  .company-list a { display: block; padding: 12px 0; color: #1a1a1a; text-decoration: none; font-size: 12pt; }
  .company-list a:hover { color: #555; }
  .company-list .id { font-size: 9pt; color: #999; }
</style>`;
}

// ── Mount on Express app ──────────────────────────────────────────────────────
/**
 * Call this from index.js: mountReportRoutes(app)
 */
function mountReportRoutes(app) {
  app.get('/', handleIndex);
  app.get('/setup/new-company', handleNewCompanyPage);
  app.get('/api/:company/report', handleReport);
  app.get('/api/:company/periods', handlePeriods);
  app.get('/api/:company/accounts', handleAccounts);
  app.get('/api/:company/vat-codes', handleVatCodes);
  app.get('/:company/journal/new', handleJournalNewPage);
  app.get('/:company/bank/import', handleBankImportPage);
  app.get('/:company/bank/reconcile', handleBankReconcilePage);
  app.get('/:company/settings', handleSettingsPage);
  app.get('/:company', handleCompanyPage);
  app.post('/api/admin/query', (req, res, next) => { req.body = req.body || {}; next(); }, handleAdminQuery);
}

// ── Route: GET /api/:company/vat-codes ─────────────────────────────────────────────
async function handleVatCodes(req, res) {
  const { company } = req.params;
  const q = makeQuery();
  try {
    const rows = await q(`SELECT * FROM vat_codes WHERE company_id = ? ORDER BY vat_code`, [company]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Route: GET /:company/settings ──────────────────────────────────────────────
async function handleJournalNewPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildJournalNewPage(company));
}

function buildJournalNewPage(company) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>New Journal Entry — freeBooks</title>
${commonStyle()}
<style>
  table.jv-table { width:100%; border-collapse:collapse; font-size:10pt; }
  table.jv-table th { text-align:left; font-size:9pt; text-transform:uppercase; color:#555; border-bottom:1px solid #ccc; padding:6px 6px; }
  table.jv-table td { padding:3px 4px; border-bottom:1px solid #f0f0f0; vertical-align:middle; }
  table.jv-table input[type=text], table.jv-table input[type=number], table.jv-table select { padding:4px 6px; border:1px solid #ddd; border-radius:3px; font-size:10pt; }
  .header-fields { display:flex; gap:16px; align-items:flex-end; margin-bottom:20px; flex-wrap:wrap; }
  .header-fields label { display:flex; flex-direction:column; gap:3px; font-weight:600; font-size:10pt; color:#555; }
  .header-fields input { padding:7px 10px; border:1px solid #ccc; border-radius:4px; font-size:10pt; }
  .totals { display:flex; gap:24px; margin-top:12px; font-size:10pt; align-items:center; }
  .totals span { font-weight:600; }
  button.btn-primary:disabled { opacity:0.4; cursor:default; }
  .btn-sm.danger { border-color:#cc2222; color:#cc2222; }
  .btn-sm { padding:0 14px; height:32px; font-size:10pt; cursor:pointer; border:1px solid #ccc; border-radius:3px; background:#f5f5f5; }
  .btn-sm:hover { background:#e8e8e8; }
  button.btn-primary { padding:10px 24px; background:#1a1a1a; color:#fff; border:none; border-radius:4px; font-size:11pt; font-weight:600; cursor:pointer; }
  button.btn-primary:hover:not(:disabled) { background:#333; }
</style>
</head>
<body>
<div class="page">
  <div class="back" style="display:flex;justify-content:space-between;align-items:center">
    <a href="/${company}">← Reports</a>
    <a href="/${company}/settings">⚙ Settings</a>
  </div>
  <div class="header" style="display:flex;justify-content:space-between;align-items:flex-start">
    <div>
      <h1 id="jv-mode-title">New Journal Entry</h1>
      <p class="sub">${company}</p>
    </div>
    <button class="btn-sm" id="btn-reversal-mode" onclick="toggleReversalMode()" style="margin-top:8px">⟲ Reversal</button>
  </div>

  <!-- Reversal search panel (hidden by default) -->
  <div id="reversal-panel" style="display:none;margin-bottom:16px;padding:14px;background:#f8f4ff;border:1px solid #c9b8e8;border-radius:6px">
    <div style="font-weight:600;margin-bottom:8px;color:#5a3ea0">Find entry to reverse</div>
    <input type="text" id="reversal-search" placeholder="Search by reference or description…"
      oninput="onReversalSearch(this.value)"
      style="width:400px;padding:7px 10px;border:1px solid #c9b8e8;border-radius:4px;font-size:10pt">
    <div id="reversal-results" style="margin-top:6px;max-height:200px;overflow-y:auto;background:#fff;border:1px solid #ddd;border-radius:4px;display:none"></div>
  </div>

  <div class="header-fields">
    <label>Date <input type="date" id="entry-date"></label>
    <label>Journal <select id="entry-journal" style="width:180px;height:32px;padding:4px 6px"><option value="">— loading —</option></select></label>
    <label>Description <input type="text" id="entry-desc" placeholder="e.g. Salary payment" style="width:240px"></label>
  </div>

  <table class="jv-table">
    <thead>
      <tr>
        <th>Code</th><th>Account Name</th><th class="num">Debit</th><th class="num">Credit</th>
        <th>Line Description</th><th>Tax Code</th><th></th>
      </tr>
    </thead>
    <tbody id="lines-body"></tbody>
  </table>

  <div class="totals">
    <div>Debits: <span id="total-dr">0.00</span></div>
    <div>Credits: <span id="total-cr">0.00</span></div>
    <div>Diff: <span id="total-diff" style="color:#cc2222">0.00</span></div>
  </div>

  <div style="margin-top:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
    <button class="btn-sm" onclick="addLine()">+ Add Line</button>
    <button class="btn-primary" id="btn-post" onclick="postEntry()">Post Entry</button>
    <span id="status-msg" style="font-size:10pt"></span>
  </div>
</div>
<script>
  var COMPANY = '${company}';
  var accountsMap = {};
  var vatCodes = [];

  fetch('/api/' + COMPANY + '/accounts')
    .then(r => r.json())
    .then(rows => { rows.forEach(a => { accountsMap[a.account_code] = a.account_name; }); });

  fetch('/api/' + COMPANY + '/vat-codes')
    .then(r => r.json())
    .then(rows => {
      if (!Array.isArray(rows)) return;
      vatCodes = rows.filter(v => v.is_active !== false);
      document.querySelectorAll('.tax-select').forEach(sel => populateTaxSelect(sel));
    });

  // Load journals into dropdown
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'journals.list', companyId: COMPANY }) })
    .then(r => r.json())
    .then(res => {
      var journals = res.data || res;
      var sel = document.getElementById('entry-journal');
      if (!Array.isArray(journals) || journals.length === 0) {
        sel.innerHTML = '<option value="">— no journals —</option>';
        return;
      }
      sel.innerHTML = '<option value="">— select journal —</option>'
        + journals.map(j => '<option value="'+j.journal_id+'">'+j.code+' — '+j.name+'</option>').join('');
      // Default to MISC if available
      var miscOpt = Array.from(sel.options).find(o => o.text.startsWith('MISC'));
      if (miscOpt) sel.value = miscOpt.value;
    })
    .catch(() => {
      document.getElementById('entry-journal').innerHTML = '<option value="">— unavailable —</option>';
    });

  function populateTaxSelect(sel) {
    var current = sel.value;
    sel.innerHTML = '<option value="">\u2014 none \u2014</option>'
      + vatCodes.map(v => '<option value="'+v.vat_code+'"'+(v.vat_code===current?' selected':'')+'>'+v.vat_code+' \u2014 '+v.description+'</option>').join('');
  }

  // ── Account autocomplete ──────────────────────────────────────────────────
  var acctDropdown = null;
  var acctDropdownTarget = null;

  function getAccountList() {
    return Object.keys(accountsMap).map(code => ({ code, name: accountsMap[code] }));
  }

  function showAcctDropdown(input, matches) {
    hideAcctDropdown();
    if (!matches.length) return;
    var rect = input.getBoundingClientRect();
    var div = document.createElement('div');
    div.id = 'acct-dd';
    div.style.cssText = 'position:fixed;z-index:9999;background:#fff;border:1px solid #ccc;border-radius:4px;'
      + 'box-shadow:0 3px 10px rgba(0,0,0,.15);max-height:220px;overflow-y:auto;min-width:280px;font-size:10pt;'
      + 'top:'+(rect.bottom+2)+'px;left:'+rect.left+'px';
    matches.slice(0, 20).forEach(function(a) {
      var row = document.createElement('div');
      row.style.cssText = 'padding:6px 10px;cursor:pointer;display:flex;gap:10px;align-items:baseline';
      row.innerHTML = '<span style="font-weight:600;color:#333;min-width:70px">'+a.code+'</span>'
        +'<span style="color:#666">'+a.name+'</span>';
      row.onmousedown = function(e) {
        e.preventDefault();
        selectAccount(a.code, a.name, acctDropdownTarget);
      };
      row.onmouseover = function() { row.style.background='#f0f4ff'; };
      row.onmouseout  = function() { row.style.background=''; };
      div.appendChild(row);
    });
    document.body.appendChild(div);
    acctDropdown = div;
    acctDropdownTarget = input;
  }

  function hideAcctDropdown() {
    if (acctDropdown) { acctDropdown.remove(); acctDropdown = null; }
    acctDropdownTarget = null;
  }

  function selectAccount(code, name, input) {
    hideAcctDropdown();
    var tr = input.closest('tr');
    var codeInput = tr.querySelector('.acct-input');
    var nameInput = tr.querySelector('.acct-name-input');
    codeInput.value = code;
    nameInput.value = name;
    codeInput.style.color = '';
    nameInput.style.color = '#555';
  }

  function onCodeInput(input) {
    var q = input.value.trim().toLowerCase();
    if (!q) { hideAcctDropdown(); return; }
    var matches = getAccountList().filter(a =>
      a.code.toLowerCase().startsWith(q) || a.code.toLowerCase().includes(q)
    ).sort((a, b) => a.code.localeCompare(b.code));
    // Sync name field if exact match
    var tr = input.closest('tr');
    var nameInput = tr.querySelector('.acct-name-input');
    if (accountsMap[input.value.trim()]) {
      nameInput.value = accountsMap[input.value.trim()];
      nameInput.style.color = '#555';
    } else {
      nameInput.value = '';
    }
    showAcctDropdown(input, matches);
  }

  function onNameInput(input) {
    var q = input.value.trim().toLowerCase();
    if (!q) { hideAcctDropdown(); return; }
    var matches = getAccountList().filter(a => a.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    showAcctDropdown(input, matches);
  }

  document.addEventListener('click', function(e) {
    if (acctDropdown && !acctDropdown.contains(e.target)) hideAcctDropdown();
  });
  // ──────────────────────────────────────────────────────────────────────────

  function addLine() {
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td><input type="text" class="acct-input" oninput="onCodeInput(this)" onblur="hideAcctDropdown()" style="width:90px" placeholder="101414"></td>'
      +'<td><input type="text" class="acct-name-input" oninput="onNameInput(this)" onblur="hideAcctDropdown()" style="width:160px;color:#555;border:1px solid #ddd;border-radius:3px;padding:3px 6px;font-size:10pt" placeholder="search by name"></td>'
      +'<td><input type="number" class="debit-input" min="0" step="0.01" oninput="updateTotals()" style="width:100px"></td>'
      +'<td><input type="number" class="credit-input" min="0" step="0.01" oninput="updateTotals()" style="width:100px"></td>'
      +'<td><input type="text" class="desc-input" style="width:160px" placeholder="optional"></td>'
      +'<td><select class="tax-select" style="width:120px"><option value="">\u2014 none \u2014</option></select></td>'
      +'<td><button class="btn-sm danger" onclick="this.parentElement.parentElement.remove(); updateTotals()">&times;</button></td>';
    document.getElementById('lines-body').appendChild(tr);
    populateTaxSelect(tr.querySelector('.tax-select'));
    return tr;
  }

  function updateTotals() {
    var dr = 0, cr = 0;
    document.querySelectorAll('#lines-body tr').forEach(tr => {
      dr += parseFloat(tr.querySelector('.debit-input').value || 0);
      cr += parseFloat(tr.querySelector('.credit-input').value || 0);
    });
    document.getElementById('total-dr').textContent = dr.toFixed(2);
    document.getElementById('total-cr').textContent = cr.toFixed(2);
    var diff = Math.round((dr - cr) * 100) / 100;
    var diffEl = document.getElementById('total-diff');
    diffEl.textContent = diff.toFixed(2);
    diffEl.style.color = diff === 0 ? '#2a8a2a' : '#cc2222';
    document.getElementById('btn-post').disabled = diff !== 0;
  }

  function postEntry() {
    var date      = document.getElementById('entry-date').value;
    var journalId = document.getElementById('entry-journal').value;
    var desc      = document.getElementById('entry-desc').value.trim();
    if (!date) { showStatus('Date is required', true); return; }
    if (!journalId) { showStatus('Select a journal', true); return; }

    var lines = Array.from(document.querySelectorAll('#lines-body tr')).map(tr => ({
      date,
      account_code:  tr.querySelector('.acct-input').value.trim(),
      debit:         parseFloat(tr.querySelector('.debit-input').value  || 0),
      credit:        parseFloat(tr.querySelector('.credit-input').value || 0),
      description:   tr.querySelector('.desc-input').value.trim() || desc || null,
      vat_code:      tr.querySelector('.tax-select').value || null,
    })).filter(l => l.account_code && (l.debit > 0 || l.credit > 0));
    // Validate codes
    var badCodes = lines.filter(l => !accountsMap[l.account_code]).map(l => l.account_code);
    if (badCodes.length) { showStatus('Unknown account(s): ' + badCodes.join(', '), true); return; }

    if (lines.length < 2) { showStatus('At least 2 lines required', true); return; }

    document.getElementById('btn-post').disabled = true;
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'journal.post', companyId: COMPANY, journalId, lines }) })
      .then(r => r.json())
      .then(res => {
        var d = res.data || res;
        if (res.error || d.errors) {
          showStatus((d.errors || [res.error]).join('; '), true);
          document.getElementById('btn-post').disabled = false;
        } else {
          showStatus('Posted \u2713  ' + (d.reference || d.batchId), false);
          setTimeout(() => {
            document.getElementById('lines-body').innerHTML = '';
            document.getElementById('entry-desc').value = '';
            addLine(); addLine();
            updateTotals();
            document.getElementById('status-msg').textContent = '';
          }, 2000);
        }
      })
      .catch(e => { showStatus(e.message, true); document.getElementById('btn-post').disabled = false; });
  }

  function showStatus(msg, isErr) {
    var el = document.getElementById('status-msg');
    el.textContent = msg;
    el.style.color = isErr ? '#cc2222' : '#2a8a2a';
  }

  document.getElementById('entry-date').value = new Date().toISOString().slice(0, 10);
  addLine(); addLine();
  updateTotals();

  // ── Reversal mode ──────────────────────────────────────────────────
  var reversalMode = false;
  var reversalSearchTimer = null;

  function toggleReversalMode() {
    reversalMode = !reversalMode;
    document.getElementById('reversal-panel').style.display = reversalMode ? '' : 'none';
    document.getElementById('jv-mode-title').textContent = reversalMode ? 'Reversal Entry' : 'New Journal Entry';
    document.getElementById('btn-reversal-mode').textContent = reversalMode ? '\u2715 Cancel Reversal' : '\u27f2 Reversal';
    document.getElementById('btn-reversal-mode').style.background = reversalMode ? '#f0e8ff' : '';
    if (!reversalMode) {
      document.getElementById('reversal-search').value = '';
      document.getElementById('reversal-results').style.display = 'none';
      document.getElementById('entry-desc').value = '';
      document.getElementById('lines-body').innerHTML = '';
      addLine(); addLine();
      updateTotals();
    }
  }

  function onReversalSearch(q) {
    clearTimeout(reversalSearchTimer);
    var res = document.getElementById('reversal-results');
    if (q.trim().length < 2) { res.style.display = 'none'; return; }
    reversalSearchTimer = setTimeout(function() {
      fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action:'journal.search', companyId: COMPANY, q: q.trim() }) })
        .then(r => r.json())
        .then(function(resp) {
          var rows = resp.data || resp;
          res.innerHTML = '';
          if (!Array.isArray(rows) || !rows.length) {
            res.innerHTML = '<div style="padding:8px 12px;color:#888;font-size:10pt">No matching entries</div>';
            res.style.display = '';
            return;
          }
          rows.forEach(function(r) {
            var d = document.createElement('div');
            d.style.cssText = 'padding:8px 12px;cursor:pointer;border-bottom:1px solid #f0f0f0;font-size:10pt';
            var ref = r.reference || r.batch_id;
            var date = r.date ? String(r.date).slice(0,10) : '';
            d.innerHTML = '<span style="font-weight:600">' + ref + '</span>'
              + '<span style="color:#888;margin-left:10px">' + date + '</span>'
              + (r.description ? '<span style="color:#555;margin-left:10px">' + r.description + '</span>' : '');
            d.onmouseenter = function() { d.style.background='#f0f4ff'; };
            d.onmouseleave = function() { d.style.background=''; };
            d.onclick = function() { loadReversalEntry(r.batch_id, ref); };
            res.appendChild(d);
          });
          res.style.display = '';
        });
    }, 300);
  }

  function loadReversalEntry(batchId, ref) {
    document.getElementById('reversal-results').style.display = 'none';
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'journal.get', companyId: COMPANY, batchId: batchId }) })
      .then(r => r.json())
      .then(function(resp) {
        var lines = resp.data || resp;
        if (!Array.isArray(lines) || !lines.length) { showStatus('Entry not found', true); return; }
        // Set date to today
        var today = new Date();
        var todayStr = today.getFullYear() + '-'
          + String(today.getMonth()+1).padStart(2,'0') + '-'
          + String(today.getDate()).padStart(2,'0');
        var dateEl = document.getElementById('entry-date');
        dateEl.value = '';
        dateEl.value = todayStr;
        dateEl.dispatchEvent(new Event('input'));
        dateEl.dispatchEvent(new Event('change'));
        // Set description
        document.getElementById('entry-desc').value = 'Reversal: ' + ref;
        // Match journal by reference prefix
        var code = ref && ref.includes('/') ? ref.split('/')[0] : '';
        if (code) {
          var jSel = document.getElementById('entry-journal');
          var opt = Array.from(jSel.options).find(o => o.text.startsWith(code + ' '));
          if (opt) jSel.value = opt.value;
        }
        // Clear existing lines and populate reversed
        document.getElementById('lines-body').innerHTML = '';
        lines.forEach(function(l) {
          var tr = addLine();
          var codeIn  = tr.querySelector('.acct-input');
          var nameIn  = tr.querySelector('.acct-name-input');
          var debitIn = tr.querySelector('.debit-input');
          var creditIn = tr.querySelector('.credit-input');
          codeIn.value  = l.account_code || '';
          nameIn.value  = accountsMap[l.account_code] || '';
          // Swap debit ↔ credit
          debitIn.value  = parseFloat(l.credit || 0) || '';
          creditIn.value = parseFloat(l.debit  || 0) || '';
          var descIn = tr.querySelector('.desc-input');
          descIn.value = l.description || '';
        });
        updateTotals();
        showStatus('Reversal loaded — review and post', false);
      })
      .catch(function(e) { showStatus(e.message, true); });
  }
<\/script>
</body>
</html>`;
}

async function handleSettingsPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildSettingsPage(company));
}

// ── Route: GET /setup/new-company ─────────────────────────────────────────────
async function handleNewCompanyPage(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildNewCompanyPage());
}

// ── Route: POST /api/admin/query ──────────────────────────────────────────────
async function handleAdminQuery(req, res) {
  const { sql, params = [] } = req.body || {};
  if (!sql) return res.status(400).json({ error: 'Missing sql' });
  try {
    const q = makeQuery();
    const rows = await q(sql, params);
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Settings page HTML ────────────────────────────────────────────────────────
function buildSettingsPage(company) {
  const cfOptions = ['','Cash','Op-WC','Operating','Tax','Investing','Financing','NonCash','Excluded']
    .map(v => `<option value="${v}">${v || '— none —'}</option>`).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Settings — freeBooks</title>
${commonStyle()}
<style>
  .tabs { display:flex; gap:0; border-bottom:2px solid #1a1a1a; margin-bottom:24px; }
  .tab { padding:8px 20px; cursor:pointer; font-weight:600; font-size:10pt; color:#555; border-bottom:3px solid transparent; margin-bottom:-2px; }
  .tab.active { color:#1a1a1a; border-bottom-color:#1a1a1a; }
  .tab-panel { display:none; }
  .tab-panel.active { display:block; }
  table.edit-table { width:100%; border-collapse:collapse; font-size:10pt; }
  table.edit-table th { text-align:left; font-size:9pt; text-transform:uppercase; color:#555; border-bottom:1px solid #ccc; padding:6px 6px; }
  table.edit-table td { padding:4px 4px; border-bottom:1px solid #f0f0f0; vertical-align:middle; }
  table.edit-table input[type=text], table.edit-table input[type=date], table.edit-table select { width:100%; padding:4px 6px; border:1px solid #ddd; border-radius:3px; font-size:10pt; }
  table.edit-table .ro { background:#f5f5f5; color:#888; padding:4px 6px; border-radius:3px; display:block; }
  .field-row { display:flex; flex-direction:column; gap:4px; margin-bottom:14px; }
  .field-row label { font-weight:600; font-size:10pt; color:#555; }
  .field-row input[type=text], .field-row select { padding:7px 10px; border:1px solid #ccc; border-radius:4px; font-size:10pt; max-width:300px; }
  .msg { margin-top:10px; font-size:10pt; }
  .msg.ok { color:#2a8a2a; }
  .msg.err { color:#cc2222; }
  .search-bar { padding:6px 10px; border:1px solid #ccc; border-radius:4px; font-size:10pt; margin-bottom:12px; width:260px; }
  .btn-sm { padding:0 14px; height:32px; font-size:10pt; cursor:pointer; border:1px solid #ccc; border-radius:3px; background:#f5f5f5; }
  .btn-sm:hover { background:#e8e8e8; }
  .btn-sm.danger { border-color:#cc2222; color:#cc2222; }
  button.btn-primary { padding:10px 24px; background:#1a1a1a; color:#fff; border:none; border-radius:4px; font-size:11pt; font-weight:600; cursor:pointer; }
  button.btn-primary:hover { background:#333; }
</style>
</head>
<body>
<div class="page">
  <div class="back"><a href="/${company}">← Reports</a></div>
  <div class="header">
    <h1>⚙ Settings</h1>
    <p class="sub">${company}</p>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="showTab('periods')">Periods</div>
    <div class="tab" onclick="showTab('company')">Company</div>
    <div class="tab" onclick="showTab('coa')">Chart of Accounts</div>
    <div class="tab" id="tab-vat-label" onclick="showTab('vat')">Tax Codes</div>
    <div class="tab" onclick="showTab('journals')">Journals</div>
    <div class="tab" onclick="showTab('mappings')">Bank Mappings</div>
  </div>

  <!-- PERIODS TAB -->
  <div id="tab-periods" class="tab-panel active">
    <table class="edit-table" id="periods-table">
      <thead><tr><th>Period Name</th><th>Start Date</th><th>End Date</th><th>Locked</th><th></th></tr></thead>
      <tbody id="periods-body"></tbody>
    </table>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
      <button class="btn-sm" onclick="addPeriodRow()">+ Add Period</button>
      <button class="btn-primary" onclick="savePeriods()">Save Periods</button>
      <span id="msg-periods" class="msg"></span>
    </div>
  </div>

  <!-- COMPANY TAB -->
  <div id="tab-company" class="tab-panel">
    <div class="field-row"><label>Company Name</label><input type="text" id="co-name"></div>
    <div class="field-row"><label>Currency</label><input type="text" id="co-currency" maxlength="3" style="max-width:80px"></div>
    <div class="field-row"><label>Jurisdiction</label><input type="text" id="co-jurisdiction" style="max-width:80px"></div>
    <div class="field-row"><label>Tax ID</label><input type="text" id="co-taxid"></div>
    <div class="field-row"><label>Reporting Standard</label><input type="text" id="co-standard"></div>
    <div class="field-row"><label><input type="checkbox" id="co-vat"> VAT / GST Registered</label></div>
    <button class="btn-primary" onclick="saveCompany()">Save</button>
    <span id="msg-company" class="msg"></span>
  </div>

  <!-- COA TAB -->
  <div id="tab-coa" class="tab-panel">
    <input type="text" class="search-bar" id="coa-search" placeholder="Filter by code or name…" oninput="filterCoa()">
    <table class="edit-table" id="coa-table">
      <thead><tr><th>Code</th><th>Account Name</th><th>Type</th><th>Subtype</th><th>CF Category</th><th>Active</th></tr></thead>
      <tbody id="coa-body"></tbody>
    </table>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
      <button class="btn-primary" onclick="saveCoa()">Save COA</button>
      <span id="msg-coa" class="msg"></span>
    </div>
  </div>

  <!-- JOURNALS TAB -->
  <div id="tab-journals" class="tab-panel">
    <table class="edit-table" id="journals-table">
      <thead><tr><th>Code</th><th>Name</th><th style="text-align:center">Active</th><th></th></tr></thead>
      <tbody id="journals-body"></tbody>
    </table>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
      <button class="btn-sm" onclick="addJournalRow()">+ Add Journal</button>
      <button class="btn-primary" onclick="saveJournals()">Save</button>
      <span id="msg-journals" class="msg"></span>
    </div>
    <p style="margin-top:8px;font-size:9pt;color:#888">Journal codes appear in the reference sequence (e.g. MISC/2026/0001). Codes should be short uppercase strings.</p>
  </div>

  <!-- BANK MAPPINGS TAB -->
  <div id="tab-mappings" class="tab-panel">
    <table class="edit-table" id="mappings-table">
      <thead><tr><th>Pattern</th><th>Match</th><th>Offset Account <small style="font-weight:400;color:#888">(expense/income — bank side auto-assigned)</small></th><th>Description Override</th><th>Priority</th><th style="text-align:center">Active</th><th></th></tr></thead>
      <tbody id="mappings-body"></tbody>
    </table>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
      <button class="btn-sm" onclick="addMappingRow()">+ Add Rule</button>
      <button class="btn-primary" onclick="saveMappings()">Save</button>
      <span id="msg-mappings" class="msg"></span>
    </div>
    <p style="margin-top:8px;font-size:9pt;color:#888">Rules are applied in priority order (lower = higher priority). Match types: <em>contains</em>, <em>exact</em>, <em>starts_with</em>, <em>regex</em>.<br>
    Set the <b>offset account</b> (expense for outflows, income for inflows). The bank account is supplied at import time and assigned automatically based on the amount sign.</p>
  </div>

  <!-- VAT/GST CODES TAB -->
  <div id="tab-vat" class="tab-panel">
    <table class="edit-table" id="vat-table">
      <thead><tr><th>Code</th><th>Description</th><th>Rate %</th><th>Input Acct</th><th>Output Acct</th><th>Report Box</th><th style="text-align:center">Rev.Chg</th><th style="text-align:center">Active</th><th></th></tr></thead>
      <tbody id="vat-body"></tbody>
    </table>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
      <button class="btn-sm" onclick="addVatRow()">+ Add Code</button>
      <button class="btn-primary" onclick="saveVat()">Save</button>
      <span id="msg-vat" class="msg"></span>
    </div>
    <p style="margin-top:8px;font-size:9pt;color:#888">Saving replaces all codes. Existing journal entry tax tags on transactions are preserved.</p>
  </div>
</div>

<script>
var COMPANY = '${company}';
var CF_OPTS = ['','Cash','Op-WC','Operating','Tax','Investing','Financing','NonCash','Excluded'];

var VAT_NAMES = { SG:'GST', SE:'VAT' };
function showTab(t) {
  document.querySelectorAll('.tab').forEach((el,i) => el.classList.toggle('active', ['periods','company','coa','vat','journals','mappings'][i]===t));
  document.querySelectorAll('.tab-panel').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-'+t).classList.add('active');
}

function showMsg(id, msg, isErr) {
  var el = document.getElementById(id);
  el.textContent = msg;
  el.className = 'msg ' + (isErr ? 'err' : 'ok');
  if (!isErr) setTimeout(() => { el.textContent = ''; }, 3000);
}

// --- PERIODS ---
function addPeriodRow(p) {
  p = p || {};
  var tr = document.createElement('tr');
  tr.innerHTML = '<td><input type="text" value="' + (p.period_id||'') + '" placeholder="FY2027"></td>'
    + '<td><input type="date" value="' + (p.start_date ? p.start_date.slice(0,10) : '') + '"></td>'
    + '<td><input type="date" value="' + (p.end_date ? p.end_date.slice(0,10) : '') + '"></td>'
    + '<td style="text-align:center"><input type="checkbox"' + (p.locked ? ' checked' : '') + '>' + (p.locked ? ' 🔒' : '') + '</td>'
    + '<td><button class="btn-sm danger" onclick="this.parentElement.parentElement.remove()">✕</button></td>';
  document.getElementById('periods-body').appendChild(tr);
}

function savePeriods() {
  var rows = Array.from(document.querySelectorAll('#periods-body tr')).map(tr => {
    var inputs = tr.querySelectorAll('input');
    return { company_id: COMPANY, period_id: inputs[0].value.trim(), start_date: inputs[1].value, end_date: inputs[2].value, locked: inputs[3].checked };
  }).filter(p => p.period_id && p.start_date && p.end_date);
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'period.save', companyId: COMPANY, periods: rows }) })
    .then(r => r.json()).then(r => { var d = r.data||r; showMsg('msg-periods', r.error||d.error || ('Saved ' + (d.saved||0) + ' periods'), !!(r.error||d.error)); })
    .catch(e => showMsg('msg-periods', e.message, true));
}

fetch('/api/' + COMPANY + '/periods').then(r => r.json()).then(rows => rows.forEach(r => addPeriodRow({ period_id: r.period_name, start_date: r.start_date ? String(r.start_date).slice(0,10) : '', end_date: r.end_date ? String(r.end_date).slice(0,10) : '', locked: r.locked })));

// --- COMPANY ---
fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'company.list', companyId: COMPANY }) })
  .then(r => r.json()).then(res => {
    var rows = (res && res.data) ? res.data : (Array.isArray(res) ? res : []);
    var co = rows.find(c => c.company_id === COMPANY);
    if (co && co.jurisdiction) {
      var vn = VAT_NAMES[co.jurisdiction] || 'Tax';
      document.getElementById('tab-vat-label').textContent = vn + ' Codes';
    }
    if (!co) return;
    document.getElementById('co-name').value = co.company_name || '';
    document.getElementById('co-currency').value = co.base_currency || co.currency || '';
    document.getElementById('co-jurisdiction').value = co.jurisdiction || '';
    document.getElementById('co-taxid').value = co.tax_id || '';
    document.getElementById('co-standard').value = co.reporting_standard || '';
    document.getElementById('co-vat').checked = !!co.vat_registered;
  });

function saveCompany() {
  var co = { company_id: COMPANY, company_name: document.getElementById('co-name').value,
    base_currency: document.getElementById('co-currency').value, jurisdiction: document.getElementById('co-jurisdiction').value,
    tax_id: document.getElementById('co-taxid').value, reporting_standard: document.getElementById('co-standard').value,
    vat_registered: document.getElementById('co-vat').checked };
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'company.save', companyId: COMPANY, companies: [co] }) })
    .then(r => r.json()).then(r => { var d = r.data||r; showMsg('msg-company', r.error||d.error || 'Saved', !!(r.error||d.error)); })
    .catch(e => showMsg('msg-company', e.message, true));
}

// --- COA ---
var coaData = [];
fetch('/api/' + COMPANY + '/accounts').then(r => r.json()).then(rows => {
  coaData = rows;
  renderCoa(rows);
});

function cfSelect(val) {
  return '<select>' + CF_OPTS.map(o => '<option value="'+o+'"'+(o===val?' selected':'')+'>'+( o||'— none —')+'</option>').join('') + '</select>';
}

function renderCoa(rows) {
  document.getElementById('coa-body').innerHTML = rows.map(a => '<tr data-code="'+a.account_code+'">'
    + '<td><span class="ro">'+a.account_code+'</span></td>'
    + '<td><input type="text" value="'+(a.account_name||'').replace(/"/g,'&quot;')+'"></td>'
    + '<td><span class="ro">'+( a.account_type||'')+'</span></td>'
    + '<td><input type="text" value="'+(a.account_subtype||'').replace(/"/g,'&quot;')+'"></td>'
    + '<td>'+cfSelect(a.cf_category||'')+'</td>'
    + '<td style="text-align:center"><input type="checkbox"'+(a.is_active!==false?' checked':'')+'></td>'
    + '</tr>').join('');
}

function filterCoa() {
  var q = document.getElementById('coa-search').value.toLowerCase();
  var filtered = q ? coaData.filter(a => (a.account_code||'').toLowerCase().includes(q) || (a.account_name||'').toLowerCase().includes(q)) : coaData;
  renderCoa(filtered);
}

function saveCoa() {
  var rows = Array.from(document.querySelectorAll('#coa-body tr')).map(tr => {
    var inputs = tr.querySelectorAll('input[type=text]');
    var sel = tr.querySelector('select');
    var chk = tr.querySelector('input[type=checkbox]');
    return { account_code: tr.dataset.code, account_name: inputs[0].value, account_subtype: inputs[1].value,
      cf_category: sel ? sel.value : '', is_active: chk ? chk.checked : true };
  });
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'coa.save', companyId: COMPANY, accounts: rows }) })
    .then(r => r.json()).then(r => { var d = r.data||r; showMsg('msg-coa', r.error||d.error || ('Saved ' + (d.saved||0) + ' accounts'), !!(r.error||d.error)); })
    .catch(e => showMsg('msg-coa', e.message, true));
}

// --- VAT/GST CODES ---
function addVatRow(v) {
  v = v || {};
  var tr = document.createElement('tr');
  tr.innerHTML =
    '<td><input type="text" value="'+(v.vat_code||'')+'" placeholder="SG9" style="width:70px"></td>'
    +'<td><input type="text" value="'+(v.description||'').replace(/"/g,"&quot;")+'"></td>'
    +'<td><input type="number" value="'+(v.rate!=null?(v.rate*100).toFixed(2):0)+'" step="0.01" min="0" max="100" style="width:65px"></td>'
    +'<td><input type="text" value="'+(v.vat_account_input||'')+'" style="width:65px"></td>'
    +'<td><input type="text" value="'+(v.vat_account_output||'')+'" style="width:65px"></td>'
    +'<td><input type="text" value="'+(v.report_box||'')+'" style="width:55px"></td>'
    +'<td style="text-align:center"><input type="checkbox"'+(v.is_reverse_charge?' checked':'')+' title="Reverse charge"></td>'
    +'<td style="text-align:center"><input type="checkbox"'+(v.is_active!==false?' checked':'')+' title="Active"></td>'
    +'<td><button class="btn-sm danger" onclick="this.parentElement.parentElement.remove()">✕</button></td>';
  document.getElementById('vat-body').appendChild(tr);
}

function saveVat() {
  var rows = Array.from(document.querySelectorAll('#vat-body tr')).map(tr => {
    var inputs = tr.querySelectorAll('input');
    return { vat_code: inputs[0].value.trim(), description: inputs[1].value.trim(),
      rate: parseFloat(inputs[2].value||0)/100, vat_account_input: inputs[3].value.trim()||null,
      vat_account_output: inputs[4].value.trim()||null, report_box: inputs[5].value.trim()||null,
      is_reverse_charge: inputs[6].checked, is_active: inputs[7].checked, effective_from: '2000-01-01' };
  }).filter(v => v.vat_code);
  if (rows.length === 0 && !confirm('No codes defined. This will delete all tax codes. Continue?')) return;
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'vat.codes.save', companyId: COMPANY, vatCodes: rows }) })
    .then(r => r.json())
    .then(r => { var d=r.data||r; showMsg('msg-vat', r.error||d.error||('Saved '+(d.saved||0)+' codes'), !!(r.error||d.error)); })
    .catch(e => showMsg('msg-vat', e.message, true));
}

fetch('/api/'+COMPANY+'/vat-codes').then(r=>r.json()).then(rows=>{ if(Array.isArray(rows)) rows.forEach(addVatRow); });

// --- JOURNALS ---
function addJournalRow(j) {
  j = j || {};
  var tr = document.createElement('tr');
  tr.innerHTML = '<td><input type="text" value="'+(j.code||'')+'" placeholder="MISC" style="width:80px;text-transform:uppercase"></td>'
    + '<td><input type="text" value="'+(j.name||'')+'" placeholder="Miscellaneous"></td>'
    + '<td style="text-align:center"><input type="checkbox"'+(j.active!==false?' checked':'')+' ></td>'
    + '<td><button class="btn-sm danger" onclick="this.parentElement.parentElement.remove()">&times;</button></td>';
  document.getElementById('journals-body').appendChild(tr);
}

function saveJournals() {
  var rows = Array.from(document.querySelectorAll('#journals-body tr')).map(tr => {
    var inputs = tr.querySelectorAll('input');
    var code = inputs[0].value.trim().toUpperCase();
    return { journal_id: COMPANY+'_'+code.toLowerCase(), code: code, name: inputs[1].value.trim(), active: inputs[2].checked };
  }).filter(j => j.code && j.name);
  var saves = rows.map(j => fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'journals.save', companyId: COMPANY, journal: j }) }).then(r => r.json()));
  Promise.all(saves)
    .then(() => showMsg('msg-journals', 'Saved '+rows.length+' journal'+(rows.length===1?'':'s'), false))
    .catch(e => showMsg('msg-journals', e.message, true));
}

fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ action:'journals.list', companyId: COMPANY }) })
  .then(r => r.json()).then(res => { var rows = res.data||res; if(Array.isArray(rows)) rows.forEach(addJournalRow); });

// --- BANK MAPPINGS ---
var MATCH_TYPES = ['contains','exact','starts_with','regex'];
function addMappingRow(m) {
  m = m || {};
  var tr = document.createElement('tr');
  tr.innerHTML = '<td><input type="text" value="'+(m.pattern||'')+'" placeholder="SALARY" style="width:140px"></td>'
    + '<td><select style="width:90px">' + MATCH_TYPES.map(t => '<option'+(t===(m.match_type||'contains')?' selected':'')+'>'+t+'</option>').join('') + '</select></td>'
    + '<td><input type="text" value="'+(m.debit_account||'')+'" placeholder="600001" style="width:80px"></td>'
    + '<td><input type="text" value="'+(m.description_override||'')+'" placeholder="optional" style="width:160px"></td>'
    + '<td><input type="number" value="'+(m.priority||100)+'" style="width:55px"></td>'
    + '<td style="text-align:center"><input type="checkbox"'+(m.is_active!==false?' checked':'')+' ></td>'
    + '<td><button class="btn-sm danger" onclick="this.parentElement.parentElement.remove()">&times;</button></td>';
  document.getElementById('mappings-body').appendChild(tr);
}

function saveMappings() {
  var rows = Array.from(document.querySelectorAll('#mappings-body tr')).map(tr => {
    var inputs = tr.querySelectorAll('input');
    var sel = tr.querySelector('select');
    return { pattern: inputs[0].value.trim(), match_type: sel.value,
      debit_account: inputs[1].value.trim(), credit_account: null,
      description_override: inputs[2].value.trim() || null,
      priority: parseInt(inputs[3].value||100), is_active: inputs[4].checked };
  }).filter(m => m.pattern && m.debit_account);
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'mapping.save', companyId: COMPANY, mappings: rows }) })
    .then(r => r.json()).then(r => { var d=r.data||r; showMsg('msg-mappings', r.error||d.error||('Saved '+(d.saved||0)+' rules'), !!(r.error||d.error)); })
    .catch(e => showMsg('msg-mappings', e.message, true));
}

fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ action:'mapping.list', companyId: COMPANY }) })
  .then(r => r.json()).then(res => { var rows = res.data||res; if(Array.isArray(rows)) rows.forEach(addMappingRow); });
</script>
</body>
</html>`;
}

// ── New Company wizard ────────────────────────────────────────────────────────
function buildNewCompanyPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>New Company — freeBooks</title>
${commonStyle()}
<style>
  .field-row { display:flex; flex-direction:column; gap:4px; margin-bottom:14px; }
  .field-row label { font-weight:600; font-size:10pt; color:#555; }
  .field-row input, .field-row select { padding:7px 10px; border:1px solid #ccc; border-radius:4px; font-size:10pt; max-width:320px; }
  .section-title { font-weight:700; font-size:11pt; margin:20px 0 10px; border-bottom:1px solid #eee; padding-bottom:6px; }
  table.edit-table { width:100%; border-collapse:collapse; font-size:10pt; margin-bottom:10px; }
  table.edit-table th { text-align:left; font-size:9pt; text-transform:uppercase; color:#555; border-bottom:1px solid #ccc; padding:6px; }
  table.edit-table td { padding:4px 6px; border-bottom:1px solid #f0f0f0; }
  table.edit-table input { width:100%; padding:4px 6px; border:1px solid #ddd; border-radius:3px; font-size:10pt; }
  .btn-sm { padding:0 14px; height:32px; font-size:10pt; cursor:pointer; border:1px solid #ccc; border-radius:3px; background:#f5f5f5; }
  .btn-sm.danger { border-color:#cc2222; color:#cc2222; }
  button.btn-primary { padding:10px 24px; background:#1a1a1a; color:#fff; border:none; border-radius:4px; font-size:11pt; font-weight:600; cursor:pointer; }
  button.btn-primary:hover { background:#333; }
  #review { display:none; margin-top:20px; padding:16px; background:#f8f8f8; border-radius:6px; border:1px solid #ddd; }
  .msg { margin-top:10px; font-size:10pt; }
  .msg.err { color:#cc2222; }
</style>
</head>
<body>
<div class="page">
  <div class="back"><a href="/">← All companies</a></div>
  <div class="header"><h1>New Company</h1></div>

  <div class="section-title">Company Details</div>
  <div class="field-row"><label>Company ID <small style="color:#999">(lowercase, underscores only)</small></label><input type="text" id="co-id" placeholder="myco_sg" pattern="[a-z0-9_]+"></div>
  <div class="field-row"><label>Company Name</label><input type="text" id="co-name"></div>
  <div class="field-row"><label>Currency</label><input type="text" id="co-currency" value="SGD" maxlength="3" style="max-width:80px"></div>
  <div class="field-row"><label>Jurisdiction</label>
    <select id="co-jurisdiction" style="max-width:120px">
      <option value="SG">SG — Singapore</option>
      <option value="SE">SE — Sweden</option>
    </select>
  </div>
  <div class="field-row"><label>Tax ID</label><input type="text" id="co-taxid" placeholder="e.g. 201703022E"></div>
  <div class="field-row"><label>Reporting Standard</label><input type="text" id="co-standard" value="SFRS"></div>
  <div class="field-row"><label><input type="checkbox" id="co-vat"> VAT / GST Registered</label></div>

  <div class="section-title">Fiscal Periods</div>
  <table class="edit-table">
    <thead><tr><th>Period Name</th><th>Start Date</th><th>End Date</th><th></th></tr></thead>
    <tbody id="periods-body"></tbody>
  </table>
  <button class="btn-sm" onclick="addRow()">+ Add Period</button>

  <div style="margin-top:24px;display:flex;gap:12px;align-items:center">
    <button class="btn-primary" onclick="showReview()">Review →</button>
  </div>

  <div id="review">
    <div class="section-title" style="margin-top:0">Review</div>
    <div id="review-content"></div>
    <div style="margin-top:16px;display:flex;gap:12px;align-items:center">
      <button class="btn-primary" onclick="createCompany()">Create Company</button>
      <span id="msg" class="msg"></span>
    </div>
  </div>
</div>
<script>
function addRow(p) {
  p = p || {};
  var tr = document.createElement('tr');
  tr.innerHTML = '<td><input type="text" value="'+(p.name||'')+'" placeholder="FY2026"></td>'
    +'<td><input type="date" value="'+(p.start||'')+'" ></td>'
    +'<td><input type="date" value="'+(p.end||'')+'" ></td>'
    +'<td><button class="btn-sm danger" onclick="this.parentElement.parentElement.remove()">✕</button></td>';
  document.getElementById('periods-body').appendChild(tr);
}
addRow();

function getFields() {
  return {
    company_id: document.getElementById('co-id').value.trim(),
    company_name: document.getElementById('co-name').value.trim(),
    currency: document.getElementById('co-currency').value.trim().toUpperCase(),
    jurisdiction: document.getElementById('co-jurisdiction').value,
    tax_id: document.getElementById('co-taxid').value.trim(),
    reporting_standard: document.getElementById('co-standard').value.trim(),
    vat_registered: document.getElementById('co-vat').checked,
  };
}

function getPeriods() {
  return Array.from(document.querySelectorAll('#periods-body tr')).map(tr => {
    var ins = tr.querySelectorAll('input');
    return { name: ins[0].value.trim(), start: ins[1].value, end: ins[2].value };
  }).filter(p => p.name && p.start && p.end);
}

function showReview() {
  var co = getFields();
  var ps = getPeriods();
  if (!co.company_id || !co.company_name) { alert('Company ID and Name are required'); return; }
  document.getElementById('review-content').innerHTML =
    '<p><strong>'+co.company_name+'</strong> ('+co.company_id+')</p>'
    +'<p>'+co.jurisdiction+' · '+co.currency+' · '+co.reporting_standard+'</p>'
    +(co.tax_id ? '<p>Tax ID: '+co.tax_id+'</p>' : '')
    +'<p>'+ps.length+' fiscal period(s) defined</p>'
    +'<p style="color:#555;font-size:9pt">COA and VAT codes will be loaded from the '+co.jurisdiction+' jurisdiction template.</p>';
  document.getElementById('review').style.display = 'block';
}

function createCompany() {
  var co = getFields();
  var ps = getPeriods();
  var msg = document.getElementById('msg');
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'setup.add_company', companyId: co.company_id,
      body: { company: { ...co, fy_start: ps[0]&&ps[0].start, fy_end: ps[ps.length-1]&&ps[ps.length-1].end } } }) })
    .then(r => r.json())
    .then(d => {
      if (d.error) { msg.textContent = d.error; msg.className = 'msg err'; return; }
      if (ps.length === 0) { window.location.href = '/'+co.company_id+'/settings'; return; }
      var periods = ps.map(p => ({ company_id: co.company_id, period_id: p.name, start_date: p.start, end_date: p.end, locked: false }));
      return fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action:'period.save', companyId: co.company_id, periods }) })
        .then(() => { window.location.href = '/'+co.company_id+'/settings'; });
    })
    .catch(e => { msg.textContent = e.message; msg.className = 'msg err'; });
}
</script>
</body>
</html>`;
}

// Keep existing action-based handler for backward compat
const { generateVatReturn } = require('./vat');
async function handleReports(ctx, action) {
  switch (action) {
    case 'report.refresh_ap_aging':   return refreshAPAging(ctx);
    case 'report.refresh_vat_return': return generateVatReturn(ctx);
    default:
      throw Object.assign(new Error(`Unknown report action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

const { query: dbQuery } = require('./db');
async function refreshAPAging(ctx) {
  const { companyId } = ctx;
  const rows = await dbQuery(
    `SELECT vendor, vendor_ref, due_date, amount_home, amount_paid
     FROM bills
     WHERE company_id = @companyId
       AND status != 'paid'
       AND amount_paid < amount_home`,
    { companyId }
  );

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const BUCKET_ORDER = ['Not Yet Due', '0-30 days', '31-60 days', '61-90 days', '91+ days'];
  const bucketsMap = {};

  for (const row of rows) {
    const outstanding = (Number(row.amount_home) || 0) - (Number(row.amount_paid) || 0);
    const dueDate = new Date(String(row.due_date).substring(0, 10) + 'T00:00:00Z');
    const daysPastDue = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
    let label;
    if (daysPastDue < 0) label = 'Not Yet Due';
    else if (daysPastDue <= 30) label = '0-30 days';
    else if (daysPastDue <= 60) label = '31-60 days';
    else if (daysPastDue <= 90) label = '61-90 days';
    else label = '91+ days';
    if (!bucketsMap[label]) bucketsMap[label] = [];
    bucketsMap[label].push({ vendor: row.vendor || '', vendorRef: row.vendor_ref || '', outstanding: Math.round(outstanding * 100) / 100, daysPastDue });
  }
  for (const bills of Object.values(bucketsMap)) bills.sort((a, b) => b.daysPastDue - a.daysPastDue);
  const buckets = BUCKET_ORDER.filter(l => bucketsMap[l]).map(l => {
    const bills = bucketsMap[l];
    const total = Math.round(bills.reduce((s, b) => s + b.outstanding, 0) * 100) / 100;
    return { label: l, total, bills };
  });
  return { report: 'ap_aging', buckets, totalOutstanding: Math.round(buckets.reduce((s, b) => s + b.total, 0) * 100) / 100 };
}

// ── Bank Import page ─────────────────────────────────────────────────────────
async function handleBankImportPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildBankImportPage(company));
}

function buildBankImportPage(company) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Bank Import — ${company}</title>
${commonStyle()}
<style>
  .step { background:#f8f8f8; border:1px solid #e0e0e0; border-radius:6px; padding:14px 18px; margin-bottom:16px; }
  .step h3 { margin:0 0 10px; font-size:11pt; color:#333; }
  table.review-table { width:100%; border-collapse:collapse; font-size:9.5pt; }
  table.review-table th { background:#f0f0f0; padding:5px 7px; text-align:left; font-size:9pt; border:1px solid #ddd; }
  table.review-table td { padding:4px 6px; border:1px solid #eee; vertical-align:middle; }
  table.review-table tr.matched td:first-child { border-left:3px solid #2a8a2a; }
  table.review-table tr.unmatched td:first-child { border-left:3px solid #cc8800; }
  table.review-table tr.skipped td { opacity:.5; }
  .tag { display:inline-block; padding:1px 7px; border-radius:10px; font-size:8.5pt; font-weight:600; }
  .tag.hi  { background:#d4edda; color:#155724; }
  .tag.med { background:#fff3cd; color:#856404; }
  .tag.lo  { background:#f8d7da; color:#721c24; }
  input.acct { width:75px; padding:3px 5px; border:1px solid #ccc; border-radius:3px; font-size:9.5pt; }
  select.col-map { padding:3px 5px; border:1px solid #ccc; border-radius:3px; font-size:9.5pt; }
</style>
</head>
<body>
<div class="page">
  <div class="back" style="display:flex;justify-content:space-between;align-items:center">
    <a href="/${company}">← Reports</a>
    <a href="/${company}/bank/reconcile" style="font-size:9.5pt">✓ Go to Reconciliation</a>
  </div>
  <div class="header"><h1>Bank Statement Import</h1><p class="sub">${company} — Upload a bank statement CSV, review matched entries, then post to the BANK journal.</p></div>

  <!-- Step 1: Upload -->
  <div class="step" id="step1">
    <h3>① Load your bank statement CSV</h3>
    <p style="margin:0 0 10px;font-size:9.5pt;color:#555">Open the CSV in a text editor, select all (Ctrl+A), copy (Ctrl+C), then paste below. Or use the file picker.</p>
    <textarea id="csv-paste" rows="5" style="width:100%;font-family:monospace;font-size:9pt;padding:8px;border:1px solid #ccc;border-radius:4px;resize:vertical" placeholder="Paste CSV content here…"></textarea>
    <div style="display:flex;gap:10px;align-items:center;margin-top:8px">
      <button class="btn-primary" onclick="onPasteLoad()">Load Pasted CSV →</button>
      <span style="color:#888;font-size:9.5pt">or select file:</span>
      <input type="file" id="csv-file" accept=".csv,.txt" onchange="onFileLoad()">
    </div>
    <div id="file-status" style="margin-top:8px;font-size:10pt"></div>
  </div>

  <!-- Step 2: Map columns -->
  <div class="step" id="step2" style="display:none">
    <h3>② Map columns &amp; set bank account</h3>
    <p style="margin:0 0 10px;font-size:9.5pt;color:#555">Confirm which columns contain the date, description, and amounts. Then enter the bank account code this statement is for.</p>
    <table style="border-collapse:collapse;font-size:10pt">
      <tr><td style="padding:5px 14px 5px 0"><b>Date column</b></td><td><select id="col-date" class="col-map"></select></td></tr>
      <tr><td style="padding:5px 14px 5px 0"><b>Description column</b></td><td><select id="col-desc" class="col-map"></select></td></tr>
      <tr><td style="padding:5px 14px 5px 0"><b>Amount type</b></td><td>
        <select id="amt-type" class="col-map" onchange="toggleAmtCols()">
          <option value="single">Single amount column (positive=inflow, negative=outflow)</option>
          <option value="split">Separate Debit / Credit columns</option>
        </select>
      </td></tr>
      <tr id="row-single"><td style="padding:5px 14px 5px 0">&nbsp;&nbsp;Amount column</td><td><select id="col-amt" class="col-map"></select></td></tr>
      <tr id="row-debit" style="display:none"><td style="padding:5px 14px 5px 0">&nbsp;&nbsp;Debit column (outflow/payment)</td><td><select id="col-deb" class="col-map"></select></td></tr>
      <tr id="row-credit" style="display:none"><td style="padding:5px 14px 5px 0">&nbsp;&nbsp;Credit column (inflow/deposit)</td><td><select id="col-cred" class="col-map"></select></td></tr>
      <tr><td style="padding:5px 14px 5px 0"><b>Bank account code</b></td>
        <td><input type="text" id="bank-acct" class="acct" style="width:90px" placeholder="101414">
        <span style="font-size:9pt;color:#888;margin-left:8px">The asset account for this bank</span></td></tr>
    </table>
    <div style="margin-top:14px;display:flex;gap:12px;align-items:center">
      <button class="btn-primary" onclick="parseAndProcess()">Process rows →</button>
      <span id="parse-status" style="font-size:10pt"></span>
    </div>
  </div>

  <!-- Step 3: Review -->
  <div class="step" id="step-review" style="display:none">
    <h3>③ Review &amp; Approve</h3>
    <p style="margin:0 0 10px;font-size:9.5pt;color:#555">Green border = rule-matched. Orange = unmatched (fill in DR/CR accounts manually). Check <b>Skip</b> to exclude a row. Then click <b>Post to Bank Journal</b>.</p>
    <div id="import-summary" style="margin-bottom:10px;font-size:10pt"></div>
    <div id="balance-bar" style="display:none;margin-bottom:12px;padding:10px 14px;background:#f0f4ff;border:1px solid #c0cfe8;border-radius:6px;font-size:10pt;display:flex;gap:28px;align-items:center">
      <span>Book balance before: <b id="bal-before">—</b></span>
      <span>→ net import: <b id="bal-net">—</b></span>
      <span>Book balance after: <b id="bal-after">—</b></span>
    </div>
    <table class="review-table">
      <thead><tr><th style="width:90px">Date</th><th>Description</th><th style="width:85px" class="num">Amount</th><th style="width:80px">Match</th><th style="width:80px">Debit</th><th style="width:80px">Credit</th><th style="text-align:center;width:50px">Skip</th></tr></thead>
      <tbody id="review-body"></tbody>
    </table>
    <div style="margin-top:14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <label style="font-size:10pt">Journal <select id="import-journal" style="height:32px;padding:4px 8px;border:1px solid #ccc;border-radius:4px;font-size:10pt"><option value="">— loading —</option></select></label>
      <button class="btn-primary" onclick="postApproved()">Post to Journal</button>
      <span id="post-status" style="font-size:10pt"></span>
    </div>
  </div>
</div>
<script>
  var COMPANY = '${company}';
  var csvRows = [];
  var headers = [];
  var processedRows = [];
  var accountsMap = {};
  var journalsList = [];

  fetch('/api/' + COMPANY + '/accounts')
    .then(function(r){ return r.json(); })
    .then(function(rows){ rows.forEach(function(a){ accountsMap[a.account_code] = a.account_name; }); });

  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'journals.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); })
    .then(function(res){ journalsList = res.data || res; })
    .catch(function(){});

  function processCSVText(text) {
    var statusEl = document.getElementById('file-status');
    try {
      var lines = text.split(String.fromCharCode(10)).filter(function(l) { return l.trim().length > 0; });
      if (lines.length < 2) { statusEl.style.color='#cc2222'; statusEl.textContent = 'Error: need at least a header row + 1 data row'; return; }
      var firstLine = lines[0];
      var sep = (firstLine.split(';').length > firstLine.split(',').length) ? ';' : ',';
      headers = parseCSVRow(firstLine, sep);
      csvRows = lines.slice(1).map(function(l) { return parseCSVRow(l, sep); }).filter(function(r) { return r.some(function(c) { return c.trim(); }); });
      statusEl.style.color = '#2a8a2a';
      statusEl.textContent = '\u2713 Loaded ' + csvRows.length + ' rows | Columns: ' + headers.join(', ');
      populateColDropdowns();
      document.getElementById('step2').style.display = '';
      document.getElementById('step2').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch(err) {
      statusEl.style.color = '#cc2222';
      statusEl.textContent = 'Error: ' + err.message;
    }
  }

  function onPasteLoad() {
    var text = document.getElementById('csv-paste').value.trim();
    if (!text) { document.getElementById('file-status').textContent = 'Nothing pasted yet'; return; }
    processCSVText(text);
  }

  function onFileLoad() {
    var statusEl = document.getElementById('file-status');
    var file = document.getElementById('csv-file').files[0];
    if (!file) { statusEl.style.color='#cc2222'; statusEl.textContent = 'No file selected'; return; }
    statusEl.style.color = '#888'; statusEl.textContent = 'Reading…';
    var reader = new FileReader();
    reader.onerror = function() { statusEl.style.color='#cc2222'; statusEl.textContent = 'File read error'; };
    reader.onload = function(e) { processCSVText(e.target.result); };
    reader.readAsText(file);
  }

  function parseCSVRow(line, sep) {
    sep = sep || ',';
    var result = [], cur = '', inQ = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (c === '"') { inQ = !inQ; }
      else if (c === sep && !inQ) { result.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    result.push(cur.trim());
    return result;
  }

  var STORAGE_KEY = 'freebooks_import_' + COMPANY;

  function saveImportPrefs() {
    try {
      var prefs = {
        amtType: document.getElementById('amt-type').value,
        bankAcct: document.getElementById('bank-acct').value,
        journalId: document.getElementById('import-journal').value,
        colDate: document.getElementById('col-date').selectedIndex,
        colDesc: document.getElementById('col-desc').selectedIndex,
        colAmt:  document.getElementById('col-amt').selectedIndex,
        colDeb:  document.getElementById('col-deb').selectedIndex,
        colCred: document.getElementById('col-cred').selectedIndex,
        colHeaders: headers.join(',') // only restore if same headers
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch(e) {}
  }

  function restoreImportPrefs() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var prefs = JSON.parse(raw);
      // Only restore column indices if headers match
      if (prefs.colHeaders === headers.join(',')) {
        var ids = ['col-date','col-desc','col-amt','col-deb','col-cred'];
        var saved = [prefs.colDate, prefs.colDesc, prefs.colAmt, prefs.colDeb, prefs.colCred];
        ids.forEach(function(id, i) { if (saved[i] != null) document.getElementById(id).selectedIndex = saved[i]; });
      }
      if (prefs.amtType) { document.getElementById('amt-type').value = prefs.amtType; toggleAmtCols(); }
      if (prefs.bankAcct) document.getElementById('bank-acct').value = prefs.bankAcct;
    } catch(e) {}
  }

  function populateColDropdowns() {
    var ids = ['col-date','col-desc','col-amt','col-deb','col-cred'];
    var guesses = { 'col-date': /date/i, 'col-desc': /desc|narr|ref|detail|memo/i,
      'col-amt': /amount|amt/i, 'col-deb': /debit|dr|withdraw|out/i, 'col-cred': /credit|cr|deposit|in/i };
    ids.forEach(function(id) {
      var sel = document.getElementById(id);
      sel.innerHTML = headers.map(function(h,i){ return '<option value="'+i+'"'+(guesses[id]&&guesses[id].test(h)?' selected':'')+'>'+h+'</option>'; }).join('');
    });
    restoreImportPrefs();
  }

  function toggleAmtCols() {
    var split = document.getElementById('amt-type').value === 'split';
    document.getElementById('row-single').style.display = split ? 'none' : '';
    document.getElementById('row-debit').style.display = split ? '' : 'none';
    document.getElementById('row-credit').style.display = split ? '' : 'none';
  }

  function parseAndProcess() {
    var di = parseInt(document.getElementById('col-date').value);
    var dsi = parseInt(document.getElementById('col-desc').value);
    var bankAcct = document.getElementById('bank-acct').value.trim();
    var split = document.getElementById('amt-type').value === 'split';
    if (!bankAcct) { document.getElementById('parse-status').textContent = 'Bank account required'; return; }

    var bankRows = [];
    csvRows.forEach(function(row) {
      var dateRaw = row[di] || '';
      var desc = row[dsi] || '';
      var amount;
      if (split) {
        var deb = parseFloat((row[parseInt(document.getElementById('col-deb').value)]||'').replace(/,/g,'')) || 0;
        var cred = parseFloat((row[parseInt(document.getElementById('col-cred').value)]||'').replace(/,/g,'')) || 0;
        amount = cred - deb;
      } else {
        amount = parseFloat((row[parseInt(document.getElementById('col-amt').value)]||'').replace(/,/g,'')) || 0;
      }
      if (deb === 0 && cred === 0 && amount === 0) return; // skip balance-only rows
      var date = normalizeDate(dateRaw);
      if (!date) return;
      bankRows.push({ date, description: desc || '(no description)', amount, bankAccount: bankAcct });
    });

    saveImportPrefs();
    var skipped = csvRows.length - bankRows.length;
    if (bankRows.length === 0) {
      document.getElementById('parse-status').textContent = 'No valid rows found (' + csvRows.length + ' rows read, all skipped). Check date column and amount columns.';
      return;
    }
    document.getElementById('parse-status').textContent = 'Processing ' + bankRows.length + ' rows (' + skipped + ' skipped)…';
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'bank.process', companyId: COMPANY, bankAccount: bankAcct, rows: bankRows }) })
      .then(r => r.json()).then(res => {
        var d = res.data || res;
        if (res.error || d.error) { document.getElementById('parse-status').textContent = res.error || d.error; return; }
        processedRows = d.processed || [];
        document.getElementById('parse-status').textContent = '';
        renderReview(d);
        fetchAndShowBalance(bankAcct);
        checkDuplicates(bankAcct, bankRows);
      })
      .catch(e => { document.getElementById('parse-status').textContent = e.message; });
  }

  var MONTHS = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  function normalizeDate(s) {
    if (!s) return null;
    s = s.trim();
    // Try YYYY-MM-DD
    if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) return s;
    // Try YYYYMMDD (e.g. 20260326)
    if (/^[0-9]{8}$/.test(s)) return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8);
    // Try DD Mon YYYY or D Mon YYYY (e.g. 26 Mar 2026, 5 Jan 2026)
    var m = s.match(/^([0-9]{1,2})[ \-]([A-Za-z]{3})[ \-]([0-9]{2,4})$/);
    if (m) {
      var mon = MONTHS[m[2].toLowerCase()];
      if (mon) {
        var yr = m[3].length === 2 ? '20' + m[3] : m[3];
        return yr + '-' + String(mon).padStart(2,'0') + '-' + m[1].padStart(2,'0');
      }
    }
    // Replace slashes/dots with dashes then parse
    s = s.replace(/[\/.]/g, '-');
    var p = s.split('-');
    if (p.length === 3) {
      if (p[0].length === 4) return s; // YYYY-MM-DD
      if (p[2].length === 4) return p[2]+'-'+p[1].padStart(2,'0')+'-'+p[0].padStart(2,'0'); // DD-MM-YYYY
      if (parseInt(p[0]) > 12) return '20'+p[2]+'-'+p[1].padStart(2,'0')+'-'+p[0].padStart(2,'0'); // DD-MM-YY
      return '20'+p[2]+'-'+p[0].padStart(2,'0')+'-'+p[1].padStart(2,'0'); // MM-DD-YY
    }
    return null;
  }

  function renderReview(d) {
    var summary = d.summary || {};
    document.getElementById('import-summary').innerHTML =
      '<b>'+processedRows.length+'</b> rows: '
      + '<span style="color:#2a8a2a">'+(summary.ruleMatched||0)+' rule-matched</span>, '
      + '<span style="color:#856404">'+(summary.billMatched||0)+' bill-matched</span>, '
      + '<span style="color:#cc8800">'+(summary.unmatched||0)+' unmatched</span>';
    document.getElementById('review-body').innerHTML = processedRows.map(function(r, i) {
      var orig = r.original;
      var amt = parseFloat(orig.amount);
      var matchTag = r.matchType === 'rule' ? '<span class="tag hi">rule</span>'
        : r.matchType === 'bill' ? '<span class="tag med">bill</span>'
        : '<span class="tag lo">manual</span>';
      var cls = r.matchType ? 'matched' : 'unmatched';
      return '<tr class="'+cls+'" data-i="'+i+'">'
        +'<td>'+orig.date+'</td>'
        +'<td>'+escHtml(orig.description)+'</td>'
        +'<td class="num" style="color:'+(amt>=0?'#2a8a2a':'#cc2222')+'">'+(amt>=0?'+':'')+fmt(Math.abs(amt))+'</td>'
        +'<td>'+matchTag+'</td>'
        +'<td style="width:90px"><input class="acct" data-field="dr" value="'+(r.debitAccount||'')+'" placeholder="DR acct" oninput="updateAcctName(this)">'
          +'<div style="font-size:8pt;color:#888;margin-top:2px;max-width:86px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">'+(r.debitAccount ? (accountsMap[r.debitAccount]||'?') : '')+'</div></td>'
        +'<td style="width:90px"><input class="acct" data-field="cr" value="'+(r.creditAccount||'')+'" placeholder="CR acct" oninput="updateAcctName(this)">'
          +'<div style="font-size:8pt;color:#888;margin-top:2px;max-width:86px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">'+(r.creditAccount ? (accountsMap[r.creditAccount]||'?') : '')+'</div></td>'
        +'<td style="text-align:center"><input type="checkbox" data-skip="'+i+'" onchange="updateBalances()"></td>'
        +'</tr>';
    }).join('');
    document.getElementById('step-review').style.display = '';
    // Populate journal dropdown now that the element is visible
    var jSel = document.getElementById('import-journal');
    if (Array.isArray(journalsList) && journalsList.length) {
      jSel.innerHTML = journalsList.map(function(j){
        return '<option value="'+j.journal_id+'">'+j.code+' \u2014 '+j.name+'</option>';
      }).join('');
      var bank = journalsList.find(function(j){ return j.code === 'BANK'; });
      if (bank) jSel.value = bank.journal_id;
      try {
        var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        if (saved.journalId) jSel.value = saved.journalId;
      } catch(e) {}
    } else {
      // journals not loaded yet — retry once after short delay
      setTimeout(function(){
        if (Array.isArray(journalsList) && journalsList.length) {
          jSel.innerHTML = journalsList.map(function(j){ return '<option value="'+j.journal_id+'">'+j.code+' \u2014 '+j.name+'</option>'; }).join('');
          var b = journalsList.find(function(j){ return j.code === 'BANK'; });
          if (b) jSel.value = b.journal_id;
        } else {
          jSel.innerHTML = '<option value="">— no journals found —</option>';
        }
      }, 800);
    }
  }

  function checkDuplicates(bankAcct, bankRows) {
    // Build a lookup of date+amount combos already in the ledger for this account
    fetch('/api/admin/query', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ sql: "SELECT date, debit, credit FROM journal_entries WHERE company_id='" + COMPANY + "' AND account_code='" + bankAcct + "'" }) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        var existing = res.data || res.rows || res;
        if (!Array.isArray(existing)) return;
        // Build set of 'date|amount' signatures already in the ledger
        var sigs = new Set();
        existing.forEach(function(e) {
          var net = parseFloat(e.debit||0) - parseFloat(e.credit||0);
          sigs.add(String(e.date).slice(0,10) + '|' + Math.abs(net).toFixed(2));
        });
        var dupCount = 0;
        document.querySelectorAll('#review-body tr').forEach(function(tr, i) {
          var r = processedRows[i];
          if (!r) return;
          var sig = r.original.date + '|' + Math.abs(parseFloat(r.original.amount)).toFixed(2);
          if (sigs.has(sig)) {
            tr.style.opacity = '0.55';
            tr.querySelector('[data-skip]').checked = true;
            var warn = tr.querySelector('.dup-warn');
            if (!warn) {
              var td = tr.querySelector('td');
              var w = document.createElement('div');
              w.className = 'dup-warn';
              w.style.cssText = 'font-size:8pt;color:#856404;font-weight:600';
              w.textContent = 'possible duplicate';
              td.appendChild(w);
            }
            dupCount++;
          }
        });
        if (dupCount > 0) {
          var msg = document.getElementById('import-summary');
          msg.innerHTML += ' &nbsp;<span style="color:#856404;font-weight:600">\u26a0 '+dupCount+' possible duplicate'+(dupCount>1?'s':'')+' pre-skipped — uncheck Skip to include</span>';
          updateBalances();
        }
      }).catch(function(){});
  }

  var bookBalanceBefore = null;

  function fetchAndShowBalance(bankAcct) {
    fetch('/api/admin/query', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ sql: "SELECT COALESCE(SUM(debit)-SUM(credit),0) AS balance FROM journal_entries WHERE company_id='" + COMPANY + "' AND account_code='" + bankAcct.replace(/'/g,\'\') + "'" }) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        var rows = res.data || res.rows || res;
        if (Array.isArray(rows) && rows.length > 0) {
          bookBalanceBefore = parseFloat(rows[0].balance || 0);
          document.getElementById('balance-bar').style.display = 'flex';
          updateBalances();
        }
      }).catch(function(){});
  }

  function updateBalances() {
    if (bookBalanceBefore === null) return;
    var net = 0;
    document.querySelectorAll('#review-body tr').forEach(function(tr, i) {
      var skip = tr.querySelector('[data-skip]').checked;
      if (!skip && processedRows[i]) net += parseFloat(processedRows[i].original.amount || 0);
    });
    var after = bookBalanceBefore + net;
    document.getElementById('bal-before').textContent = fmt(bookBalanceBefore);
    document.getElementById('bal-net').textContent = (net >= 0 ? '+' : '') + fmt(net);
    document.getElementById('bal-net').style.color = net >= 0 ? '#2a8a2a' : '#cc2222';
    document.getElementById('bal-after').textContent = fmt(after);
  }

  function fmt(n) { return parseFloat(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
  function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function updateAcctName(input) {
    var code = input.value.trim();
    var nameDiv = input.nextElementSibling;
    if (!nameDiv) return;
    nameDiv.textContent = code ? (accountsMap[code] || (code.length >= 4 ? '?' : '')) : '';
    nameDiv.style.color = (code && !accountsMap[code] && code.length >= 4) ? '#cc2222' : '#888';
  }

  function postApproved() {
    var entries = [];
    document.querySelectorAll('#review-body tr').forEach(function(tr, i) {
      var skip = tr.querySelector('[data-skip]').checked;
      if (skip) return;
      var r = processedRows[i];
      var dr = tr.querySelector('[data-field=dr]').value.trim();
      var cr = tr.querySelector('[data-field=cr]').value.trim();
      if (!dr || !cr) return;
      entries.push({ date: r.original.date, description: r.description || r.original.description,
        amount: r.original.amount, debitAccount: dr, creditAccount: cr,
        vatCode: r.vatCode || null, billId: r.billId || null });
    });
    if (!entries.length) { document.getElementById('post-status').textContent = 'Nothing to post'; return; }
    var journalId = document.getElementById('import-journal').value;
    if (!journalId) { document.getElementById('post-status').textContent = 'Select a journal first'; return; }
    document.getElementById('post-status').textContent = 'Posting '+entries.length+' entries…';
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'bank.approve', companyId: COMPANY, journalId, entries }) })
      .then(r => r.json()).then(res => {
        var d = res.data || res;
        if (res.error || d.error) { document.getElementById('post-status').textContent = res.error||d.error; return; }
        var n = d.posted || 0, failed = d.failed || 0;
        var jName = document.getElementById('import-journal').options[document.getElementById('import-journal').selectedIndex];
        var jLabel = jName ? jName.text : journalId;
        document.getElementById('step-review').innerHTML =
          '<div style="padding:28px;text-align:center">'
          +'<div style="font-size:28pt;color:#2a8a2a;margin-bottom:10px">&#10003;</div>'
          +'<div style="font-size:14pt;font-weight:700;margin-bottom:8px">Import complete</div>'
          +'<div style="font-size:11pt;color:#555;margin-bottom:24px">'
            +n+' entr'+(n===1?'y':'ies')+' posted to <b>'+escHtml(jLabel)+'</b>.'
            +(failed ? ' <span style="color:#cc2222">'+failed+' failed.</span>' : '')
          +'</div>'
          +'<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">'
            +'<a href="/'+COMPANY+'" style="display:inline-block;padding:10px 22px;background:#1a1a1a;color:#fff;border-radius:4px;font-weight:600;text-decoration:none">&larr; Back to Reports</a>'
            +'<a href="/'+COMPANY+'/bank/import" style="display:inline-block;padding:10px 22px;background:#555;color:#fff;border-radius:4px;font-weight:600;text-decoration:none">Import Another Statement</a>'
          +'</div></div>';
      })
      .catch(e => { document.getElementById('post-status').textContent = e.message; });
  }
<\/script>
</body>
</html>`;
}

// ── Bank Reconcile page ───────────────────────────────────────────────────────
async function handleBankReconcilePage(req, res) {
  const { company } = req.params;
  const q = makeQuery();
  const accounts = await q(
    `SELECT account_code, account_name FROM accounts WHERE company_id = ? AND cf_category = 'Cash' ORDER BY account_code`,
    [company]
  );
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildBankReconcilePage(company, accounts));
}

function buildBankReconcilePage(company, cashAccounts) {
  const acctOptions = cashAccounts.map(a =>
    `<option value="${a.account_code}">${a.account_code} — ${a.account_name}</option>`
  ).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Reconciliation — ${company}</title>
${commonStyle()}
<style>
  table.rec-table { width:100%; border-collapse:collapse; font-size:10pt; }
  table.rec-table th { background:#f0f0f0; padding:6px 8px; text-align:left; font-size:9pt; border:1px solid #ddd; }
  table.rec-table td { padding:5px 7px; border:1px solid #eee; vertical-align:middle; }
  table.rec-table tr.cleared td { color:#888; }
  table.rec-table tr.cleared td:first-child { text-decoration:line-through; }
  .summary-bar { display:flex; gap:24px; padding:12px 16px; background:#f8f8f8; border:1px solid #e0e0e0; border-radius:6px; margin-bottom:16px; font-size:10pt; }
  .summary-bar .lbl { color:#888; font-size:9pt; }
  .summary-bar .val { font-weight:700; font-size:12pt; }
</style>
</head>
<body>
<div class="page">
  <div class="back" style="display:flex;justify-content:space-between;align-items:center">
    <a href="/${company}">← Reports</a>
    <a href="/${company}/bank/import">🏦 Bank Import</a>
  </div>
  <div class="header"><h1>Bank Reconciliation</h1><p class="sub">${company}</p></div>

  <div style="display:flex;gap:12px;align-items:center;margin-bottom:16px;flex-wrap:wrap">
    <label>Account <select id="rec-account" style="width:220px;height:32px;padding:4px 6px">
      ${acctOptions || '<option>No cash accounts found</option>'}
    </select></label>
    <label>From <input type="date" id="rec-from"></label>
    <label>To <input type="date" id="rec-to"></label>
    <button class="btn-primary" onclick="loadReconcile()">Load</button>
  </div>

  <div class="summary-bar" id="rec-summary" style="display:none">
    <div><div class="lbl">Book Balance</div><div class="val" id="sum-book">0.00</div></div>
    <div><div class="lbl">Cleared Balance</div><div class="val" id="sum-cleared">0.00</div></div>
    <div><div class="lbl">Uncleared Items</div><div class="val" id="sum-uncleared">0</div></div>
    <div><div class="lbl">Statement Balance</div><input type="number" id="stmt-balance" step="0.01" placeholder="Enter statement balance" style="width:160px;padding:4px 8px;border:1px solid #ccc;border-radius:3px;font-size:10pt"></div>
    <div><div class="lbl">Difference</div><div class="val" id="sum-diff" style="color:#cc2222">—</div></div>
  </div>

  <table class="rec-table" id="rec-table" style="display:none">
    <thead><tr><th style="width:90px">Date</th><th>Reference</th><th>Description</th><th class="num" style="width:100px">Debit</th><th class="num" style="width:100px">Credit</th><th style="text-align:center;width:70px">Cleared</th></tr></thead>
    <tbody id="rec-body"></tbody>
  </table>
  <div id="rec-status" style="margin-top:10px;font-size:10pt"></div>
</div>
<script>
  var COMPANY = '${company}';
  var recRows = [];

  // Set default date range: current month
  var now = new Date();
  document.getElementById('rec-from').value = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-01';
  document.getElementById('rec-to').value = now.toISOString().slice(0,10);
  document.getElementById('stmt-balance').addEventListener('input', updateSummary);

  function loadReconcile() {
    var accountCode = document.getElementById('rec-account').value;
    var dateFrom = document.getElementById('rec-from').value;
    var dateTo = document.getElementById('rec-to').value;
    if (!accountCode) return;
    document.getElementById('rec-status').textContent = 'Loading…';
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'bank.reconcile.list', companyId: COMPANY, accountCode, dateFrom, dateTo }) })
      .then(r => r.json()).then(res => {
        recRows = res.data || res;
        document.getElementById('rec-status').textContent = '';
        renderReconcile();
      })
      .catch(e => { document.getElementById('rec-status').textContent = e.message; });
  }

  function renderReconcile() {
    var acct = document.getElementById('rec-account').value;
    document.getElementById('rec-summary').style.display = '';
    document.getElementById('rec-table').style.display = '';
    document.getElementById('rec-body').innerHTML = recRows.map(function(r, i) {
      var cls = r.cleared ? 'cleared' : '';
      return '<tr class="'+cls+'" data-i="'+i+'" data-batch="'+r.batch_id+'" data-acct="'+acct+'">'
        +'<td>'+(r.date?String(r.date).slice(0,10):'')+'</td>'
        +'<td>'+(r.reference||r.batch_id||'')+'</td>'
        +'<td>'+(r.description||'')+'</td>'
        +'<td class="num">'+(parseFloat(r.debit||0)?fmt(r.debit):'')+'</td>'
        +'<td class="num">'+(parseFloat(r.credit||0)?fmt(r.credit):'')+'</td>'
        +'<td style="text-align:center"><input type="checkbox"'+(r.cleared?' checked':'')+''
          +' onchange="toggleCleared(this,\''+r.batch_id+'\',\''+acct+'\')" ></td>'
        +'</tr>';
    }).join('');
    updateSummary();
  }

  function toggleCleared(cb, batchId, accountCode) {
    var cleared = cb.checked;
    cb.disabled = true;
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'bank.reconcile.clear', companyId: COMPANY, batchId, accountCode, cleared }) })
      .then(r => r.json()).then(res => {
        cb.disabled = false;
        var tr = cb.closest('tr');
        var i = parseInt(tr.dataset.i);
        recRows[i].cleared = cleared;
        tr.className = cleared ? 'cleared' : '';
        updateSummary();
      })
      .catch(function() { cb.disabled = false; cb.checked = !cleared; });
  }

  function updateSummary() {
    var bookBal = 0, clearedBal = 0, unclearedCount = 0;
    recRows.forEach(function(r) {
      var net = parseFloat(r.debit||0) - parseFloat(r.credit||0);
      bookBal += net;
      if (r.cleared) clearedBal += net; else unclearedCount++;
    });
    document.getElementById('sum-book').textContent = fmt(bookBal);
    document.getElementById('sum-cleared').textContent = fmt(clearedBal);
    document.getElementById('sum-uncleared').textContent = unclearedCount;
    var stmtVal = parseFloat(document.getElementById('stmt-balance').value);
    if (!isNaN(stmtVal)) {
      var diff = stmtVal - clearedBal;
      var el = document.getElementById('sum-diff');
      el.textContent = fmt(diff);
      el.style.color = Math.abs(diff) < 0.01 ? '#2a8a2a' : '#cc2222';
    }
  }

  function fmt(n) { return parseFloat(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
<\/script>
</body>
</html>`;
}

module.exports = { handleReports, mountReportRoutes };
