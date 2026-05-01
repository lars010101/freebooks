'use strict';
const { commonStyle } = require('./common');

async function handleBankReconcilePage(req, res) {
  const { company } = req.params;
  const q = makeQuery();
  const accounts = await q(
    `SELECT account_code, account_name FROM accounts WHERE company_id = ? AND cf_category = 'Cash' ORDER BY account_code`,
    [company]
  );
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildBankReconcilePage(company, accounts));
}


function buildBankReconcilePage(company, cashAccounts) {
  const acctOptions = cashAccounts.map(a =>
    `<option value="${a.account_code}">${a.account_code} — ${a.account_name}</option>`
  ).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Reconciliation — ${company}</title>
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
</style>
</head>
<body>
<div class="page">
  <div class="back" style="display:flex;justify-content:space-between;align-items:center">
    <a href="/${company}">← Reports</a>
    <a href="/${company}/bank/import">🏦 Bank Import</a>
  </div>
  <div class="header"><h1>Bank Reconciliation</h1><p class="sub">${company}</p></div>

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
</div>
<script>
  var COMPANY = '${company}';
  var recRows = [];

  // Set default date range: current month
  var now = new Date();
  document.getElementById('rec-from').value = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-01';
  document.getElementById('rec-to').value = now.toISOString().slice(0,10);
  document.getElementById('stmt-balance').addEventListener('input', updateSummary);

  var openingBalance = 0;

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
        // (moved to toggleCleared via data attrs)
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

  function fmt(n) { return parseFloat(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
<\/script>
</body>
</html>`;
}

module.exports = { handleBankReconcilePage };
