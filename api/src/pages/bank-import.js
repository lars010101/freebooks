'use strict';

// Import Statement lives as a TAB of the Bank page (magnus 2026-07-28):
// Transactions · Import · Mappings. The standalone /bank/import route 301s
// to /bank?tab=import (reports.js). renderImportPanel returns the panel
// markup + a script that DEFINES window.fbInitBankImport — bank.js calls it
// lazily on first tab show (idempotent via __fbImportInited).

function renderImportPanel(company) {
  return `
<style>
  .step { background:var(--surface,#fff); border:1px solid var(--border,#e8e8e8); border-radius:0.5rem; padding:1.25rem 1.5rem; margin-bottom:1rem; box-shadow:0 1px 3px rgba(0,0,0,.05); }
  .step h3 { margin:0 0 0.875rem; font-size:0.9375rem; color:var(--text); font-weight:600; }
  .wz-step .wz-num { display:inline-flex;align-items:center;justify-content:center;width:1.75rem;height:1.75rem;border-radius:50%;background:var(--border,#e0e0e0);color:var(--text-muted,#888);font-size:0.8rem;font-weight:700;flex-shrink:0; }
  .wz-step .wz-label { font-size:0.875rem;color:var(--text-muted,#888);font-weight:500; }
  .wz-step.active .wz-num { background:var(--accent,#1a1a1a);color:#fff; }
  .wz-step.active .wz-label { color:var(--text);font-weight:600; }
  .wz-step.done .wz-num { background:#2a8a2a;color:#fff; }
  .wz-step.done .wz-label { color:var(--text-muted,#888); }
  .wz-connector { flex:1;height:2px;background:var(--border,#e0e0e0);margin:0 0.5rem;max-width:4rem; }
  table.review-table { width:100%; border-collapse:collapse; font-size:9.5pt; }
  table.review-table th { background:#f0f0f0; padding:5px 7px; text-align:left; font-size:9pt; border:1px solid #ddd; }
  table.review-table td { padding:4px 6px; border:1px solid #eee; vertical-align:middle; background:#fff !important; color:#1a1a1a !important; opacity:1 !important; }
  table.review-table tr.matched td:first-child { border-left:3px solid #2a8a2a; }
  table.review-table tr.unmatched td:first-child { border-left:3px solid #cc8800; }
  .tag { display:inline-block; padding:1px 7px; border-radius:10px; font-size:8.5pt; font-weight:600; }
  .tag.hi  { background:#d4edda; color:#155724; }
  .tag.med { background:#fff3cd; color:#856404; }
  .tag.lo  { background:#f8d7da; color:#721c24; }
  .tag.sug { background:#ffeeba; color:#856404; }
  .tag.rec { background:#dbe5f1; color:#2f5496; }
  table.review-table tr.suggested td:first-child { border-left:3px solid #e0a800; }
  table.review-table tr.recorded td:first-child { border-left:3px solid #6c8ebf; }
  input.acct { width:75px; padding:3px 5px; border:1px solid #ccc; border-radius:3px; font-size:9.5pt; }
  select.col-map { padding:3px 5px; border:1px solid #ccc; border-radius:3px; font-size:9.5pt; }
  #bill-panel-list tbody tr:hover { background:#f0f4ff; }
</style>

  <div id="wizard-steps" style="display:flex; align-items:center; gap:0; margin-bottom:1.5rem;">
    <div class="wz-step active" id="wz-step-1" style="display:flex;align-items:center;gap:0.5rem">
      <span class="wz-num">1</span>
      <span class="wz-label">Upload</span>
    </div>
    <div class="wz-connector"></div>
    <div class="wz-step" id="wz-step-2" style="display:flex;align-items:center;gap:0.5rem">
      <span class="wz-num">2</span>
      <span class="wz-label">Mapping</span>
    </div>
    <div class="wz-connector"></div>
    <div class="wz-step" id="wz-step-3" style="display:flex;align-items:center;gap:0.5rem">
      <span class="wz-num">3</span>
      <span class="wz-label">Review &amp; Approve</span>
    </div>
  </div>

  <!-- Step 1: Upload -->
  <div class="step" id="step1">
    <h3>① Load your bank statement CSV</h3>
    <div id="drop-zone" style="border:2px dashed var(--border,#ccc);border-radius:0.5rem;padding:2rem 1rem;text-align:center;color:var(--text-muted,#888);margin-bottom:1rem;cursor:pointer;transition:border-color .15s" onclick="document.getElementById('csv-file').click()" ondragover="event.preventDefault();this.style.borderColor='var(--accent,#1a1a1a)'" ondragleave="this.style.borderColor=''" ondrop="onDropFile(event)">
      <div style="font-size:0.9375rem;margin-bottom:0.5rem">Drag and drop your bank statement file here, or <span style="color:var(--accent,#2255cc);text-decoration:underline;cursor:pointer">click to browse</span>.</div>
      <button class="btn-sm" id="paste-toggle-btn" onclick="event.stopPropagation(); var t=document.getElementById('csv-paste'); var b=document.getElementById('paste-load-btn'); var show=t.style.display==='none'||!t.style.display; t.style.display=show?'block':'none'; b.style.display=show?'':'none';" style="margin-top:0.5rem">Paste CSV instead</button>
    </div>
    <textarea id="csv-paste" rows="4" style="display:none;width:100%;font-family:monospace;font-size:0.8125rem;padding:0.5rem;border:1px solid var(--border,#ccc);border-radius:0.375rem;resize:vertical;box-sizing:border-box;" placeholder="Paste CSV content here…"></textarea>
    <button class="btn-primary" id="paste-load-btn" style="display:none;margin-top:0.5rem" onclick="onPasteLoad()">Load Pasted CSV →</button>
    <input type="file" id="csv-file" accept=".csv,.txt" onchange="onFileLoad()" style="display:none">
    <div id="file-status" style="margin-top:0.5rem;font-size:0.875rem"></div>
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
        <td style="position:relative">
          <input type="text" id="bank-acct" class="acct" style="width:90px" placeholder="101414" autocomplete="off">
          <span id="bank-acct-hint" style="font-size:9pt;color:#888;margin-left:8px">The asset account for this bank</span>
        </td></tr>
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
    <p style="margin:0 0 10px;font-size:9.5pt;color:#555">Green border = rule-matched. Orange = unmatched (fill in DR/CR accounts manually). Check <b>Skip</b> to exclude a row. Then click <b>Post to Bank Journal</b>.</p>
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
<script>
window.fbInitBankImport = function () {
  if (window.__fbImportInited) return;
  window.__fbImportInited = true;
  var COMPANY = '${company}';
  var csvRows = [];
  var headers = [];
  var processedRows = [];
  var accountsMap = {};
  var journalsList = [];
  var openBills = [];
  var billPanelRowIdx = -1;

  fetch('/api/' + COMPANY + '/accounts')
    .then(function(r){ return r.json(); })
    .then(function(rows){
      rows.forEach(function(a){ accountsMap[a.account_code] = a.account_name; });
      var existingVal = document.getElementById('bank-acct').value.trim();
      if (existingVal && accountsMap[existingVal]) {
        var hint = document.getElementById('bank-acct-hint');
        if (hint) hint.textContent = accountsMap[existingVal];
      }
    });

  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'journals.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); })
    .then(function(res){ journalsList = res.data || res; })
    .catch(function(){});

  // Bank account picker — FB.dropdown (source reads accountsMap live; the
  // init fetch above populates it, late arrivals still match)
  (function attachBankAcctDd() {
    if (!window.FB || !FB.dropdown) return;
    FB.dropdown.attach(document.getElementById('bank-acct'), {
      // No keys:true — this is an FB.keys page (FB.form, K3b); dropdown keys
      // route through the form's INSERT bindings.
      minWidth: 240,
      source: function (q) {
        q = (q || '').toLowerCase();
        return Object.keys(accountsMap).sort().map(function (code) {
          return { code: code, name: accountsMap[code] || '' };
        }).filter(function (a) {
          return a.code.toLowerCase().indexOf(q) >= 0 || a.name.toLowerCase().indexOf(q) >= 0;
        }).map(function (a) { return { primary: a.code, secondary: a.name, data: a }; });
      },
      onPick: function (it, inp) {
        inp.value = it.primary;
        var hint = document.getElementById('bank-acct-hint');
        if (hint) hint.textContent = it.secondary || '';
      }
    });
  })();

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
      setWizardStep(2);
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

  function setWizardStep(n) {
    for (var i = 1; i <= 3; i++) {
      var el = document.getElementById('wz-step-' + i);
      if (!el) continue;
      el.classList.remove('active','done');
      if (i < n) el.classList.add('done');
      else if (i === n) el.classList.add('active');
    }
  }

  function onDropFile(e) {
    e.preventDefault();
    document.getElementById('drop-zone').style.borderColor = '';
    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    var statusEl = document.getElementById('file-status');
    if (statusEl) { statusEl.style.color = '#888'; statusEl.textContent = 'Reading ' + file.name + '…'; }
    var reader = new FileReader();
    reader.onload = function(ev) {
      processCSVText(ev.target.result);
    };
    reader.onerror = function() {
      if (statusEl) { statusEl.style.color = '#cc2222'; statusEl.textContent = 'File read error'; }
    };
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
        colHeaders: headers.join(',') // only restore if same headers
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch(e) {}
  }

  function restoreImportPrefs() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var prefs = JSON.parse(raw);
      // Only restore column indices if headers match
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
      if (deb === 0 && cred === 0 && amount === 0) return; // skip balance-only rows
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
    // Try YYYY-MM-DD
    if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) return s;
    // Try YYYYMMDD (e.g. 20260326)
    if (/^[0-9]{8}$/.test(s)) return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8);
    // Try DD Mon YYYY or D Mon YYYY (e.g. 26 Mar 2026, 5 Jan 2026)
    var m = s.match(/^([0-9]{1,2})[ \-]([A-Za-z]{3})[ \-]([0-9]{2,4})$/);
    if (m) {
      var mon = MONTHS[m[2].toLowerCase()];
      if (mon) {
        var yr = m[3].length === 2 ? '20' + m[3] : m[3];
        return yr + '-' + String(mon).padStart(2,'0') + '-' + m[1].padStart(2,'0');
      }
    }
    // Replace slashes/dots with dashes then parse
    s = s.replace(/[\/.]/g, '-');
    var p = s.split('-');
    if (p.length === 3) {
      if (p[0].length === 4) return s; // YYYY-MM-DD
      if (p[2].length === 4) return p[2]+'-'+p[1].padStart(2,'0')+'-'+p[0].padStart(2,'0'); // DD-MM-YYYY
      if (parseInt(p[0]) > 12) return '20'+p[2]+'-'+p[1].padStart(2,'0')+'-'+p[0].padStart(2,'0'); // DD-MM-YY
      return '20'+p[2]+'-'+p[0].padStart(2,'0')+'-'+p[1].padStart(2,'0'); // MM-DD-YY
    }
    return null;
  }

  function renderReview(d) {
    var summary = d.summary || {};
    document.getElementById('import-summary').innerHTML =
      '<b>'+processedRows.length+'</b> rows: '
      + '<span style="color:#2a8a2a">'+(summary.ruleMatched||0)+' rule-matched</span>, '
      + '<span style="color:#856404">'+(summary.billMatched||0)+' bill-matched</span>, '
      + '<span style="color:#cc8800">'+(summary.unmatched||0)+' unmatched</span>'
      + ((summary.billSuggest||0) ? ' &nbsp;<span style="color:#856404;font-weight:600">'+summary.billSuggest+' amount-only suggestion'+(summary.billSuggest>1?'s':'')+' pre-skipped — uncheck Skip to confirm</span>' : '')
      + ((summary.recordedPayment||0) ? ' &nbsp;<span style="color:#2f5496;font-weight:600">'+summary.recordedPayment+' already recorded — will clear on approve</span>' : '');
    document.getElementById('step-review').style.display = '';
    setWizardStep(3);
    document.getElementById('review-body').innerHTML = processedRows.map(function(r, i) {
      var orig = r.original;
      var amt = parseFloat(orig.amount);
      var matchTag = r.matchType === 'rule' ? '<span class="tag hi">rule</span>'
        : r.matchType === 'bill' ? '<span class="tag med">bill</span>'
        : r.matchType === 'bill_suggest' ? '<span class="tag sug">bill?</span>'
        : r.matchType === 'recorded_payment' ? '<span class="tag rec">recorded</span>'
        : '<span class="tag lo">manual</span>';
      var cls = r.matchType === 'bill_suggest' ? 'suggested'
        : r.matchType === 'recorded_payment' ? 'recorded'
        : r.matchType ? 'matched' : 'unmatched';
      var billCell = r.billId
        ? '<span style="color:#2a8a2a;font-size:9pt">\u2713 '+escHtml((r.vendorShort||String(r.billId)).slice(0,10))+'</span>'
          +' <button style="border:none;background:none;cursor:pointer;color:#888;font-size:9pt" '
          +'onclick="unlinkBill('+i+')" title="Unlink bill">\u00d7</button>'
        : '<button style="border:1px solid #aaa;background:#f8f8f8;border-radius:3px;cursor:pointer;padding:2px 6px;font-size:10pt" '
          +'onclick="openBillPanel('+i+')">&#128279;</button>';
      var drCell = '<td style="width:90px"><input class="acct" data-field="dr" value="'+(r.debitAccount||'')+'" placeholder="DR acct" oninput="updateAcctName(this)">'
        +'<div style="font-size:8pt;color:#333;margin-top:2px;max-width:86px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">'+(r.debitAccount ? (accountsMap[r.debitAccount]||'?') : '')+'</div></td>';
      var crCell = '<td style="width:90px"><input class="acct" data-field="cr" value="'+(r.creditAccount||'')+'" placeholder="CR acct" oninput="updateAcctName(this)">'
        +'<div style="font-size:8pt;color:#333;margin-top:2px;max-width:86px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">'+(r.creditAccount ? (accountsMap[r.creditAccount]||'?') : '')+'</div></td>';
      if (r.matchType === 'recorded_payment') {
        drCell = '<td colspan="2" style="font-size:8.5pt;color:#2f5496;font-style:italic">already recorded — clears on approve</td>';
        crCell = '';
      }
      return '<tr class="'+cls+'" data-i="'+i+'">'
        +'<td>'+orig.date+'</td>'
        +'<td>'+escHtml(orig.description)+'</td>'
        +'<td class="num" style="color:'+(amt>=0?'#2a8a2a':'#cc2222')+'">'+(amt>=0?'+':'')+fmt(Math.abs(amt))+'</td>'
        +'<td>'+matchTag+'</td>'
        +'<td style="width:80px;text-align:center" data-bill-cell="'+i+'">'+billCell+'</td>'
        + drCell + crCell
        +'<td style="text-align:center"><input type="checkbox" data-skip="'+i+'" onchange="updateBalances()"'+(r.matchType === 'bill_suggest' ? ' checked' : '')+'></td>'
        +'</tr>';
    }).join('');
    // Populate journal dropdown now that the element is visible
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
      // journals not loaded yet — retry once after short delay
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
    // Build a lookup of date+amount combos already in the ledger for this account
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action: 'journal.account_lines', companyId: COMPANY, account_code: bankAcct }) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        var existing = res.data || res.rows || res;
        if (!Array.isArray(existing)) return;
        // Build set of 'date|amount' signatures already in the ledger
        var sigs = new Set();
        existing.forEach(function(e) {
          var net = parseFloat(e.debit||0) - parseFloat(e.credit||0);
          sigs.add(String(e.date).slice(0,10) + '|' + Math.abs(net).toFixed(2));
        });
        var dupCount = 0;
        document.querySelectorAll('#review-body tr').forEach(function(tr, i) {
          var r = processedRows[i];
          if (!r) return;
          // P1-9: recorded payments are EXPECTED in the ledger (that is the point —
          // approve clears them), and suggestions are already pre-skipped above.
          if (r.matchType === 'recorded_payment' || r.matchType === 'bill_suggest') return;
          var sig = r.original.date + '|' + Math.abs(parseFloat(r.original.amount)).toFixed(2);
          if (sigs.has(sig)) {

            tr.querySelector('[data-skip]').checked = true;
            var warn = tr.querySelector('.dup-warn');
            if (!warn) {
              var td = tr.querySelector('td');
              var w = document.createElement('div');
              w.className = 'dup-warn';
              w.style.cssText = 'font-size:8pt;color:#7a5c00;font-weight:600';
              w.textContent = '⚠ possible duplicate';
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
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action: 'journal.account_balance', companyId: COMPANY, account_code: bankAcct }) })
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
    nameDiv.style.color = (code && !accountsMap[code] && code.length >= 4) ? '#cc2222' : '#333';
  }

  function postApproved() {
    var entries = [];
    document.querySelectorAll('#review-body tr').forEach(function(tr, i) {
      var skip = tr.querySelector('[data-skip]').checked;
      if (skip) return;
      var r = processedRows[i];
      // P1-9: recorded payments post nothing — approve clears their bank leg
      if (r.matchType === 'recorded_payment' && r.paymentBatchId) {
        entries.push({ date: r.original.date, description: r.description || r.original.description,
          amount: r.original.amount, recordedPayment: true, paymentBatchId: r.paymentBatchId, bankAccount: r.bankAccount });
        return;
      }
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
            +'<a href="/'+COMPANY+'" style="display:inline-block;padding:10px 22px;background:#1a1a1a;color:#fff;border-radius:4px;font-weight:600;text-decoration:none">&larr; Back to Reports</a>'
            +'<a href="/'+COMPANY+'/bank/import" style="display:inline-block;padding:10px 22px;background:#555;color:#fff;border-radius:4px;font-weight:600;text-decoration:none">Import Another Statement</a>'
          +'</div></div>';
      })
      .catch(e => { document.getElementById('post-status').textContent = e.message; });
  }

  // ── Bill linking ─────────────────────────────────────────────────────
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

  // NOTE: the old document-level Esc→closeBillPanel listener is deleted —
  // Esc now routes through the FB.form binding table (K3b).

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
      billRows = []; billIdx = -1;
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
          // K3b: data-index + addEventListener instead of inline JSON onclick —
          // the old onclick="selectBill({...})" truncated at the first quote
          // inside the JSON (attribute is double-quoted) and threw
          // 'Unexpected end of input' on EVERY click — mouse was as broken
          // as keyboard. Latent bug surfaced by the K3b keyboard tests.
          return '<tr data-bill-idx="'+i+'" style="cursor:pointer;border-bottom:1px solid #f0f0f0">'
            +'<td style="padding:5px 8px">'+escHtml(b.vendor_name||b.vendor_id||'')+'</td>'
            +'<td style="padding:5px 8px;color:#555">'+escHtml(b.vendor_ref||'')+'</td>'
            +'<td style="padding:5px 8px;color:#555">'+escHtml(String(b.bill_date||'').slice(0,10))+'</td>'
            +'<td style="padding:5px 8px;text-align:right;font-weight:600">'+outstanding.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+'</td>'
            +'</tr>';
        }).join('')
      +'</tbody></table>';
    Array.prototype.forEach.call(list.querySelectorAll('tbody tr'), function (tr) {
      tr.addEventListener('click', function () { selectBill(filtered[Number(tr.getAttribute('data-bill-idx'))]); });
    });
    // K3b: keyboard highlight rows for the FB.form arrows/Enter bindings.
    billRows = Array.from(list.querySelectorAll('tbody tr'));
    billIdx = billRows.length ? 0 : -1;
    paintBill();
  }

  function selectBill(bill) {
    if (billPanelRowIdx < 0 || !processedRows[billPanelRowIdx]) return;
    var r = processedRows[billPanelRowIdx];
    r.billId = bill.bill_id;
    r.vendorShort = (bill.vendor_name||bill.vendor_id||'').slice(0,10);
    // Set AP account as debit (payment reduces AP), bank account as credit
    if (bill.ap_account) {
      var tr = document.querySelector('#review-body tr[data-i="'+billPanelRowIdx+'"]');
      if (tr) {
        var drInput = tr.querySelector('[data-field=dr]');
        var crInput = tr.querySelector('[data-field=cr]');
        if (drInput) { drInput.value = bill.ap_account; updateAcctName(drInput); }
        // creditAccount stays as bank account if already set
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

  // ── FB.form (K3b, keyboard-ux-spec §8) — the wizard as zones: bill panel ──
  // (when open) → upload → mapping → review. a = attach file, w = process/
  // post (stage-dispatched), b = link bill, Space = toggle skip. Bill-panel
  // results: arrows + Enter inside the search (reversal-search pattern).
  var billRows = [];
  var billIdx = -1;
  function paintBill() {
    billRows.forEach(function (tr, i) { tr.style.background = (i === billIdx) ? '#f0f4ff' : ''; });
    if (billRows[billIdx] && billRows[billIdx].scrollIntoView) billRows[billIdx].scrollIntoView({ block: 'nearest' });
  }
  function moveBill(d) {
    if (!billRows.length) return;
    billIdx += d;
    if (billIdx < 0) billIdx = 0;
    if (billIdx > billRows.length - 1) billIdx = billRows.length - 1;
    paintBill();
  }
  function billPanelOpen() { return document.getElementById('bill-panel').style.display !== 'none'; }
  function visible(id) { var el = document.getElementById(id); return !!(el && el.style.display !== 'none'); }

  var importForm = FB.form.create({
    formId: 'bank-import',
    // Embedded as a Bank tab (2026-07-28): the set only owns dispatch while
    // the Import panel is the visible tab — Transactions/Mappings keep their
    // own bindings otherwise (hidden-panel elements stay in the document).
    active: function () {
      var p = document.getElementById('bank-panel-import');
      return !!(p && p.style.display !== 'none' && document.contains(p));
    },
    zones: [
      { id: 'billpanel', rows: function () { return billPanelOpen() ? [document.getElementById('bill-panel')] : []; } },
      { id: 'upload', rows: function () { return [document.getElementById('step1')]; },
        cells: function (rowEl) {
          return Array.prototype.slice.call(rowEl.querySelectorAll('textarea'))
            .filter(function (el) { return !el.disabled && el.offsetParent !== null; });
        } },
      { id: 'mapping', rows: function () {
          if (!visible('step2')) return [];
          return Array.prototype.slice.call(document.querySelectorAll('#step2 table tr'))
            .filter(function (tr) { return tr.offsetParent !== null; });
        } },
      { id: 'review', rows: function () {
          if (!visible('step-review')) return [];
          return Array.prototype.slice.call(document.querySelectorAll('#review-body tr'));
        } }
    ],
    verbs: {
      add: { key: 'a', hint: 'attach file', run: function () { document.getElementById('csv-file').click(); } },
      write: { key: 'w', hint: 'process/post', run: function () {
        if (visible('step-review')) { postApproved(); return; }
        if (visible('step2')) { parseAndProcess(); return; }
        if (visible('paste-load-btn')) { onPasteLoad(); }
      } }
    },
    extraBindings: function (api) {
      function searchFocused() { return document.activeElement === document.getElementById('bill-panel-search'); }
      return [
        { key: 'p', mode: 'NORMAL', hint: 'paste csv', hintBar: true, run: function () { document.getElementById('paste-toggle-btn').click(); } },
        { key: 'b', mode: 'NORMAL', hint: 'link bill', hintBar: true,
          when: function () { return api.cur().z === 3; },
          run: function () { openBillPanel(api.cur().r); } },
        { key: ' ', mode: 'NORMAL', hint: 'skip row', hintBar: true,
          when: function () { return api.cur().z === 3; },
          run: function () {
            var tr = api.zoneRows(3)[api.cur().r];
            var cb = tr ? tr.querySelector('[data-skip]') : null;
            if (cb) { cb.checked = !cb.checked; updateBalances(); }
          } },
        { key: 'ArrowDown', mode: 'INSERT', when: searchFocused, run: function () { moveBill(1); } },
        { key: 'ArrowUp', mode: 'INSERT', when: searchFocused, run: function () { moveBill(-1); } },
        { key: 'Enter', mode: 'INSERT', when: function () { return searchFocused() && billIdx >= 0; },
          run: function () { if (billRows[billIdx]) billRows[billIdx].click(); } },
        { key: 'Escape', mode: 'INSERT', when: billPanelOpen, run: function () { closeBillPanel(); api.exitEdit(); } },
        { key: 'Escape', mode: 'NORMAL', when: billPanelOpen, run: closeBillPanel }
      ];
    }
  });
  FB.keys.renderHints('bank-import', document.getElementById('sb-hints'), { layout: 'list' });
};
<\/script>`;
}

module.exports = { renderImportPanel };
