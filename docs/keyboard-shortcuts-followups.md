# Keyboard shortcuts — open followups

Trimmed 2026-10-03. This doc began as hand-off notes for PR #293
(`fix/keyboard-shortcuts-consolidation-pass`), which was never merged and
whose branch no longer exists; `bill-post-payment-consolidation-spec.md`
superseded its approach. Items below were re-checked against the code on
that date. Only the still-live items are kept; each is tracked as a GitHub
issue (see headings).

No open items remain (2026-11-22).

## Resolved since the original notes (kept for the record)

- **Payables `I` key (#299)** — retired 2026-11-22 (magnus). Enter now
  opens any saved bill's full page (draft → full editor, otherwise the
  locked page) (`openRow`, `payables-bills.js`). Since #312 (same day) the
  Bills list is read-only, so `i` no longer edits inline there.
  See `keyboard-ux-spec.md` §0.

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
- **Hint-bar `kbd` column alignment (#300)** — fixed 2026-10-03: hint lists
  are now a two-column grid (`.fb-keys-nav`/`.fb-keys-actions`/`#sb-hints`,
  rows as subgrids in `common.css`), so descriptions align however long a key
  label gets.
