'use strict';

function reconciliationTabJS() {
  return `
// ========== RECONCILIATION TAB — FB.list ==========
// Migrated off a hand-rolled fetch+innerHTML table (2026-09-11), same as the
// Payments tab. bank.reconcile.list/.clear (api/src/bank.js) wired up since
// issue #137; the response shape ({ rows, openingBalance }) doesn't match
// FB.list's plain { data, total } convention, so this uses a custom
// list.fetch (Inbox's fetchTxnRows precedent) rather than list.action/body.
var _reconAccountsLoaded = false;
var _reconAccount = '';
var _reconOpening = 0;

function fetchReconRows() {
  var sel = document.getElementById('recon-account');
  var accountCode = sel ? sel.value : '';
  if (!accountCode) return Promise.resolve([]);
  _reconAccount = accountCode;
  var st = window.FB && FB.period ? FB.period.get() : {};
  return fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'bank.reconcile.list', companyId: COMPANY, accountCode: accountCode, dateFrom: st.start || '', dateTo: st.end || '' }) })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      var d = res.data || res;
      if (res.error || (d && d.error)) { FB.status.show('Load failed: ' + (res.error || d.error), true); return []; }
      _reconOpening = Number((d && d.openingBalance) || 0);
      var openingEl = document.getElementById('recon-opening');
      if (openingEl) openingEl.textContent = FB.util.fmtAmt(_reconOpening);
      return ((d && d.rows) || []).map(function (r) {
        return {
          _key: r.batch_id, batch_id: r.batch_id, date: r.date || '',
          reference: r.reference || '', description: r.description || '',
          debit: Number(r.debit || 0), credit: Number(r.credit || 0), cleared: !!r.cleared
        };
      });
    })
    .catch(function (e) { FB.status.show('Error: ' + e.message, true); return []; });
}

// Running cleared-balance accumulator — computed once here from the FETCH
// order (chronological, ORDER BY date/batch_id server-side), never from
// however the table is currently sorted client-side (docs/UI.md — default
// sort order: a derived summary has to track real order, not display
// order, once a column becomes sortable).
function _updateReconSummary(saved) {
  var clearedBalance = _reconOpening;
  var unclearedCount = 0;
  saved.forEach(function (r) {
    if (r.cleared) clearedBalance += r.debit - r.credit; else unclearedCount++;
  });
  document.getElementById('recon-cleared-balance').textContent = FB.util.fmtAmt(clearedBalance);
  document.getElementById('recon-uncleared-count').textContent = String(unclearedCount);
}

var reconciliationList = FB.list.create({
  keysId: 'bank-reconciliation',
  tbody: 'recon-tbody',
  companyId: function () { return COMPANY; },
  tree: false,
  canAdd: false,
  editable: function () { return false; },
  active: function () { var p = document.getElementById('tab-reconciliation'); return !!(p && p.classList.contains('active')); },
  columns: [
    { field: 'date', sortable: true, filterType: 'date', label: 'Date',
      display: function (v) { return '<span title="' + esc(String(v || '').slice(0, 10)) + '">' + FB.util.fmtDateShort(v) + '</span>'; } },
    { field: 'reference', sortable: true, filterType: 'text', label: 'Reference',
      display: function (v) { return v ? esc(v) : '<span class="pe-ro">—</span>'; } },
    { field: 'description', sortable: true, filterType: 'text', label: 'Description',
      display: function (v) { return v ? esc(v) : '<span class="pe-ro">—</span>'; } },
    { field: 'debit', sortable: true, align: 'right', filterType: 'amount', label: 'Debit',
      display: function (v) { return v ? '<span class="amt">' + FB.util.fmtAmt(v) + '</span>' : ''; } },
    { field: 'credit', sortable: true, align: 'right', filterType: 'amount', label: 'Credit',
      display: function (v) { return v ? '<span class="amt">' + FB.util.fmtAmt(v) + '</span>' : ''; } },
    // Direct click-to-toggle, not FB.list's edit-mode machinery — the box
    // itself is the control (same immediate-mutation shape as Vendors' ~
    // toggle-active, just mouse-first here since it's the column's whole
    // reason to exist rather than an incidental verb).
    { field: 'cleared', sortable: true, align: 'center', filterType: 'list', label: 'Cleared',
      display: function (v, r) {
        var boxClass = 'recon-clear-box' + (v ? ' cleared' : '');
        return '<span class="recon-clear-cell" onclick="event.stopPropagation();toggleClear(\\'' + r.batch_id + '\\',' + (v ? 'true' : 'false') + ')"><span class="' + boxClass + '"></span></span>';
      } }
  ],
  list: { fetch: fetchReconRows, map: function (row) { return row; } },
  onLoaded: function (saved) { _updateReconSummary(saved); },
});

function initReconciliation() {
  if (_reconAccountsLoaded) { if (document.getElementById('recon-account').value) reconciliationList.load(); return; }
  _reconAccountsLoaded = true;
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'coa.list', companyId: COMPANY }) })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      var d = res.data || res;
      var accounts = Array.isArray(d) ? d : [];
      var cashAccounts = accounts.filter(function (a) { return a.cf_category === 'Cash' && a.is_active !== false; });
      var sel = document.getElementById('recon-account');
      if (!sel) return;
      if (!cashAccounts.length) {
        sel.innerHTML = '<option value="">No cash accounts</option>';
        document.getElementById('recon-tbody').innerHTML = '<tr><td colspan="7" class="table-empty">No Cash-category accounts configured (Accounting → Chart of Accounts).</td></tr>';
        return;
      }
      sel.innerHTML = cashAccounts.map(function (a) {
        return '<option value="' + esc(a.account_code) + '">' + esc(a.account_code) + ' — ' + esc(a.account_name || '') + '</option>';
      }).join('');
      var saved = null;
      try { saved = localStorage.getItem('fb.reconAccount.' + COMPANY); } catch (e) {}
      if (saved && cashAccounts.some(function (a) { return a.account_code === saved; })) sel.value = saved;
      sel.onchange = function () {
        try { localStorage.setItem('fb.reconAccount.' + COMPANY, sel.value); } catch (e) {}
        reconciliationList.load();
      };
      if (sel.value) reconciliationList.load();
    })
    .catch(function (e) { FB.status.show('Error loading accounts: ' + e.message, true); });
}

function toggleClear(batchId, wasCleared) {
  var nowCleared = !wasCleared;
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'bank.reconcile.clear', companyId: COMPANY, batchId: batchId, accountCode: _reconAccount, cleared: nowCleared }) })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      var d = res.data || res;
      if (res.error || (d && d.error)) { FB.status.show('Update failed: ' + (res.error || d.error), true); return; }
      reconciliationList.load();
    })
    .catch(function (e) { FB.status.show('Error: ' + e.message, true); });
}
`;
}

module.exports = { reconciliationTabJS };
