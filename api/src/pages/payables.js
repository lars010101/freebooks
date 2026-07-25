'use strict';
const { commonStyle, navBar, layoutEnd } = require('./common');
const { query } = require('../db');
const { billsTabJS } = require('./payables-bills');
const { vendorsTabJS } = require('./payables-vendors');

async function handlePayablesPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const [co] = await query(`SELECT jurisdiction, currency AS base_currency FROM companies WHERE company_id = @cid LIMIT 1`, { cid: company }).catch(() => [{}]);
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
  .table-card { border:1px solid #e8e8e8; border-radius:8px; overflow:visible; }
  .data-table { width:100%; border-collapse:collapse; font-size:0.875rem; table-layout:fixed; }
  .data-table thead { position:sticky; top:0; z-index:10; }
  .data-table th { text-align:left; font-size:0.75rem; color:#555; font-weight:600; text-transform:uppercase; letter-spacing:.05em; background:#fafafa; border-bottom:1px solid #e8e8e8; padding:12px 12px; }
  .data-table td { padding:14px 12px; border-bottom:1px solid #f2f2f2; vertical-align:middle; color:#222; }
  /* INSERT mode: tighter side padding so edit inputs (esp. browser date-picker
     chrome, ~110px min) keep working width in the tuned colgroup columns. */
  .data-table tbody.insert-mode td { padding-left:10px; padding-right:10px; }
  .data-table tbody tr:last-child td { border-bottom:none; }
  .data-table tbody tr:hover td { background:#fafafa; }
  /* Suppress hover when keyboard was last input or in INSERT mode */
  .data-table tbody.kb-active tr:hover td,
  .data-table tbody.insert-mode tr:hover td { background:inherit !important; }
  /* bill-row-focus persists through hover regardless */
  .data-table tbody tr.bill-row-focus:hover td { background: rgba(61, 100, 148, 0.18) !important; }
  .data-table tbody.kb-active tr.bill-row-focus:hover td,
  .data-table tbody.insert-mode tr.bill-row-focus:hover td { background: rgba(61, 100, 148, 0.18) !important; }
  .data-table tbody tr.bill-row-focus[data-draft="true"]:hover td,
  .data-table tbody.kb-active tr.bill-row-focus[data-draft="true"]:hover td,
  .data-table tbody.insert-mode tr.bill-row-focus[data-draft="true"]:hover td { background: rgba(61, 100, 148, 0.35) !important; }
  .data-table tbody tr[data-url] { cursor:pointer; }

  /* Sortable/filterable column headers */
  .data-table th.sortable { cursor:pointer; user-select:none; }
  .data-table th.sortable:hover { background:#f0f0f0; }
  .th-inner { display:flex; align-items:center; gap:4px; position:relative; }
  .th-sort { font-size:0.6875rem; color:#1a1a1a; width:12px; text-align:center; flex-shrink:0; }
  .th-sort:empty { display:none; } /* no reserved gap: header label stays flush with cell content */
  /* The ≡ filter affordance is the framework's .fb-filter-btn (common.css) —
     the bespoke .th-filter-btn spans were deleted 2026-07-24 (double icon). */
  /* AMOUNT header: label hugs the corner icon (flush right with the figures).
     Reserve math: th padding-right 24px (filterable, common.css) + th-inner
     22px = 46px == the amount cell's 46px (rule below), so label right edge
     == figures right edge == icon left edge. */
  th[data-col="amount"] .th-inner { justify-content:flex-end; padding-right:22px; }
  /* Figure reserve: 46px right padding on amount cells, matching the header's
     24+22px — label right edge == figures right edge == ≡ left edge. Targets
     data-field because the framework's td carries no .amt class (the span
     does); the old td.amt selector went dead in the FB.list migration.
     Child rows: td.amt is the amount cell (no data-field), needs same reserve
     so child figures align with parent figures and the header label. */
  #bills-table td[data-field="amount"], #bills-table td.draft-total-amount,
  #bills-table tr[data-child-of] td.amt { padding-right:46px; }
  /* Column weights (P1-3 density pass, agreed 2026-07-21; CCY widened 7→9%
     2026-07-22 — at 7% the corner-pinned filter icon overlapped the "CCY"
     label at ≤1400px viewports). Vendor is information-dense; CCY only needs
     a 3-letter code + header affordances. */
  #bills-table col.col-vendor { width:22%; }
  #bills-table col.col-date   { width:12.5%; }
  #bills-table col.col-due    { width:12.5%; }
  #bills-table col.col-ref    { width:15%; }
  #bills-table col.col-amount { width:14%; }
  #bills-table col.col-ccy    { width:9%; }
  #bills-table col.col-status { width:15%; }
  /* CCY collapsed: redistribute its 9% (vendor +6, ref +1, amount +0.5, status +0.5,
     dates +0.5 each) so widths still sum to 100%. */
  #bills-table.single-ccy col.col-vendor { width:28%; }
  #bills-table.single-ccy col.col-date   { width:13%; }
  #bills-table.single-ccy col.col-due    { width:13%; }
  #bills-table.single-ccy col.col-ref    { width:16%; }
  #bills-table.single-ccy col.col-amount { width:14.5%; }
  #bills-table.single-ccy col.col-status { width:15.5%; }
  /* Conditional CCY: column hidden when all visible bills share one currency.
     visibility:collapse on the <col> is the spec'd mechanism — the column's
     space is reclaimed WITHOUT breaking column-track mapping (display:none on
     th/td would slide later columns into the wrong track). The th also gets
     visibility:hidden: Chrome leaks the absolutely-positioned filter icon out
     of the collapsed column (it painted over the STATUS label). */
  #bills-table.single-ccy col.col-ccy { visibility: collapse; }
  #bills-table.single-ccy th[data-col="currency"] { visibility: hidden; }
  /* Chrome leaks the collapsed track's cell text (width 0, paint remains) —
     hide the cells too. data-field (not nth-child): column order is cfg-owned. */
  #bills-table.single-ccy td[data-field="currency"] { visibility: hidden; }
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
  .vendor-cell { display:inline-flex; align-items:center; gap:10px; }
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
  .child-row td { background:#fafafa; border-bottom:1px solid #f0f0f0; color:#444; padding:14px 18px; font-size:0.8125rem; }
  .child-ccy { font-size:0.75rem; color:#666; text-align:center; }
  .child-row td.child-desc { padding-left:60px; color:#666; position:relative; }
  .child-gst-row td { background:#f5f5f5; }

  /* Vertical stepper line — connects parent avatar down through child rows */
  .child-row td.child-desc::before {
    content:'';
    position:absolute;
    left:34px;             /* aligned with parent avatar center (18px padding + 16px) */
    top:0;
    bottom:0;
    width:1px;
    background:#d0d0d0;
  }
  /* Last child: vertical line stops at middle, horizontal connector points to text */
  .child-row:last-child td.child-desc::before { bottom:50%; }
  .child-row:last-child td.child-desc::after {
    content:'';
    position:absolute;
    left:34px;
    top:50%;
    width:18px;
    height:1px;
    background:#d0d0d0;
  }
  [data-theme="dark"] .child-row td.child-desc::before,
  [data-theme="dark"] .child-row:last-child td.child-desc::after { background:#444; }

  .draft-input { border:1px solid #ccc; border-radius:4px; padding:4px 8px; height:32px; font-size:0.875rem; width:100%; box-sizing:border-box; background:#fffef5; font-family:inherit; }
  .draft-input:focus { outline:none; border-color:#1a1a1a; }
  .draft-input.req { border:2px solid #cc2222; box-shadow:0 0 0 1px #cc2222; }
  select.draft-input { padding:4px 4px; }
  /* Make draft inputs fill their cells properly */
  .draft-vendor-input { flex:1 !important; min-width:0 !important; margin-left:10px !important; width:auto !important; }
  .draft-input[type="date"] { width:100%; }
  /* AP-account cell in the draft parent: input fills the column, save icon fixed */
  .draft-ap-cell { display:flex; align-items:center; gap:6px; }
  .draft-ap-cell .draft-input { flex:1; min-width:0; }
  .draft-ap-cell .btn-save-draft { flex-shrink:0; }
  /* Draft child row amount input — sits in the AMOUNT column: same gutter as
     posted figures so the draft row aligns with data rows (td.amt). */
  .child-row td input[type="number"] { width:100%; box-sizing:border-box; }
  tr[data-draft="true"] td { background:#fffef5; }
  tr[data-draft="true"]:hover td { background:#fffbea; }
  tr[data-draft="true"].child-row td { background:#fffef5; }

  /* Row state classes */
  tr[data-row-type="parent"]:hover td { background:#fafafa; }
  tr.row-loading { opacity:0.6; }
  .child-row:last-child td { border-bottom:1px solid #e8e8e8; }
  .data-table th:last-child,
  .data-table td:last-child { min-width: 110px; }

  /* Bills keyboard nav */
  tr.bill-row-focus td { background: rgba(61, 100, 148, 0.18) !important; }
  [data-theme="dark"] tr.bill-row-focus td { background: rgba(61, 100, 148, 0.35) !important; }
  /* Draft rows in INSERT mode: boost highlight visibility against #fffef5 background */
  tr.bill-row-focus[data-draft="true"] td { background: rgba(61, 100, 148, 0.35) !important; }
  [data-theme="dark"] tr.bill-row-focus[data-draft="true"] td { background: rgba(61, 100, 148, 0.50) !important; }

  /* Inline journal preview rows (fold area, replaces popup) */
  .data-table tbody.preview-mode tr:hover td { background:inherit !important; }
  tr.preview-row td { background:#f8f9fa; border-bottom:1px solid #f0f0f0; padding:8px 18px; font-size:0.8125rem; vertical-align:top; }
  tr.preview-row .preview-acct { padding-left:48px; }
  tr.preview-row .preview-acct-name { color:#2255cc; font-weight:500; }
  tr.preview-row .preview-desc { color:#888; font-size:0.75rem; margin-top:2px; }
  tr.preview-row .preview-side { color:#666; font-size:0.75rem; text-align:center; width:50px; font-weight:600; }
  tr.preview-row .preview-amt { color:#1a1a1a; text-align:right; font-variant-numeric:tabular-nums; }
  tr.preview-row .preview-amt .preview-amt-home { color:#888; font-size:0.75rem; }
  tr.preview-row.preview-totals td { font-weight:600; border-top:1px solid #ddd; background:#f0f0f0; }
  tr.preview-row.preview-totals .preview-totals-label { padding-left:48px; }
  tr.preview-row.preview-fx-header-row td { background:#fffbea; }
  tr.preview-row .preview-fx-header { color:#666; font-size:0.8125rem; font-style:italic; }
  tr.preview-row input.preview-acct-input:focus { outline:none; border-color:#2255cc; background:#fffef5; }

  .btn-sm:hover { background:#e8e8e8; }
  .btn-save-draft { background:none; border:none; cursor:pointer; font-size:1rem; padding:2px 6px; color:#bbb; line-height:1; border-radius:4px; }
  .btn-save-draft:hover { color:#1a1a1a; background:#f0f0f0; }
  /* P1-9: hover-only Pay affordance on posted/partial parent rows — no chrome at rest */
  .pay-afford { display:none; margin-left:6px; font-size:8pt; padding:1px 6px; border:1px solid #5b8def; background:#fff; color:#5b8def; border-radius:3px; cursor:pointer; line-height:1.4; }
  .pay-afford:hover { background:#5b8def; color:#fff; }
  .data-table tbody tr:hover .pay-afford { display:inline-block; }
  .data-table tbody.kb-active tr:hover .pay-afford,
  .data-table tbody.insert-mode tr:hover .pay-afford { display:none; }
  /* P1-9: inline payment row */
  .pay-row td.pay-cell { padding:6px 12px 6px 60px; background:#f6f9ff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pay-row .pay-lbl { font-weight:600; font-size:8pt; color:#5b8def; text-transform:uppercase; letter-spacing:0.4px; margin-right:8px; }
  tr.pay-row td.pay-cell input.draft-input { height:26px; font-size:9pt; margin-right:6px; width:auto; display:inline-block; }
  tr.pay-row td.pay-cell input.pay-date { width:130px; }
  tr.pay-row td.pay-cell input.pay-acct { width:90px; }
  tr.pay-row td.pay-cell input.pay-amount { width:90px; text-align:right; }
  tr.pay-row td.pay-cell input.pay-ref { width:110px; }
  tr.pay-row td.pay-cell input.pay-fx { width:70px; text-align:right; }
  .pay-row .pay-ccy { font-size:8pt; color:#666; margin-right:6px; }
  .pay-row .pay-hint { font-size:8pt; color:#999; margin-left:8px; }
  .pay-row .pay-hint a { color:#5b8def; cursor:pointer; text-decoration:none; }
  .pay-row .pay-hint a:hover { text-decoration:underline; }
  /* P1-9: payment history rows on unfold */
  .payment-history-row td { font-size:8pt; color:#555; font-style:italic; }
  .payment-history-row .pay-voided { text-decoration:line-through; color:#aaa; }
  .btn-sm.danger { border-color:#cc2222; color:#cc2222; }
  button.btn-primary { padding:10px 24px; background:#1a1a1a; color:#fff; border:none; border-radius:4px; font-size:0.9375rem; font-weight:600; cursor:pointer; }
  button.btn-primary:hover { background:#333; }
  button.btn-primary:disabled { background:#ccc; color:#666; cursor:not-allowed; }
  .msg-pay { margin-top:10px; font-size:0.8125rem; }
  .msg-pay.ok { color:#2a8a2a; }
  .msg-pay.err { color:#cc2222; }

  /* Vendor cell navigation (editing only; browse mode uses shared .bill-row-focus) */
  .data-table tbody td.vcell-selected { background:#1a3a6b !important; color:#fff !important; }
  .data-table tbody td.vcell-selected span:not(.avatar):not(.badge) { color:#fff !important; }
  .data-table tbody td.vcell-selected .badge { opacity:0.85; }
  .data-table tbody td.vcell-editing { background:#fff !important; color:#222 !important; box-shadow:inset 0 0 0 2px #1a3a6b; padding:3px 8px !important; }
  .data-table tbody td.vcell-editing input { border:none; outline:none; background:transparent; font-size:inherit; font-family:'Helvetica Neue',Arial,sans-serif !important; color:#222 !important; padding:0; box-sizing:border-box; }
  #vendors-body input { font-family:'Helvetica Neue',Arial,sans-serif !important; font-size:inherit !important; }
  .fb-dd { font-family:'Helvetica Neue',Arial,sans-serif; }
</style>
</head>
<body>${navBar(company, 'payables')}
<div class="page">

  <!-- Page header -->
  <div class="header">
    <h1>📋 Payables</h1>
  </div>

  <!-- KPI cards (above tabs) -->
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
    <table class="data-table" id="bills-table">
      <!-- Column weighting lives in CSS on the col classes (single source of
           truth — the .single-ccy state re-weights when CCY collapses). Fixed
           layout reads widths from the colgroup. -->
      <colgroup>
        <col class="col-vendor">   <!-- VENDOR -->
        <col class="col-date">     <!-- DATE (year-elided "21 Jul" + ISO tooltip) -->
        <col class="col-due">      <!-- DUE -->
        <col class="col-ref">      <!-- REFERENCE -->
        <col class="col-amount">   <!-- AMOUNT (incl. icon-width alignment gutter) -->
        <col class="col-ccy">      <!-- CCY -->
        <col class="col-status">   <!-- STATUS -->
      </colgroup>
      <thead>
        <tr>
          <th class="sortable" data-col="vendor" data-filter-type="text"><div class="th-inner"><span class="th-label">Vendor</span><span class="th-sort"></span></div></th>
          <th class="sortable" data-col="date" data-filter-type="date"><div class="th-inner"><span class="th-label">Date</span><span class="th-sort"></span></div></th>
          <th class="sortable" data-col="due_date" data-filter-type="date"><div class="th-inner"><span class="th-label">Due</span><span class="th-sort"></span></div></th>
          <th data-col="vendor_ref" data-filter-type="text"><div class="th-inner"><span class="th-label">Reference</span></div></th>
          <th class="sortable" data-col="amount" data-filter-type="amount"><div class="th-inner"><span class="th-label">Amount</span><span class="th-sort"></span></div></th>
          <th class="sortable" data-col="currency" data-filter-type="list"><div class="th-inner"><span class="th-label">CCY</span><span class="th-sort"></span></div></th>
          <th class="sortable" data-col="status" data-filter-type="list"><div class="th-inner"><span class="th-label">Status</span><span class="th-sort"></span></div></th>
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

  <!-- Keyboard hints live in the sidebar (#sb-hints), generated by
       FB.keys.renderHints from the binding table — never hand-written here. -->

  </div><!-- /pay-panel-bills -->

  <div id="pay-panel-vendors" style="display:none">
    <div class="table-card">
      <table class="data-table" id="vendors-table">
        <thead>
          <tr>
            <th>Vendor</th>
            <th style="width:70px;text-align:center">CCY</th>
            <th style="width:110px;text-align:center">Terms (d)</th>
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
      <!-- Vendors hints are rendered into the sidebar by showPayTab (static
           list until the Vendors tab migrates onto FB.keys). -->
    </div>
  </div><!-- /pay-panel-vendors -->

</div>

<script>
var COMPANY = '${company}';
var BASE_CURRENCY = '${baseCurrency}';
${billsTabJS()}${vendorsTabJS()}
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handlePayablesPage };
