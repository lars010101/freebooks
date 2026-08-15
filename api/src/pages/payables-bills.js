'use strict';

// billsTabJS(flags) — emits the Payables > Bills client JS.
//
// Relevance flags (settings-ux-spec §7 item 9 + fx-automation-spec §1) gate
// whole UI surfaces SERVER-SIDE so nothing flashes:
//   - vatRegistered=false → no per-line VAT code column/input, no stated-VAT
//     footer cell, no per-code tax footer rows. Amounts post gross-to-expense
//     (the server already does this; the client just stops collecting a code).
//   - fxTracking='off'    → the CCY column/input locks to the company base
//     currency: the parent CCY cell renders the base ccy as read-only text and
//     the draft new-bill buffer + partner-pick default-ccy sync are suppressed
//     so a bill always submits in base currency.
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
// 2026-08-11 IA restructure: Partners tab moved to Master Data page.
// These shims keep the Bills page's partner dropdown working without the
// Partners tab's partnersList being on the page.
window.allPartners = window.allPartners || [];
function loadPartners() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'partner.list', companyId: COMPANY, partner_type: 'vendor' }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var data = res.data || res;
      window.allPartners = Array.isArray(data) ? data : (data.rows || []);
    })
    .catch(function(){});
}
function registerPartnerKeyActions() { /* keys registered by FB.list at creation */ }

// Relevance flags (settings-ux-spec §7 item 9 + fx-automation-spec §1).
// Inlined server-side from getRelevanceFlags — VAT_ON gates the per-line VAT
// code column + stated-VAT footer + per-code footers; FX_ON gates the CCY
// column / partner-default-ccy sync (locked to BASE_CURRENCY when off).
var VAT_ON = ${VAT_ON};
var FX_ON = ${FX_ON};
// ========== BILLS STATE ==========
// Page-level state retained by the FB.list Bills screen. The bespoke
// render/draft/filter/sort/pagination/nav machinery was deleted in Task 7;
// FB.list owns the table render, fold state, dirty buffer, sort, and column
// filters. What remains here: KPI/period inputs, the CCY-visibility display
// hook, and the dropdown sources/attachers reused by the cfg columns + child
// renderer + inline pay row.
var allPeriods = []; // loaded on init for popup period check
var today = new Date().toISOString().slice(0,10);
var in7days = new Date(Date.now() + 7*24*3600*1000).toISOString().slice(0,10);
var taxCodeMap = {}; // vat_code -> description
var taxCodeRateMap = {}; // vat_code -> { rate, is_reverse_charge } (for GST default computation)

// Company-level default AP/expense account codes, loaded from settings on page
// init. Blank ('') when unset — used as fallbacks in place of the old hardcoded
// '201100' (AP) and '400000' (expense) defaults. Vendor defaults still override
// these; see _loadCompanyDefaults() and the partner-selection handler.
var companyDefaultAp = '';
var companyDefaultExpense = '';

// FB.mode -> tbody display hook (page-level). The bespoke cursor object was
// deleted in Task 7 (FB.list nav owns row focus/scroll now); this listener
// remains so the inline pay row / CCY-input visibility still react to a shared
// INSERT/NORMAL mode flip. _applyCcyColVisibility returns the CCY column while
// editing (CCY input visible); the .insert-mode class drives pay-row styling.
FB.mode.onChange(function(v) {
  var tbody = document.getElementById('bills-tbody');
  if (!tbody) return;
  if (v === 'INSERT') tbody.classList.add('insert-mode'); else tbody.classList.remove('insert-mode');
  _applyCcyColVisibility(); // CCY column returns while editing (CCY input)
});

var billAccountsList = [];

var AVATAR_COLORS = ['#4f6ef7','#e05c5c','#2bac72','#e09d3a','#9b59c4','#17a2b8','#e07840','#5c7ae0'];

// ========== ACCOUNT AUTOCOMPLETE (bills tab) ==========
function loadBillAccounts() {
  if (billAccountsList.length) return Promise.resolve();
  return fetch('/api/' + COMPANY + '/accounts')
    .then(function(r) { return r.json(); })
    .then(function(rows) {
      billAccountsList = Array.isArray(rows) ? rows : [];
    })
    .catch(function() {});
}

// ── FB.dropdown sources (P2-1) ─────────────────────────────────────────────
// Account codes (AP + expense): contains-match on code AND name.
function _acctSource(q) {
  q = (q || '').trim().toLowerCase();
  return billAccountsList.filter(function(a) {
    if (!q) return true;
    return (a.account_code || '').toLowerCase().indexOf(q) >= 0 ||
           (a.account_name || '').toLowerCase().indexOf(q) >= 0;
  }).map(function(a) {
    return { primary: a.account_code, secondary: a.account_name || '', data: { code: a.account_code } };
  });
}
function _attachAcctDropdown(input) {
  if (!input) return;
  FB.dropdown.attach(input, {
    source: _acctSource,
    onPick: function(item, inp) {
      inp.value = item.data.code;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

// ========== P1-9: INLINE PAYMENT ROW (pay-on-bill) ==========
// Cash/bank accounts only (cf_category='Cash' is the app-wide marker).
function _cashSource(q) {
  q = (q || '').trim().toLowerCase();
  return billAccountsList.filter(function(a) {
    if (a.cf_category !== 'Cash' || a.is_active === false) return false;
    if (!q) return true;
    return (a.account_code || '').toLowerCase().indexOf(q) >= 0 ||
           (a.account_name || '').toLowerCase().indexOf(q) >= 0;
  }).map(function(a) {
    return { primary: a.account_code, secondary: a.account_name || '', data: { code: a.account_code } };
  });
}
function _attachCashDropdown(input) {
  if (!input) return;
  FB.dropdown.attach(input, {
    source: _cashSource,
    onPick: function(item, inp) {
      inp.value = item.data.code;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}
function payRowOpen() { return !!document.querySelector('tr[data-pay-row="true"]'); }

// Data-driven form (Task 6f): anchor row + bill data object.
function openPayRowData(anchorTr, d) {
  if (!anchorTr || !d) return;
  if (payRowOpen()) return; // one payment row at a time
  var billId = d.bill_id;
  if (!billId) return;
  var status = d.status || '';
  if (status !== 'posted' && status !== 'partial') return;
  if (!billAccountsList.length) { loadBillAccounts().then(function() { openPayRowData(anchorTr, d); }); return; }

  var ccy = d.currency || BASE_CURRENCY;
  var outstanding = Math.max(0, Math.round(((parseFloat(d.amount) || 0) - (parseFloat(d.amount_paid) || 0)) * 100) / 100);
  var today = new Date().toISOString().slice(0, 10);
  var foreign = ccy.toUpperCase() !== BASE_CURRENCY.toUpperCase();

  var tr = document.createElement('tr');
  tr.dataset.rowType = 'child';
  tr.dataset.parentId = billId;
  tr.dataset.payRow = 'true';
  tr.className = 'child-row pay-row';
  tr._idem = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('pay-' + Date.now() + '-' + Math.random());
  tr.innerHTML = '<td colspan="7" class="pay-cell">'
    + '<span class="pay-lbl">Pay</span>'
    + '<input type="date" class="draft-input pay-date" value="' + today + '" title="Payment date">'
    + '<input class="draft-input pay-acct" placeholder="e.g. 1020" title="Bank/cash account">'
    + '<input class="draft-input pay-amount" type="number" step="0.01" min="0" value="' + outstanding.toFixed(2) + '" title="Amount in ' + esc(ccy) + '">'
    + '<span class="pay-ccy">' + esc(ccy) + '</span>'
    + '<input class="draft-input pay-ref" placeholder="e.g. bank ref" title="Payment reference (optional)">'
    + (foreign ? '<input class="draft-input pay-fx" type="number" step="0.0001" min="0" placeholder="e.g. 1.35" title="FX rate ' + esc(ccy) + ' → ' + esc(BASE_CURRENCY) + ' at payment date">' : '')
    + '<span class="pay-hint"><a class="pay-ok" title="Record payment">Enter ✓</a> · <a class="pay-cancel" title="Cancel">Esc ✕</a></span>'
    + '</td>';
  anchorTr.insertAdjacentElement('afterend', tr);

  var acctIn = tr.querySelector('.pay-acct');
  acctIn.value = localStorage.getItem('fb.payAccount.' + COMPANY) || '';
  _attachCashDropdown(acctIn);
  tr.querySelector('.pay-ok').addEventListener('click', function(e) { e.stopPropagation(); submitPayRow(); });
  tr.querySelector('.pay-cancel').addEventListener('click', function(e) { e.stopPropagation(); closePayRow(); });
  if (foreign) {
    _getFxRate(ccy, today).then(function(rate) {
      var fxIn = tr.querySelector('.pay-fx');
      if (fxIn && rate != null && !fxIn.value) fxIn.value = rate;
    });
  }
  FB.mode.set('INSERT');
  var amtIn = tr.querySelector('.pay-amount');
  amtIn.focus();
  amtIn.select();
}

// Legacy dataset-reading wrapper deleted in Task 7 (framework rows carry no
// dataset.billId/status attrs). payAffordHtml routes the Pay affordance via
// _payAffordClick, which resolves the bill row through billsList.rowByKey and
// calls openPayRowData directly.

function closePayRow() {
  var tr = document.querySelector('tr[data-pay-row="true"]');
  if (tr) tr.remove();
  FB.mode.set('NORMAL');
}

function submitPayRow() {
  var tr = document.querySelector('tr[data-pay-row="true"]');
  if (!tr || tr._submitting) return;
  var billId = tr.dataset.parentId;
  var date = tr.querySelector('.pay-date').value;
  var acct = tr.querySelector('.pay-acct').value.trim();
  var amt = parseFloat(tr.querySelector('.pay-amount').value);
  var ref = tr.querySelector('.pay-ref').value.trim();
  var fxIn = tr.querySelector('.pay-fx');
  var fxRate = (fxIn && fxIn.value !== '') ? parseFloat(fxIn.value) : null;
  if (!date) { billEditMsg('Payment date required', 'err'); return; }
  if (!acct) { billEditMsg('Bank account required', 'err'); tr.querySelector('.pay-acct').focus(); return; }
  if (!(amt > 0)) { billEditMsg('Amount must be greater than zero', 'err'); return; }
  tr._submitting = true;
  billEditMsg('Recording payment…', '');
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': tr._idem },
    body: JSON.stringify({ action: 'bill.payment.record', companyId: COMPANY, billId: billId, date: date,
      bankAccount: acct, amount: amt, reference: ref || undefined, fxRate: fxRate != null ? fxRate : undefined }) })
  .then(function(r) { return r.json(); })
  .then(function(res) {
    tr._submitting = false;
    var d = res.data || res;
    if (res.error || (d && d.error)) {
      billEditMsg('Payment failed: ' + (res.error || d.error), 'err');
      return;
    }
    localStorage.setItem('fb.payAccount.' + COMPANY, acct);
    closePayRow();
    billEditMsg('Payment recorded — bill ' + (d.status || 'updated'), 'ok');
    billChildCache = {}; // lines/payments stale after payment (Task 6f)
    billsList.load();
  })
  .catch(function(e) { tr._submitting = false; billEditMsg('Payment failed: ' + e.message, 'err'); });
}
// VAT codes: '— None —' plus every code in taxCodeMap (contains-match).
function _vatSource(q) {
  q = (q || '').trim().toLowerCase();
  var items = [];
  if (!q || 'none'.indexOf(q) >= 0) items.push({ primary: '— None —', data: { code: '' } });
  Object.keys(taxCodeMap).forEach(function(code) {
    var name = taxCodeMap[code] || '';
    if (!q || code.toLowerCase().indexOf(q) >= 0 || name.toLowerCase().indexOf(q) >= 0) {
      items.push({ primary: code, secondary: name, data: { code: code } });
    }
  });
  return items;
}
// Wire a VAT-code input: FB.dropdown + commit-on-pick/blur-if-changed.
// commit() runs the builder-specific sync + GST recompute + parent total.
function _attachVatDropdown(input, commit) {
  if (!input) return;
  input.dataset.lastCode = input.value.trim();
  function _commit() {
    input.dataset.lastCode = input.value.trim();
    commit();
  }
  FB.dropdown.attach(input, {
    source: _vatSource,
    onPick: function(item, inp) { inp.value = item.data.code; _commit(); }
  });
  input.addEventListener('input', function() { input.classList.remove('req'); });
  input.addEventListener('blur', function() {
    if (input.value.trim() !== (input.dataset.lastCode || '')) _commit();
  });
}
// Save-time guard: every line's VAT code must be blank or a known tax code.
function _validateDraftVatCodes(parentTr) {
  var bad = null;
  Array.from(parentTr.parentNode.querySelectorAll('tr[data-parent-key="' + (parentTr.dataset.draftKey || parentTr.dataset.billId) + '"] input.child-vat')).forEach(function(inp) {
    var v = inp.value.trim();
    if (v && !taxCodeMap[v]) { bad = bad || inp; inp.classList.add('req'); }
  });
  if (bad) billEditMsg('Invalid VAT code "' + bad.value.trim() + '" — pick from the dropdown', 'err');
  return !bad;
}
// ========== STATUS MESSAGE ==========
function billEditMsg(msg, type) {
  // Routes through the ONE status channel (2026-07-23); local styling retired.
  if (window.FB && FB.status) FB.status.show(msg, type === 'err' ? 'err' : type === 'warn' ? 'warn' : false);
}

// ========== PAGE INIT ==========
// Fetch company-level default AP/expense account codes from settings and stash
// them in companyDefaultAp / companyDefaultExpense. These replace the old
// hardcoded '201100'/'400000' fallbacks. Blank when the company hasn't
// configured defaults — drafts then render with data-ap-account="" etc. and the
// backend surfaces a clear "required" validation error at post time.
function _loadCompanyDefaults() {
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'settings.get', companyId: COMPANY }) })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      var s = (res && res.data) ? res.data : (res || {});
      companyDefaultAp = (s.default_ap_account || '').trim();
      companyDefaultExpense = (s.default_expense_account || '').trim();
    })
    .catch(function (e) {
      // Non-fatal: leave defaults blank (blank fallback behaviour).
      console.warn('Could not load company default accounts:', e && e.message);
    });
}

function fbPageInitPayables() {
  loadPartners();
  billsList.load();
  loadPeriods();
  registerPartnerKeyActions();
  // Sidebar hint panel is generated from the same binding table that drives
  // dispatch (P1-3/P1-6: single source of truth — cannot go stale).
  renderPayHints('bills');
  loadBillAccounts();
  _loadCompanyDefaults();

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
// Lookup FX rate for a draft bill (background, no UI). Returns a Promise.
function _getFxRate(ccy, billDate) {
  if (!ccy || !billDate || ccy.toUpperCase() === BASE_CURRENCY.toUpperCase()) {
    return Promise.resolve(null);
  }
  return fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'fx.rates.get', companyId: COMPANY, fromCurrency: ccy, toCurrency: BASE_CURRENCY, date: billDate }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    var d = res.data || res;
    return (d && d.rate != null) ? d.rate : null;
  })
  .catch(function(){ return null; });
}
// ========== DATA LOADING ==========
function loadPeriods() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'period.list', companyId: COMPANY }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    var rows = res.data || res || [];
    allPeriods = Array.isArray(rows) ? rows : [];
  }).catch(function(){});
}

function loadFxRatesForKpi(callback) {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action: 'fx.rates.list', companyId: COMPANY }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    var rates = res.data || res || [];
    if (!Array.isArray(rates)) rates = [];
    var rateMap = {};
    rates.forEach(function(r) {
      if (!r.from_currency || !r.to_currency || !r.rate) return;
      var key = r.from_currency + '_' + r.to_currency;
      if (!rateMap[key] || String(r.rate_date||'') > String(rateMap[key].date||'')) {
        rateMap[key] = { rate: Number(r.rate), date: r.rate_date };
      }
    });
    callback(rateMap);
  })
  .catch(function(){ callback({}); });
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
    var active = b.status === 'posted' || b.status === 'partial';
    if (!active) return;
    var amt = convertToBase(Number(b.amount || 0), b.currency, rateMap);
    var due = b.due_date ? String(b.due_date).slice(0,10) : null;
    var isOverdue = due && due < today;
    outstandingAmt += amt; outstandingN++;
    if (isOverdue) { overdueAmt += amt; overdueN++; }
    else if (due && due <= in7days) { upcomingAmt += amt; upcomingN++; }
  });
  setText('kpi-outstanding', fmtAmt(outstandingAmt));
  setText('kpi-outstanding-count', outstandingN + ' bill' + (outstandingN !== 1 ? 's' : ''));
  setText('kpi-overdue', fmtAmt(overdueAmt));
  setText('kpi-overdue-count', overdueN + ' bill' + (overdueN !== 1 ? 's' : ''));
  setText('kpi-upcoming', fmtAmt(upcomingAmt));
  setText('kpi-upcoming-count', upcomingN + ' bill' + (upcomingN !== 1 ? 's' : ''));
}

function fmtAmt(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
}

function setText(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = text;
}
// Conditional CCY column: when every visible bill shares one currency the
// column carries no information — hide it (agreed 2026-07-21). It returns
// automatically in INSERT mode (the CCY input lives there) and whenever the
// list is mixed. EXCEPTION (2026-07-22): never hide while a currency filter
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
  var hide = _singleCcy && FB.mode.get() !== 'INSERT' && !filtering;
  tbl.classList.toggle('single-ccy', hide);
  // Column widths are owned by CSS (col.col-* classes + .single-ccy
  // re-weighting rules) — no JS width juggling here.
}
// Data-driven: the framework's rows carry no data-currency attributes, so
// read the mapped saved rows (onLoaded) instead of the DOM. Re-applied per
// render via cfg.onChrome (mode flips, filter changes, edits).
function _refreshCcyVisibility(saved) {
  var rows = saved || [];
  var ccys = {};
  rows.forEach(function (r) { ccys[(r.currency || '').toUpperCase()] = 1; });
  _singleCcy = rows.length > 0 && Object.keys(ccys).length === 1;
  _applyCcyColVisibility();
}
// ========== UTILITY FUNCTIONS ==========
function partnerCell(name) {
  if (!name) return '<span style="color:#aaa">—</span>';
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

function fmtDate(d) {
  if (!d) return '—';
  var s = String(d).slice(0,10);
  var parts = s.split('-');
  if (parts.length !== 3) return s;
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return parts[2] + ' ' + months[parseInt(parts[1],10)-1] + ' ' + parts[0];
}

// Compact list-row date: elide the year when it is the current calendar year
// ("21 Jul"); full "21 Jul 2025" otherwise. The full ISO date sits in the
// cell's title (hover tooltip) — density without losing the unambiguous
// month-name format. Agreed with magnus 2026-07-21.
function fmtDateShort(d) {
  if (!d) return '—';
  var s = String(d).slice(0, 10);
  var yr = new Date().toISOString().slice(0, 4);
  if (s.slice(0, 4) === yr) return fmtDate(s).replace(' ' + yr, '');
  return fmtDate(s);
}

function statusBadge(status, dueDate) {
  var isOverdue = (status === 'posted' || status === 'partial') && dueDate && String(dueDate).slice(0,10) < today;
  if (isOverdue) return '<span class="badge" style="background:#fff0f0;color:#cc2222">Overdue</span>';
  if (status === 'draft')   return '<span class="badge" style="background:#e8e4d0;color:#7a6a00;cursor:pointer">Draft</span>';
  if (status === 'posted')  return '<span class="badge" style="background:#e8eeff;color:#2255cc">Open</span>';
  if (status === 'partial') return '<span class="badge" style="background:#fff3e0;color:#cc7700">Partial</span>';
  if (status === 'paid')    return '<span class="badge" style="background:#f0fff4;color:#2a8a2a">Paid</span>';
  if (status === 'void')    return '<span class="badge" style="background:#f0f0f0;color:#888">Void</span>';
  return '<span class="badge" style="background:#f0f0f0;color:#888">' + esc(status||'') + '</span>';
}
// esc now comes from fb-core.js (window.esc) — P1-3 shared core

// ========== FB.list cfg (Bills → tree) — the Bills tab's list machine ==========
// Declarative FB.list.create config; the bespoke render/draft/filter/fold/nav
// machinery was deleted in Task 7 — this cfg IS the Bills tab now.
//
// payAffordHtml(r) — the hover "Pay" affordance on posted/partial bills
// (extracted from the old renderPage cell). The inline onclick routes through
// _payAffordClick, which resolves the bill via billsList.rowByKey (framework
// parent rows carry data-key) and opens the inline pay row (P1-9, retained).
function payAffordHtml(r) {
  return '<button class="pay-afford" title="Record payment (p)" onclick="event.stopPropagation();_payAffordClick(this)">Pay</button>';
}
function _payAffordClick(btn) {
  var tr = btn.closest('tr');
  while (tr && tr.dataset && tr.dataset.childOf) tr = tr.previousElementSibling;
  if (!tr) return;
  var key = tr.dataset && tr.dataset.key;
  if (key == null) return;
  var bill = billsList.rowByKey(String(key));
  if (bill) openPayRowData(tr, bill);
}

// billAttachPartner(input, tr) — column 'attach' hook for the partner field in
// edit mode (Task 6c). Reproduces today's _wireDraftParentEvents partner branch
// (L1703–1763) as a column attach: FB.dropdown over allPartners; on pick (and on
// blur-resolve of a typed name) the input's data-* datasets are populated with
// the partner id / name / default AP / default expense / default currency, and
// the displayed CCY cell is synced. The framework owns the dirty chip, so the
// old refreshSaveIcon(tr) calls are gone; the Shift+Tab wrap to the last
// child's VAT input is Task 6d (Tab wiring). 'attach' only fires in INSERT, so
// this is inert while the old machinery still owns rendering.
//
// DEV NOTE: ap_account / expense_account / partner_id / currency are not cfg
// columns (the 6a cfg has 7 display columns; AP/expense travel on the partner
// input's datasets, as in the old DOM). The framework harvests only declared
// columns on Esc, so flowing these datasets into the bill save payload is
// finalized in Task 6e (cfg.save.body / a harvest hook). For 6c the attach
// faithfully reproduces the partner-pick UX and stores the defaults for 6e.
function billAttachPartner(input, tr) {
  if (!input) return;
  FB.dropdown.attach(input, {
    source: function (q) {
      q = (q || '').trim().toLowerCase();
      return (allPartners || []).filter(function (v) {
        if (!q) return true;
        return (v.name || '').toLowerCase().indexOf(q) >= 0;
      }).map(function (v) {
        return { primary: v.name || '', data: { v: v } };
      });
    },
    onPick: function (item, inp) {
      var v = item.data.v;
      inp.dataset.partnerId = v.partner_id || '';
      inp.dataset.partnerName = v.name || '';
      inp.dataset.apAccount = v.default_ap_account || companyDefaultAp || '';
      inp.dataset.expenseAccount = v.default_expense_account || companyDefaultExpense || '';
      inp.dataset.partnerCurrency = (FX_ON ? (v.default_currency || BASE_CURRENCY) : BASE_CURRENCY).toUpperCase();
      inp.value = v.name || '';
      billSyncPartnerCcy(tr, inp.dataset.partnerCurrency);
    }
  });
  // Blur: resolve a typed (non-picked) name against master data; if it matches
  // a partner, populate the same datasets + CCY. Leave typed-but-unknown values
  // intact for server-side validation (today's L1742–1763 behavior).
  input.addEventListener('blur', function () {
    setTimeout(function () {
      var name = input.value.trim();
      if (!name) return;
      if (input.dataset.partnerName) return; // already resolved via pick
      var match = (allPartners || []).find(function (x) {
        return (x.name || '').toLowerCase() === name.toLowerCase();
      });
      if (match) {
        input.dataset.partnerId = match.partner_id || '';
        input.dataset.partnerName = match.name || '';
        input.dataset.apAccount = match.default_ap_account || companyDefaultAp || '';
        input.dataset.expenseAccount = match.default_expense_account || companyDefaultExpense || '';
        input.dataset.partnerCurrency = (FX_ON ? (match.default_currency || BASE_CURRENCY) : BASE_CURRENCY).toUpperCase();
        input.value = match.name;
        billSyncPartnerCcy(tr, input.dataset.partnerCurrency);
      }
    }, 200);
  });
}

// billSyncPartnerCcy(tr, ccy) — update the displayed CCY cell. The currency
// column is ro:'always', so in edit mode it renders its display() HTML (a
// <span class="ccy-cell">). Picking a partner updates that span to the partner's
// default currency for visual parity with today's CCY-input side-effect.
function billSyncPartnerCcy(tr, ccy) {
  var span = tr && tr.querySelector('.ccy-cell');
  if (span) span.textContent = ccy;
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
  // New / dirty draft (Task 6c): the in-buffer lines ARE the children — no
  // fetch. The framework's newRow() seeds cfg.blank().lines (one empty line);
  // a/Tab append to it; Esc harvest rewrites it. Mapping mirrors the
  // draft-line shape billsMergeChildRows emits for saved drafts, so
  // billsChildRowHtml renders them uniformly. row._dirty is true for both
  // new (baseRows sets _dirty:true on isNew) and saved-draft-in-edit buffers,
  // and only those carry a lines array (bill.list.map sets none), so this
  // branch is inert for plain saved rows (which fall through to the fetch).
  if (row._dirty && Array.isArray(row.lines)) {
    var _dl = row.lines.map(function (l) {
      return { _kind: 'draft-line', entry_id: l.entry_id || '',
        description: l.description || '', amount: Number(l.amount || 0),
        expense_account: l.expense_account || '',
        vat_code: l.vat_code || '' };
    });
    return _dl.concat(billCodeFooterRows(row.lines, row.vat_amount_stated));
  }
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
    var needsPayments = row.status === 'posted' || row.status === 'partial' || row.status === 'paid';
    if (!needsPayments) { entry.fetched = true; entry.fetching = false; billsList.render(); return; }
    fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'bill.payments', companyId: COMPANY, billId: row.bill_id }) })
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
      // Round-trip: the server returns account_code; the edit renderer and
      // harvest speak expense_account. Map both or a reload-then-edit shows
      // an empty account and fails validation.
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
      voided: !!pmt.voided_at });
  });
  return out;
}

// billsChildRowHtml(parent, child, idx) — view-mode child <tr> INNER html (the
// framework owns the <tr> shell: data-idx, data-child-of, row-dirty).
// Grid: parent has 7 columns + row-actions = 8 column-widths.
// Child layout: desc colspan=4 (cols 0-3), amount (col 4, aligns under AMOUNT),
// spacer (col 5, CCY), tax/empty (col 6, Status), empty (col 7, actions).
function billsChildRowHtml(parent, child, idx) {
  function amtCell(n, extra) {
    var s = 'text-align:right;font-variant-numeric:tabular-nums' + (extra ? ';' + extra : '');
    return '<td class="amt" style="' + s + '">' + Number(n || 0).toFixed(2) + '</td>';
  }
  var spacer = '<td class="child-spacer"></td>';
  var empty = '<td></td>';
  if (child._kind === 'empty') {
    return '<td colspan="8" class="child-desc" style="color:#aaa;font-style:italic">No line items</td>';
  }
  if (child._kind === 'draft-line') {
    return '<td colspan="4" class="child-desc">' + esc(child.description || '') + '</td>'
      + amtCell(child.amount) + spacer
      + (VAT_ON ? '<td style="font-size:0.75rem;cursor:pointer;width:50px" title="Edit tax code">' + esc(child.vat_code || '') + '</td>' : '<td></td>')
      + empty;
  }
  if (child._kind === 'expense') {
    return '<td colspan="4" class="child-desc">' + esc(child.description || '') + '</td>'
      + amtCell(child.amount) + spacer
      + '<td></td>'
      + empty;
  }
  if (child._kind === 'gst') {
    return '<td colspan="4" class="child-desc" style="color:#888;font-style:italic">' + esc(child.label || '') + '</td>'
      + amtCell(child.amount, 'color:#888') + spacer + '<td></td>' + empty;
  }
  if (child._kind === 'payment') {
    var v = child.voided;
    var meth = child.method === 'manual' ? 'manual' : 'bank match';
    var txt = 'Payment ' + fmtDateShort(child.date) + ' \u00b7 ' + esc(meth)
      + (child.reference ? ' \u00b7 ' + esc(child.reference) : '') + (v ? ' \u00b7 voided' : '');
    return '<td colspan="4" class="child-desc' + (v ? ' pay-voided' : '') + '">' + txt + '</td>'
      + amtCell(child.amount, v ? 'color:#888' : '') + spacer + '<td></td>' + empty;
  }
  return '<td colspan="8" class="child-desc"></td>';
}

// Live totals refresh while child lines are edited: parent AMOUNT shows gross
// = net + (stated ?? computed VAT); the footer cells show Net / VAT / Gross.
// VAT is computed per line from its code (amount × rate) — lines carry no VAT
// amount state (redesign 2026-07-26). Reverse-charge VAT is self-assessed and
// never part of the gross owed to the partner.
function billRefreshParentTotal(childTr) {
  if (!childTr || !childTr.dataset || !childTr.dataset.childOf) return;
  var key = childTr.dataset.childOf;
  var ptr = childTr.previousElementSibling;
  while (ptr && ptr.dataset && ptr.dataset.childOf === key) ptr = ptr.previousElementSibling;
  if (!ptr) return;
  var lines = [], net = 0, stdVat = 0;
  var sib = ptr.nextElementSibling;
  while (sib && sib.dataset && sib.dataset.childOf === key) {
    var amt = parseFloat((sib.querySelector('.child-amt') || {}).value) || 0;
    var code = ((sib.querySelector('.child-vat') || {}).value || '').trim();
    var info = code ? taxCodeRateMap[code] : null;
    lines.push({ amount: amt, vat_code: code });
    net += amt;
    if (info && !info.is_reverse_charge) stdVat += Math.round(amt * Number(info.rate) * 100) / 100;
    sib = sib.nextElementSibling;
  }
  var ftr = ptr.parentNode.querySelector('tr.fb-edit-footer[data-footer-of="' + key + '"]');
  var statedInp = ftr && ftr.querySelector('.bill-vat-stated');
  var stated = (statedInp && statedInp.dataset.stated === '1' && statedInp.value !== '') ? (parseFloat(statedInp.value) || 0) : null;
  var gross = net + ((stated !== null) ? stated : stdVat);
  var cell = ptr.querySelector('td[data-field="amount"]');
  if (cell) cell.innerHTML = '<span class="amt" style="text-align:right;font-variant-numeric:tabular-nums">' + gross.toFixed(2) + '</span>';
  if (ftr) billRenderFooter(ftr, key, lines, stated, stdVat);
}

// ── Bill footer (2026-07-26, rev): ONE footer row per VAT code, visible in ──
// BOTH read-only (fold open) and edit mode. Each row states the code + its
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

// The edit-mode footer row carries ONLY the stated-VAT cell (the sole VAT
// override surface): pre-filled computed, amber when stated, cleared = back
// to computed. Net/Gross are not duplicated here — gross lives on the parent
// row's AMOUNT cell.
function billFooterHtml(parent) {
  if (!VAT_ON) return '<td colspan="8"></td>'; // vatRegistered=false: no stated-VAT surface
  return '<td colspan="3" style="color:#666;font-size:0.85em">VAT (supplier-stated total — pre-filled computed; edit to match the invoice; clear to return to computed)</td>'
    + '<td></td>'
    + '<td class="amt"><input class="draft-input bill-vat-stated" type="number" step="0.01" title="Supplier-stated VAT total" style="text-align:right" /></td>'
    + '<td class="child-spacer"></td>'
    + '<td></td>'
    + '<td></td>';
}

// Rebuild the per-code footer rows ahead of the stated-VAT row and prefill
// the stated cell with the computed total while it is untouched.
function billRenderFooter(ftr, key, lines, stated, stdVat) {
  var inp = ftr.querySelector('.bill-vat-stated');
  if (inp) {
    if (inp.dataset.stated !== '1') inp.value = stdVat.toFixed(2);
    inp.style.color = inp.dataset.stated === '1' ? '#b26a00' : '';
  }
  Array.from(ftr.parentNode.querySelectorAll('tr.fb-code-footer[data-footer-of="' + key + '"]')).forEach(function (tr) { tr.remove(); });
  billCodeFooterRows(lines, stated).forEach(function (r) {
    var tr = document.createElement('tr');
    tr.className = 'fb-code-footer child-row';
    tr.dataset.footerOf = key;
    tr.innerHTML = '<td colspan="4" class="child-desc" style="color:#888;font-style:italic">' + esc(r.label) + '</td>'
      + '<td class="amt" style="text-align:right;font-variant-numeric:tabular-nums;color:#888">' + r.amount.toFixed(2) + '</td>'
      + '<td class="child-spacer"></td><td></td><td></td>';
    ftr.parentNode.insertBefore(tr, ftr);
  });
}
function billAttachFooter(ftr, parent) {
  var key = String(parent._key);
  var inp = ftr.querySelector('.bill-vat-stated');
  // Restore stated from the buffer (survives Tab-spawn re-renders); a saved
  // draft's stated total arrives in bills.vat_amount (0 = none).
  var saved = (parent.vat_amount_stated != null && !isNaN(Number(parent.vat_amount_stated))) ? Number(parent.vat_amount_stated)
    : (parent.status === 'draft' && Number(parent.vat_amount) > 0 ? Number(parent.vat_amount) : null);
  function anyChildTr() {
    var k = ftr.previousElementSibling;
    while (k && !(k.dataset && k.dataset.childOf)) k = k.previousElementSibling;
    return k;
  }
  if (inp) {
    if (saved !== null) { inp.dataset.stated = '1'; inp.value = saved.toFixed(2); }
    inp.addEventListener('input', function () {
      if (inp.value === '') { delete inp.dataset.stated; parent.vat_amount_stated = null; }
      else { inp.dataset.stated = '1'; parent.vat_amount_stated = parseFloat(inp.value) || 0; }
      var kid = anyChildTr();
      if (kid) billRefreshParentTotal(kid);
    });
  }
  // Tab from the stated-VAT cell → new child row (same hasData rule as the
  // child chain); Shift+Tab → back to the last child's VAT code input.
  ftr.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab' || e.target !== inp) return;
    e.preventDefault();
    var last = anyChildTr();
    if (e.shiftKey) {
      var v = last && last.querySelector('.child-vat');
      if (v) v.focus();
      return;
    }
    var desc = last && last.querySelector('.child-desc');
    var amt = last && last.querySelector('.child-amt');
    var hasData = (desc && desc.value.trim() !== '') || (amt && (parseFloat(amt.value) || 0) > 0);
    if (hasData && billsList && billsList.addChild) billsList.addChild();
  });
  var kid = anyChildTr();
  if (kid) billRefreshParentTotal(kid);
}

// Task 6e — bill-level save/del helpers (used by cfg.validate / cfg.save).
// billLineNonEmpty mirrors the saveDraftToDb / _gatherInlineBillData row
// filter: a line counts when it has a description OR a positive amount
// (prefilled defaults — expense account, currency — do not keep a row).
function billLineNonEmpty(l) {
  return !!(l && ((l.description || '').trim() || (parseFloat(l.amount) > 0)));
}
// billSumGross sums net + VAT, matching the live parent total shown by
// billRefreshParentTotal: VAT is computed per line from its code (lines carry
// no VAT amounts — 2026-07-26), the bill-level stated total wins when given,
// and reverse-charge VAT is excluded (self-assessed, never owed to the partner).
function billSumGross(lines, stated) {
  var net = 0, stdVat = 0;
  (lines || []).forEach(function (l) {
    var amt = parseFloat(l.amount) || 0;
    net += amt;
    var code = (l.vat_code || '').trim();
    var info = code ? taxCodeRateMap[code] : null;
    if (info && !info.is_reverse_charge) stdVat += Math.round(amt * Number(info.rate) * 100) / 100;
  });
  var t = net + ((stated != null && !isNaN(Number(stated))) ? Number(stated) : stdVat);
  return t;
}

// Named bill-level validate + save-body (Task 6f hoists them so extraBindings
// can call them for the post flow; the cfg references the same functions).
function billValidateBuf(b) {
  if (!b.partner_name) return 'Select partner from dropdown before saving';
  if (!b.date) return 'Bill date required';
  if (!b.due_date) return 'Due date required';
  if (b.due_date < b.date) return 'Due date must be ≥ bill date';
  var lines = (b.lines || []).filter(billLineNonEmpty);
  if (!lines.length) return 'At least one line item is required';
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (!(l.expense_account || '').trim()) return 'Each line needs an expense account';
    if (isNaN(parseFloat(l.amount))) return 'Line amounts must be numeric';
    var vc = (l.vat_code || '').trim();
    if (vc && !taxCodeMap[vc]) return 'Invalid VAT code "' + vc + '" — pick from the dropdown';
  }
  return null;
}
function billSaveBody(b) {
  return { bill: {
    bill_id: b._isNew ? null : b._key,
    partner_name: b.partner_name, vendor_ref: b.vendor_ref, date: b.date, due_date: b.due_date,
    amount: billSumGross(b.lines, b.vat_amount_stated), currency: b.currency, ap_account: b.ap_account,
    expense_account: b.expense_account,
    vat_amount_stated: (b.vat_amount_stated != null && !isNaN(Number(b.vat_amount_stated))) ? Number(b.vat_amount_stated) : null,
    lines: (b.lines || []).filter(billLineNonEmpty).map(function (l) {
      return { description: l.description, expense_account: l.expense_account,
        amount: l.amount, vat_code: l.vat_code || null, currency: b.currency };
    })
  } };
}

// ========== MULTI-BILL SETTLEMENT (Issue #131) ==========
// One bank payment split across N bills from the same vendor + same currency.
// Mirrors openPayRowData/closePayRow/submitPayRow patterns. The panel is a
// child TR with data-multi-pay-row="true" inserted after the focused parent.

function multiPayRowOpen() { return !!document.querySelector('tr[data-multi-pay-row="true"]'); }

function openMultiPayPanel(anchorTr, focusedBill) {
  if (!anchorTr || !focusedBill) return;
  if (multiPayRowOpen() || payRowOpen()) return; // one panel at a time
  if (!billAccountsList.length) { loadBillAccounts().then(function() { openMultiPayPanel(anchorTr, focusedBill); }); return; }

  var partner = (focusedBill.partner_name || '').toLowerCase();
  var ccy = focusedBill.currency || BASE_CURRENCY;

  // Collect qualifying bills: same partner (case-insensitive), same currency,
  // status 'posted' or 'partial'. Walk the DOM parent rows and resolve data
  // via billsList.rowByKey (the framework keeps saved rows private).
  var tb = document.getElementById('bills-tbody');
  var qualifying = [];
  if (tb) {
    var parentTrs = tb.querySelectorAll('tr[data-key]');
    Array.prototype.forEach.call(parentTrs, function(tr) {
      var b = billsList.rowByKey(tr.dataset.key);
      if (!b || !b.bill_id) return;
      if ((b.partner_name || '').toLowerCase() !== partner) return;
      if ((b.currency || BASE_CURRENCY) !== ccy) return;
      if (b.status !== 'posted' && b.status !== 'partial') return;
      var out = Math.max(0, Math.round(((parseFloat(b.amount) || 0) - (parseFloat(b.amount_paid) || 0)) * 100) / 100);
      if (out <= 0) return;
      qualifying.push({ bill: b, outstanding: out, tr: tr });
    });
  }

  if (qualifying.length < 2) { billEditMsg('Only 1 bill for this vendor', 'err'); return; }

  var today = new Date().toISOString().slice(0, 10);
  var foreign = ccy.toUpperCase() !== BASE_CURRENCY.toUpperCase();
  var totalOutstanding = 0;
  qualifying.forEach(function(q) { totalOutstanding += q.outstanding; });
  totalOutstanding = Math.round(totalOutstanding * 100) / 100;

  var tr = document.createElement('tr');
  tr.dataset.multiPayRow = 'true';
  tr.dataset.parentId = focusedBill.bill_id;
  tr.className = 'child-row multi-pay-row';
  tr._idem = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('mpay-' + Date.now() + '-' + Math.random());

  // Shared fields row + bill selection list + total + balance + hints.
  var html = '<td colspan="7" class="multi-pay-cell">'
    + '<div class="mp-shared">'
    + '<span class="mp-lbl">Multi-Pay</span>'
    + '<input type="date" class="draft-input mp-date" value="' + today + '" title="Payment date">'
    + '<input class="draft-input mp-acct" placeholder="e.g. 1020" title="Bank/cash account">'
    + '<input class="draft-input mp-ref" placeholder="e.g. bank ref" title="Payment reference (optional)">'
    + (foreign ? '<input class="draft-input mp-fx" type="number" step="0.0001" min="0" placeholder="e.g. 1.35" title="FX rate ' + esc(ccy) + ' \u2192 ' + esc(BASE_CURRENCY) + '">' : '')
    + '<span class="mp-ccy">' + esc(ccy) + '</span>'
    + '</div>'
    + '<div class="mp-list">';
  qualifying.forEach(function(q, i) {
    var b = q.bill;
    html += '<div class="mp-item" data-bill-id="' + esc(b.bill_id) + '" data-outstanding="' + q.outstanding + '">'
      + '<span class="mp-check" tabindex="0" title="Space to toggle">\u2713</span>'
      + '<span class="mp-desc">' + esc(b.vendor_ref || '') + ' \u00b7 ' + esc(String(b.date || '').slice(0, 10)) + ' <span class="mp-amt">out ' + q.outstanding.toFixed(2) + '</span></span>'
      + '<input class="draft-input mp-alloc" type="number" step="0.01" min="0" value="' + q.outstanding.toFixed(2) + '" title="Allocation in ' + esc(ccy) + '">'
      + '</div>';
  });
  html += '</div>'
    + '<div class="mp-shared">'
    + '<span class="mp-lbl">Total</span>'
    + '<input class="draft-input mp-total" type="number" step="0.01" min="0" value="' + totalOutstanding.toFixed(2) + '" title="Total payment amount in ' + esc(ccy) + '">'
    + '<span class="mp-ccy">' + esc(ccy) + '</span>'
    + '<span class="mp-balance ok">Allocated: ' + totalOutstanding.toFixed(2) + ' / ' + totalOutstanding.toFixed(2) + ' \u2713</span>'
    + '<span class="mp-hint"><a class="mp-ok" title="Record payment">Enter \u2713</a> \u00b7 <a class="mp-cancel" title="Cancel">Esc \u2715</a></span>'
    + '</div>'
    + '</td>';
  tr.innerHTML = html;
  anchorTr.insertAdjacentElement('afterend', tr);

  // Wire the bank account dropdown + FX rate (same as openPayRowData).
  var acctIn = tr.querySelector('.mp-acct');
  acctIn.value = localStorage.getItem('fb.payAccount.' + COMPANY) || '';
  _attachCashDropdown(acctIn);
  if (foreign) {
    _getFxRate(ccy, today).then(function(rate) {
      var fxIn = tr.querySelector('.mp-fx');
      if (fxIn && rate != null && !fxIn.value) fxIn.value = rate;
    });
  }

  // Click handlers.
  tr.querySelector('.mp-ok').addEventListener('click', function(e) { e.stopPropagation(); submitMultiPayPanel(); });
  tr.querySelector('.mp-cancel').addEventListener('click', function(e) { e.stopPropagation(); closeMultiPayPanel(); });

  // Toggle a bill on check-click or alloc focus.
  tr.querySelectorAll('.mp-item').forEach(function(item, idx) {
    item._selected = true; // all selected by default
    item.querySelector('.mp-check').addEventListener('click', function(e) {
      e.stopPropagation();
      _multiPayToggleItem(item);
    });
    var alloc = item.querySelector('.mp-alloc');
    alloc.addEventListener('input', function() { _multiPayUpdateBalance(); });
    alloc.addEventListener('focus', function() {
      _multiPayFocusItem(item);
      alloc.select();
    });
  });

  // Total input → auto-distribute across selected bills.
  tr.querySelector('.mp-total').addEventListener('input', function() {
    var total = parseFloat(tr.querySelector('.mp-total').value) || 0;
    _multiPayAutoDistribute(total);
    _multiPayUpdateBalance();
  });

  // Panel-level keyboard navigation (Arrow Up/Down, Space, Enter, Esc).
  tr._mpFocusIdx = 0;
  _multiPayFocusItem(tr.querySelectorAll('.mp-item')[0]);
  tr.addEventListener('keydown', _multiPayKeydown);

  FB.mode.set('INSERT');
  tr.querySelector('.mp-total').focus();
  tr.querySelector('.mp-total').select();
}

function _multiPayToggleItem(item) {
  item._selected = !item._selected;
  item.classList.toggle('mp-off', !item._selected);
  var tr = document.querySelector('tr[data-multi-pay-row="true"]');
  if (tr) {
    var total = parseFloat(tr.querySelector('.mp-total').value) || 0;
    _multiPayAutoDistribute(total);
    _multiPayUpdateBalance();
  }
}

function _multiPayFocusItem(item) {
  if (!item) return;
  var tr = document.querySelector('tr[data-multi-pay-row="true"]');
  if (!tr) return;
  tr.querySelectorAll('.mp-item').forEach(function(it) { it.classList.remove('mp-focused'); });
  item.classList.add('mp-focused');
  tr._mpFocusIdx = Array.prototype.indexOf.call(tr.querySelectorAll('.mp-item'), item);
}

function _multiPayKeydown(e) {
  var tr = document.querySelector('tr[data-multi-pay-row="true"]');
  if (!tr) return;
  var items = tr.querySelectorAll('.mp-item');
  if (!items.length) return;
  // Only handle when focus is within the panel.
  var inPanel = tr.contains(e.target);
  if (!inPanel) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    var ni = Math.min(tr._mpFocusIdx + 1, items.length - 1);
    _multiPayFocusItem(items[ni]);
    var alloc = items[ni].querySelector('.mp-alloc');
    if (alloc) alloc.focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    var pi = Math.max(tr._mpFocusIdx - 1, 0);
    _multiPayFocusItem(items[pi]);
    var alloc2 = items[pi].querySelector('.mp-alloc');
    if (alloc2) alloc2.focus();
  } else if (e.key === ' ') {
    // Space toggles selection when the focused item's check or alloc is active.
    if (e.target.classList.contains('mp-check') || e.target.classList.contains('mp-alloc')) {
      e.preventDefault();
      _multiPayToggleItem(items[tr._mpFocusIdx]);
    }
  }
  // Enter / Esc are handled by the extraBindings key table (NORMAL mode).
}

function _multiPaySelectedBills() {
  var tr = document.querySelector('tr[data-multi-pay-row="true"]');
  if (!tr) return [];
  var out = [];
  tr.querySelectorAll('.mp-item').forEach(function(item) {
    if (item._selected) {
      var billId = item.getAttribute('data-bill-id');
      var outstanding = parseFloat(item.getAttribute('data-outstanding')) || 0;
      var amt = parseFloat(item.querySelector('.mp-alloc').value) || 0;
      out.push({ billId: billId, outstanding: outstanding, amount: amt });
    }
  });
  return out;
}

function _multiPayAutoDistribute(totalAmount) {
  var tr = document.querySelector('tr[data-multi-pay-row="true"]');
  if (!tr) return;
  var selected = _multiPaySelectedBills();
  if (!selected.length) return;
  totalAmount = Math.round((parseFloat(totalAmount) || 0) * 100) / 100;
  var sumOut = 0;
  selected.forEach(function(s) { sumOut += s.outstanding; });
  if (sumOut <= 0) return;
  // Proportional by outstanding, 2dp. Remainder → largest bill.
  var distributed = 0;
  var largestIdx = 0;
  selected.forEach(function(s, i) {
    if (s.outstanding > selected[largestIdx].outstanding) largestIdx = i;
  });
  selected.forEach(function(s, i) {
    if (i === largestIdx) return;
    s.alloc = Math.round(totalAmount * (s.outstanding / sumOut) * 100) / 100;
    distributed += s.alloc;
  });
  selected[largestIdx].alloc = Math.round((totalAmount - distributed) * 100) / 100;
  // Write back to DOM.
  tr.querySelectorAll('.mp-item').forEach(function(item) {
    if (!item._selected) return;
    var billId = item.getAttribute('data-bill-id');
    var match = selected.filter(function(s) { return s.billId === billId; })[0];
    if (match) item.querySelector('.mp-alloc').value = match.alloc.toFixed(2);
  });
}

function _multiPayUpdateBalance() {
  var tr = document.querySelector('tr[data-multi-pay-row="true"]');
  if (!tr) return;
  var total = Math.round((parseFloat(tr.querySelector('.mp-total').value) || 0) * 100) / 100;
  var allocated = 0;
  tr.querySelectorAll('.mp-item').forEach(function(item) {
    if (item._selected) allocated += parseFloat(item.querySelector('.mp-alloc').value) || 0;
  });
  allocated = Math.round(allocated * 100) / 100;
  var bal = tr.querySelector('.mp-balance');
  if (!bal) return;
  if (allocated === total) {
    bal.textContent = 'Allocated: ' + allocated.toFixed(2) + ' / ' + total.toFixed(2) + ' \u2713';
    bal.className = 'mp-balance ok';
  } else {
    var diff = Math.round((total - allocated) * 100) / 100;
    bal.textContent = 'Allocated: ' + allocated.toFixed(2) + ' / ' + total.toFixed(2) + ' \u26a0 ' + Math.abs(diff).toFixed(2) + (diff > 0 ? ' unallocated' : ' over');
    bal.className = 'mp-balance warn';
  }
}

function closeMultiPayPanel() {
  var tr = document.querySelector('tr[data-multi-pay-row="true"]');
  if (tr) tr.remove();
  FB.mode.set('NORMAL');
}

function submitMultiPayPanel() {
  var tr = document.querySelector('tr[data-multi-pay-row="true"]');
  if (!tr || tr._submitting) return;
  var date = tr.querySelector('.mp-date').value;
  var acct = tr.querySelector('.mp-acct').value.trim();
  var ref = tr.querySelector('.mp-ref').value.trim();
  var total = Math.round((parseFloat(tr.querySelector('.mp-total').value) || 0) * 100) / 100;
  var fxIn = tr.querySelector('.mp-fx');
  var fxRate = (fxIn && fxIn.value !== '') ? parseFloat(fxIn.value) : null;
  var selected = _multiPaySelectedBills();

  if (!date) { billEditMsg('Payment date required', 'err'); return; }
  if (!acct) { billEditMsg('Bank account required', 'err'); tr.querySelector('.mp-acct').focus(); return; }
  if (selected.length < 2) { billEditMsg('Select at least 2 bills for multi-bill settlement', 'err'); return; }
  var allocSum = 0, badAmt = false;
  var allocations = selected.map(function(s) {
    var a = Math.round((parseFloat(s.amount) || 0) * 100) / 100;
    if (!(a > 0)) badAmt = true;
    allocSum += a;
    return { billId: s.billId, amount: a };
  });
  allocSum = Math.round(allocSum * 100) / 100;
  if (badAmt) { billEditMsg('Each allocation must be greater than zero', 'err'); return; }
  if (allocSum !== total) { billEditMsg('Allocations (' + allocSum.toFixed(2) + ') must equal total (' + total.toFixed(2) + ')', 'err'); return; }

  tr._submitting = true;
  billEditMsg('Recording multi-bill payment\u2026', '');
  var body = { action: 'bill.payment.record', companyId: COMPANY, date: date, bankAccount: acct,
    allocations: allocations };
  if (ref) body.reference = ref;
  if (fxRate != null) body.fxRate = fxRate;
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': tr._idem },
    body: JSON.stringify(body) })
  .then(function(r) { return r.json(); })
  .then(function(res) {
    tr._submitting = false;
    var d = res.data || res;
    if (res.error || (d && d.error)) {
      billEditMsg('Payment failed: ' + (res.error || d.error), 'err');
      return;
    }
    localStorage.setItem('fb.payAccount.' + COMPANY, acct);
    var n = (d.paymentIds && d.paymentIds.length) || (d.results && d.results.length) || allocations.length;
    closeMultiPayPanel();
    billEditMsg('Multi-bill payment recorded \u2014 ' + n + ' bill' + (n !== 1 ? 's' : '') + ' settled', 'ok');
    billChildCache = {};
    billsList.load();
  })
  .catch(function(e) { tr._submitting = false; billEditMsg('Payment failed: ' + e.message, 'err'); });
}

var billsList = FB.list.create({
  keysId: 'bills',
  active: function () {
    var p = document.getElementById('pay-panel-bills');
    return !!p && p.style.display !== 'none';
  },
  tbody: 'bills-tbody',
  companyId: function () { return COMPANY; },
  focusClass: 'bill-row-focus',
  onFocus: function (tr) {},
  tree: true,
  columns: [
    { field: 'partner_name', type: 'text', attach: billAttachPartner, sortable: true,
      display: function (v, r) { return partnerCell(r.partner_name || v || ''); }, label: 'Partner' },
    { field: 'date', type: 'date', sortable: true, filterType: 'date',
      display: function (v) {
        return '<span style="white-space:nowrap" title="' + esc(String(v || '').slice(0, 10)) + '">' + fmtDateShort(v) + '</span>';
      } },
    { field: 'due_date', type: 'date', sortable: true, filterType: 'date',
      display: function (v, r) {
        var due = v ? String(v).slice(0, 10) : '';
        var active = r.status === 'posted' || r.status === 'partial';
        var overdue = active && due && due < today;
        return '<span style="white-space:nowrap" title="' + esc(due) + '"><span' + (overdue ? ' class="overdue-date"' : '') + '>' + fmtDateShort(due) + '</span></span>';
      } },
    { field: 'vendor_ref', type: 'text', filterType: 'text',
      display: function (v, r) {
        var id = String(r.bill_id || r._key || '');
        return '<a href="/' + esc(COMPANY) + '/bill/' + esc(id) + '" class="ref-link" onclick="event.stopPropagation()">' + esc(v || '') + '</a>';
      } },
    { field: 'amount', type: 'number', ro: 'always', sortable: true, filterType: 'amount', align: 'right',
      display: function (v, r) {
        // For dirty draft bills the parent amount is the gross sum of the
        // in-buffer lines (net + GST override); the buffer's amount field is
        // stale (0 for new bills, last-saved for re-edited drafts). Recompute
        // from lines so re-renders (Tab-spawn, focus changes, fold toggles)
        // keep the parent total in sync with billRefreshParentTotal's live DOM.
        var amt = v || 0;
        if (r && r._dirty && Array.isArray(r.lines) && r.lines.length) {
          amt = billSumGross(r.lines);
        }
        return '<span class="amt" style="text-align:right;font-variant-numeric:tabular-nums">' + Number(amt).toFixed(2) + '</span>';
      } },
    { field: 'currency', type: 'text', ro: 'always', sortable: true, filterType: 'list',
      display: function (v, r) {
        var ccy = v || BASE_CURRENCY;
        // data-bill-date/data-bill-ccy carry the FX-tooltip inputs (_getFxRate
        // population is wired when the framework takes over rendering).
        return '<span class="ccy-cell" style="font-size:0.75rem;color:#666" data-bill-date="' + esc(String(r.date || '').slice(0, 10)) + '" data-bill-ccy="' + esc(ccy) + '">' + esc(ccy) + '</span>';
      } },
    { field: 'status', type: 'text', ro: 'always', sortable: true, filterType: 'list',
      display: function (v, r) {
        var due = r.due_date ? String(r.due_date).slice(0, 10) : null;
        return statusBadge(v, due) + ((v === 'posted' || v === 'partial') ? payAffordHtml(r) : '');
      } }
  ],
  label: '+ Add bill',
  list: { action: 'bill.list',
    map: function (b) {
      return {
        _key: b.bill_id, bill_id: b.bill_id, partner_name: b.partner_name || '', date: b.date || '',
        due_date: b.due_date || '', vendor_ref: b.vendor_ref || '', amount: b.amount || 0,
        amount_paid: b.amount_paid || 0, currency: b.currency || BASE_CURRENCY, status: b.status || '',
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
    loadFxRatesForKpi(function (rm) { computeKpis(saved, rm); });
  },
  onChrome: function () { _applyCcyColVisibility(); },
  // Task 6c — blank / isBlank / same / firstField. The framework calls these
  // when the + Add bill row is activated (newRow -> cfg.blank -> enterEdit ->
  // cfg.firstField) and on Esc of a new buffer (cfg.isBlank -> vanish or keep
  // dirty). same runs on Esc of a SAVED-draft re-edit (compare buffer vs saved
  // row; drop dirty if equal) — inert until 6d/6e wire saved-draft re-edit.
  // blank mirrors today's createDraftBill (L1526-1578): parent fields empty
  // except currency/ap_account/expense_account seeded from company defaults,
  // status 'draft', and ONE empty line (description/amount/vat_code blank,
  // expense_account + currency seeded). isBlank mirrors _isDraftEmpty
  // (L1474-1494): true when partner/date/ref all empty AND no line has a
  // description or positive amount (pre-filled defaults do not count).
  blank: function () {
    return { _isBill: true, isNew: true, partner_name: '', date: '', due_date: '',
      vendor_ref: '', amount: 0, currency: BASE_CURRENCY,
      ap_account: companyDefaultAp, expense_account: companyDefaultExpense,
      status: 'draft',
      lines: [ { description: '', expense_account: companyDefaultExpense,
        amount: 0, vat_code: '', vat_amount_override: null,
        currency: BASE_CURRENCY } ] };
  },
  isBlank: function (b) {
    if (!b.partner_name && !b.date && !b.vendor_ref) {
      return !(b.lines || []).some(function (l) {
        return l.description || (parseFloat(l.amount) > 0);
      });
    }
    return false;
  },
  // same(b, s): header fields equal AND lines deep-equal
  // (description/amount/vat_code). s is a saved row from bill.list.map (no
  // lines array until 6e loads them on re-edit); when s has no lines, a
  // header-only match is treated as same so a freshly opened saved draft with
  // no edits drops dirty. 6e refines this once saved-draft lines are loaded.
  same: function (b, s) {
    if ((b.partner_name || '') !== (s.partner_name || '')) return false;
    if (String(b.date || '') !== String(s.date || '')) return false;
    if (String(b.due_date || '') !== String(s.due_date || '')) return false;
    if ((b.vendor_ref || '') !== (s.vendor_ref || '')) return false;
    // Bill-level stated VAT (footer cell) is part of the dirty comparison.
    var _bSt = (b.vat_amount_stated != null && !isNaN(Number(b.vat_amount_stated))) ? Number(b.vat_amount_stated) : null;
    var _sSt = (Number(s.vat_amount) > 0) ? Number(s.vat_amount) : null;
    if (_bSt !== _sSt) return false;
    if ((b.currency || '') !== (s.currency || '')) return false;
    if ((b.ap_account || '') !== (s.ap_account || '')) return false;
    if ((b.expense_account || '') !== (s.expense_account || '')) return false;
    var bl = b.lines || [];
    // Saved rows from bill.list.map carry no lines array; when absent, compare
    // against the fetched server lines in billChildCache (the rows the re-edit
    // rendered from). Only reachable for drafts — posted bills aren't editable.
    var sl = s.lines;
    if (!sl) {
      var cache = billChildCache[s._key];
      sl = (cache && cache.fetched) ? (cache.lines || []) : null;
    }
    if (sl) {
      if (bl.length !== sl.length) return false;
      for (var i = 0; i < bl.length; i++) {
        if (!sl[i]) return false;
        if ((bl[i].description || '') !== (sl[i].description || '')) return false;
        if (Number(bl[i].amount || 0) !== Number(sl[i].amount || 0)) return false;
        if ((bl[i].vat_code || '') !== (sl[i].vat_code || '')) return false;
      }
    }
    return true;
  },
  firstField: function (isNew) { return 'partner_name'; },
  // ── Task 6d: child-line edit unit ──
  // EDIT-mode child row (framework owns the <tr> shell). Lines carry only the
  // VAT code — VAT amounts are always computed (redesign 2026-07-26: the
  // per-line GST input was removed; the stated VAT lives in the bill footer).
  // Grid matches view mode: desc colspan=3 (cols 0-2), expense-acct (col 3),
  // amount (col 4), spacer (col 5), vat (col 6), empty (col 7, actions).
  editChildRowHtml: function (parent, child, idx) {
    return '<td colspan="3"><input class="draft-input child-desc" placeholder="Line item description" value="' + esc(child.description || '') + '" /></td>'
      + '<td><input class="draft-input child-expense-acct" placeholder="Expense Acct" title="Expense account code" value="' + esc(child.expense_account || '') + '" /></td>'
      + '<td class="amt"><input class="draft-input child-amt" type="number" step="0.01" placeholder="0.00" value="' + (child.amount ? Number(child.amount).toFixed(2) : '') + '" style="text-align:right" /></td>'
      + '<td class="child-spacer"></td>'
      + (VAT_ON ? '<td><input class="draft-input child-vat" placeholder="— None —" title="VAT code" value="' + esc(child.vat_code || '') + '" style="width:72px" /></td>' : '<td></td>')
      + '<td></td>';
  },
  editFooterRowHtml: billFooterHtml,
  // Post-build hook per child row (framework calls it after innerHTML): wire
  // the account + VAT dropdowns, the live totals refresh, and the Tab /
  // Shift+Tab field flow (payables spec).
  attachChild: function (tr, parent, idx) {
    var expInp = tr.querySelector('.child-expense-acct');
    if (expInp) _attachAcctDropdown(expInp);
    var vatInp = tr.querySelector('.child-vat');
    var amtInp = tr.querySelector('.child-amt');
    if (vatInp) _attachVatDropdown(vatInp, function () { billRefreshParentTotal(tr); });
    if (amtInp) amtInp.addEventListener('input', function () { billRefreshParentTotal(tr); });
    tr.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var sib = tr.nextElementSibling;
      var isLast = !sib || !sib.dataset || sib.dataset.childOf !== String(parent._key);
      // Forward Tab on the last child's last field (VAT code) → the bill
      // footer's stated-VAT cell (the footer is the next stop in the chain).
      if (!e.shiftKey && isLast && e.target === vatInp) {
        e.preventDefault();
        var ftr = tr.parentNode.querySelector('tr.fb-edit-footer[data-footer-of="' + String(parent._key) + '"]');
        var finp = ftr && ftr.querySelector('.bill-vat-stated');
        if (finp) { finp.focus(); finp.select(); }
        return;
      }
      // Shift+Tab on the FIRST child's desc → back to the parent's last input.
      if (e.shiftKey && e.target.classList.contains('child-desc')) {
        var prev = tr.previousElementSibling;
        var isFirst = !(prev && prev.dataset && prev.dataset.childOf === String(parent._key));
        if (isFirst) {
          e.preventDefault();
          if (prev) { var pin = prev.querySelector('.fb-e-vendor_ref') || prev.querySelector('input'); if (pin) pin.focus(); }
        }
      }
    });
  },
  attachFooter: billAttachFooter,
  // Read one child row's inputs back into a line object (framework exitEditTree).
  harvestChild: function (tr) {
    return {
      description: ((tr.querySelector('.child-desc') || {}).value || '').trim(),
      expense_account: ((tr.querySelector('.child-expense-acct') || {}).value || '').trim(),
      amount: parseFloat((tr.querySelector('.child-amt') || {}).value) || 0,
      vat_code: ((tr.querySelector('.child-vat') || {}).value || '').trim()
    };
  },
  // Non-column payload fields: partner_id / ap_account / expense_account travel
  // on the partner input's dataset (set on pick/blur-resolve). Untouched edit →
  // dataset empty → fall back to the row's saved values. Without this the
  // buffer drops AP/expense on every save (duplicate-save bug's silent twin).
  harvestExtra: function (tr, row, buf) {
    var vin = tr.querySelector('.fb-e-partner_name');
    var ds = (vin && vin.dataset) || {};
    buf.vat_amount_stated = (row.vat_amount_stated != null && !isNaN(Number(row.vat_amount_stated))) ? Number(row.vat_amount_stated) : null;
    buf.partner_id = ds.partnerId || row.partner_id || '';
    buf.ap_account = ds.apAccount || row.ap_account || '';
    buf.expense_account = ds.expenseAccount || row.expense_account || '';
    if (ds.partnerCurrency && FX_ON) buf.currency = ds.partnerCurrency;
  },
  // a-verb / Tab-spawn: the framework appends this shape to the bill buffer.
  addChild: function (parent) {
    return { description: '', expense_account: companyDefaultExpense || '', amount: 0, vat_code: '', currency: parent.currency || BASE_CURRENCY };
  },
  // Task 6e — bill-level draft validation. Mirrors saveDraftToDb guards
  // (L2156-2163) plus the per-line checks the post path enforces: partner
  // from the dropdown, bill date present, due date present and not before
  // the bill date, at least one non-empty line, an expense account on every
  // line, numeric line amounts, and every VAT code blank or known. Returns
  // an error string or null.
  validate: billValidateBuf,
  // Task 6e — ONE bill.draft.save write carries header + all lines. body maps
  // the bill buffer to the exact payload shape saveDraftToDb /
  // _gatherInlineBillData sends (field names identical; the server action is
  // unchanged). The framework merges { action, companyId } around body.
  // focusKey returns the saved bill's key so the cursor lands on it after the
  // post-save reload (saved draft re-renders as display, fold closes).
  save: {
    action: 'bill.draft.save',
    body: billSaveBody,
    focusKey: function (b, res) { return b._isNew ? (res.billId || b._key) : b._key; }
  },
  // Task 6e — draft delete. confirm prompts before the framework posts
  // bill.draft.delete; body sends the saved draft's _key as billId. cfg.
  // deletable (Task 6f) restricts x to drafts; the framework drops unsaved
  // new buffers without calling del.
  del: {
    action: 'bill.draft.delete',
    body: function (b) { return { billId: b._key }; },
    confirm: function (b) { return 'Delete draft bill from "' + (b.partner_name || '?') + '"?'; },
    deleted: function () { return 'Draft deleted'; }
  },
  // Task 6f — drafts are the only editable/deletable bills; everything else
  // is a verb (post / pay / void), never an edit.
  editable: function (d) { return d.status === 'draft'; },
  deletable: function (d) { return d.status === 'draft'; },
  // Screen verbs (framework PREPENDS these; guards keep built-ins as fallback).
  extraBindings: function (api) {
    function parentOf(d) { return d && d._childOf ? api.rowByKey(d._childOf) : d; }
    function reloadBills() { billChildCache = {}; billsList.load(); }
    // Anchor for the pay row: the focused parent <tr> in the framework table.
    function focusedParentTr() {
      var tb = document.getElementById('bills-tbody');
      var tr = tb && tb.querySelector('tr.bill-row-focus');
      while (tr && tr.dataset && tr.dataset.childOf) tr = tr.previousElementSibling;
      return tr || null;
    }
    function voidBill(p) {
      if (p.status === 'void') { FB.status.show('Bill is already void — cannot be modified.', true); return; }
      if (p.status === 'paid') { FB.status.show('Bill is fully paid — reversal must be done via a credit note or payment reversal.', true); return; }
      var partner = p.partner_name || p.bill_id;
      var msg = p.status === 'partial'
        ? 'Bill from "' + partner + '" is partially paid. Reversing will void the bill but will not reverse the payment. Continue?'
        : 'Reverse bill from "' + partner + '"? A reversal journal entry will be created. This cannot be undone.';
      if (!confirm(msg)) return;
      fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bill.void', companyId: COMPANY, billId: p.bill_id }) })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          var d = res.data || res;
          if (res.error || (d && d.error)) { FB.status.show('Cannot void: ' + (res.error || d.error), true); return; }
          FB.status.show('Bill voided', false); reloadBills();
        })
        .catch(function (e) { FB.status.show('Error: ' + e.message, true); });
    }
    function voidPayment(child) {
      if (child.voided === true || child.voided === 'true' || child.voided_at) { FB.status.show('Payment already voided', true); return; }
      var msg = 'Void this payment? A reversal journal entry will be created.';
      // Multi-bill payment: voiding reverses the entire batch (all bills).
      if (child._isMultiBill) msg = 'This was part of a multi-bill payment. Voiding will reverse the entire payment (all bills). Continue?';
      if (!confirm(msg)) return;
      fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bill.payment.void', companyId: COMPANY, paymentId: child.payment_id }) })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          var d = res.data || res;
          if (res.error || (d && d.error)) { FB.status.show('Void failed: ' + (res.error || d.error), true); return; }
          FB.status.show('Payment voided — bill ' + (d.newStatus || ''), false); reloadBills();
        })
        .catch(function (e) { FB.status.show('Void failed: ' + e.message, true); });
    }
    function postDraft(p) {
      // p on a draft: new bill → bill.create; saved draft → save-if-dirty, then bill.draft.post.
      if (p._isNew) {
        var err = billValidateBuf(p);
        if (err) { FB.status.show(err, true); return; }
        var body = billSaveBody(p);
        delete body.bill.bill_id;
        FB.status.show('Posting…', false);
        fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'bill.create', companyId: COMPANY, bill: body.bill }) })
          .then(function (r) { return r.json(); })
          .then(function (res) {
            var d = res.data || res;
            if (res.error || (d && d.error)) { FB.status.show('Post failed: ' + (res.error || d.error), true); return; }
            var _w = (d && d.warnings) || [];
            if (_w.length) FB.status.show('Posted with warning: ' + _w.join(' · '), 'warn');
            else FB.status.show('Bill posted', false);
            reloadBills();
          })
          .catch(function (e) { FB.status.show('Post failed: ' + e.message, true); });
        return;
      }
      var sendPost = function () {
        FB.status.show('Posting…', false);
        fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'bill.draft.post', companyId: COMPANY, billId: p.bill_id,
            bill: { ap_account: p.ap_account || companyDefaultAp || '' } }) })
          .then(function (r) { return r.json(); })
          .then(function (res) {
            var d = res.data || res;
            if (res.error || (d && d.error)) { FB.status.show('Post failed: ' + (res.error || d.error), true); return; }
            var _w = (d && d.warnings) || [];
            if (_w.length) FB.status.show('Posted with warning: ' + _w.join(' · '), 'warn');
            else FB.status.show('Bill posted', false);
            reloadBills();
          })
          .catch(function (e) { FB.status.show('Post failed: ' + e.message, true); });
      };
      if (p._dirty) api.writeFocused().then(function (ok) { if (ok) sendPost(); });
      else sendPost();
    }
    return [
      // Pay-row sub-mode (NORMAL mode; the pay row is DOM-injected, not a bill edit).
      { key: 'Enter', mode: 'NORMAL', paletteEligible: false, when: payRowOpen, run: submitPayRow },
      { key: 'Escape', mode: 'NORMAL', paletteEligible: false, when: payRowOpen, run: closePayRow },
      { key: 'I', mode: 'NORMAL', hint: 'edit in full editor', paletteEligible: false,
        when: function () { var p = parentOf(api.focusedRow()); return !!(p && p.status === 'draft'); },
        run: function () {
          var p = parentOf(api.focusedRow());
          fbNavigate('/' + COMPANY + '/bill/edit?id=' + encodeURIComponent(p.bill_id));
        } },
      { key: 'p', mode: 'NORMAL', hint: 'post/pay', hintBar: true,
        when: function () { return !payRowOpen() && !multiPayRowOpen() && !!parentOf(api.focusedRow()); },
        run: function () {
          var p = parentOf(api.focusedRow()); if (!p) return;
          if (p.status === 'posted' || p.status === 'partial') {
            var tr = focusedParentTr(); if (tr) openPayRowData(tr, p);
            return;
          }
          if (p.status === 'draft') postDraft(p);
        } },
      { key: 'P', mode: 'NORMAL', hint: 'multi-pay', hintBar: true,
        when: function () { return !multiPayRowOpen() && !payRowOpen() && !!parentOf(api.focusedRow()); },
        run: function () {
          var p = parentOf(api.focusedRow()); if (!p) return;
          if (p.status !== 'posted' && p.status !== 'partial') { FB.status.show('Multi-bill settlement requires a posted or partial bill', true); return; }
          var tr = focusedParentTr(); if (tr) openMultiPayPanel(tr, p);
        } },
      // Multi-pay panel submit/cancel (NORMAL mode; the panel is DOM-injected).
      { key: 'Enter', mode: 'NORMAL', paletteEligible: false, when: multiPayRowOpen, run: submitMultiPayPanel },
      { key: 'Escape', mode: 'NORMAL', paletteEligible: false, when: multiPayRowOpen, run: closeMultiPayPanel },
      { key: 'x', mode: 'NORMAL', hint: 'void', hintBar: true,
        when: function () {
          var d = api.focusedRow(); if (!d) return false;
          if (d._kind === 'payment') return true; // payment-history child → void payment
          var p = parentOf(d);
          return !!(p && !p._isNew && p.status && p.status !== 'draft'); // posted/partial/paid/void → void bill
        },
        run: function () {
          var d = api.focusedRow(); if (!d) return;
          if (d._kind === 'payment') { voidPayment(d); return; }
          var p = parentOf(d); if (p) voidBill(p);
        } }
    ];
  }
});

// ========== TAB SWITCHER (simplified — single Bills panel) ==========
// 2026-08-11 IA restructure: Partners tab moved to Master Data page. Bills is
// now the only panel; showPayTab is kept as a no-op shim for compatibility.
function showPayTab(t) {
  if (window.FB && FB.list && FB.list.anyDirty()) {
    FB.list.guard(function(){ showPayTab(t); });
    return;
  }
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
