'use strict';
const { commonStyle } = require('./common');

async function handleBillNewPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildBillNewPage(company));
}

function buildBillNewPage(company) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>New Bill — freeBooks</title>
${commonStyle()}
<style>
  .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px 24px; max-width:700px; margin-bottom:20px; }
  .form-grid .full { grid-column:1 / -1; }
  .form-group { display:flex; flex-direction:column; gap:4px; }
  .form-group label { font-weight:600; font-size:10pt; color:#555; }
  .form-group input, .form-group select, .form-group textarea {
    padding:7px 10px; border:1px solid #ccc; border-radius:4px; font-size:10pt; }
  .form-group input:focus, .form-group select:focus { outline:none; border-color:#888; }
  .form-group .err { color:#cc2222; font-size:9pt; margin-top:2px; display:none; }
  button.btn-primary { padding:10px 24px; background:#1a1a1a; color:#fff; border:none; border-radius:4px;
    font-size:11pt; font-weight:600; cursor:pointer; }
  button.btn-primary:hover:not(:disabled) { background:#333; }
  button.btn-primary:disabled { opacity:0.4; cursor:default; }
  .success-box { background:#f0fff4; border:1px solid #2a8a2a; border-radius:6px; padding:20px 24px;
    max-width:500px; }
  .success-box h2 { color:#2a8a2a; margin:0 0 10px; }
  .success-box a { color:#1a1a1a; font-weight:600; }
  .acct-wrap { position:relative; }
  .acct-row { display:flex; gap:6px; align-items:flex-start; }
  .acct-row input.code { width:90px; flex-shrink:0; }
  .acct-row input.name { flex:1; color:#555; }
  .acct-hint { font-size:8pt; color:#888; margin-top:2px; }
  .vendor-wrap { position:relative; }
</style>
</head>
<body>
<div class="page">
  <div class="back" style="display:flex;justify-content:space-between;align-items:center">
    <a href="/${company}">← Reports</a>
    <a href="/${company}/settings">⚙ Settings</a>
  </div>
  <div class="header">
    <h1>📄 New Bill</h1>
    <p class="sub">${company}</p>
  </div>

  <div id="success-panel" style="display:none" class="success-box">
    <h2>✓ Bill created</h2>
    <p>Bill ID: <strong id="success-bill-id"></strong></p>
    <div style="display:flex;gap:16px;margin-top:14px">
      <a href="#" onclick="resetForm(); return false">↩ Enter Another</a>
      <a href="/${company}">← Back to Reports</a>
    </div>
  </div>

  <div id="bill-form">
    <div class="form-grid">
      <!-- Vendor -->
      <div class="form-group">
        <label>Vendor *</label>
        <div class="vendor-wrap">
          <input type="text" id="vendor-name-input" placeholder="Search vendor…" autocomplete="off"
            oninput="onVendorInput(this)" onblur="hideVendorDropdown()">
          <input type="hidden" id="vendor-id-input">
        </div>
        <div class="err" id="err-vendor">Vendor is required</div>
      </div>
      <!-- Invoice Ref -->
      <div class="form-group">
        <label>Invoice Ref</label>
        <input type="text" id="vendor-ref" placeholder="e.g. INV-2024-001">
      </div>
      <!-- Bill Date -->
      <div class="form-group">
        <label>Bill Date *</label>
        <input type="date" id="bill-date">
        <div class="err" id="err-date">Date is required</div>
      </div>
      <!-- Due Date -->
      <div class="form-group">
        <label>Due Date</label>
        <input type="date" id="due-date">
      </div>
      <!-- Amount -->
      <div class="form-group">
        <label>Amount *</label>
        <input type="number" id="amount" min="0" step="0.01" placeholder="0.00">
        <div class="err" id="err-amount">Valid amount required</div>
      </div>
      <!-- Currency -->
      <div class="form-group">
        <label>Currency</label>
        <input type="text" id="currency" maxlength="3" placeholder="e.g. SGD" style="text-transform:uppercase">
      </div>
      <!-- Expense Account -->
      <div class="form-group">
        <label>Expense Account *</label>
        <div class="acct-row">
          <input type="text" class="code" id="expense-code" placeholder="401000"
            oninput="onCodeInput(this,'expense-name','expense-hint')" onblur="hideAcctDropdown()" autocomplete="off">
          <input type="text" class="name" id="expense-name" placeholder="search by name"
            oninput="onNameInput(this,'expense-code','expense-hint')" onblur="hideAcctDropdown()" autocomplete="off">
        </div>
        <div class="acct-hint" id="expense-hint"></div>
        <div class="err" id="err-expense">Valid expense account required</div>
      </div>
      <!-- AP Account -->
      <div class="form-group">
        <label>AP Account *</label>
        <div class="acct-row">
          <input type="text" class="code" id="ap-code" placeholder="201130"
            oninput="onCodeInput(this,'ap-name','ap-hint')" onblur="hideAcctDropdown()" autocomplete="off">
          <input type="text" class="name" id="ap-name" placeholder="search by name"
            oninput="onNameInput(this,'ap-code','ap-hint')" onblur="hideAcctDropdown()" autocomplete="off">
        </div>
        <div class="acct-hint" id="ap-hint"></div>
        <div class="err" id="err-ap">Valid AP account required</div>
      </div>
      <!-- VAT Code -->
      <div class="form-group">
        <label>VAT Code</label>
        <select id="vat-code"><option value="">— none —</option></select>
      </div>
      <!-- Description -->
      <div class="form-group full">
        <label>Description</label>
        <input type="text" id="description" placeholder="e.g. Office supplies for Jan 2025">
      </div>
    </div>

    <div style="display:flex;gap:12px;align-items:center">
      <button class="btn-primary" id="btn-submit" onclick="submitBill()">Create Bill</button>
      <span id="status-msg" style="font-size:10pt"></span>
    </div>
  </div>
</div>

<script>
  var COMPANY = '${company}';
  var accountsMap = {};
  var vendorsList = [];

  // Load accounts
  fetch('/api/' + COMPANY + '/accounts')
    .then(function(r){ return r.json(); })
    .then(function(rows){
      rows.forEach(function(a){ accountsMap[a.account_code] = a.account_name; });
      // Default AP account to 201130 if it exists
      if (accountsMap['201130']) {
        document.getElementById('ap-code').value = '201130';
        document.getElementById('ap-name').value = accountsMap['201130'];
        document.getElementById('ap-hint').textContent = accountsMap['201130'];
      }
    });

  // Load VAT codes
  fetch('/api/' + COMPANY + '/vat-codes')
    .then(function(r){ return r.json(); })
    .then(function(rows){
      if (!Array.isArray(rows)) return;
      var sel = document.getElementById('vat-code');
      rows.filter(function(v){ return v.is_active !== false; }).forEach(function(v){
        var opt = document.createElement('option');
        opt.value = v.vat_code;
        opt.textContent = v.vat_code + ' — ' + v.description;
        sel.appendChild(opt);
      });
    }).catch(function(){});

  // Load vendors
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'vendor.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); })
    .then(function(res){ vendorsList = res.data || res || []; })
    .catch(function(){});

  // Set default dates
  var today = new Date().toISOString().slice(0, 10);
  document.getElementById('bill-date').value = today;
  var due = new Date(); due.setDate(due.getDate() + 30);
  document.getElementById('due-date').value = due.toISOString().slice(0, 10);

  // ── Vendor autocomplete ──────────────────────────────────────────────
  var vendorDropdown = null;

  function onVendorInput(input) {
    var q = input.value.trim().toLowerCase();
    document.getElementById('vendor-id-input').value = '';
    if (!q) { hideVendorDropdown(); return; }
    var matches = vendorsList.filter(function(v){
      return (v.name||'').toLowerCase().includes(q) || (v.vendor_id||'').toLowerCase().includes(q);
    }).slice(0, 15);
    showVendorDropdown(input, matches);
  }

  function showVendorDropdown(input, matches) {
    hideVendorDropdown();
    if (!matches.length) return;
    var rect = input.getBoundingClientRect();
    var div = document.createElement('div');
    div.id = 'vendor-dd';
    div.style.cssText = 'position:fixed;z-index:9999;background:#fff;border:1px solid #ccc;border-radius:4px;'
      + 'box-shadow:0 3px 10px rgba(0,0,0,.15);max-height:200px;overflow-y:auto;min-width:260px;font-size:10pt;'
      + 'top:'+(rect.bottom+2)+'px;left:'+rect.left+'px';
    matches.forEach(function(v){
      var row = document.createElement('div');
      row.style.cssText = 'padding:7px 10px;cursor:pointer';
      row.textContent = v.name || v.vendor_id;
      row.onmousedown = function(e){
        e.preventDefault();
        document.getElementById('vendor-name-input').value = v.name || v.vendor_id;
        document.getElementById('vendor-id-input').value = v.vendor_id;
        hideVendorDropdown();
      };
      row.onmouseover = function(){ row.style.background='#f0f4ff'; };
      row.onmouseout  = function(){ row.style.background=''; };
      div.appendChild(row);
    });
    document.body.appendChild(div);
    vendorDropdown = div;
  }

  function hideVendorDropdown() {
    if (vendorDropdown) { vendorDropdown.remove(); vendorDropdown = null; }
  }

  // ── Account autocomplete ─────────────────────────────────────────────
  var acctDropdown = null;
  var acctDropdownMeta = null; // { codeId, nameId, hintId }

  function getAccountList() {
    return Object.keys(accountsMap).map(function(code){ return { code: code, name: accountsMap[code] }; });
  }

  function showAcctDropdown(input, matches, codeId, nameId, hintId) {
    hideAcctDropdown();
    if (!matches.length) return;
    var rect = input.getBoundingClientRect();
    var div = document.createElement('div');
    div.id = 'acct-dd';
    div.style.cssText = 'position:fixed;z-index:9999;background:#fff;border:1px solid #ccc;border-radius:4px;'
      + 'box-shadow:0 3px 10px rgba(0,0,0,.15);max-height:220px;overflow-y:auto;min-width:300px;font-size:10pt;'
      + 'top:'+(rect.bottom+2)+'px;left:'+rect.left+'px';
    matches.slice(0, 20).forEach(function(a){
      var row = document.createElement('div');
      row.style.cssText = 'padding:6px 10px;cursor:pointer;display:flex;gap:10px;align-items:baseline';
      row.innerHTML = '<span style="font-weight:600;color:#333;min-width:70px">'+a.code+'</span>'
        +'<span style="color:#666">'+a.name+'</span>';
      row.onmousedown = function(e){
        e.preventDefault();
        document.getElementById(codeId).value = a.code;
        document.getElementById(nameId).value = a.name;
        document.getElementById(hintId).textContent = a.name;
        hideAcctDropdown();
      };
      row.onmouseover = function(){ row.style.background='#f0f4ff'; };
      row.onmouseout  = function(){ row.style.background=''; };
      div.appendChild(row);
    });
    document.body.appendChild(div);
    acctDropdown = div;
    acctDropdownMeta = { codeId: codeId, nameId: nameId, hintId: hintId };
  }

  function hideAcctDropdown() {
    if (acctDropdown) { acctDropdown.remove(); acctDropdown = null; }
    acctDropdownMeta = null;
  }

  function onCodeInput(input, nameId, hintId) {
    var q = input.value.trim();
    var hintEl = document.getElementById(hintId);
    if (accountsMap[q]) {
      document.getElementById(nameId).value = accountsMap[q];
      hintEl.textContent = accountsMap[q];
    } else {
      document.getElementById(nameId).value = '';
      hintEl.textContent = '';
    }
    if (!q) { hideAcctDropdown(); return; }
    var matches = getAccountList().filter(function(a){
      return a.code.toLowerCase().startsWith(q.toLowerCase()) || a.code.toLowerCase().includes(q.toLowerCase());
    }).sort(function(a,b){ return a.code.localeCompare(b.code); });
    showAcctDropdown(input, matches, input.id, nameId, hintId);
  }

  function onNameInput(input, codeId, hintId) {
    var q = input.value.trim().toLowerCase();
    if (!q) { hideAcctDropdown(); return; }
    var matches = getAccountList().filter(function(a){ return a.name.toLowerCase().includes(q); })
      .sort(function(a,b){ return a.name.localeCompare(b.name); });
    showAcctDropdown(input, matches, codeId, input.id, hintId);
  }

  document.addEventListener('click', function(e){
    if (acctDropdown && !acctDropdown.contains(e.target)) hideAcctDropdown();
    if (vendorDropdown && !vendorDropdown.contains(e.target)) hideVendorDropdown();
  });

  // ── Submit ────────────────────────────────────────────────────────────
  function submitBill() {
    // Clear errors
    document.querySelectorAll('.err').forEach(function(el){ el.style.display='none'; });

    var vendorId   = document.getElementById('vendor-id-input').value.trim();
    var vendorName = document.getElementById('vendor-name-input').value.trim();
    var vendorRef  = document.getElementById('vendor-ref').value.trim();
    var billDate   = document.getElementById('bill-date').value;
    var dueDate    = document.getElementById('due-date').value;
    var amount     = parseFloat(document.getElementById('amount').value);
    var currency   = document.getElementById('currency').value.trim().toUpperCase();
    var expCode    = document.getElementById('expense-code').value.trim();
    var apCode     = document.getElementById('ap-code').value.trim();
    var vatCode    = document.getElementById('vat-code').value;
    var description= document.getElementById('description').value.trim();

    var valid = true;
    if (!vendorId && !vendorName) {
      document.getElementById('err-vendor').style.display = '';
      valid = false;
    }
    if (!billDate) {
      document.getElementById('err-date').style.display = '';
      valid = false;
    }
    if (!amount || amount <= 0) {
      document.getElementById('err-amount').style.display = '';
      valid = false;
    }
    if (!expCode || !accountsMap[expCode]) {
      document.getElementById('err-expense').style.display = '';
      valid = false;
    }
    if (!apCode || !accountsMap[apCode]) {
      document.getElementById('err-ap').style.display = '';
      valid = false;
    }
    if (!valid) return;

    document.getElementById('btn-submit').disabled = true;
    showStatus('Creating bill…', false);

    var payload = {
      action: 'bill.create',
      companyId: COMPANY,
      vendorId: vendorId || null,
      vendorName: vendorName || null,
      vendor_ref: vendorRef || null,
      bill_date: billDate,
      due_date: dueDate || null,
      amount: amount,
      currency: currency || null,
      expense_account: expCode,
      ap_account: apCode,
      vat_code: vatCode || null,
      description: description || null
    };

    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        var d = res.data || res;
        if (res.error || d.error || (d.errors && d.errors.length)) {
          var msg = d.errors ? d.errors.join('; ') : (res.error || d.error);
          showStatus(msg, true);
          document.getElementById('btn-submit').disabled = false;
        } else {
          var billId = d.bill_id || d.billId || d.id || '(created)';
          document.getElementById('success-bill-id').textContent = billId;
          document.getElementById('bill-form').style.display = 'none';
          document.getElementById('success-panel').style.display = '';
          document.getElementById('status-msg').textContent = '';
        }
      })
      .catch(function(e){
        showStatus(e.message, true);
        document.getElementById('btn-submit').disabled = false;
      });
  }

  function resetForm() {
    document.getElementById('bill-form').style.display = '';
    document.getElementById('success-panel').style.display = 'none';
    document.getElementById('btn-submit').disabled = false;
    document.getElementById('vendor-name-input').value = '';
    document.getElementById('vendor-id-input').value = '';
    document.getElementById('vendor-ref').value = '';
    document.getElementById('amount').value = '';
    document.getElementById('description').value = '';
    document.getElementById('vat-code').value = '';
    var today2 = new Date().toISOString().slice(0,10);
    document.getElementById('bill-date').value = today2;
    var due2 = new Date(); due2.setDate(due2.getDate() + 30);
    document.getElementById('due-date').value = due2.toISOString().slice(0,10);
    document.querySelectorAll('.err').forEach(function(el){ el.style.display='none'; });
    showStatus('', false);
  }

  function showStatus(msg, isErr) {
    var el = document.getElementById('status-msg');
    el.textContent = msg;
    el.style.color = isErr ? '#cc2222' : '#2a8a2a';
  }
<\/script>
</body>
</html>`;
}

module.exports = { handleBillNewPage };
