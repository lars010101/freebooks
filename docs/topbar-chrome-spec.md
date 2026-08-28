# Topbar Chrome Spec — GitHub-style header, retiring the bottom status line

**Status:** Draft — design agreed in principle (magnus, 2026-08-28), not yet built.
**Supersedes:** the bottom status line (`#fb-status-line`, built by `layoutEnd()` in
`api/src/pages/common.js`) and the per-page `+ Journal Entry` topbar button.
**Retains unchanged:** `/` search and `:` command-bar behavior (`fb-core.js`
`FB.search`/`FB.palette`, `fb-command.js`), the period control's resolved-label
rule (`docs/global-period-selector-chrome-spec.md`), the notification bell's
existing data source (`docs/fx-automation-spec.md` §7), the company switcher
(`fbToggleCompany`, `common.js`).
**Explicitly deferred, not decided here:** killing the `:show` alias, and
restructuring the `?` help overlay (NAV section reorder + a new Global
section). Both were discussed in the design conversation that produced this
spec; neither is resolved. See §7.
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
entirely. It does not touch page-level navigation (`g`-map, `?`, `:`
commands) — those are unchanged; this is chrome-only.

---

## 1. Layout — left to right

| Element | Behavior | Status |
|---|---|---|
| Company switcher | Mark + name + caret. Opens `#tb-company-dropdown` via the existing `fbToggleCompany` | Unchanged, restyled |
| Period selector | Collapsed label = period name (`FY2026`) or `start – end` for a custom range | Unchanged, relocated (already specced — see below) |
| Search | Same `#tb-global-search` input, same placeholder, same `/`/`:` dispatch | Unchanged, relocated |
| Chat with AI | Icon, disabled/greyed | Stub — no backing feature yet |
| `+` New menu | Dropdown of create-shortcuts | New affordance, reuses existing data (§5) |
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
menu's "New Journal Entry" row (§5). Any other page-specific quick-action
button injected via `topBarContext().actions` is likewise superseded by the
`+` menu, the `g`-map, or search — this design has no room for bespoke
per-page topbar buttons.

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

Reuses `newTargets()` (`fb-core.js`, built as `:new`'s `itemSource` off the
action catalog's `create: true` entries) as its item list, verbatim — no
new registry, no new server surface. Clicking a row does exactly what
selecting it from `:new`'s dropdown does today. This is the mouse-parity
affordance for `:new`; it does not change what `:new` itself does or
require touching `fb-command.js`.

`newTargets()` already dedupes by destination route (e.g. `bill.create` and
`bill.draft.save` both land on `/bill/edit` and collapse to one row) — the
`+` menu will show fewer rows than the raw count of `create: true` catalog
entries. This is inherited, existing behavior, not something this spec adds
or needs to replicate.

---

## 6. Theme toggle

`common.js` already fully implements this — `fbApplyTheme(t)`,
`window.fbToggleTheme()`, and the `:light`/`:dark` command aliases
(`fb-command.js`) all exist and work today. What's missing is markup:
`fbApplyTheme` looks for `#fb-theme-icon`/`#fb-theme-btn` to update their
icon/title, but no page currently renders those elements — the toggle has
been keyboard/command-only (`:light`, `:dark`) with no visible button. This
spec's only change is adding that button to the topbar, wired to the
existing `fbToggleTheme()` — no new client logic.

---

## 7. Explicitly deferred (raised during design, not decided)

- **`:show` alias's fate.** Flagged as a possible duplicate of `?` + `g`-map
  navigation ("might kill it") — not decided. Out of scope here regardless
  of outcome; `:bill`, `:post`, `:pay`, `:new`, etc. are untouched either way.
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
  `+`/theme/company/period dropdown styles.
- `api/public/common.js` — theme button wiring (`fbApplyTheme` already
  targets the right IDs, §6), remove dead footer-search wiring.
- `api/public/fb-core.js` — `FB.status` auto-dismiss + nav-dismiss (§3),
  `_refreshInboxBadge()` retarget (§4). `FB.search`/`FB.palette` unchanged.
