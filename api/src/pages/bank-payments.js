'use strict';

function paymentsTabJS() {
  return `
// ========== PAYMENTS TAB — FB.list ==========
// Migrated off a hand-rolled fetch+innerHTML table (2026-09-11) — this page
// was revived after "every list in the app runs on FB.list" was already
// true everywhere else, and just never got moved onto it. Read-only
// register (payments are never hand-edited row-by-row — they're created via
// New Payment or bank-match settlement) plus one row action (void), which
// is exactly Inbox's Transactions-tab shape: editable:false + rowVerbs.
var PAYMENTS_THRESHOLD = 1000;

var paymentsList = FB.list.create({
  keysId: 'bank-payments',
  tbody: 'payments-tbody',
  companyId: function () { return COMPANY; },
  tree: false,
  canAdd: false,
  editable: function () { return false; },
  active: function () { var p = document.getElementById('tab-payments'); return !!(p && p.classList.contains('active')); },
  columns: [
    { field: 'date', sortable: true, filterType: 'date', label: 'Date',
      display: function (v) { return '<span style="white-space:nowrap" title="' + esc(String(v || '').slice(0, 10)) + '">' + FB.util.fmtDateShort(v) + '</span>'; } },
    { field: 'direction', sortable: true, filterType: 'list', label: 'Dir',
      display: function (v) { return '<span class="badge ' + (v === 'in' ? 'badge-success' : 'badge-warning') + '">' + (v === 'in' ? 'In' : 'Out') + '</span>'; } },
    { field: 'partner_name', sortable: true, filterType: 'text', label: 'Partner',
      display: function (v) { return v ? esc(v) : '<span class="pe-ro">—</span>'; } },
    { field: 'vendor_ref', sortable: true, filterType: 'text', label: 'Bill Ref',
      // Whole-row navigation doesn't map onto FB.list's row click (that's
      // reserved for edit-mode/fold), so this is a link-in-a-cell instead —
      // the same pattern Payables' Bills Reference column already uses to
      // reach a bill's own page.
      display: function (v, r) {
        if (!v) return '<span class="pe-ro">—</span>';
        if (!r.bill_id) return esc(v);
        return '<a href="/' + esc(COMPANY) + '/bill/' + esc(r.bill_id) + '" class="ref-link" onclick="event.stopPropagation()">' + esc(v) + '</a>';
      } },
    { field: 'amount', sortable: true, align: 'right', filterType: 'amount', label: 'Amount',
      display: function (v, r) { return '<span class="amt"' + (r.voided ? ' style="color:var(--text-faint);text-decoration:line-through"' : '') + '>' + FB.util.fmtAmt(v) + '</span>'; } },
    { field: 'method', sortable: true, filterType: 'list', label: 'Method',
      display: function (v) { return '<span class="badge ' + (v === 'bank_match' ? 'badge-info' : 'badge-neutral') + '">' + (v === 'bank_match' ? 'Bank Match' : 'Manual') + '</span>'; } },
    { field: 'reference', sortable: true, filterType: 'text', label: 'Reference',
      display: function (v) { return v ? esc(v) : '<span class="pe-ro">—</span>'; } },
    { field: 'status', sortable: true, filterType: 'list', label: 'Status',
      display: function (v) { return '<span class="badge ' + (v === 'voided' ? 'badge-danger' : 'badge-success') + '">' + (v === 'voided' ? 'Voided' : 'Posted') + '</span>'; } },
  ],
  hint: 'Payments: y verbs void, Enter unfolds nothing (flat list). Direction/Method/Status columns are filterable (≡) — no separate toolbar needed. The Status filter shows Voided rows — hidden by default.',
  list: {
    action: 'payment.list',
    body: function () {
      var st = window.FB && FB.period ? FB.period.get() : {};
      // No page-specific Direction/Method/Voided toolbar — those columns are
      // already sortable/filterable (≡) via FB.list itself, so a bespoke
      // set of dropdowns duplicating that was redundant. voided:true always
      // fetches the full set (the server otherwise excludes voided_at rows
      // entirely); applyFilterExpr('status:posted') below hides them by
      // default client-side instead — same "hide noise by default, recover
      // via the column's own filter" doctrine as Inbox's rejected-proposals
      // default.
      return {
        threshold: PAYMENTS_THRESHOLD,
        dateFrom: st.start || '', dateTo: st.end || '',
        voided: true
      };
    },
    tooManyMessage: function (total) {
      return total.toLocaleString() + ' payments — narrow the date range above (Period Selector) or a filter to see this list.';
    },
    map: function (r) {
      return {
        _key: r.payment_id, payment_id: r.payment_id, bill_id: r.bill_id || '',
        date: r.date || '', direction: r.direction || '', partner_name: r.partner_name || '',
        vendor_ref: r.vendor_ref || '', amount: Number(r.amount) || 0,
        method: r.method || '', reference: r.reference || '',
        voided: !!r.voided_at, status: r.voided_at ? 'voided' : 'posted'
      };
    }
  },
  rowVerbs: [
    { key: 'x', label: 'void',
      when: function (row) { return !row.voided; },
      affordance: function () { return '<a class="chip chip-cancel" title="Void" aria-label="Void" data-act="verb:x">&#10005;</a>'; },
      run: function (api, row) { voidPaymentRow(row.payment_id); } }
  ]
});
// Default view: hide voided rows (same mechanism as Inbox's default
// status:proposed filter) — the Status column's own ≡ filter reveals them.
paymentsList.applyFilterExpr('status:posted');

function voidPaymentRow(paymentId) {
  FB.modal.open({
    title: 'Void this payment?',
    body: 'A reversal journal entry will be created.',
    buttons: [
      { label: 'Cancel', onClick: function (api) { api.close(); } },
      { label: 'Void payment', danger: true, onClick: function (api) {
          api.close();
          fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'payment.void', companyId: COMPANY, paymentId: paymentId }) })
            .then(function (r) { return r.json(); })
            .then(function (res) {
              var d = res.data || res;
              if (res.error || (d && d.error)) { FB.status.show('Void failed: ' + (res.error || d.error), true); return; }
              FB.status.show('Payment voided.', false);
              paymentsList.load();
            })
            .catch(function (e) { FB.status.show('Error: ' + e.message, true); });
        } }
    ]
  });
}
`;
}

module.exports = { paymentsTabJS };
