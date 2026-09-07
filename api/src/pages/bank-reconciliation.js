'use strict';

function reconciliationTabJS() {
  return `
// ========== RECONCILIATION TAB ==========
// Wires up bank.reconcile.list/.clear (api/src/bank.js) — orphaned since the
// old Bank page was deleted (issue #137, 2026-08-09), zero callers until now.
// Not FB.list, not a fetched read-only report fragment (unlike Aging/Control)
// either — it's a mutating, per-line clear/uncleared workflow, so it gets its
// own small interactive table (closest precedent: Accounting's Integrity tab,
// a plain fetched table per ia-restructure-3-spec.md §3.3, plus a click handler).
var _reconAccountsLoaded = false;
var _reconRows = [];
var _reconAccount = '';

function reconMsg(msg, type) {
  var el = document.getElementById('msg-recon');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'err' ? 'var(--danger)' : type === 'ok' ? 'var(--success)' : 'var(--text-muted)';
}

function fmtDateShortRecon(d) {
  if (!d) return '';
  var s = String(d).slice(0, 10);
  var parts = s.split('-');
  if (parts.length !== 3) return s;
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return parseInt(parts[2], 10) + ' ' + MONTHS[parseInt(parts[1], 10) - 1];
}

function initReconciliation() {
  if (_reconAccountsLoaded) { loadReconciliation(); return; }
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
        document.getElementById('recon-tbody').innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-faint);padding:32px">No Cash-category accounts configured (Accounting → Chart of Accounts).</td></tr>';
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
        loadReconciliation();
      };
      loadReconciliation();
    })
    .catch(function (e) { reconMsg('Error loading accounts: ' + e.message, 'err'); });
}

function loadReconciliation() {
  var sel = document.getElementById('recon-account');
  var accountCode = sel ? sel.value : '';
  if (!accountCode) return;
  _reconAccount = accountCode;
  var st = window.FB && FB.period ? FB.period.get() : {};
  var tbody = document.getElementById('recon-tbody');
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-faint);padding:32px">Loading&#8230;</td></tr>';
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'bank.reconcile.list', companyId: COMPANY, accountCode: accountCode, dateFrom: st.start || '', dateTo: st.end || '' }) })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      var d = res.data || res;
      if (res.error || (d && d.error)) { tbody.innerHTML = ''; reconMsg('Load failed: ' + (res.error || d.error), 'err'); return; }
      _reconRows = (d && d.rows) || [];
      document.getElementById('recon-opening').textContent = Number((d && d.openingBalance) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      renderReconciliation();
      reconMsg('', '');
    })
    .catch(function (e) { tbody.innerHTML = ''; reconMsg('Error: ' + e.message, 'err'); });
}

function renderReconciliation() {
  var tbody = document.getElementById('recon-tbody');
  var opening = Number((document.getElementById('recon-opening').textContent || '0').replace(/,/g, '')) || 0;
  if (!_reconRows.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-faint);padding:32px">No activity in range.</td></tr>';
    document.getElementById('recon-cleared-balance').textContent = opening.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('recon-uncleared-count').textContent = '0';
    return;
  }
  var clearedBalance = opening;
  var unclearedCount = 0;
  var html = _reconRows.map(function (r) {
    var debit = Number(r.debit || 0), credit = Number(r.credit || 0);
    if (r.cleared) clearedBalance += debit - credit; else unclearedCount++;
    var boxClass = 'recon-clear-box' + (r.cleared ? ' cleared' : '');
    return '<tr>'
      + '<td>' + esc(fmtDateShortRecon(r.date)) + '</td>'
      + '<td>' + esc(r.reference || '—') + '</td>'
      + '<td>' + esc(r.description || '—') + '</td>'
      + '<td style="text-align:right; font-variant-numeric:tabular-nums;">' + (debit ? debit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '') + '</td>'
      + '<td style="text-align:right; font-variant-numeric:tabular-nums;">' + (credit ? credit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '') + '</td>'
      + '<td class="recon-clear-cell" onclick="toggleClear(\\'' + r.batch_id + '\\',' + (r.cleared ? 'true' : 'false') + ')"><span class="' + boxClass + '"></span></td>'
      + '</tr>';
  }).join('');
  tbody.innerHTML = html;
  document.getElementById('recon-cleared-balance').textContent = clearedBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.getElementById('recon-uncleared-count').textContent = String(unclearedCount);
}

function toggleClear(batchId, wasCleared) {
  var nowCleared = !wasCleared;
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'bank.reconcile.clear', companyId: COMPANY, batchId: batchId, accountCode: _reconAccount, cleared: nowCleared }) })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      var d = res.data || res;
      if (res.error || (d && d.error)) { reconMsg('Update failed: ' + (res.error || d.error), 'err'); return; }
      var row = _reconRows.filter(function (r) { return r.batch_id === batchId; })[0];
      if (row) row.cleared = nowCleared;
      renderReconciliation();
    })
    .catch(function (e) { reconMsg('Error: ' + e.message, 'err'); });
}
`;
}

module.exports = { reconciliationTabJS };
