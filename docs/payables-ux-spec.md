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
