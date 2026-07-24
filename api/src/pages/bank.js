'use strict';
const { commonStyle, makeQuery, navBar, layoutEnd } = require('./common');

async function handleBankPage(req, res) {
  const { company } = req.params;
  const q = makeQuery();
  const [accounts, companyRows] = await Promise.all([
    q(`SELECT account_code, account_name FROM accounts WHERE company_id = ? AND cf_category = 'Cash' ORDER BY account_code`, [company]),
    q(`SELECT currency FROM companies WHERE company_id = ? LIMIT 1`, [company])
  ]);
  const homeCurrency = companyRows[0]?.currency || 'SGD';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildBankPage(company, accounts, homeCurrency));
}


function buildBankPage(company, cashAccounts, homeCurrency) {
  homeCurrency = homeCurrency || 'SGD';
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

  .tabs { display:flex; gap:0; border-bottom:2px solid #1a1a1a; margin-bottom:24px; }
  .tab { padding:8px 20px; cursor:pointer; font-weight:600; font-size:10pt; color:#555; border-bottom:3px solid transparent; margin-bottom:-2px; }
  .tab.active { color:#1a1a1a; border-bottom-color:#1a1a1a; }
  .edit-table { width:100%; border-collapse:collapse; font-size:10pt; }
  .edit-table th { text-align:left; font-size:9pt; text-transform:uppercase; color:#555; border-bottom:1px solid #ccc; padding:6px; }
  .edit-table td { padding:4px; border-bottom:1px solid #f0f0f0; vertical-align:middle; }
  .edit-table input[type=text], .edit-table select { width:100%; padding:4px 6px; border:1px solid #ddd; border-radius:3px; font-size:10pt; }
  .btn-sm { padding:0 14px; height:32px; font-size:10pt; cursor:pointer; border:1px solid #ccc; border-radius:3px; background:#f5f5f5; }
  .btn-sm:hover { background:#e8e8e8; }
  .btn-sm.danger { border-color:#cc2222; color:#cc2222; }
  .msg { margin-top:10px; font-size:10pt; }
  .msg.ok { color:#2a8a2a; }
  .msg.err { color:#cc2222; }
</style>
</head>
<body>${navBar(company, 'bank')}
<div class="page">
  
  <div class="header">
    <h1>🏦 Bank</h1>
  </div>

  <div class="tabs" style="margin-bottom:20px">
    <div class="tab active" id="bank-tab-txn" onclick="showBankTab('txn')">Transactions</div>
    <div class="tab" id="bank-tab-mappings" onclick="showBankTab('mappings')">Mappings</div>
  </div>

  <div id="bank-panel-txn">

  <!-- Reconciliation section (primary) -->
  <div id="uncleared-banner" style="display:none;margin-bottom:12px;padding:8px 14px;background:#fff3cd;border:1px solid #ffc107;border-radius:4px;font-size:10pt">
    Showing all uncleared transactions across all bank accounts.
    <a href="javascript:void(0)" onclick="exitUnclearedMode()" style="margin-left:12px;color:#555;font-size:9.5pt">← Show date filter</a>
  </div>

  <div style="display:flex;gap:12px;align-items:center;margin-bottom:16px;flex-wrap:wrap">
    <label>Account <select id="rec-account" style="width:220px;height:32px;padding:4px 6px">
      ${acctOptions || '<option>No cash accounts found</option>'}
    </select></label>
    <label>From <input type="date" id="rec-from"></label>
    <label>To <input type="date" id="rec-to"></label>
    <label style="display:flex;align-items:center;gap:5px;font-size:10pt;cursor:pointer"><input type="checkbox" id="filter-cleared"> Cleared</label>
    <label style="display:flex;align-items:center;gap:5px;font-size:10pt;cursor:pointer"><input type="checkbox" id="filter-uncleared" checked> Uncleared</label>
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
    <thead><tr><th style="width:90px">Date</th><th class="acct-col" style="display:none;width:100px">Account</th><th>Reference</th><th>Description</th><th class="num" style="width:100px">Debit</th><th class="num" style="width:100px">Credit</th><th style="text-align:center;width:70px"><input type="checkbox" id="hdr-clear-all" onchange="toggleAllCleared(this)" style="cursor:pointer" title="Mark all cleared"> Cleared</th></tr></thead>
    <tbody id="rec-body"></tbody>
  </table>
  <div id="rec-status" style="margin-top:10px;font-size:10pt"></div>


  </div><!-- /bank-panel-txn -->

  <div id="bank-panel-mappings" style="display:none">
    <table class="edit-table" id="mappings-table">
      <thead><tr><th>Pattern</th><th>Match</th><th>Offset Account <small style="font-weight:400;color:#888">(expense/income - bank side auto-assigned)</small></th><th>Description Override</th><th>Priority</th><th style="text-align:center">Active</th><th></th></tr></thead>
      <tbody id="mappings-body"></tbody>
    </table>
    <p style="margin-top:8px;font-size:9pt;color:#888">Rules are applied in priority order (lower = higher priority). Match types: <em>contains</em>, <em>exact</em>, <em>starts_with</em>, <em>regex</em>.<br>
    Set the <b>offset account</b> (expense for outflows, income for inflows). The bank account is supplied at import time and assigned automatically based on the amount sign.</p>
  </div><!-- /bank-panel-mappings -->

</div>

<script>
  var COMPANY = '${company}';
  var HOME_CURRENCY = '${homeCurrency}';
  var _unclearedMode = (new URLSearchParams(window.location.search)).get('mode') === 'uncleared';

  function setRecStatus(msg) { var el = document.getElementById('rec-status'); if (el) el.textContent = msg; }

  // ── Reconciliation JS ────────────────────────────────────────────────────────
  var recRows = [];
  var openingBalance = 0;

  // Set default date range: current month
  var now = new Date();
  document.getElementById('rec-from').value = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-01';
  document.getElementById('rec-to').value = now.toISOString().slice(0,10);
  document.getElementById('stmt-balance').addEventListener('input', updateSummary);

  // Cleared/Uncleared filter + getFilteredRows
  function getFilteredRows() {
    var showCleared   = document.getElementById('filter-cleared')   ? document.getElementById('filter-cleared').checked   : true;
    var showUncleared = document.getElementById('filter-uncleared') ? document.getElementById('filter-uncleared').checked : true;
    return recRows.filter(function(r) {
      if (r.cleared && !showCleared)   return false;
      if (!r.cleared && !showUncleared) return false;
      return true;
    }).slice(0, 100);
  }

  // Auto-load on any filter change
  function attachFilterListeners() {
    ['rec-account','rec-from','rec-to','filter-cleared','filter-uncleared'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', function() { loadReconcile(); });
    });
  }
  attachFilterListeners();

  // Auto-load on page open (uncleared only by default)
  setTimeout(function() {
    var acct = document.getElementById('rec-account');
    if (acct && acct.options.length > 0 && acct.options[0].value) { loadReconcile(); }
  }, 150);

  if (_unclearedMode) {
    document.getElementById('uncleared-banner').style.display = '';
    document.getElementById('rec-account').closest('div').style.display = 'none'; // hide controls
    // Show the Account column header
    document.querySelectorAll('.acct-col').forEach(function(el) { el.style.display = ''; });
    loadAllUncleared();
  }

  function loadReconcile() {
    var accountCode = document.getElementById('rec-account').value;
    var dateFrom = document.getElementById('rec-from').value;
    var dateTo = document.getElementById('rec-to').value;
    if (!accountCode) return;
    setRecStatus('Loading…');
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'bank.reconcile.list', companyId: COMPANY, accountCode, dateFrom, dateTo }) })
      .then(r => r.json()).then(res => {
        var d = res.data || res;
        recRows = Array.isArray(d) ? d : (d.rows || []);
        openingBalance = d.openingBalance || 0;
        setRecStatus('');
        renderReconcile();
      })
      .catch(e => { setRecStatus(e.message); });
  }

  function loadAllUncleared() {
    setRecStatus('Loading uncleared transactions…');
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'bank.uncleared.list', companyId: COMPANY }) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        var d = res.data || res;
        recRows = Array.isArray(d) ? d : (d.rows || []);
        setRecStatus('');
        renderUnclearedAll();
      })
      .catch(function(e){ setRecStatus(e.message); });
  }

  function renderReconcile() {
    var acct = document.getElementById('rec-account').value;
    document.getElementById('rec-summary').style.display = '';
    document.getElementById('rec-table').style.display = '';
    var displayRows = getFilteredRows();
    setRecStatus(recRows.length > displayRows.length ? 'Showing ' + displayRows.length + ' of ' + recRows.length + ' transactions' : '');
    document.getElementById('rec-body').innerHTML = displayRows.map(function(r, i) {
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
    recNav.clear();
    updateSummary();
  }

  function renderUnclearedAll() {
    document.getElementById('rec-summary').style.display = 'none';
    document.getElementById('rec-table').style.display = '';
    var displayRows = getFilteredRows();
    setRecStatus(recRows.length > displayRows.length ? 'Showing ' + displayRows.length + ' of ' + recRows.length + ' transactions' : '');
    document.getElementById('rec-body').innerHTML = displayRows.map(function(r, i) {
      return '<tr class="" data-i="'+i+'" data-batch="'+r.batch_id+'" data-acct="'+r.account_code+'">'
        +'<td>'+(r.date?String(r.date).slice(0,10):'')+'</td>'
        +'<td class="acct-col">'+(r.account_code||'')+'</td>'
        +'<td>'+(r.reference||r.batch_id||'')+'</td>'
        +'<td>'+(r.description||'')+'</td>'
        +'<td class="num">'+(parseFloat(r.debit||0)?fmt(r.debit):'')+'</td>'
        +'<td class="num">'+(parseFloat(r.credit||0)?fmt(r.credit):'')+'</td>'
        +'<td style="text-align:center"><input type="checkbox" onchange="toggleCleared(this)"></td>'
        +'</tr>';
    }).join('');
    setRecStatus(recRows.length
      ? recRows.length + ' uncleared transaction' + (recRows.length === 1 ? '' : 's')
      : 'No uncleared transactions ✓');
    recNav.clear();
  }

  function toggleAllCleared(hdrCb) {
    var wantCleared = hdrCb.checked;
    // Collect all row checkboxes that need to change state
    var rowCbs = Array.from(document.querySelectorAll('#rec-body tr')).map(function(tr) {
      return tr.querySelector('input[type=checkbox]');
    }).filter(function(cb) { return cb && cb.checked !== wantCleared; });
    if (!rowCbs.length) return;
    // Disable header checkbox during operation
    hdrCb.disabled = true;
    var pending = rowCbs.length;
    rowCbs.forEach(function(cb) {
      cb.checked = wantCleared;
      // Trigger the same logic as individual toggleCleared
      toggleCleared(cb, function() {
        pending--;
        if (pending === 0) { hdrCb.disabled = false; }
      });
    });
  }

  function toggleCleared(cb, _done) {
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
        // data-i is the index into the FILTERED display rows — resolve the
        // row object through getFilteredRows() (same references as recRows);
        // indexing recRows directly is wrong when a filter hides rows.
        var rowObj = getFilteredRows()[i];
        if (rowObj) rowObj.cleared = cleared;
        // classList.toggle, not className assignment — the latter wipes
        // nav-row-focus when the row was cleared via the keyboard cursor.
        tr.classList.toggle('cleared', cleared);
        updateSummary();
        // Sync header checkbox
        var hdrCb = document.getElementById('hdr-clear-all');
        if (hdrCb && !cleared) hdrCb.checked = false;
        if (_done) _done();
      })
      .catch(function() { cb.disabled = false; cb.checked = !cleared; if (_done) _done(); });
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

  function exitUnclearedMode() {
    _unclearedMode = false;
    document.getElementById('uncleared-banner').style.display = 'none';
    document.getElementById('rec-account').closest('div').style.display = '';
    document.querySelectorAll('.acct-col').forEach(function(el) { el.style.display = 'none'; });
    document.getElementById('rec-table').style.display = 'none';
    document.getElementById('rec-body').innerHTML = '';
    setRecStatus('');
  }

  // ── FB.keys: Transactions tab (P1-3 remainder — payables pattern) ─────────
  // Row cursor over #rec-body via FB.nav (sticky boundaries, scroll-into-view,
  // nav-row-focus class styled app-wide). Mappings tab stays unmigrated —
  // it is a per-row-input edit table, not a vim list (see spec §P1-3).
  var recNav = FB.nav.create({
    rows: function() { return Array.from(document.querySelectorAll('#rec-body tr')); }
  });

  function _txnVisible() {
    var p = document.getElementById('bank-panel-txn');
    return p && p.style.display !== 'none';
  }
  function _txnInputFocused() {
    var ae = document.activeElement;
    if (!ae || !_txnVisible()) return false;
    return document.getElementById('bank-panel-txn').contains(ae)
      && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.tagName === 'TEXTAREA');
  }
  function _focusedRowCb() {
    var tr = recNav.current();
    return tr ? tr.querySelector('input[type=checkbox]') : null;
  }

  FB.keys.register('bank', {
    active: _txnVisible,
    getMode: function() { return _txnInputFocused() ? 'INSERT' : 'NORMAL'; },
    bindings: [
      { key: 'j', mode: 'NORMAL', hint: 'navigate', hintBar: true,
        swallow: function() { return recNav.current() || document.querySelector('#rec-body tr'); },
        run: function() { recNav.move(1); } },
      { key: 'k', mode: 'NORMAL', hint: 'navigate', hintBar: true,
        swallow: function() { return recNav.current() || document.querySelector('#rec-body tr'); },
        run: function() { recNav.move(-1); } },
      { key: 'c', mode: 'NORMAL', hint: 'clear/unclear', hintBar: true,
        swallow: _focusedRowCb,
        run: function() {
          var cb = _focusedRowCb();
          if (!cb || cb.disabled) return;
          cb.checked = !cb.checked;
          toggleCleared(cb);
        } },
      { key: 'Escape', mode: 'NORMAL', hint: 'clear focus', hintBar: true,
        swallow: function() { return !!recNav.current(); },
        run: function() { recNav.clear(); } },
      { key: 'Escape', mode: 'INSERT', hint: 'back',
        run: function() { if (document.activeElement) document.activeElement.blur(); } }
    ]
  });
  FB.keys.renderHints('bank', document.getElementById('sb-hints'), { layout: 'list' });

  // ── Mappings tab keyboard (P2): ghost-row create + row nav ──────────────
  function _mappingsVisible() {
    var p = document.getElementById('bank-panel-mappings');
    return !!(p && p.style.display !== 'none');
  }
  function _mappingRows() {
    return Array.from(document.querySelectorAll('#mappings-body tr'));
  }
  var _mapSel = -1;
  function _mapCursor() {
    _mappingRows().forEach(function(r, i) { r.classList.toggle('bill-row-focus', i === _mapSel); });
  }
  FB.keys.register('bank-mappings', {
    active: _mappingsVisible,
    getMode: function() {
      var ae = document.activeElement;
      return (ae && ae.closest && ae.closest('#mappings-body')) ? 'INSERT' : 'NORMAL';
    },
    bindings: [
      { key: 'j', mode: 'NORMAL', hint: 'navigate', hintBar: true,
        swallow: function() { return _mappingRows().length > 0; },
        run: function() { var n = _mappingRows().length; if (!n) return; _mapSel = Math.min(_mapSel + 1, n - 1); _mapCursor(); } },
      { key: 'k', mode: 'NORMAL', hint: 'navigate', hintBar: true,
        swallow: function() { return _mappingRows().length > 0; },
        run: function() { _mapSel = Math.max(_mapSel - 1, 0); _mapCursor(); } },
      { key: 'i', mode: 'NORMAL', hint: 'edit', hintBar: true,
        swallow: function() { return _mapSel >= 0; },
        run: function() {
          var tr = _mappingRows()[_mapSel];
          if (!tr) return;
          if (tr.classList.contains('fb-ghost-row')) { activateMappingGhost(tr); return; } // i on ghost = create
          var inp = tr.cells[0].querySelector('input');
          if (inp) inp.focus();
        } },
      { key: 'Enter', mode: 'NORMAL', hint: 'edit', hintBar: true,
        swallow: function() { return _mapSel >= 0; },
        run: function() {
          var tr = _mappingRows()[_mapSel];
          if (!tr) return;
          if (tr.classList.contains('fb-ghost-row')) { activateMappingGhost(tr); return; } // Enter on ghost = create
          var inp = tr.cells[0].querySelector('input');
          if (inp) inp.focus();
        } },
      { key: 'Escape', mode: 'INSERT', hint: 'back',
        run: function() { if (document.activeElement) document.activeElement.blur(); } }
    ]
  });

  // Ghost-row mouse affordance: clicking anywhere on the faded ghost row
  // activates it (inputs are disabled, so every click lands on the row itself).
  document.getElementById('mappings-body').addEventListener('click', function(e) {
    var tr = e.target.closest ? e.target.closest('tr.fb-ghost-row') : null;
    if (!tr) return;
    activateMappingGhost(tr);
  });


  function fmt(n) { return parseFloat(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }

// ========== BANK TAB SWITCHER ==========
function showBankTab(t) {
  ['txn','mappings'].forEach(function(id) {
    document.getElementById('bank-panel-' + id).style.display = (id === t) ? '' : 'none';
    var tabEl = document.getElementById('bank-tab-' + id);
    if (tabEl) tabEl.classList.toggle('active', id === t);
  });
  if (t === 'mappings') { loadMappings(); loadBankMappingAccounts(); }
  // Sidebar hints follow the active tab's FB.keys set.
  var hints = document.getElementById('sb-hints');
  if (hints) {
    if (t === 'txn') FB.keys.renderHints('bank', hints, { layout: 'list' });
    else FB.keys.renderHints('bank-mappings', hints, { layout: 'list' });
  }
}

// ========== BANK MAPPINGS ==========
var MATCH_TYPES = ['contains','exact','starts_with','regex'];
var bankMappingAccounts = [];
var bankMappingsDirty = false;

function loadBankMappingAccounts() {
  if (bankMappingAccounts.length) return;
  fetch('/api/' + COMPANY + '/accounts').then(function(r){ return r.json(); }).then(function(rows){
    bankMappingAccounts = Array.isArray(rows) ? rows : [];
  });
}

function addMappingRow(m) {
  m = m || {};
  var isNew = !m.mapping_id;
  var MATCH_TYPES_LOCAL = ['contains','exact','starts_with','regex'];
  var tr = document.createElement('tr');
  tr.dataset.mappingId = m.mapping_id || '';
  tr.innerHTML = '<td><input type="text" value="'+(m.pattern||'')+'" placeholder="Pattern" style="width:130px"></td>'
    + '<td><select style="width:90px">' + MATCH_TYPES_LOCAL.map(function(mt){ return '<option'+(mt===(m.match_type||'contains')?' selected':'')+'>'+mt+'</option>'; }).join('') + '</select></td>'
    + '<td><input type="text" class="bm-acct" value="'+(m.debit_account||'')+'" placeholder="Debit account" style="width:100px" autocomplete="off"></td>'
    + '<td><input type="text" value="'+(m.description_override||'')+'" placeholder="Description" style="width:140px"></td>'
    + '<td><input type="number" value="'+(m.priority||100)+'" style="width:55px"></td>'
    + '<td style="text-align:center"><input type="checkbox"'+(m.is_active===true?' checked':'')+' ></td>'
    + '<td style="white-space:nowrap;text-align:right"></td>';
  var saveBtn = document.createElement('button');
  saveBtn.className = 'btn-sm';
  saveBtn.innerHTML = '\u{1F4BE}';
  saveBtn.title = 'Save';
  saveBtn.style.cssText = 'opacity:' + (isNew ? '1' : '0.35') + ';margin-right:4px';
  saveBtn.onclick = function() { saveMappingRow(tr); };
  var delBtn = document.createElement('button');
  delBtn.className = 'btn-sm danger';
  delBtn.innerHTML = '\u2715';
  delBtn.title = 'Delete';
  delBtn.onclick = function() { deleteMappingRow(tr); };
  tr.cells[tr.cells.length-1].appendChild(saveBtn);
  tr.cells[tr.cells.length-1].appendChild(delBtn);
  tr.querySelectorAll('input,select').forEach(function(el){
    el.addEventListener('input', function(){ saveBtn.style.opacity='1'; if(isNew && el===tr.cells[0].querySelector('input') && el.value.trim()){ isNew=false; appendBlankMappingRow(); } });
    el.addEventListener('change', function(){ saveBtn.style.opacity='1'; });
  });
  document.getElementById('mappings-body').appendChild(tr);
  attachMappingAcctDd(tr.querySelector('.bm-acct'));
  return tr;
}
// P2 pinned-top: the ghost row leads the table — a FADED, display-only entry
// row (inputs disabled). i / Enter / click activates it (single create
// affordance, always visible, mouse + keyboard parity).
function prependBlankMappingRow() {
  var tbody = document.getElementById('mappings-body');
  if (!tbody) return null;
  var first = tbody.querySelector('tr');
  if (first && first.classList.contains('fb-ghost-row')) return first; // ghost already pinned
  if (first && !first.dataset.mappingId) {
    var fi = first.cells[0].querySelector('input');
    if (fi && !fi.value.trim()) return first; // activated blank, still untouched
  }
  var tr = addMappingRow({});
  tbody.insertBefore(tr, tbody.firstChild);
  tr.classList.add('fb-ghost-row');
  tr.querySelectorAll('input,select,button').forEach(function(el){ el.disabled = true; });
  return tr;
}
// Ghost → active input row: enable the fields, drop the faded styling, focus.
function activateMappingGhost(tr) {
  if (!tr || !tr.classList.contains('fb-ghost-row')) return;
  tr.classList.remove('fb-ghost-row');
  tr.querySelectorAll('input,select,button').forEach(function(el){ el.disabled = false; });
  var inp = tr.cells[0].querySelector('input');
  if (inp) inp.focus();
  if (window.FB && FB.track) FB.track.create('mapping');
}
function appendBlankMappingRow() {
  // Legacy callers (post-save/delete replenishment) now repin at top instead.
  return prependBlankMappingRow();
}
function saveMappingRow(tr) {
  var inputs = tr.querySelectorAll('input');
  var sel = tr.querySelector('select');
  var pattern = inputs[0].value.trim();
  var debitAcct = inputs[1].value.trim();
  if (!pattern || !debitAcct) {
    if (window.FB && FB.status) FB.status.show('Pattern and account required', true);
    return;
  }
  var mapping = { mapping_id: tr.dataset.mappingId || null, pattern: pattern, match_type: sel ? sel.value : 'contains', debit_account: debitAcct, description_override: inputs[2].value.trim() || null, priority: parseInt(inputs[3].value)||100, is_active: inputs[4].checked };
  var saveBtn = tr.querySelector('button.btn-sm:not(.danger)');
  if (saveBtn) { saveBtn.innerHTML='\u23F3'; saveBtn.disabled=true; }
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'mapping.upsert', companyId: COMPANY, mapping: mapping }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var d = res.data||res;
      if (d.error||res.error) {
        if (window.FB && FB.status) FB.status.show(d.error||res.error, true);
        if (saveBtn) { saveBtn.innerHTML='\u{1F4BE}'; saveBtn.disabled=false; }
      } else {
        if (d.mappingId) tr.dataset.mappingId = d.mappingId;
        if (saveBtn) { saveBtn.innerHTML='\u2713'; saveBtn.style.opacity='0.35'; saveBtn.disabled=false; setTimeout(function(){ saveBtn.innerHTML='\u{1F4BE}'; },1500); }
        if (window.FB && FB.status) FB.status.show('Saved');
      }
    })
    .catch(function(e){
      if (window.FB && FB.status) FB.status.show(e.message, true);
      if (saveBtn) { saveBtn.innerHTML='\u{1F4BE}'; saveBtn.disabled=false; }
    });
}
function deleteMappingRow(tr) {
  var mappingId = tr.dataset.mappingId;
  if (!mappingId) { tr.remove(); appendBlankMappingRow(); return; }
  var pattern = tr.cells[0].querySelector('input').value.trim();
  if (!confirm('Delete mapping "'+pattern+'"?')) return;
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'mapping.delete', companyId: COMPANY, mappingId: mappingId }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var d = res.data||res;
      if (d.error||res.error) { if (window.FB && FB.status) FB.status.show(d.error||res.error, true); }
      else { tr.remove(); appendBlankMappingRow(); }
    })
    .catch(function(e){ if (window.FB && FB.status) FB.status.show(e.message, true); });
}

function loadMappings() {
  if (window.FB && FB.status) FB.status.show('Loading…');
  document.getElementById('mappings-body').innerHTML = '';
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'mapping.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var rows = res.data || res;
      if (res.error) throw new Error(res.error);
      if (!Array.isArray(rows)) throw new Error('Unexpected response: ' + JSON.stringify(res).slice(0, 100));
      rows.forEach(addMappingRow);
      prependBlankMappingRow();
      bankMappingsDirty = false;
      if (window.FB && FB.status) FB.status.show(rows.length ? 'Mappings loaded' : 'No rules yet.');
    })
    .catch(function(e){
      if (window.FB && FB.status) FB.status.show('Error: ' + e.message, true);
      console.error('loadMappings failed:', e);
    });
}

// saveMappings replaced by per-row saveMappingRow

function attachMappingAcctDd(input) {
  if (!input || !window.FB || !FB.dropdown) return;
  FB.dropdown.attach(input, {
    keys: true,
    minWidth: 200,
    source: function (q) {
      loadBankMappingAccounts();
      q = (q || '').toLowerCase();
      return bankMappingAccounts.filter(function (a) {
        return (a.account_code||'').toLowerCase().indexOf(q) >= 0 || (a.account_name||'').toLowerCase().indexOf(q) >= 0;
      }).map(function (a) { return { primary: a.account_code, secondary: a.account_name, data: a }; });
    },
    onPick: function (it, inp) {
      inp.value = it.primary;
      inp.dispatchEvent(new Event('input', { bubbles: true })); // lights row save button
    }
  });
}
<\/script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleBankPage };
