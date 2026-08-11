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
 * - Post = `p` (NORMAL verb) or Ctrl+Enter — also a Post button.
 * - Line delete is keyboard-accessible: `x` (NORMAL verb) or Enter/Space on
 *   the delete button cell (FB.form button-cell activation).
 */
const { makeQuery, commonStyle, navBar, layoutEnd, getRelevanceFlags } = require('./common');

async function handleBillEditPage(req, res) {
  const { company } = req.params;
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const flags = await getRelevanceFlags(company);
    res.send(buildBillEditPage(company, req.query.id || null, flags));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function buildBillEditPage(company, editId, flags) {
  // Relevance flags (settings-ux-spec §7 item 9 + fx-automation-spec §1):
  // vatOn=false drops the VAT code column / stated-GST total / per-code rows;
  // fxOn=false locks the CCY field to the company base currency.
  const vatOn = !flags || flags.vatRegistered !== false;
  const fxOn = !flags || flags.fxTracking !== 'off';
  const baseCcy = (flags && flags.baseCurrency) || '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Bill Editor - freeBooks</title>
${commonStyle()}
<style>
  table.be-lines { width:100%; border-collapse:collapse; font-size:10pt; }
  table.be-lines th { text-align:left; font-size:9pt; text-transform:uppercase; color:#555; border-bottom:1px solid #ccc; padding:6px 6px; }
  table.be-lines td { padding:3px 4px; border-bottom:1px solid #f0f0f0; vertical-align:middle; }
  table.be-lines input, table.be-lines select { padding:4px 6px; border:1px solid #ddd; border-radius:3px; font-size:10pt; box-sizing:border-box; }
  .be-line-x { visibility:hidden; cursor:pointer; color:#999; border:none; background:none; font-size:12pt; padding:0 4px; }
  tr:hover .be-line-x { visibility:visible; }
  .be-line-x.fb-form-cursor-btn { visibility: visible; }
  .be-msg { min-height:1em; font-size:10pt; }
  .be-msg.err { color:#cc2222; }
  .be-msg.ok { color:#2a8a2a; }
  .be-msg.warn { color:#856404; }
  .be-attach-row { display:flex; justify-content:space-between; align-items:center; padding:3px 6px; border-bottom:1px solid #f5f5f5; border-radius:3px; font-size:10pt; }
  .be-attach-row .name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .be-attach-row .staged { color:#856404; font-size:8.5pt; }
  .btn-plain { padding:7px 12px; background:none; border:1px solid #ccc; border-radius:4px; cursor:pointer; font-size:10pt; }
  input.req { border-color:#cc2222 !important; }
</style>
</head>
<body>${navBar(company, 'payables')}
<div class="page">
  <div class="header" style="display:flex;justify-content:space-between;align-items:flex-start">
    <div>
      <h1 id="be-title">New Bill</h1>
    </div>
  </div>

  <div class="header-fields">
    <label>Partner * <input id="be-partner-name" autocomplete="off" placeholder="start typing…"></label>
    <label>Bill date * <input id="be-date" type="date"></label>
    <label>Due date <input id="be-due" type="date"></label>
    <label>Bill no <input id="be-ref" autocomplete="off" placeholder="e.g. INV-123"></label>
    <label>CCY ${fxOn
      ? '<input id="be-ccy" maxlength="3" autocomplete="off" style="text-transform:uppercase">'
      : '<input id="be-ccy" maxlength="3" autocomplete="off" style="text-transform:uppercase" value="' + baseCcy + '" readonly tabindex="-1" title="Single-currency company (fx_tracking off) — locked to base currency">'}</label>
    <label>CR: AP account <input id="be-ap" autocomplete="off"></label>
  </div>

  <table class="be-lines">
    <thead><tr>
      <th style="width:28%">Description</th>
      <th style="width:10%">Amount</th>
      ${vatOn ? '<th style="width:10%">VAT code</th>' : ''}
      <th style="width:12%">Cost center</th>
      <th style="width:16%">DR: Expense account</th>
      <th style="width:2%"></th>
    </tr></thead>
    <tbody id="be-lines-body"></tbody>
  </table>
  <div style="margin-top:6px">
    <button class="btn-sm" id="be-add-row-btn" type="button">+ Add Line</button>
  </div>

  <div class="totals">
    <div id="be-code-rows" style="font-size:8.5pt;color:#888;font-style:italic${vatOn ? '' : ';display:none'}"></div>
    <span>Net <b id="be-tot-net">0.00</b></span>
    ${vatOn ? '<span title="Supplier-stated VAT total — pre-filled computed; edit to match the supplier invoice; clear to return to computed">GST <input id="be-tot-gst" class="bill-vat-stated" type="number" step="0.01" style="width:90px;text-align:right"></span>' : ''}
    <span>Gross <b id="be-tot-gross">0.00</b></span>
  </div>

  <div style="margin-top:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
    <button class="btn-primary" id="be-post" type="button">Post bill (p)</button>
    <button class="btn-sm" id="be-save" type="button">Back (q)</button>
    <span class="be-msg" id="be-msg"></span>
  </div>

  <div style="margin-top:14px;padding:12px;border:1px solid #e8e8e8;border-radius:4px;background:#fafafa">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <span style="font-size:10pt;font-weight:600">📎 Attachments</span>
      <label style="cursor:pointer;padding:4px 12px;border:1px solid #ccc;border-radius:3px;background:#fff;font-size:9.5pt">
        + Attach
        <input type="file" id="be-file" style="display:none" multiple>
      </label>
    </div>
    <div id="be-attach-list" style="font-size:9.5pt;color:#aaa">No files queued</div>
  </div>
</div>
<script>
// IIFE-wrapped: fbNavigate re-executes inline scripts on SPA navigation —
// top-level const/let would throw "already declared" on every repeat visit.
(function () {
'use strict';
const COMPANY = ${JSON.stringify(company)};
const VAT_ON = ${vatOn ? 'true' : 'false'};
const FX_ON = ${fxOn ? 'true' : 'false'};
// Server-embedded: fbNavigate re-executes this script BEFORE pushState, so
// window.location.search still holds the OLD page's query at parse time.
const editId = ${JSON.stringify(editId)};

const S = {
  partners: [], accounts: [], vatCodes: [], centers: [], currencies: [],
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
  apiAction('partner.list', { partner_type: 'vendor' }).then(d => { S.partners = d || []; }),
  apiAction('coa.list').then(d => { S.accounts = d || []; }),
  ...(VAT_ON ? [apiAction('vat.codes.list').then(d => { S.vatCodes = d || []; })] : []),
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
  if (S.billId) document.getElementById('be-title').textContent = 'Edit Draft Bill';
  updateTotals();
  takeSnapshot(); // baseline for dirty tracking
}).catch(function (e) {
  // Surface init failures in the status bar instead of dying silently —
  // a rejected fetch previously left the page static-HTML-only with no focus.
  msg('Load error: ' + (e && e.message ? e.message : e), 'err');
}).finally(function () {
  // FB.form owns cursor/mode now: paint the cursor on the first cell once
  // rows exist. The form starts in NORMAL (user presses i/Enter to edit).
  if (beForm) beForm.refresh();
});

async function prefillFromDraft(id) {
  const [bill, lines] = await Promise.all([
    apiAction('bill.get', { billId: id }),
    apiAction('bill.lines', { billId: id }),
  ]);
  document.getElementById('be-partner-name').value = bill.partner_name || '';
  document.getElementById('be-date').value = (bill.date || '').slice(0, 10);
  document.getElementById('be-due').value = (bill.due_date || bill.date || '').slice(0, 10);
  document.getElementById('be-ref').value = bill.vendor_ref || '';
  document.getElementById('be-ccy').value = bill.currency || '';
  document.getElementById('be-ap').value = bill.ap_account || '';
  if (VAT_ON && Number(bill.vat_amount) > 0) { // drafts: stated VAT total (0 = none); element absent when vat_registered=false
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

// ── Header wiring (dropdowns + partner defaults) ─────────────────────────────
function wireHeader() {
  FB.dropdown.attach(document.getElementById('be-partner-name'), {
    minWidth: 260,
    source: q => {
      q = (q || '').toLowerCase();
      return S.partners.filter(v => (v.name || '').toLowerCase().includes(q))
        .map(v => ({ primary: v.name, secondary: v.default_currency || '', data: v }));
    },
    onPick: (it, inp) => {
      inp.value = it.primary;
      const v = it.data;
      if (FX_ON && v.default_currency && !document.getElementById('be-ccy').value) document.getElementById('be-ccy').value = v.default_currency;
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
    minWidth: 280,
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
    minWidth: 220,
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
    minWidth: 180,
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
    '<td><input class="bl-amt" type="number" step="0.01" min="0" value="' + (data.amount !== '' && data.amount != null ? data.amount : '') + '"></td>' +
    (VAT_ON ? '<td><input class="bl-vat" value="' + FB.util.escAttr(data.vat_code || '') + '" autocomplete="off" placeholder="—"></td>' : '') +
    '<td><input class="bl-cc" value="' + FB.util.escAttr(data.cost_center || '') + '" autocomplete="off"></td>' +
    '<td><input class="bl-acct" value="' + FB.util.escAttr(data.expense_account || '') + '" autocomplete="off"></td>' +
    '<td><button class="be-line-x" type="button" title="delete line">×</button></td>';
  tbody.appendChild(tr);
  attachAcct(tr.querySelector('.bl-acct'));
  if (VAT_ON) attachVat(tr.querySelector('.bl-vat'));
  attachCenter(tr.querySelector('.bl-cc'), 'cost');
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
  const el = document.getElementById('be-add-row-btn');
  const has = lastLineHasData();
  el.disabled = !has;
}
document.getElementById('be-add-row-btn').onclick = () => {
  if (!lastLineHasData()) return;
  const tr = addLine({});
  tr.querySelector('.bl-desc').focus();
};

// ── Totals (display only — server is the authority at save/post) ────────────
function collectLines() {
  return Array.from(document.querySelectorAll('#be-lines-body tr')).map(tr => ({
    description: tr.querySelector('.bl-desc').value.trim(),
    expense_account: tr.querySelector('.bl-acct').value.trim(),
    amount: parseFloat(tr.querySelector('.bl-amt').value) || 0,
    vat_code: (function(){ var s = tr.querySelector('.bl-vat'); return s ? (s.value.trim() || '') : ''; })(),
    cost_center: tr.querySelector('.bl-cc').value.trim() || null,
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
  // Element renders only when vat_registered (template guard) — null-safe:
  // non-VAT companies must not die here (K5 crawl caught the page error).
  const el = document.getElementById('be-tot-gst');
  const stated = (el && el.dataset.stated === '1' && el.value !== '') ? (parseFloat(el.value) || 0) : null;
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
  if (el) {
    if (el.dataset.stated !== '1') el.value = gst.toFixed(2);
    el.style.color = stated !== null ? '#b26a00' : '';
  }
  document.getElementById('be-tot-net').textContent = net.toFixed(2);
  document.getElementById('be-tot-gross').textContent = (net + gst).toFixed(2);
}
// Element absent when vat_registered=false — guard or the whole page script
// dies here on non-VAT companies (keys, post wiring, attachments all lost).
const _beTotGst = document.getElementById('be-tot-gst');
if (_beTotGst) _beTotGst.addEventListener('input', (e) => {
  e.target.dataset.stated = e.target.value !== '' ? '1' : '';
  updateTotals();
});

// ── Gather + validate ───────────────────────────────────────────────────────
function gatherBill() {
  return {
    bill_id: S.billId || undefined,
    partner_name: document.getElementById('be-partner-name').value.trim(),
    date: document.getElementById('be-date').value,
    due_date: document.getElementById('be-due').value,
    vendor_ref: document.getElementById('be-ref').value.trim(),
    currency: document.getElementById('be-ccy').value.trim().toUpperCase() || undefined,
    ap_account: document.getElementById('be-ap').value.trim() || undefined,
    vat_amount_stated: (function () { const el = document.getElementById('be-tot-gst'); return (el && el.dataset.stated === '1' && el.value !== '') ? (parseFloat(el.value) || 0) : null; })(),
    lines: collectLines(),
    // NO amount — server computes (P2-4)
  };
}
function validateClient(bill, forPost) {
  const missing = [];
  document.querySelectorAll('.req').forEach(el => el.classList.remove('req'));
  const mark = id => { document.getElementById(id).classList.add('req'); };
  if (!bill.partner_name) { missing.push('partner'); mark('be-partner-name'); }
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
  const empty = !bill.partner_name && !bill.lines.length;
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

// q = quit (no save). Dirty → confirm discard (same guard as Partners).
function quitEditor() {
  const bill = gatherBill();
  if (!bill.partner_name && !bill.lines.length) { window.location.href = '/' + COMPANY + '/payables'; return; } // empty → exit silently
  if (isDirty() && !confirm('Unsaved changes — discard?')) return;
  window.location.href = '/' + COMPANY + '/payables';
}


// ── Attachments (staged until first save) ───────────────────────────────────
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

// ── FB.form (K3, keyboard-ux-spec §8) — the one form machine; this page ──
// declares config + verbs only. Zones: header grid → lines table → attachments.
// The page starts in NORMAL; user presses i/Enter to edit a cell.
var beForm = FB.form.create({
  formId: 'bill-edit',
  zones: [
    { id: 'header', rows: function () { return [document.querySelector('.header-fields')]; } },
    { id: 'lines',  rows: function () { return Array.from(document.querySelectorAll('#be-lines-body tr')); },
      cells: function (rowEl) {
        return Array.prototype.slice.call(rowEl.querySelectorAll('input,select,button'))
          .filter(function (el) { return !el.disabled && el.type !== 'hidden'; });
      } },
    { id: 'attachments', rows: function () { return Array.from(document.querySelectorAll('#be-attach-list .be-attach-row')); },
      cells: function () { return []; } },
  ],
  verbs: {
    add: { key: 'a', hint: 'add line', run: function (api) {
      var tr = addLine({});
      updateTotals();
      api.moveTo(1, api.zoneRows(1).length - 1, 0, true);
    } },
    delete: { key: 'x', hint: 'delete',
      when: function (api) { return api.cur().z === 1; },
      run: function (api) {
        var tr = api.zoneRows(1)[api.cur().r];
        if (!tr) return;
        tr.remove(); updateTotals(); refreshAddRow(); api.refresh();
      } },
    write: { key: 'w', hint: 'write draft', run: function () { saveDraft(false); } },
    quit: { key: 'q', hint: 'quit', paletteEligible: false, run: function () { quitEditor(); } }
  },
  extraBindings: function (api) {
    return [
      { key: 'p', mode: 'NORMAL', hint: 'post bill', hintBar: true, swallow: true, run: function () { postBill(); } },
      { key: 'A', mode: 'NORMAL', hint: 'attach file', hintBar: true, swallow: true,
        run: function () { document.getElementById('be-file').click(); } },
    ];
  }
});
FB.keys.renderHints('bill-edit', document.getElementById('sb-hints'), { layout: 'list' });
})();
<\/script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleBillEditPage };
