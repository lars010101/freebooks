'use strict';
const { commonStyle, navBar } = require('./common');
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
  .bill-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:20px; }
  .bill-header-left { display:flex; align-items:center; gap:12px; }
  .bill-header h1 { margin:0; font-size:16pt; font-weight:700; }
  .bill-header-actions { display:flex; gap:8px; align-items:center; }
  .badge { display:inline-block; padding:3px 10px; border-radius:4px; font-size:9pt; font-weight:600; }
  .btn-action { padding:7px 16px; border:1px solid #ccc; border-radius:5px; background:#fff; cursor:pointer; font-size:10pt; }
  .btn-action:hover { background:#f5f5f5; }
  .btn-primary { background:#1a1a1a; color:#fff; border-color:#1a1a1a; }
  .btn-primary:hover { background:#333; }
  .meta-strip { display:flex; border-bottom:1px solid #e8e8e8; padding-bottom:16px; margin-bottom:20px; }
  .meta-field { flex:1; padding-right:16px; }
  .meta-field + .meta-field { border-left:1px solid #eee; padding-left:16px; }
  .meta-label { font-size:9pt; color:#999; font-weight:600; text-transform:uppercase; letter-spacing:.04em; margin-bottom:4px; }
  .meta-val { font-size:10.5pt; font-weight:600; color:#1a1a1a; }
  .amount-cards { display:flex; gap:12px; margin-bottom:24px; }
  .card-paid { flex:0 0 38%; background:#f5f5f5; border-radius:6px; padding:16px 20px; }
  .card-due { flex:1; background:#fff; border:2px solid #1a1a1a; border-radius:6px; padding:16px 20px; }
  .card-label { font-size:9pt; color:#999; font-weight:600; text-transform:uppercase; letter-spacing:.04em; margin-bottom:8px; }
  .card-amount-paid { font-size:22pt; font-weight:600; color:#aaa; }
  .card-amount-due { font-size:22pt; font-weight:700; color:#1a1a1a; }
  .card-currency { font-size:11pt; font-weight:400; color:#aaa; margin-right:4px; }
  .section-h { font-size:10.5pt; font-weight:700; color:#222; margin:24px 0 10px; }
  .data-table { width:100%; border-collapse:collapse; font-size:10pt; }
  .data-table th { text-align:left; font-size:8.5pt; color:#888; font-weight:600; text-transform:uppercase; letter-spacing:.04em; border-bottom:1px solid #ddd; padding:6px 10px; }
  .data-table td { padding:7px 10px; border-bottom:1px solid #f2f2f2; vertical-align:middle; }
  .data-table tr:last-child td { border-bottom:none; }
  .data-table tr.batch-first td { background:#fafafa; font-weight:600; }
  .ref-blue { color:#2255cc; }
  .currency-blue { color:#2255cc; }
  .attach-row { display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #f0f0f0; }
  .attach-row:last-child { border-bottom:none; }
  .attach-icon { font-size:20pt; line-height:1; margin-right:10px; flex-shrink:0; }
  .attach-info { flex:1; }
  .attach-filename { font-weight:600; font-size:9.5pt; color:#1a1a1a; }
  .attach-meta { font-size:8.5pt; color:#999; margin-top:2px; }
  .attach-actions { display:flex; gap:6px; flex-shrink:0; }
  .btn-dl { padding:5px 12px; border:1px solid #ccc; border-radius:4px; background:#f5f5f5; font-size:8.5pt; text-decoration:none; color:#333; cursor:pointer; }
  .btn-dl:hover { background:#eee; }
  .btn-del { padding:5px 12px; border:1px solid #ffcccc; border-radius:4px; background:#fff5f5; font-size:8.5pt; color:#cc4444; cursor:pointer; }
  .btn-del:hover { background:#ffe0e0; }
  .edit-section { margin-top:24px; border-top:1px solid #eee; padding-top:16px; display:none; }
  .edit-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px 24px; margin-bottom:14px; }
  .edit-label { font-size:9pt; color:#888; font-weight:600; text-transform:uppercase; display:block; margin-bottom:4px; }
  .edit-input { width:100%; padding:7px 10px; border:1px solid #ccc; border-radius:4px; font-size:10pt; box-sizing:border-box; }
  .edit-input:focus { outline:none; border-color:#2255cc; }
  .back-link { display:inline-flex; align-items:center; gap:5px; color:#666; text-decoration:none; font-size:9.5pt; margin-bottom:18px; }
  .back-link:hover { color:#1a1a1a; }
</style>
</head>
<body>
<div class="page">
  ${navBar(company, 'payables')}

  <a href="/${company}/payables" class="back-link">&#8592; Back to Payables</a>

  <!-- Header -->
  <div class="bill-header">
    <div class="bill-header-left">
      <h1>Bill Details</h1>
      <span id="b-status"></span>
    </div>
    <div class="bill-header-actions">
      <button id="btn-edit-toggle" class="btn-action" onclick="toggleEdit()">&#9998; Edit</button>
      <button id="btn-void" class="btn-action" onclick="doVoid()" style="display:none">&#8856; Void</button>
      <button class="btn-action btn-primary" onclick="document.getElementById('attach-input').click()">&#128206; Add Attachment</button>
      <input type="file" id="attach-input" style="display:none" accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt" onchange="uploadAttachment(this)">
    </div>
  </div>

  <!-- Meta strip -->
  <div class="meta-strip" id="meta-strip">
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

  <!-- Hidden IDs for JS compat -->
  <span id="m-ap" style="display:none"></span>
  <span id="m-desc" style="display:none"></span>
  <span id="m-amount" style="display:none"></span>

  <!-- Amount cards -->
  <div class="amount-cards">
    <div class="card-paid">
      <div class="card-label">Amount Paid</div>
      <div class="card-amount-paid" id="b-amount-paid">—</div>
    </div>
    <div class="card-due">
      <div class="card-label">Amount Due</div>
      <div class="card-amount-due">
        <span class="card-currency" id="b-currency-prefix"></span><span id="b-amount-due">—</span>
      </div>
    </div>
  </div>

  <!-- Bill Line Items -->
  <div class="section-h">Bill Line Items</div>
  <table class="data-table">
    <thead>
      <tr>
        <th>Description</th>
        <th style="text-align:right;min-width:90px">Amount</th>
        <th style="min-width:80px">${taxLabel}</th>
        <th style="min-width:60px">Currency</th>
      </tr>
    </thead>
    <tbody id="lines-tbody">
      <tr><td colspan="4" style="color:#888;padding:12px">Loading…</td></tr>
    </tbody>
  </table>

  <!-- Journal Entries -->
  <div class="section-h">Journal Entries</div>
  <table class="data-table">
    <thead>
      <tr>
        <th style="white-space:nowrap;width:90px">Date</th>
        <th style="min-width:110px">Reference</th>
        <th style="min-width:70px">Account</th>
        <th>Account Name</th>
        <th style="text-align:right;min-width:80px">DR</th>
        <th style="text-align:right;min-width:80px">CR</th>
      </tr>
    </thead>
    <tbody id="journals-tbody">
      <tr><td colspan="6" style="color:#888;padding:12px">Loading…</td></tr>
    </tbody>
  </table>

  <!-- Attachments -->
  <div class="section-h">Attachments</div>
  <div id="attachments-list">
    <span style="color:#aaa;font-size:9pt">Loading…</span>
  </div>

  <!-- Edit section -->
  <div class="edit-section" id="edit-section">
    <div style="font-size:10pt;font-weight:600;color:#333;margin-bottom:12px">Edit Non-Financial Fields</div>
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
      <button onclick="saveEdits()" style="padding:8px 20px;background:#1a1a1a;color:#fff;border:none;border-radius:4px;font-size:10pt;cursor:pointer">Save Changes</button>
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
      document.getElementById('b-vendor').textContent = 'Bill not found';
      return;
    }
    billData = bill;
    renderBill(bill);
    loadLines();
    loadJournals();
    loadAttachments();
  })
  .catch(function(e){
    document.getElementById('b-vendor').textContent = 'Error: ' + e.message;
  });
}

function renderBill(bill) {
  document.title = 'Bill — ' + (bill.vendor || BILL_ID) + ' — freeBooks';
  document.getElementById('b-vendor').textContent = bill.vendor || '—';
  document.getElementById('b-ref').textContent = bill.vendor_ref || '—';
  document.getElementById('b-date').textContent = bill.date ? String(bill.date).slice(0,10) : '—';
  document.getElementById('b-due').textContent = bill.due_date ? String(bill.due_date).slice(0,10) : '—';
  document.getElementById('b-currency').textContent = bill.currency || '—';
  document.getElementById('b-status').innerHTML = statusBadge(bill.status, bill.due_date);
  document.getElementById('b-currency-prefix').textContent = bill.currency || '';

  var paid = Number(bill.amount_paid || 0);
  var due = Number(bill.amount || 0) - paid;
  document.getElementById('b-amount-paid').textContent = paid.toFixed(2);
  document.getElementById('b-amount-due').textContent = due.toFixed(2);

  // Pre-fill edit fields
  document.getElementById('edit-ref').value = bill.vendor_ref || '';
  document.getElementById('edit-due').value = bill.due_date ? String(bill.due_date).slice(0,10) : '';

  // Void button visibility
  var voidBtn = document.getElementById('btn-void');
  if (voidBtn) voidBtn.style.display = (bill.status === 'posted') ? '' : 'none';
}

function loadLines() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'bill.lines', companyId: COMPANY, billId: BILL_ID }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    var lines = res.data || res || [];
    if (!Array.isArray(lines) || !lines.length) {
      document.getElementById('lines-tbody').innerHTML = '<tr><td colspan="4" style="color:#888;padding:10px">No line items.</td></tr>';
      return;
    }
    var html = '';
    lines.forEach(function(l){
      html += '<tr>'
        + '<td><input type="text" value="' + escAttr(l.description||'') + '" '
        + 'style="width:100%;border:none;background:transparent;font-size:10pt;padding:2px 4px;border-radius:3px" '
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
        document.getElementById('journals-tbody').innerHTML = '<tr><td colspan="6" style="color:#888;padding:10px">No journal entries.</td></tr>';
        return;
      }
      var batches = {};
      entries.forEach(function(e){
        var bId = e.batch_id || 'default';
        if (!batches[bId]) batches[bId] = { date: e.date, reference: e.reference, lines: [] };
        batches[bId].lines.push(e);
      });
      var html = '';
      Object.keys(batches).forEach(function(bId){
        var batch = batches[bId];
        var dateStr = batch.date ? String(batch.date).slice(0,10) : '';
        batch.lines.forEach(function(line, idx){
          var dr = parseFloat(line.debit_home || line.debit || 0).toFixed(2);
          var cr = parseFloat(line.credit_home || line.credit || 0).toFixed(2);
          var acctName = line.account_name || acctMap[line.account_code] || '';
          var trClass = idx === 0 ? ' class="batch-first"' : '';
          html += '<tr' + trClass + '>'
            + '<td style="white-space:nowrap">' + (idx === 0 ? dateStr : '') + '</td>'
            + '<td class="ref-blue">' + (idx === 0 ? esc(batch.reference || bId) : '') + '</td>'
            + '<td>' + esc(line.account_code || '') + '</td>'
            + '<td style="color:#555;font-size:9.5pt">' + esc(acctName) + '</td>'
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

function loadAttachments() {
  var el = document.getElementById('attachments-list');
  el.innerHTML = '<span style="color:#aaa;font-size:9pt">Loading\u2026</span>';
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'attachment.list', companyId: COMPANY, entityType:'bill', entityId: BILL_ID }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    var items = res.data || res || [];
    if (!Array.isArray(items) || !items.length) {
      el.innerHTML = '<span style="color:#aaa;font-size:9pt">No attachments yet.</span>';
      return;
    }
    el.innerHTML = items.map(function(a){
      var kb = (a.file_size / 1024).toFixed(1);
      var date = a.created_at ? new Date(a.created_at).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) : '';
      return '<div class="attach-row">'
        + '<div style="display:flex;align-items:center">'
        + '<span class="attach-icon">&#128196;</span>'
        + '<div class="attach-info">'
        + '<div class="attach-filename">' + esc(a.filename) + '</div>'
        + '<div class="attach-meta">Uploaded on ' + date + ' \u2022 ' + kb + ' KB</div>'
        + '</div></div>'
        + '<div class="attach-actions">'
        + '<a href="/api/attachments/' + esc(a.attachment_id) + '" target="_blank" class="btn-dl">Download</a>'
        + '<button onclick="deleteAttachment(&apos;' + esc(a.attachment_id) + '&apos;)" class="btn-del">Delete</button>'
        + '</div></div>';
    }).join('');
  })
  .catch(function(){ el.innerHTML = '<span style="color:#cc2222">Error loading attachments.</span>'; });
}

function uploadAttachment(input) {
  if (!input.files || !input.files[0]) return;
  var file = input.files[0];
  input.value = '';
  var el = document.getElementById('attachments-list');
  var prev = el.innerHTML;
  el.innerHTML = '<span style="color:#888">Uploading ' + esc(file.name) + '\u2026</span>';
  var fd = new FormData();
  fd.append('companyId', COMPANY);
  fd.append('entityType', 'bill');
  fd.append('entityId', BILL_ID);
  fd.append('file', file);
  fetch('/api/upload', { method:'POST', body: fd })
  .then(function(r){ return r.json(); })
  .then(function(res){
    if (res.error || !res.ok) { el.innerHTML = prev; alert('Upload failed: ' + (res.error || 'unknown error')); return; }
    loadAttachments();
  })
  .catch(function(e){ el.innerHTML = prev; alert('Upload failed: ' + e.message); });
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
  if (open) {
    sec.style.display = 'none';
    btn.innerHTML = '&#9998; Edit';
  } else {
    sec.style.display = '';
    btn.innerHTML = '&#10005; Cancel Edit';
  }
}

function saveEdits() {
  if (!billData) return;
  var vendor_ref = document.getElementById('edit-ref').value.trim();
  var due_date = document.getElementById('edit-due').value;
  var statusEl = document.getElementById('edit-status');
  statusEl.textContent = 'Saving\u2026';
  statusEl.style.color = '#555';
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'bill.update', companyId: COMPANY, billId: BILL_ID,
      vendor_ref: vendor_ref, due_date: due_date || undefined, description: billData.description || '' }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    if (res.error) {
      statusEl.textContent = '\u2717 ' + res.error;
      statusEl.style.color = '#cc2222';
    } else {
      billData.vendor_ref = vendor_ref;
      billData.due_date = due_date;
      document.getElementById('b-ref').textContent = vendor_ref || '—';
      document.getElementById('b-due').textContent = due_date || '—';
      statusEl.textContent = '\u2713 Saved';
      statusEl.style.color = '#2a8a2a';
    }
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
</body>
</html>`;
}

module.exports = { handleBillDetailPage };
