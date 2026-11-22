'use strict';

// billsTabJS(flags) — emits the Payables > Bills client JS.
//
// Relevance flags (settings-ux-spec §7 item 9 + fx-automation-spec §1) gate
// whole UI surfaces SERVER-SIDE so nothing flashes:
//   - vatRegistered=false → no per-line VAT code column, no per-code tax
//     footer rows.
//   - fxTracking='off'    → FX_ON is false (kept for the emitted constant).
//
// The list is read-only (#312, 2026-11-22): bills are created and edited only
// on the full bill page (bill-edit.js, /bill/new and /bill/:id). Enter opens a
// bill, Space folds its lines, + Add bill opens /bill/new.
//
// flags is { vatRegistered, fxTracking, baseCurrency }. When absent the full UI
// renders (the safe superset — matches pre-flag behavior for unguarded callers).
function billsTabJS(flags) {
  const f = flags || {};
  const vatOn = f.vatRegistered !== false;
  const fxOn = f.fxTracking !== 'off';
  // Client-readable booleans inlined into the emitted JS (single source of
  // truth — no second fetch, no window.__fbFlags re-read at render time).
  const VAT_ON = vatOn ? 'true' : 'false';
  const FX_ON = fxOn ? 'true' : 'false';
  return `
// Relevance flags (settings-ux-spec §7 item 9 + fx-automation-spec §1).
// Inlined server-side from getRelevanceFlags — VAT_ON gates the per-line VAT
// code column + per-code footers.
var VAT_ON = ${VAT_ON};
var FX_ON = ${FX_ON};
// ========== BILLS STATE ==========
// Page-level state retained by the FB.list Bills screen. The bespoke
// render/draft/filter/sort/pagination/nav machinery was deleted in Task 7;
// FB.list owns the table render, fold state, dirty buffer, sort, and column
// filters. What remains here: KPI/period inputs and the CCY-visibility display
// hook.
// AP Control drill-through ("Bills (N)" / "Posted" / "Paid" cells link here
// with ?billIds=id1,id2,...): read once at load so the very first
// billsList.load() (fired by FB.period.onChange during init) already asks
// for exactly that set — unconstrained by the global Period Selector's
// current date range, since the promise is "exactly these bills", not
// "these bills, if they happen to be in range".
var deepLinkBillIds = (function () {
  try {
    var raw = new URLSearchParams(window.location.search).get('billIds');
    return raw ? raw.split(',').filter(Boolean) : null;
  } catch (e) { return null; }
})();
var allPeriods = []; // loaded on init for popup period check
var today = new Date().toISOString().slice(0,10);
var in7days = new Date(Date.now() + 7*24*3600*1000).toISOString().slice(0,10);
var taxCodeMap = {}; // vat_code -> description
var taxCodeRateMap = {}; // vat_code -> { rate, is_reverse_charge } (for GST default computation)

var AVATAR_COLORS = ['var(--avatar-1)','var(--avatar-2)','var(--avatar-3)','var(--avatar-4)','var(--avatar-5)','var(--avatar-6)','var(--avatar-7)','var(--avatar-8)'];

// bill-post-payment-consolidation-spec.md §3: the inline single-bill pay-row
// and multi-pay panel (both retained here through P1-9/P1-9b) are retired in
// favor of the New Payment page (payment-new.js) — reachable from the '+' New
// menu (unscoped) or 'y' on a posted/partial row (scoped to that bill, §2 of
// the spec below). goToNewPayment is the one navigation helper both call.
function goToNewPayment(billId) {
  fbNavigate('/' + COMPANY + '/payment/new' + (billId ? ('?billId=' + encodeURIComponent(billId)) : ''));
}
// ========== PAGE INIT ==========
// ========== DATE-RANGE INIT — retired (global-period-selector-chrome-spec §5)
// The bill list date range is now resolved by the global Period Selector
// (FB.period). The ?dateFrom=/?dateTo= URL params are handled by
// FB.period._resolve. No local init function needed. ==========

// Setup-state spanning row — same pattern as FB.list's renderTooMany: one
// <tr><td colspan> with the message, followed by the add row (display-only;
// not click-wired, consistent with the tooMany state).
function renderBillsSetupState() {
  var tb = document.getElementById('bills-tbody');
  if (!tb) return;
  tb.innerHTML = '<tr class="fb-toomany-row"><td colspan="9">No accounting periods configured yet.</td></tr>'
    + '<tr class="fb-add-row"><td class="fb-add-cell" colspan="9">+ Add bill</td></tr>';
}

function fbPageInitPayables() {
  loadPeriods();
  // Reload bills when the global period changes (global-period-selector-chrome-spec §5).
  FB.period.onChange(function () { billsList.load(); });
  // Sidebar hint panel is generated from the same binding table that drives
  // dispatch (P1-3/P1-6: single source of truth — cannot go stale).
  renderPayHints('bills');

  // vatRegistered=false (VAT_ON): no tax codes exist for the company — skip the
  // fetch entirely; maps stay empty and every VAT surface below renders nothing.
  if (VAT_ON) {
  fetch('/api/' + COMPANY + '/vat-codes')
    .then(function(r){ return r.json(); })
    .then(function(codes){
      if (Array.isArray(codes)) {
        codes.forEach(function(c){
          taxCodeMap[c.vat_code] = c.description || c.vat_code;
          taxCodeRateMap[c.vat_code] = { rate: Number(c.rate) || 0, is_reverse_charge: !!c.is_reverse_charge };
        });
      }
    })
    .catch(function(){});
  }
}
window.addEventListener('DOMContentLoaded', fbPageInitPayables);
window.fbPageInit = fbPageInitPayables;
// ========== DATA LOADING ==========
function loadPeriods() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'period.list', companyId: COMPANY }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    var rows = res.data || res || [];
    allPeriods = Array.isArray(rows) ? rows : [];
    // Zero periods: FB.period never resolves a range (fb-core.js _init only
    // calls period.set()/fires onChange when periods.length > 0), so
    // billsList.load() — normally triggered by FB.period.onChange — never
    // runs and the table is stuck on its server-rendered "Loading…" row
    // forever. Render the setup state directly instead of waiting for a
    // period-change event that will never come.
    if (allPeriods.length === 0) renderBillsSetupState();
  }).catch(function(){});
}

function loadFxRatesForKpi(callback, bills) {
  // Collect distinct foreign currencies from bills (exclude base currency).
  var ccys = {};
  (bills || []).forEach(function (b) {
    var c = b.currency || '';
    if (c && c !== BASE_CURRENCY) ccys[c] = 1;
  });
  var list = Object.keys(ccys);
  if (!list.length) { callback({}); return; }

  // Fetch the effective rate for each currency via fx.rates.get (threshold-free,
  // one currency at a time — fx.rates.list now requires foreignCurrency + threshold).
  var today = new Date().toISOString().slice(0, 10);
  var rateMap = {};
  var done = 0;
  list.forEach(function (ccy) {
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'fx.rates.get', companyId: COMPANY, fromCurrency: ccy, toCurrency: BASE_CURRENCY, date: today }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var data = res.data || res;
      var rate = data ? data.rate : null;
      if (rate != null) {
        rateMap[ccy + '_' + BASE_CURRENCY] = { rate: Number(rate), date: data.rateDate || null };
      }
    })
    .catch(function(){})
    .then(function(){
      done++;
      if (done === list.length) callback(rateMap);
    });
  });
}

function convertToBase(amt, currency, rateMap) {
  if (!currency || currency === BASE_CURRENCY) return amt;
  var key = currency + '_' + BASE_CURRENCY;
  if (rateMap[key]) return amt * rateMap[key].rate;
  var invKey = BASE_CURRENCY + '_' + currency;
  if (rateMap[invKey] && rateMap[invKey].rate) return amt / rateMap[invKey].rate;
  return amt;
}

// ========== KPI FUNCTIONS ==========
function computeKpis(bills, rateMap) {
  rateMap = rateMap || {};
  var outstandingAmt = 0, outstandingN = 0;
  var overdueAmt = 0, overdueN = 0;
  var upcomingAmt = 0, upcomingN = 0;
  bills.forEach(function(b) {
    if (b.status !== 'posted') return;
    var amt = convertToBase(Number(b.amount || 0), b.currency, rateMap);
    var due = b.due_date ? String(b.due_date).slice(0,10) : null;
    var isOverdue = due && due < today;
    outstandingAmt += amt; outstandingN++;
    if (isOverdue) { overdueAmt += amt; overdueN++; }
    else if (due && due <= in7days) { upcomingAmt += amt; upcomingN++; }
  });
  setText('kpi-outstanding', FB.util.fmtAmt(outstandingAmt));
  setText('kpi-outstanding-count', outstandingN + ' bill' + (outstandingN !== 1 ? 's' : ''));
  setText('kpi-overdue', FB.util.fmtAmt(overdueAmt));
  setText('kpi-overdue-count', overdueN + ' bill' + (overdueN !== 1 ? 's' : ''));
  setText('kpi-upcoming', FB.util.fmtAmt(upcomingAmt));
  setText('kpi-upcoming-count', upcomingN + ' bill' + (upcomingN !== 1 ? 's' : ''));
}

function setText(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = text;
}
// Conditional CCY column: when every visible bill shares one currency the
// column carries no information — hide it (agreed 2026-07-21). It returns
// automatically whenever the list is mixed. EXCEPTION (2026-07-22): never hide while a currency filter
// is active — the column's ≡ is the only way to SEE and CLEAR that filter;
// hiding it trapped users (had to reload to get foreign bills back).
// _refreshCcyVisibility is DOM-driven (reads the currently rendered parent
// rows) so it stays correct after in-place row removals (x delete), row
// conversions (Esc save), and full re-renders alike.
var _singleCcy = false;
function _applyCcyColVisibility() {
  var tbl = document.getElementById('bills-table');
  if (!tbl) return;
  // Never hide while ANY filter is active — a hidden column's ≡ is the only
  // way to see/clear its filter (2026-07-22 doctrine, restored post-migration).
  var filtering = !!(window.billsList && billsList.anyFilterActive && billsList.anyFilterActive());
  var hide = _singleCcy && !filtering;
  tbl.classList.toggle('single-ccy', hide);
  // Column widths are owned by CSS (col.col-* classes + .single-ccy
  // re-weighting rules) — no JS width juggling here.
}
// Data-driven: the framework's rows carry no data-currency attributes, so
// read the mapped saved rows (onLoaded) instead of the DOM. Re-applied per
// render via cfg.onChrome (filter changes).
function _refreshCcyVisibility(saved) {
  var rows = saved || [];
  var ccys = {};
  rows.forEach(function (r) { ccys[(r.currency || '').toUpperCase()] = 1; });
  _singleCcy = rows.length > 0 && Object.keys(ccys).length === 1;
  _applyCcyColVisibility();
}
// ========== UTILITY FUNCTIONS ==========
function partnerCell(name) {
  if (!name) return '<span style="color:var(--text-faint)">—</span>';
  var initials = name.trim().split(/\\s+/).map(function(w){ return w[0]; }).slice(0,2).join('').toUpperCase();
  var color = AVATAR_COLORS[Math.abs(hashStr(name)) % AVATAR_COLORS.length];
  return '<div class="partner-cell">'
    + '<span class="avatar" style="background:' + color + '">' + esc(initials) + '</span>'
    + '<span>' + esc(name) + '</span>'
    + '</div>';
}

function hashStr(s) {
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

// fmtDate/fmtDateShort now live once in fb-core.js (FB.util) — promoted
// 2026-09-11, this file's copies were a byte-identical unpromoted duplicate.
var fmtDate = FB.util.fmtDate;
var fmtDateShort = FB.util.fmtDateShort;

// Posted-vs-draft visual language (docs/UI.md Components): every status
// except 'draft' is locked once posted — the 🔒 is a second, non-color-
// dependent signal of that, matching bill-edit.js's statusBadge().
function statusBadge(status, dueDate) {
  // 'partial' is no longer a stored status (2026-09-15) — payment progress
  // shows via the Outstanding column instead, so status stays a simple
  // lifecycle (Draft/Rejected/Open/Paid/Void) and Overdue is purely a
  // due-date flag on an open bill, whether or not it's been partly paid.
  var isOverdue = status === 'posted' && dueDate && String(dueDate).slice(0,10) < today;
  if (isOverdue) return '<span class="badge badge-danger">🔒 Overdue</span>';
  if (status === 'draft')   return '<span class="badge badge-neutral">Draft</span>';
  if (status === 'rejected') return '<span class="badge badge-danger">Rejected</span>';
  if (status === 'posted')  return '<span class="badge badge-info">🔒 Open</span>';
  if (status === 'paid')    return '<span class="badge badge-success">🔒 Paid</span>';
  if (status === 'void')    return '<span class="badge badge-neutral">🔒 Void</span>';
  return '<span class="badge badge-neutral">' + esc(status||'') + '</span>';
}
// esc now comes from fb-core.js (window.esc) — P1-3 shared core

// ========== FB.list cfg (Bills → tree) — the Bills tab's list machine ==========
// Declarative FB.list.create config; the bespoke render/draft/filter/fold/nav
// machinery was deleted in Task 7 — this cfg IS the Bills tab now.
//
// payAffordHtml(r) — the hover "Pay" affordance on posted/partial bills
// (extracted from the old renderPage cell). Opens New Payment scoped to this
// bill (bill-post-payment-consolidation-spec.md §3) — same destination 'y'
// reaches (§2); this is the mouse-only path onto it.
//
// Icon, not a text label (2026-09-16): reuses Inbox's existing .chip
// vocabulary (common.css) instead of a bespoke button — checkmark/chip-ok
// is the same "forward/confirm action on this row" glyph Inbox's Approve
// already uses, so Pay costs the user nothing new to learn. .row-afford is
// the hover-only-visibility half (kept generic — any row action on a dense
// register, not payment-specific); the .chip/.chip-ok look is shared and
// global, same icon anywhere the app has a forward-action chip.
function payAffordHtml(r) {
  return '<a class="chip chip-ok row-afford" title="Record payment" onclick="event.stopPropagation();_payAffordClick(this)">&#10003;</a>';
}
function _payAffordClick(btn) {
  var tr = btn.closest('tr');
  while (tr && tr.dataset && tr.dataset.childOf) tr = tr.previousElementSibling;
  if (!tr) return;
  var key = tr.dataset && tr.dataset.key;
  if (key == null) return;
  var bill = billsList.rowByKey(String(key));
  if (bill) goToNewPayment(bill.bill_id);
}

// writeOffAffordHtml(r) — the hover "write off" affordance, same mouse-
// parity role for 'W' that payAffordHtml is for 'y'/Pay. Only offered where
// 'W' itself would fire (posted, some outstanding) — the materiality gate
// is enforced server-side either way. Plain .chip (no color modifier) —
// write-off is neither the forward action (chip-ok/✓, Pay) nor the
// cancel/reject action (chip-cancel/✕, Void) — same "third, neutral kind
// of action" role Inbox's ✎ Correct-&-Resubmit already plays.
function writeOffAffordHtml(r) {
  if (r.status !== 'posted') return '';
  if ((Number(r.amount || 0) - Number(r.amount_paid || 0)) <= 0.005) return '';
  return '<a class="chip row-afford" title="Write off remaining balance" onclick="event.stopPropagation();_writeOffAffordClick(this)">&#8776;</a>';
}
function _writeOffAffordClick(btn) {
  var tr = btn.closest('tr');
  while (tr && tr.dataset && tr.dataset.childOf) tr = tr.previousElementSibling;
  if (!tr) return;
  var key = tr.dataset && tr.dataset.key;
  if (key == null) return;
  var bill = billsList.rowByKey(String(key));
  if (bill) writeOffBill(bill);
}
// Write off (2026-09-15) — closes a small remaining outstanding balance
// with no real payment (DR AP / CR the company's Write-off account).
// Client only checks the cheap, obvious preconditions (posted, some
// outstanding); the materiality threshold itself is enforced server-side
// (bills.js writeOffBill) and its rejection message is shown verbatim — it
// already names the exact amounts, no reason to re-derive them here.
// Top-level (not inside extraBindings' closure) so both the 'W' keybinding
// and the hover button above can reach it; reloadBills()'s own body
// (billChildCache={}; billsList.load()) is inlined since both are
// already top-level vars — no need for the closure just for that.
function writeOffBill(p) {
  if (p.status !== 'posted') { FB.status.show('Only a posted bill can be written off.', true); return; }
  var outstanding = Number(p.amount || 0) - Number(p.amount_paid || 0);
  if (outstanding <= 0.005) { FB.status.show('Bill has no outstanding balance to write off.', true); return; }
  var partner = esc(p.partner_name || p.bill_id);
  var amtStr = FB.util.fmtAmt(outstanding) + ' ' + esc(p.currency || '');
  FB.modal.open({
    title: 'Write off this bill?',
    body: 'Close the remaining ' + amtStr + ' outstanding on the bill from "' + partner + '" with no real payment — posts a journal entry to the Write-off account. This cannot be undone (void the resulting entry from Bank → Payments to reverse it).',
    buttons: [
      { label: 'Cancel', onClick: function (api) { api.close(); } },
      { label: 'Write off', danger: true, onClick: function (api) {
          api.close();
          fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'bill.write_off', companyId: COMPANY, billId: p.bill_id }) })
            .then(function (r) { return r.json(); })
            .then(function (res) {
              var d = res.data || res;
              var err = res.error || (d && d.error);
              if (err) { FB.status.show('Write-off failed: ' + (err.message || err), true); return; }
              FB.status.show('Bill written off', false); billChildCache = {}; billsList.load();
            })
            .catch(function (e) { FB.status.show('Write-off failed: ' + e.message, true); });
        } }
    ]
  });
}

// ========== Task 6b — children accessor + childRowHtml (lazy fold) ==========
// billChildCache[_key] = { lines: [...], payments: [...], fetched: bool,
//   fetching: bool }. The framework calls cfg.children(row) SYNCHRONOUSLY
// during render (merged()→childrenOf), so this accessor returns the cached
// rows when already resolved and otherwise returns [] and kicks off a
// background fetch of bill.lines (+ bill.payments for posted/partial/paid).
// On resolution the cache is filled and billsList.render() re-runs so the
// fold re-renders with the now-pre-resolved children (the next children()
// call returns them synchronously). This is the pre-resolved pattern: the
// first unfold shows an empty fold that fills in on the next render tick.
var billChildCache = {};

function billsChildren(row) {
  var k = row._key;
  var c = billChildCache[k];
  if (c && c.fetched) return billsMergeChildRows(c, row);
  // First touch (or a fetch is already in flight): return [] now and trigger
  // a re-render when the data lands. Idempotent — only the first call spawns
  // the fetch; later calls while fetching just re-read the (still-empty)
  // cache and return [].
  if (!c) {
    billChildCache[k] = { lines: [], payments: [], fetched: false, fetching: true };
    billsFetchChildren(row);
  }
  return [];
}

function billsFetchChildren(row) {
  var k = row._key;
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'bill.lines', companyId: COMPANY, billId: row.bill_id }) })
  .then(function (r) { return r.json(); })
  .then(function (res) {
    var lines = (res && res.data) ? res.data : (res || []);
    if (!Array.isArray(lines)) lines = [];
    var entry = billChildCache[k] || (billChildCache[k] = { lines: [], payments: [], fetched: false });
    entry.lines = lines;
    var needsPayments = row.status === 'posted' || row.status === 'paid';
    if (!needsPayments) { entry.fetched = true; entry.fetching = false; billsList.render(); return; }
    fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'payment.list', companyId: COMPANY, billId: row.bill_id }) })
    .then(function (pr) { return pr.json(); })
    .then(function (pres) {
      var payments = (pres && pres.data) ? pres.data : (pres || []);
      if (!Array.isArray(payments)) payments = [];
      entry.payments = payments;
      entry.fetched = true; entry.fetching = false;
      billsList.render();
    })
    .catch(function () { entry.fetched = true; entry.fetching = false; billsList.render(); });
  })
  .catch(function () {
    var entry = billChildCache[k];
    if (entry) { entry.fetched = true; entry.fetching = false; }
    billsList.render();
  });
}

// billsMergeChildRows(cache, parent) — builds the flat ordered list of child
// row objects the framework flattens under the parent. Mirrors the row order
// emitted by today's toggleBillLines (L918–1058): draft → line rows; posted →
// expense lines, then the grouped tax lines (one DR per VAT code — 2026-07-26),
// then payment history rows. Each child carries a _kind tag the renderer switches on.
function billsMergeChildRows(cache, parent) {
  var lines = cache.lines || [];
  var payments = cache.payments || [];
  if (!lines.length && !payments.length) return [{ _kind: 'empty' }];
  var out = [];
  if (parent.status === 'draft') {
    lines.forEach(function (l) {
      out.push({ _kind: 'draft-line', entry_id: l.entry_id || '',
        description: l.description || '', amount: Number(l.amount || 0),
        expense_account: l.expense_account || l.account_code || '',
        vat_code: l.vat_code || '' });
    });
    return out.concat(billCodeFooterRows(lines, Number(parent.vat_amount) > 0 ? Number(parent.vat_amount) : null));
  }
  // Posted: expense lines (journal expense rows carry no vat_code), then the
  // GROUPED tax lines (one DR per VAT code — 2026-07-26), then payment history.
  var expenseLines = lines.filter(function (l) { return !l.vat_code; });
  var gstLines = lines.filter(function (l) { return !!l.vat_code; });
  expenseLines.forEach(function (line) {
    var rawDesc = line.description || '';
    var sepIdx = rawDesc.lastIndexOf(' / ');
    var desc = sepIdx !== -1 ? rawDesc.slice(sepIdx + 3).trim() : rawDesc;
    out.push({ _kind: 'expense', entry_id: line.entry_id || '',
      description: desc, account_code: line.account_code || '',
      amount: Number(line.amount || 0) });
  });
  gstLines.forEach(function (line) {
    var codeDesc = taxCodeMap[line.vat_code];
    var label = codeDesc ? line.vat_code + ': ' + codeDesc : (line.vat_code || 'GST/VAT');
    out.push({ _kind: 'gst', entry_id: line.entry_id || '',
      vat_code: line.vat_code || '', amount: Number(line.amount || 0),
      label: label });
  });
  payments.forEach(function (pmt) {
    out.push({ _kind: 'payment', payment_id: pmt.payment_id || '',
      date: pmt.date || '', method: pmt.method || '',
      reference: pmt.reference || '', amount: Number(pmt.amount || 0),
      voided: !!pmt.voided_at, _isMultiBill: !!pmt.is_multi_bill });
  });
  return out;
}

// billsChildRowHtml(parent, child, idx) — view-mode child <tr> INNER html (the
// framework owns the <tr> shell: data-idx, data-child-of, row-dirty).
// Grid: parent has 8 columns + row-actions = 9 column-widths (Outstanding,
// 2026-09-15, added between Amount and CCY).
// Child layout: desc colspan=4 (cols 0-3), amount (col 4, aligns under AMOUNT),
// outCell (col 5, Outstanding — always blank, a child line has none of its
// own), spacer (col 6, CCY), tax/empty (col 7, Status), empty (col 8, actions).
function billsChildRowHtml(parent, child, idx) {
  function amtCell(n, extra) {
    // text-align/tabular-nums come from the shared .amt component (common.css)
    return '<td class="amt"' + (extra ? ' style="' + extra + '"' : '') + '>' + FB.util.fmtAmt(n || 0) + '</td>';
  }
  var spacer = '<td class="child-spacer"></td>';
  var empty = '<td></td>';
  var outCell = '<td></td>';
  if (child._kind === 'empty') {
    return '<td colspan="9" class="child-desc" style="color:var(--text-faint);font-style:italic">No line items</td>';
  }
  if (child._kind === 'draft-line') {
    return '<td colspan="4" class="child-desc">' + esc(child.description || '') + '</td>'
      + amtCell(child.amount) + outCell + spacer
      + (VAT_ON ? '<td style="font-size:0.75rem;width:50px">' + esc(child.vat_code || '') + '</td>' : '<td></td>')
      + empty;
  }
  if (child._kind === 'expense') {
    return '<td colspan="4" class="child-desc">' + esc(child.description || '') + '</td>'
      + amtCell(child.amount) + outCell + spacer
      + '<td></td>'
      + empty;
  }
  if (child._kind === 'gst') {
    return '<td colspan="4" class="child-desc" style="color:var(--text-muted);font-style:italic">' + esc(child.label || '') + '</td>'
      + amtCell(child.amount, 'color:var(--text-muted)') + outCell + spacer + '<td></td>' + empty;
  }
  if (child._kind === 'payment') {
    var v = child.voided;
    var isWriteOff = child.method === 'write_off';
    var meth = isWriteOff ? '' : (child.method === 'manual' ? 'manual' : 'bank match');
    var txt = (isWriteOff ? 'Write-off ' : 'Payment ') + fmtDateShort(child.date) + (meth ? ' \u00b7 ' + esc(meth) : '')
      + (child.reference ? ' \u00b7 ' + esc(child.reference) : '') + (v ? ' \u00b7 voided' : '');
    return '<td colspan="4" class="child-desc' + (v ? ' pay-voided' : '') + '">' + txt + '</td>'
      + amtCell(child.amount, v ? 'color:var(--text-muted)' : '') + outCell + spacer + '<td></td>' + empty;
  }
  return '<td colspan="9" class="child-desc"></td>';
}

// ── Bill footer (2026-07-26, rev): ONE footer row per VAT code, shown under ──
// an unfolded draft's lines. Each row states the code + its
// description and the code's VAT amount. When a stated VAT total exists, the
// delta is applied to the largest standard code (mirrors the posting rule) so
// the rows always sum to the stated total. Reverse-charge codes get their own
// rows (self-assessed — never part of the gross owed to the partner).
function billCodeFooterRows(lines, stated) {
  if (!VAT_ON) return []; // vatRegistered=false: no tax codes, no per-code rows
  var std = {}, rc = {}, order = [];
  (lines || []).forEach(function (l) {
    var code = ((l && l.vat_code) || '').trim();
    if (!code) return;
    var info = taxCodeRateMap[code];
    if (!info) return;
    var v = Math.round((parseFloat(l.amount) || 0) * Number(info.rate) * 100) / 100;
    var bucket = info.is_reverse_charge ? rc : std;
    if (!(code in bucket)) order.push(code);
    bucket[code] = (bucket[code] || 0) + v;
  });
  var stdTotal = Object.keys(std).reduce(function (s, c) { return s + std[c]; }, 0);
  var _st = (stated != null && !isNaN(Number(stated))) ? Number(stated) : null;
  if (_st !== null && stdTotal > 0) {
    var largest = null;
    Object.keys(std).forEach(function (c) { if (std[c] > 0 && (largest === null || std[c] >= std[largest])) largest = c; });
    if (largest !== null) std[largest] = Math.round((std[largest] + (_st - stdTotal)) * 100) / 100;
  }
  var rows = [];
  order.forEach(function (code) {
    var info = taxCodeRateMap[code];
    var amt = info.is_reverse_charge ? rc[code] : std[code];
    if (!amt) return;
    var codeDesc = taxCodeMap[code];
    rows.push({ _kind: 'gst', entry_id: '', vat_code: code, amount: amt,
      label: codeDesc ? code + ': ' + codeDesc : code });
  });
  return rows;
}

// Multi-bill settlement (P1-9b, issue #131) moved into the New Payment page
// (payment-new.js) — bill-post-payment-consolidation-spec.md §3. It was the
// only entry point for a multi-bill payment; New Payment (reachable from the
// '+' New menu) now is.

var billsList = FB.list.create({
  keysId: 'bills',
  active: function () {
    // Payables' tab switcher (showTab() in payables.js) toggles visibility
    // via the '.tab-panel.active' CSS class on #tab-bills, not via inline
    // style on #pay-panel-bills — so gate on the tbody's real rendered
    // visibility instead of a style property nothing ever sets.
    var el = document.getElementById('bills-tbody');
    return !!el && el.offsetParent !== null;
  },
  tbody: 'bills-tbody',
  companyId: function () { return COMPANY; },
  onFocus: function (tr) {},
  tree: true,
  columns: [
    { field: 'partner_name', type: 'text', sortable: true, filterType: 'text',
      display: function (v, r) { return partnerCell(r.partner_name || v || ''); }, label: 'Partner' },
    { field: 'date', type: 'date', sortable: true, filterType: 'date',
      display: function (v) {
        return '<span style="white-space:nowrap" title="' + esc(String(v || '').slice(0, 10)) + '">' + fmtDateShort(v) + '</span>';
      } },
    { field: 'due_date', type: 'date', sortable: true, filterType: 'date',
      display: function (v, r) {
        var due = v ? String(v).slice(0, 10) : '';
        var overdue = r.status === 'posted' && due && due < today;
        return '<span style="white-space:nowrap" title="' + esc(due) + '"><span' + (overdue ? ' class="overdue-date"' : '') + '>' + fmtDateShort(due) + '</span></span>';
      } },
    { field: 'vendor_ref', type: 'text', sortable: true, filterType: 'text',
      display: function (v, r) {
        var id = String(r.bill_id || r._key || '');
        var qs = 'from=bills';
        // fb-list-bills-return-context-spec §4: carry the active date range
        // (both-or-neither) as ?dateFrom=/?dateTo= URL params so FB.period._resolve
        // can pick them up on return. Reads from the global Period Selector.
        var st = FB.period.get();
        if (st.start && st.end) {
          qs += '&dateFrom=' + encodeURIComponent(st.start) + '&dateTo=' + encodeURIComponent(st.end);
        }
        return '<a href="/' + esc(COMPANY) + '/bill/' + esc(id) + '?' + qs + '" class="ref-link" onclick="event.stopPropagation()">' + esc(v || '') + '</a>';
      } },
    { field: 'amount', type: 'number', ro: 'always', sortable: true, filterType: 'amount', align: 'right',
      display: function (v) {
        return '<span class="amt">' + FB.util.fmtAmt(v || 0) + '</span>';
      } },
    // Payment progress (2026-09-15): what used to be inferred from a
    // separate 'partial' status. Shows the actual open balance for every
    // 'posted' bill (whether nothing or something has been paid toward it)
    // — blank for anything else (draft/rejected/void have none; 'paid' is
    // redundant with the Paid badge, always 0 here).
    { field: 'outstanding', type: 'number', ro: 'always', sortable: true, filterType: 'amount', align: 'right', label: 'Balance',
      display: function (v, r) {
        if (r.status !== 'posted') return '<span class="pe-ro">—</span>';
        return '<span class="amt">' + FB.util.fmtAmt(Number(v) || 0) + '</span>';
      } },
    { field: 'currency', type: 'text', ro: 'always', sortable: true, filterType: 'list',
      display: function (v, r) {
        var ccy = v || BASE_CURRENCY;
        // data-bill-date/data-bill-ccy carry the FX-tooltip inputs (_getFxRate
        // population is wired when the framework takes over rendering).
        return '<span class="ccy-cell" style="font-size:0.75rem;color:var(--text-muted)" data-bill-date="' + esc(String(r.date || '').slice(0, 10)) + '" data-bill-ccy="' + esc(ccy) + '">' + esc(ccy) + '</span>';
      } },
    { field: 'status', type: 'text', ro: 'always', sortable: true, filterType: 'list',
      display: function (v, r) {
        var due = r.due_date ? String(r.due_date).slice(0, 10) : null;
        return statusBadge(v, due) + (v === 'posted' ? payAffordHtml(r) + writeOffAffordHtml(r) : '');
      } }
  ],
  label: '+ Add bill',
  list: { action: 'bill.list',
    // global-period-selector-chrome-spec §5: dateFrom/dateTo come from the
    // global Period Selector (FB.period.get()) + the shared threshold.
    // AP Control drill-through: pin to the explicit id set instead, with no
    // date filter at all — the clicked number's bills may fall outside
    // whatever range the picker currently has active.
    body: function () {
      if (deepLinkBillIds) return { billIds: deepLinkBillIds, threshold: FB.list.threshold };
      var st = FB.period.get();
      return {
        dateFrom: st.start || '',
        dateTo: st.end || '',
        threshold: FB.list.threshold
      };
    },
    tooManyMessage: function (total) {
      return total.toLocaleString() + ' bills \u2014 narrow the date range above to see this list.';
    },
    map: function (b) {
      return {
        _key: b.bill_id, bill_id: b.bill_id, partner_name: b.partner_name || '', date: b.date || '',
        due_date: b.due_date || '', vendor_ref: b.vendor_ref || '', amount: b.amount || 0,
        amount_paid: b.amount_paid || 0,
        // Payment progress lives here, not in status (2026-09-15) — a bill
        // is 'posted' whether nothing or something has been paid toward it;
        // outstanding = amount - amount_paid is what used to be implied by
        // a separate 'partial' status value.
        outstanding: (Number(b.amount) || 0) - (Number(b.amount_paid) || 0),
        currency: b.currency || BASE_CURRENCY, status: b.status || '',
        ap_account: b.ap_account || '', expense_account: b.expense_account || '',
        partner_id: b.partner_id || '', _isBill: true
      };
    } },
  // Pre-resolved lazy children: the framework calls children(row)
  // SYNCHRONOUSLY during render, so billsChildren returns already-cached lines
  // (or [] on first touch) and triggers a background fetch that re-renders on
  // resolution. childRowHtml renders the view-mode child <tr> inner HTML.
  // (Task 6b.)
  children: billsChildren,
  childRowHtml: billsChildRowHtml,
  onLoaded: function (saved) {
    _refreshCcyVisibility(saved);
    loadFxRatesForKpi(function (rm) { computeKpis(saved, rm); }, saved);
  },
  onChrome: function () { _applyCcyColVisibility(); },
  // + Add bill (and ?new=1) opens the full bill page instead of an inline
  // buffer (#312).
  onNew: function () { fbNavigate('/' + COMPANY + '/bill/new'); },
  // Draft delete. confirm prompts before the framework posts
  // bill.draft.delete; body sends the saved draft's _key as billId. cfg.
  // deletable restricts it to drafts.
  del: {
    action: 'bill.draft.delete',
    body: function (b) { return { billId: b._key }; },
    confirm: function (b) { return 'Delete draft bill from "' + (b.partner_name || '?') + '"?'; },
    deleted: function () { return 'Draft deleted'; }
  },
  // Read-only list (#312): every change happens on the full bill page.
  editable: function () { return false; },
  // Enter opens the bill's full page — the editor for a draft, the locked
  // page (journal trail, attachments, void) otherwise. Space folds.
  openRow: function (p) { fbNavigate('/' + COMPANY + '/bill/' + encodeURIComponent(p.bill_id)); },
  deletable: function (d) { return d.status === 'draft'; },
  // Screen verbs (framework PREPENDS these; guards keep built-ins as fallback).
  extraBindings: function (api) {
    function parentOf(d) { return d && d._childOf ? api.rowByKey(d._childOf) : d; }
    function reloadBills() { billChildCache = {}; billsList.load(); }
    function voidBill(p) {
      if (p.status === 'void') { FB.status.show('Bill is already void — cannot be modified.', true); return; }
      if (p.status === 'paid') { FB.status.show('Bill is fully paid — reversal must be done via a credit note or payment reversal.', true); return; }
      // 'partial' is no longer a stored status (2026-09-15) — amount_paid is
      // the direct check now, matching the server's own guard (bills.js
      // voidBill) exactly instead of a status value kept in sync with it.
      // Short-circuits here rather than opening a "Continue?" confirm that
      // would just fail server-side — same treatment as paid/void above.
      if (Number(p.amount_paid) > 0.005) { FB.status.show('Bill is partially paid — reversal must be done via a credit note or payment reversal.', true); return; }
      var partner = esc(p.partner_name || p.bill_id);
      var msg = 'Reverse bill from "' + partner + '"? A reversal journal entry will be created. This cannot be undone.';
      FB.modal.open({
        title: 'Void this bill?',
        body: msg,
        buttons: [
          { label: 'Cancel', onClick: function (api) { api.close(); } },
          { label: 'Void bill', danger: true, onClick: function (api) {
              api.close();
              fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'bill.void', companyId: COMPANY, billId: p.bill_id }) })
                .then(function (r) { return r.json(); })
                .then(function (res) {
                  var d = res.data || res;
                  var err = res.error || (d && d.error);
                  // err is {code, message} (server error shape), not a
                  // string — string-concatenating it directly printed
                  // "Cannot void: [object Object]" for every failure here.
                  if (err) { FB.status.show('Cannot void: ' + (err.message || err), true); return; }
                  FB.status.show('Bill voided', false); reloadBills();
                })
                .catch(function (e) { FB.status.show('Error: ' + e.message, true); });
            } }
        ]
      });
    }
    function voidPayment(child) {
      if (child.voided === true || child.voided === 'true' || child.voided_at) { FB.status.show('Payment already voided', true); return; }
      var msg = 'Void this payment? A reversal journal entry will be created.';
      // Multi-bill payment: voiding reverses the entire batch (all bills).
      if (child._isMultiBill) msg = 'This was part of a multi-bill payment. Voiding will reverse the entire payment (all bills). Continue?';
      FB.modal.open({
        title: 'Void this payment?',
        body: msg,
        buttons: [
          { label: 'Cancel', onClick: function (api) { api.close(); } },
          { label: 'Void payment', danger: true, onClick: function (api) {
              api.close();
              fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'payment.void', companyId: COMPANY, paymentId: child.payment_id }) })
                .then(function (r) { return r.json(); })
                .then(function (res) {
                  var d = res.data || res;
                  var err = res.error || (d && d.error);
                  if (err) { FB.status.show('Void failed: ' + (err.message || err), true); return; }
                  FB.status.show('Payment voided — bill ' + (d.newStatus || ''), false); reloadBills();
                })
                .catch(function (e) { FB.status.show('Void failed: ' + e.message, true); });
            } }
        ]
      });
    }
    function postDraft(p) {
      FB.status.show('Posting…', false);
      fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bill.draft.post', companyId: COMPANY, billId: p.bill_id }) })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          var d = res.data || res;
          var postErr = res.error || (d && d.error);
          if (postErr) { FB.status.show('Post failed: ' + (postErr.message || postErr), true); return; }
          var _w = (d && d.warnings) || [];
          if (_w.length) FB.status.show('Posted with warning: ' + _w.join(' · '), 'warn');
          else FB.status.show('Bill posted', false);
          reloadBills();
        })
        .catch(function (e) { FB.status.show('Post failed: ' + e.message, true); });
    }
    return [
      // y advances a saved bill (§2): draft → post; posted (whether or not
      // partly paid) → New Payment scoped to this bill. p/P are both retired.
      { key: 'y', mode: 'NORMAL', hint: 'post/pay', hintBar: true,
        when: function () { var p = parentOf(api.focusedRow()); return !!(p && (p.status === 'draft' || p.status === 'posted')); },
        run: function () {
          var p = parentOf(api.focusedRow()); if (!p) return;
          if (p.status === 'draft') { postDraft(p); return; }
          goToNewPayment(p.bill_id);
        } },
      { key: 'x', mode: 'NORMAL', hint: 'void', hintBar: true,
        when: function () {
          var d = api.focusedRow(); if (!d) return false;
          if (d._kind === 'payment') return true; // payment-history child → void payment
          var p = parentOf(d);
          // posted/paid/void → void bill. Not draft (delete/reject it
          // instead) and not rejected (never posted — same reasoning,
          // nothing to void; the new status Inbox's Transactions tab uses).
          return !!(p && p.status && p.status !== 'draft' && p.status !== 'rejected');
        },
        run: function () {
          var d = api.focusedRow(); if (!d) return;
          if (d._kind === 'payment') { voidPayment(d); return; }
          var p = parentOf(d); if (p) voidBill(p);
        } },
      // W (capital — lowercase w is save) closes a small outstanding
      // residual with no real payment. Only offered where it could possibly
      // apply; the actual materiality gate is server-side (bills.js
      // writeOffBill), same division of labor as every other guard here.
      { key: 'W', mode: 'NORMAL', hint: 'write off', hintBar: true,
        when: function () {
          var p = parentOf(api.focusedRow()); if (!p) return false;
          return p.status === 'posted' && (Number(p.amount || 0) - Number(p.amount_paid || 0)) > 0.005;
        },
        run: function () {
          var p = parentOf(api.focusedRow()); if (!p) return;
          writeOffBill(p);
        } }
    ];
  }
});

// ========== TAB SWITCHER (simplified — single Bills panel) ==========
// 2026-08-11 IA restructure: Partners tab moved to Master Data page. Bills is
// now the only panel; showPayTab is kept as a no-op shim for compatibility.
function showPayTab(t) {
  renderPayHints('bills');
}

// Sidebar keyboard hints for the Bills page.
function renderPayHints(tab) {
  var el = document.getElementById('sb-hints');
  if (!el) return;
  FB.keys.renderHints('bills', el, { layout: 'list' });
}
`;
}

module.exports = { billsTabJS };
