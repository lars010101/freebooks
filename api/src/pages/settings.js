'use strict';
const { makeQuery, commonStyle, navBar, layoutEnd } = require('./common');

async function handleSettingsPage(req, res) {
  const { company } = req.params;
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
  table.edit-table th { text-align:left; font-size:9pt; text-transform:uppercase; color:#555; border-bottom:1px solid #ccc; padding:6px 6px; }
  table.edit-table td { padding:4px 4px; border-bottom:1px solid #f0f0f0; vertical-align:middle; }
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
  /* Periods modal-edit doctrine (docs/settings-ux-spec.md) */
  #tab-periods tbody td, #tab-coa tbody td, #tab-vat tbody td, #tab-journals tbody td { cursor:text; }
  tr.row-dirty > td:first-child { box-shadow: inset 3px 0 0 #d97706; }
  .dirty-val { color:#b45309; }
  tr.row-editing > td { background:#fffbeb; }
  .row-actions { white-space:nowrap; text-align:right; }
  .chip { cursor:pointer; padding:2px 8px; border:1px solid #ccc; border-radius:3px; font-size:10pt; user-select:none; }
  .chip:hover { background:#f0f0f0; }
  .chip-ok { color:#2a8a2a; border-color:#2a8a2a; }
  .chip-cancel { color:#cc2222; border-color:#cc2222; }
  .pe-ro { color:#888; }
  .fb-modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.35); display:flex; align-items:center; justify-content:center; z-index:1000; }
  .fb-modal { background:#fff; border-radius:6px; padding:20px 24px; min-width:340px; box-shadow:0 8px 30px rgba(0,0,0,0.18); }
  .fb-modal-title { font-weight:600; margin-bottom:8px; }
  .fb-modal-body { font-size:10pt; color:#555; margin-bottom:14px; }
  .fb-modal-err { color:#cc2222; font-size:10pt; margin-bottom:8px; }
  .fb-modal-btns { display:flex; gap:10px; justify-content:flex-end; }
</style>
</head>
<body>${navBar(company, 'settings')}
<div class="page">
  <div class="header">
    <h1>⚙ Settings</h1>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="showTab('company')">Company</div>
    <div class="tab" onclick="showTab('periods')">Periods<span id="tab-dot-periods" style="display:none;color:#d97706"> ●</span></div>
    <div class="tab" onclick="showTab('coa')">Chart of Accounts<span id="tab-dot-coa" style="display:none;color:#d97706"> ●</span></div>
    <div class="tab" id="tab-vat-label" onclick="showTab('vat')">Tax Codes<span id="tab-dot-vat" style="display:none;color:#d97706"> ●</span></div>
    <div class="tab" onclick="showTab('journals')">Journals<span id="tab-dot-journals" style="display:none;color:#d97706"> ●</span></div>
    <div class="tab" onclick="showTab('fxrates')">Exchange Rates</div>
  </div>

  <!-- PERIODS TAB -->
  <div id="tab-periods" class="tab-panel">
    <table class="edit-table" id="periods-table">
      <thead><tr><th>Period Name</th><th>Start Date</th><th>End Date</th><th>Locked</th><th></th></tr></thead>
      <tbody id="periods-body"></tbody>
    </table>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
      <span id="msg-periods" class="msg" style="font-size:0.8125rem"></span>
    </div>
  </div>

  <!-- COMPANY TAB -->
  <div id="tab-company" class="tab-panel active">
    <table class="edit-table" id="company-table">
      <thead><tr>
        <th>Company ID</th>
        <th>Company Name</th>
        <th style="width:70px">Currency</th>
        <th style="width:60px">Jur.</th>
        <th>Tax ID</th>
        <th>Std.</th>
        <th style="text-align:center">VAT</th>
        <th>FX Acct</th>
        <th></th>
      </tr></thead>
      <tbody id="company-body"></tbody>
    </table>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
      <span id="msg-company" class="msg" style="font-size:0.8125rem"></span>
    </div>

    <!-- Default accounts for this company (used as fallbacks on new bills) -->
    <div style="margin-top:24px;padding:14px 16px;background:#f8f9fa;border-radius:6px;border:1px solid #e0e0e0">
      <div style="font-weight:600;margin-bottom:4px">Default Accounts (current company)</div>
      <div style="font-size:9pt;color:#666;margin-bottom:12px">Used as fallbacks when creating new bills. Vendor-specific defaults still take precedence; leave blank for no default.</div>
      <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end">
        <div class="field-row" style="margin-bottom:0">
          <label for="default-ap-account">Default AP Account</label>
          <input type="text" id="default-ap-account" placeholder="account code" style="max-width:200px">
        </div>
        <div class="field-row" style="margin-bottom:0">
          <label for="default-expense-account">Default Expense Account</label>
          <input type="text" id="default-expense-account" placeholder="account code" style="max-width:200px">
        </div>
        <button class="btn-sm" id="btn-save-default-accounts" onclick="saveDefaultAccounts()">Save Defaults</button>
        <span id="msg-default-accounts" class="msg" style="margin-left:8px"></span>
      </div>
    </div>

    <!-- VAT tolerance for supplier-stated VAT override (current company) -->
    <div style="margin-top:16px;padding:14px 16px;background:#f8f9fa;border-radius:6px;border:1px solid #e0e0e0">
      <div style="font-weight:600;margin-bottom:4px">VAT Tolerance (current company)</div>
      <div style="font-size:9pt;color:#666;margin-bottom:12px">When a supplier-stated VAT amount differs from the computed value, the override is accepted (with a warning) when |stated − computed| ≤ max(flat, % × computed). The % field is displayed as a percentage (e.g. 1 = 1%).</div>
      <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end">
        <div class="field-row" style="margin-bottom:0">
          <label for="vat-tolerance-flat">VAT Tolerance (flat)</label>
          <input type="number" step="0.01" min="0" id="vat-tolerance-flat" placeholder="0.50" style="max-width:120px">
        </div>
        <div class="field-row" style="margin-bottom:0">
          <label for="vat-tolerance-pct">VAT Tolerance (%)</label>
          <input type="number" step="0.1" min="0" id="vat-tolerance-pct" placeholder="1" style="max-width:120px">
        </div>
        <button class="btn-sm" id="btn-save-vat-tolerance" onclick="saveVatTolerance()">Save Tolerance</button>
        <span id="msg-vat-tolerance" class="msg" style="margin-left:8px"></span>
      </div>
    </div>
  </div>

  <!-- COA TAB -->
  <div id="tab-coa" class="tab-panel">
    <input type="text" class="search-bar" id="coa-search" placeholder="Filter by code or name..." oninput="filterCoa()">
    <table class="edit-table" id="coa-table">
      <thead><tr><th>Code</th><th>Account Name</th><th>Type</th><th>Subtype</th><th>CF Category</th><th>Active</th><th></th></tr></thead>
      <tbody id="coa-body"></tbody>
    </table>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
      <span id="msg-coa" class="msg" style="font-size:0.8125rem"></span>
    </div>
  </div>

  <!-- JOURNALS TAB -->
  <div id="tab-journals" class="tab-panel">
    <table class="edit-table" id="journals-table">
      <thead><tr><th>Code</th><th>Name</th><th style="text-align:center">Active</th><th></th></tr></thead>
      <tbody id="journals-body"></tbody>
    </table>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
      <span id="msg-journals" class="msg" style="font-size:0.8125rem"></span>
    </div>
    <p style="margin-top:8px;font-size:9pt;color:#888">Journal codes appear in the reference sequence (e.g. MISC/2026/0001). Codes should be short uppercase strings.</p>
  </div>

  <!-- VAT/GST CODES TAB -->
  <div id="tab-vat" class="tab-panel">
    <table class="edit-table" id="vat-table">
      <thead><tr><th>Code</th><th>Description</th><th>Rate %</th><th>Input Acct</th><th>Output Acct</th><th>Report Box</th><th style="text-align:center">Rev.Chg</th><th style="text-align:center">Active</th><th></th></tr></thead>
      <tbody id="vat-body"></tbody>
    </table>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
      <span id="msg-vat" class="msg" style="font-size:0.8125rem"></span>
    </div>
    <p style="margin-top:8px;font-size:9pt;color:#888">Saving replaces all codes. Existing journal entry tax tags on transactions are preserved.</p>
  </div>

  <!-- EXCHANGE RATES TAB -->
  <div id="tab-fxrates" class="tab-panel">
    <div style="margin-bottom:16px;padding:12px;background:#f8f9fa;border-radius:6px;border:1px solid #e0e0e0">
      <div style="font-weight:600;margin-bottom:10px">FX Rate Provider</div>
      <div class="field-row">
        <label>Provider</label>
        <select id="fx-provider-select" onchange="onFxProviderChange()" style="max-width:300px"></select>
      </div>
      <div id="fx-provider-desc" style="font-size:9pt;color:#666;margin:6px 0 10px 0"></div>
      <div id="fx-api-key-row" class="field-row" style="display:none">
        <label id="fx-api-key-label">API Key</label>
        <input type="password" id="fx-provider-apikey" placeholder="Enter API key" style="max-width:300px">
      </div>
      <button class="btn-sm" id="btn-save-apikey" onclick="saveApiKey()" style="display:none">Save API Key</button>
      <span id="msg-fx-provider" class="msg" style="margin-left:8px"></span>
    </div>
    <div style="margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="btn-primary" onclick="fetchFromEcb()">📡 Fetch Rates</button>
      <span id="current-base-currency" style="font-size:10pt;color:#666"></span>
    </div>
    <table class="edit-table" id="fx-rates-table">
      <thead><tr><th>Date</th><th>From</th><th>To</th><th style="text-align:right">Rate</th><th>Source</th><th></th></tr></thead>
      <tbody id="fx-rates-body"></tbody>
    </table>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="btn-sm" onclick="addFxRateRow()">+ Add Rate</button>
      <button id="btn-save-fxrates" class="btn-primary" onclick="saveFxRates()">Save Rates</button>
      <span id="msg-fxrates" class="msg"></span>
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

function showTab(t) {
  var cur = document.querySelector('.tab-panel.active');
  var curTab = cur ? cur.id.replace('tab-','') : '';
  if (curTab && curTab !== t) {
    // Modal doctrine (docs/settings-ux-spec.md §4): dirty period rows route
    // through the Save/Discard/Stay modal. Buffers are page-global, so the
    // guard fires when leaving ANY tab, not just Periods.
    if (typeof periodsAnyDirty === 'function' && periodsAnyDirty()) {
      openPeriodLeaveModal(function(){ showTab(t); });
      return;
    }
    if (dirtyTabs.has(curTab)) {
      if (!confirm('You have unsaved changes. Discard?')) return;
      resetDirty(curTab);
    }
  }
  var tabs = ['company','periods','coa','vat','journals','fxrates'];
  document.querySelectorAll('.tab').forEach(function(el,i){ el.classList.toggle('active', tabs[i]===t); });
  document.querySelectorAll('.tab-panel').forEach(function(el){ el.classList.remove('active'); });
  document.getElementById('tab-'+t).classList.add('active');
  // Sidebar hints: migrated tabs render their FB.keys binding table (cannot drift);
  // unmigrated tabs show no hints.
  var hintEl = document.getElementById('sb-hints');
  if (hintEl) {
    if (t === 'periods') renderPeriodHints();
    else if (t === 'coa') renderCoaHints();
    else if (t === 'vat') renderVatHints();
    else if (t === 'journals') renderJournalHints();
    else if (t === 'fxrates') FB.keys.renderHints('settings-fxrates', hintEl, { layout: 'list' });
    else hintEl.innerHTML = '';
  }
  if (!tabLoaded[t]) {
    tabLoaded[t] = true;
    if (t === 'company')  { loadCompanies(); loadDefaultAccounts(); }
    if (t === 'periods')  { loadPeriods(); }
    if (t === 'coa')      { loadCoa(); }
    if (t === 'vat')      { loadVat(); }
    if (t === 'journals') { loadJournals(); }
    if (t === 'fxrates')  { loadFxProviders(); loadFxRates(); loadBaseCurrencies(); }
  }
}

function showMsg(id, msg, isErr) {
  var el = document.getElementById(id);
  el.textContent = msg;
  el.className = 'msg ' + (isErr ? 'err' : 'ok');
  if (!isErr) setTimeout(function(){ el.textContent = ''; }, 3000);
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

// ========== PERIODS ==========
// ========== PERIODS — modal edit doctrine (docs/settings-ux-spec.md) ==========
// Read-first rows. Esc never saves: it exits edit mode leaving a dirty buffer;
// w writes, u reverts. Period names are immutable on saved rows (server upsert
// keys on period_name — rename needs delete+create; a deliberate feature later).
var periodsSaved = [];          // last-saved rows from the server
var periodsDirty = {};          // key → { period_name, start_date, end_date, locked, isNew }
var periodGhostN = 0;           // new-row key counter
var periodEditIdx = -1;         // row index currently in edit mode (-1 = none)
var periodNav = null;

function periodRows() { return Array.from(document.querySelectorAll('#periods-body tr:not(.fb-ghost-row)')); }

// Merged view: saved rows overlaid with their dirty buffers, then dirty ghosts.
function periodMerged() {
  var out = periodsSaved.map(function(p) {
    var d = periodsDirty[p.period_id];
    if (d) return { period_id: p.period_id, period_name: d.period_name, start_date: d.start_date, end_date: d.end_date, locked: d.locked, _dirty: true, _key: p.period_id, _isNew: false };
    return { period_id: p.period_id, period_name: p.period_name, start_date: p.start_date, end_date: p.end_date, locked: p.locked, _dirty: false, _key: p.period_id, _isNew: false };
  });
  Object.keys(periodsDirty).forEach(function(k) {
    var d = periodsDirty[k];
    // P2 pinned-top: new (unsaved) rows lead the list, directly under the ghost row.
    if (d && d.isNew) out.unshift({ period_id: '', period_name: d.period_name, start_date: d.start_date, end_date: d.end_date, locked: d.locked, _dirty: true, _key: k, _isNew: true });
  });
  return out;
}

function periodsAnyDirty() { return periodEditIdx >= 0 || Object.keys(periodsDirty).length > 0; }

function syncPeriodsChrome() {
  var dirty = periodsAnyDirty();
  var dot = document.getElementById('tab-dot-periods');
  if (dot) dot.style.display = dirty ? '' : 'none';
  if (dirty) markDirty('periods'); else resetDirty('periods');
}

function validatePeriodBuf(d) {
  if (!d.period_name || !d.start_date || !d.end_date) return 'Name, start and end required';
  if (d.start_date > d.end_date) return 'Start date must be on or before end date';
  return null;
}

function renderPeriods(focusKey) {
  var tbody = document.getElementById('periods-body');
  if (!tbody) return;
  var merged = periodMerged();
  // P2: ghost row pinned-top — the single create affordance (o / click).
  var ghostHtml = '<tr class="fb-ghost-row" style="cursor:text"><td colspan="5" class="fb-ghost-cell">+ New period <kbd>o</kbd></td></tr>';
  tbody.innerHTML = ghostHtml + merged.map(function(p, i) {
    var name = p.period_name ? esc(p.period_name) : '<span class="pe-ro">—</span>';
    var start = p.start_date ? esc(FB.util.fmtDate(p.start_date)) : '<span class="pe-ro">—</span>';
    var end = p.end_date ? esc(FB.util.fmtDate(p.end_date)) : '<span class="pe-ro">—</span>';
    if (p._dirty) {
      name = '<span class="dirty-val">' + name + '</span>';
      start = '<span class="dirty-val">' + start + '</span>';
      end = '<span class="dirty-val">' + end + '</span>';
    }
    var actions = p._dirty
      ? '<a class="chip chip-ok" title="write (w)" onclick="event.stopPropagation();writePeriodRowAt(' + i + ')">✓</a> <a class="chip chip-cancel" title="revert (u)" onclick="event.stopPropagation();revertPeriodRowAt(' + i + ')">✕</a>'
      : '';
    return '<tr' + (p._dirty ? ' class="row-dirty"' : '') + ' data-idx="' + i + '" data-key="' + esc(p._key) + '">'
      + '<td data-field="name">' + name + '</td>'
      + '<td data-field="start">' + start + '</td>'
      + '<td data-field="end">' + end + '</td>'
      + '<td data-field="locked" style="text-align:center"><input type="checkbox" disabled' + (p.locked ? ' checked' : '') + '></td>'
      + '<td class="row-actions">' + actions + '</td></tr>';
  }).join('');
  Array.from(tbody.querySelectorAll('tr:not(.fb-ghost-row)')).forEach(function(tr) {
    tr.addEventListener('click', function(e) {
      if (periodNav) periodNav.set(tr);
      var td = e.target.closest('td');
      if (!td || td.classList.contains('row-actions')) return;
      enterPeriodEdit(+tr.dataset.idx, td.dataset.field || undefined);
    });
  });
  var ghost = tbody.querySelector('.fb-ghost-row');
  if (ghost) ghost.addEventListener('click', function() { newPeriodRow(); });
  if (periodNav) {
    var target = focusKey != null ? tbody.querySelector('tr[data-key="' + focusKey + '"]') : null;
    periodNav.set(target || periodRows()[0] || null);
  }
}

function enterPeriodEdit(idx, field) {
  if (periodEditIdx === idx) return;
  if (periodEditIdx >= 0) exitPeriodEdit(); // click-away: exit, dirty buffer kept
  var d = periodMerged()[idx];
  var tr = periodRows()[idx];
  if (!d || !tr) return;
  periodEditIdx = idx;
  var nameHtml = d._isNew
    ? '<input type="text" class="pe-name" value="' + esc(d.period_name || '') + '" style="width:110px">'
    : '<span class="pe-ro">' + esc(d.period_name) + '</span>';
  tr.innerHTML = '<td data-field="name">' + nameHtml + '</td>'
    + '<td data-field="start"><input type="date" class="pe-start" value="' + esc(d.start_date || '') + '"></td>'
    + '<td data-field="end"><input type="date" class="pe-end" value="' + esc(d.end_date || '') + '"></td>'
    + '<td data-field="locked" style="text-align:center"><input type="checkbox" class="pe-locked"' + (d.locked ? ' checked' : '') + '></td>'
    + '<td class="row-actions">'
    + '<a class="chip chip-ok" title="write (w)" onclick="event.stopPropagation();writePeriodRowAt(' + idx + ')">✓</a> '
    + '<a class="chip chip-cancel" title="exit (Esc)" onclick="event.stopPropagation();exitPeriodEdit()">✕</a></td>';
  tr.classList.add('row-editing');
  if (window.FB && FB.mode) FB.mode.set('INSERT');
  window.fbEditActive = true;
  var sel = { name: '.pe-name', start: '.pe-start', end: '.pe-end', locked: '.pe-locked' }[field]
    || (d._isNew ? '.pe-name' : '.pe-start');
  var target = tr.querySelector(sel) || tr.querySelector('input');
  if (target) { target.focus(); if (target.select) target.select(); }
  syncPeriodsChrome();
}

function exitPeriodEdit() {
  if (periodEditIdx < 0) return;
  var d = periodMerged()[periodEditIdx];
  var tr = periodRows()[periodEditIdx];
  if (d && tr) {
    var nameIn = tr.querySelector('.pe-name');
    var start = tr.querySelector('.pe-start').value;
    var end = tr.querySelector('.pe-end').value;
    var locked = tr.querySelector('.pe-locked').checked;
    if (d._isNew) {
      var name = nameIn ? nameIn.value.trim() : '';
      if (name || start || end || locked) {
        periodsDirty[d._key] = { period_name: name, start_date: start, end_date: end, locked: locked, isNew: true };
      } else {
        delete periodsDirty[d._key]; // untouched new row vanishes — nothing from nothing
      }
    } else {
      var saved = null;
      for (var i = 0; i < periodsSaved.length; i++) if (periodsSaved[i].period_id === d._key) saved = periodsSaved[i];
      var same = saved && start === saved.start_date && end === saved.end_date && locked === !!saved.locked;
      if (same) delete periodsDirty[d._key]; // restored saved values — not dirty
      else periodsDirty[d._key] = { period_name: saved ? saved.period_name : d._key, start_date: start, end_date: end, locked: locked, isNew: false };
    }
  }
  var key = d ? d._key : null;
  periodEditIdx = -1;
  if (window.FB && FB.mode) FB.mode.set('NORMAL');
  window.fbEditActive = false;
  renderPeriods(key);
  syncPeriodsChrome();
}

function writePeriodRowAt(idx) {
  if (periodEditIdx >= 0) exitPeriodEdit(); // ✓ chip from edit mode = Esc then w
  var d = periodMerged()[idx];
  if (!d || !d._dirty) return;
  var err = validatePeriodBuf(d);
  if (err) { showMsg('msg-periods', err, true); return; }
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'period.upsert', companyId: COMPANY,
      period: { period_id: d._isNew ? d.period_name : d._key, period_name: d.period_name, start_date: d.start_date, end_date: d.end_date, locked: !!d.locked } }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var dd = res.data || res;
      if (dd.error || res.error) { showMsg('msg-periods', dd.error || res.error, true); return; } // stays dirty, values intact
      delete periodsDirty[d._key];
      showMsg('msg-periods', 'Saved', false);
      loadPeriods(d._isNew ? d.period_name : d._key);
    })
    .catch(function(e){ showMsg('msg-periods', e.message, true); });
}

function revertPeriodRowAt(idx) {
  if (periodEditIdx >= 0) exitPeriodEdit();
  var d = periodMerged()[idx];
  if (!d || !d._dirty) return;
  delete periodsDirty[d._key];
  renderPeriods(d._isNew ? null : d._key);
  syncPeriodsChrome();
}

function focusedPeriodIdx() {
  var tr = periodNav && periodNav.current();
  return tr ? +tr.dataset.idx : -1;
}
function focusedPeriodDirty() {
  var idx = focusedPeriodIdx();
  var d = idx >= 0 ? periodMerged()[idx] : null;
  return !!(d && d._dirty);
}
function editFocusedPeriod() { var idx = focusedPeriodIdx(); enterPeriodEdit(idx >= 0 ? idx : 0); }
function writeFocusedPeriod() { var idx = focusedPeriodIdx(); if (idx >= 0) writePeriodRowAt(idx); }
function revertFocusedPeriod() { var idx = focusedPeriodIdx(); if (idx >= 0) revertPeriodRowAt(idx); }

function deleteFocusedPeriod() {
  var idx = focusedPeriodIdx();
  if (idx < 0) return;
  var d = periodMerged()[idx];
  if (!d) return;
  if (d._isNew) { delete periodsDirty[d._key]; renderPeriods(); syncPeriodsChrome(); return; }
  if (!confirm('Delete period "' + d.period_name + '"?')) return;
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'period.delete', companyId: COMPANY, periodId: d._key }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var dd = res.data || res;
      if (dd.error || res.error) { showMsg('msg-periods', dd.error || res.error, true); return; } // INVALID_STATE shown verbatim
      delete periodsDirty[d._key];
      loadPeriods();
    })
    .catch(function(e){ showMsg('msg-periods', e.message, true); });
}

function newPeriodRow() {
  if (periodEditIdx >= 0) exitPeriodEdit();
  var key = '_new_' + (++periodGhostN);
  periodsDirty[key] = { period_name: '', start_date: '', end_date: '', locked: false, isNew: true };
  renderPeriods(key);
  enterPeriodEdit(0, 'name'); // new rows unshift to index 0 (pinned-top)
  if (window.FB && FB.track) FB.track.create('period');
}

// Edit-mode field movement: Enter/Tab/Shift+Tab move, sticky at ends — never save.
function advancePeriodField() {
  var tr = periodRows()[periodEditIdx];
  if (!tr) return;
  var inputs = Array.from(tr.querySelectorAll('input'));
  var i = inputs.indexOf(document.activeElement);
  if (i >= 0 && i < inputs.length - 1) { inputs[i + 1].focus(); if (inputs[i + 1].select) inputs[i + 1].select(); }
}
function periodTabSticky(e) {
  var tr = periodRows()[periodEditIdx];
  if (!tr) return false;
  var inputs = Array.from(tr.querySelectorAll('input'));
  if (!inputs.length) return false;
  var i = inputs.indexOf(document.activeElement);
  return e.shiftKey ? i === 0 : i === inputs.length - 1;
}

// Save/Discard/Stay leave modal (spec §4).
function closePeriodLeaveModal() {
  var ov = document.getElementById('period-leave-overlay');
  if (ov) ov.remove();
}
function openPeriodLeaveModal(proceed) {
  closePeriodLeaveModal();
  var ov = document.createElement('div');
  ov.id = 'period-leave-overlay';
  ov.className = 'fb-modal-overlay';
  ov.innerHTML = '<div class="fb-modal">'
    + '<div class="fb-modal-title">Unsaved changes</div>'
    + '<div class="fb-modal-body">Period rows have unsaved changes.</div>'
    + '<div class="fb-modal-err" id="period-leave-err"></div>'
    + '<div class="fb-modal-btns">'
    + '<button class="btn-sm danger" id="pl-discard">Discard</button>'
    + '<button class="btn-sm" id="pl-stay">Stay</button>'
    + '<button class="btn-primary" id="pl-save">Save</button>'
    + '</div></div>';
  ov.addEventListener('click', function(e){ if (e.target === ov) closePeriodLeaveModal(); });
  document.body.appendChild(ov);
  document.getElementById('pl-stay').onclick = closePeriodLeaveModal;
  document.getElementById('pl-discard').onclick = function() {
    if (periodEditIdx >= 0) { periodEditIdx = -1; if (window.FB && FB.mode) FB.mode.set('NORMAL'); window.fbEditActive = false; }
    periodsDirty = {};
    renderPeriods();
    syncPeriodsChrome();
    closePeriodLeaveModal();
    proceed();
  };
  document.getElementById('pl-save').onclick = function() {
    if (periodEditIdx >= 0) exitPeriodEdit();
    var keys = Object.keys(periodsDirty);
    if (!keys.length) { closePeriodLeaveModal(); proceed(); return; }
    var errEl = document.getElementById('period-leave-err');
    var chain = Promise.resolve();
    var failed = null;
    keys.forEach(function(k) {
      chain = chain.then(function() {
        if (failed) return;
        var d = periodsDirty[k];
        if (!d) return;
        var verr = validatePeriodBuf(d);
        if (verr) { failed = verr; return; }
        return fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'period.upsert', companyId: COMPANY,
            period: { period_id: d.isNew ? d.period_name : k, period_name: d.period_name, start_date: d.start_date, end_date: d.end_date, locked: !!d.locked } }) })
          .then(function(r){ return r.json(); })
          .then(function(res){ var dd = res.data || res; if (dd.error || res.error) failed = dd.error || res.error; })
          .catch(function(e){ failed = e.message; });
      });
    });
    chain.then(function() {
      if (failed) { if (errEl) errEl.textContent = failed; return; } // modal stays open
      periodsDirty = {};
      syncPeriodsChrome();
      closePeriodLeaveModal();
      loadPeriods();
      proceed();
    });
  };
}

function renderPeriodHints() {
  var el = document.getElementById('sb-hints');
  if (!el || !(window.FB && FB.keys)) return;
  FB.keys.renderHints('settings-periods', el, { layout: 'list' });
}

function loadPeriods(focusKey) {
  var tbody = document.getElementById('periods-body');
  if (!tbody) return;
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'period.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var rows = res.data || res;
      periodsSaved = (Array.isArray(rows) ? rows : []).map(function(p){
        return { period_id: p.period_id, period_name: p.period_id, start_date: String(p.start_date || '').slice(0, 10), end_date: String(p.end_date || '').slice(0, 10), locked: !!p.locked };
      });
      renderPeriods(focusKey);
      syncPeriodsChrome();
    })
    .catch(function(e){ console.error('loadPeriods:', e); });
}

// Leave-veto for {/} page navigation (common.js consults this before fbNavigate).
window.fbBeforeTabSwitch = function(href) {
  if (!periodsAnyDirty()) return true;
  openPeriodLeaveModal(function(){ fbNavigate(href); });
  return false;
};

// Sidebar link clicks get the same treatment — mouse parity for {/}.
document.addEventListener('click', function(e) {
  var a = e.target && e.target.closest ? e.target.closest('.sb-nav a[href]') : null;
  if (!a) return;
  if (periodsAnyDirty()) {
    e.preventDefault();
    e.stopPropagation();
    openPeriodLeaveModal(function(){ fbNavigate(a.getAttribute('href')); });
  }
}, true);

// Register immediately — fb-core.js loads in <head> (see commonStyle()), so FB.keys
// is already present. Under fbNavigate soft-nav this inline script re-executes after
// DOMContentLoaded has already fired, so a DOMContentLoaded listener would never run
// and j/k bindings would silently die on the second visit (repro: Settings →
// Payables → Settings → l → j dead). Guard against double-registration via
// FB.keys.unregister before re-registering.
(function() {
  if (!(window.FB && FB.keys)) return;
  periodNav = FB.nav.create({ rows: periodRows, focusClass: 'nav-row-focus' });
  if (FB.keys.unregister) FB.keys.unregister('settings-periods');
  FB.keys.register('settings-periods', {
    active: function() { var p = document.getElementById('tab-periods'); return !!(p && p.classList.contains('active')); },
    getMode: function() { return periodEditIdx >= 0 ? 'INSERT' : 'NORMAL'; },
    bindings: [
      { key: 'j', mode: 'NORMAL', hint: 'navigate', hintBar: true, run: function() { periodNav.move(1); } },
      { key: 'k', mode: 'NORMAL', hint: 'navigate', hintBar: true, run: function() { periodNav.move(-1); } },
      { key: 'i', mode: 'NORMAL', hint: 'edit', hintBar: true, run: editFocusedPeriod },
      { key: 'Enter', mode: 'NORMAL', hint: 'edit', hintBar: true, run: editFocusedPeriod },
      { key: 'o', mode: 'NORMAL', hint: 'new row', hintBar: true, run: newPeriodRow },
      { key: 'x', mode: 'NORMAL', hint: 'delete', hintBar: true, run: deleteFocusedPeriod },
      { key: 'w', mode: 'NORMAL', hint: 'write', hintBar: true, when: focusedPeriodDirty, run: writeFocusedPeriod },
      { key: 'u', mode: 'NORMAL', hint: 'revert', hintBar: true, when: focusedPeriodDirty, run: revertFocusedPeriod },
      { key: 'Escape', mode: 'INSERT', hint: 'exit edit', hintBar: true, run: exitPeriodEdit },
      { key: 'Enter', mode: 'INSERT', run: advancePeriodField },
      { key: 'Tab', mode: 'INSERT', when: periodTabSticky, run: function() {} },
      { key: 'Tab', mode: 'INSERT', swallow: false, preventDefault: false, run: function() {} }
    ]
  });
})();

// ========== COMPANY ==========
var companiesData = [];

function addCompanyRow(co, isNew) {
  isNew = isNew || false;
  co = co || {};
  var tr = document.createElement('tr');
  tr.dataset.companyId = isNew ? '' : (co.company_id || '');
  tr.dataset.isNew = isNew ? '1' : '0';

  var idCell = isNew
    ? '<input type="text" value="" style="width:110px" placeholder="e.g. myco_sg">'
    : '<span class="ro">' + (co.company_id || '') + '</span>';

  tr.innerHTML = '<td>' + idCell + '</td>'
    + '<td><input type="text" value="' + (co.company_name || '').replace(/"/g, '&quot;') + '" style="width:160px"></td>'
    + '<td><input type="text" class="co-ccy" value="' + (co.base_currency || co.currency || '') + '" maxlength="3" style="width:60px" oninput="this.value=this.value.toUpperCase()"></td>'
    + '<td><input type="text" value="' + (co.jurisdiction || '') + '" maxlength="10" style="width:55px"></td>'
    + '<td><input type="text" value="' + (co.tax_id || '').replace(/"/g, '&quot;') + '" style="width:120px"></td>'
    + '<td><input type="text" value="' + (co.reporting_standard || '').replace(/"/g, '&quot;') + '" style="width:80px"></td>'
    + '<td style="text-align:center"><input type="checkbox"' + (co.vat_registered ? ' checked' : '') + '></td>'
    + '<td><input type="text" value="' + (co.fx_gain_loss_account || '').replace(/"/g, '&quot;') + '" style="width:80px" placeholder="account code"></td>'
    + '<td style="white-space:nowrap;text-align:right"></td>';

  var saveBtn = document.createElement('button');
  saveBtn.className = 'btn-sm';
  saveBtn.innerHTML = '\u{1F4BE}';
  saveBtn.title = 'Save';
  saveBtn.style.cssText = 'opacity:' + (isNew ? '1' : '0.35') + ';margin-right:4px';
  saveBtn.onclick = function () { saveCompanyRow(tr); };

  var delBtn = document.createElement('button');
  delBtn.className = 'btn-sm danger';
  delBtn.innerHTML = '\u2715';
  delBtn.title = 'Delete';
  delBtn.onclick = function () { deleteCompanyRow(tr); };

  tr.cells[tr.cells.length - 1].appendChild(saveBtn);
  tr.cells[tr.cells.length - 1].appendChild(delBtn);

  tr.querySelectorAll('input').forEach(function (el) {
    el.addEventListener('input', function () {
      saveBtn.style.opacity = '1';
      if (isNew && el === tr.cells[0].querySelector('input') && el.value.trim()) {
        appendBlankCompanyRow();
      }
    });
    el.addEventListener('change', function () { saveBtn.style.opacity = '1'; });
  });

  document.getElementById('company-body').appendChild(tr);
  attachCcyDd(tr.querySelector('.co-ccy'));
  return tr;
}

function appendBlankCompanyRow() {
  var tbody = document.getElementById('company-body');
  var rows = tbody ? tbody.querySelectorAll('tr') : [];
  if (rows.length > 0) {
    var li = rows[rows.length - 1].cells[0].querySelector('input');
    if (li && !li.value.trim()) return;
  }
  addCompanyRow({}, true);
}

function saveCompanyRow(tr) {
  var isNew = tr.dataset.isNew === '1';
  var idEl = tr.cells[0].querySelector('input,span.ro');
  var companyId = (idEl && idEl.value !== undefined ? idEl.value : idEl.textContent).trim();
  if (!companyId) { showMsg('msg-company', 'Company ID required', true); return; }

  var inputs = tr.querySelectorAll('input[type=text]');
  var cb = tr.querySelector('input[type=checkbox]');

  // inputs[0]=id(new only), [1]=name, [2]=currency, [3]=jurisdiction, [4]=taxid, [5]=std, [6]=fxacct
  var nameVal       = inputs[1] ? inputs[1].value.trim() : '';
  var currencyVal   = inputs[2] ? inputs[2].value.trim().toUpperCase() : '';
  var jurisdicVal   = inputs[3] ? inputs[3].value.trim() : '';
  var taxIdVal      = inputs[4] ? inputs[4].value.trim() : '';
  var stdVal        = inputs[5] ? inputs[5].value.trim() : '';
  var fxAcctVal     = inputs[6] ? inputs[6].value.trim() : '';

  if (!nameVal) { showMsg('msg-company', 'Company name required', true); return; }

  var saveBtn = tr.querySelector('button.btn-sm:not(.danger)');
  if (saveBtn) { saveBtn.innerHTML = '\u23F3'; saveBtn.disabled = true; }

  var co = {
    company_id: isNew ? companyId : tr.dataset.companyId,
    company_name: nameVal,
    base_currency: currencyVal,
    jurisdiction: jurisdicVal,
    tax_id: taxIdVal,
    reporting_standard: stdVal,
    vat_registered: cb ? cb.checked : false
  };

  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'company.save', companyId: isNew ? companyId : tr.dataset.companyId, companies: [co] }) })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      var d = res.data || res;
      var m = document.getElementById('msg-company');
      if (res.error || d.error) {
        if (m) { m.textContent = res.error || d.error; m.className = 'msg err'; }
        if (saveBtn) { saveBtn.innerHTML = '\u{1F4BE}'; saveBtn.disabled = false; }
      } else {
        tr.dataset.companyId = companyId;
        tr.dataset.isNew = '0';
        // If new, replace id input with ro span
        if (isNew) {
          var idInput = tr.cells[0].querySelector('input');
          if (idInput) {
            var span = document.createElement('span');
            span.className = 'ro';
            span.textContent = companyId;
            idInput.replaceWith(span);
          }
        }
        // Save FX settings separately
        if (fxAcctVal !== '') {
          fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'settings.save', companyId: companyId, settings: { fx_gain_loss_account: fxAcctVal } }) })
            .catch(function (e) { console.error('FX settings save failed:', e); });
        }
        if (saveBtn) {
          saveBtn.innerHTML = '\u2713';
          saveBtn.style.opacity = '0.35';
          saveBtn.disabled = false;
          setTimeout(function () { saveBtn.innerHTML = '\u{1F4BE}'; }, 1500);
        }
        if (m) { m.textContent = 'Saved'; m.className = 'msg ok'; setTimeout(function () { m.textContent = ''; }, 2000); }
        // Update VAT tab label if editing current company
        if (companyId === COMPANY && jurisdicVal) {
          var vn = VAT_NAMES[jurisdicVal] || 'Tax';
          document.getElementById('tab-vat-label').textContent = vn + ' Codes';
        }
        // Store base currency for FX tab
        if (companyId === COMPANY) {
          window._companyCurrency = currencyVal;
        }
      }
    })
    .catch(function (e) {
      showMsg('msg-company', e.message, true);
      if (saveBtn) { saveBtn.innerHTML = '\u{1F4BE}'; saveBtn.disabled = false; }
    });
}

function deleteCompanyRow(tr) {
  var companyId = tr.dataset.companyId;
  if (!companyId) { tr.remove(); appendBlankCompanyRow(); return; }
  if (companyId === COMPANY) { showMsg('msg-company', 'Cannot delete the active company', true); return; }
  if (!confirm('Delete company "' + companyId + '"? This cannot be undone.')) return;
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'company.delete', companyId: companyId }) })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      var d = res.data || res;
      if (res.error || d.error) {
        showMsg('msg-company', res.error || d.error, true);
      } else {
        tr.remove();
        appendBlankCompanyRow();
      }
    })
    .catch(function (e) { showMsg('msg-company', e.message, true); });
}

function loadCompanies() {
  var tbody = document.getElementById('company-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'company.list', companyId: COMPANY }) })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      var rows = (res && res.data) ? res.data : (Array.isArray(res) ? res : []);
      companiesData = rows;
      rows.forEach(function (co) { addCompanyRow(co, false); });
      appendBlankCompanyRow();
      // Set VAT tab label and currency from current company
      var cur = rows.find(function (c) { return c.company_id === COMPANY; });
      if (cur) {
        if (cur.jurisdiction) {
          var vn = VAT_NAMES[cur.jurisdiction] || 'Tax';
          document.getElementById('tab-vat-label').textContent = vn + ' Codes';
        }
        window._companyCurrency = cur.base_currency || cur.currency || '';
      }
      // Load FX gain/loss account for each company row
      rows.forEach(function (co, idx) {
        fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'settings.get', companyId: co.company_id }) })
          .then(function (r) { return r.json(); })
          .then(function (r2) {
            var s = r2.data || r2;
            var fxAcct = s.fx_gain_loss_account || '';
            if (fxAcct) {
              var trs = document.getElementById('company-body').querySelectorAll('tr');
              var matchTr = Array.from(trs).find(function (t) { return t.dataset.companyId === co.company_id; });
              if (matchTr) {
                var fxInput = matchTr.querySelectorAll('input[type=text]')[6];
                if (fxInput) fxInput.value = fxAcct;
              }
            }
          }).catch(function () {});
      });
    })
    .catch(function (e) { console.error('loadCompanies:', e); });
}

// ========== COA — modal edit doctrine (docs/settings-ux-spec.md) ==========
var coaSaved = [];
var coaDirty = {};
var coaGhostN = 0;
var coaEditIdx = -1;
var coaNav = null;
var coaFilterQ = '';
var SUBTYPES = ['','Current Asset','Non-Current Asset','Current Liability','Non-Current Liability','Equity','Revenue','COGS','Operating Expense','Non-Operating Expense','Closing'];
var CF_CATS_COA = ['','Cash','Op-WC','Operating','Tax','Investing','Financing','NonCash','Excluded'];
var ACCT_TYPES = ['Asset','Liability','Equity','Revenue','Expense','Closing'];

function coaRows() { return Array.from(document.querySelectorAll('#coa-body tr:not(.fb-ghost-row)')); }

function coaMerged() {
  var out = coaSaved.map(function(a) {
    var d = coaDirty[a.account_code];
    if (d) return { account_code: a.account_code, account_name: d.account_name, account_type: d.account_type, account_subtype: d.account_subtype, cf_category: d.cf_category, is_active: d.is_active, _dirty: true, _key: a.account_code, _isNew: false };
    return { account_code: a.account_code, account_name: a.account_name, account_type: a.account_type, account_subtype: a.account_subtype, cf_category: a.cf_category, is_active: a.is_active, _dirty: false, _key: a.account_code, _isNew: false };
  });
  Object.keys(coaDirty).forEach(function(k) {
    var d = coaDirty[k];
    if (d && d.isNew) out.unshift({ account_code: d.account_code, account_name: d.account_name, account_type: d.account_type, account_subtype: d.account_subtype, cf_category: d.cf_category, is_active: d.is_active, _dirty: true, _key: k, _isNew: true }); // P2 pinned-top
  });
  var q = coaFilterQ.toLowerCase();
  if (q) out = out.filter(function(a){ return (a.account_code||'').toLowerCase().indexOf(q) >= 0 || (a.account_name||'').toLowerCase().indexOf(q) >= 0; });
  return out;
}

function coaAnyDirty() { return coaEditIdx >= 0 || Object.keys(coaDirty).length > 0; }

function syncCoaChrome() {
  var dirty = coaAnyDirty();
  var dot = document.getElementById('tab-dot-coa');
  if (dot) dot.style.display = dirty ? '' : 'none';
  if (dirty) markDirty('coa'); else resetDirty('coa');
}

function validateCoaBuf(d) {
  if (!d.account_code || !d.account_name || !d.account_type) return 'Code, name and type required';
  return null;
}

function renderCoa(focusKey) {
  var tbody = document.getElementById('coa-body');
  if (!tbody) return;
  var merged = coaMerged();
  tbody.innerHTML = '<tr class="fb-ghost-row" style="cursor:text"><td colspan="7" class="fb-ghost-cell">+ New account <kbd>o</kbd></td></tr>' + merged.map(function(a, i) {
    var code = a.account_code ? esc(a.account_code) : '<span class="pe-ro">—</span>';
    var name = a.account_name ? esc(a.account_name) : '<span class="pe-ro">—</span>';
    var type = a.account_type ? esc(a.account_type) : '<span class="pe-ro">—</span>';
    var subtype = a.account_subtype ? esc(a.account_subtype) : '<span class="pe-ro">—</span>';
    var cf = a.cf_category ? esc(a.cf_category) : '<span class="pe-ro">—</span>';
    var active = a.is_active ? 'Yes' : 'No';
    if (a._dirty) {
      code = '<span class="dirty-val">' + code + '</span>';
      name = '<span class="dirty-val">' + name + '</span>';
      type = '<span class="dirty-val">' + type + '</span>';
      subtype = '<span class="dirty-val">' + subtype + '</span>';
      cf = '<span class="dirty-val">' + cf + '</span>';
      active = '<span class="dirty-val">' + active + '</span>';
    }
    var actions = a._dirty
      ? '<a class="chip chip-ok" title="write (w)" onclick="event.stopPropagation();writeCoaRowAt(' + i + ')">✓</a> <a class="chip chip-cancel" title="revert (u)" onclick="event.stopPropagation();revertCoaRowAt(' + i + ')">✕</a>'
      : '';
    return '<tr' + (a._dirty ? ' class="row-dirty"' : '') + ' data-idx="' + i + '" data-key="' + esc(a._key) + '">'
      + '<td data-field="code">' + code + '</td>'
      + '<td data-field="name">' + name + '</td>'
      + '<td data-field="type">' + type + '</td>'
      + '<td data-field="subtype">' + subtype + '</td>'
      + '<td data-field="cf">' + cf + '</td>'
      + '<td data-field="active" style="text-align:center">' + active + '</td>'
      + '<td class="row-actions">' + actions + '</td></tr>';
  }).join('');
  Array.from(tbody.querySelectorAll('tr:not(.fb-ghost-row)')).forEach(function(tr) {
    tr.addEventListener('click', function(e) {
      if (coaNav) coaNav.set(tr);
      var td = e.target.closest('td');
      if (!td || td.classList.contains('row-actions')) return;
      enterCoaEdit(+tr.dataset.idx, td.dataset.field || undefined);
    });
  });
  var coaGhost = tbody.querySelector('.fb-ghost-row');
  if (coaGhost) coaGhost.addEventListener('click', function() { newCoaRow(); });
  if (coaNav) {
    var target = focusKey != null ? tbody.querySelector('tr[data-key="' + focusKey + '"]') : null;
    coaNav.set(target || coaRows()[0] || null);
  }
}

function enterCoaEdit(idx, field) {
  if (coaEditIdx === idx) return;
  if (coaEditIdx >= 0) exitCoaEdit();
  var d = coaMerged()[idx];
  var tr = coaRows()[idx];
  if (!d || !tr) return;
  coaEditIdx = idx;
  var codeHtml = d._isNew
    ? '<input type="text" class="ce-code" value="' + esc(d.account_code || '') + '" style="width:80px">'
    : '<span class="pe-ro">' + esc(d.account_code) + '</span>';
  var typeOpts = ACCT_TYPES.map(function(t){ return '<option value="'+t+'"'+(t===d.account_type?' selected':'')+'>'+t+'</option>'; }).join('');
  var subtypeOpts = SUBTYPES.map(function(s){ return '<option value="'+s+'"'+(s===(d.account_subtype||'')?' selected':'')+'>'+(s||'- none -')+'</option>'; }).join('');
  var cfOpts = CF_CATS_COA.map(function(c){ return '<option value="'+c+'"'+(c===(d.cf_category||'')?' selected':'')+'>'+(c||'- none -')+'</option>'; }).join('');
  tr.innerHTML = '<td data-field="code">' + codeHtml + '</td>'
    + '<td data-field="name"><input type="text" class="ce-name" value="' + esc(d.account_name || '') + '" style="width:200px"></td>'
    + '<td data-field="type"><select class="ce-type" style="width:90px">' + typeOpts + '</select></td>'
    + '<td data-field="subtype"><select class="ce-subtype" style="width:140px">' + subtypeOpts + '</select></td>'
    + '<td data-field="cf"><select class="ce-cf" style="width:100px">' + cfOpts + '</select></td>'
    + '<td data-field="active" style="text-align:center"><input type="checkbox" class="ce-active"' + (d.is_active ? ' checked' : '') + '></td>'
    + '<td class="row-actions">'
    + '<a class="chip chip-ok" title="write (w)" onclick="event.stopPropagation();writeCoaRowAt(' + idx + ')">✓</a> '
    + '<a class="chip chip-cancel" title="exit (Esc)" onclick="event.stopPropagation();exitCoaEdit()">✕</a></td>';
  tr.classList.add('row-editing');
  if (window.FB && FB.mode) FB.mode.set('INSERT');
  window.fbEditActive = true;
  var sel = { code: '.ce-code', name: '.ce-name', type: '.ce-type', subtype: '.ce-subtype', cf: '.ce-cf', active: '.ce-active' }[field]
    || (d._isNew ? '.ce-code' : '.ce-name');
  var target = tr.querySelector(sel) || tr.querySelector('input,select');
  if (target) { target.focus(); if (target.select) target.select(); }
  syncCoaChrome();
}

function exitCoaEdit() {
  if (coaEditIdx < 0) return;
  var d = coaMerged()[coaEditIdx];
  var tr = coaRows()[coaEditIdx];
  if (d && tr) {
    var codeIn = tr.querySelector('.ce-code');
    var name = tr.querySelector('.ce-name').value.trim();
    var type = tr.querySelector('.ce-type').value;
    var subtype = tr.querySelector('.ce-subtype').value || null;
    var cf = tr.querySelector('.ce-cf').value || null;
    var active = tr.querySelector('.ce-active').checked;
    if (d._isNew) {
      var code = codeIn ? codeIn.value.trim() : '';
      if (code || name || type) {
        coaDirty[d._key] = { account_code: code, account_name: name, account_type: type, account_subtype: subtype, cf_category: cf, is_active: active, isNew: true };
      } else {
        delete coaDirty[d._key];
      }
    } else {
      var saved = null;
      for (var i = 0; i < coaSaved.length; i++) if (coaSaved[i].account_code === d._key) saved = coaSaved[i];
      var same = saved && name === saved.account_name && type === saved.account_type
        && (subtype||null) === (saved.account_subtype||null)
        && (cf||null) === (saved.cf_category||null)
        && active === !!saved.is_active;
      if (same) delete coaDirty[d._key];
      else coaDirty[d._key] = { account_code: d._key, account_name: name, account_type: type, account_subtype: subtype, cf_category: cf, is_active: active, isNew: false };
    }
  }
  var key = d ? d._key : null;
  coaEditIdx = -1;
  if (window.FB && FB.mode) FB.mode.set('NORMAL');
  window.fbEditActive = false;
  renderCoa(key);
  syncCoaChrome();
}

function writeCoaRowAt(idx) {
  if (coaEditIdx >= 0) exitCoaEdit();
  var d = coaMerged()[idx];
  if (!d || !d._dirty) return;
  var err = validateCoaBuf(d);
  if (err) { showMsg('msg-coa', err, true); return; }
  var account = { account_code: d.account_code, account_name: d.account_name, account_type: d.account_type, account_subtype: d.account_subtype||null, cf_category: d.cf_category||null, is_active: !!d.is_active };
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'coa.upsert', companyId: COMPANY, account: account }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var dd = res.data||res;
      if (dd.error||res.error) { showMsg('msg-coa', dd.error||res.error, true); return; }
      delete coaDirty[d._key];
      showMsg('msg-coa', 'Saved', false);
      loadCoa(d._isNew ? d.account_code : d._key);
    })
    .catch(function(e){ showMsg('msg-coa', e.message, true); });
}

function revertCoaRowAt(idx) {
  if (coaEditIdx >= 0) exitCoaEdit();
  var d = coaMerged()[idx];
  if (!d || !d._dirty) return;
  delete coaDirty[d._key];
  renderCoa(d._isNew ? null : d._key);
  syncCoaChrome();
}

function focusedCoaIdx() { var tr = coaNav && coaNav.current(); return tr ? +tr.dataset.idx : -1; }
function focusedCoaDirty() { var idx = focusedCoaIdx(); var d = idx >= 0 ? coaMerged()[idx] : null; return !!(d && d._dirty); }
function editFocusedCoa() { var idx = focusedCoaIdx(); enterCoaEdit(idx >= 0 ? idx : 0); }
function writeFocusedCoa() { var idx = focusedCoaIdx(); if (idx >= 0) writeCoaRowAt(idx); }
function revertFocusedCoa() { var idx = focusedCoaIdx(); if (idx >= 0) revertCoaRowAt(idx); }

function deleteFocusedCoa() {
  var idx = focusedCoaIdx();
  if (idx < 0) return;
  var d = coaMerged()[idx];
  if (!d) return;
  if (d._isNew) { delete coaDirty[d._key]; renderCoa(); syncCoaChrome(); return; }
  if (!confirm('Delete account "' + d.account_code + '"? This will fail if the account has transactions.')) return;
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'coa.delete', companyId: COMPANY, accountCode: d._key }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var dd = res.data||res;
      if (dd.error||res.error) { showMsg('msg-coa', dd.error||res.error, true); return; }
      delete coaDirty[d._key];
      loadCoa();
    })
    .catch(function(e){ showMsg('msg-coa', e.message, true); });
}

function newCoaRow() {
  if (coaEditIdx >= 0) exitCoaEdit();
  var key = '_new_' + (++coaGhostN);
  coaDirty[key] = { account_code: '', account_name: '', account_type: 'Asset', account_subtype: null, cf_category: null, is_active: true, isNew: true };
  renderCoa(key);
  enterCoaEdit(0, 'code'); // new rows unshift to index 0 (pinned-top)
  if (window.FB && FB.track) FB.track.create('account');
}

function advanceCoaField() {
  var tr = coaRows()[coaEditIdx];
  if (!tr) return;
  var inputs = Array.from(tr.querySelectorAll('input,select'));
  var i = inputs.indexOf(document.activeElement);
  if (i >= 0 && i < inputs.length - 1) { inputs[i + 1].focus(); if (inputs[i + 1].select) inputs[i + 1].select(); }
}
function coaTabSticky(e) {
  var tr = coaRows()[coaEditIdx];
  if (!tr) return false;
  var inputs = Array.from(tr.querySelectorAll('input,select'));
  if (!inputs.length) return false;
  var i = inputs.indexOf(document.activeElement);
  return e.shiftKey ? i === 0 : i === inputs.length - 1;
}

function renderCoaHints() {
  var el = document.getElementById('sb-hints');
  if (!el || !(window.FB && FB.keys)) return;
  FB.keys.renderHints('settings-coa', el, { layout: 'list' });
}

function loadCoa(focusKey) {
  var tbody = document.getElementById('coa-body');
  if (!tbody) return;
  fetch('/api/' + COMPANY + '/accounts').then(function(r){ return r.json(); }).then(function(rows){
    coaSaved = (Array.isArray(rows) ? rows : []).map(function(a){
      return { account_code: a.account_code, account_name: a.account_name, account_type: a.account_type, account_subtype: a.account_subtype||null, cf_category: a.cf_category||null, is_active: a.is_active === true };
    });
    renderCoa(focusKey);
    syncCoaChrome();
  }).catch(function(e){ console.error('loadCoa:', e); });
}

function filterCoa() {
  var el = document.getElementById('coa-search');
  coaFilterQ = el ? el.value : '';
  if (coaEditIdx >= 0) { coaEditIdx = -1; if (window.FB && FB.mode) FB.mode.set('NORMAL'); window.fbEditActive = false; }
  renderCoa();
  syncCoaChrome();
}

// Register immediately — see Periods IIFE comment for rationale.
(function() {
  if (!(window.FB && FB.keys)) return;
  coaNav = FB.nav.create({ rows: coaRows, focusClass: 'nav-row-focus' });
  if (FB.keys.unregister) FB.keys.unregister('settings-coa');
  FB.keys.register('settings-coa', {
    active: function() { var p = document.getElementById('tab-coa'); return !!(p && p.classList.contains('active')); },
    getMode: function() { return coaEditIdx >= 0 ? 'INSERT' : 'NORMAL'; },
    bindings: [
      { key: 'j', mode: 'NORMAL', hint: 'navigate', hintBar: true, run: function() { coaNav.move(1); } },
      { key: 'k', mode: 'NORMAL', hint: 'navigate', hintBar: true, run: function() { coaNav.move(-1); } },
      { key: 'i', mode: 'NORMAL', hint: 'edit', hintBar: true, run: editFocusedCoa },
      { key: 'Enter', mode: 'NORMAL', hint: 'edit', hintBar: true, run: editFocusedCoa },
      { key: 'o', mode: 'NORMAL', hint: 'new row', hintBar: true, run: newCoaRow },
      { key: 'x', mode: 'NORMAL', hint: 'delete', hintBar: true, run: deleteFocusedCoa },
      { key: 'w', mode: 'NORMAL', hint: 'write', hintBar: true, when: focusedCoaDirty, run: writeFocusedCoa },
      { key: 'u', mode: 'NORMAL', hint: 'revert', hintBar: true, when: focusedCoaDirty, run: revertFocusedCoa },
      { key: 'Escape', mode: 'INSERT', hint: 'exit edit', hintBar: true, run: exitCoaEdit },
      { key: 'Enter', mode: 'INSERT', run: advanceCoaField },
      { key: 'Tab', mode: 'INSERT', when: coaTabSticky, run: function() {} },
      { key: 'Tab', mode: 'INSERT', swallow: false, preventDefault: false, run: function() {} }
    ]
  });
})();

// ========== VAT/GST CODES — modal edit doctrine ==========
var vatSaved = [];
var vatDirty = {};
var vatGhostN = 0;
var vatEditIdx = -1;
var vatNav = null;

function vatRows() { return Array.from(document.querySelectorAll('#vat-body tr:not(.fb-ghost-row)')); }

function vatMerged() {
  var out = vatSaved.map(function(v) {
    var d = vatDirty[v.vat_code];
    if (d) return { vat_code: v.vat_code, description: d.description, rate: d.rate, input_account: d.input_account, output_account: d.output_account, report_box: d.report_box, is_reverse_charge: d.is_reverse_charge, is_active: d.is_active, _dirty: true, _key: v.vat_code, _isNew: false };
    return { vat_code: v.vat_code, description: v.description, rate: v.rate, input_account: v.input_account, output_account: v.output_account, report_box: v.report_box, is_reverse_charge: v.is_reverse_charge, is_active: v.is_active, _dirty: false, _key: v.vat_code, _isNew: false };
  });
  Object.keys(vatDirty).forEach(function(k) {
    var d = vatDirty[k];
    if (d && d.isNew) out.unshift({ vat_code: d.vat_code, description: d.description, rate: d.rate, input_account: d.input_account, output_account: d.output_account, report_box: d.report_box, is_reverse_charge: d.is_reverse_charge, is_active: d.is_active, _dirty: true, _key: k, _isNew: true }); // P2 pinned-top
  });
  return out;
}

function vatAnyDirty() { return vatEditIdx >= 0 || Object.keys(vatDirty).length > 0; }

function syncVatChrome() {
  var dirty = vatAnyDirty();
  var dot = document.getElementById('tab-dot-vat');
  if (dot) dot.style.display = dirty ? '' : 'none';
  if (dirty) markDirty('vat'); else resetDirty('vat');
}

function renderVat(focusKey) {
  var tbody = document.getElementById('vat-body');
  if (!tbody) return;
  var merged = vatMerged();
  tbody.innerHTML = '<tr class="fb-ghost-row" style="cursor:text"><td colspan="9" class="fb-ghost-cell">+ New tax code <kbd>o</kbd></td></tr>' + merged.map(function(v, i) {
    var code = v.vat_code ? esc(v.vat_code) : '<span class="pe-ro">—</span>';
    var desc = v.description ? esc(v.description) : '<span class="pe-ro">—</span>';
    var rate = v.rate != null ? esc(String(v.rate)) : '<span class="pe-ro">—</span>';
    var input = v.input_account ? esc(v.input_account) : '<span class="pe-ro">—</span>';
    var output = v.output_account ? esc(v.output_account) : '<span class="pe-ro">—</span>';
    var rbox = v.report_box ? esc(v.report_box) : '<span class="pe-ro">—</span>';
    if (v._dirty) {
      code = '<span class="dirty-val">' + code + '</span>';
      desc = '<span class="dirty-val">' + desc + '</span>';
      rate = '<span class="dirty-val">' + rate + '</span>';
      input = '<span class="dirty-val">' + input + '</span>';
      output = '<span class="dirty-val">' + output + '</span>';
      rbox = '<span class="dirty-val">' + rbox + '</span>';
    }
    var actions = v._dirty
      ? '<a class="chip chip-ok" title="write (w)" onclick="event.stopPropagation();writeVatRowAt(' + i + ')">✓</a> <a class="chip chip-cancel" title="revert (u)" onclick="event.stopPropagation();revertVatRowAt(' + i + ')">✕</a>'
      : '';
    return '<tr' + (v._dirty ? ' class="row-dirty"' : '') + ' data-idx="' + i + '" data-key="' + esc(v._key) + '">'
      + '<td data-field="code">' + code + '</td>'
      + '<td data-field="desc">' + desc + '</td>'
      + '<td data-field="rate">' + rate + '</td>'
      + '<td data-field="input">' + input + '</td>'
      + '<td data-field="output">' + output + '</td>'
      + '<td data-field="rbox">' + rbox + '</td>'
      + '<td data-field="rc" style="text-align:center">' + (v.is_reverse_charge ? 'Yes' : 'No') + '</td>'
      + '<td data-field="active" style="text-align:center">' + (v.is_active ? 'Yes' : 'No') + '</td>'
      + '<td class="row-actions">' + actions + '</td></tr>';
  }).join('');
  Array.from(tbody.querySelectorAll('tr:not(.fb-ghost-row)')).forEach(function(tr) {
    tr.addEventListener('click', function(e) {
      if (vatNav) vatNav.set(tr);
      var td = e.target.closest('td');
      if (!td || td.classList.contains('row-actions')) return;
      enterVatEdit(+tr.dataset.idx, td.dataset.field || undefined);
    });
  });
  var vatGhost = tbody.querySelector('.fb-ghost-row');
  if (vatGhost) vatGhost.addEventListener('click', function() { newVatRow(); });
  if (vatNav) {
    var target = focusKey != null ? tbody.querySelector('tr[data-key="' + focusKey + '"]') : null;
    vatNav.set(target || vatRows()[0] || null);
  }
}

function enterVatEdit(idx, field) {
  if (vatEditIdx === idx) return;
  if (vatEditIdx >= 0) exitVatEdit();
  var d = vatMerged()[idx];
  var tr = vatRows()[idx];
  if (!d || !tr) return;
  vatEditIdx = idx;
  var codeHtml = d._isNew
    ? '<input type="text" class="ve-code" value="' + esc(d.vat_code || '') + '" style="width:60px">'
    : '<span class="pe-ro">' + esc(d.vat_code) + '</span>';
  tr.innerHTML = '<td data-field="code">' + codeHtml + '</td>'
    + '<td data-field="desc"><input type="text" class="ve-desc" value="' + esc(d.description || '') + '" style="width:160px"></td>'
    + '<td data-field="rate"><input type="number" step="0.01" class="ve-rate" value="' + (d.rate != null ? d.rate : 0) + '" style="width:55px"></td>'
    + '<td data-field="input"><input type="text" class="ve-input" value="' + esc(d.input_account || '') + '" style="width:70px"></td>'
    + '<td data-field="output"><input type="text" class="ve-output" value="' + esc(d.output_account || '') + '" style="width:70px"></td>'
    + '<td data-field="rbox"><input type="text" class="ve-rbox" value="' + esc(d.report_box || '') + '" style="width:50px"></td>'
    + '<td data-field="rc" style="text-align:center"><input type="checkbox" class="ve-rc"' + (d.is_reverse_charge ? ' checked' : '') + '></td>'
    + '<td data-field="active" style="text-align:center"><input type="checkbox" class="ve-active"' + (d.is_active ? ' checked' : '') + '></td>'
    + '<td class="row-actions">'
    + '<a class="chip chip-ok" title="write (w)" onclick="event.stopPropagation();writeVatRowAt(' + idx + ')">✓</a> '
    + '<a class="chip chip-cancel" title="exit (Esc)" onclick="event.stopPropagation();exitVatEdit()">✕</a></td>';
  tr.classList.add('row-editing');
  if (window.FB && FB.mode) FB.mode.set('INSERT');
  window.fbEditActive = true;
  var sel = { code: '.ve-code', desc: '.ve-desc', rate: '.ve-rate', input: '.ve-input', output: '.ve-output', rbox: '.ve-rbox' }[field]
    || (d._isNew ? '.ve-code' : '.ve-desc');
  var target = tr.querySelector(sel) || tr.querySelector('input');
  if (target) { target.focus(); if (target.select) target.select(); }
  syncVatChrome();
}

function exitVatEdit() {
  if (vatEditIdx < 0) return;
  var d = vatMerged()[vatEditIdx];
  var tr = vatRows()[vatEditIdx];
  if (d && tr) {
    var codeIn = tr.querySelector('.ve-code');
    var desc = tr.querySelector('.ve-desc').value.trim();
    var rate = parseFloat(tr.querySelector('.ve-rate').value) || 0;
    var input = tr.querySelector('.ve-input').value.trim();
    var output = tr.querySelector('.ve-output').value.trim();
    var rbox = tr.querySelector('.ve-rbox').value.trim();
    var rc = tr.querySelector('.ve-rc').checked;
    var active = tr.querySelector('.ve-active').checked;
    if (d._isNew) {
      var code = codeIn ? codeIn.value.trim() : '';
      if (code || desc || input || output) {
        vatDirty[d._key] = { vat_code: code, description: desc, rate: rate, input_account: input, output_account: output, report_box: rbox, is_reverse_charge: rc, is_active: active, isNew: true };
      } else {
        delete vatDirty[d._key];
      }
    } else {
      var saved = null;
      for (var i = 0; i < vatSaved.length; i++) if (vatSaved[i].vat_code === d._key) saved = vatSaved[i];
      var same = saved && desc === (saved.description || '') && rate === (saved.rate || 0) && input === (saved.input_account || '') && output === (saved.output_account || '') && rbox === (saved.report_box || '') && rc === !!saved.is_reverse_charge && active === !!saved.is_active;
      if (same) delete vatDirty[d._key];
      else vatDirty[d._key] = { vat_code: d._key, description: desc, rate: rate, input_account: input, output_account: output, report_box: rbox, is_reverse_charge: rc, is_active: active, isNew: false };
    }
  }
  var key = d ? d._key : null;
  vatEditIdx = -1;
  if (window.FB && FB.mode) FB.mode.set('NORMAL');
  window.fbEditActive = false;
  renderVat(key);
  syncVatChrome();
}

function writeVatRowAt(idx) {
  if (vatEditIdx >= 0) exitVatEdit();
  var d = vatMerged()[idx];
  if (!d || !d._dirty) return;
  if (!d.vat_code) { showMsg('msg-vat', 'VAT code required', true); return; }
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'vat.codes.upsert', companyId: COMPANY,
      vatCode: { vat_code: d._isNew ? d.vat_code : d._key, description: d.description || null, rate: d.rate || 0, input_account: d.input_account || null, output_account: d.output_account || null, report_box: d.report_box || null, is_reverse_charge: !!d.is_reverse_charge, is_active: !!d.is_active } }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var dd = res.data || res;
      if (dd.error || res.error) { showMsg('msg-vat', dd.error || res.error, true); return; }
      delete vatDirty[d._key];
      showMsg('msg-vat', 'Saved', false);
      loadVat(d._isNew ? d.vat_code : d._key);
    })
    .catch(function(e){ showMsg('msg-vat', e.message, true); });
}

function revertVatRowAt(idx) {
  if (vatEditIdx >= 0) exitVatEdit();
  var d = vatMerged()[idx];
  if (!d || !d._dirty) return;
  delete vatDirty[d._key];
  renderVat(d._isNew ? null : d._key);
  syncVatChrome();
}

function focusedVatIdx() {
  var tr = vatNav && vatNav.current();
  return tr ? +tr.dataset.idx : -1;
}
function focusedVatDirty() {
  var idx = focusedVatIdx();
  var d = idx >= 0 ? vatMerged()[idx] : null;
  return !!(d && d._dirty);
}
function editFocusedVat() { var idx = focusedVatIdx(); enterVatEdit(idx >= 0 ? idx : 0); }
function writeFocusedVat() { var idx = focusedVatIdx(); if (idx >= 0) writeVatRowAt(idx); }
function revertFocusedVat() { var idx = focusedVatIdx(); if (idx >= 0) revertVatRowAt(idx); }

function deleteFocusedVat() {
  var idx = focusedVatIdx();
  if (idx < 0) return;
  var d = vatMerged()[idx];
  if (!d) return;
  if (d._isNew) { delete vatDirty[d._key]; renderVat(); syncVatChrome(); return; }
  if (!confirm('Delete VAT code "' + d.vat_code + '"?')) return;
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'vat.codes.delete', companyId: COMPANY, vatCode: d._key }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var dd = res.data || res;
      if (dd.error || res.error) { showMsg('msg-vat', dd.error || res.error, true); return; }
      delete vatDirty[d._key];
      loadVat();
    })
    .catch(function(e){ showMsg('msg-vat', e.message, true); });
}

function newVatRow() {
  if (vatEditIdx >= 0) exitVatEdit();
  var key = '_new_' + (++vatGhostN);
  vatDirty[key] = { vat_code: '', description: '', rate: 0, input_account: '', output_account: '', report_box: '', is_reverse_charge: false, is_active: true, isNew: true };
  renderVat(key);
  enterVatEdit(0, 'code'); // new rows unshift to index 0 (pinned-top)
  if (window.FB && FB.track) FB.track.create('tax-code');
}

function advanceVatField() {
  var tr = vatRows()[vatEditIdx];
  if (!tr) return;
  var inputs = Array.from(tr.querySelectorAll('input'));
  var i = inputs.indexOf(document.activeElement);
  if (i >= 0 && i < inputs.length - 1) { inputs[i + 1].focus(); if (inputs[i + 1].select) inputs[i + 1].select(); }
}
function vatTabSticky(e) {
  var tr = vatRows()[vatEditIdx];
  if (!tr) return false;
  var inputs = Array.from(tr.querySelectorAll('input'));
  if (!inputs.length) return false;
  var i = inputs.indexOf(document.activeElement);
  return e.shiftKey ? i === 0 : i === inputs.length - 1;
}

function renderVatHints() {
  var el = document.getElementById('sb-hints');
  if (!el || !(window.FB && FB.keys)) return;
  FB.keys.renderHints('settings-vat', el, { layout: 'list' });
}

function loadVat(focusKey) {
  var tbody = document.getElementById('vat-body');
  if (!tbody) return;
  fetch('/api/' + COMPANY + '/vat-codes')
    .then(function(r){ return r.json(); })
    .then(function(rows){
      vatSaved = (Array.isArray(rows) ? rows : []).map(function(v){
        return { vat_code: v.vat_code, description: v.description || '', rate: v.rate || 0, input_account: v.input_account || v.vat_account_input || '', output_account: v.output_account || v.vat_account_output || '', report_box: v.report_box || '', is_reverse_charge: !!v.is_reverse_charge, is_active: !!v.is_active };
      });
      renderVat(focusKey);
      syncVatChrome();
    })
    .catch(function(e){ console.error('loadVat:', e); });
}

// Register immediately — same soft-nav rationale as settings-periods.
(function() {
  if (!(window.FB && FB.keys)) return;
  vatNav = FB.nav.create({ rows: vatRows, focusClass: 'nav-row-focus' });
  if (FB.keys.unregister) FB.keys.unregister('settings-vat');
  FB.keys.register('settings-vat', {
    active: function() { var p = document.getElementById('tab-vat'); return !!(p && p.classList.contains('active')); },
    getMode: function() { return vatEditIdx >= 0 ? 'INSERT' : 'NORMAL'; },
    bindings: [
      { key: 'j', mode: 'NORMAL', hint: 'navigate', hintBar: true, run: function() { vatNav.move(1); } },
      { key: 'k', mode: 'NORMAL', hint: 'navigate', hintBar: true, run: function() { vatNav.move(-1); } },
      { key: 'i', mode: 'NORMAL', hint: 'edit', hintBar: true, run: editFocusedVat },
      { key: 'Enter', mode: 'NORMAL', hint: 'edit', hintBar: true, run: editFocusedVat },
      { key: 'o', mode: 'NORMAL', hint: 'new row', hintBar: true, run: newVatRow },
      { key: 'x', mode: 'NORMAL', hint: 'delete', hintBar: true, run: deleteFocusedVat },
      { key: 'w', mode: 'NORMAL', hint: 'write', hintBar: true, when: focusedVatDirty, run: writeFocusedVat },
      { key: 'u', mode: 'NORMAL', hint: 'revert', hintBar: true, when: focusedVatDirty, run: revertFocusedVat },
      { key: 'Escape', mode: 'INSERT', hint: 'exit edit', hintBar: true, run: exitVatEdit },
      { key: 'Enter', mode: 'INSERT', run: advanceVatField },
      { key: 'Tab', mode: 'INSERT', when: vatTabSticky, run: function() {} },
      { key: 'Tab', mode: 'INSERT', swallow: false, preventDefault: false, run: function() {} }
    ]
  });
})();

// ========== JOURNALS — modal edit doctrine ==========
var journalsSaved = [];
var journalsDirty = {};
var journalsGhostN = 0;
var journalsEditIdx = -1;
var journalsNav = null;

function journalsRows() { return Array.from(document.querySelectorAll('#journals-body tr:not(.fb-ghost-row)')); }

function journalsMerged() {
  var out = journalsSaved.map(function(j) {
    var d = journalsDirty[j.journal_id];
    if (d) return { journal_id: j.journal_id, code: d.code, name: d.name, active: d.active, _dirty: true, _key: j.journal_id, _isNew: false };
    return { journal_id: j.journal_id, code: j.code, name: j.name, active: j.active, _dirty: false, _key: j.journal_id, _isNew: false };
  });
  Object.keys(journalsDirty).forEach(function(k) {
    var d = journalsDirty[k];
    if (d && d.isNew) out.unshift({ journal_id: '', code: d.code, name: d.name, active: d.active, _dirty: true, _key: k, _isNew: true }); // P2 pinned-top
  });
  return out;
}

function journalsAnyDirty() { return journalsEditIdx >= 0 || Object.keys(journalsDirty).length > 0; }

function syncJournalsChrome() {
  var dirty = journalsAnyDirty();
  var dot = document.getElementById('tab-dot-journals');
  if (dot) dot.style.display = dirty ? '' : 'none';
  if (dirty) markDirty('journals'); else resetDirty('journals');
}

function renderJournals(focusKey) {
  var tbody = document.getElementById('journals-body');
  if (!tbody) return;
  var merged = journalsMerged();
  tbody.innerHTML = '<tr class="fb-ghost-row" style="cursor:text"><td colspan="4" class="fb-ghost-cell">+ New journal <kbd>o</kbd></td></tr>' + merged.map(function(j, i) {
    var code = j.code ? esc(j.code) : '<span class="pe-ro">—</span>';
    var name = j.name ? esc(j.name) : '<span class="pe-ro">—</span>';
    if (j._dirty) {
      code = '<span class="dirty-val">' + code + '</span>';
      name = '<span class="dirty-val">' + name + '</span>';
    }
    var actions = j._dirty
      ? '<a class="chip chip-ok" title="write (w)" onclick="event.stopPropagation();writeJournalRowAt(' + i + ')">✓</a> <a class="chip chip-cancel" title="revert (u)" onclick="event.stopPropagation();revertJournalRowAt(' + i + ')">✕</a>'
      : '';
    return '<tr' + (j._dirty ? ' class="row-dirty"' : '') + ' data-idx="' + i + '" data-key="' + esc(j._key) + '">'
      + '<td data-field="code">' + code + '</td>'
      + '<td data-field="name">' + name + '</td>'
      + '<td data-field="active" style="text-align:center">' + (j.active ? 'Yes' : 'No') + '</td>'
      + '<td class="row-actions">' + actions + '</td></tr>';
  }).join('');
  Array.from(tbody.querySelectorAll('tr:not(.fb-ghost-row)')).forEach(function(tr) {
    tr.addEventListener('click', function(e) {
      if (journalsNav) journalsNav.set(tr);
      var td = e.target.closest('td');
      if (!td || td.classList.contains('row-actions')) return;
      enterJournalEdit(+tr.dataset.idx, td.dataset.field || undefined);
    });
  });
  var jGhost = tbody.querySelector('.fb-ghost-row');
  if (jGhost) jGhost.addEventListener('click', function() { newJournalRow(); });
  if (journalsNav) {
    var target = focusKey != null ? tbody.querySelector('tr[data-key="' + focusKey + '"]') : null;
    journalsNav.set(target || journalsRows()[0] || null);
  }
}

function enterJournalEdit(idx, field) {
  if (journalsEditIdx === idx) return;
  if (journalsEditIdx >= 0) exitJournalEdit();
  var d = journalsMerged()[idx];
  var tr = journalsRows()[idx];
  if (!d || !tr) return;
  journalsEditIdx = idx;
  var codeHtml = d._isNew
    ? '<input type="text" class="je-code" value="' + esc(d.code || '') + '" style="width:70px" oninput="this.value=this.value.toUpperCase()">'
    : '<span class="pe-ro">' + esc(d.code) + '</span>';
  tr.innerHTML = '<td data-field="code">' + codeHtml + '</td>'
    + '<td data-field="name"><input type="text" class="je-name" value="' + esc(d.name || '') + '" style="width:180px"></td>'
    + '<td data-field="active" style="text-align:center"><input type="checkbox" class="je-active"' + (d.active ? ' checked' : '') + '></td>'
    + '<td class="row-actions">'
    + '<a class="chip chip-ok" title="write (w)" onclick="event.stopPropagation();writeJournalRowAt(' + idx + ')">✓</a> '
    + '<a class="chip chip-cancel" title="exit (Esc)" onclick="event.stopPropagation();exitJournalEdit()">✕</a></td>';
  tr.classList.add('row-editing');
  if (window.FB && FB.mode) FB.mode.set('INSERT');
  window.fbEditActive = true;
  var sel = { code: '.je-code', name: '.je-name' }[field]
    || (d._isNew ? '.je-code' : '.je-name');
  var target = tr.querySelector(sel) || tr.querySelector('input');
  if (target) { target.focus(); if (target.select) target.select(); }
  syncJournalsChrome();
}

function exitJournalEdit() {
  if (journalsEditIdx < 0) return;
  var d = journalsMerged()[journalsEditIdx];
  var tr = journalsRows()[journalsEditIdx];
  if (d && tr) {
    var codeIn = tr.querySelector('.je-code');
    var name = tr.querySelector('.je-name').value.trim();
    var active = tr.querySelector('.je-active').checked;
    if (d._isNew) {
      var code = codeIn ? codeIn.value.trim().toUpperCase() : '';
      if (code || name) {
        journalsDirty[d._key] = { code: code, name: name, active: active, isNew: true };
      } else {
        delete journalsDirty[d._key];
      }
    } else {
      var saved = null;
      for (var i = 0; i < journalsSaved.length; i++) if (journalsSaved[i].journal_id === d._key) saved = journalsSaved[i];
      var same = saved && name === saved.name && active === !!saved.active;
      if (same) delete journalsDirty[d._key];
      else journalsDirty[d._key] = { code: saved ? saved.code : d._key, name: name, active: active, isNew: false };
    }
  }
  var key = d ? d._key : null;
  journalsEditIdx = -1;
  if (window.FB && FB.mode) FB.mode.set('NORMAL');
  window.fbEditActive = false;
  renderJournals(key);
  syncJournalsChrome();
}

function writeJournalRowAt(idx) {
  if (journalsEditIdx >= 0) exitJournalEdit();
  var d = journalsMerged()[idx];
  if (!d || !d._dirty) return;
  if (!d.code || !d.name) { showMsg('msg-journals', 'Code and name required', true); return; }
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'journals.save', companyId: COMPANY,
      journal: { journal_id: d._isNew ? null : d._key, code: d.code, name: d.name, active: !!d.active } }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var dd = res.data || res;
      if (dd.error || res.error) { showMsg('msg-journals', dd.error || res.error, true); return; }
      delete journalsDirty[d._key];
      showMsg('msg-journals', 'Saved', false);
      loadJournals(d._isNew ? (dd.journalId || d.code) : d._key);
    })
    .catch(function(e){ showMsg('msg-journals', e.message, true); });
}

function revertJournalRowAt(idx) {
  if (journalsEditIdx >= 0) exitJournalEdit();
  var d = journalsMerged()[idx];
  if (!d || !d._dirty) return;
  delete journalsDirty[d._key];
  renderJournals(d._isNew ? null : d._key);
  syncJournalsChrome();
}

function focusedJournalIdx() {
  var tr = journalsNav && journalsNav.current();
  return tr ? +tr.dataset.idx : -1;
}
function focusedJournalDirty() {
  var idx = focusedJournalIdx();
  var d = idx >= 0 ? journalsMerged()[idx] : null;
  return !!(d && d._dirty);
}
function editFocusedJournal() { var idx = focusedJournalIdx(); enterJournalEdit(idx >= 0 ? idx : 0); }
function writeFocusedJournal() { var idx = focusedJournalIdx(); if (idx >= 0) writeJournalRowAt(idx); }
function revertFocusedJournal() { var idx = focusedJournalIdx(); if (idx >= 0) revertJournalRowAt(idx); }

function deleteFocusedJournal() {
  var idx = focusedJournalIdx();
  if (idx < 0) return;
  var d = journalsMerged()[idx];
  if (!d) return;
  if (d._isNew) { delete journalsDirty[d._key]; renderJournals(); syncJournalsChrome(); return; }
  if (!confirm('Deactivate journal "' + d.code + '"? (soft delete — existing references preserved)')) return;
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'journals.delete', companyId: COMPANY, journalId: d._key }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var dd = res.data || res;
      if (dd.error || res.error) { showMsg('msg-journals', dd.error || res.error, true); return; }
      delete journalsDirty[d._key];
      loadJournals();
    })
    .catch(function(e){ showMsg('msg-journals', e.message, true); });
}

function newJournalRow() {
  if (journalsEditIdx >= 0) exitJournalEdit();
  var key = '_new_' + (++journalsGhostN);
  journalsDirty[key] = { code: '', name: '', active: true, isNew: true };
  renderJournals(key);
  enterJournalEdit(0, 'code'); // new rows unshift to index 0 (pinned-top)
  if (window.FB && FB.track) FB.track.create('journal-type');
}

function advanceJournalField() {
  var tr = journalsRows()[journalsEditIdx];
  if (!tr) return;
  var inputs = Array.from(tr.querySelectorAll('input'));
  var i = inputs.indexOf(document.activeElement);
  if (i >= 0 && i < inputs.length - 1) { inputs[i + 1].focus(); if (inputs[i + 1].select) inputs[i + 1].select(); }
}
function journalTabSticky(e) {
  var tr = journalsRows()[journalsEditIdx];
  if (!tr) return false;
  var inputs = Array.from(tr.querySelectorAll('input'));
  if (!inputs.length) return false;
  var i = inputs.indexOf(document.activeElement);
  return e.shiftKey ? i === 0 : i === inputs.length - 1;
}

function renderJournalHints() {
  var el = document.getElementById('sb-hints');
  if (!el || !(window.FB && FB.keys)) return;
  FB.keys.renderHints('settings-journals', el, { layout: 'list' });
}

function loadJournals(focusKey) {
  var tbody = document.getElementById('journals-body');
  if (!tbody) return;
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'journals.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var rows = res.data || res;
      journalsSaved = (Array.isArray(rows) ? rows : []).map(function(j){
        return { journal_id: j.journal_id, code: j.code || '', name: j.name || '', active: !!j.active };
      });
      renderJournals(focusKey);
      syncJournalsChrome();
    })
    .catch(function(e){ console.error('loadJournals:', e); });
}

// Register immediately — same soft-nav rationale as settings-periods.
(function() {
  if (!(window.FB && FB.keys)) return;
  journalsNav = FB.nav.create({ rows: journalsRows, focusClass: 'nav-row-focus' });
  if (FB.keys.unregister) FB.keys.unregister('settings-journals');
  FB.keys.register('settings-journals', {
    active: function() { var p = document.getElementById('tab-journals'); return !!(p && p.classList.contains('active')); },
    getMode: function() { return journalsEditIdx >= 0 ? 'INSERT' : 'NORMAL'; },
    bindings: [
      { key: 'j', mode: 'NORMAL', hint: 'navigate', hintBar: true, run: function() { journalsNav.move(1); } },
      { key: 'k', mode: 'NORMAL', hint: 'navigate', hintBar: true, run: function() { journalsNav.move(-1); } },
      { key: 'i', mode: 'NORMAL', hint: 'edit', hintBar: true, run: editFocusedJournal },
      { key: 'Enter', mode: 'NORMAL', hint: 'edit', hintBar: true, run: editFocusedJournal },
      { key: 'o', mode: 'NORMAL', hint: 'new row', hintBar: true, run: newJournalRow },
      { key: 'x', mode: 'NORMAL', hint: 'delete', hintBar: true, run: deleteFocusedJournal },
      { key: 'w', mode: 'NORMAL', hint: 'write', hintBar: true, when: focusedJournalDirty, run: writeFocusedJournal },
      { key: 'u', mode: 'NORMAL', hint: 'revert', hintBar: true, when: focusedJournalDirty, run: revertFocusedJournal },
      { key: 'Escape', mode: 'INSERT', hint: 'exit edit', hintBar: true, run: exitJournalEdit },
      { key: 'Enter', mode: 'INSERT', run: advanceJournalField },
      { key: 'Tab', mode: 'INSERT', when: journalTabSticky, run: function() {} },
      { key: 'Tab', mode: 'INSERT', swallow: false, preventDefault: false, run: function() {} }
    ]
  });
})();

// ── FX Rates tab keyboard (P2) ────────────────────────────────────────────
(function() {
  if (!(window.FB && FB.keys)) return;
  var fxSel = -1;
  function fxRows() { return Array.from(document.querySelectorAll('#fx-rates-body tr')); }
  function fxCursor() { fxRows().forEach(function(r, i) { r.classList.toggle('bill-row-focus', i === fxSel); }); }
  if (FB.keys.unregister) FB.keys.unregister('settings-fxrates');
  FB.keys.register('settings-fxrates', {
    active: function() { var p = document.getElementById('tab-fxrates'); return !!(p && p.classList.contains('active')); },
    getMode: function() {
      var ae = document.activeElement;
      return (ae && ae.closest && ae.closest('#fx-rates-body')) ? 'INSERT' : 'NORMAL';
    },
    bindings: [
      { key: 'j', mode: 'NORMAL', hint: 'navigate', hintBar: true,
        swallow: function() { return fxRows().length > 0; },
        run: function() { var n = fxRows().length; if (!n) return; fxSel = Math.min(fxSel + 1, n - 1); fxCursor(); } },
      { key: 'k', mode: 'NORMAL', hint: 'navigate', hintBar: true,
        swallow: function() { return fxRows().length > 0; },
        run: function() { fxSel = Math.max(fxSel - 1, 0); fxCursor(); } },
      { key: 'o', mode: 'NORMAL', hint: 'new rate', hintBar: true,
        run: function() { addFxRateRow(); } },
      { key: 'Enter', mode: 'NORMAL', hint: 'edit', hintBar: true,
        swallow: function() { return fxSel >= 0; },
        run: function() {
          var tr = fxRows()[fxSel];
          var inp = tr && tr.querySelector('input');
          if (inp) inp.focus();
        } },
      { key: 'Escape', mode: 'INSERT', hint: 'back',
        run: function() { if (document.activeElement) document.activeElement.blur(); } }
    ]
  });
})();

// Ghost-row mouse affordance for FX: the staged manual row IS the create target;
// clicking its non-input area focuses the from-currency field.
document.addEventListener('click', function(e) {
  var p = document.getElementById('tab-fxrates');
  if (!(p && p.classList.contains('active'))) return;
  var tr = e.target && e.target.closest ? e.target.closest('#fx-rates-body tr') : null;
  if (!tr || !tr.querySelector('input.fx-from')) return;
  if (['INPUT','SELECT','BUTTON'].indexOf(e.target.tagName) >= 0) return;
  var inp = tr.querySelector('input.fx-from');
  if (inp) inp.focus();
});

// ========== HANDLE ?tab= URL PARAM ==========
(function() {
  var params = new URLSearchParams(window.location.search);
  var tab = params.get('tab');
  loadCurrencyList();
  showTab(tab || 'company');
})();

// Wire FX rates save button
var fxSaveBtn = document.querySelector('#fx-rates-body');
if (!fxSaveBtn) {
  var s = document.createElement('script');
  s.textContent = '(function(){ var tbody = document.getElementById("fx-rates-body"); if (tbody && !tbody.dataset.fxWired) { tbody.dataset.fxWired = true; var frm = tbody.parentElement.parentElement; var btn = document.createElement("button"); btn.className = "btn-primary"; btn.textContent = "Save Rates"; btn.onclick = saveFxRates; frm.appendChild(btn); } })();';
  document.body.appendChild(s);
}
// ========== EXCHANGE RATES ==========
var fxRatesData = [];
var baseCurrencies = new Set();

function loadBaseCurrencies() {
  // Update the display of current company's base currency
  var compCcy = window._companyCurrency || '';
  var displayEl = document.getElementById('current-base-currency');
  if (displayEl && compCcy) {
    displayEl.textContent = 'Base currency: ' + compCcy;
  }
}

function loadFxRates() {
  var compCcy = window._companyCurrency || '';
  var params = { action:'fx.rates.list', companyId: COMPANY };
  if (compCcy) params.baseCurrency = compCcy;
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(params) })
    .then(function(r){ return r.json(); }).then(function(res){
      fxRatesData = res.data || res;
      renderFxRates(Array.isArray(fxRatesData) ? fxRatesData : []);
      loadBaseCurrencies();
    }).catch(function(){});
}

function renderFxRates(rows) {
  var tbody = document.getElementById('fx-rates-body');
  tbody.innerHTML = '';
  rows.forEach(function(r){
    var tr = document.createElement('tr');
    var isEcb = r.source === 'ecb';
    if (isEcb) tr.style.opacity = '0.6';
    var date = r.date ? String(r.date).slice(0, 10) : '';
    tr.innerHTML =
      '<td><span class="ro">' + date + '</span></td>' +
      '<td><span class="ro">' + (r.from_currency || '') + '</span></td>' +
      '<td><span class="ro">' + (r.to_currency || '') + '</span></td>' +
      '<td style="text-align:right"><span class="ro">' + (Number(r.rate).toFixed(6)) + '</span></td>' +
      '<td><span class="ro">' + (r.source || '') + '</span></td>' +
      '<td>' + (isEcb ? '' : '<button class="btn-sm danger" onclick="deleteFxRate(&apos;' + date + '&apos;, &apos;' + r.from_currency + '&apos;, &apos;' + r.to_currency + '&apos;, &apos;' + r.source + '&apos;)" style="font-size:9pt">×</button>') + '</td>';
    tbody.appendChild(tr);
  });
}

function addFxRateRow() {
  var tr = document.createElement('tr');
  var today = new Date().toISOString().slice(0, 10);
  tr.innerHTML =
    '<td><input type="date" class="fx-date" style="width:120px" value="' + today + '"></td>' +
    '<td><input type="text" class="fx-from" maxlength="3" style="width:60px;text-transform:uppercase" placeholder="e.g. USD"></td>' +
    '<td><input type="text" class="fx-to" maxlength="3" style="width:60px;text-transform:uppercase" placeholder="e.g. SGD"></td>' +
    '<td style="text-align:right"><input type="number" class="fx-rate" step="0.000001" style="width:100px" placeholder="e.g. 1.35"></td>' +
    '<td><span class="ro">manual</span></td>' +
    '<td><button class="btn-sm danger" onclick="this.parentElement.parentElement.remove()" style="font-size:9pt">×</button></td>';
  // P2 pinned-top: staged manual rows lead the table
  var tbody = document.getElementById('fx-rates-body');
  tbody.insertBefore(tr, tbody.firstChild);
  attachCcyDd(tr.querySelector('.fx-from'));
  attachCcyDd(tr.querySelector('.fx-to'));
  tr.querySelector('.fx-from').focus();
  if (window.FB && FB.track) FB.track.create('fx-rate');
}

function deleteFxRate(date, from, to, source) {
  if (!confirm('Delete this rate?')) return;
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'fx.rates.delete', companyId: COMPANY, date: date, from_currency: from, to_currency: to, source: source }) })
    .then(function(r){ return r.json(); }).then(function(r){ if (!r.error && !r.data.error) loadFxRates(); else showMsg('msg-fxrates', r.error || r.data.error, true); })
    .catch(function(e){ showMsg('msg-fxrates', e.message, true); });
}

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
  var newRates = [];
  var missing = [];
  var rows = Array.from(document.querySelectorAll('#fx-rates-body tr')).filter(function(tr){ return tr.querySelector('.fx-date'); });
  // clear previous field highlights
  rows.forEach(function(tr){ ['fx-date','fx-from','fx-to','fx-rate'].forEach(function(c){ var el = tr.querySelector('.'+c); if (el) el.style.borderColor=''; }); });
  if (!rows.length) { showMsg('msg-fxrates', 'Click "+ Add Rate" first, then fill in date, from, to, and rate', true); return; }
  rows.forEach(function(tr, i){
    var date = tr.querySelector('.fx-date').value;
    var from = tr.querySelector('.fx-from').value.trim().toUpperCase();
    var to = tr.querySelector('.fx-to').value.trim().toUpperCase();
    var rate = parseFloat(tr.querySelector('.fx-rate').value || 0);
    var miss = [];
    if (!date) { miss.push('date'); tr.querySelector('.fx-date').style.borderColor='#c33'; }
    if (!from) { miss.push('from'); tr.querySelector('.fx-from').style.borderColor='#c33'; }
    if (!to) { miss.push('to'); tr.querySelector('.fx-to').style.borderColor='#c33'; }
    if (!(rate > 0)) { miss.push('rate'); tr.querySelector('.fx-rate').style.borderColor='#c33'; }
    if (miss.length) { missing.push('Row ' + (i+1) + ': ' + miss.join(', ')); }
    else { newRates.push({ date: date, from_currency: from, to_currency: to, rate: rate }); }
  });
  if (missing.length) { showMsg('msg-fxrates', 'Missing fields — ' + missing.join('; '), true); return; }
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'fx.rates.save', companyId: COMPANY, rates: newRates }) })
    .then(function(r){ return r.json(); }).then(function(r){ var d = r.data||r; showMsg('msg-fxrates', r.error||d.error||('Saved '+newRates.length+' rates'), !!(r.error||d.error)); if (!r.error && !d.error) loadFxRates(); })
    .catch(function(e){ showMsg('msg-fxrates', e.message, true); });
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

// ========== FX PROVIDER MANAGEMENT ==========
var fxProviders = [];

function loadFxProviders() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'fx.providers.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      fxProviders = res.data || res || [];
      var select = document.getElementById('fx-provider-select');
      select.innerHTML = '';
      (Array.isArray(fxProviders) ? fxProviders : []).forEach(function(p){
        var opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        select.appendChild(opt);
      });
      // Load current provider setting
      fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'fx.provider.get', companyId: COMPANY }) })
        .then(function(r){ return r.json(); })
        .then(function(res){
          var current = res.data || res || {};
          select.value = current.provider || 'ecb';
          onFxProviderChange();
          if (current.apiKey) {
            document.getElementById('fx-provider-apikey').placeholder = 'API key set (' + current.apiKey + ')';
          }
        })
        .catch(function(e){ console.error('loadFxProviders: failed to get current:', e); });
    })
    .catch(function(e){ console.error('loadFxProviders failed:', e); });
}

function onFxProviderChange() {
  var select = document.getElementById('fx-provider-select');
  var providerId = select.value;
  var provider = fxProviders.find(function(p){ return p.id === providerId; });
  if (!provider) return;
  document.getElementById('fx-provider-desc').textContent = provider.description || '';
  var apiKeyRow = document.getElementById('fx-api-key-row');
  var apiKeyBtn = document.getElementById('btn-save-apikey');
  if (provider.requiresApiKey) {
    apiKeyRow.style.display = 'flex';
    if (apiKeyBtn) apiKeyBtn.style.display = '';
    document.getElementById('fx-api-key-label').textContent = provider.apiKeyLabel || 'API Key';
  } else {
    apiKeyRow.style.display = 'none';
    if (apiKeyBtn) apiKeyBtn.style.display = 'none';
  }
  saveProviderSelection();
}

function saveProviderSelection() {
  var select = document.getElementById('fx-provider-select');
  var providerId = select.value;
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'fx.provider.save', companyId: COMPANY, provider: providerId, apiKey: null }) })
    .then(function(r){ return r.json(); })
    .then(function(r){ var d = r.data||r; if (r.error||d.error) showMsg('msg-fx-provider', r.error||d.error, true); })
    .catch(function(e){ showMsg('msg-fx-provider', e.message, true); });
}

function saveApiKey() {
  var select = document.getElementById('fx-provider-select');
  var providerId = select.value;
  var apiKey = document.getElementById('fx-provider-apikey').value.trim();
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'fx.provider.save', companyId: COMPANY, provider: providerId, apiKey: apiKey }) })
    .then(function(r){ return r.json(); })
    .then(function(r){ var d = r.data||r; showMsg('msg-fx-provider', r.error||d.error||'API Key saved', !!(r.error||d.error)); })
    .catch(function(e){ showMsg('msg-fx-provider', e.message, true); });
}

// ========== DEFAULT ACCOUNTS (current company) ==========
// Reads / writes the 'default_ap_account' and 'default_expense_account' rows in
// the settings table for the active company. These are used as fallbacks when
// creating new bills (vendor defaults still take precedence; blank = no default).

function loadDefaultAccounts() {
  var apInput = document.getElementById('default-ap-account');
  var expInput = document.getElementById('default-expense-account');
  if (!apInput || !expInput) return;
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'settings.get', companyId: COMPANY }) })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      var s = (res && res.data) ? res.data : (res || {});
      apInput.value = s.default_ap_account || '';
      expInput.value = s.default_expense_account || '';
    })
    .catch(function (e) { showMsg('msg-default-accounts', e.message, true); });
}

function saveDefaultAccounts() {
  var apInput = document.getElementById('default-ap-account');
  var expInput = document.getElementById('default-expense-account');
  if (!apInput || !expInput) return;
  var apVal = apInput.value.trim();
  var expVal = expInput.value.trim();
  var btn = document.getElementById('btn-save-default-accounts');
  if (btn) { btn.disabled = true; }
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'settings.save', companyId: COMPANY,
      settings: { default_ap_account: apVal, default_expense_account: expVal }
    }) })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      var d = res.data || res;
      if (res.error || d.error) {
        showMsg('msg-default-accounts', res.error || d.error, true);
      } else {
        showMsg('msg-default-accounts', 'Default accounts saved', false);
      }
      if (btn) { btn.disabled = false; }
    })
    .catch(function (e) {
      showMsg('msg-default-accounts', e.message, true);
      if (btn) { btn.disabled = false; }
    });
}

// Populate the default-accounts card on the default-visible Company tab.
window.addEventListener('DOMContentLoaded', function () { loadDefaultAccounts(); loadVatTolerance(); });

// ========== VAT TOLERANCE (current company) ==========
// Reads / writes the 'vat_tolerance' (flat) and 'vat_tolerance_pct' rows in the
// settings table. The % field is displayed as a percentage (1 = 1%) but stored
// as a decimal fraction (0.01 = 1%) in the DB.

function loadVatTolerance() {
  var flatInput = document.getElementById('vat-tolerance-flat');
  var pctInput = document.getElementById('vat-tolerance-pct');
  if (!flatInput || !pctInput) return;
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'settings.get', companyId: COMPANY }) })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      var s = (res && res.data) ? res.data : (res || {});
      var flat = parseFloat(s.vat_tolerance);
      var pct = parseFloat(s.vat_tolerance_pct);
      flatInput.value = isNaN(flat) ? '' : String(flat);
      // Display the percentage form (0.01 -> 1)
      pctInput.value = isNaN(pct) ? '' : String(Math.round(pct * 100 * 100) / 100);
    })
    .catch(function (e) { showMsg('msg-vat-tolerance', e.message, true); });
}

function saveVatTolerance() {
  var flatInput = document.getElementById('vat-tolerance-flat');
  var pctInput = document.getElementById('vat-tolerance-pct');
  if (!flatInput || !pctInput) return;
  var flatVal = flatInput.value.trim();
  var pctVal = pctInput.value.trim();
  // Convert displayed percentage back to decimal fraction for storage
  var flatNum = parseFloat(flatVal);
  var pctNum = parseFloat(pctVal);
  if (flatVal !== '' && (isNaN(flatNum) || flatNum < 0)) {
    showMsg('msg-vat-tolerance', 'Flat tolerance must be a non-negative number', true);
    return;
  }
  if (pctVal !== '' && (isNaN(pctNum) || pctNum < 0)) {
    showMsg('msg-vat-tolerance', 'Tolerance % must be a non-negative number', true);
    return;
  }
  // Store: flat as-is; pct as decimal (1 -> 0.01)
  var flatStore = (flatVal === '') ? '' : String(flatNum);
  var pctStore = (pctVal === '') ? '' : String(pctNum / 100);
  var btn = document.getElementById('btn-save-vat-tolerance');
  if (btn) { btn.disabled = true; }
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'settings.save', companyId: COMPANY,
      settings: { vat_tolerance: flatStore, vat_tolerance_pct: pctStore }
    }) })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      var d = res.data || res;
      if (res.error || d.error) {
        showMsg('msg-vat-tolerance', res.error || d.error, true);
      } else {
        showMsg('msg-vat-tolerance', 'VAT tolerance saved', false);
      }
      if (btn) { btn.disabled = false; }
    })
    .catch(function (e) {
      showMsg('msg-vat-tolerance', e.message, true);
      if (btn) { btn.disabled = false; }
    });
}

// ========== UNSAVED CHANGES PROTECTION ==========
window.onbeforeunload = function(e) {
  if (dirtyTabs.size > 0) {
    var msg = 'You have unsaved changes.';
    e.returnValue = msg;
    return msg;
  }
};

</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleSettingsPage };
