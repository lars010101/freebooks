'use strict';
const { makeQuery, commonStyle, navBar } = require('./common');

async function handleSettingsPage(req, res) {
  const { company } = req.params;
  const q = makeQuery();
  try {
    const companies = await q(
      `SELECT company_id, company_name FROM companies ORDER BY company_name`
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildSettingsPage(company, companies));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}


function buildSettingsPage(company, companies = []) {
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
</style>
</head>
<body>
<div class="page">
  ${navBar(company, 'settings')}
  <div class="header">
    <h1>⚙ Settings</h1>
    <p class="sub">${company}</p>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="showTab('periods')">Periods</div>
    <div class="tab" onclick="showTab('company')">Company</div>
    <div class="tab" onclick="showTab('coa')">Chart of Accounts</div>
    <div class="tab" id="tab-vat-label" onclick="showTab('vat')">Tax Codes</div>
    <div class="tab" onclick="showTab('journals')">Journals</div>
    <div class="tab" onclick="showTab('mappings')">Bank Mappings</div>
    <div class="tab" onclick="showTab('vendors')">Vendors</div>
    <div class="tab" onclick="showTab('fxrates')">Exchange Rates</div>
  </div>

  <!-- PERIODS TAB -->
  <div id="tab-periods" class="tab-panel active">
    <table class="edit-table" id="periods-table">
      <thead><tr><th>Period Name</th><th>Start Date</th><th>End Date</th><th>Locked</th><th></th></tr></thead>
      <tbody id="periods-body"></tbody>
    </table>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
      <button class="btn-sm" onclick="addPeriodRow()">+ Add Period</button>
      <button id="btn-save-periods" class="btn-primary" onclick="savePeriods()" disabled>Save</button>
      <span id="msg-periods" class="msg"></span>
    </div>
  </div>

  <!-- COMPANY TAB -->
  <div id="tab-company" class="tab-panel">
    <div class="field-row"><label>Company Name</label><input type="text" id="co-name"></div>
    <div class="field-row"><label>Currency</label><input type="text" id="co-currency" maxlength="3" style="max-width:80px" list="currency-list"></div>
    <div class="field-row"><label>Jurisdiction</label><input type="text" id="co-jurisdiction" style="max-width:80px"></div>
    <div class="field-row"><label>Tax ID</label><input type="text" id="co-taxid"></div>
    <div class="field-row"><label>Reporting Standard</label><input type="text" id="co-standard"></div>
    <div class="field-row"><label><input type="checkbox" id="co-vat"> VAT / GST Registered</label></div>
    <div class="field-row"><label>FX Gain/Loss Account</label>
      <div style="display:flex;gap:8px;align-items:center;width:100%">
        <input type="text" id="co-fx-account" placeholder="code or name" style="flex:1;max-width:300px" autocomplete="off" oninput="vendorAcctInput(this)" onblur="hideVendorAcctDd()">
        <span id="co-fx-account-name" style="font-size:9pt;color:#888"></span>
      </div>
    </div>
    <button id="btn-save-company" class="btn-primary" onclick="saveCompany()" disabled>Save</button>
    <span id="msg-company" class="msg"></span>

    <hr style="margin:24px 0;border:none;border-top:1px solid #e8e8e8">

    <div style="margin-bottom:6px;font-weight:700;font-size:11pt">Manage Companies</div>

    <div class="field-row" style="margin-bottom:16px">
      <label>Switch Company</label>
      <div style="display:flex;gap:10px;align-items:center">
        <select id="co-switch-select" style="max-width:280px;padding:7px 10px;border:1px solid #ccc;border-radius:4px;font-size:10pt">
          ${companies.map(c => `<option value="${c.company_id}"${c.company_id === company ? ' selected' : ''}>${c.company_name} (${c.company_id})</option>`).join('\n          ')}
        </select>
        <button class="btn-sm" onclick="switchCompany()">Switch →</button>
      </div>
    </div>

    <div>
      <a href="/setup/new-company" style="display:inline-block;padding:9px 20px;background:#f5f5f5;color:#1a1a1a;border:1px solid #ccc;border-radius:4px;font-size:10pt;font-weight:600;text-decoration:none">+ New Company</a>
    </div>
  </div>

  <!-- COA TAB -->
  <div id="tab-coa" class="tab-panel">
    <input type="text" class="search-bar" id="coa-search" placeholder="Filter by code or name..." oninput="filterCoa()">
    <table class="edit-table" id="coa-table">
      <thead><tr><th>Code</th><th>Account Name</th><th>Type</th><th>Subtype</th><th>CF Category</th><th>Active</th></tr></thead>
      <tbody id="coa-body"></tbody>
    </table>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
      <button id="btn-save-coa" class="btn-primary" onclick="saveCoa()" disabled>Save</button>
      <span id="msg-coa" class="msg"></span>
    </div>
  </div>

  <!-- JOURNALS TAB -->
  <div id="tab-journals" class="tab-panel">
    <table class="edit-table" id="journals-table">
      <thead><tr><th>Code</th><th>Name</th><th style="text-align:center">Active</th><th></th></tr></thead>
      <tbody id="journals-body"></tbody>
    </table>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
      <button class="btn-sm" onclick="addJournalRow()">+ Add Journal</button>
      <button id="btn-save-journals" class="btn-primary" onclick="saveJournals()" disabled>Save</button>
      <span id="msg-journals" class="msg"></span>
    </div>
    <p style="margin-top:8px;font-size:9pt;color:#888">Journal codes appear in the reference sequence (e.g. MISC/2026/0001). Codes should be short uppercase strings.</p>
  </div>

  <!-- BANK MAPPINGS TAB -->
  <div id="tab-mappings" class="tab-panel">
    <table class="edit-table" id="mappings-table">
      <thead><tr><th>Pattern</th><th>Match</th><th>Offset Account <small style="font-weight:400;color:#888">(expense/income - bank side auto-assigned)</small></th><th>Description Override</th><th>Priority</th><th style="text-align:center">Active</th><th></th></tr></thead>
      <tbody id="mappings-body"></tbody>
    </table>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
      <button class="btn-sm" onclick="addMappingRow()">+ Add Rule</button>
      <button id="btn-save-mappings" class="btn-primary" onclick="saveMappings()" disabled>Save</button>
      <span id="msg-mappings" class="msg"></span>
    </div>
    <p style="margin-top:8px;font-size:9pt;color:#888">Rules are applied in priority order (lower = higher priority). Match types: <em>contains</em>, <em>exact</em>, <em>starts_with</em>, <em>regex</em>.<br>
    Set the <b>offset account</b> (expense for outflows, income for inflows). The bank account is supplied at import time and assigned automatically based on the amount sign.</p>
  </div>

  <!-- VAT/GST CODES TAB -->
  <div id="tab-vat" class="tab-panel">
    <table class="edit-table" id="vat-table">
      <thead><tr><th>Code</th><th>Description</th><th>Rate %</th><th>Input Acct</th><th>Output Acct</th><th>Report Box</th><th style="text-align:center">Rev.Chg</th><th style="text-align:center">Active</th><th></th></tr></thead>
      <tbody id="vat-body"></tbody>
    </table>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
      <button class="btn-sm" onclick="addVatRow()">+ Add Code</button>
      <button id="btn-save-vat" class="btn-primary" onclick="saveVat()" disabled>Save</button>
      <span id="msg-vat" class="msg"></span>
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
      <span id="msg-fxrates" class="msg"></span>
    </div>
  </div>

  <!-- VENDORS TAB -->
  <div id="tab-vendors" class="tab-panel">
    <table class="edit-table" id="vendors-table">
      <thead><tr><th>Name</th><th>CCY</th><th>Terms(d)</th><th>Expense A/C</th><th>AP A/C</th><th style="text-align:center">Active</th><th></th></tr></thead>
      <tbody id="vendors-body"></tbody>
    </table>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
      <button class="btn-sm" onclick="addVendorRow()">+ Add Vendor</button>
      <button id="btn-save-vendors" class="btn-primary" onclick="saveVendors()" disabled>Save</button>
      <span id="msg-vendors" class="msg"></span>
    </div>
    <p style="margin-top:8px;font-size:9pt;color:#888">These defaults auto-fill when creating a bill for this vendor: currency, payment terms, expense account, and AP account.</p>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button id="btn-save-fxrates" class="btn-primary" onclick="saveFxRates()">Save Rates</button>
    </div>
  </div>
</div>

<script>
var COMPANY = '${company}';
var CF_OPTS = ['','Cash','Op-WC','Operating','Tax','Investing','Financing','NonCash','Excluded'];
var VAT_NAMES = { SG:'GST', SE:'VAT' };

// ========== DIRTY STATE MANAGER (all tabs) ==========
var dirtyTabs = new Set();
var vendorAccountsList = [];
var vendorAcctActiveInput = null;
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
  if (cur) {
    var curTab = cur.id.replace('tab-','');
    if (dirtyTabs.has(curTab) && curTab !== t) {
      if (!confirm('You have unsaved changes. Discard?')) return;
      resetDirty(curTab);
    }
  }
  var tabs = ['periods','company','coa','vat','journals','mappings','vendors','fxrates'];
  document.querySelectorAll('.tab').forEach(function(el,i){ el.classList.toggle('active', tabs[i]===t); });
  document.querySelectorAll('.tab-panel').forEach(function(el){ el.classList.remove('active'); });
  document.getElementById('tab-'+t).classList.add('active');
  if (t === 'vendors') { loadVendors(); loadVendorAccounts(); }
  if (t === 'mappings') loadVendorAccounts();
  if (t === 'fxrates') { loadFxProviders(); loadFxRates(); loadBaseCurrencies(); }
}

function switchCompany() {
  var sel = document.getElementById('co-switch-select');
  var id = sel.value;
  if (!id) return;
  localStorage.setItem('freebooks_company', id);
  window.location.href = '/' + id;
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
function addPeriodRow(p) {
  p = p || {};
  var tr = document.createElement('tr');
  tr.innerHTML = '<td><input type="text" value="' + (p.period_id||'') + '" placeholder="FY2027"></td>'
    + '<td><input type="date" value="' + (p.start_date ? p.start_date.slice(0,10) : '') + '"></td>'
    + '<td><input type="date" value="' + (p.end_date ? p.end_date.slice(0,10) : '') + '"></td>'
    + '<td style="text-align:center"><input type="checkbox"' + (p.locked ? ' checked' : '') + '>' + (p.locked ? ' \u{1f512}' : '') + '</td>'
    + '<td><button class="btn-sm danger" onclick="markDirty(\\'periods\\'); this.parentElement.parentElement.remove()">\u2715</button></td>';
  wireDirty(tr, 'periods');
  document.getElementById('periods-body').appendChild(tr);
}
function loadPeriods() {
  document.getElementById('periods-body').innerHTML = '';
  fetch('/api/' + COMPANY + '/periods').then(function(r){ return r.json(); }).then(function(rows){
    rows.forEach(function(r){ addPeriodRow({ period_id: r.period_name, start_date: r.start_date ? String(r.start_date).slice(0,10) : '', end_date: r.end_date ? String(r.end_date).slice(0,10) : '', locked: r.locked }); });
    resetDirty('periods');
  });
}
function savePeriods() {
  var rows = Array.from(document.querySelectorAll('#periods-body tr')).map(function(tr){
    var inputs = tr.querySelectorAll('input');
    return { company_id: COMPANY, period_id: inputs[0].value.trim(), start_date: inputs[1].value, end_date: inputs[2].value, locked: inputs[3].checked };
  }).filter(function(p){ return p.period_id && p.start_date && p.end_date; });
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'period.save', companyId: COMPANY, periods: rows }) })
    .then(function(r){ return r.json(); }).then(function(r){ var d = r.data||r; showMsg('msg-periods', r.error||d.error || ('Saved ' + (d.saved||0) + ' periods'), !!(r.error||d.error)); if (!r.error && !d.error) resetDirty('periods'); })
    .catch(function(e){ showMsg('msg-periods', e.message, true); });
}
loadPeriods();
loadVendorAccounts(); // preload accounts for vendor autocomplete

// ========== COMPANY ==========
function loadCompany() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'company.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); }).then(function(res){
      var rows = (res && res.data) ? res.data : (Array.isArray(res) ? res : []);
      var co = rows.find(function(c){ return c.company_id === COMPANY; });
      if (co && co.jurisdiction) {
        var vn = VAT_NAMES[co.jurisdiction] || 'Tax';
        document.getElementById('tab-vat-label').textContent = vn + ' Codes';
      }
      if (!co) return;
      document.getElementById('co-name').value = co.company_name || '';
      document.getElementById('co-currency').value = co.base_currency || co.currency || '';
      document.getElementById('co-jurisdiction').value = co.jurisdiction || '';
      document.getElementById('co-taxid').value = co.tax_id || '';
      document.getElementById('co-standard').value = co.reporting_standard || '';
      document.getElementById('co-vat').checked = !!co.vat_registered;
      ['co-name','co-currency','co-jurisdiction','co-taxid','co-standard','co-vat','co-fx-account'].forEach(function(id){
        var el = document.getElementById(id);
        if (el) { el.oninput = function(){ markDirty('company'); }; el.onchange = function(){ markDirty('company'); }; }
      });
      // Load FX settings
      loadFxSettings();
      resetDirty('company');
    });
}
function loadFxSettings() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'settings.get', companyId: COMPANY }) })
    .then(function(r){ return r.json(); }).then(function(res){
      var settings = res.data || res;
      var fxAcct = settings.fx_gain_loss_account || '';
      document.getElementById('co-fx-account').value = fxAcct;
      if (fxAcct && vendorAccountsList.length > 0) {
        var acct = vendorAccountsList.find(function(a){ return a.account_code === fxAcct; });
        if (acct) document.getElementById('co-fx-account-name').textContent = acct.account_name || '';
      }
    }).catch(function(){});
}
function saveCompany() {
  var co = { company_id: COMPANY, company_name: document.getElementById('co-name').value,
    base_currency: document.getElementById('co-currency').value, jurisdiction: document.getElementById('co-jurisdiction').value,
    tax_id: document.getElementById('co-taxid').value, reporting_standard: document.getElementById('co-standard').value,
    vat_registered: document.getElementById('co-vat').checked };
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'company.save', companyId: COMPANY, companies: [co] }) })
    .then(function(r){ return r.json(); }).then(function(r){ var d = r.data||r; showMsg('msg-company', r.error||d.error || 'Saved', !!(r.error||d.error)); if (!r.error && !d.error) {
      // Also save FX settings
      var fxSettings = { fx_gain_loss_account: document.getElementById('co-fx-account').value.trim() || '' };
      fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'settings.save', companyId: COMPANY, settings: fxSettings }) })
        .catch(function(e){ console.error('FX settings save failed:', e); });
      resetDirty('company');
    } })
    .catch(function(e){ showMsg('msg-company', e.message, true); });
}
loadCompany();

// ========== COA ==========
var coaData = [];
function loadCoa() {
  fetch('/api/' + COMPANY + '/accounts').then(function(r){ return r.json(); }).then(function(rows){
    coaData = rows;
    renderCoa(rows);
    resetDirty('coa');
  });
}
function cfSelect(val) {
  return '<select>' + CF_OPTS.map(function(o){ return '<option value="'+o+'"'+(o===val?' selected':'')+'>'+( o||'\u2014 none \u2014')+'</option>'; }).join('') + '</select>';
}
function renderCoa(rows) {
  document.getElementById('coa-body').innerHTML = rows.map(function(a){ return '<tr data-code="'+a.account_code+'">'
    + '<td><span class="ro">'+a.account_code+'</span></td>'
    + '<td><input type="text" value="'+(a.account_name||'').replace(/"/g,'&quot;')+'"></td>'
    + '<td><span class="ro">'+( a.account_type||'')+'</span></td>'
    + '<td><input type="text" value="'+(a.account_subtype||'').replace(/"/g,'&quot;')+'"></td>'
    + '<td>'+cfSelect(a.cf_category||'')+'</td>'
    + '<td style="text-align:center"><input type="checkbox"'+(a.is_active!==false?' checked':'')+'></td>'
    + '</tr>'; }).join('');
  Array.from(document.querySelectorAll('#coa-body tr')).forEach(function(tr){ wireDirty(tr, 'coa'); });
}
function filterCoa() {
  var q = document.getElementById('coa-search').value.toLowerCase();
  var filtered = q ? coaData.filter(function(a){ return (a.account_code||'').toLowerCase().includes(q) || (a.account_name||'').toLowerCase().includes(q); }) : coaData;
  renderCoa(filtered);
}
function saveCoa() {
  var rows = Array.from(document.querySelectorAll('#coa-body tr')).map(function(tr){
    var inputs = tr.querySelectorAll('input[type=text]');
    var sel = tr.querySelector('select');
    var chk = tr.querySelector('input[type=checkbox]');
    return { account_code: tr.dataset.code, account_name: inputs[0].value, account_subtype: inputs[1].value,
      cf_category: sel ? sel.value : '', is_active: chk ? chk.checked : true };
  });
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'coa.save', companyId: COMPANY, accounts: rows }) })
    .then(function(r){ return r.json(); }).then(function(r){ var d = r.data||r; showMsg('msg-coa', r.error||d.error || ('Saved ' + (d.saved||0) + ' accounts'), !!(r.error||d.error)); if (!r.error && !d.error) resetDirty('coa'); })
    .catch(function(e){ showMsg('msg-coa', e.message, true); });
}
loadCoa();

// ========== VAT/GST CODES ==========
function addVatRow(v) {
  v = v || {};
  var tr = document.createElement('tr');
  tr.innerHTML =
    '<td><input type="text" value="'+(v.vat_code||'')+'" placeholder="SG9" style="width:70px"></td>'
    +'<td><input type="text" value="'+(v.description||'').replace(/"/g,"&quot;")+'"></td>'
    +'<td><input type="number" value="'+(v.rate!=null?(v.rate*100).toFixed(2):0)+'" step="0.01" min="0" max="100" style="width:65px"></td>'
    +'<td><input type="text" value="'+(v.vat_account_input||'')+'" style="width:65px"></td>'
    +'<td><input type="text" value="'+(v.vat_account_output||'')+'" style="width:65px"></td>'
    +'<td><input type="text" value="'+(v.report_box||'')+'" style="width:55px"></td>'
    +'<td style="text-align:center"><input type="checkbox"'+(v.is_reverse_charge?' checked':'')+' title="Reverse charge"></td>'
    +'<td style="text-align:center"><input type="checkbox"'+(v.is_active!==false?' checked':'')+' title="Active"></td>'
    +'<td><button class="btn-sm danger" onclick="markDirty(\\'vat\\'); this.parentElement.parentElement.remove()">\u2715</button></td>';
  wireDirty(tr, 'vat');
  document.getElementById('vat-body').appendChild(tr);
}
function loadVat() {
  document.getElementById('vat-body').innerHTML = '';
  fetch('/api/'+COMPANY+'/vat-codes').then(function(r){ return r.json(); }).then(function(rows){
    if (Array.isArray(rows)) rows.forEach(addVatRow);
    resetDirty('vat');
  });
}
function saveVat() {
  var rows = Array.from(document.querySelectorAll('#vat-body tr')).map(function(tr){
    var inputs = tr.querySelectorAll('input');
    return { vat_code: inputs[0].value.trim(), description: inputs[1].value.trim(),
      rate: parseFloat(inputs[2].value||0)/100, vat_account_input: inputs[3].value.trim()||null,
      vat_account_output: inputs[4].value.trim()||null, report_box: inputs[5].value.trim()||null,
      is_reverse_charge: inputs[6].checked, is_active: inputs[7].checked, effective_from: '2000-01-01' };
  }).filter(function(v){ return v.vat_code; });
  if (rows.length === 0 && !confirm('No codes defined. This will delete all tax codes. Continue?')) return;
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'vat.codes.save', companyId: COMPANY, vatCodes: rows }) })
    .then(function(r){ return r.json(); })
    .then(function(r){ var d=r.data||r; showMsg('msg-vat', r.error||d.error||('Saved '+(d.saved||0)+' codes'), !!(r.error||d.error)); if (!r.error && !d.error) resetDirty('vat'); })
    .catch(function(e){ showMsg('msg-vat', e.message, true); });
}
loadVat();

// ========== JOURNALS ==========
function addJournalRow(j) {
  j = j || {};
  var tr = document.createElement('tr');
  tr.innerHTML = '<td><input type="text" value="'+(j.code||'')+'" placeholder="MISC" style="width:80px;text-transform:uppercase"></td>'
    + '<td><input type="text" value="'+(j.name||'')+'" placeholder="Miscellaneous"></td>'
    + '<td style="text-align:center"><input type="checkbox"'+(j.active!==false?' checked':'')+' ></td>'
    + '<td><button class="btn-sm danger" onclick="markDirty(\\'journals\\'); this.parentElement.parentElement.remove()">&times;</button></td>';
  wireDirty(tr, 'journals');
  document.getElementById('journals-body').appendChild(tr);
}
function loadJournals() {
  document.getElementById('journals-body').innerHTML = '';
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'journals.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); }).then(function(res){
      var rows = res.data||res;
      if (Array.isArray(rows)) rows.forEach(addJournalRow);
      resetDirty('journals');
    });
}
function saveJournals() {
  var rows = Array.from(document.querySelectorAll('#journals-body tr')).map(function(tr){
    var inputs = tr.querySelectorAll('input');
    var code = inputs[0].value.trim().toUpperCase();
    return { journal_id: COMPANY+'_'+code.toLowerCase(), code: code, name: inputs[1].value.trim(), active: inputs[2].checked };
  }).filter(function(j){ return j.code && j.name; });
  var saves = rows.map(function(j){ return fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'journals.save', companyId: COMPANY, journal: j }) }).then(function(r){ return r.json(); }); });
  Promise.all(saves)
    .then(function(){ showMsg('msg-journals', 'Saved '+rows.length+' journal'+(rows.length===1?'':'s'), false); resetDirty('journals'); })
    .catch(function(e){ showMsg('msg-journals', e.message, true); });
}
loadJournals();

// ========== BANK MAPPINGS ==========
var MATCH_TYPES = ['contains','exact','starts_with','regex'];
function addMappingRow(m) {
  m = m || {};
  var tr = document.createElement('tr');
  tr.innerHTML = '<td><input type="text" value="'+(m.pattern||'')+'" placeholder="SALARY" style="width:140px"></td>'
    + '<td><select style="width:90px">' + MATCH_TYPES.map(function(t){ return '<option'+(t===(m.match_type||'contains')?' selected':'')+'>'+t+'</option>'; }).join('') + '</select></td>'
    + '<td><input type="text" value="'+(m.debit_account||'')+'" placeholder="code or name" style="width:110px" autocomplete="off" oninput="vendorAcctInput(this)" onblur="hideVendorAcctDd()"></td>'
    + '<td><input type="text" value="'+(m.description_override||'')+'" placeholder="optional" style="width:160px"></td>'
    + '<td><input type="number" value="'+(m.priority||100)+'" style="width:55px"></td>'
    + '<td style="text-align:center"><input type="checkbox"'+(m.is_active!==false?' checked':'')+' ></td>'
    + '<td><button class="btn-sm danger" onclick="markDirty(\\'mappings\\'); this.parentElement.parentElement.remove()">&times;</button></td>';
  wireDirty(tr, 'mappings');
  document.getElementById('mappings-body').appendChild(tr);
}
function loadMappings() {
  document.getElementById('mappings-body').innerHTML = '';
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'mapping.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); }).then(function(res){
      var rows = res.data||res;
      if (Array.isArray(rows)) rows.forEach(addMappingRow);
      resetDirty('mappings');
    });
}
function saveMappings() {
  var rows = Array.from(document.querySelectorAll('#mappings-body tr')).map(function(tr){
    var inputs = tr.querySelectorAll('input');
    var sel = tr.querySelector('select');
    return { pattern: inputs[0].value.trim(), match_type: sel.value,
      debit_account: inputs[1].value.trim(), credit_account: null,
      description_override: inputs[2].value.trim() || null,
      priority: parseInt(inputs[3].value||100), is_active: inputs[4].checked };
  }).filter(function(m){ return m.pattern && m.debit_account; });
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'mapping.save', companyId: COMPANY, mappings: rows }) })
    .then(function(r){ return r.json(); }).then(function(r){ var d=r.data||r; showMsg('msg-mappings', r.error||d.error||('Saved '+(d.saved||0)+' rules'), !!(r.error||d.error)); if (!r.error && !d.error) resetDirty('mappings'); })
    .catch(function(e){ showMsg('msg-mappings', e.message, true); });
}
loadMappings();

// ========== VENDORS ==========
function loadVendors() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'vendor.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var rows = (res.data || res);
      var tbody = document.getElementById('vendors-body');
      tbody.innerHTML = '';
      if (Array.isArray(rows)) rows.forEach(addVendorRow);
      resetDirty('vendors');
    }).catch(function(){});
}
function addVendorRow(v) {
  v = v || {};
  var tr = document.createElement('tr');
  tr.innerHTML =
    '<td><input type="text" value="' + (v.name||'') + '" placeholder="Vendor name" style="width:220px"></td>' +
    '<td><input type="text" value="' + (v.default_currency||'') + '" maxlength="3" style="width:45px"></td>' +
    '<td><input type="number" value="' + (v.payment_terms_days||30) + '" style="width:55px"></td>' +
    '<td><input type="text" value="' + (v.default_expense_account||'') + '" style="width:90px" placeholder="code or name" autocomplete="off" oninput="vendorAcctInput(this)" onblur="hideVendorAcctDd()"></td>' +
    '<td><input type="text" value="' + (v.default_ap_account||'') + '" style="width:90px" placeholder="code or name" autocomplete="off" oninput="vendorAcctInput(this)" onblur="hideVendorAcctDd()"></td>' +
    '<td style="text-align:center"><input type="checkbox"' + (v.is_active!==false ? ' checked' : '') + '></td>' +
    '<td><button class="btn-sm danger" onclick="markDirty(\\'vendors\\'); this.parentElement.parentElement.remove()">\u2715</button></td>';
  wireDirty(tr, 'vendors');
  document.getElementById('vendors-body').appendChild(tr);
}
function loadVendorAccounts() {
  fetch('/api/' + COMPANY + '/accounts').then(function(r){ return r.json(); }).then(function(rows){
    vendorAccountsList = Array.isArray(rows) ? rows : [];
    console.log('vendorAccountsList loaded:', vendorAccountsList.length);
  }).catch(function(e){ console.error('loadVendorAccounts failed:', e); });
}

// ========== HANDLE ?tab= URL PARAM ==========
(function() {
  var params = new URLSearchParams(window.location.search);
  var tab = params.get('tab');
  if (tab) showTab(tab);
})();

// Wire FX rates save button
var fxSaveBtn = document.querySelector('#fx-rates-body');
if (!fxSaveBtn) {
  var s = document.createElement('script');
  s.textContent = 'document.addEventListener("DOMContentLoaded", function(){ var tbody = document.getElementById("fx-rates-body"); if (tbody && !tbody.dataset.fxWired) { tbody.dataset.fxWired = true; var frm = tbody.parentElement.parentElement; var btn = document.createElement("button"); btn.className = "btn-primary"; btn.textContent = "Save Rates"; btn.onclick = saveFxRates; frm.appendChild(btn); } });';
  document.body.appendChild(s);
}

function vendorAcctInput(input) {
  if (!vendorAccountsList.length) { loadVendorAccounts(); }
  vendorAcctActiveInput = input;
  var q = input.value.trim().toLowerCase();
  var dd = document.getElementById('vendor-acct-dd');
  if (dd) dd.remove();
  if (!q) return;
  var matches = vendorAccountsList.filter(function(a){
    return (a.account_code||'').toLowerCase().includes(q) || (a.account_name||'').toLowerCase().includes(q);
  }).slice(0, 12);
  if (!matches.length) return;
  var div = document.createElement('div');
  div.id = 'vendor-acct-dd';
  div.style.cssText = 'position:fixed;background:#fff;border:1px solid #ccc;z-index:9999;max-height:200px;overflow-y:auto;font-size:11px;box-shadow:0 2px 6px rgba(0,0,0,.2)';
  matches.forEach(function(a){
    var item = document.createElement('div');
    item.textContent = a.account_code + ' - ' + a.account_name;
    item.style.cssText = 'padding:4px 8px;cursor:pointer;white-space:nowrap';
    item.onmouseover = function(){ item.style.background='#e8f0fe'; };
    item.onmouseout  = function(){ item.style.background=''; };
    item.onmousedown = function(e){ e.preventDefault(); };
    item.onclick = function(){
      if (vendorAcctActiveInput) vendorAcctActiveInput.value = a.account_code;
      var d = document.getElementById('vendor-acct-dd');
      if (d) d.remove();
      vendorAcctActiveInput = null;
    };
    div.appendChild(item);
  });
  var rect = input.getBoundingClientRect();
  div.style.left = rect.left + 'px';
  div.style.top  = (rect.bottom + 2) + 'px';
  div.style.minWidth = rect.width + 'px';
  document.body.appendChild(div);
}
function hideVendorAcctDd() {
  setTimeout(function(){
    var dd = document.getElementById('vendor-acct-dd');
    if (dd) dd.remove();
  }, 150);
}
function saveVendors() {
  var rows = Array.from(document.querySelectorAll('#vendors-body tr')).map(function(tr){
    var inputs = tr.querySelectorAll('input');
    return {
      name: inputs[0].value.trim(),
      default_currency: inputs[1].value.trim() || null,
      payment_terms_days: parseInt(inputs[2].value) || 30,
      tax_id: null,
      notes: null,
      default_expense_account: inputs[3].value.trim() || null,
      default_ap_account: inputs[4].value.trim() || null,
      is_active: inputs[5].checked
    };
  }).filter(function(r){ return r.name; });
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'vendor.save', companyId: COMPANY, vendors: rows }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var d = res.data || res;
      showMsg('msg-vendors', d.error || 'Saved ' + rows.length + ' vendors', !!d.error);
      if (!d.error) loadVendors();
    })
    .catch(function(e){ showMsg('msg-vendors', e.message, true); });
}

// ========== EXCHANGE RATES ==========
var fxRatesData = [];
var baseCurrencies = new Set();

function loadBaseCurrencies() {
  // Update the display of current company's base currency
  var compCcy = document.getElementById('co-currency').value || '';
  var displayEl = document.getElementById('current-base-currency');
  if (displayEl && compCcy) {
    displayEl.textContent = 'Base currency: ' + compCcy;
  }
}

function loadFxRates() {
  var compCcy = document.getElementById('co-currency').value || '';
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
  tr.innerHTML =
    '<td><input type="date" class="fx-date" style="width:120px"></td>' +
    '<td><input type="text" class="fx-from" maxlength="3" style="width:60px;text-transform:uppercase" placeholder="USD" list="currency-list"></td>' +
    '<td><input type="text" class="fx-to" maxlength="3" style="width:60px;text-transform:uppercase" placeholder="SGD" list="currency-list"></td>' +
    '<td style="text-align:right"><input type="number" class="fx-rate" step="0.000001" style="width:100px" placeholder="1.0"></td>' +
    '<td><span class="ro">manual</span></td>' +
    '<td><button class="btn-sm danger" onclick="this.parentElement.parentElement.remove()" style="font-size:9pt">×</button></td>';
  document.getElementById('fx-rates-body').appendChild(tr);
}

function deleteFxRate(date, from, to, source) {
  if (!confirm('Delete this rate?')) return;
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'fx.rates.delete', companyId: COMPANY, date: date, from_currency: from, to_currency: to, source: source }) })
    .then(function(r){ return r.json(); }).then(function(r){ if (!r.error && !r.data.error) loadFxRates(); else showMsg('msg-fxrates', r.error || r.data.error, true); })
    .catch(function(e){ showMsg('msg-fxrates', e.message, true); });
}

function fetchFromEcb() {
  var baseCcy = document.getElementById('co-currency').value || '';
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
  var rows = Array.from(document.querySelectorAll('#fx-rates-body tr')).filter(function(tr){ return tr.querySelector('.fx-date'); });
  rows.forEach(function(tr){
    var date = tr.querySelector('.fx-date').value;
    var from = tr.querySelector('.fx-from').value.trim().toUpperCase();
    var to = tr.querySelector('.fx-to').value.trim().toUpperCase();
    var rate = parseFloat(tr.querySelector('.fx-rate').value || 0);
    if (date && from && to && rate > 0) {
      newRates.push({ date: date, from_currency: from, to_currency: to, rate: rate });
    }
  });
  if (!newRates.length) { showMsg('msg-fxrates', 'No rates to save', true); return; }
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'fx.rates.save', companyId: COMPANY, rates: newRates }) })
    .then(function(r){ return r.json(); }).then(function(r){ var d = r.data||r; showMsg('msg-fxrates', r.error||d.error||('Saved '+newRates.length+' rates'), !!(r.error||d.error)); if (!r.error && !d.error) loadFxRates(); })
    .catch(function(e){ showMsg('msg-fxrates', e.message, true); });
}

// ========== CURRENCY DATALIST ==========
function loadCurrencyDatalist() {
  fetch('/db/currencies.json')
    .then(function(r){ return r.json(); })
    .then(function(currencies){
      var datalist = document.getElementById('currency-list');
      if (!datalist) {
        datalist = document.createElement('datalist');
        datalist.id = 'currency-list';
        document.body.appendChild(datalist);
      }
      datalist.innerHTML = '';
      currencies.forEach(function(c){
        var opt = document.createElement('option');
        opt.value = c.code;
        opt.textContent = c.code + ' — ' + c.name;
        datalist.appendChild(opt);
      });
    })
    .catch(function(e){ console.error('Failed to load currencies:', e); });
}
loadCurrencyDatalist();

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
    .then(function(r){ var d = r.data||r; showMsg('msg-fx-provider', r.error||d.error||('Provider saved: ' + providerId), !!(r.error||d.error)); })
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

// ========== UNSAVED CHANGES PROTECTION ==========
window.onbeforeunload = function(e) {
  if (dirtyTabs.size > 0) {
    var msg = 'You have unsaved changes.';
    e.returnValue = msg;
    return msg;
  }
};

</script>
</body>
</html>`;
}

module.exports = { handleSettingsPage };
