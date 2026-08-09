# Payables UX Specification

> **2026-07-24 rev. 4 — Bills migrated onto `FB.list` (`tree: true`).** The bespoke Bills interaction machinery (render/draft/filter/nav/fold) is deleted; the Bills tab is now a declarative `FB.list.create(cfg)` call. This spec's Bills-specific sections now describe the framework-native behavior (see `fb-list-ux-spec.md`). The bill editor screen (`bill-edit.js`) and the bill-detail page remain separate. The pre-interim "Esc always saves / no cancel path" doctrine is **superseded** — `Esc` never saves; `w` is the only save path (FB.list §3 doctrine).

## Design Principles

1. Two modes only: NORMAL (browsing) and INSERT (editing). No ambiguous middle state.
2. Every keyboard action has a mouse equivalent and vice versa. No interaction requires both. No interaction is available through only one input method.
3. NORMAL mode is row-oriented (vim line semantics). INSERT mode is bill-oriented — the entire draft bill (parent + all child lines) opens for editing simultaneously.
4. Save timing is unambiguous: `Esc` never saves — it exits INSERT only. `w` is the only save path (one `bill.draft.save` carrying header + all lines). `u` reverts. No blur-chasing, no timers, no deferred checks. (FB.list §3 doctrine, adopted 2026-07-24.)
5. Per-line accounts: each child line carries its own expense account; the parent row carries the AP (creditor) account. Both use COA datalist autocomplete.
6. Tax-exclusive entry: the user types the net amount per line; VAT is computed on top from the line's VAT code — lines carry no VAT amount state. The only override surface is the bill-level stated VAT (editable footer cell, agreed 2026-07-26).

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
| Enter | Double-click row | **Edit** — whole-bill INSERT on drafts (no-op on posted bills); create on the `+ Add bill` row |
| Space | Click ▸/▾ fold icon on parent | **Fold** — toggle the fold of the bill under the cursor (parent folds itself; a child folds its parent); inert on the add row (vim fold semantics) |
| i | Double-click editable row | Enter INSERT mode (opens entire draft bill for editing) |
| I | — | Open the focused draft bill in the full-page editor (`bill-edit.js`); no-op on posted bills |
| a | — | Append new child line to the focused draft bill |
| x | Click delete icon (on hover) | Delete draft bill / delete current child line / void posted bill (confirm) / void payment (on a payment-history child) |
| p | Click "Post"/"Pay" affordance | Post draft bill directly (no preview step); on posted/partial bills open the inline pay row |
| G | Scroll to bottom | Jump to last row (= add row) |
| gg | Scroll to top | Scroll to top |
| Esc | — | No-op (already in NORMAL) |

`o`/`O` are **retired** on Bills (2026-07-24) — the `+ Add bill` row is the only create path; the full-page editor is reached via `I` or the ref-link / double-click.

Row selection highlights the complete row (parent or child). No cell-level cursor in NORMAL mode.

**Keyboard hints live in the left sidebar** (`#sb-hints`, below the nav, above the footer) — moved there 2026-07-22 from a footer bar under the table, which keyboard users never saw (the page never scrolls that far with keypresses). The panel is **generated from the same FB.keys binding table that drives dispatch** (`FB.keys.renderHints(name, el, {layout:'list'})`), one `kbd`-chip row per hint, so hints cannot drift from behavior. Pages/tabs render their own set: on Payables, `showPayTab` swaps the panel between Bills (generated) and Vendors (static list until the Vendors tab migrates onto FB.keys). The panel hides when the sidebar is collapsed and on pages that render no hints.

j/k navigation crosses bill boundaries seamlessly:
- On last child of a bill, j moves to next bill's parent (or first child if that bill is expanded)
- On first child of a bill, k moves to previous bill's parent (or last child if that bill is expanded)

### INSERT MODE (editing one bill)

| Key | Mouse | Action |
|-----|-------|--------|
| Tab | Click cell in bill | Move to next editable cell (sticky at the ends) |
| Shift+Tab | Click cell in bill | Move to previous editable cell |
| Enter | — | Move to next input within the bill (sticky at the last field; never saves) |
| Esc | — | Exit INSERT only — **never saves**; the dirty bill stays (amber). `w` persists. |
| w | Click 💾 chip | Write the whole bill (header + all lines) in ONE server write — the only save (read, dirty state) |
| u | — | Revert the whole bill to saved values (read, dirty state) |
| x | — | On a dirty-new bill, discard it — cursor → add row |
| (all other keys) | — | Type into the focused input (h/j/k/l/{/}/a/o/x/p/G/gg all inert) |

**Dirty bill = amber.** The framework's whole-bill dirty buffer (keyed by the parent `_key`) carries the header + every child line as one unit; the bill (parent + its open children) renders amber until `w` or `u`.

Entering INSERT mode (via `i`/Enter on any row of a draft bill):
- **All** editable cells on the bill are rendered as inputs (parent fields + child fields) and the framework enters INSERT mode (`FB.mode`); focus lands on the first parent input (partner).
- h/j/k/l/{/} are inert (they type into inputs).
- Tab/Shift+Tab move between cells across the entire bill (parent → children).

**New (unsaved) drafts:** activating the `+ Add bill` row (Enter/click) transforms it in place into the whole-bill INSERT unit — parent + first child rendered as inputs, fold open, focus on the partner input — and enters INSERT mode.

**Saved drafts (status='draft', already in DB):** `i`/Enter on a draft (parent or child) re-enters the whole-bill edit unit — the parent + its open children re-render as inputs pre-filled with saved values, draft lines re-fetched from the server. The framework's whole-bill dirty buffer carries header + every child line as one unit.

Exiting INSERT mode (Esc; or click-outside — see below):
- Esc **never saves.** It exits INSERT only; every input across the parent + open children is harvested into the framework's whole-bill dirty buffer (keyed by the parent `_key`) and the bill re-renders as display text marked dirty (amber).
- If the bill is completely empty (framework `isBlank`), it vanishes instead — cursor → add row.
- The dirty bill stays until `w` (write — the only save, one `bill.draft.save` carrying header + all lines) or `u` (revert).
- Returns to NORMAL mode with selection on the parent row.

Posted bills: `i`/Enter and double-click are no-ops (the framework's `editable` predicate is false). The row is read-only. No INSERT mode is entered.

### Tab Behavior at Bill Boundaries

Tab navigates across all editable cells in the bill. The forward flow for a bill is:

**Parent:** partner → date → due → ref → **first child:** description → expense account → amount → VAT code select → **next child:** description → … → last child VAT code select → **footer:** stated-VAT cell

(The parent's total and CCY are read-only in edit — the total is computed from the lines and CCY follows the picked partner. AP/expense accounts default from the partner pick and travel on the partner input's dataset; they are not row inputs.)

- **Forward Tab on the last child's last field (VAT code select):** focus moves to the bill footer's stated-VAT cell. **Forward Tab on the stated-VAT cell:** if the current child has data (description or amount), a **new child row is created** (`createDraftLine`) and focus moves to its description input. If the child is empty, Tab stays (sticky — no empty rows created).
- **Shift+Tab** flows in reverse. On the first child's description field, focus moves back to the parent's last input (vendor ref).

This keeps the user inside the bill editing flow. Creating a new line is natural — just Tab past the last field. No need to Esc → `a` → `i` to add a line.

### Click-Outside (Mouse Esc Equivalent)

When a mouse user is in INSERT mode and clicks another row, the bill exits INSERT (Esc equivalent — **never saves**; the dirty buffer stays, amber) and the clicked row is selected (j/k equivalent). No intermediate NORMAL state should be visible; the dirty bill remains until `w`/`u`. This is the framework's leave-guard parity: click-away does not silently persist.

### Esc never saves; `u` reverts (FB.list §3 doctrine)

Esc exits INSERT only — it never persists. The dirty bill stays (amber) until `w` (the only save, one `bill.draft.save` for the whole bill) or `u` (revert to saved values). `x` on a dirty-new bill discards it (cursor → add row). This is the framework-native doctrine shared by every FB.list screen (see `fb-list-ux-spec.md` §3); the pre-interim "Esc always saves / no cancel path" doctrine is superseded (2026-07-24).

### Empty Bill Discard

If Esc is pressed on a completely empty draft (no partner, no date, no child data — framework `isBlank`), the draft vanishes rather than entering the dirty state — cursor → add row. This prevents empty draft rows from accumulating.

## List Display (NORMAL Mode)

- **Dates are compact:** the year is elided when it is the current calendar year ("21 Jul"); prior/future years show the full date ("15 Dec 2025"). The full ISO date is in the cell's `title` (hover tooltip). Numeric-only formats were rejected (locale-ambiguous for a multi-jurisdiction app); the month-name form stays. (Agreed 2026-07-21.)
- **Column widths are weighted** via `<colgroup>` (fixed layout), with all weights owned by CSS `col.col-*` classes — never inline styles or JS width juggling — so the `.single-ccy` state can re-weight cleanly: VENDOR 22%, DATE 12.5%, DUE 12.5%, REFERENCE 15%, AMOUNT 14%, CCY 9%, STATUS 15%. Vendor carries the most information; CCY needs the 3-letter code plus header affordances (CCY was widened 7→9% on 2026-07-22: at 7% the corner-pinned filter icon overlapped the "CCY" label at ≤1400px viewports).
- **CCY column is conditional** (agreed 2026-07-21): when every visible bill shares one currency it carries no information, so it is hidden via `visibility:collapse` on the `<col>` (space reclaimed, column-track mapping preserved — `display:none` would slide later columns into the wrong track; the CCY th also gets `visibility:hidden` because Chrome leaks the absolutely-positioned filter icon out of a collapsed column) and the other columns absorb the width via the `.single-ccy` re-weighting rules. It returns automatically in INSERT mode (the CCY input lives there) and whenever the list is mixed. Recompute is DOM-driven (`_refreshCcyVisibility`) so in-place row removals (x), Esc-save conversions, and re-renders all stay correct. **Exception (2026-07-22): the column never hides while a currency filter is active** — the column's ≡ is the only way to see and clear that filter; hiding it trapped users (a reload was needed to get foreign bills back). With the filter active the column stays, showing the blue filtered ≡; clearing re-hides if the unfiltered list is single-currency.
- **Child-row VAT code select sits in column 7 (under STATUS)**, not under CCY (moved 2026-07-21 so the CCY column can hide cleanly); the `+` add-row icon lives in the column-6 spacer cell (`td.child-spacer`).
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

- **Partner input** (`.draft-partner-input`) — free-text with dropdown autocomplete; selecting a partner sets `data-partner-id`, `data-partner-name`, `data-ap-account`, and `data-expense-account` from partner master data.
- **Total** (`.draft-total-amount`) — read-only text showing the gross amount (net + GST), updated live by `updateParentDraftAmount`. Not an input, so Tab skips it.
- **AP account input** (`.draft-ap-account`) — COA datalist autocomplete (`list="coa-options"`). Pre-filled from partner default > company default > blank.
- **Save chip** (💾, the `w` verb's mouse affordance) — in the STATUS column. Grayscale/faded when the bill is completely empty; full colour when any field has data. Clicking writes the whole bill (one `bill.draft.save`). Esc never saves.

### Child Row

| Description (colspan=3) | Expense Acct | Amount | VAT Code | [action] |
|-------------------------|--------------|--------|----------|----------|
| Description input | Expense account input (COA datalist) | Amount input (number) | VAT code select | add-row icon (+) on last child |

- **Description** (`.child-desc`) — `colspan=3` (reduced from 4 in earlier versions to make room for the expense account column).
- **Expense account** (`.child-expense-acct`) — COA datalist autocomplete (`list="coa-options"`). Pre-filled from partner default > company default > blank.
- **Amount** — numeric input; the net (tax-exclusive) amount for the line.
- **VAT code** (`<select>`) — dropdown of active VAT codes, plus "— None —".
- **Add-row icon** (+) — appears only on the last child row. Fades when that row is empty. Clicking creates a new child line (`addRowFromIcon` → `createDraftLine`).

## Parent Total (Gross = Net + GST)

The parent row's AMOUNT cell shows the gross total (sum of each line's net + computed VAT; when a stated VAT total is entered in the bill footer, gross = net + stated). This is computed identically in four contexts (the bespoke functions are gone; the framework hooks carry the same formula):

| Context | Where it lives | Formula |
|---------|---------------|---------|
| Live display during INSERT editing | `updateParentDraftAmount` (child renderer input/change handler) | Σ (net + GST) over child rows |
| Save payload (`totalAmt`) | `cfg.save.body(bill)` (`w` verb → `bill.draft.save`) | Σ (net + GST) over child rows |
| Direct-post payload (`totalAmt`) | Bills `p` extraBinding → `bill.create` body | Σ (net + GST) over child rows |
| Display after saving | `cfg.list.map` (re-render from server row) | Σ (net + GST) over child rows |

GST is computed from each line's VAT code (no per-line VAT amount input; see [VAT/GST Handling](#vatgst-handling) below). Reverse-charge lines are computed-only and excluded from the user-facing total (the backend self-assesses them separately).

## Account Defaults (3-Tier Precedence)

Both the AP account (parent) and the expense account (per child line) are resolved with a three-tier fallback:

1. **Partner default** — from partner master data (set when a partner is selected in the dropdown; stored on the partner input's `data-ap-account` / `data-expense-account`).
2. **Company default** — from Settings (`default_ap_account`, `default_expense_account`), loaded on page init into `companyDefaultAp` / `companyDefaultExpense`.
3. **Blank** — no default; validation surfaces a clear "account is required" error.

The framework's column `display`/`attach` hooks emit `data-expense-account` and `data-ap-account` on each parent row's HTML for saved bills. `saveDraftBill` (backend) applies company defaults as a safety net via `applyCompanyDefaults` before persistence. A blank account produces a "required" validation error (not "does not exist in COA").

## VAT/GST Handling

**Scope gate (2026-07-27):** when the company's `vat_registered` flag is **false**, none of this section's UI renders (settings-ux-spec §7 item 9) — and the server posts no tax lines regardless.

### Tax-exclusive entry
The user enters the **net** amount per line. VAT (GST) is computed on top: `expectedVat = Math.round(amount × rate × 100) / 100`. Lines carry **no VAT amount state** — the only per-line tax field is the VAT **code** select. (Redesign 2026-07-26: the per-line GST amount input and its auto-compute/override machinery were removed.)

### Bill footer: one row per VAT code (NORMAL + INSERT)
The bill renders **one footer row per VAT code** used on its lines, in BOTH read-only (fold open) and edit mode (revised 2026-07-26 per review):
- The row label is the code + its description (e.g. `SE25: Standard rate 25%`); the amount is that code's VAT (posted bills: the posted grouped tax line; drafts: computed). Two codes → two footer rows.
- When a stated VAT total exists, the rounding delta is applied to the largest standard code's row (mirrors the posting rule) so the footer rows always sum to the stated total.
- Reverse-charge codes appear as their own rows (self-assessed — never part of the gross owed to the vendor).
- Net/Gross are not repeated in the footer: gross lives on the parent row's AMOUNT cell. (The full-page editor has no parent row, so it keeps its Net/Gross readout.)
- There is no tax-lines drill-down — the per-code footer rows ARE the tax display.

### Stated-VAT cell (INSERT only)
Edit mode adds ONE editable row (`.bill-vat-stated`) after the per-code rows: pre-filled with the computed total (Σ per-line `amount × rate` over standard codes); typing the VAT total from the supplier's invoice makes it *stated* (amber; sent as `vat_amount_stated`); clearing returns it to computed. This is the **only** VAT override surface — there are no per-line VAT amounts (agreed 2026-07-26). Tab flow: last child's VAT code select → stated-VAT cell → (Tab again) new child row's description — the cell sits in the chain and is never a dead end.

### Tolerance check (backend)
When `vat_amount_stated` is provided, the backend compares it to the computed VAT total (non-reverse-charge lines only):

```
tolerance = max(flat, pct × expectedVatTotal)
```

- If `|stated − computed| > tolerance`, a **warning** is added (does NOT block posting), e.g.:
  > Stated VAT 12.00 differs from computed 11.50 by 0.50 — verify supplier invoice
- If within tolerance, no warning.

**Settings** (Company tab, unchanged):
- `vat_tolerance` — flat amount in home currency (default `0.50`)
- `vat_tolerance_pct` — percentage of expected VAT, `0.01` = 1% (default `0.01`)

### Journal entries (backend)
- **Standard VAT:** one DR to the VAT code's input account **per VAT code** (grouped across lines; previously per expense line) — the per-code split is what per-rate / GST-return reporting reads, so codes are never merged into one lump. If stated ≠ computed, the rounding delta is added to the **largest** tax line by computed amount (agreed 2026-07-26) so the journal always sums to the stated total. The delta is allocated **only among standard (non-RC) lines with computed VAT > 0**; if no such line exists (e.g. all lines zero-rated/exempt), the stated amount is ignored and a warning is emitted — a stated VAT total on an all-zero-rated bill is almost always a wrong-code data-entry error. With one stated total and multiple taxable codes the true per-code split of a variance is unknowable; largest-line allocation keeps any per-box misstatement bounded by the tolerance check.
- **Reverse charge:** DR input VAT + CR output VAT per RC code (net zero), always the computed amount — RC lines never absorb stated-VAT deltas (self-assessed amounts must be exact). No per-line RC UI exists anymore; the pairs appear as per-code footer rows.
- One DR to the expense account per line (debit = net amount).
- One CR to the AP account for the total (net + VAT).
- The tax GL account comes **only** from the VAT code (`vat_codes.vat_account_input` / `vat_account_output`) — per-line account overrides are removed (agreed 2026-07-26).
- One shared server-side tax-line generator serves both the bills path and the generic journal path (`vat.js`) — no parallel tax math.

### API / migration
- `bill.lines[].vat_amount_override` and `bill.lines[].vat_account_override` are removed from the payload; the server ignores them if sent.
- New optional header field `vat_amount_stated` (number | null) on `bill.create` / `bill.draft.save`.
- Legacy drafts (`bills.draft_lines` JSON holding per-line overrides): on first save after upgrade, Σ(override ?? computed) becomes `vat_amount_stated` when it differs from the computed total — no legacy override is silently lost.

## Posting Flow

### Direct post (no preview)
Pressing `p` posts the bill **directly** — no preview step, no confirmation dialog. The backend validates; on error, the draft remains intact.

The `p` verb (Bills `extraBinding`) routes to one of two server actions depending on the bill's state:

1. **Inline unsaved draft (no `bill_id`):** the framework's whole-bill buffer is gathered by the `p` handler, client-side guards run (partner, date, due date ≥ date, ref, amount > 0, at least one line), then it sends `bill.create` (creates AND posts in one call).

2. **Saved draft re-edited (has `bill_id`):** saves the draft first (`bill.draft.save` via `cfg.save.body`), then sends `bill.draft.post` which delegates to `createBill` with `_replaceDraftId`.

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
- Bill list reloads (framework `cfg.list` re-fetch via `billsList.load()`)

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
When the mouse hovers over the CCY cell (in both INSERT and display modes) and the currency is non-base, the tooltip shows the rate (e.g. "USD → SGD: 1.34"). The tooltip updates when the date or currency changes. If no rate exists, the tooltip says so. The framework's column `display`/`attach` hooks populate these tooltips asynchronously for display rows.

### Enter on CCY (keyboard users)
In INSERT mode, pressing Enter on the CCY input when a non-base currency is entered shows the FX rate in the status bar (e.g. "FX: 1 USD = 1.34 SGD"). If no rate exists, the message indicates this.

## Foldable Rows

### Fold Toggle (Space — vim fold semantics)
- Space (keyboard): toggle the fold of the bill under the cursor — on a parent it folds that bill; on a child it folds the parent; inert on the add row. (Enter is **edit**, not fold — see NORMAL table.)
- Click ▸/▾ icon (mouse): toggle fold on that parent
- Clicking the parent row body (not the icon) selects the row — does NOT toggle fold

### Fold Behavior
- **Expand:** children render from the framework's per-`_key` child cache — drafts render the in-memory dirty buffer's child array; saved bills lazy-fetch `bill.lines` (+ `bill.payments` for paid/partial) on first unfold and cache. Parent gets the fold-open indicator (▾).
- **Collapse:** removes child rows from the DOM. Parent loses the open indicator. If the cursor was on a child, it moves to the parent.
- Framework child cache: once fetched, children are cached by the parent `_key`. Subsequent unfolds render from cache instantly. The cache invalidates on save/post.

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
- Mouse was the last input (keyboard activity suppresses hover — the framework drops hover styling while keyboard nav is active)

When the keyboard is used (j/k/etc), hover is suppressed. When the mouse is moved, hover is re-enabled. This prevents the white hover background from conflicting with the cursor highlight during keyboard navigation.

## Cursor Model

*(2026-07-24: the bespoke `cursor` object is deleted — `FB.list`'s `nav` owns row focus; `FB.mode` owns mode. The notes below map the old behavior to where it now lives.)*

- Mode is the shared `FB.mode` store; the framework's edit-lifecycle toggles the `insert-mode` class on the tbody on enter/exit. (The legacy `cursor.mode` getter/setter is gone.)
- Row focus is the framework's `nav` cursor — `nav-row-focus` on the focused `<tr>` (config `focusClass`), moved on j/k, cleared/re-applied by the framework on tab switch.
- Keyboard-vs-mouse hover suppression is the framework's standard behavior (hover highlight is dropped while keyboard nav is active).
- Tab switching (`showPayTab`, retained as the tab shell) re-applies the framework cursor on the Bills tab and scrolls to the last position.
- Per-cell Tab positioning is internal to the framework child-renderer's Tab wiring; NORMAL mode is row-only selection (no cell cursor).

## Removed / Simplified

The following elements from earlier implementations are removed or simplified:

| Removed | Reason |
|---------|--------|
| Cell-level cursor in NORMAL mode (h/l within row) | Row-only selection; h/l reserved for tab switching |
| `fbBillCursorMid` flag | No longer needed; h/l always means tab switch |
| `bill-cell-focus` CSS (dark blue cell highlight) | No cell cursor in NORMAL mode |
| `autoSaveDraftIfReady` 200ms timer | Save is explicit (`w`), never on blur (2026-07-24: Esc never saves) |
| `autoSaveChildRow` | Same — save is explicit, not on blur |
| `enterBillCellEdit` / `exitBillCellEdit` | Per-cell editing replaced by bill-level INSERT |
| `billEditState` object | No longer needed without per-cell edit |
| `dd` double-tap delete | Replaced by single `x` key |
| `dd` double-tap timer (`_ddPending`, `_ddTimer`) | No double-key sequences except `gg` |
| `za/zo/zc/zR/zM` fold keys (dead code) | Never implemented; Enter/Space used instead |
| `:w` save command (`fbCmdDispatch`) | `w` is the save verb; no command bar needed |
| `~` hidden shortcut | Removed; use `p` to post |
| `_expandAll` / `_collapseAll` | Removed; no bulk expand/collapse |
| Preview step (`_enterPreview` / `_exitPreview` / `_renderPreviewLines` / `_confirmPost`) | Removed; direct post on `p` |
| `bill.draft.preview` backend endpoint | Dead code; frontend no longer calls it |
| Popup posting (`openPostReviewPopup` / `confirmPost` / `closePostReviewPopup`) | Removed entirely |
| Blur-chasing save timers | Save is explicit (`w`), never on blur/click-away |
| j/k boundary blocking | Seamless navigation across bill boundaries |

## Implementation Notes

*(2026-07-24: the bespoke machinery below is deleted — Bills runs on `FB.list` (`tree: true`). Behavior now lives in the framework + the Bills `cfg` in `payables-bills.js`. Notes retained as a map to where each behavior now lives.)*

- Whole-bill INSERT is the framework's tree edit unit — `cfg.blank()` (new drafts: parent + first child, fold open, partner focus) and re-entry on a saved draft via the `editable` predicate + re-render of inputs. Both render parent + children with all inputs simultaneously.
- Tab navigation (forward Tab on the last child's last field spawns a new line; Shift+Tab on the first child's desc goes to the parent's last input — partner ref) is now the framework child-renderer's Tab wiring.
- Save is the `w` verb → `cfg.save.body(bill)` — one `bill.draft.save` carrying header + all lines, the only save path. Esc never saves.
- After save, the framework re-renders the bill from `cfg.list.map` (display text); the dirty buffer is dropped.
- Direct post (`p` verb) routes to `bill.create` (inline unsaved drafts: create+post in one call) or `bill.draft.save` → `bill.draft.post` (saved drafts), via the Bills `extraBindings` `p` handler.
- Account autocomplete (AP + expense) is the column `attach` hooks (FB.dropdown over the COA); the shared `coa-options` datalist is gone.
- `updateParentDraftAmount` (live parent total) runs from the child renderer's input/change handlers.
- VAT recompute (`_recomputeChildVat`) stays — computed from the line's VAT code (no per-line amount state); called from the child renderer / line sync. Stated-VAT override lives at the bill footer (`.bill-vat-stated`), not per line (redesign 2026-07-26).
- j/k dispatch is owned by the framework's `FB.keys` registration (`'bills'`, capture phase); common.js's bubble handler is no longer reached for Bills. The `fbBillNav` capture-phase special-case in common.js is removed (2026-07-24) — the standard key dispatch path now applies to Bills like any other FB.list screen.
- `gg` double-key logic is retained (deeply ingrained vim muscle memory); all other double-key sequences are removed.

## Vendors Tab (migrated onto fb-core 2026-07-22, P1-3)

The Vendors tab runs the **same interaction model as Bills** — it was previously a one-off cell-cursor design (`hjkl` cell movement, per-cell edit with `d`/`~` verbs and a stale hand-written hint claiming "hjkl navigate" while `h/l` actually switched tabs). The migration adopted the Bills model wholesale rather than porting the cell model onto fb-core.

### NORMAL mode

| Key | Mouse | Action |
|-----|-------|--------|
| j / k | Click row | Move row selection (sticky at top/bottom, never deselects) |
| gg / G | — | First / last row |
| Enter or i | Double-click row | Enter INSERT (row-level edit) |
| a | — | New partner row at bottom, immediately in INSERT |
| x | — | Delete partner (unsaved row drops silently; saved partner asks `confirm()`) |
| ~ | Double-click ACTIVE badge | Toggle active/inactive (saved partners only) |
| h / l | Click tab | Switch Bills ↔ Partners (NOT bound by the tab — falls through to common.js, same as Bills) |

### INSERT mode (row-level — the whole row becomes inputs)

Pressing `i`/`Enter`/double-click converts **all five editable cells at once** (Vendor, CCY, Terms, Expense A/C, AP A/C) into uniform 32px `.draft-input` fields; the ACTIVE badge stays read-only. This mirrors Bills' bill-level INSERT ("isn't it simpler to reuse full edit rather than specific line edit?").

- **Tab / Shift+Tab** traverse the inputs (native); **sticky at the ends** — Tab on the last input (AP) and Shift+Tab on the first (name) stay put, no accidental focus escape.
- **Esc saves** — the only save trigger, same doctrine as Bills (no cancel path). Validation: name required (red `.req` border + message, stays in INSERT); CCY checked against the currency list. On server error the row stays in INSERT with inputs untouched.
- **Empty new row + Esc discards** (never creates something from nothing).
- **Enter also saves** (form convention; matches the pre-migration Enter-commit).
- **Click-away saves**: clicking another row with an edit open saves first, then selects the clicked row. The async save does NOT reset `partnerSelRow` — the cursor stays where the click moved it (a completion-handler stomp that yanked it back was fixed on day one).
- **Leaving the tab** (h/l/{/}) with an edit open saves-or-discards it first (`showPayTab` calls `partnerSaveAndExit()`).
- **Autocomplete dropdowns** (CCY, both account fields): ArrowUp/Down navigate, Enter selects, Tab selects-and-stays, Esc closes the dropdown only (a second Esc saves the row). Dropdown-aware bindings precede general ones — FB.keys takes the FIRST key+mode+`when` match.
- j/k/a/x/~ are inert in INSERT (letters type into inputs, per the editable-target guard and mode-scoped bindings).

### Mechanics

- Mode is the shared `FB.mode` store; keys are the `FB.keys` binding table `'partners'` (sidebar hints are generated from it — the static `_PARTNER_HINTS` list is gone).
- Save path: `partnerSaveAndExit()` → validate → `partner.upsert` → `_renderPartnerRowDisplay()` rebuilds just that row (keeps the list stable, no full re-render flash). `_partnerSaving` guards re-entrant Esc during the flight.
- The old cell-cursor machinery is deleted: `vendorSelCol`, `vendorCellEdit`, `vendorCellPreEdit`, `enterVendorCellEdit`/`commitVendorCell`, `vendorMoveRow`/`vendorMoveCol`, per-cell save-on-nav (`vendorDirtyRows`), and the `VENDOR_KEYS` capture listener.
- `window.fbVendorSelRow` is still maintained — common.js's j/k deferral reads it.

## FB.dropdown — unified validated autocomplete (IMPLEMENTED 2026-07-21, commit `6c5cdc4` — `fb-core.js`; proposal dated 2026-07-22)

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

## P1-4 — Full-page bill editor (SHIPPED 2026-07-22 — bill-new.js deleted, −1490 LOC)

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
2. **Lines table** — one row per line: description, expense account (FB.dropdown), amount, VAT code (FB.dropdown); VAT is computed from the code (no per-line VAT amount input). Bill footer carries the editable stated-VAT cell (supplier-stated doctrine, tolerance warning at post). Row ops mirror the tree-table: `a` add line below, `x` delete line, `+` icon on last row (gray/faded when empty). No separate GST rows (bill-new's syncGstRow pattern dies).
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
- **VAT:** computed from each line's VAT code; bill-level stated-VAT override in the footer (tolerance-warned at post — warnings render in the status bar, never swallowed).
- **Attachments:** after first save (bill_id exists), uploads bind to the draft; unsaved-new bills stage files client-side until first save (mirrors bill-new's reenter flow, minus its FX hackery).

### Elimination inventory (bill-new.js — what dies and why)

| bill-new.js feature | Fate | Reason |
|---------------------|------|--------|
| Manual FX rate input + fetchRate/fetchAndRetry/maybeFillReenter | **Deleted** | Phase 2d doctrine: rate from master data at post; override = Settings → Exchange Rates |
| Client-side `rebuildJournals()` preview | **Deleted** | Direct-post doctrine (preview was compensation, not safety); server validates at `p` |
| Dialect-A account/vendor/currency dropdowns | **Deleted** | FB.dropdown everywhere (P1-7) |
| syncGstRow separate GST rows | **Deleted** | VAT computed from the line's VAT code (no per-line VAT amount); stated-VAT override at the bill footer (redesign 2026-07-26) |
| Attachments panel | **Migrates** | The one capability worth keeping — rebuilt in the editor's zone 3 |
| Form-style page chrome (`rem` typography, card styling) | **Deleted** | Editor uses app tokens/pt, sidebar, hints chrome |

### Decisions (magnus, 2026-07-22)

1. **Entry points:** `+ Bill` toolbar link → the editor (create path). `o` in the Bills list stays the default quick path (tree-table INSERT). `O` (shift-o) from the Bills tab → editor, new bill.
2. **`i` always stays inline** (no line-count threshold). Editor entry for an existing draft: **`I` (shift-i)** on the focused draft row. Mouse parity: **double-click opens the full editor** — mouse users always get the editor (magnus, 2026-07-22). Shipped code matches; there is no hover-edit affordance.
3. **Attachments on unsaved bills stage client-side** until the first save binds them (bill-new's reenter behavior, minus its FX hackery).
4. **Per-line cost/profit centers: INCLUDED** (reversing the draft's skip). The ledger already carries them — `journal_entries.cost_center/profit_center`, bill-header fields, `centers` master data, and `createBill` threads header centers into journal lines. Editor adds a per-line center column (FB.dropdown over `center.list`, default from header, overridable); backend extends the `draft_lines` line shape with `cost_center`/`profit_center` and maps line-level centers onto journal lines at post (falling back to header centers when a line has none).

## P1-9 — Payment matching UX (DONE 2026-07-22 — backend + Bills UI + import confirm-flow landed)

*(Approved by magnus as "go ahead with p1-5" 2026-07-22 — the chat label was wrong; P1-5 was already the shipped VAT-warnings item. Roadmap records this as P1-9.)*

### Purpose

Payment today has exactly one path: bank-import auto-match. That leaves four gaps versus standard practice (Xero / QBO / Odoo):

1. **No manual "record payment"** — without a bank feed you cannot pay a bill at all. `bill_payments`, partial-payment status, and the FX settlement journal all exist server-side; no action or UI exposes them outside import.
2. **Silent amount-only auto-match** — `matchBillRow` falls back to linking a bank row to *any* open bill with the same amount, with no confirm step. Wrong-link risk is real (two bills, same round amount).
3. **Payment history invisible** — a paid bill shows "Paid" but you cannot see when/how it was paid without querying the DB.
4. **No unwind** — a wrong match is permanent (bill.void correctly refuses paid bills; there is no payment-void).

### Current state (verified 2026-07-22)

- `approveBankEntries` (bank.js) already does the full settlement: 2-line journal (DR AP / CR bank), 3-line FX gain/loss split for foreign-currency bills, `amount_paid` update in foreign currency, status → `paid`/`partial`, `bill_payments` row (`method: 'bank_match'`). **This is the shared settlement core — new paths must reuse it, not reimplement it.**
- `bill.match` (catalog, viewer): candidate open bills by amount/currency (+optional vendor/date). **Dormant — no page calls it.**
- Import matching tiers today: mapping rule (high) → bill exact-amount + vendor/ref substring (medium) → **amount-only fallback (silent)** → unmatched.
- `p` in Bills list is draft-only (post). On posted/partial rows it is currently a no-op — free to reuse.

### Proposed scope

1. **`bill.payment.record` action** (mutating, idempotent, data_entry role). Params: `billId`, `date`, `bankAccount`, `amount`, `reference?`, `fxRate?` (foreign bills). Validates: bill posted/partial, amount > 0, amount ≤ outstanding (+ε), bank account is a cash/bank account. Settlement goes through the **same extracted core** as import approve (FX split included). `bill_payments.method = 'manual'`.
2. **Bills list: `p` on a posted/partial bill → inline payment row** (expand below the parent, same pattern as line folds — no modal, no new chrome per the clutter rule). Fields: date (default today), bank account (FB.dropdown over cash/bank accounts, default last-used), amount (default full outstanding, in bill currency; editable for partial), reference (optional). For foreign-currency bills an FX-rate field appears, prefilled from the day's rate. `Enter` confirms (calls `bill.payment.record`, status bar shows result + new status), `Esc` cancels. Mouse parity: a "Pay" affordance on the row's hover (same pattern as delete).
3. **Payment history on unfold**: unfolding a paid/partial bill appends payment child rows (date, amount, method, reference) below the line rows. Data via a small `bill.payments` viewer action (or folded into `bill.lines` response — pick whichever keeps one round-trip).
4. **Import hardening**: delete the silent amount-only fallback. Tiers become: rule (high, auto) → exact amount + vendor/ref token in narrative (medium, auto) → **exact amount only (suggested — renders amber, excluded from approve-all, needs per-row `Enter` to confirm or `x` to reject)** → unmatched. Bonus cheap win: vendor_ref as a *whole token* in the narrative promotes a medium match to high.
5. **`bill.payment.void` action** (mutating, idempotent): reversing journal, `amount_paid` decrement, status restore (`paid`/`partial` → `posted`). `x` on a payment child row triggers it (with the standard undo-toast pattern). Safety valve for wrong matches, manual or import.

### Explicitly deferred

- **Multi-bill settlement** (one payment → N bills, the monthly-statement case): needs an allocation UI; defer to its own phase. ✅ Tracked — GitHub issue.
- **Bank-tab manual match** (`m` on an uncleared line → candidate list via dormant `bill.match`): originally deferred because the bank tab hadn't migrated to FB.keys. **Re-scoped:** the Bank sidebar item has been dissolved (bank-dissolution-spec); reconciliation is now a report. The `m` verb should live on the reconciliation report if built. Consider whether the inbox-based Phase B matching flow makes this redundant. ✅ Tracked — GitHub issue.
- **Tolerance suggestions** (±2% amount window as a suggestion tier): defer until real usage data says it's needed. ✅ Tracked — GitHub issue.

### Decisions (magnus, 2026-07-22)

1. **Dual path approved ("go for B").** Pay-on-bill exists alongside bank-import matching (industry standard: Xero/QBO/Odoo all have both). Consequence — new scope item 6: **import rows matching an already-recorded manual payment must not re-post** (would double-count CR Bank). `bank.process` tags them `recorded_payment`; `bank.approve` clears the existing payment's bank leg via a `reconciliations` row — no new journal. Binding: **`p` contextual** (post on drafts, pay on posted/partial) — one key, the row's status disambiguates.
2. Import hardening (silent amount-only auto-match demoted to confirm-required suggestion): **agreed.**
3. Payment entry as inline expanding row: **agreed** — inline, not the full editor.
4. Deferred list (multi-bill settlement, bank-tab manual match, tolerance tiers): **OK.**

### Implementation status (2026-07-22)

- **Backend ✅** — shared settlement core (`api/src/settlement.js`) extracted from import approve; import path refactored onto it (behavior mirrored branch-for-branch). New actions: `bill.payment.record` (data_entry, idempotent; cash-account + period-lock + outstanding validation; FX via booking-rate split), `bill.payments` (viewer history), `bill.payment.void` (idempotent; journal reversal + status restore + append-only void mark). `bill_payments` extended: `amount_foreign`, `reference`, `voided_at`, `voided_by`. 5 contract tests added — suite 26/26 green. Fixed en route: ERROR_STATUS gap — INVALID_STATUS/INVALID_ACCOUNT/ALREADY_REVERSED et al. returned HTTP 500; now 409/400.
- **Import hardening + recorded-payment recognition ✅** — `matchBillRow` now returns tiers: vendor_ref whole-token → high, vendor/ref substring → medium, amount-only → `bill_suggest` (confirm-required; summary buckets `billSuggest`/`recordedPayment` added). `bank.process` tags rows matching an unvoided manual payment (exact date + amount + bank account) as `recorded_payment`; `bank.approve` clears the payment's bank leg via `reconciliations` (ON CONFLICT DO NOTHING) and posts nothing. `openBills` now selects `ap_account` so process→approve is a valid agent flow without frontend account-filling.
- **Bills-tab UI ✅** — `p` on posted/partial opens the inline payment row (colspan fold-pattern row: date default today, bank-account FB.dropdown over `cf_category='Cash'` with last-used default, amount default outstanding in bill ccy, optional reference, FX-rate field for foreign bills prefilled from the day's rate). Enter records (`Idempotency-Key` per row open), Esc cancels, dropdown-open Enter picks before submit (binding priority), mode INSERT↔NORMAL. Mouse parity: hover-only "Pay" affordance on posted/partial parent rows (no chrome at rest; there was no pre-existing delete hover icon on this table — the spec's "same pattern as delete" resolved to the 💾-style inline icon). Unfold of paid/partial bills appends payment-history child rows (date · method · reference · amount; voided struck through) via a parallel `bill.payments` fetch — deviation from spec's one-round-trip: kept separate to preserve `bill.lines`' array shape. `x` on a payment row voids via `bill.payment.void` (confirm, status-bar result, list reload). Sidebar hint updated: `p` = post/pay. Verified live: record → Paid, history rows, void → posted + reversal journal, ledger balanced. Template-escape trap hit and fixed: inline onclick row lookup uses `parentNode.parentNode` (no nested quotes in template strings).
- **Bank-import UI ✅** — `bill_suggest` rows render amber (`bill?` tag, amber left border) **pre-skipped** (confirm = uncheck Skip; reject = leave it), excluded from approve-all; `recorded_payment` rows render blue (`recorded` tag, "already recorded — clears on approve" note, included in approve as clearing entries). Summary line gains suggestion/recorded counts. `checkDuplicates` now excludes both tiers (a recorded payment is *expected* in the ledger — dup-warn would mislabel and fight the clearing flow). Verified live against throwaway DB: 3-row process renders all three tiers; contract suite 28/28.
- **P1-9 COMPLETE** — all six scope items shipped. Remaining deferred list unchanged (multi-bill settlement, bank-tab manual match, tolerance tiers).

## P1-6 — Discoverability: `?` overlay + dead-palette removal (SHIPPED 2026-07-22)

### Purpose

Keyboard-first UX fails if bindings are undiscoverable. The review found the `?` button handler-less and the `:` command palette dispatching to an undefined `fbCmdDispatch` — discoverability was dead. P1-3 had already made the sidebar hint panel generated from the FB.keys binding tables; P1-6 completes the pattern with an on-demand exhaustive reference.

### Shipped behavior

1. **`?` (Shift+/) opens a which-key-style overlay** of the active page's binding set. Two columns — NORMAL | INSERT — listing **every binding that carries a `hint`** (exhaustive), where the sidebar panel remains the curated `hintBar` subset. Same binding table, same adjacent-same-hint grouping (`j/k navigate`) as dispatch and sidebar — one source of truth, the overlay **cannot go stale**. Modifier-gated bindings (e.g. Ctrl+Enter) are probed through their `when()` and labeled explicitly.
2. **Trigger guards:** NORMAL mode only, and never while typing in an input/textarea/select/contenteditable (same guard that keeps NORMAL verbs inert) — a literal `?` typed into a description field stays text. On pages with no FB.keys set (journal/bank/settings/dashboard), `?` is a silent no-op.
3. **While open, the overlay swallows every key** (capture-phase, before page bindings and common.js's bubble handler). Close on `Esc`, `?`, or backdrop click. Focus is restored to the previously focused element.
4. **Mouse parity:** the topbar `?` button (previously handler-less) toggles the same overlay via `FB.keys.help.toggle()` — deliberately not mode-gated (read-only documentation).
5. **`:` palette removed, not fixed.** The search-bar `:`-prefix dispatch called an undefined function (would `console.log` and swallow the command), and `fbOpenCmdPalette` was a self-admitted no-op stub — doubly dead code, deleted per standing rule 6. The search bar keeps its real behaviors (Enter blurs, Esc clears+blurs; filtering is each page's oninput). The command-line *concept* is not rejected — its proper replacement is specced as **P1-10**.

### Decisions (2026-07-22)

1. Overlay is exhaustive, sidebar stays curated — two surfaces, one table. Rationale: the sidebar must stay scannable; the overlay answers "what can I press here, exactly?"
2. NORMAL-mode-only keyboard trigger. INSERT-mode users are typing; typing wins. The INSERT column is still *shown* so INSERT bindings are discoverable.
3. Palette removed rather than repaired: it never worked, and a real one deserves its own design (fuzzy commands, recent actions) — not a P1-6 side quest.

### Implementation status (2026-07-22)

- fb-core.js: `_activeSet()` resolves the dispatch-owning set; `FB.keys.help` (open/close/toggle/isOpen); shared `_groupHints()` used by both sidebar renderHints and the overlay; `?` trigger in `_dispatch` after page bindings.
- common.css: `#fb-keys-overlay` panel styles reusing `.fb-hint-row` markup with a light-panel palette.
- common.js: dead palette deleted (~70 LOC); topbar `?` button wired (`#tb-help-btn`); cache-buster bumped `?v=20260722`.
- **P1-3 remainder — Bank ✅ (2026-07-22, branch `p1/fb-core-remainder`).** Transactions tab onto FB.keys/FB.nav: `j/k` row cursor (sticky boundaries, `nav-row-focus`, scroll-into-view), `c` clear/unclear focused row (same `bank.reconcile.clear` action as the checkbox), `Esc` clear focus; INSERT-mode `Esc` blurs filter inputs back to NORMAL. Sidebar hints generated from the binding table; hints follow tab switches (cleared on Mappings — honest absence, not stale chrome). **Dead code deleted:** the entire legacy import block lived in bank.js referencing DOM that exists only in bank-import.js — ~714 JS lines (processCSVText … refreshBillCell, incl. the page's only keydown handler) + dead CSS (review-table, wizard, bill-card, tags) gone per rule 6. **Bugs fixed en route:** (1) `toggleCleared` mutated `recRows[i]` by *display* index — wrong row whenever the Cleared/Uncleared filter hid rows; now resolves the row object through `getFilteredRows()`. (2) `toggleCleared` assigned `tr.className`, wiping `nav-row-focus` on keyboard toggles; now `classList.toggle('cleared')`. **Deferred:** Mappings tab (per-row-input edit table — not a vim list; candidate for the P1-10 palette instead). Verified live: cursor, toggle persistence, focus retention, overlay, hints. Suite 28/28.
- Verified live (throwaway DB): overlay opens on Bills + bill-edit, columns/labels match sidebar superset, Esc/`?`/backdrop close, typing `?` in an inline field stays text, journal page no-op. Contract suite 28/28.

## P1-10 — Command palette: `:` written commands (DONE 2026-07-23 — spec below as designed; built commit `d1c2110`)

*(Raised by magnus 2026-07-22 after P1-6 removed the dead `:` stub: "the idea with `:` is to allow written commands by the user, such as `:new bill"." Agreed: the concept is vim-native and fits the keyboard-first philosophy; what was deleted was a non-functional stub. Spec now, build later — after the P1-3 remainder.)*

### Purpose

Single-key verbs cover the frequent actions; written commands cover the rest:

1. **Key-less actions** — things too rare to deserve a binding ("lock period", "post FX revaluation", "go bank"). Today these are mouse-only or URL-only.
2. **Discoverability by typing** — "new bill" instead of memorizing `o`. The palette doubles as a teacher: every row shows the key equivalent next to the command.
3. **Mouse parity for keyboard-first design** — clickable command list, no new chrome at rest (clutter rule).

### Current state

- P1-6 deleted the dead stub: search-bar `:` dispatch → undefined `fbCmdDispatch` (commands were silently swallowed); `fbOpenCmdPalette` a no-op with a hardcoded 7-item navigation list. Nothing functional was lost.
- `/` fuzzy search is intact (focus search from NORMAL, page-level oninput filtering). This spec does not touch it.
- FB.keys binding tables already name every page verb (`hint`) and hold its executor (`run`) — a command registry can be **derived**, not hand-written.

### Proposed behavior

1. **One input, two modes — no new chrome.** The existing topbar input is the single entry point. `/` places the cursor there in **search mode** (unchanged behavior: per-page fuzzy filtering). `:` places the cursor there in **command mode**: matching commands appear in a dropdown directly below the input. No overlay, no bottom bar. The input shows a `:` prefix in command mode so the mode is visible. At build time the placeholder returns to "Search (/) or Command (:) …" — restored only once it's true again.
2. **Mode is set by HOW you got there, not by content.** Entering via mouse click is always search mode — written commands are a keyboard-user feature. (Mouse parity for commands is deliberately waived, magnus 2026-07-22.)
3. **Command sources — derived, single source of truth:**
   - **Page verbs** = NORMAL-mode bindings with a `hint` from the active FB.keys set. Executing one calls the binding's `run` — identical effect to pressing the key, against the current focus/context.
   - **API actions** = the action catalog (`GET /api/actions`, P1-1) — **all** API-accessible functions are represented (magnus 2026-07-22), each with an explicit disposition:
     - **Execute directly** — actions that need no parameters beyond current context (e.g. period lock, FX revaluation post). Executed via `fbApi` with `Idempotency-Key` — standing rule 3; no new backend surface.
     - **Navigate to form** — actions requiring input (e.g. `bill.create` → open the bill editor; `journal.post` → open journal-new). A command can't collect a bill's lines in a dropdown; routing to the form is the honest execution.
     - **Excluded** — raw data viewers (`bill.list`, `vendor.list`, …) are meaningless as commands; their data is reached via navigation or the page verbs.
     The disposition map is small, explicit, and lives next to the catalog — new actions default to navigate-to-form, so the palette grows automatically with the API.
4. **Matching:** fuzzy subsequence over label + key equivalent; ranking = recency (localStorage) then exactness. `↑/↓` (and `Ctrl-n`/`Ctrl-p`, vim convention) move in the dropdown; `Enter` executes (first match if none selected) and closes; `Esc` clears and blurs (the search bar's existing Esc behavior). While the input has focus, page bindings are inert — as today.
5. **Row content:** command label · key equivalent as `kbd` where one exists · scope tag (`page` / `api`). The palette doubles as a keyboard teacher.
6. **Empty state:** "no matching commands" — never silently dead.

### Explicitly deferred

- Command arguments (`:bill INV-123`, `:goto 2026-06`), aliases, chaining. ✅ Tracked — GitHub issue.
- Frecency beyond simple localStorage recency. ✅ Tracked — GitHub issue.
- `/`-mode search-hits dropdown (today search filters per page in place; a unified hits dropdown is separate scope if ever wanted). ✅ Tracked — GitHub issue.
- `?`-overlay cross-link ("press `:` to run any command" footer line) — evaluate after both ship.
- Mobile/touch considerations.

### Decisions (magnus, 2026-07-22)

1. **No separate popup or bottom bar.** The existing topbar input hosts both modes; `hits in a dropdown below the input`. (Overrides the spec draft's center-overlay proposal.)
2. **Mouse entry is always search.** Commands are keyboard-only; no `:`-prefix detection for mouse-entered text.
3. **All API-accessible functions available** — via the action catalog with the execute/navigate/excluded disposition map (item 3 above), not a hand-picked registry.

### Relationship to other items

- **P2-6 (user-editable keybindings):** both treat binding tables as data. A remap layer automatically renames the palette's key labels — palette needs no separate work when P2-6 lands.
- **P1-3 remainder:** build P1-10 AFTER Journal/Bank/Settings migrate onto FB.keys, so derived page verbs cover the whole app in one shot instead of special-casing three legacy pages.
- **P1-6:** removed the dead stub; this is its proper replacement.
