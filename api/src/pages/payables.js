'use strict';
const { commonStyle, navBar, layoutEnd } = require('./common');
const { query } = require('../db');

async function handlePayablesPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const [co] = await query(`SELECT jurisdiction FROM companies WHERE company_id = @cid LIMIT 1`, { cid: company }).catch(() => [{}]);
  const taxLabel = (co && co.jurisdiction === 'SG') ? 'GST' : 'VAT';
  res.send(buildPayablesPage(company, taxLabel));
}

function buildPayablesPage(company, taxLabel = 'VAT') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Payables — freeBooks</title>
${commonStyle()}
<style>
  .page { max-width:1100px; }

  /* Page header */
  .page-header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:28px; }
  .page-header h1 { margin:0 0 4px; font-size:20pt; font-weight:700; letter-spacing:-.01em; }
  .page-header .sub { margin:0; font-size:10pt; color:#aaa; }
  .btn-create { display:inline-flex; align-items:center; gap:7px; padding:9px 20px; background:#1a1a1a; color:#fff; border:none; border-radius:6px; font-size:10.5pt; font-weight:600; text-decoration:none; cursor:pointer; }
  .btn-create:hover { background:#333; }

  /* KPI cards */
  .kpi-row { display:flex; gap:16px; margin-bottom:28px; }
  .kpi-card { flex:1; border:1px solid #e8e8e8; border-radius:8px; padding:20px 24px; background:#fff; }
  .kpi-label { font-size:8.5pt; color:#aaa; font-weight:600; text-transform:uppercase; letter-spacing:.06em; margin-bottom:10px; }
  .kpi-amount { font-size:20pt; font-weight:700; color:#1a1a1a; line-height:1; margin-bottom:6px; }
  .kpi-amount.overdue { color:#cc2222; }
  .kpi-count { font-size:9pt; color:#aaa; }

  /* Filter bar */
  .filter-bar { display:flex; gap:10px; align-items:center; margin-bottom:20px; flex-wrap:wrap; }
  .search-wrap { position:relative; flex:1; min-width:180px; }
  .search-wrap input { width:100%; padding:9px 12px 9px 36px; border:1px solid #ddd; border-radius:6px; font-size:10pt; box-sizing:border-box; }
  .search-wrap input:focus { outline:none; border-color:#1a1a1a; }
  .search-icon { position:absolute; left:11px; top:50%; transform:translateY(-50%); color:#aaa; font-size:11pt; pointer-events:none; }
  .filter-bar select { padding:9px 12px; border:1px solid #ddd; border-radius:6px; font-size:10pt; background:#fff; }
  .filter-bar select:focus { outline:none; border-color:#1a1a1a; }

  /* Table card */
  .table-card { border:1px solid #e8e8e8; border-radius:8px; overflow:hidden; }
  .data-table { width:100%; border-collapse:collapse; font-size:10.5pt; }
  .data-table th { text-align:left; font-size:8.5pt; color:#aaa; font-weight:600; text-transform:uppercase; letter-spacing:.05em; background:#fafafa; border-bottom:1px solid #e8e8e8; padding:12px 18px; }
  .data-table td { padding:14px 18px; border-bottom:1px solid #f2f2f2; vertical-align:middle; color:#222; }
  .data-table tbody tr:last-child td { border-bottom:none; }
  .data-table tbody tr:hover td { background:#fafafa; }

  /* Vendor avatar */
  .vendor-cell { display:flex; align-items:center; gap:10px; }
  .avatar { width:32px; height:32px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:9pt; font-weight:700; color:#fff; flex-shrink:0; }

  /* Badge */
  .badge { display:inline-block; padding:3px 10px; border-radius:20px; font-size:8.5pt; font-weight:600; }

  /* Link */
  .ref-link { color:#2255cc; text-decoration:none; font-weight:500; }
  .ref-link:hover { text-decoration:underline; }
  .view-link { color:#2255cc; text-decoration:none; font-size:10pt; font-weight:500; }
  .view-link:hover { text-decoration:underline; }

  .overdue-date { color:#cc2222; font-weight:600; }

  /* Pagination */
  .pagination-row { display:flex; justify-content:space-between; align-items:center; padding:14px 18px; border-top:1px solid #f0f0f0; font-size:9.5pt; color:#888; }
  .page-btns { display:flex; gap:4px; align-items:center; }
  .page-btn { padding:5px 11px; border:1px solid #ddd; border-radius:5px; background:#fff; cursor:pointer; font-size:9pt; color:#333; }
  .page-btn:hover { background:#f5f5f5; }
  .page-btn.active { background:#1a1a1a; color:#fff; border-color:#1a1a1a; }
  .page-btn:disabled { opacity:.4; cursor:default; }
  .tabs { display:flex; gap:0; border-bottom:2px solid #1a1a1a; margin-bottom:24px; }
  .tab { padding:8px 20px; cursor:pointer; font-weight:600; font-size:10pt; color:#555; border-bottom:3px solid transparent; margin-bottom:-2px; }
  .tab.active { color:#1a1a1a; border-bottom-color:#1a1a1a; }
  .edit-table { width:100%; border-collapse:collapse; font-size:10pt; }
  .edit-table th { text-align:left; font-size:9pt; text-transform:uppercase; color:#555; border-bottom:1px solid #ccc; padding:6px; }
  .edit-table td { padding:4px; border-bottom:1px solid #f0f0f0; vertical-align:middle; }
  .edit-table input[type=text], .edit-table select { width:100%; padding:4px 6px; border:1px solid #ddd; border-radius:3px; font-size:10pt; }
  .btn-sm { padding:0 14px; height:32px; font-size:10pt; cursor:pointer; border:1px solid #ccc; border-radius:3px; background:#f5f5f5; }
  .btn-sm:hover { background:#e8e8e8; }
  .btn-sm.danger { border-color:#cc2222; color:#cc2222; }
  button.btn-primary { padding:10px 24px; background:#1a1a1a; color:#fff; border:none; border-radius:4px; font-size:11pt; font-weight:600; cursor:pointer; }
  button.btn-primary:hover { background:#333; }
  button.btn-primary:disabled { background:#ccc; color:#666; cursor:not-allowed; }
  .msg-pay { margin-top:10px; font-size:10pt; }
  .msg-pay.ok { color:#2a8a2a; }
  .msg-pay.err { color:#cc2222; }
</style>
</head>
<body>${navBar(company, 'payables')}
<div class="page">

  <!-- Page header -->
  <div class="header">
    <h1>📋 Payables</h1>
  </div>

  <div class="tabs" style="margin-bottom:20px">
    <div class="tab active" id="pay-tab-bills" onclick="showPayTab('bills')">Bills</div>
    <div class="tab" id="pay-tab-vendors" onclick="showPayTab('vendors')">Vendors</div>
  </div>

  <div id="pay-panel-bills">

  <!-- KPI cards -->
  <div class="kpi-row">
    <div class="kpi-card">
      <div class="kpi-label">Total Outstanding</div>
      <div class="kpi-amount" id="kpi-outstanding">—</div>
      <div class="kpi-count" id="kpi-outstanding-count"></div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Overdue</div>
      <div class="kpi-amount overdue" id="kpi-overdue">—</div>
      <div class="kpi-count" id="kpi-overdue-count"></div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Upcoming (Next 7 Days)</div>
      <div class="kpi-amount" id="kpi-upcoming">—</div>
      <div class="kpi-count" id="kpi-upcoming-count"></div>
    </div>
  </div>

  <!-- Filter bar -->
  <div class="filter-bar">
    <div class="search-wrap">
      <span class="search-icon">&#128269;</span>
      <input type="text" id="f-search" placeholder="Search bills, vendors..." oninput="applyFilters()">
    </div>
    <select id="f-status" onchange="applyFilters()">
      <option value="">Status: All</option>
      <option value="posted">Open</option>
      <option value="partial">Partial</option>
      <option value="paid">Paid</option>
      <option value="void">Void</option>
      <option value="overdue">Overdue</option>
    </select>
    <select id="f-vendor" onchange="applyFilters()">
      <option value="">Vendor: All</option>
    </select>
  </div>

  <!-- Table card -->
  <div class="table-card">
    <table class="data-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Due Date</th>
          <th>Vendor</th>
          <th>Invoice Ref</th>
          <th style="text-align:right">Amount</th>
          <th>Status</th>
          <th style="text-align:right">Actions</th>
        </tr>
      </thead>
      <tbody id="bills-tbody">
        <tr><td colspan="7" style="text-align:center;color:#aaa;padding:32px">Loading&#8230;</td></tr>
      </tbody>
    </table>
    <div class="pagination-row" id="pagination-row" style="display:none">
      <span id="pag-info"></span>
      <div class="page-btns" id="pag-btns"></div>
    </div>
  </div>

  </div><!-- /pay-panel-bills -->

  <div id="pay-panel-vendors" style="display:none">
    <table class="edit-table" id="vendors-table">
      <thead><tr><th>Name</th><th>CCY</th><th>Terms(d)</th><th>Expense A/C</th><th>AP A/C</th><th style="text-align:center">Active</th><th></th></tr></thead>
      <tbody id="vendors-body"></tbody>
    </table>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
      <span id="msg-vendors" class="msg" style="font-size:0.8125rem"></span>
    </div>
    <p style="margin-top:8px;font-size:9pt;color:#888">These defaults auto-fill when creating a bill for this vendor: currency, payment terms, expense account, and AP account.</p>
  </div><!-- /pay-panel-vendors -->

</div>

<script>
var COMPANY = '${company}';
var allBills = [];
var filteredBills = [];
var today = new Date().toISOString().slice(0,10);
var in7days = new Date(Date.now() + 7*24*3600*1000).toISOString().slice(0,10);
var PAGE_SIZE = 20;
var currentPage = 1;

var AVATAR_COLORS = ['#4f6ef7','#e05c5c','#2bac72','#e09d3a','#9b59c4','#17a2b8','#e07840','#5c7ae0'];

function fbPageInitPayables() {
  loadVendors();
  loadAllBills();
}
window.addEventListener('DOMContentLoaded', fbPageInitPayables);
document.addEventListener('fb:pageload', fbPageInitPayables);

function loadVendors() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'vendor.list', companyId: COMPANY }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    var vendors = res.data || res || [];
    if (!Array.isArray(vendors)) return;
    var sel = document.getElementById('f-vendor');
    vendors.forEach(function(v){
      var opt = document.createElement('option');
      opt.value = v.name || v.vendor_id;
      opt.textContent = v.name || v.vendor_id;
      sel.appendChild(opt);
    });
  }).catch(function(){});
}

function loadAllBills() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'bill.list', companyId: COMPANY }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    var rows = res.data || res || [];
    if (!Array.isArray(rows)) rows = [];
    allBills = rows;
    computeKpis(rows);
    applyFilters();
  })
  .catch(function(e){ showMsg('Error loading bills: ' + e.message); });
}

function computeKpis(bills) {
  var outstandingAmt = 0, outstandingN = 0;
  var overdueAmt = 0, overdueN = 0;
  var upcomingAmt = 0, upcomingN = 0;
  bills.forEach(function(b) {
    var active = b.status === 'posted' || b.status === 'partial';
    if (!active) return;
    var amt = Number(b.amount || 0);
    var due = b.due_date ? String(b.due_date).slice(0,10) : null;
    var isOverdue = due && due < today;
    outstandingAmt += amt; outstandingN++;
    if (isOverdue) { overdueAmt += amt; overdueN++; }
    else if (due && due <= in7days) { upcomingAmt += amt; upcomingN++; }
  });
  setText('kpi-outstanding', fmtAmt(outstandingAmt));
  setText('kpi-outstanding-count', outstandingN + ' bill' + (outstandingN !== 1 ? 's' : ''));
  setText('kpi-overdue', fmtAmt(overdueAmt));
  setText('kpi-overdue-count', overdueN + ' bill' + (overdueN !== 1 ? 's' : ''));
  setText('kpi-upcoming', fmtAmt(upcomingAmt));
  setText('kpi-upcoming-count', upcomingN + ' bill' + (upcomingN !== 1 ? 's' : ''));
}

function fmtAmt(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
}

function setText(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = text;
}

function applyFilters() {
  var search = (document.getElementById('f-search').value || '').toLowerCase().trim();
  var status = document.getElementById('f-status').value;
  var vendor = document.getElementById('f-vendor').value;

  filteredBills = allBills.filter(function(b) {
    // Search
    if (search) {
      var haystack = ((b.vendor || '') + ' ' + (b.vendor_ref || '') + ' ' + (b.description || '')).toLowerCase();
      if (haystack.indexOf(search) === -1) return false;
    }
    // Status (special: overdue)
    if (status === 'overdue') {
      var due = b.due_date ? String(b.due_date).slice(0,10) : null;
      var active = b.status === 'posted' || b.status === 'partial';
      if (!active || !due || due >= today) return false;
    } else if (status) {
      if (b.status !== status) return false;
    }
    // Vendor
    if (vendor && b.vendor !== vendor) return false;
    return true;
  });

  currentPage = 1;
  renderPage();
}

function renderPage() {
  var total = filteredBills.length;
  var totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  var start = (currentPage - 1) * PAGE_SIZE;
  var end = Math.min(start + PAGE_SIZE, total);
  var slice = filteredBills.slice(start, end);

  if (!slice.length) {
    showMsg('No bills found.');
    document.getElementById('pagination-row').style.display = 'none';
    return;
  }

  var html = '';
  slice.forEach(function(b) {
    var due = b.due_date ? String(b.due_date).slice(0,10) : null;
    var active = b.status === 'posted' || b.status === 'partial';
    var isOverdue = active && due && due < today;
    var dueCls = isOverdue ? ' class="overdue-date"' : '';
    var dueDisp = due || '\u2014';
    html += '<tr>'
      + '<td style="white-space:nowrap">' + fmtDate(b.date) + '</td>'
      + '<td style="white-space:nowrap"><span' + dueCls + '>' + fmtDate(due) + '</span></td>'
      + '<td>' + vendorCell(b.vendor) + '</td>'
      + '<td><a href="/' + COMPANY + '/bill/' + b.bill_id + '" class="ref-link">' + esc(b.vendor_ref || b.bill_id) + '</a></td>'
      + '<td style="text-align:right;font-variant-numeric:tabular-nums">' + Number(b.amount||0).toFixed(2) + '</td>'
      + '<td>' + statusBadge(b.status, due) + '</td>'
      + '<td style="text-align:right"><a href="/' + COMPANY + '/bill/' + b.bill_id + '" class="view-link">View</a></td>'
      + '</tr>';
  });
  document.getElementById('bills-tbody').innerHTML = html;

  // Pagination
  var pagRow = document.getElementById('pagination-row');
  if (total <= PAGE_SIZE) {
    setText('pag-info', 'Showing ' + total + ' entr' + (total !== 1 ? 'ies' : 'y'));
    pagRow.style.display = 'none';
  } else {
    pagRow.style.display = '';
    setText('pag-info', 'Showing ' + (start+1) + ' to ' + end + ' of ' + total + ' entries');
    renderPagination(totalPages);
  }
}

function renderPagination(totalPages) {
  var btns = '';
  btns += '<button class="page-btn" onclick="goPage(' + (currentPage-1) + ')" ' + (currentPage===1?'disabled':'') + '>Prev</button>';
  var lo = Math.max(1, currentPage-2), hi = Math.min(totalPages, currentPage+2);
  if (lo > 1) btns += '<button class="page-btn" onclick="goPage(1)">1</button>' + (lo>2?'<span style="padding:0 4px;color:#aaa">&hellip;</span>':'');
  for (var p = lo; p <= hi; p++) {
    btns += '<button class="page-btn' + (p===currentPage?' active':'') + '" onclick="goPage(' + p + ')">' + p + '</button>';
  }
  if (hi < totalPages) btns += (hi<totalPages-1?'<span style="padding:0 4px;color:#aaa">&hellip;</span>':'') + '<button class="page-btn" onclick="goPage(' + totalPages + ')">' + totalPages + '</button>';
  btns += '<button class="page-btn" onclick="goPage(' + (currentPage+1) + ')" ' + (currentPage===totalPages?'disabled':'') + '>Next</button>';
  document.getElementById('pag-btns').innerHTML = btns;
}

function goPage(p) {
  currentPage = p;
  renderPage();
  window.scrollTo(0,0);
}

function vendorCell(name) {
  if (!name) return '<span style="color:#aaa">\u2014</span>';
  var initials = name.trim().split(/\\s+/).map(function(w){ return w[0]; }).slice(0,2).join('').toUpperCase();
  var color = AVATAR_COLORS[Math.abs(hashStr(name)) % AVATAR_COLORS.length];
  return '<div class="vendor-cell">'
    + '<span class="avatar" style="background:' + color + '">' + esc(initials) + '</span>'
    + '<span>' + esc(name) + '</span>'
    + '</div>';
}

function hashStr(s) {
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function fmtDate(d) {
  if (!d) return '\u2014';
  var s = String(d).slice(0,10);
  var parts = s.split('-');
  if (parts.length !== 3) return s;
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return parts[2] + ' ' + months[parseInt(parts[1],10)-1] + ' ' + parts[0];
}

function statusBadge(status, dueDate) {
  var isOverdue = (status === 'posted' || status === 'partial') && dueDate && String(dueDate).slice(0,10) < today;
  if (isOverdue) return '<span class="badge" style="background:#fff0f0;color:#cc2222">Overdue</span>';
  if (status === 'posted')  return '<span class="badge" style="background:#e8eeff;color:#2255cc">Open</span>';
  if (status === 'partial') return '<span class="badge" style="background:#fff3e0;color:#cc7700">Partial</span>';
  if (status === 'paid')    return '<span class="badge" style="background:#f0fff4;color:#2a8a2a">Paid</span>';
  if (status === 'void')    return '<span class="badge" style="background:#f0f0f0;color:#888">Void</span>';
  return '<span class="badge" style="background:#f0f0f0;color:#888">' + esc(status||'') + '</span>';
}

function showMsg(msg) {
  document.getElementById('bills-tbody').innerHTML =
    '<tr><td colspan="7" style="text-align:center;color:#aaa;padding:32px">' + esc(msg) + '</td></tr>';
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ========== PAYABLES TAB SWITCHER ==========
function showPayTab(t) {
  ['bills','vendors'].forEach(function(id) {
    document.getElementById('pay-panel-' + id).style.display = (id === t) ? '' : 'none';
    var tabEl = document.getElementById('pay-tab-' + id);
    if (tabEl) tabEl.classList.toggle('active', id === t);
  });
  if (t === 'vendors') { loadVendorTable(); loadVendorAccounts(); }
}

// ========== VENDOR MANAGEMENT ==========
var vendorAccountsList = [];
var vendorAcctActiveInput = null;

function loadVendorAccounts() {
  if (vendorAccountsList.length) return;
  fetch('/api/' + COMPANY + '/accounts').then(function(r){ return r.json(); }).then(function(rows){
    vendorAccountsList = Array.isArray(rows) ? rows : [];
  }).catch(function(){});
}

function loadVendorTable() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'vendor.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var rows = (res.data || res);
      var tbody = document.getElementById('vendors-body');
      tbody.innerHTML = '';
      if (Array.isArray(rows)) rows.forEach(addVendorRow);
      appendBlankVendorRow();
    }).catch(function(){});
}

function addVendorRow(v) {
  v = v || {};
  var isNew = !v.vendor_id;
  var tr = document.createElement('tr');
  tr.dataset.vendorId = v.vendor_id || '';
  tr.dataset.dirty = isNew ? '1' : '0';
  tr.innerHTML =
    '<td><input type="text" value="' + (v.name||'') + '" placeholder="Vendor name" style="width:200px"></td>' +
    '<td><input type="text" value="' + (v.default_currency||'') + '" maxlength="3" style="width:45px"></td>' +
    '<td><input type="number" value="' + (v.payment_terms_days||30) + '" style="width:55px"></td>' +
    '<td><input type="text" value="' + (v.default_expense_account||'') + '" style="width:90px" placeholder="code" autocomplete="off" oninput="payVendorAcctInput(this)" onblur="hidePayVendorAcctDd()"></td>' +
    '<td><input type="text" value="' + (v.default_ap_account||'') + '" style="width:90px" placeholder="code" autocomplete="off" oninput="payVendorAcctInput(this)" onblur="hidePayVendorAcctDd()"></td>' +
    '<td style="text-align:center"><input type="checkbox"' + (v.is_active===true ? ' checked' : '') + '></td>' +
    '<td style="white-space:nowrap;text-align:right"></td>';

  // Save button
  var saveBtn = document.createElement('button');
  saveBtn.className = 'btn-sm';
  saveBtn.title = 'Save this row';
  saveBtn.innerHTML = '\uD83D\uDCBE';
  saveBtn.style.cssText = 'opacity:' + (isNew ? '1' : '0.35') + ';margin-right:4px';
  saveBtn.onclick = function() { saveVendorRow(tr); };

  // Delete button
  var delBtn = document.createElement('button');
  delBtn.className = 'btn-sm danger';
  delBtn.title = 'Delete vendor';
  delBtn.innerHTML = '\u2715';
  delBtn.onclick = function() { deleteVendorRow(tr); };

  tr.cells[tr.cells.length - 1].appendChild(saveBtn);
  tr.cells[tr.cells.length - 1].appendChild(delBtn);

  // Mark dirty and brighten save button on any change
  tr.querySelectorAll('input').forEach(function(el) {
    el.addEventListener('input', function() {
      tr.dataset.dirty = '1';
      saveBtn.style.opacity = '1';
      // If this is the blank row and name got filled, add another blank row
      if (isNew && el === tr.cells[0].querySelector('input') && el.value.trim()) {
        isNew = false;
        tr.dataset.vendorId = tr.dataset.vendorId || '';
        appendBlankVendorRow();
      }
    });
    el.addEventListener('change', function() {
      tr.dataset.dirty = '1';
      saveBtn.style.opacity = '1';
    });
  });
  tr.querySelectorAll('input[type=checkbox]').forEach(function(el) {
    el.addEventListener('change', function() {
      tr.dataset.dirty = '1';
      saveBtn.style.opacity = '1';
    });
  });

  document.getElementById('vendors-body').appendChild(tr);
  return tr;
}

function appendBlankVendorRow() {
  // Only append if last row isn't already blank
  var tbody = document.getElementById('vendors-body');
  var rows = tbody.querySelectorAll('tr');
  if (rows.length > 0) {
    var lastNameInput = rows[rows.length - 1].cells[0].querySelector('input');
    if (lastNameInput && !lastNameInput.value.trim()) return; // already blank
  }
  addVendorRow({});
}

// saveVendors: replaced by per-row saveVendorRow()

function saveVendorRow(tr) {
  var inputs = tr.querySelectorAll('input');
  var name = inputs[0].value.trim();
  if (!name) {
    var msgEl = document.getElementById('msg-vendors');
    if (msgEl) { msgEl.textContent = 'Name is required.'; msgEl.className = 'msg err'; }
    inputs[0].focus();
    return;
  }
  var vendor = {
    vendor_id: tr.dataset.vendorId || null,
    name: name,
    default_currency: inputs[1].value.trim() || null,
    payment_terms_days: parseInt(inputs[2].value) || 30,
    default_expense_account: inputs[3].value.trim() || null,
    default_ap_account: inputs[4].value.trim() || null,
    is_active: inputs[5].checked
  };
  var saveBtn = tr.querySelector('button.btn-sm:not(.danger)');
  if (saveBtn) { saveBtn.innerHTML = '\u23F3'; saveBtn.disabled = true; }
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'vendor.upsert', companyId: COMPANY, vendor: vendor }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var d = res.data || res;
      var msgEl = document.getElementById('msg-vendors');
      if (d.error || res.error) {
        if (msgEl) { msgEl.textContent = d.error || res.error; msgEl.className = 'msg err'; }
        if (saveBtn) { saveBtn.innerHTML = '\uD83D\uDCBE'; saveBtn.disabled = false; }
      } else {
        // Store the returned/assigned vendorId on the row
        if (d.vendorId) tr.dataset.vendorId = d.vendorId;
        tr.dataset.dirty = '0';
        if (saveBtn) { saveBtn.innerHTML = '\u2713'; saveBtn.style.opacity='0.35'; saveBtn.disabled = false; setTimeout(function(){ saveBtn.innerHTML='\uD83D\uDCBE'; }, 1500); }
        if (msgEl) { msgEl.textContent = 'Saved.'; msgEl.className = 'msg ok'; setTimeout(function(){ msgEl.textContent=''; }, 2000); }
      }
    })
    .catch(function(e){
      var msgEl = document.getElementById('msg-vendors');
      if (msgEl) { msgEl.textContent = e.message; msgEl.className = 'msg err'; }
      if (saveBtn) { saveBtn.innerHTML = '\uD83D\uDCBE'; saveBtn.disabled = false; }
    });
}

function deleteVendorRow(tr) {
  var name = tr.cells[0].querySelector('input').value.trim();
  var vendorId = tr.dataset.vendorId;
  // If no vendorId (unsaved new row) just remove from DOM
  if (!vendorId) { tr.remove(); appendBlankVendorRow(); return; }
  if (!confirm('Delete vendor "' + (name || vendorId) + '"?')) return;
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'vendor.delete', companyId: COMPANY, vendorId: vendorId }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var d = res.data || res;
      if (d.error || res.error) {
        var msgEl = document.getElementById('msg-vendors');
        if (msgEl) { msgEl.textContent = d.error || res.error; msgEl.className = 'msg err'; }
      } else {
        tr.remove();
        appendBlankVendorRow();
      }
    })
    .catch(function(e){
      var msgEl = document.getElementById('msg-vendors');
      if (msgEl) { msgEl.textContent = e.message; msgEl.className = 'msg err'; }
    });
}

function payVendorAcctInput(input) {
  loadVendorAccounts();
  vendorAcctActiveInput = input;
  var q = input.value.trim().toLowerCase();
  var dd = document.getElementById('pay-vendor-acct-dd');
  if (dd) dd.remove();
  if (!q) return;
  var matches = vendorAccountsList.filter(function(a){
    return (a.account_code||'').toLowerCase().includes(q) || (a.account_name||'').toLowerCase().includes(q);
  }).slice(0, 12);
  if (!matches.length) return;
  var div = document.createElement('div');
  div.id = 'pay-vendor-acct-dd';
  div.style.cssText = 'position:fixed;background:#fff;border:1px solid #ccc;z-index:9999;max-height:200px;overflow-y:auto;font-size:11px;box-shadow:0 2px 6px rgba(0,0,0,.2)';
  matches.forEach(function(a){
    var item = document.createElement('div');
    item.textContent = a.account_code + ' - ' + a.account_name;
    item.style.cssText = 'padding:4px 8px;cursor:pointer;white-space:nowrap';
    item.onmouseover = function(){ item.style.background='#e8f0fe'; };
    item.onmouseout  = function(){ item.style.background=''; };
    item.onmousedown = function(e){ e.preventDefault(); };
    item.onclick = function(){
      if (vendorAcctActiveInput) {
        vendorAcctActiveInput.value = a.account_code;
        vendorAcctActiveInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      var d = document.getElementById('pay-vendor-acct-dd');
      if (d) d.remove();
      vendorAcctActiveInput = null;
    };
    div.appendChild(item);
  });
  var rect = input.getBoundingClientRect();
  div.style.left = rect.left + 'px';
  div.style.top  = (rect.bottom + 2) + 'px';
  div.style.minWidth = rect.width + 'px';
  document.body.appendChild(div);
}

function hidePayVendorAcctDd() {
  setTimeout(function(){ var dd = document.getElementById('pay-vendor-acct-dd'); if (dd) dd.remove(); }, 150);
}
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handlePayablesPage };
