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
const { getDb } = require('./db');
const { renderReport, renderComparative, generatePeriods } = require(
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
  const { type, start, end, format, step } = req.query;

  if (!type)  return res.status(400).json({ error: 'Missing ?type=' });
  if (!start) return res.status(400).json({ error: 'Missing ?start=' });
  if (!end)   return res.status(400).json({ error: 'Missing ?end=' });

  const query = makeQuery();

  try {
    let result;

    if (step === 'month' || step === 'year') {
      const periods = generatePeriods(start, end, step);
      result = await renderComparative(query, company, type, periods);
    } else {
      result = await renderReport(query, company, type, start, end);
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
              pl_category, bs_category, cf_category, is_active
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

  const fyLinks = periods.map(p => {
    const s = p.start_date ? String(p.start_date).slice(0, 10) : '';
    const e = p.end_date   ? String(p.end_date).slice(0, 10)   : '';
    return `<button class="period-btn" onclick="setPeriod('${s}','${e}')">${p.period_name}</button>`;
  }).join('\n');

  const reportButtons = REPORT_TYPES.map(r =>
    `<button class="report-btn${r.id === 'pl' ? ' active' : ''}" onclick="setReport('${r.id}')">${r.label}</button>`
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
  .label { font-weight: 600; font-size: 10pt; min-width: 110px; color: #555; }
  button { cursor: pointer; padding: 6px 14px; border: 1px solid #ccc; border-radius: 4px;
           background: #f5f5f5; font-size: 10pt; }
  button.active { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
  button:hover:not(.active) { background: #e8e8e8; }
  input[type=date] { padding: 5px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 10pt; }
  .actions { margin-top: 24px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .btn-primary { padding: 10px 24px; background: #1a1a1a; color: #fff; border: none;
                 border-radius: 4px; font-size: 11pt; font-weight: 600; cursor: pointer; }
  .btn-primary:hover { background: #333; }
  .btn-secondary { padding: 10px 24px; background: #fff; color: #1a1a1a; border: 2px solid #1a1a1a;
                   border-radius: 4px; font-size: 11pt; font-weight: 600; cursor: pointer; }
  .btn-secondary:hover { background: #f5f5f5; }
  .report-link { font-size: 9pt; color: #555; word-break: break-all; }
  .back { margin-bottom: 16px; }
  .back a { color: #555; text-decoration: none; font-size: 10pt; }
  .back a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="page">
  <div class="back"><a href="/">← All companies</a></div>
  <div class="header">
    <h1>${co.company_name}</h1>
    <p class="sub">${co.company_id} · freeBooks Reports</p>
  </div>

  <div class="controls">

    <div class="control-row">
      <span class="label">Period shortcuts</span>
      ${fyLinks || '<em>No periods defined</em>'}
    </div>

    <div class="control-row">
      <span class="label">Date range</span>
      <input type="date" id="startDate" oninput="updateLink()">
      <span>to</span>
      <input type="date" id="endDate" oninput="updateLink()">
    </div>

    <div class="control-row">
      <span class="label">Report type</span>
      ${reportButtons}
    </div>

    <div class="control-row">
      <span class="label">Format</span>
      <button id="fmt-html" class="active" onclick="setFormat('html')">HTML</button>
      <button id="fmt-csv" onclick="setFormat('csv')">CSV</button>
    </div>

    <div class="control-row">
      <span class="label">Multi-period</span>
      <button id="step-none" class="active" onclick="setStep('')">None</button>
      <button id="step-month" onclick="setStep('month')">By Month</button>
      <button id="step-year" onclick="setStep('year')">By Year</button>
    </div>

  </div>

  <div class="actions">
    <button class="btn-primary" onclick="openReport()">Open Report</button>
    <button class="btn-secondary" onclick="copyLink()">Copy Link</button>
    <div id="link-preview" class="report-link"></div>
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
    updateLink();
  }

  function setFormat(f) {
    formatType = f;
    document.getElementById('fmt-html').classList.toggle('active', f === 'html');
    document.getElementById('fmt-csv').classList.toggle('active',  f === 'csv');
    updateLink();
  }

  function setStep(s) {
    stepType = s;
    ['none','month','year'].forEach(id => {
      document.getElementById('step-' + id).classList.toggle('active', (s || 'none') === id);
    });
    updateLink();
  }

  function setPeriod(s, e) {
    document.getElementById('startDate').value = s;
    document.getElementById('endDate').value   = e;
    updateLink();
  }

  function buildUrl() {
    var s = document.getElementById('startDate').value;
    var e = document.getElementById('endDate').value;
    if (!s || !e) return null;
    var url = '/api/' + company + '/report?type=' + reportType + '&start=' + s + '&end=' + e;
    if (formatType === 'csv') url += '&format=csv';
    if (stepType) url += '&step=' + stepType;
    return url;
  }

  function updateLink() {
    var url = buildUrl();
    document.getElementById('link-preview').textContent = url ? window.location.origin + url : '';
  }

  function openReport() {
    var url = buildUrl();
    if (!url) { alert('Please select a date range'); return; }
    window.open(url, '_blank');
  }

  function copyLink() {
    var url = buildUrl();
    if (!url) { alert('Please select a date range'); return; }
    navigator.clipboard.writeText(window.location.origin + url)
      .then(() => alert('Link copied!'))
      .catch(() => alert(window.location.origin + url));
  }

  // Pre-fill with most recent period
  ${periods.length > 0
    ? `setPeriod('${String(periods[0].start_date || '').slice(0, 10)}', '${String(periods[0].end_date || '').slice(0, 10)}');`
    : ''
  }
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
  app.get('/api/:company/report', handleReport);
  app.get('/api/:company/periods', handlePeriods);
  app.get('/api/:company/accounts', handleAccounts);
  app.get('/:company', handleCompanyPage);
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

module.exports = { handleReports, mountReportRoutes };
