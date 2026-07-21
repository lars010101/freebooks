# Payables UX Specification

## Design Principles

1. Two modes only: NORMAL (browsing) and INSERT (editing). No ambiguous middle state.
2. Every keyboard action has a mouse equivalent and vice versa. No interaction requires both. No interaction is available through only one input method.
3. NORMAL mode is row-oriented (vim line semantics). INSERT mode is bill-oriented — the entire draft bill (parent + all child lines) opens for editing simultaneously.
4. Save timing is unambiguous: exiting INSERT mode saves. No blur-chasing, no timers, no deferred checks.
5. Per-line accounts: each child line carries its own expense account; the parent row carries the AP (creditor) account. Both use COA datalist autocomplete.
6. Tax-exclusive entry: the user types the net amount per line; GST is computed on top. The supplier-stated VAT can override the computed default.

## Two-State Model

### NORMAL MODE (browsing)

| Key | Mouse | Action |
|-----|-------|--------|
| j | — | Move down one row (parent or child, no boundary blocking) |
| k | — | Move up one row (parent or child, no boundary blocking) |
| h | Click tab label | Switch to left tab |
| l | Click tab label | Switch to right tab |
| { | Click sidebar page | Previous sidebar page |
| } | Click sidebar page | Next sidebar page |
| Enter | Click ▸/▾ fold icon on parent | Toggle fold (expand/collapse bill) |
| Space | Click ▸/▾ fold icon on parent | Toggle fold (alias) |
| i | Double-click editable row | Enter INSERT mode (opens entire draft bill for editing) |
| o | Click "+" toolbar button | New bill below current row |
| O | — | New bill above current row |
| a | — | Append new child line to current draft bill |
| x | Click delete icon (on hover) | Delete current child line / delete draft bill / void posted bill |
| p | Click "Post" button on draft | Post draft bill directly (no preview step) |
| G | Scroll to bottom | Jump to last row |
| gg | Scroll to top | Scroll to top |
| Esc | — | No-op (already in NORMAL) |

Row selection highlights the complete row (parent or child). No cell-level cursor in NORMAL mode.

**Keyboard hints live in the left sidebar** (`#sb-hints`, below the nav, above the footer) — moved there 2026-07-22 from a footer bar under the table, which keyboard users never saw (the page never scrolls that far with keypresses). The panel is **generated from the same FB.keys binding table that drives dispatch** (`FB.keys.renderHints(name, el, {layout:'list'})`), one `kbd`-chip row per hint, so hints cannot drift from behavior. Pages/tabs render their own set: on Payables, `showPayTab` swaps the panel between Bills (generated) and Vendors (static list until the Vendors tab migrates onto FB.keys). The panel hides when the sidebar is collapsed and on pages that render no hints.

j/k navigation crosses bill boundaries seamlessly:
- On last child of a bill, j moves to next bill's parent (or first child if that bill is expanded)
- On first child of a bill, k moves to previous bill's parent (or last child if that bill is expanded)

### INSERT MODE (editing one bill)

| Key | Mouse | Action |
|-----|-------|--------|
| Tab | Click cell in bill | Move to next editable cell |
| Shift+Tab | Click cell in bill | Move to previous editable cell |
| Enter | — | Move to next input within the bill (or exit INSERT if on the last field) |
| Esc | Click outside bill | Save bill + exit to NORMAL |
| (all other keys) | — | Type into the focused input (h/j/k/l/{/}/o/x/p/G/gg all inert) |

Entering INSERT mode (via `i` on any row of a draft bill):
- **All** editable cells on the bill are already rendered as inputs (parent fields + child fields). `i` simply sets `cursor.mode = 'INSERT'` and focuses the first parent input (vendor).
- h/j/k/l/{/} are inert (they type into inputs).
- Tab/Shift+Tab move between cells across the entire bill (parent → children).

**New (unsaved) drafts:** `createDraftBill()` renders the parent row + first child row with all inputs, opens the fold, and auto-enters INSERT mode with focus on the vendor input.

**Saved drafts (status='draft', already in DB):** `convertDisplayToDraft()` re-renders the parent row from display text back into editable inputs (pre-filled with saved values), fetches draft lines from the server, and renders child rows with editable inputs. The `data-draft` attribute is re-set to `'true'` so subsequent Esc saves correctly.

Exiting INSERT mode (via Esc or click-outside):
- If the bill is completely empty, it is discarded instead of saved (`_discardDraftBill`)
- Otherwise the entire bill is saved to database (`saveDraftToDb`)
- Cells return to display state (`convertDraftRowToDisplay`)
- Returns to NORMAL mode with selection on the parent row

Posted bills: `i` and double-click are no-ops. The row is read-only. No INSERT mode is entered.

### Tab Behavior at Bill Boundaries

Tab navigates across all editable cells in the bill. The forward flow for a bill is:

**Parent:** vendor → date → due → ref → (skip read-only total) → CCY → AP account → **first child:** description → expense account → amount → VAT code select → GST amount → **next child:** description → … → last child GST amount

- **Forward Tab on the last child's last field (GST amount):** If the current child has data (description or amount), a **new child row is created** (`createDraftLine`) and focus moves to its description input. If the child is empty, Tab stays (sticky — no empty rows created).
- **Shift+Tab** flows in reverse. On the first child's description field, focus moves back to the parent's CCY input.

This keeps the user inside the bill editing flow. Creating a new line is natural — just Tab past the last field. No need to Esc → `a` → `i` to add a line.

### Click-Outside Save (Mouse Esc Equivalent)

When a mouse user is in INSERT mode and clicks another row, two things happen atomically:
1. Current bill is saved (Esc equivalent)
2. Clicked row is selected (j/k equivalent)

No intermediate NORMAL state should be visible. Implementation:
```js
function onRowClick(rowEl) {
  if (cursor.mode === 'INSERT') {
    saveCurrentBill();
    exitInsertMode();
  }
  selectRow(rowEl);
}
```

### No Cancel / Discard Path

There is no discard option. Esc always saves (or discards if empty). Click-away always saves. If a user wants to undo changes, they delete the row afterward. An undo mechanism (u key / undo button) may be added in a future revision but is out of scope for this spec.

### Empty Bill Discard

If Esc is pressed on a completely empty draft (no vendor, no date, no child data), the draft is discarded rather than saved (`_isDraftEmpty` → `_discardDraftBill`). This prevents empty draft rows from accumulating.

## List Display (NORMAL Mode)

- **Dates are compact:** the year is elided when it is the current calendar year ("21 Jul"); prior/future years show the full date ("15 Dec 2025"). The full ISO date is in the cell's `title` (hover tooltip). Numeric-only formats were rejected (locale-ambiguous for a multi-jurisdiction app); the month-name form stays. (Agreed 2026-07-21.)
- **Column widths are weighted** via `<colgroup>` (fixed layout), with all weights owned by CSS `col.col-*` classes — never inline styles or JS width juggling — so the `.single-ccy` state can re-weight cleanly: VENDOR 22%, DATE 12.5%, DUE 12.5%, REFERENCE 15%, AMOUNT 14%, CCY 9%, STATUS 15%. Vendor carries the most information; CCY needs the 3-letter code plus header affordances (CCY was widened 7→9% on 2026-07-22: at 7% the corner-pinned filter icon overlapped the "CCY" label at ≤1400px viewports).
- **CCY column is conditional** (agreed 2026-07-21): when every visible bill shares one currency it carries no information, so it is hidden via `visibility:collapse` on the `<col>` (space reclaimed, column-track mapping preserved — `display:none` would slide later columns into the wrong track; the CCY th also gets `visibility:hidden` because Chrome leaks the absolutely-positioned filter icon out of a collapsed column) and the other columns absorb the width via the `.single-ccy` re-weighting rules. It returns automatically in INSERT mode (the CCY input lives there) and whenever the list is mixed. Recompute is DOM-driven (`_refreshCcyVisibility`) so in-place row removals (x), Esc-save conversions, and re-renders all stay correct. **Exception (2026-07-22): the column never hides while a currency filter is active** — the column's ≡ is the only way to see and clear that filter; hiding it trapped users (a reload was needed to get foreign bills back). With the filter active the column stays, showing the blue filtered ≡; clearing re-hides if the unfiltered list is single-currency.
- **Child-row VAT code/GST input sits in column 7 (under STATUS)**, not under CCY (moved 2026-07-21 so the CCY column can hide cleanly); the `+` add-row icon lives in the column-6 spacer cell (`td.child-spacer`).
- **Cell side padding is 12px uniformly** (was 18px); vertical rhythm unchanged (th 12px, td 14px).
- **Header labels sit flush with cell content** (delta 0): the sort arrow lives AFTER the label and collapses when inactive (`.th-sort:empty{display:none}`), so no reserved icon gap. CCY cells are left-aligned like the header (not centered). The filter icon (≡) is absolutely pinned to the right corner of EVERY header — out of the layout flow, so it never displaces a label.
- **AMOUNT header label is flush RIGHT** with the figures (delta 0): the label hugs the corner icon, and the figure cells (`td.amt`, `td.draft-total-amount`) carry the same icon-width reserve (46px right padding) so label right edge == figures right edge == icon left edge. AMOUNT column is 14% wide to keep 6-figure amounts on one line.
- **INSERT-mode rows use tighter side padding** (10px vs 12px) so edit inputs — especially the browser date-picker chrome — keep working width in the weighted columns.

## Bill Layout (INSERT Mode)

### Parent Row (7 columns matching table headers)

| VENDOR | DATE | DUE | REFERENCE | AMOUNT | CCY | STATUS |
|--------|------|-----|-----------|--------|-----|--------|
| Vendor input | Date input | Due date input | Ref input | Total (gross, read-only text) | Currency input | AP account input + save button (💾) |

**Input geometry (2026-07-22):** every draft input **fills its cell** (`width:100%`, `box-sizing:border-box`) at a uniform **32px height** — no fixed pixel widths (the CCY input was 50px and the AP input 80px, which truncated the AP account and broke column alignment). The AP-account cell is a flex row (`.draft-ap-cell`: input grows, save icon / Draft badge fixed). The read-only total cell (`.draft-total-amount`) keeps the standard AMOUNT gutter (46px right padding) so the draft total aligns with posted figures — a stale `!important` padding override that killed this gutter was removed. Child-row amount inputs sit in an `td.amt` cell so they inherit the same gutter and align with data rows.

- **Vendor input** (`.draft-vendor-input`) — free-text with dropdown autocomplete; selecting a vendor sets `data-vendor-id`, `data-vendor-name`, `data-ap-account`, and `data-expense-account` from vendor master data.
- **Total** (`.draft-total-amount`) — read-only text showing the gross amount (net + GST), updated live by `updateParentDraftAmount`. Not an input, so Tab skips it.
- **AP account input** (`.draft-ap-account`) — COA datalist autocomplete (`list="coa-options"`). Pre-filled from vendor default > company default > blank.
- **Save button** (💾, `.btn-save-draft`) — in the STATUS column. Grayscale/faded when the bill is completely empty; full colour when any field has data. Clicking saves the draft (`saveDraftFromIcon`).

### Child Row

| Description (colspan=3) | Expense Acct | Amount | VAT Code + GST | [action] |
|-------------------------|--------------|--------|-----------------|----------|
| Description input | Expense account input (COA datalist) | Amount input (number) | VAT code select + GST amount input (stacked) | add-row icon (+) on last child |

- **Description** (`.child-desc`) — `colspan=3` (reduced from 4 in earlier versions to make room for the expense account column).
- **Expense account** (`.child-expense-acct`) — COA datalist autocomplete (`list="coa-options"`). Pre-filled from vendor default > company default > blank.
- **Amount** — numeric input; the net (tax-exclusive) amount for the line.
- **VAT code** (`<select>`) — dropdown of active VAT codes, plus "— None —".
- **GST amount** (`.child-gst`) — appears when a VAT code is selected. See [VAT/GST Handling](#vatgst-handling) below.
- **Add-row icon** (+) — appears only on the last child row. Fades when that row is empty. Clicking creates a new child line (`addRowFromIcon` → `createDraftLine`).

## Parent Total (Gross = Net + GST)

The parent row's AMOUNT cell shows the gross total (sum of each line's net + GST). This is computed identically in four places:

| Function | Context | Formula |
|----------|---------|---------|
| `updateParentDraftAmount` | Live display during INSERT editing | Σ (net + GST) over child rows |
| `saveDraftToDb` | Save payload (`totalAmt`) | Σ (net + GST) over child rows |
| `_gatherInlineBillData` | Direct-post payload (`totalAmt`) | Σ (net + GST) over child rows |
| `convertDraftRowToDisplay` | Display after saving | Σ (net + GST) over child rows |

GST is the `.child-gst` input value. Read-only reverse-charge GST inputs are excluded from the user-facing total (the backend self-assesses them separately).

## Account Defaults (3-Tier Precedence)

Both the AP account (parent) and the expense account (per child line) are resolved with a three-tier fallback:

1. **Vendor default** — from vendor master data (set when a vendor is selected in the dropdown; stored on the vendor input's `data-ap-account` / `data-expense-account`).
2. **Company default** — from Settings (`default_ap_account`, `default_expense_account`), loaded on page init into `companyDefaultAp` / `companyDefaultExpense`.
3. **Blank** — no default; validation surfaces a clear "account is required" error.

`renderPage` emits `data-expense-account` and `data-ap-account` on each parent row's HTML for saved bills. `saveDraftBill` (backend) applies company defaults as a safety net via `applyCompanyDefaults` before persistence. A blank account produces a "required" validation error (not "does not exist in COA").

## VAT/GST Handling

### Tax-exclusive entry
The user enters the **net** amount per line. VAT (GST) is computed on top: `expectedVat = Math.round(amount × rate × 100) / 100`.

### GST amount input (`.child-gst`)
- Appears when a VAT code is selected; hidden when "— None —" is chosen.
- **Auto-computed default** — set by `_recomputeChildGst` on amount or VAT-code change: `Math.round(amount × rate × 100) / 100`.
- **Supplier-stated override** — the user can type the GST amount shown on the supplier's invoice. This overrides the computed default. The override is stored as `vat_amount_override` on the line and sent to the backend.
- **Reverse charge codes** — the GST input is **read-only** (self-assessed). The computed amount is always used; any override is cleared (`vatAmountOverride = null`). The input has a grey background and tooltip "Reverse charge — VAT is self-assessed (override disabled)".

### Tolerance check (backend)
When a supplier-stated VAT override is provided (and the code is not reverse charge), the backend compares the stated amount to the computed amount:

```
tolerance = max(flat, pct × expectedVat)
```

- If `|stated − computed| > tolerance`, a **warning** is added (does NOT block posting). The warning message includes the line number, stated amount, computed amount, and the difference, e.g.:
  > Line 1: VAT amount 12.00 differs from computed 11.50 by 0.50 — verify supplier invoice
- If within tolerance, no warning.

**Settings** (Company tab):
- `vat_tolerance` — flat amount in home currency (default `0.50`)
- `vat_tolerance_pct` — percentage of expected VAT, `0.01` = 1% (default `0.01`)

### Journal entries (backend)
- **Standard VAT:** one DR to the GST input account per expense line (debit = lineVat).
- **Reverse charge:** DR input VAT + CR output VAT (net cash effect zero; both reported), using the computed amount.
- One DR to the expense account per line (debit = net amount).
- One CR to the AP account for the total (net + VAT).

## Posting Flow

### Direct post (no preview)
Pressing `p` posts the bill **directly** — no preview step, no confirmation dialog. The backend validates; on error, the draft remains intact.

Two cases in `_postDirect`:

1. **Inline draft (never saved, has vendor input):** gathers data via `_gatherInlineBillData`, runs client-side guards (vendor, date, due date ≥ date, ref, amount > 0, at least one line), then sends `bill.create` (creates AND posts in one call).

2. **Saved draft re-edited inline (has `billId`, no vendor input):** saves the draft first (`bill.draft.save`), then sends `bill.draft.post` which delegates to `createBill` with `_replaceDraftId`.

### Client-side guards (inline draft)
- Vendor required (selected from dropdown)
- Bill date required
- Due date required and ≥ bill date
- Invoice reference (Ref) required
- Total amount > 0
- At least one line item

### Backend validation
- Accounts exist in COA (or are required if blank)
- DR = CR (balanced journal)
- FX rate available for the bill's currency + date (see [FX Handling](#fx-handling))
- Bill date falls within an unlocked accounting period

Validation runs **before** any DB writes. On failure, the draft is untouched and the error is shown in the status bar.

### On success
- "Bill posted successfully" in the status bar
- If the backend returns tolerance warnings (`data.warnings`, e.g. supplier-stated VAT differs from computed): "Posted with warning: …" in the status bar in warning colour (amber), held longer (6s vs 2.5s) so it can be read. Warnings never block posting and never add new UI chrome — status bar only.
- Draft row + child rows removed from the DOM
- Bill list reloads (`loadAllBills`)

### On error
- Error message in the status bar
- Draft remains in the DOM, fully editable

## Draft Posting Mechanics (Backend)

### In-place UPDATE (not delete + insert)
When posting a saved draft, `createBill` is called with `_replaceDraftId` set to the draft's `bill_id`. Instead of deleting and re-inserting, the draft row is **UPDATEd in place**:

```sql
UPDATE bills SET status='posted', ... WHERE bill_id=@bill_id AND company_id=@company_id AND status='draft'
```

- **Preserves** `bill_id`, `created_at`, `created_by` (not reset on post).
- **Preserves attachment links** (same `bill_id`).
- The `status='draft'` guard in the WHERE clause is a safety net — it ensures only a draft is ever promoted, never clobbering a posted/paid/void row.
- Journal entries are **INSERTed** (drafts have none), referencing the reused `bill_id`.
- `draft_lines` is set to NULL on the posted row.

### `postDraftBill` (backend)
Reads the draft row, resolves lines from stored `draft_lines` JSON (or falls back to a single line from the bill row), applies any overrides, then delegates to `createBill` with `_replaceDraftId = billId`.

## FX Handling

### No UI input field
There is no FX rate input field in the bill entry UI. The visual layout is identical for base and foreign currency bills. FX rates are managed exclusively in **Settings → Exchange Rates** (master data).

### Rate resolution at post time
When a bill is posted, the backend resolves the FX rate from the `fx_rates` table via `getRate(currency, homeCurrency, date)`:
- **Exact-date match only** — no nearest-date fallback.
- Forward and reverse (inverted) rates are both considered.
- If no exact-date rate exists, posting is **blocked** with an error directing the user to Settings → Exchange Rates. No manual override is available during bill creation.

### Tooltip (mouse users)
When the mouse hovers over the CCY cell (in both INSERT and display modes) and the currency is non-base, the tooltip shows the rate (e.g. "USD → SGD: 1.34"). The tooltip updates when the date or currency changes. If no rate exists, the tooltip says so. `renderPage` populates these tooltips asynchronously for display rows.

### Enter on CCY (keyboard users)
In INSERT mode, pressing Enter on the CCY input when a non-base currency is entered shows the FX rate in the status bar (e.g. "FX: 1 USD = 1.34 SGD"). If no rate exists, the message indicates this.

## Foldable Rows

### Fold Toggle
- Enter or Space (keyboard): toggle fold on parent row under cursor
- Click ▸/▾ icon (mouse): toggle fold on that parent
- Clicking the parent row body (not the icon) selects the row — does NOT toggle fold

### Fold Behavior
- **Expand:** for drafts, renders child rows from the in-memory `draftLines` cache (auto-created if empty); for saved bills, fetches line items from the server (first time) and caches by `bill_id`. Parent gets the `row-expanded` CSS class.
- **Collapse:** removes child rows from DOM. Parent loses `row-expanded` class. If the cursor was on a child, it moves to the parent.
- Client-side line cache: once fetched, line items are cached by bill ID. Subsequent expands render from cache instantly. Cache invalidates on save/post.

### Expand All / Collapse All
`_expandAll` / `_collapseAll` have been **removed**. There is no bulk expand/collapse. If needed, it may be reintroduced via a future command palette. Out of scope for this spec.

### Visual Affordances

| Element | Hover State | Cursor Icon |
|---------|-------------|-------------|
| Fold icon (▸/▾) | Background lightens | pointer |
| Parent row body | Subtle background tint (mouse only, not after keyboard) | default (clicking selects) |
| Editable row (draft) | Slightly darker tint + tooltip "double-click to edit" | default |
| Posted row | No special hover | not-allowed on double-click attempt, or "posted" badge |
| Delete icon | Turns red | pointer |
| Post button | Highlights | pointer |
| Input field (INSERT) | Standard focus ring | text (I-beam) |

### Hover Highlight Rules

Hover background highlight is only active when:
- NOT in INSERT mode, AND
- Mouse was the last input (keyboard activity suppresses hover via `kb-active` class on tbody)

When the keyboard is used (j/k/etc), hover is suppressed. When the mouse is moved, hover is re-enabled. This prevents the white hover background from conflicting with the blue cursor highlight during keyboard navigation.

## Cursor Model

- `cursor.mode` is a getter/setter that auto-toggles CSS classes: setting it to `'INSERT'` adds `insert-mode` to the tbody; setting it to `'NORMAL'` removes it.
- `kb-active` class is added to the tbody on keydown and removed on mousemove — suppresses hover highlight during keyboard navigation.
- Tab switching (`showPayTab`) re-applies the row highlight and scrolls to the last cursor position.
- `cursor.col` is retained as internal state for Tab navigation positioning but has no visual effect in NORMAL mode (row-only selection).

## Removed / Simplified

The following elements from earlier implementations are removed or simplified:

| Removed | Reason |
|---------|--------|
| Cell-level cursor in NORMAL mode (h/l within row) | Row-only selection; h/l reserved for tab switching |
| `fbBillCursorMid` flag | No longer needed; h/l always means tab switch |
| `bill-cell-focus` CSS (dark blue cell highlight) | No cell cursor in NORMAL mode |
| `autoSaveDraftIfReady` 200ms timer | Save triggers on INSERT exit (Esc), not on blur |
| `autoSaveChildRow` | Same — save on Esc, not on blur |
| `enterBillCellEdit` / `exitBillCellEdit` | Per-cell editing replaced by bill-level INSERT |
| `billEditState` object | No longer needed without per-cell edit |
| `dd` double-tap delete | Replaced by single `x` key |
| `dd` double-tap timer (`_ddPending`, `_ddTimer`) | No double-key sequences except `gg` |
| `za/zo/zc/zR/zM` fold keys (dead code) | Never implemented; Enter/Space used instead |
| `:w` save command (`fbCmdDispatch`) | Esc saves on INSERT exit; no command bar needed |
| `~` hidden shortcut | Removed; use `p` to post |
| `_expandAll` / `_collapseAll` | Removed; no bulk expand/collapse |
| Preview step (`_enterPreview` / `_exitPreview` / `_renderPreviewLines` / `_confirmPost`) | Removed; direct post on `p` |
| `bill.draft.preview` backend endpoint | Dead code; frontend no longer calls it |
| Popup posting (`openPostReviewPopup` / `confirmPost` / `closePostReviewPopup`) | Removed entirely |
| Blur-chasing save timers | Save happens only on Esc (or click-outside) |
| j/k boundary blocking | Seamless navigation across bill boundaries |

## Implementation Notes

- Bill-level INSERT rendering reuses `createDraftBill()` for new drafts and `convertDisplayToDraft()` for saved drafts. Both render parent + children with all inputs simultaneously.
- Tab navigation is wired via `_wireChildRowTab()` — forward Tab on last child's GST select creates a new row; Shift+Tab on first child's desc goes to parent CCY.
- Save-on-INSERT-exit uses `saveDraftToDb()` — one trigger, one code path, no timers.
- `convertDraftRowToDisplay()` converts editable inputs back to display text after save, removing the `data-draft` attribute.
- `_gatherInlineBillData()` collects the full bill (parent fields + per-line expense accounts + `vat_amount_override`) for direct posting of unsaved inline drafts.
- `_postDirect()` routes to `bill.create` (inline drafts) or `bill.draft.save` → `bill.draft.post` (saved drafts), then `_sendPost()` handles the response.
- `_ensureCoaDatalist()` builds a shared `<datalist id="coa-options">` from the chart of accounts for AP and expense account autocomplete.
- `updateParentDraftAmount()` recomputes the parent total live on every input/change in a child row.
- `_recomputeChildGst()` and `_initChildGst()` manage the GST input: computed default, supplier-stated override, and reverse-charge read-only state.
- Event handler conflicts between common.js and payables-bills.js resolved by early `stopImmediatePropagation()` in the bills handler (capture phase) when `fbBillNav` is true.
- `gg` double-key logic is retained (deeply ingrained vim muscle memory); all other double-key sequences are removed.

## Vendors Tab (migrated onto fb-core 2026-07-22, P1-3)

The Vendors tab runs the **same interaction model as Bills** — it was previously a one-off cell-cursor design (`hjkl` cell movement, per-cell edit with `d`/`~` verbs and a stale hand-written hint claiming "hjkl navigate" while `h/l` actually switched tabs). The migration adopted the Bills model wholesale rather than porting the cell model onto fb-core.

### NORMAL mode

| Key | Mouse | Action |
|-----|-------|--------|
| j / k | Click row | Move row selection (sticky at top/bottom, never deselects) |
| gg / G | — | First / last row |
| Enter or i | Double-click row | Enter INSERT (row-level edit) |
| a | — | New vendor row at bottom, immediately in INSERT |
| x | — | Delete vendor (unsaved row drops silently; saved vendor asks `confirm()`) |
| ~ | Double-click ACTIVE badge | Toggle active/inactive (saved vendors only) |
| h / l | Click tab | Switch Bills ↔ Vendors (NOT bound by the tab — falls through to common.js, same as Bills) |

### INSERT mode (row-level — the whole row becomes inputs)

Pressing `i`/`Enter`/double-click converts **all five editable cells at once** (Vendor, CCY, Terms, Expense A/C, AP A/C) into uniform 32px `.draft-input` fields; the ACTIVE badge stays read-only. This mirrors Bills' bill-level INSERT ("isn't it simpler to reuse full edit rather than specific line edit?").

- **Tab / Shift+Tab** traverse the inputs (native); **sticky at the ends** — Tab on the last input (AP) and Shift+Tab on the first (name) stay put, no accidental focus escape.
- **Esc saves** — the only save trigger, same doctrine as Bills (no cancel path). Validation: name required (red `.req` border + message, stays in INSERT); CCY checked against the currency list. On server error the row stays in INSERT with inputs untouched.
- **Empty new row + Esc discards** (never creates something from nothing).
- **Enter also saves** (form convention; matches the pre-migration Enter-commit).
- **Click-away saves**: clicking another row with an edit open saves first, then selects the clicked row. The async save does NOT reset `vendorSelRow` — the cursor stays where the click moved it (a completion-handler stomp that yanked it back was fixed on day one).
- **Leaving the tab** (h/l/{/}) with an edit open saves-or-discards it first (`showPayTab` calls `vendorSaveAndExit()`).
- **Autocomplete dropdowns** (CCY, both account fields): ArrowUp/Down navigate, Enter selects, Tab selects-and-stays, Esc closes the dropdown only (a second Esc saves the row). Dropdown-aware bindings precede general ones — FB.keys takes the FIRST key+mode+`when` match.
- j/k/a/x/~ are inert in INSERT (letters type into inputs, per the editable-target guard and mode-scoped bindings).

### Mechanics

- Mode is the shared `FB.mode` store; keys are the `FB.keys` binding table `'vendors'` (sidebar hints are generated from it — the static `_VENDOR_HINTS` list is gone).
- Save path: `vendorSaveAndExit()` → validate → `vendor.upsert` → `_renderVendorRowDisplay()` rebuilds just that row (keeps the list stable, no full re-render flash). `_vendorSaving` guards re-entrant Esc during the flight.
- The old cell-cursor machinery is deleted: `vendorSelCol`, `vendorCellEdit`, `vendorCellPreEdit`, `enterVendorCellEdit`/`commitVendorCell`, `vendorMoveRow`/`vendorMoveCol`, per-cell save-on-nav (`vendorDirtyRows`), and the `VENDOR_KEYS` capture listener.
- `window.fbVendorSelRow` is still maintained — common.js's j/k deferral reads it.

## FB.dropdown — unified validated autocomplete (PROPOSED 2026-07-22, not yet implemented)

### Problem

Three dropdown mechanisms are in play, and the Bills INSERT row itself mixes all of them:

| Mechanism | Where | Issue |
|-----------|-------|-------|
| Native `<datalist>` | Bills INSERT AP/expense accounts (`coa-options`), Settings currency list, Bank account code | Popup is browser chrome: unstylable, ignores the app theme, eats ArrowUp/Down/Enter/Esc **before** FB.keys sees them (bypasses the binding table), and does not render at all in headless Chrome (verified 2026-07-22: standalone page, focused input, ArrowDown — no popup) → unverifiable in the contract-test workflow |
| Native `<select>` | Bills child-line VAT code, plus ~12 configuration pickers | OS-rendered popup; prefix-only type-ahead, no substring/code+name search — unusable for a large COA inside a keyboard-first row |
| Custom div dropdowns | 9 copies in 3 visual dialects: Payables (square, `#e8f0fe`), Journal/bill-new (4px radius, `#f0f4ff`, flex code+name), Bank (CSS class, 3px radius, 180px max-height) | Work correctly with FB.keys, but are 9 hand-rolled copies with divergent styling, item caps (10/12/15/20), and filter logic |

### Decision

**One app-specific component: `FB.dropdown` (in fb-core.js, styled from common.css).** Native `<datalist>` is eliminated entirely. Native `<select>` is retained **only** for configuration UI (report type/period, FX provider, import column maps, journal pickers, COA type/subtype/cash-flow, rec-account) — low-frequency, mouse-first, not part of keyboard data entry.

### Visual contract

- Container `.fb-dd`: `position:fixed`, app surface/border tokens, square corners, shadow token, `z-index:9999`, `max-height:200px`, `overflow-y:auto`, font matching the input, `min-width` = input width (160px floor for narrow inputs like CCY).
- Item `.fb-dd-item`: uniform padding token, `white-space:nowrap`, `cursor:pointer`. Coded entities render two-part: primary (code, semibold) + secondary (name, muted). Single-string entities (vendor names) render primary only.
- Active item `.fb-dd-active`: theme-aware accent background (replaces hardcoded `#e8f0fe` / `#f0f4ff`; must hold up under both ☀ themes).
- **All styling via CSS classes.** Inline `cssText` dropdown styling is deleted — that is what makes the component themeable.

### Behavior contract

- Opens on `input` when ≥1 match; closes on 0 matches or empty query. At most one dropdown open app-wide; opening closes the previous.
- **ArrowDown on a focused, attached field with no dropdown open shows the full list** (capped at 12) — faster discovery without typing.
- Filter: case-insensitive **contains** match on both code and name. Uniform cap of **12** items.
- Keyboard routes through FB.keys with `when: ddOpen` guards; dropdown bindings precede general INSERT bindings (FB.keys takes the first key+mode+`when` match):
  - **ArrowUp/Down** — move the active item, **sticky at both ends** (no wraparound; cursor doctrine).
  - **Enter** — pick active item (or first when none active), close. Does not advance focus.
  - **Tab** — pick active item, close, then native traversal continues (**pick-and-advance** — decided 2026-07-22).
  - **Esc** — closes the dropdown only; a second Esc performs the normal INSERT-exit save.
- Mouse: hover sets active; `mousedown` preventDefault (input keeps focus); click picks; click-outside and 150ms blur close.
- Selection side-effects (e.g. vendor pick → fill CCY/AP/expense defaults) live in page-level `onPick` callbacks, never in the component.

### Validation semantics

- **Strict fields** (vendor): value must come from a pick or exact match; free text blocks save with a status-bar error (current behavior, unchanged).
- **Code fields** (accounts, currency, tax code): free text tolerated while typing; validated at save against the source list; invalid → red `.req` border + message, row stays in INSERT.

### API

```
FB.dropdown.attach(input, {
  source: function(query) -> [{ primary, secondary, data }]   // sync, from preloaded lists
  onPick: function(item, input),
  cap: 12,                                                     // optional
  keys: true                                                   // optional — self-bind ArrowUp/Down/Enter/Tab/Esc on the input
})                                                            // (for pages without FB.keys; FB.keys pages wire via bindings)
```

Attach once per input at row build. The popup div is created on demand and removed on close; instances are tracked by reference (no global `getElementById` lookups).

### Migration order

1. **P2-1a** — `FB.dropdown` + common.css tokens. Bills INSERT: vendor dd, CCY dd, AP/expense accounts (delete `coa-options` + `_ensureCoaDatalist()`), child-line VAT `<select>` → dropdown.
2. **P2-1b** — Vendors tab CCY + account dropdowns → component (near-mechanical; same dialect).
3. **P2-1c** — journal-new `acct-dd`, bank `.acct-dd`, bank-import `bankAcctDropdown`, Settings `currency-list` datalist, Bank account-code datalist → component. Dialects B and C deleted. **bill-new.js is excluded — its dropdowns are rebuilt by the P1-4 full-page editor (decided 2026-07-22).**

### Testing contract

The popup is plain DOM — headless-verifiable, closing the verifiability gap that datalist created. Per migration step, contract tests assert: open/filter on input, active-class movement with sticky ends, Enter pick, Esc layering (dd first, row save second), click-away close, and theme token presence.

---

## P1-4 — Full-page bill editor (DRAFT 2026-07-22, for magnus review — NOT yet implemented)

### Purpose

Two creation paths, one editor core:

| Path | For | Surface |
|------|-----|---------|
| **Tree-table INSERT** (existing, default) | Common bills: 1–3 lines, no attachments | Payables → Bills, `o` |
| **Full-page editor** (this section) | Complex bills: many lines, attachments, per-line VAT review | `+ Bill` toolbar link, `O` (shift-o) from Bills tab, dblclick on a draft's "edit" affordance |

The full-page editor is the **escape hatch, not a second philosophy**. Same modes, same verbs, same endpoints, same validation authority. Anything the tree-table can do, the editor does identically; the editor adds only what the tree-table structurally cannot (attachments, long line lists, comfortable per-line VAT review).

### Relationship to existing pages

- **`bill-new.js` is deleted** when this ships (its capabilities migrate or are deliberately dropped — see Elimination inventory below).
- **`bill-detail.js` remains** the read/management surface for posted documents (void, payments, attachment view). The editor handles drafts + create; posted bills are never editable (append-only doctrine — corrections via void/rebill).
- One shared editor component used for **create-complex** and **edit-draft** (`i` on a saved draft may open the editor instead of inline edit when line count > N — threshold decided below).

### Layout (three zones + status bar)

1. **Header card** — vendor (FB.dropdown, strict-validated), bill date, due date (auto from vendor payment terms, overridable), vendor ref, CCY (FB.dropdown; FX rate hint in the **status bar** on Enter — Phase 2d doctrine, no FX input field anywhere), AP account (FB.dropdown, default vendor → company → blank).
2. **Lines table** — one row per line: description, expense account (FB.dropdown), amount, VAT code (FB.dropdown), GST amount (auto-computed, overridable — supplier-stated doctrine, tolerance warning at post). Row ops mirror the tree-table: `a` add line below, `x` delete line, `+` icon on last row (gray/faded when empty). No separate GST rows (bill-new's syncGstRow pattern dies).
3. **Attachments panel** — list + upload + delete (the capability the tree-table lacks; reuses `/api/upload` + `attachment.list`/`attachment.delete`).
4. **Status bar** — totals (net / GST / gross, server-computed at save), FX rate hint, validation errors naming every missing field.

### Interaction model (identical semantics to the tree-table)

- Page loads in **INSERT mode** (it IS an editing surface); fields focused in traversal order; Tab/Shift+Tab traverse header → lines (Tab from last line's last field adds a line if current has data, sticky if empty).
- **Esc saves and returns** to the Bills tab (sole save trigger; empty bill discards). Draft first (`bill.draft.save`), then the Bills tab reflects it.
- **Posting is deliberate and separate**: `p` posts from the editor (direct — `bill.create` for new, save-then-`bill.draft.post` for existing drafts). Server validation errors render in the status bar; editor stays open.
- `h/l` — NOT bound (fall through to shell tab switch; an unsaved bill prompts save-or-discard via the same tab-switch guard as Vendors).
- All dropdowns FB.dropdown with `keys` via the page binding table (dropdown bindings precede general INSERT bindings).
- Hints in `#sb-hints` generated from the page's binding table.

### Data flow

- **Load (edit-draft):** one `view.bills`-style read — bill header + embedded lines (reuse `bill.lines` shape; add `view.bill` only if attachments + header justify it).
- **Save:** `bill.draft.save` (server computes totals from lines — P2-4 closes the client-total trust gap; the editor NEVER sends `bill.amount`).
- **Post:** `bill.create` / `bill.draft.post`; FX resolved server-side from master data at post (no rate input, no fetchRate machinery).
- **VAT:** per-line GST amount editable (supplier-stated, tolerance-warned at post — warnings render in the status bar, never swallowed).
- **Attachments:** after first save (bill_id exists), uploads bind to the draft; unsaved-new bills stage files client-side until first save (mirrors bill-new's reenter flow, minus its FX hackery).

### Elimination inventory (bill-new.js — what dies and why)

| bill-new.js feature | Fate | Reason |
|---------------------|------|--------|
| Manual FX rate input + fetchRate/fetchAndRetry/maybeFillReenter | **Deleted** | Phase 2d doctrine: rate from master data at post; override = Settings → Exchange Rates |
| Client-side `rebuildJournals()` preview | **Deleted** | Direct-post doctrine (preview was compensation, not safety); server validates at `p` |
| Dialect-A account/vendor/currency dropdowns | **Deleted** | FB.dropdown everywhere (P1-7) |
| syncGstRow separate GST rows | **Deleted** | GST lives ON the line (tree-table pattern) |
| Attachments panel | **Migrates** | The one capability worth keeping — rebuilt in the editor's zone 3 |
| Form-style page chrome (`rem` typography, card styling) | **Deleted** | Editor uses app tokens/pt, sidebar, hints chrome |

### Decisions (magnus, 2026-07-22)

1. **Entry points:** `+ Bill` toolbar link → the editor (create path). `o` in the Bills list stays the default quick path (tree-table INSERT). `O` (shift-o) from the Bills tab → editor, new bill.
2. **`i` always stays inline** (no line-count threshold). Editor entry for an existing draft: **`I` (shift-i)** on the focused draft row. Mouse parity (answering "do mouse users always get the editor?"): **no** — double-click = inline (mirrors `i`); a hover pencil affordance on draft rows = editor (mirrors `I`), same hover-icon pattern as the delete affordance, no always-visible chrome.
3. **Attachments on unsaved bills stage client-side** until the first save binds them (bill-new's reenter behavior, minus its FX hackery).
4. **Per-line cost/profit centers: INCLUDED** (reversing the draft's skip). The ledger already carries them — `journal_entries.cost_center/profit_center`, bill-header fields, `centers` master data, and `createBill` threads header centers into journal lines. Editor adds a per-line center column (FB.dropdown over `center.list`, default from header, overridable); backend extends the `draft_lines` line shape with `cost_center`/`profit_center` and maps line-level centers onto journal lines at post (falling back to header centers when a line has none).
