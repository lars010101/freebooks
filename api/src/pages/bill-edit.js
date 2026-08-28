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
  const whtOn = !!(flags && flags.whtTracking === 'true');
  const baseCcy = (flags && flags.baseCurrency) || '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Bill Editor - freeBooks</title>
${commonStyle()}
<style>
  .be-grid-header {
    display:grid;
    grid-template-columns: repeat(3, 1fr);
    column-gap:0;
    align-items:end;
    margin-bottom:12px;
  }
  .be-grid-header label {
    display:flex; flex-direction:column; gap:3px;
    font-weight:600; font-size:9pt; text-transform:uppercase; color:#555;
    padding:0 4px;
  }
  .be-grid-header input, .be-grid-header select {
    padding:4px 6px; border:1px solid #ccc; border-radius:4px;
    font-size:10pt; box-sizing:border-box; height:32px;
  }
  /* Partner spans full width of row 1. Bill date, due date, and bill no
     share row 2 evenly — no longer tied to the line table's column widths
     now that CR: AP account (the thing that required the alignment) is gone. */
  .be-grid-header .be-gh-partner {
    grid-row: 1;
    grid-column: 1 / -1;
    padding-right:8px;
  }
  .be-grid-header .be-gh-row2 { grid-row: 2; }
  .be-grid-header .be-gh-memo {
    grid-row: 3;
    grid-column: 1 / -1;
  }
  .be-lines-wrap, .bl-header, .bl-row { column-gap: 8px; }
  .bl-header, .bl-row { display: grid; grid-template-columns: var(--bl-cols); }
  .bl-header { font-size:9pt; text-transform:uppercase; color:#555; border-bottom:1px solid #ccc; padding:6px 6px 8px; }
  .bl-row { border-bottom:1px solid #f0f0f0; padding:3px 0; }
  .bl-group { display: contents; }
  .bl-cell { padding:3px 4px; display:flex; align-items:center; min-width:0; }
  .bl-cell input, .bl-cell select { min-width:0; width:100%; padding:4px 6px; border:1px solid #ddd; border-radius:3px; font-size:10pt; box-sizing:border-box; height:32px; }
  .be-line-x { visibility:hidden; cursor:pointer; color:#999; border:none; background:none; font-size:12pt; padding:0 4px; }
  .bl-row:hover .be-line-x { visibility:visible; }
  .be-line-x.fb-form-cursor-btn { visibility: visible; }
  @media (max-width: 1100px) {
    .bl-header { display: none; }
    .bl-row {
      display: flex;
      flex-direction: column;
      row-gap: 4px;
      padding-bottom: 8px;
    }
    .bl-group {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .bl-group .bl-cell { flex: 1 1 120px; }
  }
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
<div class="page page-wide">
  <div class="header" style="display:flex;justify-content:space-between;align-items:flex-start">
    <div>
      <h1 id="be-title">New Bill</h1>
    </div>
  </div>

  <div class="be-grid-header">
    <label class="be-gh-partner">Partner * <input id="be-partner-name" autocomplete="off" placeholder="start typing…"></label>
    <label class="be-gh-row2">Bill date * <input id="be-date" type="date"></label>
    <label class="be-gh-row2">Due date <input id="be-due" type="date"></label>
    <label class="be-gh-row2">Bill no <input id="be-ref" autocomplete="off" placeholder="e.g. INV-123"></label>
    <label class="be-gh-memo">Memo <input id="be-memo" autocomplete="off" placeholder="internal note (optional)"></label>
  </div>
  ${fxOn
    ? '<div class="header-fields"><label>CCY <input id="be-ccy" maxlength="3" autocomplete="off" style="text-transform:uppercase"></label></div>'
    : '<input id="be-ccy" type="hidden" value="' + baseCcy + '">'}

  <div class="be-lines-wrap" id="be-lines-wrap">
    <div class="bl-header" id="be-lines-header"></div>
    <div id="be-lines-body"></div>
  </div>
  <div style="margin-top:6px">
    <button class="btn-sm" id="be-add-row-btn" type="button">+ Add Line</button>
  </div>

  <div class="totals">
    <div id="be-code-rows" style="font-size:8.5pt;color:#888;font-style:italic${vatOn ? '' : ';display:none'}"></div>
    <span>Net <b id="be-tot-net">0.00</b></span>
    ${vatOn ? '<span title="Supplier-stated VAT total — pre-filled computed; edit to match the supplier invoice; clear to return to computed">GST <input id="be-tot-gst" class="bill-vat-stated" type="number" step="0.01" style="width:90px;text-align:right"></span>' : ''}
    <span>Gross <b id="be-tot-gross">0.00</b></span>
    ${whtOn ? '<span title="Withheld and remitted to the tax authority separately — not paid to the vendor">WHT <b id="be-tot-wht" style="color:#b26a00">0.00</b></span><span>Payable to vendor <b id="be-tot-payable">0.00</b></span>' : ''}
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
const WHT_ON = ${whtOn ? 'true' : 'false'};
// Server-embedded: fbNavigate re-executes this script BEFORE pushState, so
// window.location.search still holds the OLD page's query at parse time.
const editId = ${JSON.stringify(editId)};

const S = {
  partners: [], accounts: [], vatCodes: [], whtCodes: [], centers: [], currencies: [],
  billId: editId || null,
  selectedPartnerId: null,  // partner_id from dropdown pick (bills-partner-fk-spec §4.2)
  selectedApAccount: null,  // resolved ap_account — no visible field; §1 of bill-edit-header-cleanup-spec.md
  stagedFiles: [],       // File objects staged pre-first-save
  saving: false,
  savedSnapshot: null,   // JSON of last-saved (or initial) form state
};

// ── Line-item column config — single source of truth ──────────────────────
// Extend this array (not hand-typed widths in separate places) when #3
// (qty × unit price) and #4 (withholding tax) land — see §3.2 of
// bill-line-items-layout-prep-spec.md for the reserved slots.
//
// INVARIANT: tier-1 entries must precede tier-2 entries in this array.
// §3.4's Tier-B rendering groups cells by tier and relies on each group's
// internal order matching this array's order — see §2.3.
const LINE_COLUMNS = [
  { id: 'desc', label: 'Description',        cls: 'bl-desc',   tier: 1 },
  // Reserved for the #3 spec (qty × unit price) — do not build ahead of it:
  // { id: 'qty',  label: 'Qty',                cls: 'bl-qty',    tier: 1 },
  // { id: 'rate', label: 'Rate',               cls: 'bl-rate',   tier: 1 },
  { id: 'amt',  label: 'Amount',              cls: 'bl-amt',    tier: 1 },
  { id: 'vat',  label: 'VAT code',            cls: 'bl-vat',    tier: 2, conditionalOn: () => VAT_ON },
  // Reserved for the #4 spec (withholding tax) — do not build ahead of it:
  { id: 'wht',  label: 'WHT code',           cls: 'bl-wht',    tier: 2, conditionalOn: () => WHT_ON },
  { id: 'cc',   label: 'Cost center',         cls: 'bl-cc',     tier: 2 },
  { id: 'acct', label: 'DR: Expense account', cls: 'bl-acct',   tier: 2 },
  { id: 'del',  label: '',                    cls: 'be-line-x', tier: 2 },
];
function activeColumns() { return LINE_COLUMNS.filter(c => !c.conditionalOn || c.conditionalOn()); }

// Tier A (wide, single row) column-track widths, keyed by column id — see
// §3.3. Kept separate from LINE_COLUMNS itself so the reserved/commented
// entries above can stay terse; a width only needs to exist once its column
// is actually wired up in renderCell (§2.3).
const WIDE_TRACK_WIDTH = {
  desc: 'minmax(240px,3fr)', qty: 'minmax(70px,0.6fr)', rate: 'minmax(90px,0.7fr)',
  amt:  'minmax(90px,0.8fr)', vat: 'minmax(90px,0.8fr)', wht:  'minmax(90px,0.8fr)',
  cc:   'minmax(120px,1fr)',  acct: 'minmax(180px,1.6fr)', del: '32px',
};
function computeWideColumns() { return activeColumns().map(c => WIDE_TRACK_WIDTH[c.id] || '1fr').join(' '); }

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
  ...(WHT_ON ? [apiAction('wht.codes.list').then(d => { S.whtCodes = d || []; })] : []),
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
  renderLinesHeader();
  applyGridColumns();
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
  S.selectedPartnerId = bill.partner_id || null;  // bills-partner-fk-spec §4.2 — preserve link on re-save
  document.getElementById('be-date').value = (bill.date || '').slice(0, 10);
  document.getElementById('be-due').value = (bill.due_date || bill.date || '').slice(0, 10);
  document.getElementById('be-ref').value = bill.vendor_ref || '';
  document.getElementById('be-ccy').value = bill.currency || '';
  S.selectedApAccount = bill.ap_account || null;
  document.getElementById('be-memo').value = bill.description || '';
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
    wht_code: l.wht_code || '',
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
      S.selectedPartnerId = v.partner_id || null;  // bills-partner-fk-spec §4.2
      S.selectedApAccount = v.default_ap_account || null;  // §1.4 — carried silently
      if (FX_ON && v.default_currency && !document.getElementById('be-ccy').value) document.getElementById('be-ccy').value = v.default_currency;
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
  // bills-partner-fk-spec §4.2.4: if user types/edits the name without picking
  // from the dropdown, clear the stored partner_id — same free-text behavior as §0.2.
  const _partnerInput = document.getElementById('be-partner-name');
  if (_partnerInput) _partnerInput.addEventListener('input', () => { S.selectedPartnerId = null; S.selectedApAccount = null; });
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
function attachWht(input) {
  FB.dropdown.attach(input, {
    minWidth: 220,
    source: q => {
      q = (q || '').toLowerCase();
      return [{ wht_code: '', description: 'none', rate: 0 }].concat(S.whtCodes)
        .filter(w => (w.wht_code || '').toLowerCase().includes(q) || (w.description || '').toLowerCase().includes(q))
        .map(w => ({ primary: w.wht_code || '—', secondary: w.description || '', data: w }));
    },
    onPick: (it, inp) => { inp.value = it.data.wht_code; inp.dispatchEvent(new Event('input', { bubbles: true })); },
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
function renderLinesHeader() {
  document.getElementById('be-lines-header').innerHTML =
    activeColumns().map(c => '<div class="bl-cell">' + FB.util.esc(c.label) + '</div>').join('');
}
function applyGridColumns() {
  document.getElementById('be-lines-wrap').style.setProperty('--bl-cols', computeWideColumns());
}
function renderCell(col, data) {
  var inner;
  switch (col.id) {
    case 'desc': inner = '<input class="bl-desc" value="' + FB.util.escAttr(data.description || '') + '" placeholder="line description">'; break;
    case 'amt':  inner = '<input class="bl-amt" type="number" step="0.01" min="0" placeholder="Amount" value="' + (data.amount !== '' && data.amount != null ? data.amount : '') + '">'; break;
    case 'vat':  inner = '<input class="bl-vat" value="' + FB.util.escAttr(data.vat_code || '') + '" autocomplete="off" placeholder="—">'; break;
    case 'wht':  inner = '<input class="bl-wht" value="' + FB.util.escAttr(data.wht_code || '') + '" autocomplete="off" placeholder="—">'; break;
    case 'cc':   inner = '<input class="bl-cc" value="' + FB.util.escAttr(data.cost_center || '') + '" autocomplete="off" placeholder="Cost center">'; break;
    case 'acct': inner = '<input class="bl-acct" value="' + FB.util.escAttr(data.expense_account || '') + '" autocomplete="off" placeholder="Expense acct">'; break;
    case 'del':  inner = '<button class="be-line-x" type="button" title="delete line">×</button>'; break;
    default:
      throw new Error('renderCell: no case for column "' + col.id + '" — add one before enabling it in LINE_COLUMNS.');
  }
  return '<div class="bl-cell">' + inner + '</div>';
}
function addLine(data) {
  const container = document.getElementById('be-lines-body');
  const cols = activeColumns();
  const row = document.createElement('div');
  row.className = 'bl-row';
  const g1 = cols.filter(c => c.tier === 1).map(c => renderCell(c, data)).join('');
  const g2 = cols.filter(c => c.tier === 2).map(c => renderCell(c, data)).join('');
  row.innerHTML = '<div class="bl-group">' + g1 + '</div><div class="bl-group">' + g2 + '</div>';
  container.appendChild(row);
  attachAcct(row.querySelector('.bl-acct'));
  if (VAT_ON) attachVat(row.querySelector('.bl-vat'));
  if (WHT_ON) attachWht(row.querySelector('.bl-wht'));
  attachCenter(row.querySelector('.bl-cc'), 'cost');
  row.querySelector('.be-line-x').onclick = () => { row.remove(); updateTotals(); refreshAddRow(); };
  row.querySelectorAll('input').forEach(i => i.addEventListener('input', () => { updateTotals(); refreshAddRow(); }));
  refreshAddRow();
  return row;
}
function vatRateOf(code) {
  const v = S.vatCodes.find(x => x.vat_code === code);
  return v ? Number(v.rate != null ? v.rate : (v.rate_percent || 0)) : 0;
}
function lastLineHasData() {
  const rows = document.querySelectorAll('#be-lines-body .bl-row');
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
  const row = addLine({});
  row.querySelector('.bl-desc').focus();
};

// ── Totals (display only — server is the authority at save/post) ────────────
function collectLines() {
  return Array.from(document.querySelectorAll('#be-lines-body .bl-row')).map(row => ({
    description: row.querySelector('.bl-desc').value.trim(),
    expense_account: row.querySelector('.bl-acct').value.trim(),
    amount: parseFloat(row.querySelector('.bl-amt').value) || 0,
    vat_code: (function(){ var s = row.querySelector('.bl-vat'); return s ? (s.value.trim() || '') : ''; })(),
    wht_code: (function(){ var w = row.querySelector('.bl-wht'); return w ? (w.value.trim() || '') : ''; })(),
    cost_center: row.querySelector('.bl-cc').value.trim() || null,
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
  // WHT totals (display-only — no stated/override per §0.5)
  var whtTotal = 0;
  if (typeof WHT_ON !== 'undefined' && WHT_ON) {
    lines.forEach(l => {
      var w = S.whtCodes ? S.whtCodes.find(x => x.wht_code === l.wht_code) : null;
      if (w) whtTotal += Math.round(l.amount * Number(w.rate) * 100) / 100;
    });
  }
  var gross = net + gst;
  var whtEl = document.getElementById('be-tot-wht');
  var payEl = document.getElementById('be-tot-payable');
  if (whtEl) whtEl.textContent = whtTotal.toFixed(2);
  if (payEl) payEl.textContent = (gross - whtTotal).toFixed(2);
  document.getElementById('be-tot-gross').textContent = gross.toFixed(2);
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
    partner_id: S.selectedPartnerId || null,  // bills-partner-fk-spec §4.2
    date: document.getElementById('be-date').value,
    due_date: document.getElementById('be-due').value,
    vendor_ref: document.getElementById('be-ref').value.trim(),
    currency: document.getElementById('be-ccy').value.trim().toUpperCase() || undefined,
    ap_account: S.selectedApAccount || undefined,
    description: document.getElementById('be-memo').value.trim() || undefined,
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
    let m = e.message + det;
    if (e.message.includes('AP account is required')) m += ' — set a default AP account for this vendor or in Settings → Chart of Accounts.';
    msg(m, 'err');
  } finally { S.saving = false; }
}

// Escape = quit (no save). Dirty → confirm discard (same guard as Partners).
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
  heading: 'Bill',
  zones: [
    { id: 'header', rows: function () { return [document.querySelector('.be-grid-header')]; } },
    { id: 'lines',  rows: function () {
        return Array.from(document.querySelectorAll('#be-lines-body .bl-row'));
      },
      cells: function (rowEl) {
        return Array.prototype.slice.call(rowEl.querySelectorAll('input,select,button'))
          .filter(function (el) { return !el.disabled && el.type !== 'hidden'; });
      } },
    { id: 'attachments', rows: function () { return Array.from(document.querySelectorAll('#be-attach-list .be-attach-row')); },
      cells: function () { return []; } },
  ],
  verbs: {
    add: { key: 'i', hint: 'insert line item', run: function (api) {
      var row = addLine({});
      updateTotals();
      api.moveTo(1, api.zoneRows(1).length - 1, 0, true);
    } },
    delete: { key: 'x', hint: 'delete',
      when: function (api) { return api.cur().z === 1 && api.cur().r > 0; },
      run: function (api) {
        var row = api.zoneRows(1)[api.cur().r];
        if (!row) return;
        row.remove(); updateTotals(); refreshAddRow(); api.refresh();
      } },
    // w now posts instead of saving a draft (magnus 2026-08-28) — killed the
    // human "save draft, don't post" path; an agent can still create/leave a
    // bill in draft (bill.create/bill.draft.save are agentWritable —
    // action-catalog.js), but a human's write action always commits straight
    // to posted. postBill() already handles both cases (a truly-new bill
    // goes through bill.create directly, no draft ever touched; an existing
    // draft — e.g. one opened from an Inbox review — gets a final silent
    // save then bill.draft.post). No hint: silent alias for the p binding
    // below (same pattern as the Escape/quit alias), so the overlay isn't
    // cluttered with two rows for one action.
    write: { key: 'w', run: function () { postBill(); } },
    // No hint: Escape is the universal quit/cancel key and doesn't need to
    // be taught via the sidebar hint bar or the ? overlay (magnus 2026-08-28).
    quit: { key: 'Escape', paletteEligible: false, run: function () { quitEditor(); } }
  },
  extraBindings: function (api) {
    return [
      { key: 'p', mode: 'NORMAL', hint: 'post bill', hintBar: true, swallow: true, run: function () { postBill(); } },
      // a = attach, moved off Shift-A (magnus 2026-08-28 — a is exclusively
      // attach app-wide now; line-insert moved to i, see verbs.add above).
      { key: 'a', mode: 'NORMAL', hint: 'attach file', hintBar: true, swallow: true,
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
