# Topbar Chrome Spec — GitHub-style header, retiring the bottom status line

**Status:** Draft — design agreed in principle (magnus, 2026-08-28), not yet built.
**2026-09-01 update:** every `:` command-bar reference in this document
(`FB.palette` command mode, `:new`, `:show`, `:light`/`:dark`, `:bill`,
`:post`, `:pay`, etc.) describes a system that has since been **fully
retired** (`global-search-spec.md`) — `/` search is the sole summon key,
Ctrl+K has no binding, and `fb-command.js`'s `ALIASES` table is empty. Where
this doc's reasoning depended on one of those aliases still existing, see
the inline notes added at each spot rather than treating the original text
as current.
**2026-09-03 update:** §5's premise — the `+` menu as a mouse-parity surface
for `newTargets()`/the full `create: true` action catalog — is gone. The menu
is now a small, fixed, hand-picked list of operational (transaction) actions
only; master-data/setup actions (new account, new partner, new tax code,
etc.) were dropped rather than bucketed into a "Setup" submenu (considered,
rejected — see §5). `FB.palette` (the module `newTargets()`/`preloadCatalog()`
lived in, already gutted of its command-mode half on 2026-09-01) was deleted
from `fb-core.js` in its entirety as a result — nothing references it anymore.
Separately, `global-search-spec.md` §1–§3 changed how `/` search itself opens
and scopes (blank bar, no auto-opening dropdown, ranked-not-picked scope) —
unrelated to the `+` menu, but also falsifies this doc's old "`FB.search`
unchanged" claim (§8).
**Supersedes:** the bottom status line (`#fb-status-line`, built by `layoutEnd()` in
`api/src/pages/common.js`) and the per-page `+ Journal Entry` topbar button.
**Retains unchanged:** `/` search (`fb-core.js` `FB.search`); `:` command-bar
behavior does NOT survive — see the 2026-09-01 update above — the period
control's resolved-label rule (`docs/global-period-selector-chrome-spec.md`),
the notification bell's existing data source (`docs/fx-automation-spec.md`
§7), the company switcher (`fbToggleCompany`, `common.js`).
**Explicitly deferred, not decided here:** killing the `:show` alias — since
resolved elsewhere: `global-search-spec.md` §0 retired `:show` outright, no
replacement built. Restructuring the `?` help overlay (NAV section reorder +
a new Global section) was later resolved by `help-overlay-chrome-spec.md`
(which also had to remove its own now-dead `: Command` row on 2026-09-01).
**Reference mockup:** interactive prototype built during design —
`https://claude.ai/code/artifact/12f4d5d7-2118-41c8-99d0-7931b5040db7`
(company/period cluster, `+` menu, notification bell, status banner
behavior — all of §1–§4 below were validated there before being written up).

---

## 0. Why this exists

The sidebar was removed (PR #146, per `command-bar-ux-spec.md`) in favor of
`/`, `:`, and the `g`-prefix map. That cutover left the bottom status line
(`#fb-status-line`) as the only place carrying global chrome — search input,
command-status feedback, inbox count, mode indicator — visually disconnected
from the company/period identity, which lives in the *top* bar. This spec
consolidates all of it into one topbar, styled after GitHub's header (company
switcher, search, quick actions, notifications), and retires the bottom line
entirely. It does not touch page-level navigation (`g`-map, `?`) — those are
unchanged; this is chrome-only. (`:` commands, mentioned here as unchanged at
draft time, were fully retired afterward — see the 2026-09-01 header note.)

---

## 1. Layout — left to right

| Element | Behavior | Status |
|---|---|---|
| Company switcher | Mark + name + caret. Opens `#tb-company-dropdown` via the existing `fbToggleCompany` | Unchanged, restyled |
| Period selector | Collapsed label = period name (`FY2026`) or `start – end` for a custom range | Unchanged, relocated (already specced — see below) |
| Search | Same `#tb-global-search` input, `/` dispatch | Unchanged at draft time; placeholder and open behavior later changed twice — see `global-search-spec.md`, not restated here |
| Chat with AI | Icon, disabled/greyed | Stub — no backing feature yet |
| `+` New menu | Dropdown of a fixed, short operational-action list | New affordance (§5) |
| Notifications bell | Existing `tb-notif-btn`/`tb-notif-badge`/`tb-notif-dropdown` | Unchanged, gains a second data source (§4) |
| Theme toggle | Cycles light/dark | New button, wires up already-dead-code (§6) |

Removed entirely: the bottom status line and its four children
(`.tb-search-wrap` duplicate, `#tb-status-msg`, `#fb-sl-inbox`,
`#fb-vim-mode`) — search moves up (unchanged behavior, just relocated),
status feedback becomes the banner in §3, the inbox count moves onto the
bell (§4), and the NORMAL/INSERT indicator (`#fb-vim-mode`) is dropped
without a replacement — out of scope per the original design conversation,
revisit only if its absence turns out to matter in practice.

Also removed: the hardcoded `<a ... class="tb-btn tb-btn-quiet">+ Journal
Entry</a>` rendered on every page by `navBar()` — superseded by the `+`
menu's "Journal Entry" row (§5; unprefixed — see §5's 2026-09-03 revision on
why "New" was dropped from every row label). Any other page-specific
quick-action button injected via `topBarContext().actions` is likewise
superseded by the `+` menu, the `g`-map, or search — this design has no room
for bespoke per-page topbar buttons.

**Visual system:** the topbar takes over `--sb-bg` (the navy that used to be
the sidebar's background, `#18293f` / `#0e1520` dark) instead of `--tb-bg`
(current near-white `#f9fafc`) — the sidebar's one moment of brand color
moves into the surviving persistent chrome rather than disappearing.
`--tb-text`/`--tb-border` need light-on-navy equivalents; the reference
mockup's `--navy-text` (`rgba(220,228,242,.82)`), `--navy-text-strong`
(`#fff`), and `--navy-hover` (`#223650` light / `#16243a` dark) are
concrete starting values, not final tokens — reconcile with `common.css`'s
existing dark-mode block during implementation rather than introducing a
second color system.

The search input carries `tabindex="-1"` today (reachable only via `/`/`:`,
not Tab-order) — preserve that in the relocated markup; it was deliberate,
not an oversight.

---

## 2. Company switcher and period selector

No behavior change. `fbToggleCompany` (`common.js`) and the period control
(`docs/global-period-selector-chrome-spec.md`) are reused verbatim, just
repositioned into a shared top-left cluster (mirroring GitHub's org/repo
breadcrumb position). The period control's collapsed-label rule — a period
name for a predefined period, `start – end` for a custom range — is already
specced there; this document does not restate or modify it.

---

## 3. Status banner — replaces `#tb-status-msg`, with one deliberate behavior change

`FB.status` (`fb-core.js`, "the ONE transient-feedback channel," ratified
2026-07-23) is unchanged as a *concept* — one channel, ok/warn/err, used
app-wide (`fb-core.js` command execution, `fb-list.js` save confirmations).
Two things change:

1. **Auto-dismiss, ~5 seconds.** This **reverses** the 2026-07-23 ratification
   that the message "NEVER auto-dismisses... stays until the next one
   replaces it." Overridden here (magnus, 2026-08-28): the never-dismiss
   rule existed to protect a slow reader from a timed-out message, but in
   practice reads as chrome that won't go away. 5 seconds is long enough to
   read a short confirmation or error; a new message arriving mid-display
   still immediately replaces the old one and restarts the timer, same as
   before.
2. **Instant dismiss on navigation, never on tab/visibility change.** A
   message describing the page just left has nothing to do with the page
   that loads next, so it must not persist across a route change. This
   should hook into `fbNavigate` itself (the same chokepoint the leave-veto
   already lives in, per `keyboard-ux-spec.md` §7) — call the dismiss
   directly from there, not from a generic `visibilitychange` listener.
   Switching browser tabs or alt-tabbing away is explicitly **not** a
   navigation and must leave the banner untouched; do not wire this to any
   visibility/focus event.

**Layout:** the banner sits in normal document flow directly under the
topbar and animates its own height open/closed — it must **push the page
content down**, not overlay it. (The reference mockup got this wrong on the
first pass using `position: absolute`, which doesn't reserve layout space;
the fix was a `grid-template-rows: 0fr → 1fr` expand on a wrapping element.
Whatever the real implementation's CSS approach, the requirement is: no
overlap with page content in either direction, expanding or collapsing.)

---

## 4. Notifications bell — also fixes an existing dead badge

No change to the bell's existing behavior: `_refreshNotifBadge()` and
`_toggleNotifDropdown()` (`fb-core.js`, `fx-automation-spec.md` §7) keep
reading `notifications.list`/`notifications.mark_read` exactly as today.

**Separately, found during this design pass:** the Inbox pending-count badge
is currently dead. `_refreshInboxBadge()` (`fb-core.js`, A5 §10.4) has a
correct, working fetch against `inbox.list`, but targets `#sb-inbox-badge` —
a sidebar element that no longer exists since the sidebar's removal. It has
silently no-op'd (`if (!badge) return`) since that cutover. The static
`"0 pending"` text in the old bottom-bar footer was never wired to anything
either.

**Fix, scoped to this spec:** retarget `_refreshInboxBadge()` at a new
element on the bell, and combine it with the existing notification count on
one visible badge number. Keep the two data sources visually distinct
inside the dropdown rather than merging them: an "Inbox — N pending" section
(linking to `g i`) above the existing, unchanged Notifications list. Do not
unify `inbox.list` and `notifications.list` into one backend query — this is
a UI co-location fix, not a data-model change.

---

## 5. `+` New menu

**Superseded 2026-09-03 — this section originally specced a catalog-driven menu; that design shipped, then was deliberately narrowed. What follows describes the current, narrower menu; the catalog-driven history is kept below for context.**

### 5.1 Current design — fixed, operational-only, four rows

The menu is a **hardcoded list of four rows**, `NEW_MENU_ITEMS` in `fb-core.js`, not derived from `/api/actions` or any other registry:

```
Journal Entry        → /journal/voucher
Bill from Supplier    → /bill/edit
Invoice to Customer   → disabled (AR not built yet — greyed out, title="Coming soon")
Payment                → /payment/new
```

Two deliberate departures from the original (§5.2) design:

- **No "New" prefix.** Every row read "New Bill", "New Payment", etc.; the leading word was dropped from all four (owner's call) — the menu's own heading/icon already establishes "these are things you create."
- **Operational only — no master-data/setup rows.** The original catalog-driven menu surfaced every `create: true` action indiscriminately: alongside the three (now four) transactional rows above, it also listed New account, New tax code, New partner, New period, New journal (book), New cost center, New exchange rate, and Grant access — eight setup/admin rows outweighing the transactional ones a user reaches for constantly. A collapsible "Setup" sub-section grouping those eight was considered and explicitly rejected (owner's call) in favor of dropping them from this menu entirely; they remain reachable from their own pages (Settings, Chart of Accounts, etc.), just not from `+`. This includes **New partner** — even though bill/invoice entry already lets you create a partner inline while typing, so its absence here isn't a regression for the common path.

Since the list is fixed rather than catalog-derived, `newTargets()`,
`_fetchCatalog()`, `_pageLabelFor()`, and the whole `FB.palette` module they
lived in (`fb-core.js`) were deleted outright — nothing else consumed them
(`/api/actions`/`action-catalog.js` on the server are untouched; they still
serve agent self-discovery, unrelated to this menu). `FB.util.newTargets`
and `FB.palette` are gone from the `window.FB` object.

**Invoice to Customer** is a placeholder: AR/customer invoicing doesn't
exist yet. It renders disabled (`.tb-new-item-disabled`, `common.css`) rather
than being omitted, so the eventual feature has a reserved, visible slot
instead of the menu silently growing a row later.

### 5.2 Original design (2026-08-28 draft, superseded above)

Reused `newTargets()` (`fb-core.js`, originally built as `:new`'s
`itemSource` off the action catalog's `create: true` entries) as its item
list, verbatim — no new registry, no new server surface. At draft time,
clicking a row did exactly what selecting it from `:new`'s dropdown did, and
this button was conceived as `:new`'s mouse-parity affordance.

**2026-09-01: that premise is gone.** `:new` (and all of `:` command mode)
was retired before the `+` button's implementation shipped — confirmed via
`git log` that `:new` was already deleted from `fb-command.js`'s `ALIASES`
prior to this doc's own build. The `+` button was, at that point, the *only*
surface for `newTargets()`; there was no keyboard equivalent (raised in
conversation as a possible `p`-key or similar addition — never built).

**2026-09-02:** `bill-post-payment-consolidation-spec.md` added `bill.payment.record`
to the `create: true` catalog entries, routed to the new `/payment/new` page
(unscoped New Payment — the only entry point for a multi-bill payment,
superseding the retired `Shift+P` panel). At the time this landed in the `+`
menu automatically, same as every other `create: true` entry — that
automatic-inclusion mechanism no longer exists as of §5.1.

`newTargets()` deduped by destination route (e.g. `bill.create` and
`bill.draft.save` both landed on `/bill/edit` and collapsed to one row) — a
property of the now-deleted mechanism, not something the fixed list in §5.1
needs, since each of its four rows is simply written once.

---

## 6. Theme toggle

`common.js` already fully implements this — `fbApplyTheme(t)` and
`window.fbToggleTheme()` exist and work today. At draft time the toggle was
also reachable via `:light`/`:dark` command aliases; those were already
retired by `global-search-spec.md` §0 in favor of this very button, so by
the time this spec ships there is no command-line path left, only whatever
markup this spec adds. What's missing is that markup: `fbApplyTheme` looks
for `#fb-theme-icon`/`#fb-theme-btn` to update their icon/title, but no page
currently renders those elements — the toggle has no visible button yet.
This spec's only change is adding that button to the topbar, wired to the
existing `fbToggleTheme()` — no new client logic.

---

## 7. Explicitly deferred (raised during design, not decided)

- ~~**`:show` alias's fate.**~~ **Resolved.** `global-search-spec.md` §0
  retired `:show` outright (no replacement), and every other alias named
  here — `:bill`, `:post`, `:pay`, `:new` — was retired alongside it. None
  of `:` command mode survived.
- **`?` help-overlay restructure.** Agreed in discussion: the NAV (`g`-map)
  section should render first/top-left instead of last, and a new "Global"
  section should document `/`, `:`, and `g` itself (currently undocumented
  anywhere in the overlay). Neither change is built. This spec's `+`/theme/
  notification additions do not depend on it, but should eventually appear
  in that Global section once it exists.
- **Chat with AI.** Icon only, disabled. No backend, no interaction — pure
  placeholder for a future feature.

---

## 8. Files touched

- `api/src/pages/common.js` — `navBar()` (new topbar markup), `layoutEnd()`
  (remove the footer), `topBarContext()` (verified: every `actions` value is
  already `''` — the slot and the `${ctx.actions}` rendering at L154 are
  dead and safe to delete outright, not just superseded).
- `api/public/common.css` — topbar color tokens (§1), status-banner layout,
  `+`/theme/company/period dropdown styles. 2026-09-03: added
  `.tb-new-item-disabled` for the Invoice-to-Customer placeholder row (§5.1);
  removed `.tb-new-empty` (dead once the menu stopped needing a catalog-load
  "Loading…" state).
- `api/public/common.js` — theme button wiring (`fbApplyTheme` already
  targets the right IDs, §6), remove dead footer-search wiring.
- `api/public/fb-core.js` — `FB.status` auto-dismiss + nav-dismiss (§3),
  `_refreshInboxBadge()` retarget (§4). 2026-09-03: `_populateNewMenu()`/
  `_wireNewMenu()` rewritten around the fixed `NEW_MENU_ITEMS` list (§5.1);
  the entire `FB.palette` module deleted. `FB.search` also changed the same
  day, independently — see `global-search-spec.md`'s changelog, not
  restated here.
