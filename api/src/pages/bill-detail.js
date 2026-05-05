'use strict';
const { commonStyle, navBar, layoutEnd } = require('./common');
const { query } = require('../db');

async function handleBillDetailPage(req, res) {
  const { company, id } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const [co] = await query(
    `SELECT jurisdiction FROM companies WHERE company_id = @cid LIMIT 1`,
    { cid: company }
  ).catch(() => [{}]);
  const taxLabel = (co && co.jurisdiction === 'SG') ? 'GST' : 'VAT';
  res.send(buildBillDetailPage(company, id, taxLabel));
}

function buildBillDetailPage(company, billId, taxLabel = 'VAT') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Bill Details — freeBooks</title>
${commonStyle()}
<style>
  /* ---- Bill Detail page overrides ---- */
  .page { max-width:1100px; }

  .breadcrumb { font-size:9pt; color:#aaa; margin-bottom:22px; letter-spacing:.02em; }
  .breadcrumb a { color:#aaa; text-decoration:none; }
  .breadcrumb a:hover { color:#555; }
  .breadcrumb span { margin:0 7px; }

  .bill-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:28px; }
  .bill-header-left { display:flex; align-items:center; gap:14px; }
  .bill-header h1 { margin:0; font-size:20pt; font-weight:700; letter-spacing:-.01em; }
  .bill-header-actions { display:flex; gap:10px; align-items:center; }

  .badge { display:inline-block; padding:4px 12px; border-radius:5px; font-size:9pt; font-weight:600; }

  .btn-action {
    display:inline-flex; align-items:center; gap:6px;
    padding:8px 18px; border:1px solid #d0d0d0; border-radius:6px;
    background:#fff; cursor:pointer; font-size:10pt; color:#333;
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
  .meta-label { font-size:8.5pt; color:#aaa; font-weight:600; text-transform:uppercase; letter-spacing:.06em; margin-bottom:6px; }
  .meta-val { font-size:12pt; font-weight:600; color:#1a1a1a; }

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
  .card-label { font-size:8.5pt; color:#aaa; font-weight:600; text-transform:uppercase; letter-spacing:.06em; margin-bottom:12px; }
  .card-val-paid { font-size:30pt; font-weight:600; color:#c0c0c0; line-height:1; }
  .card-val-due { display:flex; align-items:baseline; gap:8px; line-height:1; }
  .card-currency { font-size:13pt; font-weight:500; color:#aaa; }
  .card-amount { font-size:36pt; font-weight:700; color:#1a1a1a; }

  /* Section headings */
  .section-h { font-size:13pt; font-weight:700; color:#1a1a1a; margin:0 0 14px; }

  /* Card-wrapped tables */
  .table-card {
    border:1px solid #e8e8e8; border-radius:8px;
    overflow:hidden; margin-bottom:36px;
  }
  .data-table { width:100%; border-collapse:collapse; font-size:10.5pt; }
  .data-table th {
    text-align:left; font-size:8.5pt; color:#aaa; font-weight:600;
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
    font-size:8pt; font-weight:700; color:#cc4444; letter-spacing:.04em;
    line-height:1;
  }
  .pdf-icon::before { content:'\\2014'; font-size:6pt; color:#ffaaaa; margin-bottom:2px; }
  .attach-info { flex:1; min-width:0; }
  .attach-filename { font-weight:600; font-size:10pt; color:#1a1a1a; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .attach-meta { font-size:8.5pt; color:#aaa; margin-top:3px; }
  .attach-actions { display:flex; gap:6px; flex-shrink:0; }
  .btn-icon {
    width:32px; height:32px; border:1px solid #ddd; border-radius:5px;
    background:#fff; cursor:pointer; display:inline-flex;
    align-items:center; justify-content:center; font-size:13pt; color:#555;
    text-decoration:none;
  }
  .btn-icon:hover { background:#f5f5f5; border-color:#bbb; }
  .btn-icon-del { color:#cc4444; border-color:#ffcccc; background:#fff5f5; }
  .btn-icon-del:hover { background:#ffe0e0; }

  /* Edit section */
  .edit-section { border:1px solid #e8e8e8; border-radius:8px; padding:24px 28px; display:none; margin-bottom:28px; }
  .edit-section-title { font-size:10.5pt; font-weight:600; color:#333; margin-bottom:16px; }
  .edit-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px 28px; margin-bottom:16px; }
  .edit-label { font-size:8.5pt; color:#888; font-weight:600; text-transform:uppercase; letter-spacing:.04em; display:block; margin-bottom:5px; }
  .edit-input { width:100%; padding:9px 12px; border:1px solid #ccc; border-radius:5px; font-size:10.5pt; box-sizing:border-box; }
  .edit-input:focus { outline:none; border-color:#2255cc; box-shadow:0 0 0 3px rgba(34,85,204,.08); }
</style>
</head>
<body>
<div class="page">
  ${navBar(company, 'payables')}

  <!-- Breadcrumb -->
  <div class="breadcrumb">
    <a href="/${company}/payables">BILLS</a>
    <span>&#8250;</span>
    <span id="bc-ref" style="color:#555;font-weight:600">${billId}</span>
  </div>

  <!-- Header -->
  <div class="bill-header">
    <div class="bill-header-left">
      <h1>Bill Details</h1>
      <span id="b-status"></span>
    </div>
    <div class="bill-header-actions">
      <button id="btn-edit-toggle" class="btn-action" onclick="toggleEdit()">&#9998; Edit</button>
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
      <div class="meta-label">Vendor</div>
      <div class="meta-val" id="b-vendor">—</div>
    </div>
    <div class="meta-field">
      <div class="meta-label">Invoice Ref</div>
      <div class="meta-val" id="b-ref">—</div>
    </div>
    <div class="meta-field">
      <div class="meta-label">Bill Date</div>
      <div class="meta-val" id="b-date">—</div>
    </div>
    <div class="meta-field">
      <div class="meta-label">Due Date</div>
      <div class="meta-val" id="b-due">—</div>
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
          <th style="min-width:90px">${taxLabel} (8%)</th>
          <th style="min-width:80px">Currency</th>
        </tr>
      </thead>
      <tbody id="lines-tbody">
        <tr><td colspan="4" style="color:#aaa;padding:20px 18px">Loading&#8230;</td></tr>
      </tbody>
    </table>
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

  <!-- Attachments -->
  <div class="section-h">Attachments</div>
  <div id="attachments-list" class="attach-card">
    <div style="padding:16px 20px;color:#aaa;font-size:9.5pt">Loading&#8230;</div>
  </div>

  <!-- Edit section -->
  <div class="edit-section" id="edit-section" style="margin-top:28px">
    <div class="edit-section-title">Edit Non-Financial Fields</div>
    <div class="edit-grid">
      <div>
        <label class="edit-label">Invoice Ref</label>
        <input type="text" id="edit-ref" class="edit-input">
      </div>
      <div>
        <label class="edit-label">Due Date</label>
        <input type="date" id="edit-due" class="edit-input">
      </div>
    </div>
    <div style="display:flex;gap:10px;align-items:center">
      <button onclick="saveEdits()"
        style="padding:9px 22px;background:#1a1a1a;color:#fff;border:none;border-radius:5px;font-size:10.5pt;cursor:pointer">
        Save Changes
      </button>
      <span id="edit-status" style="font-size:10pt"></span>
    </div>
  </div>

</div>

<script>
var COMPANY = '${company}';
var BILL_ID = '${billId}';
var billData = null;
var accountsCache = null;

window.addEventListener('DOMContentLoaded', function() {
  loadBill();
});

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function escAttr(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}

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
    var bill = res.data || res;
    if (!bill || res.error) {
      document.getElementById('b-vendor').textContent = res.error || 'Bill not found';
      return;
    }
    billData = bill;
    renderBill(bill);
    loadLines();
    loadJournals();
    loadAttachments();
  })
  .catch(function(e){ document.getElementById('b-vendor').textContent = 'Error: ' + e.message; });
}

function renderBill(bill) {
  document.title = 'Bill \u2014 ' + (bill.vendor || BILL_ID) + ' \u2014 freeBooks';
  var ref = bill.vendor_ref || BILL_ID;
  document.getElementById('bc-ref').textContent = ref;
  document.getElementById('b-vendor').textContent = bill.vendor || '\u2014';
  document.getElementById('b-ref').textContent = ref;
  document.getElementById('b-date').textContent = bill.date ? fmtDate(bill.date) : '\u2014';
  document.getElementById('b-due').textContent = bill.due_date ? fmtDate(bill.due_date) : '\u2014';
  document.getElementById('b-currency').textContent = bill.currency
    ? bill.currency + ' \u2013 ' + currencyName(bill.currency)
    : '\u2014';
  document.getElementById('b-status').innerHTML = statusBadge(bill.status, bill.due_date);
  document.getElementById('b-currency-prefix').textContent = bill.currency || '';
  var paid = Number(bill.amount_paid || 0);
  var due = Number(bill.amount || 0) - paid;
  document.getElementById('b-amount-paid').textContent = paid.toFixed(2);
  document.getElementById('b-amount-due').textContent = due.toFixed(2);
  document.getElementById('edit-ref').value = bill.vendor_ref || '';
  document.getElementById('edit-due').value = bill.due_date ? String(bill.due_date).slice(0,10) : '';
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
        + '<td><input type="text" value="' + escAttr(l.description||'') + '" '
        + 'style="width:100%;border:none;background:transparent;font-size:10.5pt;padding:2px 4px;border-radius:3px;color:#222" '
        + 'onchange="updateLineDesc(&apos;' + esc(l.entry_id||'') + '&apos;, this.value)" '
        + 'onfocus="this.style.background=&apos;#f8f9ff&apos;;this.style.border=&apos;1px solid #c0c8ff&apos;" '
        + 'onblur="this.style.background=&apos;transparent&apos;;this.style.border=&apos;none&apos;">'
        + '</td>'
        + '<td style="text-align:right">' + Number(l.amount||0).toFixed(2) + '</td>'
        + '<td style="color:#555">' + esc(l.vat_code||'') + '</td>'
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
    el.innerHTML = '<div style="padding:16px 20px;color:#aaa;font-size:9.5pt">No attachments yet.</div>';
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
  el.innerHTML = '<div style="padding:16px 20px;color:#aaa;font-size:9.5pt">Loading\u2026</div>';
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

function toggleEdit() {
  var sec = document.getElementById('edit-section');
  var btn = document.getElementById('btn-edit-toggle');
  var open = sec.style.display !== 'none' && sec.style.display !== '';
  sec.style.display = open ? 'none' : '';
  btn.innerHTML = open ? '&#9998; Edit' : '&#10005; Cancel Edit';
}

function saveEdits() {
  if (!billData) return;
  var vendor_ref = document.getElementById('edit-ref').value.trim();
  var due_date = document.getElementById('edit-due').value;
  var statusEl = document.getElementById('edit-status');
  statusEl.textContent = 'Saving\u2026'; statusEl.style.color = '#555';
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'bill.update', companyId: COMPANY, billId: BILL_ID,
      vendor_ref: vendor_ref, due_date: due_date || undefined, description: billData.description || '' }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    if (res.error) { statusEl.textContent = '\u2717 ' + res.error; statusEl.style.color = '#cc2222'; return; }
    billData.vendor_ref = vendor_ref; billData.due_date = due_date;
    document.getElementById('b-ref').textContent = vendor_ref || '\u2014';
    document.getElementById('bc-ref').textContent = vendor_ref || BILL_ID;
    document.getElementById('b-due').textContent = due_date ? fmtDate(due_date) : '\u2014';
    statusEl.textContent = '\u2713 Saved'; statusEl.style.color = '#2a8a2a';
  })
  .catch(function(e){ statusEl.textContent = '\u2717 ' + e.message; statusEl.style.color = '#cc2222'; });
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
