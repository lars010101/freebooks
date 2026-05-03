'use strict';
const { commonStyle, navBar } = require('./common');

async function handleOpeningBalancesPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildOpeningBalancesPage(company));
}

function buildOpeningBalancesPage(company) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Opening Balances — freeBooks</title>
${commonStyle()}
<style>
  .ob-header-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:14px 24px; max-width:700px; margin-bottom:20px; }
  .ob-field { display:flex; flex-direction:column; gap:4px; }
  .ob-field label { font-weight:600; font-size:10pt; color:#555; }
  .ob-field input, .ob-field select { padding:7px 10px; border:1px solid #ccc; border-radius:4px; font-size:10pt; }
  .ob-field input:focus, .ob-field select:focus { outline:none; border-color:#888; }
  .filter-btns { display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap; align-items:center; }
  .filter-btns button { padding:5px 14px; border:1px solid #ccc; border-radius:4px; font-size:10pt; cursor:pointer; background:#f5f5f5; }
  .filter-btns button.active { background:#1a1a1a; color:#fff; border-color:#1a1a1a; }
  .filter-btns button:hover:not(.active) { background:#eee; }
  table.ob-table { width:100%; border-collapse:collapse; font-size:10pt; }
  table.ob-table th { text-align:left; font-size:9pt; color:#555; text-transform:uppercase; border-bottom:2px solid #ccc; padding:6px 8px; }
  table.ob-table td { padding:4px 6px; border-bottom:1px solid #f0f0f0; }
  table.ob-table tr:hover td { background:#fafafa; }
  table.ob-table input[type=number] { width:110px; padding:4px 7px; border:1px solid #ddd; border-radius:3px; font-size:10pt; text-align:right; }
  table.ob-table input[type=number]:focus { outline:none; border-color:#888; }
  .ob-totals { display:flex; gap:24px; align-items:center; margin-top:14px; padding:12px 16px;
    background:#f8f8f8; border-radius:6px; font-size:10pt; flex-wrap:wrap; }
  .ob-totals .tot-item { display:flex; flex-direction:column; gap:2px; }
  .ob-totals .tot-label { font-size:9pt; color:#888; font-weight:600; text-transform:uppercase; }
  .ob-totals .tot-val { font-size:12pt; font-weight:700; font-family:monospace; }
  .ob-totals .tot-diff-ok { color:#2a8a2a; }
  .ob-totals .tot-diff-bad { color:#cc2222; }
  button.btn-primary { padding:10px 24px; background:#1a1a1a; color:#fff; border:none; border-radius:4px;
    font-size:11pt; font-weight:600; cursor:pointer; }
  button.btn-primary:hover:not(:disabled) { background:#333; }
  button.btn-primary:disabled { opacity:0.4; cursor:default; }
  .success-box { background:#f0fff4; border:1px solid #2a8a2a; border-radius:6px; padding:20px 24px; max-width:500px; }
  .success-box h2 { color:#2a8a2a; margin:0 0 10px; }
  .success-box a { color:#1a1a1a; font-weight:600; }
  .type-badge { display:inline-block; padding:1px 7px; border-radius:3px; font-size:9pt; font-weight:600; }
  .info-box { background:#f0f4ff; border:1px solid #2255cc; border-radius:4px; padding:12px 16px;
    font-size:10pt; margin-bottom:16px; }
</style>
</head>
<body>
<div class="page">
  ${navBar(company, 'settings')}
  <div class="header">
    <h1>📂 Opening Balances</h1>
    <p class="sub">${company}</p>
  </div>

  <div class="info-box">
    Enter debit/credit amounts for each account as of your opening date. The journal must balance (Total DR = Total CR) before posting. Leave amount blank or zero to skip an account.
  </div>

  <div id="success-panel" style="display:none" class="success-box">
    <h2>✓ Opening balances posted</h2>
    <p>Batch: <strong id="success-batch"></strong></p>
    <div style="display:flex;gap:16px;margin-top:14px">
      <a href="/${company}">← Back to Reports</a>
      <a href="/${company}/settings">⚙ Settings</a>
    </div>
  </div>

  <div id="ob-form">
    <div class="ob-header-grid">
      <div class="ob-field">
        <label>As of Date *</label>
        <input type="date" id="ob-date">
      </div>
      <div class="ob-field">
        <label>Journal</label>
        <select id="ob-journal"></select>
      </div>
      <div class="ob-field">
        <label>Description</label>
        <input type="text" id="ob-desc" value="Opening balances">
      </div>
    </div>

    <div class="filter-btns">
      <span style="font-weight:600;font-size:10pt;color:#555;margin-right:4px">Show:</span>
      <button id="btn-filter-bs" class="active" onclick="setFilter('bs')">Balance Sheet</button>
      <button id="btn-filter-all" onclick="setFilter('all')">All Accounts</button>
      <button id="btn-filter-nonzero" onclick="setFilter('nonzero')">Non-Zero Only</button>
      <input type="text" id="acct-search" placeholder="Search account…" style="padding:5px 10px;border:1px solid #ccc;border-radius:4px;font-size:10pt;width:200px"
        oninput="renderTable()">
    </div>

    <table class="ob-table">
      <thead>
        <tr>
          <th style="width:90px">Code</th>
          <th>Account Name</th>
          <th style="width:100px">Type</th>
          <th style="width:120px;text-align:right">Debit</th>
          <th style="width:120px;text-align:right">Credit</th>
        </tr>
      </thead>
      <tbody id="ob-tbody">
        <tr><td colspan="5" style="text-align:center;color:#888;padding:20px">Loading accounts…</td></tr>
      </tbody>
    </table>

    <div class="ob-totals">
      <div class="tot-item">
        <span class="tot-label">Total DR</span>
        <span class="tot-val" id="tot-dr">0.00</span>
      </div>
      <div class="tot-item">
        <span class="tot-label">Total CR</span>
        <span class="tot-val" id="tot-cr">0.00</span>
      </div>
      <div class="tot-item">
        <span class="tot-label">Difference</span>
        <span class="tot-val" id="tot-diff">0.00</span>
      </div>
      <div style="margin-left:auto;display:flex;gap:12px;align-items:center">
        <button class="btn-primary" id="btn-post" onclick="postBalances()" disabled>Post Opening Balances</button>
        <span id="post-status" style="font-size:10pt"></span>
      </div>
    </div>
  </div>
</div>

<script>
  var COMPANY = '${company}';
  var accountsList = [];
  var journalsList = [];
  var drVals = {};
  var crVals = {};
  var currentFilter = 'bs';

  var BS_TYPES = ['Asset', 'Liability', 'Equity'];

  // Set default date to today
  document.getElementById('ob-date').value = new Date().toISOString().slice(0,10);

  // Load accounts
  fetch('/api/' + COMPANY + '/accounts')
    .then(function(r){ return r.json(); })
    .then(function(rows){
      accountsList = Array.isArray(rows) ? rows.filter(function(a){ return a.is_active !== false; }) : [];
      renderTable();
    });

  // Load journals
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'journals.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      journalsList = res.data || res || [];
      var sel = document.getElementById('ob-journal');
      sel.innerHTML = '';
      journalsList.filter(function(j){ return j.active !== false; }).forEach(function(j){
        var opt = document.createElement('option');
        opt.value = j.journal_id;
        opt.textContent = j.code + ' — ' + j.name;
        if (j.code === 'MISC') opt.selected = true;
        sel.appendChild(opt);
      });
    }).catch(function(){});

  function setFilter(f) {
    currentFilter = f;
    ['bs','all','nonzero'].forEach(function(x){
      var btn = document.getElementById('btn-filter-' + x);
      if (btn) btn.className = (x === f) ? 'active' : '';
    });
    renderTable();
  }

  function renderTable() {
    var search = document.getElementById('acct-search').value.trim().toLowerCase();
    var rows = accountsList;

    if (currentFilter === 'bs') {
      rows = rows.filter(function(a){ return BS_TYPES.indexOf(a.account_type) >= 0; });
    } else if (currentFilter === 'nonzero') {
      rows = rows.filter(function(a){
        return (Number(drVals[a.account_code]||0) > 0) || (Number(crVals[a.account_code]||0) > 0);
      });
    }

    if (search) {
      rows = rows.filter(function(a){
        return a.account_code.toLowerCase().includes(search) || a.account_name.toLowerCase().includes(search);
      });
    }

    var tbody = document.getElementById('ob-tbody');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#888;padding:20px">No accounts.</td></tr>';
      return;
    }

    var html = '';
    rows.forEach(function(a){
      var typeColor = a.account_type === 'Asset' ? '#1a5276' :
        a.account_type === 'Liability' ? '#7b241c' :
        a.account_type === 'Equity' ? '#1e8449' :
        a.account_type === 'Revenue' ? '#6c3483' : '#555';
      var drVal = drVals[a.account_code] || '';
      var crVal = crVals[a.account_code] || '';
      html += '<tr>' +
        '<td style="font-family:monospace;color:#333">' + esc(a.account_code) + '</td>' +
        '<td>' + esc(a.account_name) + '</td>' +
        '<td><span class="type-badge" style="background:' + typeColor + '22;color:' + typeColor + '">' + esc(a.account_type) + '</span></td>' +
        '<td style="text-align:right"><input type="number" min="0" step="0.01" placeholder="0.00" data-code="' + esc(a.account_code) + '" data-side="dr" value="' + esc(drVal) + '" oninput="onAmtInput(this)"></td>' +
        '<td style="text-align:right"><input type="number" min="0" step="0.01" placeholder="0.00" data-code="' + esc(a.account_code) + '" data-side="cr" value="' + esc(crVal) + '" oninput="onAmtInput(this)"></td>' +
        '</tr>';
    });
    tbody.innerHTML = html;
    updateTotals();
  }

  function onAmtInput(el) {
    var code = el.dataset.code;
    var side = el.dataset.side;
    var val = el.value;
    if (side === 'dr') drVals[code] = val;
    else crVals[code] = val;
    updateTotals();
  }

  function updateTotals() {
    var totalDr = 0, totalCr = 0;
    accountsList.forEach(function(a){
      var dr = parseFloat(drVals[a.account_code] || 0);
      var cr = parseFloat(crVals[a.account_code] || 0);
      if (!isNaN(dr)) totalDr += dr;
      if (!isNaN(cr)) totalCr += cr;
    });
    var diff = Math.abs(totalDr - totalCr);
    document.getElementById('tot-dr').textContent = totalDr.toFixed(2);
    document.getElementById('tot-cr').textContent = totalCr.toFixed(2);
    var diffEl = document.getElementById('tot-diff');
    diffEl.textContent = (totalDr - totalCr).toFixed(2);
    diffEl.className = 'tot-val ' + (diff < 0.005 ? 'tot-diff-ok' : 'tot-diff-bad');
    var postBtn = document.getElementById('btn-post');
    var hasLines = (totalDr > 0 || totalCr > 0);
    var balanced = diff < 0.005;
    postBtn.disabled = !(hasLines && balanced);
  }

  function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function collectLines() {
    var date = document.getElementById('ob-date').value;
    var desc = document.getElementById('ob-desc').value.trim() || 'Opening balances';
    var lines = [];
    accountsList.forEach(function(a){
      var dr = parseFloat(drVals[a.account_code] || 0);
      var cr = parseFloat(crVals[a.account_code] || 0);
      dr = isNaN(dr) ? 0 : dr;
      cr = isNaN(cr) ? 0 : cr;
      if (dr <= 0 && cr <= 0) return;
      lines.push({ account_code: a.account_code, debit: dr, credit: cr, date: date, description: desc, source: 'manual' });
    });
    return lines;
  }

  function postBalances() {
    var date = document.getElementById('ob-date').value;
    if (!date) { document.getElementById('post-status').textContent = 'Date is required.'; document.getElementById('post-status').style.color='#cc2222'; return; }
    var journalId = document.getElementById('ob-journal').value;
    var lines = collectLines();
    if (!lines.length) { document.getElementById('post-status').textContent = 'No non-zero lines.'; return; }

    var btn = document.getElementById('btn-post');
    btn.disabled = true;
    document.getElementById('post-status').textContent = 'Posting\u2026';
    document.getElementById('post-status').style.color = '#555';

    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'journal.post', companyId: COMPANY, journalId: journalId || undefined, lines: lines, source: 'manual' }) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        var d = res.data || res;
        var err = res.error || d.error || (d.errors && d.errors.join('; '));
        if (err) {
          btn.disabled = false;
          document.getElementById('post-status').textContent = '\u2717 ' + err;
          document.getElementById('post-status').style.color = '#cc2222';
        } else {
          document.getElementById('ob-form').style.display = 'none';
          document.getElementById('success-batch').textContent = d.batchId || d.batch_id || '(posted)';
          document.getElementById('success-panel').style.display = '';
        }
      })
      .catch(function(e){
        btn.disabled = false;
        document.getElementById('post-status').textContent = '\u2717 ' + e.message;
        document.getElementById('post-status').style.color = '#cc2222';
      });
  }
<\/script>
</body>
</html>`;
}

module.exports = { handleOpeningBalancesPage };
