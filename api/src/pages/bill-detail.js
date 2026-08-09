'use strict';
const { commonStyle, navBar, layoutEnd, getRelevanceFlags } = require('./common');
const { query } = require('../db');

async function handleBillDetailPage(req, res) {
  const { company, id } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const [co] = await query(
    `SELECT jurisdiction FROM companies WHERE company_id = @cid LIMIT 1`,
    { cid: company }
  ).catch(() => [{}]);
  const taxLabel = (co && co.jurisdiction === 'SG') ? 'GST' : 'VAT';
  const flags = await getRelevanceFlags(company);
  res.send(buildBillDetailPage(company, id, taxLabel, flags));
}

function buildBillDetailPage(company, billId, taxLabel = 'VAT', flags) {
  // settings-ux-spec §7 item 9: vatRegistered=false drops the tax column.
  const vatOn = !flags || flags.vatRegistered !== false;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Bill Details — freeBooks</title>
${commonStyle()}
<style>
  /* ---- Bill Detail page overrides ---- */
  .page { max-width:1100px; }



  .bill-header-actions { display:flex; gap:10px; align-items:center; }

  .badge { display:inline-block; padding:4px 12px; border-radius:5px; font-size:0.75rem; font-weight:600; }

  .btn-action {
    display:inline-flex; align-items:center; gap:6px;
    padding:8px 18px; border:1px solid #d0d0d0; border-radius:6px;
    background:#fff; cursor:pointer; font-size:0.8125rem; color:#333;
    white-space:nowrap;
  }
  .btn-action:hover { background:#f5f5f5; border-color:#bbb; }
  .btn-primary { background:#1a1a1a; color:#fff; border-color:#1a1a1a; }
  .btn-primary:hover { background:#333; border-color:#333; }

  /* Meta strip */
  .meta-strip {
    display:flex;
    border-top:1px solid #eee; border-bottom:1px solid #eee;
    padding:24px 0; margin-bottom:32px;
  }
  .meta-field { flex:1; padding:0 28px; }
  .meta-field:first-child { padding-left:0; }
  .meta-field:last-child { border-right:none; }
  .meta-field + .meta-field { border-left:1px solid #eee; }
  .meta-label { font-size:0.75rem; color:#aaa; font-weight:600; text-transform:uppercase; letter-spacing:.06em; margin-bottom:6px; }
  .meta-val { font-size:1rem; font-weight:600; color:#1a1a1a; }

  /* Amount cards */
  .amount-cards { display:flex; gap:16px; margin-bottom:36px; }
  .card-paid {
    flex:0 0 42%;
    background:#f7f7f7; border-radius:8px;
    padding:24px 28px;
  }
  .card-due {
    flex:1;
    background:#fff; border:2px solid #1a1a1a; border-radius:8px;
    padding:24px 28px;
  }
  .card-label { font-size:0.75rem; color:#aaa; font-weight:600; text-transform:uppercase; letter-spacing:.06em; margin-bottom:12px; }
  .card-val-paid { font-size:1.875rem; font-weight:600; color:#c0c0c0; line-height:1; }
  .card-val-due { display:flex; align-items:baseline; gap:8px; line-height:1; }
  .card-currency { font-size:1.0625rem; font-weight:500; color:#aaa; }
  .card-amount { font-size:2.25rem; font-weight:700; color:#1a1a1a; }

  /* Section headings */
  .section-h { font-size:1.0625rem; font-weight:700; color:#1a1a1a; margin:0 0 14px; }

  /* Card-wrapped tables */
  .table-card {
    border:1px solid #e8e8e8; border-radius:8px;
    overflow:hidden; margin-bottom:36px;
  }
  .data-table { width:100%; border-collapse:collapse; font-size:0.875rem; }
  .data-table th {
    text-align:left; font-size:0.75rem; color:#aaa; font-weight:600;
    text-transform:uppercase; letter-spacing:.05em;
    background:#fafafa; border-bottom:1px solid #e8e8e8;
    padding:12px 18px;
  }
  .data-table td { padding:16px 18px; border-bottom:1px solid #f2f2f2; vertical-align:middle; color:#222; }
  .data-table tbody tr:last-child td { border-bottom:none; }
  .data-table tr.batch-row-0 td { background:#fff; }
  .data-table tr.batch-row-n td { background:#fff; }
  .ref-blue { color:#2255cc; font-weight:500; }
  .currency-blue { color:#2255cc; }

  /* Attachments */
  .attach-card { border:1px solid #e8e8e8; border-radius:8px; overflow:hidden; }
  .attach-row { display:flex; align-items:center; padding:16px 20px; border-bottom:1px solid #f2f2f2; gap:14px; }
  .attach-row:last-child { border-bottom:none; }
  .pdf-icon {
    width:36px; height:44px; background:#fff0f0; border:1px solid #ffcccc;
    border-radius:4px; flex-shrink:0;
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    font-size:0.6875rem; font-weight:700; color:#cc4444; letter-spacing:.04em;
    line-height:1;
  }
  .pdf-icon::before { content:'\\2014'; font-size:0.5rem; color:#ffaaaa; margin-bottom:2px; }
  .attach-info { flex:1; min-width:0; }
  .attach-filename { font-weight:600; font-size:0.8125rem; color:#1a1a1a; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .attach-meta { font-size:0.75rem; color:#aaa; margin-top:3px; }
  .attach-actions { display:flex; gap:6px; flex-shrink:0; }
  .btn-icon {
    width:32px; height:32px; border:1px solid #ddd; border-radius:5px;
    background:#fff; cursor:pointer; display:inline-flex;
    align-items:center; justify-content:center; font-size:1.0625rem; color:#555;
    text-decoration:none;
  }
  .btn-icon:hover { background:#f5f5f5; border-color:#bbb; }
  .btn-icon-del { color:#cc4444; border-color:#ffcccc; background:#fff5f5; }
  .btn-icon-del:hover { background:#ffe0e0; }



  /* Keyboard nav focus for attachment rows */
  .attach-row.nav-attach-focus { background: #1a1a1a !important; }
  .attach-row.nav-attach-focus .attach-filename,
  .attach-row.nav-attach-focus .attach-meta { color: #fff !important; }
  .attach-row.nav-attach-focus .pdf-icon { border-color: #888; color: #fff; }
  /* Description input: white text when row is focused */
  tr.nav-row-focus > td input { color: #fff !important; background: transparent !important; border-color: transparent !important; }
  /* Invoice ref nav focus */
  .meta-field.nav-meta-focus { background: var(--accent); border-radius:6px; }
  .meta-field.nav-meta-focus .meta-label { color: rgba(255,255,255,.7); }
  .meta-field.nav-meta-focus .meta-val-input { color: #fff; background: transparent; }
  /* Inline edit hint */
  .line-desc-input { width:100%; border:none; background:transparent; font-size:0.875rem; padding:2px 4px; border-radius:3px; color:#222; cursor:text; }
  .line-desc-input:hover { background:#f8f9ff; border:1px solid #c0c8ff; }
  .line-desc-input:focus { outline:none; background:#f8f9ff; border:1px solid #c0c8ff; }
  .meta-val-input { font-size:1rem; font-weight:600; color:#1a1a1a; border:none; background:transparent; padding:2px 4px; border-radius:3px; width:100%; cursor:text; }
  .meta-val-input:hover { background:#f8f9ff; border:1px solid #c0c8ff; }
  .meta-val-input:focus { outline:none; background:#f8f9ff; border:1px solid #c0c8ff; }
</style>
</head>
<body>${navBar(company, 'payables')}
<div class="page">

  <!-- Header -->
  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:28px;">
    <div class="header" style="margin-bottom:0; display:flex; align-items:center; gap:12px;">
      <h1>📋 Payables: Bill details</h1>
      <span id="b-status"></span>
    </div>
    <div class="bill-header-actions">
      <button id="btn-void" class="btn-action" onclick="doVoid()" style="display:none">&#8856; Void</button>
      <button class="btn-action btn-primary" onclick="document.getElementById('attach-input').click()">
        &#128206; Add Attachment
      </button>
      <input type="file" id="attach-input" style="display:none"
        accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt"
        onchange="uploadAttachment(this)">
    </div>
  </div>

  <!-- Meta strip -->
  <div class="meta-strip">
    <div class="meta-field">
      <div class="meta-label">Partner</div>
      <div class="meta-val" id="b-partner-name">—</div>
    </div>
    <div class="meta-field nav-meta-item">
      <div class="meta-label">Invoice Ref <span style="font-size:0.625rem;color:#bbb;font-weight:400;text-transform:none;letter-spacing:0">(i to edit)</span></div>
      <input class="meta-val-input" id="b-ref" value="" placeholder="—" title="Press i or click to edit" onchange="saveRef(this.value)" onblur="saveRef(this.value)">
    </div>
    <div class="meta-field">
      <div class="meta-label">Bill Date</div>
      <div class="meta-val" id="b-date">—</div>
    </div>
    <div class="meta-field nav-meta-item">
      <div class="meta-label">Due Date <span style="font-size:0.625rem;color:#bbb;font-weight:400;text-transform:none;letter-spacing:0">(i to edit)</span></div>
      <input type="date" class="meta-val-input" id="b-due" title="Press i or click to edit" onchange="saveDueDate(this.value)">
    </div>
    <div class="meta-field">
      <div class="meta-label">Currency</div>
      <div class="meta-val" id="b-currency">—</div>
    </div>
  </div>

  <!-- Hidden compat spans -->
  <span id="m-ap" style="display:none"></span>
  <span id="m-desc" style="display:none"></span>
  <span id="m-amount" style="display:none"></span>

  <!-- Amount cards -->
  <div class="amount-cards">
    <div class="card-paid">
      <div class="card-label">Amount Paid</div>
      <div class="card-val-paid" id="b-amount-paid">—</div>
    </div>
    <div class="card-due">
      <div class="card-label">Amount Due</div>
      <div class="card-val-due">
        <span class="card-currency" id="b-currency-prefix"></span>
        <span class="card-amount" id="b-amount-due">—</span>
      </div>
    </div>
  </div>

  <!-- Bill Line Items -->
  <div class="section-h">Bill Line Items</div>
  <div class="table-card" style="margin-bottom:36px">
    <table class="data-table">
      <thead>
        <tr>
          <th>Description</th>
          <th style="text-align:right;min-width:100px">Amount</th>
          ${vatOn ? '<th style="min-width:90px">' + taxLabel + '</th>' : ''}
          <th style="min-width:80px">Currency</th>
        </tr>
      </thead>
      <tbody id="lines-tbody">
        <tr><td colspan="4" style="color:#aaa;padding:20px 18px">Loading&#8230;</td></tr>
      </tbody>
    </table>
  </div>

  <!-- Attachments -->
  <div class="section-h">Attachments</div>
  <div id="attachments-list" class="attach-card" style="margin-bottom:36px">
    <div style="padding:16px 20px;color:#aaa;font-size:0.8125rem">Loading&#8230;</div>
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
        <tr><td colspan="6" style="color:#aaa;padding:20px 18px">Loading&#8230;</td></tr>
      </tbody>
    </table>
  </div>



</div>

<script>
var COMPANY = '${company}';
var VAT_ON = ${vatOn ? 'true' : 'false'};
var BILL_ID = '${billId}';
var billData = null;
var accountsCache = null;

function fbPageInitBillDetail() {
  loadBill();
}
window.addEventListener('DOMContentLoaded', fbPageInitBillDetail);
window.fbPageInit = fbPageInitBillDetail;

// Navigation model: meta strip = one j/k row; h/l moves within it
var _lastMetaIdx = 0;

function moveMetaNav(dir) {
  var metaItems = Array.from(document.querySelectorAll('.nav-meta-item'));
  if (!metaItems.length) return;
  var focused = document.querySelector('.nav-meta-item.nav-meta-focus');
  if (!focused) return;
  var idx = metaItems.indexOf(focused);
  _lastMetaIdx = Math.max(0, Math.min(metaItems.length - 1, idx + dir));
  clearBillNavFocus();
  metaItems[_lastMetaIdx].classList.add('nav-meta-focus');
}

function getMetaStrip() { return document.querySelector('.meta-strip'); }

function getBillNavItems() {
  var items = [];
  var strip = getMetaStrip();
  if (strip && strip.querySelector('.nav-meta-item')) items.push(strip);
  Array.from(document.querySelectorAll('#lines-tbody tr')).forEach(function(r) { items.push(r); });
  Array.from(document.querySelectorAll('.attach-row')).forEach(function(r) { items.push(r); });
  return items;
}

function clearBillNavFocus() {
  document.querySelectorAll('tr.nav-row-focus').forEach(function(r) { r.classList.remove('nav-row-focus'); });
  document.querySelectorAll('.attach-row.nav-attach-focus').forEach(function(r) { r.classList.remove('nav-attach-focus'); });
  document.querySelectorAll('.nav-meta-item.nav-meta-focus').forEach(function(r) { r.classList.remove('nav-meta-focus'); });
}

function getFocusedBillItem() {
  // Meta fields focused → report the strip as the focused item
  if (document.querySelector('.nav-meta-item.nav-meta-focus')) return getMetaStrip();
  return document.querySelector('tr.nav-row-focus') ||
         document.querySelector('.attach-row.nav-attach-focus');
}

function moveBillNav(dir) {
  var items = getBillNavItems();
  if (!items.length) return;
  var focused = getFocusedBillItem();
  var idx = focused ? items.indexOf(focused) : -1;
  var newIdx;
  if (idx === -1) {
    newIdx = dir === 'j' ? 0 : items.length - 1;
  } else {
    newIdx = dir === 'j' ? idx + 1 : idx - 1;
  }
  newIdx = Math.max(0, Math.min(items.length - 1, newIdx));
  clearBillNavFocus();
  var next = items[newIdx];
  if (next.tagName === 'TR') {
    next.classList.add('nav-row-focus');
  } else if (next.classList.contains('attach-row')) {
    next.classList.add('nav-attach-focus');
  } else {
    // meta strip — focus the last-used meta field (default: first)
    var metaItems = Array.from(next.querySelectorAll('.nav-meta-item'));
    var target = metaItems[Math.min(_lastMetaIdx, metaItems.length - 1)];
    if (target) target.classList.add('nav-meta-focus');
  }
  next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Register keyboard actions for bill detail view
window.fbKeyActions = {
  'j': function() { moveBillNav('j'); },
  'k': function() { moveBillNav('k'); },
  'edit': function() {
    var metaFocused = document.querySelector('.nav-meta-item.nav-meta-focus');
    if (metaFocused) {
      var metaInp = metaFocused.querySelector('input');
      if (metaInp) { metaInp.focus(); metaInp.select(); }
      return;
    }
    var focused = document.querySelector('tr.nav-row-focus');
    if (focused) {
      var inp = focused.querySelector('input.line-desc-input');
      if (inp) { inp.focus(); inp.select(); }
    }
  },
  'attach': function() {
    // K4: A = attach everywhere (keyboard-ux-spec §8). The legacy common.js
    // dispatcher routes shift-a to fbKeyActions.attach; the old 'new' entry
    // (a = attach) is retired on this page — freed for add-line semantics.
    var inp = document.getElementById('attach-input');
    if (inp) inp.click();
  },
  'delete': function() {
    var attachFocused = document.querySelector('.attach-row.nav-attach-focus');
    if (attachFocused) {
      var delBtn = attachFocused.querySelector('.btn-icon-del');
      if (delBtn) delBtn.click();
      return;
    }
    // Nothing focused → confirm void
    doVoid();
  },
  'h': function() { moveMetaNav(-1); },
  'l': function() { moveMetaNav(1); },
  'escape': function() {
    if (typeof COMPANY !== 'undefined') fbNavigate('/' + COMPANY + '/payables');
  }
};

// K5: register an FB.keys set delegating to the same handlers (gate: every
// route must have a live, hint-rendered set). fb-core claims these keys at
// capture phase, so the legacy common.js dispatcher never double-fires;
// keys NOT claimed here (legacy 'a', 'i') keep bubbling to fbKeyActions.
(function () {
  function act(name) { return function () { window.fbKeyActions[name](); }; }
  FB.keys.unregister('bill-detail'); // soft-nav re-execution guard
  FB.keys.register('bill-detail', {
    bindings: [
      { key: 'j', mode: 'NORMAL', hint: 'navigate', hintBar: true, paletteEligible: false, run: act('j') },
      { key: 'k', mode: 'NORMAL', hint: 'navigate', hintBar: true, paletteEligible: false, run: act('k') },
      { key: 'h', mode: 'NORMAL', hint: 'section ←', hintBar: true, paletteEligible: false, run: act('h') },
      { key: 'l', mode: 'NORMAL', hint: 'section →', hintBar: true, paletteEligible: false, run: act('l') },
      { key: 'e', mode: 'NORMAL', hint: 'edit', hintBar: true, paletteEligible: false, run: act('edit') },
      { key: 'A', mode: 'NORMAL', hint: 'attach', hintBar: true, run: act('attach') },
      { key: 'd', mode: 'NORMAL', hint: 'delete/void', hintBar: true, run: act('delete') },
      { key: 'Escape', mode: 'NORMAL', hint: 'back', hintBar: true, paletteEligible: false, run: act('escape') }
    ]
  });
  FB.keys.renderHints('bill-detail', document.getElementById('sb-hints'), { layout: 'list' });
})();

// esc/escAttr now come from fb-core.js (window.esc) — P1-3 shared core
function statusBadge(status, dueDate) {
  var today = new Date().toISOString().slice(0,10);
  var isOverdue = (status === 'posted' || status === 'partial') && dueDate && String(dueDate).slice(0,10) < today;
  if (isOverdue) return '<span class="badge" style="background:#fff0f0;color:#cc2222">Overdue</span>';
  if (status === 'posted')  return '<span class="badge" style="background:#e8eeff;color:#2255cc">Open</span>';
  if (status === 'partial') return '<span class="badge" style="background:#fff3e0;color:#cc7700">Partial</span>';
  if (status === 'paid')    return '<span class="badge" style="background:#f0fff4;color:#2a8a2a">Paid</span>';
  if (status === 'void')    return '<span class="badge" style="background:#f0f0f0;color:#888">Void</span>';
  return '<span class="badge" style="background:#f0f0f0;color:#888">' + esc(status||'') + '</span>';
}

function loadBill() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'bill.get', companyId: COMPANY, billId: BILL_ID }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    if (!document.getElementById('b-partner-name')) return;
    var bill = res.data || res;
    if (!bill || res.error) {
      document.getElementById('b-partner-name').textContent = res.error || 'Bill not found';
      return;
    }
    billData = bill;
    renderBill(bill);
    loadLines();
    loadJournals();
    loadAttachments();
  })
  .catch(function(e){
    var el = document.getElementById('b-partner-name');
    if (el) el.textContent = 'Error: ' + e.message;
  });
}

function renderBill(bill) {
  document.title = 'Bill \u2014 ' + (bill.partner_name || BILL_ID) + ' \u2014 freeBooks';
  var ref = bill.vendor_ref || BILL_ID;
  document.getElementById('b-partner-name').textContent = bill.partner_name || '\u2014';
  document.getElementById('b-ref').value = ref;
  document.getElementById('b-date').textContent = bill.date ? fmtDate(bill.date) : '\u2014';
  document.getElementById('b-due').value = bill.due_date ? String(bill.due_date).slice(0,10) : '';
  document.getElementById('b-currency').textContent = bill.currency || '\u2014';
  document.getElementById('b-status').innerHTML = statusBadge(bill.status, bill.due_date);
  document.getElementById('b-currency-prefix').textContent = bill.currency || '';
  var paid = Number(bill.amount_paid || 0);
  var due = Number(bill.amount || 0) - paid;
  document.getElementById('b-amount-paid').textContent = paid.toFixed(2);
  document.getElementById('b-amount-due').textContent = due.toFixed(2);
  var voidBtn = document.getElementById('btn-void');
  if (voidBtn) voidBtn.style.display = (bill.status === 'posted') ? '' : 'none';
}

function fmtDate(d) {
  if (!d) return '\u2014';
  var s = String(d).slice(0,10);
  var parts = s.split('-');
  if (parts.length !== 3) return s;
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[parseInt(parts[1],10)-1] + ' ' + parseInt(parts[2],10) + ', ' + parts[0];
}

function currencyName(code) {
  var names = { SGD:'Singapore Dollar', SEK:'Swedish Krona', USD:'US Dollar', EUR:'Euro', GBP:'British Pound', MYR:'Malaysian Ringgit', AUD:'Australian Dollar' };
  return names[code] || code;
}

function loadLines() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'bill.lines', companyId: COMPANY, billId: BILL_ID }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    var lines = res.data || res || [];
    if (!Array.isArray(lines) || !lines.length) {
      document.getElementById('lines-tbody').innerHTML = '<tr><td colspan="4" style="color:#aaa;padding:20px 18px">No line items.</td></tr>';
      return;
    }
    var html = '';
    lines.forEach(function(l){
      html += '<tr>'
        + '<td><input type="text" value="' + esc(l.description||'') + '" '
        + 'class="line-desc-input" '
        + 'title="Click to edit description" '
        + 'data-entry-id="' + esc(l.entry_id||'') + '" '
        + 'onchange="updateLineDesc(&apos;' + esc(l.entry_id||'') + '&apos;, this.value)">'
        + '</td>'
        + '<td style="text-align:right">' + Number(l.amount||0).toFixed(2) + '</td>'
        + (VAT_ON ? '<td style="color:#555">' + esc(l.vat_code||'') + '</td>' : '')
        + '<td class="currency-blue">' + esc(l.currency||'') + '</td>'
        + '</tr>';
    });
    document.getElementById('lines-tbody').innerHTML = html;
  })
  .catch(function(){
    document.getElementById('lines-tbody').innerHTML = '<tr><td colspan="4" style="color:#cc2222">Error loading lines.</td></tr>';
  });
}

function updateLineDesc(entryId, description) {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'journal.entry.update', companyId: COMPANY, entryId: entryId, description: description }) })
  .then(function(r){ return r.json(); })
  .then(function(res){ if (res.error) console.warn('Line update failed:', res.error); })
  .catch(function(e){ console.warn('Line update error:', e); });
}

function ensureAccounts(cb) {
  if (accountsCache) { cb(accountsCache); return; }
  fetch('/api/' + COMPANY + '/accounts')
  .then(function(r){ return r.json(); })
  .then(function(rows){
    accountsCache = {};
    if (Array.isArray(rows)) rows.forEach(function(a){ if (a.account_code) accountsCache[a.account_code] = a.account_name || ''; });
    cb(accountsCache);
  })
  .catch(function(){ cb({}); });
}

function loadJournals() {
  ensureAccounts(function(acctMap){
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'journal.list', companyId: COMPANY, billId: BILL_ID, sortBy:'date', sortDir:'ASC' }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var entries = res.data || res || [];
      if (!Array.isArray(entries) || !entries.length) {
        document.getElementById('journals-tbody').innerHTML = '<tr><td colspan="6" style="color:#aaa;padding:20px 18px">No journal entries.</td></tr>';
        return;
      }
      var batches = {};
      var batchOrder = [];
      entries.forEach(function(e){
        var bId = e.batch_id || 'default';
        if (!batches[bId]) { batches[bId] = { date: e.date, reference: e.reference, lines: [] }; batchOrder.push(bId); }
        batches[bId].lines.push(e);
      });
      var html = '';
      batchOrder.forEach(function(bId){
        var batch = batches[bId];
        var dateStr = batch.date ? String(batch.date).slice(0,10) : '';
        batch.lines.forEach(function(line, idx){
          var dr = parseFloat(line.debit_home || line.debit || 0).toFixed(2);
          var cr = parseFloat(line.credit_home || line.credit || 0).toFixed(2);
          var acctName = line.account_name || acctMap[line.account_code] || '';
          html += '<tr class="batch-row-' + (idx===0?'0':'n') + '">'
            + '<td style="white-space:nowrap;color:#555">' + (idx === 0 ? dateStr : '') + '</td>'
            + '<td class="ref-blue">' + (idx === 0 ? esc(batch.reference || bId) : '') + '</td>'
            + '<td style="color:#555">' + esc(line.account_code || '') + '</td>'
            + '<td>' + esc(acctName) + '</td>'
            + '<td style="text-align:right">' + (dr !== '0.00' ? dr : '\u2014') + '</td>'
            + '<td style="text-align:right">' + (cr !== '0.00' ? cr : '\u2014') + '</td>'
            + '</tr>';
        });
      });
      document.getElementById('journals-tbody').innerHTML = html;
    })
    .catch(function(){
      document.getElementById('journals-tbody').innerHTML = '<tr><td colspan="6" style="color:#cc2222">Error loading journals.</td></tr>';
    });
  });
}

function renderAttachments(items) {
  var el = document.getElementById('attachments-list');
  if (!items.length) {
    el.innerHTML = '<div style="padding:16px 20px;color:#aaa;font-size:0.8125rem">No attachments yet.</div>';
    return;
  }
  el.innerHTML = items.map(function(a){
    var kb = (a.file_size / 1024).toFixed(1);
    var date = a.created_at ? new Date(a.created_at).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) : '';
    var ext = (a.filename || '').split('.').pop().toUpperCase().slice(0,4);
    return '<div class="attach-row">'
      + '<div class="pdf-icon">' + esc(ext) + '</div>'
      + '<div class="attach-info">'
      + '<div class="attach-filename">' + esc(a.filename) + '</div>'
      + '<div class="attach-meta">Uploaded on ' + date + ' \u2022 ' + kb + ' KB</div>'
      + '</div>'
      + '<div class="attach-actions">'
      + '<a href="/api/attachments/' + esc(a.attachment_id) + '" target="_blank" class="btn-icon" title="Download">&#8595;</a>'
      + '<button onclick="deleteAttachment(&apos;' + esc(a.attachment_id) + '&apos;)" class="btn-icon btn-icon-del" title="Delete">&#128465;</button>'
      + '</div>'
      + '</div>';
  }).join('');
}

function loadAttachments() {
  var el = document.getElementById('attachments-list');
  el.innerHTML = '<div style="padding:16px 20px;color:#aaa;font-size:0.8125rem">Loading\u2026</div>';
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'attachment.list', companyId: COMPANY, entityType:'bill', entityId: BILL_ID }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    var items = res.data || res || [];
    renderAttachments(Array.isArray(items) ? items : []);
  })
  .catch(function(){ el.innerHTML = '<div style="padding:16px 20px;color:#cc2222">Error loading attachments.</div>'; });
}

function uploadAttachment(input) {
  if (!input.files || !input.files[0]) return;
  var file = input.files[0];
  input.value = '';
  var el = document.getElementById('attachments-list');
  el.innerHTML = '<div style="padding:16px 20px;color:#888">Uploading ' + esc(file.name) + '\u2026</div>';
  var fd = new FormData();
  fd.append('companyId', COMPANY);
  fd.append('entityType', 'bill');
  fd.append('entityId', BILL_ID);
  fd.append('file', file);
  fetch('/api/upload', { method:'POST', body: fd })
  .then(function(r){ return r.json(); })
  .then(function(res){
    if (res.error || !res.ok) { loadAttachments(); alert('Upload failed: ' + (res.error || 'unknown error')); return; }
    loadAttachments();
  })
  .catch(function(e){ loadAttachments(); alert('Upload failed: ' + e.message); });
}

function deleteAttachment(attachmentId) {
  if (!confirm('Remove this attachment?')) return;
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'attachment.delete', companyId: COMPANY, attachmentId: attachmentId }) })
  .then(function(r){ return r.json(); })
  .then(function(){ loadAttachments(); })
  .catch(function(){});
}



var _saveRefPending = null;
function saveRef(val) {
  if (!billData) return;
  val = val.trim();
  if (val === (billData.vendor_ref || BILL_ID)) return; // no change
  clearTimeout(_saveRefPending);
  _saveRefPending = setTimeout(function() {
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'bill.update', companyId: COMPANY, billId: BILL_ID,
        vendor_ref: val, description: billData.description || '' }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      if (!res.error) { billData.vendor_ref = val; }
    }).catch(function(){});
  }, 400);
}

function saveDueDate(val) {
  if (!billData) return;
  if (val === (billData.due_date ? String(billData.due_date).slice(0,10) : '')) return;
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'bill.update', companyId: COMPANY, billId: BILL_ID,
      due_date: val || undefined, vendor_ref: billData.vendor_ref || '',
      description: billData.description || '' }) })
  .then(function(r){ return r.json(); })
  .then(function(res){ if (!res.error) { billData.due_date = val; } })
  .catch(function(){});
}

function doVoid() {
  if (!confirm('Void this bill? The journal entry will be auto-reversed.')) return;
  var btn = document.getElementById('btn-void');
  btn.disabled = true;
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'bill.void', companyId: COMPANY, billId: BILL_ID }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    var err = res.error || (res.data && res.data.error);
    if (err) { btn.disabled = false; alert('Error: ' + err); return; }
    window.location.href = '/' + COMPANY + '/payables';
  })
  .catch(function(e){ btn.disabled = false; alert('Error: ' + e.message); });
}
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleBillDetailPage };
