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
  table.aging-table tr.detail-row { cursor:pointer; }
  table.aging-table tr.detail-row:hover td { background:#f0f4ff; }
  table.aging-table tr.detail-row td { font-size:9pt; color:#555; background:#fafafa; padding:4px 8px 4px 24px; }
  table.aging-table tr.detail-row td:first-child { text-align:left; }
  table.aging-table tr.total-row td { font-weight:700; border-top:2px solid #ccc; background:#f8f8f8; }
  .col-90plus { color:#cc2222; font-weight:600; }
  .section-title { font-size:10pt; color:#555; font-weight:600; text-transform:uppercase; letter-spacing:.04em; margin:20px 0 6px; }
  .modal-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px 20px; }
  .modal-field { display:flex; flex-direction:column; gap:3px; }
  .mf-label { font-size:9pt; color:#888; font-weight:600; text-transform:uppercase; }
  .mf-val { font-size:10pt; color:#222; }
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

<div id="bill-modal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);z-index:1000;overflow:auto">
  <div style="background:#fff;border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,.2);max-width:640px;margin:40px auto;padding:28px 32px;position:relative">
    <button onclick="closeModal()" style="position:absolute;top:12px;right:16px;background:none;border:none;font-size:18pt;cursor:pointer;color:#888">&times;</button>
    <h2 style="margin:0 0 18px;font-size:14pt">Bill Details</h2>
    <div class="modal-grid">
      <div class="modal-field"><span class="mf-label">Vendor</span><span class="mf-val" id="m-vendor"></span></div>
      <div class="modal-field"><span class="mf-label">Invoice Ref</span><span class="mf-val" id="m-ref"></span></div>
      <div class="modal-field"><span class="mf-label">Bill Date</span><span class="mf-val" id="m-date"></span></div>
      <div class="modal-field"><span class="mf-label">Due Date</span><span class="mf-val" id="m-due"></span></div>
      <div class="modal-field"><span class="mf-label">Currency</span><span class="mf-val" id="m-currency"></span></div>
      <div class="modal-field"><span class="mf-label">Amount</span><span class="mf-val" id="m-amount"></span></div>
      <div class="modal-field"><span class="mf-label">Status</span><span class="mf-val" id="m-status"></span></div>
      <div class="modal-field"><span class="mf-label">AP Account</span><span class="mf-val" id="m-ap"></span></div>
      <div class="modal-field" style="grid-column:1/-1"><span class="mf-label">Description</span><span class="mf-val" id="m-desc"></span></div>
    </div>
    <h3 style="font-size:10pt;color:#555;font-weight:600;margin:20px 0 8px">Expense Lines</h3>
    <table style="width:100%;border-collapse:collapse;font-size:10pt">
      <thead><tr>
        <th style="text-align:left;border-bottom:1px solid #ccc;padding:5px 8px;font-size:9pt;color:#555;text-transform:uppercase">Code</th>
        <th style="text-align:left;border-bottom:1px solid #ccc;padding:5px 8px;font-size:9pt;color:#555;text-transform:uppercase">Account</th>
        <th style="text-align:left;border-bottom:1px solid #ccc;padding:5px 8px;font-size:9pt;color:#555;text-transform:uppercase">Description</th>
        <th style="text-align:right;border-bottom:1px solid #ccc;padding:5px 8px;font-size:9pt;color:#555;text-transform:uppercase;min-width:80px">Amount</th>
        <th style="text-align:left;border-bottom:1px solid #ccc;padding:5px 8px;font-size:9pt;color:#555;text-transform:uppercase">VAT</th>
      </tr></thead>
      <tbody id="m-lines-tbody"></tbody>
    </table>
    <div style="margin-top:20px;text-align:right">
      <button onclick="closeModal()" style="padding:8px 20px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer;font-size:10pt">Close</button>
    </div>
  </div>
</div>

<script>
var COMPANY = '${company}';
var agingRows = []; // stores all bill rows for modal lookup

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
      agingRows = rows;
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
    html += '<tr class="vendor-row" data-vendor-key="' + esc(vendor) + '" onclick="toggleDetails(this.dataset.vendorKey)">'
      + '<td>▶ ' + esc(vendor) + '</td>'
      + '<td>' + fmt(vt.current) + '</td>'
      + '<td>' + fmt(vt['1_30']) + '</td>'
      + '<td>' + fmt(vt['31_60']) + '</td>'
      + '<td>' + fmt(vt['61_90']) + '</td>'
      + '<td' + (vt['90plus'] > 0 ? ' class="col-90plus"' : '') + '>' + fmt(vt['90plus']) + '</td>'
      + '<td>' + fmt(vt.total) + '</td>'
      + '</tr>';
    // Detail rows (hidden by default)
    bills.forEach(function(b, i) {
      var bal = Number(b.balance_due || 0);
      var label = b.vendor_ref || b.date ? String(b.date||'').slice(0,10) : b.bill_id.slice(0,8);
      html += '<tr class="detail-row" data-bill-id="' + b.bill_id + '" id="dr-' + btoa(vendor) + '-' + i + '" style="display:none" onclick="viewBill(this.dataset.billId)">'
        + '<td style="padding-left:24px">' + esc(label) + '</td>'
        + '<td>' + (b.bucket === 'current' ? fmt(bal) : '') + '</td>'
        + '<td>' + (b.bucket === '1_30'    ? fmt(bal) : '') + '</td>'
        + '<td>' + (b.bucket === '31_60'   ? fmt(bal) : '') + '</td>'
        + '<td>' + (b.bucket === '61_90'   ? fmt(bal) : '') + '</td>'
        + '<td' + (bal > 0 && b.bucket === '90plus' ? ' class="col-90plus"' : '') + '>' + (b.bucket === '90plus' ? fmt(bal) : '') + '</td>'
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
    + '<td' + (totals['90plus'] > 0 ? ' class="col-90plus"' : '') + '>' + fmt(totals['90plus']) + '</td>'
    + '<td>' + fmt(totals.total) + '</td>'
    + '</tr>';

  html += '</tbody></table>';
  document.getElementById('report-area').innerHTML = html;
}

function toggleDetails(vendor) {
  // vendor is passed as a string (either from data-vendor-key or direct call)
  var key = btoa(vendor);
  // toggle all detail rows for this vendor
  var i = 0;
  var anyShowing = false;
  while (true) {
    var el = document.getElementById('dr-' + key + '-' + i);
    if (!el) break;
    if (el.style.display === 'none') anyShowing = true;
    i++;
  }
  i = 0;
  while (true) {
    var el = document.getElementById('dr-' + key + '-' + i);
    if (!el) break;
    el.style.display = anyShowing ? '' : 'none';
    i++;
  }
  // flip arrow on vendor row
  var allRows = document.querySelectorAll('.vendor-row');
  allRows.forEach(function(row) {
    if (row.querySelector('td:first-child') && row.querySelector('td:first-child').textContent.includes(vendor)) {
      var cell = row.querySelector('td:first-child');
      cell.textContent = cell.textContent.replace(/^[▶▼] /, (anyShowing ? '▼ ' : '▶ '));
    }
  });
}

function viewBill(billId) {
  var bill = agingRows.find(function(b) { return b.bill_id === billId; });
  if (!bill) return;
  document.getElementById('m-vendor').textContent = bill.vendor || '';
  document.getElementById('m-ref').textContent = bill.vendor_ref || '—';
  document.getElementById('m-date').textContent = bill.date ? String(bill.date).slice(0,10) : '';
  document.getElementById('m-due').textContent = bill.due_date ? String(bill.due_date).slice(0,10) : '—';
  document.getElementById('m-currency').textContent = bill.currency || '';
  document.getElementById('m-amount').textContent = Number(bill.amount||0).toFixed(2);
  document.getElementById('m-status').textContent = bill.status || '';
  document.getElementById('m-ap').textContent = bill.ap_account || '';
  document.getElementById('m-desc').textContent = bill.description || '—';
  document.getElementById('m-lines-tbody').innerHTML = '<tr><td colspan="5" style="color:#888;padding:8px">Loading…</td></tr>';
  document.getElementById('bill-modal').style.display = '';

  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'bill.lines', companyId: COMPANY, billId: billId }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var lines = res.data || res || [];
      if (!Array.isArray(lines) || !lines.length) {
        document.getElementById('m-lines-tbody').innerHTML = '<tr><td colspan="5" style="color:#888;padding:8px">No expense lines.</td></tr>';
        return;
      }
      var html = '';
      lines.forEach(function(l){
        html += '<tr>'
          + '<td style="padding:5px 8px;border-bottom:1px solid #f0f0f0">' + esc(l.account_code||'') + '</td>'
          + '<td style="padding:5px 8px;border-bottom:1px solid #f0f0f0">' + esc(l.account_name||'') + '</td>'
          + '<td style="padding:5px 8px;border-bottom:1px solid #f0f0f0">' + esc(l.description||'') + '</td>'
          + '<td style="padding:5px 8px;border-bottom:1px solid #f0f0f0;text-align:right">' + Number(l.amount||0).toFixed(2) + '</td>'
          + '<td style="padding:5px 8px;border-bottom:1px solid #f0f0f0;color:#555">' + esc(l.vat_code||'') + '</td>'
          + '</tr>';
      });
      document.getElementById('m-lines-tbody').innerHTML = html;
    })
    .catch(function() {
      document.getElementById('m-lines-tbody').innerHTML = '<tr><td colspan="5" style="color:#cc2222">Error loading lines.</td></tr>';
    });
}

function closeModal() {
  document.getElementById('bill-modal').style.display = 'none';
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
