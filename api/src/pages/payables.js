'use strict';
const { commonStyle } = require('./common');

async function handlePayablesPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildPayablesPage(company));
}

function buildPayablesPage(company) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Payables — freeBooks</title>
${commonStyle()}
<style>
  .filter-row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:10px; }
  .filter-row select, .filter-row input { padding:6px 10px; border:1px solid #ccc; border-radius:4px; font-size:10pt; }
  .filter-row button { padding:6px 18px; background:#1a1a1a; color:#fff; border:none; border-radius:4px; font-size:10pt; cursor:pointer; }
  .filter-row button:hover { background:#333; }
  .more-toggle { cursor:pointer; font-size:10pt; color:#555; padding:4px 0; margin-bottom:8px; user-select:none; }
  .more-toggle:hover { color:#000; }
  .badge { display:inline-block; padding:2px 8px; border-radius:3px; font-size:9pt; font-weight:600; }
  .btn-view { padding:3px 12px; font-size:9pt; border:1px solid #ccc; border-radius:3px; background:#f5f5f5; cursor:pointer; }
  .btn-view:hover { background:#e8e8e8; }
  table.bills-table { width:100%; border-collapse:collapse; font-size:10pt; margin-top:12px; }
  table.bills-table th { text-align:left; font-size:9pt; color:#555; text-transform:uppercase; border-bottom:2px solid #ccc; padding:6px 8px; }
  table.bills-table td { padding:7px 8px; border-bottom:1px solid #f0f0f0; }
  table.bills-table tr:hover td { background:#fafafa; }
  .modal-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px 20px; }
  .modal-field { display:flex; flex-direction:column; gap:3px; }
  .mf-label { font-size:9pt; color:#888; font-weight:600; text-transform:uppercase; }
  .mf-val { font-size:10pt; color:#222; }
  .btn-new-bill { display:inline-block; padding:8px 18px; background:#1a1a1a; color:#fff; text-decoration:none; border-radius:4px; font-size:10pt; font-weight:600; }
  .btn-new-bill:hover { background:#333; }
  .back { margin-bottom:16px; }
  .back a { color:#555; text-decoration:none; font-size:10pt; }
  .back a:hover { text-decoration:underline; }
</style>
</head>
<body>
<div class="page">
  <div class="back" style="display:flex;justify-content:space-between;align-items:center">
    <a href="/${company}">← Reports</a>
    <a href="/${company}/settings">⚙ Settings</a>
  </div>
  <div class="header" style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px">
    <div>
      <h1>📋 Payables</h1>
      <p class="sub">${company}</p>
    </div>
    <a href="/${company}/bill/new" class="btn-new-bill">＋ New Bill</a>
  </div>

  <div class="filter-row">
    <select id="f-vendor"><option value="">— All Vendors —</option></select>
    <input type="text" id="f-desc" placeholder="Description...">
    <select id="f-status">
      <option value="">All Statuses</option>
      <option value="posted">Open</option>
      <option value="partial">Partial</option>
      <option value="paid">Paid</option>
      <option value="void">Void</option>
    </select>
    <select id="f-period"><option value="">— All Periods —</option></select>
    <button id="btn-search" onclick="doSearch()">Search</button>
  </div>

  <div class="more-toggle" onclick="toggleMore()">▾ More filters</div>
  <div id="more-filters" style="display:none">
    <div class="filter-row" style="margin-bottom:16px">
      <select id="f-amt-op">
        <option value="≥">≥</option>
        <option value="=">=</option>
        <option value="≤">≤</option>
      </select>
      <input type="number" id="f-amt-val" min="0" step="0.01" placeholder="0.00">
      <input type="text" id="f-currency" maxlength="3" placeholder="SGD" style="text-transform:uppercase;width:60px">
    </div>
  </div>

  <table class="bills-table">
    <thead>
      <tr>
        <th>Date</th>
        <th>Due Date</th>
        <th>Vendor</th>
        <th>Description</th>
        <th>Currency</th>
        <th style="text-align:right">Amount</th>
        <th>Status</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody id="bills-tbody">
      <tr><td colspan="8" style="text-align:center;color:#888;padding:20px">Loading…</td></tr>
    </tbody>
  </table>
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
        <th style="text-align:left;border-bottom:1px solid #ccc;padding:5px 6px;font-size:9pt;color:#555;text-transform:uppercase">Code</th>
        <th style="text-align:left;border-bottom:1px solid #ccc;padding:5px 6px;font-size:9pt;color:#555;text-transform:uppercase">Account</th>
        <th style="text-align:left;border-bottom:1px solid #ccc;padding:5px 6px;font-size:9pt;color:#555;text-transform:uppercase">Description</th>
        <th style="text-align:right;border-bottom:1px solid #ccc;padding:5px 6px;font-size:9pt;color:#555;text-transform:uppercase">Amount</th>
        <th style="text-align:left;border-bottom:1px solid #ccc;padding:5px 6px;font-size:9pt;color:#555;text-transform:uppercase">VAT</th>
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
var periodsData = [];
var billsData = [];
var today = new Date().toISOString().slice(0,10);

window.addEventListener('DOMContentLoaded', function() {
  loadVendors();
  loadPeriods();
  doSearch();
});

function loadVendors() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'vendor.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var vendors = res.data || res || [];
      var sel = document.getElementById('f-vendor');
      sel.innerHTML = '<option value="">— All Vendors —</option>';
      vendors.forEach(function(v){
        var opt = document.createElement('option');
        opt.value = v.name || v.vendor_id;
        opt.textContent = v.name || v.vendor_id;
        sel.appendChild(opt);
      });
    }).catch(function(){});
}

function loadPeriods() {
  fetch('/api/' + COMPANY + '/periods')
    .then(function(r){ return r.json(); })
    .then(function(rows){
      periodsData = Array.isArray(rows) ? rows : [];
      var sel = document.getElementById('f-period');
      sel.innerHTML = '<option value="">— All Periods —</option>';
      periodsData.forEach(function(p){
        var opt = document.createElement('option');
        opt.value = p.period_name;
        opt.textContent = p.period_name;
        sel.appendChild(opt);
      });
    }).catch(function(){});
}

function doSearch() {
  var vendor = document.getElementById('f-vendor').value;
  var desc = document.getElementById('f-desc').value.trim();
  var status = document.getElementById('f-status').value;
  var periodName = document.getElementById('f-period').value;
  var amtOp = document.getElementById('f-amt-op').value;
  var amtVal = parseFloat(document.getElementById('f-amt-val').value);
  var currency = document.getElementById('f-currency').value.trim().toUpperCase();

  var dateFrom = null, dateTo = null;
  if (periodName) {
    var p = periodsData.find(function(x){ return x.period_name === periodName; });
    if (p) { dateFrom = p.start_date; dateTo = p.end_date; }
  }

  var payload = { action: 'bill.list', companyId: COMPANY };
  if (vendor) payload.vendor = vendor;
  if (desc) payload.description = desc;
  if (status) payload.status = status;
  if (dateFrom) payload.dateFrom = dateFrom;
  if (dateTo) payload.dateTo = dateTo;

  showTableMsg('Loading\u2026');

  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      if (res.error) { showTableMsg('Error: ' + res.error); return; }
      var rows = res.data || res || [];
      if (!Array.isArray(rows)) rows = [];
      if (!isNaN(amtVal) && amtVal > 0) {
        rows = rows.filter(function(r) {
          if (amtOp === '\u2265') return r.amount >= amtVal;
          if (amtOp === '=') return Math.abs(r.amount - amtVal) < 0.01;
          if (amtOp === '\u2264') return r.amount <= amtVal;
          return true;
        });
      }
      if (currency) rows = rows.filter(function(r){ return (r.currency||'') === currency; });
      billsData = rows;
      renderBills(rows);
    })
    .catch(function(e){ showTableMsg('Error: ' + e.message); });
}

function renderBills(rows) {
  var tbody = document.getElementById('bills-tbody');
  if (!rows.length) { showTableMsg('No bills found.'); return; }
  var html = '';
  rows.forEach(function(b){
    var badge = statusBadge(b.status, b.due_date);
    var dueDisp = b.due_date || '\u2014';
    var descDisp = (b.description || '').substring(0, 60);
    html += '<tr>' +
      '<td>' + (b.date || '') + '</td>' +
      '<td>' + dueDisp + '</td>' +
      '<td>' + esc(b.vendor || '') + '</td>' +
      '<td>' + esc(descDisp) + '</td>' +
      '<td>' + (b.currency || '') + '</td>' +
      '<td style="text-align:right">' + Number(b.amount || 0).toFixed(2) + '</td>' +
      '<td>' + badge + '</td>' +
      '<td><button class="btn-view" data-bill-id="' + b.bill_id + '" onclick="viewBill(this.dataset.billId)">View</button></td>' +
      '</tr>';
  });
  tbody.innerHTML = html;
}

function statusBadge(status, dueDate) {
  var isOverdue = (status === 'posted' || status === 'partial') && dueDate && dueDate < today;
  if (isOverdue) return '<span class="badge" style="background:#fff0f0;color:#cc2222">Overdue</span>';
  if (status === 'posted')  return '<span class="badge" style="background:#e8eeff;color:#2255cc">Open</span>';
  if (status === 'partial') return '<span class="badge" style="background:#fff3e0;color:#cc7700">Partial</span>';
  if (status === 'paid')    return '<span class="badge" style="background:#f0fff4;color:#2a8a2a">Paid</span>';
  if (status === 'void')    return '<span class="badge" style="background:#f0f0f0;color:#888">Void</span>';
  return '<span class="badge" style="background:#f0f0f0;color:#888">' + (status||'') + '</span>';
}

function showTableMsg(msg) {
  document.getElementById('bills-tbody').innerHTML = '<tr><td colspan="8" style="text-align:center;color:#888;padding:20px">' + msg + '</td></tr>';
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function toggleMore() {
  var el = document.getElementById('more-filters');
  el.style.display = el.style.display === 'none' ? '' : 'none';
}

function viewBill(billId) {
  var bill = billsData.find(function(b){ return b.bill_id === billId; });
  if (!bill) return;
  document.getElementById('m-vendor').textContent = bill.vendor || '';
  document.getElementById('m-ref').textContent = bill.vendor_ref || '\u2014';
  document.getElementById('m-date').textContent = bill.date || '';
  document.getElementById('m-due').textContent = bill.due_date || '\u2014';
  document.getElementById('m-currency').textContent = bill.currency || '';
  document.getElementById('m-amount').textContent = Number(bill.amount||0).toFixed(2);
  document.getElementById('m-status').innerHTML = statusBadge(bill.status, bill.due_date);
  document.getElementById('m-ap').textContent = bill.ap_account || '';
  document.getElementById('m-desc').textContent = bill.description || '\u2014';
  document.getElementById('m-lines-tbody').innerHTML = '<tr><td colspan="5" style="color:#888">Loading\u2026</td></tr>';
  document.getElementById('bill-modal').style.display = '';

  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'bill.lines', companyId: COMPANY, billId: billId }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var lines = res.data || res || [];
      if (!Array.isArray(lines)) lines = [];
      if (!lines.length) {
        document.getElementById('m-lines-tbody').innerHTML = '<tr><td colspan="5" style="color:#888">No expense lines found.</td></tr>';
        return;
      }
      var html = '';
      lines.forEach(function(l){
        html += '<tr><td>' + esc(l.account_code||'') + '</td><td>' + esc(l.account_name||'') + '</td>'
          + '<td>' + esc(l.description||'') + '</td><td style="text-align:right">' + Number(l.amount||0).toFixed(2) + '</td>'
          + '<td>' + esc(l.vat_code||'') + '</td></tr>';
      });
      document.getElementById('m-lines-tbody').innerHTML = html;
    })
    .catch(function(e){
      document.getElementById('m-lines-tbody').innerHTML = '<tr><td colspan="5" style="color:#cc2222">Error loading lines.</td></tr>';
    });
}

function closeModal() {
  document.getElementById('bill-modal').style.display = 'none';
}
</script>
</body>
</html>`;
}

module.exports = { handlePayablesPage };
