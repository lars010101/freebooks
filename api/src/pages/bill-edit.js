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
 * - Line delete is keyboard-accessible: `x` (NORMAL verb) or Enter/Space on
 *   the delete button cell (FB.form button-cell activation).
 *
 * bill-post-payment-consolidation-spec.md: `p` is retired. `w` is the one
 * commit key — it always posts (the Draft toggle was removed 2026-09-06,
 * per magnus: users never save drafts manually anymore). Agent/`:bill`-
 * authored drafts still land via bill.create/bill.draft.save server-side,
 * untouched by this page.
 */
const { makeQuery, commonStyle, navBar, layoutEnd, getRelevanceFlags } = require('./common');

// Stage 1 (2026-09-06, bill-edit/bill-detail merge): renamed from
// handleBillEditPage/buildBillEditPage in prep for taking over the /bill/:id
// route once Stages 2-4 port bill-detail.js's posted-bill view (journal
// trail, void, amount cards) in here. Not yet wired to /bill/:id — reports.js
// still routes that to the unmerged bill-detail.js for now. id is read from
// req.params.id (the eventual /bill/:id shape) with a req.query.id fallback
// so the still-registered /bill/edit?id= path (used by Payables' I verb)
// keeps working unchanged during the transition.
async function handleBillPage(req, res) {
  const { company, id } = req.params;
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const flags = await getRelevanceFlags(company);
    res.send(buildBillPage(company, id || req.query.id || null, flags));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function buildBillPage(company, editId, flags) {
  // Relevance flags (settings-ux-spec §7 item 9 + fx-automation-spec §1):
  // vatOn=false drops the VAT code column / stated-GST total / per-code rows;
  // fxOn=false locks the CCY field to the company base currency.
  const vatOn = !flags || flags.vatRegistered !== false;
  const fxOn = !flags || flags.fxTracking !== 'off';
  const whtOn = !!(flags && flags.whtTracking === 'true');
  const baseCcy = (flags && flags.baseCurrency) || '';
  // Jurisdiction-aware tax label (2026-09-06, ported from bill-detail.js —
  // fixes a pre-existing bug where this page always said "GST" regardless
  // of jurisdiction; bill-detail.js already got this right).
  const taxLabel = (flags && flags.jurisdiction === 'SG') ? 'GST' : 'VAT';
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
    font-weight:600; font-size:0.75rem; text-transform:uppercase; color:var(--text-muted);
    padding:0 4px;
  }
  .be-grid-header input, .be-grid-header select {
    padding:4px 6px; border:1px solid var(--border); border-radius:4px;
    font-size:0.8125rem; box-sizing:border-box; height:32px; background:var(--surface); color:var(--text);
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
  .bl-header { font-size:0.75rem; text-transform:uppercase; color:var(--text-muted); border-bottom:1px solid var(--border); padding:6px 6px 8px; }
  .bl-row { border-bottom:1px solid var(--border); padding:3px 0; }
  .bl-group { display: contents; }
  .bl-cell { padding:3px 4px; display:flex; align-items:center; min-width:0; }
  .bl-cell input, .bl-cell select { min-width:0; width:100%; padding:4px 6px; border:1px solid var(--border); border-radius:3px; font-size:0.8125rem; box-sizing:border-box; height:32px; background:var(--surface); color:var(--text); }
  .be-line-x { visibility:hidden; cursor:pointer; color:var(--text-muted); border:none; background:none; font-size:0.875rem; padding:0 4px; }
  .bl-row:hover .be-line-x { visibility:visible; }
  .be-line-x.fb-form-cursor-btn { visibility: visible; }
  .bl-row.bl-auto { background:var(--bg); }
  .bl-auto-label { color:var(--text-muted); font-size:0.75rem; }
  /* Line-item equivalent of the shared .fb-locked-fields header treatment
     (common.css) — native :disabled here since these inputs are always
     individually disabled, not toggled via a wrapper class. */
  .bl-cell input:disabled { background:transparent; border-color:transparent; color:var(--text-muted); }
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
  .be-msg { min-height:1em; font-size:0.8125rem; }
  .be-msg.err { color:var(--danger); }
  .be-msg.ok { color:var(--success); }
  .be-msg.warn { color:var(--warning); }
  .be-attach-row { display:flex; justify-content:space-between; align-items:center; padding:3px 6px; border-bottom:1px solid var(--border); border-radius:3px; font-size:0.8125rem; }
  .be-attach-row .name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .be-attach-row .staged { color:var(--warning); font-size:0.6875rem; }
  /* + Add attachment row (2026-09-06, retires A) — fb-list add-row parity */
  .be-attach-add-btn { border:none; background:none; cursor:pointer; color:var(--text-muted); font-size:0.75rem; padding:2px 0; text-align:left; width:100%; }
  .be-attach-row.fb-form-row-focus .be-attach-add-btn { color:var(--on-accent); }
  /* JE ref link (2026-09-06) — see loadJournalRef() */
  .be-journal-ref-link { color:var(--accent); font-weight:500; text-decoration:none; }
  .be-journal-ref-link:hover { text-decoration:underline; }
  /* Status badge (shared .badge component, common.css) + amount cards
     (2026-09-06, ported from bill-detail.js). Positioning next to the h1
     title stays local — not a property of the badge itself. */
  #be-status-badge { margin-left:10px; vertical-align:middle; }
  .be-amount-cards { display:flex; gap:16px; font-size:0.8125rem; margin-top:10px; }
  .btn-plain { padding:7px 12px; background:none; border:1px solid var(--border); border-radius:4px; cursor:pointer; font-size:0.8125rem; }
  input.req { border-color:var(--danger) !important; }
</style>
</head>
<body>${navBar(company, 'payables')}
<div class="page page-wide">
  <div class="header" style="display:flex;justify-content:space-between;align-items:flex-start">
    <div>
      <h1 id="be-title" style="display:inline">New Bill</h1>
      <span id="be-status-badge"></span>
      <!-- JE ref (2026-09-06, replaces the old Journal Entries trail table —
           per magnus: the line items already show the same Account/Debit/
           Credit info; the doc-no link was the only thing missing). -->
      <span id="be-je-ref" style="margin-left:10px;font-size:0.75rem"></span>
    </div>
    <!-- Void (2026-09-06, ported from bill-detail.js): shown only for a
         posted, unpaid bill — matches the server's own refusal to void a
         partial/paid/already-void bill. Also reachable via x on the header
         zone, same "x means something bigger here" pattern as
         journal-voucher's reversal entry. -->
    <button id="be-void" class="btn-sm" type="button" style="display:none;color:var(--danger);border-color:var(--danger)">&#8856; Void</button>
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

  <div style="margin-top:6px;padding:12px;border:1px solid var(--border);border-radius:4px;background:var(--bg)">
    <div style="font-size:0.8125rem;font-weight:600;margin-bottom:6px">📎 Attachments</div>
    <input type="file" id="be-file" style="display:none" multiple>
    <div id="be-attach-list" style="font-size:0.75rem"></div>
  </div>

  <div class="be-lines-wrap" id="be-lines-wrap">
    <div class="bl-header" id="be-lines-header"></div>
    <div id="be-lines-body"></div>
  </div>
  <div style="margin-top:6px">
    <button class="btn-sm" id="be-add-row-btn" type="button">+ Add Line</button>
  </div>

  ${whtOn ? '<div class="totals"><span title="Withheld and remitted to the tax authority separately — not paid to the vendor">WHT <b id="be-tot-wht" style="color:var(--warning)">0.00</b></span><span>Payable to vendor <b id="be-tot-payable">0.00</b></span></div>' : ''}

  <!-- Amount Paid/Due (2026-09-06, ported from bill-detail.js) — payment
       progress, distinct from the bill's face amount (the line items' own
       Total row, computed by computeAutoLines()); these track what's
       actually been paid against it. Only meaningful once posted. -->
  <div id="be-amount-cards" class="be-amount-cards" style="display:none">
    <div>Amount Paid <b id="be-amount-paid">0.00</b></div>
    <div>Amount Due <b id="be-amount-due">0.00</b></div>
  </div>

  <div style="margin-top:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
    <button class="btn-primary" id="be-post" type="button">Save (w)</button>
    <button class="btn-sm" id="be-save" type="button">Back (Esc)</button>
    <span class="be-msg" id="be-msg"></span>
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
const TAX_LABEL = ${JSON.stringify(taxLabel)};
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
  status: null,          // bill.status once loaded — 'draft' | 'posted' | 'partial' | 'paid' | 'void'
  locked: false,         // Stage 2 (2026-09-06, bill-edit/bill-detail merge): true once status !== 'draft'
  vatAmountsStated: null, // per-VAT-code override map restored from bill.get, seeds the first renderAutoLines() pass
};

// ── Line-item column config — single source of truth ──────────────────────
// Extend this array (not hand-typed widths in separate places) when #3
// (qty × unit price) and #4 (withholding tax) land — see §3.2 of
// bill-line-items-layout-prep-spec.md for the reserved slots.
//
// INVARIANT: tier-1 entries must precede tier-2 entries in this array.
// §3.4's Tier-B rendering groups cells by tier and relies on each group's
// internal order matching this array's order — see §2.3.
// Account/Debit/Credit replaces the old single Amount + "DR: Expense
// account" pair (bill-line-item-grid-spec.md). Every user line is a debit
// (an expense line never carries a Credit value); the auto-generated VAT/
// WHT/total rows built by renderAutoLines() reuse this same column set so
// everything lines up under one shared --bl-cols grid.
// Column order (2026-09-06, per magnus): Description, Debit, Credit, Tax
// code, [WHT code], Account, Cost center — Account moved to tier 2 so it
// renders after the tax codes, not mirroring journal-voucher.js's order
// (Account first) any more; that was never a hard requirement, just how
// this shipped originally.
const LINE_COLUMNS = [
  { id: 'desc',   label: 'Description',  cls: 'bl-desc',   tier: 1 },
  // Reserved for the #3 spec (qty × unit price) — do not build ahead of it:
  // { id: 'qty',  label: 'Qty',          cls: 'bl-qty',    tier: 1 },
  // { id: 'rate', label: 'Rate',         cls: 'bl-rate',   tier: 1 },
  { id: 'debit',  label: 'Debit',        cls: 'bl-debit',  tier: 1 },
  { id: 'credit', label: 'Credit',       cls: 'bl-credit', tier: 1 },
  { id: 'vat',    label: TAX_LABEL + ' code', cls: 'bl-vat', tier: 2, conditionalOn: () => VAT_ON },
  { id: 'wht',    label: 'WHT code',     cls: 'bl-wht',    tier: 2, conditionalOn: () => WHT_ON },
  { id: 'acct',   label: 'Account',      cls: 'bl-acct',   tier: 2 },
  { id: 'cc',     label: 'Cost center',  cls: 'bl-cc',     tier: 2 },
  { id: 'del',    label: '',             cls: 'be-line-x', tier: 2 },
];
function activeColumns() { return LINE_COLUMNS.filter(c => !c.conditionalOn || c.conditionalOn()); }

// Tier A (wide, single row) column-track widths, keyed by column id — see
// §3.3. Kept separate from LINE_COLUMNS itself so the reserved/commented
// entries above can stay terse; a width only needs to exist once its column
// is actually wired up in renderCell (§2.3).
const WIDE_TRACK_WIDTH = {
  desc: 'minmax(200px,2.4fr)', qty: 'minmax(70px,0.6fr)', rate: 'minmax(90px,0.7fr)',
  acct: 'minmax(160px,1.4fr)', debit: 'minmax(90px,0.8fr)', credit: 'minmax(90px,0.8fr)',
  vat: 'minmax(90px,0.8fr)', wht: 'minmax(90px,0.8fr)',
  cc:   'minmax(120px,1fr)', del: '32px',
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
  if (S.billId) await prefillFromExisting(S.billId);
  else {
    document.getElementById('be-date').value = FB.util.today();
    document.getElementById('be-due').value = FB.util.today();
    addLine({});
  }
  wireHeader();
  renderLinesHeader();
  applyGridColumns();
  if (S.billId) {
    document.getElementById('be-title').textContent =
      (S.status && S.status !== 'draft') ? 'Bill — ' + S.status.charAt(0).toUpperCase() + S.status.slice(1) : 'Edit Draft Bill';
    if (S.status && S.status !== 'draft') applyLockedMode();
  }
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

async function prefillFromExisting(id) {
  const [bill, lines] = await Promise.all([
    apiAction('bill.get', { billId: id }),
    apiAction('bill.lines', { billId: id }),
  ]);
  S.status = bill.status || 'draft';
  S.amount = Number(bill.amount || 0);
  S.amountPaid = Number(bill.amount_paid || 0);
  S.dueDateRaw = bill.due_date || null;
  // Recently-viewed for the search empty-state dropdown (global-search-spec.md
  // §2.1) — ported from bill-detail.js (Stage 4, 2026-09-06); was missing
  // here entirely, since bill-edit.js previously only ever showed drafts.
  if (window.FB && FB.search && FB.search.pushRecent) {
    FB.search.pushRecent({ type: 'bill', id: id,
      label: (bill.partner_name || '') + (bill.vendor_ref ? ' ' + bill.vendor_ref : ''),
      route: '/bill/' + encodeURIComponent(id) });
  }
  document.getElementById('be-partner-name').value = bill.partner_name || '';
  S.selectedPartnerId = bill.partner_id || null;  // bills-partner-fk-spec §4.2 — preserve link on re-save
  document.getElementById('be-date').value = (bill.date || '').slice(0, 10);
  document.getElementById('be-due').value = (bill.due_date || bill.date || '').slice(0, 10);
  document.getElementById('be-ref').value = bill.vendor_ref || '';
  document.getElementById('be-ccy').value = bill.currency || '';
  S.selectedApAccount = bill.ap_account || null;
  document.getElementById('be-memo').value = bill.description || '';
  // Per-VAT-code override map (bill.get enriches drafts with it from
  // draft_lines) — seeds computeAutoLines()'s first pass, before any
  // .bl-auto DOM row exists to read dataset.stated off of.
  S.vatAmountsStated = (VAT_ON && bill.vat_amounts_stated) ? bill.vat_amounts_stated : null;
  (lines || []).forEach(l => addLine({
    description: l.description || '',
    expense_account: l.account_code || '',
    amount: l.amount || '',
    vat_code: l.vat_code || '',
    wht_code: l.wht_code || '',
  }));
  if (!(lines || []).length) addLine({});
  // renderAttachments() (not a bare loadAttachments()) — it's what creates
  // the #be-attach-existing container loadAttachments() needs, plus the
  // "+ Add attachment" row. Pre-existing bug fixed in passing (2026-09-06):
  // without this, an existing bill's already-uploaded attachments never
  // actually rendered on open — loadAttachments() was silently returning
  // immediately because its target container didn't exist yet.
  renderAttachments();
}

// ── Locked mode (2026-09-06, bill-edit/bill-detail merge Stage 2) ──────────
// Once a bill is anything other than 'draft', its lines are a posted
// accounting record — editing them after the fact means editing history,
// which is exactly what void/reversal exist to handle correctly instead.
// vendor_ref and due_date stay live-editable (ported from bill-detail.js's
// meta-strip: saveRef/saveDueDate), auto-saving via bill.update — there is
// no explicit "save" step left once locked, so the Save button and the
// draft/post machinery (commitBill, the 'a' and line-delete verbs) all
// become no-ops. Journal trail and Void are Stage 3, not here yet.
function applyLockedMode() {
  S.locked = true;
  // Posted-vs-draft visual language (docs/UI.md Components): flatten the
  // header to plain text via the shared component, same treatment as
  // journal-voucher.js's locked header — previously this just fell back to
  // the browser's default greyed-out disabled box.
  var gridHeader = document.querySelector('.be-grid-header');
  if (gridHeader) gridHeader.classList.add('fb-locked-fields');
  ['be-partner-name', 'be-date', 'be-ccy', 'be-memo'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.disabled = true;
  });
  document.querySelectorAll('#be-lines-body .bl-row input, #be-lines-body .bl-row select').forEach(function (el) {
    el.disabled = true;
  });
  var addRowBtn = document.getElementById('be-add-row-btn');
  if (addRowBtn) addRowBtn.style.display = 'none';
  var postBtn = document.getElementById('be-post');
  if (postBtn) postBtn.style.display = 'none';
  var refEl = document.getElementById('be-ref');
  var dueEl = document.getElementById('be-due');
  if (S.status === 'void') {
    // updateBill refuses any edit once void — match that server truth
    // instead of offering fields that will just error on save.
    if (refEl) refEl.disabled = true;
    if (dueEl) dueEl.disabled = true;
  } else {
    if (refEl) refEl.addEventListener('change', function () { saveMetaField('vendor_ref', refEl.value.trim()); });
    if (dueEl) dueEl.addEventListener('change', function () { saveMetaField('due_date', dueEl.value); });
  }
  // Void (Stage 3, 2026-09-06) — same guard the server enforces: only a
  // 'posted', unpaid bill can be voided (partial/paid/void all refused).
  if (S.status === 'posted') {
    var voidBtn = document.getElementById('be-void');
    if (voidBtn) { voidBtn.style.display = ''; voidBtn.onclick = doVoid; }
  }
  // JE ref (2026-09-06) — only ever populated once locked.
  loadJournalRef();
  // Status badge + Amount Paid/Due (Stage 4, 2026-09-06, ported from
  // bill-detail.js) — payment progress, distinct from the Net/Gross totals
  // computed from the lines above.
  var badge = document.getElementById('be-status-badge');
  if (badge) badge.innerHTML = statusBadge(S.status, S.dueDateRaw);
  var cardsEl = document.getElementById('be-amount-cards');
  if (cardsEl) {
    cardsEl.style.display = '';
    document.getElementById('be-amount-paid').textContent = S.amountPaid.toFixed(2);
    document.getElementById('be-amount-due').textContent = (S.amount - S.amountPaid).toFixed(2);
  }
}

// Ported verbatim from bill-detail.js. Every status this function can be
// asked to render corresponds to a locked bill — statusBadge() is only ever
// called from applyLockedMode(), never for a draft — so every label gets the
// 🔒 (posted-vs-draft visual language, docs/UI.md Components): a second,
// non-color-dependent signal that the record can no longer be edited.
function statusBadge(status, dueDate) {
  var today = new Date().toISOString().slice(0, 10);
  var isOverdue = (status === 'posted' || status === 'partial') && dueDate && String(dueDate).slice(0, 10) < today;
  if (isOverdue) return '<span class="badge badge-danger">🔒 Overdue</span>';
  if (status === 'posted')  return '<span class="badge badge-info">🔒 Open</span>';
  if (status === 'partial') return '<span class="badge badge-warning">🔒 Partial</span>';
  if (status === 'paid')    return '<span class="badge badge-success">🔒 Paid</span>';
  if (status === 'void')    return '<span class="badge badge-neutral">🔒 Void</span>';
  return '<span class="badge badge-neutral">🔒 ' + FB.util.esc(status || '') + '</span>';
}

function doVoid() {
  FB.modal.open({
    title: 'Void this bill?',
    body: 'The journal entry will be auto-reversed.',
    buttons: [
      { label: 'Cancel', onClick: function (api) { api.close(); } },
      { label: 'Void bill', danger: true, onClick: function (api) {
          api.close();
          var btn = document.getElementById('be-void');
          btn.disabled = true;
          apiAction('bill.void', { billId: S.billId })
            .then(function () { window.location.href = '/' + COMPANY + '/payables'; })
            .catch(function (e) { btn.disabled = false; msg(e.message, 'err'); });
        } }
    ]
  });
}

// JE ref link (2026-09-06, replaces the old full journal-trail table —
// per magnus: the line items already show the same Account/Debit/Credit
// info the trail table repeated; the doc-no link was the only thing it had
// that the line items don't. One or more batches (e.g. the original post
// plus a void-reversal) each get their own link, deduped by batch_id.
function loadJournalRef() {
  apiAction('journal.list', { billId: S.billId, sortBy: 'date', sortDir: 'ASC' }).then(function (entries) {
    var el = document.getElementById('be-je-ref');
    if (!el) return;
    var seen = {}, refs = [];
    (entries || []).forEach(function (e) {
      var bId = e.batch_id || 'default';
      if (seen[bId]) return;
      seen[bId] = true;
      refs.push('<a class="be-journal-ref-link" href="/' + COMPANY + '/journal/voucher?batch=' + encodeURIComponent(bId) + '">' + FB.util.esc(e.reference || bId) + '</a>');
    });
    el.innerHTML = refs.length ? 'JE: ' + refs.join(', ') : '';
  }).catch(function () {
    var el = document.getElementById('be-je-ref');
    if (el) el.textContent = '';
  });
}

// Live-save a single header field once locked (partial update — bill.update
// only touches fields it's given, so no need to resend the others).
function saveMetaField(field, value) {
  if (!S.billId) return;
  var payload = { billId: S.billId };
  payload[field] = value;
  apiAction('bill.update', payload)
    .then(function () { msg('Saved', 'ok'); })
    .catch(function (e) { msg(e.message, 'err'); });
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
    case 'desc':   inner = '<input class="bl-desc" value="' + FB.util.escAttr(data.description || '') + '" placeholder="line description">'; break;
    case 'acct':   inner = '<input class="bl-acct" value="' + FB.util.escAttr(data.expense_account || '') + '" autocomplete="off" placeholder="Account">'; break;
    case 'debit':  inner = '<input class="bl-debit" type="number" step="0.01" min="0" placeholder="Debit" value="' + (data.amount !== '' && data.amount != null ? data.amount : '') + '">'; break;
    // A user (expense) line is always a debit — Credit stays blank/disabled,
    // present only so the column lines up with the auto-generated total row.
    case 'credit': inner = '<input class="bl-credit" type="number" value="" disabled tabindex="-1">'; break;
    case 'vat':    inner = '<input class="bl-vat" value="' + FB.util.escAttr(data.vat_code || '') + '" autocomplete="off" placeholder="—">'; break;
    case 'wht':    inner = '<input class="bl-wht" value="' + FB.util.escAttr(data.wht_code || '') + '" autocomplete="off" placeholder="—">'; break;
    case 'cc':     inner = '<input class="bl-cc" value="' + FB.util.escAttr(data.cost_center || '') + '" autocomplete="off" placeholder="Cost center">'; break;
    case 'del':    inner = '<button class="be-line-x" type="button" title="delete line" aria-label="Delete line">×</button>'; break;
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
  // New rows go before the auto-generated VAT/WHT/total rows, which must
  // always stay last (renderAutoLines() re-appends them on every edit).
  const firstAuto = container.querySelector('.bl-auto');
  if (firstAuto) container.insertBefore(row, firstAuto); else container.appendChild(row);
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
function userLineRows() { return document.querySelectorAll('#be-lines-body .bl-row:not(.bl-auto)'); }
function lastLineHasData() {
  const rows = userLineRows();
  if (!rows.length) return false;
  const last = rows[rows.length - 1];
  return !!(last.querySelector('.bl-desc').value.trim() || last.querySelector('.bl-debit').value);
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

// ── Totals + auto-generated lines (bill-line-item-grid-spec.md) ─────────────
// User-entered lines only — the auto-generated VAT/WHT/total rows below
// (.bl-auto) are computed output, never sent back as "lines" to the server.
function collectLines() {
  return Array.from(userLineRows()).map(row => ({
    description: row.querySelector('.bl-desc').value.trim(),
    expense_account: row.querySelector('.bl-acct').value.trim(),
    amount: parseFloat(row.querySelector('.bl-debit').value) || 0,
    vat_code: (function(){ var s = row.querySelector('.bl-vat'); return s ? (s.value.trim() || '') : ''; })(),
    wht_code: (function(){ var w = row.querySelector('.bl-wht'); return w ? (w.value.trim() || '') : ''; })(),
    cost_center: row.querySelector('.bl-cc').value.trim() || null,
  })).filter(l => l.description || l.amount || l.expense_account);
}
// Reads back a supplier-stated override already sitting in an auto VAT row's
// Debit input (marked via dataset.stated by wireAutoRow's listener) so
// rebuilding the row on every keystroke doesn't clobber what the user typed.
// Before that row exists at all (first render after loading an existing
// draft), falls back to S.vatAmountsStated — restored from bill.get.
function statedOverride(key) {
  const input = document.querySelector('.bl-auto[data-key="' + key + '"] .bl-auto-debit');
  if (input) return (input.dataset.stated === '1' && input.value !== '') ? (parseFloat(input.value) || 0) : null;
  if (S.vatAmountsStated && key.indexOf('vat:') === 0) {
    const v = S.vatAmountsStated[key.slice(4)];
    return (v !== undefined && v !== null && v !== '' && !isNaN(Number(v))) ? Number(v) : null;
  }
  return null;
}
function computeAutoLines() {
  const lines = collectLines();
  const net = lines.reduce((s, l) => s + l.amount, 0);
  const std = {}, rc = {}, wht = {}, stdOrder = [], rcOrder = [], whtOrder = [];
  lines.forEach(l => {
    if (l.vat_code) {
      const v = S.vatCodes.find(x => x.vat_code === l.vat_code);
      if (v) {
        const amt = Math.round(l.amount * vatRateOf(l.vat_code) * 100) / 100;
        const bucket = v.is_reverse_charge ? rc : std;
        const order = v.is_reverse_charge ? rcOrder : stdOrder;
        if (!(l.vat_code in bucket)) { order.push(l.vat_code); bucket[l.vat_code] = { v, amt: 0 }; }
        bucket[l.vat_code].amt += amt;
      }
    }
    if (WHT_ON && l.wht_code) {
      const w = S.whtCodes ? S.whtCodes.find(x => x.wht_code === l.wht_code) : null;
      if (w) {
        const amt = Math.round(l.amount * Number(w.rate) * 100) / 100;
        if (!(l.wht_code in wht)) { whtOrder.push(l.wht_code); wht[l.wht_code] = { w, amt: 0 }; }
        wht[l.wht_code].amt += amt;
      }
    }
  });
  const rows = [];
  let stdTotal = 0;
  stdOrder.forEach(code => {
    const entry = std[code];
    if (!entry.amt) return;
    const stated = statedOverride('vat:' + code);
    const debit = stated !== null ? stated : entry.amt;
    stdTotal += debit;
    rows.push({ key: 'vat:' + code, account: entry.v.vat_account_input, label: code + ': ' + (entry.v.description || code), debit, credit: 0, editable: !S.locked, stated: stated !== null });
  });
  rcOrder.forEach(code => {
    const entry = rc[code];
    if (!entry.amt) return;
    rows.push({ key: 'rc-dr:' + code, account: entry.v.vat_account_input, label: 'Input ' + TAX_LABEL + ' RC — ' + code, debit: entry.amt, credit: 0, editable: false });
    rows.push({ key: 'rc-cr:' + code, account: entry.v.vat_account_output, label: 'Output ' + TAX_LABEL + ' RC — ' + code, debit: 0, credit: entry.amt, editable: false });
  });
  let whtTotal = 0;
  whtOrder.forEach(code => {
    const entry = wht[code];
    if (!entry.amt) return;
    whtTotal += entry.amt;
    rows.push({ key: 'wht:' + code, account: entry.w.wht_account, label: 'WHT — ' + code, debit: 0, credit: entry.amt, editable: false });
  });
  rows.push({ key: 'total', account: S.selectedApAccount || '', label: 'Total', debit: 0, credit: Math.round((net + stdTotal - whtTotal) * 100) / 100, editable: false });
  return { rows, net, stdTotal, whtTotal, gross: Math.round((net + stdTotal) * 100) / 100 };
}
function autoRowCells(r) {
  const cols = activeColumns();
  const cell = c => {
    var inner;
    switch (c.id) {
      case 'desc':   inner = '<span class="bl-auto-label">' + FB.util.esc(r.label) + '</span>'; break;
      case 'acct':   inner = '<input class="bl-acct" value="' + FB.util.escAttr(r.account || '') + '" disabled tabindex="-1">'; break;
      case 'debit':  inner = r.editable
        ? '<input class="bl-debit bl-auto-debit" type="number" step="0.01" min="0" value="' + (r.debit ? r.debit.toFixed(2) : '') + '">'
        : '<input class="bl-debit" type="number" value="' + (r.debit ? r.debit.toFixed(2) : '') + '" disabled tabindex="-1">';
        break;
      case 'credit': inner = '<input class="bl-credit" type="number" value="' + (r.credit ? r.credit.toFixed(2) : '') + '" disabled tabindex="-1">'; break;
      case 'del':    inner = ''; break;
      default:       inner = ''; // vat/wht/cc: blank on every auto row (spec §8)
    }
    return '<div class="bl-cell">' + inner + '</div>';
  };
  const g1 = cols.filter(c => c.tier === 1).map(cell).join('');
  const g2 = cols.filter(c => c.tier === 2).map(cell).join('');
  return '<div class="bl-group">' + g1 + '</div><div class="bl-group">' + g2 + '</div>';
}
function wireAutoRow(row, r) {
  if (!r.editable) return;
  const input = row.querySelector('.bl-auto-debit');
  input.title = 'Supplier-stated ' + TAX_LABEL + ' for this code — pre-filled computed; edit to match the supplier invoice; clear to return to computed';
  input.addEventListener('input', function () {
    input.dataset.stated = input.value !== '' ? '1' : '';
    updateTotals();
  });
}
function updateAutoRowCells(row, r) {
  const acctInput = row.querySelector('.bl-acct');
  if (acctInput) acctInput.value = r.account || '';
  const debitInput = row.querySelector('.bl-debit');
  if (debitInput) {
    debitInput.value = r.debit ? r.debit.toFixed(2) : '';
    if (r.editable) debitInput.style.color = debitInput.dataset.stated === '1' ? 'var(--warning)' : '';
  }
  const creditInput = row.querySelector('.bl-credit');
  if (creditInput) creditInput.value = r.credit ? r.credit.toFixed(2) : '';
  const label = row.querySelector('.bl-auto-label');
  if (label) label.textContent = r.label;
}
// Reconciles .bl-auto rows against freshly computed data without destroying
// the DOM node the user is actively typing into — a naive full rebuild on
// every keystroke would steal focus from an in-progress VAT override edit.
function renderAutoLines(rows) {
  const container = document.getElementById('be-lines-body');
  const existingByKey = {};
  container.querySelectorAll('.bl-auto').forEach(el => { existingByKey[el.dataset.key] = el; });
  const seen = {};
  rows.forEach(r => {
    seen[r.key] = true;
    let row = existingByKey[r.key];
    if (!row) {
      row = document.createElement('div');
      row.className = 'bl-row bl-auto';
      row.dataset.key = r.key;
      row.innerHTML = autoRowCells(r);
      wireAutoRow(row, r);
      if (r.stated) { const di = row.querySelector('.bl-auto-debit'); if (di) { di.dataset.stated = '1'; di.style.color = 'var(--warning)'; } }
    } else if (!row.contains(document.activeElement)) {
      updateAutoRowCells(row, r);
    }
    container.appendChild(row); // moves (not recreates) — re-establishes order, keeps focus
  });
  Object.keys(existingByKey).forEach(key => { if (!seen[key]) existingByKey[key].remove(); });
}
function collectVatAmountsStated() {
  const map = {};
  document.querySelectorAll('.bl-auto .bl-auto-debit').forEach(input => {
    if (input.dataset.stated === '1' && input.value !== '') {
      const code = input.closest('.bl-auto').dataset.key.slice('vat:'.length);
      map[code] = parseFloat(input.value) || 0;
    }
  });
  return map;
}
function updateTotals() {
  const auto = computeAutoLines();
  renderAutoLines(auto.rows);
  var whtEl = document.getElementById('be-tot-wht');
  var payEl = document.getElementById('be-tot-payable');
  if (whtEl) whtEl.textContent = auto.whtTotal.toFixed(2);
  if (payEl) payEl.textContent = (auto.gross - auto.whtTotal).toFixed(2);
}

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
    vat_amounts_stated: VAT_ON ? collectVatAmountsStated() : undefined,
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
    // bill-post-payment-consolidation-spec.md §5: aligned with payables-bills.js's
    // billValidateBuf, which already requires both of these for a save.
    if (!bill.due_date) { missing.push('due date'); mark('be-due'); }
    else if (bill.due_date < bill.date) { missing.push('due date must be on or after bill date'); mark('be-due'); }
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

// q = quit (no save). Dirty → confirm discard (same guard as Partners).
// Locked bills have nothing pending — vendor_ref/due_date already auto-save
// on change — so there's no dirty-check left to run.
// Return-context (ported from bill-detail.js's escape handler, Stage 4,
// 2026-09-06 — ap-aging-drilldown-spec.md §6): drilled in from AP Aging with
// ?from=ap-aging&asof=&ccy= → back to that report at the same as-of date/
// currency, not a reset default. Anything else falls through to Payables.
function returnUrl() {
  var params = new URLSearchParams(window.location.search);
  if (params.get('from') === 'ap-aging') {
    var asof = params.get('asof') || '';
    var ccy = params.get('ccy') || '';
    var url = '/' + COMPANY + '/reports?t=ap-aging&end=' + encodeURIComponent(asof);
    if (ccy) url += '&ccy=' + encodeURIComponent(ccy);
    return url;
  }
  return '/' + COMPANY + '/payables';
}

function quitEditor() {
  if (S.locked) { window.location.href = returnUrl(); return; }
  const bill = gatherBill();
  if (!bill.partner_name && !bill.lines.length) { window.location.href = returnUrl(); return; } // empty → exit silently
  if (!isDirty()) { window.location.href = returnUrl(); return; }
  FB.modal.open({
    title: 'Discard unsaved changes?',
    buttons: [
      { label: 'Keep editing', onClick: function (api) { api.close(); } },
      { label: 'Discard', danger: true, onClick: function (api) { api.close(); window.location.href = returnUrl(); } }
    ]
  });
}


// ── Attachments (staged until first save — or, once locked, uploaded
// immediately since there's no "save" step left to stage them for) ────────
document.getElementById('be-file').addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  e.target.value = '';
  if (S.locked) { files.forEach(uploadAttachmentNow); return; }
  files.forEach(f => S.stagedFiles.push(f));
  renderAttachments();
});
async function uploadAttachmentNow(file) {
  const fd = new FormData();
  fd.append('companyId', COMPANY);
  fd.append('entityType', 'bill');
  fd.append('entityId', S.billId);
  fd.append('file', file);
  try {
    await fetch('/api/upload', { method: 'POST', body: fd });
    loadAttachments();
  } catch (e) { msg('Upload failed: ' + (e && e.message || e), 'err'); }
}
function renderAttachments() {
  const el = document.getElementById('be-attach-list');
  el.innerHTML = S.stagedFiles.map((f, i) =>
    '<div class="be-attach-row"><span class="name">📄 ' + FB.util.esc(f.name) + '</span>' +
    '<span class="staged">staged — uploads on save</span>' +
    '<button class="be-line-x" style="visibility:visible" data-i="' + i + '" type="button" aria-label="Remove attachment">×</button></div>'
  ).join('') + (S.billId ? '<div id="be-attach-existing"></div>' : '')
    // + Add attachment row (2026-09-06, retires A) — fb-list add-row parity.
    // Pinned last; its button is the attachments zone's one real cell.
    + '<div class="be-attach-row be-attach-add"><button type="button" class="be-attach-add-btn" onclick="document.getElementById(\\'be-file\\').click()">+ Add attachment</button></div>';
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
// Stage 4 (2026-09-06, ported from bill-detail.js's richer render): icon,
// upload date, size, and — new here — an actual delete button. Bill-edit
// previously had no way to remove an already-uploaded attachment at all,
// only staged (not-yet-uploaded) ones; this closes that gap.
async function loadAttachments() {
  const host = document.getElementById('be-attach-existing');
  if (!host || !S.billId) return;
  try {
    const rows = await apiAction('attachment.list', { entityType: 'bill', entityId: S.billId });
    host.innerHTML = (rows || []).map(a => {
      const kb = (a.file_size / 1024).toFixed(1);
      const date = a.created_at ? new Date(a.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
      return '<div class="be-attach-row" data-attachment-id="' + FB.util.esc(a.attachment_id) + '">'
        + '<span class="name">📄 <a href="/api/attachments/' + a.attachment_id + '" target="_blank">' + FB.util.esc(a.filename || a.file_name || 'file') + '</a>'
        + ' <span class="staged">(' + date + (date ? ' · ' : '') + kb + ' KB)</span></span>'
        + '<button class="be-line-x" style="visibility:visible" data-attachment-id="' + FB.util.esc(a.attachment_id) + '" type="button" title="delete (x)" aria-label="Delete">×</button></div>';
    }).join('');
    host.querySelectorAll('button[data-attachment-id]').forEach(b => {
      b.onclick = () => deleteExistingAttachment(b.dataset.attachmentId);
    });
  } catch (e) { /* non-fatal */ }
}

function deleteExistingAttachment(attachmentId) {
  FB.modal.open({
    title: 'Remove attachment?',
    buttons: [
      { label: 'Cancel', onClick: function (api) { api.close(); } },
      { label: 'Remove', danger: true, onClick: function (api) {
          api.close();
          apiAction('attachment.delete', { attachmentId }).then(loadAttachments).catch(e => msg(e.message, 'err'));
        } }
    ]
  });
}

// w commits — always posts (the Draft toggle was removed 2026-09-06, per
// magnus: users never save drafts manually anymore). The Save button
// mirrors it exactly (same function, not a second path).
// Locked (2026-09-06): nothing left to commit — vendor_ref/due_date already
// auto-save, lines are frozen, and the Save button itself is hidden.
function commitBill() { if (S.locked) return; return postBill(); }

// ── Buttons + keys ──────────────────────────────────────────────────────────
document.getElementById('be-save').onclick = () => quitEditor();
document.getElementById('be-post').onclick = () => commitBill();

// ── FB.form (K3, keyboard-ux-spec §8) — the one form machine; this page ──
// declares config + verbs only. Zones: header grid → attachments → lines table.
// The page starts in NORMAL; user presses i/Enter to edit a cell.
var beForm = FB.form.create({
  formId: 'bill-edit',
  zones: [
    { id: 'header', rows: function () { return [document.querySelector('.be-grid-header')]; } },
    // A retired (2026-09-06): cells() now exposes the "+ Add attachment"
    // row's button as the zone's one real cell (i/Enter or a click opens
    // the file picker); real attachment rows stay cell-less, deleted
    // directly by 'x' (see the delete verb's z===1 branch below).
    // Attachments moved into the header area (2026-09-06, per magnus) — this
    // zone now sits right after 'header' to match the new visual order.
    { id: 'attachments', rows: function () { return Array.from(document.querySelectorAll('#be-attach-list .be-attach-row')); },
      cells: function (rowEl) {
        var btn = rowEl.querySelector('.be-attach-add-btn');
        return btn ? [btn] : [];
      } },
    { id: 'lines',  rows: function () {
        return Array.from(document.querySelectorAll('#be-lines-body .bl-row'));
      },
      cells: function (rowEl) {
        return Array.prototype.slice.call(rowEl.querySelectorAll('input,select,button'))
          .filter(function (el) { return !el.disabled && el.type !== 'hidden'; });
      } },
  ],
  verbs: {
    add: { key: 'a', hint: 'add line', run: function (api) {
      if (S.locked) return;   // 2026-09-06: lines are frozen once posted
      var row = addLine({});
      updateTotals();
      // bill-line-item-grid-spec.md (2026-09-06): the auto-generated VAT/WHT/
      // total rows now live in the same zone, pinned last by addLine()'s
      // insertBefore — "last row" is no longer the just-added line, so find
      // it by identity instead of assuming it's at zoneRows(2).length - 1.
      var idx = Array.prototype.indexOf.call(api.zoneRows(2), row);
      api.moveTo(2, idx >= 0 ? idx : api.zoneRows(2).length - 1, 0, true);
    } },
    delete: { key: 'x', hint: 'delete',
      // Auto-generated rows (bill-line-item-grid-spec.md) aren't deletable —
      // they're computed output, not a real line — so x is inert on them
      // rather than removing-then-immediately-regenerating one.
      when: function (api) {
        var z = api.cur().z;
        if (z === 2) {
          var row = api.zoneRows(2)[api.cur().r];
          return api.cur().r > 0 && row && !row.classList.contains('bl-auto');
        }
        return z === 1;
      },
      run: function (api) {
        if (api.cur().z === 2 && S.locked) return;   // 2026-09-06: lines are frozen once posted
        if (api.cur().z === 1) {
          // attachments zone — staged files have a data-i delete button,
          // already-uploaded ones a data-attachment-id one (Stage 4,
          // 2026-09-06); the add row has neither, so this safely no-ops on it.
          var arow = api.zoneRows(1)[api.cur().r];
          var abtn = arow && arow.querySelector('button[data-i], button[data-attachment-id]');
          if (abtn) abtn.onclick();
          return;
        }
        var row = api.zoneRows(2)[api.cur().r];
        if (!row) return;
        row.remove(); updateTotals(); refreshAddRow(); api.refresh();
      } },
    // w always posts (Draft toggle removed 2026-09-06). p is retired.
    write: { key: 'w', hint: 'save', run: function () { commitBill(); } },
    // No dedicated key any more — Esc in NORMAL invokes this directly
    // (fb-form.js unifies the Esc doctrine: INSERT Esc exits a field edit,
    // NORMAL Esc exits the whole form). 'q' is retired.
    quit: { hint: 'quit', run: function () { quitEditor(); } }
  },
  extraBindings: function (api) {
    return [
      // A retired (2026-09-06) — the attachments zone's own
      // "+ Add attachment" row does this job now (see the zone's cells()).
      // x on the header zone voids a posted bill (Stage 3, 2026-09-06) —
      // same "x means something bigger on the header" pattern as
      // journal-voucher's reversal entry. Never collides with the generic
      // delete verb's x, which only ever matches z===1||2 (attachments/
      // lines), never z===0 (header).
      { key: 'x', mode: 'NORMAL', hint: 'void', hintBar: true,
        when: function () { return S.status === 'posted' && api.cur().z === 0; },
        run: doVoid },
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

module.exports = { handleBillPage };
