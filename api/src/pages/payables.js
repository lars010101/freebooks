'use strict';
const { commonStyle, navBar, layoutEnd, getRelevanceFlags, flagsBootstrapJson } = require('./common');
const { query } = require('../db');
const { billsTabJS } = require('./payables-bills');
const { partnersTabJS } = require('./payables-partners');

async function handlePayablesPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Server-side relevance flags (settings-ux-spec §7 item 9 + fx-automation-spec
  // §1): read once here, drive both server-rendered chrome (none on this page —
  // the VAT column lives in the client-rendered bill tree) and the
  // window.__fbFlags bootstrap that billsTabJS reads to drop the VAT column /
  // stated-VAT footer / per-code footers + lock CCY to base when fxTracking='off'.
  const flags = await getRelevanceFlags(company);
  const [co] = await query(`SELECT jurisdiction, currency AS base_currency FROM companies WHERE company_id = @cid LIMIT 1`, { cid: company }).catch(() => [{}]);
  const taxLabel = (co && co.jurisdiction === 'SG') ? 'GST' : 'VAT';
  const baseCurrency = (flags && flags.baseCurrency) || (co && co.base_currency) || 'SGD';
  res.send(buildPayablesPage(company, taxLabel, baseCurrency, flags));
}

function buildPayablesPage(company, taxLabel = 'VAT', baseCurrency = 'SGD', flags = null) {
  const flagsJson = flagsBootstrapJson(flags);
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
  .page-header .sub { margin:0; font-size:0.8125rem; color:var(--text-faint); }
  .btn-create { display:inline-flex; align-items:center; gap:7px; padding:9px 20px; background:var(--accent); color:var(--on-accent); border:none; border-radius:6px; font-size:0.875rem; font-weight:600; text-decoration:none; cursor:pointer; }
  .btn-create:hover { opacity:.88; }

  /* KPI cards */
  .kpi-row { display:flex; gap:16px; margin-bottom:28px; }
  .kpi-card { flex:1; border:1px solid var(--border); border-radius:8px; padding:20px 24px; background:var(--surface); }
  .kpi-label { font-size:0.75rem; color:var(--text-faint); font-weight:600; text-transform:uppercase; letter-spacing:.06em; margin-bottom:10px; }
  .kpi-amount { font-size:1.667rem; font-weight:700; color:var(--text); line-height:1; margin-bottom:6px; }
  .kpi-amount.overdue { color:var(--danger); }
  .kpi-count { font-size:0.75rem; color:var(--text-faint); }

  /* Filter bar */
  .filter-bar { display:flex; gap:10px; align-items:center; margin-bottom:20px; flex-wrap:wrap; }
  .search-wrap { position:relative; flex:1; min-width:180px; }
  .search-wrap input { width:100%; padding:8px 12px 8px 36px; border:1px solid var(--border); border-radius:6px; font-size:0.8125rem; box-sizing:border-box; background:var(--surface); color:var(--text); }
  .search-wrap input:focus { outline:none; border-color:var(--accent); }
  .search-icon { position:absolute; left:11px; top:50%; transform:translateY(-50%); color:var(--text-faint); font-size:0.9375rem; pointer-events:none; }
  .filter-bar select { padding:8px 12px; border:1px solid var(--border); border-radius:6px; font-size:0.8125rem; background:var(--surface); color:var(--text); }
  .filter-bar select:focus { outline:none; border-color:var(--accent); }

  /* Table card */
  .table-card { border:1px solid var(--border); border-radius:8px; overflow:visible; }
  .data-table { width:100%; border-collapse:collapse; font-size:0.875rem; table-layout:fixed; }
  .data-table thead { position:sticky; top:0; z-index:10; }
  .data-table th { text-align:left; font-size:0.75rem; color:var(--text-muted); font-weight:600; text-transform:uppercase; letter-spacing:.05em; background:var(--bg); border-bottom:1px solid var(--border); padding:12px 12px; }
  .data-table td { padding:12px 12px; border-bottom:1px solid var(--border); vertical-align:middle; color:var(--text); }
  /* INSERT mode: tighter side padding so edit inputs (esp. browser date-picker
     chrome, ~110px min) keep working width in the tuned colgroup columns. */
  .data-table tbody.insert-mode td { padding-left:10px; padding-right:10px; }
  .data-table tbody tr:last-child td { border-bottom:none; }
  .data-table tbody tr:hover td { background:var(--bg); }
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
  .data-table th.sortable:hover { background:var(--bg); }
  .th-inner { display:flex; align-items:center; gap:4px; position:relative; }
  .th-sort { font-size:0.6875rem; color:var(--text); width:12px; text-align:center; flex-shrink:0; }
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
  #bills-table tr[data-child-of]:not(.row-editing) td.amt { padding-right:46px; }
  /* Column weights (P1-3 density pass, agreed 2026-07-21; CCY widened 7→9%
     2026-07-22 — at 7% the corner-pinned filter icon overlapped the "CCY"
     label at ≤1400px viewports). Partner is information-dense; CCY only needs
     a 3-letter code + header affordances. */
  #bills-table col.col-partner { width:22%; }
  #bills-table col.col-date   { width:12.5%; }
  #bills-table col.col-due    { width:12.5%; }
  #bills-table col.col-ref    { width:15%; }
  #bills-table col.col-amount { width:14%; }
  #bills-table col.col-ccy    { width:9%; }
  #bills-table col.col-status { width:15%; }
  /* CCY collapsed: redistribute its 9% (partner +6, ref +1, amount +0.5, status +0.5,
     dates +0.5 each) so widths still sum to 100%. */
  #bills-table.single-ccy col.col-partner { width:28%; }
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
  .col-filter-dd { position:fixed; background:var(--surface); border:1px solid var(--border); border-radius:6px; z-index:9999; min-width:180px; box-shadow:0 4px 12px rgba(0,0,0,.12); overflow:hidden; padding:10px; }
  .col-filter-dd-item { padding:8px 14px; cursor:pointer; font-size:0.8125rem; white-space:nowrap; border-radius:4px; }
  .col-filter-dd-item:hover { background:var(--bg); }
  .col-filter-dd-item.active { font-weight:700; color:var(--accent); }
  .col-filter-dd-clear { color:var(--text-muted); font-style:italic; font-size:0.8125rem; border-bottom:1px solid var(--border); margin-bottom:4px; padding-bottom:6px; border-radius:0; }
  .col-filter-dd label { font-size:0.75rem; color:var(--text-muted); font-weight:600; text-transform:uppercase; letter-spacing:.04em; display:block; margin-bottom:5px; }
  .col-filter-dd input[type=date],
  .col-filter-dd input[type=text],
  .col-filter-dd input[type=number] { width:100%; padding:8px 12px; border:1px solid var(--border); border-radius:4px; font-size:0.8125rem; box-sizing:border-box; margin-bottom:6px; background:var(--surface); color:var(--text); }
  .col-filter-dd select { width:100%; padding:8px 12px; border:1px solid var(--border); border-radius:4px; font-size:0.8125rem; background:var(--surface); color:var(--text); margin-bottom:6px; }
  .col-filter-dd-apply { width:100%; padding:7px; background:var(--accent); color:var(--on-accent); border:none; border-radius:4px; font-size:0.8125rem; cursor:pointer; }
  .col-filter-dd-apply:hover { opacity:.88; }

  /* Partner avatar */
  .partner-cell { display:inline-flex; align-items:center; gap:10px; }
  .avatar { width:32px; height:32px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:0.75rem; font-weight:700; color:var(--on-accent); flex-shrink:0; }

  /* Link */
  .ref-link { color:var(--accent); text-decoration:none; font-weight:500; }
  .ref-link:hover { text-decoration:underline; }
  .view-link { color:var(--accent); text-decoration:none; font-size:0.8125rem; font-weight:500; }
  .view-link:hover { text-decoration:underline; }

  .overdue-date { color:var(--danger); font-weight:600; }

  /* Pagination */
  .pagination-row { display:flex; justify-content:space-between; align-items:center; padding:14px 18px; border-top:1px solid var(--border); font-size:0.8125rem; color:var(--text-muted); }
  .page-btns { display:flex; gap:4px; align-items:center; }
  .page-btn { padding:5px 11px; border:1px solid var(--border); border-radius:5px; background:var(--surface); cursor:pointer; font-size:0.75rem; color:var(--text); }
  .page-btn:hover { background:var(--bg); }
  .page-btn.active { background:var(--accent); color:var(--on-accent); border-color:var(--accent); }
  .page-btn:disabled { opacity:.4; cursor:default; }
  .tabs { display:flex; gap:0; border-bottom:2px solid var(--accent); margin-bottom:24px; }
  .tab { padding:8px 20px; cursor:pointer; font-weight:600; font-size:0.8125rem; color:var(--text-muted); border-bottom:3px solid transparent; margin-bottom:-2px; }
  .tab.active { color:var(--accent); border-bottom-color:var(--accent); }
  .tab-panel { display:none; }
  .tab-panel.active { display:block; }

  .edit-table { width:100%; border-collapse:collapse; font-size:0.8125rem; }
  .edit-table th { text-align:left; font-size:0.75rem; text-transform:uppercase; color:var(--text-muted); border-bottom:1px solid var(--border); padding:6px; }
  .edit-table td { padding:4px; border-bottom:1px solid var(--border); vertical-align:middle; }
  .edit-table input[type=text], .edit-table select { width:100%; padding:4px 6px; border:1px solid var(--border); border-radius:3px; font-size:0.8125rem; }

  /* Tree table — child rows */
  .child-row td { background:var(--bg); border-bottom:1px solid var(--border); color:var(--text-muted); padding:14px 18px; font-size:0.8125rem; }
  .child-ccy { font-size:0.75rem; color:var(--text-muted); text-align:center; }
  .child-row td.child-desc { padding-left:60px; color:var(--text-muted); position:relative; }

  /* Vertical stepper line — connects parent avatar down through child rows.
     var(--border) replaces the old #d0d0d0/#444 pair — no [data-theme="dark"]
     override needed, the token already adapts. */
  .child-row td.child-desc::before {
    content:'';
    position:absolute;
    left:34px;             /* aligned with parent avatar center (18px padding + 16px) */
    top:0;
    bottom:0;
    width:1px;
    background:var(--border);
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
    background:var(--border);
  }

  .draft-input { border:1px solid var(--border); border-radius:4px; padding:4px 8px; height:32px; font-size:0.875rem; width:100%; box-sizing:border-box; background:var(--warning-bg); font-family:inherit; }
  .draft-input:focus { outline:none; border-color:var(--accent); }
  .draft-input.req { border:2px solid var(--danger); box-shadow:0 0 0 1px var(--danger); }
  select.draft-input { padding:4px 4px; }
  /* Make draft inputs fill their cells properly */
  .draft-partner-input { flex:1 !important; min-width:0 !important; margin-left:10px !important; width:auto !important; }
  .draft-input[type="date"] { width:100%; }
  /* AP-account cell in the draft parent: input fills the column, save icon fixed */
  .draft-ap-cell { display:flex; align-items:center; gap:6px; }
  .draft-ap-cell .draft-input { flex:1; min-width:0; }
  .draft-ap-cell .btn-save-draft { flex-shrink:0; }
  /* Draft child row amount input — sits in the AMOUNT column: same gutter as
     posted figures so the draft row aligns with data rows (td.amt). */
  .child-row td input[type="number"] { width:100%; box-sizing:border-box; }
  tr[data-draft="true"] td { background:var(--warning-bg); }
  tr[data-draft="true"]:hover td { background:var(--warning-bg); }
  tr[data-draft="true"].child-row td { background:var(--warning-bg); }

  /* Row state classes */
  tr[data-row-type="parent"]:hover td { background:var(--bg); }
  tr.row-loading { opacity:0.6; }
  .child-row:last-child td { border-bottom:1px solid var(--border); }
  .data-table th:last-child,
  .data-table td:last-child { min-width: 110px; }

  /* Bills keyboard nav */
  tr.bill-row-focus td { background: rgba(61, 100, 148, 0.18) !important; }
  [data-theme="dark"] tr.bill-row-focus td { background: rgba(61, 100, 148, 0.35) !important; }
  /* Draft rows in INSERT mode: boost highlight visibility against the warning-tinted background */
  tr.bill-row-focus[data-draft="true"] td { background: rgba(61, 100, 148, 0.35) !important; }
  [data-theme="dark"] tr.bill-row-focus[data-draft="true"] td { background: rgba(61, 100, 148, 0.50) !important; }

  /* Inline journal preview rows (fold area, replaces popup) */
  .data-table tbody.preview-mode tr:hover td { background:inherit !important; }
  tr.preview-row td { background:var(--bg); border-bottom:1px solid var(--border); padding:8px 18px; font-size:0.8125rem; vertical-align:top; }
  tr.preview-row .preview-acct { padding-left:48px; }
  tr.preview-row .preview-acct-name { color:var(--accent); font-weight:500; }
  tr.preview-row .preview-desc { color:var(--text-muted); font-size:0.75rem; margin-top:2px; }
  tr.preview-row .preview-side { color:var(--text-muted); font-size:0.75rem; text-align:center; width:50px; font-weight:600; }
  tr.preview-row .preview-amt { color:var(--text); text-align:right; font-variant-numeric:tabular-nums; }
  tr.preview-row .preview-amt .preview-amt-home { color:var(--text-muted); font-size:0.75rem; }
  tr.preview-row.preview-totals td { font-weight:600; border-top:1px solid var(--border); background:var(--bg); }
  tr.preview-row.preview-totals .preview-totals-label { padding-left:48px; }
  tr.preview-row.preview-fx-header-row td { background:var(--warning-bg); }
  tr.preview-row .preview-fx-header { color:var(--text-muted); font-size:0.8125rem; font-style:italic; }
  tr.preview-row input.preview-acct-input:focus { outline:none; border-color:var(--accent); background:var(--warning-bg); }

  .btn-save-draft { background:none; border:none; cursor:pointer; font-size:1rem; padding:2px 6px; color:var(--text-faint); line-height:1; border-radius:4px; }
  .btn-save-draft:hover { color:var(--accent); background:var(--bg); }
  /* P1-9: hover-only Pay affordance on posted/partial parent rows — no chrome at rest.
     Consolidated onto var(--accent) — was a dedicated #5b8def blue with no
     dark-theme variant of its own. */
  .pay-afford { display:none; margin-left:6px; font-size:0.6875rem; padding:1px 6px; border:1px solid var(--accent); background:var(--surface); color:var(--accent); border-radius:3px; cursor:pointer; line-height:1.4; }
  .pay-afford:hover { background:var(--accent); color:var(--on-accent); }
  .data-table tbody tr:hover .pay-afford { display:inline-block; }
  .data-table tbody.kb-active tr:hover .pay-afford,
  .data-table tbody.insert-mode tr:hover .pay-afford { display:none; }
  /* P1-9: inline payment row. Consolidated onto var(--accent)/var(--dd-active) —
     was a dedicated #5b8def/#f6f9ff blue pair with no dark-theme variant. */
  .pay-row td.pay-cell { padding:6px 12px 6px 60px; background:var(--dd-active); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pay-row .pay-lbl { font-weight:600; font-size:0.625rem; color:var(--accent); text-transform:uppercase; letter-spacing:0.4px; margin-right:8px; }
  tr.pay-row td.pay-cell input.draft-input { height:26px; font-size:0.75rem; margin-right:6px; width:auto; display:inline-block; }
  tr.pay-row td.pay-cell input.pay-date { width:130px; }
  tr.pay-row td.pay-cell input.pay-acct { width:90px; }
  tr.pay-row td.pay-cell input.pay-amount { width:90px; text-align:right; }
  tr.pay-row td.pay-cell input.pay-ref { width:110px; }
  tr.pay-row td.pay-cell input.pay-fx { width:70px; text-align:right; }
  .pay-row .pay-ccy { font-size:0.625rem; color:var(--text-muted); margin-right:6px; }
  .pay-row .pay-hint { font-size:0.625rem; color:var(--text-muted); margin-left:8px; }
  .pay-row .pay-hint a { color:var(--accent); cursor:pointer; text-decoration:none; }
  .pay-row .pay-hint a:hover { text-decoration:underline; }
  /* Issue #131: multi-bill settlement panel (child row, same palette as pay-row) */
  .multi-pay-row td.multi-pay-cell { padding:8px 12px 8px 60px; background:var(--dd-active); vertical-align:top; }
  .multi-pay-row .mp-lbl { font-weight:600; font-size:0.625rem; color:var(--accent); text-transform:uppercase; letter-spacing:0.4px; margin-right:8px; }
  .multi-pay-row .mp-shared { margin-bottom:6px; white-space:nowrap; }
  tr.multi-pay-row td.multi-pay-cell input.draft-input { height:26px; font-size:0.75rem; margin-right:6px; width:auto; display:inline-block; }
  tr.multi-pay-row td.multi-pay-cell input.mp-date { width:130px; }
  tr.multi-pay-row td.multi-pay-cell input.mp-acct { width:90px; }
  tr.multi-pay-row td.multi-pay-cell input.mp-ref { width:110px; }
  tr.multi-pay-row td.multi-pay-cell input.mp-fx { width:70px; text-align:right; }
  tr.multi-pay-row td.multi-pay-cell input.mp-total { width:100px; text-align:right; font-weight:600; }
  tr.multi-pay-row td.multi-pay-cell input.mp-alloc { width:90px; text-align:right; }
  .multi-pay-row .mp-ccy { font-size:0.625rem; color:var(--text-muted); margin-right:6px; }
  .multi-pay-row .mp-list { margin:4px 0 6px 0; }
  .multi-pay-row .mp-item { display:flex; align-items:center; padding:3px 0; border-top:1px solid var(--border); }
  .multi-pay-row .mp-item:first-child { border-top:none; }
  .multi-pay-row .mp-check { width:22px; font-weight:600; color:var(--accent); cursor:pointer; user-select:none; text-align:center; font-size:0.8125rem; }
  .multi-pay-row .mp-item.mp-off .mp-check { color:var(--text-faint); }
  .multi-pay-row .mp-item.mp-focused .mp-check { outline:1px solid var(--accent); }
  .multi-pay-row .mp-item.mp-off .mp-alloc { opacity:0.4; }
  .multi-pay-row .mp-desc { flex:1; font-size:0.75rem; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin:0 8px; }
  .multi-pay-row .mp-desc .mp-amt { color:var(--text-muted); font-size:0.625rem; }
  .multi-pay-row .mp-balance { font-size:0.625rem; font-weight:600; margin-left:8px; }
  .multi-pay-row .mp-balance.ok { color:var(--success); }
  .multi-pay-row .mp-balance.warn { color:var(--warning); }
  .multi-pay-row .mp-hint { font-size:0.625rem; color:var(--text-muted); margin-left:8px; }
  .multi-pay-row .mp-hint a { color:var(--accent); cursor:pointer; text-decoration:none; }
  .multi-pay-row .mp-hint a:hover { text-decoration:underline; }
  /* P1-9: payment history rows on unfold */
  .payment-history-row td { font-size:0.625rem; color:var(--text-muted); font-style:italic; }
  .payment-history-row .pay-voided { text-decoration:line-through; color:var(--text-faint); }
  .msg-pay { margin-top:10px; font-size:0.8125rem; }
  .msg-pay.ok { color:var(--success); }
  .msg-pay.err { color:var(--danger); }

  /* Partner cell navigation (editing only; browse mode uses shared .bill-row-focus) */
  .data-table tbody td.vcell-selected { background:var(--accent) !important; color:var(--on-accent) !important; }
  .data-table tbody td.vcell-selected span:not(.avatar):not(.badge) { color:var(--on-accent) !important; }
  .data-table tbody td.vcell-selected .badge { opacity:0.85; }
  .data-table tbody td.vcell-editing { background:var(--surface) !important; color:var(--text) !important; box-shadow:inset 0 0 0 2px var(--accent); padding:3px 8px !important; }
  .data-table tbody td.vcell-editing input { border:none; outline:none; background:transparent; font-size:inherit; font-family:'Helvetica Neue',Arial,sans-serif !important; color:var(--text) !important; padding:0; box-sizing:border-box; }
  #vendors-body input { font-family:'Helvetica Neue',Arial,sans-serif !important; font-size:inherit !important; }
  .fb-dd { font-family:'Helvetica Neue',Arial,sans-serif; }

  /* Aging/Control tabs — fetched report fragment, not an iframe (no nested
     document navigation, no duplicate <head>/CSS parse). Mirrors
     reports/render.js htmlPage()'s embedded styling, theme-aware.
     docs/ia-restructure-3-spec.md §1. */
  .rpt-embed { border:none; width:100%; min-height:500px; display:block; background:var(--surface); border-radius:8px; padding:16px 20px; }
  .rpt-embed .page { padding:0; max-width:none; }
  .rpt-embed .header { display:none; } /* period/company header — redundant with this page's own H1 */
  .rpt-embed table { width:100%; border-collapse:collapse; margin-top:8px; }
  .rpt-embed th { text-align:left; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-muted); border-bottom:1px solid var(--border); padding:6px 8px; }
  .rpt-embed td { padding:5px 8px; border-bottom:1px solid var(--border); vertical-align:top; color:var(--text); }
  .rpt-embed .footer { margin-top:24px; padding-top:12px; border-top:1px solid var(--border); font-size:0.75rem; color:var(--text-muted); }
  .rpt-embed-msg { padding:1rem 0; color:var(--text-muted); }
</style>
</head>
<body>${navBar(company, 'payables')}
<div class="page page-wide">

  <!-- Page header -->
  <div class="header">
    <h1>📋 Payables</h1>
  </div>

  <!-- Tab strip (IA restructure 2: 4 tabs — Bills · Vendors · Aging · Control) -->
  <div class="tabs">
    <div class="tab active" data-tab="bills" onclick="showTab('bills')">Bills</div>
    <div class="tab" data-tab="vendors" onclick="showTab('vendors')">Vendors</div>
    <div class="tab" data-tab="aging" onclick="showTab('aging')">Aging</div>
    <div class="tab" data-tab="control" onclick="showTab('control')">Control</div>
  </div>

  <!-- BILLS TAB -->
  <div id="tab-bills" class="tab-panel active">
  <div id="pay-panel-bills">

  <!-- KPI cards -->
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

  <!-- Date-range toolbar retired (global-period-selector-chrome-spec §5):
       bills now read from the global Period Selector (FB.period). -->
  <div class="tb-controls-row" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:16px;">
  </div>

  <!-- Table card -->
  <div class="table-card">
    <table class="data-table" id="bills-table">
      <!-- Column weighting lives in CSS on the col classes (single source of
           truth — the .single-ccy state re-weights when CCY collapses). Fixed
           layout reads widths from the colgroup. -->
      <colgroup>
        <col class="col-partner">   <!-- PARTNER -->
        <col class="col-date">     <!-- DATE (year-elided "21 Jul" + ISO tooltip) -->
        <col class="col-due">      <!-- DUE -->
        <col class="col-ref">      <!-- REFERENCE -->
        <col class="col-amount">   <!-- AMOUNT (incl. icon-width alignment gutter) -->
        <col class="col-ccy">      <!-- CCY -->
        <col class="col-status">   <!-- STATUS -->
      </colgroup>
      <thead>
        <tr>
          <th class="sortable" data-col="partner_name" data-filter-type="text"><div class="th-inner"><span class="th-label">Partner</span><span class="th-sort"></span></div></th>
          <th class="sortable" data-col="date" data-filter-type="date"><div class="th-inner"><span class="th-label">Date</span><span class="th-sort"></span></div></th>
          <th class="sortable" data-col="due_date" data-filter-type="date"><div class="th-inner"><span class="th-label">Due</span><span class="th-sort"></span></div></th>
          <th data-col="vendor_ref" data-filter-type="text"><div class="th-inner"><span class="th-label">Reference</span></div></th>
          <th class="sortable" data-col="amount" data-filter-type="amount"><div class="th-inner"><span class="th-label">Amount</span><span class="th-sort"></span></div></th>
          <th class="sortable" data-col="currency" data-filter-type="list"><div class="th-inner"><span class="th-label">CCY</span><span class="th-sort"></span></div></th>
          <th class="sortable" data-col="status" data-filter-type="list"><div class="th-inner"><span class="th-label">Status</span><span class="th-sort"></span></div></th>
        </tr>
      </thead>
      <tbody id="bills-tbody">
        <tr><td colspan="7" style="text-align:center;color:var(--text-faint);padding:32px">Loading&#8230;</td></tr>
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
  </div><!-- /tab-bills -->

  <!-- VENDORS TAB -->
  <div id="tab-vendors" class="tab-panel">
    <table class="edit-table" id="vendors-table">
      <thead><tr><th>Name</th><th>AP Account</th><th>Expense Account</th><th>Currency</th><th>Terms (days)</th><th>Active</th></tr></thead>
      <tbody id="vendors-body"></tbody>
    </table>
  </div>

  <!-- AGING TAB — fetched fragment of report?type=ap-aging -->
  <div id="tab-aging" class="tab-panel">
    <div id="aging-body" class="rpt-embed"><p class="rpt-embed-msg">Loading…</p></div>
  </div>

  <!-- CONTROL TAB — fetched fragment of report?type=ap-control -->
  <div id="tab-control" class="tab-panel">
    <div id="control-body" class="rpt-embed"><p class="rpt-embed-msg">Loading…</p></div>
  </div>

</div>

<script>
var COMPANY = '${company}';
var BASE_CURRENCY = '${baseCurrency}';
// Relevance flags (settings-ux-spec §7 item 9 + fx-automation-spec §1):
// server-rendered so billsTabJS can drop the VAT column / stated-VAT footer /
// per-code footers when vatRegistered=false, and lock CCY to base currency when
// fxTracking='off' — no flash, no async client hiding.
window.__fbFlags = ${flagsJson};
${billsTabJS(flags)}
${partnersTabJS()}

// ========== TAB SWITCHER (IA restructure 2: Bills · Vendors · Aging · Control) ==========
var PAYABLES_TABS = ['bills','vendors','aging','control'];
function showTab(t) {
  // Modal guard — don't abandon a dirty row mid-edit.
  if (window.FB && FB.list && FB.list.anyDirty()) {
    FB.list.guard(function(){ showTab(t); }); return;
  }
  PAYABLES_TABS.forEach(function(tab) {
    var el = document.querySelector('.tab[data-tab="' + tab + '"]');
    var panel = document.getElementById('tab-' + tab);
    if (el) el.classList.toggle('active', tab === t);
    if (panel) panel.classList.toggle('active', tab === t);
  });
  // Load tab content on first visit.
  if (t === 'vendors' && !window._vendorsLoaded) {
    window._vendorsLoaded = true;
    if (typeof loadPartners === 'function') {
      var vendorsLoaded = loadPartners();
      // Deep-linked from search — pre-filter to the matched partner once
      // data is in (same applyFilterExpr() qualifier grammar as Accounting's).
      var vendorFilter = new URLSearchParams(window.location.search).get('filter');
      if (vendorFilter && vendorsLoaded && vendorsLoaded.then) vendorsLoaded.then(function () { partnersList.applyFilterExpr('name:' + vendorFilter); });
    }
  }
  if (t === 'aging') loadReportEmbed('aging-body', 'ap-aging');
  if (t === 'control') loadReportEmbed('control-body', 'ap-control');
  updateDownloadHooks(t);
  // Persist last-active tab (session-scoped, §2.4).
  // Per-tab relevance override (global-period-selector-chrome-spec §4.2):
  // bills→range, vendors→none, aging→asOf, control→asOf.
  var TAB_RELEVANCE = { bills: 'range', vendors: 'none', aging: 'asOf', control: 'asOf' };
  if (window.FB && FB.period) FB.period.setRelevance(TAB_RELEVANCE[t] || 'none');
  try { sessionStorage.setItem('fb.tab.payables', t); } catch(e) {}
}

// Load (or reload) a report fragment for the Aging/Control tabs — fetches the
// standalone report page and extracts its .page element client-side
// (DOMParser), same technique as reports-hub.js and accounting.js's Integrity
// tab (docs/ia-restructure-3-spec.md §1). No nested-document navigation, no
// duplicate <head>/CSS parse, cached per URL for the session. Reads the
// as-of date from FB.period.get().end — the server requires ?end= for all
// report types including as-of reports (ap-aging, ap-control). If no period
// is resolved yet (fresh company, no transactions), the container shows a
// prompt rather than firing a 400.
//
// ap-aging is excluded from this path — its <tbody> is empty, populated
// entirely by an embedded FB.list.create().load() script written for an
// isolated iframe's own independent FB instance (confirmed: executing it in
// this host page's shared scope broke FB.period app-wide). It keeps the old
// iframe mechanism, auto-resized to content height so the report just prints
// downward instead of scrolling inside a height-clamped box. ap-control's
// rows ARE server-rendered — safe on the fragment path.
var IFRAME_REPORTS = ['ap-aging'];
function loadReportIframe(containerId, url) {
  var body = document.getElementById(containerId);
  if (!body) return;
  body.innerHTML = '<iframe id="rpt-iframe-' + containerId + '" src="' + url.replace(/"/g, '&quot;')
    + '" style="border:none;width:100%;height:200px;display:block;background:var(--surface)"></iframe>';
  var frame = document.getElementById('rpt-iframe-' + containerId);
  // ResizeObserver, not a one-shot resize-on-load measurement: this report
  // populates its table via its own async script (a bill.aging/journal.list-
  // style call) that resolves after the load event fires — a single
  // measurement would capture the still-empty shell's height. Matches
  // reports-hub.js's fix.
  frame.onload = function() {
    try {
      // Isolated iframe, own independent FB instance (see the comment above)
      // — without this, every FB binding inside it appears dead to the human.
      if (window.FB && FB.util && FB.util.forwardIframeKeys) FB.util.forwardIframeKeys(frame);
      var doc = frame.contentWindow.document;
      function resize() {
        var h = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
        frame.style.height = h + 'px';
      }
      resize();
      var ro = new ResizeObserver(resize);
      ro.observe(doc.body);
    } catch (e) {}
  };
}

var _rptEmbedCache = {};
function loadReportEmbed(containerId, reportType) {
  var body = document.getElementById(containerId);
  if (!body) return;
  var st = window.FB && FB.period ? FB.period.get() : { end: '' };
  var end = st.end || '';
  if (!end) { body.innerHTML = '<p class="rpt-embed-msg">Select a period first.</p>'; return; }
  var url = '/api/' + COMPANY + '/report?type=' + reportType + '&end=' + encodeURIComponent(end);
  if (IFRAME_REPORTS.indexOf(reportType) >= 0) { loadReportIframe(containerId, url); return; }
  if (_rptEmbedCache[url]) { body.innerHTML = _rptEmbedCache[url]; return; }
  body.innerHTML = '<p class="rpt-embed-msg">Loading…</p>';
  fetch(url).then(function(r) {
    var ct = r.headers.get('content-type') || '';
    return r.text().then(function(text) { return { ok: r.ok, ct: ct, text: text }; });
  }).then(function(r) {
    if (!r.ok || r.ct.indexOf('application/json') === 0) {
      var msg = 'Load failed';
      try { msg = JSON.parse(r.text).error || msg; } catch(e) {}
      body.innerHTML = '<p class="rpt-embed-msg" style="color:var(--danger)">' + esc(msg) + '</p>';
      return;
    }
    var doc = new DOMParser().parseFromString(r.text, 'text/html');
    var pageEl = doc.querySelector('.page');
    if (!pageEl) { body.innerHTML = '<p class="rpt-embed-msg">Report returned no content.</p>'; return; }
    // Deliberately NOT re-executing pageEl's embedded <script> (some reports,
    // e.g. AP Aging, ship one): it calls FB.list.create()/FB.keys, written
    // for an isolated iframe with its own independent FB instance — running
    // it in this host page's shared scope collided with the host's live
    // FB.period state (confirmed while building this). The report's DATA is
    // fully server-rendered regardless; only its filter/sort interactivity
    // goes inert, same as before this fetch mechanism existed.
    _rptEmbedCache[url] = pageEl.outerHTML;
    body.innerHTML = pageEl.outerHTML;
  }).catch(function(err) {
    body.innerHTML = '<p class="rpt-embed-msg" style="color:var(--danger)">Load failed: ' + esc(err && err.message ? err.message : 'network error') + '</p>';
  });
}

// Feed the unified topbar download icon (ia-restructure-3-spec.md §6.3) —
// Aging/Control had NO download affordance at all before this; Bills/Vendors
// are editable registers, not reports, and stay without one. AP Aging's raw
// fetched data never reaches window scope as a flat array the way GL/Line
// items/Transactions do — its iframe script groups straight into a nested
// vendorRows global (vendor summary rows, each carrying a _bills array) —
// the generic row→CSV converter below already drops any key starting with
// "_", so exporting vendorRows directly yields the vendor-level summary
// (Current/1-30/31-60/61-90/90+/Total), which is the report's own content.
function _rowsToCsvPayables(rows) {
  if (!rows || !rows.length) return null;
  var keys = Object.keys(rows[0]).filter(function (k) { return k.charAt(0) !== '_'; });
  var header = keys.map(function (k) { return '"' + k.replace(/_/g, ' ').replace(/\\b\\w/g, function (c) { return c.toUpperCase(); }) + '"'; }).join(',');
  var lines = [header];
  rows.forEach(function (r) {
    lines.push(keys.map(function (k) { return '"' + String(r[k] == null ? '' : r[k]).replace(/"/g, '""') + '"'; }).join(','));
  });
  return lines.join('\\n');
}
function _fragmentCsvPayables(containerId) {
  var body = document.getElementById(containerId);
  var tables = body ? body.querySelectorAll('table') : [];
  if (!tables.length) return null;
  var lines = [];
  tables.forEach(function (tbl) {
    tbl.querySelectorAll('tr').forEach(function (tr) {
      var cells = Array.from(tr.querySelectorAll('th,td'));
      if (cells.length) lines.push(cells.map(function (c) { return '"' + c.textContent.trim().replace(/"/g, '""') + '"'; }).join(','));
    });
    lines.push('');
  });
  return lines.join('\\n');
}
function updateDownloadHooks(t) {
  var st = window.FB && FB.period ? FB.period.get() : {};
  if (t === 'aging' || t === 'control') {
    var reportType = t === 'aging' ? 'ap-aging' : 'ap-control';
    var suffix = reportType + (st.end ? '_' + st.end : '');
    window.__fbDownloadPdfUrl = function () {
      var s = window.FB && FB.period ? FB.period.get() : {};
      if (!s.end) return null;
      return '/api/' + COMPANY + '/report?type=' + reportType + '&end=' + encodeURIComponent(s.end);
    };
    if (t === 'aging') {
      window.__fbDownloadCsv = function () {
        var frame = document.getElementById('rpt-iframe-aging-body');
        var csv = frame && frame.contentWindow ? _rowsToCsvPayables(frame.contentWindow.vendorRows) : null;
        return csv ? { filename: suffix + '.csv', csv: csv } : null;
      };
    } else {
      window.__fbDownloadCsv = function () {
        var csv = _fragmentCsvPayables('control-body');
        return csv ? { filename: suffix + '.csv', csv: csv } : null;
      };
    }
  } else {
    window.__fbDownloadPdfUrl = null;
    window.__fbDownloadCsv = null;
  }
}

// Reload the visible report tab when the global period changes.
if (window.FB && FB.period) {
  FB.period.onChange(function () {
    var active = document.querySelector('.tab-panel.active');
    if (!active) return;
    if (active.id === 'tab-aging') loadReportEmbed('aging-body', 'ap-aging');
    if (active.id === 'tab-control') loadReportEmbed('control-body', 'ap-control');
  });
}

// Restore last-active tab on load (or ?tab= param, which takes precedence).
(function() {
  var params = new URLSearchParams(window.location.search);
  var tab = params.get('tab') || '';
  if (!tab) {
    try { tab = sessionStorage.getItem('fb.tab.payables') || ''; } catch(e) {}
  }
  if (tab && PAYABLES_TABS.indexOf(tab) >= 0 && tab !== 'bills') {
    showTab(tab);
  }
})();

</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handlePayablesPage, handleBillsPage: handlePayablesPage };
