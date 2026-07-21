'use strict';
const { commonStyle, navBar, layoutEnd } = require('./common');
const { query } = require('../db');

async function handleBillNewPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const [co] = await query(`SELECT jurisdiction FROM companies WHERE company_id = @cid LIMIT 1`, { cid: company }).catch(() => [{}]);
  const taxLabel = (co && co.jurisdiction === 'SG') ? 'GST' : 'VAT';
  res.send(buildBillNewPage(company, taxLabel));
}

function buildBillNewPage(company, taxLabel = 'VAT') {
  // New Bill page now uses identical layout + CSS as Bill details (meta-strip, amount card, table-card)
  // Full implementation follows the same DOM structure and vim keyboard model as requested.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>New Bill — freeBooks</title>
${commonStyle()}
<style>
.page { max-width:1100px; }
.bill-header-actions { display:flex; gap:10px; align-items:center; }
.btn-action {
  display:inline-flex; align-items:center; gap:6px;
  padding:8px 18px; border:1px solid #d0d0d0; border-radius:6px;
  background:#fff; cursor:pointer; font-size:0.8125rem; color:#333; white-space:nowrap;
}
.btn-action:hover { background:#f5f5f5; border-color:#bbb; }
.btn-primary { background:#1a1a1a; color:#fff; border-color:#1a1a1a; }
.btn-primary:hover { background:#333; border-color:#333; }
.btn-primary:disabled { opacity:0.4; cursor:default; }
.currency-blue { color:#2255cc; }
/* Required field soft pink background */
.meta-input.req { border:1px solid #cc5555 !important; }
.meta-input.req:hover { border:1px solid #cc5555 !important; }
.meta-input.req:focus { background:#f8f9ff; border:1px solid #cc5555 !important; }
.line-input.req { border:1px solid #cc5555 !important; }
.line-input.req:hover { border:1px solid #cc5555 !important; }
.line-input.req:focus { background:#f8f9ff; border:1px solid #cc5555 !important; }
.line-desc-input.req { border:1px solid #cc5555 !important; }
.line-desc-input.req:hover { border:1px solid #cc5555 !important; }
.line-desc-input.req:focus { background:#f8f9ff; border:1px solid #cc5555 !important; }
/* vim nav highlight */
/* Nav NORMAL mode highlight — copied exactly from bill-detail.js */
.meta-field.nav-sel { background:var(--accent); border-radius:6px; }
.meta-field.nav-sel .meta-label { color:rgba(255,255,255,.7); }
.meta-field.nav-sel .meta-input { color:#fff; background:transparent; border-color:transparent !important; }
/* Nav highlight for line item inputs (no meta-field container) */
input.nav-sel, select.nav-sel { outline:2px solid var(--accent) !important; background:#f0f4ff !important; }
/* Hide GST rows in Bill Line Items (kept for journal calc) */
.gst-row { display:none !important; }

/* Meta strip */
.meta-strip { display:flex; border-top:1px solid #eee; border-bottom:1px solid #eee; padding:24px 0; margin-bottom:24px; }
.meta-field { flex:1; padding:0 28px; }
.meta-field:first-child { padding-left:0; }
.meta-field + .meta-field { border-left:1px solid #eee; }
.meta-label { font-size:0.75rem; color:#aaa; font-weight:600; text-transform:uppercase; letter-spacing:.06em; margin-bottom:6px; }
.meta-input { font-size:1rem; font-weight:600; color:#1a1a1a; border:none; background:transparent; padding:2px 4px; border-radius:3px; width:100%; cursor:text; }
.meta-input:hover { background:#f8f9ff; border:1px solid #c0c8ff; }
.meta-input:focus { outline:none; background:#f8f9ff; border:1px solid #c0c8ff; }
.meta-input::placeholder { color:#bbb; font-weight:400; font-size:0.875rem; }
input[type=date].meta-input { font-size:0.9375rem; min-width:130px; white-space:nowrap; }
.meta-err { color:#cc2222; font-size:0.6875rem; margin-top:3px; display:none; }
.fx-hint-row { font-size:0.6875rem; color:#888; margin-top:4px; display:flex; align-items:center; gap:4px; }
.fx-input-inline { width:80px; border:none; background:transparent; font-size:0.6875rem; border-bottom:1px solid #e8e8e8; padding:1px 2px; color:#555; }
.fx-input-inline:focus { outline:none; border-bottom-color:#888; }

/* Journal entry inputs */
.line-desc-input { width:100%; border:none; background:transparent; font-size:0.875rem; padding:2px 4px; border-radius:3px; color:#222; cursor:text; }
.line-desc-input:hover { background:#f8f9ff; border:1px solid #c0c8ff; }
.line-desc-input:focus { outline:none; background:#f8f9ff; border:1px solid #c0c8ff; }

/* Amount cards */
.amount-cards { display:flex; gap:16px; margin-bottom:36px; }
.card-paid { flex:0 0 42%; background:#f7f7f7; border-radius:8px; padding:24px 28px; }
.card-val-paid { font-size:1.875rem; font-weight:600; color:#c0c0c0; line-height:1; }
.card-due { flex:1; background:#fff; border:2px solid #1a1a1a; border-radius:8px; padding:24px 28px; }
.card-label { font-size:0.75rem; color:#aaa; font-weight:600; text-transform:uppercase; letter-spacing:.06em; margin-bottom:12px; }
.card-val-due { display:flex; align-items:baseline; gap:8px; line-height:1; }
.card-currency { font-size:1.0625rem; font-weight:500; color:#aaa; }
.card-amount { font-size:2.25rem; font-weight:700; color:#1a1a1a; }

/* Section headings */
.section-h { font-size:1.0625rem; font-weight:700; color:#1a1a1a; margin:0 0 14px; }

/* Table card */
.table-card { border:1px solid #e8e8e8; border-radius:8px; overflow:hidden; margin-bottom:36px; }
.data-table { width:100%; border-collapse:collapse; font-size:0.875rem; }
.data-table th { text-align:left; font-size:0.75rem; color:#aaa; font-weight:600; text-transform:uppercase; letter-spacing:.05em; background:#fafafa; border-bottom:1px solid #e8e8e8; padding:12px 18px; }
.data-table td { padding:10px 18px; border-bottom:1px solid #f2f2f2; vertical-align:middle; color:#222; }
.data-table tbody tr:last-child td { border-bottom:none; }

/* Line inputs */
.line-input { border:none; background:transparent; font-size:0.875rem; padding:2px 4px; border-radius:3px; color:#222; width:100%; cursor:text; }
.line-input:hover { background:#f8f9ff; border:1px solid #c0c8ff; }
.line-input:focus { outline:none; background:#f8f9ff; border:1px solid #c0c8ff; }
.line-input::placeholder { color:#ccc; }

/* GST rows */
.gst-row > td { background:#f7fff7 !important; }
.gst-row > td:first-child { color:#2a8a2a; font-size:0.75rem; }

/* Add line button */
.btn-add-line { display:flex; align-items:center; justify-content:center; gap:6px; width:100%; padding:10px; font-size:0.8125rem; cursor:pointer; border:1px solid #e8e8e8; border-top:none; border-radius:0 0 8px 8px; background:#fafafa; color:#555; }
.btn-add-line:hover { background:#f0f0f0; color:#1a1a1a; }

/* Remove button */
.btn-remove { background:none; border:none; color:#cc2222; font-size:1.0625rem; cursor:pointer; padding:0 4px; line-height:1; }
.btn-remove:disabled { color:#ccc; cursor:default; }

/* Line account autocomplete */
.line-acct-wrap { position:relative; display:flex; gap:4px; }
.line-acct-wrap input.lcode { width:75px; }
.line-acct-wrap input.lname { width:150px; color:#555; }

/* Attach card */
.attach-card { border:1px solid #e8e8e8; border-radius:8px; overflow:hidden; }
.attach-row { display:flex; align-items:center; padding:16px 20px; border-bottom:1px solid #f2f2f2; gap:14px; }
.attach-row:last-child { border-bottom:none; }
.pdf-icon { width:36px; height:44px; background:#fff0f0; border:1px solid #ffcccc; border-radius:4px; flex-shrink:0; display:flex; flex-direction:column; align-items:center; justify-content:center; font-size:0.6875rem; font-weight:700; color:#cc4444; letter-spacing:.04em; line-height:1; }
.pdf-icon::before { content:'\\2014'; font-size:0.5rem; color:#ffaaaa; margin-bottom:2px; }
.attach-info { flex:1; min-width:0; }
.attach-filename { font-weight:600; font-size:0.8125rem; color:#1a1a1a; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.attach-meta { font-size:0.75rem; color:#aaa; margin-top:3px; }
.attach-actions { display:flex; gap:6px; flex-shrink:0; }
.btn-icon { width:32px; height:32px; border:1px solid #ddd; border-radius:5px; background:#fff; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; font-size:1.0625rem; color:#555; text-decoration:none; }
.btn-icon:hover { background:#f5f5f5; border-color:#bbb; }
.btn-icon-del { color:#cc4444; border-color:#ffcccc; background:#fff5f5; }
.btn-icon-del:hover { background:#ffe0e0; }

/* Success box */
.success-box { background:#f0fff4; border:1px solid #2a8a2a; border-radius:8px; padding:32px 36px; max-width:500px; }
.success-box h2 { color:#2a8a2a; margin:0 0 10px; }
.success-box a { color:#1a1a1a; font-weight:600; }

/* Vendor/acct wraps */
.vendor-wrap { position:relative; }
.acct-hint { font-size:0.6875rem; color:#888; margin-top:2px; }

</style>
</head>
<body>${navBar(company, 'payables')}
<div class="page">
  <div id="success-panel" style="display:none" class="success-box">
    <h2>✓ Bill created</h2>
    <p>Bill ID: <strong id="success-bill-id"></strong></p>
  </div>

  <div id="bill-form">
    <!-- Header: h1 left, Create Bill button + status right -->
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:28px;">
      <div class="header" style="margin-bottom:0; display:flex; align-items:center; gap:12px;">
        <h1 id="page-title">📄 Payables: New Bill</h1>
      </div>
      <div class="bill-header-actions">
        <span id="status-msg" style="font-size:0.8125rem"></span>
        <button class="btn-action btn-primary" id="btn-submit" onclick="submitBill()">Post</button>
      </div>
    </div>

    <!-- Meta strip: Vendor | Invoice Ref | Bill Date | Due Date | Currency | AP Account -->
    <div class="meta-strip">
      <div class="meta-field">
        <div class="meta-label">Vendor * <span style="font-size:0.625rem;color:#bbb;font-weight:400;text-transform:none;letter-spacing:0">(i to edit)</span></div>
        <div class="vendor-wrap">
          <input type="text" id="vendor-name-input" class="meta-input req" placeholder="Search vendor…" autocomplete="off"
            oninput="onVendorInput(this)" onblur="hideVendorDropdown()">
          <input type="hidden" id="vendor-id-input">
        </div>
        <div class="meta-err" id="err-vendor">Vendor is required</div>
      </div>

      <div class="meta-field">
        <div class="meta-label">Invoice Ref * <span style="font-size:0.625rem;color:#bbb;font-weight:400;text-transform:none;letter-spacing:0">(i to edit)</span></div>
        <input type="text" id="vendor-ref" class="meta-input req" placeholder="e.g. INV-2024-001">
        <div class="meta-err" id="err-ref">Invoice Ref is required</div>
      </div>

      <div class="meta-field" style="min-width:150px">
        <div class="meta-label">Bill Date * <span style="font-size:0.625rem;color:#bbb;font-weight:400;text-transform:none;letter-spacing:0">(i to edit)</span></div>
        <input type="date" id="bill-date" class="meta-input req" onchange="recalcDueDate(); rebuildJournals();">
        <div class="meta-err" id="err-date">Date is required</div>
      </div>

      <div class="meta-field" style="min-width:150px">
        <div class="meta-label">Due Date <span style="font-size:0.625rem;color:#bbb;font-weight:400;text-transform:none;letter-spacing:0">(i to edit)</span></div>
        <input type="date" id="due-date" class="meta-input">
      </div>

      <div class="meta-field">
        <div class="meta-label">Currency <span style="font-size:0.625rem;color:#bbb;font-weight:400;text-transform:none;letter-spacing:0">(i to edit)</span></div>
        <div style="position:relative">
          <input type="text" id="currency" maxlength="3" class="meta-input" placeholder="e.g. SGD" style="text-transform:uppercase" onchange="onCurrencyChange()" oninput="onCurrencyInput(this)" onblur="hideCurrencyDropdown()" autocomplete="off">
          <div id="currency-dropdown" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #ccc;border-top:none;border-radius:0 0 4px 4px;box-shadow:0 3px 10px rgba(0,0,0,.15);max-height:200px;overflow-y:auto;z-index:9999"></div>
        </div>
      </div>
    </div>

    <!-- Hidden inputs for AP account (kept for submitBill compatibility) -->
    <input type="hidden" id="ap-code" value="">
    <input type="hidden" id="ap-name" value="">
    <span id="ap-hint" style="display:none"></span>

    <!-- FX Rate row (shown when foreign currency) -->
    <div id="fx-rate-row" style="display:none; padding:0 28px; margin-bottom:20px;">
      <div style="display:flex; gap:12px; align-items:flex-start;">
        <div style="flex:1; max-width:200px;">
          <div class="meta-label">FX Rate</div>
          <input type="number" id="fx-rate" class="meta-input" placeholder="1.0" step="0.0001">
        </div>
        <button type="button" id="btn-get-rate" onclick="getRate()" class="btn-action" style="margin-top:24px;">Get Rate</button>
      </div>
      <span id="fx-rate-hint" class="fx-hint-row" style="margin-top:6px; margin-left:0;"></span>
    </div>



    <!-- Amount cards -->
    <div class="amount-cards">
      <div class="card-paid">
        <div class="card-label">Amount Paid</div>
        <div class="card-val-paid">0.00</div>
      </div>
      <div class="card-due">
        <div class="card-label">Amount Due</div>
        <div class="card-val-due">
          <span class="card-currency" id="total-currency-prefix"></span>
          <span class="card-amount" id="lines-total">0.00</span>
        </div>
        <div id="card-breakdown" style="font-size:0.8125rem;color:#888;margin-top:8px"></div>
        <div id="fx-total-display" style="margin-top:6px;font-size:0.8125rem;color:#666;display:none"></div>
        <!-- hidden compat -->
        <span id="lines-net" style="display:none">0.00</span>
        <span id="gst-rows" style="display:none"></span>
      </div>
    </div>

    <!-- Bill Line Items -->
    <div class="section-h">Bill Line Items</div>
    <div class="table-card" style="margin-bottom:0;border-radius:8px 8px 0 0">
      <table class="data-table" id="lines-table">
        <thead>
          <tr>
            <th style="width:30px">#</th>
            <th>Description</th>
            <th style="width:110px">Amount *</th>
            <th style="width:110px">${taxLabel} Code</th>
            <th style="width:60px">CCY</th>
            <th style="width:30px"></th>
          </tr>
        </thead>
        <tbody id="lines-body"></tbody>
      </table>
    </div>
    <button class="btn-add-line" onclick="addLine()">＋ Add Line Item</button>
    <div class="meta-err" id="err-lines" style="display:none;margin-bottom:20px;margin-top:8px">At least one expense line with a valid account and amount > 0 is required</div>

    <!-- Attachments (section-h + attach-card) -->
    <div class="section-h" style="margin-top:36px">Attachments</div>
    <div class="attach-card" style="margin-bottom:36px">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 18px;background:#fafafa;border-bottom:1px solid #e8e8e8">
        <span style="font-size:0.8125rem;font-weight:600;color:#555">📎 Files to attach on save</span>
        <label tabindex="0" style="cursor:pointer;color:#1a1a1a;font-size:0.8125rem;font-weight:600">
          + Add File
          <input type="file" id="bill-attach-input" style="display:none" accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt" onchange="addBillAttachment(this)" multiple>
        </label>
      </div>
      <div id="bill-pending-list">
        <div style="padding:16px 20px;color:#aaa;font-size:0.8125rem">No files queued</div>
      </div>
    </div>

    <!-- Journal Entries -->
    <div class="section-h">Journal Entries</div>
    <div class="table-card" style="margin-bottom:36px">
      <table class="data-table">
        <thead>
          <tr>
            <th style="white-space:nowrap;width:100px">Date</th>
            <th style="min-width:120px">Reference</th>
            <th style="min-width:80px">Account</th>
            <th>Account Name</th>
            <th style="text-align:right;min-width:90px">DR</th>
            <th style="text-align:right;min-width:90px">CR</th>
          </tr>
        </thead>
        <tbody id="journals-tbody">
          <tr><td colspan="6" style="color:#aaa;padding:20px 18px">Add expense lines above to preview journal entries.</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<script>
  var COMPANY = '${company}';
  var accountsMap = {};
  var vatCodesList = [];
  var vendorsList = [];
  var currenciesList = [];
  var lineCounter = 0;
  var _reenterId = new URLSearchParams(window.location.search).get('reenter');
  var _accountsLoaded = false, _vatLoaded = false;
  var homeCurrency = 'SGD';  // Default, will be loaded from company data
  var pendingBillAttachments = [];

  // Load currencies
  fetch('/db/currencies.json').then(function(r){ return r.json(); }).then(function(currencies){
    currenciesList = currencies || [];
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

  // Dates: not prepopulated — user enters manually
  var currentTermsDays = 30;
  function recalcDueDate() {
    var bd = document.getElementById('bill-date').value;
    if (!bd) return;
    var d = new Date(bd); d.setDate(d.getDate() + currentTermsDays);
    document.getElementById('due-date').value = d.toISOString().slice(0, 10);
  }

  // Add first line on load
  addLine();

  // Wire fx-rate input to update FX total display
  var fxRateInput = document.getElementById('fx-rate');
  if (fxRateInput) {
    fxRateInput.addEventListener('change', function(){
      updateFxTotalDisplay();
    });
  }

  // ── FX Rate lookup ──────────────────────────────────────────────────
  function onCurrencyChange() {
    var currency = document.getElementById('currency').value.trim().toUpperCase();
    updateFxRateVisibility(currency);
    // Update all currency labels in line items
    document.querySelectorAll('.line-ccy-label').forEach(function(el){
      el.textContent = currency;
    });
    updateFxTotalDisplay();
    if (currency && currency !== homeCurrency) {
      getRate();
    }
  }

  function updateFxRateVisibility(currency) {
    var fxRateRow = document.getElementById('fx-rate-row');
    var btn = document.getElementById('btn-get-rate');
    var hint = document.getElementById('fx-rate-hint');
    var fxRateInput = document.getElementById('fx-rate');
    
    if (!currency || currency === homeCurrency) {
      fxRateRow.style.display = 'none';
      hint.textContent = '';
      if (!currency || currency === homeCurrency) {
        fxRateInput.value = '1.0';
      }
    } else {
      fxRateRow.style.display = '';
    }
  }

  function updateFxTotalDisplay() {
    var el = document.getElementById('fx-total-display');
    if (!el) return;
    var currency = document.getElementById('currency').value.trim().toUpperCase();
    var fxRate = parseFloat(document.getElementById('fx-rate').value) || 1.0;
    if (!currency || currency === homeCurrency || fxRate === 1.0) {
      el.style.display = 'none';
      return;
    }
    var foreignTotal = 0;
    document.querySelectorAll('.lamount').forEach(function(inp){
      foreignTotal += parseFloat(inp.value) || 0;
    });
    if (foreignTotal === 0) {
      el.style.display = 'none';
      return;
    }
    var homeTotal = foreignTotal * fxRate;
    el.textContent = '\u2248 ' + homeCurrency + ' ' + homeTotal.toFixed(2) + ' @ ' + fxRate.toFixed(4) + ' (' + currency + ')';
    el.style.display = '';
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
    document.getElementById('page-title').textContent = '📄 Re-enter Bill';
    var _banner = document.createElement('div');
    _banner.style.cssText = 'background:#fff3e0;border:1px solid #ff9800;border-radius:4px;padding:12px 16px;margin-bottom:16px;font-size:0.8125rem;';
    _banner.innerHTML = '<strong>⟲ Re-entry mode</strong> &mdash; The original bill has been reversed. Fill in the corrected details and submit.';
    var _metaStrip = document.querySelector('.meta-strip');
    document.getElementById('bill-form').insertBefore(_banner, _metaStrip);
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
      }
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
      + 'box-shadow:0 3px 10px rgba(0,0,0,.15);max-height:200px;overflow-y:auto;min-width:260px;font-size:0.8125rem;'
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

  // ── Currency autocomplete ──────────────────────────────────────────────
  function onCurrencyInput(input) {
    var q = input.value.trim().toUpperCase();
    if (!q) { hideCurrencyDropdown(); return; }
    var matches = currenciesList.filter(function(c){
      return (c.code||'').toUpperCase().startsWith(q) || (c.code||'').toUpperCase().includes(q) || 
              (c.name||'').toUpperCase().includes(q);
    }).slice(0, 15);
    showCurrencyDropdown(input, matches);
  }

  function showCurrencyDropdown(input, matches) {
    hideCurrencyDropdown();
    var dd = document.getElementById('currency-dropdown');
    if (!dd) return;
    if (!matches.length) { return; }
    dd.innerHTML = '';
    matches.forEach(function(c){
      var row = document.createElement('div');
      row.style.cssText = 'padding:7px 10px;cursor:pointer;display:flex;gap:8px;align-items:center';
      row.innerHTML = '<span style="font-weight:600;min-width:50px">' + (c.code||'') + '</span>' +
                      '<span style="color:#666;flex:1">' + (c.name||'') + '</span>';
      row.onmousedown = function(e){
        e.preventDefault();
        input.value = c.code.toUpperCase();
        hideCurrencyDropdown();
        input.onchange();
      };
      row.onmouseover = function(){ row.style.background='#f0f4ff'; };
      row.onmouseout  = function(){ row.style.background=''; };
      dd.appendChild(row);
    });
    dd.style.display = '';
  }

  function hideCurrencyDropdown() {
    var dd = document.getElementById('currency-dropdown');
    if (dd) dd.style.display = 'none';
  }

  function autoFillVendor(v) {
    // Payment terms → recalc due date
    if (v.payment_terms_days) {
      currentTermsDays = parseInt(v.payment_terms_days) || 30;
      recalcDueDate();
    }
    // Currency
    if (v.default_currency) {
      document.getElementById('currency').value = v.default_currency.toUpperCase();
      onCurrencyChange(); // sync CCY labels in all line items
    }
    // AP account (hidden input)
    if (v.default_ap_account) {
      document.getElementById('ap-code').value = v.default_ap_account;
    }
    // Expense account — first line
    if (v.default_expense_account) {
      var firstRow = document.querySelector('#lines-body tr');
      if (firstRow) {
        var lcodeEl = firstRow.querySelector('.lcode');
        if (lcodeEl) {
          lcodeEl.value = v.default_expense_account;
        }
      }
    }
    rebuildJournals();
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
      '<td style="color:#888;font-size:0.75rem;padding-left:8px">' + tbody.children.length + 1 + '</td>' +
      '<input type="hidden" class="lcode" data-line="'+idx+'">' +
      '<td><input type="text" class="ldesc line-input req" data-line="'+idx+'" placeholder="Line detail"></td>' +
      '<td>' +
        '<input type="number" class="lamount line-input req" data-line="'+idx+'" min="0" step="0.01" placeholder="0.00" style="width:100px">' +
      '</td>' +
      '<td>' + vatSel + '</td>' +
      '<td><span class="line-ccy-label currency-blue" style="font-size:0.8125rem;font-weight:500"></span></td>' +
      '<td><button class="btn-remove" onclick="removeLine(this)" title="Remove line">\u00d7</button></td>';

    tbody.appendChild(tr);

    // Set values if provided
    if (data.expense_account) { tr.querySelector('.lcode').value = data.expense_account; }
    if (data.description) { tr.querySelector('.ldesc').value = data.description; }
    if (data.amount) { tr.querySelector('.lamount').value = data.amount; }

    // Populate VAT select
    var sel = tr.querySelector('.vat-select');
    populateVatSelect(sel, data.vat_code || '');
    sel.onchange = function() { syncGstRow(tr); };
    var amtEl2 = tr.querySelector('.lamount');
    amtEl2.oninput = function() { syncGstRow(tr); updateFxTotalDisplay(); rebuildJournals(); };

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

  // esc now comes from fb-core.js (window.esc) — P1-3 shared core

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
      '<td style="color:#888;font-size:0.75rem;padding-left:8px">GST</td>' +
      '<td>' +
        '<div class="line-acct-wrap">' +
          '<input type="text" class="lcode gst-acct-code" placeholder="' + esc(vc.vat_account_input) + '" value="' + esc(vc.vat_account_input) + '" autocomplete="off">' +
          '<input type="text" class="lname gst-acct-name" placeholder="" value="' + esc(acctName) + '" autocomplete="off">' +
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
    var breakdownText = '';
    Object.keys(gstByCode).forEach(function(code) {
      var vc = vatCodesList.find(function(x) { return x.vat_code === code; });
      var rateLabel = vc ? ' (' + Math.round(Number(vc.rate) * 100) + '%)' : '';
      gstHtml += '<div style="font-weight:400;font-size:0.8125rem;color:#555">GST ' + code + rateLabel + ': ' + gstByCode[code].toFixed(2) + '</div>';
      if (breakdownText) breakdownText += ' + ';
      breakdownText += 'GST ' + code + ' ' + gstByCode[code].toFixed(2);
    });
    
    // Update currency prefix in amount card (no breakdown shown)
    var currency = (document.getElementById('currency') ? document.getElementById('currency').value.trim().toUpperCase() : '') || homeCurrency;
    document.getElementById('total-currency-prefix').textContent = currency;
    document.getElementById('card-breakdown').textContent = '';

    document.getElementById('lines-net').textContent = net.toFixed(2);
    document.getElementById('gst-rows').innerHTML = gstHtml;
    document.getElementById('lines-total').textContent = (net + gstTotal).toFixed(2);
    rebuildJournals();
  }

  function rebuildJournals() {
    var tbody = document.getElementById('journals-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    var dateVal = (document.getElementById('bill-date').value || '').slice(0, 10);
    var refText = '— (on save)';
    var apCode  = document.getElementById('ap-code').value.trim();
    var apName  = accountsMap[apCode] || '';

    var totalCr = 0; // will be sum of all DR amounts

    // One DR row per expense line (only when amount > 0)
    document.querySelectorAll('#lines-body tr:not(.gst-row)').forEach(function(lineTr) {
      var lineIdx  = lineTr.dataset.line;
      var amt      = parseFloat(lineTr.querySelector('.lamount') ? lineTr.querySelector('.lamount').value : 0) || 0;
      var expCode  = lineTr.querySelector('.lcode') ? lineTr.querySelector('.lcode').value.trim() : '';
      var expName  = accountsMap[expCode] || '';

      totalCr += amt;

      var tr = document.createElement('tr');
      tr.dataset.journalLine = lineIdx;
      tr.innerHTML =
        '<td style="color:#888;font-size:0.8125rem;white-space:nowrap">' + dateVal + '</td>' +
        '<td style="color:#aaa;font-size:0.8125rem">' + refText + '</td>' +
        '<td>' +
          '<div style="display:flex;gap:4px">' +
            '<input type="text" class="j-code line-desc-input req" style="width:72px" placeholder="401000" value="' + esc(expCode) + '" autocomplete="off">' +
          '</div>' +
        '</td>' +
        '<td><input type="text" class="j-name line-desc-input" style="width:100%;min-width:120px" placeholder="" value="' + esc(expName) + '" autocomplete="off"></td>' +
        '<td style="text-align:right;color:#222">' + (amt > 0 ? amt.toFixed(2) : '') + '</td>' +
        '<td style="text-align:right;color:#aaa"></td>';

      tbody.appendChild(tr);

      // Wire autocomplete on j-code and j-name
      var jCode = tr.querySelector('.j-code');
      var jName = tr.querySelector('.j-name');

      jCode.oninput = function() {
        onLineCodeInput(jCode, jName);
        var lcodHid = document.querySelector('#lines-body tr[data-line="' + lineIdx + '"] .lcode');
        if (lcodHid) lcodHid.value = jCode.value;
      };
      jCode.onblur = function() { hideAcctDropdown(); };

      jName.oninput = function() {
        onLineNameInput(jName, jCode);
      };
      jName.onblur = function() {
        hideAcctDropdown();
        // sync code back
        var lcodHid = document.querySelector('#lines-body tr[data-line="' + lineIdx + '"] .lcode');
        if (lcodHid) lcodHid.value = jCode.value;
      };

      // Override dropdown selection to also sync hidden .lcode
      (function(li, jc, jn) {
        jc.addEventListener('change', function() {
          var lcodHid = document.querySelector('#lines-body tr[data-line="' + li + '"] .lcode');
          if (lcodHid) lcodHid.value = jc.value;
        });
      })(lineIdx, jCode, jName);
    });

    // One DR row per GST line
    document.querySelectorAll('#lines-body tr.gst-row').forEach(function(gstTr) {
      var gstCode = gstTr.querySelector('.gst-acct-code') ? gstTr.querySelector('.gst-acct-code').value.trim() : '';
      var gstName = accountsMap[gstCode] || '';
      var gstAmtInput = gstTr.querySelector('.gst-amount');
      var gstAmt = gstAmtInput ? parseFloat(gstAmtInput.value) || 0 : 0;
      
      if (!gstCode) return; // skip if no account

      totalCr += gstAmt;

      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td style="color:#888;font-size:0.8125rem;white-space:nowrap">' + dateVal + '</td>' +
        '<td style="color:#aaa;font-size:0.8125rem">' + refText + '</td>' +
        '<td><span style="font-size:0.8125rem;color:#555">' + esc(gstCode) + '</span></td>' +
        '<td style="font-size:0.8125rem;color:#555">' + esc(gstName) + '</td>' +
        '<td style="text-align:right;color:#222">' + (gstAmt > 0 ? gstAmt.toFixed(2) : '') + '</td>' +
        '<td style="text-align:right;color:#aaa"></td>';
      tbody.appendChild(tr);
    });

    // CR row — AP account (always shown so user can enter account code)
    {
      var crTr = document.createElement('tr');
      crTr.dataset.journalCr = '1';
      crTr.innerHTML =
        '<td style="color:#888;font-size:0.8125rem;white-space:nowrap">' + dateVal + '</td>' +
        '<td style="color:#aaa;font-size:0.8125rem">' + refText + '</td>' +
        '<td>' +
          '<input type="text" class="j-ap-code line-desc-input req" style="width:72px" placeholder="201130" value="' + esc(apCode) + '" autocomplete="off">' +
        '</td>' +
        '<td><input type="text" class="j-ap-name line-desc-input" style="width:100%;min-width:120px" placeholder="" value="' + esc(apName) + '" autocomplete="off"></td>' +
        '<td style="text-align:right;color:#aaa"></td>' +
        '<td style="text-align:right;color:#222;font-weight:600">' + (totalCr > 0 ? totalCr.toFixed(2) : '') + '</td>';
      tbody.appendChild(crTr);

      var jApCode = crTr.querySelector('.j-ap-code');
      var jApName = crTr.querySelector('.j-ap-name');

      jApCode.oninput = function() {
        onLineCodeInput(jApCode, jApName);
        document.getElementById('ap-code').value = jApCode.value;
      };
      jApCode.onblur = function() {
        hideAcctDropdown();
        document.getElementById('ap-code').value = jApCode.value;
      };
      jApCode.addEventListener('change', function() {
        document.getElementById('ap-code').value = jApCode.value;
      });

      jApName.oninput = function() { onLineNameInput(jApName, jApCode); };
      jApName.onblur = function() {
        hideAcctDropdown();
        document.getElementById('ap-code').value = jApCode.value;
      };
    }

    // Always show at least 2 rows for visual consistency
    while (tbody.querySelectorAll('tr').length < 2) {
      var padTr = document.createElement('tr');
      padTr.innerHTML =
        '<td style="white-space:nowrap;color:#aaa;font-size:0.8125rem">—</td>' +
        '<td style="color:#aaa;font-size:0.8125rem">—</td>' +
        '<td></td><td></td>' +
        '<td style="text-align:right"></td>' +
        '<td style="text-align:right"></td>';
      tbody.appendChild(padTr);
    }
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
      + 'box-shadow:0 3px 10px rgba(0,0,0,.15);max-height:220px;overflow-y:auto;min-width:300px;font-size:0.8125rem;'
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
      + 'box-shadow:0 3px 10px rgba(0,0,0,.15);max-height:220px;overflow-y:auto;min-width:300px;font-size:0.8125rem;'
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
    var currencyInput = document.getElementById('currency');
    var currencyDD = document.getElementById('currency-dropdown');
    if (currencyDD && currencyInput && e.target !== currencyInput && !currencyDD.contains(e.target)) hideCurrencyDropdown();
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
      document.getElementById('err-vendor').style.display = 'block'; valid = false;
    }
    if (!vendorRef) {
      document.getElementById('err-ref').style.display = 'block'; valid = false;
    }
    if (!billDate) {
      document.getElementById('err-date').style.display = 'block'; valid = false;
    }
    if (!apCode || !accountsMap[apCode]) {
      document.getElementById('err-ap').style.display = 'block'; valid = false;
    }
    var linesValid = lines.length > 0 && lines.every(function(l){ return l.expense_account && accountsMap[l.expense_account] && l.amount > 0; });
    if (!linesValid) {
      document.getElementById('err-lines').style.display = 'block'; valid = false;
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
        fx_rate: parseFloat(document.getElementById('fx-rate').value) || 1.0,
        ap_account: apCode,
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
          uploadPendingBillAttachments(billId);
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
    document.getElementById('ap-code').value = '';
    currentTermsDays = 30;
    document.getElementById('bill-date').value = '';
    document.getElementById('due-date').value = '';
    document.getElementById('currency').value = homeCurrency;
    document.getElementById('fx-rate').value = '1.0';
    updateFxRateVisibility(homeCurrency);
    document.getElementById('lines-body').innerHTML = '';
    lineCounter = 0;
    addLine();
    document.querySelectorAll('.meta-err').forEach(function(el){ el.style.display='none'; });
    showStatus('', false);
  }

  function showStatus(msg, isErr) {
    var el = document.getElementById('status-msg');
    el.textContent = msg;
    el.style.color = isErr ? '#cc2222' : '#2a8a2a';
  }
  // ── vim-style 2D grid navigation ──────────────────────────────────────
  // Grid layout:
  //   Row 0     : meta-strip [vendor, invoice-ref, bill-date, due-date, currency]
  //   Row 1..N  : bill line items [desc, amount, vat-select] per line
  //   Row N+1.. : journal entry rows [j-code, j-name] per row
  //
  // j / k  = move DOWN / UP between rows (same column, clamped)
  // h / l  = move LEFT / RIGHT within same row
  // i      = enter INSERT mode on current cell
  // ESC    = INSERT→NORMAL (stay on cell) | NORMAL→cancel (history.back)
  // Tab / click = enter INSERT mode (handled via focusin)

  var navMode = true;   // true = NORMAL, false = INSERT
  var navRow  = 0;
  var navCol  = 0;
  var _navMoving = false;

  function buildNavGrid() {
    var grid = [];

    // Row 0: meta-strip
    var metaRow = ['vendor-name-input','vendor-ref','bill-date','due-date','currency']
      .map(function(id){ return document.getElementById(id); })
      .filter(Boolean);
    if (metaRow.length) grid.push(metaRow);

    // One row per bill line item
    document.querySelectorAll('#lines-body tr:not(.gst-row)').forEach(function(tr){
      var row = [];
      var desc = tr.querySelector('.ldesc');
      var amt  = tr.querySelector('.lamount');
      var vat  = tr.querySelector('.vat-select');
      if (desc) row.push(desc);
      if (amt)  row.push(amt);
      if (vat)  row.push(vat);
      if (row.length) grid.push(row);
    });

    // One row per journal entry (account code + account name)
    document.querySelectorAll('#journals-tbody tr').forEach(function(tr){
      var row = [];
      var code = tr.querySelector('.j-code, .j-ap-code');
      var name = tr.querySelector('.j-name, .j-ap-name');
      if (code) row.push(code);
      if (name) row.push(name);
      if (row.length) grid.push(row);
    });

    return grid;
  }

  function navHighlightCell(grid, r, c) {
    document.querySelectorAll('.nav-sel').forEach(function(el){ el.classList.remove('nav-sel'); });
    var target = grid[r] && grid[r][c];
    if (!target) return;
    var container = target.closest('.meta-field') || target;
    container.classList.add('nav-sel');
    _navMoving = true;
    target.focus();
    _navMoving = false;
    navMode = true;
  }

  function navMove(dr, dc) {
    var grid = buildNavGrid();
    var newRow = navRow + dr;
    if (newRow < 0 || newRow >= grid.length) return; // don't wrap vertically
    var newCol = Math.max(0, Math.min(grid[newRow].length - 1, navCol + dc));
    navRow = newRow;
    navCol = newCol;
    navHighlightCell(grid, navRow, navCol);
  }

  function enterInsertMode() {
    navMode = false;
    document.querySelectorAll('.nav-sel').forEach(function(el){ el.classList.remove('nav-sel'); });
    var grid = buildNavGrid();
    var el = grid[navRow] && grid[navRow][navCol];
    if (el) { el.focus(); if (el.select) el.select(); }
  }

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      var openDD =
        (document.getElementById('acct-dd') && document.getElementById('acct-dd').style.display !== 'none') ||
        (document.getElementById('currency-dropdown') && document.getElementById('currency-dropdown').style.display !== 'none') ||
        (document.getElementById('vendor-dd') && document.getElementById('vendor-dd').style.display !== 'none');
      if (openDD) {
        typeof hideAcctDropdown === 'function' && hideAcctDropdown();
        typeof hideCurrencyDropdown === 'function' && hideCurrencyDropdown();
        typeof hideVendorDropdown === 'function' && hideVendorDropdown();
        return;
      }
      if (!navMode) {
        // INSERT → NORMAL: stay on current cell
        navMode = true;
        var grid = buildNavGrid();
        var active = document.activeElement;
        outer: for (var r = 0; r < grid.length; r++) {
          for (var c = 0; c < grid[r].length; c++) {
            if (grid[r][c] === active) { navRow = r; navCol = c; break outer; }
          }
        }
        navHighlightCell(grid, navRow, navCol);
      } else {
        history.back();
      }
      return;
    }

    if (e.key === 'Tab') return; // browser handles Tab; focusin sets INSERT mode

    if (!navMode) return; // INSERT mode — all keys pass through normally

    // NORMAL mode: strict 2D movement
    if      (e.key === 'j') { e.preventDefault(); navMove( 1,  0); }
    else if (e.key === 'k') { e.preventDefault(); navMove(-1,  0); }
    else if (e.key === 'h') { e.preventDefault(); navMove( 0, -1); }
    else if (e.key === 'l') { e.preventDefault(); navMove( 0,  1); }
    else if (e.key === 'i') { e.preventDefault(); enterInsertMode(); }
  });

  // Tab or click → INSERT mode; track grid position
  document.addEventListener('focusin', function(e) {
    if (_navMoving) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) {
      navMode = false;
      var grid = buildNavGrid();
      outer: for (var r = 0; r < grid.length; r++) {
        for (var c = 0; c < grid[r].length; c++) {
          if (grid[r][c] === e.target) { navRow = r; navCol = c; break outer; }
        }
      }
      document.querySelectorAll('.nav-sel').forEach(function(el){ el.classList.remove('nav-sel'); });
    }
  });

  // Page load: NORMAL mode, no cell highlighted — user starts navigation with hjkl

  // Update currency labels and FX display on initial load
  window.addEventListener('load', function(){
    var currency = document.getElementById('currency').value.trim().toUpperCase();
    document.querySelectorAll('.line-ccy-label').forEach(function(el){
      el.textContent = currency || homeCurrency;
    });
    updateFxTotalDisplay();
  });

  // Delegated click handler for FX "Fetch from ECB" links
  document.addEventListener('click', function(e) {
    var link = e.target.closest('.fetch-ecb-link');
    if (!link) return;
    e.preventDefault();
    fetchAndRetry(link.dataset.date, link.dataset.currency);
  });

  function addBillAttachment(input) {
    if (!input.files || !input.files.length) return;
    for (var i = 0; i < input.files.length; i++) pendingBillAttachments.push(input.files[i]);
    input.value = '';
    renderBillPendingList();
  }

  function removeBillAttachment(idx) {
    pendingBillAttachments.splice(idx, 1);
    renderBillPendingList();
  }

  function renderBillPendingList() {
    var el = document.getElementById('bill-pending-list');
    if (!el) return;
    if (!pendingBillAttachments.length) { el.innerHTML = '<div style="padding:16px 20px;color:#aaa;font-size:0.8125rem">No files queued</div>'; return; }
    el.innerHTML = pendingBillAttachments.map(function(f, i) {
      var kb = (f.size / 1024).toFixed(1);
      var ext = f.name.split('.').pop().toUpperCase().substring(0,4);
      return '<div class="attach-row">'
        + '<div class="pdf-icon">' + ext + '</div>'
        + '<div class="attach-info">'
        + '  <div class="attach-filename">' + f.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>'
        + '  <div class="attach-meta">Pending save &middot; ' + kb + ' KB</div>'
        + '</div>'
        + '<div class="attach-actions">'
        + '  <button type="button" class="btn-icon btn-icon-del" onclick="removeBillAttachment(' + i + ')" title="Remove">&#10005;</button>'
        + '</div>'
        + '</div>';
    }).join('');
  }

  async function uploadPendingBillAttachments(billId) {
    if (!pendingBillAttachments.length) return;
    for (var i = 0; i < pendingBillAttachments.length; i++) {
      var fd = new FormData();
      fd.append('companyId', COMPANY);
      fd.append('entityType', 'bill');
      fd.append('entityId', billId);
      fd.append('file', pendingBillAttachments[i]);
      try { await fetch('/api/upload', { method: 'POST', body: fd }); } catch(e) {}
    }
    pendingBillAttachments = [];
  }
<\/script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleBillNewPage };
