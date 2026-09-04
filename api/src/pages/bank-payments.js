'use strict';

function paymentsTabJS() {
  return `
// ========== PAYMENTS TAB — plain fetched table, not FB.list ==========
// Read-only register (payments are never hand-edited row-by-row — they're
// created via New Payment or bank-match settlement) plus one row action
// (void). FB.list's edit/dirty-buffer machinery has nothing to do here, so
// this mirrors the simpler pattern payables-bills.js already uses for the
// per-bill payment-history child rows (plain fetch + render + a void
// button), just company-wide instead of scoped to one bill's tree.
var PAYMENTS_THRESHOLD = 1000;
var _paymentsLoadSeq = 0;
var _paymentsDebounce = null;
function _debouncedLoadPayments() {
  clearTimeout(_paymentsDebounce);
  _paymentsDebounce = setTimeout(loadPayments, 250);
}

function paymentsMsg(msg, type) {
  var el = document.getElementById('msg-payments');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'err' ? '#cc2222' : type === 'ok' ? '#2a8a2a' : '#888';
}

function fmtDateShortPay(d) {
  if (!d) return '';
  var s = String(d).slice(0, 10);
  var parts = s.split('-');
  if (parts.length !== 3) return s;
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return parseInt(parts[2], 10) + ' ' + MONTHS[parseInt(parts[1], 10) - 1];
}

function loadPayments() {
  var tbody = document.getElementById('payments-tbody');
  if (!tbody) return;
  var seq = ++_paymentsLoadSeq;
  var st = window.FB && FB.period ? FB.period.get() : {};
  var body = {
    action: 'payment.list', companyId: COMPANY,
    threshold: PAYMENTS_THRESHOLD,
    dateFrom: st.start || '', dateTo: st.end || '',
    direction: (document.getElementById('pf-direction') || {}).value || '',
    method: (document.getElementById('pf-method') || {}).value || '',
    voided: !!(document.getElementById('pf-voided') || {}).checked
  };
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (seq !== _paymentsLoadSeq) return; // stale response — a newer request already landed
      var d = res.data || res;
      if (res.error || (d && d.error)) { tbody.innerHTML = ''; paymentsMsg('Load failed: ' + (res.error || d.error), 'err'); return; }
      var rows = (d && d.data) || [];
      var total = d && d.total;
      if (d && d.tooMany) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#aaa;padding:32px">'
          + (total || 0).toLocaleString() + ' payments \u2014 narrow the date range above (Period Selector) or a filter to see this list.</td></tr>';
        return;
      }
      var q = ((document.getElementById('pf-search') || {}).value || '').trim().toLowerCase();
      if (q) {
        rows = rows.filter(function (r) {
          return (r.partner_name || '').toLowerCase().indexOf(q) >= 0
              || (r.reference || '').toLowerCase().indexOf(q) >= 0
              || (r.vendor_ref || '').toLowerCase().indexOf(q) >= 0;
        });
      }
      renderPayments(rows);
      paymentsMsg('', '');
    })
    .catch(function (e) { if (seq !== _paymentsLoadSeq) return; tbody.innerHTML = ''; paymentsMsg('Error: ' + e.message, 'err'); });
}

function renderPayments(rows) {
  var tbody = document.getElementById('payments-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#aaa;padding:32px">No payments in range.</td></tr>';
    return;
  }
  var html = rows.map(function (r) {
    var voided = !!r.voided_at;
    var dirBadge = '<span class="badge badge-' + (r.direction || 'out') + '">' + (r.direction === 'in' ? 'In' : 'Out') + '</span>';
    var methodBadge = '<span class="badge badge-' + (r.method || 'manual') + '">' + (r.method === 'bank_match' ? 'Bank Match' : 'Manual') + '</span>';
    var amt = Number(r.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // Status is always a real status badge — Void is a hover-only action
    // appended after it (mirrors Bills tab's .pay-afford), never the sole
    // content of the "Status" cell (a bare action button there read as if
    // "Void" were itself a status value).
    var statusCell = voided
      ? '<span class="badge badge-voided">Voided</span>'
      : '<span class="badge badge-posted">Posted</span>'
        + '<button class="void-afford" onclick="event.stopPropagation();voidPaymentRow(\\'' + r.payment_id + '\\')">Void</button>';
    var url = r.bill_id ? ('/' + COMPANY + '/bill/' + encodeURIComponent(r.bill_id)) : '';
    return '<tr' + (url ? ' data-url="' + url + '" onclick="window.fbNavigate ? window.fbNavigate(\\'' + url + '\\') : (window.location.href=\\'' + url + '\\')"' : '') + '>'
      + '<td>' + esc(fmtDateShortPay(r.date)) + '</td>'
      + '<td>' + dirBadge + '</td>'
      + '<td>' + esc(r.partner_name || '\u2014') + '</td>'
      + '<td>' + esc(r.vendor_ref || '\u2014') + '</td>'
      + '<td style="text-align:right; font-variant-numeric:tabular-nums;' + (voided ? 'color:#aaa;text-decoration:line-through' : '') + '">' + amt + '</td>'
      + '<td>' + methodBadge + '</td>'
      + '<td>' + esc(r.reference || '\u2014') + '</td>'
      + '<td>' + statusCell + '</td>'
      + '</tr>';
  }).join('');
  tbody.innerHTML = html;
}

function voidPaymentRow(paymentId) {
  if (!confirm('Void this payment? A reversal journal entry will be created.')) return;
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'payment.void', companyId: COMPANY, paymentId: paymentId }) })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      var d = res.data || res;
      if (res.error || (d && d.error)) { paymentsMsg('Void failed: ' + (res.error || d.error), 'err'); return; }
      paymentsMsg('Payment voided.', 'ok');
      loadPayments();
    })
    .catch(function (e) { paymentsMsg('Error: ' + e.message, 'err'); });
}
`;
}

module.exports = { paymentsTabJS };
