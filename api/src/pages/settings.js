'use strict';
const { makeQuery, commonStyle, navBar, layoutEnd } = require('./common');

async function handleSettingsPage(req, res) {
  const { company } = req.params;
  // IA-spec step 4 (§5.10, 2026-08-04): Periods promoted to a top-level
  // section; the Settings Periods tab was removed. Old deep links redirect.
  if (req.query && req.query.tab === 'periods') {
    return res.redirect(302, '/' + company + '/periods');
  }
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildSettingsPage(company));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}


function buildSettingsPage(company) {
  const cfOptions = ['','Cash','Op-WC','Operating','Tax','Investing','Financing','NonCash','Excluded']
    .map(v => `<option value="${v}">${v || '- none -'}</option>`).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Settings - freeBooks</title>
${commonStyle()}
<style>
  .tabs { display:flex; gap:0; border-bottom:2px solid #1a1a1a; margin-bottom:24px; }
  .tab { padding:8px 20px; cursor:pointer; font-weight:600; font-size:10pt; color:#555; border-bottom:3px solid transparent; margin-bottom:-2px; }
  .tab.active { color:#1a1a1a; border-bottom-color:#1a1a1a; }
  .tab-panel { display:none; }
  .tab-panel.active { display:block; }
  table.edit-table { width:100%; border-collapse:collapse; font-size:10pt; }
  table.edit-table th { text-align:left; font-size:9pt; text-transform:uppercase; color:#555; border-bottom:1px solid #ccc; padding:6px 6px; white-space:nowrap; }
  table.edit-table td { padding:4px 4px; border-bottom:1px solid #f0f0f0; vertical-align:middle; white-space:nowrap; }
  table.edit-table input[type=text], table.edit-table input[type=date], table.edit-table select { width:100%; padding:4px 6px; border:1px solid #ddd; border-radius:3px; font-size:10pt; }
  table.edit-table .ro { background:#f5f5f5; color:#888; padding:4px 6px; border-radius:3px; display:block; }
  .field-row { display:flex; flex-direction:column; gap:4px; margin-bottom:14px; }
  .field-row label { font-weight:600; font-size:10pt; color:#555; }
  .field-row input[type=text], .field-row select { padding:7px 10px; border:1px solid #ccc; border-radius:4px; font-size:10pt; max-width:300px; }
  .msg { margin-top:10px; font-size:10pt; }
  .msg.ok { color:#2a8a2a; }
  .msg.err { color:#cc2222; }
  .search-bar { padding:6px 10px; border:1px solid #ccc; border-radius:4px; font-size:10pt; margin-bottom:12px; width:260px; }
  .btn-sm { padding:0 14px; height:32px; font-size:10pt; cursor:pointer; border:1px solid #ccc; border-radius:3px; background:#f5f5f5; }
  .btn-sm:hover { background:#e8e8e8; }
  .btn-sm.danger { border-color:#cc2222; color:#cc2222; }
  button.btn-primary { padding:10px 24px; background:#1a1a1a; color:#fff; border:none; border-radius:4px; font-size:11pt; font-weight:600; cursor:pointer; }
  button.btn-primary:hover { background:#333; }
  button.btn-primary:disabled { background:#ccc; color:#666; cursor:not-allowed; }
  /* Modal-edit doctrine (docs/settings-ux-spec.md) */
  #tab-coa tbody td, #tab-vat tbody td, #tab-journals tbody td { cursor:text; }
  tr.row-dirty > td:first-child { box-shadow: inset 3px 0 0 #d97706; }
  .dirty-val { color:#b45309; }
  tr.row-editing > td { background:#fffbeb; }
  .row-actions { white-space:nowrap; text-align:right; }
  .chip { cursor:pointer; padding:2px 8px; border:1px solid #ccc; border-radius:3px; font-size:10pt; user-select:none; }
  .chip:hover { background:#f0f0f0; }
  .chip-ok { color:#2a8a2a; border-color:#2a8a2a; }
  .chip-cancel { color:#cc2222; border-color:#cc2222; }
  .pe-ro { color:#888; }
  /* .fb-modal* rules moved to common.css 2026-07-28 (K2 — FB.modal is the
     one shared modal; page-local copies deleted, see keyboard-ux-spec §7). */
  /* ── Opening Balances tab (relocated from standalone route 2026-07-28) ── */
  .ob-header-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:14px 24px; max-width:700px; margin-bottom:20px; }
  .ob-field { display:flex; flex-direction:column; gap:4px; }
  .ob-field label { font-weight:600; font-size:10pt; color:#555; }
  .ob-field input, .ob-field select { padding:7px 10px; border:1px solid #ccc; border-radius:4px; font-size:10pt; }
  .ob-field input:focus, .ob-field select:focus { outline:none; border-color:#888; }
  .filter-btns { display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap; align-items:center; }
  .filter-btns button { padding:5px 14px; border:1px solid #ccc; border-radius:4px; font-size:10pt; cursor:pointer; background:#f5f5f5; }
  .filter-btns button.active { background:var(--toggle-on,#f59e0b); color:var(--toggle-on-text,#1a1a1a); border-color:var(--toggle-on-border,#d97706); }
  .filter-btns button:hover:not(.active) { background:#eee; }
  table.ob-table { width:100%; border-collapse:collapse; font-size:10pt; }
  table.ob-table th { text-align:left; font-size:9pt; color:#555; text-transform:uppercase; border-bottom:2px solid #ccc; padding:6px 8px; }
  table.ob-table td { padding:4px 6px; border-bottom:1px solid #f0f0f0; }
  table.ob-table tr:hover td { background:#fafafa; }
  table.ob-table input[type=number] { width:110px; padding:4px 7px; border:1px solid #ddd; border-radius:3px; font-size:10pt; text-align:right; }
  table.ob-table input[type=number]:focus { outline:none; border-color:#888; }
  .ob-totals { display:flex; gap:24px; align-items:center; margin-top:14px; padding:12px 16px;
    background:#f8f8f8; border-radius:6px; font-size:10pt; flex-wrap:wrap; }
  .ob-totals .tot-item { display:flex; flex-direction:column; gap:2px; }
  .ob-totals .tot-label { font-size:9pt; color:#888; font-weight:600; text-transform:uppercase; }
  .ob-totals .tot-val { font-size:12pt; font-weight:700; font-family:monospace; }
  .ob-totals .tot-diff-ok { color:#2a8a2a; }
  .ob-totals .tot-diff-bad { color:#cc2222; }
  .success-box { background:#f0fff4; border:1px solid #2a8a2a; border-radius:6px; padding:20px 24px; max-width:500px; }
  .success-box h2 { color:#2a8a2a; margin:0 0 10px; }
  .success-box a { color:#1a1a1a; font-weight:600; }
  .type-badge { display:inline-block; padding:1px 7px; border-radius:3px; font-size:9pt; font-weight:600; }
  .ob-info-box { background:#f0f4ff; border:1px solid #2255cc; border-radius:4px; padding:12px 16px;
    font-size:10pt; margin-bottom:16px; }
</style>
</head>
<body>${navBar(company, 'settings')}
<div class="page">
  <div class="header">
    <h1>⚙ Settings</h1>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="showTab('company')">Company<span id="tab-dot-company" style="display:none;color:#d97706"> ●</span></div>
    <div class="tab" onclick="showTab('coa')">Chart of Accounts<span id="tab-dot-coa" style="display:none;color:#d97706"> ●</span></div>
    <div class="tab" id="tab-vat-label" onclick="showTab('vat')">Tax Codes<span id="tab-dot-vat" style="display:none;color:#d97706"> ●</span></div>
    <div class="tab" onclick="showTab('journals')">Journals<span id="tab-dot-journals" style="display:none;color:#d97706"> ●</span></div>
    <div class="tab" id="tab-fxrates-label" onclick="showTab('fxrates')">Exchange Rates</div>
    <div class="tab" onclick="showTab('ai')">AI</div>
    <div class="tab" onclick="showTab('opening-balances')">Opening Balances</div>
  </div>

  <!-- Periods tab REMOVED 2026-08-04 (IA-spec step 4, §5.10): Periods is now
       a top-level section at /:company/periods. The grid config lifted into
       pages/periods-grid.js (shared module); ?tab=periods 302-redirects. -->

  <!-- COMPANY TAB — FB.list attribute/value grid (settings-ux-spec §7 item 1
       rev. 3, supersedes the slim record form). One FIXED row per company
       attribute (canAdd: false — no add, no delete; every row is critical).
       Columns Attribute | Value | Type; only the Value cell edits, with a
       per-row editor (text/number/checkbox/select) resolved from the
       server-sent row shape. w writes ONE attribute via company.attr.save
       (server-authoritative validation); u reverts; Esc never saves. The
       all-companies grid stays deleted: switch via the top-left switcher,
       create via its "+ New company" link, delete via the danger zone below. -->
  <div id="tab-company" class="tab-panel active">
    <table class="edit-table" id="company-attrs-table">
      <thead><tr><th>Attribute</th><th>Value</th><th>Type</th><th></th></tr></thead>
      <tbody id="company-attrs-body"></tbody>
    </table>

    <!-- SETUP — opening balances (Xero conversion-balances pattern, ratified
         2026-07-28): the once-per-company migration screen is linked from
         Settings, not the sidebar; also palette-reachable via the route
         registry. -->
    <div style="margin-top:18px;padding:12px 18px;border:1px solid #ddd;border-radius:6px;background:#fafafa;display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap">
      <div style="font-size:10pt;color:#333"><strong>Opening balances</strong> — per-account starting balances as of your go-live date (once-per-company migration).</div>
      <a href="/${company}/settings?tab=opening-balances" class="btn-sm" style="text-decoration:none;display:inline-block">Opening Balances →</a>
    </div>

    <!-- DANGER ZONE — settings-ux-spec §7 item 1 rev 2026-07-27 final.
         Deletes the CURRENT company via company.delete. Server guards:
         last-company refusal + posted-books (journal entries) refusal. On
         success the client redirects to the first surviving company. The
         styled fb-modal surfaces both the irreversibility confirmation and,
         on INVALID_STATE, the server's explanatory message. -->
    <div id="company-danger-zone" class="company-danger-zone"
         style="margin-top:28px;padding:14px 18px;border:1px solid #cc2222;border-radius:6px;background:#fff5f5">
      <div style="font-weight:700;color:#cc2222;font-size:10pt;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px">Danger Zone</div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap">
        <div style="font-size:10pt;color:#333">Delete this company and all of its books. This is permanent and cannot be undone.</div>
        <button type="button" class="btn-sm danger" id="cr-delete-btn" onclick="companyDanger.confirmDelete()">Delete this company</button>
      </div>
    </div>
  </div>

  <!-- COA TAB -->
  <div id="tab-coa" class="tab-panel">
    <table class="edit-table" id="coa-table">
      <thead><tr><th>Code</th><th>Account Name</th><th>Type</th><th>Subtype</th><th>CF Category</th><th>Active</th><th>Default</th><th>Start</th><th></th></tr></thead>
      <tbody id="coa-body"></tbody>
    </table>
  </div>

  <!-- JOURNALS TAB -->
  <div id="tab-journals" class="tab-panel">
    <table class="edit-table" id="journals-table">
      <thead><tr><th>Code</th><th>Name</th><th style="text-align:center">Active</th><th></th></tr></thead>
      <tbody id="journals-body"></tbody>
    </table>
  </div>

  <!-- VAT/GST CODES TAB — the VAT Tolerance panel is GONE (settings-ux-spec §7
       item 1 rev. 3): tolerance lives on the Company attribute grid as two
       typed Number rows. This tab is only the codes register. -->
  <div id="tab-vat" class="tab-panel">
    <table class="edit-table" id="vat-table">
      <thead><tr><th>Code</th><th>Description</th><th>Rate %</th><th>Input Acct</th><th>Output Acct</th><th>Report Box</th><th style="text-align:center">Rev.Chg</th><th style="text-align:center">Active</th><th></th></tr></thead>
      <tbody id="vat-body"></tbody>
    </table>
  </div>

  <!-- EXCHANGE RATES TAB — the FX provider panel is GONE (settings-ux-spec §7
       item 5 rev. 3): provider + API key are per-company rows on the Company
       attribute grid ('manual' = no auto-download). This tab is only the rates
       register + the 📡 Fetch Rates list-level action. -->
  <div id="tab-fxrates" class="tab-panel">
    <table class="edit-table" id="fx-rates-table">
      <thead><tr><th>Date</th><th>From</th><th>To</th><th style="text-align:right">Rate</th><th>Source</th><th></th></tr></thead>
      <tbody id="fx-rates-body"></tbody>
    </table>
  </div>

  <!-- AI TAB — agent pipeline config + LLM provider (B9 spec) -->
  <div id="tab-ai" class="tab-panel">
    <div style="padding:12px 18px;border:1px solid #ddd;border-radius:6px;background:#fafafa;margin-bottom:18px">
      <div style="font-size:10pt;color:#333;margin-bottom:8px"><strong>Agent pipeline</strong> — automatic processing of bank statements and bills dropped in the inbox folder.</div>
      <table class="edit-table" style="background:transparent">
        <tbody>
          <tr>
            <td style="white-space:nowrap">Enable agent pipeline</td>
            <td><input type="checkbox" id="ai-agent-enabled" onchange="markDirty('ai')"></td>
          </tr>
          <tr>
            <td style="white-space:nowrap">Poll interval (ms)</td>
            <td><input type="number" id="ai-poll-interval" value="30000" style="width:120px" onchange="markDirty('ai')"></td>
          </tr>
          <tr>
            <td style="white-space:nowrap">Inbox path</td>
            <td><input type="text" id="ai-inbox-path" style="width:400px" placeholder="~/freebooks-inbox" onchange="markDirty('ai')"></td>
          </tr>
          <tr>
            <td style="white-space:nowrap">Agent status</td>
            <td><span id="ai-agent-status" style="color:#666;font-size:9pt">Loading…</span></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div style="padding:12px 18px;border:1px solid #ddd;border-radius:6px;background:#fafafa;margin-bottom:18px">
      <div style="font-size:10pt;color:#333;margin-bottom:8px"><strong>LLM provider</strong> — OpenAI-compatible endpoint for tier-4 residual matching. Works with local llama.cpp, OpenAI, or any compatible server.</div>
      <table class="edit-table" style="background:transparent">
        <tbody>
          <tr>
            <td style="white-space:nowrap">Endpoint URL</td>
            <td><input type="text" id="ai-llm-endpoint" style="width:400px" placeholder="http://127.0.0.1:8080 or https://api.openai.com" onchange="markDirty('ai')"></td>
          </tr>
          <tr>
            <td style="white-space:nowrap">API key</td>
            <td><input type="password" id="ai-llm-key" style="width:400px" placeholder="(optional — empty for local)" onchange="markDirty('ai')"></td>
          </tr>
          <tr>
            <td style="white-space:nowrap">Model</td>
            <td><input type="text" id="ai-llm-model" style="width:300px" placeholder="qwen2.5-7b-instruct" onchange="markDirty('ai')"></td>
          </tr>
          <tr>
            <td style="white-space:nowrap">Temperature</td>
            <td><input type="number" id="ai-llm-temp" value="0.1" step="0.1" min="0" max="2" style="width:80px" onchange="markDirty('ai')"></td>
          </tr>
          <tr>
            <td></td>
            <td>
              <button class="btn-sm" onclick="testLLM()">Test connection</button>
              <span id="ai-test-result" style="margin-left:8px;font-size:9pt"></span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div style="padding:12px 18px;border:1px solid #ddd;border-radius:6px;background:#fafafa;margin-bottom:18px">
      <div style="font-size:10pt;color:#333;margin-bottom:8px">
        <strong>Vision LLM</strong> — OpenAI-compatible vision-capable endpoint for bill/receipt
        image extraction (scanned PDFs and JPG/PNG). Optional — leave blank to disable image
        extraction; digital PDFs still extract via the text LLM above.
      </div>
      <table class="edit-table" style="background:transparent">
        <tbody>
          <tr>
            <td style="white-space:nowrap">Vision endpoint URL</td>
            <td><input type="text" id="ai-vision-endpoint" style="width:400px"
                placeholder="https://api.openai.com or http://127.0.0.1:8080"
                onchange="markDirty('ai')"></td>
          </tr>
          <tr>
            <td style="white-space:nowrap">Vision model</td>
            <td><input type="text" id="ai-vision-model" style="width:300px"
                placeholder="gpt-4o-mini" onchange="markDirty('ai')"></td>
          </tr>
          <tr>
            <td style="white-space:nowrap">Vision API key</td>
            <td><input type="password" id="ai-vision-key" style="width:400px"
                placeholder="(optional — leave blank to reuse the LLM API key)"
                onchange="markDirty('ai')"></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div style="padding:12px 18px">
      <button class="btn-sm" onclick="saveAiSettings()" style="font-size:10pt">Save AI settings</button>
      <span id="ai-save-msg" style="margin-left:8px;font-size:9pt"></span>
    </div>
  </div>

  <!-- OPENING BALANCES TAB — relocated to a standalone page (opening-balance-
       flattened-spec). The bespoke in-tab grid was removed; this tab now just
       links to /:company/opening-balances, the one-time migration page. -->
  <div id="tab-opening-balances" class="tab-panel">
    <div class="info-box" style="max-width:560px">
      Opening balances are entered on a dedicated migration page. It posts under the reserved <strong>OPEN</strong> journal and <strong>OPEN</strong> period (create both first under the Journals and Periods tabs).
      <div style="margin-top:14px">
        <a class="btn-primary" style="display:inline-block;padding:10px 24px;background:#1a1a1a;color:#fff;border-radius:4px;font-size:11pt;font-weight:600;text-decoration:none"
           href="/${company}/opening-balances">Open Opening Balances →</a>
      </div>
    </div>
  </div>
</div>

<script>
var COMPANY = '${company}';
var CF_OPTS = ['','Cash','Op-WC','Operating','Tax','Investing','Financing','NonCash','Excluded'];
var VAT_NAMES = { SG:'GST', SE:'VAT' };

// ========== DIRTY STATE MANAGER (all tabs) ==========
var dirtyTabs = new Set();
var tabLoaded = {};
function markDirty(tab) {
  dirtyTabs.add(tab);
  var btn = document.getElementById('btn-save-' + tab);
  if (btn) btn.disabled = false;
}
function resetDirty(tab) {
  dirtyTabs.delete(tab);
  var btn = document.getElementById('btn-save-' + tab);
  if (btn) btn.disabled = true;
}

// settings-ux-spec §7 item 9 + fx-automation-spec §1: relevance flags gate
// whole Settings tabs. vat_registered=false hides Tax Codes (and with it the
// VAT Tolerance panel); fx_tracking='off' hides Exchange Rates. Tabs stay in
// the DOM (display:none) so showTab's index math is unaffected; h/l skips them
// via common.js. If the active tab becomes hidden, fall back to Company.
function applyRelevanceFlags(c) {
  var vatOn = !c || c.vat_registered !== false; // default: show while unknown
  var fxOn = !c || c.fx_tracking !== 'off';
  var vatTab = document.getElementById('tab-vat-label');
  var fxTab = document.getElementById('tab-fxrates-label');
  if (vatTab) vatTab.style.display = vatOn ? '' : 'none';
  if (fxTab) fxTab.style.display = fxOn ? '' : 'none';
  var active = document.querySelector('.tab-panel.active');
  if (active && ((active.id === 'tab-vat' && !vatOn) || (active.id === 'tab-fxrates' && !fxOn))) {
    showTab('company');
  }
}

function showTab(t) {
  // Relevance-flag gate (settings-ux-spec §7 item 9 + fx-automation-spec §1):
  // hidden tabs are not navigable — h/l already skips them (common.js), this
  // guards programmatic/direct calls.
  var labelEl = document.getElementById(t === 'vat' ? 'tab-vat-label' : (t === 'fxrates' ? 'tab-fxrates-label' : ''));
  if (labelEl && labelEl.style.display === 'none') return;
  var cur = document.querySelector('.tab-panel.active');
  var curTab = cur ? cur.id.replace('tab-','') : '';
  if (curTab && curTab !== t) {
    // Modal doctrine (docs/settings-ux-spec.md §4): dirty rows in ANY FB.list
    // tab route through the Save/Discard/Stay modal. Buffers are page-global,
    // so the guard fires when leaving ANY tab.
    if (window.FB && FB.list && FB.list.anyDirty()) {
      FB.list.guard(function(){ showTab(t); });
      return;
    }
    if (dirtyTabs.has(curTab)) {
      if (!confirm('You have unsaved changes. Discard?')) return;
      resetDirty(curTab);
    }
  }
  var tabs = ['company','coa','vat','journals','fxrates','ai','opening-balances'];
  document.querySelectorAll('.tab').forEach(function(el,i){ el.classList.toggle('active', tabs[i]===t); });
  document.querySelectorAll('.tab-panel').forEach(function(el){ el.classList.remove('active'); });
  document.getElementById('tab-'+t).classList.add('active');
  // Sidebar hints: migrated tabs render their FB.keys binding table (cannot drift);
  // unmigrated tabs show no hints.
  var hintEl = document.getElementById('sb-hints');
  if (hintEl) {
    if (t === 'company') renderCompanyHints();
    else if (t === 'coa') renderCoaHints();
    else if (t === 'vat') renderVatHints();
    else if (t === 'journals') renderJournalHints();
    else if (t === 'fxrates') FB.keys.renderHints('settings-fxrates', hintEl, { layout: 'list' });
    else if (t === 'opening-balances') renderOpeningBalancesHints();
    else hintEl.innerHTML = '';
  }
  if (!tabLoaded[t]) {
    tabLoaded[t] = true;
    if (t === 'company')  { loadCompanyAttrs(); }
    if (t === 'coa')      { loadCoa(); }
    if (t === 'vat')      { loadVat(); }
    if (t === 'journals') { loadJournals(); }
    if (t === 'fxrates')  { loadFxRates(); loadBaseCurrencies(); }
    if (t === 'ai')       { loadAiSettings(); }
    // opening-balances tab is now a static link — no lazy load needed.
  }
}

function showMsg(id, msg, isErr) {
  // The ONE status channel (2026-07-23): the topbar slot via FB.status.
  // Per-screen spans retired; never auto-dismisses — a message stays until
  // the next one replaces it. The id arg is accepted for back-compat.
  if (window.FB && FB.status) FB.status.show(msg, isErr);
}

function wireDirty(tr, tab) {
  var els = tr.querySelectorAll('input,select');
  els.forEach(function(el){
    var prev = el.oninput;
    el.oninput = function(e){ if (prev) prev.call(this, e); markDirty(tab); };
    var prevC = el.onchange;
    el.onchange = function(e){ if (prevC) prevC.call(this, e); markDirty(tab); };
  });
}

// ========== PERIODS — REMOVED 2026-08-04 (IA-spec step 4, §5.10) ==========
// The periods grid promoted to the top-level Periods section
// (/:company/periods). Its FB.list config lifted into pages/periods-grid.js
// (shared module — one definition, no drift). Nothing here references
// periodsList any longer.

// ========== COMPANY ATTRIBUTES — FB.list (settings-ux-spec §7 item 1 rev. 3) ==========
// One FIXED row per company attribute: canAdd false, no delete — every row is
// critical. The server owns the attribute registry (company.attr.list returns
// labels, display strings and per-row editor shapes); the client renders what
// it is given. Only the Value cell edits — the editor type comes from the row
// (column editor fn, fb-list rev 2026-07-27). w writes ONE attribute via
// company.attr.save — validation is server-authoritative (Magnus: these are
// highly sensitive settings; front-end checks are advisory only). Company ID
// is a read-only row (editable false). The danger zone stays an action below.
var companyAttrs = FB.list.create({
  keysId: 'settings-company',
  active: function() { var p = document.getElementById('tab-company'); return !!(p && p.classList.contains('active')); },
  tbody: 'company-attrs-body',
  companyId: function() { return COMPANY; },
  canAdd: false,
  hint: 'Fixed rows — one per company attribute. Only the Value cell edits (i); w writes one attribute, u reverts, Esc cancels. Validation happens on the server at write time. FX API Key: a blank edit keeps the stored key.',
  columns: [
    { field: 'label', type: 'text', width: 190, ro: 'always', label: 'Attribute',
      display: function(v) { return '<span style="font-weight:600">' + esc(v) + '</span>'; } },
    { field: 'value', type: 'text', width: 300, label: 'Value',
      display: function(v, d) {
        if (!d._dirty) return esc(d.display != null ? String(d.display) : '');
        // Dirty preview: render the buffer value in the row's own terms.
        var ed = d.editor || {};
        if (ed.type === 'checkbox') return v ? 'Yes' : 'No';
        if (ed.type === 'select') {
          var opts = ed.options || [];
          for (var i = 0; i < opts.length; i++) {
            var o = opts[i], ov = (typeof o === 'string') ? o : o.value;
            if (ov === v) return esc((typeof o === 'string') ? (o || '- none -') : o.label);
          }
          return esc(String(v));
        }
        if (ed.type === 'number') {
          return d._key === 'vat_tolerance_pct' ? esc(Number(v).toFixed(2) + '%') : esc(String(Number(v)));
        }
        return (v !== '' && v != null) ? esc(String(v)) : '<span class="pe-ro">—</span>';
      },
      editor: function(d) { return d.editor || { type: 'text' }; } },
    { field: 'type_label', type: 'text', width: 70, ro: 'always', label: 'Type', filterType: null,
      display: function(v) { return '<span class="pe-ro">' + esc(v) + '</span>'; } }
  ],
  editable: function(d) { return !d.readonly; },
  same: function(b, s) { return b.value === s.value; },
  validate: function() { return null; }, // server-authoritative (settings-ux-spec §7 item 1 rev. 3)
  firstField: function() { return 'value'; },
  track: 'company-attr',
  list: { action: 'company.attr.list',
    map: function(r) { return { label: r.label, value: r.value, display: r.display, type_label: r.type, editor: r.editor, readonly: !!r.readonly, _key: r.key }; } },
  save: { action: 'company.attr.save',
    body: function(d) { return { key: d._key, value: d.value }; },
    focusKey: function(d) { return d._key; } },
  onChrome: function(dirty) {
    var dot = document.getElementById('tab-dot-company');
    if (dot) dot.style.display = dirty ? '' : 'none';
    if (dirty) markDirty('company'); else resetDirty('company');
  },
  onLoaded: function(rows) {
    // Side-effects the rest of the page reads from the current company:
    // relevance flags gate whole tabs; the VAT tab label follows the
    // jurisdiction; the FX register lists rates for the base currency; the
    // danger zone addresses the company by name.
    var byKey = {};
    rows.forEach(function(r) { byKey[r._key] = r; });
    window._companyCurrency = byKey.currency ? byKey.currency.value : '';
    applyRelevanceFlags({
      vat_registered: byKey.vat_registered ? !!byKey.vat_registered.value : true,
      fx_tracking: (byKey.multi_currency && byKey.multi_currency.value === false) ? 'off' : 'auto'
    });
    if (byKey.jurisdiction && byKey.jurisdiction.value) {
      var vn = VAT_NAMES[byKey.jurisdiction.value] || 'Tax';
      var lbl = document.getElementById('tab-vat-label');
      // Preserve the dirty-dot span (textContent would wipe it).
      if (lbl) lbl.innerHTML = vn + ' Codes<span id="tab-dot-vat" style="display:none;color:#d97706"> ●</span>';
    }
    companyDanger.setCompany(
      byKey.company_id ? byKey.company_id.value : COMPANY,
      byKey.company_name ? byKey.company_name.value : COMPANY
    );
  }
});

function loadCompanyAttrs(focusKey) { return companyAttrs.load(focusKey); }
function renderCompanyHints() {
  var el = document.getElementById('sb-hints');
  if (el) companyAttrs.renderHints(el);
}

// ========== COMPANY DANGER ZONE (delete) ==========
// Action, not a grid row. Routes the CURRENT company through company.delete;
// the styled fb-modal surfaces the irreversibility confirmation and, on
// INVALID_STATE, the server's explanatory message (last-company / posted-books
// refusals). Identity comes from the attribute grid's onLoaded.
var companyDanger = (function () {
  var current = { id: null, name: '' };

  function setCompany(id, name) { current = { id: id, name: name }; }

  // K2: FB.modal type-to-confirm (keyboard-ux-spec §7) — an exact company-name
  // match arms the danger button; Enter inside the input activates it; the
  // button carries NO letter key (deliberate friction); Esc/backdrop cancel.
  function confirmDelete() {
    if (!current.id) { showMsg('msg-company', 'No company loaded', true); return; }
    var name = current.name || current.id;
    FB.modal.open({
      title: 'Delete "' + name + '"?',
      body: 'This will permanently delete the company and all of its books (accounts, periods, journals, bills, settings, …). <strong>This cannot be undone.</strong>',
      typeConfirm: { match: name, label: 'Type the company name (' + name + ') to confirm' },
      buttons: [
        { label: 'Delete company', danger: true, requiresConfirm: true, onClick: function (api) { doDelete(api); } },
        { label: 'Cancel', onClick: function (api) { api.close(); } }
      ]
    });
  }

  function doDelete(api) {
    var confirmBtn = api.btn(0);
    var cancelBtn = api.btn(1);
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Deleting…'; }
    if (cancelBtn) cancelBtn.disabled = true;
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'company.delete', companyId: current.id }) })
      .then(function (r){ return r.json(); })
      .then(function (res){
        var d = res.data || res;
        if (res.error || d.error) {
          // Surface the server's message inside the modal (last-company /
          // posted-books refusals explain themselves). Re-enable the buttons
          // so the user can dismiss or retry.
          var errText = (res.error && res.error.message) || res.error || (d.error && d.error.message) || d.error;
          api.error(String(errText));
          if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Delete company'; }
          if (cancelBtn) cancelBtn.disabled = false;
          return;
        }
        var remaining = (d && Array.isArray(d.remaining)) ? d.remaining : [];
        var next = remaining[0];
        api.close();
        if (next) {
          // Switch the active company and redirect to the survivor's settings.
          try { localStorage.setItem('freebooks_company', next); } catch (e) {}
          window.location.href = '/' + next + '/settings';
        } else {
          // No survivors — shouldn't happen (server refuses the last company),
          // but degrade gracefully back to the new-company page.
          window.location.href = '/setup/new-company';
        }
      })
      .catch(function (e){
        api.error(e.message);
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Delete company'; }
        if (cancelBtn) cancelBtn.disabled = false;
      });
  }

  return { setCompany: setCompany, confirmDelete: confirmDelete };
})();

// ========== COA — FB.list (P3 consolidated) ==========
var CF_CATS_COA = ['','Cash','Op-WC','Operating','Tax','Investing','Financing','NonCash','Excluded'];
var ACCT_TYPES = ['Asset','Liability','Equity','Revenue','Expense','Closing'];
var SUBTYPES = ['','Cash and Equivalents','Cost of Goods Sold','Cost of Revenue','Current Assets','Current Liabilities','Depreciation','Equity','Financial Assets','Financial Items','Intangible Assets','Net Result','Non-current Assets','Non-current Liabilities','Operating Expenses','Other Income','Personnel Costs','Revenue','Tangible Assets','Tax'];

var coaList = FB.list.create({
  keysId: 'settings-coa',
  active: function() { var p = document.getElementById('tab-coa'); return !!(p && p.classList.contains('active')); },
  tbody: 'coa-body',
  companyId: function() { return COMPANY; },
  columns: [
    { field: 'account_code', type: 'text', width: 80, ro: 'saved' },
    { field: 'account_name', type: 'text', width: 200 },
    { field: 'account_type', type: 'select', width: 90, options: ACCT_TYPES, filterType: 'list' },
    { field: 'account_subtype', type: 'select', width: 140, options: SUBTYPES, nullable: true, filterType: 'list' },
    { field: 'cf_category', type: 'select', width: 100, options: CF_CATS_COA, nullable: true, filterType: 'list' },
    { field: 'is_active', type: 'checkbox', align: 'center',
      display: function(v) { return v ? 'Yes' : 'No'; } },
    { field: 'default_role', type: 'select', width: 70, nullable: true, align: 'center',
      options: ['', 'AP', 'Expense'],
      display: function(v) { return v ? v : '—'; } },
    { field: 'effective_from', type: 'date', width: 100, filterType: 'date' }
  ],
  blank: function() { return { account_code: '', account_name: '', account_type: 'Asset', account_subtype: null, cf_category: null, is_active: true, default_role: null, effective_from: '' }; },
  isBlank: function(b) { return !b.account_code && !b.account_name; },
  same: function(b, s) {
    return b.account_name === s.account_name && b.account_type === s.account_type
      && (b.account_subtype || null) === (s.account_subtype || null)
      && (b.cf_category || null) === (s.cf_category || null)
      && b.is_active === !!s.is_active
      && (b.default_role || null) === (s.default_role || null)
      && (b.effective_from || '') === (s.effective_from || '');
  },
  validate: function(d) { return (d.account_code && d.account_name && d.account_type) ? null : 'Code, name and type required'; },
  firstField: function(isNew) { return isNew ? 'account_code' : 'account_name'; },
  track: 'account',
  filter: function(a, q) {
    q = q.toLowerCase();
    return (a.account_code || '').toLowerCase().indexOf(q) >= 0 || (a.account_name || '').toLowerCase().indexOf(q) >= 0;
  },
  list: { url: function() { return '/api/' + COMPANY + '/accounts'; },
    map: function(a) { return { account_code: a.account_code, account_name: a.account_name, account_type: a.account_type, account_subtype: a.account_subtype || null, cf_category: a.cf_category || null, is_active: a.is_active === true, default_role: a.default_role || null, effective_from: (a.effective_from || '').toString().slice(0, 10), _key: a.account_code }; } },
  save: { action: 'coa.upsert',
    body: function(d) { return { account: { account_code: d.account_code, account_name: d.account_name, account_type: d.account_type, account_subtype: d.account_subtype || null, cf_category: d.cf_category || null, is_active: !!d.is_active, default_role: d.default_role || null, effective_from: d.effective_from || null } }; },
    focusKey: function(d) { return d._isNew ? d.account_code : d._key; } },
  del: { action: 'coa.delete',
    body: function(d) { return { accountCode: d._key }; },
    confirm: function(d) { return 'Delete account "' + d.account_code + '"? This will fail if the account has transactions.'; } },
  onChrome: function(dirty) {
    var dot = document.getElementById('tab-dot-coa');
    if (dot) dot.style.display = dirty ? '' : 'none';
    if (dirty) markDirty('coa'); else resetDirty('coa');
  }
});

function loadCoa(focusKey) { coaList.load(focusKey); }
function renderCoaHints() {
  var el = document.getElementById('sb-hints');
  if (el) coaList.renderHints(el);
}

// ========== VAT/GST CODES — FB.list (P3 consolidated) ==========
var vatList = FB.list.create({
  keysId: 'settings-vat',
  active: function() { var p = document.getElementById('tab-vat'); return !!(p && p.classList.contains('active')); },
  tbody: 'vat-body',
  companyId: function() { return COMPANY; },
  columns: [
    { field: 'vat_code', type: 'text', width: 60, ro: 'saved' },
    { field: 'description', type: 'text', width: 160 },
    { field: 'rate', type: 'number', step: '0.01', width: 55, filterType: 'amount' },
    { field: 'input_account', type: 'text', width: 70 },
    { field: 'output_account', type: 'text', width: 70 },
    { field: 'report_box', type: 'text', width: 50 },
    { field: 'is_reverse_charge', type: 'checkbox', align: 'center',
      display: function(v) { return v ? 'Yes' : 'No'; } },
    { field: 'is_active', type: 'checkbox', align: 'center',
      display: function(v) { return v ? 'Yes' : 'No'; } }
  ],
  blank: function() { return { vat_code: '', description: '', rate: 0, input_account: '', output_account: '', report_box: '', is_reverse_charge: false, is_active: true }; },
  isBlank: function(b) { return !b.vat_code && !b.description && !b.input_account && !b.output_account; },
  same: function(b, s) {
    return b.description === (s.description || '') && b.rate === (s.rate || 0)
      && b.input_account === (s.input_account || '') && b.output_account === (s.output_account || '')
      && b.report_box === (s.report_box || '') && b.is_reverse_charge === !!s.is_reverse_charge && b.is_active === !!s.is_active;
  },
  validate: function(d) { return d.vat_code ? null : 'VAT code required'; },
  firstField: function(isNew) { return isNew ? 'vat_code' : 'description'; },
  track: 'tax-code',
  list: { url: function() { return '/api/' + COMPANY + '/vat-codes'; },
    map: function(v) { return { vat_code: v.vat_code, description: v.description || '', rate: v.rate || 0, input_account: v.input_account || v.vat_account_input || '', output_account: v.output_account || v.vat_account_output || '', report_box: v.report_box || '', is_reverse_charge: !!v.is_reverse_charge, is_active: !!v.is_active, _key: v.vat_code }; } },
  save: { action: 'vat.codes.upsert',
    body: function(d) { return { vatCode: { vat_code: d._isNew ? d.vat_code : d._key, description: d.description || null, rate: d.rate || 0, input_account: d.input_account || null, output_account: d.output_account || null, report_box: d.report_box || null, is_reverse_charge: !!d.is_reverse_charge, is_active: !!d.is_active } }; },
    focusKey: function(d) { return d._isNew ? d.vat_code : d._key; } },
  del: { action: 'vat.codes.delete',
    body: function(d) { return { vatCode: d._key }; },
    confirm: function(d) { return 'Delete VAT code "' + d.vat_code + '"?'; } },
  onChrome: function(dirty) {
    var dot = document.getElementById('tab-dot-vat');
    if (dot) dot.style.display = dirty ? '' : 'none';
    if (dirty) markDirty('vat'); else resetDirty('vat');
  }
});

function loadVat(focusKey) { vatList.load(focusKey); }
function renderVatHints() {
  var el = document.getElementById('sb-hints');
  if (el) vatList.renderHints(el);
}

// ========== JOURNALS — FB.list (P3 consolidated) ==========
var journalsList = FB.list.create({
  keysId: 'settings-journals',
  active: function() { var p = document.getElementById('tab-journals'); return !!(p && p.classList.contains('active')); },
  tbody: 'journals-body',
  companyId: function() { return COMPANY; },
  hint: 'Journal codes appear in the reference sequence (e.g. MISC/2026/0001). Codes should be short uppercase strings.',
  columns: [
    { field: 'code', type: 'text', width: 70, ro: 'saved', uppercase: true },
    { field: 'name', type: 'text', width: 180 },
    { field: 'active', type: 'checkbox', align: 'center',
      display: function(v) { return v ? 'Yes' : 'No'; } }
  ],
  blank: function() { return { code: '', name: '', active: true }; },
  isBlank: function(b) { return !b.code && !b.name; },
  same: function(b, s) { return b.name === s.name && b.active === !!s.active; },
  validate: function(d) { return (d.code && d.name) ? null : 'Code and name required'; },
  firstField: function(isNew) { return isNew ? 'code' : 'name'; },
  track: 'journal-type',
  list: { action: 'journals.list',
    map: function(j) { return { journal_id: j.journal_id, code: j.code || '', name: j.name || '', active: !!j.active, _key: j.journal_id }; } },
  save: { action: 'journals.save',
    body: function(d) { return { journal: { journal_id: d._isNew ? null : d._key, code: d.code, name: d.name, active: !!d.active } }; },
    focusKey: function(d, res) { return d._isNew ? (res.journalId || d.code) : d._key; } },
  del: { action: 'journals.delete',
    body: function(d) { return { journalId: d._key }; },
    confirm: function(d) { return 'Deactivate journal "' + d.code + '"? (soft delete — existing references preserved)'; } },
  onChrome: function(dirty) {
    var dot = document.getElementById('tab-dot-journals');
    if (dot) dot.style.display = dirty ? '' : 'none';
    if (dirty) markDirty('journals'); else resetDirty('journals');
  }
});

function loadJournals(focusKey) { journalsList.load(focusKey); }
function renderJournalHints() {
  var el = document.getElementById('sb-hints');
  if (el) journalsList.renderHints(el);
}



// ========== EXCHANGE RATES — FB.list (P3 consolidated) ==========
// One register like every other: rows stage via the add row or edit in place,
// w writes. Any user write flips the row's source to 'manual' (2026-07-23 —
// ECB rows are no longer read-only; the legacy bulk Save Rates button is gone).
var fxList = FB.list.create({
  keysId: 'settings-fxrates',
  active: function() { var p = document.getElementById('tab-fxrates'); return !!(p && p.classList.contains('active')); },
  tbody: 'fx-rates-body',
  companyId: function() { return COMPANY; },
  columns: [
    { field: 'date', type: 'date', width: 120, filterType: 'date' },
    { field: 'from_currency', type: 'text', width: 60, uppercase: true, attach: attachCcyDd, filterType: 'list' },
    { field: 'to_currency', type: 'text', width: 60, uppercase: true, attach: attachCcyDd, filterType: 'list' },
    { field: 'rate', type: 'number', step: '0.000001', width: 100,
      display: function(v) { return (v !== null && v !== undefined && v !== '') ? Number(v).toFixed(6) : '<span class="pe-ro">—</span>'; }, filterType: 'amount' },
    { field: 'source', ro: 'always', filterType: 'list' }
  ],
  blank: function() { return { date: new Date().toISOString().slice(0, 10), from_currency: '', to_currency: '', rate: '', source: 'manual' }; },
  isBlank: function(b) { return !b.from_currency && !b.to_currency && !b.rate; },
  same: function(b, s) {
    return String(b.date) === String(s.date) && b.from_currency === s.from_currency
      && b.to_currency === s.to_currency && Number(b.rate) === Number(s.rate);
  },
  // All rows editable + deletable like every other register. A user write
  // flips the row's source to 'manual': the client sends the ORIGINAL saved
  // key (date|from|to|source) and the server replaces that row, so editing an
  // ECB row converts it instead of duplicating it.
  validate: function(d) {
    if (!d.date || !d.from_currency || !d.to_currency) return 'Date, from and to required';
    if (!(Number(d.rate) > 0)) return 'Rate must be greater than 0';
    return null;
  },
  firstField: function() { return 'from_currency'; },
  track: 'fx-rate',
  actions: [
    { key: 'f', label: '📡 Fetch Rates', handler: function (api) { fetchFromEcb(); } }
  ],
  list: { action: 'fx.rates.list',
    body: function() { var c = window._companyCurrency || ''; return c ? { baseCurrency: c } : {}; },
    map: function(r) { return { date: r.date ? String(r.date).slice(0, 10) : '', from_currency: r.from_currency || '', to_currency: r.to_currency || '', rate: Number(r.rate), source: r.source || 'manual', _key: String(r.date).slice(0, 10) + '|' + r.from_currency + '|' + r.to_currency + '|' + (r.source || 'manual') }; } },
  save: { action: 'fx.rates.save',
    body: function(d) {
      var r = { date: d.date, from_currency: d.from_currency, to_currency: d.to_currency, rate: Number(d.rate) };
      if (!d._isNew && d._key) {
        var p = String(d._key).split('|'); // original saved key: date|from|to|source
        if (p.length === 4) r.original = { date: p[0], from_currency: p[1], to_currency: p[2], source: p[3] };
      }
      return { rates: [r] };
    },
    focusKey: function(d) { return d._key; } },
  del: { action: 'fx.rates.delete',
    body: function(d) { return { date: d.date, from_currency: d.from_currency, to_currency: d.to_currency, source: d.source }; },
    confirm: function() { return 'Delete this rate?'; } }
});

function loadBaseCurrencies() {
  // Update the display of current company's base currency
  var compCcy = window._companyCurrency || '';
  var displayEl = document.getElementById('current-base-currency');
  if (displayEl && compCcy) {
    displayEl.textContent = 'Base currency: ' + compCcy;
  }
}

function loadFxRates() { fxList.load().then(loadBaseCurrencies); }


function fetchFromEcb() {
  var baseCcy = window._companyCurrency || '';
  if (!baseCcy) { showMsg('msg-fxrates', 'Please set company currency first', true); return; }
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'fx.fetch_rates', companyId: COMPANY, baseCurrency: baseCcy }) })
    .then(function(r){ return r.json(); }).then(function(r){
      if (r.error || (r.data && r.data.error)) {
        showMsg('msg-fxrates', r.error || r.data.error, true);
      } else {
        showMsg('msg-fxrates', 'Fetched ' + (r.data.rateCount || 0) + ' rates from ' + (r.data.provider || 'provider'), false);
        loadFxRates();
      }
    }).catch(function(e){ showMsg('msg-fxrates', e.message, true); });
}

function saveFxRates() {
  // Legacy bulk-save removed 2026-07-23 (one save path: w). Kept as a thin
  // shim so any stale onclick cannot ReferenceError; the button itself is gone.
  fxList.writeAllDirty();
}

// ========== CURRENCY LIST (FB.dropdown source) ==========
var currencyList = [];
function loadCurrencyList() {
  fetch('/db/currencies.json')
    .then(function(r){ return r.json(); })
    .then(function(currencies){ currencyList = currencies; })
    .catch(function(e){ console.error('Failed to load currencies:', e); });
}

function attachCcyDd(input) {
  if (!input || !window.FB || !FB.dropdown) return;
  FB.dropdown.attach(input, {
    keys: true,
    source: function (q) {
      q = (q || '').toLowerCase();
      return currencyList.filter(function (c) {
        return c.code.toLowerCase().indexOf(q) >= 0 || (c.name || '').toLowerCase().indexOf(q) >= 0;
      }).map(function (c) { return { primary: c.code, secondary: c.name, data: c }; });
    },
    onPick: function (it, inp) {
      inp.value = it.primary;
      inp.dispatchEvent(new Event('input', { bubbles: true })); // light row-save affordances
    }
  });
}

// ========== FX PROVIDER PANEL — removed (settings-ux-spec §7 item 5 rev. 3) ==========
// Provider + API key are per-company rows on the Company attribute grid
// ('manual' = no auto-download). The install-level read-first panel that lived
// here is deleted; fx.providers.list / fx.provider.get|save remain available
// as actions (per-company since fx-automation-spec rev. 3).


// ========== DEFAULT ACCOUNTS — removed (settings-ux-spec §7 item 1) ==========
// Default AP/Expense accounts are now managed per-row on the COA tab via the
// account-level default_role flag (server-side single-holder enforcement).
// The legacy "Default Accounts (current company)" panel, loadDefaultAccounts(),
// and saveDefaultAccounts() have been removed from the Company tab.


// ========== VAT TOLERANCE PANEL — removed (settings-ux-spec §7 item 1 rev. 3) ==========
// Tolerance lives on the Company attribute grid as two typed Number rows
// (flat + %, % edited as a percentage and stored as a fraction — the storage
// semantics bills.js has always read). The read-first panel that sat above
// this register is deleted.

// ========== OPENING BALANCES (relocated from standalone route 2026-07-28) =========
// ========== OPENING BALANCES TAB — now a link to the standalone page =========
// (opening-balance-flattened-spec) The bespoke in-tab grid was removed; the
// tab panel now just links to /:company/opening-balances. No JS needed here.
function renderOpeningBalancesHints() {
  var el = document.getElementById('sb-hints');
  if (el) el.innerHTML = '';
}


// ========== UNSAVED CHANGES PROTECTION ==========
window.onbeforeunload = function(e) {
  if (dirtyTabs.size > 0) {
    var msg = 'You have unsaved changes.';
    e.returnValue = msg;
    return msg;
  }
};


// ========== AI TAB (B9 spec) =========
var _aiSettingsLoaded = false;
function loadAiSettings() {
  if (_aiSettingsLoaded) return;
  _aiSettingsLoaded = true;
  fetch('/api', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({action:'settings.get', companyId:CURRENT_COMPANY, userEmail:CURRENT_USER})
  }).then(function(r){ return r.json(); }).then(function(r){
    if (!r.ok) return;
    var s = r.data || {};
    document.getElementById('ai-agent-enabled').checked = s.agent_enabled === 'true';
    document.getElementById('ai-poll-interval').value = s.agent_poll_interval_ms || '30000';
    document.getElementById('ai-inbox-path').value = s.agent_inbox_path || '';
    document.getElementById('ai-llm-endpoint').value = s.llm_endpoint_url || '';
    document.getElementById('ai-llm-key').value = s.llm_api_key || '';
    document.getElementById('ai-llm-model').value = s.llm_model || '';
    document.getElementById('ai-llm-temp').value = s.llm_temperature || '0.1';
    document.getElementById('ai-vision-endpoint').value = s.llm_vision_endpoint_url || '';
    document.getElementById('ai-vision-model').value   = s.llm_vision_model || '';
    document.getElementById('ai-vision-key').value    = s.llm_vision_api_key || '';
    // Agent status
    fetch('/api', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({action:'agent.status', companyId:CURRENT_COMPANY, userEmail:CURRENT_USER})
    }).then(function(r){ return r.json(); }).then(function(r){
      var el = document.getElementById('ai-agent-status');
      if (r.ok && r.data) {
        el.textContent = r.data.running ? 'Running' : 'Stopped';
        el.style.color = r.data.running ? '#16a34a' : '#666';
      } else {
        el.textContent = 'Stopped'; el.style.color = '#666';
      }
    }).catch(function(){
      var el = document.getElementById('ai-agent-status');
      el.textContent = 'Stopped'; el.style.color = '#666';
    });
  }).catch(function(e){ showMsg('ai', 'Failed to load AI settings', true); });
}

function saveAiSettings() {
  var settings = {
    agent_enabled: document.getElementById('ai-agent-enabled').checked ? 'true' : 'false',
    agent_poll_interval_ms: document.getElementById('ai-poll-interval').value,
    agent_inbox_path: document.getElementById('ai-inbox-path').value,
    llm_endpoint_url: document.getElementById('ai-llm-endpoint').value,
    llm_api_key: document.getElementById('ai-llm-key').value,
    llm_model: document.getElementById('ai-llm-model').value,
    llm_temperature: document.getElementById('ai-llm-temp').value,
    llm_vision_endpoint_url: document.getElementById('ai-vision-endpoint').value,
    llm_vision_model:        document.getElementById('ai-vision-model').value,
    llm_vision_api_key:      document.getElementById('ai-vision-key').value,
  };
  fetch('/api', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({action:'settings.save', companyId:CURRENT_COMPANY, userEmail:CURRENT_USER, settings:settings})
  }).then(function(r){ return r.json(); }).then(function(r){
    var el = document.getElementById('ai-save-msg');
    if (r.ok) { el.textContent = '✓ Saved'; el.style.color = '#16a34a'; resetDirty('ai'); }
    else { el.textContent = '✗ ' + (r.error?.message || 'Save failed'); el.style.color = '#dc2626'; }
  }).catch(function(e){
    var el = document.getElementById('ai-save-msg');
    el.textContent = '✗ Network error'; el.style.color = '#dc2626';
  });
}

function testLLM() {
  var el = document.getElementById('ai-test-result');
  el.textContent = 'Testing…'; el.style.color = '#666';
  fetch('/api', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      action:'settings.ai.test', companyId:CURRENT_COMPANY, userEmail:CURRENT_USER,
      endpoint_url: document.getElementById('ai-llm-endpoint').value,
      api_key: document.getElementById('ai-llm-key').value,
      model: document.getElementById('ai-llm-model').value,
    })
  }).then(function(r){ return r.json(); }).then(function(r){
    if (r.ok && r.data && r.data.ok) {
      el.textContent = '✓ OK (' + r.data.latency_ms + 'ms)'; el.style.color = '#16a34a';
    } else {
      el.textContent = '✗ ' + (r.data?.error || r.error?.message || 'Failed'); el.style.color = '#dc2626';
    }
  }).catch(function(e){
    el.textContent = '✗ Network error'; el.style.color = '#dc2626';
  });
}

// ========== HANDLE ?tab= URL PARAM ==========
(function() {
  var params = new URLSearchParams(window.location.search);
  var tab = params.get('tab');
  loadCurrencyList();
  // Load the attribute grid EAGERLY even when ?tab= deep-links elsewhere:
  // relevance flags (VAT tab / Exchange Rates tab visibility) are derived from
  // its rows, so they must resolve before any tab renders.
  tabLoaded['company'] = true;
  loadCompanyAttrs();
  showTab(tab || 'company');
})();
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleSettingsPage };
