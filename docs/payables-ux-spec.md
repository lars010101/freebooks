# Payables UX Specification

## Design Principles

1. Two modes only: NORMAL (browsing) and INSERT (editing). No ambiguous middle state.
2. Every keyboard action has a mouse equivalent and vice versa. No interaction requires both. No interaction is available through only one input method.
3. NORMAL mode is row-oriented (vim line semantics). INSERT mode is bill-oriented — the entire draft bill (parent + all child lines) opens for editing simultaneously.
4. Save timing is unambiguous: exiting INSERT mode saves. No blur-chasing, no timers, no deferred checks.

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
| o | Click "+" toolbar button | New bill below current |
| O | — | New bill above current |
| a | — | Append new child line to current draft bill |
| x | Click delete icon (on hover) | Delete current row/bill |
| p | Click "Post" button on draft | Post draft bill |
| G | Scroll to bottom | Jump to last row |
| gg | Scroll to top | Scroll to top |
| Esc | — | No-op (already in NORMAL) |

Row selection highlights the complete row (parent or child). No cell-level cursor in NORMAL mode. This eliminates the 2D cursor model, the fbBillCursorMid flag, and the bill-cell-focus CSS.

j/k navigation crosses bill boundaries seamlessly:
- On last child of a bill, j moves to next bill's parent (or first child if that bill is expanded)
- On first child of a bill, k moves to previous bill's parent (or last child if that bill is expanded)

### INSERT MODE (editing one bill)

| Key | Mouse | Action |
|-----|-------|--------|
| Tab | Click cell in bill | Move to next editable cell |
| Shift+Tab | Click cell in bill | Move to previous editable cell |
| Esc | Click outside bill | Save bill + exit to NORMAL |
| (all other keys) | — | Disabled (h/j/k/l/{/}/o/x/p/G/gg all inert) |

Entering INSERT mode (via `i` on any row of a draft bill):
- **All** editable cells on the bill become inputs simultaneously — parent fields (vendor, date, due, ref, currency, FX rate) AND all child line fields (description, amount, GST code)
- Focus lands on first parent input (vendor)
- h/j/k/l/{/} are disabled
- Tab/Shift+Tab move between cells across the entire bill (parent → children)

**New (unsaved) drafts:** `createDraftBill()` renders parent + first child with all inputs. `i` is auto-triggered on creation.

**Saved drafts (status='draft', already in DB):** `convertDisplayToDraft()` re-renders the parent row from display text back into editable inputs (pre-filled with saved values), fetches draft lines from server, and renders child rows with editable inputs. The `data-draft` attribute is re-set to `'true'` so subsequent Esc saves correctly.

Exiting INSERT mode (via Esc or click-outside):
- Entire bill is saved to database (`saveDraftToDb`)
- If bill is completely empty, it is discarded instead of saved
- Cells return to display state (`convertDraftRowToDisplay`)
- Returns to NORMAL mode with selection on the parent row

Posted bills: `i` and double-click are no-ops. The row is read-only. No INSERT mode is entered.

### Tab Behavior at Bill Boundaries

Tab navigates across all editable cells in the bill:
- **Forward Tab** flows: vendor → date → due → ref → (skip read-only amount) → currency → first child desc → first child amount → first child GST → ... → last child GST
- **Tab on the last child's last field (GST):** If the current child has data (description or amount), a **new child row is created** and focus moves to its description input. If the child is empty, Tab stays (sticky — no empty rows created).
- **Shift+Tab** flows in reverse: last child GST → last child amount → last child desc → ... → parent currency → ref → due → date → vendor
- **Shift+Tab on the first child's description field:** Focus moves to the parent's currency input.

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

There is no discard option. Esc always saves. Click-away always saves. If a user wants to undo changes, they delete the row afterward. An undo mechanism (u key / undo button) may be added in a future revision but is out of scope for this spec.

### Empty Bill Discard

If Esc is pressed on a completely empty draft (no vendor, no date, no child data), the draft is discarded rather than saved. This prevents empty draft rows from accumulating.

## FX Rate in INSERT Mode

### When it appears
An FX rate input field appears in the draft parent row when the bill currency differs from the company's base currency. If currency === base currency, the field is hidden.

### Auto-lookup
When the bill date changes (or when the currency changes), the system automatically queries the `fx_rates` table via the `fx.rates.get` endpoint to find the applicable rate for that currency pair on that date. The returned rate populates the FX rate input. If no rate is found, the field is left empty and the user must enter a rate manually.

### Editable override
The auto-populated rate is editable. The user can override it with any positive decimal value.

### Save payload
The FX rate is included in both `saveDraftToDb` (draft save) and `confirmPost` (post to journal) payloads. The backend uses this rate for `amount_home`, `debit_home`, and `credit_home` calculations. If no rate is provided and the currency differs from base, the backend rejects with a validation error.

### Live amount_home preview
When a foreign currency is selected and a rate is entered, the parent row shows a live preview of the home-currency equivalent next to the foreign-currency amount total. This updates as child line amounts change.

## Foldable Rows

### Fold Toggle
- Enter or Space (keyboard): toggle fold on parent row under cursor
- Click ▸/▾ icon (mouse): toggle fold on that parent
- Clicking the parent row body (not the icon) selects the row — does NOT toggle fold

### Fold Behavior
- Expand: fetches line items from server (first time), renders child rows below parent. Parent gets row-expanded class.
- Collapse: removes child rows from DOM. Parent loses row-expanded class.
- Client-side line cache: once fetched, line items are cached by bill ID. Subsequent expands render from cache instantly. Cache invalidates on save/post.

### Expand All / Collapse All
Not bound to keys in this spec. The methods exist in code (_expandAll, _collapseAll) but are not wired to any keyboard shortcut. If needed, they can be accessed via future command palette. Out of scope for now.

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

## Removed / Simplified

The following elements from the pre-refactor implementation are removed or simplified by this spec:

| Removed | Reason |
|---------|--------|
| Cell-level cursor in NORMAL mode (h/l within row) | Row-only selection; h/l reserved for tab switching |
| fbBillCursorMid flag | No longer needed; h/l always means tab switch |
| bill-cell-focus CSS (dark blue cell highlight) | No cell cursor in NORMAL mode |
| autoSaveDraftIfReady 200ms timer | Save triggers on INSERT exit (Esc), not on blur |
| autoSaveChildRow | Same — save on Esc, not on blur |
| enterBillCellEdit / exitBillCellEdit | Per-cell editing replaced by bill-level INSERT |
| billEditState object | No longer needed without per-cell edit |
| dd double-tap delete | Replaced by single x key |
| za/zo/zc/zR/zM fold keys (dead code) | Never implemented; Enter/Space used instead |
| :w save command | Esc saves on INSERT exit; no command bar needed |
| Double-key sequence logic for fold | Enter/Space are single-key, no chord ambiguity |
| j/k boundary blocking | Seamless navigation across bill boundaries |

## Implementation Notes

- Bill-level INSERT rendering reuses `createDraftBill()` for new drafts and `convertDisplayToDraft()` for saved drafts. Both render parent + children with all inputs simultaneously.
- Tab navigation is wired via `_wireChildRowTab()` — forward Tab on last child's GST creates a new row; Shift+Tab on first child's desc goes to parent CCY.
- Save-on-INSERT-exit uses `saveDraftToDb()` — one trigger, one code path, no timers.
- `convertDraftRowToDisplay()` converts editable inputs back to display text after save, removing `data-draft` attribute.
- Event handler conflicts between common.js and payables-bills.js resolved by early `stopImmediatePropagation()` in the bills handler (capture phase) when `fbBillNav` is true.
- gg double-key logic is retained (deeply ingrained vim muscle memory); all other double-key sequences are removed.
- `cursor.col` is retained as internal state for Tab navigation positioning but has no visual effect in NORMAL mode.
