'use strict';
const { makeQuery, commonStyle, navBar, layoutEnd } = require('./common');

async function handleMasterDataPage(req, res) {
  const { company } = req.params;
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildMasterDataPage(company));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function buildMasterDataPage(company) {
  const cfOptions = ['','Cash','Op-WC','Operating','Tax','Investing','Financing','NonCash','Excluded']
    .map(v => `<option value="${v}">${v || '- none -'}</option>`).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Master Data - freeBooks</title>
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
  .search-bar { padding:6px 10px; border:1px solid #ccc; border-radius:4px; font-size:10pt; margin-bottom:12px; width:260px; }
  /* Modal-edit doctrine (docs/settings-ux-spec.md) */
  #tab-coa tbody td, #tab-vat tbody td, #tab-journals tbody td, #tab-centers tbody td { cursor:text; }
  tr.row-dirty > td:first-child { box-shadow: inset 3px 0 0 #d97706; }
  .dirty-val { color:#b45309; }
  tr.row-editing > td { background:#fffbeb; }
  .row-actions { white-space:nowrap; text-align:right; }
  .pe-ro { color:#888; }
  .type-badge { display:inline-block; padding:1px 7px; border-radius:3px; font-size:9pt; font-weight:600; }

  /* Partners tab */
  .partner-cell { display:inline-flex; align-items:center; gap:10px; }
  .badge { display:inline-block; padding:3px 10px; border-radius:20px; font-size:0.75rem; font-weight:600; }
  #partners-body input { font-family:'Helvetica Neue',Arial,sans-serif !important; font-size:inherit !important; }
  .fb-dd { font-family:'Helvetica Neue',Arial,sans-serif; }
</style>
</head>
<body>${navBar(company, 'master-data')}
<div class="page">
  <div class="header">
    <h1>🗂 Master Data</h1>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="showTab('partners')">Partners<span id="tab-dot-partners" style="display:none;color:#d97706"> ●</span></div>
    <div class="tab" onclick="showTab('coa')">Chart of Accounts<span id="tab-dot-coa" style="display:none;color:#d97706"> ●</span></div>
    <div class="tab" id="tab-vat-label" onclick="showTab('vat')">Tax Codes<span id="tab-dot-vat" style="display:none;color:#d97706"> ●</span></div>
    <div class="tab" onclick="showTab('journals')">Journals<span id="tab-dot-journals" style="display:none;color:#d97706"> ●</span></div>
    <div class="tab" id="tab-fxrates-label" onclick="showTab('fxrates')">Exchange Rates</div>
    <div class="tab" onclick="showTab('centers')">Cost/Profit Centers<span id="tab-dot-centers" style="display:none;color:#d97706"> ●</span></div>
  </div>

  <!-- PARTNERS TAB -->
  <div id="tab-partners" class="tab-panel active">
    <table class="edit-table" id="partners-table">
      <thead><tr><th>Partner</th><th style="width:70px;text-align:center">CCY</th><th style="width:110px;text-align:center">Terms (d)</th><th style="width:140px">Expense A/C</th><th style="width:140px">AP A/C</th><th style="width:60px;text-align:center">Vendor</th><th style="width:60px;text-align:center">Customer</th><th style="width:90px;text-align:center">Active</th></tr></thead>
      <tbody id="partners-body">
        <tr><td colspan="8" style="text-align:center;color:#aaa;padding:32px">Loading&#8230;</td></tr>
      </tbody>
    </table>
    <div style="margin-top:10px;display:flex;gap:12px;align-items:center">
      <span id="msg-partners" style="font-size:0.875rem"></span>
    </div>
  </div>

  <!-- COA TAB -->
  <div id="tab-coa" class="tab-panel">
    <table class="edit-table" id="coa-table">
      <thead><tr><th>Code</th><th>Account Name</th><th>Type</th><th>Subtype</th><th>CF Category</th><th>Active</th><th>Default</th><th>Start</th><th></th></tr></thead>
      <tbody id="coa-body"></tbody>
    </table>
  </div>

  <!-- TAX CODES TAB -->
  <div id="tab-vat" class="tab-panel">
    <table class="edit-table" id="vat-table">
      <thead><tr><th>Code</th><th>Description</th><th>Rate %</th><th>Input Acct</th><th>Output Acct</th><th>Report Box</th><th style="text-align:center">Rev.Chg</th><th style="text-align:center">Active</th><th></th></tr></thead>
      <tbody id="vat-body"></tbody>
    </table>
  </div>

  <!-- JOURNALS TAB -->
  <div id="tab-journals" class="tab-panel">
    <table class="edit-table" id="journals-table">
      <thead><tr><th>Code</th><th>Name</th><th style="text-align:center">Active</th><th></th></tr></thead>
      <tbody id="journals-body"></tbody>
    </table>
  </div>

  <!-- EXCHANGE RATES TAB -->
  <div id="tab-fxrates" class="tab-panel">
    <table class="edit-table" id="fx-rates-table">
      <thead><tr><th>Date</th><th>From</th><th>To</th><th style="text-align:right">Rate</th><th>Source</th><th></th></tr></thead>
      <tbody id="fx-rates-body"></tbody>
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

// Relevance-flag gating (settings-ux-spec §7 item 9 + fx-automation-spec §1):
// vat_registered=false hides Tax Codes; fx_tracking='false' hides Exchange Rates.
// Tabs stay in the DOM (display:none) so showTab's index math is unaffected;
// h/l skips them via common.js. If the active tab becomes hidden, fall back.
var _relevanceState = { vat_registered: true, fx_tracking: 'false' };
function applyRelevanceFlags(c) {
  if (c) {
    if (c.vat_registered !== undefined) _relevanceState.vat_registered = c.vat_registered;
    if (c.fx_tracking !== undefined) _relevanceState.fx_tracking = c.fx_tracking;
  }
  var vatOn = _relevanceState.vat_registered !== false;
  var fxOn = _relevanceState.fx_tracking === 'true';
  var vatTab = document.getElementById('tab-vat-label');
  var fxTab = document.getElementById('tab-fxrates-label');
  if (vatTab) vatTab.style.display = vatOn ? '' : 'none';
  if (fxTab) fxTab.style.display = fxOn ? '' : 'none';
  var active = document.querySelector('.tab-panel.active');
  if (active && ((active.id === 'tab-vat' && !vatOn) || (active.id === 'tab-fxrates' && !fxOn))) {
    showTab('partners');
  }
}

function showTab(t) {
  var labelEl = document.getElementById(t === 'vat' ? 'tab-vat-label' : (t === 'fxrates' ? 'tab-fxrates-label' : ''));
  if (labelEl && labelEl.style.display === 'none') return;
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
  var tabs = ['partners','coa','vat','journals','fxrates','centers'];
  document.querySelectorAll('.tab').forEach(function(el,i){ el.classList.toggle('active', tabs[i]===t); });
  document.querySelectorAll('.tab-panel').forEach(function(el){ el.classList.remove('active'); });
  document.getElementById('tab-'+t).classList.add('active');
  var hintEl = document.getElementById('sb-hints');
  if (hintEl) {
    if (t === 'partners') FB.keys.renderHints('partners', hintEl);
    else if (t === 'coa') renderCoaHints();
    else if (t === 'vat') renderVatHints();
    else if (t === 'journals') renderJournalHints();
    else if (t === 'fxrates') FB.keys.renderHints('md-fxrates', hintEl, { layout: 'list' });
    else if (t === 'centers') FB.keys.renderHints('md-centers', hintEl);
    else hintEl.innerHTML = '';
  }
  if (!tabLoaded[t]) {
    tabLoaded[t] = true;
    if (t === 'partners')  { loadPartners(); }
    if (t === 'coa')      { loadCoa(); }
    if (t === 'vat')      { loadVat(); }
    if (t === 'journals') { loadJournals(); }
    if (t === 'fxrates')  { loadFxRates(); loadBaseCurrencies(); }
    if (t === 'centers')  { loadCenters(); }
  }
}

function showMsg(id, msg, isErr) {
  if (window.FB && FB.status) FB.status.show(msg, isErr);
}

// ========== PARTNERS — FB.list (relocated from payables-partners.js) =========
var partnerAccountsList = [];
var partnerCurrenciesList = [];
window.allPartners = []; // read by payables-bills.js bill partner dropdown

function loadPartnerAccounts() {
  if (partnerAccountsList.length) return;
  fetch('/api/' + COMPANY + '/accounts').then(function(r){ return r.json(); }).then(function(rows){
    partnerAccountsList = Array.isArray(rows) ? rows : [];
  }).catch(function(){});
}
function loadPartnerCurrencies() {
  if (partnerCurrenciesList.length) return;
  fetch('/db/currencies.json').then(function(r){ return r.json(); }).then(function(list){
    partnerCurrenciesList = Array.isArray(list) ? list : [];
  }).catch(function(){});
}

function partnerAttachCcy(inp) {
  loadPartnerCurrencies();
  FB.dropdown.attach(inp, {
    source: function(q) {
      q = (q || '').trim().toLowerCase();
      return partnerCurrenciesList.filter(function(c) {
        if (!q) return true;
        return (c.code || '').toLowerCase().indexOf(q) >= 0 ||
               (c.name || '').toLowerCase().indexOf(q) >= 0;
      }).map(function(c) {
        return { primary: (c.code || '').toUpperCase(), secondary: c.name || '', data: { code: (c.code || '').toUpperCase() } };
      });
    },
    onPick: function(item, input) {
      input.value = item.data.code;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}
function partnerAttachAcct(inp) {
  loadPartnerAccounts();
  FB.dropdown.attach(inp, {
    source: function(q) {
      q = (q || '').trim().toLowerCase();
      return partnerAccountsList.filter(function(a) {
        if (!q) return true;
        return (a.account_code || '').toLowerCase().indexOf(q) >= 0 ||
               (a.account_name || '').toLowerCase().indexOf(q) >= 0;
      }).map(function(a) {
        return { primary: a.account_code, secondary: a.account_name || '', data: { code: a.account_code } };
      });
    },
    onPick: function(item, input) {
      input.value = item.data.code;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

function partnerMsg(msg, type) {
  var el = document.getElementById('msg-partners');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'err' ? '#cc2222' : type === 'ok' ? '#2a8a2a' : '#888';
}

function partnerActiveBadge(v) {
  return v !== false
    ? '<span class="badge" style="background:#f0fff4;color:#2a8a2a">Active</span>'
    : '<span class="badge" style="background:#f0f0f0;color:#888">Inactive</span>';
}

var partnersList = FB.list.create({
  keysId: 'partners',
  active: function() {
    var panel = document.getElementById('tab-partners');
    return !!(panel && panel.classList.contains('active'));
  },
  tbody: 'partners-body',
  companyId: function() { return COMPANY; },
  focusClass: 'bill-row-focus',
  columns: [
    { field: 'name', type: 'text', width: 180 },
    { field: 'default_currency', type: 'text', width: 40, align: 'center', uppercase: true, attach: partnerAttachCcy, filterType: 'list' },
    { field: 'payment_terms_days', type: 'number', width: 55, align: 'center', filterType: 'amount' },
    { field: 'default_expense_account', type: 'text', width: 130, attach: partnerAttachAcct },
    { field: 'default_ap_account', type: 'text', width: 130, attach: partnerAttachAcct },
    { field: 'is_vendor', type: 'checkbox', align: 'center', width: 50, display: function(v) { return v !== false ? 'V' : '\\u2014'; } },
    { field: 'is_customer', type: 'checkbox', align: 'center', width: 50, display: function(v) { return v === true ? 'C' : '\\u2014'; } },
    { field: 'is_active', type: 'checkbox', align: 'center', ro: 'always', display: partnerActiveBadge }
  ],
  blank: function() { return { name: '', default_currency: '', payment_terms_days: 30, default_expense_account: '', default_ap_account: '', is_vendor: true, is_customer: false, is_active: true }; },
  isBlank: function(b) { return !b.name; },
  same: function(b, s) {
    return b.name === (s.name || '')
      && b.default_currency === (s.default_currency || '')
      && b.payment_terms_days === (s.payment_terms_days != null ? s.payment_terms_days : 30)
      && b.default_expense_account === (s.default_expense_account || '')
      && b.default_ap_account === (s.default_ap_account || '')
      && (b.is_vendor !== false) === (s.is_vendor !== false)
      && (b.is_customer === true) === (s.is_customer === true);
  },
  validate: function(d) {
    if (!d.name) return 'Partner name required.';
    if (d.default_currency && partnerCurrenciesList.length) {
      var ok = partnerCurrenciesList.some(function(c){ return (c.code || '').toUpperCase() === d.default_currency; });
      if (!ok) return 'Unknown currency: ' + d.default_currency;
    }
    return null;
  },
  firstField: function() { return 'name'; },
  track: 'partner',
  list: { action: 'partner.list',
    map: function(v) { return { partner_id: v.partner_id, name: v.name || '', default_currency: v.default_currency || '', payment_terms_days: v.payment_terms_days != null ? v.payment_terms_days : 30, default_expense_account: v.default_expense_account || '', default_ap_account: v.default_ap_account || '', is_vendor: v.is_vendor !== false, is_customer: v.is_customer === true, is_active: v.is_active !== false, _key: v.partner_id }; } },
  onLoaded: function(saved) { window.allPartners = saved; },
  save: { action: 'partner.upsert',
    body: function(d) { return { partner: { partner_id: d._isNew ? null : d._key, name: d.name, default_currency: d.default_currency || null, payment_terms_days: parseInt(d.payment_terms_days, 10) || 30, default_expense_account: d.default_expense_account || null, default_ap_account: d.default_ap_account || null, is_vendor: d.is_vendor !== false, is_customer: d.is_customer === true, is_active: d.is_active !== false } }; },
    focusKey: function(d, res) { return d._isNew ? (res.partnerId || d._key) : d._key; } },
  del: { action: 'partner.delete',
    body: function(d) { return { partnerId: d._key }; },
    confirm: function(d) { return 'Delete partner "' + (d.name || d._key) + '"?'; } },
  extraBindings: function(api) {
    return [
      { key: '~', mode: 'NORMAL', hint: 'toggle active', hintBar: true,
        when: function() { var d = api.focusedRow(); return !!(d && !d._isNew); },
        run: function() {
          var d = api.focusedRow();
          if (!d || d._isNew) return;
          var v = { partner_id: d._key, name: d.name, default_currency: d.default_currency || null,
            payment_terms_days: d.payment_terms_days != null ? d.payment_terms_days : 30,
            default_expense_account: d.default_expense_account || null,
            default_ap_account: d.default_ap_account || null,
            is_vendor: d.is_vendor !== false, is_customer: d.is_customer === true,
            is_active: d.is_active === false };
          fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ action:'partner.upsert', companyId: COMPANY, partner: v }) })
            .then(function(r){ return r.json(); })
            .then(function(res){
              var dd = res.data || res;
              if (dd.error || res.error) { partnerMsg((dd.error && dd.error.message) || dd.error || res.error, 'err'); return; }
              partnerMsg(v.is_active ? 'Marked active.' : 'Marked inactive.', 'ok');
              setTimeout(function(){ partnerMsg('', ''); }, 1500);
              api.load(d._key);
            })
            .catch(function(e){ partnerMsg(e.message, 'err'); });
        } }
    ];
  }
});

function loadPartners() { partnersList.load(); loadPartnerCurrencies(); }

// Hover suppression while a row is being edited (matches bills tbody).
FB.mode.onChange(function(m) {
  var tb = document.getElementById('partners-body');
  if (tb) tb.classList.toggle('insert-mode', m === 'INSERT');
});

// ========== COA — FB.list (relocated from settings.js) ==========
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
      options: ['', 'AP', 'Expense', 'FX Gain/Loss'],
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

// ========== VAT/GST CODES — FB.list (relocated from settings.js) ==========
var vatList = FB.list.create({
  keysId: 'md-vat',
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

// ========== JOURNALS — FB.list (relocated from settings.js) ==========
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

// ========== EXCHANGE RATES — FB.list (relocated from settings.js) ==========
var fxList = FB.list.create({
  keysId: 'md-fxrates',
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
        var p = String(d._key).split('|');
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
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

// ========== COST/PROFIT CENTERS — FB.list (new) ==========
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

// ========== COMPANY + POSTING RULES EAGER LOAD (relevance flags) ==========
// Company attrs (vat_registered) and Posting Rules (fx_tracking) drive tab
// visibility. Load both eagerly so flags resolve before any tab renders.
function loadCompanyFlags() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'company.attr.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var data = res.data || res;
      var rows = Array.isArray(data) ? data : (data.rows || []);
      var byKey = {};
      rows.forEach(function(r) { byKey[r.key] = r; });
      window._companyCurrency = byKey.currency ? byKey.currency.value : '';
      applyRelevanceFlags({
        vat_registered: byKey.vat_registered ? !!byKey.vat_registered.value : true
      });
      // Update VAT tab label based on jurisdiction
      if (byKey.jurisdiction && byKey.jurisdiction.value) {
        var vn = VAT_NAMES[byKey.jurisdiction.value] || 'Tax';
        var lbl = document.getElementById('tab-vat-label');
        if (lbl) lbl.innerHTML = vn + ' Codes<span id="tab-dot-vat" style="display:none;color:#d97706"> ●</span>';
      }
    })
    .catch(function(){});
}

function loadPostRulesFlags(cb) {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'posting_rules.attr.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var data = res.data || res;
      var rows = Array.isArray(data) ? data : (data.rows || []);
      var byKey = {};
      rows.forEach(function(r) { byKey[r.key] = r; });
      applyRelevanceFlags({
        fx_tracking: (byKey.multi_currency && byKey.multi_currency.value === true) ? 'true' : 'false'
      });
      if (cb) cb();
    })
    .catch(function(){ if (cb) cb(); });
}

// ========== HANDLE ?tab= URL PARAM ==========
(function() {
  var params = new URLSearchParams(window.location.search);
  var tab = params.get('tab');
  loadCurrencyList();
  // Eager-load Company + Posting Rules for relevance flags.
  // showTab is deferred until after flags resolve so that a ?tab=fxrates
  // deep link doesn't bail out because the tab is still display:none.
  loadCompanyFlags();
  loadPostRulesFlags(function() {
    showTab(tab || 'partners');
  });
})();
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleMasterDataPage };
