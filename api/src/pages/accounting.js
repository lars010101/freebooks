'use strict';
// accounting.js — IA restructure 2 (2026-08-27).
// Split out from master-data.js: Chart of Accounts, Tax Codes (VAT + WHT
// merged into one tab), Journals, Cost/Profit Centers. Partners moved to
// payables; Exchange Rates moved to exchange-rates.js.
const { makeQuery, commonStyle, navBar, layoutEnd } = require('./common');

async function handleAccountingPage(req, res) {
  const { company } = req.params;
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildAccountingPage(company));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function buildAccountingPage(company) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Accounting - freeBooks</title>
${commonStyle()}
<style>
  .tabs { display:flex; gap:0; border-bottom:2px solid var(--accent); margin-bottom:24px; }
  .tab { padding:8px 20px; cursor:pointer; font-weight:600; font-size:0.8125rem; color:var(--text-muted); border-bottom:3px solid transparent; margin-bottom:-2px; }
  .tab.active { color:var(--accent); border-bottom-color:var(--accent); }
  .tab-panel { display:none; }
  .tab-panel.active { display:block; }
  table.edit-table { width:100%; border-collapse:collapse; font-size:0.8125rem; }
  table.edit-table th { text-align:left; font-size:0.75rem; text-transform:uppercase; color:var(--text-muted); border-bottom:1px solid var(--border); padding:6px 6px; white-space:nowrap; }
  table.edit-table td { padding:4px 6px; border-bottom:1px solid var(--border); vertical-align:middle; white-space:nowrap; }
  table.edit-table input[type=text], table.edit-table input[type=date], table.edit-table select { width:100%; padding:4px 6px; border:1px solid var(--border); border-radius:3px; font-size:0.8125rem; background:var(--surface); color:var(--text); }
  table.edit-table .ro { background:var(--bg); color:var(--text-muted); padding:4px 6px; border-radius:3px; display:block; }
  .pe-ro { color:var(--text-muted); }
  tr.row-dirty > td:first-child { box-shadow: inset 3px 0 0 var(--warning); }
  .dirty-val { color:var(--warning); }
  tr.row-editing > td { background:var(--warning-bg); }
  .row-actions { white-space:nowrap; text-align:right; }
  .type-badge { display:inline-block; padding:1px 7px; border-radius:3px; font-size:0.75rem; font-weight:600; }
  .subhead { font-size:0.875rem; font-weight:700; color:var(--text); margin:18px 0 6px; }
  .subhead:first-child { margin-top:0; }
  /* Integrity tab — fetched report fragment, not FB.list (nothing to edit).
     Mirrors reports/render.js htmlPage()'s embedded styling, theme-aware.
     docs/ia-restructure-3-spec.md §3.3. */
  .rpt-embed .page { padding:0; max-width:none; }
  .rpt-embed .header { display:none; } /* period/company header — redundant with this page's own H1 */
  .rpt-embed table { width:100%; border-collapse:collapse; margin-top:8px; }
  .rpt-embed th { text-align:left; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-muted); border-bottom:1px solid var(--border); padding:6px 8px; }
  .rpt-embed td { padding:5px 8px; border-bottom:1px solid var(--border); vertical-align:top; color:var(--text); }
  .rpt-embed .footer { margin-top:24px; padding-top:12px; border-top:1px solid var(--border); font-size:0.75rem; color:var(--text-muted); }
  .rpt-embed-msg { padding:1rem 0; color:var(--text-muted); }
</style>
</head>
<body>${navBar(company, 'accounting')}
<div class="page page-wide">
  <div class="header">
    <h1>📊 Accounting</h1>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="showTab('coa')">Chart of Accounts<span id="tab-dot-coa" style="display:none;color:var(--warning)"> ●</span></div>
    <div class="tab" id="tab-taxcodes-label" onclick="showTab('taxcodes')">Tax Codes<span id="tab-dot-taxcodes" style="display:none;color:var(--warning)"> ●</span></div>
    <div class="tab" onclick="showTab('journals')">Journals<span id="tab-dot-journals" style="display:none;color:var(--warning)"> ●</span></div>
    <div class="tab" onclick="showTab('centers')">Cost/Profit Centers<span id="tab-dot-centers" style="display:none;color:var(--warning)"> ●</span></div>
    <div class="tab" onclick="showTab('integrity')">Integrity<span id="tab-dot-integrity" style="display:none;color:var(--danger)"> ●</span></div>
  </div>

  <!-- COA TAB -->
  <div id="tab-coa" class="tab-panel active">
    <table class="edit-table" id="coa-table">
      <thead><tr><th>Code</th><th>Account Name</th><th>Type</th><th>Subtype</th><th>CF Category</th><th>Active</th><th>Default</th><th>Start</th><th></th></tr></thead>
      <tbody id="coa-body"></tbody>
    </table>
  </div>

  <!-- TAX CODES TAB (merged: VAT/GST + WHT in one grid) -->
  <div id="tab-taxcodes" class="tab-panel">
    <table class="edit-table" id="taxcodes-table">
      <thead><tr><th style="width:50px">Type</th><th style="width:60px">Code</th><th>Description</th><th style="width:55px">Rate %</th><th style="width:70px">In Acct</th><th style="width:70px">Out Acct / WHT</th><th style="width:50px;text-align:center">RC</th><th style="width:50px">Report Box</th><th style="width:50px;text-align:center">Active</th><th></th></tr></thead>
      <tbody id="taxcodes-body"></tbody>
    </table>
  </div>

  <!-- JOURNALS TAB -->
  <div id="tab-journals" class="tab-panel">
    <table class="edit-table" id="journals-table">
      <thead><tr><th>Code</th><th>Name</th><th style="text-align:center">Active</th><th></th></tr></thead>
      <tbody id="journals-body"></tbody>
    </table>
  </div>

  <!-- COST/PROFIT CENTERS TAB -->
  <div id="tab-centers" class="tab-panel">
    <table class="edit-table" id="centers-table">
      <thead><tr><th>Center ID</th><th>Name</th><th>Type</th><th>Profit Center</th><th style="text-align:center">Active</th><th></th></tr></thead>
      <tbody id="centers-body"></tbody>
    </table>
  </div>

  <!-- INTEGRITY TAB — fetched report fragment (report?type=integrity), not
       FB.list: nothing here to edit/add/delete. docs/ia-restructure-3-spec.md §3.3 -->
  <div id="tab-integrity" class="tab-panel">
    <div id="integrity-body" class="rpt-embed"><p class="rpt-embed-msg">Loading…</p></div>
  </div>

</div>

<script>
var COMPANY = '${company}';
var CF_OPTS = ['','Cash','Op-WC','Operating','Tax','Investing','Financing','NonCash','Excluded'];
var VAT_NAMES = { SG:'GST', SE:'VAT' };

// ========== DIRTY STATE MANAGER ==========
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
    if (window.FB && FB.list && FB.list.anyDirty()) {
      FB.list.guard(function(){ showTab(t); });
      return;
    }
    if (dirtyTabs.has(curTab)) {
      FB.modal.open({
        title: 'Discard unsaved changes?',
        buttons: [
          { label: 'Keep editing', onClick: function (api) { api.close(); } },
          { label: 'Discard', danger: true, onClick: function (api) { api.close(); resetDirty(curTab); showTabFinish(t); } }
        ]
      });
      return;
    }
  }
  showTabFinish(t);
}
function showTabFinish(t) {
  var tabs = ['coa','taxcodes','journals','centers','integrity'];
  document.querySelectorAll('.tab').forEach(function(el,i){ el.classList.toggle('active', tabs[i]===t); });
  document.querySelectorAll('.tab-panel').forEach(function(el){ el.classList.remove('active'); });
  document.getElementById('tab-'+t).classList.add('active');
  // Persist last-active tab.
  try { sessionStorage.setItem('accounting-last-tab', t); } catch(e) {}
  var hintEl = document.getElementById('sb-hints');
  if (hintEl) {
    if (t === 'coa') renderCoaHints();
    else if (t === 'taxcodes') renderTaxHints();
    else if (t === 'journals') renderJournalHints();
    else if (t === 'centers') FB.keys.renderHints('md-centers', hintEl);
    else hintEl.innerHTML = '';
  }
  if (!tabLoaded[t]) {
    tabLoaded[t] = true;
    if (t === 'coa') {
      var coaLoaded = loadCoa();
      // Deep-linked from search (global-search-spec.md's account→list follow-up)
      // — pre-filter to the matched row once data is in, reusing the same
      // applyFilterExpr() qualifier grammar the ≡ column filters already use.
      var coaFilter = new URLSearchParams(window.location.search).get('filter');
      if (coaFilter && coaLoaded && coaLoaded.then) coaLoaded.then(function () { coaList.applyFilterExpr('account_code:' + coaFilter); });
    }
    if (t === 'taxcodes') loadTaxCodes();
    if (t === 'journals') loadJournals();
    if (t === 'centers') loadCenters();
  }
  // Integrity re-fetches on every visit (not just the first) — cheap, and the
  // globally-selected period may have changed since the tab was last shown.
  if (t === 'integrity') loadIntegrity();
  updateDownloadHooks(t);
}

// Feed the unified topbar download icon (ia-restructure-3-spec.md §6.3) —
// only Integrity is a "report" here (Chart of Accounts/Tax Codes/Journals/
// Centers are editable registers, not reports, and stay without one).
function updateDownloadHooks(t) {
  if (t === 'integrity') {
    window.__fbDownloadPdfUrl = function () {
      var s = window.FB && FB.period ? FB.period.get() : {};
      if (!s.start || !s.end) return null;
      return '/api/' + COMPANY + '/report?type=integrity&start=' + encodeURIComponent(s.start) + '&end=' + encodeURIComponent(s.end);
    };
    window.__fbDownloadCsv = function () {
      var body = document.getElementById('integrity-body');
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
      var s = window.FB && FB.period ? FB.period.get() : {};
      return { filename: 'integrity_' + (s.start || '') + '_' + (s.end || '') + '.csv', csv: lines.join('\\n') };
    };
  } else {
    window.__fbDownloadPdfUrl = null;
    window.__fbDownloadCsv = null;
  }
}

// ========== INTEGRITY — fetched report fragment, not FB.list ==========
// Same fetch-and-extract technique as reports-hub.js (docs/ia-restructure-3-spec.md
// §1/§3.3): fetch the standalone report page, pull out its .page element via
// DOMParser, inject the markup — no iframe. Uses the globally-selected period
// (FB.period) even though this page's dateRelevance is 'none' for its other
// tabs; the integrity() / integrity_extended() checks are period-range checks
// and need a start/end regardless.
function loadIntegrity() {
  var body = document.getElementById('integrity-body');
  if (!body) return;
  var st = (window.FB && FB.period) ? FB.period.get() : {};
  var start = st.start, end = st.end;
  var dot = document.getElementById('tab-dot-integrity');
  if (!start || !end) {
    body.innerHTML = '<p class="rpt-embed-msg">Select a period first.</p>';
    return;
  }
  body.innerHTML = '<p class="rpt-embed-msg">Loading…</p>';
  fetch('/api/' + COMPANY + '/report?type=integrity&start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end))
    .then(function(r) {
      var ct = r.headers.get('content-type') || '';
      return r.text().then(function(text) { return { ok: r.ok, ct: ct, text: text }; });
    })
    .then(function(r) {
      if (!r.ok || r.ct.indexOf('application/json') === 0) {
        var msg = 'Load failed';
        try { msg = JSON.parse(r.text).error || msg; } catch(e) {}
        body.innerHTML = '<p class="rpt-embed-msg" style="color:var(--danger)">' + esc(msg) + '</p>';
        return;
      }
      var doc = new DOMParser().parseFromString(r.text, 'text/html');
      var pageEl = doc.querySelector('.page');
      if (!pageEl) { body.innerHTML = '<p class="rpt-embed-msg">Report returned no content.</p>'; return; }
      body.innerHTML = pageEl.outerHTML;
      // Dot indicator — a failing check, not "unsaved edits" (the dot's usual
      // meaning on this page's other four tabs). Reused mechanism, distinct
      // color (red vs. the amber dirty-dot) to reduce that ambiguity a little;
      // fully resolving it is an open question (spec §5 item 2).
      var anyFail = Array.from(body.querySelectorAll('td')).some(function(td) { return td.textContent.trim() === 'FAIL'; });
      if (dot) dot.style.display = anyFail ? '' : 'none';
    })
    .catch(function(err) {
      body.innerHTML = '<p class="rpt-embed-msg" style="color:var(--danger)">Load failed: ' + esc(err && err.message ? err.message : 'network error') + '</p>';
    });
}
if (window.FB && FB.period) {
  FB.period.onChange(function () {
    var active = document.querySelector('.tab-panel.active');
    if (active && active.id === 'tab-integrity') loadIntegrity();
  });
}

function showMsg(id, msg, isErr) {
  if (window.FB && FB.status) FB.status.show(msg, isErr);
}

// ========== COA — FB.list ==========
var CF_CATS_COA = ['','Cash','Op-WC','Operating','Tax','Investing','Financing','NonCash','Excluded'];
var ACCT_TYPES = ['Asset','Liability','Equity','Revenue','Expense','Closing'];
var SUBTYPES = ['','Cash and Equivalents','Cost of Goods Sold','Cost of Revenue','Current Assets','Current Liabilities','Depreciation','Equity','Financial Assets','Financial Items','Intangible Assets','Net Result','Non-current Assets','Non-current Liabilities','Operating Expenses','Other Income','Personnel Costs','Revenue','Tangible Assets','Tax'];

var coaList = FB.list.create({
  keysId: 'md-coa',
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
      options: ['', 'AP', 'Expense', 'FX Gain/Loss', 'Cash'],
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

function loadCoa(focusKey) { return coaList.load(focusKey); }
function renderCoaHints() {
  var el = document.getElementById('sb-hints');
  if (el) coaList.renderHints(el);
}

// ========== TAX CODES — merged VAT/GST + WHT in one FB.list =========
// One grid, one tbody. Rows carry a 'type' field ('vat' or 'wht') that drives:
// - which account columns are editable (In Acct + RC read-only for WHT,
//   Out Acct / WHT read-only for VAT)
// - which backend action save/del routes to (vat.codes.* vs wht.codes.*)
// The 'code' field maps to vat_code or wht_code on the backend.
var TAX_TYPES = ['VAT', 'WHT'];
var _taxCfg = {
  keysId: 'acct-taxcodes',
  active: function() { var p = document.getElementById('tab-taxcodes'); return !!(p && p.classList.contains('active')); },
  tbody: 'taxcodes-body',
  companyId: function() { return COMPANY; },
  columns: [
    { field: 'type', type: 'select', width: 50, options: TAX_TYPES, filterType: 'list',
      display: function(v, d) {
        if (!d._dirty) return esc(v === 'wht' ? 'WHT' : (VAT_NAMES[_curJurisdiction] || 'VAT'));
        return esc(v === 'wht' ? 'WHT' : 'VAT');
      },
      ro: 'saved'
    },
    { field: 'code', type: 'text', width: 60, ro: 'saved' },
    { field: 'description', type: 'text', width: 160 },
    { field: 'rate', type: 'number', step: '0.01', width: 55, filterType: 'amount' },
    { field: 'in_acct', type: 'text', width: 70,
      ro: function(d) { return d.type === 'wht'; },
      display: function(v, d) { return d.type === 'wht' ? '' : esc(v || ''); } },
    { field: 'out_wht_acct', type: 'text', width: 70,
      ro: function(d) { return d.type !== 'wht'; },
      display: function(v, d) { return d.type === 'wht' ? esc(v || '') : esc(v || ''); } },
    { field: 'is_reverse_charge', type: 'checkbox', align: 'center',
      ro: function(d) { return d.type === 'wht'; },
      display: function(v, d) { return d.type === 'wht' ? '\u2014' : (v ? 'Yes' : 'No'); } },
    { field: 'report_box', type: 'text', width: 50 },
    { field: 'is_active', type: 'checkbox', align: 'center',
      display: function(v) { return v ? 'Yes' : 'No'; } }
  ],
  blank: function() { return { type: 'vat', code: '', description: '', rate: 0, in_acct: '', out_wht_acct: '', is_reverse_charge: false, report_box: '', is_active: true }; },
  isBlank: function(b) { return !b.code && !b.description; },
  same: function(b, s) {
    return b.type === s.type && b.description === (s.description || '') && b.rate === (s.rate || 0)
      && b.in_acct === (s.in_acct || '') && b.out_wht_acct === (s.out_wht_acct || '')
      && b.report_box === (s.report_box || '') && b.is_reverse_charge === !!s.is_reverse_charge && b.is_active === !!s.is_active;
  },
  validate: function(d) { return d.code ? null : 'Code required'; },
  firstField: function(isNew) { return isNew ? 'code' : 'description'; },
  track: 'tax-code',
  // Load from BOTH endpoints, merge into one row set (list.fetch is supported
  // by FB.list for multi-source registers).
  list: { fetch: function() { return _loadTaxCodes(); },
    map: function(r) { return r; } },
  // Save/del: FB.list calls post(cfg.save.action, cfg.save.body(d)) — the action
  // string is read from the config object at call time. We mutate _taxCfg.save.action
  // / _taxCfg.del.action per-row in onSaveStart / confirm() to route correctly.
  save: { action: 'vat.codes.upsert',
    body: function(d) {
      if (d.type === 'wht') {
        return { whtCode: { wht_code: d._isNew ? d.code : d._key.replace(/^wht:/, ''), description: d.description || null, rate: d.rate || 0, wht_account: d.out_wht_acct || null, report_box: d.report_box || null, is_active: !!d.is_active } };
      }
      return { vatCode: { vat_code: d._isNew ? d.code : d._key.replace(/^vat:/, ''), description: d.description || null, rate: d.rate || 0, input_account: d.in_acct || null, output_account: d.out_wht_acct || null, report_box: d.report_box || null, is_reverse_charge: !!d.is_reverse_charge, is_active: !!d.is_active } };
    },
    focusKey: function(d) { return d._key; },
    onSaveStart: function(d) {
      _taxCfg.save.action = d.type === 'wht' ? 'wht.codes.upsert' : 'vat.codes.upsert';
    } },
  del: { action: 'vat.codes.delete',
    body: function(d) {
      if (d.type === 'wht') return { whtCode: d._key.replace(/^wht:/, '') };
      return { vatCode: d._key.replace(/^vat:/, '') };
    },
    confirm: function(d) {
      _taxCfg.del.action = d.type === 'wht' ? 'wht.codes.delete' : 'vat.codes.delete';
      return 'Delete tax code "' + d.code + '"?';
    },
    deleted: 'Deleted' },
  onChrome: function(dirty) {
    var dot = document.getElementById('tab-dot-taxcodes');
    if (dot) dot.style.display = dirty ? '' : 'none';
    if (dirty) markDirty('taxcodes'); else resetDirty('taxcodes');
  }
};
var taxCodesList = FB.list.create(_taxCfg);

var _curJurisdiction = 'SE';

function _loadTaxCodes() {
  return Promise.all([
    fetch('/api/' + COMPANY + '/vat-codes').then(function(r) { return r.json(); }),
    fetch('/api/' + COMPANY + '/wht-codes').then(function(r) { return r.json(); })
  ]).then(function(results) {
    var vatRows = Array.isArray(results[0]) ? results[0] : (results[0].rows || []);
    var whtRows = Array.isArray(results[1]) ? results[1] : (results[1].rows || []);
    var merged = [];
    for (var i = 0; i < vatRows.length; i++) {
      var v = vatRows[i];
      merged.push({
        type: 'vat', code: v.vat_code, description: v.description || '', rate: v.rate || 0,
        in_acct: v.vat_account_input || v.input_account || '', out_wht_acct: v.vat_account_output || v.output_account || '',
        is_reverse_charge: !!v.is_reverse_charge, report_box: v.report_box || '', is_active: !!v.is_active,
        _key: 'vat:' + v.vat_code
      });
    }
    for (var j = 0; j < whtRows.length; j++) {
      var w = whtRows[j];
      merged.push({
        type: 'wht', code: w.wht_code, description: w.description || '', rate: w.rate || 0,
        in_acct: '', out_wht_acct: w.wht_account || '',
        is_reverse_charge: false, report_box: w.report_box || '', is_active: !!w.is_active,
        _key: 'wht:' + w.wht_code
      });
    }
    return merged;
  });
}

function loadTaxCodes(focusKey) { taxCodesList.load(focusKey); }

function renderTaxHints() {
  var el = document.getElementById('sb-hints');
  if (el) {
    taxCodesList.renderHints(el);
  }
}

// ========== JOURNALS — FB.list ==========
var journalsList = FB.list.create({
  keysId: 'md-journals',
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

// ========== COST/PROFIT CENTERS — FB.list ==========
var centersList = FB.list.create({
  keysId: 'md-centers',
  active: function() { var p = document.getElementById('tab-centers'); return !!(p && p.classList.contains('active')); },
  tbody: 'centers-body',
  companyId: function() { return COMPANY; },
  columns: [
    { field: 'center_id', type: 'text', width: 120, ro: 'saved' },
    { field: 'name', type: 'text', width: 200 },
    { field: 'center_type', type: 'select', width: 90, options: ['Cost', 'Profit'], filterType: 'list',
      display: function(v) { return v ? v : '—'; },
      onChange: function(row, val) {
        // Profit centers don't have a profit_center_id; clear it when switching to Profit.
        if (val === 'Profit') row.profit_center_id = '';
      }
    },
    { field: 'profit_center_id', type: 'select', width: 140,
      options: function() { return centersProfitCenterOptions; },
      display: function(v, row) {
        if (row && row.center_type === 'Profit') return '';
        return v ? (centersProfitCenterNames[v] || v) : '—';
      },
      visible: function(row) { return !row || row.center_type !== 'Profit'; }
    },
    { field: 'is_active', type: 'checkbox', align: 'center',
      display: function(v) { return v ? 'Yes' : 'No'; } }
  ],
  blank: function() { return { center_id: '', name: '', center_type: 'Cost', is_active: true, profit_center_id: '' }; },
  isBlank: function(b) { return !b.center_id && !b.name; },
  same: function(b, s) {
    return b.name === (s.name || '') && b.center_type === (s.center_type || 'Cost') && b.is_active === !!s.is_active
      && (b.profit_center_id || '') === (s.profit_center_id || '');
  },
  validate: function(d) { return d.center_id ? null : 'Center ID required'; },
  firstField: function(isNew) { return isNew ? 'center_id' : 'name'; },
  track: 'center',
  list: { action: 'center.list',
    map: function(c) { return {
      center_id: c.center_id,
      name: c.name || '',
      center_type: c.center_type || 'Cost',
      profit_center_id: c.profit_center_id || '',
      is_active: c.is_active !== false,
      _key: c.center_id
    }; } },
  save: { action: 'center.upsert',
    body: function(d) { return { center: {
      center_id: d._isNew ? d.center_id : d._key,
      center_type: d.center_type || 'Cost',
      name: d.name || '',
      profit_center_id: (d.center_type === 'Cost' && d.profit_center_id) ? d.profit_center_id : null,
      is_active: d.is_active !== false
    } }; },
    focusKey: function(d) { return d._isNew ? d.center_id : d._key; } },
  del: { action: 'center.delete',
    body: function(d) { return { centerId: d._key }; },
    confirm: function(d) { return 'Delete center "' + d.center_id + '"?'; } },
  onChrome: function(dirty) {
    var dot = document.getElementById('tab-dot-centers');
    if (dot) dot.style.display = dirty ? '' : 'none';
    if (dirty) markDirty('centers'); else resetDirty('centers');
  }
});

// Cache profit-center options for the dropdown (loaded alongside center.list).
var centersProfitCenterOptions = [];
var centersProfitCenterNames = {};
function refreshProfitCenterOptions(centers) {
  centersProfitCenterOptions = [];
  centersProfitCenterNames = {};
  for (var i = 0; i < centers.length; i++) {
    var c = centers[i];
    if (c.center_type === 'Profit') {
      centersProfitCenterOptions.push(c.center_id);
      centersProfitCenterNames[c.center_id] = c.name || c.center_id;
    }
  }
}
var _originalLoadCenters = function(focusKey) { centersList.load(focusKey); };
function loadCenters(focusKey) {
  _originalLoadCenters(focusKey).then(function() {
    // After the list loads, refresh the profit center options from the raw data.
    var rows = centersList._raw || [];
    refreshProfitCenterOptions(rows);
  }).catch(function() {});
}

// ========== UNSAVED CHANGES PROTECTION ==========
window.onbeforeunload = function(e) {
  if (dirtyTabs.size > 0) {
    var msg = 'You have unsaved changes.';
    e.returnValue = msg;
    return msg;
  }
};

// ========== JURISDICTION-BASED VAT LABEL (SG→GST, SE→VAT) ==========
function loadCompanyJurisdiction() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'company.attr.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var data = res.data || res;
      var rows = Array.isArray(data) ? data : (data.rows || []);
      var byKey = {};
      rows.forEach(function(r) { byKey[r.key] = r; });
      if (byKey.jurisdiction && byKey.jurisdiction.value) {
        _curJurisdiction = byKey.jurisdiction.value;
        var vn = VAT_NAMES[byKey.jurisdiction.value] || 'Tax';
        var lbl = document.getElementById('tab-taxcodes-label');
        if (lbl) lbl.innerHTML = 'Tax Codes<span id="tab-dot-taxcodes" style="display:none;color:var(--warning)"> \u25cf</span>';
      }
    })
    .catch(function(){});
}

// ========== INIT ==========
(function() {
  var params = new URLSearchParams(window.location.search);
  var tab = params.get('tab');
  // Restore last-active tab from sessionStorage unless a ?tab= deep link overrides.
  var stored = '';
  try { stored = sessionStorage.getItem('accounting-last-tab') || ''; } catch(e) {}
  var initial = tab || stored || 'coa';
  var valid = ['coa','taxcodes','journals','centers','integrity'];
  if (valid.indexOf(initial) < 0) initial = 'coa';
  loadCompanyJurisdiction();
  showTab(initial);
})();
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleAccountingPage };
