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
      </div>
    </div>

  </div>

  <!-- COA TAB -->
  <div id="tab-coa" class="tab-panel">
    <table class="edit-table" id="coa-table">
      <thead><tr><th>Code</th><th>Account Name</th><th>Type</th><th>Subtype</th><th>CF Category</th><th>Active</th><th>Default</th><th></th></tr></thead>
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

  <!-- VAT/GST CODES TAB -->
  <div id="tab-vat" class="tab-panel">
    <table class="edit-table" id="vat-table">
      <thead><tr><th>Code</th><th>Description</th><th>Rate %</th><th>Input Acct</th><th>Output Acct</th><th>Report Box</th><th style="text-align:center">Rev.Chg</th><th style="text-align:center">Active</th><th></th></tr></thead>
      <tbody id="vat-body"></tbody>
    </table>
  </div>

  <!-- EXCHANGE RATES TAB -->
  <div id="tab-fxrates" class="tab-panel">
    <!-- FX provider config — read-first panel (settings-ux-spec §7 item 5 rev 2026-07-27).
         Installation-scoped, lives here next to the 📡 Fetch Rates action it configures.
         Read mode: provider name + whether an API key is set, as TEXT. Edit mode: select +
         (conditional) API-key input behind an explicit Save button (Esc never saves).
         Sits OUTSIDE the FB.list tbody tree so the rates register and its single-key verbs
         run unmodified; the framework's editable-target focus guard keeps verbs inert while
         this panel's inputs have focus. -->
    <div id="fx-provider-panel" class="fx-provider-panel"
         style="margin-bottom:14px;padding:12px 16px;background:#f8f9fa;border-radius:6px;border:1px solid #e0e0e0">
      <div class="fxp-read" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <div style="font-weight:600">FX Provider</div>
        <div id="fxp-read-provider" style="font-size:10pt;color:#333">—</div>
        <div id="fxp-read-key" style="font-size:9pt;color:#666"></div>
        <button type="button" class="btn-sm fxp-edit-btn" onclick="fxProviderPanel.edit()">Edit</button>
      </div>
      <div id="fxp-edit" class="fxp-edit" style="display:none;flex-direction:column;gap:10px">
        <div class="field-row" style="margin-bottom:0">
          <label for="fxp-select">Provider</label>
          <select id="fxp-select" onchange="fxProviderPanel.onSelectChange()" style="max-width:300px"></select>
        </div>
        <div id="fxp-key-row" class="field-row" style="display:none;margin-bottom:0">
          <label id="fxp-key-label">API Key</label>
          <input type="password" id="fxp-key" placeholder="Enter API key" style="max-width:300px">
        </div>
        <div id="fxp-desc" style="font-size:9pt;color:#666"></div>
        <div style="display:flex;gap:10px">
          <button type="button" class="btn-sm" id="fxp-save-btn" onclick="fxProviderPanel.save()">Save Provider</button>
          <button type="button" class="btn-sm" onclick="fxProviderPanel.cancel()">Cancel</button>
        </div>
      </div>
    </div>
    <table class="edit-table" id="fx-rates-table">
      <thead><tr><th>Date</th><th>From</th><th>To</th><th style="text-align:right">Rate</th><th>Source</th><th></th></tr></thead>
      <tbody id="fx-rates-body"></tbody>
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

function showTab(t) {
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
    if (t === 'company')  { loadCompanies(); }
    if (t === 'periods')  { loadPeriods(); }
    if (t === 'coa')      { loadCoa(); }
    if (t === 'vat')      { loadVat(); }
    if (t === 'journals') { loadJournals(); }
    if (t === 'fxrates')  { loadFxRates(); loadBaseCurrencies(); fxProviderPanel.load(); }
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

// ========== PERIODS — FB.list (P3 consolidated) ==========
// Esc never saves: it exits edit mode leaving a dirty buffer; w writes,
// u reverts. Period names are immutable on saved rows (server upsert keys on
// period_name — rename needs delete+create; a deliberate feature later).
var periodsList = FB.list.create({
  keysId: 'settings-periods',
  active: function() { var p = document.getElementById('tab-periods'); return !!(p && p.classList.contains('active')); },
  tbody: 'periods-body',
  companyId: function() { return COMPANY; },
  columns: [
    { field: 'period_name', type: 'text', width: 110, ro: 'saved' },
    { field: 'start_date', type: 'date', width: null, filterType: 'date',
      display: function(v) { return v ? esc(FB.util.fmtDate(v)) : '<span class="pe-ro">—</span>'; } },
    { field: 'end_date', type: 'date', width: null, filterType: 'date',
      display: function(v) { return v ? esc(FB.util.fmtDate(v)) : '<span class="pe-ro">—</span>'; } },
    { field: 'locked', type: 'checkbox', align: 'center',
      display: function(v) { return '<input type="checkbox" disabled' + (v ? ' checked' : '') + '>'; } }
  ],
  blank: function() { return { period_name: '', start_date: '', end_date: '', locked: false }; },
  isBlank: function(b) { return !b.period_name && !b.start_date && !b.end_date && !b.locked; },
  same: function(b, s) {
    return b.start_date === s.start_date && b.end_date === s.end_date && b.locked === !!s.locked;
  },
  validate: function(d) {
    if (!d.period_name || !d.start_date || !d.end_date) return 'Name, start and end required';
    if (d.start_date > d.end_date) return 'Start date must be on or before end date';
    return null;
  },
  firstField: function(isNew) { return isNew ? 'period_name' : 'start_date'; },
  track: 'period',
  list: { action: 'period.list',
    map: function(p) { return { period_id: p.period_id, period_name: p.period_id, start_date: String(p.start_date || '').slice(0, 10), end_date: String(p.end_date || '').slice(0, 10), locked: !!p.locked, _key: p.period_id }; } },
  save: { action: 'period.upsert',
    body: function(d) { return { period: { period_id: d._isNew ? d.period_name : d._key, period_name: d.period_name, start_date: d.start_date, end_date: d.end_date, locked: !!d.locked } }; },
    focusKey: function(d) { return d._isNew ? d.period_name : d._key; } },
  del: { action: 'period.delete',
    body: function(d) { return { periodId: d._key }; },
    confirm: function(d) { return 'Delete period "' + d.period_name + '"?'; } },
  onChrome: function(dirty) {
    var dot = document.getElementById('tab-dot-periods');
    if (dot) dot.style.display = dirty ? '' : 'none';
    if (dirty) markDirty('periods'); else resetDirty('periods');
  }
});

function loadPeriods(focusKey) { periodsList.load(focusKey); }
function renderPeriodHints() {
  var el = document.getElementById('sb-hints');
  if (el) periodsList.renderHints(el);
}

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

// ========== COA — FB.list (P3 consolidated) ==========
var CF_CATS_COA = ['','Cash','Op-WC','Operating','Tax','Investing','Financing','NonCash','Excluded'];
var ACCT_TYPES = ['Asset','Liability','Equity','Revenue','Expense','Closing'];
var SUBTYPES = ['','Current Asset','Non-Current Asset','Current Liability','Non-Current Liability','Equity','Revenue','COGS','Operating Expense','Non-Operating Expense','Closing'];

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
      display: function(v) { return v ? v : '—'; } }
  ],
  blank: function() { return { account_code: '', account_name: '', account_type: 'Asset', account_subtype: null, cf_category: null, is_active: true, default_role: null }; },
  isBlank: function(b) { return !b.account_code && !b.account_name; },
  same: function(b, s) {
    return b.account_name === s.account_name && b.account_type === s.account_type
      && (b.account_subtype || null) === (s.account_subtype || null)
      && (b.cf_category || null) === (s.cf_category || null)
      && b.is_active === !!s.is_active
      && (b.default_role || null) === (s.default_role || null);
  },
  validate: function(d) { return (d.account_code && d.account_name && d.account_type) ? null : 'Code, name and type required'; },
  firstField: function(isNew) { return isNew ? 'account_code' : 'account_name'; },
  track: 'account',
  filter: function(a, q) {
    q = q.toLowerCase();
    return (a.account_code || '').toLowerCase().indexOf(q) >= 0 || (a.account_name || '').toLowerCase().indexOf(q) >= 0;
  },
  list: { url: function() { return '/api/' + COMPANY + '/accounts'; },
    map: function(a) { return { account_code: a.account_code, account_name: a.account_name, account_type: a.account_type, account_subtype: a.account_subtype || null, cf_category: a.cf_category || null, is_active: a.is_active === true, default_role: a.default_role || null, _key: a.account_code }; } },
  save: { action: 'coa.upsert',
    body: function(d) { return { account: { account_code: d.account_code, account_name: d.account_name, account_type: d.account_type, account_subtype: d.account_subtype || null, cf_category: d.cf_category || null, is_active: !!d.is_active, default_role: d.default_role || null } }; },
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

// ========== FX PROVIDER PANEL (read-first, install-level) ==========
// settings-ux-spec §7 item 5 rev 2026-07-27 + fx-automation-spec rev 2026-07-27.
// Lives on the Exchange Rates tab next to the 📡 Fetch Rates action. Read mode
// shows provider name/description + whether an API key is set, as TEXT. Edit
// mode (click Edit, or i while the panel is focused) reveals the provider
// select and, when the chosen provider needs one, the API-key input — behind
// an explicit Save Provider button (Esc never saves, one save path). This
// panel owns its own minimal edit state (NOT FB.mode) and sits OUTSIDE the
// FB.list tbody tree; the framework's editable-target focus guard keeps the
// rates register's single-key verbs inert while the panel's inputs have focus.
var fxProviders = [];
var fxProviderPanel = (function () {
  var editing = false;
  var current = { provider: 'ecb', apiKey: null, source: null };
  var wired = false;

  function el(id) { return document.getElementById(id); }
  function findProvider(id) {
    for (var i = 0; i < fxProviders.length; i++) if (fxProviders[i].id === id) return fxProviders[i];
    return null;
  }

  function renderRead() {
    var p = findProvider(current.provider) || { name: current.provider, description: '' };
    el('fxp-read-provider').textContent = p.name || current.provider;
    var keyEl = el('fxp-read-key');
    var keyTxt = current.apiKey
      ? 'API key set (••••' + current.apiKey + ')'
      : (p.requiresApiKey ? 'API key NOT set' : 'No API key required');
    keyEl.textContent = keyTxt;
    if (current.source === 'company') {
      keyEl.textContent += ' — per-company (legacy); saving upgrades to install-level';
    }
    el('fxp-read-provider').title = p.description || '';
  }

  function showRead() {
    editing = false;
    el('fxp-read-provider').parentElement.style.display = 'flex';
    el('fxp-edit').style.display = 'none';
  }
  function showEdit() {
    editing = true;
    el('fxp-read-provider').parentElement.style.display = 'none';
    el('fxp-edit').style.display = 'flex';
    populateSelect();
    el('fxp-select').value = current.provider;
    onSelectChange();
    // Clear any stale key draft; placeholder hints at the stored key.
    var keyInput = el('fxp-key');
    keyInput.value = '';
    if (current.apiKey) keyInput.placeholder = 'API key set (••••' + current.apiKey + ') — retype to replace';
    else keyInput.placeholder = 'Enter API key';
    var s = el('fxp-select'); if (s) s.focus();
  }

  function populateSelect() {
    var sel = el('fxp-select');
    sel.innerHTML = '';
    (Array.isArray(fxProviders) ? fxProviders : []).forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.id; opt.textContent = p.name;
      sel.appendChild(opt);
    });
  }

  function onSelectChange() {
    var p = findProvider(el('fxp-select').value);
    if (!p) return;
    el('fxp-desc').textContent = p.description || '';
    var keyRow = el('fxp-key-row');
    if (p.requiresApiKey) {
      keyRow.style.display = 'flex';
      el('fxp-key-label').textContent = p.apiKeyLabel || 'API Key';
    } else {
      keyRow.style.display = 'none';
    }
  }

  function wire() {
    if (wired) return; wired = true;
    var panel = el('fx-provider-panel');
    if (!panel) return;
    // Esc exits edit mode without saving (Esc-never-saves doctrine). Enter on
    // the API-key field submits (mouse parity with the Save button).
    panel.addEventListener('keydown', function (e) {
      if (!editing) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
      else if (e.key === 'Enter' && (e.target === el('fxp-key') || e.target === el('fxp-select'))) {
        e.preventDefault(); save();
      }
    });
    // i enters edit mode from read mode (keyboard parity with the Edit
    // button) — only when the panel itself (not a child input) has focus, so
    // it never hijacks typing. Read mode has no inputs, so this is safe.
    panel.setAttribute('tabindex', '0');
    panel.addEventListener('keydown', function (e) {
      if (editing) return;
      if (e.key === 'i' && !(e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) {
        e.preventDefault(); edit();
      }
    });
  }

  function load() {
    wire();
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'fx.providers.list', companyId: COMPANY }) })
      .then(function (r){ return r.json(); })
      .then(function (res){
        fxProviders = res.data || res || [];
        return fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'fx.provider.get', companyId: COMPANY }) })
          .then(function (r){ return r.json(); })
          .then(function (r2){
            var c = r2.data || r2 || {};
            current = { provider: c.provider || 'ecb', apiKey: c.apiKey || null, source: c.source || null };
            renderRead();
            showRead();
          });
      })
      .catch(function (e){ console.error('fxProviderPanel.load failed:', e); });
  }

  function edit() { showEdit(); }
  function cancel() { showRead(); renderRead(); }

  function save() {
    var providerId = el('fxp-select').value;
    var p = findProvider(providerId);
    var keyRow = el('fxp-key-row');
    var apiKey = (keyRow && keyRow.style.display !== 'none') ? el('fxp-key').value.trim() : null;
    if (!providerId) { showMsg('fx-provider', 'Select a provider first', true); return; }
    if (p && p.requiresApiKey && !apiKey && !current.apiKey) {
      showMsg('fx-provider', (p.apiKeyLabel || 'API Key') + ' required for ' + p.name, true);
      return;
    }
    var btn = el('fxp-save-btn'); if (btn) btn.disabled = true;
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'fx.provider.save', companyId: COMPANY, provider: providerId, apiKey: apiKey }) })
      .then(function (r){ return r.json(); })
      .then(function (r){
        var d = r.data || r;
        if (r.error || d.error) { showMsg('fx-provider', r.error || d.error, true); if (btn) btn.disabled = false; return; }
        // Refresh current config from the server, re-render read mode, confirm.
        return fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'fx.provider.get', companyId: COMPANY }) })
          .then(function (rr){ return rr.json(); })
          .then(function (rr2){
            var c = rr2.data || rr2 || {};
            current = { provider: c.provider || providerId, apiKey: c.apiKey || null, source: c.source || 'install' };
            renderRead();
            showRead();
            showMsg('fx-provider', 'Provider saved (install-level)', false);
            if (btn) btn.disabled = false;
          });
      })
      .catch(function (e){ showMsg('fx-provider', e.message, true); if (btn) btn.disabled = false; });
  }

  return { load: load, edit: edit, cancel: cancel, save: save, onSelectChange: onSelectChange };
})();


// ========== DEFAULT ACCOUNTS — removed (settings-ux-spec §7 item 1) ==========
// Default AP/Expense accounts are now managed per-row on the COA tab via the
// account-level default_role flag (server-side single-holder enforcement).
// The legacy "Default Accounts (current company)" panel, loadDefaultAccounts(),
// and saveDefaultAccounts() have been removed from the Company tab.
// loadVatTolerance remains (a later task relocates the VAT Tolerance panel).

// Populate the VAT tolerance card on the default-visible Company tab.
window.addEventListener('DOMContentLoaded', function () { loadVatTolerance(); });

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


// ========== HANDLE ?tab= URL PARAM ==========
(function() {
  var params = new URLSearchParams(window.location.search);
  var tab = params.get('tab');
  loadCurrencyList();
  showTab(tab || 'company');
})();
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleSettingsPage };
