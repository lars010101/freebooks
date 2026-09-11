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
const { commonStyle, navBar, layoutEnd, flagsBootstrapJson } = require('./common');
const { query } = require('../db');
const { paymentsTabJS } = require('./bank-payments');
const { reconciliationTabJS } = require('./bank-reconciliation');

async function handleBankPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const [co] = await query(`SELECT currency AS base_currency, jurisdiction FROM companies WHERE company_id = @cid LIMIT 1`, { cid: company }).catch(() => [{}]);
  const baseCurrency = (co && co.base_currency) || 'SGD';
  res.send(buildBankPage(company, baseCurrency, (co && co.jurisdiction) || ''));
}

function buildBankPage(company, baseCurrency = 'SGD', jurisdiction = '') {
  // Only jurisdiction (for FB.util.fmtAmt's number formatting) and
  // baseCurrency are relevant here — this page has no VAT/FX/centers UI, so
  // a full getRelevanceFlags() call would be more than this page needs.
  const flagsJson = flagsBootstrapJson({ jurisdiction, baseCurrency });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Bank — freeBooks</title>
${commonStyle()}
<style>
  .page { max-width:1100px; }

  /* docs/UI.md — Table: dense by default (font-size 0.8125rem, was the same
     off-scale 0.875rem Payables had), flush on the page (no wrapping
     .table-card border/radius — borderless is the standard now, matching
     Inbox). Auto layout (no colgroup/table-layout:fixed) — matches Inbox's
     .jrnl-table, and sidesteps the column-track-count bug class fixed on
     Payables (a colgroup/th count that drifts from cfg.columns.length + 1
     for the framework's own trailing row-actions cell). */
  .data-table { width:100%; border-collapse:collapse; font-size:0.8125rem; }
  .data-table thead { position:sticky; top:0; z-index:10; }
  .data-table th { text-align:left; font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; background:var(--bg); border-bottom:1px solid var(--border); padding:6px 6px; }
  .data-table td { padding:4px 6px; border-bottom:1px solid var(--border); vertical-align:middle; color:var(--text); }
  .data-table tbody tr:last-child td { border-bottom:none; }
  .data-table tbody tr:hover td { background:var(--bg); }
  .data-table tbody tr[data-url] { cursor:pointer; }

  /* Status/source badges use the shared .badge component (common.css).
     Direction (in/out) carries real semantic color (cash arriving vs.
     leaving) so it maps onto success/warning like any other status;
     manual/bank_match are provenance, not status, and stay neutral/info —
     see the class mapping in bank-payments.js. Void is now a rowVerbs chip
     (fb-list.js's shared .chip/.chip-cancel row-verb affordance) — the old
     bespoke .void-afford hover recipe is gone with the hand-rolled table it
     belonged to. */

  /* .tabs/.tab/.tab-panel now in common.css (2026-09-09) — 20px margin
     matches Inbox's own override (docs/UI.md — chrome alignment: header,
     tabs, and table start at the identical pixel position on every page). */
  .tabs { margin-bottom:20px; }

  /* Reconciliation's account selector + summary stats, hoisted into the
     page header (2026-09-11) — same hybrid as Payables' Bills stat-strip:
     tab-scoped (hidden unless Reconciliation is active, toggled in
     showBankTab) and position:absolute so it never contributes to
     .header's own height (docs/UI.md — chrome alignment). Unlike Payables'
     stats, these are scoped one level deeper than "this tab" — they're
     meaningless without an account selected too — so the selector moved up
     WITH the stats instead of staying behind near the table, keeping the
     numbers and the control that determines them next to each other. */
  .header { position:relative; }
  .recon-stat-strip { position:absolute; right:0; top:50%; transform:translateY(-50%); display:flex; align-items:center; gap:18px; }
  .recon-stat-strip[hidden] { display:none; }
  .recon-stat-strip select { padding:4px 8px; border:1px solid var(--border); border-radius:6px; font-size:0.8125rem; background:var(--surface); color:var(--text); }
  .recon-stat-item { display:flex; flex-direction:column; align-items:flex-end; gap:2px; }
  .recon-stat-label { font-size:0.6875rem; color:var(--text-faint); font-weight:600; text-transform:uppercase; letter-spacing:.05em; }
  .recon-stat-value { font-size:1rem; font-weight:700; color:var(--text); font-variant-numeric:tabular-nums; }
  .recon-stat-sep { width:1px; height:30px; background:var(--border); }
  .recon-clear-cell { text-align:center; cursor:pointer; user-select:none; }
  .recon-clear-box { display:inline-block; width:16px; height:16px; border:1px solid var(--text-faint); border-radius:3px; }
  .recon-clear-box.cleared { background:var(--success); border-color:var(--success); position:relative; }
  .recon-clear-box.cleared::after { content:'\\2713'; color:var(--on-accent); font-size:0.6875rem; position:absolute; left:2px; top:-2px; }
</style>
</head>
<body>${navBar(company, 'bank')}
<div class="page page-wide">

  <div class="header">
    <h1>🏦 Bank</h1>
    <!-- Reconciliation-only: account selector + summary, hidden unless that
         tab is active (toggled by showBankTab below). -->
    <div class="recon-stat-strip" id="bank-recon-stat-strip" hidden>
      <label style="font-size:0.8125rem;color:var(--text-muted)">Account
        <select id="recon-account"></select>
      </label>
      <span class="recon-stat-sep"></span>
      <div class="recon-stat-item">
        <span class="recon-stat-label">Opening</span>
        <span class="recon-stat-value" id="recon-opening">—</span>
      </div>
      <span class="recon-stat-sep"></span>
      <div class="recon-stat-item">
        <span class="recon-stat-label">Cleared</span>
        <span class="recon-stat-value" id="recon-cleared-balance">—</span>
      </div>
      <span class="recon-stat-sep"></span>
      <div class="recon-stat-item">
        <span class="recon-stat-label">Uncleared</span>
        <span class="recon-stat-value" id="recon-uncleared-count">—</span>
      </div>
    </div>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="payments" onclick="showBankTab('payments')">Payments</div>
    <div class="tab" data-tab="reconciliation" onclick="showBankTab('reconciliation')">Reconciliation</div>
  </div>

  <!-- PAYMENTS TAB -->
  <div id="tab-payments" class="tab-panel active">
    <!-- No page-specific Direction/Method/Voided toolbar — Dir/Method/Status
         are already sortable/filterable columns (≡) via FB.list itself. -->
    <table class="data-table" id="payments-table">
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
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="payments-tbody">
        <tr><td colspan="9" class="table-empty">Loading&#8230;</td></tr>
      </tbody>
    </table>
  </div>

  <!-- RECONCILIATION TAB -->
  <div id="tab-reconciliation" class="tab-panel">
    <table class="data-table" id="recon-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Reference</th>
          <th>Description</th>
          <th style="text-align:right">Debit</th>
          <th style="text-align:right">Credit</th>
          <th style="text-align:center">Cleared</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="recon-tbody">
        <tr><td colspan="7" class="table-empty">Select an account.</td></tr>
      </tbody>
    </table>
  </div>

</div>

<script>
window.__fbFlags = ${flagsJson};
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
  // Reconciliation's account selector + summary live in the header now —
  // pure visibility toggle, same as Payables' Bills-only stat strip.
  var reconStrip = document.getElementById('bank-recon-stat-strip');
  if (reconStrip) reconStrip.hidden = (t !== 'reconciliation');
  if (t === 'payments' && window.paymentsList) paymentsList.load();
  if (t === 'reconciliation' && typeof initReconciliation === 'function') initReconciliation();
  try { sessionStorage.setItem('fb.tab.bank', t); } catch (e) {}
}

if (window.FB && FB.period) {
  FB.period.setRelevance('range');
  FB.period.onChange(function () {
    var active = document.querySelector('.tab-panel.active');
    if (!active) return;
    if (active.id === 'tab-payments' && window.paymentsList) paymentsList.load();
    if (active.id === 'tab-reconciliation' && window.reconciliationList && document.getElementById('recon-account') && document.getElementById('recon-account').value) reconciliationList.load();
  });
}

// Initial load + tab restore (?tab= takes precedence over sessionStorage).
(function () {
  paymentsList.load();
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
