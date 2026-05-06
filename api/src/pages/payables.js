'use strict';
const { commonStyle, navBar, layoutEnd } = require('./common');
const { query } = require('../db');

async function handlePayablesPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const [co] = await query(`SELECT jurisdiction, base_currency FROM companies WHERE company_id = @cid LIMIT 1`, { cid: company }).catch(() => [{}]);
  const taxLabel = (co && co.jurisdiction === 'SG') ? 'GST' : 'VAT';
  const baseCurrency = (co && co.base_currency) || 'SGD';
  res.send(buildPayablesPage(company, taxLabel, baseCurrency));
}

function buildPayablesPage(company, taxLabel = 'VAT', baseCurrency = 'SGD') {
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
  .data-table th { text-align:left; font-size:8.5pt; color:#555; font-weight:600; text-transform:uppercase; letter-spacing:.05em; background:#fafafa; border-bottom:1px solid #e8e8e8; padding:12px 18px; }
  .data-table td { padding:14px 18px; border-bottom:1px solid #f2f2f2; vertical-align:middle; color:#222; }
  .data-table tbody tr:last-child td { border-bottom:none; }
  .data-table tbody tr:hover td { background:#fafafa; }
  .data-table tbody tr[data-url] { cursor:pointer; }

  /* Sortable/filterable column headers */
  .data-table th.sortable { cursor:pointer; user-select:none; }
  .data-table th.sortable:hover { background:#f0f0f0; }
  .th-inner { display:flex; align-items:center; gap:4px; }
  .th-sort { font-size:8pt; color:#1a1a1a; width:12px; text-align:center; flex-shrink:0; }
  .th-filter-btn { margin-left:auto; font-size:8pt; color:#bbb; padding:1px 3px; border-radius:3px; opacity:0; transition:opacity .1s; cursor:pointer; line-height:1; }
  th:hover .th-filter-btn,
  th.col-filtered .th-filter-btn { opacity:1; }
  th.col-filtered .th-filter-btn { color:#2255cc; }
  .col-filter-dd { position:fixed; background:#fff; border:1px solid #ddd; border-radius:6px; z-index:9999; min-width:180px; box-shadow:0 4px 12px rgba(0,0,0,.12); overflow:hidden; padding:10px; }
  .col-filter-dd-item { padding:8px 14px; cursor:pointer; font-size:10pt; white-space:nowrap; border-radius:4px; }
  .col-filter-dd-item:hover { background:#f5f5f5; }
  .col-filter-dd-item.active { font-weight:700; color:#2255cc; }
  .col-filter-dd-clear { color:#999; font-style:italic; font-size:9.5pt; border-bottom:1px solid #eee; margin-bottom:4px; padding-bottom:6px; border-radius:0; }
  .col-filter-dd label { font-size:8.5pt; color:#888; font-weight:600; text-transform:uppercase; letter-spacing:.04em; display:block; margin-bottom:5px; }
  .col-filter-dd input[type=date],
  .col-filter-dd input[type=text],
  .col-filter-dd input[type=number] { width:100%; padding:7px 9px; border:1px solid #ccc; border-radius:4px; font-size:10pt; box-sizing:border-box; margin-bottom:6px; }
  .col-filter-dd select { width:100%; padding:6px 8px; border:1px solid #ccc; border-radius:4px; font-size:10pt; background:#fff; margin-bottom:6px; }
  .col-filter-dd-apply { width:100%; padding:7px; background:#1a1a1a; color:#fff; border:none; border-radius:4px; font-size:10pt; cursor:pointer; }
  .col-filter-dd-apply:hover { background:#333; }

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

  <!-- KPI cards (moved above tabs) -->
  <div class="kpi-row">
    <div class="kpi-card">
      <div class="kpi-label">Total Outstanding (${baseCurrency})</div>
      <div class="kpi-amount" id="kpi-outstanding">—</div>
      <div class="kpi-count" id="kpi-outstanding-count"></div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Overdue (${baseCurrency})</div>
      <div class="kpi-amount overdue" id="kpi-overdue">—</div>
      <div class="kpi-count" id="kpi-overdue-count"></div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Upcoming (Next 7 Days)</div>
      <div class="kpi-amount" id="kpi-upcoming">—</div>
      <div class="kpi-count" id="kpi-upcoming-count"></div>
    </div>
  </div>

  <div class="tabs" style="margin-bottom:20px">
    <div class="tab active" id="pay-tab-bills" onclick="showPayTab('bills')">Bills</div>
    <div class="tab" id="pay-tab-vendors" onclick="showPayTab('vendors')">Vendors</div>
  </div>

  <div id="pay-panel-bills">

  <!-- Table card -->
  <div class="table-card">
    <table class="data-table">
      <thead>
        <tr>
          <th class="sortable" data-col="date" data-filter-type="date"><div class="th-inner"><span class="th-sort"></span><span class="th-label">Date</span><span class="th-filter-btn" title="Filter by date">≡</span></div></th>
          <th class="sortable" data-col="due_date" data-filter-type="date"><div class="th-inner"><span class="th-sort"></span><span class="th-label">Due</span><span class="th-filter-btn" title="Filter by due date">≡</span></div></th>
          <th class="sortable" data-col="vendor" data-filter-type="text"><div class="th-inner"><span class="th-sort"></span><span class="th-label">Vendor</span><span class="th-filter-btn" title="Filter by vendor">≡</span></div></th>
          <th data-col="vendor_ref" data-filter-type="text"><div class="th-inner"><span class="th-label">Reference</span><span class="th-filter-btn" title="Filter by reference">≡</span></div></th>
          <th class="sortable" data-col="amount" data-filter-type="amount" style="text-align:right"><div class="th-inner"><span class="th-sort"></span><span class="th-label">Amount</span><span class="th-filter-btn" title="Filter by amount">≡</span></div></th>
          <th class="sortable" data-col="currency" data-filter-type="list"><div class="th-inner"><span class="th-sort"></span><span class="th-label">CCY</span><span class="th-filter-btn" title="Filter by currency">≡</span></div></th>
          <th class="sortable" data-col="status" data-filter-type="list"><div class="th-inner"><span class="th-sort"></span><span class="th-label">Status</span><span class="th-filter-btn" title="Filter by status">≡</span></div></th>
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
var BASE_CURRENCY = '${baseCurrency}';
var allBills = [];
var filteredBills = [];
var today = new Date().toISOString().slice(0,10);
var in7days = new Date(Date.now() + 7*24*3600*1000).toISOString().slice(0,10);
var PAGE_SIZE = 20;
var currentPage = 1;
var sortState = { col: null, dir: 'asc' };
var colFilters = {};

var AVATAR_COLORS = ['#4f6ef7','#e05c5c','#2bac72','#e09d3a','#9b59c4','#17a2b8','#e07840','#5c7ae0'];

function fbPageInitPayables() {
  loadVendors();
  loadAllBills();
  initBillsTable();
  registerBillKeyActions();
}
window.addEventListener('DOMContentLoaded', fbPageInitPayables);
window.fbPageInit = fbPageInitPayables;

function initBillsTable() {
  // Row click → navigate to bill
  var tbody = document.getElementById('bills-tbody');
  if (tbody) {
    tbody.addEventListener('click', function(e) {
      if (e.target.closest('a[href]')) return; // let links handle themselves
      var tr = e.target.closest('tr[data-url]');
      if (tr) fbNavigate(tr.dataset.url);
    });
  }

  // Header sort + filter
  document.querySelectorAll('.data-table th[data-col]').forEach(function(th) {
    var col = th.dataset.col;
    var label = th.querySelector('.th-label');
    var sortIcon = th.querySelector('.th-sort');
    var filterBtn = th.querySelector('.th-filter-btn');

    if (label && sortIcon && th.classList.contains('sortable')) {
      th.addEventListener('click', function(e) {
        if (e.target.closest('.th-filter-btn')) return; // filter button handles its own click
        if (sortState.col === col) {
          sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
        } else {
          sortState.col = col;
          sortState.dir = 'asc';
        }
        // Update all sort icons
        document.querySelectorAll('.data-table th[data-col] .th-sort').forEach(function(ic) { ic.textContent = ''; ic.classList.remove('on'); });
        sortIcon.textContent = sortState.dir === 'asc' ? '▲' : '▼';
        sortIcon.classList.add('on');
        applyFilters();
      });
    }

    if (filterBtn) {
      filterBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        openColFilter(th, col);
      });
    }
  });
}

function openColFilter(th, col) {
  // Close any existing dropdown
  var existing = document.getElementById('col-filter-dd');
  if (existing) { existing.remove(); if (existing.dataset.col === col) return; }

  var filterType = th.dataset.filterType || 'list';
  var dd = document.createElement('div');
  dd.id = 'col-filter-dd';
  dd.className = 'col-filter-dd';
  dd.dataset.col = col;

  if (filterType === 'date') {
    // Calendar picker
    var lbl = document.createElement('label');
    lbl.textContent = 'Pick a date';
    var inp = document.createElement('input');
    inp.type = 'date';
    inp.value = colFilters[col] || '';
    var clearBtn = document.createElement('div');
    clearBtn.className = 'col-filter-dd-item col-filter-dd-clear';
    clearBtn.textContent = 'Clear filter';
    clearBtn.addEventListener('click', function() {
      delete colFilters[col]; th.classList.remove('col-filtered'); dd.remove(); applyFilters();
    });
    var applyBtn = document.createElement('button');
    applyBtn.className = 'col-filter-dd-apply';
    applyBtn.textContent = 'Apply';
    applyBtn.addEventListener('click', function() {
      var v = inp.value;
      if (v) { colFilters[col] = v; th.classList.add('col-filtered'); }
      else { delete colFilters[col]; th.classList.remove('col-filtered'); }
      dd.remove(); applyFilters();
    });
    dd.appendChild(lbl);
    dd.appendChild(inp);
    dd.appendChild(clearBtn);
    dd.appendChild(applyBtn);

  } else if (filterType === 'text') {
    // Free-text contains filter (simplified: no buttons, just input + autosearch)
    var inp2 = document.createElement('input');
    inp2.type = 'text';
    inp2.placeholder = 'Type to filter…';
    inp2.value = colFilters[col] || '';
    inp2.style.width = '100%';
    inp2.style.padding = '9px';
    inp2.style.border = '1px solid #ccc';
    inp2.style.borderRadius = '4px';
    inp2.style.fontSize = '10pt';
    inp2.style.boxSizing = 'border-box';
    inp2.style.marginBottom = '0';
    var debounceTimer = null;
    inp2.addEventListener('input', function(e) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function() {
        var v = inp2.value.trim();
        if (v) { colFilters[col] = v; th.classList.add('col-filtered'); }
        else { delete colFilters[col]; th.classList.remove('col-filtered'); }
        applyFilters();
      }, 150);
    });
    inp2.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        clearTimeout(debounceTimer);
        var v = inp2.value.trim();
        if (v) { colFilters[col] = v; th.classList.add('col-filtered'); }
        else { delete colFilters[col]; th.classList.remove('col-filtered'); }
        dd.remove();
        applyFilters();
      } else if (e.key === 'Escape') {
        dd.remove();
      }
    });
    dd.appendChild(inp2);

  } else if (filterType === 'amount') {
    // Operator + value filter
    var lbl3 = document.createElement('label');
    lbl3.textContent = 'Amount filter';
    var opSel = document.createElement('select');
    opSel.innerHTML = '<option value="=">=  Equal to</option><option value=">">&gt;  Greater than</option><option value="<">&lt;  Less than</option>';
    if (colFilters[col]) opSel.value = colFilters[col].op;
    var inp3 = document.createElement('input');
    inp3.type = 'number';
    inp3.placeholder = '0.00';
    inp3.step = '0.01';
    inp3.min = '0';
    if (colFilters[col]) inp3.value = colFilters[col].val;
    var clearBtn3 = document.createElement('div');
    clearBtn3.className = 'col-filter-dd-item col-filter-dd-clear';
    clearBtn3.textContent = 'Clear filter';
    clearBtn3.addEventListener('click', function() {
      delete colFilters[col]; th.classList.remove('col-filtered'); dd.remove(); applyFilters();
    });
    var applyBtn3 = document.createElement('button');
    applyBtn3.className = 'col-filter-dd-apply';
    applyBtn3.textContent = 'Apply';
    applyBtn3.addEventListener('click', function() {
      var v = inp3.value.trim();
      if (v !== '') {
        colFilters[col] = { op: opSel.value, val: Number(v) };
        th.classList.add('col-filtered');
      } else {
        delete colFilters[col];
        th.classList.remove('col-filtered');
      }
      dd.remove(); applyFilters();
    });
    dd.appendChild(lbl3);
    dd.appendChild(opSel);
    dd.appendChild(inp3);
    dd.appendChild(clearBtn3);
    dd.appendChild(applyBtn3);

  } else {
    // List (single-select): status, currency
    var vals = [];
    if (col === 'currency') {
      // Collect all unique currencies from bills
      allBills.forEach(function(b) {
        var v = b.currency || BASE_CURRENCY;
        v = String(v);
        if (vals.indexOf(v) === -1) vals.push(v);
      });
    } else {
      // For other list types
      allBills.forEach(function(b) {
        var v = b[col];
        if (v == null || v === '') return;
        v = String(v);
        if (vals.indexOf(v) === -1) vals.push(v);
      });
    }
    if (col === 'status') {
      var hasOverdue = allBills.some(function(b) {
        var due = b.due_date ? String(b.due_date).slice(0,10) : null;
        return (b.status === 'posted' || b.status === 'partial') && due && due < today;
      });
      if (hasOverdue && vals.indexOf('overdue') === -1) vals.push('overdue');
    }
    vals.sort();
    var clearItem = document.createElement('div');
    clearItem.className = 'col-filter-dd-item col-filter-dd-clear';
    clearItem.textContent = 'All (clear filter)';
    clearItem.addEventListener('click', function() {
      delete colFilters[col]; th.classList.remove('col-filtered'); dd.remove(); applyFilters();
    });
    dd.appendChild(clearItem);
    vals.forEach(function(v) {
      var item = document.createElement('div');
      item.className = 'col-filter-dd-item' + (colFilters[col] === v ? ' active' : '');
      var dispV = col === 'status' ? (v === 'posted' ? 'Open' : v.charAt(0).toUpperCase() + v.slice(1)) : v;
      item.textContent = dispV;
      item.addEventListener('click', function() {
        colFilters[col] = v; th.classList.add('col-filtered'); dd.remove(); applyFilters();
      });
      dd.appendChild(item);
    });
  }

  // Position below the filter button
  var rect = th.getBoundingClientRect();
  dd.style.top = (rect.bottom + 4) + 'px';
  dd.style.left = Math.max(4, rect.right - 200) + 'px';
  document.body.appendChild(dd);

  // Focus first input
  var firstInput = dd.querySelector('input, select');
  if (firstInput) setTimeout(function() { firstInput.focus(); }, 10);

  // Close on outside click
  function onOutsideClick(e) {
    if (!dd.contains(e.target)) { dd.remove(); document.removeEventListener('click', onOutsideClick); }
  }
  setTimeout(function() { document.addEventListener('click', onOutsideClick); }, 0);
}

function registerBillKeyActions() {
  window.fbKeyActions = {
    'new': function() { fbNavigate('/' + COMPANY + '/bill/new'); },
    'delete': function(row) {
      var billId = row.dataset.billId;
      var vendor = row.dataset.vendor || billId;
      if (!billId) return;
      if (!confirm('Void bill from "' + vendor + '"? This will reverse the bill and cannot be undone.')) return;
      fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bill.void', companyId: COMPANY, billId: billId }) })
        .then(function(r) { return r.json(); })
        .then(function(res) {
          var d = res.data || res;
          if (res.error || d.error) {
            alert('Cannot void: ' + (res.error || d.error));
          } else {
            loadAllBills();
          }
        })
        .catch(function(e) { alert('Error: ' + e.message); });
    }
  };
}

function loadVendors() {
  // Vendors loaded into allBills data; no separate dropdown needed
}

function loadAllBills() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'bill.list', companyId: COMPANY }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    var rows = res.data || res || [];
    if (!Array.isArray(rows)) rows = [];
    allBills = rows;
    applyFilters();
    loadFxRatesForKpi(function(rateMap) { computeKpis(rows, rateMap); });
  })
  .catch(function(e){ showMsg('Error loading bills: ' + e.message); });
}

function loadFxRatesForKpi(callback) {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action: 'fx.rates.list', companyId: COMPANY }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    var rates = res.data || res || [];
    if (!Array.isArray(rates)) rates = [];
    var rateMap = {};
    rates.forEach(function(r) {
      if (!r.from_currency || !r.to_currency || !r.rate) return;
      var key = r.from_currency + '_' + r.to_currency;
      if (!rateMap[key] || String(r.rate_date||'') > String(rateMap[key].date||'')) {
        rateMap[key] = { rate: Number(r.rate), date: r.rate_date };
      }
    });
    callback(rateMap);
  })
  .catch(function(){ callback({}); });
}

function convertToBase(amt, currency, rateMap) {
  if (!currency || currency === BASE_CURRENCY) return amt;
  var key = currency + '_' + BASE_CURRENCY;
  if (rateMap[key]) return amt * rateMap[key].rate;
  var invKey = BASE_CURRENCY + '_' + currency;
  if (rateMap[invKey] && rateMap[invKey].rate) return amt / rateMap[invKey].rate;
  return amt; // no rate available — use raw
}

function computeKpis(bills, rateMap) {
  rateMap = rateMap || {};
  var outstandingAmt = 0, outstandingN = 0;
  var overdueAmt = 0, overdueN = 0;
  var upcomingAmt = 0, upcomingN = 0;
  bills.forEach(function(b) {
    var active = b.status === 'posted' || b.status === 'partial';
    if (!active) return;
    var amt = convertToBase(Number(b.amount || 0), b.currency, rateMap);
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
  filteredBills = allBills.filter(function(b) {
    // Column filters
    if (colFilters.status) {
      if (colFilters.status === 'overdue') {
        var due = b.due_date ? String(b.due_date).slice(0,10) : null;
        var active = b.status === 'posted' || b.status === 'partial';
        if (!active || !due || due >= today) return false;
      } else {
        if (b.status !== colFilters.status) return false;
      }
    }
    if (colFilters.vendor) {
      // Vendor now uses text filter (contains match, case-insensitive)
      if (String(b.vendor || '').toLowerCase().indexOf(colFilters.vendor.toLowerCase()) === -1) return false;
    }
    if (colFilters.date && String(b.date || '').slice(0,10) !== colFilters.date) return false;
    if (colFilters.due_date && String(b.due_date || '').slice(0,10) !== colFilters.due_date) return false;
    if (colFilters.vendor_ref) {
      if (String(b.vendor_ref || '').toLowerCase().indexOf(colFilters.vendor_ref.toLowerCase()) === -1) return false;
    }
    if (colFilters.currency) {
      if ((b.currency || BASE_CURRENCY) !== colFilters.currency) return false;
    }
    if (colFilters.amount) {
      var bAmt = Number(b.amount || 0);
      var fAmt = Number(colFilters.amount.val);
      var fOp  = colFilters.amount.op;
      if (fOp === '=' && bAmt !== fAmt) return false;
      if (fOp === '>' && bAmt <= fAmt) return false;
      if (fOp === '<' && bAmt >= fAmt) return false;
    }
    return true;
  });

  // Apply sort
  if (sortState.col) {
    var col = sortState.col, dir = sortState.dir;
    filteredBills = filteredBills.slice().sort(function(a, b) {
      var av = a[col] == null ? '' : a[col];
      var bv = b[col] == null ? '' : b[col];
      if (col === 'amount') { av = Number(av); bv = Number(bv); }
      else if (col === 'currency') { av = String(av); bv = String(bv); }
      else { av = String(av).toLowerCase(); bv = String(bv).toLowerCase(); }
      if (av < bv) return dir === 'asc' ? -1 : 1;
      if (av > bv) return dir === 'asc' ? 1 : -1;
      return 0;
    });
  }

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
    var rowUrl = '/' + COMPANY + '/bill/' + b.bill_id;
    html += '<tr data-url="' + rowUrl + '" data-bill-id="' + esc(String(b.bill_id)) + '" data-vendor="' + esc(b.vendor||'') + '">'
      + '<td style="white-space:nowrap">' + fmtDate(b.date) + '</td>'
      + '<td style="white-space:nowrap"><span' + dueCls + '>' + fmtDate(due) + '</span></td>'
      + '<td>' + vendorCell(b.vendor) + '</td>'
      + '<td><a href="' + rowUrl + '" class="ref-link" onclick="event.stopPropagation()">' + esc(b.vendor_ref || b.bill_id) + '</a></td>'
      + '<td style="text-align:right;font-variant-numeric:tabular-nums">' + Number(b.amount||0).toFixed(2) + '</td>'
      + '<td style="font-size:9pt;color:#666;text-align:center;width:50px">' + esc(b.currency || BASE_CURRENCY) + '</td>'
      + '<td>' + statusBadge(b.status, due) + '</td>'
      + '</tr>';
  });
  var tbody = document.getElementById('bills-tbody');
  if (!tbody) return;
  tbody.innerHTML = html;

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
  var el = document.getElementById('bills-tbody');
  if (!el) return;
  el.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#aaa;padding:32px">' + esc(msg) + '</td></tr>';
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
