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
 * No new backend surface: bill.payment.record already branches on whether
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
  .pn-bill-row { display:grid; grid-template-columns: 28px 1fr 90px 110px; gap:8px; align-items:center; padding:6px 10px; border-bottom:1px solid #f0f0f0; }
  .pn-bill-row:last-child { border-bottom:none; }
  .pn-bill-row.pn-off { opacity:0.45; }
  .pn-bill-row input[type="checkbox"] { width:16px; height:16px; }
  .pn-bill-row input[type="number"] { width:100%; padding:4px 6px; border:1px solid #ddd; border-radius:3px; text-align:right; box-sizing:border-box; }
  .pn-outstanding { color:#888; font-variant-numeric:tabular-nums; text-align:right; }
  .pn-total-row { display:flex; gap:12px; align-items:center; margin-bottom:16px; }
  .pn-total-row input { width:110px; padding:4px 6px; border:1px solid #ccc; border-radius:4px; text-align:right; }
  .pn-balance.ok { color:#2a8a2a; } .pn-balance.warn { color:#b26a00; }
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
  <div class="pn-header" id="pn-fx-row" style="display:none">
    <label>FX rate <input id="pn-fx" type="number" step="0.0001" min="0" placeholder="e.g. 1.35"></label>
  </div>

  <div class="pn-bills" id="pn-bills"><div style="padding:12px;color:#888">Pick a partner to see open bills.</div></div>

  <div class="pn-total-row">
    <span>Total <input id="pn-total" type="number" step="0.01" min="0"></span>
    <span id="pn-ccy" style="color:#666"></span>
    <span class="pn-balance" id="pn-balance"></span>
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

const S = { partners: [], qualifying: [], currency: BASE_CCY, saving: false };

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
apiAction('partner.list', { partner_type: 'vendor' }).then(d => { S.partners = d || []; });
FB.dropdown.attach(document.getElementById('pn-partner'), {
  minWidth: 260,
  source: q => {
    q = (q || '').toLowerCase();
    return S.partners.filter(v => (v.name || '').toLowerCase().includes(q))
      .map(v => ({ primary: v.name, secondary: v.default_currency || '', data: v }));
  },
  onPick: (it, inp) => { inp.value = it.primary; loadQualifying(it.primary, it.data.default_currency || BASE_CCY); },
});

// ── Load this partner's open (posted/partial, outstanding>0) bills, same
// currency — mirrors payables-bills.js's retired openMultiPayPanel query,
// now a server round-trip instead of a DOM scan (this page has no bill list
// of its own to scan). preselectId (if given) starts checked; the rest
// start unchecked — the operator opts more bills into the same payment. ──
function loadQualifying(partnerName, currency, preselectId) {
  document.getElementById('pn-partner').value = partnerName;
  S.currency = currency || BASE_CCY;
  document.getElementById('pn-ccy').textContent = S.currency;
  document.getElementById('pn-fx-row').style.display = (FX_ON && S.currency !== BASE_CCY) ? '' : 'none';
  if (FX_ON && S.currency !== BASE_CCY) {
    apiAction('fx.rates.get', { fromCurrency: S.currency, toCurrency: BASE_CCY, date: document.getElementById('pn-date').value })
      .then(d => { const el = document.getElementById('pn-fx'); if (d && d.rate != null && !el.value) el.value = d.rate; })
      .catch(() => {});
  }
  apiAction('bill.list', { threshold: 100000 }).then(rows => {
    const pn = (partnerName || '').toLowerCase();
    S.qualifying = (rows || []).filter(b =>
      (b.partner_name || '').toLowerCase() === pn &&
      (b.currency || BASE_CCY) === S.currency &&
      (b.status === 'posted' || b.status === 'partial') &&
      (Number(b.amount) || 0) - (Number(b.amount_paid) || 0) > 0
    );
    renderBills(preselectId);
  }).catch(e => msg('Could not load bills: ' + e.message, 'err'));
}

function renderBills(preselectId) {
  const host = document.getElementById('pn-bills');
  if (!S.qualifying.length) { host.innerHTML = '<div style="padding:12px;color:#888">No open bills for this partner/currency.</div>'; updateBalance(); return; }
  host.innerHTML = S.qualifying.map(b => {
    const out = Math.max(0, Math.round(((Number(b.amount) || 0) - (Number(b.amount_paid) || 0)) * 100) / 100);
    const checked = preselectId ? (b.bill_id === preselectId) : false;
    return '<div class="pn-bill-row' + (checked ? '' : ' pn-off') + '" data-bill-id="' + b.bill_id + '" data-outstanding="' + out + '">'
      + '<input type="checkbox" class="pn-check"' + (checked ? ' checked' : '') + '>'
      + '<span>' + FB.util.esc((b.vendor_ref || '') + ' · ' + String(b.date || '').slice(0, 10)) + '</span>'
      + '<span class="pn-outstanding">' + out.toFixed(2) + '</span>'
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
      distributeFromTotal();
      updateBalance();
    });
    alloc.addEventListener('input', updateBalance);
  });
  const sum = S.qualifying.reduce((s, b) => {
    const row = host.querySelector('[data-bill-id="' + b.bill_id + '"]');
    return s + (row && row.querySelector('.pn-check').checked ? Number(row.dataset.outstanding) : 0);
  }, 0);
  document.getElementById('pn-total').value = sum.toFixed(2);
  updateBalance();
}

function selectedRows() {
  return Array.from(document.querySelectorAll('.pn-bill-row')).filter(r => r.querySelector('.pn-check').checked);
}
function distributeFromTotal() {
  const rows = selectedRows();
  if (!rows.length) return;
  const total = Math.round((parseFloat(document.getElementById('pn-total').value) || 0) * 100) / 100;
  const sumOut = rows.reduce((s, r) => s + Number(r.dataset.outstanding), 0);
  if (sumOut <= 0) return;
  let distributed = 0, largest = rows[0];
  rows.forEach(r => { if (Number(r.dataset.outstanding) > Number(largest.dataset.outstanding)) largest = r; });
  rows.forEach(r => {
    if (r === largest) return;
    const a = Math.round(total * (Number(r.dataset.outstanding) / sumOut) * 100) / 100;
    distributed += a;
    r.querySelector('.pn-alloc').value = a.toFixed(2);
  });
  largest.querySelector('.pn-alloc').value = Math.round((total - distributed) * 100) / 100;
}
function updateBalance() {
  const total = Math.round((parseFloat(document.getElementById('pn-total').value) || 0) * 100) / 100;
  const allocated = selectedRows().reduce((s, r) => s + (parseFloat(r.querySelector('.pn-alloc').value) || 0), 0);
  const bal = document.getElementById('pn-balance');
  if (Math.round(allocated * 100) / 100 === total) { bal.textContent = 'Allocated: ' + allocated.toFixed(2) + ' / ' + total.toFixed(2) + ' \\u2713'; bal.className = 'pn-balance ok'; }
  else { bal.textContent = 'Allocated: ' + allocated.toFixed(2) + ' / ' + total.toFixed(2); bal.className = 'pn-balance warn'; }
}
document.getElementById('pn-total').addEventListener('input', () => { distributeFromTotal(); updateBalance(); });

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
  const total = Math.round((parseFloat(document.getElementById('pn-total').value) || 0) * 100) / 100;
  const sum = Math.round(allocations.reduce((s, a) => s + a.amount, 0) * 100) / 100;
  if (sum !== total) { msg('Allocations (' + sum.toFixed(2) + ') must equal total (' + total.toFixed(2) + ')', 'err'); return; }

  S.saving = true;
  msg('Recording payment…', '');
  const body = allocations.length === 1
    ? { action: 'bill.payment.record', companyId: COMPANY, billId: allocations[0].billId, date, bankAccount: acct, amount: allocations[0].amount, reference: ref || undefined, fxRate: fxRate != null ? fxRate : undefined }
    : { action: 'bill.payment.record', companyId: COMPANY, date, bankAccount: acct, allocations, reference: ref || undefined, fxRate: fxRate != null ? fxRate : undefined };
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
    loadQualifying(bill.partner_name, bill.currency, presetBillId);
  }).catch(e => msg('Could not load bill: ' + e.message, 'err'));
}
})();
<\/script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handlePaymentNewPage };
