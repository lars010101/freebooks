# `?` Help Overlay — NAVIGATION + ACTIONS two-column (v2)

**Status:** Built — ratified design (magnus, 2026-08-28), implemented in
`api/public/fb-core.js` `help.open()` + `api/public/common.css`.
**Amends:** the overlay described in `docs/payables-ux-spec.md` P1-6 and the
deferred item in `docs/keyboard-ux-spec.md` §9 ("`?` overlay GLOBAL
section... the overlay currently documents the active page set only").
**Supersedes:** the earlier Global + Go to page stacked layout (PR #283),
which this v2 merges into a single NAVIGATION column and pairs with an
ACTIONS column.
**Depends on:** `fb-core.js`'s `help` module (`open()`, `_rows()`,
`_groupHints()`), `window.FB_ROUTES`, the active page's `FB.keys`
binding table.
**Deferred, tracked separately:** `docs/topbar-chrome-spec.md` §7 also
deferred this same overlay restructure and `:show`'s fate together — this
document resolves only the overlay; `:show` remains undecided.
**Reference:** a live capture of GitHub's actual "Keyboard shortcuts" dialog
(pasted by magnus during design) is what "copy GitHub's structure" resolves
to below — see §1 for what was actually taken from it versus deliberately
not adopted.

---

## 0. Why this exists

Two gaps found while designing the topbar redesign, both about the same
underlying problem — the overlay only ever documents the *active page's*
own binding table, never the chrome that gets you *to* a page in the first
place:

1. `/`, `:`, and `g` itself are not documented anywhere in the overlay —
   only page verbs and (since #149) the `g`-map are.
2. `help.open()` returns `false` (silent no-op) when the current page has no
   `FB.keys` set at all, or one with zero hinted bindings — exactly the
   pages where a confused user is most likely to reach for `?`.

---

## 1. What "copy GitHub's structure" resolves to

GitHub's real dialog (not the docs page, which describes shortcuts but not
the dialog's own layout) is a **vertical stack of fully-expanded, named
sections** — "Repositories," "Code view," "Site-wide shortcuts," etc. — each
a heading followed by a plain list of rows. There is no left-nav category
sidebar, and critically, no click-to-expand/"see all" affordance — every
relevant section renders in full immediately. That last point needs no
change here: freebooks' overlay already renders everything at once with no
progressive disclosure, matching the exhaustive-by-default doctrine from
`payables-ux-spec.md` P1-6 ("Overlay is exhaustive... one source of truth").

**Adopted:** the named-sections structure, now realized as a two-column
side-by-side layout (§2) — NAVIGATION on the left, ACTIONS on the right.

**Not adopted (v1 → v2 revision):** the earlier Global + Go to page stacked
sections (PR #283) are merged into the single NAVIGATION column. The old
separate "Global" and "Go to page" headings are gone.

**Not adopted:** the INSERT column is removed entirely. INSERT bindings
(Esc-to-cancel, etc.) are obvious and only cluttered the panel; they are
no longer rendered. The old NORMAL heading is renamed to ACTIONS.

**Not adopted:** Esc, `?`, and standalone `g` are not shown anywhere in the
overlay. Esc closes the overlay (still wired functionally in `_dispatch`),
`?` toggles it (obvious — you pressed it to get here), and `g` is obvious
from the `g <key>` Go to page rows listed below it in NAVIGATION.

**Not adopted:** GitHub's row format (description on the left, key badge(s)
right-aligned). Both columns use freebooks' own existing row format
(`<kbd>` left, description right, via `_rows()`) for consistency.

---

## 2. New layout

Two columns side by side under a single title row:

```
┌─────────────────────────────────────────────────────────┐
│ Keyboard shortcuts            <page name>                │
├──────────────────────────┬──────────────────────────────┤
│ NAVIGATION               │ ACTIONS                      │
│   /  Search               │   (page bindings,             │
│   :  Command              │    grouped by hint)           │
│   h/l  Move left / right   │                              │
│   j/k  Move up / down      │                              │
│   gg/G  Move to first /    │                              │
│          last row          │                              │
│   g i  Go to Inbox         │                              │
│   g p  Go to Payables      │                              │
│   ...                     │                              │
└──────────────────────────┴──────────────────────────────┘
```

The diagram shows example `g`-map rows for illustration; the actual entries
come from `window.FB_ROUTES` (`api/src/nav-registry.js`), which has been
through multiple IA restructures (Bank dropped per issue #137, Reports
split into Statements/Books, `b` reassigned, `g d`/`g r` no longer exist).
A hardcoded list here would only add another stale copy of a table that's
already drifted once. The inlined g-map loop in `help.open()` is the actual
source of truth; the diagram's job is to show layout position, not content.

Concretely, in `help.open()`'s template: a `.fb-keys-main` flex container
holds `.fb-keys-nav` (left) and `.fb-keys-actions` (right). The standalone
footer (`? close` / `Esc close`) is removed entirely; the old Global and
Go to page stacked sections are merged into NAVIGATION.

**NAVIGATION section rows** (left column; static chrome constants, NOT
derived from any binding table — true chrome, not page verbs), in order:

| Keys | Hint |
|---|---|
| `/` | Search |
| `:` | Command |
| `h/l` | Move left / right |
| `j/k` | Move up / down |
| `gg/G` | Move to first / last row |

followed by the g-map entries from `window.FB_ROUTES`, each with its hint
prefixed **"Go to "** (e.g. "Go to Inbox", "Go to Payables"):

| Keys | Hint |
|---|---|
| `g <key>` | Go to <route label> |
| ... | ... |

The "Go to " prefix makes the g-map rows self-describing as navigation
targets, distinct from the page verbs in ACTIONS.

**ACTIONS section** (right column): the active page's NORMAL-mode hinted
bindings, grouped via `_groupHints()` — same grouping as before. The
heading is "ACTIONS" (was "NORMAL"). If there is no active set or zero
hinted NORMAL bindings, an honest `—` placeholder is shown (same empty
state as the old per-mode placeholder).

**Removed from the overlay:**
- The INSERT column — removed entirely. INSERT bindings exist but are
  not rendered (Esc-to-cancel is obvious).
- Esc — not shown (it closes the overlay; obvious).
- `?` toggle help — not shown (you pressed it to open this; obvious).
- `g` standalone — not shown (obvious from the `g <key>` Go to page rows
  directly below the static rows).
- The old "Global" and "Go to page" section headings — replaced by the
  single "NAVIGATION" heading.
- The old standalone footer (?/Esc close) — already gone since PR #283.

---

## 3. Fix: the overlay must always open something

Today, `open()` returns `false` (silent no-op, per `_activeSet()` returning
null, or a set with zero hinted bindings) on pages with no `FB.keys` set at
all. Once NAVIGATION renders independently of the active page's bindings,
there is no longer a reason for the overlay to open empty-handed on those
pages — it should always show at least NAVIGATION, with ACTIONS shown as an
honest "—" placeholder rather than declining to open at all.

**This is not enough on its own.** The keyboard trigger in `_dispatch`
(`fb-core.js` L340–348) had its own, separate `_activeSet()` gate that
short-circuits *before* `help.open()` is ever called. PR #283 already
relaxed it to:

```js
if (e.key === '?') {
  var cur = _activeSet();
  var cm = (cur && cur.set.getMode) ? cur.set.getMode() : 'NORMAL';
  if (cm !== 'NORMAL' || _isEditableTarget(e)) return;
  ...
  help.open();
}
```

Dropping the `if (!cur) return;` line and defaulting `cm` to `'NORMAL'`
when there's no active set lets `help.open()` be called unconditionally in
NORMAL mode outside editable targets. `open()` itself then decides what to
render, per the always-open behavior above. v2 inherits this fix unchanged.

---

## 4. Explicitly out of scope

- `:show`'s fate — tracked in `docs/topbar-chrome-spec.md` §7, unresolved.
- Any change to `?`'s trigger guards (NORMAL-mode-only, not-while-typing) —
  unchanged from `payables-ux-spec.md` P1-6.
- Showing INSERT bindings anywhere — deliberately removed (§2).

---

## 5. Files touched

- `api/public/fb-core.js` — `help.open()` rewritten: NAVIGATION column
  (static `/ : h/l j/k gg/G` rows + g-map entries with "Go to " prefix,
  inlined from `window.FB_ROUTES`) + ACTIONS column (NORMAL bindings via
  `_groupHints()`, renamed from "NORMAL"); INSERT column, Global block, and
  "Go to page" heading removed. The `_dispatch` `?` trigger relax
  (always-open fix) was already applied in PR #283 and is unchanged here.
  The now-unused `_navRows()` helper is left in place (harmless).
- `api/public/common.css` — `.fb-keys-cols`/`.fb-keys-col` replaced by
  `.fb-keys-main` (flex container) + `.fb-keys-nav` (left, `flex: 0 0 auto`)
  + `.fb-keys-actions` (right, `flex: 1; min-width: 0`); `.fb-keys-global`
  removed.
- `docs/help-overlay-chrome-spec.md` — this document (v2 layout).
