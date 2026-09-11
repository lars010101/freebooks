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
const { makeQuery, commonStyle, navBar, layoutEnd, getRelevanceFlags, flagsBootstrapJson } = require('./common');

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
  const flagsJson = flagsBootstrapJson(flags);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Bill Editor - freeBooks</title>
${commonStyle()}
<style>
  /* Header fields (2026-09-11): each field is sized to what it holds
     instead of dividing the row into equal fractions — a date input never
     needed a third of a 1600px page. Sizing/padding/border-radius now lend
     from the payables/bills .data-table's own dense recipe (docs/UI.md)
     rather than inventing separate numbers: padding 4px 6px, 3px radius, no
     forced input height (natural height from padding+font, same as
     Vendors' .edit-table inputs).
     Row 1 (2026-09-11, per magnus): Partner/Date/Due/Reference/Amount/CCY/
     Status — literally the Bills table's own column order and titles
     (payables.js #bills-table thead), so a bill reads the same way whether
     you're looking at the list row or the full-page editor. Amount is the
     line items' computed gross, read-only (the old "Total" auto-row in the
     lines grid is retired — updateTotals() writes here instead); Status
     shows "Unposted" pre-post, the same locked badge as before once posted. */
  .be-grid-header { margin-bottom:12px; }
  .be-gh-row { display:flex; gap:12px; align-items:end; margin-bottom:10px; }
  .be-gh-row:last-child { margin-bottom:0; }
  .be-grid-header label {
    display:flex; flex-direction:column; gap:3px;
    font-weight:600; font-size:0.75rem; text-transform:uppercase; color:var(--text-muted);
  }
  .be-grid-header input, .be-grid-header select {
    padding:4px 6px; border:1px solid var(--border); border-radius:3px;
    font-size:0.8125rem; box-sizing:border-box; background:var(--surface); color:var(--text);
    /* Browsers don't inherit the page font into form controls by default —
       without this, every input here (most visibly the date boxes, whose
       spinner/segments render in the same computed font) silently falls
       back to Chromium's plain-Arial form-control default while the
       surrounding labels use body's Helvetica Neue stack. Same bug class
       already fixed once in the topbar search box (common.css .tb-search). */
    font-family:inherit;
  }
  /* Caption left-align (2026-09-11, per magnus — same fix as the line-items
     grid, applied here too): a caption sitting directly in the label starts
     at x:0, but the input below it starts 7px in (1px border + 6px
     padding) — the caption needs its own 7px inset to land where the
     input's TEXT starts, not the input's outer wall. Wrapped in a span
     (rather than padding the label itself) because padding on the label
     would shift the input too, not just the caption. */
  .be-gh-cap { padding-left:7px; }
  /* Amount is right-aligned (its value is), so its caption mirrors that —
     right-aligned, padded from the right by the same 7px the input's own
     right-side inset uses, instead of the left-aligned default. */
  .be-gh-cap-right { padding-left:0; padding-right:7px; text-align:right; }
  /* Status has no input at all — its "cell" is the badge span next to the
     label, whose own inset is .badge's padding (3px 10px, no border), not
     an input's (1px border + 6px padding) — a different number, so it gets
     its own rule rather than reusing .be-gh-cap's 7px. */
  .be-gh-status label { padding-left:10px; }
  .be-gh-partner { width:320px; }
  .be-gh-partner input { width:100%; }
  .be-gh-date, .be-gh-due { width:150px; }
  .be-gh-ref { width:200px; }
  .be-gh-amount input { text-align:right; font-variant-numeric:tabular-nums; background:var(--bg); }
  .be-gh-ccy { width:90px; }
  .be-gh-amount, .be-gh-status { width:140px; }
  .be-gh-memo { width:100%; max-width:460px; }
  .be-gh-memo input { width:100%; }
  /* Attachments icon (2026-09-11) — borrows Inbox's source-document badge
     concept (underlagBadge/.ul-badge in inbox.js): a compact 📎 pill with a
     count, click opens a modal listing/managing them, instead of an
     always-open bordered box that took a full row even with zero files. */
  .be-attach-icon-btn {
    display:inline-flex; align-items:center; gap:4px;
    padding:5px 10px; border:1px solid var(--border); border-radius:9px;
    font-size:0.75rem; font-weight:600; background:var(--surface); color:var(--text-muted);
    cursor:pointer; white-space:nowrap; box-sizing:border-box;
  }
  .be-attach-icon-btn.has-files { background:var(--info-bg); color:var(--info); border-color:transparent; }
  #be-attach-count:empty { display:none; }
  .be-lines-wrap, .bl-header, .bl-row { column-gap: 8px; }
  .bl-header, .bl-row { display: grid; grid-template-columns: var(--bl-cols); }
  /* Divider (2026-09-11, per magnus): sits above the line item column
     headers — separating the header-fields section (Memo/Attachments) from
     the whole line-items block, headers included — not under the last line
     before "+ Add Line". #be-lines-body's LAST row (whichever one that
     currently is — a real line, or the last auto VAT/WHT row once one
     exists) drops its own border, so there's exactly this one divider, not
     a second one trailing the rows too. */
  .bl-header { border-top:1px solid var(--border); }
  .bl-row { border-bottom:1px solid var(--border); }
  #be-lines-body .bl-row:last-child { border-bottom:none; }
  .bl-group { display: contents; }
  /* Cell padding/font-size lent from .data-table th/td (docs/UI.md — no
     reason for the line-items grid to run a different density than every
     other table in the app).
     Header padding-left is 13px, not the cell's own 6px (2026-09-11, per
     magnus): a body cell's typed text actually starts 13px in from the
     cell's left edge (6px .bl-cell padding + 1px input border + 6px input
     padding) — the header needs to match where the TEXT starts, not the
     input's outer wall, or it reads as left of every column it labels. */
  .bl-cell { padding:4px 6px; display:flex; align-items:center; min-width:0; }
  .bl-header .bl-cell { padding:6px 6px 6px 13px; font-size:0.75rem; text-transform:uppercase; color:var(--text-muted); }
  .bl-cell input, .bl-cell select { min-width:0; width:100%; padding:4px 6px; border:1px solid var(--border); border-radius:3px; font-size:0.8125rem; box-sizing:border-box; background:var(--surface); color:var(--text); font-family:inherit; }
  /* Debit/Credit are the grid's monetary columns — right-aligned values,
     header right-aligned to match (2026-09-11, per magnus: same standard
     Bills' own Amount column already uses — th[data-col="amount"] .th-inner
     { justify-content:flex-end } in payables.js). The header's padding
     flips (13px moves from left to right) to mirror the input's own
     right-side inset instead of its left one. */
  .bl-header .bl-debit, .bl-header .bl-credit { justify-content:flex-end; padding-left:6px; padding-right:13px; }
  .bl-cell input.bl-debit, .bl-cell input.bl-credit { text-align:right; font-variant-numeric:tabular-nums; }
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
  /* Attachment rows (2026-09-11) — the same .fb-attach-row/.fb-att-* recipe
     journal-voucher.js and inbox.js each carry their own copy of (docs/UI.md
     — duplicated per-page, like .fb-att-add-btn/.be-attach-add-btn); the
     shared FB.attachments.rowHtml() (fb-attachments.js) emits this markup
     for already-uploaded rows so the modal matches Inbox's source-document
     panel exactly, not just visually similar. */
  .fb-attach-row { display:flex; align-items:center; gap:6px; padding:3px 6px; border-bottom:1px solid var(--border); border-radius:3px; font-size:0.8125rem; }
  .fb-att-link { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text); text-decoration:none; }
  .fb-att-link:hover { text-decoration:underline; }
  .fb-att-meta { color:var(--text-muted); font-size:0.6875rem; white-space:nowrap; }
  .fb-att-del { border:none; background:none; cursor:pointer; color:var(--text-muted); font-size:0.875rem; padding:0 4px; }
  .fb-att-del:hover { color:var(--danger); }
  .fb-attach-empty { color:var(--text-faint); font-size:0.75rem; font-style:italic; padding:6px; }
  /* + Add attachment row (2026-09-06, retires A) — fb-list add-row parity.
     Base recipe is shared (.be-attach-add-btn in common.css). These rows now
     live inside the attachments modal (2026-09-11), not a keyboard-navigable
     FB.form zone, so there's no row-focus colour override to carry any more. */
  /* JE ref link (2026-09-06) — see loadJournalRef() */
  .be-journal-ref-link { color:var(--accent); font-weight:500; text-decoration:none; }
  .be-journal-ref-link:hover { text-decoration:underline; }
  /* Status badge (shared .badge component, common.css) — lives in the
     header grid's row 1 now (2026-09-11), not next to the h1; see
     updateStatusBadge(). */
  .be-amount-cards { display:flex; gap:16px; font-size:0.8125rem; margin-top:10px; }
  input.req { border-color:var(--danger) !important; }
  .header { display:flex; justify-content:space-between; align-items:flex-start; }
</style>
</head>
<body>${navBar(company, 'payables')}
<div class="page page-wide">
  <div class="header">
    <!-- align-items:baseline (not the h1's own display:inline trick this
         used to use) — keeps the badge/JE-ref visually attached to the h1's
         text without the h1 losing its normal block-level box, which was
         quietly shifting the whole header 6px down relative to every other
         page (docs/UI.md — chrome alignment: .header's height/position must
         trace to the h1 alone). -->
    <div style="display:flex;align-items:baseline;gap:10px">
      <h1 id="be-title">New Bill</h1>
      <!-- JE ref (2026-09-06, replaces the old Journal Entries trail table —
           per magnus: the line items already show the same Account/Debit/
           Credit info; the doc-no link was the only thing missing). -->
      <span id="be-je-ref" style="font-size:0.75rem"></span>
    </div>
    <!-- Void (2026-09-06, ported from bill-detail.js): shown only for a
         posted, unpaid bill — matches the server's own refusal to void a
         partial/paid/already-void bill. Also reachable via x on the header
         zone, same "x means something bigger here" pattern as
         journal-voucher's reversal entry. -->
    <button id="be-void" class="btn-sm danger" type="button" style="display:none">&#8856; Void</button>
  </div>

  <div class="be-grid-header">
    <!-- Row 1: Partner/Date/Due/Reference/Amount/CCY/Status — the Bills
         table's own column order and titles (docs/UI.md — lend, don't
         diverge). Amount and Status are read-only displays here, not
         inputs; Amount comes from updateTotals(), Status from
         updateStatusBadge(). -->
    <div class="be-gh-row">
      <label class="be-gh-partner"><span class="be-gh-cap">Partner *</span><input id="be-partner-name" autocomplete="off"></label>
      <label class="be-gh-date"><span class="be-gh-cap">Date *</span><input id="be-date" type="date"></label>
      <label class="be-gh-due"><span class="be-gh-cap">Due</span><input id="be-due" type="date"></label>
      <label class="be-gh-ref"><span class="be-gh-cap">Reference</span><input id="be-ref" autocomplete="off"></label>
      <label class="be-gh-amount"><span class="be-gh-cap be-gh-cap-right">Amount</span><input id="be-amount" type="text" value="0.00" readonly tabindex="-1"></label>
      ${fxOn
        ? '<label class="be-gh-ccy"><span class="be-gh-cap">CCY</span><input id="be-ccy" maxlength="3" autocomplete="off" style="text-transform:uppercase"></label>'
        : '<input id="be-ccy" type="hidden" value="' + baseCcy + '">'}
      <div class="be-gh-status"><label style="margin-bottom:0">Status</label><span id="be-status-badge"></span></div>
    </div>
    <!-- Row 2: Memo + attachments (icon opens a modal — see openAttachmentsModal()). -->
    <div class="be-gh-row">
      <label class="be-gh-memo"><span class="be-gh-cap">Memo</span><input id="be-memo" autocomplete="off"></label>
      <button type="button" id="be-attach-icon-btn" class="be-attach-icon-btn" title="Attachments">📎 <span id="be-attach-count"></span></button>
      <input type="file" id="be-file" style="display:none" multiple>
    </div>
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
    <button class="btn-primary" id="be-post" type="button">Save</button>
    <button class="btn-sm" id="be-save" type="button">Back</button>
    <span class="be-msg" id="be-msg"></span>
  </div>

</div>
<script>
// IIFE-wrapped: fbNavigate re-executes inline scripts on SPA navigation —
// top-level const/let would throw "already declared" on every repeat visit.
(function () {
'use strict';
window.__fbFlags = ${flagsJson};
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
  existingAttachments: [], // attachment.list rows for an already-saved bill (2026-09-11, attachments modal)
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
  { id: 'desc',   label: 'Line Item Description', cls: 'bl-desc', tier: 1 },
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
    S.status = 'draft';
    addLine({});
  }
  wireHeader();
  wireAttachIcon();
  renderLinesHeader();
  applyGridColumns();
  if (S.billId) {
    document.getElementById('be-title').textContent =
      (S.status && S.status !== 'draft') ? 'Bill — ' + S.status.charAt(0).toUpperCase() + S.status.slice(1) : 'Edit Draft Bill';
    if (S.status && S.status !== 'draft') applyLockedMode();
  }
  updateStatusBadge();
  updateAttachIcon();
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
  await loadExistingAttachments();
  updateAttachIcon();
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
  // Amount Paid/Due (Stage 4, 2026-09-06, ported from bill-detail.js) —
  // payment progress, distinct from the Net/Gross totals computed from the
  // lines above. Status badge itself is updateStatusBadge()'s job now (row 1
  // of the header grid, not here) — called from init regardless of locked
  // state, so no need to duplicate it in this function.
  var cardsEl = document.getElementById('be-amount-cards');
  if (cardsEl) {
    cardsEl.style.display = '';
    document.getElementById('be-amount-paid').textContent = FB.util.fmtAmt(S.amountPaid);
    document.getElementById('be-amount-due').textContent = FB.util.fmtAmt(S.amount - S.amountPaid);
  }
}

// Ported from bill-detail.js, extended (2026-09-11) to also cover the
// not-yet-posted case — statusBadge() now runs unconditionally from init
// (row 1 of the header grid, Status column), not only from applyLockedMode().
// Every OTHER label still corresponds to a locked bill and keeps the 🔒
// (posted-vs-draft visual language, docs/UI.md Components): a second,
// non-color-dependent signal that the record can no longer be edited —
// "Unposted" carries no lock since the bill is still fully editable.
function statusBadge(status, dueDate) {
  var today = new Date().toISOString().slice(0, 10);
  var isOverdue = (status === 'posted' || status === 'partial') && dueDate && String(dueDate).slice(0, 10) < today;
  if (isOverdue) return '<span class="badge badge-danger">🔒 Overdue</span>';
  if (status === 'posted')  return '<span class="badge badge-info">🔒 Open</span>';
  if (status === 'partial') return '<span class="badge badge-warning">🔒 Partial</span>';
  if (status === 'paid')    return '<span class="badge badge-success">🔒 Paid</span>';
  if (status === 'void')    return '<span class="badge badge-neutral">🔒 Void</span>';
  if (!status || status === 'draft') return '<span class="badge badge-neutral">Unposted</span>';
  return '<span class="badge badge-neutral">🔒 ' + FB.util.esc(status || '') + '</span>';
}
function updateStatusBadge() {
  var badge = document.getElementById('be-status-badge');
  if (badge) badge.innerHTML = statusBadge(S.status, S.dueDateRaw);
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
  // c.cls carried onto the header cell too (not just the body input) so
  // column-specific CSS — the Debit/Credit right-align rule — can target
  // the header the same way it targets the input. Skipped for 'del' (label
  // is '' anyway) — its cls (be-line-x) names a button recipe, not a column.
  document.getElementById('be-lines-header').innerHTML =
    activeColumns().map(c => '<div class="bl-cell' + (c.id === 'del' ? '' : ' ' + c.cls) + '">' + FB.util.esc(c.label) + '</div>').join('');
}
function applyGridColumns() {
  document.getElementById('be-lines-wrap').style.setProperty('--bl-cols', computeWideColumns());
}
function renderCell(col, data) {
  var inner;
  switch (col.id) {
    case 'desc':   inner = '<input class="bl-desc" value="' + FB.util.escAttr(data.description || '') + '">'; break;
    case 'acct':   inner = '<input class="bl-acct" value="' + FB.util.escAttr(data.expense_account || '') + '" autocomplete="off">'; break;
    case 'debit':  inner = '<input class="bl-debit" type="number" step="0.01" min="0" value="' + (data.amount !== '' && data.amount != null ? data.amount : '') + '">'; break;
    // A user (expense) line is always a debit — Credit stays blank/disabled,
    // present only so the column lines up with the auto-generated total row.
    case 'credit': inner = '<input class="bl-credit" type="number" value="" disabled tabindex="-1">'; break;
    case 'vat':    inner = '<input class="bl-vat" value="' + FB.util.escAttr(data.vat_code || '') + '" autocomplete="off" placeholder="—">'; break;
    case 'wht':    inner = '<input class="bl-wht" value="' + FB.util.escAttr(data.wht_code || '') + '" autocomplete="off" placeholder="—">'; break;
    case 'cc':     inner = '<input class="bl-cc" value="' + FB.util.escAttr(data.cost_center || '') + '" autocomplete="off">'; break;
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
  // No "Total" row (2026-09-11, retired per magnus) — the bill's gross
  // amount now lives in the header grid's row 1 (Amount, read-only), lent
  // straight from the Bills table's own Amount column instead of repeating
  // it as one more line in the grid.
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
  var amtEl = document.getElementById('be-amount');
  if (amtEl) amtEl.value = FB.util.fmtAmt(auto.gross);
  var whtEl = document.getElementById('be-tot-wht');
  var payEl = document.getElementById('be-tot-payable');
  if (whtEl) whtEl.textContent = FB.util.fmtAmt(auto.whtTotal);
  if (payEl) payEl.textContent = FB.util.fmtAmt(auto.gross - auto.whtTotal);
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


// ── Attachments (2026-09-11: icon + modal, borrowing Inbox's source-document
// badge concept — underlagBadge/showSourceDocs in inbox.js) instead of an
// always-open bordered box. Staged until first save — or, once locked,
// uploaded immediately since there's no "save" step left to stage them for.
// Click routing (per magnus): zero attachments → skip the modal entirely and
// go straight to the file picker; one or more → open the modal (list +
// remove + an "add another" row), same split Inbox doesn't need (it never
// uploads, only views) but the icon itself borrows its look. ────────────────
function wireAttachIcon() {
  document.getElementById('be-attach-icon-btn').onclick = function () {
    const count = S.stagedFiles.length + S.existingAttachments.length;
    if (count === 0) { document.getElementById('be-file').click(); return; }
    openAttachmentsModal();
  };
}
document.getElementById('be-file').addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  e.target.value = '';
  if (S.locked) { files.forEach(uploadAttachmentNow); return; }
  files.forEach(f => S.stagedFiles.push(f));
  refreshAttachModal();
});
async function uploadAttachmentNow(file) {
  const fd = new FormData();
  fd.append('companyId', COMPANY);
  fd.append('entityType', 'bill');
  fd.append('entityId', S.billId);
  fd.append('file', file);
  try {
    await fetch('/api/upload', { method: 'POST', body: fd });
    await loadExistingAttachments();
    refreshAttachModal();
  } catch (e) { msg('Upload failed: ' + (e && e.message || e), 'err'); }
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
  await loadExistingAttachments();
  updateAttachIcon();
}
async function loadExistingAttachments() {
  if (!S.billId) { S.existingAttachments = []; return; }
  try { S.existingAttachments = await apiAction('attachment.list', { entityType: 'bill', entityId: S.billId }) || []; }
  catch (e) { S.existingAttachments = []; }
}
function updateAttachIcon() {
  const count = S.stagedFiles.length + S.existingAttachments.length;
  const countEl = document.getElementById('be-attach-count');
  if (countEl) countEl.textContent = count ? String(count) : '';
  const btn = document.getElementById('be-attach-icon-btn');
  if (btn) btn.classList.toggle('has-files', count > 0);
}
// Staged (not-yet-uploaded) rows have no attachment_id yet, so they can't
// use FB.attachments.rowHtml (which links to /api/attachments/<id>) — kept
// bespoke, but built from the exact same .fb-attach-row/.fb-att-*  classes
// (see the CSS block) so a staged row and an uploaded row read identically
// apart from the "staged" tag and the disabled download link.
function stagedRowHtml(f, i) {
  return '<div class="fb-attach-row" data-staged-i="' + i + '">'
    + '<span class="fb-att-icon">📄</span>'
    + '<span class="fb-att-link" style="color:var(--text-muted)">' + FB.util.esc(f.name) + '</span>'
    + ' <span class="fb-att-meta">staged — uploads on save</span>'
    + '<button class="fb-att-del" data-staged-i="' + i + '" title="Remove" aria-label="Remove">×</button>'
    + '</div>';
}
// Already-uploaded rows use the shared FB.attachments.rowHtml (fb-attachments.js)
// — the exact same row Inbox's source-document modal renders (per magnus:
// "open popup ... exactly like on inbox"), not a page-local reimplementation.
function renderAttachModalBody() {
  const rows = S.stagedFiles.map(stagedRowHtml).join('')
    + S.existingAttachments.map(a => FB.attachments.rowHtml(a)).join('');
  return (rows || FB.attachments.emptyHtml('No attachments yet'))
    // + Add attachment row (2026-09-06, retires A) — fb-list add-row parity.
    + '<div class="fb-attach-row be-attach-add"><button type="button" class="be-attach-add-btn" onclick="document.getElementById(\\'be-file\\').click()">+ Add attachment</button></div>';
}
function wireAttachModalButtons() {
  const el = document.getElementById('be-attach-modal-body');
  if (!el) return;
  el.querySelectorAll('button.fb-att-del[data-staged-i]').forEach(b => b.onclick = () => { S.stagedFiles.splice(Number(b.dataset.stagedI), 1); refreshAttachModal(); });
  el.querySelectorAll('button.fb-att-del[data-att-id]').forEach(b => b.onclick = () => deleteExistingAttachment(b.dataset.attId));
}
function refreshAttachModal() {
  const el = document.getElementById('be-attach-modal-body');
  if (el) { el.innerHTML = renderAttachModalBody(); wireAttachModalButtons(); }
  updateAttachIcon();
}
function openAttachmentsModal() {
  FB.modal.open({
    title: 'Attachments',
    body: '<div id="be-attach-modal-body">' + renderAttachModalBody() + '</div>',
    buttons: [{ label: 'Close', onClick: function (api) { api.close(); } }]
  });
  wireAttachModalButtons();
}

// FB.modal is single, app-wide (see fb-core.js) — opening the confirm dialog
// below closes the attachments modal that triggered it, same as any other
// modal-from-modal call in this codebase (there's no nesting). Just refresh
// the header icon's count; the attachments modal itself is gone by the time
// this resolves.
function deleteExistingAttachment(attachmentId) {
  FB.modal.open({
    title: 'Remove attachment?',
    buttons: [
      { label: 'Cancel', onClick: function (api) { api.close(); } },
      { label: 'Remove', danger: true, onClick: function (api) {
          api.close();
          apiAction('attachment.delete', { attachmentId })
            .then(async () => { await loadExistingAttachments(); updateAttachIcon(); })
            .catch(e => msg(e.message, 'err'));
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
    // Attachments (2026-09-11): a single button cell — the 📎 icon itself —
    // that opens the attachments modal (openAttachmentsModal, wired via
    // wireAttachIcon). Managing what's inside (add/delete) is mouse-only in
    // the modal now, same as Inbox's own source-document viewer this
    // borrows from; there's no longer a list of keyboard-navigable rows here.
    { id: 'attachments', rows: function () { var b = document.getElementById('be-attach-icon-btn'); return b ? [b] : []; },
      cells: function (rowEl) { return [rowEl]; } },
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
      // rather than removing-then-immediately-regenerating one. Lines-only
      // now (2026-09-11) — the attachments zone is a single button cell
      // (open the modal), nothing there for x to delete any more.
      when: function (api) {
        if (api.cur().z !== 2) return false;
        var row = api.zoneRows(2)[api.cur().r];
        return api.cur().r > 0 && row && !row.classList.contains('bl-auto');
      },
      run: function (api) {
        if (S.locked) return;   // 2026-09-06: lines are frozen once posted
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
      // x on the header zone voids a posted bill (Stage 3, 2026-09-06) —
      // same "x means something bigger on the header" pattern as
      // journal-voucher's reversal entry. Never collides with the generic
      // delete verb's x, which only ever matches z===2 (lines), never z===0
      // (header) or z===1 (attachments — a single button cell, not deletable).
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
