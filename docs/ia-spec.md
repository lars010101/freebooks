# freebooks — Interaction Architecture Spec (IA Spec)

**Date:** 2026-08-18 · **Status:** RATIFIED (magnus, Slack design thread) · **Scope:** All views, all modes, all verbs — the complete keyboard/interaction contract
**Consumers:** `api/src/nav-registry.js`, `api/public/fb-core.js`, `api/public/fb-list.js`, `api/public/fb-form.js`, `api/public/common.js`, `api/src/pages/*.js`
**Companions:** `keyboard-ux-spec.md` (K1–K5 program history), `fb-list-ux-spec.md` (list machine), `agent-readiness-spec.md` (A1–A5 agent model), `UI.md` (typography/colour)

---

## 0. Doctrine

freebooks is **agent-first** (ratified 2026-07-31, magnus — roadmap §0q):

- **The API/MCP surface is the product.** The web UI is a viewer plus a small human correction surface.
- **Mouse parity is dropped.** Existing mouse support stays in place, but parity is no longer a requirement, review criterion, or test gate. New work ships keyboard + API only.
- **The verb surface is frozen.** No new keyboard verbs without explicit magnus ratification. The K-series keyboard program (K1–K5) is complete and frozen at current capability.
- **New scope ships API-first.** UI for new features is read-only rendering of API results; write-UI is built only on explicit request.
- **Esc never writes.** Exactly one save path per surface: `w` (write). Esc peels one layer, never commits.
- **NORMAL owns the cursor.** No field holds DOM focus in NORMAL mode. INSERT is entered only via `i`/`Enter` (keyboard) or click (mouse).

---

## 1. Route Registry — the single source of truth

Every app route lives once in `api/src/nav-registry.js`. Four consumers share the table so navigation can never drift:

1. **Sidebar** — `navBar()` renders `.sb-nav` anchors from entries with `sidebar: true`.
2. **`{`/`}` cycling** — `common.js` reads the rendered `.sb-nav` anchors.
3. **`g`-prefix go-to map** — `fb-core.js` reads `window.FB_ROUTES` (injected by `navBar`) and maps `gKey` letters → routes.
4. **Command palette** — entries with `palette: true` surface as `Go to {label}` rows.

Entry shape: `{ key, route, label, icon, sidebar, gKey, palette, absolute }`. `route` uses the `:company` placeholder; `absolute: true` for company-less routes (`/setup/new-company`).

### Current routes (as of 2026-08-18)

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

---

## 2. Mode System

Two modes, managed by `FB.mode` (fb-core):

| Mode | Entered by | Exited by | DOM focus | Purpose |
|------|-----------|-----------|-----------|---------|
| **NORMAL** | `Esc` from INSERT; page load; `q` quit | `i`/`Enter` on editable cell; click into input | **None** — cursor is a CSS class, not DOM focus | Navigation, verbs, page-level actions |
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

**Migrated:** Settings (Periods, COA, Tax Codes, Journals, Company attrs), Partners, FX Rates, Bills (`tree: true`), Bank Mappings, Inbox, Journal.

**Core contract:**

| Mode | Key | Action |
|------|-----|--------|
| read | `j`/`k` | Navigate rows, sticky ends; the add row is a nav position (bottom) |
| read | `gg` / `G` | First row / bottom (= add row) — framework-level |
| read | `i` / Enter / click cell | Edit focused row; on the add row = create. Tree mode: on a child = edit the parent bill (whole-bill unit); on a posted bill = no-op (`editable` false) |
| read, tree | `Space` / click ▸ | Fold — toggle the parent under the cursor (children lazy-fetch on first open); inert on the add row |
| read, tree | `a` | Add child to the focused draft bill |
| read | `x` | Delete — confirm for saved rows; no-op on `deletable:false` rows; discards dirty-new rows |
| read, dirty | `w` / ✓ chip | **Write — the only save** |
| read, dirty | `u` / ✕ chip | Undo to saved values |
| edit | Enter / Tab / Shift+Tab | Next / prev field, sticky ends — never saves |
| edit | Esc | Dropdown open → close dropdown; otherwise exit to read, buffer stays dirty |
| any | `h`/`l` · `{`/`}` · `?` | Shared chrome via common.js / FB.keys |

**Add row:** A plain muted text row pinned at the **bottom** of the list, reading `+ Add entry`. Reachable by click; `j` (sticky past the last data row); `G`. `i`/`Enter`/click transforms it in place into the live navy edit row (INSERT mode, first field focused).

**Leave-guard:** One shared modal per page across all mounted FB.list instances: switching tab/page or sidebar-navigating with any editing-or-dirty row opens **Save / Discard / Stay**. Save = write all dirty rows, proceed only when all succeed; Discard = undo all, proceed; Stay = abort.

**Filtering:** Per-column dropdown (mouse) + topbar search input (keyboard) render the same filter state. `c` clears all filters. NORMAL-mode `Esc` peels one layer. Edit/dirty rows always bypass filters.

**List-level verbs:** `actions: [{ key, label, handler(api) }]` — each gets a NORMAL-mode key binding + a small mouse-parity button above the table. Must not edit existing rows. Example: Inbox `f` = cycle status filter.

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
| `{` / `}` | Sidebar prev/next page | Global, NORMAL only |
| `h` / `l` | Horizontal tab prev/next (on `.tabs` pages) | Global, NORMAL only |
| `j` / `k` | Table row prev/next (with visual focus) | Global, NORMAL only |
| `Enter` | Activate focused row (follow link or click) | Global, NORMAL only |
| `/` | Focus topbar global search | Global, NORMAL only |
| `?` | Which-key overlay (active binding set) | Global, NORMAL only |
| `Esc` | Peel one layer (see §2) | Global |
| `A` | Attach (page-registered) | Global, NORMAL only |
| `~` | **Universal toggle verb** — toggles the state of the ACTIVE CELL / focused control | Global, NORMAL only |

**2026-09-01 update:** the `:`/Ctrl+K "Command palette" row above is removed — `:` command mode was fully retired (`global-search-spec.md`), leaving `/` as the sole summon key. Ctrl+K has no binding.

**`g`-prefix dispatch semantics (fb-core `_dispatch`, capture phase):**
- One pending-`g` state (500 ms window). Arming: bare `g` in NORMAL mode, never in editable targets, never with Ctrl/Alt/Meta, and only when no active page set claims `g`.
- Second key resolves: `g` → gg, `c` → switcher, a registry `gKey` → navigate (`fbNavigate`, dirty-buffer leave-veto applies). Anything else cancels and falls through to normal dispatch.

**Company switcher (`g c`):** While open, owns EVERY key. `j`/`k`/`↓`/`↑` highlight (sticky at boundaries), `Enter` follows the highlighted anchor, `Esc` closes, `g c` toggles closed.

**Modal (`FB.modal`):** One modal app-wide. `Esc`/backdrop = cancel (NEVER confirms). Button letters per-modal, shown in the button (`Save w`). Type-to-confirm for destructive actions: `requiresConfirm` buttons stay disabled until the input matches exactly; `Enter` in the input fires it; the danger button carries NO letter key.

**Leave-guard (FB.list):** `w` = write & leave, `u` = undo & leave, `Esc` = Stay.

**Status messages:** All transient feedback routes through `FB.status.show(text, sev)` into the single topbar slot `#tb-status-msg`. Severity: `true`/`'err'` red, `'warn'` amber, falsy green/neutral. **Never auto-dismisses.**

---

## 5. Per-View Interaction Contracts

### 5.1 Inbox (`/:company`) — A5 unified review queue

- **Machine:** FB.list (`tree: true`, `canAdd: false`, `editable: false`)
- **Data:** `inbox.list` — Class A (journal proposals) + Class B (bills due/overdue)
- **Grouping:** Items group by `item.type` under a collapsible group header row. `Enter`/`click` folds/unfolds. Fold state client-side per type.
- **Status filter (`f`):** Three-state cycle — `proposed` → `rejected` → `bills` → `proposed`. Default view: `proposed` (Class A queue). `rejected` is the graveyard (void doctrine). `bills` is Class B (filter, not default).
- **Row verbs:**
  - `y` — approve (confirm modal: date, line count, total debit, optional note; `Enter` confirms; `Esc` cancels). Only on `proposed` rows.
  - `x` — reject (FB.modal with **required** note input; `Enter` submits when non-empty; `Esc` cancels). Only on `proposed` rows.
  - `Enter` — unfold lines read-only (tree idiom). On group headers: fold/unfold.
  - `o` — open bill in Payables (Class B `bill_due` rows only).
- **Source-document indicators:** Folded `PROPOSED` rows show a 📎 N badge (attachment_count > 0) or a ⚠️ warning icon (0 attachments — tooltip: "No source document attached"). VAT tolerance flags render a ⚠️ icon (tooltip: "VAT tolerance flag"). Unfolding a `PROPOSED` row lazily fetches `attachment.list` and renders shared `FB.attachments.rowHtml` rows linking to `GET /api/attachments/:id` (`target _blank`).
- **Badge:** Sidebar Inbox item shows pending-proposal count, refreshed on soft-nav and on `fb:queue-changed`.
- **Empty state:** "Nothing to review — agent-proposed journal batches will appear here."

### 5.3 Journal → Voucher Register (Reports hub)

The Journal sidebar page dissolved into the Reports hub on 2026-08-03 (Step 3). The posted register is now the **Voucher Register** report (`type=voucher-register`) rendered inside the Reports iframe. The legacy `/:company/journal` route 302-redirects to `/:company/reports?t=voucher-register`.

- **Machine:** Report iframe (self-contained HTML, inline styles) — not an FB.list surface.
- **Data:** `journal_entries` grouped server-side by `batch_id` (date DESC). One row per posted batch: date, reference, description, total debit/credit, source, line count.
- **Reverse verb:** Each non-reversed voucher row has a **Reverse** button that calls `POST /api/action` with `action: 'journal.reverse', batchId`. On success the row flips to **Reversed** and the new reversal batch is prepended as a fresh row. Idempotent (server refuses double-reversal).
- **Reversal chains:** `reversed_by` set → **Reversed** badge + link to the reversal batch. `reverses` set → **Reversal** badge + link to the original batch.
- **Date-range filter:** Start/end inputs re-query via the report endpoint.
- **g j freed:** The `g j` go-to letter is no longer assigned (the register lives inside Reports = `g r`).

### 5.4 Journal-new (`/:company/journal/voucher`) — JV entry form

- **Machine:** FB.form
- **Zones:** reversal panel (present only in reversal mode) → header fields (date/journal/desc) → attachment queue → JV line grid
- **Verbs:**
  - `a` — add line (cursor + edit)
  - `x` — delete line / remove staged attachment
  - `w` — post (disabled-guard: out-of-balance blocks)
  - `q` — quit (fbNavigate to dashboard)
  - `R` — reversal mode (vim's R = replace mode). Esc contract: INSERT-Esc from the search ONLY exits edit → NORMAL (reversal stays active); NORMAL-Esc cancels the whole reversal.
  - `A` — attach (opens file picker for pending queue)
- **Reversal search:** Min-length 1; arrows/Enter navigate results; Esc closes.
- **Reversal pick:** Cursor lands on the header date cell in NORMAL (search blurred, results collapsed). Original entry renders read-only (grayed, italic) above the editable swapped rows.
- **Attachment queue:** FB.form zone (read-only rows, no cells). `j`/`k` reach it, `x` removes the cursor row.

### 5.5 Bank — dissolved (2026-08-09, issue #137)

The Bank page and its page modules (`pages/bank.js`, `pages/bank-import.js`) were deleted. The old `/:company/bank` URL 302-redirects to `/:company/reports`. Bank reconciliation is being moved to a report. The server handlers in `api/src/bank.js` (`bank.match`, `bank.reconcile.*`) are kept for the agent feed-watcher + reconcile actions. Bank imports are handled through the agent inbox, not a dedicated import wizard.

### 5.6 Bills (`/:company/bills`)

- **Tabs:** Bills · Partners
- **Machine:** FB.list (`tree: true` for Bills; flat for Partners)

**Bills tab:**
- `j`/`k` navigate the flattened sequence (parents + open children), sticky ends
- `Space` / click ▸ — fold/unfold (children lazy-fetch on first open; collapsed-by-default)
- `i`/`Enter` — edit the whole bill (parent + all children as one unit); on a posted bill = no-op
- `a` — add child line to the focused draft bill
- `x` — delete bill (confirm for saved); on a dirty-new row = discard
- `w` — write the whole bill in one request (header + lines)
- `u` — undo all
- `p` — post (draft → posted); on posted/partial → inline payment row
- `o` — new bill (master object)
- `A` — attach (bill-level)
- Column filters: `filterType` per column; `c` clears all; `Esc` peels
- Sortable columns: click header cycles asc → desc → none (mouse-only, no verb)

**Partners tab:**
- Standard FB.list contract
- `~` — toggle active (universal toggle verb)

### 5.7 Reports (`/:company/reports`)

- **Machine:** FB.form (header-only form: report/period selects + date cells + MoM/YoY/download button cells)
- **Keys:**
  - `h`/`l` — navigate cells (report type, period, start date, end date, MoM, YoY, download)
  - `i`/`Enter` — edit cell (selects open overlay; dates enter INSERT)
  - `~` — toggle the focused comparison button (MoM/YoY; re-toggle → none)
  - `d` — download menu with `j`/`k`/`Enter`/`Esc` mini-scope
- **onCommit hook:** `fbLoadReport()` fires on any committed cell change, debounced.
- **Report viewer:** `<iframe>` with `FB.util.forwardIframeKeys` so parent keybindings survive focus inside the frame.

### 5.8 Settings (`/:company/settings`)

- **Tabs:** Company · Posting Rules · AI
- **Machine:** FB.list (all tabs except Company danger zone)

**Company tab:**
- FB.list attribute/value grid (`canAdd: false` — fixed rows, no add, no delete)
- Per-row typed editors (text/number/checkbox/select) resolved from server-sent row shape
- `w` writes ONE attribute via `company.attr.save`; `u` undoes; `Esc` never saves
- **Danger zone:** Type the exact company name to arm `Delete company`; `Enter` in the input fires it; server refusals surface in the modal's error slot. `#cr-delete-btn` is mouse-only by ratified design (danger zone: GitHub/QBO pattern).

**Posting Rules / AI tabs:**
- Standard FB.list contract (add row, `i`/`Enter` edit, `w` write, `u` undo, `x` delete, `c` clear filters)

> **Note:** Periods, COA, Tax Codes, Journals, and Exchange Rates moved to the Master Data page (`/:company/master-data`) on 2026-08-11. Partners also moved there from Bills.

### 5.9 New Company (`/setup/new-company`)

- **Machine:** FB.form
- **Zones:** one zone row per field (vertical stack) → periods grid
- **Verbs:** `a` add period, `x` delete period, `w` create
- **No sidebar chrome** — hint rendering no-ops; hints render inline (`#nc-hints`)

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
- `c` clears all filters AND the mirror.
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

### 7.3 Attachments

Upload → bound to `entity_type`/`entity_id` → on approve re-pointed to `entity_type='journal'`/`batchId` → on reject/expire GC'd after 30-day grace (hard invariant: never touch `'journal'`-bound rows).

---

## 8. Attachment Model

- **`A` = attach everywhere** (K4, ratified 2026-07-28). Legacy pages route shift-a to a page-registered `attach` verb; FB.form pages declare `A` as an extraBinding.
- Attachment queues are **FB.form zones** (journal-voucher pending queue: `j`/`k` rows, `x` removes the staged file) or shared `.fb-attach-row` markup + `FB.attachments` helpers.
- Attachment rows are read-only (no inline edit, no add row — `A` is the create verb).
- **Disk controls (A4):** 15 MB per-file cap for `journal_proposal` uploads; pdf/jpg/png whitelist; sha256 dedupe per company. Other entity types keep the 32 MB status quo.

---

## 9. Verb Conventions (ratified, frozen)

| Key | Meaning | Context |
|-----|---------|---------|
| `o`/`O` | **New** master object (opens a new top-level entity) | FB.list screens |
| `a`/`A` | **Add** child to an existing parent (bill line, attachment) | FB.list tree mode; `A` = attach everywhere |
| `i`/`Enter` | Edit cell / activate row / create from add row | Universal |
| `Esc` | Peel one layer; never writes | Universal |
| `w` | **Write — the only save** | Universal |
| `u` | Undo to saved values | FB.list |
| `x` | Delete / discard | Universal |
| `y`/`x` | Approve / reject (review pair) | Inbox queue only |
| `~` | **Universal toggle verb** — toggles the state of the ACTIVE CELL / focused control | Universal |
| `Space` | Activate the focused toggle/button (parity alias of `~`/`Enter`) | FB.form button cells |
| `c` | Clear filters | FB.list filter surfaces |
| `f` | Cycle filter (list-level action) | Inbox (status), Bank (cleared), FX (fetch rates) |
| `d` | Download menu / delete (page-dependent) | Reports (download), legacy pages (delete) |
| `p` | Post / pay (page-dependent) | Payables (post bill / pay) |
| `q` | Quit / navigate away | FB.form pages |
| `R` | Reversal mode | journal-voucher only |
| `gg`/`G` | First row / last row | Framework-level |
| `?` | Which-key overlay | Global |
| `/` | Focus topbar search | Global |
| `:` | Command palette | Global |

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
| Manual journal entry / reversal / agent | journal-voucher view mode → `R` (reversal mode) |
| Bill (AP) | Bill detail → void (unpaid) or credit memo (paid — not yet built) |
| Sales invoice (AR) | Invoice detail → void or credit memo (module unbuilt) |

### 10.4 Return-to-origin

Every detail view honors a return stack: `Esc`/`q` returns to the exact screen, scroll position, and cursor position the user came from. Not a hardcoded destination. The origin's full state (route, scroll, cursor, filters) is pushed on drill and popped on return.

### 10.5 journal-voucher view mode

`/:company/journal/voucher?batch=<batchId>` loads a posted batch read-only:
- Header fields and lines render populated, non-editable.
- `R` enters reversal mode pre-targeted at that batch (the existing reversal flow).
- `Esc`/`q` returns to the origin (§10.4).
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
