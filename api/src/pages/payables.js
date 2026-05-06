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

  /* New Bill Modal */
  .newbill-modal { display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,.4); z-index:9998; align-items:center; justify-content:center; }
  .newbill-modal.open { display:flex; }
  .newbill-modal-content { background:#fff; border-radius:8px; box-shadow:0 8px 32px rgba(0,0,0,.2); max-width:900px; max-height:85vh; overflow:auto; padding:32px; position:relative; width:95%; }
  .newbill-modal-header { margin-bottom:24px; }
  .newbill-modal-header h2 { margin:0 0 4px; font-size:1.5rem; font-weight:700; }
  .newbill-modal-header .close-btn { position:absolute; top:12px; right:12px; background:none; border:none; font-size:1.5rem; color:#999; cursor:pointer; }
  .newbill-modal-header .close-btn:hover { color:#333; }
  .newbill-form-section { margin-bottom:24px; }
  .newbill-form-section h3 { font-size:0.875rem; color:#555; font-weight:600; text-transform:uppercase; margin:0 0 12px; letter-spacing:.06em; }
  .newbill-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px 20px; margin-bottom:16px; }
  .newbill-grid.full { grid-template-columns:1fr; }
  .newbill-field { display:flex; flex-direction:column; gap:4px; }
  .newbill-field label { font-weight:600; font-size:0.8125rem; color:#333; }
  .newbill-field input, .newbill-field select { padding:8px 10px; border:1px solid #ccc; border-radius:4px; font-size:0.8125rem; font-family:inherit; }
  .newbill-field input:focus, .newbill-field select:focus { outline:none; border-color:#1a1a1a; box-shadow:0 0 0 2px rgba(26,26,26,.1); }
  .newbill-field.invalid input, .newbill-field.invalid select { border-color:#cc2222; background:#fff5f5; }
  .newbill-field.invalid::after { content:'Required'; font-size:0.75rem; color:#cc2222; margin-top:2px; }
  .newbill-lines { margin-bottom:24px; }
  .newbill-lines h3 { font-size:0.875rem; color:#555; font-weight:600; text-transform:uppercase; margin:0 0 12px; letter-spacing:.06em; }
  .newbill-lines-table { width:100%; border-collapse:collapse; font-size:0.8125rem; }
  .newbill-lines-table th { text-align:left; font-size:0.75rem; color:#555; font-weight:600; text-transform:uppercase; border-bottom:1px solid #ccc; padding:8px; }
  .newbill-lines-table td { padding:6px 8px; border-bottom:1px solid #f0f0f0; vertical-align:middle; }
  .newbill-lines-table td input { width:100%; padding:4px 6px; border:1px solid #ddd; border-radius:3px; font-size:0.8125rem; font-family:inherit; }
  .newbill-lines-table td input:focus { outline:none; border-color:#1a1a1a; }
  .newbill-lines-table tbody tr.newbill-line-row.editing td { background:#f9f9f9; }
  .newbill-lines-table tbody tr.newbill-line-row.editing td input { border-color:#1a1a1a; }
  .newbill-totals { border-top:2px solid #ccc; padding-top:12px; text-align:right; font-size:0.9375rem; }
  .newbill-total-row { display:flex; justify-content:flex-end; gap:24px; margin-top:8px; }
  .newbill-total-row div { display:flex; align-items:baseline; gap:8px; }
  .newbill-total-label { font-weight:600; color:#333; }
  .newbill-total-value { font-weight:700; font-size:1.125rem; }
  .newbill-actions { display:flex; gap:12px; margin-top:24px; align-items:center; }
  .newbill-post-btn { padding:10px 24px; background:#1a1a1a; color:#fff; border:none; border-radius:4px; font-size:0.9375rem; font-weight:600; cursor:pointer; }
  .newbill-post-btn:hover { background:#333; }
  .newbill-post-btn:disabled { opacity:.4; cursor:not-allowed; }
  .newbill-status { font-size:0.8125rem; color:#666; }
  .edit-table { width:100%; border-collapse:collapse; font-size:0.8125rem; }
  .edit-table th { text-align:left; font-size:0.75rem; text-transform:uppercase; color:#555; border-bottom:1px solid #ccc; padding:6px; }
  .edit-table td { padding:4px; border-bottom:1px solid #f0f0f0; vertical-align:middle; }
  .edit-table input[type=text], .edit-table select { width:100%; padding:4px 6px; border:1px solid #ddd; border-radius:3px; font-size:0.8125rem; }
  .btn-sm { padding:0 14px; height:32px; font-size:0.8125rem; cursor:pointer; border:1px solid #ccc; border-radius:3px; background:#f5f5f5; }
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

  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
    <div style="flex:1"></div>
    <button onclick="openNewBillModal()" style="padding:9px 20px; background:#1a1a1a; color:#fff; border:none; border-radius:6px; font-size:0.875rem; font-weight:600; cursor:pointer;">+ New Bill</button>
  </div>

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

  <!-- New Bill Modal -->
  <div id="newbill-modal" class="newbill-modal">
    <div class="newbill-modal-content">
      <button class="close-btn" onclick="closeNewBillModal()">✕</button>
      <div class="newbill-modal-header">
        <h2>📄 New Bill</h2>
        <div style="font-size:0.75rem;color:#888;margin-top:4px;">Press p to post · Esc to cancel · hjkl to navigate · i to edit</div>
      </div>

      <!-- Meta strip (mirrors Bill details) -->
      <div class="meta-strip" style="margin-bottom:24px;">
        <div class="meta-field nav-meta-item" id="newbill-vendor-field" data-field="vendor">
          <div class="meta-label">Vendor *</div>
          <input type="text" class="meta-val-input" id="newbill-vendor" placeholder="Search vendor…" autocomplete="off" style="font-size:1rem;font-weight:600;">
          <input type="hidden" id="newbill-vendor-id">
        </div>
        <div class="meta-field nav-meta-item" id="newbill-ref-field" data-field="vendor_ref">
          <div class="meta-label">Invoice Ref *</div>
          <input type="text" class="meta-val-input" id="newbill-vendor-ref" placeholder="e.g. INV-2024-001">
        </div>
        <div class="meta-field nav-meta-item" id="newbill-date-field" data-field="date">
          <div class="meta-label">Bill Date *</div>
          <input type="date" class="meta-val-input" id="newbill-date">
        </div>
        <div class="meta-field nav-meta-item" id="newbill-due-field" data-field="due_date">
          <div class="meta-label">Due Date</div>
          <input type="date" class="meta-val-input" id="newbill-due-date">
        </div>
        <div class="meta-field nav-meta-item" id="newbill-currency-field" data-field="currency">
          <div class="meta-label">Currency</div>
          <input type="text" class="meta-val-input" id="newbill-currency" maxlength="3" placeholder="SGD" style="text-transform:uppercase">
        </div>
      </div>

      <!-- Amount card -->
      <div class="amount-cards" style="margin-bottom:24px;">
        <div class="card-due" style="flex:1;">
          <div class="card-label">Total Amount</div>
          <div class="card-val-due" id="newbill-total-amount-card">
            <span class="card-currency" id="newbill-total-ccy">SGD</span>
            <span class="card-amount" id="newbill-total-amount">0.00</span>
          </div>
        </div>
      </div>

      <div class="newbill-form-section">
        <h3>Line Items</h3>
        <table class="newbill-lines-table" id="newbill-lines-table">
          <thead>
            <tr>
              <th style="width:40px">#</th>
              <th>Expense Account</th>
              <th>Description *</th>
              <th style="width:120px">Amount *</th>
              <th style="width:30px"></th>
            </tr>
          </thead>
          <tbody id="newbill-lines-body"></tbody>
        </table>
        <button type="button" onclick="newbillAddLine()" style="margin-top:8px; padding:6px 12px; font-size:0.8125rem; border:1px solid #ccc; border-radius:3px; background:#f5f5f5; cursor:pointer;">＋ Add Line</button>
      </div>

      <div class="newbill-totals">
        <div class="newbill-total-row">
          <div><span class="newbill-total-label">Total:</span><span class="newbill-total-value" id="newbill-total-amount">0.00</span></div>
        </div>
      </div>

      <div class="newbill-actions">
        <button class="newbill-post-btn" id="newbill-post-btn" onclick="newbillPost()">Post Bill (p)</button>
        <span class="newbill-status" id="newbill-status"></span>
      </div>
      <div style="margin-top:8px; font-size:0.75rem; color:#999;">
        hjkl navigate · i/Enter edit · Esc cancel · a add line · d delete line · p post
      </div>
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

var AVATAR_COLORS = ['#4f6ef7','#e05c5c','#2bac72','#e09d3a','#9b59c4','#17a2b8','#e07840','#5c7ae0'];

function fbPageInitPayables() {
  loadVendors();
  loadAllBills();
  initBillsTable();
  registerBillKeyActions();
  registerVendorKeyActions();
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
      + '<td style="font-size:0.75rem;color:#666;text-align:center;width:50px">' + esc(b.currency || BASE_CURRENCY) + '</td>'
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

// ========== NEW BILL MODAL (Vim-style) ==========
var newbillModalOpen = false;
var newbillAllVendors = [];
var newbillAllAccounts = [];
var newbillFormData = {};
var newbillLineCounter = 0;
var newbillCurField = 'vendor';
var newbillFields = ['vendor', 'vendor_ref', 'date', 'due_date', 'currency', 'ap_account'];
var newbillEditMode = false;
var newbillIsDirty = false;
var newbillSelectedLineId = null;

function openNewBillModal() {
  newbillModalOpen = true;
  document.getElementById('newbill-modal').classList.add('open');
  newbillFormData = {};
  newbillLineCounter = 0;
  loadNewbillVendors();
  loadNewbillAccounts();
  var today = new Date().toISOString().slice(0,10);
  document.getElementById('newbill-date').value = today;
  document.getElementById('newbill-currency').value = BASE_CURRENCY;
  newbillFormData.date = today;
  newbillFormData.currency = BASE_CURRENCY;
  newbillRenderLines();
  newbillAddLine();
  newbillCurField = 'vendor';
  // Prefocus vendor in insert mode (immediate typing + autocomplete)
  var vendorInput = document.getElementById('newbill-vendor');
  vendorInput.focus();
  vendorInput.select();
  // Mark as dirty tracking for Esc guard
  newbillIsDirty = false;
  vendorInput.addEventListener('input', function(){ newbillIsDirty = true; }, { once: true });

  // Wire realtime validation
  newbillWireRealtimeValidation();

  // Basic vendor inheritance on blur/select
  vendorInput.addEventListener('blur', function(){
    var vname = vendorInput.value.trim();
    if (!vname) return;
    var match = newbillAllVendors.find(function(v){ return (v.name||'').toLowerCase() === vname.toLowerCase(); });
    if (match) {
      if (match.currency) document.getElementById('newbill-currency').value = match.currency;
      if (match.payment_terms_days) {
        var d = new Date(document.getElementById('newbill-date').value);
        d.setDate(d.getDate() + match.payment_terms_days);
        document.getElementById('newbill-due-date').value = d.toISOString().slice(0,10);
      }
      // Could also set default AP/expense accounts here
      newbillIsDirty = true;
    }
  });

  registerNewbillKeyHandlers();
}

function closeNewBillModal(force) {
  if (!force && newbillIsDirty) {
    if (!confirm('Discard unsaved changes?')) return;
  }
  newbillModalOpen = false;
  document.getElementById('newbill-modal').classList.remove('open');
  if (newbillKeyHandler) document.removeEventListener('keydown', newbillKeyHandler);
}

function loadNewbillVendors() {
  if (newbillAllVendors.length) return;
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'vendor.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); })
    .then(function(res){ newbillAllVendors = res.data || res || []; })
    .catch(function(){});
}

function loadNewbillAccounts() {
  if (newbillAllAccounts.length) return;
  fetch('/api/' + COMPANY + '/accounts').then(function(r){ return r.json(); })
    .then(function(rows){ newbillAllAccounts = Array.isArray(rows) ? rows : []; })
    .catch(function(){});
}

function newbillAddLine() {
  if (!newbillFormData.lines) newbillFormData.lines = [];
  newbillLineCounter++;
  newbillFormData.lines.push({ id: newbillLineCounter, account_code: '', description: '', amount: 0 });
  newbillRenderLines();
}

function newbillRemoveLine(lineId) {
  if (newbillFormData.lines) {
    var idx = newbillFormData.lines.findIndex(function(l){ return l.id === lineId; });
    if (idx >= 0) {
      newbillFormData.lines.splice(idx, 1);
      newbillRenderLines();
      newbillUpdateTotal();
    }
  }
}

function newbillRenderLines() {
  var tbody = document.getElementById('newbill-lines-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!newbillFormData.lines) newbillFormData.lines = [];
  newbillFormData.lines.forEach(function(line, idx) {
    var tr = document.createElement('tr');
    tr.className = 'newbill-line-row';
    tr.dataset.lineId = line.id;
    tr.innerHTML = '<td style="text-align:center;color:#888;font-size:0.75rem">' + (idx+1) + '</td>' +
      '<td><input type="text" value="' + esc(line.account_code||'') + '" placeholder="Account code"></td>' +
      '<td><input type="text" value="' + esc(line.description||'') + '" placeholder="Description"></td>' +
      '<td><input type="number" value="' + (line.amount||0) + '" step="0.01" min="0" style="text-align:right"></td>' +
      '<td><button type="button" onclick="newbillRemoveLine(' + line.id + ')" style="border:none;background:none;color:#cc2222;cursor:pointer;">x</button></td>';
    tbody.appendChild(tr);
    tr.querySelectorAll('input').forEach(function(inp, i) {
      inp.addEventListener('change', function() {
        if (i === 0) line.account_code = inp.value;
        else if (i === 1) line.description = inp.value;
        else if (i === 2) line.amount = parseFloat(inp.value) || 0;
        newbillUpdateTotal();
      });
    });
  });
  newbillUpdateTotal();
}

function newbillUpdateTotal() {
  var total = 0;
  if (newbillFormData.lines) {
    newbillFormData.lines.forEach(function(line) { total += Number(line.amount || 0); });
  }
  document.getElementById('newbill-total-amount').textContent = total.toFixed(2);
}

function newbillValidate() {
  document.querySelectorAll('.newbill-field').forEach(function(f){ f.classList.remove('invalid'); });
  var errors = [];
  var vendor = document.getElementById('newbill-vendor').value.trim();
  var ref = document.getElementById('newbill-vendor-ref').value.trim();
  var date = document.getElementById('newbill-date').value;
  var due = document.getElementById('newbill-due-date').value;
  var currency = document.getElementById('newbill-currency').value.trim();
  var apAccount = document.getElementById('newbill-ap-account').value.trim();

  if (!vendor) { errors.push('Vendor required'); document.getElementById('newbill-vendor-field').classList.add('invalid'); }
  if (!ref) { errors.push('Invoice Ref required'); document.getElementById('newbill-ref-field').classList.add('invalid'); }
  if (!date) { errors.push('Bill Date required'); document.getElementById('newbill-date-field').classList.add('invalid'); }
  if (!due) { errors.push('Due Date required'); document.getElementById('newbill-due-field').classList.add('invalid'); }
  if (!currency) { errors.push('Currency required'); document.getElementById('newbill-currency-field').classList.add('invalid'); }
  if (!apAccount) { errors.push('AP Account required'); document.getElementById('newbill-ap-field').classList.add('invalid'); }

  var hasValidLines = false;
  if (newbillFormData.lines) {
    newbillFormData.lines.forEach(function(line) {
      if (line.description && line.amount > 0 && line.account_code) hasValidLines = true;
    });
  }
  if (!hasValidLines) errors.push('At least one line with description, account and amount required');

  return { valid: errors.length === 0, errors: errors };
}

function newbillWireRealtimeValidation() {
  var fields = ['newbill-vendor','newbill-vendor-ref','newbill-date','newbill-due-date','newbill-currency','newbill-ap-account'];
  fields.forEach(function(id){
    var el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', function(){ newbillIsDirty = true; newbillValidate(); });
      el.addEventListener('change', function(){ newbillValidate(); });
    }
  });
}

function newbillPost() {
  document.querySelectorAll('.newbill-field').forEach(function(f){ f.classList.remove('invalid'); });
  var validation = newbillValidate();
  if (!validation.valid) {
    newbillShowStatus(validation.errors.join('; '), 'err');
    return;
  }
  var vendor = document.getElementById('newbill-vendor').value.trim();
  var ref = document.getElementById('newbill-vendor-ref').value.trim();
  var date = document.getElementById('newbill-date').value;
  var dueDate = document.getElementById('newbill-due-date').value;
  var currency = document.getElementById('newbill-currency').value.trim().toUpperCase() || BASE_CURRENCY;
  var apAccount = document.getElementById('newbill-ap-account').value.trim();
  var lines = [];
  if (newbillFormData.lines) {
    newbillFormData.lines.forEach(function(line) {
      if (line.description && line.amount > 0 && line.account_code) {
        lines.push({ expense_account: line.account_code, description: line.description, amount: Number(line.amount || 0) });
      }
    });
  }
  var payload = {
    action: 'bill.create',
    companyId: COMPANY,
    bill: { vendor: vendor, vendor_ref: ref, date: date, due_date: dueDate || null, currency: currency, ap_account: apAccount, lines: lines }
  };
  newbillShowStatus('Creating bill...', '');
  document.getElementById('newbill-post-btn').disabled = true;
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var d = res.data || res;
      if (res.error || d.error || (d.errors && d.errors.length)) {
        var msg = d.errors ? d.errors.join('; ') : (res.error || d.error);
        newbillShowStatus(msg, 'err');
        document.getElementById('newbill-post-btn').disabled = false;
      } else {
        newbillShowStatus('Posted!', 'ok');
        var newBillId = d.id || (res.data && res.data.id);
        setTimeout(function() {
          loadAllBills();
          closeNewBillModal(true);
          // Highlight the new bill in the list (simple re-render + flash)
          setTimeout(function() {
            var rows = document.querySelectorAll('#bills-tbody tr[data-url]');
            rows.forEach(function(r) {
              if (r.dataset.url && r.dataset.url.includes(newBillId)) {
                r.style.transition = 'background 0.2s';
                r.style.background = '#e8f0fe';
                setTimeout(function(){ r.style.background = ''; }, 1800);
              }
            });
          }, 400);
        }, 800);
      }
    })
    .catch(function(e){ newbillShowStatus(e.message, 'err'); document.getElementById('newbill-post-btn').disabled = false; });
}

function newbillShowStatus(msg, type) {
  var el = document.getElementById('newbill-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'err' ? '#cc2222' : (type === 'ok' ? '#2a8a2a' : '#666');
}

var newbillKeyHandler = null;

function registerNewbillKeyHandlers() {
  if (newbillKeyHandler) document.removeEventListener('keydown', newbillKeyHandler);
  newbillKeyHandler = function(e) {
    if (!newbillModalOpen) return;
    if (newbillEditMode) {
      if (e.key === 'Enter') { e.preventDefault(); newbillExitEditMode(true); }
      else if (e.key === 'Escape') { e.preventDefault(); newbillExitEditMode(false); }
      return;
    }
    // Normal mode
    if (['h','j','k','l','i','a','d','p','Enter','Escape'].indexOf(e.key) !== -1) {
      e.stopPropagation();
      e.preventDefault();
    }
    if (e.key === 'i' || e.key === 'Enter') { newbillEnterEditMode(); }
    else if (e.key === 'Escape') { closeNewBillModal(); }
    else if (e.key === 'h' || e.key === 'l') { newbillMoveCurField(e.key === 'h' ? -1 : 1); }
    else if (e.key === 'j' || e.key === 'k') { newbillMoveLineFocus(e.key === 'j' ? 1 : -1); }
    else if (e.key === 'a') { newbillAddLine(); }
    else if (e.key === 'd') { newbillDeleteLine(); }
    else if (e.key === 'p') { newbillPost(); }
  };
  document.addEventListener('keydown', newbillKeyHandler);
}

function newbillMoveCurField(dir) {
  var idx = newbillFields.indexOf(newbillCurField);
  if (idx < 0) idx = 0;
  var newIdx = Math.max(0, Math.min(newbillFields.length - 1, idx + dir));
  newbillCurField = newbillFields[newIdx];
  newbillUpdateHighlight();
}

function newbillUpdateHighlight() {
  document.querySelectorAll('.newbill-field').forEach(function(f) { f.style.borderLeft = 'none'; f.style.paddingLeft = '0'; });
  var curFieldEl = document.getElementById('newbill-' + newbillCurField + '-field');
  if (curFieldEl) {
    curFieldEl.style.borderLeft = '3px solid #1a1a1a';
    curFieldEl.style.paddingLeft = '12px';
    var inp = curFieldEl.querySelector('input');
    if (inp) inp.focus();
  }
}

function newbillEnterEditMode() {
  newbillEditMode = true;
  var curFieldEl = document.getElementById('newbill-' + newbillCurField + '-field');
  if (curFieldEl) {
    var inp = curFieldEl.querySelector('input');
    if (inp) { inp.focus(); inp.select(); }
  }
}

function newbillExitEditMode(save) {
  newbillEditMode = false;
  if (save) {
    var curFieldEl = document.getElementById('newbill-' + newbillCurField + '-field');
    if (curFieldEl) {
      var inp = curFieldEl.querySelector('input');
      if (inp) newbillFormData[newbillCurField] = inp.value;
    }
  }
  newbillUpdateHighlight();
}

function newbillMoveLineFocus(dir) {
  if (!newbillFormData.lines || newbillFormData.lines.length === 0) return;
  var currentIdx = -1;
  if (newbillSelectedLineId) {
    currentIdx = newbillFormData.lines.findIndex(function(l){ return l.id === newbillSelectedLineId; });
  }
  var newIdx = Math.max(0, Math.min(newbillFormData.lines.length - 1, currentIdx + dir));
  newbillSelectedLineId = newbillFormData.lines[newIdx].id;
  newbillHighlightLineRow();
}

function newbillHighlightLineRow() {
  document.querySelectorAll('#newbill-lines-body tr').forEach(function(tr) {
    tr.style.background = '';
    if (parseInt(tr.dataset.lineId) === newbillSelectedLineId) {
      tr.style.background = '#f0f0f0';
    }
  });
}

function newbillDeleteLine() {
  if (!newbillFormData.lines || newbillFormData.lines.length === 0) return;
  var idx = newbillFormData.lines.findIndex(function(l){ return l.id === newbillSelectedLineId; });
  if (idx < 0) idx = newbillFormData.lines.length - 1;
  if (!confirm('Delete this line?')) return;
  newbillFormData.lines.splice(idx, 1);
  newbillSelectedLineId = newbillFormData.lines.length ? newbillFormData.lines[0].id : null;
  newbillRenderLines();
  newbillUpdateTotal();
  newbillHighlightLineRow();
  newbillIsDirty = true;
}
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handlePayablesPage };
