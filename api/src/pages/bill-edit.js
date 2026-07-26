'use strict';
/**
 * freeBooks — Full-page bill editor (P1-4)
 *
 * Escape hatch for complex bills (many lines, attachments, per-line VAT
 * review). Same interaction semantics as the tree-table (spec:
 * docs/payables-ux-spec.md §P1-4): loads in INSERT, Esc saves-and-returns,
 * server computes totals (never sends bill.amount), FX from master data at
 * post, supplier-stated per-line GST with tolerance warnings.
 *
 * Deviations flagged for magnus (see commit message):
 * - `p` cannot be a letter-key command on an always-INSERT surface (it would
 *   type). Post = Ctrl+Enter (also a Post button). `p` fires only when focus
 *   is NOT in an editable field.
 * - Line delete is a per-row × icon (mouse); keyboard line-delete pending
 *   magnus's call (x would type).
 */
const { makeQuery, commonStyle, navBar, layoutEnd } = require('./common');

async function handleBillEditPage(req, res) {
  const { company } = req.params;
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildBillEditPage(company, req.query.id || null));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function buildBillEditPage(company, editId) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Bill Editor - freeBooks</title>
${commonStyle()}
<style>
  .be-wrap { max-width:1100px; }
  .be-card { background:var(--surface,#fff); border:1px solid var(--border,#e0e0e0); border-radius:6px; padding:14px 16px; margin-bottom:14px; }
  .be-card h3 { margin:0 0 10px 0; font-size:9pt; text-transform:uppercase; color:#888; letter-spacing:.05em; }
  .be-header-grid { display:grid; grid-template-columns:2fr 1fr 1fr 1fr 1fr 1fr; gap:10px; }
  .be-field label { display:block; font-size:8pt; color:#888; margin-bottom:3px; text-transform:uppercase; }
  .be-field input { width:100%; padding:6px 8px; border:1px solid #ccc; border-radius:4px; font-size:10pt; box-sizing:border-box; }
  table.be-lines { width:100%; border-collapse:collapse; font-size:10pt; }
  table.be-lines th { text-align:left; font-size:8pt; text-transform:uppercase; color:#888; border-bottom:1px solid var(--border,#ddd); padding:4px 6px; }
  table.be-lines td { padding:3px 4px; border-bottom:1px solid #f2f2f2; }
  table.be-lines input, table.be-lines select { width:100%; padding:5px 6px; border:1px solid #ccc; border-radius:3px; font-size:10pt; box-sizing:border-box; }
  .be-line-x { visibility:hidden; cursor:pointer; color:#999; border:none; background:none; font-size:12pt; padding:0 4px; }
  tr:hover .be-line-x { visibility:visible; }
  .be-add-row { margin-top:6px; font-size:10pt; color:#5b8def; cursor:pointer; user-select:none; }
  .be-add-row.faded { color:#999; opacity:0.3; cursor:default; }
  .be-status { position:sticky; bottom:0; background:var(--surface,#fff); border-top:1px solid var(--border,#e0e0e0); padding:8px 16px; display:flex; gap:18px; align-items:center; font-size:10pt; }
  .be-totals { margin-left:auto; display:flex; gap:16px; font-variant-numeric:tabular-nums; }
  .be-totals b { font-weight:600; }
  .be-msg { min-height:1em; }
  .be-msg.err { color:#cc2222; }
  .be-msg.ok { color:#2a8a2a; }
  .be-msg.warn { color:#856404; }
  .be-attach-row { display:flex; align-items:center; gap:10px; padding:6px 0; border-bottom:1px solid #f2f2f2; font-size:10pt; }
  .be-attach-row .name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .be-attach-row .staged { color:#856404; font-size:8.5pt; }
  .btn-primary { padding:7px 16px; background:#1a3a6b; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:10pt; }
  .btn-plain { padding:7px 12px; background:none; border:1px solid #ccc; border-radius:4px; cursor:pointer; font-size:10pt; }
  input.req { border-color:#cc2222 !important; }
</style>
</head>
<body>${navBar(company, 'payables')}
<div class="be-wrap">
  <h1 id="be-title">New Bill <span style="color:#888;font-weight:400;font-size:10pt">— full editor</span></h1>

  <div class="be-card">
    <h3>Header</h3>
    <div class="be-header-grid">
      <div class="be-field"><label>Vendor *</label><input id="be-vendor" autocomplete="off" placeholder="start typing…"></div>
      <div class="be-field"><label>Bill date *</label><input id="be-date" type="date"></div>
      <div class="be-field"><label>Due date</label><input id="be-due" type="date"></div>
      <div class="be-field"><label>Vendor ref</label><input id="be-ref" autocomplete="off" placeholder="e.g. INV-123"></div>
      <div class="be-field"><label>CCY</label><input id="be-ccy" maxlength="3" autocomplete="off" style="text-transform:uppercase"></div>
      <div class="be-field"><label>AP account</label><input id="be-ap" autocomplete="off"></div>
    </div>
  </div>

  <div class="be-card">
    <h3>Lines</h3>
    <table class="be-lines">
      <thead><tr>
        <th style="width:28%">Description</th>
        <th style="width:16%">Expense account</th>
        <th style="width:10%">Amount</th>
        <th style="width:10%">VAT code</th>
        <th style="width:12%">Cost center</th>
        <th style="width:12%">Profit center</th>
        <th style="width:2%"></th>
      </tr></thead>
      <tbody id="be-lines-body"></tbody>
    </table>
    <div class="be-add-row" id="be-add-row">+ add line (a)</div>
  </div>

  <div class="be-card">
    <h3>Attachments</h3>
    <div id="be-attach-list"></div>
    <input type="file" id="be-file" style="display:none">
    <button class="btn-plain" id="be-attach-btn" type="button">📎 attach file (A)</button>
    <span style="font-size:8.5pt;color:#888;margin-left:8px">files stage locally until the first save</span>
  </div>

  <div class="be-status">
    <button class="btn-primary" id="be-post" type="button">Post bill (p)</button>
    <button class="btn-plain" id="be-save" type="button">Back (q)</button>
    <span class="be-msg" id="be-msg"></span>
    <div class="be-totals">
      <div id="be-code-rows" style="width:100%;font-size:8.5pt;color:#888;font-style:italic"></div>
      <span>Net <b id="be-tot-net">0.00</b></span>
      <span title="Supplier-stated VAT total — pre-filled computed; edit to match the supplier invoice; clear to return to computed">GST <input id="be-tot-gst" class="bill-vat-stated" type="number" step="0.01" style="width:90px;text-align:right"></span>
      <span>Gross <b id="be-tot-gross">0.00</b></span>
    </div>
  </div>
</div>
<script>
// IIFE-wrapped: fbNavigate re-executes inline scripts on SPA navigation —
// top-level const/let would throw "already declared" on every repeat visit.
(function () {
'use strict';
const COMPANY = ${JSON.stringify(company)};
// Server-embedded: fbNavigate re-executes this script BEFORE pushState, so
// window.location.search still holds the OLD page's query at parse time.
const editId = ${JSON.stringify(editId)};

const S = {
  vendors: [], accounts: [], vatCodes: [], centers: [], currencies: [],
  billId: editId || null,
  stagedFiles: [],       // File objects staged pre-first-save
  saving: false,
  savedSnapshot: null,   // JSON of last-saved (or initial) form state
};

function msg(text, cls) {
  const el = document.getElementById('be-msg');
  el.textContent = text || '';
  el.className = 'be-msg' + (cls ? ' ' + cls : '');
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

// ── Load ────────────────────────────────────────────────────────────────────
Promise.all([
  apiAction('vendor.list').then(d => { S.vendors = d || []; }),
  apiAction('coa.list').then(d => { S.accounts = d || []; }),
  apiAction('vat.codes.list').then(d => { S.vatCodes = d || []; }),
  apiAction('center.list').then(d => { S.centers = d || []; }),
  fetch('/db/currencies.json').then(r => r.json()).then(d => { S.currencies = d || []; }),
]).then(async () => {
  if (S.billId) await prefillFromDraft(S.billId);
  else {
    document.getElementById('be-date').value = FB.util.today();
    document.getElementById('be-due').value = FB.util.today();
    addLine({});
  }
  wireHeader();
  if (S.billId) document.getElementById('be-title').innerHTML = 'Edit draft bill <span style="color:#888;font-weight:400;font-size:10pt">— full editor</span>';
  updateTotals();
  takeSnapshot(); // baseline for dirty tracking
}).catch(function (e) {
  // Surface init failures in the status bar instead of dying silently —
  // a rejected fetch previously left the page static-HTML-only with no focus.
  msg('Load error: ' + (e && e.message ? e.message : e), 'err');
}).finally(function () {
  // Focus asserts unconditionally (even on wiring failure) and re-asserts
  // after paint to win any race with fbNavigate's post-swap work.
  var v = document.getElementById('be-vendor');
  if (v) v.focus();
  setTimeout(function () { var v2 = document.getElementById('be-vendor'); if (v2) v2.focus(); }, 50);
});

async function prefillFromDraft(id) {
  const [bill, lines] = await Promise.all([
    apiAction('bill.get', { billId: id }),
    apiAction('bill.lines', { billId: id }),
  ]);
  document.getElementById('be-vendor').value = bill.vendor || '';
  document.getElementById('be-date').value = (bill.date || '').slice(0, 10);
  document.getElementById('be-due').value = (bill.due_date || bill.date || '').slice(0, 10);
  document.getElementById('be-ref').value = bill.vendor_ref || '';
  document.getElementById('be-ccy').value = bill.currency || '';
  document.getElementById('be-ap').value = bill.ap_account || '';
  if (Number(bill.vat_amount) > 0) { // drafts: stated VAT total (0 = none)
    const el = document.getElementById('be-tot-gst');
    el.dataset.stated = '1';
    el.value = Number(bill.vat_amount).toFixed(2);
  }
  (lines || []).forEach(l => addLine({
    description: l.description || '',
    expense_account: l.account_code || '',
    amount: l.amount || '',
    vat_code: l.vat_code || '',
  }));
  if (!(lines || []).length) addLine({});
  loadAttachments();
}

// ── Header wiring (dropdowns + vendor defaults) ─────────────────────────────
function wireHeader() {
  FB.dropdown.attach(document.getElementById('be-vendor'), {
    keys: true, minWidth: 260,
    source: q => {
      q = (q || '').toLowerCase();
      return S.vendors.filter(v => (v.name || '').toLowerCase().includes(q))
        .map(v => ({ primary: v.name, secondary: v.default_currency || '', data: v }));
    },
    onPick: (it, inp) => {
      inp.value = it.primary;
      const v = it.data;
      if (v.default_currency && !document.getElementById('be-ccy').value) document.getElementById('be-ccy').value = v.default_currency;
      if (v.default_ap_account && !document.getElementById('be-ap').value) document.getElementById('be-ap').value = v.default_ap_account;
      if (v.payment_terms_days) {
        const d = document.getElementById('be-date').value;
        if (d) {
          const due = new Date(d); due.setDate(due.getDate() + Number(v.payment_terms_days));
          document.getElementById('be-due').value = due.toISOString().slice(0, 10);
        }
      }
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    },
  });
  attachCcy(document.getElementById('be-ccy'));
  attachAcct(document.getElementById('be-ap'));
}
function attachCcy(input) {
  FB.dropdown.attach(input, {
    keys: true,
    source: q => {
      q = (q || '').toLowerCase();
      return S.currencies.filter(c => c.code.toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q))
        .map(c => ({ primary: c.code, secondary: c.name, data: c }));
    },
    onPick: (it, inp) => { inp.value = it.primary; inp.dispatchEvent(new Event('input', { bubbles: true })); },
  });
}
function attachAcct(input) {
  FB.dropdown.attach(input, {
    keys: true, minWidth: 280,
    source: q => {
      q = (q || '').toLowerCase();
      return S.accounts.filter(a => a.account_code.toLowerCase().includes(q) || (a.account_name || '').toLowerCase().includes(q))
        .map(a => ({ primary: a.account_code, secondary: a.account_name, data: a }));
    },
    onPick: (it, inp) => { inp.value = it.primary; inp.dispatchEvent(new Event('input', { bubbles: true })); },
  });
}
function attachVat(sel) {
  FB.dropdown.attach(sel, {
    keys: true, minWidth: 220,
    source: q => {
      q = (q || '').toLowerCase();
      return [{ vat_code: '', description: 'none', rate: 0 }].concat(S.vatCodes)
        .filter(v => (v.vat_code || '').toLowerCase().includes(q) || (v.description || '').toLowerCase().includes(q))
        .map(v => ({ primary: v.vat_code || '—', secondary: v.description || '', data: v }));
    },
    onPick: (it, inp) => {
      inp.value = it.data.vat_code;
      inp.dataset.rate = it.data.rate != null ? it.data.rate : (it.data.rate_percent || 0);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    },
  });
}
function attachCenter(input, type) {
  FB.dropdown.attach(input, {
    keys: true, minWidth: 180,
    source: q => {
      q = (q || '').toLowerCase();
      return S.centers.filter(c => (!type || c.center_type === type))
        .filter(c => c.center_id.toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q))
        .map(c => ({ primary: c.center_id, secondary: c.name, data: c }));
    },
    onPick: (it, inp) => { inp.value = it.primary; inp.dispatchEvent(new Event('input', { bubbles: true })); },
  });
}

// ── Lines ───────────────────────────────────────────────────────────────────
function addLine(data) {
  const tbody = document.getElementById('be-lines-body');
  const tr = document.createElement('tr');
  tr.innerHTML =
    '<td><input class="bl-desc" value="' + FB.util.escAttr(data.description || '') + '" placeholder="line description"></td>' +
    '<td><input class="bl-acct" value="' + FB.util.escAttr(data.expense_account || '') + '" autocomplete="off"></td>' +
    '<td><input class="bl-amt" type="number" step="0.01" min="0" value="' + (data.amount !== '' && data.amount != null ? data.amount : '') + '"></td>' +
    '<td><input class="bl-vat" value="' + FB.util.escAttr(data.vat_code || '') + '" autocomplete="off" placeholder="—"></td>' +
    '<td><input class="bl-cc" value="' + FB.util.escAttr(data.cost_center || '') + '" autocomplete="off"></td>' +
    '<td><input class="bl-pc" value="' + FB.util.escAttr(data.profit_center || '') + '" autocomplete="off"></td>' +
    '<td><button class="be-line-x" type="button" title="delete line">×</button></td>';
  tbody.appendChild(tr);
  attachAcct(tr.querySelector('.bl-acct'));
  attachVat(tr.querySelector('.bl-vat'));
  attachCenter(tr.querySelector('.bl-cc'), 'cost');
  attachCenter(tr.querySelector('.bl-pc'), 'profit');
  tr.querySelector('.be-line-x').onclick = () => { tr.remove(); updateTotals(); refreshAddRow(); };
  tr.querySelectorAll('input').forEach(i => i.addEventListener('input', () => { updateTotals(); refreshAddRow(); }));
  refreshAddRow();
  return tr;
}
function vatRateOf(code) {
  const v = S.vatCodes.find(x => x.vat_code === code);
  return v ? Number(v.rate != null ? v.rate : (v.rate_percent || 0)) : 0;
}
function lastLineHasData() {
  const rows = document.querySelectorAll('#be-lines-body tr');
  if (!rows.length) return false;
  const last = rows[rows.length - 1];
  return !!(last.querySelector('.bl-desc').value.trim() || last.querySelector('.bl-amt').value);
}
function refreshAddRow() {
  const el = document.getElementById('be-add-row');
  const has = lastLineHasData();
  el.classList.toggle('faded', !has);
}
document.getElementById('be-add-row').onclick = () => {
  if (!lastLineHasData()) return;
  const tr = addLine({});
  tr.querySelector('.bl-desc').focus();
};

// Tab from the last field of the last line creates a new line (sticky if empty)
document.getElementById('be-lines-body').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.shiftKey) return;
  const rows = document.querySelectorAll('#be-lines-body tr');
  const last = rows[rows.length - 1];
  if (!last) return;
  const fields = last.querySelectorAll('input');
  if (document.activeElement === fields[fields.length - 1] || document.activeElement === last.querySelector('.be-line-x')) {
    if (lastLineHasData()) {
      e.preventDefault();
      const tr = addLine({});
      tr.querySelector('.bl-desc').focus();
    } else {
      e.preventDefault(); // sticky — no empty-row spam
    }
  }
});

// ── Totals (display only — server is the authority at save/post) ────────────
function collectLines() {
  return Array.from(document.querySelectorAll('#be-lines-body tr')).map(tr => ({
    description: tr.querySelector('.bl-desc').value.trim(),
    expense_account: tr.querySelector('.bl-acct').value.trim(),
    amount: parseFloat(tr.querySelector('.bl-amt').value) || 0,
    vat_code: tr.querySelector('.bl-vat').value.trim() || '',
    cost_center: tr.querySelector('.bl-cc').value.trim() || null,
    profit_center: tr.querySelector('.bl-pc').value.trim() || null,
  })).filter(l => l.description || l.amount || l.expense_account);
}
function updateTotals() {
  // VAT is computed per line from its code (lines carry no VAT amounts —
  // redesign 2026-07-26). One footer row per VAT code states the code + its
  // description and amount; a stated total applies its delta to the largest
  // standard code (mirrors the posting rule) so the rows sum to the stated
  // total. Reverse-charge is self-assessed and never part of the gross.
  const lines = collectLines();
  const net = lines.reduce((s, l) => s + l.amount, 0);
  const el = document.getElementById('be-tot-gst');
  const stated = (el.dataset.stated === '1' && el.value !== '') ? (parseFloat(el.value) || 0) : null;
  const std = {}, rc = {}, order = [];
  lines.forEach(l => {
    const v = S.vatCodes.find(x => x.vat_code === l.vat_code);
    if (!v) return;
    const amt = Math.round(l.amount * vatRateOf(l.vat_code) * 100) / 100;
    const bucket = v.is_reverse_charge ? rc : std;
    if (!(l.vat_code in bucket)) order.push(l.vat_code);
    bucket[l.vat_code] = (bucket[l.vat_code] || 0) + amt;
  });
  const stdTotal = Object.keys(std).reduce((s, c) => s + std[c], 0);
  if (stated !== null && stdTotal > 0) {
    let largest = null;
    Object.keys(std).forEach(c => { if (std[c] > 0 && (largest === null || std[c] >= std[largest])) largest = c; });
    if (largest !== null) std[largest] = Math.round((std[largest] + (stated - stdTotal)) * 100) / 100;
  }
  const rowsEl = document.getElementById('be-code-rows');
  if (rowsEl) rowsEl.innerHTML = order.map(c => {
    const v = S.vatCodes.find(x => x.vat_code === c);
    const amt = v.is_reverse_charge ? rc[c] : std[c];
    if (!amt) return '';
    return '<div>' + FB.util.esc(c + ': ' + (v.description || c)) + ' — ' + amt.toFixed(2) + '</div>';
  }).join('');
  const gst = stated !== null ? stated : stdTotal;
  if (el.dataset.stated !== '1') el.value = gst.toFixed(2);
  el.style.color = stated !== null ? '#b26a00' : '';
  document.getElementById('be-tot-net').textContent = net.toFixed(2);
  document.getElementById('be-tot-gross').textContent = (net + gst).toFixed(2);
}
document.getElementById('be-tot-gst').addEventListener('input', (e) => {
  e.target.dataset.stated = e.target.value !== '' ? '1' : '';
  updateTotals();
});

// ── Gather + validate ───────────────────────────────────────────────────────
function gatherBill() {
  return {
    bill_id: S.billId || undefined,
    vendor: document.getElementById('be-vendor').value.trim(),
    date: document.getElementById('be-date').value,
    due_date: document.getElementById('be-due').value,
    vendor_ref: document.getElementById('be-ref').value.trim(),
    currency: document.getElementById('be-ccy').value.trim().toUpperCase() || undefined,
    ap_account: document.getElementById('be-ap').value.trim() || undefined,
    vat_amount_stated: (function () { const el = document.getElementById('be-tot-gst'); return (el.dataset.stated === '1' && el.value !== '') ? (parseFloat(el.value) || 0) : null; })(),
    lines: collectLines(),
    // NO amount — server computes (P2-4)
  };
}
function validateClient(bill, forPost) {
  const missing = [];
  document.querySelectorAll('.req').forEach(el => el.classList.remove('req'));
  const mark = id => { document.getElementById(id).classList.add('req'); };
  if (!bill.vendor) { missing.push('vendor'); mark('be-vendor'); }
  if (!bill.date) { missing.push('bill date'); mark('be-date'); }
  if (forPost) {
    if (!bill.ap_account) { missing.push('AP account'); mark('be-ap'); }
    bill.lines.forEach((l, i) => { if (!l.expense_account) missing.push('line ' + (i + 1) + ' expense account'); });
    if (!bill.lines.length) missing.push('at least one line');
    if (!bill.lines.some(l => l.amount > 0)) missing.push('a positive line amount');
  }
  return missing;
}

// ── Dirty tracking (snapshot after load + after each save) ──────────────────
function takeSnapshot() { S.savedSnapshot = JSON.stringify(gatherBill()); }
function isDirty() { return JSON.stringify(gatherBill()) !== S.savedSnapshot; }

// ── Save / post ─────────────────────────────────────────────────────────────
async function saveDraft(quiet) {
  if (S.saving) return null;
  const bill = gatherBill();
  const empty = !bill.vendor && !bill.lines.length;
  if (empty) { if (!quiet) msg('Nothing to save — bill is empty', 'err'); return null; }
  const missing = validateClient(bill, false);
  if (missing.length) { msg('Missing: ' + missing.join(', '), 'err'); return null; }
  S.saving = true;
  msg('Saving…');
  try {
    const r = await apiAction('bill.draft.save', { bill });
    S.billId = r.billId;
    await uploadStaged();
    takeSnapshot();
    if (!quiet) msg('Draft saved', 'ok');
    return r.billId;
  } catch (e) {
    msg(e.message, 'err');
    return null;
  } finally { S.saving = false; }
}

async function postBill() {
  if (S.saving) return;
  const bill = gatherBill();
  const missing = validateClient(bill, true);
  if (missing.length) { msg('Missing: ' + missing.join(', '), 'err'); return; }
  S.saving = true;
  msg('Posting…');
  try {
    let res;
    if (S.billId) {
      await saveDraft(true); // persist latest edits first
      res = await apiAction('bill.draft.post', { billId: S.billId });
    } else {
      res = await apiAction('bill.create', { bill });
    }
    const warns = (res && res.warnings && res.warnings.length) ? ' — ⚠ ' + res.warnings.join('; ') : '';
    msg('Bill posted' + warns, warns ? 'warn' : 'ok');
    setTimeout(() => { window.location.href = '/' + COMPANY + '/payables'; }, 900);
  } catch (e) {
    const det = e.details && e.details.errors ? ': ' + e.details.errors.join('; ') : '';
    msg(e.message + det, 'err');
  } finally { S.saving = false; }
}

// Esc = exit edit mode (vim doctrine: Esc exits, w writes, never conflate)
function exitToNormal() {
  if (document.activeElement) document.activeElement.blur();
  FB.mode.set('normal');
}

// q = quit (no save). Dirty → confirm discard (same guard as Vendors).
function quitEditor() {
  const bill = gatherBill();
  if (!bill.vendor && !bill.lines.length) { window.location.href = '/' + COMPANY + '/payables'; return; } // empty → exit silently
  if (isDirty() && !confirm('Unsaved changes — discard?')) return;
  window.location.href = '/' + COMPANY + '/payables';
}

function enterInsert() {
  FB.mode.set('insert');
  const vendor = document.getElementById('be-vendor');
  if (vendor) vendor.focus();
}

// ── Attachments (staged until first save) ───────────────────────────────────
document.getElementById('be-attach-btn').onclick = () => document.getElementById('be-file').click();
document.getElementById('be-file').addEventListener('change', (e) => {
  Array.from(e.target.files).forEach(f => S.stagedFiles.push(f));
  e.target.value = '';
  renderAttachments();
});
function renderAttachments() {
  const el = document.getElementById('be-attach-list');
  el.innerHTML = S.stagedFiles.map((f, i) =>
    '<div class="be-attach-row"><span class="name">📄 ' + FB.util.esc(f.name) + '</span>' +
    '<span class="staged">staged — uploads on save</span>' +
    '<button class="be-line-x" style="visibility:visible" data-i="' + i + '" type="button">×</button></div>'
  ).join('') + (S.billId ? '<div id="be-attach-existing"></div>' : '');
  el.querySelectorAll('button[data-i]').forEach(b => b.onclick = () => { S.stagedFiles.splice(Number(b.dataset.i), 1); renderAttachments(); });
  if (S.billId) loadAttachments();
}
async function uploadStaged() {
  if (!S.billId || !S.stagedFiles.length) return;
  for (const f of S.stagedFiles) {
    const fd = new FormData();
    fd.append('companyId', COMPANY);
    fd.append('entityType', 'bill');
    fd.append('entityId', S.billId);
    fd.append('file', f);
    await fetch('/api/upload', { method: 'POST', body: fd });
  }
  S.stagedFiles = [];
  renderAttachments();
}
async function loadAttachments() {
  const host = document.getElementById('be-attach-existing');
  if (!host || !S.billId) return;
  try {
    const rows = await apiAction('attachment.list', { entityType: 'bill', entityId: S.billId });
    host.innerHTML = (rows || []).map(a =>
      '<div class="be-attach-row"><span class="name">📄 <a href="/api/attachments/' + a.attachment_id + '" target="_blank">' + FB.util.esc(a.filename || a.file_name || 'file') + '</a></span></div>'
    ).join('');
  } catch (e) { /* non-fatal */ }
}

// ── Buttons + keys ──────────────────────────────────────────────────────────
document.getElementById('be-save').onclick = () => quitEditor();
document.getElementById('be-post').onclick = () => postBill();

// Page loads in INSERT (it IS an editing surface); Esc exits to NORMAL.
FB.mode.set('insert');
FB.keys.unregister('bill-edit'); // soft-nav re-execution guard
FB.keys.register('bill-edit', {
  active: () => true,
  getMode: () => FB.mode.get(),
  bindings: [
    // ── INSERT: dropdown keys first (contract: dd bindings precede general) ──
    { key: 'ArrowDown', mode: 'INSERT', when: () => FB.dropdown.isOpen(), swallow: true, run: () => FB.dropdown.move(1) },
    { key: 'ArrowUp', mode: 'INSERT', when: () => FB.dropdown.isOpen(), swallow: true, run: () => FB.dropdown.move(-1) },
    { key: 'Enter', mode: 'INSERT', when: () => FB.dropdown.isOpen(), swallow: true, run: () => FB.dropdown.pick() },
    { key: 'Escape', mode: 'INSERT', when: () => FB.dropdown.isOpen(), swallow: true, run: () => FB.dropdown.close() },
    // ── INSERT: Esc exits to NORMAL (no save — vim doctrine) ──
    { key: 'Escape', mode: 'INSERT', hint: 'exit edit', hintBar: true, swallow: true, run: exitToNormal },
    // ── NORMAL: page commands ──
    { key: 'i', mode: 'NORMAL', hint: 'edit', hintBar: true, run: enterInsert },
    { key: 'Enter', mode: 'NORMAL', hint: 'edit', hintBar: false, run: enterInsert },
    { key: 'w', mode: 'NORMAL', hint: 'write draft', hintBar: true, swallow: true,
      run: () => saveDraft(false) },
    { key: 'p', mode: 'NORMAL', hint: 'post bill', hintBar: true, swallow: true, run: postBill },
    { key: 'a', mode: 'NORMAL', hint: 'add line', hintBar: true, swallow: true,
      run: () => {
        const tr = addLine({});
        FB.mode.set('insert');
        tr.querySelector('.bl-desc').focus();
      } },
    { key: 'A', mode: 'NORMAL', hint: 'attach file', hintBar: true, swallow: true,
      run: () => document.getElementById('be-file').click() },
    { key: 'q', mode: 'NORMAL', hint: 'quit', hintBar: true, swallow: true, run: quitEditor },
  ],
});
FB.keys.renderHints('bill-edit', document.getElementById('sb-hints'), { layout: 'list' });
})();
<\/script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleBillEditPage };
