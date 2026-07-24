# Bills → FB.list with `tree: true` — implementation plan

**Branch:** `feat/bills-fb-list` (checked out, based on current `origin/main`)
**Ratified:** 2026-07-24 (contract in this plan's preamble — do not redesign)
**Status:** PLAN ONLY — no implementation in this commit.

## Goal

Migrate the Payables → **Bills** tab (the last bespoke list in the app) onto
`FB.list` (`api/public/fb-list.js`) by adding a `tree: true` mode to the shared
list machine. Bills is a tree-table: one parent row per bill, expandable to
child rows (line items / payments). Today every other register is a flat list
on `FB.list`; Bills is the holdout (~2,760 lines of bespoke render/draft/filter/
nav/fold machinery in `api/src/pages/payables-bills.js`).

After this work `FB.list` owns: the add row, j/k over the flattened visible
sequence (parents + open children + add row), fold/unfold, the whole-bill edit
unit (dirty tracking + `w` save at BILL granularity), column filters, and the
leave-guard. The Bills screen becomes a declarative `FB.list.create(cfg)`
call — no bespoke interaction code of its own.

## Architecture / stack

- **Backend:** Node.js + Express + DuckDB. Server actions live in
  `api/src/bills.js`. Bill save is bill-level (ONE `bill.draft.save` /
  `bill.create` write per bill — header + all lines). No server changes are
  required by this plan; the action shapes are reused verbatim (see
  "Server action shapes" below). Contract tests (`api/test/contract.test.js`,
  28 tests) cover actions, not pixels, and stay green.
- **Client:** vanilla ES5, no build step. `api/public/fb-list.js` (~995 lines)
  is the shared list machine. `api/src/pages/payables-vendors.js` (~172 lines)
  is the reference FB.list config pattern (attach dropdowns, extraBindings,
  focusClass/onFocus). `api/src/pages/payables-bills.js` (~2,761 lines) is the
  bespoke Bills screen to be migrated. `api/public/common.js` carries the
  `fbBillNav` capture-phase special-case (to remove). `api/src/pages/payables.js`
  renders the page shell (KPI summary header, tab bar, table skeleton).
- **No new dependencies.** No build step. Edit in place; the browser loads the
  JS straight from `api/public/`.

## Doctrine (from the ratified contract — the spec, restated)

1. **Esc never saves.** `w` writes the WHOLE bill (header + all lines, ONE
   server write — bill-level INSERT). `u` reverts. Dirty bill = amber. This is
   already Bills' interim behavior (fb-list spec §10); migration makes it
   framework-native.
2. **Create:** the bottom `+ Add entry` row is the ONLY create path. `o`/`O`
   retire on Bills (fb-list spec §2). Activating it = today's
   `createDraftBill` behavior: parent + first child inputs, fold open, focus
   vendor, INSERT mode. `a` = add child line to the focused draft bill (stays).
   Tab past the last field of the last child spawning a new line stays.
3. **Keys (owner's final word 2026-07-24):**
   - **Enter = EDIT, always** — parent rows, child rows (whole-bill INSERT on
     drafts; no-op on posted bills, which are read-only); on the add row Enter
     = create.
   - **Space = FOLD** with vim fold semantics: toggles the fold of the bill
     under the cursor — on a parent it folds that bill, on a child it folds
     the parent; inert on the add row. Mouse parity: ▸/▾ click stays.
   - `i` = whole-bill INSERT on any row of a draft; posted bills: `i`/Enter
     no-op, `x` = void (confirm), `p` = post.
   - `x` on draft = delete. j/k cross bill boundaries per the payables spec's
     boundary rules; sticky ends; the add row is the bottom nav position.
4. **Filters (fb-list spec §8):** column filters evaluate on PARENT rows;
   children follow their parent's visibility; fold state untouched. A
   dirty/editing bill bypasses filters as a unit. The ≡ header UX carries over
   1:1, framework-rendered; Bills' ~450 lines of bespoke filter code are
   DELETED, not ported.
5. **Scope:** the full-page bill editor (`bill-edit.js`) and bill-detail page
   stay. Deleted: bespoke filters, bespoke draft/INSERT machinery, the
   `fbBillNav` capture-phase handler + its `common.js` special-casing. The CCY
   single-currency auto-hide (`.single-ccy`) stays as a page-level display
   hook. Summary header (TOTAL OUTSTANDING etc.) stays as page chrome.
6. **Framework (fb-list.js):** `tree: true` config — children accessor, per-bill
   fold state keyed by row `_key`, child-row renderer hook (children render a
   different cell layout), whole-bill edit unit (dirty tracking + save at BILL
   granularity), j/k over the flattened visible sequence, fold verb, `a` verb
   binding, editable/deletable predicates per bill status.
7. **Specs in the SAME commit(s) as code:** rewrite stale sections of
   `docs/payables-ux-spec.md` (NORMAL/INSERT key tables, Esc doctrine, create
   path); extend `docs/fb-list-ux-spec.md` (`tree:true` config in §6, §4 verb
   table gains Enter/Space tree semantics, §1/§11 mark Bills migrated, delete
   §10 interim note). Follow existing dating/revision style.
8. **Testing (fb-list spec §12):** API contract tests (`npm test` in `api/`,
   currently 28) stay green; adjust only if bill save actions change shape
   (they do not). Client behavior verified LIVE in browser — the plan's final
   task is a live verification checklist (create → edit → fold → filter → post
   on Bills).

## Server action shapes (reused unchanged — for the cfg authors)

| Action | Body | Response | Used for |
|---|---|---|---|
| `bill.list` | `{ companyId }` | `[{ bill_id, vendor, date, due_date, vendor_ref, amount, amount_paid, currency, status, expense_account, ap_account, … }]` | `cfg.list` |
| `bill.lines` | `{ billId }` | `[{ entry_id, account_code, account_name, description, amount, vat_code, vat_amount_override, currency, fx_rate }]` (drafts read `draft_lines` JSON; posted read journal entries) | children accessor (lazy) |
| `bill.payments` | `{ billId }` | `[{ payment_id, date, method, reference, amount, voided_at }]` | children accessor (posted/partial only, appended after journal lines) |
| `bill.draft.save` | `{ bill: { bill_id, vendor, vendor_ref, date, due_date, amount, currency, ap_account, expense_account, lines: [{ description, expense_account, amount, vat_code, vat_amount_override, currency }] } }` | `{ billId, status: 'draft' }` | `cfg.save` (drafts) |
| `bill.draft.delete` | `{ billId }` | `{ deleted: true }` | `cfg.del` (drafts) |
| `bill.draft.post` | `{ billId, bill: { ap_account } }` | posted | `p` verb (saved draft) |
| `bill.create` | `{ bill: {…same shape as draft.save…} }` | `{ created, billId, status: 'posted', warnings }` | `p` verb (inline unsaved draft: create+post in one call) |
| `bill.void` | `{ billId }` | `{ voided: true }` | `x` verb (posted/partial) |
| `bill.payment.record` | `{ billId, date, bankAccount, amount, reference, fxRate }` | `{ status }` | inline pay row (P1-9, stays) |
| `bill.payment.void` | `{ paymentId }` | reversal | `x` on a payment-history child (stays) |

Sources: `api/src/bills.js` — `listBills` (L606), `getBillLines` (L647),
`saveDraftBill` (L750), `deleteDraftBill` (L814), `postDraftBill` (L840),
`createBill` (L96), `voidBill` (L403), `recordBillPayment` (L445).

---

## Recon: payables-bills.js structure map (line ranges, current file)

A migration map so implementers edit the right ranges (these are CURRENT line
numbers on `feat/bills-fb-list`; they will shift as the file is rewritten).

| Lines | Block | Disposition |
|---|---|---|
| 1–37 | state vars: `allBills`, `draftLines`, `treeState` (open Set + isOpen/toggle/setOpen/setClose) | **DELETE** — `treeState` becomes framework fold state keyed by `_key`; `draftLines` becomes the framework dirty buffer's child array |
| 39–103 | `cursor` object + `cursor.mode` FB.mode wiring + `_applyCcyColVisibility` on mode change | **DELETE** cursor (framework `nav` owns it); **KEEP** the `FB.mode.onChange` → `.single-ccy` / `insert-mode` class hook (page-level display) |
| 105–141 | account autocomplete sources (`_acctSource`, `_attachAcctDropdown`) | **KEEP** — reused as column `attach` hooks |
| 143–256 | P1-9 inline payment row (`openPayRow`/`closePayRow`/`submitPayRow`, `_cashSource`, `_attachCashDropdown`) | **KEEP** — posted-bill action triggered by `p` on posted/partial (stays an extraBinding) |
| 258–297 | VAT dropdown source + `_attachVatDropdown` + `_validateDraftVatCodes` | **KEEP** — child-row renderer + save-time guard |
| 299–790 | `kbd` object: bespoke binding table + all handlers (`_move`, `_gg`, `_insertEscape`, `_writeFocusedDraft`, `_insertEnter`, `_isRowEditable`, `_normalEnter` [fold+save], `_normalEdit`, `_normalAddLine`, `_normalPost`, `_getParentRow`, `_toggleFold`, `_openFold`, `_closeFold`, `_deleteCurrent`) | **DELETE** — replaced by FB.list bindings + tree hooks |
| 792–796 | `billEditMsg` | **KEEP** (thin `FB.status.show` wrapper) — or inline to `FB.status.show` at call sites |
| 798–847 | `fbPageInitPayables` | **KEEP, TRIM** — drop `kbd.register()`, `registerBillKeyActions()`, `window.fbBillNav = true`; add `billsList.load()` |
| 849–916 | `initBillsTable` (tbody click/dblclick, sort button wiring, filter button wiring) | **DELETE** bespoke filter/sort wiring; framework owns click→edit/fold. dblclick→editor stays as a render hook (or a parent `display` link) |
| 918–1058 | `toggleBillLines` (fetch `bill.lines` + `bill.payments`, render posted child rows / draft child rows / GST rows / payment-history rows) | **REFACTOR** into the framework children accessor + `childRowHtml` hook (lazy fetch on first unfold) |
| 1060–1217 | `openColFilter` (bespoke column filter dropdown, ~157 lines) | **DELETE** — framework ≡ owns it |
| 1219–1300 | `_wireChildRowTab`, `refreshAddRowIcons` (+ icon mgmt) | **REFACTOR** — Tab-spawn-new-line becomes a child-renderer hook; + icon → `a` verb |
| 1302–1354 | `addRowFromIcon`, `refreshSaveIcon` | **DELETE** — framework `a` verb + `w` chip |
| 1356–1406 | `renderDraftChildRows` | **REFACTOR** into `childRowHtml` (edit mode) |
| 1408–1472 | `_initChildGst`, `_recomputeChildGst` | **KEEP** — GST recompute, called from child renderer / line sync |
| 1474–1524 | `_isDraftEmpty`, `_discardDraftBill` | **DELETE** — framework `isBlank` + dirty-new discard |
| 1526–1578 | `createDraftBill` | **REFACTOR** into `cfg.blank()` + add-row activate (parent + first child, fold open, focus vendor) |
| 1580–1634 | `createDraftLine` | **REFACTOR** into `a` verb (`addChild`) |
| 1636–1658 | `_saveAndExitInsert` | **DELETE** — Esc never saves |
| 1660–1692 | `_getFxRate`, `_updateCcyTooltip` | **KEEP** — FX tooltip on CCY cell |
| 1694–1830 | `_wireDraftParentEvents` (vendor/CCY/AP dropdowns, Tab cross to children) | **REFACTOR** into column `attach` hooks + child-renderer Tab wiring |
| 1832–1935 | `insertDraftParentRow`, `insertDraftChildRow` | **DELETE** — framework create + `a` |
| 1937–2008 | `convertDisplayToDraft` | **DELETE** — framework re-enters edit on a saved draft via `editable` predicate + re-render of inputs |
| 2010–2095 | `convertDraftRowToDisplay` | **DELETE** — framework renders saved rows from `cfg.list.map` |
| 2097–2113 | `saveDraftFromIcon` | **DELETE** — `w` chip |
| 2115–2252 | `saveDraftToDb` | **REFACTOR** into `cfg.save.body(d)` (bill-level payload) |
| 2254–2295 | `_gatherInlineBillData` | **FOLD** into `cfg.save.body` / `bill.create` body |
| 2297–2398 | `_postDirect`, `_sendPost` | **REFACTOR** into the `p` extraBinding (saved-draft: save+post chain; inline: `bill.create`) |
| 2400–2422 | `registerBillKeyActions` (`fbKeyActions.new`/`delete`) | **DELETE** — framework owns create/delete |
| 2424–2476 | `loadPeriods`, `loadAllBills`, `loadFxRatesForKpi`, `convertToBase` | **KEEP** `loadPeriods`, `loadFxRatesForKpi`, `convertToBase`; `loadAllBills` → `billsList.load()` (kept as a thin alias for KPI recompute on `onLoaded`) |
| 2478–2509 | `computeKpis`, `fmtAmt`, `setText` | **KEEP** — summary header chrome |
| 2511–2561 | `applyFilters` (bespoke filter + sort) | **DELETE** — framework `merged()` + column filters |
| 2563–2587 | `_singleCcy`, `_applyCcyColVisibility`, `_refreshCcyVisibility` | **KEEP** — page-level `.single-ccy` display hook (called from `onLoaded` / render) |
| 2589–2644 | `renderPage` | **DELETE** — framework render |
| 2646–2663 | `renderPagination`, `goPage` | **DELETE** — no pagination |
| 2665–2712 | `vendorCell`, `hashStr`, `fmtDate`, `fmtDateShort`, `statusBadge` | **KEEP** — `display` functions reused by column display + child renderer |
| 2714–2718 | `showMsg` | **DELETE** — `FB.status` |
| 2722–2757 | `showPayTab`, `renderPayHints` | **KEEP, TRIM** — drop `window.fbBillNav` toggle; keep tab shell + `renderPayHints` (FB.keys.renderHints) |

**Net estimate:** ~2,000 lines deleted from `payables-bills.js`; ~250 lines of
declarative `FB.list.create(cfg)` + retained helpers (KPI, FX tooltip, GST
recompute, dropdown sources, inline pay row) take their place. `fb-list.js`
grows by ~250–350 lines (tree machinery). Net repo: **−1,400 to −1,700 lines**.

---

## Task 1 — FB.list: add `tree: true` config flag and fold state

**Objective:** Introduce the `tree` opt-in and per-bill fold state in
`fb-list.js`, without changing any flat-list screen. No rendering or nav
changes yet — just the data model + config surface.

**Files:**
- `api/public/fb-list.js` — config block (L17–69), `create()` (L80), state vars (L99–107).

**Code shape:**
```js
// In create(cfg), after the columns filterType defaulting (L93–97):
cfg.tree = !!cfg.tree;
if (cfg.tree) {
  if (!cfg.children) cfg.children = function (row) { return []; };       // accessor → child rows (lazy fetch inside)
  if (!cfg.foldKey) cfg.foldKey = function (row) { return row._key; };   // fold-state key (default _key)
  if (!cfg.isFolded) cfg.isFolded = function (row) { return folded[cfg.foldKey(row)]; };
  if (!cfg.fold) cfg.fold = function (row, open) { folded[cfg.foldKey(row)] = !!open; };
}

// New state var (near L99–107):
var folded = {}; // foldKey → bool (open=true)
```

New config options (documented in §6 in Task 8):
- `tree` — boolean, enables tree mode.
- `children(row)` — returns child rows for a parent (may fetch; framework
  caches per-`_key`). For Bills: lazy `bill.lines` + `bill.payments`.
- `foldKey(row)` / `isFolded(row)` / `fold(row, open)` — fold state hooks
  (default `_key`-keyed `folded` map). Override only if fold state must live
  elsewhere.
- `childRowHtml(row, child, idx)` — view-mode HTML for a child `<tr>`
  (different cell layout from parents). **Added in Task 2.**
- `addChild(row)` — the `a` verb: append a child to the focused draft bill.
  **Added in Task 4.**

**Commands:**
```bash
node -e "require('./api/public/fb-list.js'); console.log('ok')" 2>&1 | head
```
Expected: `ok` (the IIFE just attaches `FB.list`; no syntax error).

**Verification:** `npm test` (in `api/`) — 28 tests, all green (no behavior
change yet). Load the Vendors tab in the browser — unchanged.

**Commit:** `FB.list: tree:true config flag + per-bill fold state (no behavior yet)`

---

## Task 2 — FB.list: flatten parents+children into the merged/nav sequence

**Objective:** In `tree: true` mode, `merged()` returns a flat sequence of
parent rows, each followed by its open children. Children are skipped when the
parent is folded. `rows()`/`navRows()` and `render()` iterate this flat
sequence. Folded state is read via `cfg.isFolded`.

**Files:**
- `api/public/fb-list.js` — `merged()` (L124–155), `rows()`/`navRows()` (L110–111), `rowHtml()` (L495–507), `render()` (L520–545).

**Code shape:**
```js
function merged() {
  var out = []; // flat: parent, then its open children, then next parent…
  var base = saved.map(/* … unchanged dirty-overlay … */);
  Object.keys(dirty).forEach(/* … unchanged dirty-new append … */);
  // tree flatten (only when cfg.tree):
  if (cfg.tree) {
    base.forEach(function (r) {
      out.push(r);
      if (!cfg.isFolded(r)) {
        var kids = childCache[r._key] || cfg.children(r) || [];
        kids.forEach(function (k) { out.push(Object.assign({}, k, { _childOf: r._key, _dirty: r._dirty })); });
      }
    });
  } else {
    out = base;
  }
  // filters: parents evaluated; children follow parent visibility; dirty bill bypasses as a unit
  // … (see Task 5 for the filter rewrite) …
  return out;
}
```

- `rowHtml(d, i)`: if `d._childOf` → delegate to `cfg.childRowHtml(parent, d, i)`
  (different cell layout: description / expense-account / amount / VAT-code /
  GST-amount in specific columns, spacer cell with `+` icon). Else the existing
  parent `rowHtml`.
- Parent `rowHtml` gains a fold indicator cell (▸ folded / ▾ open) when
  `cfg.tree` — clickable for mouse parity.
- `render()`: unchanged structure — it already maps `merged()`; child rows now
  appear in the map. Click wiring: a click on a parent's fold indicator toggles
  fold; a click elsewhere on a parent/child enters edit (drafts) per the verb
  table. The existing add-row click → `newRow()` stays.
- New state: `var childCache = {};` — per-`_key` cache of fetched children;
  `cfg.children` may populate it (Bills fetches `bill.lines` once and caches).

**Commands:** `node -e "require('./api/public/fb-list.js'); console.log('ok')"`

**Verification:** `npm test` green. Vendors tab unchanged (tree=false).

**Commit:** `FB.list: tree flatten — merged() emits open children; childRowHtml hook`

---

## Task 3 — FB.list: whole-bill edit unit (bill-level INSERT + dirty tracking)

**Objective:** In `tree: true` mode, `enterEdit`/`exitEdit` operate on the
WHOLE bill: entering edit on a draft bill (from parent or child) re-renders
the parent + all its open children as inputs (the draft child-row renderer),
focuses the first parent field. `exitEdit` (Esc) harvests EVERY input across
parent + children into ONE dirty bill buffer (keyed by the parent `_key`), never
saves. `w` writes the whole bill in one server call. `u` reverts the whole
bill. Dirty = amber on the parent (and its children, since they carry
`_childOf`).

**Files:**
- `api/public/fb-list.js` — `enterEdit()` (L579–611), `exitEdit()` (L615–650), `writeAt()` (L653–667), `revertAt()` (L669–676), `deleteFocused()` (L678–693), `newRow()` (L695–706), `editFocused()` (L735–742).

**Code shape:**
```js
function enterEdit(idx, field) {
  // … existing guard …
  var d = merged()[idx];
  var parent = d._childOf ? rowByKey(d._childOf) : d;     // tree: edit the BILL, not the row
  // Re-render parent + open children as inputs (cfg.editRowHtml / cfg.editChildRowHtml
  //   — or reuse cfg.childRowHtml in edit mode for drafts). Focus first parent field.
  // editIdx tracks the PARENT index; editKey = parent._key.
}

function exitEdit() {
  // Harvest ALL inputs across parent + open children into ONE bill buffer:
  //   dirty[parent._key] = { isNew, header…, lines: [...], _isBill: true }
  // Esc never saves. An untouched new bill (cfg.isBlank(buf)) vanishes → add row.
}

function writeAt(idx) {
  // tree: find the parent for idx; if its buffer is a bill, run cfg.validate(bill),
  //   post(cfg.save.action, cfg.save.body(bill)) — ONE write. On success drop the
  //   buffer and reload (fold closes; saved draft re-renders as display).
}
```

- `editable(d)` / `deletable(d)` already exist (L47 config); Bills sets them per
  status: `editable = status === 'draft'`, `deletable = status === 'draft'`.
  Posted/partial: `x` = void (an action, not `cfg.del` — see Task 4), `p` = post/pay.
- `newRow()` in tree mode = `cfg.blank()` returning a bill with one empty line,
  fold open, enter edit on the parent. (Maps to today's `createDraftBill`.)
- `editFocused()`: on the add row → `newRow()` (create); on a parent/child of a
  draft → `enterEdit` the bill; on a posted bill → no-op (editable false).

**Commands:** `node -e "require('./api/public/fb-list.js'); console.log('ok')"`

**Verification:** `npm test` green. Manual: on a scratch tree-list test harness
(or the Bills screen once wired in Task 6) — `i` on a draft opens the whole
bill; Esc exits, buffer stays dirty (amber); `w` saves the whole bill.

**Commit:** `FB.list: tree whole-bill edit unit — bill-level INSERT, dirty, w/u`

---

## Task 4 — FB.list: tree verbs (Enter=edit, Space=fold, `a`=add child, `x`/`p` per status)

**Objective:** Wire the tree-mode key bindings per the ratified verb table.

**Files:**
- `api/public/fb-list.js` — `bindings` array (L771–830), `registerKeys()` (L831–841).

**Binding shape (tree mode, appended/conditional on `cfg.tree`):**
```js
if (cfg.tree) {
  // Enter = EDIT always (replaces the flat-list Enter=edit which already exists;
  //   tree adds: on a child → edit the parent bill; on posted → no-op).
  // Space = FOLD (new): toggles the fold of the bill under the cursor.
  bindings.push({ key: ' ', mode: 'NORMAL', hint: 'fold', hintBar: true,
    when: function () { var d = focusedRow(); return !!(d && (d._childOf || d._isBill !== false)); },
    run: function () { var d = focusedRow(); if (d) toggleFold(d._childOf ? rowByKey(d._childOf) : d); } });
  // a = add child line to the focused draft bill (cfg.addChild).
  bindings.push({ key: 'a', mode: 'NORMAL', hint: 'add line', hintBar: true,
    when: function () { var d = focusedRow(); return !!(d && cfg.editable(d._childOf ? rowByKey(d._childOf) : d)); },
    run: function () { var d = focusedRow(); var p = d._childOf ? rowByKey(d._childOf) : d; if (p) cfg.addChild(p); } });
}
// x / p are screen actions (void/post) — declared by Bills via cfg.actions or
//   extraBindings, NOT hard-coded in the framework (see Task 6). The framework's
//   built-in x (delete) is used only for draft delete (cfg.del).
```

- `Enter` already = `editFocused` (L775); in tree mode `editFocused` resolves
  child→parent (Task 3). No new binding — just confirm the resolution.
- `Space` is NEW (flat lists have no Space). Guarded by `cfg.tree`.
- `a` is NEW in tree mode (flat lists leave `a` unbound per §5). Guarded by `cfg.tree`.
- Fold toggle helper `toggleFold(row)`: `cfg.fold(row, !cfg.isFolded(row))`;
  `render()` re-runs; if unfolding and children not cached, `cfg.children(row)`
  fetches+caches them (Bills: lazy `bill.lines`).
- `o`/`O`: the framework does NOT register them (fb-list spec §2). Bills must
  not register them either (Task 6 removes the bespoke `o`/`O`/`I` bindings).

**Commands:** `node -e "require('./api/public/fb-list.js'); console.log('ok')"`

**Verification:** `npm test` green. Manual on a tree harness: Space folds/unfolds;
`a` adds a child to a draft; Enter on a posted bill is a no-op.

**Commit:** `FB.list: tree verbs — Space fold, a add-child (Enter=edit already wired)`

---

## Task 5 — FB.list: tree-aware column filters (parents evaluated; children follow)

**Objective:** In `tree: true` mode, column filters (≡ dropdowns + topbar
`/expression`) evaluate on PARENT rows only. A child's visibility = its
parent's visibility (children never survive a parent that the filter drops).
Fold state is untouched by filtering. A dirty/editing bill bypasses filters as
a unit (parent + its children).

**Files:**
- `api/public/fb-list.js` — `merged()` filter section (L134–154), `applyColFilters()` (L217–223), `colMatches()` (L183–216), the `keepRow` bypass (L137).

**Code shape:**
```js
// In merged(), after the tree flatten (Task 2):
function keepRow(r) {
  if (r._dirty) return true;                       // dirty bill (parent OR its children) bypasses
  if (editKey !== null && (r._key === editKey || r._childOf === editKey)) return true;
  return false;
}
if (filterQ || hasColFilters()) {
  out = out.filter(function (r) {
    if (keepRow(r)) return true;
    if (r._childOf) return out.indexOf(rowByKey(r._childOf)) >= 0; // child follows parent
    // parent: evaluate filterQ + colFilters on the parent row only
    if (filterQ && !textMatch(r, filterQ)) return false;
    if (hasColFilters() && !applyColFilters(r)) return false;
    return true;
  });
}
```
- `colMatches` and the box-expr grammar are unchanged — they already operate on
  a row's column fields; in tree mode they're only called on parents.
- The `childCache` must be rebuilt/cleared when a parent is filtered OUT (its
  children are not rendered, so no stale child rows leak). Simplest: after
  filtering, drop child entries whose parent is not in `out`.

**Commands:** `node -e "require('./api/public/fb-list.js'); console.log('ok')"`

**Verification:** `npm test` green. Manual: a column filter on a tree harness
hides parents but leaves fold state intact; a dirty bill stays visible through
a filter.

**Commit:** `FB.list: tree column filters evaluate on parents; children follow; dirty bypasses`

---

## Task 5b — FB.list: optional per-column `sortable` (framework-owned sort)

**Objective:** Preserve Bills' spec'd header-sort behavior as a framework
feature (added 2026-07-24 after plan review — dropping it would regress
payables-ux-spec behavior; bespoke sort is deleted in Task 7).

**Files:** `api/public/fb-list.js` — `wireHeaders`/`syncHeaderState` area +
render entry; `api/public/common.css` if the `.th-sort` rules don't already
exist there (check — Bills' rules may live in page CSS to be lifted).

**Behavior:**
- Column config gains optional `sortable: true` (default off — only Bills
  declares it today).
- A sortable column header gets a click handler (mouse parity with the
  deleted bespoke sort) cycling **asc → desc → none**; `none` restores
  server order (`saved` array order — re-render from `saved`, do not
  re-fetch).
- The ▲/▼ arrow renders AFTER the label and collapses when inactive:
  `.th-sort:empty{display:none}` (payables spec). Only one column sorted at
  a time (single-key sort, matching the deleted bespoke behavior).
- Sort is a VIEW concern: it composes with filters (sort the filtered set),
  never reorders `saved`, and a dirty/editing bill stays in place (sorting
  is suspended while any bill is dirty — same doctrine as the filter
  bypass).
- Keyboard: no dedicated verb (sort was mouse-only on Bills; parity
  preserved). `G`/`gg`/j/k operate on the sorted+filtered sequence.

**Verification:** `npm test` green. Manual: click a sortable header cycles
asc/desc/none; arrow collapses at `none`; order returns to server order.

**Commit:** `FB.list: optional per-column sortable headers (asc/desc/none cycle)`

---

## Task 6 — Bills screen: declare the `FB.list.create(cfg)` (tree: true)

**Objective:** Replace the bespoke Bills render/draft/nav/fold/filter machinery
with one declarative `FB.list.create` call carrying `tree: true`. This is the
biggest task; it is split into 6a–6f below, each a focused commit. The
retained helpers (KPI, FX tooltip, GST recompute, dropdown sources, inline pay
row, `.single-ccy` hook) stay in `payables-bills.js`.

**Reference pattern:** `api/src/pages/payables-vendors.js` (L81–157) — the
declarative cfg: `keysId`, `active`, `tbody`, `companyId`, `columns[]` with
`attach`, `blank`, `isBlank`, `same`, `validate`, `editable`, `firstField`,
`list`, `save`, `del`, `extraBindings`, `focusClass`, `onFocus`, `onLoaded`.

### Task 6a — Bills cfg skeleton + `list` + `columns` + `display` hooks

**Files:** `api/src/pages/payables-bills.js` — replace the bulk of L1–37 +
L2589–2712 (renderPage/vendorCell/statusBadge stay as helpers) with a
`var billsList = FB.list.create({ … })` block near the top of the IIFE body.

**Cfg shape:**
```js
var billsList = FB.list.create({
  keysId: 'bills',
  active: function () { var p = document.getElementById('pay-panel-bills'); return !!p && p.style.display !== 'none'; },
  tbody: 'bills-tbody',
  companyId: function () { return COMPANY; },
  focusClass: 'bill-row-focus',
  onFocus: function (tr) { /* compat: drop window.fbBillNav; nothing needed */ },
  tree: true,
  columns: [
    { field: 'vendor',      type: 'text',  attach: billAttachVendor, display: function (v, r) { return vendorCell(r.vendor || v); }, label: 'Vendor' },
    { field: 'date',        type: 'date',  display: function (v) { return '<span title="'+esc(String(v||'').slice(0,10))+'">'+fmtDateShort(v)+'</span>'; }, filterType: 'date' },
    { field: 'due_date',    type: 'date',  display: /* overdue span */, filterType: 'date' },
    { field: 'vendor_ref',  type: 'text',  display: /* ref-link a[href=/company/bill/<id>] */, filterType: 'text' },
    { field: 'amount',      type: 'number', ro: 'always', display: function (v) { return '<span class="amt">'+Number(v||0).toFixed(2)+'</span>'; }, filterType: 'amount' },
    { field: 'currency',    type: 'text',  ro: 'always', display: function (v) { return '<span class="ccy-cell">'+esc(v||BASE_CURRENCY)+'</span>'; }, filterType: 'list' },
    { field: 'status',      type: 'text',  ro: 'always', display: function (v, r) { return statusBadge(v, r.due_date) + (v==='posted'||v==='partial' ? payAffordHtml(r) : ''); }, filterType: 'list' }
  ],
  label: '+ Add bill',
  list: { action: 'bill.list', map: function (b) {
    return { _key: b.bill_id, bill_id: b.bill_id, vendor: b.vendor||'', date: b.date||'', due_date: b.due_date||'',
      vendor_ref: b.vendor_ref||'', amount: b.amount||0, amount_paid: b.amount_paid||0,
      currency: b.currency||BASE_CURRENCY, status: b.status||'', ap_account: b.ap_account||'',
      expense_account: b.expense_account||'', _isBill: true };
  } },
  onLoaded: function (saved) { _refreshCcyVisibility(); loadFxRatesForKpi(function (rm) { computeKpis(saved, rm); }); },
  // children / childRowHtml / addChild / editable / deletable / save / del / extraBindings — Tasks 6b–6f
});
```

- `billAttachVendor(input, tr)` — the vendor dropdown (today's
  `_wireDraftParentEvents` vendor branch, L1703–1763), refactored to a column
  `attach`. On pick: set `data-vendor-id/name/ap-account/expense-account`,
  set the CCY field from vendor default, mark dirty.
- `payAffordHtml(r)` — the hover `Pay` button (today L2614) → opens the inline
  pay row (P1-9, retained). Click handled in `render` via a data-act or an
  `extraBindings`-registered delegated listener.
- Retained helpers copied/referenced: `vendorCell`, `hashStr`, `fmtDate`,
  `fmtDateShort`, `statusBadge`, `_getFxRate`, `_updateCcyTooltip`.

**Verification:** `npm test` green. Browser: Bills tab renders saved bills via
the framework; j/k moves; no draft create yet (6c). Fold/filter no-ops until 6b.

**Commit:** `Bills: FB.list cfg skeleton — list/columns/display (tree stubs)`

### Task 6b — Bills children accessor + `childRowHtml` (lazy fold)

**Objective:** Wire the fold. `cfg.children(row)` lazily fetches
`bill.lines` (+ `bill.payments` for posted/partial) and caches per `_key`.
`cfg.childRowHtml(parent, child, idx)` renders the view-mode child row
(description / expense-account / amount / VAT-code / GST-amount in the spec'd
columns, spacer cell with `+` icon on the last child). This is today's
`toggleBillLines` (L918–1058) refactored into the framework hook.

**Files:** `api/src/pages/payables-bills.js` — new `cfg.children` +
`cfg.childRowHtml`; reuse `esc`, `taxCodeMap`, `fmtDateShort`.

**Code shape:**
```js
var billChildCache = {}; // _key → { lines: [...], payments: [...], fetched: bool }
function billsChildren(row) {
  var k = row._key;
  if (billChildCache[k] && billChildCache[k].fetched) return mergeChildRows(billChildCache[k], row);
  // fetch bill.lines (+ bill.payments when posted/partial); cache; return [] on first call (render fires again on resolve)
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'bill.lines', companyId: COMPANY, billId: row.bill_id }) })
    .then(function (r){ return r.json(); })
    .then(function (res){ var lines = res.data||res||[]; billChildCache[k] = { lines: lines, payments: [], fetched: true };
      if (row.status === 'posted' || row.status === 'partial') {
        fetch('/api/action', { /* bill.payments */ }).then(function (pr){ billChildCache[k].payments = (pr.data||pr)||[]; billsList.render(); });
      } else { billsList.render(); } });
  return billChildCache[k] ? mergeChildRows(billChildCache[k], row) : [];
}
cfg.children = billsChildren;
cfg.childRowHtml = function (parent, child, idx) {
  // posted: expense line (desc / expense-acct / amount / spacer / VAT code) + GST sub-rows + payment-history rows
  // draft (saved, status='draft'): desc / amount / VAT code (read-only display, re-enters edit via i)
  // See toggleBillLines L951–1019 for the exact posted split and L1021–1052 for payment history.
};
```
- The `+` add-row icon on the last child renders only in EDIT mode (draft
  children) — handled in the edit-mode child renderer (6d).
- Fold indicator (▸/▾) on the parent row: the framework's parent `rowHtml`
  emits it in tree mode (Task 2); clicking it calls `toggleFold`. The existing
  `.data-table` CSS for `.child-row` (payables.js L161–189) stays.

**Verification:** Browser: Space/click folds a posted bill → lazy-fetches lines
→ renders children; Space again collapses. Fold state survives a filter.

**Commit:** `Bills: children accessor + childRowHtml (lazy bill.lines/payments fold)`

### Task 6c — Bills `blank` + add-row create (parent + first child, INSERT)

**Objective:** Activating the `+ Add bill` row = today's `createDraftBill`
(L1526–1578): a new draft bill buffer with one empty line, fold open, focus
vendor, INSERT mode. This is `cfg.blank()` + the framework's `newRow()` (which
Task 3 made tree-aware).

**Files:** `api/src/pages/payables-bills.js` — `cfg.blank`, `cfg.isBlank`,
`cfg.firstField`.

**Code shape:**
```js
cfg.blank = function () {
  return { _isBill: true, isNew: true, vendor: '', date: '', due_date: '', vendor_ref: '',
    amount: 0, currency: BASE_CURRENCY, ap_account: companyDefaultAp, expense_account: companyDefaultExpense,
    status: 'draft', lines: [ { description: '', expense_account: companyDefaultExpense, amount: 0, vat_code: '', vat_amount_override: null, currency: BASE_CURRENCY } ] };
};
cfg.isBlank = function (b) {
  if (!b.vendor && !b.date && !b.vendor_ref) {
    return !(b.lines || []).some(function (l) { return l.description || (parseFloat(l.amount) > 0); });
  }
  return false;
};
cfg.firstField = function (isNew) { return 'vendor'; };
```
- `cfg.children` for a new (unsaved) draft returns its in-buffer `lines` as
  edit-mode child rows (no fetch). The framework opens the fold on create
  (Task 3 `newRow` sets `cfg.fold(row, true)`).
- The vendor dropdown `attach` (6a) fires on focus.

**Verification:** Browser: click `+ Add bill` (or `i`/Enter on it) → parent +
one child row appear as inputs, fold open, vendor focused. Esc on empty →
vanishes (cursor → add row). Type vendor, Esc → amber dirty; `w` → saved
draft (6e).

**Commit:** `Bills: blank + add-row create (parent + first child, INSERT)`

### Task 6d — Bills child edit renderer + `a` add-child + Tab-spawn-new-line

**Objective:** Edit mode for a draft bill renders parent + children as inputs
(today's `renderDraftChildRows` L1356–1406 + `_wireDraftParentEvents`
L1694–1830 + `_wireChildRowTab` L1219–1262). `a` adds a child line
(`createDraftLine` L1580–1634). Tab past the last field of the last child
spawns a new line (the existing sticky behavior).

**Files:** `api/src/pages/payables-bills.js` — `cfg.addChild`,
edit-mode child row HTML, retained `_attachAcctDropdown`, `_attachVatDropdown`,
`_initChildGst`, `_recomputeChildGst`.

**Code shape:**
```js
cfg.addChild = function (parent) {
  // append { description:'', expense_account: companyDefaultExpense, amount:0, vat_code:'', vat_amount_override:null, currency: parent.currency } to the draft buffer's lines; render; focus new child desc
  // mirrors createDraftLine L1580–1634 but operates on the framework dirty buffer
};
// editChildRowHtml(parent, child, idx, isLast) → inputs for desc / expense-acct / amount / VAT + GST, with attachers wired (Task 3 enterEdit calls this)
// Tab wiring: forward Tab on last child's last field (GST) with data → addChild + focus; Shift+Tab on first child desc → parent CCY. Retain _wireChildRowTab logic.
// The + icon on the last child → addChild (mouse parity for `a`).
```
- GST recompute (`_recomputeChildGst`) stays; called on amount/VAT-code input.
- Parent input events (vendor/CCY/AP dropdowns, FX tooltip) attach in `enterEdit`
  via the column `attach` hooks (6a) + a bill-level post-build hook.

**Verification:** Browser: `i` on a saved draft re-renders it editable; `a`
adds a line; Tab past last GST spawns a line; Shift+Tab wraps to parent CCY;
Esc exits (dirty amber); `w` saves.

**Commit:** `Bills: child edit renderer + a add-child + Tab-spawn-new-line`

### Task 6e — Bills `save` (bill-level) + `del` (draft)

**Objective:** `cfg.save.body(d)` builds the bill-level payload (today's
`saveDraftToDb` L2115–2252 + `_gatherInlineBillData` L2254–2295 folded in) —
ONE `bill.draft.save` write carrying header + all lines. `cfg.del` =
`bill.draft.delete`. `w` success → reload (saved draft re-renders as display,
fold closes). `u` reverts the whole bill.

**Files:** `api/src/pages/payables-bills.js` — `cfg.save`, `cfg.del`,
`cfg.validate`, `cfg.same`.

**Code shape:**
```js
cfg.validate = function (b) {
  // draft-time guards (NOT post guards): vendor from dropdown, date present, VAT codes valid (_validateDraftVatCodes). Return error string | null.
};
cfg.same = function (b, s) { /* header + lines deep-equal against saved */ };
cfg.save = { action: 'bill.draft.save',
  body: function (b) {
    return { bill: {
      bill_id: b._isNew ? null : b._key,
      vendor: b.vendor, vendor_ref: b.vendor_ref, date: b.date, due_date: b.due_date,
      amount: sumGross(b.lines), currency: b.currency, ap_account: b.ap_account, expense_account: b.expense_account,
      lines: (b.lines||[]).filter(nonEmpty).map(function (l) {
        return { description: l.description, expense_account: l.expense_account, amount: l.amount,
          vat_code: l.vat_code || null, vat_amount_override: l.vat_amount_override, currency: b.currency };
      })
    } };
  },
  focusKey: function (b, res) { return b._isNew ? (res.billId || b._key) : b._key; } };
cfg.del = { action: 'bill.draft.delete', body: function (b) { return { billId: b._key }; },
  confirm: function (b) { return 'Delete draft bill from "'+(b.vendor||'?')+'"?'; } };
```
- `sumGross(lines)` = Σ (net + non-readonly GST) — same formula as
  `updateParentDraftAmount` (L1865–1881).
- On `w` success the framework drops the dirty buffer and `load()` re-renders
  the saved draft as display (fold closed). `billChildCache[_key]` is cleared so
  the next unfold refetches.

**Verification:** Browser: create draft → `w` → saved draft appears collapsed;
edit it (`i`) → change a line → Esc → `w` → re-saved. `u` reverts. `x` on a
saved draft → confirm → deleted.

**Commit:** `Bills: bill-level save (bill.draft.save) + del (bill.draft.delete)`

### Task 6f — Bills `extraBindings`: `p` (post/pay), `x` (void), pay-row, payment-void

**Objective:** Screen-specific verbs that are NOT row edits live in
`extraBindings` (fb-list spec §4/§6): `p` posts a draft (saved-draft:
save+`bill.draft.post` chain; inline unsaved: `bill.create`) or opens the
inline pay row on posted/partial (P1-9, retained). `x` on a posted/partial
bill = void (`bill.void`, confirm); `x` on a payment-history child = void
payment (`bill.payment.void`). These override/extend the framework's built-in
`x` (which handles draft delete via `cfg.del`).

**Files:** `api/src/pages/payables-bills.js` — `cfg.extraBindings`;
retained `openPayRow`/`closePayRow`/`submitPayRow` (L143–256),
`_postDirect`/`_sendPost` refactored into the `p` binding.

**Code shape:**
```js
cfg.editable = function (d) { return d.status === 'draft'; };     // i/Enter no-op on posted
cfg.deletable = function (d) { return d.status === 'draft'; };    // framework x → cfg.del (draft delete)
cfg.extraBindings = function (api) {
  return [
    { key: 'I', mode: 'NORMAL', hint: 'edit in full editor',
      run: function () {
        var d = api.focusedRow(); if (!d || d.status !== 'draft') return;
        FB.navigate('/' + COMPANY + '/bill/edit?id=' + encodeURIComponent(d._key));
      } },
    { key: 'p', mode: 'NORMAL', hint: 'post/pay', hintBar: true,
      run: function () {
        var d = api.focusedRow(); if (!d) return;
        var p = d._childOf ? rowByKey(d._childOf) : d;
        if (!p) return;
        if (p.status === 'draft') postBill(p, api);                       // save+post (saved) or bill.create (inline)
        else if (p.status === 'posted' || p.status === 'partial') openPayRow(parentTr(p)); // P1-9 inline pay row
      } },
    { key: 'x', mode: 'NORMAL', hint: 'void', hintBar: true, when: function () { var d = api.focusedRow(); return d && d.status && d.status !== 'draft'; },
      run: function () {
        var d = api.focusedRow();
        if (d.paymentId) { /* x on payment-history child → bill.payment.void (confirm) */ }
        else if (d.status === 'posted' || d.status === 'partial') { /* bill.void (confirm) — today L768–786 */ }
      } }
  ];
};
```
- `postBill(p, api)`: if `p._isNew` → `bill.create` (gathered from the dirty
  buffer, today's `_postDirect` inline branch L2306–2322); else save the dirty
  buffer via `api.writeAllDirty`-equivalent then `bill.draft.post`
  (today's saved-draft branch L2324–2365). On success: `api.load()`.
- The inline pay row (`openPayRow`) inserts a `<tr data-pay-row>` after the
  parent (unchanged P1-9 machinery); its Enter/Esc/Tab bindings are declared
  ahead of the general INSERT bindings (priority order) exactly as today
  (L388–393). These stay in `extraBindings` (or a dedicated INSERT-binding
  block the framework exposes for tree screens — see open question below).

**Verification:** Browser: `p` on a draft → posted (bill disappears from
drafts, reappears as Open); `p` on a posted bill → pay row opens → Enter
records payment; `x` on a posted bill → confirm → voided; `x` on a
payment-history child → confirm → payment voided.

**Commit:** `Bills: extraBindings — p post/pay, x void, pay-row + payment-void`

---

## Task 7 — Delete the bespoke Bills machinery (after the cfg fully replaces it)

**Objective:** Once Task 6a–6f are in and the Bills tab is fully driven by
`FB.list`, delete the now-dead code. Do this as ONE focused commit so the diff
is a clean removal (the migration commits added the cfg alongside the old
code; this commit drops the old code).

**Files:** `api/src/pages/payables-bills.js` — delete the line ranges mapped
"DELETE" in the recon table above. Concretely:

- `kbd` object and all its handlers (L299–790).
- `initBillsTable` bespoke filter/sort/click wiring (L849–916) — the framework
  owns tbody click→edit/fold now. Keep only the dblclick→editor behavior,
  relocated into the parent `display` ref-link or a render hook.
- `openColFilter` (L1060–1217) — framework ≡ owns column filters.
- `addRowFromIcon`, `refreshSaveIcon` (L1302–1354) — framework `a` + `w` chip.
- `_isDraftEmpty`, `_discardDraftBill` (L1474–1524) — framework `isBlank` +
  dirty-new discard.
- `insertDraftParentRow`, `insertDraftChildRow` (L1832–1935) — framework
  create + `a`.
- `convertDisplayToDraft`, `convertDraftRowToDisplay` (L1937–2095) — framework
  re-enter edit + render-from-saved.
- `saveDraftFromIcon` (L2097–2113) — `w` chip.
- `_saveAndExitInsert` (L1636–1658) — Esc never saves.
- `registerBillKeyActions` / `window.fbKeyActions` (L2400–2422) — framework
  owns create/delete.
- `applyFilters` (L2511–2561) — framework `merged()` + column filters.
- `renderPage`, `renderPagination`, `goPage` (L2589–2663) — framework render.
- `showMsg` (L2714–2718) — `FB.status`.
- The `treeState`, `draftLines`, `cursor` state objects (L5–37, L39–103) —
  framework fold state + dirty buffer + `nav`.
- `toggleBillLines` (L918–1058) — refactored into `cfg.children`/`childRowHtml`
  in 6b; the original function is deleted.
- `_wireDraftParentEvents`, `_wireChildRowTab`, `renderDraftChildRows`,
  `refreshAddRowIcons` (L1219–1300, L1356–1406, L1694–1830) — refactored into
  `attach` hooks + edit child renderer in 6a/6d; originals deleted.

**Retained** (do NOT delete): `billAccountsList` + `loadBillAccounts` +
`_acctSource` + `_attachAcctDropdown` (L105–141); `_cashSource` +
`_attachCashDropdown` + `openPayRow`/`closePayRow`/`submitPayRow` (L143–256);
`_vatSource` + `_attachVatDropdown` + `_validateDraftVatCodes` (L258–297);
`_initChildGst` + `_recomputeChildGst` (L1408–1472); `billEditMsg` (L792–796);
`fbPageInitPayables` trimmed (L819–847); `_loadCompanyDefaults` (L798–817);
`loadPeriods`/`loadAllBills`/`loadFxRatesForKpi`/`convertToBase`
(L2424–2476, with `loadAllBills` becoming a thin `billsList.load()` alias);
`computeKpis`/`fmtAmt`/`setText` (L2478–2509);
`_singleCcy`/`_applyCcyColVisibility`/`_refreshCcyVisibility` (L2563–2587);
`vendorCell`/`hashStr`/`fmtDate`/`fmtDateShort`/`statusBadge` (L2665–2712);
`showPayTab`/`renderPayHints` trimmed (L2722–2757); `_getFxRate`/
`_updateCcyTooltip` (L1660–1692).

**Commands:**
```bash
# After the delete, the file should be ~700–900 lines (cfg + retained helpers).
wc -l api/src/pages/payables-bills.js
node -e "require('./api/src/pages/payables-bills.js'); console.log('ok')" 2>&1 | head
```

**Verification:** `npm test` green. Browser: full Bills cycle still works
(create/edit/fold/filter/post/void/pay) — nothing regressed because the cfg
already replaced every deleted function.

**Commit:** `Bills: delete bespoke render/draft/filter/nav machinery (FB.list owns it)`

---

## Task 8 — Remove the `fbBillNav` capture-phase special-case in common.js

**Objective:** `common.js` consults `window.fbBillNav` to suppress its own j/k
handler when the Bills tab is active (L495). With Bills on `FB.list`, the
framework's `FB.keys` registration ('bills') owns j/k at capture phase and
common.js's bubble handler is never reached for Bills — the special-case is
dead. Remove it. Also remove `window.fbBillNav = true`/toggle from
`fbPageInitPayables`/`showPayTab` (already trimmed in Task 6a/Task 7).

**Files:**
- `api/public/common.js` — L488–521 (the j/k block): delete the
  `if (window.fbBillNav) { return; }` guard (L495). The vendor-panel guard
  (L491–494) and the generic `fbKeyActions` j/k fallback (L497–521) stay.
- `api/src/pages/payables-bills.js` — drop `window.fbBillNav = true;` from
  `fbPageInitPayables` (L832) and `window.fbBillNav = (t === 'bills');` from
  `showPayTab` (L2730) — done in Task 6a/7, confirmed here.

**Verification:** `npm test` green. Browser: on Bills, j/k moves the framework
cursor (capture-phase FB.keys wins); on a non-FB.list page, common.js j/k still
works. Vendors tab unchanged (its guard stays).

**Commit:** `common.js: remove fbBillNav j/k guard (Bills now on FB.list)`

---

## Task 9 — Rewrite stale `payables-ux-spec.md` sections (same commit as code)

**Objective:** The payables spec has stale doctrine: "Esc always saves" / "No
Cancel/Discard Path" (L99–101), the create path via `o`/`O` (NORMAL table
L27–28), and the INSERT table's "Esc → Save bill + exit" (L51). The ratified
contract rewrites these to the framework-native doctrine (Esc never saves;
create via add row; `o`/`O` retired on Bills). Follow the existing
dating/revision style (section status lines + dated inline notes, e.g. the
fb-list spec's `**(2026-07-24 rev. 3)**` pattern).

**Files:** `docs/payables-ux-spec.md`.

**Rewrites:**
- **NORMAL MODE table (L14–34):** drop the `o`/`O` rows ("new bill below/above
  current row") — create is the `+ Add bill` row (Enter on it). Change `Enter`
  from "Toggle fold" to **"Edit (whole-bill INSERT on drafts; no-op on posted;
  create on the add row)"**. Add a **Space = Fold** row (vim fold semantics:
  toggles the bill under the cursor; inert on the add row). Keep `a` (add
  child line), `x` (delete draft / void posted / void payment), `p` (post/pay),
  j/k (cross bill boundaries), G/gg.
- **INSERT MODE table (L44–52):** `Esc` row → **"Exit INSERT only — never
  saves; the dirty bill stays (amber). `w` persists."** Remove "Click outside
  bill = Save bill + exit" (click-outside now exits, dirty stays — framework
  behavior). Keep Tab/Shift+Tab/Enter field-advance; note Tab past last child's
  last field spawns a new line.
- **"No Cancel / Discard Path" section (L99–101):** replace with the doctrine
  (Esc never saves; `u` reverts; `x` on a dirty-new bill discards it). Reference
  fb-list-ux-spec §3.
- **"Click-Outside Save" section (L82–98):** rewrite to "Click-outside exits
  INSERT (dirty stays); the clicked row is selected." Drop the `saveCurrentBill`
  pseudo-code.
- **"Empty Bill Discard" (L103–105):** keep — an untouched new bill still
  vanishes on Esc (framework `isBlank`).
- Add a dated header note (top of the doc, near L1–2): "Bills migrated onto
  FB.list (`tree: true`) 2026-07-24; this spec's Bills-specific sections now
  describe the framework-native behavior (see fb-list-ux-spec.md). The
  bill editor screen (bill-edit.js) and bill-detail page remain separate."

**Verification:** Read-through: the spec's NORMAL/INSERT tables, Esc doctrine,
and create path now match the implemented behavior; no "Esc saves" remains.

**Commit:** `payables-ux-spec: rewrite NORMAL/INSERT tables, Esc doctrine, create path (Bills on FB.list)`

---

## Task 10 — Extend `fb-list-ux-spec.md` for `tree: true` (same commit as code)

**Objective:** Document the tree mode added in Tasks 1–5 and mark Bills
migrated. Follow the existing dating/revision style.

**Files:** `docs/fb-list-ux-spec.md`.

**Edits:**
- **§1 (L11):** move "Bills (needs `tree: true` …)" from Pending to Migrated:
  "**Migrated:** Settings (…), Vendors, FX Rates, **Bills (`tree: true`)**.
  Pending: Bank Mappings." Delete the parenthetical about Bills needing tree.
- **§4 verb table (L43–53):** add tree-only rows (mark "tree mode"): `Space` =
  fold (toggle the bill under the cursor; inert on the add row); `a` = add
  child to the focused draft bill. Note that `Enter` on a child = edit the
  parent bill; on a posted bill = no-op; on the add row = create. `o`/`O`
  remain retired on every FB.list screen (Bills included).
- **§6 config contract (L63–87):** add the tree options (the block documented
  in Task 1): `tree`, `children(row)`, `foldKey(row)` / `isFolded(row)` /
  `fold(row, open)`, `childRowHtml(parent, child, idx)`, `addChild(row)`. Note
  that in tree mode `editable`/`deletable` gate the whole-bill edit unit and
  `save.body` carries header + lines (bill-level write).
- **New §6.1 (or a §6 "Tree mode" subsection):** the fold/filter/edit-unit
  semantics — children follow parent visibility; fold state untouched by
  filters; dirty/editing bill bypasses filters as a unit; j/k over the
  flattened visible sequence (parents + open children + add row).
- **§8 (L100):** the existing note "Bills' ≡ implementation is the reference
  UX; it is deleted — not ported — when Bills migrates to FB.list" — update to
  past tense: "Bills' bespoke ≡ was deleted (not ported) when it migrated."
- **§10 (L155–157):** delete the "Bills — Option A (interim doctrine)" interim
  note — Bills now follows the framework-native §3 doctrine. Add a one-line
  dated note: "Bills migrated onto FB.list (`tree: true`) 2026-07-24; the
  interim doctrine in this section is superseded."
- **§11 backlog (L159–164):** mark item 3 done ("Bills → FB.list with
  `tree: true`" — strike or check). Reorder note: Bank Mappings is now the
  last bespoke list.
- **Status line (L3):** append "Bills `tree: true` ratified 2026-07-24."

**Verification:** Read-through: the spec describes the tree config + verbs that
Tasks 1–5 implemented; Bills is marked migrated; no stale "Pending: Bills" or
"interim" remains.

**Commit:** `fb-list-ux-spec: tree:true config, §4 tree verbs, Bills migrated, drop §10 interim`

---

## Task 11 — Live browser verification checklist (final gate)

**Objective:** Per fb-list-ux-spec §12, verify the full Bills cycle live in the
browser on a throwaway DB. No automated tests are added; this is the manual
gate that the shared framework behavior is correct on the Bills screen.

**Setup:**
```bash
cd /home/ubuntu/accounting/workspace-legal-accountant/freebooks
export FREEBOOKS_DB_PATH=/tmp/bills-fb-list-verify.duckdb   # THROWAWAY — never ~/.freebooks/freebooks.duckdb
rm -f /tmp/bills-fb-list-verify.duckdb
node db/init.js
node api/src/index.js   # from repo root; server on its usual port
# Open the Payables page in a browser; create 2–3 vendors in Settings first if none.
```

**Checklist (each must pass):**
1. **Render:** Bills tab lists saved bills (or "No bills found.") via the
   framework; KPI summary header (TOTAL OUTSTANDING / OVERDUE / UPCOMING)
   populates; `.single-ccy` hides the CCY column when the list is
   single-currency, returns when mixed or a currency filter is active.
2. **j/k + G/gg:** cursor moves over parents and open children, crosses bill
   boundaries seamlessly, sticky at top/bottom; G → add row; gg → first row.
3. **Fold (Space / click ▸):** on a posted bill, Space lazy-fetches
   `bill.lines` (+ `bill.payments` for paid/partial) and renders children;
   Space again collapses. On a child, Space folds the parent. Inert on the add
   row. Fold state survives a column filter.
4. **Create (add row):** Enter/click on `+ Add bill` → parent + first child
   appear as inputs, fold open, vendor focused. Esc on the empty bill →
   vanishes, cursor → add row.
5. **Edit unit (i):** `i` on a draft (parent or child) opens the whole bill;
   `a` adds a child line; Tab past the last child's GST spawns a line;
   Shift+Tab wraps to parent CCY; Esc exits (dirty amber, NOT saved); `w`
   saves the whole bill in ONE `bill.draft.save` (Network tab: one request);
   the saved draft re-renders collapsed. `u` reverts a dirty bill.
6. **Filters (≡ + topbar `/`):** a column filter on Vendor hides non-matching
   parents (children follow); a dirty bill stays visible through the filter;
   `c` clears all; the topbar mirrors `//vendor:acme`. Edit/dirty bill bypasses.
7. **Post (`p`):** on a saved/inline draft → posts (one `bill.draft.post` or
   `bill.create`); the bill reappears as Open. On a posted/partial bill →
   opens the inline pay row → Enter records a payment (one
   `bill.payment.record`); the bill status updates to partial/paid.
8. **Void (`x`):** on a posted bill → confirm → voided (one `bill.void`); on
   a payment-history child → confirm → payment voided (one
   `bill.payment.void`). On a draft → confirm → deleted (one
   `bill.draft.delete`).
9. **Leave-guard:** with a dirty bill, switching to the Vendors tab (or a
   sidebar page) opens the shared Save/Discard/Stay modal; Save writes the
   dirty bill; Discard reverts; Stay aborts.
10. **Posted bills read-only:** `i`/Enter on a posted/partial/paid/void bill =
    no-op (editable predicate false). Only `p` (pay) and `x` (void) act.
11. **Editor still separate:** double-click a draft (or the ref-link) opens the
    full-page `bill-edit.js` editor — unchanged.
12. **`npm test` in `api/`**: 28 tests, all green.

**On any failure:** fix in the relevant task's commit (do not paper over); the
checklist is the gate, not a suggestion.

**Commit:** (none — this is verification only. If a fix is needed, commit the
fix with a message referencing the failed checklist item, e.g.
`Bills: fix <X> caught in live verification`.)

---

## Open questions / contract ambiguities (flagged for the owner — not silently resolved)

These are points where the ratified contract left a detail to the implementer's
judgment or where the current code and the contract could be read two ways.
Each is a decision the implementer should confirm with the owner (or pick the
sensible default noted) before/while implementing — NOT silently.

1. **`p` on a posted/partial bill = inline pay row (P1-9) vs. a simpler "post"
   verb.** The contract says "`p` = post" and separately lists the inline pay
   row as retained (§5). The current Bills code reuses `p` for both: post on a
   draft, open-pay-row on posted/partial (L646–649). This plan keeps that
   dual-meaning `p`. **Confirm:** `p` is intentionally dual (post-draft /
   pay-posted), not two separate keys. *(Default kept: dual `p`.)*
2. **`x` on a posted bill = void, but the framework's built-in `x` is "delete"
   (with `cfg.del`).** The contract says "`x` on draft = delete … posted bills:
   `x` = void (confirm)". This plan routes posted/partial `x` to an
   `extraBindings` void handler and leaves draft `x` to the framework's
   `cfg.del` path. **Confirm:** a single `x` key maps to delete-on-draft and
   void-on-posted, with the framework `cfg.del` only handling the draft case.
3. **The inline pay row's INSERT bindings (Enter/Esc/Tab) currently precede
   the general INSERT bindings (priority order, L388–393).** `extraBindings`
   in FB.list appends to the NORMAL set (the framework's INSERT bindings are
   fixed). The pay-row INSERT bindings may need a framework hook to inject
   high-priority INSERT bindings for tree screens, OR the pay row can manage
   its own keydown listener (as it essentially does today via the `payRowOpen`
   `when` guards). **Decision needed:** expose an `extraInsertBindings(api)`
   hook in FB.list, or keep the pay-row's bindings expressed as `when:
   payRowOpen` INSERT bindings appended via a new hook. *(Plan assumes a new
   `extraInsertBindings` hook is added in Task 4/6f — small framework
   addition.)*
4. **`o`/`O` retirement — `O` currently opens the full-page editor
   (`fbNavigate('/company/bill/edit')`, L366–367).** The contract retires
   `o`/`O` on Bills (§2). Retiring `O` removes the keyboard shortcut to the
   blank editor page; the double-click path (L866–884) and the ref-link remain.
   **Confirm:** losing the `O` shortcut to the blank editor is acceptable (the
   editor is still reachable by URL/double-click). *(Default: retire `O` per
   the contract.)*
5. **`I` (edit in full editor, L368–374) — DECIDED 2026-07-24: KEEP.**
   `I` is navigation (list → full editor for the focused draft), not a create
   path, so it is unaffected by the `o`/`O` retirement. Implemented as a
   Bills-only `extraBindings` entry in Task 6f: opens the full editor for the
   focused draft bill; no-op on posted bills.
6. **Sort — DECIDED 2026-07-24: KEEP, framework-owned.** The current Bills
   table has bespoke sort (click header ▲/▼, `sortState`, L887–907 +
   L2545–2557) and sort is spec'd in payables-ux-spec — dropping it would be a
   behavior regression. New **Task 5b** adds optional `sortable: true` per
   column to FB.list: header click cycles asc → desc → none (server order =
   `bill.list` ORDER BY date DESC), ▲/▼ arrow after the label, collapses when
   inactive (`.th-sort:empty{display:none}` per payables spec). Framework-owned
   per the unified-code doctrine; only Bills declares it today.
7. **`bill.list` returns drafts AND posted/partial/paid/void in one call.**
   The framework renders them all in one flat list (today's behavior). No
   server change. **Confirm:** no status segmentation (e.g. a separate drafts
   list) is wanted. *(Default: one list, status filter via ≡.)*
8. **The "Draft" badge on a saved draft is clickable in today's code
   (L2706 `cursor:pointer`) — pressing it was an alias for `p`.** The
   framework's `status` column `display` emits the badge; making it clickable
   for `p` requires a render hook (data-act) or the `p` key alone.
   **Confirm:** badge-click = `p` (post) is preserved via a render hook, or
   `p`-key only. *(Default: keep badge-click → post via a delegated click
   handler in the cfg, for mouse parity.)*

## Size estimate (honest)

- **`api/public/fb-list.js`:** +250 to +350 lines (tree config, flatten,
  childRowHtml, whole-bill edit unit, tree verbs, tree filters, fold helper,
  `extraInsertBindings` hook). 995 → ~1,250–1,350 lines.
- **`api/src/pages/payables-bills.js`:** −2,000 lines deleted, +250 lines of
  declarative cfg + retained helpers. 2,761 → ~700–900 lines.
- **`api/public/common.js`:** −1 line (the `fbBillNav` guard).
- **Specs:** `docs/payables-ux-spec.md` rewritten sections (~−40 / +50 lines
  net); `docs/fb-list-ux-spec.md` +~60 lines (tree config + verb rows).
- **Net repo:** approximately **−1,400 to −1,700 lines**, one new shared
  capability (`tree: true`) that any future tree-list (e.g. Receivables) reuses.

## Sequencing recap

Tasks 1–5 (framework `tree: true`) → Tasks 6a–6f (Bills cfg) → Task 7 (delete
bespoke) → Task 8 (common.js guard) → Tasks 9–10 (specs) → Task 11 (live
verify). Each task is one commit; the branch is not pushed and no PR is opened.
