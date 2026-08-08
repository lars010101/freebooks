# Keyboard UX Spec — navigation, go-to map, palette, switcher, toggle verb

**Status:** ratified 2026-07-28 (Slack design thread, magnus) · **Phase:** K1 shipped
**Consumers:** `api/src/nav-registry.js`, `api/public/fb-core.js`, `api/public/common.js`, `api/public/fb-list.js`, `api/src/pages/common.js`

---

## 0. Agent-first UI doctrine (ratified 2026-07-31, magnus — roadmap §0q)

freebooks is agent-first: the API/MCP surface is the product; the web UI is
a viewer plus a small human correction surface. Consequences for this spec:

- **Mouse parity is dropped.** Existing mouse support stays in place, but
  parity is no longer a requirement, a review criterion, or a test gate.
  Historical "mouse parity" ratifications below stand as descriptions of
  shipped behavior, not obligations for future work.
- **The verb surface is frozen.** No new keyboard verbs without explicit
  magnus ratification (P2-6 rebinding is dropped).
- **The coverage gate is single-screen.** `test:keys` runs the full
  key-coverage assertions on journal-new only; every other route is
  smoke-checked (loads, zero uncaught JS errors). Per-screen exemption
  tables were retired with the crawl (git history keeps them).
- **New scope ships API-first.** UI for new features is read-only rendering
  of API results; write-UI is built only on explicit request.

---

## 1. Route registry — the single source of truth

Every app route lives ONCE in `api/src/nav-registry.js`. Four consumers share
the table so navigation can never drift:

1. **Sidebar** — `navBar()` (`api/src/pages/common.js`) renders `.sb-nav`
   anchors from entries with `sidebar: true`. Sidebar DOM is byte-equivalent
   to the pre-registry markup (same anchors, hrefs, order, active-state).
2. **`{`/`}` cycling** — `common.js` reads the rendered `.sb-nav` anchors.
3. **g-prefix go-to map** — `fb-core.js` reads `window.FB_ROUTES` (injected
   by `navBar` into every page) and maps `gKey` letters → routes.
4. **Command palette** — entries with `palette: true` surface as
   `Go to {label}` rows (scope `nav`).

Entry shape: `{ key, route, label, icon, sidebar, gKey, palette, absolute }`.
`route` uses the `:company` placeholder; `absolute: true` for company-less
routes (`/setup/new-company`). Adding a route = appending one entry — it
becomes keyboard-reachable immediately (§2/§4). Rules live in the registry
file's header comment.

## 2. g-prefix go-to map

Ratified slate (d/v added 2026-07-28; v freed 2026-08-05 Receivables dropped, magnus):

| Sequence | Action |
|---|---|
| `g d` | Dashboard |
| `g r` | Reports |
| `g b` | Bank |
| `g p` | Payables |
| `g s` | Settings |
| `g j` | Journal |
| `g i` | Inbox (reassigned 2026-08-03 per spec §10; bank-import reachable via `g b` + palette) |
| `g c` | Company switcher (reserved — not a route) |
| `g g` | List cursor to first row, then **absolute page top** (both scroll containers, next frame) |
| `g <other>` | Cancel — the key proceeds through normal dispatch untouched |

`g j` (Journal) activated 2026-07-31 with the A3j Journal register page. The
review queue moved to the Inbox (`g i`) 2026-08-03 per spec §10; the Journal
list is now the pure posted register.

**Dispatch semantics** (fb-core `_dispatch`, capture phase):

- One pending-`g` state (500 ms window) lives in fb-core. The legacy copies
  in `common.js` and `fb-list.js` are **deleted** — unification was the point.
- Arming: bare `g` in NORMAL mode, never in editable targets
  (`_isEditableTarget`), never with Ctrl/Alt/Meta, and **only when no active
  page set claims `g`** (`_setClaims` — context-override doctrine: page
  bindings beat the global prefix).
- Second key resolves via `_gResolve`: `g` → gg, `c` → switcher, a registry
  `gKey` → navigate (`fbNavigate`, so the dirty-buffer leave-veto applies;
  `window.location` for absolute routes). Anything else cancels and falls
  through to normal dispatch.
- `G` (last row + **absolute page bottom**) — fb-list/fb-form binding on
  their pages, `common.js` bubble fallback elsewhere. G/gg scroll BOTH
  scroll containers (`#page-main` and window) on the NEXT frame: the row
  paint's `scrollIntoView('nearest')` would otherwise cancel the page
  scroll mid-flight (magnus K1 review 2026-07-28).
- **gg unification hook:** fb-core fires every `FB.nav.onGG(fn)` hook FIRST
  (cursor to first row), then forces absolute top on the next frame. Each
  FB.list instance registers a hook that calls `nav.first()` **only when its
  panel is visible** (`offsetParent` guard — settings mounts six instances;
  hidden tabs must no-op).

## 3. Company switcher keyboard contract

`g c` toggles `#tb-company-dropdown`. It reuses `fbToggleCompany`'s data path
(`common.js`, extended with an `onReady(opened)` callback) — no duplicated
fetch/render. While open, the switcher owns EVERY key (help-overlay
precedent — page bindings and `common.js` stay inert):

| Key | Action |
|---|---|
| `j` / `↓` | Highlight next option (sticky at bottom) |
| `k` / `↑` | Highlight previous option (sticky at top) |
| `Enter` | Follow the highlighted anchor — plain `.click()`, exactly the mouse path |
| `Esc` | Close |
| `g c` | Toggle closed (mirror of the open sequence) |

Keyboard highlight uses `.tb-company-focus` (mirrors `:hover` styling).
Mouse behavior (click header to open, outside-click to close) is unchanged.

## 4. Palette navigation source

Third palette source alongside page verbs and the API catalog: registry
routes with `palette: true` render as `Go to {label}` rows showing the `g`
key-equivalent (the palette doubles as a keyboard teacher). Fuzzy + recency
ranking identical to existing rows.

**api-scope rows** (the `/api/actions` catalog): two dispositions —
`execute` (payload-free, run directly: only `fx.fetch_rates`) and
`navigate` (opens the screen where the form lives). Navigate rows
**deep-link to their tab** (`/settings?tab=vat`, `/payables?tab=vendors`,
`/bank?tab=mappings` — the latter two honored by K1-review tab-param
support on those pages) so the row lands on the actual workflow, not the
page's default tab (magnus K1 review 2026-07-28).

**Dedupe rule:** the registry carries the decision. Routes already covered by
an action-catalog `navigate` entry (`/journal/new`, `/setup/new-company`)
keep `palette: false` — their catalog action labels describe the
destination well enough. `/bank/import` moved to the registry (`palette:
true`) because the catalog `bank.process` description lacked the word
"import", making it invisible to palette search — the registry emits a 'Go to
Bank Import' row that surfaces on 'bank import'/'import'. Its `gKey` was
dropped 2026-08-03 (spec §10): 'i' was reassigned to the Inbox, and
bank-import is reachable via `g b` + palette ('Go to Bank Import' row).
Sidebar routes and opening-balances (now a Settings tab, §6) carry `palette: true`. (A runtime
route-match dedupe was tried and rejected: catalog navigate targets like
`/payables` for `vendor.save` are action labels, not go-to rows — matching
on them swallowed the real `Go to` rows.)

## 5. `~` — the universal toggle verb

Ratified: `~` is THE toggle verb framework-wide (precedents: Vendors
`~` toggle-active, `payables-vendors.js`; vim's own toggle-case key).

**Semantics (ratified 2026-07-28, magnus): `~` toggles the state of the
ACTIVE CELL / focused control — it never cycles a group.** Toggle-button
groups (opening-balances filters, reports MoM/YoY) are ordinary `h`/`l`-
navigable button cells in their FB.form row; the focused button carries
the standard cell cursor, `~` flips that button alone, and `Enter`/`i`
activate it (fb-form's generic button-click). Radio-style groups keep
their own on/off semantics per button (re-toggle returns to neutral —
e.g. reports comparison: `~` on active MoM → none).

- **Bank transaction panel: `c` → `~` migrated 2026-07-28** (clear/unclear).
  `c` is released; on FB.list filter surfaces `c` remains 'clear filters'
  (different semantic, unchanged).
- Journal-new reversal is NOT a `~` — moved to `R` 2026-07-28 (magnus: `~`
  reads as toggle-true/false; reversal is a mode — vim's own `R` = replace
  mode). **Esc contract (ratified 2026-07-28, magnus):** INSERT-Esc from
  the reversal search ONLY exits edit → NORMAL (reversal stays active);
  NORMAL-Esc cancels the whole reversal back to normal JV edit. So
  `R` → (INSERT in search) `Esc` → NORMAL (still reversing) → `Esc` →
  cancelled. The NORMAL binding is `when: reversalMode`-guarded, so global
  Esc is untouched outside reversal.
- **Reversal pick → cursor lands on the date cell** (ratified 2026-07-28):
  after choosing a source entry (Enter on a result row), the form cursor
  moves to the header date cell in NORMAL (search blurred, results
  collapsed) — the reviewer is never stranded in the search input; `j`/`k`
  from date walk straight into the line grid.
- **Reversal shows the original entry read-only** (ratified 2026-07-28):
  on pick, the ORIGINAL (un-swapped) lines render as grayed, italic,
  plain-text rows ABOVE the editable swapped rows, under an "Original
  entry (read-only)" header row. These rows carry no inputs → excluded
  from the FB.form `lines` zone (`:not(.jv-orig-line)`), from `updateTotals`,
  and from `postEntry` (originals are never re-posted).
- **`~` never changes NORMAL/INSERT mode** (ratified 2026-07-28): toggles
  act via `click()` (no focus, no setMode). **Space activates the focused
  toggle/button** — parity alias of `~`/`Enter` on button cells (fb-form).
- **Toggle-button visuals (ratified 2026-07-28):** three states must be
  readable at a glance — OFF (default surface), ON (amber `--toggle-on`,
  never the cursor navy), FOCUSED (navy outline ring `.fb-form-cursor-btn`;
  the fill cursor is for value cells only). Active-fill + cursor-fill
  collision (both near-black) was owner finding #1.
- Future toggle semantics (reconcile clear/unclear, further comparison
  toggles) bind `~` — no per-screen invention.

## 6. Opening Balances placement

The opening-balances screen is the
once-per-company migration tool (enter the opening trial balance as of the
go-live date; posts one balancing journal batch). Precedent: **Xero keeps
"Conversion Balances" under Settings**; QBO enters opening balances per
account. **Relocated 2026-07-28 (magnus): it is now a Settings tab —
Settings → Opening Balances** (`/:company/settings?tab=opening-balances`),
following the standard showTab / lazy-load / `?tab=` deep-link pattern.
The old standalone route `/:company/opening-balances` 302-redirects to the
tab (bookmarks/links keep working); the nav-registry entry and the
new-company `Enter Opening Balances` link point at the tab. It is NOT the
sidebar; palette-reachable via §4. It carries no `g`
letter (run-once screen — letters are for high-frequency routes).

View filters (K1 review 2026-07-28; toggle model ratified same day):
**Balance Sheet · P&L · Non-Zero Only** — independent on/off buttons,
`h`/`l`-navigable cells of the filter row, `~` flips the focused one.
BS + P&L both on = all accounts (the old "All Accounts" button is
removed as redundant); both off = empty grid (strict checkbox semantics,
no magic case); Non-Zero ANDs with the type filter. The P&L view exists
for mid-year migration — YTD income/expense openings are required for a
correct full-year P&L (QBO/Xero conversion pattern). The screen is
FB.form (a posting grid with editable debit/credit cells and a balance
guard), not FB.list — the view-filter is the FB.form pattern; column
filters are an FB.list concept.

## 7. Modal keyboard contract (K2 — shipped 2026-07-28)

**Binding stack.** `FB.keys.push(name, def)` registers a set AND makes it the
exclusive dispatch owner until `FB.keys.pop(name)` (LIFO `_scopeStack` in
fb-core `_dispatch`). While a scope is pushed, page sets, the company
switcher, the g-prefix and `common.js` are all inert. Unmatched keys are
swallowed (`stopImmediatePropagation`) but NOT `preventDefault`'ed, so
typing into a modal input works while page verbs stay dead.

**FB.modal** (fb-core) is the one modal. Contract:

| Key | Action |
|---|---|
| `Esc` | Cancel — NEVER confirms (backdrop click = same) |
| Button letters | Per-modal, shown in the button (`Save w`); NORMAL mode only |
| `Enter` in a confirm input | Activates the armed `requiresConfirm` button |
| (danger button) | Carries NO letter key — deliberate friction |

- **Type-to-confirm** (GitHub repo-deletion pattern, ratified): destructive
  actions require typing an exact-match string; `requiresConfirm` buttons
  stay disabled until the input matches exactly. `getMode` returns INSERT
  while the input is focused, so a name containing `w`/`u`/`~` never fires
  a verb.
- **Leave-guard** (FB.list): `w` = write & leave, `u` = revert & leave,
  `Esc` = Stay — the w/u keys mirror the list's own write/revert doctrine.
  Esc/backdrop keeps buffers and cancels navigation.
- **Danger zone** (Settings → Company delete): type the exact company name
  to arm `Delete company`; Enter in the input fires it; server refusals
  (last-company / posted-books) surface in the modal's error slot.
- Focus: the confirm input (else first button) is focused on open; prior
  focus is restored on close. One modal app-wide; `FB.modal.isOpen()`.

**Guard chokepoint (2026-07-28):** the leave-veto lives INSIDE `fbNavigate`
itself — sidebar clicks, `{`/`}`, the g-map, and palette navigate rows all
funnel through it, so the g-map/palette bypass (owner finding #4) is closed
by construction. Guard-confirmed continuations pass `{ force: true }`.
Related soft-nav fix the same day: `history.pushState` now runs BEFORE
page-script re-execution — arriving pages read `location.search` at script
time, and the old ordering silently no-op'd every `?tab=` deep-link on
soft-nav (settings/payables/bank).

## 8. FB.form — the one form machine (K3 — shipped 2026-07-28)

Model B (ratified): the **bill-edit modal model** — NORMAL rest state,
Tab/Shift+Tab inside edits — formalized as `api/public/fb-form.js`. NOT QBO
always-insert: a NORMAL state must exist or page verbs, the g-prefix, the
palette and `?` all die. A form = ordered **zones** (header fields, a line
grid, …); each zone exposes `rows()`, each row `cells()`. Pages declare
config + verbs only — no per-page key handlers (FB.list doctrine).

**Framework-owned keys:**

| Key | NORMAL | INSERT |
|---|---|---|
| `j`/`k` | next/prev row (zones flatten; sticky at form ends; **column preserved** — goal-column, 2026-07-28) | — |
| `h`/`l` | next/prev cell (sticky) | — |
| `i`/`Enter` | edit cell → INSERT | advance to next cell (fb-list parity) |
| `Esc` | — | exit edit → NORMAL (never writes) |
| `Tab`/`Shift+Tab` | move cursor next/prev cell (no INSERT) — **crosses row/zone boundaries** (2026-07-28: was row-clamped; header→grid must flow) | native traversal; cursor follows focus |
| `G` | last row | — |

**Tab-strip precedence (2026-08-02, magnus):** on a page with a `.tabs`
strip (Bank/Import, Settings/Opening Balances), `h`/`l` switch TABS —
common.js's bubble handler owns them, so FB.form drops its `h`/`l` cell
bindings at `create()` (hints stay truthful). Horizontal cell movement on
tabbed pages is Tab/Shift+Tab only. Tabless FB.form pages (journal-new,
reports-hub, new-company) keep `h`/`l` cell nav.

Dropdown routing in INSERT is identical to fb-list (arrows move, Enter/Tab
pick, Esc closes). `Space` on a button cell = `~`/`Enter` (activate; §5).
Select commits are **mode-preserving** (2026-07-28 global rule): picking a
value never flips NORMAL/INSERT — an explicit edit from NORMAL returns to
NORMAL; a select reached mid-INSERT (Tab traversal) commits and STAYS
INSERT so the field flow continues. **Strengthened 2026-08-02 (magnus):
dropdowns never alter NORMAL/INSERT mode at all.** A mouse click on a
`<select>` cell moves the cursor only (focusin sync, no `setMode`) and
opens the FB.dropdown overlay / native popup in whatever mode was active;
while the overlay is open it owns arrows/Enter/Tab/Esc in BOTH modes
(fb-core's editable-target guard has an `isOpen()` carve-out so the NORMAL
ddOpen bindings dispatch from a focused select). Keyboard entry
(`i`/`Enter`/`ArrowDown` on a select cell) still enters INSERT via
`edit()`/`openFull` per the ratified loop above. Mechanics: `attachSelect`'s
mousedown opens the overlay BEFORE focusing the anchor (focusin → paint()
would otherwise blur it pre-render); fb-form's K3e no-focus-in-NORMAL
enforcement spares a control whose overlay is open (`ae.__fbdd.el`) and is
restored on close (pick blurs the anchor in NORMAL; the NORMAL ddOpen Esc
binding blurs it too); `edit()` calls `setMode(true)` BEFORE `el.focus()`
so K3e can't strip the cell being entered. **Pages on FB.form
must NOT pass `keys: true` to FB.dropdown**. `gg` = first row via the K1
`FB.nav.onGG` hook. Mouse parity: clicking a cell moves the cursor (focusin
sync). Verbs (`a` add, `x` delete, `w` write, `q` quit) are per-page config
with `when` predicates.

**Cell-type semantics (K3b fix, ratified by magnus 2026-07-28):** a zone may
override `cells(row)` to declare arbitrary controls as cells in visual order
(default hook finds input/select/textarea only). Button cells **activate**
(`i`/`Enter` = click, focus stays NORMAL) — they never enter INSERT. A native
`<select>` cell without FB.dropdown (re-ratified 2026-07-28, supersedes the
K3c showPicker design): `i`/`Enter` enters INSERT and steps options
programmatically — `j`/`k` step (disabled options skipped), `Enter` commits
and fires `change`, `Esc` reverts to the pre-edit option and fires nothing.
The OS popup (`el.showPicker()`) is never opened from the keyboard: it was
user-activation-dependent (the same keypress took different paths across
runs — the root cause of an untestable, environment-dependent select), the
open popup owns keys natively (`j` becomes typeahead, not vim stepping),
and `_focusin` had already flipped the mode store to INSERT, contradicting
the "stay NORMAL" design. Mouse click still opens the native popup
(browser default — mouse parity unchanged). Header-only
forms (reports filter bar: one row, N control cells) therefore navigate
`h`/`l`, not `j`/`k`.

**journal-new pilot:** zones = reversal panel (present only in reversal
mode) → header (date/journal/desc) → JV line grid. `a` add line (cursor +
edit), `x` delete line, `w` post (disabled-guard), `q` quit, `R` reversal
mode (focus search; arrows/Enter navigate results, Esc cancels reversal
outright — 2026-07-28). `h`/`l` = cell movement here (page has no tabs —
context override). Reversal search matches on a single character
(min-length 1; the old min-2 gate failed silently on "a"/"2").

**K3b adoption (shipped 2026-07-28):** four pages onto FB.form, each
declaring config only:

- **reports** — header-only form (report/period selects + date cells;
  MoM/YoY/download are button cells). `~` toggles the focused comparison
  button (re-toggle → none; §5). `d` opens the
  download menu with a `j`/`k`/`Enter`/`Esc` mini-scope (context override —
  no delete on this page).
- **bank-import** — wizard zones: bill panel (when open) → upload →
  mapping → review. `a` attach file, `p` paste CSV, `w` process/post
  (stage-dispatched), `b` link bill, `Space` toggle skip. Bill-panel
  results use the reversal-search pattern (arrows/Enter, Esc closes).
  **2026-07-28: Import Statement is a Bank TAB** (Transactions · Import ·
  Mappings — magnus). The standalone `/bank/import` route 301s to
  `/bank?tab=import`; the wizard lazy-inits on first tab show and its
  FB.form set is active only while the Import panel is visible.
- **opening-balances** — header → filter bar (BS/P&L/Non-Zero toggle
  buttons + search, all `h`/`l` cells) → account grid.
  `w` post (disabled-guard), `~` toggles the focused filter button (§5).
- **new-company** — one zone row per field (vertical stack) → periods
  grid. `a` add period, `x` delete period, `w` create. (No sidebar chrome
  on this page — hint rendering no-ops.)

**Soft-nav key lifecycle (K3c, ratified 2026-07-28):** `fbNavigate` swaps
`#page-main` and re-executes page scripts, but nothing previously tore down
the departing page's `FB.keys` state — the first-registered set whose
`active()` passed owned dispatch forever, so every soft-nav destination was
key-dead. Fix: `FB.keys.resetPage()` (called by `fbNavigate` after the content
swap, before script re-execution) fires registered teardown callbacks, removes
all page-registered key sets (everything after the core baseline captured at
IIFE end), clears the modal scope stack, and resets the g-prefix/gg-hook state.
`FB.form` registers a teardown for its per-`create()` document-level
`focusin`/`focusout` listeners, and defaults to an `active()` guard (first
zone's first row still in the document) as defense-in-depth. The arriving
page's scripts then register fresh sets against a clean slate.

**ArrowDown/ArrowUp parity (K3d, ratified 2026-07-28):** in NORMAL on a
native `<select>` cell, `ArrowDown`/`ArrowUp` behave like `i`/`Enter` —
enter INSERT and j/k-step (no OS popup from the keyboard, per the §8
re-ratification above). In INSERT stepping mode, `ArrowDown`/`ArrowUp` are
aliases for `j`/`k`. Text/date inputs' arrow keys are untouched (native
caret behavior).

**NORMAL-owns-cursor rule (K3e, ratified 2026-07-28; enforced same day):**
NORMAL owns the cursor; no field holds DOM focus in NORMAL — fb-form's
paint now actively blurs any form element holding focus in NORMAL (a
lingering button/select focus showed as a second "selector" beside the
vim cursor and re-fired on native Space/Enter — owner findings #5/#6).
INSERT is entered only via `i`/`Enter` (keyboard) or click (mouse parity).
Tab/Shift+Tab in NORMAL move the cursor cell next/prev without entering
INSERT (crossing row/zone boundaries). In INSERT they **programmatically**
advance/retreat (`advance()`/`retreat()` + focus) — supersedes the K3e
"native traversal" design: headless Chromium does not traverse focus for
CDP-synthesized Tabs (the keydown reached the input unprevented and focus
never moved), which made native traversal both flaky and untestable.
`Esc` exits INSERT and never writes.

**Enter on button cells (2026-07-28):** Enter/i CLICK the focused button
in both modes — NORMAL (via `edit()`) and INSERT (no advance, no mode
flip, cursor stays put). edit() never focuses buttons (click only), so
toggling never leaves DOM focus behind.

**Select overlays (2026-07-28):** `ArrowDown`/`ArrowUp` on an attachable
select cell (`FB.dropdown.attachSelect`) in NORMAL opens the FULL option
list overlay instead of blind-stepping the cell value — arrows navigate,
Enter picks (sets the value + fires `change`), Esc closes; pick/close
from a NORMAL-opened overlay returns to NORMAL. Selects without the
overlay keep the INSERT j/k-stepping path. Reports' type/period selects
use the overlay. **Mouse parity (2026-07-30):** clicking an attachSelect-ed
select opens the same FB overlay — the native OS popup is suppressed
(`mousedown` preventDefault + explicit focus + open-full), and select
`input` events never open the overlay (a native pick previously left a
stray white menu behind the closing OS popup). One menu, both paths.

**onCommit hook (K3e, ratified 2026-07-28):** forms may pass
`cfg.onCommit(cellEl, api)` — invoked on the INSERT Enter commit-and-advance
path for input cells (before advancing) and on `commitSelect` (native select
commit). NOT on Esc (never writes), NOT on button cells (their click handlers
self-trigger). Reports uses this to run-on-any-commit: `fbLoadReport()`
fires on any committed cell change (changed or unchanged), debounced so a
change-event + onCommit double-fire collapses into one report load.

**Iframe key-forwarding (K3d, ratified 2026-07-28):** pages that render
same-origin content in an `<iframe>` must call
`FB.util.forwardIframeKeys(iframe)` on the frame's `load` event so parent
keybindings survive focus inside the frame. The util re-dispatches
non-editable keydowns on the parent document and prevents default in the
iframe; editable targets (input/textarea/select/contentEditable) pass
through natively. Guard against double-attach on reloads via a marker
property on the iframe document.

## 9. Deferred (later phases)

- **K4 (shipped 2026-07-28)** — Attachment keyboard unification: **`A` =
  attach everywhere** — legacy pages (common.js `fbKeyActions` dispatcher)
  route shift-a to a page-registered `attach` verb (bill-detail; its old
  `a` = attach is retired); FB.form pages declare `A` as an extraBinding
  (journal-new). Attachment queues are **FB.form zones** (journal-new
  pending queue: `j`/`k` rows, `x` removes the staged file) or shared
  `.fb-attach-row` markup + `FB.attachments` helpers (api/public/
  fb-attachments.js: rowHtml, emptyHtml, createNav). Architectural
  refinement vs the original "queue as FB.list" line: attachment rows are
  read-only (no inline edit, no add row — `A` is the create verb), so they
  live in the form machine / shared nav surface rather than FB.list; the
  observable contract is identical (`j`/`k`/`x` + `A`). bill-detail keeps
  its bespoke combined nav (meta → lines → attach) — markup not swapped;
  only the key was unified. bill-edit queue nav done (K4b — FB.form migration).
  Reconciliation: the audit's "/bank/reconcile mouse-only checkboxes" item
  predates the FB.list migration — that URL now 301-redirects to
  /:company/bank, whose Transactions tab already carries the full contract:
  j/k row cursor (FB.nav) + **`~` = clear/unclear** (universal toggle verb,
  ratified 2026-07-28) wired to the same persistence as the checkbox. K4
  closes the item with end-to-end verification (toggle + persistence), no
  new code. K4 also fixed a K3c regression: the default `active()` guard
  checked zone 0 only — journal-new (reversal zone empty at rest) and
  bank-import (bill panel closed at rest) were key-dead; the guard now
  scans ALL zones.
- **K5 (shipped 2026-07-28)** — Coverage gate, not CI (repo has no CI
  runner): `tests/keys-coverage.mjs` (`npm run test:keys`) crawls every
  registry route + bill detail/edit and asserts, per route: zero uncaught
  JS errors · a live `FB.keys` set (`hasActive`) · non-empty hint surface
  · ≥1 active set with NORMAL bindings (`FB.keys.audit()`) · **every
  visible interactive control is keyboard-managed** — contained in an
  `FB.coverage.roots()` element (FB.form zone rows, FB.list table, FB.nav
  row set, attach panel, open dropdown; providers registered per framework,
  `{ core: true }` chrome providers survive `resetPage`), or a native
  text-entry field (INSERT-mode typing IS the keyboard path), or a ratified
  exemption. Exemptions live in the crawl file with reasons; **`verb`
  exemptions are self-checking** — the crawl verifies a live binding with
  that key exists, so a removed verb breaks the gate. Findings closed on
  landing: dashboard gained an FB.nav set (cards + report links) —
  upgraded 2026-07-28 to a **spatial 2D grid** (`FB.nav.create({ grid })`:
  j/k across visual rows with column preserved, h/l within a row; owner
  finding #13); **non-table FB.nav surfaces take a visible focus ring via
  `FB.nav.create({ focusClass: 'fb-nav-focus' })`** (2026-07-28, magnus
  finding: the dashboard card/report selector was invisible under hjkl —
  the default `nav-row-focus` rule is `tr`-scoped so it never painted on
  `<a>` cards; `.fb-nav-focus` is a strong outline/box-shadow ring in
  common.css, a CSS class only so NORMAL-mode doctrine holds — no DOM
  focus is grabbed, Enter follows the anchor via `el.click()`, Esc clears);
  bill-detail registers an FB.keys set delegating to its fbKeyActions
  handlers; bank gained **`f` = cycle cleared-filter** (uncleared →
  cleared → both); new-company renders hints inline (`#nc-hints` — no
  sidebar chrome there); **fb-core `hasActive()` semantics fixed** (sets
  with no `active` fn were reported inactive — dispatch treats them as
  always-live); **bill-edit null-guard fixed** (`#be-tot-gst` renders only
  when vat_registered — the unguarded listener killed the whole page
  script, including keys, on non-VAT companies). Ratified mouse-only by
  design: `#hdr-clear-all` (bulk convenience; per-row `~` is the path —
  QBO/Xero have no bulk-clear hotkey), settings `#cr-delete-btn` (danger
  zone: GitHub/QBO pattern — mouse trigger + type-to-confirm modal owns
  the keyboard once open). receivables is a ratified stub exemption (AR ships FB.list
  day one). Coverage behavior is verified ONCE here, framework-level —
  not per tab.
- `?` overlay GLOBAL section (chrome keys: g-map, `{`/`}`, `h`/`l`, `/`,
  `:`) — the overlay currently documents the active page set only.
- Vimium-style `f` hint overlay as a universal mouse-parity fallback —
  likely unnecessary once K1–K4 land; revisit after K5 measurement.
