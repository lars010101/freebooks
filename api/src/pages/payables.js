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
  .page-header h1 { margin:0 0 4px; font-size:1.667rem; font-weight:700; letter-spacing:-.01em; }
  .page-header .sub { margin:0; font-size:0.8125rem; color:#aaa; }
  .btn-create { display:inline-flex; align-items:center; gap:7px; padding:9px 20px; background:#1a1a1a; color:#fff; border:none; border-radius:6px; font-size:0.875rem; font-weight:600; text-decoration:none; cursor:pointer; }
  .btn-create:hover { background:#333; }

  /* KPI cards */
  .kpi-row { display:flex; gap:16px; margin-bottom:28px; }
  .kpi-card { flex:1; border:1px solid #e8e8e8; border-radius:8px; padding:20px 24px; background:#fff; }
  .kpi-label { font-size:0.75rem; color:#aaa; font-weight:600; text-transform:uppercase; letter-spacing:.06em; margin-bottom:10px; }
  .kpi-amount { font-size:1.667rem; font-weight:700; color:#1a1a1a; line-height:1; margin-bottom:6px; }
  .kpi-amount.overdue { color:#cc2222; }
  .kpi-count { font-size:0.75rem; color:#aaa; }

  /* Filter bar */
  .filter-bar { display:flex; gap:10px; align-items:center; margin-bottom:20px; flex-wrap:wrap; }
  .search-wrap { position:relative; flex:1; min-width:180px; }
  .search-wrap input { width:100%; padding:9px 12px 9px 36px; border:1px solid #ddd; border-radius:6px; font-size:0.8125rem; box-sizing:border-box; }
  .search-wrap input:focus { outline:none; border-color:#1a1a1a; }
  .search-icon { position:absolute; left:11px; top:50%; transform:translateY(-50%); color:#aaa; font-size:0.9375rem; pointer-events:none; }
  .filter-bar select { padding:9px 12px; border:1px solid #ddd; border-radius:6px; font-size:0.8125rem; background:#fff; }
  .filter-bar select:focus { outline:none; border-color:#1a1a1a; }

  /* Table card */
  .table-card { border:1px solid #e8e8e8; border-radius:8px; overflow:hidden; }
  .data-table { width:100%; border-collapse:collapse; font-size:0.875rem; }
  .data-table th { text-align:left; font-size:0.75rem; color:#555; font-weight:600; text-transform:uppercase; letter-spacing:.05em; background:#fafafa; border-bottom:1px solid #e8e8e8; padding:12px 18px; }
  .data-table td { padding:14px 18px; border-bottom:1px solid #f2f2f2; vertical-align:middle; color:#222; }
  .data-table tbody tr:last-child td { border-bottom:none; }
  .data-table tbody tr:hover td { background:#fafafa; }
  .data-table tbody tr[data-url] { cursor:pointer; }

  /* Sortable/filterable column headers */
  .data-table th.sortable { cursor:pointer; user-select:none; }
  .data-table th.sortable:hover { background:#f0f0f0; }
  .th-inner { display:flex; align-items:center; gap:4px; }
  .th-sort { font-size:0.6875rem; color:#1a1a1a; width:12px; text-align:center; flex-shrink:0; }
  .th-filter-btn { margin-left:auto; font-size:0.9375rem; color:#999; padding:3px 6px; border-radius:4px; opacity:0.45; transition:opacity .1s, color .1s; cursor:pointer; line-height:1; }
  th:hover .th-filter-btn { opacity:1; color:#555; }
  th.col-filtered .th-filter-btn { opacity:1; color:#2255cc; }
  .col-filter-dd { position:fixed; background:#fff; border:1px solid #ddd; border-radius:6px; z-index:9999; min-width:180px; box-shadow:0 4px 12px rgba(0,0,0,.12); overflow:hidden; padding:10px; }
  .col-filter-dd-item { padding:8px 14px; cursor:pointer; font-size:0.8125rem; white-space:nowrap; border-radius:4px; }
  .col-filter-dd-item:hover { background:#f5f5f5; }
  .col-filter-dd-item.active { font-weight:700; color:#2255cc; }
  .col-filter-dd-clear { color:#999; font-style:italic; font-size:0.8125rem; border-bottom:1px solid #eee; margin-bottom:4px; padding-bottom:6px; border-radius:0; }
  .col-filter-dd label { font-size:0.75rem; color:#888; font-weight:600; text-transform:uppercase; letter-spacing:.04em; display:block; margin-bottom:5px; }
  .col-filter-dd input[type=date],
  .col-filter-dd input[type=text],
  .col-filter-dd input[type=number] { width:100%; padding:7px 9px; border:1px solid #ccc; border-radius:4px; font-size:0.8125rem; box-sizing:border-box; margin-bottom:6px; }
  .col-filter-dd select { width:100%; padding:6px 8px; border:1px solid #ccc; border-radius:4px; font-size:0.8125rem; background:#fff; margin-bottom:6px; }
  .col-filter-dd-apply { width:100%; padding:7px; background:#1a1a1a; color:#fff; border:none; border-radius:4px; font-size:0.8125rem; cursor:pointer; }
  .col-filter-dd-apply:hover { background:#333; }

  /* Vendor avatar */
  .vendor-cell { display:flex; align-items:center; gap:10px; }
  .avatar { width:32px; height:32px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:0.75rem; font-weight:700; color:#fff; flex-shrink:0; }

  /* Badge */
  .badge { display:inline-block; padding:3px 10px; border-radius:20px; font-size:0.75rem; font-weight:600; }

  /* Link */
  .ref-link { color:#2255cc; text-decoration:none; font-weight:500; }
  .ref-link:hover { text-decoration:underline; }
  .view-link { color:#2255cc; text-decoration:none; font-size:0.8125rem; font-weight:500; }
  .view-link:hover { text-decoration:underline; }

  .overdue-date { color:#cc2222; font-weight:600; }

  /* Pagination */
  .pagination-row { display:flex; justify-content:space-between; align-items:center; padding:14px 18px; border-top:1px solid #f0f0f0; font-size:0.8125rem; color:#888; }
  .page-btns { display:flex; gap:4px; align-items:center; }
  .page-btn { padding:5px 11px; border:1px solid #ddd; border-radius:5px; background:#fff; cursor:pointer; font-size:0.75rem; color:#333; }
  .page-btn:hover { background:#f5f5f5; }
  .page-btn.active { background:#1a1a1a; color:#fff; border-color:#1a1a1a; }
  .page-btn:disabled { opacity:.4; cursor:default; }
  .tabs { display:flex; gap:0; border-bottom:2px solid #1a1a1a; margin-bottom:24px; }
  .tab { padding:8px 20px; cursor:pointer; font-weight:600; font-size:0.8125rem; color:#555; border-bottom:3px solid transparent; margin-bottom:-2px; }
  .tab.active { color:#1a1a1a; border-bottom-color:#1a1a1a; }


  .edit-table { width:100%; border-collapse:collapse; font-size:0.8125rem; }
  .edit-table th { text-align:left; font-size:0.75rem; text-transform:uppercase; color:#555; border-bottom:1px solid #ccc; padding:6px; }
  .edit-table td { padding:4px; border-bottom:1px solid #f0f0f0; vertical-align:middle; }
  .edit-table input[type=text], .edit-table select { width:100%; padding:4px 6px; border:1px solid #ddd; border-radius:3px; font-size:0.8125rem; }
  .btn-sm { padding:0 14px; height:32px; font-size:0.8125rem; cursor:pointer; border:1px solid #ccc; border-radius:3px; background:#f5f5f5; }

  /* Tree table — child rows */
  .child-row td { background:#fafafa; border-bottom:1px solid #f0f0f0; color:#444; padding:19px 18px; }
  .child-ccy { font-size:0.75rem; color:#666; text-align:center; }
  .child-row td.child-desc { padding-left:2rem; }
  .child-gst-row td { background:#f5f5f5; }

  /* Row state classes */
  tr[data-row-type="parent"]:hover td { background:#fafafa; }
  tr.row-expanded > td:first-child { color:#1a1a1a; font-weight:600; }
  tr.row-loading { opacity:0.6; }
  .child-row:last-child td { border-bottom:1px solid #e8e8e8; }

  /* Bills keyboard nav */
  tr.bill-row-focus td { background:#f0f4ff; }
  tr.bill-row-focus td.bill-cell-focus { background:#1a3a6b !important; color:#fff !important; }
  tr.bill-row-focus td.bill-cell-focus span:not(.avatar):not(.badge) { color:#fff !important; }
  tr.bill-row-focus td.bill-cell-focus .badge { opacity:0.85; }
  tr.bill-row-focus td.bill-cell-focus a { color:#fff !important; }

  .btn-sm:hover { background:#e8e8e8; }
  .btn-sm.danger { border-color:#cc2222; color:#cc2222; }
  button.btn-primary { padding:10px 24px; background:#1a1a1a; color:#fff; border:none; border-radius:4px; font-size:0.9375rem; font-weight:600; cursor:pointer; }
  button.btn-primary:hover { background:#333; }
  button.btn-primary:disabled { background:#ccc; color:#666; cursor:not-allowed; }
  .msg-pay { margin-top:10px; font-size:0.8125rem; }
  .msg-pay.ok { color:#2a8a2a; }
  .msg-pay.err { color:#cc2222; }

  /* Vendor cell navigation */
  .data-table tbody tr.vrow-selected td { background:#f0f4ff; }
  .data-table tbody tr.vrow-selected td.vcell-selected { background:#1a3a6b !important; color:#fff !important; }
  .data-table tbody tr.vrow-selected td.vcell-selected span:not(.avatar):not(.badge) { color:#fff !important; }
  .data-table tbody tr.vrow-selected td.vcell-selected .badge { opacity:0.85; }
  .data-table tbody td.vcell-editing,
  .data-table tbody tr.vrow-selected td.vcell-editing { background:#fff !important; color:#222 !important; box-shadow:inset 0 0 0 2px #1a3a6b; padding:3px 8px !important; }
  .data-table tbody td.vcell-editing input,
  .data-table tbody tr.vrow-selected td.vcell-editing input { border:none; outline:none; background:transparent; font-size:inherit; font-family:'Helvetica Neue',Arial,sans-serif !important; color:#222 !important; padding:0; box-sizing:border-box; }
  #vendors-body input { font-family:'Helvetica Neue',Arial,sans-serif !important; font-size:inherit !important; }
  #pay-vendor-ccy-dd, #pay-vendor-acct-dd { font-family:'Helvetica Neue',Arial,sans-serif !important; }
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
          <th class="sortable" data-col="vendor" data-filter-type="text"><div class="th-inner"><span class="th-sort"></span><span class="th-label">Vendor</span><span class="th-filter-btn" title="Filter by vendor">≡</span></div></th>
          <th class="sortable" data-col="date" data-filter-type="date"><div class="th-inner"><span class="th-sort"></span><span class="th-label">Date</span><span class="th-filter-btn" title="Filter by date">≡</span></div></th>
          <th class="sortable" data-col="due_date" data-filter-type="date"><div class="th-inner"><span class="th-sort"></span><span class="th-label">Due</span><span class="th-filter-btn" title="Filter by due date">≡</span></div></th>
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
    <div class="table-card">
      <table class="data-table" id="vendors-table">
        <thead>
          <tr>
            <th>Vendor</th>
            <th style="width:60px;text-align:center">CCY</th>
            <th style="width:90px;text-align:center">Terms (d)</th>
            <th style="width:140px">Expense A/C</th>
            <th style="width:140px">AP A/C</th>
            <th style="width:90px;text-align:center">Active</th>
          </tr>
        </thead>
        <tbody id="vendors-body">
          <tr><td colspan="6" style="text-align:center;color:#aaa;padding:32px">Loading&#8230;</td></tr>
        </tbody>
      </table>
    </div>
    <div style="margin-top:10px;display:flex;gap:12px;align-items:center">
      <span id="msg-vendors" style="font-size:0.875rem"></span>
      <span style="margin-left:auto;font-size:0.625rem;color:#bbb">hjkl&nbsp;navigate &nbsp;·&nbsp; i&nbsp;edit cell &nbsp;·&nbsp; a&nbsp;add &nbsp;·&nbsp; d&nbsp;delete &nbsp;·&nbsp; ~&nbsp;toggle active &nbsp;·&nbsp; Enter&nbsp;commit &nbsp;·&nbsp; Esc&nbsp;cancel</span>
    </div>
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
var taxCodeMap = {}; // vat_code → description

var treeState = {
  open: new Set(),
  isOpen: function(billId) { return this.open.has(String(billId)); },
  toggle: function(billId) {
    billId = String(billId);
    if (this.open.has(billId)) this.open.delete(billId);
    else this.open.add(billId);
  },
  setOpen: function(billId) { this.open.add(String(billId)); },
  setClose: function(billId) { this.open.delete(String(billId)); }
};

var cursor = {
  rowEl: null,
  col: 0,
  mode: 'NORMAL',

  set: function(rowEl, col) {
    document.querySelectorAll('tr.bill-row-focus').forEach(function(r){ r.classList.remove('bill-row-focus'); });
    document.querySelectorAll('td.bill-cell-focus').forEach(function(td){ td.classList.remove('bill-cell-focus'); });
    this.rowEl = rowEl || null;
    this.col = (col != null) ? col : 0;
    if (!rowEl) { window.fbBillCursorMid = false; return; }
    rowEl.classList.add('bill-row-focus');
    var cells = rowEl.querySelectorAll('td');
    if (cells[this.col]) cells[this.col].classList.add('bill-cell-focus');
    window.fbBillCursorMid = (this.col < cells.length - 1);
    var pm = document.getElementById('page-main');
    var rows = this.getVisibleRows();
    if (pm && rows.length && rows[0] === rowEl) {
      pm.scrollTo(0, 0);
    } else if (pm) {
      var rect = rowEl.getBoundingClientRect();
      var pmRect = pm.getBoundingClientRect();
      var pad = 8;
      if (rect.top < pmRect.top + pad) {
        pm.scrollBy({ top: rect.top - pmRect.top - pad, behavior: 'instant' });
      } else if (rect.bottom > pmRect.bottom - pad) {
        pm.scrollBy({ top: rect.bottom - pmRect.bottom + pad, behavior: 'instant' });
      }
    } else {
      rowEl.scrollIntoView({ block: 'nearest' });
    }
  },

  clear: function() { this.set(null, 0); },

  getVisibleRows: function() {
    var tbody = document.getElementById('bills-tbody');
    if (!tbody) return [];
    return Array.from(tbody.querySelectorAll('tr[data-row-type="parent"], tr[data-row-type="child"]'));
  },

  currentIndex: function() {
    if (!this.rowEl) return -1;
    return this.getVisibleRows().indexOf(this.rowEl);
  }
};

var kbd = {
  _registered: false,
  _lastKey: null,
  _lastKeyTimer: null,
  _lastMoveTime: 0,

  register: function() {
    // Remove old handler from any prior SPA navigation (script re-executes each time)
    if (window._fbBillKbdHandler) {
      document.removeEventListener('keydown', window._fbBillKbdHandler);
    }
    var self = this;
    window._fbBillKbdHandler = function(e) { self._handle(e); };
    document.addEventListener('keydown', window._fbBillKbdHandler);
  },

  _isBillsTabActive: function() {
    var bills_panel = document.getElementById('pay-panel-bills');
    if (!bills_panel) return false;
    return bills_panel.style.display !== 'none';
  },

  _handle: function(e) {
    if (!this._isBillsTabActive()) return;
    var tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;

    var rows = cursor.getVisibleRows();
    var idx = cursor.currentIndex();

    if (e.key === 'j') {
      e.preventDefault();
      var now = Date.now(); if (now - this._lastMoveTime < 40) return; this._lastMoveTime = now;
      if (idx === -1 && rows.length) { cursor.set(rows[0], 0); }
      else if (idx >= 0 && idx < rows.length - 1) { cursor.set(rows[idx + 1], cursor.col); }
      this._lastKey = null; return;
    }

    if (e.key === 'k') {
      e.preventDefault();
      var now2 = Date.now(); if (now2 - this._lastMoveTime < 40) return; this._lastMoveTime = now2;
      if (idx > 0) { cursor.set(rows[idx - 1], cursor.col); }
      else if (idx === 0) { cursor.clear(); }
      this._lastKey = null; return;
    }

    if (e.key === 'l') {
      e.preventDefault();
      if (cursor.rowEl) {
        var cells = cursor.rowEl.querySelectorAll('td');
        cursor.set(cursor.rowEl, Math.min(cursor.col + 1, cells.length - 1));
      }
      this._lastKey = null; return;
    }

    if (e.key === 'h') {
      e.preventDefault();
      if (cursor.rowEl && cursor.col > 0) { cursor.set(cursor.rowEl, cursor.col - 1); }
      this._lastKey = null; return;
    }

    if (e.key === 'G') {
      e.preventDefault();
      if (rows.length) cursor.set(rows[rows.length - 1], cursor.col || 0);
      this._lastKey = null; return;
    }

    if (e.key === ' ') {
      e.preventDefault();
      this._toggleFold();
      this._lastKey = null; return;
    }

    // Sequence: z_ and g_
    if (this._lastKey === 'z') {
      if (e.key === 'a') { e.preventDefault(); this._lastKey = null; window._fbBillZPending = false; this._toggleFold(); return; }
      if (e.key === 'o') { e.preventDefault(); this._lastKey = null; this._openFold(); return; }
      if (e.key === 'c') { e.preventDefault(); this._lastKey = null; this._closeFold(); return; }
      if (e.key === 'R') { e.preventDefault(); this._lastKey = null; this._expandAll(); return; }
      if (e.key === 'M') { e.preventDefault(); this._lastKey = null; this._collapseAll(); return; }
      this._lastKey = null;
    }

    if (this._lastKey === 'g' && e.key === 'g') {
      e.preventDefault(); this._lastKey = null;
      if (rows.length) cursor.set(rows[0], cursor.col || 0);
      return;
    }

    // Store key for sequences (ignore bare modifier keystrokes)
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
    this._lastKey = e.key;
    clearTimeout(this._lastKeyTimer);
    var self = this;
    this._lastKeyTimer = setTimeout(function(){ self._lastKey = null; window._fbBillZPending = false; }, 1000);

    if (e.key === 'z') { e.preventDefault(); window._fbBillZPending = true; }
    else if (e.key === 'g') { e.preventDefault(); }
  },

  _getParentRow: function() {
    if (!cursor.rowEl) return null;
    if (cursor.rowEl.dataset.rowType === 'parent') return cursor.rowEl;
    if (cursor.rowEl.dataset.rowType === 'child') {
      var pid = cursor.rowEl.dataset.parentId;
      return document.querySelector('tr[data-row-type="parent"][data-bill-id="' + pid + '"]');
    }
    return null;
  },

  _toggleFold: function() {
    var pr = this._getParentRow(); if (!pr) return;
    var billId = pr.dataset.billId;
    if (treeState.isOpen(billId)) this._closeFold(pr); else this._openFold(pr);
  },

  _openFold: function(parentRow) {
    parentRow = parentRow || this._getParentRow(); if (!parentRow) return;
    var billId = parentRow.dataset.billId;
    if (treeState.isOpen(billId)) return;
    treeState.setOpen(billId);
    toggleBillLines(billId, parentRow);
  },

  _closeFold: function(parentRow) {
    parentRow = parentRow || this._getParentRow(); if (!parentRow) return;
    var billId = parentRow.dataset.billId;
    if (!treeState.isOpen(billId)) return;
    if (cursor.rowEl && cursor.rowEl.dataset.rowType === 'child') cursor.set(parentRow, 0);
    treeState.setClose(billId);
    toggleBillLines(billId, parentRow);
  },

  _expandAll: function() {
    var tbody = document.getElementById('bills-tbody'); if (!tbody) return;
    tbody.querySelectorAll('tr[data-row-type="parent"]').forEach(function(pr) {
      var billId = pr.dataset.billId;
      var hasChildren = !!tbody.querySelector('tr[data-row-type="child"][data-parent-id="' + billId + '"]');
      if (!hasChildren) { treeState.setOpen(billId); toggleBillLines(billId, pr); }
    });
  },

  _collapseAll: function() {
    var tbody = document.getElementById('bills-tbody'); if (!tbody) return;
    if (cursor.rowEl && cursor.rowEl.dataset.rowType === 'child') {
      var pid = cursor.rowEl.dataset.parentId;
      var pr2 = tbody.querySelector('tr[data-row-type="parent"][data-bill-id="' + pid + '"]');
      if (pr2) cursor.set(pr2, 0);
    }
    tbody.querySelectorAll('tr[data-row-type="parent"]').forEach(function(pr) {
      var billId = pr.dataset.billId;
      var hasChildren = !!tbody.querySelector('tr[data-row-type="child"][data-parent-id="' + billId + '"]');
      if (hasChildren) { treeState.setClose(billId); toggleBillLines(billId, pr); }
    });
  }
};

var AVATAR_COLORS = ['#4f6ef7','#e05c5c','#2bac72','#e09d3a','#9b59c4','#17a2b8','#e07840','#5c7ae0'];

function fbPageInitPayables() {
  loadVendors();
  loadAllBills();
  initBillsTable();
  registerBillKeyActions();
  registerVendorKeyActions();
  kbd.register();
  window.fbBillNav = true;
  window.fbBillCursorMid = false;
  
  fetch('/api/' + COMPANY + '/vat-codes')
    .then(function(r){ return r.json(); })
    .then(function(codes){
      if (Array.isArray(codes)) {
        codes.forEach(function(c){ taxCodeMap[c.vat_code] = c.description || c.vat_code; });
      }
    })
    .catch(function(){});
}
window.addEventListener('DOMContentLoaded', fbPageInitPayables);
window.fbPageInit = fbPageInitPayables;

function initBillsTable() {
  var tbody = document.getElementById('bills-tbody');
  if (tbody) {
    tbody.addEventListener('click', function(e) {
      // Don't intercept badge clicks (status) or ref links
      if (e.target.closest('a.ref-link')) return;
      if (e.target.closest('.badge')) return;

      var parentTr = e.target.closest('tr[data-row-type="parent"]');
      if (parentTr) {
        var billId = parentTr.dataset.billId;
        if (billId) toggleBillLines(billId, parentTr);
      }
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
        if (e.target.closest('.th-filter-btn')) return;
        if (sortState.col === col) {
          sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
        } else {
          sortState.col = col;
          sortState.dir = 'asc';
        }
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

function toggleBillLines(billId, parentTr) {
  var existing = document.querySelector('tr[data-row-type="child"][data-parent-id="' + billId + '"]');

  if (existing) {
    var toRemove = document.querySelectorAll('tr[data-row-type="child"][data-parent-id="' + billId + '"]');
    toRemove.forEach(function(r) { r.remove(); });
    parentTr.classList.remove('row-expanded');
    treeState.setClose(billId);
    return;
  }

  parentTr.classList.add('row-loading');
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'bill.lines', companyId: COMPANY, billId: billId }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    var lines = res.data || res || [];
    if (!Array.isArray(lines)) lines = [];
    parentTr.classList.remove('row-loading');
    parentTr.classList.add('row-expanded');
    treeState.setOpen(billId);

    var insertAfter = parentTr;
    if (!lines.length) {
      var emptyTr = document.createElement('tr');
      emptyTr.dataset.rowType = 'child';
      emptyTr.dataset.parentId = billId;
      emptyTr.className = 'child-row';
      emptyTr.innerHTML = '<td colspan="7" class="child-desc" style="color:#aaa;font-style:italic">No line items</td>';
      insertAfter.insertAdjacentElement('afterend', emptyTr);
      return;
    }

    // Separate expense lines (vat_code null) from GST/VAT lines (vat_code set)
    var expenseLines = lines.filter(function(l){ return !l.vat_code; });
    var gstLines     = lines.filter(function(l){ return !!l.vat_code; });

    // Render expense lines first
    expenseLines.forEach(function(line) {
      var tr = document.createElement('tr');
      tr.dataset.rowType = 'child';
      tr.dataset.parentId = billId;
      tr.dataset.entryId = line.entry_id || '';
      tr.className = 'child-row';

      // Strip compound prefix — user description is always the last segment after ' / '
      var rawDesc = line.description || '';
      var sepIdx = rawDesc.lastIndexOf(' / ');
      var desc = sepIdx !== -1 ? rawDesc.slice(sepIdx + 3).trim() : rawDesc;

      tr.innerHTML = '<td colspan="4" class="child-desc">' + esc(desc) + '</td>'
        + '<td style="text-align:right;font-variant-numeric:tabular-nums">' + Number(line.amount || 0).toFixed(2) + '</td>'
        + '<td class="child-ccy">' + esc(line.currency || '') + '</td>'
        + '<td style="font-size:0.75rem;color:#999">' + esc(line.vat_code || '') + '</td>';

      insertAfter.insertAdjacentElement('afterend', tr);
      insertAfter = tr;
    });

    // Render GST/VAT lines after all expense lines
    gstLines.forEach(function(line) {
      var gstTr = document.createElement('tr');
      gstTr.dataset.rowType = 'child';
      gstTr.dataset.parentId = billId;
      gstTr.dataset.entryId = line.entry_id || '';
      gstTr.className = 'child-row child-gst-row';

      // Label: "SR9: Standard Rated 9%" from taxCodeMap, fallback to vat_code only
      var codeDesc = taxCodeMap[line.vat_code];
      var gstLabel = codeDesc ? esc(line.vat_code) + ': ' + esc(codeDesc) : esc(line.vat_code || 'GST/VAT');

      gstTr.innerHTML = '<td colspan="4" class="child-desc" style="color:#888;font-style:italic">' + gstLabel + '</td>'
        + '<td style="text-align:right;font-variant-numeric:tabular-nums;color:#888">' + Number(line.amount || 0).toFixed(2) + '</td>'
        + '<td class="child-ccy" style="color:#888">' + esc(line.currency || '') + '</td>'
        + '<td></td>';

      insertAfter.insertAdjacentElement('afterend', gstTr);
      insertAfter = gstTr;
    });
  })
  .catch(function(e){
    parentTr.classList.remove('row-loading');
    console.error('Error loading lines:', e);
  });
}

function openColFilter(th, col) {
  // Close any existing dropdown
  var existing = document.getElementById('col-filter-dd');
  if (existing) { existing.remove(); if (existing.dataset.col === col) return; }

  // Toggle: if column already has a filter, clear it and return
  if (th.classList.contains('col-filtered')) {
    delete colFilters[col];
    th.classList.remove('col-filtered');
    applyFilters();
    return;
  }

  var filterType = th.dataset.filterType || 'list';
  var dd = document.createElement('div');
  dd.id = 'col-filter-dd';
  dd.className = 'col-filter-dd';
  dd.dataset.col = col;

  if (filterType === 'date') {
    // Date filter: positioned dropdown with a single date input, auto-focused
    var inp = document.createElement('input');
    inp.type = 'date';
    inp.style.cssText = 'display:block;width:160px;padding:7px 9px;border:1px solid #ccc;border-radius:4px;font-size:0.8125rem;box-sizing:border-box;';
    if (colFilters[col]) inp.value = colFilters[col];
    inp.addEventListener('change', function() {
      var v = inp.value;
      if (v) { colFilters[col] = v; th.classList.add('col-filtered'); }
      else { delete colFilters[col]; th.classList.remove('col-filtered'); }
      dd.remove();
      applyFilters();
    });
    dd.appendChild(inp);
    setTimeout(function() { if (inp.showPicker) inp.showPicker(); }, 50);

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
    inp2.style.fontSize = '0.8125rem';
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
    inp3.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        var v = inp3.value.trim();
        if (v !== '') {
          colFilters[col] = { op: opSel.value, val: Number(v) };
          th.classList.add('col-filtered');
        } else {
          delete colFilters[col];
          th.classList.remove('col-filtered');
        }
        dd.remove();
        applyFilters();
      }
    });
    dd.appendChild(lbl3);
    dd.appendChild(opSel);
    dd.appendChild(inp3);
    setTimeout(function() { inp3.focus(); }, 50);

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

  // Close on outside click or Escape
  function onOutsideClick(e) {
    if (!dd.contains(e.target)) { cleanup(); }
  }
  function onEscape(e) {
    if (e.key === 'Escape') { e.stopPropagation(); cleanup(); }
  }
  function cleanup() {
    dd.remove();
    document.removeEventListener('click', onOutsideClick);
    document.removeEventListener('keydown', onEscape, true);
  }
  setTimeout(function() {
    document.addEventListener('click', onOutsideClick);
    document.addEventListener('keydown', onEscape, true);
  }, 0);
}

function registerBillKeyActions() {
  window.fbKeyActions = {
    'new': function() { if (window._fbBillZPending) { window._fbBillZPending = false; return; } fbNavigate('/' + COMPANY + '/bill/new'); },
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
  cursor.clear();
  var rows = filteredBills;

  if (!rows.length) {
    showMsg('No bills found.');
    document.getElementById('pagination-row').style.display = 'none';
    return;
  }

  var html = '';
  rows.forEach(function(b) {
    var due = b.due_date ? String(b.due_date).slice(0,10) : null;
    var active = b.status === 'posted' || b.status === 'partial';
    var isOverdue = active && due && due < today;
    var dueCls = isOverdue ? ' class="overdue-date"' : '';
    var rowUrl = '/' + COMPANY + '/bill/' + b.bill_id;
    html += '<tr data-row-type="parent" data-bill-id="' + esc(String(b.bill_id)) + '" data-vendor="' + esc(b.vendor||'') + '" style="cursor:pointer">'
      + '<td>' + vendorCell(b.vendor) + '</td>'
      + '<td style="white-space:nowrap">' + fmtDate(b.date) + '</td>'
      + '<td style="white-space:nowrap"><span' + dueCls + '>' + fmtDate(due) + '</span></td>'
      + '<td><a href="' + rowUrl + '" class="ref-link" onclick="event.stopPropagation()">' + esc(b.vendor_ref || b.bill_id) + '</a></td>'
      + '<td style="text-align:right;font-variant-numeric:tabular-nums">' + Number(b.amount||0).toFixed(2) + '</td>'
      + '<td style="font-size:0.75rem;color:#666;text-align:center;width:50px">' + esc(b.currency || BASE_CURRENCY) + '</td>'
      + '<td>' + statusBadge(b.status, due) + '</td>'
      + '</tr>';
  });
  var tbody = document.getElementById('bills-tbody');
  if (!tbody) return;
  tbody.innerHTML = html;
  document.getElementById('pagination-row').style.display = 'none';
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
  window.fbBillNav = (t === 'bills');
  ['bills','vendors'].forEach(function(id) {
    document.getElementById('pay-panel-' + id).style.display = (id === t) ? '' : 'none';
    var tabEl = document.getElementById('pay-tab-' + id);
    if (tabEl) tabEl.classList.toggle('active', id === t);
  });
  if (t === 'vendors') { loadVendorTable(); loadVendorAccounts(); loadVendorCurrencies(); }
}

// ========== VENDOR MANAGEMENT ==========
var vendorAccountsList = [];
var vendorAcctActiveInput = null;
var vendorCurrenciesList = [];
var allVendors = [];
var vendorSelRow = -1;
window.fbVendorSelRow = -1;
var vendorSelCol = 0;
var vendorCellEdit = false;
var vendorCellPreEdit = null;
var vendorDirtyRows = {};

var VENDOR_COL_EDIT_MAX = 4; // cols 0-4 editable; col 5 (Active) = toggle only

function loadVendorAccounts() {
  if (vendorAccountsList.length) return;
  fetch('/api/' + COMPANY + '/accounts').then(function(r){ return r.json(); }).then(function(rows){
    vendorAccountsList = Array.isArray(rows) ? rows : [];
  }).catch(function(){});
}

function loadVendorCurrencies() {
  if (vendorCurrenciesList.length) return;
  fetch('/db/currencies.json').then(function(r){ return r.json(); }).then(function(list){
    vendorCurrenciesList = Array.isArray(list) ? list : [];
  }).catch(function(){});
}

function loadVendorTable() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'vendor.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var rows = res.data || res;
      allVendors = Array.isArray(rows) ? rows : [];
      vendorDirtyRows = {};
      renderVendorTable();
      vendorSelRow = -1;
      vendorSelCol = 0;
      updateVendorCursor();
    }).catch(function(e){ vendorMsg('Error loading vendors: ' + e.message, 'err'); });
}

function renderVendorTable() {
  var tbody = document.getElementById('vendors-body');
  if (!tbody) return;
  if (!allVendors.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#aaa;padding:32px">No vendors yet. Press <b>a</b> to add one.</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  allVendors.forEach(function(v, i) {
    tbody.appendChild(buildVendorDisplayRow(v, i));
  });
}

function buildVendorDisplayRow(v, i) {
  var tr = document.createElement('tr');
  tr.dataset.vendorId = v.vendor_id || '';
  tr.dataset.idx      = String(i);
  tr.style.cursor = 'pointer';

  var activeBadge = v.is_active !== false
    ? '<span class="badge" style="background:#f0fff4;color:#2a8a2a">Active</span>'
    : '<span class="badge" style="background:#f0f0f0;color:#888">Inactive</span>';

  var cellContents = [
    vendorCell(v.name),
    esc(v.default_currency || '\u2014'),
    (v.payment_terms_days || 30) + '\u202fd',
    esc(v.default_expense_account || '\u2014'),
    esc(v.default_ap_account || '\u2014'),
    activeBadge
  ];
  var cellStyles = ['', 'text-align:center;color:#666', 'text-align:center;color:#444',
    '', '', 'text-align:center'];

  cellContents.forEach(function(content, col) {
    var td = document.createElement('td');
    td.dataset.col = String(col);
    td.className = 'vcell';
    td.innerHTML = content;
    if (cellStyles[col]) td.style.cssText = cellStyles[col];
    td.addEventListener('click', function() {
      if (vendorCellEdit && (vendorSelRow !== i || vendorSelCol !== col)) commitVendorCell(true);
      vendorSelRow = i; vendorSelCol = col;
      updateVendorCursor();
    });
    td.addEventListener('dblclick', function() {
      vendorSelRow = i; vendorSelCol = col;
      updateVendorCursor();
      if (col === 5) { vendorToggleActive(); return; }
      if (!vendorCellEdit) enterVendorCellEdit();
    });
    tr.appendChild(td);
  });
  return tr;
}

function updateVendorCursor() {
  window.fbVendorSelRow = vendorSelRow;
  document.querySelectorAll('#vendors-body tr.vrow-selected').forEach(function(r){ r.classList.remove('vrow-selected'); });
  document.querySelectorAll('#vendors-body td.vcell-selected').forEach(function(td){ td.classList.remove('vcell-selected'); });
  if (vendorSelRow < 0) return;
  var tr = document.querySelector('#vendors-body tr[data-idx="' + vendorSelRow + '"]');
  if (!tr) return;
  tr.classList.add('vrow-selected');
  var td = tr.querySelector('td[data-col="' + vendorSelCol + '"]');
  if (td) td.classList.add('vcell-selected');
  tr.scrollIntoView({ block: 'nearest' });
}

function getSelectedTd() {
  if (vendorSelRow < 0) return null;
  var tr = document.querySelector('#vendors-body tr[data-idx="' + vendorSelRow + '"]');
  if (!tr) return null;
  return tr.querySelector('td[data-col="' + vendorSelCol + '"]');
}

function enterVendorCellEdit() {
  if (vendorCellEdit) return;
  if (vendorSelRow < 0 || vendorSelCol > VENDOR_COL_EDIT_MAX) return;
  var td = getSelectedTd();
  if (!td) return;
  var v = allVendors[vendorSelRow];
  if (!v) return;
  vendorCellEdit = true;
  td.classList.add('vcell-editing');
  var colVals = [v.name || '', v.default_currency || '', String(v.payment_terms_days || 30),
    v.default_expense_account || '', v.default_ap_account || ''];
  vendorCellPreEdit = colVals[vendorSelCol];
  var input = document.createElement('input');
  if (vendorSelCol === 2) {
    input.type = 'number'; input.min = 0;
    input.style.cssText = 'width:60px;text-align:center;font-family:inherit;font-size:inherit';
  } else {
    input.type = 'text';
    if (vendorSelCol === 0) input.style.cssText = 'width:100%;min-width:160px;font-family:inherit;font-size:inherit';
    if (vendorSelCol === 1) { input.maxLength = 3; input.style.cssText = 'width:48px;text-align:center;text-transform:uppercase;font-family:inherit;font-size:inherit'; }
    if (vendorSelCol === 3 || vendorSelCol === 4) input.style.cssText = 'width:110px;font-family:inherit;font-size:inherit';
  }
  input.setAttribute('autocomplete', 'off');
  input.value = colVals[vendorSelCol];
  if (vendorSelCol === 1) {
    input.oninput = function(){ payVendorCcyInput(input); };
    input.onblur  = function(){ hidePayVendorCcyDd(); };
  }
  if (vendorSelCol === 3 || vendorSelCol === 4) {
    input.oninput = function(){ vendorAcctActiveInput = input; payVendorAcctInput(input); };
    input.onblur  = function(){ hidePayVendorAcctDd(); };
  }
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  input.select();
}

function commitVendorCell(save) {
  if (!vendorCellEdit) return;
  vendorCellEdit = false;
  var td = getSelectedTd();
  if (!td) return;
  td.classList.remove('vcell-editing');
  var dd1 = document.getElementById('pay-vendor-acct-dd'); if (dd1) dd1.remove();
  var dd2 = document.getElementById('pay-vendor-ccy-dd');  if (dd2) dd2.remove();
  var input = td.querySelector('input');
  var newVal = input ? input.value.trim() : vendorCellPreEdit;
  if (!save) { newVal = vendorCellPreEdit; }
  else {
    if (vendorSelCol === 1 && newVal && vendorCurrenciesList.length) {
      var ccyUp = newVal.toUpperCase();
      var valid = vendorCurrenciesList.some(function(c){ return (c.code||'').toUpperCase() === ccyUp; });
      if (!valid) { vendorMsg('Unknown currency: ' + ccyUp, 'err'); newVal = vendorCellPreEdit; save = false; }
    }
    if (save) {
      var v = allVendors[vendorSelRow];
      if (v) {
        if (vendorSelCol === 0) v.name = newVal;
        else if (vendorSelCol === 1) v.default_currency = newVal.toUpperCase() || null;
        else if (vendorSelCol === 2) v.payment_terms_days = parseInt(newVal) || 30;
        else if (vendorSelCol === 3) v.default_expense_account = newVal || null;
        else if (vendorSelCol === 4) v.default_ap_account = newVal || null;
        vendorDirtyRows[vendorSelRow] = true;
      }
    }
  }
  renderVendorCell(td, vendorSelCol, allVendors[vendorSelRow] || {});
  td.classList.add('vcell-selected');
}

function renderVendorCell(td, col, v) {
  if (col === 0) { td.innerHTML = vendorCell(v.name || ''); td.style.cssText = ''; }
  else if (col === 1) { td.textContent = v.default_currency || '\u2014'; td.style.cssText = 'text-align:center;color:#666'; }
  else if (col === 2) { td.textContent = (v.payment_terms_days || 30) + '\u202fd'; td.style.cssText = 'text-align:center;color:#444'; }
  else if (col === 3) { td.textContent = v.default_expense_account || '\u2014'; td.style.cssText = ''; }
  else if (col === 4) { td.textContent = v.default_ap_account || '\u2014'; td.style.cssText = ''; }
  else if (col === 5) {
    td.innerHTML = v.is_active !== false
      ? '<span class="badge" style="background:#f0fff4;color:#2a8a2a">Active</span>'
      : '<span class="badge" style="background:#f0f0f0;color:#888">Inactive</span>';
    td.style.cssText = 'text-align:center';
  }
}

function saveVendorRowIfDirty(rowIdx) {
  if (!vendorDirtyRows[rowIdx]) return;
  var v = allVendors[rowIdx];
  if (!v) return;
  if (!v.name) { vendorMsg('Vendor name required.', 'err'); return; }
  delete vendorDirtyRows[rowIdx];
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'vendor.upsert', companyId: COMPANY, vendor: {
      vendor_id: v.vendor_id || null, name: v.name,
      default_currency: v.default_currency || null,
      payment_terms_days: v.payment_terms_days || 30,
      default_expense_account: v.default_expense_account || null,
      default_ap_account: v.default_ap_account || null,
      is_active: v.is_active !== false
    }}) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var d = res.data || res;
      if (d.error || res.error) { vendorMsg(d.error || res.error, 'err'); vendorDirtyRows[rowIdx] = true; return; }
      if (d.vendorId && !v.vendor_id) {
        allVendors[rowIdx].vendor_id = d.vendorId;
        var tr = document.querySelector('#vendors-body tr[data-idx="' + rowIdx + '"]');
        if (tr) tr.dataset.vendorId = d.vendorId;
      }
      vendorMsg('Saved.', 'ok');
      setTimeout(function(){ vendorMsg('', ''); }, 2000);
    })
    .catch(function(e){ vendorMsg(e.message, 'err'); vendorDirtyRows[rowIdx] = true; });
}

function vendorMoveRow(dir) {
  if (vendorCellEdit) commitVendorCell(true);
  if (dir < 0) {
    if (vendorSelRow < 0) return; // no selection, nothing to do
    if (vendorSelRow === 0) { saveVendorRowIfDirty(0); vendorSelRow = -1; window.fbVendorSelRow = -1; updateVendorCursor(); return; }
  } else {
    if (vendorSelRow < 0) { vendorSelRow = 0; updateVendorCursor(); return; }
    if (vendorSelRow === allVendors.length - 1) { saveVendorRowIfDirty(vendorSelRow); vendorSelRow = -1; window.fbVendorSelRow = -1; updateVendorCursor(); return; }
  }
  saveVendorRowIfDirty(vendorSelRow);
  vendorSelRow = Math.max(0, Math.min(allVendors.length - 1, vendorSelRow + dir));
  updateVendorCursor();
}

function vendorMoveCol(dir) {
  if (vendorCellEdit) commitVendorCell(true);
  vendorSelCol = Math.max(0, Math.min(5, vendorSelCol + dir));
  updateVendorCursor();
}

function vendorAddNew() {
  if (vendorCellEdit) commitVendorCell(true);
  saveVendorRowIfDirty(vendorSelRow);
  allVendors.push({ vendor_id: '', name: '', default_currency: '', payment_terms_days: 30,
    default_expense_account: '', default_ap_account: '', is_active: true });
  renderVendorTable();
  vendorSelRow = allVendors.length - 1;
  vendorSelCol = 0;
  updateVendorCursor();
  var tbody = document.getElementById('vendors-body');
  if (tbody && tbody.lastElementChild) tbody.lastElementChild.scrollIntoView({ block: 'nearest' });
  enterVendorCellEdit();
}

function vendorToggleActive() {
  if (vendorCellEdit) commitVendorCell(true);
  var v = allVendors[vendorSelRow];
  if (!v) return;
  if (!v.vendor_id) { vendorMsg('Save the vendor first before toggling.', 'err'); return; }
  var newActive = v.is_active === false;
  v.is_active = newActive;
  var vendor = { vendor_id: v.vendor_id, name: v.name, default_currency: v.default_currency,
    payment_terms_days: v.payment_terms_days, default_expense_account: v.default_expense_account,
    default_ap_account: v.default_ap_account, is_active: newActive };
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'vendor.upsert', companyId: COMPANY, vendor: vendor }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var d = res.data || res;
      if (d.error || res.error) { v.is_active = !newActive; vendorMsg(d.error || res.error, 'err'); return; }
      var tr = document.querySelector('#vendors-body tr[data-idx="' + vendorSelRow + '"]');
      var activeTd = tr && tr.querySelector('td[data-col="5"]');
      if (activeTd) renderVendorCell(activeTd, 5, v);
      vendorMsg(newActive ? 'Marked active.' : 'Marked inactive.', 'ok');
      setTimeout(function(){ vendorMsg('', ''); }, 1500);
    })
    .catch(function(e){ v.is_active = !newActive; vendorMsg(e.message, 'err'); });
}

function vendorDeleteSelected() {
  if (vendorCellEdit) commitVendorCell(false);
  var v = allVendors[vendorSelRow];
  if (!v) return;
  if (!v.vendor_id) {
    allVendors.splice(vendorSelRow, 1);
    delete vendorDirtyRows[vendorSelRow];
    renderVendorTable();
    vendorSelRow = Math.min(vendorSelRow, allVendors.length - 1);
    updateVendorCursor(); return;
  }
  if (!confirm('Delete vendor "' + (v.name || v.vendor_id) + '"?')) return;
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'vendor.delete', companyId: COMPANY, vendorId: v.vendor_id }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var d = res.data || res;
      if (d.error || res.error) { vendorMsg(d.error || res.error, 'err'); return; }
      allVendors.splice(vendorSelRow, 1);
      delete vendorDirtyRows[vendorSelRow];
      renderVendorTable();
      vendorSelRow = Math.min(vendorSelRow, allVendors.length - 1);
      updateVendorCursor();
      vendorMsg('Deleted.', 'ok');
      setTimeout(function(){ vendorMsg('', ''); }, 1500);
    })
    .catch(function(e){ vendorMsg(e.message, 'err'); });
}

function vendorMsg(msg, type) {
  var el = document.getElementById('msg-vendors');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'err' ? '#cc2222' : type === 'ok' ? '#2a8a2a' : '#888';
}

function registerVendorKeyActions() {
  var VENDOR_KEYS = ['j','k','h','l','i','a','d','~','Enter','Escape','Tab','ArrowDown','ArrowUp'];
  document.addEventListener('keydown', function(e) {
    var panel = document.getElementById('pay-panel-vendors');
    if (!panel || panel.style.display === 'none') return;
    // Capture phase: stop common.js tab-switch handler from also consuming these keys
    if (VENDOR_KEYS.indexOf(e.key) !== -1 && (vendorCellEdit || vendorSelRow >= 0)) {
      e.stopImmediatePropagation();
    }

    if (vendorCellEdit) {
      var acctDd = document.getElementById('pay-vendor-acct-dd');
      var ccyDd  = document.getElementById('pay-vendor-ccy-dd');
      if (acctDd) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveVendorAcctDd(1); return; }
        if (e.key === 'ArrowUp')   { e.preventDefault(); moveVendorAcctDd(-1); return; }
        if (e.key === 'Enter')     { e.preventDefault(); selectVendorAcctDdItem(); return; }
        if (e.key === 'Escape')    { e.preventDefault(); acctDd.remove(); vendorAcctActiveInput = null; return; }
        if (e.key === 'Tab')       { if (selectVendorAcctDdItem()) e.preventDefault(); return; }
        return;
      }
      if (ccyDd) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveVendorCcyDd(1); return; }
        if (e.key === 'ArrowUp')   { e.preventDefault(); moveVendorCcyDd(-1); return; }
        if (e.key === 'Enter')     { e.preventDefault(); selectVendorCcyDdItem(); return; }
        if (e.key === 'Escape')    { e.preventDefault(); ccyDd.remove(); return; }
        if (e.key === 'Tab')       { if (selectVendorCcyDdItem()) e.preventDefault(); return; }
        return;
      }
      if (e.key === 'Enter') { e.preventDefault(); commitVendorCell(true); return; }
      if (e.key === 'Escape') { e.preventDefault(); commitVendorCell(false); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        commitVendorCell(true);
        var nextCol = Math.min(VENDOR_COL_EDIT_MAX, vendorSelCol + 1);
        if (nextCol === vendorSelCol) return;
        vendorSelCol = nextCol;
        updateVendorCursor();
        enterVendorCellEdit();
        return;
      }
      return; // all other keys pass through to input
    }

    // Browse mode
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.key === 'j') { e.preventDefault(); vendorMoveRow(1); }
    else if (e.key === 'k') { e.preventDefault(); vendorMoveRow(-1); }
    else if (e.key === 'h') { e.preventDefault(); if (vendorSelRow < 0) { showPayTab('bills'); } else { vendorMoveCol(-1); } }
    else if (e.key === 'l') { e.preventDefault(); vendorMoveCol(1); }
    else if (e.key === 'i') {
      e.preventDefault();
      if (vendorSelCol === 5) vendorToggleActive();
      else if (vendorSelRow >= 0) enterVendorCellEdit();
    }
    else if (e.key === 'a') { e.preventDefault(); vendorAddNew(); }
    else if (e.key === 'd') { e.preventDefault(); vendorDeleteSelected(); }
    else if (e.key === '~') { e.preventDefault(); vendorToggleActive(); }
  });
}

// ── Currency autocomplete ──────────────────────────────────────────────
function payVendorCcyInput(input) {
  loadVendorCurrencies();
  var q = input.value.trim().toUpperCase();
  var dd = document.getElementById('pay-vendor-ccy-dd');
  if (dd) dd.remove();
  if (!q) return;
  var matches = vendorCurrenciesList.filter(function(c){
    return (c.code||'').toUpperCase().startsWith(q) || (c.name||'').toUpperCase().includes(q);
  }).slice(0, 10);
  if (!matches.length) return;
  var div = document.createElement('div');
  div.id = 'pay-vendor-ccy-dd';
  div.style.cssText = 'position:fixed;background:#fff;border:1px solid #ccc;z-index:9999;max-height:220px;overflow-y:auto;font-size:11px;box-shadow:0 2px 6px rgba(0,0,0,.2);min-width:200px';
  matches.forEach(function(c, i){
    var item = document.createElement('div');
    item.dataset.ccyCode = c.code;
    item.dataset.idx = String(i);
    item.textContent = c.code + '  \u2014  ' + (c.name || '');
    item.style.cssText = 'padding:6px 10px;cursor:pointer;white-space:nowrap';
    item.onmouseover = function(){ clearVendorCcyDdFocus(); item.classList.add('dd-active'); item.style.background='#e8f0fe'; };
    item.onmouseout  = function(){ item.classList.remove('dd-active'); item.style.background=''; };
    item.onmousedown = function(e){ e.preventDefault(); };
    item.onclick = function(){
      input.value = c.code;
      var dd2 = document.getElementById('pay-vendor-ccy-dd');
      if (dd2) dd2.remove();
    };
    div.appendChild(item);
  });
  var rect = input.getBoundingClientRect();
  div.style.left = rect.left + 'px';
  div.style.top  = (rect.bottom + 2) + 'px';
  document.body.appendChild(div);
}

function clearVendorCcyDdFocus() {
  var dd = document.getElementById('pay-vendor-ccy-dd');
  if (!dd) return;
  dd.querySelectorAll('.dd-active').forEach(function(el){ el.classList.remove('dd-active'); el.style.background=''; });
}

function moveVendorCcyDd(dir) {
  var dd = document.getElementById('pay-vendor-ccy-dd');
  if (!dd) return;
  var items = dd.querySelectorAll('[data-ccy-code]');
  if (!items.length) return;
  var cur = dd.querySelector('.dd-active');
  var curIdx = cur ? parseInt(cur.dataset.idx) : -1;
  var nextIdx = Math.max(0, Math.min(items.length - 1, curIdx + dir));
  clearVendorCcyDdFocus();
  var next = items[nextIdx];
  next.classList.add('dd-active'); next.style.background = '#e8f0fe';
  next.scrollIntoView({ block: 'nearest' });
}

function selectVendorCcyDdItem() {
  var dd = document.getElementById('pay-vendor-ccy-dd');
  if (!dd) return false;
  var cur = dd.querySelector('.dd-active') || dd.querySelector('[data-ccy-code]');
  if (!cur) return false;
  var input = document.querySelector('#vendors-body td.vcell-editing input');
  if (input) input.value = cur.dataset.ccyCode;
  dd.remove();
  return true;
}

function hidePayVendorCcyDd() {
  setTimeout(function(){ var dd = document.getElementById('pay-vendor-ccy-dd'); if (dd) dd.remove(); }, 150);
}

// ── Account autocomplete ──────────────────────────────────────────────
function clearVendorAcctDdFocus() {
  var dd = document.getElementById('pay-vendor-acct-dd');
  if (!dd) return;
  dd.querySelectorAll('.dd-active').forEach(function(el){ el.classList.remove('dd-active'); el.style.background=''; });
}

function moveVendorAcctDd(dir) {
  var dd = document.getElementById('pay-vendor-acct-dd');
  if (!dd) return;
  var items = dd.querySelectorAll('[data-acct-code]');
  if (!items.length) return;
  var cur = dd.querySelector('.dd-active');
  var curIdx = cur ? parseInt(cur.dataset.idx) : -1;
  var nextIdx = Math.max(0, Math.min(items.length - 1, curIdx + dir));
  clearVendorAcctDdFocus();
  var next = items[nextIdx];
  next.classList.add('dd-active'); next.style.background = '#e8f0fe';
  next.scrollIntoView({ block: 'nearest' });
}

function selectVendorAcctDdItem() {
  var dd = document.getElementById('pay-vendor-acct-dd');
  if (!dd) return false;
  var cur = dd.querySelector('.dd-active') || dd.querySelector('[data-acct-code]');
  if (!cur) return false;
  if (vendorAcctActiveInput) {
    vendorAcctActiveInput.value = cur.dataset.acctCode;
    vendorAcctActiveInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
  dd.remove(); vendorAcctActiveInput = null;
  return true;
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
  matches.forEach(function(a, mi){
    var item = document.createElement('div');
    item.dataset.acctCode = a.account_code;
    item.dataset.idx = String(mi);
    item.textContent = a.account_code + ' \u2014 ' + a.account_name;
    item.style.cssText = 'padding:6px 10px;cursor:pointer;white-space:nowrap;font-size:11px';
    item.onmouseover = function(){ clearVendorAcctDdFocus(); item.classList.add('dd-active'); item.style.background='#e8f0fe'; };
    item.onmouseout  = function(){ item.classList.remove('dd-active'); item.style.background=''; };
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
