'use strict';
/**
 * freeBooks — Bank (Payments + Reconciliation)
 *
 * Revived page (two-way-payments-prep) — a different scope than the old,
 * deleted Bank page (which also had an import wizard; imports stay
 * agent/Inbox-only, unchanged). Two tabs:
 *   - Payments: company-wide payment register (payment.list, billId-optional
 *     mode) — the browsing UI payments never had before this.
 *   - Reconciliation: wires up api/src/bank.js's bank.reconcile.list/.clear,
 *     orphaned since the old page's deletion (issue #137).
 */
const { commonStyle, navBar, layoutEnd } = require('./common');
const { query } = require('../db');
const { paymentsTabJS } = require('./bank-payments');
const { reconciliationTabJS } = require('./bank-reconciliation');

async function handleBankPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const [co] = await query(`SELECT currency AS base_currency FROM companies WHERE company_id = @cid LIMIT 1`, { cid: company }).catch(() => [{}]);
  const baseCurrency = (co && co.base_currency) || 'SGD';
  res.send(buildBankPage(company, baseCurrency));
}

function buildBankPage(company, baseCurrency = 'SGD') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Bank — freeBooks</title>
${commonStyle()}
<style>
  .page { max-width:1100px; }
  .page-header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:28px; }
  .page-header h1 { margin:0 0 4px; font-size:1.667rem; font-weight:700; letter-spacing:-.01em; }

  .table-card { border:1px solid var(--border); border-radius:8px; overflow:visible; }
  .data-table { width:100%; border-collapse:collapse; font-size:0.875rem; table-layout:fixed; }
  .data-table thead { position:sticky; top:0; z-index:10; }
  .data-table th { text-align:left; font-size:0.75rem; color:var(--text-muted); font-weight:600; text-transform:uppercase; letter-spacing:.05em; background:var(--bg); border-bottom:1px solid var(--border); padding:12px 12px; }
  .data-table td { padding:12px 12px; border-bottom:1px solid var(--border); vertical-align:middle; color:var(--text); }
  .data-table tbody tr:last-child td { border-bottom:none; }
  .data-table tbody tr:hover td { background:var(--bg); }
  .data-table tbody tr[data-url] { cursor:pointer; }
  tr.bank-row-focus td { background: rgba(61, 100, 148, 0.18) !important; }
  [data-theme="dark"] tr.bank-row-focus td { background: rgba(61, 100, 148, 0.35) !important; }
  .th-inner { display:flex; align-items:center; gap:4px; position:relative; }
  .th-sort { font-size:0.6875rem; color:var(--text); width:12px; text-align:center; flex-shrink:0; }
  .th-sort:empty { display:none; }

  /* Status/source badges use the shared .badge component (common.css).
     Direction (in/out) carries real semantic color (cash arriving vs.
     leaving) so it maps onto success/warning like any other status;
     manual/bank_match are provenance, not status, and stay neutral/info —
     see the class mapping in bank-payments.js. */

  /* Void: hover-only affordance next to the status badge, never the sole
     content of the Status cell (mirrors Bills tab's .pay-afford). */
  .void-afford { display:none; margin-left:6px; font-size:0.6875rem; padding:1px 6px; border:1px solid var(--danger-border); background:var(--surface); color:var(--danger); border-radius:3px; cursor:pointer; line-height:1.4; }
  .void-afford:hover { background:var(--danger); color:var(--on-accent); }
  .data-table tbody tr:hover .void-afford { display:inline-block; }
  .voided-tag { color:var(--text-faint); font-style:italic; font-size:0.75rem; }

  .tabs { display:flex; gap:0; border-bottom:2px solid var(--accent); margin-bottom:24px; }
  .tab { padding:8px 20px; cursor:pointer; font-weight:600; font-size:0.8125rem; color:var(--text-muted); border-bottom:3px solid transparent; margin-bottom:-2px; }
  .tab.active { color:var(--accent); border-bottom-color:var(--accent); }
  .tab-panel { display:none; }
  .tab-panel.active { display:block; }

  .msg-bank { margin-top:10px; font-size:0.8125rem; }
  .msg-bank.ok { color:var(--success); }
  .msg-bank.err { color:var(--danger); }

  /* Reconciliation tab */
  .recon-toolbar { display:flex; gap:14px; align-items:center; margin-bottom:18px; flex-wrap:wrap; }
  .recon-toolbar select { padding:8px 12px; border:1px solid var(--border); border-radius:6px; font-size:0.8125rem; background:var(--surface); color:var(--text); }
  .recon-summary { display:flex; gap:24px; margin-bottom:18px; }
  .recon-stat { border:1px solid var(--border); border-radius:8px; padding:14px 20px; }
  .recon-stat-label { font-size:0.6875rem; color:var(--text-faint); font-weight:600; text-transform:uppercase; letter-spacing:.05em; margin-bottom:6px; }
  .recon-stat-amount { font-size:1.25rem; font-weight:700; }
  .recon-clear-cell { text-align:center; cursor:pointer; user-select:none; }
  .recon-clear-box { display:inline-block; width:16px; height:16px; border:1px solid var(--text-faint); border-radius:3px; }
  .recon-clear-box.cleared { background:var(--success); border-color:var(--success); position:relative; }
  .recon-clear-box.cleared::after { content:'\\2713'; color:var(--on-accent); font-size:0.6875rem; position:absolute; left:2px; top:-2px; }
</style>
</head>
<body>${navBar(company, 'bank')}
<div class="page page-wide">

  <div class="page-header">
    <h1>🏦 Bank</h1>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="payments" onclick="showBankTab('payments')">Payments</div>
    <div class="tab" data-tab="reconciliation" onclick="showBankTab('reconciliation')">Reconciliation</div>
  </div>

  <!-- PAYMENTS TAB -->
  <div id="tab-payments" class="tab-panel active">
    <div class="filter-bar" style="display:flex; gap:10px; align-items:center; margin-bottom:16px; flex-wrap:wrap;">
      <label style="font-size:0.8125rem;color:var(--text-muted)">Direction
        <select id="pf-direction" onchange="loadPayments()">
          <option value="">All</option>
          <option value="out">Out</option>
          <option value="in">In</option>
        </select>
      </label>
      <label style="font-size:0.8125rem;color:var(--text-muted)">Method
        <select id="pf-method" onchange="loadPayments()">
          <option value="">All</option>
          <option value="manual">Manual</option>
          <option value="bank_match">Bank Match</option>
        </select>
      </label>
      <label style="font-size:0.8125rem;color:var(--text-muted)">
        <input type="checkbox" id="pf-voided" onchange="loadPayments()"> Show voided
      </label>
      <div class="search-wrap" style="flex:1; min-width:180px;">
        <input type="text" id="pf-search" placeholder="Search partner or reference…" oninput="_debouncedLoadPayments()" style="width:100%; padding:8px 12px; border:1px solid var(--border); border-radius:6px; font-size:0.8125rem; box-sizing:border-box; background:var(--surface); color:var(--text);">
      </div>
    </div>
    <div class="table-card">
      <table class="data-table" id="payments-table">
        <colgroup>
          <col style="width:11%">  <!-- Date -->
          <col style="width:8%">   <!-- Direction -->
          <col style="width:20%">  <!-- Partner -->
          <col style="width:14%">  <!-- Bill Ref -->
          <col style="width:13%">  <!-- Amount -->
          <col style="width:12%">  <!-- Method -->
          <col style="width:12%">  <!-- Reference -->
          <col style="width:10%">  <!-- Status -->
        </colgroup>
        <thead>
          <tr>
            <th>Date</th>
            <th>Dir</th>
            <th>Partner</th>
            <th>Bill Ref</th>
            <th style="text-align:right">Amount</th>
            <th>Method</th>
            <th>Reference</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="payments-tbody">
          <tr><td colspan="8" style="text-align:center;color:var(--text-faint);padding:32px">Loading&#8230;</td></tr>
        </tbody>
      </table>
    </div>
    <div class="msg-bank" id="msg-payments"></div>
  </div>

  <!-- RECONCILIATION TAB -->
  <div id="tab-reconciliation" class="tab-panel">
    <div class="recon-toolbar">
      <label style="font-size:0.8125rem;color:var(--text-muted)">Account
        <select id="recon-account"></select>
      </label>
    </div>
    <div class="recon-summary">
      <div class="recon-stat">
        <div class="recon-stat-label">Opening balance</div>
        <div class="recon-stat-amount" id="recon-opening">—</div>
      </div>
      <div class="recon-stat">
        <div class="recon-stat-label">Cleared balance</div>
        <div class="recon-stat-amount" id="recon-cleared-balance">—</div>
      </div>
      <div class="recon-stat">
        <div class="recon-stat-label">Uncleared</div>
        <div class="recon-stat-amount" id="recon-uncleared-count">—</div>
      </div>
    </div>
    <div class="table-card">
      <table class="data-table" id="recon-table">
        <colgroup>
          <col style="width:12%">
          <col style="width:16%">
          <col style="width:34%">
          <col style="width:14%">
          <col style="width:14%">
          <col style="width:10%">
        </colgroup>
        <thead>
          <tr>
            <th>Date</th>
            <th>Reference</th>
            <th>Description</th>
            <th style="text-align:right">Debit</th>
            <th style="text-align:right">Credit</th>
            <th style="text-align:center">Cleared</th>
          </tr>
        </thead>
        <tbody id="recon-tbody">
          <tr><td colspan="6" style="text-align:center;color:var(--text-faint);padding:32px">Select an account.</td></tr>
        </tbody>
      </table>
    </div>
    <div class="msg-bank" id="msg-recon"></div>
  </div>

</div>

<script>
var COMPANY = '${company}';
var BASE_CURRENCY = '${baseCurrency}';
${paymentsTabJS()}
${reconciliationTabJS()}

// ========== TAB SWITCHER ==========
var BANK_TABS = ['payments', 'reconciliation'];
function showBankTab(t) {
  BANK_TABS.forEach(function (tab) {
    var el = document.querySelector('.tab[data-tab="' + tab + '"]');
    var panel = document.getElementById('tab-' + tab);
    if (el) el.classList.toggle('active', tab === t);
    if (panel) panel.classList.toggle('active', tab === t);
  });
  if (t === 'payments' && typeof loadPayments === 'function') loadPayments();
  if (t === 'reconciliation' && typeof initReconciliation === 'function') initReconciliation();
  try { sessionStorage.setItem('fb.tab.bank', t); } catch (e) {}
}

if (window.FB && FB.period) {
  FB.period.setRelevance('range');
  FB.period.onChange(function () {
    var active = document.querySelector('.tab-panel.active');
    if (!active) return;
    if (active.id === 'tab-payments' && typeof loadPayments === 'function') loadPayments();
    if (active.id === 'tab-reconciliation' && typeof loadReconciliation === 'function') loadReconciliation();
  });
}

// Initial load + tab restore (?tab= takes precedence over sessionStorage).
(function () {
  loadPayments();
  var params = new URLSearchParams(window.location.search);
  var tab = params.get('tab') || '';
  if (!tab) { try { tab = sessionStorage.getItem('fb.tab.bank') || ''; } catch (e) {} }
  if (tab && BANK_TABS.indexOf(tab) >= 0 && tab !== 'payments') showBankTab(tab);
})();
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleBankPage };
