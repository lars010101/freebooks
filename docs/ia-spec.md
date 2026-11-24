# freebooks — Interaction Architecture Spec (IA Spec)

**Date:** 2026-08-18, keys updated 2026-11-24 · **Status:** RATIFIED (magnus, Slack design thread) · **Scope:** All views, all modes, all verbs — the complete keyboard/interaction contract
**Consumers:** `api/src/nav-registry.js`, `api/public/fb-core.js`, `api/public/fb-list.js`, `api/public/fb-form.js`, `api/public/common.js`, `api/src/pages/*.js`
**Companions:** `keyboard-ux-spec.md` (K1–K5 program history), `fb-list-ux-spec.md` (list machine), `agent-readiness-spec.md` (A1–A5 agent model), `UI.md` (typography/colour)

---

## 0. Doctrine

freebooks is **agent-first** (ratified 2026-07-31, magnus — roadmap (deleted 2026-10-03, see git history) §0q):

- **The API/MCP surface is the product.** The web UI is a viewer plus a small human correction surface.
- **Mouse parity is dropped.** Existing mouse support stays in place, but parity is no longer a requirement, review criterion, or test gate. New work ships keyboard + API only.
- **The verb surface is frozen.** No new keyboard verbs without explicit magnus ratification. The K-series keyboard program (K1–K5) is complete and frozen at current capability.
- **New scope ships API-first.** UI for new features is read-only rendering of API results; write-UI is built only on explicit request.
- **Esc never writes.** Exactly one save path per surface: `w` (write). Esc peels one layer, never commits.
- **NORMAL owns the cursor.** No field holds DOM focus in NORMAL mode. INSERT is entered only via `i`/`Enter` (keyboard) or click (mouse).

---

## 1. Route Registry — the single source of truth

Every app route lives once in `api/src/nav-registry.js`. Three consumers share the table so navigation can never drift:

1. **Sidebar** — `navBar()` renders `.sb-nav` anchors from entries with `sidebar: true`.
2. **`g`-prefix go-to map** — `fb-core.js` reads `window.FB_ROUTES` (injected by `navBar`) and maps `gKey` letters → routes.
3. **Command palette** — entries with `palette: true` surface as `Go to {label}` rows.

Entry shape: `{ key, route, label, icon, sidebar, gKey, palette, absolute }`. `route` uses the `:company` placeholder; `absolute: true` for company-less routes (`/setup/new-company`).

### Current routes (as of 2026-08-18, historical)

**Correction (2026-09-19): superseded.** This table describes the pre-restructure route set. The 2026-08-27 IA restructure 2 (commit `9303d05`) replaced `bills`/`reports`/`periods`/`master-data`/`admin` with `payables`/`statements`+`journal`/`calendar`/`accounting`+`exchange-rates`, and dissolved `master-data` and `admin` entirely (no redirects — clean cutover). See the current table below; this one is kept only as a historical snapshot.

|| Key | Route | Label | Icon | Sidebar | gKey | Palette | Notes |
|-----|-------|-------|------|---------|------|---------|-------|
| `inbox` | `/:company` | Inbox | 📥 | ✓ | `i` | ✓ | A5 unified review queue; root route (Dashboard dropped 2026-08-03) |
| `bills` | `/:company/bills` | Bills | 📋 | ✓ | `b` | ✓ | Bills tree (renamed from Payables 2026-08-11) |
| `reports` | `/:company/reports` | Reports | 📈 | ✓ | `r` | ✓ | Report hub |
| `periods` | `/:company/periods` | Periods | 📅 | ✓ | `p` | ✓ | Promoted to top-level 2026-08-04 |
| `settings` | `/:company/settings` | Settings | ⚙ | ✓ | `s` | ✓ | Company · Posting Rules · AI |
| `master-data` | `/:company/master-data` | Master Data | 🗂 | ✓ | `m` | ✓ | Partners · COA · Tax Codes · Journals · FX · Centers (new 2026-08-11) |
| `admin` | `/:company/admin` | Admin | 🛠 | ✓ | `a` | ✓ | Companies · Operations (new 2026-08-11) |
| `journal-voucher` | `/:company/journal/voucher` | Journal Entry | — | ✗ | — | ✗ | Covered by action-catalog navigate entry |
| `new-company` | `/setup/new-company` | New Company | — | ✗ | — | ✗ | Absolute route, company-less |

### Current routes (as of 2026-09-19)

Read directly from `api/src/nav-registry.js`'s `ROUTES` array (the file's own header comment carries the full chronological g-key history — treat that comment as the live source, this table as a point-in-time mirror of it):

|| Key | Route | Label | Icon | Sidebar | gKey | Palette | Notes |
|-----|-------|-------|------|---------|------|---------|-------|
| `inbox` | `/:company` | Inbox | 📥 | ✓ | `i` | ✓ | Root route |
| `payables` | `/:company/payables` | Payables | 📋 | ✓ | `p` | ✓ | Renamed from Bills 2026-08-27 (IA restructure 2); Bills · Vendors · Aging · Control tabs |
| `bank` | `/:company/bank` | Bank | 🏦 | ✓ | `b` | ✓ | Revived (two-way-payments-prep); Payments + Reconciliation tabs — see `bank-dissolution-spec.md`'s 2026-09-19 correction |
| `statements` | `/:company/statements` | Statements | 📊 | ✓ | `t` | ✓ | Split from Reports 2026-08-27; P&L · Balance Sheet · Cash Flow · Statement of Equity |
| `journal` | `/:company/journal` | Journal | 📈 | ✓ | `j` | ✓ | Renamed from Books 2026-08-30 (IA restructure 3); Transactions · Line items · Trial Balance · General Ledger |
| `calendar` | `/:company/calendar` | Calendar | 📅 | ✓ | `c` | ✓ | Renamed from Fiscal; Periods · Reminders · Close Checklist |
| `documents` | `/:company/documents` | Documents | 📄 | ✓ | `d` | ✓ | New (calendar-reminders-documents-spec.md §5) |
| `settings` | `/:company/settings` | Settings | ⚙ | ✓ | `s` | ✓ | Slimmed: Company · Access · Extensions |
| `accounting` | `/:company/accounting` | Accounting | 🗂 | ✓ | `a` | ✓ | New 2026-08-27, reuses Admin's freed `a`; COA · Tax Codes · Journals · Cost/Profit Centers · Integrity |
| `exchange-rates` | `/:company/exchange-rates` | Exchange Rates | 💱 | ✓ | `x` | ✓ | Promoted standalone 2026-08-27 |
| `journal-voucher` | `/:company/journal/voucher` | Journal Entry | — | ✗ | — | ✗ | Covered by action-catalog navigate entry |
| `new-company` | `/setup/new-company` | New Company | — | ✗ | — | ✗ | Absolute route, company-less |
| `chat` | `/:company/chat` | Chat with AI | 💬 | ✗ | — | ✓ | Palette-only, not in sidebar |

`master-data` and `admin` no longer exist (dissolved 2026-08-27: Companies → company switcher, Access → Settings, Operations dropped). `g m`, `g v`, `g f`, `g r` are free.

---

## 2. Mode System

Two modes, managed by `FB.mode` (fb-core):

| Mode | Entered by | Exited by | DOM focus | Purpose |
|------|-----------|-----------|-----------|---------|
| **NORMAL** | `Esc` from INSERT; page load | `i`/`Enter` on editable cell; click into input | **None** — cursor is a CSS class, not DOM focus | Navigation, verbs, page-level actions |
| **INSERT** | `i`/`Enter` on cell; click into input/select/textarea | `Esc` (never writes); `Enter` on last cell (advance) | The edited element | Text/number/date entry, select stepping |

**Rules:**
- `Esc` from INSERT exits to NORMAL, never writes. The buffer stays dirty.
- `Esc` from NORMAL peels one layer: open dropdown → close it; active filters → clear them; otherwise inert.
- `Enter` in INSERT advances to the next cell (fb-list parity: right, wrapping to next row's first cell; sticky at last cell).
- `Tab`/`Shift+Tab` in NORMAL move the cursor cell-by-cell through the whole form (crosses row/zone boundaries). In INSERT they programmatically advance/retreat (`advance()`/`retreat()` + focus).
- **Select commits are mode-preserving** (2026-07-28 global rule): picking a value never flips NORMAL/INSERT. A mouse click on a `<select>` cell moves the cursor only and opens the FB.dropdown overlay / native popup in whatever mode was active.
- **Dropdowns never alter NORMAL/INSERT mode at all** (strengthened 2026-08-02, magnus).

---

## 3. The Three Machines

### 3.1 FB.list — the one list machine (`api/public/fb-list.js`)

Every flat register in the app. A screen declares columns + actions; the framework owns ALL behavior.

**Used by:** every list in the app; §5 names them per page. Tree lists (`tree: true`: Inbox, Bills, Aging) are read-only (#315).

**Core contract:**

| Mode | Key | Action |
|------|-----|--------|
| read | `j`/`k` | Navigate rows, sticky ends; the add row is a nav position (bottom) |
| read | `gg` / `G` | First row / bottom (= add row) — framework-level |
| read | `i` / Enter / click cell | Edit the focused row (editable rows only); on the add row = create |
| read | Enter | Read-only rows: open the row's page (`openRow`) or follow its link (`data-href` / first anchor — report drill-through, §10); tree rows without `openRow`: fold |
| read, tree | `Space` / click ▸ | Fold — toggle the parent under the cursor (children lazy-fetch on first open); inert on the add row |
| read | `x` | Delete — confirm for saved rows; only where the list deletes and the row is deletable; discards dirty-new rows |
| read, dirty | `w` / ✓ chip | **Write — the only save** |
| read, dirty | `u` / ✕ chip | Undo to saved values |
| edit | Enter / Tab / Shift+Tab | Next / prev field, sticky ends — never saves |
| edit | Esc | Dropdown open → close dropdown; otherwise exit to read, buffer stays dirty |
| read | `Esc` | Close an open filter dropdown; else clear all filters (the only clear-filters key) |
| any | `h`/`l` · `?` | Shared chrome via common.js / FB.keys |

**Add row:** A plain muted text row pinned at the **bottom** of the list, reading `+ Add entry`. Reachable by click; `j` (sticky past the last data row); `G`. `i`/`Enter`/click transforms it in place into the live navy edit row (INSERT mode, first field focused).

**Leave-guard:** One shared modal per page across all mounted FB.list instances: switching tab/page or sidebar-navigating with any editing-or-dirty row opens **Save / Discard / Stay**. Save = write all dirty rows, proceed only when all succeed; Discard = undo all, proceed; Stay = abort.

**Filtering:** Per-column dropdown (mouse) + topbar search input (keyboard) render the same filter state. NORMAL-mode `Esc` peels one layer (clears all filters). Edit/dirty rows always bypass filters.

**List-level verbs:** `actions: [{ key, label, handler(api) }]` — each gets a NORMAL-mode key binding + a small mouse-parity button above the table. Must not edit existing rows. Example: Exchange Rates `f` = fetch ECB rates.

**Row verbs:** `rowVerbs: [{ key, label, when(row), affordance(row), run(api,row) }]` — per-row verb predicates. Active only on rows whose predicate passes. Example: Inbox `y`/`x` only on `proposed` rows.

### 3.2 FB.form — the one form machine (`api/public/fb-form.js`)

Model B (ratified 2026-07-28): NORMAL rest state + Tab/Shift+Tab inside edits — explicitly NOT QBO always-insert.

**Pages:** journal-voucher (pilot), reports filter bar, new-company.

**Core contract:**

| Key | NORMAL | INSERT |
|-----|--------|--------|
| `j`/`k` | Next/prev row (zones flatten; sticky at form ends; **column preserved** — goal-column) | — |
| `h`/`l` | Next/prev cell (sticky) | — |
| `i`/`Enter` | Edit cell → INSERT | Advance to next cell |
| `Esc` | — | Exit edit → NORMAL (never writes) |
| `Tab`/`Shift+Tab` | Move cursor next/prev cell (no INSERT) — crosses row/zone boundaries | Programmatic advance/retreat |
| `G` | Last row | — |

**Tab-strip precedence (2026-08-02, magnus):** On a page with a `.tabs` strip, `h`/`l` switch TABS — common.js's bubble handler owns them, so FB.form drops its `h`/`l` cell bindings at `create()`. Horizontal cell movement on tabbed pages is Tab/Shift+Tab only. Tabless FB.form pages (journal-voucher, reports-hub, new-company) keep `h`/`l` cell nav.

**Cell-type semantics:**
- **Button cells** activate (`i`/`Enter` = click, focus stays NORMAL) — they never enter INSERT.
- **Native `<select>` cells** (no FB.dropdown): `i`/`Enter` enters INSERT and steps options programmatically — `j`/`k` step (disabled skipped), `Enter` commits and fires `change`, `Esc` reverts to the pre-edit option and fires nothing. The OS popup is never opened from the keyboard.
- **AttachSelect-ed selects** (`FB.dropdown.attachSelect`): `ArrowDown`/`ArrowUp` in NORMAL opens the FULL option list overlay — arrows navigate, Enter picks, Esc closes. Pick/close from a NORMAL-opened overlay returns to NORMAL.

**NORMAL-owns-cursor rule (K3e):** NORMAL owns the cursor; no field holds DOM focus in NORMAL — fb-form's paint actively blurs any form element holding focus in NORMAL. INSERT is entered only via `i`/`Enter` (keyboard) or click (mouse parity).

### 3.3 FB.nav — spatial navigation (`api/public/fb-core.js`)

For non-table surfaces (dashboard cards, report links). `FB.nav.create({ grid })`: `j`/`k` across visual rows with column preserved, `h`/`l` within a row. Non-table surfaces take a visible focus ring via `FB.nav.create({ focusClass: 'fb-nav-focus' })` — a CSS class only, no DOM focus grabbed.

---

## 4. Chrome — global keys available on every page

| Key | Action | Scope |
|-----|--------|-------|
| `g` + letter | Go-to map (see §1) | Global, NORMAL only, never in editable targets, never with Ctrl/Alt/Meta |
| `g g` | List cursor to first row, then **absolute page top** (both scroll containers, next frame) | Global |
| `G` | Last row + **absolute page bottom** | Global |
| `h` / `l` | Previous / next tab on `.tabs` pages; previous / next cell on forms without tabs | Global, NORMAL only |
| `j` / `k` | Table row prev/next (with visual focus) | Global, NORMAL only |
| `Enter` | Activate the focused row (follow its link, else click it); lists and forms bind their own `Enter` first | Global, NORMAL only |
| `p` | Period selector | Pages with the topbar period selector |
| `g w` | Company switcher | Global |
| `/` | Focus topbar global search | Global, NORMAL only |
| `?` | Help overlay: the keys that work here right now, per active binding set (only bindings whose `when` passes) | Global, NORMAL only |
| `Esc` | Peel one layer (see §2) | Global |

**2026-09-01 update:** the `:`/Ctrl+K "Command palette" row above is removed — `:` command mode was fully retired (`global-search-spec.md`), leaving `/` as the sole summon key. Ctrl+K has no binding.

**Correction (2026-09-19, updated 2026-11-24):** `{`/`}` are not bound anywhere (the row was removed from the table above), and neither are `A` (attach) or a global `~` — `~` is a page verb where §5 lists it. `ia-restructure-spec.md` §0.1 (2026-08-11) already proved this by a full grep of every shipped public JS file for a `{`/`}` handler and found none, flagging it as stale — that correction was never carried into this file until now. Tabs switch with `h`/`l` only.

**`g`-prefix dispatch semantics (fb-core `_dispatch`, capture phase):**
- One pending-`g` state (500 ms window). Arming: bare `g` in NORMAL mode, never in editable targets, never with Ctrl/Alt/Meta, and only when no active page set claims `g`.
- Second key resolves: `g` → gg, `w` → switcher, a registry `gKey` → navigate (`fbNavigate`, dirty-buffer leave-veto applies). Anything else cancels and falls through to normal dispatch.

**Company switcher (`g w`):** While open, owns EVERY key. `j`/`k`/`↓`/`↑` highlight (sticky at boundaries), `Enter` follows the highlighted anchor, `Esc` closes, `g w` toggles closed.

> **2026-09-19 correction:** this section originally said `g c`. `docs/keyboard-ux-spec.md` §3 recorded a 2026-09-01 fix: `c` was taken by Calendar when Fiscal was renamed, so the switcher moved to `w`. Updated here to match.

**Modal (`FB.modal`):** One modal app-wide. `Esc`/backdrop = cancel (NEVER confirms). Button letters per-modal, shown in the button (`Save w`). Type-to-confirm for destructive actions: `requiresConfirm` buttons stay disabled until the input matches exactly; `Enter` in the input fires it; the danger button carries NO letter key.

**Leave-guard (FB.list):** `w` = write & leave, `u` = undo & leave, `Esc` = Stay.

**Status messages:** All transient feedback routes through `FB.status.show(text, sev)` into the single topbar slot `#tb-status-msg`. Severity: `true`/`'err'` red, `'warn'` amber, falsy green/neutral. **Never auto-dismisses.**

---

## 5. Per-Page Key Reference

**As of 2026-11-24, checked against the code** (a crawl of every page and tab plus the binding sources). This replaces the older per-view contracts, which described pages that have since been renamed, merged or removed. Press `?` on any page to see the keys that work there right now: the overlay lists only the keys that would do something in the current state (§4).

Every page also has the global keys (§4). Lists and forms share the standard keys below. The per-page tables list only what a page adds or changes.

### 5.0 Standard keys

**Lists (FB.list).** These apply on every list unless the page says it is read-only.

| Key | Action | When |
|-----|--------|------|
| `j`/`k` · `gg`/`G` | Move the row cursor; first / last row | Always |
| `Enter` | Open the row's page, or drill to its entry | Rows that link somewhere (read-only registers, Bills, Aging) |
| `i` / `Enter` | Edit the row; on the `+ Add entry` row, create one | Editable rows only |
| `Space` / `Enter` | Fold / unfold | Tree lists (Inbox, Bills, Aging) |
| `w` / `u` | Write (the only save) / undo | Only on a row with unsaved changes |
| `x` | Delete, after a confirm | Lists that delete, on rows that can be deleted |
| `Esc` | Clear all filters (also clears the topbar mirror) | While a filter is on |

A **read-only list** has no add row and no `i`/`w`/`u`; it keeps `j`/`k`, `Enter` and `Esc`, plus any page verbs.

**Forms (FB.form).**

| Key | Action |
|-----|--------|
| `j`/`k` | Next / previous row (column kept) |
| `h`/`l` | Next / previous cell, on forms without tabs (on tabbed pages `h`/`l` switch tabs) |
| `Tab` / `Shift+Tab` | Next / previous cell |
| `i` / `Enter` | Edit the cell (button cells: press it) |
| `Space` | Press a button cell |
| `Esc` | In a field: stop editing (never saves). Otherwise: leave the page, where the page has a quit verb |
| `G` | Last row |

### 5.1 Inbox (`/:company`)

All four tabs are read-only lists.

| Tab | Key | Action | When |
|-----|-----|--------|------|
| Transactions | `y` | Approve / post | Proposed rows |
| | `x` | Reject (note required) | Proposed rows |
| | `c` | Correct & resubmit (opens the journal-entry editor in correction mode) | Rejected journal entries |
| | `~` | Toggle full / partial settlement | Proposed bank matches that settle a bill |
| | `Enter` / `Space` | Unfold the lines | |
| Partners | `y` / `x` | Approve / reject the proposed partner (the row's inputs are read at approval) | Proposed rows |
| New Rule | `y` / `x` | Approve / reject the proposed rule | Proposed rows |
| Failed Input | `x` | Discard | Every row |
| | `r` | Retry (re-queue for the agent) | Every row |

Transactions opens filtered to proposed rows; `Esc` clears the filter so rejected rows show too.

### 5.2 Payables (`/:company/payables`)

| Tab | Key | Action | When |
|-----|-----|--------|------|
| Bills (read-only) | `Enter` | Open the bill page | Any bill |
| | `Space` | Fold / unfold lines and payments | |
| | `y` | Post (draft) / pay (opens New Payment for the bill) | Draft or posted bills |
| | `x` | Delete the draft | Draft bills |
| | `x` | Void the bill | Posted or paid bills |
| | `x` | Void the payment | A payment row under a bill |
| | `W` | Write off the remaining balance (server-side threshold) | Posted bills with a balance |
| Vendors | standard list | Add, edit, delete partners | |
| | `~` | Toggle active | |
| Aging (read-only) | `Enter` | Open the bill | Bill rows |
| Control | form | As-of date form | |

New bills start from `+ Add bill`, which opens the bill page (§5.10).

### 5.3 Bank (`/:company/bank`)

| Tab | Key | Action | When |
|-----|-----|--------|------|
| Payments (read-only) | `x` | Void the payment | Payments not yet voided |
| Reconciliation (read-only) | — | Standard read-only list keys | |

Payments opens filtered to posted payments; `Esc` clears the filter so voided ones show too.

### 5.4 Statements (`/:company/statements`)

Tabs: Profit & Loss · Balance Sheet · Cash Flow · Statement of Equity. The filter bar is a form; `h`/`l` switch tabs, so use `Tab`/`Shift+Tab` between its cells.

| Key | Action | When |
|-----|--------|------|
| `j`/`k` | Move from the comparison toggle down through the account rows | |
| `~` | Cycle the comparison (single period → MoM → YoY) | Cursor on the toggle (P&L, Balance Sheet, Cash Flow) |
| `Enter` | Open the account in the General Ledger | Cursor on an account row |
| `p` | Period selector | |

The toggle and the account rows are one form (`reports`): the toggle is its first row, each account row with a code is a row whose one cell is the code link.

### 5.5 Journal (`/:company/journal`)

| Tab | Key | Action |
|-----|-----|--------|
| Transactions (read-only) | `Enter` | Open the entry (the bill page for a bill's entry) |
| Line items (read-only) | `Enter` | Open the line's entry |
| Trial Balance | `Enter` | Open the account in the General Ledger |
| General Ledger (read-only) | `Enter` | Open the line's entry (opening and closing rows have none) |

`p` opens the period selector on every tab.

### 5.6 Calendar (`/:company/calendar`)

| Tab | Key | Action | When |
|-----|-----|--------|------|
| Periods | standard list | Add, edit, delete periods | |
| Reminders | — | No page keys | |
| Close Checklist | `j`/`k` | Move between checklist rows | |
| | `~` | Attest / un-attest | Manual checklist rows |

### 5.7 Documents (`/:company/documents`)

No page keys; `j`/`k` and `Enter` work on the table through the global fallbacks.

### 5.8 Settings (`/:company/settings`)

| Tab | Key | Action | When |
|-----|-----|--------|------|
| Company | standard list | Edit one attribute per row; `w` saves it. No add, no delete | Editable attributes |
| Access | standard list | Grants: add, edit, `x` revoke | Not on global grants |
| | `x` | API tokens: revoke (the list is otherwise read-only) | |
| Extensions | standard list | Posting rules and AI attributes | Editable attributes |
| | `Enter` | Run the connection test | The AI test row |

On Access both lists are live. A key both lists use belongs to the list you last clicked; the grants list by default.

The danger zone (delete company) is mouse-only by design: type the company name, then `Enter` in that input.

### 5.9 Accounting and Exchange Rates

| Page / tab | Key | Action |
|------------|-----|--------|
| Accounting: Chart of Accounts, Tax Codes, Journals, Cost/Profit Centers | standard list | Add, edit, delete |
| Accounting: Integrity | — | No page keys |
| Exchange Rates (`/:company/exchange-rates`) | standard list | Add, edit, delete rates |
| | `f` | Fetch ECB rates |

### 5.10 Bill page (`/:company/bill/new`, `/:company/bill/:id`)

A form: header → lines → attachments (one button that opens the attachments dialog). A posted bill is read-only.

| Key | Action | When |
|-----|--------|------|
| `a` | Add a line | New and draft bills |
| `x` | Delete the focused line (not computed tax rows) | Line rows, new and draft bills |
| `w` | Save, which **posts** the bill: a new bill is created posted, a draft is posted (labelled "save" in `?` and on the button) | New and draft bills |
| `x` | Delete the draft, after a confirm | Cursor on the header, saved draft |
| `x` | Void (reverse), after a confirm | Cursor on the header, posted bill with nothing paid |
| `W` | Write off the remaining balance | Posted, part-paid bill |
| `Esc` | Leave the page | |

`x` on the header does nothing on a new, paid, part-paid or void bill. A draft can also be posted from the Bills list (`y`).

### 5.11 Journal entry (`/:company/journal/voucher`)

A form: reversal panel (in reversal mode only) → header → attachments → lines.

| Key | Action | When |
|-----|--------|------|
| `a` | Add a line | New entry, or while reversing |
| `x` | Delete the focused line / staged attachment | Line or attachment rows |
| `w` | Post (blocked while out of balance) | New entry, or while reversing |
| `x` | Enter reversal mode | Cursor on the header |
| `↑`/`↓` · `Enter` · `Esc` | Move through / pick a search result / close the search | Reversal search field |
| `Esc` | Cancel reversal mode; otherwise leave the page | |

**Viewing a posted entry** (`?batch=<id>`) is read-only: no `a`/`w`. `x` on the header reverses that entry, and `Esc` returns to where you came from (§10.4). **Correcting a rejected proposal** (`?correct=<id>`, from Inbox `c`) opens the entry for editing and resubmission.

### 5.12 Other pages

| Page | Keys |
|------|------|
| New Payment (`/:company/payment/new`) | No page keys besides `Esc`, which goes back to Payables (outside a field). Fields are filled with the mouse and `Tab` |
| Chat (`/:company/chat`) | In the message box: `Enter` sends, `Shift+Enter` adds a new line |
| New Company (`/setup/new-company`) | Form: `a` add a period, `x` delete the period, `w` create the company |

---

## 6. Filtering Model

**One filter state, two ways to drive it:** a per-column dropdown (mouse) and the topbar search input (keyboard) render the same filter state; editing either updates the other.

### Column config

| `filterType` | Dropdown control |
|-------------|----------------|
| `'text'` *(default)* | Single text input — case-insensitive substring match |
| `'date'` | Date input with on / before / after operators |
| `'amount'` | Operator (`>`, `<`, `=`, `≥`, `≤`) + value |
| `'list'` | Scrollable distinct-values list, headed by "All (clear filter)" |
| `null` | Column is non-filterable (explicit opt-out; auto-default for `type: 'checkbox'`) |

### Keyboard path — the topbar

- `/` focuses the topbar global search — always, on every screen.
- Value starts with `/` → **screen-limited filter expression**, routed to the visible FB.list. So `//` starts a screen filter.
- Anything else → the **global search** (app-wide).
- NORMAL-mode `Esc` clears all filters AND the mirror.
- `Esc` in the topbar clears value + filters + blurs.
- `Enter` keeps the filter and blurs.

### Grammar

- Plain terms = case-insensitive cross-column fuzzy row filter.
- Qualifiers `field:value` filter one column.
- Operator syntax: `amount:>100`, `date:<2026-07`.
- Multiple terms/qualifiers AND-combine.

### Rules

- **Edit/dirty rows always bypass filters** — a row in edit mode is never hidden by the active filter.
- **Fold state is a row property, untouched by filters** — a folded bill stays folded when a filter applies and clears.
- **Column filters evaluate on parents** (tree mode); children follow their parent's visibility.

---

## 7. Status Lifecycle

### 7.1 Journal proposals (agent-readiness spec §4.1)

```
           journal.propose (agent)
                   │
                   ▼
              proposed ────── journal.reject (human) ──▶ rejected  [terminal,
                   │              note required           kept for audit,
         journal.approve (human)                          never posts]
                   ▼
                posted ──▶ journal_entries rows (ordinary posted batch,
                           batch_id linked back to the proposal)
```

**Approve is the post.** The human's approve transition validates and posts in one step. `rejected` is terminal and auditable, never deleted.

### 7.2 Bills

`draft` → `posted` → `partial` → `paid` · `voided` (terminal, reversal journal posted)

**Correction (2026-09-19):** `partial` is no longer a *stored* status value — commit `7a7b5e6` ("refactor: remove 'partial' as a stored bill status; derive it from amount_paid") removed it from the `bills.status` column; `db/schema.sql` carries a backfill comment confirming existing `'partial'` rows were migrated off it. `partial` is now a derived/computed display state (posted bill where `0 < amount_paid < amount`), not a value the `status` column ever holds. The lifecycle arrow above still describes the conceptual states correctly; only the storage mechanism changed.

### 7.3 Attachments

Upload → bound to `entity_type`/`entity_id` → on approve re-pointed to `entity_type='journal'`/`batchId` → on reject/expire GC'd after 30-day grace (hard invariant: never touch `'journal'`-bound rows).

---

## 8. Attachment Model

- **No attach key.** The K4 `A` = attach verb (2026-07-28) is no longer bound anywhere (checked 2026-11-24): attachments are added with the page's attach button (the bill page's opens the attachments dialog) or through the API.
- Attachment queues are **FB.form zones** (journal-voucher pending queue: `j`/`k` rows, `x` removes the staged file) or shared `.fb-attach-row` markup + `FB.attachments` helpers.
- Attachment rows are read-only (no inline edit, no add row).
- **Disk controls (A4):** 15 MB per-file cap for `journal_proposal` uploads; pdf/jpg/png whitelist; sha256 dedupe per company. Other entity types keep the 32 MB status quo.

---

## 9. Verb Conventions (ratified, frozen)

| Key | Meaning | Context |
|-----|---------|---------|
| `a` | **Add** a line / period | Bill page, journal entry, new company |
| `i`/`Enter` | Edit cell / activate row / create from add row | Universal |
| `Esc` | Peel one layer; never writes | Universal |
| `w` | **Write — the only save** | Universal |
| `u` | Undo to saved values | FB.list |
| `x` | Delete / discard; on a posted document's header, void or reverse it | Universal |
| `y`/`x` | Approve / reject (review pair); Bills: `y` post / pay | Inbox, Bills |
| `W` | Write off the remaining balance | Bills list, bill page |
| `~` | **Toggle verb** — toggles the focused row's or cell's state | Where a page binds it (§5) |
| `Space` | Activate the focused toggle/button (parity alias of `~`/`Enter`) | FB.form button cells |
| `c` | Correct & resubmit a rejected journal entry (clear filters retired 2026-11-24 — use `Esc`) | Inbox |
| `r` | Retry | Inbox Failed Input |
| `f` | Fetch rates (list-level action) | Exchange Rates |
| `p` | Period selector | Global, where present |
| `Esc` | Leave the page (`quit` verb) when nothing else is open | FB.form pages |
| `x` on the header | Reversal mode | Journal entry |
| `gg`/`G` | First row / last row | Framework-level |
| `?` | Which-key overlay | Global |
| `/` | Focus topbar search | Global |
| ~~`:`~~ | ~~Command palette~~ — **removed (2026-09-19 correction):** `:` command mode was fully retired 2026-09-01 (`global-search-spec.md`); `/` is the sole summon key. This row is kept struck through rather than deleted since §9 is "ratified, frozen" — see §4's matching 2026-09-01 update. | Global |

**Frozen surface:** No new keyboard verbs without explicit magnus ratification. The K-series keyboard program is complete.

---

## 10. Drill-through Doctrine (ratified 2026-08-03)

**Clicking a row in any report opens the smallest meaningful granularity of that item.** Each level drills one step deeper — never more than one. Keyboard parity: `Enter` on a focused row = click.

### 10.1 Drill map

| Report | Row represents | Drill target | Mechanism |
|---|---|---|---|
| **Transaction Register** | Batch (voucher) | Source-aware detail view (§10.2) | Click / `Enter` anywhere on row |
| **Journal Line Listing** | Single journal line | The batch's detail view (journal-voucher view mode) | Click / `Enter` |
| **General Ledger** | Account's lines for a period | The batch's detail view (journal-voucher view mode) | Click / `Enter` |
| **Trial Balance** | Account total for a period | General Ledger filtered to that account + period | Click / `Enter` |
| **Balance Sheet** | Account total for a period | General Ledger filtered to that account + period | Click / `Enter` |
| **Profit & Loss** | Account total for a period | General Ledger filtered to that account + period | Click / `Enter` |

### 10.2 Source-aware detail routing (Transaction Register)

The Transaction Register row's drill target depends on the batch's origin:

| Batch source | Detail view |
|---|---|
| `manual` / `reversal` / agent-proposed | journal-voucher view mode (`?batch=<batchId>`) |
| `bill` (`bill_id` set) | Bill detail page |

Links use `batch_id` or `bill_id` (UUIDs), never the reference string. The reference is a display label, not a key.

### 10.3 Correction flow

No verbs on reports. All corrections happen in detail views:

| Source | Correction path |
|---|---|
| Manual journal entry / reversal / agent | journal-voucher view mode → `x` on the header (reversal mode) |
| Bill (AP) | Bill page → `x` void (nothing paid), `W` write off the remainder (part-paid), credit memo (paid — not yet built) |
| Sales invoice (AR) | Invoice detail → void or credit memo (module unbuilt) |

### 10.4 Return-to-origin

Every detail view honors a return stack: `Esc` returns to the exact screen, scroll position, and cursor position the user came from. Not a hardcoded destination. The origin's full state (route, scroll, cursor, filters) is pushed on drill and popped on return.

### 10.5 journal-voucher view mode

`/:company/journal/voucher?batch=<batchId>` loads a posted batch read-only:
- Header fields and lines render populated, non-editable.
- `x` on the header enters reversal mode pre-targeted at that batch (the existing reversal flow).
- `Esc` returns to the origin (§10.4).
- Source documents (attachments) visible in the attachment queue zone.

### 10.6 Transaction Register — design

**Columns:** Date · Reference · Description · Amount · Source · Status

**Status indicators** (journal-level only, no source-level joins):
- **POSTED** — normal active batch (default, no badge)
- **Reversed** — badge when `reversed_by` is set. Shows the reversing batch's reference: "Reversed by REV-2026-001" (clickable, drills to the reversal batch's detail view).
- **Reversal** — badge when `reverses` is set. Shows the original batch's reference: "Reversal of 2026-001" (clickable, drills to the original batch's detail view).

**Row interaction:** Click anywhere on a row / `Enter` on a focused row → source-aware detail view (§10.2). No verbs on the report itself.

**No attachment indicator** — source documents are viewed from the detail views, not the register.

---

## 11. Testing Contract

- **API side:** Contract tests (`npm test` in `api/`) cover actions, not pixels.
- **Keyboard coverage gate:** `tests/keys-coverage.mjs` (`npm run test:keys`) crawls every registry route + bill detail/edit and asserts, per route: zero uncaught JS errors · a live `FB.keys` set · non-empty hint surface · ≥1 active NORMAL binding · every visible interactive control is keyboard-managed.
- **Single-screen gate:** `test:keys` runs the full key-coverage assertions on **journal-voucher** only (richest FB.form surface, primary human write path); every other route is smoke-checked (loads, zero uncaught JS errors).
- **Per-migration:** Live browser verification of the framework cycle on ONE representative screen is sufficient — the behavior is shared code.

---

## 12. Changelog

| Date | Change |
|------|--------|
| 2026-07-22 | FB.list consolidation ratified (P1-3) |
| 2026-07-23 | Column filters + unified topbar search ratified |
| 2026-07-24 | Bills → FB.list `tree: true`; filterable-by-default columns |
| 2026-07-27 | Bank Mappings → FB.list (last bespoke list migrated) |
| 2026-07-28 | K1–K5 keyboard program complete: nav-registry, g-map, company switcher, modal contract, FB.form, coverage gate |
| 2026-07-28 | `~` ratified as universal toggle verb; Opening Balances → Settings tab |
| 2026-07-31 | Agent-first UI doctrine ratified: mouse parity dropped, verb surface frozen, API-first |
| 2026-08-01 | A4 proposal underlag: binding convention, warn-not-block, review UX |
| 2026-08-02 | Per-actor API tokens; dropdown mode-neutrality strengthened; tab-strip precedence |
| 2026-08-03 | A5 unified inbox: queue leaves Journal, `g i` = Inbox, `f` filter moves with queue |
| 2026-08-03 | Dashboard + KPI cards dropped; Inbox becomes root route (`/:company`); source-document warning icons inline |
| 2026-08-03 | Journal dissolves: Transaction Register report in Reports; journal sidebar entry removed; drill-through doctrine (§10) ratified |
| 2026-08-04 | Drill-through fix: PL/BS account rows → GL (not TB); reports hub forwards ?account= to report iframe; GL filter bar prefilled from URL |
| 2026-08-05 | Receivables stub removed from sidebar + `g v` keybind dropped; route + page handler deleted (AR module dropped, §0m) |
| 2026-08-18 | Bank Import page removed from spec (done through agent inbox); Opening Balances feature removed (use journal voucher instead); orphaned nav-registry entry + redirect + new-company link cleaned up |
| 2026-11-24 | §5 replaced with a per-page key reference checked against the code; §3.1/§4/§9/§10 stale keys removed (`{`/`}`, `A`, global `~`, `o`, `d`, `q`, `R`, `c` clear filters); Enter on read-only register rows drills again; Statements account rows reachable with j/k + Enter |
