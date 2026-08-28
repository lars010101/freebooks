# `?` Help Overlay Restructure — Global section, NAV reordered

**Status:** Draft — design agreed (magnus, 2026-08-28), not yet built.
**Amends:** the overlay described in `docs/payables-ux-spec.md` P1-6 and the
deferred item in `docs/keyboard-ux-spec.md` §9 ("`?` overlay GLOBAL
section... the overlay currently documents the active page set only").
**Depends on:** `fb-core.js`'s `help` module (`open()`, `_navRows()`,
`_rows()`, `_groupHints()`), `window.FB_ROUTES`, the active page's `FB.keys`
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

**Adopted:** the vertical-stack-of-named-sections structure, applied to the
*two new* sections below (§2).
**Not adopted:** collapsing the existing NORMAL | INSERT side-by-side
columns into vertically-stacked sections too — a truer 1:1 copy of GitHub
would do this, but the columns stay as-is (magnus, 2026-08-28); only Global
and Go to page are added as new stacked sections above them.
**Not adopted:** GitHub's row format (description on the left, key badge(s)
right-aligned). The two new sections use freebooks' own existing row
format (`<kbd>` left, description right, via `_rows()`) instead, for
consistency with the unchanged NORMAL/INSERT columns directly below them —
introducing a second row convention in the same panel would look like two
different tools glued together. Flagging this as a judgment call, not
something explicitly decided in the design conversation.

---

## 2. New layout

```
┌─────────────────────────────────────────────┐
│ Keyboard shortcuts            <page name>    │
├─────────────────────────────────────────────┤
│ Global                                       │
│   /  Search        :  Command                │
│   g  Go to page (see below)                  │
│   ?  Toggle this help    Esc  Close           │
├─────────────────────────────────────────────┤
│ Go to page                                   │
│   ...                                        │
├───────────────────────┬───────────────────────┤
│ NORMAL                 │ INSERT                │
│   (unchanged)          │   (unchanged)         │
└───────────────────────┴───────────────────────┘
```

The diagram deliberately omits named example rows for "Go to page" —
`window.FB_ROUTES` (`api/src/nav-registry.js`) has been through multiple IA
restructures in the last few weeks (Bank dropped entirely per issue #137,
Reports split into Statements/Books, `b` reassigned from Bank to Books,
`g d`/`g r` no longer exist), so a hardcoded example here would only add
another stale copy of a table that's already drifted once in
`keyboard-ux-spec.md` §2. `_navRows()` (§2 below) is the actual source of
truth; the diagram's job is to show layout position, not content.

Concretely, in `help.open()`'s template: a new `.fb-keys-global` block and
the existing `.fb-keys-nav` block (renamed heading, see below) both render
**before** `.fb-keys-cols`, in that order. The standalone footer
(`? close` / `Esc close`) is removed — folded into the Global section's own
`?`/`Esc` rows, so close-hints aren't duplicated in two places.

**Global section rows** (new; static, not derived from any binding table —
these are true chrome constants, not page verbs):

| Keys | Hint |
|---|---|
| `/` | Search |
| `:` | Command |
| `g` | Go to page (see below) |
| `?` | Toggle this help |
| `Esc` | Close |

**Go to page section:** `_navRows()`'s existing output, unchanged — reads
`window.FB_ROUTES` exactly as today (same source `_gResolve()` uses, so the
`g`-map and this section can't drift apart). Only the heading label changes,
from `NAV` to `Go to page`, and its position moves from after `.fb-keys-cols`
to before it.

**NORMAL / INSERT columns:** unchanged in every respect — same `_groupHints`
grouping, same per-page binding table, same position relative to each other.

---

## 3. Fix: the overlay must always open something

Today, `open()` returns `false` (silent no-op, per `_activeSet()` returning
null, or a set with zero hinted bindings) on pages with no `FB.keys` set at
all. Once Global and Go to page render independently of the active page's
bindings, there is no longer a reason for the overlay to open empty-handed
on those pages — it should always show at least Global + Go to page, with
NORMAL/INSERT sections omitted (or shown as an honest "—" placeholder,
matching the existing per-mode empty state already used when one mode has
no hinted bindings) rather than declining to open at all.

**This is not enough on its own.** The keyboard trigger in `_dispatch`
(`fb-core.js` L340–348) has its own, separate `_activeSet()` gate that
short-circuits *before* `help.open()` is ever called:

```js
if (e.key === '?') {
  var cur = _activeSet();
  if (!cur) return;                                    // ← never reaches help.open()
  var cm = cur.set.getMode ? cur.set.getMode() : 'NORMAL';
  if (cm !== 'NORMAL' || _isEditableTarget(e)) return;
  ...
  help.open();
}
```

Fixing only `open()`'s internal behavior leaves the keyboard path exactly
as broken as it is today on a keyless page — pressing `?` would still do
nothing, because the dispatcher bails before `open()` runs at all. Since
the entire reason for this fix (§0) is the keyboard press, not a topbar
button, the trigger must be relaxed too:

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
when there's no active set (there's no mode to be in INSERT *of* when
nothing is bound) lets `help.open()` be called unconditionally in NORMAL
mode outside editable targets, exactly the same guard the trigger already
applies everywhere else. `open()` itself then decides what to render, per
the always-open behavior above. This directly fixes the original complaint
that started this design thread: `?` on a page you don't have muscle memory
for was exactly where it was most likely to do nothing.

---

## 4. Explicitly out of scope

- `:show`'s fate — tracked in `docs/topbar-chrome-spec.md` §7, unresolved.
- Any change to `?`'s trigger guards (NORMAL-mode-only, not-while-typing) —
  unchanged from `payables-ux-spec.md` P1-6.
- Collapsing NORMAL/INSERT into stacked sections (§1) — deliberately not
  done here.

---

## 5. Files touched

- `api/public/fb-core.js` — `help.open()` (new Global block, `_navRows()`
  heading rename + reposition, footer removal, always-open fix per §3);
  `_dispatch`'s `?` trigger (L340–348, relax the `_activeSet()` gate, §3).
- `api/public/common.css` — `.fb-keys-global` styling (likely identical to
  `.fb-keys-nav`'s existing rules, reused rather than duplicated).
