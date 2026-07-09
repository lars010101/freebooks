# Payables UX Specification

## Design Principles

1. Two modes only: NORMAL (browsing) and INSERT (editing). No ambiguous middle state.
2. Every keyboard action has a mouse equivalent and vice versa. No interaction requires both. No interaction is available through only one input method.
3. NORMAL mode is row-oriented (vim line semantics). INSERT mode is cell-oriented (within a single row).
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
| i | Double-click editable row | Enter INSERT mode (no-op if posted) |
| o | Click "+" toolbar button | New bill/line below current |
| x | Click delete icon (on hover) | Delete current row/bill |
| p | Click "Post" button on draft | Post draft bill |
| G | Scroll to bottom | Jump to last row |
| gg | Scroll to top | Scroll to top |
| Esc | — | No-op (already in NORMAL) |

Row selection highlights the complete row (parent or child). No cell-level cursor in NORMAL mode. This eliminates the 2D cursor model, the fbBillCursorMid flag, and the bill-cell-focus CSS.

j/k navigation crosses bill boundaries seamlessly:
- On last child of a bill, j moves to next bill's parent (or first child if that bill is expanded)
- On first child of a bill, k moves to previous bill's parent (or last child if that bill is expanded)

### INSERT MODE (editing one row)

| Key | Mouse | Action |
|-----|-------|--------|
| Tab | Click cell in row | Move to next editable cell |
| Shift+Tab | Click cell in row | Move to previous editable cell |
| Esc | Click outside row | Save row + exit to NORMAL |
| (all other keys) | — | Disabled (h/j/k/l/{/}/o/x/p/G/gg all inert) |

Entering INSERT mode (via i or double-click):
- All editable cells on the row become inputs simultaneously
- Focus lands on first editable cell
- h/j/k/l/{/} are disabled
- Only Tab/Shift+Tab move between cells within the row

Exiting INSERT mode (via Esc or click-outside):
- Row is saved to database
- Cells return to display state
- Returns to NORMAL mode with selection on the same row

Posted bills: i and double-click are no-ops. The row is read-only. No INSERT mode is entered.

### Tab Behavior at Row Boundaries

When Tab is pressed on the last editable cell of a row, focus wraps to the first editable cell of the same row. This keeps the INSERT boundary tight to one row. Moving to child lines requires: Esc (save + exit), j (move to child), i (enter INSERT on child).

### Click-Outside Save (Mouse Esc Equivalent)

When a mouse user is in INSERT mode and clicks another row, two things happen atomically:
1. Current row is saved (Esc equivalent)
2. Clicked row is selected (j/k equivalent)

No intermediate NORMAL state should be visible. Implementation:
```js
function onRowClick(rowEl) {
  if (cursor.mode === 'INSERT') {
    saveCurrentRow();
    exitInsertMode();
  }
  selectRow(rowEl);
}
```

### No Cancel / Discard Path

There is no discard option. Esc always saves. Click-away always saves. If a user wants to undo changes, they delete the row afterward. An undo mechanism (u key / undo button) may be added in a future revision but is out of scope for this spec.

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
| Parent row body | Subtle background tint | default (clicking selects) |
| Editable row (draft) | Slightly darker tint + tooltip "double-click to edit" | default |
| Posted row | No special hover | not-allowed on double-click attempt, or "posted" badge |
| Delete icon | Turns red | pointer |
| Post button | Highlights | pointer |
| Input field (INSERT) | Standard focus ring | text (I-beam) |

## Removed / Simplified

The following elements from the current implementation are removed or simplified by this spec:

| Removed | Reason |
|---------|--------|
| Cell-level cursor in NORMAL mode (h/l within row) | Row-only selection; h/l reserved for tab switching |
| fbBillCursorMid flag | No longer needed; h/l always means tab switch |
| bill-cell-focus CSS (dark blue cell highlight) | No cell cursor in NORMAL mode |
| autoSaveDraftIfReady 200ms timer | Save triggers on INSERT exit, not on blur |
| dd double-tap delete | Replaced by single x key |
| za/zo/zc/zR/zM fold keys (dead code) | Never implemented; Enter/Space used instead |
| :w save command | Esc saves on INSERT exit; no command bar needed |
| Double-key sequence logic for fold | Enter/Space are single-key, no chord ambiguity |
| j/k boundary blocking | Seamless navigation across bill boundaries |

## Implementation Notes

- Row-level INSERT rendering already partially exists for draft bills (draftLines, _openFold/_closeFold)
- Tab/Shift+Tab cell navigation replaces the current per-cell i-to-edit model
- Save-on-INSERT-exit is simpler than current auto-save: one trigger, one code path
- Event handler conflicts between common.js and payables-bills.js should be resolved by early stopImmediatePropagation in the bills handler when fbBillNav is true
- gg double-key logic is retained (deeply ingrained vim muscle memory); all other double-key sequences are removed
