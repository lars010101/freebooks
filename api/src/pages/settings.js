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
</style>
</head>
<body>${navBar(company, 'settings')}
<div class="page">
  <div class="header">
    <h1>⚙ Settings</h1>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="showTab('company')">Company</div>
    <div class="tab" onclick="showTab('periods')">Periods</div>
    <div class="tab" onclick="showTab('coa')">Chart of Accounts</div>
    <div class="tab" id="tab-vat-label" onclick="showTab('vat')">Tax Codes</div>
    <div class="tab" onclick="showTab('journals')">Journals</div>
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

    <div>
      <a href="/setup/new-company" style="display:inline-block;padding:9px 20px;background:#f5f5f5;color:#1a1a1a;border:1px solid #ccc;border-radius:4px;font-size:10pt;font-weight:600;text-decoration:none">+ New Company</a>
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
  var tabs = ['company','periods','coa','vat','journals','fxrates'];
  document.querySelectorAll('.tab').forEach(function(el,i){ el.classList.toggle('active', tabs[i]===t); });
  document.querySelectorAll('.tab-panel').forEach(function(el){ el.classList.remove('active'); });
  document.getElementById('tab-'+t).classList.add('active');
  if (!tabLoaded[t]) {
    tabLoaded[t] = true;
    if (t === 'company')  { loadCompany(); }
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
function addPeriodRow(p) {
  p = p || {};
  var isNew = !p.period_id && !p.period_name;
  var tr = document.createElement('tr');
  tr.dataset.periodId = p.period_id || p.period_name || '';
  tr.innerHTML = '<td><input type="text" value="'+(p.period_name||p.period_id||'')+'" style="width:100px"></td>'
    + '<td><input type="date" value="'+(p.start_date?p.start_date.slice(0,10):'')+'" style="width:130px"></td>'
    + '<td><input type="date" value="'+(p.end_date?p.end_date.slice(0,10):'')+'" style="width:130px"></td>'
    + '<td style="text-align:center"><input type="checkbox"'+(p.locked?' checked':'')+' ></td>'
    + '<td style="white-space:nowrap;text-align:right"></td>';
  var saveBtn = document.createElement('button');
  saveBtn.className = 'btn-sm';
  saveBtn.innerHTML = '\u{1F4BE}';
  saveBtn.title = 'Save';
  saveBtn.style.cssText = 'opacity:'+(isNew?'1':'0.35')+';margin-right:4px';
  saveBtn.onclick = function(){ savePeriodRow(tr); };
  var delBtn = document.createElement('button');
  delBtn.className = 'btn-sm danger';
  delBtn.innerHTML = '\u2715';
  delBtn.title = 'Delete';
  delBtn.onclick = function(){ deletePeriodRow(tr); };
  tr.cells[tr.cells.length-1].appendChild(saveBtn);
  tr.cells[tr.cells.length-1].appendChild(delBtn);
  tr.querySelectorAll('input').forEach(function(el){
    el.addEventListener('input', function(){ saveBtn.style.opacity='1'; if(isNew&&el===tr.cells[0].querySelector('input')&&el.value.trim()){isNew=false;appendBlankPeriodRow();} });
    el.addEventListener('change', function(){ saveBtn.style.opacity='1'; });
  });
  document.getElementById('periods-body').appendChild(tr);
  return tr;
}
function appendBlankPeriodRow() {
  var tbody = document.getElementById('periods-body');
  var rows = tbody ? tbody.querySelectorAll('tr') : [];
  if (rows.length>0){ var li=rows[rows.length-1].cells[0].querySelector('input'); if(li&&!li.value.trim()) return; }
  addPeriodRow({});
}
function savePeriodRow(tr) {
  var inputs = tr.querySelectorAll('input');
  var nameVal = inputs[0].value.trim();
  var startVal = inputs[1].value;
  var endVal = inputs[2].value;
  if (!nameVal||!startVal||!endVal) { var m=document.getElementById('msg-periods'); if(m){m.textContent='Name, start and end required';m.className='msg err';} return; }
  var period = { period_id: tr.dataset.periodId || nameVal, period_name: nameVal, start_date: startVal, end_date: endVal, locked: inputs[3].checked };
  var saveBtn = tr.querySelector('button.btn-sm:not(.danger)');
  if (saveBtn) { saveBtn.innerHTML='\u23F3'; saveBtn.disabled=true; }
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'period.upsert', companyId: COMPANY, period: period }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var d=res.data||res; var m=document.getElementById('msg-periods');
      if (d.error||res.error) { if(m){m.textContent=d.error||res.error;m.className='msg err';} if(saveBtn){saveBtn.innerHTML='\u{1F4BE}';saveBtn.disabled=false;} }
      else { tr.dataset.periodId=nameVal; if(saveBtn){saveBtn.innerHTML='\u2713';saveBtn.style.opacity='0.35';saveBtn.disabled=false;setTimeout(function(){saveBtn.innerHTML='\u{1F4BE}';},1500);} if(m){m.textContent='Saved';m.className='msg ok';setTimeout(function(){m.textContent='';},2000);} }
    })
    .catch(function(e){ var m=document.getElementById('msg-periods'); if(m){m.textContent=e.message;m.className='msg err';} if(saveBtn){saveBtn.innerHTML='\u{1F4BE}';saveBtn.disabled=false;} });
}
function deletePeriodRow(tr) {
  var periodId = tr.dataset.periodId;
  if (!periodId) { tr.remove(); appendBlankPeriodRow(); return; }
  var name = tr.cells[0].querySelector('input').value.trim();
  if (!confirm('Delete period "'+name+'"?')) return;
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'period.delete', companyId: COMPANY, periodId: periodId }) })
    .then(function(r){ return r.json(); })
    .then(function(res){ var d=res.data||res; if(d.error||res.error){var m=document.getElementById('msg-periods');if(m){m.textContent=d.error||res.error;m.className='msg err';}}else{tr.remove();appendBlankPeriodRow();} })
    .catch(function(e){ var m=document.getElementById('msg-periods'); if(m){m.textContent=e.message;m.className='msg err';} });
}
// savePeriods replaced by per-row savePeriodRow
function loadPeriods() {
  var tbody = document.getElementById('periods-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'period.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var rows = res.data || res;
      if (Array.isArray(rows)) rows.forEach(function(p){ addPeriodRow(p); });
      appendBlankPeriodRow();
    })
    .catch(function(e){ console.error('loadPeriods:', e); });
}
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
        if (el) { el.addEventListener('input', function(){ markDirty('company'); }); el.addEventListener('change', function(){ markDirty('company'); }); }
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

// ========== COA ==========
var coaData = [];
var SUBTYPES = ['','Current Asset','Non-Current Asset','Current Liability','Non-Current Liability','Equity','Revenue','COGS','Operating Expense','Non-Operating Expense','Closing'];
var CF_CATS_COA = ['','Cash','Op-WC','Operating','Tax','Investing','Financing','NonCash','Excluded'];
var ACCT_TYPES = ['Asset','Liability','Equity','Revenue','Expense','Closing'];
function addCoaRow(a, isNew) {
  isNew = isNew || false;
  var tr = document.createElement('tr');
  tr.dataset.accountCode = isNew ? '' : (a.account_code || '');
  tr.dataset.isNew = isNew ? '1' : '0';
  var codeCell = isNew
    ? '<input type="text" value="" style="width:80px">'
    : '<span class="ro">' + a.account_code + '</span>';
  var typeCell = isNew
    ? '<select style="width:90px">' + ACCT_TYPES.map(function(t){ return '<option>'+t+'</option>'; }).join('') + '</select>'
    : '<span class="ro">' + (a.account_type||'') + '</span>';
  var subtypeOpts = SUBTYPES.map(function(s){ return '<option value="'+s+'"'+(s===(a.account_subtype||'')?' selected':'')+'>'+s+'</option>'; }).join('');
  var cfOpts = CF_CATS_COA.map(function(c){ return '<option value="'+c+'"'+(c===(a.cf_category||'')?' selected':'')+'>'+c+'</option>'; }).join('');
  tr.innerHTML = '<td>' + codeCell + '</td>'
    + '<td><input type="text" value="'+(a.account_name||'').replace(/"/g,'&quot;')+'" style="width:200px"></td>'
    + '<td>' + typeCell + '</td>'
    + '<td><select style="width:140px">'+subtypeOpts+'</select></td>'
    + '<td><select style="width:100px">'+cfOpts+'</select></td>'
    + '<td style="text-align:center"><input type="checkbox"'+(a.is_active===true?' checked':'')+' ></td>'
    + '<td style="white-space:nowrap;text-align:right"></td>';
  var saveBtn = document.createElement('button');
  saveBtn.className = 'btn-sm';
  saveBtn.innerHTML = '\u{1F4BE}';
  saveBtn.title = 'Save';
  saveBtn.style.cssText = 'opacity:'+(isNew?'1':'0.35')+';margin-right:4px';
  saveBtn.onclick = function(){ saveCoaRow(tr); };
  var delBtn = document.createElement('button');
  delBtn.className = 'btn-sm danger';
  delBtn.innerHTML = '\u2715';
  delBtn.title = 'Delete';
  delBtn.onclick = function(){ deleteCoaRow(tr); };
  tr.cells[tr.cells.length-1].appendChild(saveBtn);
  tr.cells[tr.cells.length-1].appendChild(delBtn);
  tr.querySelectorAll('input,select').forEach(function(el){
    el.addEventListener('input', function(){ saveBtn.style.opacity='1'; if(isNew&&el===tr.cells[0].querySelector('input')&&el.value.trim()){appendBlankCoaRow();} });
    el.addEventListener('change', function(){ saveBtn.style.opacity='1'; });
  });
  document.getElementById('coa-body').appendChild(tr);
  return tr;
}
function appendBlankCoaRow() {
  var tbody = document.getElementById('coa-body');
  var rows = tbody ? tbody.querySelectorAll('tr') : [];
  if (rows.length>0){ var li=rows[rows.length-1].cells[0].querySelector('input'); if(li&&!li.value.trim()) return; }
  addCoaRow({}, true);
}
function saveCoaRow(tr) {
  var isNew = tr.dataset.isNew === '1';
  var codeEl = tr.cells[0].querySelector('input,span.ro');
  var nameEl = tr.cells[1].querySelector('input');
  var typeEl = tr.cells[2].querySelector('select,span.ro');
  var subtypeEl = tr.cells[3].querySelector('select');
  var cfEl = tr.cells[4].querySelector('select');
  var activeEl = tr.cells[5].querySelector('input[type=checkbox]');
  var code = (codeEl && codeEl.value !== undefined ? codeEl.value : codeEl.textContent).trim();
  var name = nameEl ? nameEl.value.trim() : '';
  var type = (typeEl && typeEl.value !== undefined ? typeEl.value : typeEl.textContent).trim();
  if (!code||!name||!type) { var m=document.getElementById('msg-coa'); if(m){m.textContent='Code, name and type required';m.className='msg err';} return; }
  var account = { account_code: code, account_name: name, account_type: type, account_subtype: subtypeEl?subtypeEl.value||null:null, cf_category: cfEl?cfEl.value||null:null, is_active: activeEl?activeEl.checked:true };
  var saveBtn = tr.querySelector('button.btn-sm:not(.danger)');
  if (saveBtn) { saveBtn.innerHTML='\u23F3'; saveBtn.disabled=true; }
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'coa.upsert', companyId: COMPANY, account: account }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var d=res.data||res; var m=document.getElementById('msg-coa');
      if (d.error||res.error) { if(m){m.textContent=d.error||res.error;m.className='msg err';} if(saveBtn){saveBtn.innerHTML='\u{1F4BE}';saveBtn.disabled=false;} }
      else {
        tr.dataset.accountCode=code; tr.dataset.isNew='0';
        if(saveBtn){saveBtn.innerHTML='\u2713';saveBtn.style.opacity='0.35';saveBtn.disabled=false;setTimeout(function(){saveBtn.innerHTML='\u{1F4BE}';},1500);}
        if(m){m.textContent='Saved';m.className='msg ok';setTimeout(function(){m.textContent='';},2000);}
      }
    })
    .catch(function(e){ var m=document.getElementById('msg-coa'); if(m){m.textContent=e.message;m.className='msg err';} if(saveBtn){saveBtn.innerHTML='\u{1F4BE}';saveBtn.disabled=false;} });
}
function deleteCoaRow(tr) {
  var accountCode = tr.dataset.accountCode;
  if (!accountCode) { tr.remove(); appendBlankCoaRow(); return; }
  if (!confirm('Delete account "'+accountCode+'"? This will fail if the account has transactions.')) return;
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'coa.delete', companyId: COMPANY, accountCode: accountCode }) })
    .then(function(r){ return r.json(); })
    .then(function(res){ var d=res.data||res; if(d.error||res.error){var m=document.getElementById('msg-coa');if(m){m.textContent=d.error||res.error;m.className='msg err';}}else{tr.remove();appendBlankCoaRow();} })
    .catch(function(e){ var m=document.getElementById('msg-coa'); if(m){m.textContent=e.message;m.className='msg err';} });
}
function loadCoa() {
  fetch('/api/' + COMPANY + '/accounts').then(function(r){ return r.json(); }).then(function(rows){
    coaData = rows;
    document.getElementById('coa-body').innerHTML = '';
    rows.forEach(function(a){ addCoaRow(a, false); });
    appendBlankCoaRow();
  });
}
function filterCoa() {
  var q = document.getElementById('coa-search').value.toLowerCase();
  var filtered = q ? coaData.filter(function(a){ return (a.account_code||'').toLowerCase().includes(q) || (a.account_name||'').toLowerCase().includes(q); }) : coaData;
  document.getElementById('coa-body').innerHTML = '';
  filtered.forEach(function(a){ addCoaRow(a, false); });
  appendBlankCoaRow();
}
// saveCoa replaced by per-row saveCoaRow

// ========== VAT/GST CODES ==========
function addVatRow(vc) {
  vc = vc || {};
  var isNew = !vc.vat_code;
  var tr = document.createElement('tr');
  tr.dataset.vatCode = vc.vat_code || '';
  tr.innerHTML = '<td><input type="text" value="'+(vc.vat_code||'')+'" style="width:60px"></td>'
    + '<td><input type="text" value="'+(vc.description||'').replace(/"/g,'&quot;')+'" style="width:160px"></td>'
    + '<td><input type="number" step="0.01" value="'+(vc.rate||0)+'" style="width:55px"></td>'
    + '<td><input type="text" value="'+(vc.input_account||vc.vat_account_input||'')+'" style="width:70px"></td>'
    + '<td><input type="text" value="'+(vc.output_account||vc.vat_account_output||'')+'" style="width:70px"></td>'
    + '<td><input type="text" value="'+(vc.report_box||'')+'" style="width:50px"></td>'
    + '<td style="text-align:center"><input type="checkbox"'+(vc.is_reverse_charge?' checked':'')+' ></td>'
    + '<td style="text-align:center"><input type="checkbox"'+(vc.is_active===true?' checked':'')+' ></td>'
    + '<td style="white-space:nowrap;text-align:right"></td>';
  var saveBtn = document.createElement('button');
  saveBtn.className = 'btn-sm';
  saveBtn.innerHTML = '\u{1F4BE}';
  saveBtn.title = 'Save';
  saveBtn.style.cssText = 'opacity:'+(isNew?'1':'0.35')+';margin-right:4px';
  saveBtn.onclick = function(){ saveVatRow(tr); };
  var delBtn = document.createElement('button');
  delBtn.className = 'btn-sm danger';
  delBtn.innerHTML = '\u2715';
  delBtn.title = 'Delete';
  delBtn.onclick = function(){ deleteVatRow(tr); };
  tr.cells[tr.cells.length-1].appendChild(saveBtn);
  tr.cells[tr.cells.length-1].appendChild(delBtn);
  tr.querySelectorAll('input').forEach(function(el){
    el.addEventListener('input', function(){ saveBtn.style.opacity='1'; if(isNew&&el===tr.cells[0].querySelector('input')&&el.value.trim()){isNew=false;appendBlankVatRow();} });
    el.addEventListener('change', function(){ saveBtn.style.opacity='1'; });
  });
  document.getElementById('vat-body').appendChild(tr);
  return tr;
}
function appendBlankVatRow() {
  var tbody=document.getElementById('vat-body');
  var rows=tbody?tbody.querySelectorAll('tr'):[];
  if(rows.length>0){var li=rows[rows.length-1].cells[0].querySelector('input');if(li&&!li.value.trim())return;}
  addVatRow({});
}
function saveVatRow(tr) {
  var inputs = tr.querySelectorAll('input[type=text],input[type=number]');
  var checks = tr.querySelectorAll('input[type=checkbox]');
  var code = inputs[0].value.trim();
  if (!code) { var m=document.getElementById('msg-vat'); if(m){m.textContent='VAT code required';m.className='msg err';} return; }
  var vatCode = { vat_code: tr.dataset.vatCode || code, description: inputs[1].value.trim()||null, rate: parseFloat(inputs[2].value)||0, input_account: inputs[3].value.trim()||null, output_account: inputs[4].value.trim()||null, report_box: inputs[5].value.trim()||null, is_reverse_charge: checks[0].checked, is_active: checks[1].checked };
  var saveBtn=tr.querySelector('button.btn-sm:not(.danger)');
  if(saveBtn){saveBtn.innerHTML='\u23F3';saveBtn.disabled=true;}
  fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'vat.codes.upsert',companyId:COMPANY,vatCode:vatCode})})
    .then(function(r){return r.json();})
    .then(function(res){var d=res.data||res;var m=document.getElementById('msg-vat');
      if(d.error||res.error){if(m){m.textContent=d.error||res.error;m.className='msg err';}if(saveBtn){saveBtn.innerHTML='\u{1F4BE}';saveBtn.disabled=false;}}
      else{tr.dataset.vatCode=code;if(saveBtn){saveBtn.innerHTML='\u2713';saveBtn.style.opacity='0.35';saveBtn.disabled=false;setTimeout(function(){saveBtn.innerHTML='\u{1F4BE}';},1500);}if(m){m.textContent='Saved';m.className='msg ok';setTimeout(function(){m.textContent='';},2000);}}
    })
    .catch(function(e){var m=document.getElementById('msg-vat');if(m){m.textContent=e.message;m.className='msg err';}if(saveBtn){saveBtn.innerHTML='\u{1F4BE}';saveBtn.disabled=false;}});
}
function deleteVatRow(tr) {
  var vatCode=tr.dataset.vatCode;
  if(!vatCode){tr.remove();appendBlankVatRow();return;}
  if(!confirm('Delete VAT code "'+vatCode+'"?'))return;
  fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'vat.codes.delete',companyId:COMPANY,vatCode:vatCode})})
    .then(function(r){return r.json();})
    .then(function(res){var d=res.data||res;if(d.error||res.error){var m=document.getElementById('msg-vat');if(m){m.textContent=d.error||res.error;m.className='msg err';}}else{tr.remove();appendBlankVatRow();}})
    .catch(function(e){var m=document.getElementById('msg-vat');if(m){m.textContent=e.message;m.className='msg err';}});
}
function loadVat() {
  document.getElementById('vat-body').innerHTML = '';
  fetch('/api/'+COMPANY+'/vat-codes').then(function(r){ return r.json(); }).then(function(rows){
    if (Array.isArray(rows)) rows.forEach(addVatRow);
    appendBlankVatRow();
  });
}
// saveVat replaced by per-row saveVatRow

// ========== JOURNALS ==========
function addJournalRow(j) {
  j = j || {};
  var isNew = !j.journal_id;
  var tr = document.createElement('tr');
  tr.dataset.journalId = j.journal_id || '';
  tr.innerHTML = '<td><input type="text" value="'+(j.code||'')+'" style="width:70px" oninput="this.value=this.value.toUpperCase()"></td>'
    + '<td><input type="text" value="'+(j.name||'')+'" style="width:180px"></td>'
    + '<td style="text-align:center"><input type="checkbox"'+(j.active===true?' checked':'')+' ></td>'
    + '<td style="white-space:nowrap;text-align:right"></td>';
  var saveBtn=document.createElement('button');
  saveBtn.className='btn-sm';
  saveBtn.innerHTML='\u{1F4BE}';
  saveBtn.title='Save';
  saveBtn.style.cssText='opacity:'+(isNew?'1':'0.35')+';margin-right:4px';
  saveBtn.onclick=function(){saveJournalRow(tr);};
  var delBtn=document.createElement('button');
  delBtn.className='btn-sm danger';
  delBtn.innerHTML='\u2715';
  delBtn.title='Delete (soft)';
  delBtn.onclick=function(){deleteJournalRow(tr);};
  tr.cells[tr.cells.length-1].appendChild(saveBtn);
  tr.cells[tr.cells.length-1].appendChild(delBtn);
  tr.querySelectorAll('input').forEach(function(el){
    el.addEventListener('input',function(){saveBtn.style.opacity='1';if(isNew&&el===tr.cells[0].querySelector('input')&&el.value.trim()){isNew=false;appendBlankJournalRow();}});
    el.addEventListener('change',function(){saveBtn.style.opacity='1';});
  });
  document.getElementById('journals-body').appendChild(tr);
  return tr;
}
function appendBlankJournalRow(){
  var tbody=document.getElementById('journals-body');
  var rows=tbody?tbody.querySelectorAll('tr'):[];
  if(rows.length>0){var li=rows[rows.length-1].cells[0].querySelector('input');if(li&&!li.value.trim())return;}
  addJournalRow({});
}
function saveJournalRow(tr){
  var inputs=tr.querySelectorAll('input[type=text]');
  var cb=tr.querySelector('input[type=checkbox]');
  var code=inputs[0].value.trim().toUpperCase();
  var name=inputs[1].value.trim();
  if(!code||!name){var m=document.getElementById('msg-journals');if(m){m.textContent='Code and name required';m.className='msg err';}return;}
  var journal={journal_id:tr.dataset.journalId||null,code:code,name:name,active:cb?cb.checked:true};
  var saveBtn=tr.querySelector('button.btn-sm:not(.danger)');
  if(saveBtn){saveBtn.innerHTML='\u23F3';saveBtn.disabled=true;}
  fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'journals.save',companyId:COMPANY,journal:journal})})
    .then(function(r){return r.json();})
    .then(function(res){var d=res.data||res;var m=document.getElementById('msg-journals');
      if(d.error||res.error){if(m){m.textContent=d.error||res.error;m.className='msg err';}if(saveBtn){saveBtn.innerHTML='\u{1F4BE}';saveBtn.disabled=false;}}
      else{if(d.journalId)tr.dataset.journalId=d.journalId;if(saveBtn){saveBtn.innerHTML='\u2713';saveBtn.style.opacity='0.35';saveBtn.disabled=false;setTimeout(function(){saveBtn.innerHTML='\u{1F4BE}';},1500);}if(m){m.textContent='Saved';m.className='msg ok';setTimeout(function(){m.textContent='';},2000);}}
    })
    .catch(function(e){var m=document.getElementById('msg-journals');if(m){m.textContent=e.message;m.className='msg err';}if(saveBtn){saveBtn.innerHTML='\u{1F4BE}';saveBtn.disabled=false;}});
}
function deleteJournalRow(tr){
  var journalId=tr.dataset.journalId;
  if(!journalId){tr.remove();appendBlankJournalRow();return;}
  var code=tr.cells[0].querySelector('input').value.trim();
  if(!confirm('Deactivate journal "'+code+'"? (soft delete \u2014 existing references preserved)'))return;
  fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'journals.delete',companyId:COMPANY,journalId:journalId})})
    .then(function(r){return r.json();})
    .then(function(res){var d=res.data||res;if(d.error||res.error){var m=document.getElementById('msg-journals');if(m){m.textContent=d.error||res.error;m.className='msg err';}}else{tr.remove();appendBlankJournalRow();}})
    .catch(function(e){var m=document.getElementById('msg-journals');if(m){m.textContent=e.message;m.className='msg err';}});
}
function loadJournals() {
  document.getElementById('journals-body').innerHTML = '';
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'journals.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); }).then(function(res){
      var rows = res.data||res;
      if (Array.isArray(rows)) rows.forEach(addJournalRow);
      appendBlankJournalRow();
    });
}
// saveJournals replaced by per-row saveJournalRow

function loadVendorAccounts() {
  fetch('/api/' + COMPANY + '/accounts').then(function(r){ return r.json(); }).then(function(rows){
    vendorAccountsList = Array.isArray(rows) ? rows : [];
  }).catch(function(e){ console.error('loadVendorAccounts failed:', e); });
}

// ========== HANDLE ?tab= URL PARAM ==========
(function() {
  var params = new URLSearchParams(window.location.search);
  var tab = params.get('tab');
  loadCurrencyDatalist();
  showTab(tab || 'company');
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
      if (vendorAcctActiveInput) {
        vendorAcctActiveInput.value = a.account_code;
        // Update paired name span if present (e.g. co-fx-account-name)
        var nameSpan = vendorAcctActiveInput.parentElement && vendorAcctActiveInput.parentElement.querySelector('span[id$="-name"]');
        if (nameSpan) nameSpan.textContent = a.account_name || '';
        // Trigger input event so change listeners (enable Save button) fire
        vendorAcctActiveInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
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
// CHANGE 4: Validate vendor account fields
function validateVendorAcctField(input) {
  hideVendorAcctDd();
  var code = input.value.trim();
  var statusEl = input.nextElementSibling;
  if (!statusEl || !statusEl.classList.contains('vendor-acct-status')) return;
  if (!code) {
    statusEl.textContent = '';
    return;
  }
  var found = vendorAccountsList.find(function(a) { return a.account_code === code; });
  if (found) {
    statusEl.textContent = '✓';
    statusEl.style.color = '#2a8a2a';
  } else {
    statusEl.textContent = '✗';
    statusEl.style.color = '#cc2222';
  }
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
