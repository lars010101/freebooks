# Keyboard shortcuts — open followups

Trimmed 2026-10-03. This doc began as hand-off notes for PR #293
(`fix/keyboard-shortcuts-consolidation-pass`), which was never merged and
whose branch no longer exists; `bill-post-payment-consolidation-spec.md`
superseded its approach. Items below were re-checked against the code on
that date. Only the two still-live ones are kept; each is tracked as a GitHub
issue (see headings).

## 1. Payables `I` key — still an open question (#299)

`payables-bills.js` still binds `I` (NORMAL mode, "open in full editor",
`paletteEligible: false`). Whether it is still needed now that `i`/`Enter`
are consolidated was deferred and never investigated.

## 2. Hint-bar `kbd` column can re-break alignment (#300)

`.fb-hint-row kbd` in `common.css` uses `min-width: 34px` inside a flex
row, so any future key label wider than that box breaks alignment the way
"Enter"/"Space" once did (those now render as ↵/␣). A grid with a
fixed-width first column would close this independent of label length.

## Resolved since the original notes (kept for the record)

- **Mouse "write" chip bypassing the draft-save kill** — moot: the Draft
  toggle (`~`, default off) made draft-vs-post an explicit choice
  (`bill-post-payment-consolidation-spec.md`, 2026-09-02).
- **Tests not independently executed** — belonged to the abandoned #293
  branch; no longer applicable.
- **Stale spots in `payables-ux-spec.md`** (old Partners/Vendors INSERT
  section, `shift-O` proposal) — no longer present; the INSERT-mode section
  now describes the FB.list tree-edit model.
- **Possible spec/code mismatch for `bill_draft` inbox items** — not a
  mismatch: `api/src/inbox.js` merges `bill_draft` items into the queue
  (`queryBillDrafts`) and `api/src/pages/inbox.js` renders them as
  `_kind: 'transaction'` with `kind: 'bill'`.
