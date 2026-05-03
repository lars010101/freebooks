'use strict';
const { commonStyle, makeQuery, navBar } = require('./common');

async function handleBankPage(req, res) {
  const { company } = req.params;
  const q = makeQuery();
  const accounts = await q(
    `SELECT account_code, account_name FROM accounts WHERE company_id = ? AND cf_category = 'Cash' ORDER BY account_code`,
    [company]
  );
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildBankPage(company, accounts));
}


function buildBankPage(company, cashAccounts) {
  const acctOptions = cashAccounts.map(a =>
    `<option value="${a.account_code}">${a.account_code} — ${a.account_name}</option>`
  ).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Bank — ${company}</title>
${commonStyle()}
<style>
  table.rec-table { width:100%; border-collapse:collapse; font-size:10pt; }
  table.rec-table th { background:#f0f0f0; padding:6px 8px; text-align:left; font-size:9pt; border:1px solid #ddd; }
  table.rec-table td { padding:5px 7px; border:1px solid #eee; vertical-align:middle; }
  table.rec-table tr.cleared td { color:#888; }
  table.rec-table tr.cleared td:first-child { text-decoration:line-through; }
  .summary-bar { display:flex; gap:24px; padding:12px 16px; background:#f8f8f8; border:1px solid #e0e0e0; border-radius:6px; margin-bottom:16px; font-size:10pt; }
  .summary-bar .lbl { color:#888; font-size:9pt; }
  .summary-bar .val { font-weight:700; font-size:12pt; }
  
  .step { background:#f8f8f8; border:1px solid #e0e0e0; border-radius:6px; padding:14px 18px; margin-bottom:16px; }
  .step h3 { margin:0 0 10px; font-size:11pt; color:#333; }
  table.review-table { width:100%; border-collapse:collapse; font-size:9.5pt; }
  table.review-table th { background:#f0f0f0; padding:5px 7px; text-align:left; font-size:9pt; border:1px solid #ddd; }
  table.review-table td { padding:4px 6px; border:1px solid #eee; vertical-align:middle; }
  table.review-table tr.matched td:first-child { border-left:3px solid #2a8a2a; }
  table.review-table tr.unmatched td:first-child { border-left:3px solid #cc8800; }
  table.review-table tr.skipped td { opacity:.5; }
  .tag { display:inline-block; padding:1px 7px; border-radius:10px; font-size:8.5pt; font-weight:600; }
  .tag.hi  { background:#d4edda; color:#155724; }
  .tag.med { background:#fff3cd; color:#856404; }
  .tag.lo  { background:#f8d7da; color:#721c24; }
  input.acct { width:75px; padding:3px 5px; border:1px solid #ccc; border-radius:3px; font-size:9.5pt; }
  select.col-map { padding:3px 5px; border:1px solid #ccc; border-radius:3px; font-size:9.5pt; }
  
  details { margin-top:28px; }
  details summary { cursor:pointer; font-weight:600; font-size:11pt; padding:10px 0; }
  details[open] summary { margin-bottom:14px; }
</style>
</head>
<body>
<div class="page">
  ${navBar(company, 'bank')}
  
  <div class="header">
    <h1>🏦 Bank</h1>
    <p class="sub">${company}</p>
  </div>

  <!-- Reconciliation section (primary) -->
  <div style="display:flex;gap:12px;align-items:center;margin-bottom:16px;flex-wrap:wrap">
    <label>Account <select id="rec-account" style="width:220px;height:32px;padding:4px 6px">
      ${acctOptions || '<option>No cash accounts found</option>'}
    </select></label>
    <label>From <input type="date" id="rec-from"></label>
    <label>To <input type="date" id="rec-to"></label>
    <button class="btn-primary" onclick="loadReconcile()">Load</button>
  </div>

  <div class="summary-bar" id="rec-summary" style="display:none">
    <div><div class="lbl">Opening Balance</div><div class="val" id="sum-opening">0.00</div></div>
    <div><div class="lbl">Period Net</div><div class="val" id="sum-net">0.00</div></div>
    <div><div class="lbl">Closing Book Balance</div><div class="val" id="sum-book">0.00</div></div>
    <div><div class="lbl">Uncleared Items</div><div class="val" id="sum-uncleared">0</div></div>
    <div><div class="lbl">Statement Closing Balance</div><input type="number" id="stmt-balance" step="0.01" placeholder="from bank statement" style="width:140px;padding:4px 8px;border:1px solid #ccc;border-radius:3px;font-size:10pt"></div>
    <div><div class="lbl">Difference</div><div class="val" id="sum-diff" style="color:#888">—</div></div>
  </div>

  <table class="rec-table" id="rec-table" style="display:none">
    <thead><tr><th style="width:90px">Date</th><th>Reference</th><th>Description</th><th class="num" style="width:100px">Debit</th><th class="num" style="width:100px">Credit</th><th style="text-align:center;width:70px">Cleared</th></tr></thead>
    <tbody id="rec-body"></tbody>
  </table>
  <div id="rec-status" style="margin-top:10px;font-size:10pt"></div>

  <!-- Import section (collapsible) -->
  <details id="import-section" style="margin-top:28px">
    <summary style="cursor:pointer;font-weight:600;font-size:11pt;padding:10px 0">Import CSV ↑</summary>

    <!-- Step 1: Upload -->
    <div class="step" id="step1">
      <h3>① Load your bank statement CSV</h3>
      <p style="margin:0 0 10px;font-size:9.5pt;color:#555">Open the CSV in a text editor, select all (Ctrl+A), copy (Ctrl+C), then paste below. Or use the file picker.</p>
      <textarea id="csv-paste" rows="5" style="width:100%;font-family:monospace;font-size:9pt;padding:8px;border:1px solid #ccc;border-radius:4px;resize:vertical" placeholder="Paste CSV content here…"></textarea>
      <div style="display:flex;gap:10px;align-items:center;margin-top:8px">
        <button class="btn-primary" onclick="onPasteLoad()">Load Pasted CSV →</button>
        <span style="color:#888;font-size:9.5pt">or select file:</span>
        <input type="file" id="csv-file" accept=".csv,.txt" onchange="onFileLoad()">
      </div>
      <div id="file-status" style="margin-top:8px;font-size:10pt"></div>
    </div>

    <!-- Step 2: Map columns -->
    <div class="step" id="step2" style="display:none">
      <h3>② Map columns &amp; set bank account</h3>
      <p style="margin:0 0 10px;font-size:9.5pt;color:#555">Confirm which columns contain the date, description, and amounts. Then enter the bank account code this statement is for.</p>
      <table style="border-collapse:collapse;font-size:10pt">
        <tr><td style="padding:5px 14px 5px 0"><b>Date column</b></td><td><select id="col-date" class="col-map"></select></td></tr>
        <tr><td style="padding:5px 14px 5px 0"><b>Description column</b></td><td><select id="col-desc" class="col-map"></select></td></tr>
        <tr><td style="padding:5px 14px 5px 0"><b>Amount type</b></td><td>
          <select id="amt-type" class="col-map" onchange="toggleAmtCols()">
            <option value="single">Single amount column (positive=inflow, negative=outflow)</option>
            <option value="split">Separate Debit / Credit columns</option>
          </select>
        </td></tr>
        <tr id="row-single"><td style="padding:5px 14px 5px 0">&nbsp;&nbsp;Amount column</td><td><select id="col-amt" class="col-map"></select></td></tr>
        <tr id="row-debit" style="display:none"><td style="padding:5px 14px 5px 0">&nbsp;&nbsp;Debit column (outflow/payment)</td><td><select id="col-deb" class="col-map"></select></td></tr>
        <tr id="row-credit" style="display:none"><td style="padding:5px 14px 5px 0">&nbsp;&nbsp;Credit column (inflow/deposit)</td><td><select id="col-cred" class="col-map"></select></td></tr>
        <tr><td style="padding:5px 14px 5px 0"><b>Bank account code</b></td>
          <td><input type="text" id="bank-acct" class="acct" style="width:90px" placeholder="101414">
          <span style="font-size:9pt;color:#888;margin-left:8px">The asset account for this bank</span></td></tr>
      </table>
      <div style="margin-top:14px;display:flex;gap:12px;align-items:center">
        <button class="btn-primary" onclick="parseAndProcess()">Process rows →</button>
        <span id="parse-status" style="font-size:10pt"></span>
      </div>
    </div>

    <!-- Bill search panel -->
    <div id="bill-panel" style="display:none;position:fixed;top:20%;left:50%;transform:translateX(-50%);z-index:1000;background:#fff;border:1px solid #ccc;border-radius:6px;padding:16px;min-width:500px;max-width:700px;box-shadow:0 4px 20px rgba(0,0,0,0.2)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="font-weight:600;font-size:11pt">Link Bill <span id="bill-panel-row-label" style="font-size:9pt;color:#888"></span></div>
        <button onclick="closeBillPanel()" style="border:none;background:none;cursor:pointer;font-size:14pt;color:#888">&times;</button>
      </div>
      <input type="text" id="bill-panel-search" placeholder="Filter by vendor or ref…" oninput="renderBillPanelList()"
        style="width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid #ccc;border-radius:4px;font-size:10pt;margin-bottom:10px">
      <div id="bill-panel-list" style="max-height:320px;overflow-y:auto;border:1px solid #eee;border-radius:4px"></div>
    </div>

    <!-- Step 3: Review -->
    <div class="step" id="step-review" style="display:none">
      <h3>③ Review &amp; Approve</h3>
      <p style="margin:0 0 10px;font-size:9.5pt;color:#555">Green border = rule-matched. Orange = unmatched (fill in DR/CR accounts manually). Check <b>Skip</b> to exclude a row. Then click <b>Post to Journal</b>.</p>
      <div id="import-summary" style="margin-bottom:10px;font-size:10pt"></div>
      <div id="balance-bar" style="display:none;margin-bottom:12px;padding:10px 14px;background:#f0f4ff;border:1px solid #c0cfe8;border-radius:6px;font-size:10pt;display:flex;gap:28px;align-items:center">
        <span>Book balance before: <b id="bal-before">—</b></span>
        <span>→ net import: <b id="bal-net">—</b></span>
        <span>Book balance after: <b id="bal-after">—</b></span>
      </div>
      <table class="review-table">
        <thead><tr><th style="width:90px">Date</th><th>Description</th><th style="width:85px" class="num">Amount</th><th style="width:80px">Match</th><th style="width:80px">Bill</th><th style="width:80px">Debit</th><th style="width:80px">Credit</th><th style="text-align:center;width:50px">Skip</th></tr></thead>
        <tbody id="review-body"></tbody>
      </table>
      <div style="margin-top:14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <label style="font-size:10pt">Journal <select id="import-journal" style="height:32px;padding:4px 8px;border:1px solid #ccc;border-radius:4px;font-size:10pt"><option value="">— loading —</option></select></label>
        <button class="btn-primary" onclick="postApproved()">Post to Journal</button>
        <span id="post-status" style="font-size:10pt"></span>
      </div>
    </div>

  </details>

</div>

<script>
  var COMPANY = '${company}';
  
  // ── Reconciliation JS ────────────────────────────────────────────────────────
  var recRows = [];
  var openingBalance = 0;

  // Set default date range: current month
  var now = new Date();
  document.getElementById('rec-from').value = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-01';
  document.getElementById('rec-to').value = now.toISOString().slice(0,10);
  document.getElementById('stmt-balance').addEventListener('input', updateSummary);

  function loadReconcile() {
    var accountCode = document.getElementById('rec-account').value;
    var dateFrom = document.getElementById('rec-from').value;
    var dateTo = document.getElementById('rec-to').value;
    if (!accountCode) return;
    document.getElementById('rec-status').textContent = 'Loading…';
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'bank.reconcile.list', companyId: COMPANY, accountCode, dateFrom, dateTo }) })
      .then(r => r.json()).then(res => {
        var d = res.data || res;
        recRows = Array.isArray(d) ? d : (d.rows || []);
        openingBalance = d.openingBalance || 0;
        document.getElementById('rec-status').textContent = '';
        renderReconcile();
      })
      .catch(e => { document.getElementById('rec-status').textContent = e.message; });
  }

  function renderReconcile() {
    var acct = document.getElementById('rec-account').value;
    document.getElementById('rec-summary').style.display = '';
    document.getElementById('rec-table').style.display = '';
    document.getElementById('rec-body').innerHTML = recRows.map(function(r, i) {
      var cls = r.cleared ? 'cleared' : '';
      return '<tr class="'+cls+'" data-i="'+i+'" data-batch="'+r.batch_id+'" data-acct="'+acct+'">'
        +'<td>'+(r.date?String(r.date).slice(0,10):'')+'</td>'
        +'<td>'+(r.reference||r.batch_id||'')+'</td>'
        +'<td>'+(r.description||'')+'</td>'
        +'<td class="num">'+(parseFloat(r.debit||0)?fmt(r.debit):'')+'</td>'
        +'<td class="num">'+(parseFloat(r.credit||0)?fmt(r.credit):'')+'</td>'
        +'<td style="text-align:center"><input type="checkbox"'+(r.cleared?' checked':'')+' onchange="toggleCleared(this)" ></td>'
        +'</tr>';
    }).join('');
    updateSummary();
  }

  function toggleCleared(cb) {
    var tr = cb.closest('tr');
    var batchId = tr.dataset.batch;
    var accountCode = tr.dataset.acct;
    var cleared = cb.checked;
    cb.disabled = true;
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'bank.reconcile.clear', companyId: COMPANY, batchId, accountCode, cleared }) })
      .then(r => r.json()).then(res => {
        cb.disabled = false;
        var tr = cb.closest('tr');
        var i = parseInt(tr.dataset.i);
        recRows[i].cleared = cleared;
        tr.className = cleared ? 'cleared' : '';
        updateSummary();
      })
      .catch(function() { cb.disabled = false; cb.checked = !cleared; });
  }

  function updateSummary() {
    var periodNet = 0, unclearedCount = 0;
    recRows.forEach(function(r) {
      var net = parseFloat(r.debit||0) - parseFloat(r.credit||0);
      periodNet += net;
      if (!r.cleared) unclearedCount++;
    });
    var closingBook = openingBalance + periodNet;
    document.getElementById('sum-opening').textContent = fmt(openingBalance);
    document.getElementById('sum-net').textContent = (periodNet >= 0 ? '+' : '') + fmt(periodNet);
    document.getElementById('sum-book').textContent = fmt(closingBook);
    document.getElementById('sum-uncleared').textContent = unclearedCount;
    var stmtVal = parseFloat(document.getElementById('stmt-balance').value);
    if (!isNaN(stmtVal)) {
      var diff = closingBook - stmtVal;
      var el = document.getElementById('sum-diff');
      el.textContent = fmt(diff);
      el.style.color = Math.abs(diff) < 0.01 ? '#2a8a2a' : '#cc2222';
    } else {
      document.getElementById('sum-diff').textContent = '—';
    }
  }

  // ── Import JS ───────────────────────────────────────────────────────────────
  var csvRows = [];
  var headers = [];
  var processedRows = [];
  var accountsMap = {};
  var journalsList = [];
  var openBills = [];
  var billPanelRowIdx = -1;

  fetch('/api/' + COMPANY + '/accounts')
    .then(function(r){ return r.json(); })
    .then(function(rows){ rows.forEach(function(a){ accountsMap[a.account_code] = a.account_name; }); });

  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'journals.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); })
    .then(function(res){ journalsList = res.data || res; })
    .catch(function(){});

  function processCSVText(text) {
    var statusEl = document.getElementById('file-status');
    try {
      var lines = text.split(String.fromCharCode(10)).filter(function(l) { return l.trim().length > 0; });
      if (lines.length < 2) { statusEl.style.color='#cc2222'; statusEl.textContent = 'Error: need at least a header row + 1 data row'; return; }
      var firstLine = lines[0];
      var sep = (firstLine.split(';').length > firstLine.split(',').length) ? ';' : ',';
      headers = parseCSVRow(firstLine, sep);
      csvRows = lines.slice(1).map(function(l) { return parseCSVRow(l, sep); }).filter(function(r) { return r.some(function(c) { return c.trim(); }); });
      statusEl.style.color = '#2a8a2a';
      statusEl.textContent = '\u2713 Loaded ' + csvRows.length + ' rows | Columns: ' + headers.join(', ');
      populateColDropdowns();
      document.getElementById('step2').style.display = '';
      document.getElementById('step2').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch(err) {
      statusEl.style.color = '#cc2222';
      statusEl.textContent = 'Error: ' + err.message;
    }
  }

  function onPasteLoad() {
    var text = document.getElementById('csv-paste').value.trim();
    if (!text) { document.getElementById('file-status').textContent = 'Nothing pasted yet'; return; }
    processCSVText(text);
  }

  function onFileLoad() {
    var statusEl = document.getElementById('file-status');
    var file = document.getElementById('csv-file').files[0];
    if (!file) { statusEl.style.color='#cc2222'; statusEl.textContent = 'No file selected'; return; }
    statusEl.style.color = '#888'; statusEl.textContent = 'Reading…';
    var reader = new FileReader();
    reader.onerror = function() { statusEl.style.color='#cc2222'; statusEl.textContent = 'File read error'; };
    reader.onload = function(e) { processCSVText(e.target.result); };
    reader.readAsText(file);
  }

  function parseCSVRow(line, sep) {
    sep = sep || ',';
    var result = [], cur = '', inQ = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (c === '"') { inQ = !inQ; }
      else if (c === sep && !inQ) { result.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    result.push(cur.trim());
    return result;
  }

  var STORAGE_KEY = 'freebooks_import_' + COMPANY;

  function saveImportPrefs() {
    try {
      var prefs = {
        amtType: document.getElementById('amt-type').value,
        bankAcct: document.getElementById('bank-acct').value,
        journalId: document.getElementById('import-journal').value,
        colDate: document.getElementById('col-date').selectedIndex,
        colDesc: document.getElementById('col-desc').selectedIndex,
        colAmt:  document.getElementById('col-amt').selectedIndex,
        colDeb:  document.getElementById('col-deb').selectedIndex,
        colCred: document.getElementById('col-cred').selectedIndex,
        colHeaders: headers.join(',')
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch(e) {}
  }

  function restoreImportPrefs() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var prefs = JSON.parse(raw);
      if (prefs.colHeaders === headers.join(',')) {
        var ids = ['col-date','col-desc','col-amt','col-deb','col-cred'];
        var saved = [prefs.colDate, prefs.colDesc, prefs.colAmt, prefs.colDeb, prefs.colCred];
        ids.forEach(function(id, i) { if (saved[i] != null) document.getElementById(id).selectedIndex = saved[i]; });
      }
      if (prefs.amtType) { document.getElementById('amt-type').value = prefs.amtType; toggleAmtCols(); }
      if (prefs.bankAcct) document.getElementById('bank-acct').value = prefs.bankAcct;
    } catch(e) {}
  }

  function populateColDropdowns() {
    var ids = ['col-date','col-desc','col-amt','col-deb','col-cred'];
    var guesses = { 'col-date': /date/i, 'col-desc': /desc|narr|ref|detail|memo/i,
      'col-amt': /amount|amt/i, 'col-deb': /debit|dr|withdraw|out/i, 'col-cred': /credit|cr|deposit|in/i };
    ids.forEach(function(id) {
      var sel = document.getElementById(id);
      sel.innerHTML = headers.map(function(h,i){ return '<option value="'+i+'"'+(guesses[id]&&guesses[id].test(h)?' selected':'')+'>'+h+'</option>'; }).join('');
    });
    restoreImportPrefs();
  }

  function toggleAmtCols() {
    var split = document.getElementById('amt-type').value === 'split';
    document.getElementById('row-single').style.display = split ? 'none' : '';
    document.getElementById('row-debit').style.display = split ? '' : 'none';
    document.getElementById('row-credit').style.display = split ? '' : 'none';
  }

  function parseAndProcess() {
    var di = parseInt(document.getElementById('col-date').value);
    var dsi = parseInt(document.getElementById('col-desc').value);
    var bankAcct = document.getElementById('bank-acct').value.trim();
    var split = document.getElementById('amt-type').value === 'split';
    if (!bankAcct) { document.getElementById('parse-status').textContent = 'Bank account required'; return; }

    var bankRows = [];
    csvRows.forEach(function(row) {
      var dateRaw = row[di] || '';
      var desc = row[dsi] || '';
      var amount;
      if (split) {
        var deb = parseFloat((row[parseInt(document.getElementById('col-deb').value)]||'').replace(/,/g,'')) || 0;
        var cred = parseFloat((row[parseInt(document.getElementById('col-cred').value)]||'').replace(/,/g,'')) || 0;
        amount = cred - deb;
      } else {
        amount = parseFloat((row[parseInt(document.getElementById('col-amt').value)]||'').replace(/,/g,'')) || 0;
      }
      if (deb === 0 && cred === 0 && amount === 0) return;
      var date = normalizeDate(dateRaw);
      if (!date) return;
      bankRows.push({ date, description: desc || '(no description)', amount, bankAccount: bankAcct });
    });

    saveImportPrefs();
    var skipped = csvRows.length - bankRows.length;
    if (bankRows.length === 0) {
      document.getElementById('parse-status').textContent = 'No valid rows found (' + csvRows.length + ' rows read, all skipped). Check date column and amount columns.';
      return;
    }
    document.getElementById('parse-status').textContent = 'Processing ' + bankRows.length + ' rows (' + skipped + ' skipped)…';
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'bank.process', companyId: COMPANY, bankAccount: bankAcct, rows: bankRows }) })
      .then(r => r.json()).then(res => {
        var d = res.data || res;
        if (res.error || d.error) { document.getElementById('parse-status').textContent = res.error || d.error; return; }
        processedRows = d.processed || [];
        document.getElementById('parse-status').textContent = '';
        renderReview(d);
        fetchAndShowBalance(bankAcct);
        checkDuplicates(bankAcct, bankRows);
        fetchOpenBills();
      })
      .catch(e => { document.getElementById('parse-status').textContent = e.message; });
  }

  var MONTHS = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  function normalizeDate(s) {
    if (!s) return null;
    s = s.trim();
    if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) return s;
    if (/^[0-9]{8}$/.test(s)) return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8);
    var m = s.match(/^([0-9]{1,2})[ \-]([A-Za-z]{3})[ \-]([0-9]{2,4})$/);
    if (m) {
      var mon = MONTHS[m[2].toLowerCase()];
      if (mon) {
        var yr = m[3].length === 2 ? '20' + m[3] : m[3];
        return yr + '-' + String(mon).padStart(2,'0') + '-' + m[1].padStart(2,'0');
      }
    }
    s = s.replace(/[\/.]/g, '-');
    var p = s.split('-');
    if (p.length === 3) {
      if (p[0].length === 4) return s;
      if (p[2].length === 4) return p[2]+'-'+p[1].padStart(2,'0')+'-'+p[0].padStart(2,'0');
      if (parseInt(p[0]) > 12) return '20'+p[2]+'-'+p[1].padStart(2,'0')+'-'+p[0].padStart(2,'0');
      return '20'+p[2]+'-'+p[0].padStart(2,'0')+'-'+p[1].padStart(2,'0');
    }
    return null;
  }

  function renderReview(d) {
    var summary = d.summary || {};
    document.getElementById('import-summary').innerHTML =
      '<b>'+processedRows.length+'</b> rows: '
      + '<span style="color:#2a8a2a">'+(summary.ruleMatched||0)+' rule-matched</span>, '
      + '<span style="color:#856404">'+(summary.billMatched||0)+' bill-matched</span>, '
      + '<span style="color:#cc8800">'+(summary.unmatched||0)+' unmatched</span>';
    document.getElementById('review-body').innerHTML = processedRows.map(function(r, i) {
      var orig = r.original;
      var amt = parseFloat(orig.amount);
      var matchTag = r.matchType === 'rule' ? '<span class="tag hi">rule</span>'
        : r.matchType === 'bill' ? '<span class="tag med">bill</span>'
        : '<span class="tag lo">manual</span>';
      var cls = r.matchType ? 'matched' : 'unmatched';
      var billCell = r.billId
        ? '<span style="color:#2a8a2a;font-size:9pt">\u2713 '+escHtml((r.vendorShort||String(r.billId)).slice(0,10))+'</span>'
          +' <button style="border:none;background:none;cursor:pointer;color:#888;font-size:9pt" '
          +'onclick="unlinkBill('+i+')" title="Unlink bill">\u00d7</button>'
        : '<button style="border:1px solid #aaa;background:#f8f8f8;border-radius:3px;cursor:pointer;padding:2px 6px;font-size:10pt" '
          +'onclick="openBillPanel('+i+')">&#128279;</button>';
      return '<tr class="'+cls+'" data-i="'+i+'">'
        +'<td>'+orig.date+'</td>'
        +'<td>'+escHtml(orig.description)+'</td>'
        +'<td class="num" style="color:'+(amt>=0?'#2a8a2a':'#cc2222')+'">'+(amt>=0?'+':'')+fmt(Math.abs(amt))+'</td>'
        +'<td>'+matchTag+'</td>'
        +'<td style="width:80px;text-align:center" data-bill-cell="'+i+'">'+billCell+'</td>'
        +'<td style="width:90px"><input class="acct" data-field="dr" value="'+(r.debitAccount||'')+'" placeholder="DR acct" oninput="updateAcctName(this)">'
          +'<div style="font-size:8pt;color:#888;margin-top:2px;max-width:86px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">'+(r.debitAccount ? (accountsMap[r.debitAccount]||'?') : '')+'</div></td>'
        +'<td style="width:90px"><input class="acct" data-field="cr" value="'+(r.creditAccount||'')+'" placeholder="CR acct" oninput="updateAcctName(this)">'
          +'<div style="font-size:8pt;color:#888;margin-top:2px;max-width:86px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">'+(r.creditAccount ? (accountsMap[r.creditAccount]||'?') : '')+'</div></td>'
        +'<td style="text-align:center"><input type="checkbox" data-skip="'+i+'" onchange="updateBalances()"></td>'
        +'</tr>';
    }).join('');
    document.getElementById('step-review').style.display = '';
    var jSel = document.getElementById('import-journal');
    if (Array.isArray(journalsList) && journalsList.length) {
      jSel.innerHTML = journalsList.map(function(j){
        return '<option value="'+j.journal_id+'">'+j.code+' \u2014 '+j.name+'</option>';
      }).join('');
      var bank = journalsList.find(function(j){ return j.code === 'BANK'; });
      if (bank) jSel.value = bank.journal_id;
      try {
        var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        if (saved.journalId) jSel.value = saved.journalId;
      } catch(e) {}
    } else {
      setTimeout(function(){
        if (Array.isArray(journalsList) && journalsList.length) {
          jSel.innerHTML = journalsList.map(function(j){ return '<option value="'+j.journal_id+'">'+j.code+' \u2014 '+j.name+'</option>'; }).join('');
          var b = journalsList.find(function(j){ return j.code === 'BANK'; });
          if (b) jSel.value = b.journal_id;
        } else {
          jSel.innerHTML = '<option value="">— no journals found —</option>';
        }
      }, 800);
    }
  }

  function checkDuplicates(bankAcct, bankRows) {
    fetch('/api/admin/query', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ sql: "SELECT date, debit, credit FROM journal_entries WHERE company_id='" + COMPANY + "' AND account_code='" + bankAcct + "'" }) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        var existing = res.data || res.rows || res;
        if (!Array.isArray(existing)) return;
        var sigs = new Set();
        existing.forEach(function(e) {
          var net = parseFloat(e.debit||0) - parseFloat(e.credit||0);
          sigs.add(String(e.date).slice(0,10) + '|' + Math.abs(net).toFixed(2));
        });
        var dupCount = 0;
        document.querySelectorAll('#review-body tr').forEach(function(tr, i) {
          var r = processedRows[i];
          if (!r) return;
          var sig = r.original.date + '|' + Math.abs(parseFloat(r.original.amount)).toFixed(2);
          if (sigs.has(sig)) {
            tr.style.opacity = '0.55';
            tr.querySelector('[data-skip]').checked = true;
            var warn = tr.querySelector('.dup-warn');
            if (!warn) {
              var td = tr.querySelector('td');
              var w = document.createElement('div');
              w.className = 'dup-warn';
              w.style.cssText = 'font-size:8pt;color:#856404;font-weight:600';
              w.textContent = 'possible duplicate';
              td.appendChild(w);
            }
            dupCount++;
          }
        });
        if (dupCount > 0) {
          var msg = document.getElementById('import-summary');
          msg.innerHTML += ' &nbsp;<span style="color:#856404;font-weight:600">\u26a0 '+dupCount+' possible duplicate'+(dupCount>1?'s':'')+' pre-skipped — uncheck Skip to include</span>';
          updateBalances();
        }
      }).catch(function(){});
  }

  var bookBalanceBefore = null;

  function fetchAndShowBalance(bankAcct) {
    fetch('/api/admin/query', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ sql: "SELECT COALESCE(SUM(debit)-SUM(credit),0) AS balance FROM journal_entries WHERE company_id='" + COMPANY + "' AND account_code='" + bankAcct.replace(/'/g,\'\') + "'" }) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        var rows = res.data || res.rows || res;
        if (Array.isArray(rows) && rows.length > 0) {
          bookBalanceBefore = parseFloat(rows[0].balance || 0);
          document.getElementById('balance-bar').style.display = 'flex';
          updateBalances();
        }
      }).catch(function(){});
  }

  function updateBalances() {
    if (bookBalanceBefore === null) return;
    var net = 0;
    document.querySelectorAll('#review-body tr').forEach(function(tr, i) {
      var skip = tr.querySelector('[data-skip]').checked;
      if (!skip && processedRows[i]) net += parseFloat(processedRows[i].original.amount || 0);
    });
    var after = bookBalanceBefore + net;
    document.getElementById('bal-before').textContent = fmt(bookBalanceBefore);
    document.getElementById('bal-net').textContent = (net >= 0 ? '+' : '') + fmt(net);
    document.getElementById('bal-net').style.color = net >= 0 ? '#2a8a2a' : '#cc2222';
    document.getElementById('bal-after').textContent = fmt(after);
  }

  function fmt(n) { return parseFloat(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
  function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function updateAcctName(input) {
    var code = input.value.trim();
    var nameDiv = input.nextElementSibling;
    if (!nameDiv) return;
    nameDiv.textContent = code ? (accountsMap[code] || (code.length >= 4 ? '?' : '')) : '';
    nameDiv.style.color = (code && !accountsMap[code] && code.length >= 4) ? '#cc2222' : '#888';
  }

  function postApproved() {
    var entries = [];
    document.querySelectorAll('#review-body tr').forEach(function(tr, i) {
      var skip = tr.querySelector('[data-skip]').checked;
      if (skip) return;
      var r = processedRows[i];
      var dr = tr.querySelector('[data-field=dr]').value.trim();
      var cr = tr.querySelector('[data-field=cr]').value.trim();
      if (!dr || !cr) return;
      entries.push({ date: r.original.date, description: r.description || r.original.description,
        amount: r.original.amount, debitAccount: dr, creditAccount: cr,
        vatCode: r.vatCode || null, billId: r.billId || null });
    });
    if (!entries.length) { document.getElementById('post-status').textContent = 'Nothing to post'; return; }
    var journalId = document.getElementById('import-journal').value;
    if (!journalId) { document.getElementById('post-status').textContent = 'Select a journal first'; return; }
    document.getElementById('post-status').textContent = 'Posting '+entries.length+' entries…';
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'bank.approve', companyId: COMPANY, journalId, entries }) })
      .then(r => r.json()).then(res => {
        var d = res.data || res;
        if (res.error || d.error) { document.getElementById('post-status').textContent = res.error||d.error; return; }
        var n = d.posted || 0, failed = d.failed || 0;
        var jName = document.getElementById('import-journal').options[document.getElementById('import-journal').selectedIndex];
        var jLabel = jName ? jName.text : journalId;
        document.getElementById('step-review').innerHTML =
          '<div style="padding:28px;text-align:center">'
          +'<div style="font-size:28pt;color:#2a8a2a;margin-bottom:10px">&#10003;</div>'
          +'<div style="font-size:14pt;font-weight:700;margin-bottom:8px">Import complete</div>'
          +'<div style="font-size:11pt;color:#555;margin-bottom:24px">'
            +n+' entr'+(n===1?'y':'ies')+' posted to <b>'+escHtml(jLabel)+'</b>.'
            +(failed ? ' <span style="color:#cc2222">'+failed+' failed.</span>' : '')
          +'</div>'
          +'<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">'
            +'<a href="/'+COMPANY+'/bank" style="display:inline-block;padding:10px 22px;background:#1a1a1a;color:#fff;border-radius:4px;font-weight:600;text-decoration:none">&larr; Back to Bank</a>'
            +'<a href="/'+COMPANY+'/bank" style="display:inline-block;padding:10px 22px;background:#555;color:#fff;border-radius:4px;font-weight:600;text-decoration:none">Import Another Statement</a>'
          +'</div></div>';
      })
      .catch(e => { document.getElementById('post-status').textContent = e.message; });
  }

  function fetchOpenBills() {
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'bill.list', companyId: COMPANY }) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        var bills = res.data || res;
        if (Array.isArray(bills)) openBills = bills;
      }).catch(function(){});
  }

  function openBillPanel(rowIdx) {
    billPanelRowIdx = rowIdx;
    var r = processedRows[rowIdx];
    var orig = r ? r.original : {};
    document.getElementById('bill-panel-row-label').textContent =
      '— row '+(rowIdx+1)+': '+(orig.date||'')+' '+(orig.description||'').slice(0,40);
    document.getElementById('bill-panel-search').value = '';
    renderBillPanelList();
    document.getElementById('bill-panel').style.display = '';
    document.getElementById('bill-panel-search').focus();
  }

  function closeBillPanel() {
    document.getElementById('bill-panel').style.display = 'none';
    billPanelRowIdx = -1;
  }

  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape') closeBillPanel();
  });

  function renderBillPanelList() {
    var q = document.getElementById('bill-panel-search').value.trim().toLowerCase();
    var filtered = openBills.filter(function(b){
      if (!q) return true;
      return (b.vendor_name||'').toLowerCase().includes(q)
        || (b.vendor_ref||'').toLowerCase().includes(q)
        || (b.bill_id||'').toLowerCase().includes(q);
    });
    var list = document.getElementById('bill-panel-list');
    if (!filtered.length) {
      list.innerHTML = '<div style="padding:10px 14px;color:#888;font-size:10pt">'+(openBills.length?'No matching bills':'No open bills loaded')+'</div>';
      return;
    }
    list.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:9.5pt">'
      +'<thead><tr style="background:#f0f0f0">'
      +'<th style="padding:5px 8px;text-align:left">Vendor</th>'
      +'<th style="padding:5px 8px;text-align:left">Ref</th>'
      +'<th style="padding:5px 8px;text-align:left">Date</th>'
      +'<th style="padding:5px 8px;text-align:right">Outstanding</th>'
      +'</tr></thead><tbody>'
      + filtered.slice(0,50).map(function(b, i){
          var outstanding = parseFloat(b.outstanding_amount||b.amount||0);
          return '<tr style="cursor:pointer;border-bottom:1px solid #f0f0f0" '
            +'onmouseover="this.style.background=\\\'#f0f4ff\\\'" onmouseout="this.style.background=\\\'\\\'" '
            +'onclick="selectBill('+JSON.stringify(b)+')" >'}]}
            +'<td style="padding:5px 8px">'+escHtml(b.vendor_name||b.vendor_id||'')+'</td>'
            +'<td style="padding:5px 8px;color:#555">'+escHtml(b.vendor_ref||'')+'</td>'
            +'<td style="padding:5px 8px;color:#555">'+escHtml(String(b.bill_date||'').slice(0,10))+'</td>'
            +'<td style="padding:5px 8px;text-align:right;font-weight:600">'+outstanding.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+'</td>'
            +'</tr>';
        }).join('')
      +'</tbody></table>';
  }

  function selectBill(bill) {
    if (billPanelRowIdx < 0 || !processedRows[billPanelRowIdx]) return;
    var r = processedRows[billPanelRowIdx];
    r.billId = bill.bill_id;
    r.vendorShort = (bill.vendor_name||bill.vendor_id||'').slice(0,10);
    if (bill.ap_account) {
      var tr = document.querySelector('#review-body tr[data-i="'+billPanelRowIdx+'"]');
      if (tr) {
        var drInput = tr.querySelector('[data-field=dr]');
        var crInput = tr.querySelector('[data-field=cr]');
        if (drInput) { drInput.value = bill.ap_account; updateAcctName(drInput); }
      }
    }
    refreshBillCell(billPanelRowIdx);
    closeBillPanel();
  }

  function unlinkBill(rowIdx) {
    if (!processedRows[rowIdx]) return;
    processedRows[rowIdx].billId = null;
    processedRows[rowIdx].vendorShort = null;
    refreshBillCell(rowIdx);
  }

  function refreshBillCell(rowIdx) {
    var cell = document.querySelector('[data-bill-cell="'+rowIdx+'"]');
    if (!cell) return;
    var r = processedRows[rowIdx];
    if (r && r.billId) {
      cell.innerHTML = '<span style="color:#2a8a2a;font-size:9pt">\u2713 '+escHtml((r.vendorShort||String(r.billId)).slice(0,10))+'</span>'
        +' <button style="border:none;background:none;cursor:pointer;color:#888;font-size:9pt" '
        +'onclick="unlinkBill('+rowIdx+')" title="Unlink bill">\u00d7</button>';
    } else {
      cell.innerHTML = '<button style="border:1px solid #aaa;background:#f8f8f8;border-radius:3px;cursor:pointer;padding:2px 6px;font-size:10pt" '
        +'onclick="openBillPanel('+rowIdx+')">&#128279;</button>';
    }
  }
<\/script>
</body>
</html>`;
}

module.exports = { handleBankPage };
