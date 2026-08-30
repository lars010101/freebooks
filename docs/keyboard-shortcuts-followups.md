# Keyboard shortcuts — open followups from the consolidation pass

Notes for picking this back up in a new session. Context: PR #293
(`fix/keyboard-shortcuts-consolidation-pass`) — see its description and
`docs/review-roadmap.md`'s PR #293 entries for what already shipped.

## 1. Payables `I` key — on hold

Whether `I` (full-page editor shortcut on Bills) is still needed now that
`i`/`Enter` have been consolidated. Explicitly deferred mid-session — no
investigation redone since, still an open question, not just an idea.

## 2. Mouse "write" chip still bypasses the Bills draft-save kill

PR #293 killed the human "save as draft, don't post" path on Bills across
three surfaces (grid `w` key, `bill-edit.js` `w` verb, the shared
leave-guard modal's Save button via `cfg.draftSaveOnLeave`). One surface
was **not** closed: the generic per-row ✓ "write" mouse chip
(`api/public/fb-list.js`, renders for any dirty row on any FB.list page)
still calls `writeAt`/`bill.draft.save` directly — a mouse-only user can
still park a bill in draft this way.

Direction chosen but not built: replace the per-row chips on Bills with a
topbar banner ("N unsaved changes" + Save/Revert icons), reusing the
existing `#fb-status-banner` element (today a plain transient text-only
strip via `FB.status.show()` — this would be new persistent UI, not a
rewire of something that already does it).

Two design questions still open before building it:
- **Scope**: Bills-only, or a general replacement for per-row dirty chips
  on every FB.list page? If general, "Save" still needs to mean different
  things per page (post for Bills, plain write for everything else — same
  split as `cfg.draftSaveOnLeave`).
- **Bulk-save semantics**: `writeAllDirty()` (today's bulk-write, used by
  the leave-guard modal) assumes writes rarely fail and aborts the whole
  chain on first failure. Posting is different — it validates per bill
  (missing AP account, out of balance, etc.), so a bulk "Save X changes"
  on Bills could plausibly post 3 of 4 dirty bills and have the 4th reject.
  Decide: all-or-nothing, or best-effort with per-item failure reporting?

## 3. Tests not independently executed

`tests/reversal.mjs` and `tests/keys-coverage.mjs` were rewritten to match
the new bindings but never actually run — no `playwright-core` in the
sandbox this was built in (only `node --check` + manual tracing). Run for
real before merging PR #293, or as a first step in the new session if it's
still open.

## 4. CSS layout hardening for the hint-bar/overlay kbd column

Enter/Space now render as single glyphs (↵/␣) instead of full words,
fixing the immediate alignment problem. Not done: `.fb-hint-row kbd` in
`common.css` uses `min-width: 34px` (not a fixed `width`) inside a flex
row (not a grid) — so any future key label longer than fits in that
box will re-break alignment the same way "Enter"/"Space" did. A
grid-based fixed-width first column would close this permanently,
independent of any specific label's length.

## 5. Two pre-existing doc-staleness spots, noticed but out of scope

Not caused by this session's changes, not fixed — just flagged in passing:
- `docs/payables-ux-spec.md`'s old Partners/Vendors INSERT-mode section
  predates the FB.list migration (2026-07-24) and describes bespoke
  interaction machinery that no longer exists.
- The same doc's bill-editor "design proposal" section predates the
  shipped `I` key (references a `shift-O` key that was never actually
  built).

## 6. Possible spec/code mismatch, unverified

`docs/agent-readiness-spec.md` describes a `bill_draft` Class A inbox item
type (agent-created bill drafts, `y`/`x` verbs → `bill.post`/
`bill.draft.delete`), separate from the `journal_proposals`-backed
"proposal" queue. The **current client** (`api/src/pages/inbox.js`) only
implements two `_kind`s — `'proposal'` and `'bill'` (the latter being
Class B bills-*due*, a payment reminder, not a draft-approval flow). It's
unclear whether Class A bill-draft review is actually reachable in the
current UI, or whether the spec describes a broader design than what
shipped. Not investigated further this session — would need to check the
server-side `api/src/inbox.js` (`queryBillDrafts`) against what the client
actually renders.
