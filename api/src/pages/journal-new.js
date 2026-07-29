'use strict';
const { commonStyle, navBar, layoutEnd, getRelevanceFlags } = require('./common');

async function handleJournalNewPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Relevance flags (settings-ux-spec §7 item 9): vatRegistered=false drops the
  // Tax Code column + the vat-codes fetch — journal lines carry no tax tags.
  const flags = await getRelevanceFlags(company);
  res.send(buildJournalNewPage(company, flags));
}


function buildJournalNewPage(company, flags) {
  const vatOn = !flags || flags.vatRegistered !== false;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>New JV — freeBooks</title>
${commonStyle()}
<style>
  table.jv-table { width:100%; border-collapse:collapse; font-size:10pt; }
  table.jv-table th { text-align:left; font-size:9pt; text-transform:uppercase; color:#555; border-bottom:1px solid #ccc; padding:6px 6px; }
  table.jv-table td { padding:3px 4px; border-bottom:1px solid #f0f0f0; vertical-align:middle; }
  table.jv-table input[type=text], table.jv-table input[type=number], table.jv-table select { padding:4px 6px; border:1px solid #ddd; border-radius:3px; font-size:10pt; }
  .header-fields { display:flex; gap:16px; align-items:flex-end; margin-bottom:20px; flex-wrap:wrap; }
  .header-fields label { display:flex; flex-direction:column; gap:3px; font-weight:600; font-size:10pt; color:#555; }
  .header-fields input { padding:7px 10px; border:1px solid #ccc; border-radius:4px; font-size:10pt; }
  .totals { display:flex; gap:24px; margin-top:12px; font-size:10pt; align-items:center; }
  .totals span { font-weight:600; }
  button.btn-primary:disabled { opacity:0.4; cursor:default; }
  .btn-sm.danger { border-color:#cc2222; color:#cc2222; }
  .btn-sm { padding:0 14px; height:32px; font-size:10pt; cursor:pointer; border:1px solid #ccc; border-radius:3px; background:#f5f5f5; }
  .btn-sm:hover { background:#e8e8e8; }
  button.btn-primary { padding:10px 24px; background:#1a1a1a; color:#fff; border:none; border-radius:4px; font-size:11pt; font-weight:600; cursor:pointer; }
  button.btn-primary:hover:not(:disabled) { background:#333; }
  /* K4: shared attachment-queue rows (fb-attachments.js classes) */
  .fb-attach-row { display:flex; justify-content:space-between; align-items:center; padding:3px 6px; border-bottom:1px solid #f5f5f5; border-radius:3px; }
  .fb-attach-row .fb-att-meta { color:#888; font-size:8.5pt; }
  .fb-attach-row .fb-att-del { border:none; background:none; cursor:pointer; color:#cc4444; font-size:11pt; padding:0 4px; }
  .fb-attach-row.fb-form-row-focus { background:#1a1a1a !important; color:#fff; }
  .fb-attach-row.fb-form-row-focus .fb-att-meta { color:rgba(255,255,255,.6); }
  .fb-attach-row.fb-form-row-focus .fb-att-del { color:#ff8888; }
</style>
</head>
<body>${navBar(company, 'newjv')}
<div class="page">
  <div class="header" style="display:flex;justify-content:space-between;align-items:flex-start">
    <div>
      <h1 id="jv-mode-title">New JV</h1>
      <p class="sub">${company}</p>
    </div>
    <button class="btn-sm" id="btn-reversal-mode" onclick="toggleReversalMode()" style="margin-top:8px">⟲ Reversal</button>
  </div>

  <!-- Reversal search panel (hidden by default) -->
  <div id="reversal-panel" style="display:none;margin-bottom:16px;padding:14px;background:#f8f4ff;border:1px solid #c9b8e8;border-radius:6px">
    <div style="font-weight:600;margin-bottom:8px;color:#5a3ea0">Find entry to reverse</div>
    <input type="text" id="reversal-search" placeholder="Search by reference or description…"
      oninput="onReversalSearch(this.value)"
      style="width:400px;padding:7px 10px;border:1px solid #c9b8e8;border-radius:4px;font-size:10pt">
    <div id="reversal-results" style="margin-top:6px;max-height:200px;overflow-y:auto;background:#fff;border:1px solid #ddd;border-radius:4px;display:none"></div>
  </div>

  <div class="header-fields">
    <label>Date <input type="date" id="entry-date"></label>
    <label>Journal <select id="entry-journal" style="width:180px;height:32px;padding:4px 6px"><option value="">— loading —</option></select></label>
    <label>Description <input type="text" id="entry-desc" placeholder="e.g. Salary payment" style="width:240px"></label>
  </div>

  <table class="jv-table">
    <thead>
      <tr>
        <th>Code</th><th>Account Name</th><th class="num">Debit</th><th class="num">Credit</th>
        <th>Line Description</th>${vatOn ? '<th>Tax Code</th>' : ''}<th></th>
      </tr>
    </thead>
    <tbody id="lines-body"></tbody>
  </table>

  <div class="totals">
    <div>Debits: <span id="total-dr">0.00</span></div>
    <div>Credits: <span id="total-cr">0.00</span></div>
    <div>Diff: <span id="total-diff" style="color:#cc2222">0.00</span></div>
  </div>

  <div style="margin-top:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
    <button class="btn-sm" onclick="addLine()">+ Add Line</button>
    <button class="btn-primary" id="btn-post" onclick="postEntry()">Post Entry</button>
    <span id="status-msg" style="font-size:10pt"></span>
  </div>

  <div id="jv-pre-attach-section" style="margin-top:14px;padding:12px;border:1px solid #e8e8e8;border-radius:4px;background:#fafafa">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <span style="font-size:10pt;font-weight:600">📎 Attachments</span>
      <label style="cursor:pointer;padding:4px 12px;border:1px solid #ccc;border-radius:3px;background:#fff;font-size:9.5pt">
        + Attach
        <input type="file" id="jv-pre-attach-input" style="display:none" accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt" onchange="addJvAttachment(this)" multiple>
      </label>
    </div>
    <div id="jv-pending-list" style="font-size:9.5pt;color:#aaa">No files queued</div>
  </div>

  <div id="jv-attachment-panel" style="display:none;margin-top:14px;padding:12px;border:1px solid #e0e0e0;border-radius:4px;background:#fafafa">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <span style="font-size:10pt;font-weight:600">📎 Attachments for this entry</span>
      <label style="cursor:pointer;padding:4px 12px;border:1px solid #ccc;border-radius:3px;background:#fff;font-size:9.5pt">
        + Attach
        <input type="file" id="jv-attach-input" style="display:none" accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt" onchange="uploadJvAttachment(this)">
      </label>
    </div>
    <div id="jv-attachments-list" style="font-size:9.5pt">
      <span style="color:#aaa;font-size:9pt">No attachments yet</span>
    </div>
  </div>
</div>
<script>
  var COMPANY = '${company}';
  var VAT_ON = ${vatOn ? 'true' : 'false'};
  var accountsMap = {};
  var vatCodes = [];
  var currentBatchId = null;
  var pendingJvAttachments = [];

  fetch('/api/' + COMPANY + '/accounts')
    .then(r => r.json())
    .then(rows => { rows.forEach(a => { accountsMap[a.account_code] = a.account_name; }); });

  if (VAT_ON)
  fetch('/api/' + COMPANY + '/vat-codes')
    .then(r => r.json())
    .then(rows => {
      if (!Array.isArray(rows)) return;
      vatCodes = rows.filter(v => v.is_active !== false);
      document.querySelectorAll('.tax-select').forEach(sel => populateTaxSelect(sel));
    });

  // Load journals into dropdown
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'journals.list', companyId: COMPANY }) })
    .then(r => r.json())
    .then(res => {
      var journals = res.data || res;
      var sel = document.getElementById('entry-journal');
      if (!Array.isArray(journals) || journals.length === 0) {
        sel.innerHTML = '<option value="">— no journals —</option>';
        return;
      }
      sel.innerHTML = '<option value="">— select journal —</option>'
        + journals.map(j => '<option value="'+j.journal_id+'">'+j.code+' — '+j.name+'</option>').join('');
      // Default to MISC if available
      var miscOpt = Array.from(sel.options).find(o => o.text.startsWith('MISC'));
      if (miscOpt) sel.value = miscOpt.value;
    })
    .catch(() => {
      document.getElementById('entry-journal').innerHTML = '<option value="">— unavailable —</option>';
    });

  function populateTaxSelect(sel) {
    var current = sel.value;
    sel.innerHTML = '<option value="">\u2014 none \u2014</option>'
      + vatCodes.map(v => '<option value="'+v.vat_code+'"'+(v.vat_code===current?' selected':'')+'>'+v.vat_code+' \u2014 '+v.description+'</option>').join('');
  }

  // ── Account autocomplete (FB.dropdown) ────────────────────────────────────
  function getAccountList() {
    return Object.keys(accountsMap).map(code => ({ code, name: accountsMap[code] }));
  }

  function pickAccount(acct, input) {
    var tr = input.closest('tr');
    var codeInput = tr.querySelector('.acct-input');
    var nameInput = tr.querySelector('.acct-name-input');
    codeInput.value = acct.code;
    nameInput.value = acct.name;
    codeInput.style.color = '';
    nameInput.style.color = '#555';
  }

  function attachAcctDd(input) {
    if (!window.FB || !FB.dropdown) return;
    FB.dropdown.attach(input, {
      // No keys:true — this is an FB.keys page (FB.form, K3); dropdown keys
      // route through the form's INSERT bindings (fb-list parity).
      minWidth: 280,
      source: function (q) {
        q = (q || '').toLowerCase();
        return getAccountList().filter(function (a) {
          return a.code.toLowerCase().indexOf(q) >= 0 || a.name.toLowerCase().indexOf(q) >= 0;
        }).map(function (a) { return { primary: a.code, secondary: a.name, data: a }; });
      },
      onPick: function (it, inp) { pickAccount(it.data, inp); }
    });
  }
  // ──────────────────────────────────────────────────────────────────────────

  function addLine() {
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td><input type="text" class="acct-input" style="width:90px" placeholder="101414"></td>'
      +'<td><input type="text" class="acct-name-input" style="width:160px;color:#555;border:1px solid #ddd;border-radius:3px;padding:3px 6px;font-size:10pt" placeholder="search by name"></td>'
      +'<td><input type="number" class="debit-input" min="0" step="0.01" oninput="updateTotals()" style="width:100px"></td>'
      +'<td><input type="number" class="credit-input" min="0" step="0.01" oninput="updateTotals()" style="width:100px"></td>'
      +'<td><input type="text" class="desc-input" style="width:160px" placeholder="optional"></td>'
      +(VAT_ON ? '<td><select class="tax-select" style="width:120px"><option value="">\\u2014 none \\u2014</option></select></td>' : '')
      +'<td><button class="btn-sm danger" onclick="this.parentElement.parentElement.remove(); updateTotals()">&times;</button></td>';
    document.getElementById('lines-body').appendChild(tr);
    if (VAT_ON) populateTaxSelect(tr.querySelector('.tax-select'));
    var codeIn = tr.querySelector('.acct-input');
    attachAcctDd(codeIn);
    attachAcctDd(tr.querySelector('.acct-name-input'));
    // Exact code typed → sync the name field (preserved from onCodeInput)
    codeIn.addEventListener('input', function () {
      var nameInput = tr.querySelector('.acct-name-input');
      if (accountsMap[codeIn.value.trim()]) {
        nameInput.value = accountsMap[codeIn.value.trim()];
        nameInput.style.color = '#555';
      } else {
        nameInput.value = '';
      }
    });
    return tr;
  }

  function updateTotals() {
    var dr = 0, cr = 0;
    document.querySelectorAll('#lines-body tr').forEach(tr => {
      dr += parseFloat(tr.querySelector('.debit-input').value || 0);
      cr += parseFloat(tr.querySelector('.credit-input').value || 0);
    });
    document.getElementById('total-dr').textContent = dr.toFixed(2);
    document.getElementById('total-cr').textContent = cr.toFixed(2);
    var diff = Math.round((dr - cr) * 100) / 100;
    var diffEl = document.getElementById('total-diff');
    diffEl.textContent = diff.toFixed(2);
    diffEl.style.color = diff === 0 ? '#2a8a2a' : '#cc2222';
    document.getElementById('btn-post').disabled = diff !== 0;
  }

  function loadJvAttachments() {
    if (!currentBatchId) return;
    var listEl = document.getElementById('jv-attachments-list');
    if (!listEl) return;
    fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'attachment.list', companyId: COMPANY, entityType: 'journal', entityId: currentBatchId }) })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        var items = res.data || res || [];
        if (!Array.isArray(items) || !items.length) {
          listEl.innerHTML = '<span style="color:#aaa;font-size:9pt">No attachments yet</span>';
          return;
        }
        listEl.innerHTML = items.map(function(a) {
          var kb = (a.file_size / 1024).toFixed(1);
          return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #eee">'
            + '<a href="/api/attachments/' + a.attachment_id + '" target="_blank" style="color:#1a1a1a;text-decoration:none;font-size:9.5pt">'
            + '\ud83d\udcc4 ' + a.filename + ' <span style="color:#888;font-size:8.5pt">(' + kb + ' KB)</span></a>'
            + '<button onclick="deleteJvAttachment(\\'' + a.attachment_id + '\\')" '
            + 'style="border:none;background:none;cursor:pointer;color:#cc4444;font-size:11pt;padding:0 4px">&times;</button>'
            + '</div>';
        }).join('');
      }).catch(function(){});
  }

  function uploadJvAttachment(input) {
    if (!input.files || !input.files[0] || !currentBatchId) return;
    var file = input.files[0];
    input.value = '';
    var listEl = document.getElementById('jv-attachments-list');
    listEl.innerHTML = '<span style="color:#888">Uploading ' + file.name + '\u2026</span>';
    var fd = new FormData();
    fd.append('companyId', COMPANY);
    fd.append('entityType', 'journal');
    fd.append('entityId', currentBatchId);
    fd.append('file', file);
    fetch('/api/upload', { method: 'POST', body: fd })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        if (res.error || !res.ok) { alert('Upload failed: ' + (res.error || 'unknown')); loadJvAttachments(); return; }
        loadJvAttachments();
      })
      .catch(function(e) { alert('Upload failed: ' + e.message); loadJvAttachments(); });
  }

  function deleteJvAttachment(attachmentId) {
    if (!confirm('Remove attachment?')) return;
    fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'attachment.delete', companyId: COMPANY, attachmentId: attachmentId }) })
      .then(function(r) { return r.json(); })
      .then(function() { loadJvAttachments(); })
      .catch(function(){});
  }

  function postEntry() {
    var date      = document.getElementById('entry-date').value;
    var journalId = document.getElementById('entry-journal').value;
    var desc      = document.getElementById('entry-desc').value.trim();
    if (!date) { showStatus('Date is required', true); return; }
    if (!journalId) { showStatus('Select a journal', true); return; }

    var lines = Array.from(document.querySelectorAll('#lines-body tr')).map(tr => ({
      date,
      account_code:  tr.querySelector('.acct-input').value.trim(),
      debit:         parseFloat(tr.querySelector('.debit-input').value  || 0),
      credit:        parseFloat(tr.querySelector('.credit-input').value || 0),
      description:   tr.querySelector('.desc-input').value.trim() || desc || null,
      vat_code:      (function(){ var s = tr.querySelector('.tax-select'); return s ? (s.value || null) : null; })(),
    })).filter(l => l.account_code && (l.debit > 0 || l.credit > 0));
    // Validate codes
    var badCodes = lines.filter(l => !accountsMap[l.account_code]).map(l => l.account_code);
    if (badCodes.length) { showStatus('Unknown account(s): ' + badCodes.join(', '), true); return; }

    if (lines.length < 2) { showStatus('At least 2 lines required', true); return; }

    document.getElementById('btn-post').disabled = true;
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'journal.post', companyId: COMPANY, journalId, lines }) })
      .then(r => r.json())
      .then(res => {
        var d = res.data || res;
        if (res.error || d.errors) {
          showStatus((d.errors || [res.error]).join('; '), true);
          document.getElementById('btn-post').disabled = false;
        } else {
          showStatus('Posted \u2713  ' + (d.reference || d.batchId), false);
          currentBatchId = d.batchId;
          pendingJvAttachments = [];
          renderJvPendingList();
          document.getElementById('jv-attachment-panel').style.display = '';
          document.getElementById('jv-attachments-list').innerHTML = '<span style="color:#aaa;font-size:9pt">No attachments yet</span>';
          uploadPendingJvAttachments(d.batchId).then(function() { if (currentBatchId) loadJvAttachments(); });
          setTimeout(() => {
            document.getElementById('lines-body').innerHTML = '';
            document.getElementById('entry-desc').value = '';
            addLine(); addLine();
            updateTotals();
            document.getElementById('status-msg').textContent = '';
          }, 2000);
        }
      })
      .catch(e => { showStatus(e.message, true); document.getElementById('btn-post').disabled = false; });
  }

  function showStatus(msg, isErr) {
    var el = document.getElementById('status-msg');
    el.textContent = msg;
    el.style.color = isErr ? '#cc2222' : '#2a8a2a';
  }

  document.getElementById('entry-date').value = new Date().toISOString().slice(0, 10);
  addLine(); addLine();
  updateTotals();

  // ── Reversal mode ──────────────────────────────────────────────────
  var reversalMode = false;
  var reversalSearchTimer = null;

  // K3: keyboard navigation for reversal results — ArrowUp/Down inside the
  // search input move the highlight (sticky), Enter picks (FB.dropdown
  // contract feel), Esc peels back to NORMAL via the form's general binding.
  var reversalRows = [];
  var revIdx = -1;
  function paintReversal() {
    reversalRows.forEach(function (d, i) { d.style.background = (i === revIdx) ? '#f0f4ff' : ''; });
    if (reversalRows[revIdx] && reversalRows[revIdx].scrollIntoView) reversalRows[revIdx].scrollIntoView({ block: 'nearest' });
  }
  function moveReversal(d) {
    if (!reversalRows.length) return;
    revIdx += d;
    if (revIdx < 0) revIdx = 0;
    if (revIdx > reversalRows.length - 1) revIdx = reversalRows.length - 1;
    paintReversal();
  }
  function pickReversal() {
    if (revIdx >= 0 && reversalRows[revIdx]) reversalRows[revIdx].click();
  }

  function toggleReversalMode() {
    reversalMode = !reversalMode;
    document.getElementById('reversal-panel').style.display = reversalMode ? '' : 'none';
    document.getElementById('jv-mode-title').textContent = reversalMode ? 'Reversal Entry' : 'New JV';
    document.getElementById('btn-reversal-mode').textContent = reversalMode ? '\u2715 Cancel Reversal' : '\u27f2 Reversal';
    document.getElementById('btn-reversal-mode').style.background = reversalMode ? '#f0e8ff' : '';
    if (!reversalMode) {
      document.getElementById('reversal-search').value = '';
      document.getElementById('reversal-results').style.display = 'none';
      document.getElementById('entry-desc').value = '';
      document.getElementById('lines-body').innerHTML = '';
      addLine(); addLine();
      updateTotals();
    }
  }

  function onReversalSearch(q) {
    clearTimeout(reversalSearchTimer);
    var res = document.getElementById('reversal-results');
    // Min query length 1 (magnus 2026-07-28 — single chars silently showed
    // nothing at min-2; an empty box hides results instead).
    if (q.trim().length < 1) { res.style.display = 'none'; reversalRows = []; revIdx = -1; return; }
    reversalSearchTimer = setTimeout(function() {
      fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action:'journal.search', companyId: COMPANY, q: q.trim() }) })
        .then(r => r.json())
        .then(function(resp) {
          var rows = resp.data || resp;
          res.innerHTML = '';
          if (!Array.isArray(rows) || !rows.length) {
            res.innerHTML = '<div style="padding:8px 12px;color:#888;font-size:10pt">No matching entries</div>';
            res.style.display = '';
            reversalRows = []; revIdx = -1;
            return;
          }
          rows.forEach(function(r) {
            var d = document.createElement('div');
            d.style.cssText = 'padding:8px 12px;cursor:pointer;border-bottom:1px solid #f0f0f0;font-size:10pt';
            var ref = r.reference || r.batch_id;
            var date = r.date ? String(r.date).slice(0,10) : '';
            d.innerHTML = '<span style="font-weight:600">' + ref + '</span>'
              + '<span style="color:#888;margin-left:10px">' + date + '</span>'
              + (r.description ? '<span style="color:#555;margin-left:10px">' + r.description + '</span>' : '');
            d.onmouseenter = function() { d.style.background='#f0f4ff'; };
            d.onmouseleave = function() { d.style.background=''; };
            d.onclick = function() { loadReversalEntry(r.batch_id, ref); };
            res.appendChild(d);
          });
          res.style.display = '';
          reversalRows = Array.from(res.children);
          revIdx = 0;
          paintReversal();
        });
    }, 300);
  }

  function loadReversalEntry(batchId, ref) {
    document.getElementById('reversal-results').style.display = 'none';
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'journal.get', companyId: COMPANY, batchId: batchId }) })
      .then(r => r.json())
      .then(function(resp) {
        var lines = resp.data || resp;
        if (!Array.isArray(lines) || !lines.length) { showStatus('Entry not found', true); return; }
        // Set date to today
        var today = new Date();
        var todayStr = today.getFullYear() + '-'
          + String(today.getMonth()+1).padStart(2,'0') + '-'
          + String(today.getDate()).padStart(2,'0');
        var dateEl = document.getElementById('entry-date');
        dateEl.value = '';
        dateEl.value = todayStr;
        dateEl.dispatchEvent(new Event('input'));
        dateEl.dispatchEvent(new Event('change'));
        // Set description
        document.getElementById('entry-desc').value = 'Reversal: ' + ref;
        // Match journal by reference prefix
        var code = ref && ref.includes('/') ? ref.split('/')[0] : '';
        if (code) {
          var jSel = document.getElementById('entry-journal');
          var opt = Array.from(jSel.options).find(o => o.text.startsWith(code + ' '));
          if (opt) jSel.value = opt.value;
        }
        // Clear existing lines and populate reversed
        document.getElementById('lines-body').innerHTML = '';
        lines.forEach(function(l) {
          var tr = addLine();
          var codeIn  = tr.querySelector('.acct-input');
          var nameIn  = tr.querySelector('.acct-name-input');
          var debitIn = tr.querySelector('.debit-input');
          var creditIn = tr.querySelector('.credit-input');
          codeIn.value  = l.account_code || '';
          nameIn.value  = accountsMap[l.account_code] || '';
          // Swap debit ↔ credit
          debitIn.value  = parseFloat(l.credit || 0) || '';
          creditIn.value = parseFloat(l.debit  || 0) || '';
          var descIn = tr.querySelector('.desc-input');
          descIn.value = l.description || '';
        });
        updateTotals();
        showStatus('Reversal loaded — review and post', false);
      })
      .catch(function(e) { showStatus(e.message, true); });
  }

  function addJvAttachment(input) {
    if (!input.files || !input.files.length) return;
    for (var i = 0; i < input.files.length; i++) pendingJvAttachments.push(input.files[i]);
    input.value = '';
    renderJvPendingList();
  }

  function removeJvAttachment(idx) {
    pendingJvAttachments.splice(idx, 1);
    renderJvPendingList();
  }

  function renderJvPendingList() {
    var el = document.getElementById('jv-pending-list');
    if (!el) return;
    if (!pendingJvAttachments.length) { el.innerHTML = '<span style="color:#aaa">No files queued</span>'; return; }
    // K4: shared .fb-attach-row classes (fb-attachments.js) — the queue is a
    // FB.form zone, so j/k paint the cursor row and x deletes (data-att-id =
    // staged index, read by the delete verb).
    el.innerHTML = pendingJvAttachments.map(function(f, i) {
      var kb = (f.size / 1024).toFixed(1);
      return '<div class="fb-attach-row" data-att-id="' + i + '">'
        + '<span class="fb-att-name">\ud83d\udcc4 ' + f.name + ' <span class="fb-att-meta">(' + kb + ' KB)</span></span>'
        + '<button class="fb-att-del" onclick="removeJvAttachment(' + i + ')" title="delete (x)">&times;</button>'
        + '</div>';
    }).join('');
  }

  async function uploadPendingJvAttachments(batchId) {
    if (!pendingJvAttachments.length) return;
    for (var i = 0; i < pendingJvAttachments.length; i++) {
      var fd = new FormData();
      fd.append('companyId', COMPANY);
      fd.append('entityType', 'journal');
      fd.append('entityId', batchId);
      fd.append('file', pendingJvAttachments[i]);
      try { await fetch('/api/upload', { method: 'POST', body: fd }); } catch(e) {}
    }
    pendingJvAttachments = [];
  }

  // ── FB.form (K3, keyboard-ux-spec §8) — the one form machine; this page ──
  // declares config + verbs only. Zones: reversal panel (present only in
  // reversal mode) → header fields → the JV line grid.
  var jvForm = FB.form.create({
    formId: 'journal-new',
    zones: [
      { id: 'reversal', rows: function () { return reversalMode ? [document.getElementById('reversal-panel')] : []; } },
      { id: 'header',   rows: function () { return [document.querySelector('.header-fields')]; } },
      // K4: the pending-attachment queue is a form zone (read-only rows, no
      // cells) — j/k reach it, x removes the cursor row via the delete verb.
      { id: 'attachments', rows: function () { return Array.from(document.querySelectorAll('#jv-pending-list .fb-attach-row')); },
        cells: function () { return []; } },
      { id: 'lines',    rows: function () { return Array.from(document.querySelectorAll('#lines-body tr')); } }
    ],
    verbs: {
      add: { key: 'a', hint: 'add line', run: function (api) {
        addLine(); updateTotals();
        api.moveTo(3, api.zoneRows(3).length - 1, 0, true);
      } },
      delete: { key: 'x', hint: 'delete',
        when: function (api) { var z = api.cur().z; return z === 2 || z === 3; },
        run: function (api) {
          if (api.cur().z === 2) {
            // attachments zone — remove the staged file (K4)
            var row = api.zoneRows(2)[api.cur().r];
            if (!row) return;
            removeJvAttachment(parseInt(row.dataset.attId, 10));
            api.refresh();
            return;
          }
          var tr = api.zoneRows(3)[api.cur().r];
          if (!tr) return;
          tr.remove(); updateTotals(); api.refresh();
        } },
      write: { key: 'w', hint: 'post', run: function () {
        var btn = document.getElementById('btn-post');
        if (btn.disabled) { showStatus('Out of balance — see Diff', true); return; }
        postEntry();
      } },
      quit: { key: 'q', hint: 'quit', run: function () { fbNavigate('/' + COMPANY); } }
    },
    extraBindings: function (api) {
      function searchFocused() { return document.activeElement === document.getElementById('reversal-search'); }
      return [
        // K4: A = attach everywhere (keyboard-ux-spec §8) — opens the file
        // picker for the pending-attachment queue
        { key: 'A', mode: 'NORMAL', hint: 'attach', hintBar: true, run: function () {
            var inp = document.getElementById('jv-pre-attach-input');
            if (inp) inp.click();
          } },
        // R = reversal MODE (vim's R = replace mode — a mode key for a mode;
        // magnus 2026-07-28: ~ stays pure toggle-true/false, so reversal
        // moves off ~). Esc in the search cancels the whole reversal flow.
        { key: 'R', mode: 'NORMAL', hint: 'reversal', hintBar: true, run: function () {
            toggleReversalMode();
            api.refresh();
            if (reversalMode) { var s = document.getElementById('reversal-search'); if (s) s.focus(); }
          } },
        { key: 'ArrowDown', mode: 'INSERT', when: searchFocused, run: function () { moveReversal(1); } },
        { key: 'ArrowUp', mode: 'INSERT', when: searchFocused, run: function () { moveReversal(-1); } },
        // Enter inside the search always stays local (never advances the form)
        { key: 'Enter', mode: 'INSERT', when: searchFocused, run: pickReversal },
        // Esc from the search = cancel reversal outright, back to normal JV
        // edit (magnus 2026-07-28) — not merely an exit to NORMAL.
        { key: 'Escape', mode: 'INSERT', when: searchFocused, run: function () {
            toggleReversalMode();   // off — resets search/desc/lines
            api.exitEdit();         // blur + NORMAL (input is being hidden)
            api.refresh();          // reversal zone emptied → cursor to header
          } }
      ];
    }
  });
  FB.keys.renderHints('journal-new', document.getElementById('sb-hints'), { layout: 'list' });
<\/script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleJournalNewPage };
