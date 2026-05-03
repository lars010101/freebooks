'use strict';
const { getDb } = require('../db');

let _conn = null;

function _getConn() {
  if (!_conn) {
    _conn = getDb().connect();
  }
  return _conn;
}

function makeQuery() {
  return function query(sql, params = []) {
    return new Promise((resolve, reject) => {
      const conn = _getConn();
      conn.all(sql, ...params, (err, rows) => {
        if (err) {
          // Reset on error so next call reconnects
          try { _conn = null; } catch(e) {}
          reject(err);
        } else {
          resolve(rows || []);
        }
      });
    });
  };
}

function commonStyle() {
  return `<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 11pt; color: #1a1a1a; background: #f4f4f4; }
  .page { max-width: 860px; margin: 40px auto; padding: 32px 40px; background: #fff; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
  .header { margin-bottom: 28px; }
  .header h1 { font-size: 20pt; font-weight: 700; }
  .header .sub { color: #666; font-size: 10pt; margin-top: 4px; }
  .company-list { list-style: none; margin-top: 8px; }
  .company-list li { border-bottom: 1px solid #f0f0f0; }
  .company-list a { display: block; padding: 12px 0; color: #1a1a1a; text-decoration: none; font-size: 12pt; }
  .company-list a:hover { color: #555; }
  .company-list .id { font-size: 9pt; color: #999; }
  .top-nav { display:flex; gap:0; border-bottom:2px solid #e8e8e8; margin-bottom:24px; }
  .top-nav a { padding:10px 18px; text-decoration:none; color:#555; font-size:10pt; font-weight:500; border-bottom:3px solid transparent; margin-bottom:-2px; }
  .top-nav a:hover { color:#1a1a1a; background:#f8f8f8; }
  .top-nav a.nav-active { color:#1a1a1a; border-bottom-color:#1a1a1a; font-weight:700; }
</style>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📒</text></svg>">`;
}

// ── Mount on Express app ──────────────────────────────────────────────────────
/**
 * Call this from index.js: mountReportRoutes(app)
 */
function mountReportRoutes(app) {
  app.get('/', handleIndex);
  app.get('/setup/new-company', handleNewCompanyPage);
  app.get('/api/:company/report', handleReport);
  app.get('/api/:company/periods', handlePeriods);
  app.get('/api/:company/accounts', handleAccounts);
  app.get('/api/:company/vat-codes', handleVatCodes);
  app.get('/:company/journal/new', handleJournalNewPage);
  app.get('/:company/bank/import', handleBankImportPage);
  app.get('/:company/bank/reconcile', handleBankReconcilePage);
  app.get('/:company/settings', handleSettingsPage);
  app.get('/:company', handleCompanyPage);
  app.post('/api/admin/query', (req, res, next) => { req.body = req.body || {}; next(); }, handleAdminQuery);
}

// ── Route: GET /api/:company/vat-codes ─────────────────────────────────────────────
async function handleVatCodes(req, res) {
  const { company } = req.params;
  const q = makeQuery();
  try {
    const rows = await q(`SELECT * FROM vat_codes WHERE company_id = ? ORDER BY vat_code`, [company]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Route: GET /:company/settings ──────────────────────────────────────────────
async function handleJournalNewPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildJournalNewPage(company));
}

function buildJournalNewPage(company) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>New Journal Entry — freeBooks</title>
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
</style>
</head>
<body>
<div class="page">
  <div class="back" style="display:flex;justify-content:space-between;align-items:center">
    <a href="/${company}">← Reports</a>
    <a href="/${company}/settings">⚙ Settings</a>
  </div>
  <div class="header" style="display:flex;justify-content:space-between;align-items:flex-start">
    <div>
      <h1 id="jv-mode-title">New Journal Entry</h1>
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
        <th>Line Description</th><th>Tax Code</th><th></th>
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
</div>
<script>
  var COMPANY = '${company}';
  var accountsMap = {};
  var vatCodes = [];

  fetch('/api/' + COMPANY + '/accounts')
    .then(r => r.json())
    .then(rows => { rows.forEach(a => { accountsMap[a.account_code] = a.account_name; }); });

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

  // ── Account autocomplete ──────────────────────────────────────────────────
  var acctDropdown = null;
  var acctDropdownTarget = null;

  function getAccountList() {
    return Object.keys(accountsMap).map(code => ({ code, name: accountsMap[code] }));
  }

  function showAcctDropdown(input, matches) {
    hideAcctDropdown();
    if (!matches.length) return;
    var rect = input.getBoundingClientRect();
    var div = document.createElement('div');
    div.id = 'acct-dd';
    div.style.cssText = 'position:fixed;z-index:9999;background:#fff;border:1px solid #ccc;border-radius:4px;'
      + 'box-shadow:0 3px 10px rgba(0,0,0,.15);max-height:220px;overflow-y:auto;min-width:280px;font-size:10pt;'
      + 'top:'+(rect.bottom+2)+'px;left:'+rect.left+'px';
    matches.slice(0, 20).forEach(function(a) {
      var row = document.createElement('div');
      row.style.cssText = 'padding:6px 10px;cursor:pointer;display:flex;gap:10px;align-items:baseline';
      row.innerHTML = '<span style="font-weight:600;color:#333;min-width:70px">'+a.code+'</span>'
        +'<span style="color:#666">'+a.name+'</span>';
      row.onmousedown = function(e) {
        e.preventDefault();
        selectAccount(a.code, a.name, acctDropdownTarget);
      };
      row.onmouseover = function() { row.style.background='#f0f4ff'; };
      row.onmouseout  = function() { row.style.background=''; };
      div.appendChild(row);
    });
    document.body.appendChild(div);
    acctDropdown = div;
    acctDropdownTarget = input;
  }

  function hideAcctDropdown() {
    if (acctDropdown) { acctDropdown.remove(); acctDropdown = null; }
    acctDropdownTarget = null;
  }

  function selectAccount(code, name, input) {
    hideAcctDropdown();
    var tr = input.closest('tr');
    var codeInput = tr.querySelector('.acct-input');
    var nameInput = tr.querySelector('.acct-name-input');
    codeInput.value = code;
    nameInput.value = name;
    codeInput.style.color = '';
    nameInput.style.color = '#555';
  }

  function onCodeInput(input) {
    var q = input.value.trim().toLowerCase();
    if (!q) { hideAcctDropdown(); return; }
    var matches = getAccountList().filter(a =>
      a.code.toLowerCase().startsWith(q) || a.code.toLowerCase().includes(q)
    ).sort((a, b) => a.code.localeCompare(b.code));
    // Sync name field if exact match
    var tr = input.closest('tr');
    var nameInput = tr.querySelector('.acct-name-input');
    if (accountsMap[input.value.trim()]) {
      nameInput.value = accountsMap[input.value.trim()];
      nameInput.style.color = '#555';
    } else {
      nameInput.value = '';
    }
    showAcctDropdown(input, matches);
  }

  function onNameInput(input) {
    var q = input.value.trim().toLowerCase();
    if (!q) { hideAcctDropdown(); return; }
    var matches = getAccountList().filter(a => a.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    showAcctDropdown(input, matches);
  }

  document.addEventListener('click', function(e) {
    if (acctDropdown && !acctDropdown.contains(e.target)) hideAcctDropdown();
  });
  // ──────────────────────────────────────────────────────────────────────────

  function addLine() {
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td><input type="text" class="acct-input" oninput="onCodeInput(this)" onblur="hideAcctDropdown()" style="width:90px" placeholder="101414"></td>'
      +'<td><input type="text" class="acct-name-input" oninput="onNameInput(this)" onblur="hideAcctDropdown()" style="width:160px;color:#555;border:1px solid #ddd;border-radius:3px;padding:3px 6px;font-size:10pt" placeholder="search by name"></td>'
      +'<td><input type="number" class="debit-input" min="0" step="0.01" oninput="updateTotals()" style="width:100px"></td>'
      +'<td><input type="number" class="credit-input" min="0" step="0.01" oninput="updateTotals()" style="width:100px"></td>'
      +'<td><input type="text" class="desc-input" style="width:160px" placeholder="optional"></td>'
      +'<td><select class="tax-select" style="width:120px"><option value="">\u2014 none \u2014</option></select></td>'
      +'<td><button class="btn-sm danger" onclick="this.parentElement.parentElement.remove(); updateTotals()">&times;</button></td>';
    document.getElementById('lines-body').appendChild(tr);
    populateTaxSelect(tr.querySelector('.tax-select'));
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
      vat_code:      tr.querySelector('.tax-select').value || null,
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

  function toggleReversalMode() {
    reversalMode = !reversalMode;
    document.getElementById('reversal-panel').style.display = reversalMode ? '' : 'none';
    document.getElementById('jv-mode-title').textContent = reversalMode ? 'Reversal Entry' : 'New Journal Entry';
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
    if (q.trim().length < 2) { res.style.display = 'none'; return; }
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
<\/script>
</body>
</html>`;
}

function navBar(company, activeKey) {
  const items = [
    { key: 'dashboard', label: '📊 Dashboard', href: `/${company}` },
    { key: 'bank',      label: '🏦 Bank',      href: `/${company}/bank` },
    { key: 'newjv',     label: '✏ New JV',     href: `/${company}/journal/new` },
    { key: 'payables',  label: '📋 Payables',  href: `/${company}/payables` },
    { key: 'settings',  label: '⚙ Settings',   href: `/${company}/settings` },
  ];
  const links = items.map(item =>
    `<a href="${item.href}"${item.key === activeKey ? ' class="nav-active"' : ''}>${item.label}</a>`
  ).join('');
  return `<nav class="top-nav">${links}</nav>`;
}

module.exports = { makeQuery, commonStyle, navBar };
