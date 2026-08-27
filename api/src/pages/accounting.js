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
  .pe-ro { color:#888; }
  tr.row-dirty > td:first-child { box-shadow: inset 3px 0 0 #d97706; }
  .dirty-val { color:#b45309; }
  tr.row-editing > td { background:#fffbeb; }
  .row-actions { white-space:nowrap; text-align:right; }
  .type-badge { display:inline-block; padding:1px 7px; border-radius:3px; font-size:9pt; font-weight:600; }
  .subhead { font-size:11pt; font-weight:700; color:#1a1a1a; margin:18px 0 6px; }
  .subhead:first-child { margin-top:0; }
</style>
</head>
<body>${navBar(company, 'accounting')}
<div class="page">
  <div class="header">
    <h1>📊 Accounting</h1>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="showTab('coa')">Chart of Accounts<span id="tab-dot-coa" style="display:none;color:#d97706"> ●</span></div>
    <div class="tab" id="tab-taxcodes-label" onclick="showTab('taxcodes')">Tax Codes<span id="tab-dot-taxcodes" style="display:none;color:#d97706"> ●</span></div>
    <div class="tab" onclick="showTab('journals')">Journals<span id="tab-dot-journals" style="display:none;color:#d97706"> ●</span></div>
    <div class="tab" onclick="showTab('centers')">Cost/Profit Centers<span id="tab-dot-centers" style="display:none;color:#d97706"> ●</span></div>
  </div>

  <!-- COA TAB -->
  <div id="tab-coa" class="tab-panel active">
    <table class="edit-table" id="coa-table">
      <thead><tr><th>Code</th><th>Account Name</th><th>Type</th><th>Subtype</th><th>CF Category</th><th>Active</th><th>Default</th><th>Start</th><th></th></tr></thead>
      <tbody id="coa-body"></tbody>
    </table>
  </div>

  <!-- TAX CODES TAB (merged: VAT/GST + WHT as two sub-grids) -->
  <div id="tab-taxcodes" class="tab-panel">
    <div class="subhead" id="tax-vat-head">VAT / GST Codes</div>
    <table class="edit-table" id="vat-table">
      <thead><tr><th>Code</th><th>Description</th><th>Rate %</th><th>Input Acct</th><th>Output Acct</th><th>Report Box</th><th style="text-align:center">Rev.Chg</th><th style="text-align:center">Active</th><th></th></tr></thead>
      <tbody id="vat-body"></tbody>
    </table>
    <div class="subhead">WHT Codes</div>
    <table class="edit-table" id="wht-table">
      <thead><tr><th>Code</th><th>Description</th><th>Rate %</th><th>Payable Acct</th><th>Report Box</th><th style="text-align:center">Active</th><th></th></tr></thead>
      <tbody id="wht-body"></tbody>
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
      if (!confirm('You have unsaved changes. Discard?')) return;
      resetDirty(curTab);
    }
  }
  var tabs = ['coa','taxcodes','journals','centers'];
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
    if (t === 'coa') loadCoa();
    if (t === 'taxcodes') { loadVat(); loadWht(); }
    if (t === 'journals') loadJournals();
    if (t === 'centers') loadCenters();
  }
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

function loadCoa(focusKey) { coaList.load(focusKey); }
function renderCoaHints() {
  var el = document.getElementById('sb-hints');
  if (el) coaList.renderHints(el);
}

// ========== VAT/GST CODES — FB.list ==========
var vatList = FB.list.create({
  keysId: 'md-vat',
  active: function() { var p = document.getElementById('tab-taxcodes'); return !!(p && p.classList.contains('active')); },
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
    var dot = document.getElementById('tab-dot-taxcodes');
    if (dot) dot.style.display = dirty ? '' : 'none';
    if (dirty) markDirty('taxcodes'); else resetDirty('taxcodes');
  }
});

function loadVat(focusKey) { vatList.load(focusKey); }

// ========== WHT CODES — FB.list ==========
var whtList = FB.list.create({
  keysId: 'md-wht',
  active: function() { var p = document.getElementById('tab-taxcodes'); return !!(p && p.classList.contains('active')); },
  tbody: 'wht-body',
  companyId: function() { return COMPANY; },
  columns: [
    { field: 'wht_code', type: 'text', width: 60, ro: 'saved' },
    { field: 'description', type: 'text', width: 160 },
    { field: 'rate', type: 'number', step: '0.01', width: 55, filterType: 'amount' },
    { field: 'wht_account', type: 'text', width: 70 },
    { field: 'report_box', type: 'text', width: 50 },
    { field: 'is_active', type: 'checkbox', align: 'center',
      display: function(v) { return v ? 'Yes' : 'No'; } }
  ],
  blank: function() { return { wht_code: '', description: '', rate: 0, wht_account: '', report_box: '', is_active: true }; },
  isBlank: function(b) { return !b.wht_code && !b.description && !b.wht_account; },
  same: function(b, s) {
    return b.description === (s.description || '') && b.rate === (s.rate || 0)
      && b.wht_account === (s.wht_account || '') && b.report_box === (s.report_box || '') && b.is_active === !!s.is_active;
  },
  validate: function(d) { return d.wht_code ? null : 'WHT code required'; },
  firstField: function(isNew) { return isNew ? 'wht_code' : 'description'; },
  track: 'tax-code',
  list: { url: function() { return '/api/' + COMPANY + '/wht-codes'; },
    map: function(w) { return { wht_code: w.wht_code, description: w.description || '', rate: w.rate || 0, wht_account: w.wht_account || '', report_box: w.report_box || '', is_active: !!w.is_active, _key: w.wht_code }; } },
  save: { action: 'wht.codes.upsert',
    body: function(d) { return { whtCode: { wht_code: d._isNew ? d.wht_code : d._key, description: d.description || null, rate: d.rate || 0, wht_account: d.wht_account || null, report_box: d.report_box || null, is_active: !!d.is_active } }; },
    focusKey: function(d) { return d._isNew ? d.wht_code : d._key; } },
  del: { action: 'wht.codes.delete',
    body: function(d) { return { whtCode: d._key }; },
    confirm: function(d) { return 'Delete WHT code "' + d.wht_code + '"?'; } },
  onChrome: function(dirty) {
    var dot = document.getElementById('tab-dot-taxcodes');
    if (dot) dot.style.display = dirty ? '' : 'none';
    if (dirty) markDirty('taxcodes'); else resetDirty('taxcodes');
  }
});

function loadWht(focusKey) { whtList.load(focusKey); }

function renderTaxHints() {
  var el = document.getElementById('sb-hints');
  if (el) {
    // Show VAT hints by default; both lists share the tax-code track.
    vatList.renderHints(el);
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
        var vn = VAT_NAMES[byKey.jurisdiction.value] || 'Tax';
        var head = document.getElementById('tax-vat-head');
        if (head) head.textContent = vn + ' Codes';
        var lbl = document.getElementById('tab-taxcodes-label');
        if (lbl) lbl.innerHTML = vn + '/WHT Codes<span id="tab-dot-taxcodes" style="display:none;color:#d97706"> ●</span>';
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
  var valid = ['coa','taxcodes','journals','centers'];
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
