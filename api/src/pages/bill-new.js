'use strict';
const { commonStyle, navBar } = require('./common');

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
  /* Lines table */
  .lines-section { max-width:900px; margin-bottom:18px; }
  .lines-section h3 { font-size:10pt; color:#555; font-weight:600; margin:0 0 8px; }
  table.lines-table { width:100%; border-collapse:collapse; font-size:10pt; }
  table.lines-table th { text-align:left; font-size:9pt; color:#555; text-transform:uppercase;
    border-bottom:1px solid #ccc; padding:5px 6px; }
  table.lines-table td { padding:4px 4px; border-bottom:1px solid #f0f0f0; vertical-align:middle; }
  table.lines-table input[type=text], table.lines-table input[type=number] {
    padding:5px 7px; border:1px solid #ddd; border-radius:3px; font-size:10pt; }
  table.lines-table select { padding:5px 7px; border:1px solid #ddd; border-radius:3px; font-size:10pt; }
  .btn-remove { background:none; border:none; color:#cc2222; font-size:13pt; cursor:pointer;
    padding:0 4px; line-height:1; }
  .btn-remove:disabled { color:#ccc; cursor:default; }
  .btn-add-line { margin-top:8px; padding:6px 16px; font-size:10pt; cursor:pointer;
    border:1px solid #ccc; border-radius:3px; background:#f5f5f5; }
  .btn-add-line:hover { background:#e8e8e8; }
  .total-row { margin-top:8px; font-size:11pt; font-weight:600; text-align:right; max-width:900px; }
  .line-acct-wrap { position:relative; display:flex; gap:4px; }
  .line-acct-wrap input.lcode { width:80px; }
  .line-acct-wrap input.lname { width:140px; color:#555; }

</style>
</head>
<body>
<div class="page">
  ${navBar(company, 'payables')}
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
        <input type="date" id="bill-date" onchange="recalcDueDate()">
        <div class="err" id="err-date">Date is required</div>
      </div>
      <!-- Due Date -->
      <div class="form-group">
        <label>Due Date</label>
        <input type="date" id="due-date">
      </div>
      <!-- Currency -->
      <div class="form-group">
        <label>Currency</label>
        <input type="text" id="currency" maxlength="3" placeholder="e.g. SGD" style="text-transform:uppercase" onchange="onCurrencyChange()" list="bill-currency-list">
      </div>
      <datalist id="bill-currency-list"></datalist>
      <!-- FX Rate -->
      <div class="form-group">
        <label>FX Rate</label>
        <div style="display:flex;gap:8px;align-items:flex-start">
          <input type="number" id="fx-rate" placeholder="1.0" step="0.0001" style="flex:1">
          <button type="button" class="btn-sm" id="btn-get-rate" onclick="getRate()" style="padding:7px 12px;font-size:10pt;display:none">Get Rate</button>
        </div>
        <span id="fx-rate-hint" style="font-size:9pt;color:#666"></span>
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
      <!-- Description (overall) -->
      <div class="form-group full">
        <label>Description (overall)</label>
        <input type="text" id="description" placeholder="e.g. Office supplies for Jan 2025">
      </div>
    </div>

    <!-- Expense Lines -->
    <div class="lines-section">
      <h3>Expense Lines</h3>
      <table class="lines-table" id="lines-table">
        <thead>
          <tr>
            <th style="width:30px">#</th>
            <th>Expense Account</th>
            <th>Description</th>
            <th style="width:110px">Amount *</th>
            <th style="width:110px">VAT Code</th>
            <th style="width:30px"></th>
          </tr>
        </thead>
        <tbody id="lines-body"></tbody>
      </table>
      <button class="btn-add-line" onclick="addLine()">＋ Add Line</button>
      <div class="total-row" style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">
        <div style="font-weight:400;font-size:10pt;color:#555">Subtotal (net): <span id="lines-net">0.00</span></div>
        <div id="gst-rows"></div>
        <div style="border-top:1px solid #ccc;padding-top:4px;margin-top:2px">Total payable: <span id="lines-total">0.00</span></div>
      </div>
      <div class="err" id="err-lines" style="display:none;margin-top:6px">At least one expense line with a valid account and amount > 0 is required</div>
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
  var vatCodesList = [];
  var vendorsList = [];
  var lineCounter = 0;
  var _reenterId = new URLSearchParams(window.location.search).get('reenter');
  var _accountsLoaded = false, _vatLoaded = false;
  var homeCurrency = 'SGD';  // Default, will be loaded from company data

  // Load currencies datalist
  fetch('/db/currencies.json').then(function(r){ return r.json(); }).then(function(currencies){
    var dl = document.getElementById('bill-currency-list');
    if (!dl) return;
    currencies.forEach(function(c){
      var opt = document.createElement('option');
      opt.value = c.code;
      opt.label = c.code + ' — ' + c.name;
      dl.appendChild(opt);
    });
  }).catch(function(){});

  // Load company info to get home currency
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'company.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var list = res.data || res;
      var comp = Array.isArray(list) ? list.find(function(c){ return c.company_id === COMPANY; }) : list;
      if (comp && comp.currency) {
        homeCurrency = comp.currency.toUpperCase();
        var currencyInput = document.getElementById('currency');
        if (currencyInput && !currencyInput.value) {
          currencyInput.value = homeCurrency;
          onCurrencyChange();
        }
      }
    }).catch(function(){});

  // Load accounts
  fetch('/api/' + COMPANY + '/accounts')
    .then(function(r){ return r.json(); })
    .then(function(rows){
      rows.forEach(function(a){ accountsMap[a.account_code] = a.account_name; });
      // Default AP account to 201130 if it exists (only when NOT in reenter mode)
      if (!_reenterId && accountsMap['201130']) {
        document.getElementById('ap-code').value = '201130';
        document.getElementById('ap-name').value = accountsMap['201130'];
        document.getElementById('ap-hint').textContent = accountsMap['201130'];
      }
      _accountsLoaded = true;
      maybeFillReenter();
    });

  // Load VAT codes
  fetch('/api/' + COMPANY + '/vat-codes')
    .then(function(r){ return r.json(); })
    .then(function(rows){
      if (!Array.isArray(rows)) return;
      vatCodesList = rows.filter(function(v){ return v.is_active !== false; });
      // Re-render existing lines to populate selects and wire onchange
      document.querySelectorAll('.vat-select').forEach(function(sel){
        populateVatSelect(sel, sel.value);
        sel.onchange = function() { syncGstRow(sel.closest('tr')); };
      });
      document.querySelectorAll('#lines-body tr:not(.gst-row)').forEach(function(tr) {
        if (tr.dataset.line) syncGstRow(tr);
      });
      updateTotal();
      _vatLoaded = true;
      maybeFillReenter();
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
  var currentTermsDays = 30;
  function recalcDueDate() {
    var bd = document.getElementById('bill-date').value;
    if (!bd) return;
    var d = new Date(bd); d.setDate(d.getDate() + currentTermsDays);
    document.getElementById('due-date').value = d.toISOString().slice(0, 10);
  }
  recalcDueDate();

  // Add first line on load
  addLine();

  // ── FX Rate lookup ──────────────────────────────────────────────────
  function onCurrencyChange() {
    var currency = document.getElementById('currency').value.trim().toUpperCase();
    updateFxRateVisibility(currency);
    if (currency && currency !== homeCurrency) {
      getRate();
    }
  }

  function updateFxRateVisibility(currency) {
    var btn = document.getElementById('btn-get-rate');
    var hint = document.getElementById('fx-rate-hint');
    var fxRateInput = document.getElementById('fx-rate');
    
    if (!currency || currency === homeCurrency) {
      btn.style.display = 'none';
      hint.textContent = '';
      if (!currency || currency === homeCurrency) {
        fxRateInput.value = '1.0';
      }
    } else {
      btn.style.display = '';
    }
  }

  function getRate() {
    var billDate = document.getElementById('bill-date').value;
    var currency = document.getElementById('currency').value.trim().toUpperCase();
    var hint = document.getElementById('fx-rate-hint');
    var fxRateInput = document.getElementById('fx-rate');
    var btn = document.getElementById('btn-get-rate');

    if (!billDate || !currency || currency === homeCurrency) {
      return;
    }

    btn.disabled = true;
    hint.textContent = 'Loading...';

    fetchRate(billDate, currency, function(success, rate, rateDate, source) {
      if (success) {
        btn.disabled = false;
        fxRateInput.value = rate.toFixed(4);
        hint.textContent = 'Rate as of ' + rateDate + ' (' + source + ')';
      } else {
        // Not in DB — auto-fetch from ECB then retry
        fetchAndRetry(billDate, currency);
      }
    });
  }

  function fetchRate(billDate, billCurrency, callback) {
    fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'fx.rates.get',
        companyId: COMPANY,
        fromCurrency: billCurrency,
        toCurrency: homeCurrency,
        date: billDate
      })
    })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        var data = res.data || res;
        if (data && data.rate) {
          callback(true, data.rate, data.date || billDate, data.source || 'ECB');
        } else {
          callback(false, null, null, null);
        }
      })
      .catch(function(e) {
        console.error('FX rate fetch error:', e);
        callback(false, null, null, null);
      });
  }

  function fetchAndRetry(billDate, billCurrency) {

    var hint = document.getElementById('fx-rate-hint');
    var btn = document.getElementById('btn-get-rate');
    btn.disabled = true;
    hint.textContent = 'Fetching from ECB...';

    fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'fx.fetch_rates',
        companyId: COMPANY,
        date: billDate
      })
    })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        // Now retry the rate lookup
        fetchRate(billDate, billCurrency, function(success, rate, rateDate, source) {
          btn.disabled = false;
          if (success) {
            var fxRateInput = document.getElementById('fx-rate');
            fxRateInput.value = rate.toFixed(4);
            hint.textContent = 'Rate as of ' + rateDate + ' (' + source + ')';
          } else {
            hint.textContent = 'No rate found after fetch attempt.';
          }
        });
      })
      .catch(function(e) {
        console.error('ECB fetch error:', e);
        btn.disabled = false;
        hint.textContent = 'Error fetching rates from ECB.';
      });
  }

  // ── Re-enter mode ────────────────────────────────────────────────────
  if (_reenterId) {
    document.querySelector('.header h1').textContent = '📄 Re-enter Bill';
    var _banner = document.createElement('div');
    _banner.style.cssText = 'background:#fff3e0;border:1px solid #ff9800;border-radius:4px;padding:12px 16px;margin-bottom:16px;font-size:10pt;';
    _banner.innerHTML = '<strong>⟲ Re-entry mode</strong> &mdash; The original bill has been reversed. Fill in the corrected details and submit.';
    var _formGrid = document.querySelector('.form-grid');
    document.getElementById('bill-form').insertBefore(_banner, _formGrid);
  }

  function maybeFillReenter() {
    if (!_reenterId || !_accountsLoaded || !_vatLoaded) return;
    Promise.all([
      fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action:'bill.get', companyId: COMPANY, billId: _reenterId }) }).then(function(r){ return r.json(); }),
      fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action:'bill.lines', companyId: COMPANY, billId: _reenterId }) }).then(function(r){ return r.json(); })
    ]).then(function(results) {
      var billRes = results[0], linesRes = results[1];
      var bill = billRes.data || billRes;
      var lines = linesRes.data || linesRes;
      if (!bill || bill.error) return;
      // Pre-fill header fields
      document.getElementById('vendor-name-input').value = bill.vendor || '';
      document.getElementById('vendor-ref').value = bill.vendor_ref || '';
      if (bill.date) document.getElementById('bill-date').value = String(bill.date).slice(0,10);
      if (bill.due_date) document.getElementById('due-date').value = String(bill.due_date).slice(0,10);
      if (bill.currency) document.getElementById('currency').value = bill.currency;
      if (bill.ap_account) {
        document.getElementById('ap-code').value = bill.ap_account;
        document.getElementById('ap-name').value = accountsMap[bill.ap_account] || bill.ap_account;
        document.getElementById('ap-hint').textContent = accountsMap[bill.ap_account] || '';
      }
      if (bill.description) document.getElementById('description').value = bill.description;
      // Replace default line with bill lines
      if (Array.isArray(lines) && lines.length > 0) {
        document.getElementById('lines-body').innerHTML = '';
        lineCounter = 0;
        lines.forEach(function(l) {
          addLine({ expense_account: l.account_code, amount: Number(l.amount||0).toFixed(2),
            vat_code: l.vat_code || '', description: l.description || '' });
        });
      }
      updateTotal();
    }).catch(function(){});
  }

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
        autoFillVendor(v);
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

  function autoFillVendor(v) {
    // Payment terms → recalc due date
    if (v.payment_terms_days) {
      currentTermsDays = parseInt(v.payment_terms_days) || 30;
      recalcDueDate();
    }
    // Currency
    if (v.default_currency) {
      document.getElementById('currency').value = v.default_currency;
    }
    // AP account
    if (v.default_ap_account) {
      var apCode = v.default_ap_account;
      document.getElementById('ap-code').value = apCode;
      if (accountsMap[apCode]) {
        document.getElementById('ap-name').value = accountsMap[apCode];
        document.getElementById('ap-hint').textContent = accountsMap[apCode];
      } else {
        document.getElementById('ap-name').value = '';
        document.getElementById('ap-hint').textContent = '';
      }
    }
    // Expense account — first line
    if (v.default_expense_account) {
      var firstRow = document.querySelector('#lines-body tr');
      if (firstRow) {
        var lcodeEl = firstRow.querySelector('.lcode');
        var lnameEl = firstRow.querySelector('.lname');
        var lineIdx = lcodeEl ? lcodeEl.dataset.line : null;
        if (lcodeEl) {
          lcodeEl.value = v.default_expense_account;
          if (accountsMap[v.default_expense_account]) {
            if (lnameEl) lnameEl.value = accountsMap[v.default_expense_account];
          } else {
            if (lnameEl) lnameEl.value = '';
          }
        }
      }
    }
  }

  // ── VAT select helpers ────────────────────────────────────────────────
  function populateVatSelect(sel, currentVal) {
    var prev = currentVal || sel.value || '';
    sel.innerHTML = '<option value="">— none —</option>';
    vatCodesList.forEach(function(v){
      var opt = document.createElement('option');
      opt.value = v.vat_code;
      opt.textContent = v.vat_code + ' — ' + v.description;
      if (v.vat_code === prev) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  // ── Lines management ────────────────────────────────────────────────
  function addLine(data) {
    data = data || {};
    lineCounter++;
    var idx = lineCounter;
    var tbody = document.getElementById('lines-body');
    var tr = document.createElement('tr');
    tr.dataset.line = idx;

    var vatSel = '<select class="vat-select" style="width:100px"></select>';

    tr.innerHTML =
      '<td style="color:#888;font-size:9pt;padding-left:8px">' + tbody.children.length + 1 + '</td>' +
      '<td>' +
        '<div class="line-acct-wrap">' +
          '<input type="text" class="lcode" data-line="'+idx+'" placeholder="401000" style="width:80px" autocomplete="off">' +
          '<input type="text" class="lname" data-line="'+idx+'" placeholder="account name" style="width:150px;color:#555" autocomplete="off">' +
        '</div>' +
      '</td>' +
      '<td><input type="text" class="ldesc" data-line="'+idx+'" placeholder="Line detail" style="width:200px"></td>' +
      '<td><input type="number" class="lamount" data-line="'+idx+'" min="0" step="0.01" placeholder="0.00" style="width:100px"></td>' +
      '<td>' + vatSel + '</td>' +
      '<td><button class="btn-remove" onclick="removeLine(this)" title="Remove line">\u00d7</button></td>';

    tbody.appendChild(tr);

    // Set values if provided
    if (data.expense_account) { tr.querySelector('.lcode').value = data.expense_account; }
    if (data.description) { tr.querySelector('.ldesc').value = data.description; }
    if (data.amount) { tr.querySelector('.lamount').value = data.amount; }

    // Wire expense account autocomplete
    var lcodeEl = tr.querySelector('.lcode');
    var lnameEl = tr.querySelector('.lname');
    lcodeEl.oninput = function(){ onLineCodeInput(lcodeEl, lnameEl); };
    lcodeEl.onblur  = function(){ hideAcctDropdown(); };
    lnameEl.oninput = function(){ onLineNameInput(lnameEl, lcodeEl); };
    lnameEl.onblur  = function(){ hideAcctDropdown(); };

    // Pre-fill name if code already set
    if (data.expense_account && accountsMap[data.expense_account]) {
      lnameEl.value = accountsMap[data.expense_account];
    }

    // Populate VAT select
    var sel = tr.querySelector('.vat-select');
    populateVatSelect(sel, data.vat_code || '');
    sel.onchange = function() { syncGstRow(tr); };
    var amtEl2 = tr.querySelector('.lamount');
    amtEl2.oninput = function() { syncGstRow(tr); };

    updateRemoveButtons();
    updateTotal();
    updateLineNumbers();
    return tr;
  }

  function removeLine(btn) {
    var tr = btn.closest('tr');
    // Remove associated GST row if present
    var next = tr.nextSibling;
    if (next && next.classList && next.classList.contains('gst-row') && next.dataset.parentLine === tr.dataset.line) {
      next.remove();
    }
    tr.remove();
    updateRemoveButtons();
    updateTotal();
    updateLineNumbers();
  }

  function updateRemoveButtons() {
    var btns = document.querySelectorAll('#lines-body .btn-remove');
    btns.forEach(function(b){ b.disabled = btns.length <= 1; });
  }

  function updateLineNumbers() {
    var n = 0;
    document.querySelectorAll('#lines-body tr').forEach(function(tr) {
      if (tr.classList.contains('gst-row')) return;
      n++;
      var firstTd = tr.querySelector('td:first-child');
      if (firstTd) firstTd.textContent = n;
    });
  }

  function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function syncGstRow(parentTr) {
    var amtEl = parentTr.querySelector('.lamount');
    var vatSel = parentTr.querySelector('.vat-select');
    if (!amtEl || !vatSel) return;

    var amount = parseFloat(amtEl.value);
    var vatCode = vatSel.value;

    // Remove existing GST row for this parent
    var existing = parentTr.nextSibling;
    if (existing && existing.classList && existing.classList.contains('gst-row') && existing.dataset.parentLine === parentTr.dataset.line) {
      existing.remove();
    }

    if (!vatCode || isNaN(amount) || amount <= 0) {
      updateTotal();
      return;
    }

    var vc = vatCodesList.find(function(x) { return x.vat_code === vatCode; });
    if (!vc || !vc.vat_account_input) {
      updateTotal();
      return;
    }

    var rate = Number(vc.rate);
    var gstAmount = Math.round(amount * rate * 100) / 100;
    var acctName = accountsMap[vc.vat_account_input] || '';

    var gstTr = document.createElement('tr');
    gstTr.className = 'gst-row';
    gstTr.dataset.parentLine = parentTr.dataset.line;

    // Same structure as a regular expense line
    gstTr.innerHTML =
      '<td style="color:#888;font-size:9pt;padding-left:8px">GST</td>' +
      '<td>' +
        '<div class="line-acct-wrap">' +
          '<input type="text" class="lcode gst-acct-code" placeholder="' + esc(vc.vat_account_input) + '" value="' + esc(vc.vat_account_input) + '" autocomplete="off">' +
          '<input type="text" class="lname gst-acct-name" placeholder="account name" value="' + esc(acctName) + '" autocomplete="off">' +
        '</div>' +
      '</td>' +
      '<td><input type="text" class="ldesc" value="GST Input: ' + esc(vatCode) + '" style="width:200px"></td>' +
      '<td><input type="number" class="lamount gst-amount" value="' + gstAmount.toFixed(2) + '" min="0" step="0.01" placeholder="0.00" style="width:100px"></td>' +
      '<td></td>' +
      '<td></td>';

    // Insert after parentTr
    parentTr.parentNode.insertBefore(gstTr, parentTr.nextSibling);

    // Wire full account autocomplete (same as regular lines)
    var gstCodeEl = gstTr.querySelector('.gst-acct-code');
    var gstNameEl = gstTr.querySelector('.gst-acct-name');
    gstCodeEl.oninput = function() { onLineCodeInput(gstCodeEl, gstNameEl); updateTotal(); };
    gstCodeEl.onblur  = function() { hideAcctDropdown(); };
    gstNameEl.oninput = function() { onLineNameInput(gstNameEl, gstCodeEl); updateTotal(); };
    gstNameEl.onblur  = function() { hideAcctDropdown(); };

    // Wire amount input
    gstTr.querySelector('.gst-amount').oninput = function() { updateTotal(); };

    updateTotal();
  }

  function updateTotal() {
    var net = 0;
    var gstTotal = 0;
    var gstByCode = {};

    document.querySelectorAll('#lines-body tr').forEach(function(tr) {
      if (tr.classList.contains('gst-row')) {
        var gstEl = tr.querySelector('.gst-amount');
        var parentLine = tr.dataset.parentLine;
        // Find parent's vat code
        var parentTr = document.querySelector('#lines-body tr[data-line="' + parentLine + '"]');
        var vatCode = parentTr ? (parentTr.querySelector('.vat-select') ? parentTr.querySelector('.vat-select').value : '') : '';
        var gv = gstEl ? parseFloat(gstEl.value) : 0;
        if (!isNaN(gv) && gv > 0) {
          gstTotal += gv;
          if (vatCode) {
            if (!gstByCode[vatCode]) gstByCode[vatCode] = 0;
            gstByCode[vatCode] += gv;
          }
        }
        return;
      }
      var amtEl = tr.querySelector('.lamount');
      if (!amtEl) return;
      var v = parseFloat(amtEl.value);
      if (!isNaN(v) && v > 0) net += v;
    });

    var gstHtml = '';
    Object.keys(gstByCode).forEach(function(code) {
      var vc = vatCodesList.find(function(x) { return x.vat_code === code; });
      var rateLabel = vc ? ' (' + Math.round(Number(vc.rate) * 100) + '%)' : '';
      gstHtml += '<div style="font-weight:400;font-size:10pt;color:#555">GST ' + code + rateLabel + ': ' + gstByCode[code].toFixed(2) + '</div>';
    });

    document.getElementById('lines-net').textContent = net.toFixed(2);
    document.getElementById('gst-rows').innerHTML = gstHtml;
    document.getElementById('lines-total').textContent = (net + gstTotal).toFixed(2);
  }

  function onLineCodeInput(codeEl, nameEl) {
    var q = codeEl.value.trim();
    if (accountsMap[q]) {
      nameEl.value = accountsMap[q];
    } else {
      nameEl.value = '';
    }
    if (!q) { hideAcctDropdown(); return; }
    var matches = getAccountList().filter(function(a){
      return a.code.toLowerCase().startsWith(q.toLowerCase()) || a.code.toLowerCase().includes(q.toLowerCase());
    }).sort(function(a,b){ return a.code.localeCompare(b.code); });
    showLineAcctDropdown(codeEl, matches, codeEl, nameEl);
  }

  function onLineNameInput(nameEl, codeEl) {
    var q = nameEl.value.trim().toLowerCase();
    if (!q) { hideAcctDropdown(); return; }
    var matches = getAccountList().filter(function(a){ return a.name.toLowerCase().includes(q); })
      .sort(function(a,b){ return a.name.localeCompare(b.name); });
    showLineAcctDropdown(nameEl, matches, codeEl, nameEl);
  }

  function showLineAcctDropdown(anchorEl, matches, codeEl, nameEl) {
    hideAcctDropdown();
    if (!matches.length) return;
    var rect = anchorEl.getBoundingClientRect();
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
        codeEl.value = a.code;
        nameEl.value = a.name;
        hideAcctDropdown();
      };
      row.onmouseover = function(){ row.style.background='#f0f4ff'; };
      row.onmouseout  = function(){ row.style.background=''; };
      div.appendChild(row);
    });
    document.body.appendChild(div);
    acctDropdown = div;
  }

  // ── Account autocomplete (for AP field) ─────────────────────────────
  var acctDropdown = null;

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
  }

  function hideAcctDropdown() {
    if (acctDropdown) { acctDropdown.remove(); acctDropdown = null; }
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
    document.querySelectorAll('.err').forEach(function(el){ el.style.display='none'; });

    var vendorId   = document.getElementById('vendor-id-input').value.trim();
    var vendorName = document.getElementById('vendor-name-input').value.trim();
    var vendorRef  = document.getElementById('vendor-ref').value.trim();
    var billDate   = document.getElementById('bill-date').value;
    var dueDate    = document.getElementById('due-date').value;
    var currency   = document.getElementById('currency').value.trim().toUpperCase();
    var apCode     = document.getElementById('ap-code').value.trim();
    var description= document.getElementById('description').value.trim();

    // Collect lines
    var lines = [];
    document.querySelectorAll('#lines-body tr:not(.gst-row)').forEach(function(tr){
      var expCode = tr.querySelector('.lcode').value.trim();
      var amount  = parseFloat(tr.querySelector('.lamount').value);
      var vatCode = tr.querySelector('.vat-select').value;
      var desc    = tr.querySelector('.ldesc').value.trim();

      // Read GST row overrides
      var vatAccountOverride = null;
      var vatAmountOverride = null;
      var gstRow = tr.nextSibling;
      if (gstRow && gstRow.classList && gstRow.classList.contains('gst-row') && gstRow.dataset.parentLine === tr.dataset.line) {
        var gstCode = gstRow.querySelector('.gst-acct-code');
        var gstAmt = gstRow.querySelector('.gst-amount');
        if (gstCode && gstCode.value.trim()) vatAccountOverride = gstCode.value.trim();
        if (gstAmt) vatAmountOverride = parseFloat(gstAmt.value) || null;
      }

      lines.push({ expense_account: expCode, amount: isNaN(amount) ? 0 : amount, vat_code: vatCode || null, description: desc || null, vat_account_override: vatAccountOverride, vat_amount_override: vatAmountOverride });
    });

    var valid = true;
    if (!vendorId && !vendorName) {
      document.getElementById('err-vendor').style.display = ''; valid = false;
    }
    if (!billDate) {
      document.getElementById('err-date').style.display = ''; valid = false;
    }
    if (!apCode || !accountsMap[apCode]) {
      document.getElementById('err-ap').style.display = ''; valid = false;
    }
    var linesValid = lines.length > 0 && lines.every(function(l){ return l.expense_account && accountsMap[l.expense_account] && l.amount > 0; });
    if (!linesValid) {
      document.getElementById('err-lines').style.display = ''; valid = false;
    }
    if (!valid) return;

    document.getElementById('btn-submit').disabled = true;
    showStatus('Creating bill…', false);

    var payload = {
      action: 'bill.create',
      companyId: COMPANY,
      bill: {
        vendor: vendorName || vendorId || null,
        vendor_ref: vendorRef || null,
        date: billDate,
        due_date: dueDate || null,
        currency: currency || null,
        ap_account: apCode,
        description: description || null,
        lines: lines
      }
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
    document.getElementById('description').value = '';
    currentTermsDays = 30;
    var today2 = new Date().toISOString().slice(0,10);
    document.getElementById('bill-date').value = today2;
    recalcDueDate();
    document.getElementById('lines-body').innerHTML = '';
    lineCounter = 0;
    addLine();
    document.querySelectorAll('.err').forEach(function(el){ el.style.display='none'; });
    showStatus('', false);
  }

  function showStatus(msg, isErr) {
    var el = document.getElementById('status-msg');
    el.textContent = msg;
    el.style.color = isErr ? '#cc2222' : '#2a8a2a';
  }
  // Delegated click handler for FX "Fetch from ECB" links
  document.addEventListener('click', function(e) {
    var link = e.target.closest('.fetch-ecb-link');
    if (!link) return;
    e.preventDefault();
    fetchAndRetry(link.dataset.date, link.dataset.currency);
  });
<\/script>
</body>
</html>`;
}

module.exports = { handleBillNewPage };
