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
    <!-- BANK MAPPINGS — FB.list flat register (migrated 2026-07-27; the
         app's last bespoke list). The framework owns the add row (bottom
         "+ Add entry"), j/k nav (incl. add row, gg/G), edit lifecycle
         (i/Enter/click), dirty buffers (w writes, u reverts, Esc exits
         WITHOUT saving), x delete with confirm, and the shared leave-guard
         modal. Sidebar hints come from mappingsList.renderHints. -->
    <table class="edit-table" id="mappings-table">
      <thead><tr><th>Pattern</th><th>Match</th><th>Offset Account <small style="font-weight:400;color:#888">(expense/income - bank side auto-assigned)</small></th><th>Description Override</th><th>Priority</th><th style="text-align:center">Active</th></tr></thead>
      <tbody id="mappings-body">
        <tr><td colspan="6" style="text-align:center;color:#aaa;padding:24px">Loading…</td></tr>
      </tbody>
    </table>
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
  // nav-row-focus class styled app-wide). The Mappings tab is an FB.list
  // register (see BANK MAPPINGS below) with its own keys namespace
  // ('bank-mappings'), registered by FB.list at create time.
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
      // K1: '~' is the ratified universal toggle verb (Vendors toggle-active
      // precedent; vim's own toggle-case key) — migrated from 'c' 2026-07-28.
      { key: '~', mode: 'NORMAL', hint: 'clear/unclear', hintBar: true,
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

  // ── Mappings tab keyboard: now owned by FB.list (see BANK MAPPINGS below).
  // The bespoke ghost-row cursor + click listener were deleted with the
  // per-row-input table when Mappings migrated onto FB.list (2026-07-27).


  function fmt(n) { return parseFloat(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }

// ========== BANK TAB SWITCHER ==========
function showBankTab(t) {
  ['txn','mappings'].forEach(function(id) {
    document.getElementById('bank-panel-' + id).style.display = (id === t) ? '' : 'none';
    var tabEl = document.getElementById('bank-tab-' + id);
    if (tabEl) tabEl.classList.toggle('active', id === t);
  });
  if (t === 'mappings') mappingsList.load();
  // Sidebar hints follow the active tab's FB.keys set. The Mappings tab's
  // bindings are auto-registered by FB.list at create time; mappingsList
  // .renderHints emits the j/k/i/Enter/x/w/Esc table into #sb-hints.
  var hints = document.getElementById('sb-hints');
  if (hints) {
    if (t === 'txn') FB.keys.renderHints('bank', hints, { layout: 'list' });
    else mappingsList.renderHints(hints);
  }
}

// ========== BANK MAPPINGS — FB.list flat register (migrated 2026-07-27;
// the app's LAST bespoke list — every list now runs on the one FB.list
// machine, fb-list-ux-spec §1). ==========
// Bank-import mapping rules: pattern -> offset (debit) account. The framework
// owns the add row (bottom "+ Add entry"), nav (j/k incl. add row, gg/G), edit
// lifecycle (i/Enter/click), dirty buffers (w writes, u reverts, Esc exits
// WITHOUT saving), x delete with confirm, column = filters, and the shared
// leave-guard modal. Server actions (untouched): mapping.list / mapping.upsert
// / mapping.delete. The legacy per-row-input table, ghost create-row pinned at
// top, activateMappingGhost machinery, bespoke 'bank-mappings' keys block, and
// #mappings-body ghost-row click listener were all deleted with this migration.
var bankMappingAccounts = [];
function loadBankMappingAccounts() {
  if (bankMappingAccounts.length) return;
  fetch('/api/' + COMPANY + '/accounts').then(function(r){ return r.json(); }).then(function(rows){
    bankMappingAccounts = Array.isArray(rows) ? rows : [];
  }).catch(function(){});
}
function mappingAttachAcct(inp) {
  loadBankMappingAccounts();
  FB.dropdown.attach(inp, {
    source: function(q) {
      q = (q || '').trim().toLowerCase();
      return bankMappingAccounts.filter(function(a) {
        if (!q) return true;
        return (a.account_code || '').toLowerCase().indexOf(q) >= 0 ||
               (a.account_name || '').toLowerCase().indexOf(q) >= 0;
      }).map(function(a) {
        return { primary: a.account_code, secondary: a.account_name || '', data: { code: a.account_code } };
      });
    },
    onPick: function(item, input) {
      input.value = item.data.code;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

var mappingsList = FB.list.create({
  keysId: 'bank-mappings',
  active: function() {
    var p = document.getElementById('bank-panel-mappings');
    return !!(p && p.style.display !== 'none');
  },
  tbody: 'mappings-body',
  companyId: function() { return COMPANY; },
  hint: 'Bank-import mapping rules. Lower priority = applied first. Match types: contains, exact, starts_with, regex. The offset account is the expense (outflow) / income (inflow) side; the bank account is supplied at import time from the amount sign.',
  columns: [
    { field: 'pattern', type: 'text', width: 150, sortable: true },
    { field: 'match_type', type: 'select', width: 100, options: ['contains','exact','starts_with','regex'], filterType: 'list' },
    { field: 'debit_account', type: 'text', width: 140, attach: mappingAttachAcct },
    { field: 'description_override', type: 'text', width: 170, nullable: true },
    { field: 'priority', type: 'number', width: 60, align: 'right' },
    { field: 'is_active', type: 'checkbox', align: 'center',
      display: function(v) { return v ? 'Yes' : 'No'; } }
  ],
  blank: function() { return { pattern: '', match_type: 'contains', debit_account: '', description_override: '', priority: 100, is_active: true }; },
  isBlank: function(b) { return !b.pattern && !b.debit_account; },
  same: function(b, s) {
    return b.pattern === (s.pattern || '')
      && b.match_type === (s.match_type || 'contains')
      && b.debit_account === (s.debit_account || '')
      && (b.description_override || '') === (s.description_override || '')
      && (b.priority != null ? b.priority : 100) === (s.priority != null ? s.priority : 100)
      && b.is_active === !!s.is_active;
  },
  validate: function(d) {
    if (!d.pattern) return 'Pattern required.';
    if (!d.debit_account) return 'Offset account required.';
    return null;
  },
  firstField: function() { return 'pattern'; },
  track: 'mapping',
  list: { action: 'mapping.list',
    map: function(m) { return { mapping_id: m.mapping_id, pattern: m.pattern || '', match_type: m.match_type || 'contains', debit_account: m.debit_account || '', description_override: m.description_override || '', priority: m.priority != null ? m.priority : 100, is_active: m.is_active !== false, _key: m.mapping_id }; } },
  save: { action: 'mapping.upsert',
    body: function(d) { return { mapping: { mapping_id: d._isNew ? null : d._key, pattern: d.pattern, match_type: d.match_type || 'contains', debit_account: d.debit_account, description_override: d.description_override || null, priority: parseInt(d.priority, 10) || 100, is_active: d.is_active !== false } }; },
    focusKey: function(d, res) { return d._isNew ? (res.mappingId || d._key) : d._key; } },
  del: { action: 'mapping.delete',
    body: function(d) { return { mappingId: d._key }; },
    confirm: function(d) { return 'Delete mapping "' + (d.pattern || d._key) + '"?'; } }
});
<\/script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleBankPage };
