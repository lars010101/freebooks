# freebooks — IA Restructure Spec: Master Data / Settings / Admin

**Superseded** by `ia-restructure-2-spec.md` (per that doc's own header) and,
for routes it further touched, `ia-restructure-3-spec.md`. The route table
below (`bills`, `reports`, `periods`, `master-data`, `admin`) does not match
current `nav-registry.js` — those sections were renamed/reorganized again in
later restructures. This document's `:`/Ctrl+K command-palette reachability
references also describe a system fully retired 2026-09-01
(`global-search-spec.md`) — kept below as historical record only, not as a
description of anything currently reachable.

**Date:** 2026-08-11 · **Status:** RATIFIED
**Scope:** Route registry, Payables, Settings, and a new Admin section. Client-side page/route reorganization; one server-side addition required (Cost/Profit Centers per-row actions — §5.2).
**Companions:** `ia-spec.md` (§1 Route Registry, §9 Verb Conventions — this spec extends both), `settings-ux-spec.md` (§7 tab-migration precedent this follows)
**Consumers:** `api/src/nav-registry.js`, `api/src/pages/common.js`, `api/src/pages/settings.js`, `api/src/pages/payables.js`, `api/src/pages/payables-partners.js`, new `api/src/pages/master-data.js`, new `api/src/pages/admin.js` (distinct from the existing `admin.js` SQL-console handler — see §7)

---

## 0. Explicitly out of scope

Per 2026-08-11 review: **no visual nav bar is being restored.** The app stays keyboard/palette-first per `ia-spec.md` §0 ("mouse parity is dropped"). Every section this spec introduces is reachable exactly the way Inbox/Reports/Periods/Settings are reachable today: `g`+letter and the `:`/Ctrl+K command palette ("Go to …" rows) — both already read `window.FB_ROUTES` directly (`fb-core.js` `_gResolve`, `_routeCommands`), so adding registry entries is sufficient; no DOM nav needs to be built. (The `?` overlay's NAV section is really the same `gKey` list rendered a second way, not a third independent path — see §0.1.)

---

## 1. Problem statement

Three concrete issues, verified against the current code (not just the docs):

1. **Partners is dual-purpose but single-homed.** `payables-partners.js` carries independent `is_vendor`/`is_customer` flags on one record (`blank()`: `is_vendor: true, is_customer: false`). It only *looks* vendor-only because Receivables is deferred, not because the model is. Filing it under Payables misrepresents the data and will misfile worse the moment Receivables returns.
2. **Settings conflates three different kinds of content on one tab strip:** reference registers a user maintains occasionally (COA, Tax Codes, Journals, Exchange Rates), configuration values that shape behavior (Company profile, Posting Rules, AI/Agent config), and one-shot imperative operations (Fetch Rates, the still-unbuilt Test LLM Connection — issues #179/#180) bolted onto whichever tab happens to hold their related data.
3. **There is no Admin section**, confirmed by the code's own comment (`settings-ux-spec.md` §7 item 1): *"There is no admin page — deferred until install-level surface area accumulates (user/permission management when auth lands, audit viewer)."* Company switch/create/delete is currently split three ways: footer status-line click (`fbToggleCompany`), a dropdown's buried `+ New company` link, and a danger-zone block on Settings → Company. That surface area has now accumulated; this spec pulls the deferred section forward.

---

## 2. Route Registry changes

### 2.1 New / changed entries (`api/src/nav-registry.js`)

`sidebar: true` is kept in the entries below purely because every other primary-section entry in the registry sets it, and the field still marks "this is a top-level destination" as metadata — but per §0.1 below, it currently has **no functional effect**. What actually makes a route reachable today is `gKey` (→ `g`+letter, and a row in the `?` overlay's NAV section) and `palette: true` (→ a "Go to …" row in `:`/Ctrl+K). Read the "Reachable via" column, not "Sidebar".

| Key | Route | Label | Icon | Reachable via | Notes |
|-----|-------|-------|------|---------|-------|
| `inbox` | `/:company` | Inbox | 📥 | `g i` · palette | unchanged |
| `bills` | `/:company/bills` | Bills | 📋 | `g b` · palette | **renamed from `payables`**; `gKey: 'b'` assigned (was `null`); Partners tab removed (→ Master Data) |
| `reports` | `/:company/reports` | Reports | 📈 | `g r` · palette | unchanged |
| `periods` | `/:company/periods` | Periods | 📅 | `g p` · palette | unchanged |
| `master-data` | `/:company/master-data` | Master Data | 🗂 | `g m` · palette | **new** — Partners · Chart of Accounts · Tax Codes · Journals · Exchange Rates · Cost/Profit Centers |
| `settings` | `/:company/settings` | Settings | ⚙ | `g s` · palette | **slimmed** — Company · Posting Rules · AI |
| `admin` | `/:company/admin` | Admin | 🛠 | `g a` · palette | **new** — Companies · Operations |

Unchanged non-sidebar entries (`journal-voucher`, `opening-balances`, `new-company`) carry over as-is.

### 0.1 Correction: "sidebar-reachable" is not a real reachability path today

Verified directly in the code, not just inferred: `ia-spec.md` §4 documents `{`/`}` as a live global "Sidebar prev/next page" keybinding, and `nav-registry.js`'s own header comment describes `.sidebar` entries as feeding both `navBar()`'s rendered `.sb-nav` list and `{`/`}` cycling. Neither is true anymore. `navBar()` (`api/src/pages/common.js`) renders no page-nav markup at all (confirmed previously). And a full grep of every shipped public JS file (`common.js`, `fb-core.js`, `fb-list.js`, `fb-form.js`, `fb-command.js`) for a `{`/`}` handler turns up nothing — the keybinding `ia-spec.md` documents doesn't exist in the running app. `{`/`}` today only does anything on pages with a `.tabs` strip, where it switches tabs *within* that page (`ia-spec.md` §3.2 tab-strip precedence) — it does not move between top-level sections.

So `bills`' current `gKey: null` genuinely means: reachable **only** via the `:`/Ctrl+K palette (typing part of "Bills" and hitting Enter). No letter shortcut, no `?`-overlay listing, no cycling. That's a real, separate gap from "sidebar reachable" — a phrase that describes nothing that currently runs. This spec doesn't fix it (see §6.2), but it should stop being described as fine because "it's sidebar+palette reachable" — it's palette-only, full stop, and `ia-spec.md` §4's `{`/`}` row and `nav-registry.js`'s consumer-list comment are both stale and worth a follow-up correction independent of this spec.

### 2.2 Updated g-key slate

```
g i = Inbox · g r = Reports · g p = Periods · g s = Settings
g m = Master Data (new)      · g a = Admin (new)
g b = Bills (new — was unassigned since Bank's removal)
g c = Company switcher (reserved, not a route — unchanged, see §5.1)
g d / g v / g j = still free (Dashboard/Receivables/Journal, dropped earlier)
```

`bills` gets `gKey: 'b'`, promoted from the current `payables`' `gKey: null` — resolves the palette-only gap flagged in §0.1 and §6.2.

### 2.3 Deep-link redirects (compatibility)

Following the precedent already set for Periods (`?tab=periods` 302→ `/periods`) and Bank (`/bank` 302→ `/reports`):

| Old URL | New URL |
|---|---|
| `/:company/payables` | `/:company/bills` |
| `/:company/payables?tab=partners` | `/:company/master-data?tab=partners` |
| `/:company/settings?tab=coa` | `/:company/master-data?tab=coa` |
| `/:company/settings?tab=vat` | `/:company/master-data?tab=vat` |
| `/:company/settings?tab=journals` | `/:company/master-data?tab=journals` |
| `/:company/settings?tab=fxrates` | `/:company/master-data?tab=fxrates` |
| `/:company/settings?tab=opening-balances` | unchanged — Opening Balances stays a Settings-adjacent non-sidebar route, no relation to this restructure |

No redirect needed for Cost/Profit Centers — there's no prior URL to redirect from (§3.2).

---

## 3. Section definitions

### 3.1 Bills (`/:company/bills`, was Payables)

Bills tab only — content and machine unchanged (`payables-bills.js`, `tree: true` FB.list, existing verb table: `o/a/x/w/u/p` etc. per `ia-spec.md` §5.6). The Partners tab is deleted from this page; its markup, `partnersTabJS()`, and the `pay-panel-partners`/`partners-body` DOM ids move to Master Data (§3.2) unchanged. `showPayTab` collapses to a no-op tab strip of one (or the tab strip is removed entirely and the page becomes single-panel — implementer's choice, no interaction-contract impact either way since there's only one panel left).

### 3.2 Master Data (`/:company/master-data`)

**Tabs (default: Partners):** Partners · Chart of Accounts · Tax Codes · Journals · Exchange Rates · Cost/Profit Centers

Five of the six are existing FB.list registers relocated verbatim — no field, column, verb, or server-action changes. The sixth (Cost/Profit Centers) is **net-new UI** — the backing table and actions exist but no page has ever surfaced them:

| Tab | Source today | FB.list config carries over from |
|---|---|---|
| Partners | Payables → Partners tab | `payables-partners.js` (`partnersTabJS`) — unchanged, including `is_vendor`/`is_customer` columns and `~` toggle-active verb |
| Chart of Accounts | Settings → COA tab | `settings.js` `#tab-coa` block — unchanged, including the Default-flag column |
| Tax Codes | Settings → Tax Codes tab | `settings.js` `#tab-vat` block — unchanged, including `vat_registered` relevance gating |
| Journals | Settings → Journals tab | `settings.js` `#tab-journals` block — unchanged |
| Exchange Rates | Settings → Exchange Rates tab | `settings.js` `#tab-fxrates` block — unchanged, including the `f` / "📡 Fetch Rates" list-level action (stays here, not moved to Admin) |
| Cost/Profit Centers | **none — no UI exists today** | new FB.list, schema `centers(company_id, center_id, center_type, name, is_active)` (`db/schema.sql`). Columns: Center ID · Name · Type (`cost`/`profit`, select) · Active. Tags are free-text on journal/bill lines (`cost_center`/`profit_center` VARCHAR, not FK-enforced) — this tab is where the *pick-list* for those tags gets maintained. See §5.2 for the required server-side addition. |

Adopt the same `?tab=` deep-link handling Settings already has (`handleSettingsPage`'s `req.query.tab` check) so `/:company/master-data?tab=journals` etc. work.

`vat_registered=false` still hides Tax Codes; `fx_tracking='false'` still hides Exchange Rates — the relevance-flag gating (`applyRelevanceFlags`) moves with its tab, unchanged in logic, just now scoped to the Master Data tab strip instead of Settings'.

### 3.3 Settings (`/:company/settings`, slimmed)

**Tabs (default: Company):** Company · Posting Rules · AI

| Tab | Change |
|---|---|
| Company | Unchanged — attribute/value grid + Danger Zone. Danger Zone (`company.delete`) keeps deleting **only the current company**, matching today's server contract; no scope expansion here (see §6 for why company-list-with-delete isn't being added). |
| Posting Rules | Unchanged (`postrules-attrs-body`) — FX conversion sourcing + VAT tolerance values. |
| AI | Unchanged config rows (`agent_enabled`, `llm_endpoint_url`, `llm_model`, `llm_temperature`, etc.). When Test LLM Connection lands (#179/#180), it goes to Admin → Operations, not here. |

### 3.4 Admin (`/:company/admin`, new)

**Tabs (default: Companies):** Companies · Operations

**Companies tab:**
- FB.list, read-mostly register (`company.list`, existing action) — columns: Name, Company ID, Jurisdiction, Currency.
- Row click/`Enter` switches company then redirects to Inbox (`/:company`) — same landing page as the footer/`g c` switcher. The switcher (§5.1) stays in place as the quick-switch path; this is the browse-then-switch path.
- List-level action `o` / "+ New company" → navigates to existing `/setup/new-company` (same target the switcher dropdown link uses today; this becomes the second, more discoverable entry point, not a replacement).
- Rename and delete are **not** added here — they stay on Settings → Company (§3.3), reached by switching into the target company first. This is a closed scope decision, not a deferred one: the current single-company-scoped `company.delete` guard logic stays as-is, and Admin → Companies remains a browse-and-switch surface only.

**Operations tab:**
- Not an FB.list register — a small list of action cards/buttons, one per one-shot operation. Each card: label, one-line description, a "Run" action, a status/result line, and a link back to where its configuration or output lives.
- **Test LLM Connection** — runs whatever action lands for issues #179/#180 (action name TBD; this spec only fixes its *location*, not its implementation). Card links to Settings → AI ("Configure →").
- Future occupants noted for continuity, not built now: API token mint/revoke (currently curl-only per `README.md`'s MCP section), FX revaluation preview/post (`fx.revaluation_preview`/`fx.revaluation_post` — API/agent-only today, no UI), user/role permission management, audit-log viewer.

---

## 4. Interaction contract additions (`ia-spec.md` §5 style)

### 4.1 Master Data (`/:company/master-data`)

- **Tabs:** Partners · Chart of Accounts · Tax Codes · Journals · Exchange Rates · Cost/Profit Centers
- **Machine:** FB.list on every tab (no FB.form panels on this page)
- **Tab visibility:** same relevance-flag gating as today (`vat_registered`, `fx_tracking`), just relocated
- Per-tab verbs: identical to the corresponding Settings tab's current contract (`ia-spec.md` §5.8) — no verb changes, only the page they render on changes. Exchange Rates keeps its `f` list-level action (Fetch Rates stays inline). Cost/Profit Centers gets the standard register verb set (`o/a/x/w/u/`) backed by new `center.upsert`/`center.delete` actions (§5.2).

### 4.2 Admin (`/:company/admin`)

- **Tabs:** Companies · Operations
- **Companies tab machine:** FB.list (`canAdd` via list-level `o` action → external navigate, not an in-place add row — same pattern COA's Default-flag or Bills' `o` uses for master-object creation)
- **Operations tab machine:** none of the three existing machines cleanly fit (it's neither a register nor a form). Treat it as an `FB.nav` grid of button cards (`ia-spec.md` §3.3 — `FB.nav.create({ grid })`), `j`/`k`/`h`/`l` move between cards, `Enter` runs the focused card's action (no new keyboard verb introduced — consistent with the frozen verb surface, `ia-spec.md` §9).

---

## 5. What does NOT change

### 5.1 Company switcher

`g c` and the footer status-line click (`fbToggleCompany`) stay exactly as they are — fast, modal, switch-only. Admin → Companies is the fuller *management* surface (browse all companies, jump to New Company); it doesn't replace the quick switcher, the two coexist the same way Bills' `o` and the Admin → Companies `o` both create master objects without one deprecating the other.

### 5.2 Server / API surface

Mostly unchanged — this is a client-side page/route reorganization: `vendor`/`partner.*`, `coa.*`, `vat.codes.*`, `fx.rates.*`, `fx.fetch_rates`, `company.*`, `ai.attr.*`, `posting_rules.attr.*` all keep their current contracts. Two exceptions, both already flagged elsewhere in this spec:

- Whatever action backs Test LLM Connection (#179/#180) — already planned independent of this spec.
- **Cost/Profit Centers needs new per-row actions.** The existing `center.save` (`api/src/index.js`) is a bulk delete-all-then-reinsert handler — the same "replace everything" pattern already retired for VAT codes and FX rates in favor of the one-save-path-per-row (`w`) doctrine (`settings-ux-spec.md` §7 items 2 and 5). Giving Centers a real FB.list tab means adding `center.upsert` (single-row) and `center.delete` alongside the existing `center.list`, not reusing `center.save` as-is. `center.save` can stay for now (nothing else calls it, low urgency to remove) or be retired in the same pass — implementer's call.

---

## 6. Open questions / deferred (parking lot)

1. ~~**Should Admin → Companies support delete/rename per-row?**~~ **Resolved (2026-08-11): No.** Delete/rename stays on Settings → Company. Admin → Companies is browse-and-switch only. `company.delete`'s single-company-scoped guard logic stays unchanged. Not revisiting.
2. ~~**Bills has no letter shortcut and doesn't appear in the `?` overlay**~~ **Resolved (2026-08-11): `g b` assigned to Bills** (§2.2). Bills now appears in the `?` overlay's NAV section alongside the other g-key destinations.
3. **Test LLM Connection's action name and payload** are owned by issues #179/#180, not this spec — this spec only reserves its home on Admin → Operations.
4. **`#sb-hints` dangling reference** (`settings.js`, `payables-bills.js`, `company.js` all call `document.getElementById('sb-hints')` against an element that no longer exists in `navBar()`/`layoutEnd()`) — unrelated pre-existing bug, flagged here so it isn't lost, not fixed by this spec.
5. **`ia-spec.md` §4 and `nav-registry.js`'s header comment are stale and should be corrected in a follow-up doc pass, independent of this spec:** both still describe `{`/`}` as cycling between sidebar pages and `.sidebar` entries as feeding a rendered `.sb-nav` list. Neither exists in the shipped JS (§0.1). Left unfixed, the next person who reads `ia-spec.md` will assume `{`/`}` does something it doesn't.

---

## 7. Naming collision note

`api/src/pages/admin.js` already exists today as the `FREEBOOKS_ADMIN_TOKEN`-gated arbitrary-SQL console handler (`handleAdminQuery`, mounted at `POST /api/admin/query`), unrelated to this spec's Admin *page*. The new Admin section's page handler needs a distinct file name (e.g. `api/src/pages/admin-page.js`) to avoid clobbering it — flagging so implementation doesn't silently overwrite the SQL-console route.

---

## 8. Changelog

| Date | Change |
|------|--------|
| 2026-08-11 | Spec drafted: Partners → Master Data; Settings split into Master Data / Settings / Admin; (future) Test LLM Connection placed on Admin → Operations; Payables renamed Bills. Status: PROPOSED, pending ratification. |
| 2026-08-11 | Added Cost/Profit Centers as a sixth Master Data tab — previously unbuilt (schema + `center.list`/`center.save` existed, no UI). Requires new `center.upsert`/`center.delete` actions to match the app's per-row save doctrine (§5.2). |
| 2026-08-11 | Review decisions applied: (1) Admin → Companies is browse-and-switch only, no per-row delete/rename — closed, not deferred. (2) `g b` assigned to Bills (was palette-only). (3) Fetch Rates (`f` verb) stays on Exchange Rates in Master Data, not moved to Admin → Operations. Also fixed: §4.1 added Cost/Profit Centers to tab list; `~` removed from Operations card activation (Enter only); scope claim corrected to acknowledge server-side Centers addition; §3.3 AI tab "minus" framing replaced with forward-looking statement. |
