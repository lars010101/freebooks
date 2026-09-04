'use strict';
/**
 * freeBooks — New Payment (bill-post-payment-consolidation-spec.md §3)
 *
 * Single surface for every human-recorded bill payment — single, partial, or
 * multi-bill alike. Replaces payables-bills.js's retired inline pay-row
 * (P1-9) and multi-pay panel (P1-9b). Reachable from the top-bar `+` New menu
 * (unscoped — pick the vendor, then the bill(s)) or from `y` on a
 * posted/partial Bills row (?billId=… — pre-scoped to that one bill, with
 * the option to add more of the same vendor+currency's open bills before
 * submitting).
 *
 * No new backend surface: payment.record already branches on whether
 * `allocations` is present (bills.js handleBills) — this page is a pure UI
 * consolidation onto that existing, unmodified contract.
 */
const { makeQuery, commonStyle, navBar, layoutEnd, getRelevanceFlags } = require('./common');

async function handlePaymentNewPage(req, res) {
  const { company } = req.params;
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const flags = await getRelevanceFlags(company);
    res.send(buildPaymentNewPage(company, req.query.billId || null, flags));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function buildPaymentNewPage(company, billId, flags) {
  const fxOn = !flags || flags.fxTracking !== 'off';
  const baseCcy = (flags && flags.baseCurrency) || '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>New Payment - freeBooks</title>
${commonStyle()}
<style>
  .pn-header { display:grid; grid-template-columns: repeat(4, 1fr); gap:10px; align-items:end; margin-bottom:16px; }
  .pn-header label { display:flex; flex-direction:column; gap:3px; font-weight:600; font-size:9pt; text-transform:uppercase; color:#555; }
  .pn-header input { padding:4px 6px; border:1px solid #ccc; border-radius:4px; font-size:10pt; height:32px; box-sizing:border-box; }
  .pn-bills { border:1px solid #e8e8e8; border-radius:4px; margin-bottom:12px; }
  .pn-bill-row, .pn-bill-head { display:grid; grid-template-columns: 28px 90px 1fr 90px 60px 110px; gap:8px; align-items:center; padding:6px 10px; border-bottom:1px solid #f0f0f0; }
  .pn-bill-head { font-weight:600; font-size:8pt; text-transform:uppercase; color:#888; letter-spacing:.03em; background:#fafafa; border-radius:4px 4px 0 0; }
  .pn-bill-row:last-child { border-bottom:none; }
  .pn-bill-row.pn-off { opacity:0.45; }
  .pn-bill-row.pn-currency-locked { opacity:0.3; }
  .pn-bill-row input[type="checkbox"] { width:16px; height:16px; }
  .pn-bill-row input[type="number"] { width:100%; padding:4px 6px; border:1px solid #ddd; border-radius:3px; text-align:right; box-sizing:border-box; }
  .pn-outstanding { color:#888; font-variant-numeric:tabular-nums; text-align:right; }
  .pn-bill-ccy { display:inline-block; padding:1px 7px; border-radius:10px; background:#f0f0f0; color:#666; font-size:8pt; font-weight:600; }
  .pn-total-row { display:flex; gap:12px; align-items:center; margin-bottom:16px; }
  .pn-total-row input { width:110px; padding:4px 6px; border:1px solid #ccc; border-radius:4px; text-align:right; }
  .pn-total-row input[readonly] { background:#f5f5f5; color:#444; border-color:#e0e0e0; }
  .pn-msg { min-height:1em; font-size:10pt; }
  .pn-msg.err { color:#cc2222; } .pn-msg.ok { color:#2a8a2a; }
  input.req { border-color:#cc2222 !important; }
</style>
</head>
<body>${navBar(company, 'payables')}
<div class="page">
  <div class="header"><h1>New Payment</h1></div>

  <div class="pn-header">
    <label>Partner <input id="pn-partner" autocomplete="off" placeholder="start typing…"></label>
    <label>Date <input id="pn-date" type="date"></label>
    <label>Bank/cash account <input id="pn-acct" autocomplete="off" placeholder="e.g. 1020"></label>
    <label>Reference <input id="pn-ref" autocomplete="off" placeholder="optional"></label>
  </div>

  <!-- All of a partner's open bills, any currency — each row prints its own
       currency (multi-currency companies only). No currency to pick up
       front: the selection itself decides it (checking a bill of a given
       currency locks the rest to that currency, mirroring the existing
       backend guard against a mixed-currency multi-bill payment).
       Columns: Due date · Reference · Amount owed · Currency · Pay (the one
       editable cell — everything else here is the bill's own data, not
       something to enter). Total below is a pure computed sum of Pay, never
       a second place to type an amount. -->
  <div class="pn-bill-head">
    <span></span><span>Due</span><span>Reference</span><span style="text-align:right">Amount</span><span>Ccy</span><span style="text-align:right">Pay</span>
  </div>
  <div class="pn-bills" id="pn-bills"><div style="padding:12px;color:#888">Pick a partner to see open bills.</div></div>

  <div class="pn-total-row">
    <span>Total <input id="pn-total" type="number" step="0.01" readonly tabindex="-1"></span>
    <span id="pn-total-ccy" style="color:#666"></span>
  </div>

  <!-- FX rate is the LAST input step, after the total is known — not a
       currency-selection artifact. Appears only once the selected bills'
       currency differs from home, and shows the translated home-currency
       equivalent live as either the total or the rate changes. -->
  <div class="pn-header" id="pn-fx-row" style="display:none">
    <label>FX rate <input id="pn-fx" type="number" step="0.0001" min="0" placeholder="e.g. 1.35"></label>
    <span id="pn-home-equiv" style="color:#666;align-self:center"></span>
  </div>

  <div style="display:flex;gap:12px;align-items:center">
    <button class="btn-primary" id="pn-save" type="button">Save (w)</button>
    <button class="btn-sm" id="pn-back" type="button">Back (Esc)</button>
    <span class="pn-msg" id="pn-msg"></span>
  </div>
</div>
<script>
(function () {
'use strict';
const COMPANY = ${JSON.stringify(company)};
const FX_ON = ${fxOn ? 'true' : 'false'};
const BASE_CCY = ${JSON.stringify(baseCcy)};
const presetBillId = ${JSON.stringify(billId)};

const S = { partners: [], openForPartner: [], currency: BASE_CCY, saving: false, loadedPartner: null, lastFxCurrency: null };

function msg(text, cls) {
  const el = document.getElementById('pn-msg');
  el.textContent = text || '';
  el.className = 'pn-msg' + (cls ? ' ' + cls : '');
}
function apiAction(action, payload) {
  return fetch('/api/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action, companyId: COMPANY }, payload || {})),
  }).then(r => r.json()).then(res => {
    if (res && res.ok === false) { const e = new Error(res.error.message); e.code = res.error.code; e.details = res.error.details; throw e; }
    return res.data !== undefined ? res.data : res;
  });
}

document.getElementById('pn-date').value = FB.util.today();
document.getElementById('pn-back').onclick = () => { window.location.href = '/' + COMPANY + '/payables'; };
document.getElementById('pn-save').onclick = () => submit();

// ── Bank account dropdown (cash accounts only — cf_category='Cash') ────────
let accounts = [];
apiAction('coa.list').then(rows => { accounts = rows || []; });
FB.dropdown.attach(document.getElementById('pn-acct'), {
  source: q => {
    q = (q || '').toLowerCase();
    return accounts.filter(a => a.cf_category === 'Cash' && a.is_active !== false)
      .filter(a => !q || a.account_code.toLowerCase().includes(q) || (a.account_name || '').toLowerCase().includes(q))
      .map(a => ({ primary: a.account_code, secondary: a.account_name || '', data: a }));
  },
  onPick: (it, inp) => { inp.value = it.primary; },
});
const savedAcct = localStorage.getItem('fb.payAccount.' + COMPANY);
if (savedAcct) document.getElementById('pn-acct').value = savedAcct;

// ── Partner picker (skipped straight past when a billId pre-scopes the page) ──
// Bills fully support a free-text partner_name with no partners-table row at
// all (partner_id null — tested, deliberate: "allows bill.create with
// partner_id=null"). So a vendor that was only ever typed on a bill, never
// set up as a real Partner record, has open bills but no dropdown suggestion
// unless we also source suggestions from bills themselves — hence fetching
// the full bill list up front (once, like accounts/partners already are)
// instead of lazily inside loadQualifying(): it now doubles as both the
// free-text autocomplete source and loadQualifying's own data, with no
// per-pick round-trip.
apiAction('partner.list', { partner_type: 'vendor' }).then(d => { S.partners = d || []; });
let allBills = [];
apiAction('bill.list', { threshold: 100000 }).then(result => {
  // bill.list's own handler shape ({data, total}, or {data:[], total,
  // tooMany:true} over threshold) — apiAction only unwraps the outer
  // {ok, data} envelope, not this inner one too.
  allBills = (result && result.data) || [];
});
FB.dropdown.attach(document.getElementById('pn-partner'), {
  minWidth: 260,
  source: q => {
    q = (q || '').toLowerCase();
    const seen = {};
    const out = [];
    S.partners.forEach(v => {
      const key = (v.name || '').toLowerCase();
      if (q && !key.includes(q)) return;
      seen[key] = true;
      out.push({ primary: v.name, secondary: v.default_currency || '', data: v });
    });
    // Free-text names (bills with no matching partners row) — deduped
    // against real partners above, and against each other (one suggestion
    // per distinct name, however many bills carry it).
    allBills.forEach(b => {
      const name = b.partner_name;
      if (!name) return;
      const key = name.toLowerCase();
      if (seen[key]) return;
      if (q && !key.includes(q)) return;
      seen[key] = true;
      out.push({ primary: name, secondary: 'free-text', data: null });
    });
    return out;
  },
  onPick: (it, inp) => { inp.value = it.primary; loadQualifying(it.primary); },
});
document.getElementById('pn-partner').addEventListener('blur', () => {
  // 220ms: FB.dropdown's own blur-close runs a 150ms setTimeout first — if
  // this blur was actually a click on a suggestion, onPick (and its
  // loadQualifying call, which sets S.loadedPartner) has already run by then.
  setTimeout(() => {
    const typed = document.getElementById('pn-partner').value.trim();
    if (!typed || typed === S.loadedPartner) return;
    loadQualifying(typed);
  }, 220);
});

// ── Load this partner's open (posted/partial, outstanding>0) bills —
// mirrors payables-bills.js's retired openMultiPayPanel query, now a filter
// over the up-front bill fetch instead of a DOM scan or a per-pick round
// trip. preselectId (if given) starts checked; the rest start unchecked —
// the operator opts more bills into the same payment.
//
// All open bills show at once, any currency — nothing to pick up front.
// One payment is still one bank transaction in one currency (a real
// constraint — matches the existing backend guard rejecting a mixed-
// currency multi-bill payment), but that only matters once the operator
// actually starts checking boxes; see onSelectionChanged() below, which
// locks further selection to whichever currency was checked first instead
// of asking the question before there's anything to answer. ──
function loadQualifying(partnerName, preselectId) {
  document.getElementById('pn-partner').value = partnerName;
  S.loadedPartner = partnerName;
  const pn = (partnerName || '').toLowerCase();
  S.openForPartner = allBills.filter(b =>
    (b.partner_name || '').toLowerCase() === pn &&
    (b.status === 'posted' || b.status === 'partial') &&
    (Number(b.amount) || 0) - (Number(b.amount_paid) || 0) > 0
  );
  S.lastFxCurrency = null; // forces a fresh fx.rates.get once a foreign bill is checked
  renderBills(preselectId);
}

// Columns, in order: checkbox · Due date · Reference · Amount owed ·
// Currency · Pay (the only editable cell — everything else is the bill's
// own data, read-only). Pay defaults to the full outstanding amount and is
// editable down for a partial payment.
function renderBills(preselectId) {
  const host = document.getElementById('pn-bills');
  if (!S.openForPartner.length) { host.innerHTML = '<div style="padding:12px;color:#888">No open bills for this partner.</div>'; onSelectionChanged(); return; }
  host.innerHTML = S.openForPartner.map(b => {
    const out = Math.max(0, Math.round(((Number(b.amount) || 0) - (Number(b.amount_paid) || 0)) * 100) / 100);
    const checked = preselectId ? (b.bill_id === preselectId) : false;
    const ccy = b.currency || BASE_CCY;
    const due = b.due_date ? String(b.due_date).slice(0, 10) : '—';
    return '<div class="pn-bill-row' + (checked ? '' : ' pn-off') + '" data-bill-id="' + b.bill_id + '" data-currency="' + FB.util.escAttr(ccy) + '" data-outstanding="' + out + '">'
      + '<input type="checkbox" class="pn-check"' + (checked ? ' checked' : '') + '>'
      + '<span>' + FB.util.esc(due) + '</span>'
      + '<span>' + FB.util.esc(b.vendor_ref || '—') + '</span>'
      + '<span class="pn-outstanding">' + out.toFixed(2) + '</span>'
      + (FX_ON ? '<span class="pn-bill-ccy">' + FB.util.esc(ccy) + '</span>' : '<span></span>')
      + '<input type="number" class="pn-alloc" step="0.01" min="0" value="' + (checked ? out.toFixed(2) : '') + '"' + (checked ? '' : ' disabled') + '>'
      + '</div>';
  }).join('');
  host.querySelectorAll('.pn-bill-row').forEach(row => {
    const cb = row.querySelector('.pn-check');
    const alloc = row.querySelector('.pn-alloc');
    cb.addEventListener('change', () => {
      row.classList.toggle('pn-off', !cb.checked);
      alloc.disabled = !cb.checked;
      if (cb.checked && !alloc.value) alloc.value = row.dataset.outstanding;
      onSelectionChanged();
    });
    alloc.addEventListener('input', () => { updateTotal(); updateHomeEquiv(); });
  });
  onSelectionChanged();
}

// Selected bills decide the payment's currency — not an upfront picker.
// Locks other-currency checkboxes once any box is checked (client-side
// mirror of the backend's own mixed-currency guard, before a doomed submit
// rather than after), shows the FX row only once that currency differs
// from home, and keeps the total's currency tag + home-equivalent readout
// current. Runs on every check/uncheck.
function onSelectionChanged() {
  const rows = selectedRows();
  const ccy = rows.length ? rows[0].dataset.currency : null;
  S.currency = ccy || BASE_CCY;

  document.querySelectorAll('.pn-bill-row').forEach(row => {
    const isOther = !!ccy && row.dataset.currency !== ccy;
    const cb = row.querySelector('.pn-check');
    if (!cb.checked) cb.disabled = isOther;
    row.classList.toggle('pn-currency-locked', isOther && !cb.checked);
  });

  document.getElementById('pn-total-ccy').textContent = (FX_ON && ccy) ? ccy : '';

  const showFx = FX_ON && !!ccy && ccy !== BASE_CCY;
  document.getElementById('pn-fx-row').style.display = showFx ? '' : 'none';
  if (showFx && ccy !== S.lastFxCurrency) {
    S.lastFxCurrency = ccy;
    apiAction('fx.rates.get', { fromCurrency: ccy, toCurrency: BASE_CCY, date: document.getElementById('pn-date').value })
      .then(d => { const el = document.getElementById('pn-fx'); if (d && d.rate != null) el.value = d.rate; updateHomeEquiv(); })
      .catch(() => {});
  }
  updateTotal();
  updateHomeEquiv();
}

// Total × FX rate = the translated home-currency amount — the whole reason
// a rate is asked for, shown as its direct consequence instead of left for
// the operator to work out by hand.
function updateHomeEquiv() {
  const el = document.getElementById('pn-home-equiv');
  if (document.getElementById('pn-fx-row').style.display === 'none') { el.textContent = ''; return; }
  const total = parseFloat(document.getElementById('pn-total').value) || 0;
  const rate = parseFloat(document.getElementById('pn-fx').value) || 0;
  el.textContent = rate > 0 ? ('≈ ' + (total * rate).toFixed(2) + ' ' + BASE_CCY) : '';
}

function selectedRows() {
  return Array.from(document.querySelectorAll('.pn-bill-row')).filter(r => r.querySelector('.pn-check').checked);
}
// Total is a pure computed sum of the per-line Pay amounts — never a second
// place to type a number. There is no reverse flow (edit Total, watch it
// redistribute into lines): the operator enters amounts on each line, Total
// just reflects that. readonly on the input (not disabled) keeps .value
// readable for updateHomeEquiv()/submit() without making it typable.
function updateTotal() {
  const total = selectedRows().reduce((s, r) => s + (parseFloat(r.querySelector('.pn-alloc').value) || 0), 0);
  document.getElementById('pn-total').value = total.toFixed(2);
}
document.getElementById('pn-fx').addEventListener('input', updateHomeEquiv);

// ── Submit ──────────────────────────────────────────────────────────────────
function submit() {
  if (S.saving) return;
  document.querySelectorAll('.req').forEach(el => el.classList.remove('req'));
  const date = document.getElementById('pn-date').value;
  const acct = document.getElementById('pn-acct').value.trim();
  const ref = document.getElementById('pn-ref').value.trim();
  const fxIn = document.getElementById('pn-fx');
  const fxRate = (fxIn && fxIn.value !== '') ? parseFloat(fxIn.value) : null;
  const rows = selectedRows();
  if (!date) { msg('Payment date required', 'err'); document.getElementById('pn-date').classList.add('req'); return; }
  if (!acct) { msg('Bank account required', 'err'); document.getElementById('pn-acct').classList.add('req'); return; }
  if (!rows.length) { msg('Select at least one bill', 'err'); return; }
  const allocations = rows.map(r => ({ billId: r.dataset.billId, amount: Math.round((parseFloat(r.querySelector('.pn-alloc').value) || 0) * 100) / 100 }));
  if (allocations.some(a => !(a.amount > 0))) { msg('Each allocation must be greater than zero', 'err'); return; }

  S.saving = true;
  msg('Recording payment…', '');
  const body = allocations.length === 1
    ? { action: 'payment.record', companyId: COMPANY, billId: allocations[0].billId, date, bankAccount: acct, amount: allocations[0].amount, reference: ref || undefined, fxRate: fxRate != null ? fxRate : undefined }
    : { action: 'payment.record', companyId: COMPANY, date, bankAccount: acct, allocations, reference: ref || undefined, fxRate: fxRate != null ? fxRate : undefined };
  apiAction(body.action, body).then(() => {
    localStorage.setItem('fb.payAccount.' + COMPANY, acct);
    msg('Payment recorded', 'ok');
    setTimeout(() => { window.location.href = '/' + COMPANY + '/payables'; }, 700);
  }).catch(e => { S.saving = false; msg(e.message, 'err'); });
}

document.addEventListener('keydown', function (e) {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') && e.key !== 'Escape') return;
  if (e.key === 'Escape') { window.location.href = '/' + COMPANY + '/payables'; }
});

// ── Pre-scope from a bill row's y (§2) ──────────────────────────────────────
if (presetBillId) {
  apiAction('bill.get', { billId: presetBillId }).then(bill => {
    loadQualifying(bill.partner_name, presetBillId);
  }).catch(e => msg('Could not load bill: ' + e.message, 'err'));
}
})();
<\/script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handlePaymentNewPage };
