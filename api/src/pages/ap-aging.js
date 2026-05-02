'use strict';
const { commonStyle } = require('./common');

async function handleApAgingPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildApAgingPage(company));
}

function buildApAgingPage(company) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>AP Aging — freeBooks</title>
${commonStyle()}
<style>
  .controls-row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:20px; }
  .controls-row label { font-size:10pt; color:#555; font-weight:600; }
  .controls-row input, .controls-row select { padding:6px 10px; border:1px solid #ccc; border-radius:4px; font-size:10pt; }
  .controls-row button { padding:6px 18px; background:#1a1a1a; color:#fff; border:none; border-radius:4px; font-size:10pt; cursor:pointer; }
  .controls-row button:hover { background:#333; }
  table.aging-table { width:100%; border-collapse:collapse; font-size:10pt; margin-top:4px; }
  table.aging-table th { text-align:right; font-size:9pt; color:#555; text-transform:uppercase; border-bottom:2px solid #ccc; padding:6px 8px; }
  table.aging-table th:first-child { text-align:left; }
  table.aging-table td { padding:6px 8px; border-bottom:1px solid #f0f0f0; text-align:right; }
  table.aging-table td:first-child { text-align:left; }
  table.aging-table tr.vendor-row { cursor:pointer; }
  table.aging-table tr.vendor-row:hover td { background:#f5f5ff; }
  table.aging-table tr.vendor-row td:first-child { font-weight:600; }
  table.aging-table tr.detail-row td { font-size:9pt; color:#555; background:#fafafa; padding:4px 8px 4px 24px; }
  table.aging-table tr.detail-row td:first-child { text-align:left; }
  table.aging-table tr.total-row td { font-weight:700; border-top:2px solid #ccc; background:#f8f8f8; }
  .col-90plus { color:#cc2222; font-weight:600; }
  .section-title { font-size:10pt; color:#555; font-weight:600; text-transform:uppercase; letter-spacing:.04em; margin:20px 0 6px; }
</style>
</head>
<body>
<div class="page">
  <div class="back" style="display:flex;justify-content:space-between;align-items:center">
    <a href="/${company}">← Reports</a>
    <div style="display:flex;gap:16px">
      <a href="/${company}/payables">📋 Payables</a>
      <a href="/${company}/settings">⚙ Settings</a>
    </div>
  </div>
  <div class="header">
    <h1>⏱ AP Aging</h1>
    <p class="sub">${company}</p>
  </div>

  <div class="controls-row">
    <label>As of date</label>
    <input type="date" id="asof-date">
    <label>Currency</label>
    <input type="text" id="f-currency" maxlength="3" placeholder="All" style="width:60px;text-transform:uppercase">
    <button onclick="doLoad()">Refresh</button>
  </div>

  <div id="report-area"><p style="color:#888">Loading…</p></div>
</div>

<script>
var COMPANY = '${company}';

window.addEventListener('DOMContentLoaded', function() {
  document.getElementById('asof-date').value = new Date().toISOString().slice(0,10);
  doLoad();
});

function doLoad() {
  var asOf = document.getElementById('asof-date').value;
  var currency = document.getElementById('f-currency').value.trim().toUpperCase();
  var payload = { action: 'bill.aging', companyId: COMPANY, asOfDate: asOf };
  if (currency) payload.currency = currency;

  document.getElementById('report-area').innerHTML = '<p style="color:#888">Loading…</p>';

  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var rows = res.data || res || [];
      if (!Array.isArray(rows)) rows = [];
      renderReport(rows, asOf);
    })
    .catch(function(e){
      document.getElementById('report-area').innerHTML = '<p style="color:#cc2222">Error: ' + e.message + '</p>';
    });
}

function renderReport(rows, asOf) {
  if (!rows.length) {
    document.getElementById('report-area').innerHTML = '<p style="color:#888">No outstanding payables as of ' + asOf + '.</p>';
    return;
  }

  // Group by vendor
  var vendors = {};
  rows.forEach(function(r) {
    if (!vendors[r.vendor]) vendors[r.vendor] = [];
    vendors[r.vendor].push(r);
  });

  var totals = { current:0, '1_30':0, '31_60':0, '61_90':0, '90plus':0, total:0 };

  var html = '<div class="section-title">Summary — as of ' + asOf + '</div>';
  html += '<table class="aging-table">';
  html += '<thead><tr>'
    + '<th style="text-align:left">Vendor</th>'
    + '<th>Current</th>'
    + '<th>1–30 days</th>'
    + '<th>31–60 days</th>'
    + '<th>61–90 days</th>'
    + '<th class="col-90plus">90+ days</th>'
    + '<th>Total</th>'
    + '</tr></thead><tbody id="aging-tbody">';

  Object.keys(vendors).sort().forEach(function(vendor) {
    var bills = vendors[vendor];
    var vt = { current:0, '1_30':0, '31_60':0, '61_90':0, '90plus':0, total:0 };
    bills.forEach(function(b) {
      var bal = Number(b.balance_due || 0);
      vt[b.bucket] = (vt[b.bucket] || 0) + bal;
      vt.total += bal;
      totals[b.bucket] = (totals[b.bucket] || 0) + bal;
      totals.total += bal;
    });
    var vendorKey = vendor.replace(/'/g,"\\'");
    html += '<tr class="vendor-row" onclick="toggleDetails(\'' + vendorKey + '\')">'
      + '<td>▶ ' + esc(vendor) + '</td>'
      + '<td>' + fmt(vt.current) + '</td>'
      + '<td>' + fmt(vt['1_30']) + '</td>'
      + '<td>' + fmt(vt['31_60']) + '</td>'
      + '<td>' + fmt(vt['61_90']) + '</td>'
      + '<td class="col-90plus">' + fmt(vt['90plus']) + '</td>'
      + '<td>' + fmt(vt.total) + '</td>'
      + '</tr>';
    // Detail rows (hidden by default)
    html += '<tr class="detail-header" id="dh-' + btoa(vendor) + '" style="display:none"><td colspan="7" style="padding:4px 8px 2px 24px;font-size:8.5pt;color:#888;text-transform:uppercase;border-bottom:1px solid #e0e0e0">Invoice Ref &nbsp;|&nbsp; Bill Date &nbsp;|&nbsp; Due Date &nbsp;|&nbsp; Description</td></tr>';
    bills.forEach(function(b, i) {
      var bal = Number(b.balance_due || 0);
      var desc = [b.vendor_ref, b.date, b.due_date || '—', b.description].filter(Boolean).join(' | ').substring(0, 80);
      html += '<tr class="detail-row" id="dr-' + btoa(vendor) + '-' + i + '" style="display:none">'
        + '<td>' + esc(desc) + '</td>'
        + '<td>' + (b.bucket === 'current' ? fmt(bal) : '') + '</td>'
        + '<td>' + (b.bucket === '1_30'    ? fmt(bal) : '') + '</td>'
        + '<td>' + (b.bucket === '31_60'   ? fmt(bal) : '') + '</td>'
        + '<td>' + (b.bucket === '61_90'   ? fmt(bal) : '') + '</td>'
        + '<td class="col-90plus">' + (b.bucket === '90plus' ? fmt(bal) : '') + '</td>'
        + '<td>' + fmt(bal) + '</td>'
        + '</tr>';
    });
  });

  // Grand total row
  html += '<tr class="total-row">'
    + '<td>TOTAL</td>'
    + '<td>' + fmt(totals.current) + '</td>'
    + '<td>' + fmt(totals['1_30']) + '</td>'
    + '<td>' + fmt(totals['31_60']) + '</td>'
    + '<td>' + fmt(totals['61_90']) + '</td>'
    + '<td class="col-90plus">' + fmt(totals['90plus']) + '</td>'
    + '<td>' + fmt(totals.total) + '</td>'
    + '</tr>';

  html += '</tbody></table>';
  document.getElementById('report-area').innerHTML = html;
}

function toggleDetails(vendor) {
  var key = btoa(vendor);
  var header = document.getElementById('dh-' + key);
  if (!header) return;
  var showing = header.style.display !== 'none';
  // toggle header row
  header.style.display = showing ? 'none' : '';
  // toggle all detail rows for this vendor
  var i = 0;
  while (true) {
    var el = document.getElementById('dr-' + key + '-' + i);
    if (!el) break;
    el.style.display = showing ? 'none' : '';
    i++;
  }
  // flip arrow on vendor row
  var allRows = document.querySelectorAll('.vendor-row');
  allRows.forEach(function(row) {
    if (row.querySelector('td:first-child') && row.querySelector('td:first-child').textContent.includes(vendor)) {
      var cell = row.querySelector('td:first-child');
      cell.textContent = cell.textContent.replace(/^[▶▼] /, (showing ? '▶ ' : '▼ '));
    }
  });
}

function fmt(n) {
  if (!n || n === 0) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
<\/script>
</body>
</html>`;
}

module.exports = { handleApAgingPage };
