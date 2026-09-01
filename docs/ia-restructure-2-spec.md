# freebooks — IA Restructure Spec 2: Payables / Statements / Books / Fiscal / Accounting / Exchange Rates

**Date:** 2026-08-27 · **Status:** PROPOSED
**Scope:** Route registry, a new Payables page, Reports split into Statements + Books (renamed), Periods renamed to Fiscal and flattened, Settings split into Settings + Accounting, Master Data dissolved (Exchange Rates promoted standalone), Admin dissolved. No compatibility redirects — single-user install, clean cutover (§2.3). Also: stub a per-page/per-report `dateRelevance` flag (declared only, not consumed — chrome wiring is a follow-up spec, see §0).
**Companions:** `ia-spec.md` (§1 Route Registry, §5 per-view contracts, §9 Verb Conventions — this spec extends all three), `ia-restructure-spec.md` (2026-08-11, the immediate predecessor this spec supersedes for Master Data/Settings/Admin), `report-registry.md`/`report-registry.js` (REPORT_REGISTRY split), `command-bar-ux-spec.md` (new `:vat-tolerance`/`:gst-tolerance` aliases)
**Consumers:** `api/src/nav-registry.js`, `api/src/report-registry.js`, `api/src/pages/common.js` (route deep-link semantics §2.4, `topBarContext`'s page-chrome key map §2.6), new `api/src/pages/payables.js` (rehomed), `api/src/pages/master-data.js` (dissolved — content redistributed), `api/src/pages/admin-page.js` (deleted), `api/src/pages/periods.js` (renamed/flattened), `api/src/pages/settings.js` (old redirect handlers removed, §2.3), `api/src/pages/reports-hub.js` (split), `api/public/fb-command.js` (new tolerance aliases), **`api/src/action-catalog.js`** (18+ hardcoded palette-navigation routes, §2.5 — first-class migration task, not a side effect)

---

## 0. Explicitly out of scope

1. **The chrome rework** (top/bottom bar swap, the live global Period Selector with Period/Custom modes, moving the command bar to the bottom status line) is a separate, sequenced follow-up. Per design-review decision: IA restructure ships first, chrome second, because the chrome's per-page dimming logic depends on the final page list being stable. This spec only **declares** the `dateRelevance` value per page/report (§9) — nothing reads it yet.
2. **Receivables** is not built in this pass. AR remains tracked as open backlog (`review-roadmap.md` P3-1, issue #110). This spec does not add a `receivables` route, page, or gKey — see §6.1 for why, and what the eventual shape should reuse.
3. **Bill entry paths** (agent, inline grid, full-page form, command-bar `:bill`) are unchanged — reviewed and deliberately kept as a tiered ladder, not IA scope.

---

## 1. Problem statement

Five issues, verified against the current code and the 2026-08-11 restructure it revises:

1. **Partners is filed under a neutral "Master Data" container it doesn't need.** AR was deliberately dropped (`nav-registry.js` changelog: *"Receivables dropped 2026-08-05... route + page handler deleted"*; commit `f73d329`: *"AR module dropped (§0m of review-roadmap)"*). `is_customer` persists in the schema and round-trips through `partners.js`, but nothing downstream (bills, aging, reports) ever reads it. Partners is AP-only data in practice today, filed under a generic label that implies a bigger, shared registry than actually exists.
2. **Master Data mixes static and dynamic content on one tab strip.** Chart of Accounts, Tax Codes, WHT Codes, Journals, and Cost/Profit Centers are seeded once from the jurisdiction pack (`setup.add_company`, `api/src/setup.js`) and rarely touched again. Partners and Exchange Rates are not — Partners grows continuously as an ordinary side effect of business activity, and Exchange Rates is a literal date-stamped time series refreshed via the ECB fetch action. Once Partners moves out (issue 1), Master Data holds only Exchange Rates — a tab strip of one, the same anti-pattern already ruled out for Admin → Operations (see issue 4).
3. **Reports mixes three audiences on one dropdown.** `report-registry.js`'s `REPORT_REGISTRY` already half-acknowledges this with `category` optgroups (Financial statements / Audit / Tax & filings), but AP Aging is filed under "Tax & filings," which it has nothing to do with. Financial statements (P&L, BS, CF, SCE) are output/decision documents for whoever's judging the business; Trial Balance/GL/Journal Line Listing/Integrity Check/Transaction Register are ledger-diagnostic tooling for whoever's doing the bookkeeping; AP Aging/AP Control are vendor-operational reports that belong nearer Partners than nearer financial statements.
4. **Annual Report is duplicated across Reports and the Fiscal page's Filings tab, and it's frozen.** `report-registry.js`'s `ar` entry and the `filing.list` artifact link on what's proposed below as the Fiscal page (renamed from Periods) both resolve to the exact same route (`report?type=ar` → `renderAnnualReport()` in `report-composite.js`) — not parallel data, the same generator. `docs/reports-dashboard-spec.md` §5–6 already froze this report ("read-only viewer only, no further development," SE annual-report production moved to Gredor). The Fiscal-page surface is strictly more complete (pre-scoped fiscal year, due-date/filed-state tracking) — the Reports dropdown entry is pure redundancy.
5. **The old Periods page nests two unrelated child-row kinds under one expand triangle, and Admin's third tab is a dead stub.** `periods.js`'s "Periods" tab expands each row into both filing entries and close-checklist items — two structurally similar but conceptually different lists (regulatory due dates vs. internal close-readiness attestations) crammed into one disclosure control. Separately, Admin → Operations holds exactly one disabled card ("Test LLM Connection — Coming soon") that duplicates the working "Test connection" action already on Settings → AI — it has never held anything else.

---

## 2. Route Registry changes

### 2.1 New / changed entries (`api/src/nav-registry.js`)

| Key | Route | Label | gKey | Notes |
|---|---|---|---|---|
| `inbox` | `/:company` | Inbox | `i` | unchanged |
| `payables` | `/:company/payables` | Payables | `p` | **renamed from `bills`**; fresh mnemonic gKey (`p` for Payables), freed up by Fiscal moving off it. Tabs: Bills · Vendors · Aging · Control (§3.1) |
| `statements` | `/:company/statements` | Statements | `t` | **new** — split out of Reports; P&L · Balance Sheet · Cash Flow · Statement of Equity (§3.2) |
| `books` | `/:company/books` | Books | `b` | **renamed from `reports`** (trimmed scope unchanged from the prior draft of this spec) — ledger/audit tooling. "The books," as in the detailed ledger, distinct from "Statements" (polished output). gKey `b` freed by Payables moving off it (§3.2) |
| `fiscal` | `/:company/fiscal` | Fiscal | `f` | **renamed from `periods`/`filings`** — the mid-discussion name "Filings" collided with its own "Filings" tab (same bug class as the old Periods/Periods collision), so the page is named one level up instead. Tabs: Periods · Filings · Close Checklist, fully flattened (§3.3) |
| `settings` | `/:company/settings` | Settings | `s` | **slimmed** — Company · Access · Extensions (§3.4) |
| `accounting` | `/:company/accounting` | Accounting | `a` | **new**, reuses Admin's freed `a` gKey (mnemonic carries over) — Chart of Accounts · Tax Codes · Journals · Cost/Profit Centers (§3.5) |
| `exchange-rates` | `/:company/exchange-rates` | Exchange Rates | `x` | **new**, standalone, no tabs — replaces Master Data (§3.6) |

Unchanged non-sidebar entries (`journal-voucher`, `new-company`) carry over as-is. `new-company` is now reached exclusively via the company switcher's "+ New company" link (§5.1) — no other entry point changes.

**Removed entries:** `master-data` (dissolved, content redistributed to §2.1's `payables`/`accounting`/`exchange-rates`), `admin` (dissolved — Companies absorbed into the switcher §5.1, Access moved to Settings §3.4, Operations dropped §5.2).

### 2.2 Updated g-key slate

```
g i = Inbox              · g b = Books (was Reports, trimmed)
g p = Payables (was Bills)   · g f = Fiscal (was Periods/Filings)
g t = Statements (new)   · g s = Settings
g a = Accounting (new — reuses Admin's freed key)
g x = Exchange Rates (new)
g c = Company switcher (reserved, not a route — unchanged, see §4)
g r = reserved for future Receivables (freed from Reports moving to `b`)
g m = FREE (Master Data dissolved) · g v = FREE (no longer needed — Receivables now reserves `r` instead) · g d / g j = still free
```

### 2.3 No compatibility redirects — clean cutover, including retiring the old redirect code

Single-user install, no bookmarks to preserve: old routes (`/:company/bills`, `/:company/master-data*`, `/:company/admin*`, `/:company/periods*`, the old `/:company/reports?type=pl|bs|cf|sce|ap-aging|ap-control|ar`) are simply deleted, not 302-redirected to their new equivalents. No new compatibility table, no new deep-link shim code.

This also means the *existing* redirect handlers from the 2026-08-11 restructure must be deleted, not left in place — leaving them would actively misroute. Confirmed in `api/src/pages/settings.js` lines 5–15: `?tab=periods` → 302 to `/:company/periods` (now a dead route, §2.1), and `?tab` ∈ `{coa, vat, journals, fxrates}` → 302 to `/:company/master-data?tab=...` (Master Data no longer exists — this would 302 straight into a 404). Both blocks must be removed as part of this cutover, not just left inert.

### 2.4 Tab addressing: `?tab=` stays as a load-bearing navigation param, but stops trying to track live tab switches

Correction from an earlier draft of this section, which proposed dropping `?tab=` from the URL scheme entirely — that would have broken real functionality. `api/src/action-catalog.js` has 15+ palette entries that navigate to a specific tab (and often `&new=1` create mode) on arrival — e.g. `coa.save` → `/master-data?tab=coa&new=1` (§2.5 enumerates the full remapping). That's not decorative bookmark support, it's how "New account" / "New VAT code" / "Grant access" etc. work from the `:` palette today. Dropping `?tab=` outright would silently break every one of them.

The actual bug (confirmed in `handleSettingsPage`, `api/src/pages/settings.js`) is narrower: `?tab=` is read once on load, but nothing updates the URL when a tab is switched client-side afterward — so the address bar and the visible tab drift apart the moment you click. The fix addresses that specific gap, not the load-bearing param:

- **`?tab=X` (and `&new=1`) on initial page load still works exactly as today** — the palette's deep links are unaffected, and this is the only place `?tab=` is read.
- **Switching tabs interactively never touches the URL, before or after this spec** — no change in behavior there, just no longer described as a bug to fix, since nothing was ever supposed to keep it in sync.
- **New:** switching tabs interactively writes the page's last-active tab to `sessionStorage` (e.g. `fb.tab.payables`), session-scoped — cleared when the browser tab closes.
- **New:** a plain visit with *no* `?tab=` param (e.g. arriving via `g p`) reads `sessionStorage` to restore the last-active tab for that page; falls back to the page's documented default tab if nothing is stored. An explicit `?tab=` always wins over `sessionStorage` — the palette's deep links stay deterministic regardless of session history.

This is unrelated to the Statements/Books report-type picker (`?type=`), which is a real content selector, not tab-strip visual state, and is unaffected — it keeps its existing `localStorage`-backed persistence (`fb-rpt-period`, `fb-rpt-start`, `fb-rpt-end`, etc.).

### 2.5 `action-catalog.js` route remapping (first-class migration task)

Every hardcoded route in the palette-navigation table (`api/src/action-catalog.js` lines ~779–806) needs updating — both the path (per §2.1's route renames) and, in a few cases, the tab query key (per §3.5's Tax Codes merge and §3.1's Vendors rename). This is not a side effect of the page moves, it's a required, enumerable edit:

| Action | Old route | New route |
|---|---|---|
| `coa.save` | `/master-data?tab=coa&new=1` | `/accounting?tab=coa&new=1` |
| `coa.update` | `/master-data?tab=coa` | `/accounting?tab=coa` |
| `coa.upsert` | `/master-data?tab=coa` | `/accounting?tab=coa` |
| `vat.codes.upsert` | `/master-data?tab=vat&new=1` | `/accounting?tab=tax-codes&new=1` |
| `vat.codes.view` | `/master-data?tab=vat` | `/accounting?tab=tax-codes` |
| `journals.view` | `/master-data?tab=journals` | `/accounting?tab=journals` |
| `journals.save` | `/master-data?tab=journals&new=1` | `/accounting?tab=journals&new=1` |
| `partner.save` | `/master-data?tab=partners&new=1` | `/payables?tab=vendors&new=1` — see ambiguity note below |
| `partner.upsert` | `/master-data?tab=partners` | `/payables?tab=vendors` — same ambiguity |
| `period.save` | `/periods?new=1` | `/fiscal?tab=periods&new=1` |
| `period.upsert` | `/periods` | `/fiscal?tab=periods` |
| `period.close` | `/periods` | `/fiscal?tab=periods` |
| `center.upsert` | `/master-data?tab=centers&new=1` | `/accounting?tab=centers&new=1` |
| `center.save` | `/master-data?tab=centers` | `/accounting?tab=centers` |
| `fx.rates.save` | `/master-data?tab=fxrates&new=1` | `/exchange-rates?new=1` |
| `fx.provider.save` | `/master-data?tab=fxrates` | `/exchange-rates` |
| `fx.revaluation_post` | `/master-data?tab=fxrates` | `/exchange-rates` (provisional — see §6 item 4, this action's real UI home is still undecided) |
| `permissions.upsert` | `/admin?tab=access&new=1` | `/settings?tab=access&new=1` |
| `permissions.list` | `/admin?tab=access` | `/settings?tab=access` |
| `posting_rules.attr.list` | `/settings?tab=postrules` | `/settings?tab=extensions` — see §7, the Posting Rules tab this pointed at no longer exists |
| `report.refresh_vat_return` | `/reports` | `/fiscal?tab=filings` — a VAT return is a filing artifact, not a Books/ledger report; flagged, not certain — confirm against what this action actually does before committing |

**Open ambiguity — `partner.save`/`partner.upsert`:** these are generic "create/edit a partner" actions with no vendor/customer distinction, but Partners now lives in two places (Payables → Vendors, Receivables → Customers, §3.1/§6 item 1). Defaulting both to Payables → Vendors is safe *for now* since Receivables doesn't exist yet, but this needs revisiting once issue #110 ships — either the action needs an `is_customer` discriminator, or it stays defaulted to Vendors with Receivables getting no palette shortcut of its own.

### 2.6 `common.js`'s `topBarContext` page-chrome map

`api/src/pages/common.js`'s `topBarContext()` (~line 113) keys a per-page `{ nav, actions }` object by `activeKey`, including a `'master-data'` entry (line 124) that needs replacing with `'payables'` (already present), `'accounting'`, `'exchange-rates'`, `'statements'`, and `'books'` (replacing `'reports'`) to match §2.1's route keys. **Confirmed non-urgent:** every entry in this map is currently `{ nav: '', actions: '' }` — completely inert — and the lookup falls back to that identical empty default for any unrecognized key (`ctx[activeKey] || { nav: '', actions: '' }`), so a stale key produces no functional bug today, only a maintenance trap for whoever eventually populates real content here. Worth fixing for hygiene in the same pass, not because it's load-bearing. (Aside, unrelated to this spec: `'dashboard'`, `'bank'`, and `'auditor'` are already-stale keys from prior restructures — Dashboard and Bank were both dropped years before this spec — left as-is here since cleaning up unrelated cruft isn't this spec's job.)

---

## 3. Section definitions

### 3.1 Payables (`/:company/payables`, was Bills)

**Tabs (default: Bills):** Bills · Vendors · Aging · Control

| Tab | Source today | Carries over from |
|---|---|---|
| Bills | `/:company/bills` (sole tab post-2026-08-11) | `payables-bills.js` — unchanged, including the tree-table verb set |
| Vendors | Master Data → Partners | `payables-partners.js` (`partnersTabJS`) — same file this content originated from before the 2026-08-11 move to Master Data; default sort/filter changes to surface `is_vendor` rows first. Tab labeled **Vendors** (Receivables gets the symmetric **Customers**, §6 item 1) |
| Aging | Reports → AP Aging | `api/src/pages/ap-aging.js` — same generator/route (`report?type=ap-aging`), relocated entry point only |
| Control | Reports → AP Control | Same generator/route (`report?type=ap-control`), relocated entry point only |

`api/src/pages/payables.js` already exists as the current Bills page shell (per the 2026-08-11 spec's own note that its tab strip "collapses to a no-op tab strip of one" once Partners left) — this spec re-expands that same shell to four tabs rather than introducing a new file.

### 3.2 Statements (`/:company/statements`, new) and Books (`/:company/books`, renamed from Reports)

Both pages share the existing `reports-hub.js` iframe-picker machinery and `report-registry.js` registry — this is a `REPORT_REGISTRY` category split plus two thin route wrappers, not a new rendering engine. "Reports" as a label ceases to exist; the underlying files (`reports-hub.js`, `report-registry.js`) keep their names — only the route/label/gKey change.

**Statements tabs/entries:** Profit & Loss · Balance Sheet · Cash Flow · Statement of Equity (`REPORT_REGISTRY` ids `pl`, `bs`, `cf`, `sce` — category becomes the page itself, no optgroup needed)

**Books entries:** Transaction Register · Trial Balance · General Ledger · Journal Line Listing · Integrity Check (`REPORT_REGISTRY` ids `voucher-register`, `tb`, `gl`, `journal`, `integrity`)

**Removed from `REPORT_REGISTRY` entirely:** `ap-aging`, `ap-control` (→ Payables, §3.1), `ar` (→ Fiscal-only, per §1 item 4 — the Annual Report artifact link on the Fiscal → Filings tab is the sole surface, never duplicated back into Statements or Books)

### 3.3 Fiscal (`/:company/fiscal`, renamed from Periods, fully flattened)

**Tabs (default: Periods):** Periods · Filings · Close Checklist

| Tab | Source today | Change |
|---|---|---|
| Periods | Periods tab (was "Schedule" mid-discussion, reverted) | Flattened — Period Name, Start, End, Locked, FX. No row expansion, no nested children. |
| Filings | Deadlines tab (`periods.js` line 86 — labeled "Deadlines" in the current code) | **Pure rename, not a data change.** The existing Deadlines tab is already a flat, cross-period view of `filing.list` (Filing, Period, Authority, Due Date, State, Artifact) — this tab keeps that exact content, just relabeled "Filings." Separately, the nested filing child-rows currently duplicated under each Periods row (same `filing.list` data, rendered a second way, per-period) are **deleted outright, not migrated** — they'd be pure duplication of what the renamed Filings tab already shows. Two distinct edits, not one "extraction": (a) rename Deadlines → Filings, no content change; (b) delete the redundant nested rows from the Periods tab. |
| Close Checklist | Nested checklist child rows under Periods | **New flat tab**, pulled out of the tree — Period, Item, Pass/Fail, Detail, manual attestation toggle (`period.close_check`, `periods-page-service.js`) — same data, same per-item pass/fail evaluation, now its own table instead of a second child-row kind under Periods |

Regulatory documents (VAT return, INK2, Annual Report, SIE 4 export) continue to generate via the shared report engine but surface **exclusively** through the Filings tab's artifact links, scoped to the relevant fiscal period — never duplicated as standalone Statements/Books entries (§1 item 4 established this for Annual Report specifically; the rule generalizes to VAT return/INK2 too, which were never duplicated in the registry to begin with).

### 3.4 Settings (`/:company/settings`, slimmed further)

**Tabs (default: Company):** Company · Access · Extensions

| Tab | Change |
|---|---|
| Company | Unchanged |
| Access | **Moved from Admin.** Same register (`permissions.list`/`permissions.upsert`/`permissions.delete`), same columns (Email, Role, Global-scope badge) |
| Extensions | **Renamed from AI**, absorbs FX Provider + FX API Key and Bill Extraction Tolerance from the dissolved Posting Rules tab. Final field list: Multi-Currency toggle, FX Provider, FX API Key, Bill Extraction Tolerance, plus the existing agent/LLM/Vision config rows and the "Test LLM Connection" action |

**Posting Rules tab is deleted.** Its two VAT Tolerance fields (`vat_tolerance`, `vat_tolerance_pct`) get **no UI surface at all** — see §7.

**API note:** moving these fields onto Extensions is a UI-only change — no new action is needed. The tab reads/writes through **two existing attribute namespaces**, unchanged: `posting_rules.attr.list`/`.save` for the fields it inherited (FX Provider, FX API Key, Bill Extraction Tolerance), and `ai.attr.list`/`.save` for its original LLM/Vision/agent fields. Extensions is one tab backed by two action families, not a newly-unified one — worth stating explicitly so an implementer doesn't build a redundant merged action.

### 3.5 Accounting (`/:company/accounting`, new)

**Tabs (default: Chart of Accounts):** Chart of Accounts · Tax Codes · Journals · Cost/Profit Centers

| Tab | Source today | Change |
|---|---|---|
| Chart of Accounts | Master Data → Chart of Accounts | Unchanged |
| Tax Codes | Master Data → Tax Codes + WHT Codes | **Merged.** `vat_codes` and `wht_codes` are near-identical shapes (code, description, rate, account, report box, active, effective dates); WHT lacks only the input/output account split and reverse-charge flag VAT has. One tab, one grid, a Type column (VAT/GST vs. WHT) distinguishing the two extra VAT-only fields per row. This is real UI/data-merge work, not a pure relocation — flag accordingly in implementation estimates. **Also note:** the two tables use different PK column names (`vat_code` vs. `wht_code`) — the merged grid needs either a unified column (e.g. `code`, mapped on read/write per row's Type) or an explicit per-type column mapping; don't assume a shared column name exists today. |
| Journals | Master Data → Journals | Unchanged |
| Cost/Profit Centers | Master Data → Cost/Profit Centers | Unchanged (already built per the 2026-08-11 spec's follow-through — no new server actions needed this time) |

### 3.6 Exchange Rates (`/:company/exchange-rates`, new, standalone)

No tabs — a single page, same content as Master Data → Exchange Rates today (rate grid, currency picker, `f` / "📡 Fetch Rates" action), just promoted to its own route since it was the only tenant left once Partners moved out. Matches the existing precedent of single-purpose non-tabbed routes (`journal-voucher`).

---

## 4. What replaces Admin

Admin dissolves entirely; its three tabs land in three different places, not one:

- **Companies** → the existing company-switcher dropdown (`g c` / footer `.fb-sl-company`) becomes the sole browse-and-switch surface, unchanged otherwise. The separate read-only Companies register (Name/Company ID/Jurisdiction/Currency columns, `company.list`) is retired as duplicative — the switcher already lists every company with `j`/`k`/Enter selection. **Resolved:** the switcher does not need Jurisdiction/Currency columns added — that detail is one click away on Settings → Company once you've switched, no need to surface it at switch-time.
- **Access** → Settings (§3.4).
- **Operations** → dropped. Its one live card duplicated Settings → Extensions' own "Test connection" action. The 2026-08-11 spec's "future occupants noted for continuity" (API token mint/revoke, FX revaluation preview/post UI, user/role permission management, audit-log viewer) are now homeless — none of them are built yet, but this spec doesn't get to silently drop the continuity note. See §6.4.

---

## 5. Interaction contract additions (`ia-spec.md` §5 style)

### 5.1 Payables (`/:company/payables`)

- **Machine:** FB.list on Bills (`tree: true`) and Vendors (flat); Aging/Control are report-iframe embeds, not FB.list surfaces (no new verbs — §10 drill-through doctrine's "no verbs on reports" rule applies unchanged)
- Bills tab verb set: unchanged from today's `payables-bills.js` contract
- Vendors tab: standard FB.list contract, `~` toggle-active, default sort surfaces `is_vendor = true` rows first

### 5.2 Accounting (`/:company/accounting`)

- **Machine:** FB.list on every tab
- Tax Codes tab: standard register verbs (`o`/`a`/`x`/`w`/`u`), with the VAT/WHT Type distinction rendered as a column, not a second tab strip

### 5.3 Fiscal (`/:company/fiscal`)

- **Machine:** FB.list, flat, on all three tabs — no tree/`Space`-fold verb anywhere on this page anymore (removes the one remaining tree-table pattern outside Bills)
- Close Checklist's manual attestation toggle uses the existing `~` universal toggle verb, consistent with `ia-spec.md` §9

---

## 6. Open questions / deferred (parking lot)

1. **Receivables is not scoped here.** When issue #110 (P3-1 AR) ships, it should mirror this spec's Payables shape exactly: a `receivables` route reserving the `g r` key, tabs Bills-equivalent · Customers (same `payables-partners.js` machinery, default-sorted on `is_customer`) · plus AR-equivalents of Aging/Control if those get built. Not committing to that shape now, just flagging the precedent. **Resolved:** tab is named **Customers** (symmetric with Payables' **Vendors**, item 2 below), not "Partners."
2. ~~**Vendors/Customers tab naming is unresolved.**~~ **Resolved (2026-08-27):** label the tabs by role — **Vendors** in Payables, **Customers** in (future) Receivables — content-specific naming, consistent with every other tab-naming decision in this spec, over labeling both "Partners" and relying on default sort alone.
3. ~~**Does the company switcher need Jurisdiction/Currency columns**~~ **Resolved (2026-08-27): No.** Name-only is sufficient — Jurisdiction/Currency are a Settings → Company lookup away once you've switched.
4. **Operations tab's future occupants need a new home before they're built:** API token mint/revoke (currently curl-only), FX revaluation preview/post UI (`fx.revaluation_preview`/`fx.revaluation_post` are API/agent-only today), user/role permission management beyond the Access grid, an audit-log viewer. None are in scope now; whoever builds the first of these needs to decide where it lives since Admin no longer exists as a catch-all. FX revaluation is the most likely to be built next (§2.5 already provisionally points its one existing route reference at Exchange Rates) — when it gets a real UI, it logically belongs on either Exchange Rates or Fiscal, not a new page of its own.
5. ~~**AP Control's date shape** wasn't established~~ **Resolved (2026-08-27): `asOf`**, same as Aging (§9).

---

## 7. VAT/GST Tolerance — command-bar only, no UI surface

**2026-09-01: superseded.** Both command-bar aliases described in this
section are retired (`global-search-spec.md` §0) and both settings now edit
through Settings → Extensions's `posting_rules.attr.list`/`.save` grid — the
"no UI surface at all" design rationale below did not hold up: a client-side
filter meant to keep these two keys out of that grid turned out to be dead
code, so they'd been rendering there, editable, the whole time regardless of
this section's intent. Left below as the historical record of the original
design decision.

`vat_tolerance` (flat) and `vat_tolerance_pct` are deliberately given **no settings-page surface at all** — not a tab, not an inline panel. Design rationale (explicitly re-litigated and settled in discussion): the warning this threshold gates is low-priority, so it doesn't warrant dedicated UI weight.

**New command-bar aliases** (`api/public/fb-command.js`, alongside the existing `:bill`/`:pay`/etc. alias table):

- `:vat-tolerance <value>` — sets `vat_tolerance` (flat)
- `:gst-tolerance <value>` — sets `vat_tolerance_pct`
- Both, called bare with no argument, **echo the current stored value** rather than requiring a write — the one deliberate concession to discoverability, so the values aren't completely opaque to someone who goes looking.

This requires new grammar/parser entries in `fb-command.js`'s alias table (`parseBill`-style, but trivial single-numeric-arg parsing) and wiring to `posting_rules.attr.save` — real command-bar work, not a page deletion.

**Required cleanup, easy to miss:** `action-catalog.js`'s existing palette entry for `posting_rules.attr.list` (line ~804) navigates to `/settings?tab=postrules` — a tab this spec deletes (§3.4). Once Posting Rules is gone, that palette row needs remapping to `/settings?tab=extensions` (§2.5) or the command-bar work here leaves a broken navigation entry sitting next to a perfectly working `:vat-tolerance` alias.

---

## 8. Naming collision note

`api/src/pages/admin.js` (the `FREEBOOKS_ADMIN_TOKEN`-gated raw-SQL console handler, `POST /api/admin/query`) is unrelated to the dissolved Admin *page* (`admin-page.js`, per the 2026-08-11 spec's own naming-collision note) and is untouched by this spec. Deleting `admin-page.js` must not touch `admin.js`.

---

## 9. Per-page/per-report `dateRelevance` flag (stub only — §0 item 1)

Declared now so pages aren't touched twice; **consumed by nothing yet**. The eventual global Period Selector (follow-up chrome spec) reads this to decide whether to render itself active or dimmed-but-clickable on the current page.

**Shape:** `dateRelevance: 'range' | 'asOf' | 'none'` on each `nav-registry.js` entry. For Statements/Books specifically, don't duplicate — `REPORT_REGISTRY`'s existing `multiperiod`/`needsStart` fields per report type already carry equivalent information; the follow-up spec should read those directly rather than adding a redundant parallel flag at the page level.

| Route | `dateRelevance` | Why |
|---|---|---|
| `inbox` | `none` | not date-scoped |
| `payables` (Bills tab) | `range` | already has its own date-from/to filter today |
| `payables` (Vendors tab) | `none` | directory has no date dimension |
| `payables` (Aging tab) | `asOf` | snapshot report |
| `payables` (Control tab) | `asOf` | confirmed (§6 item 5) |
| `statements` | *(per-report, see above — not a page-level flag)* | BS is `asOf`, P&L/CF/SCE are `range` |
| `books` | *(per-report, see above)* | mixed by report type |
| `fiscal` | `none` | this page manages periods; it doesn't make sense to filter periods by a period — always dimmed |
| `settings` | `none` | config, not date-scoped |
| `accounting` | `none` | reference lists, not date-scoped |
| `exchange-rates` | `range` | already has its own date-range + currency picker today |

---

## 10. Changelog

| Date | Change |
|------|--------|
| 2026-08-27 | Spec drafted per design-review discussion: Payables (Bills+Vendors+Aging+Control) replaces Master Data's Partners split and pulls AP reports out of Reports; Reports split into Statements + Reports; Periods renamed Filings and fully flattened (tree removed); Settings split into Settings + Accounting; Master Data dissolved (Exchange Rates promoted standalone); Admin dissolved (Companies → switcher, Access → Settings, Operations dropped); VAT/GST Tolerance moved to command-bar-only, no UI surface; per-page `dateRelevance` flag stubbed for a follow-up chrome spec. Status: PROPOSED, pending ratification. |
| 2026-08-27 | Review round 2 applied: (1) trimmed Reports renamed **Books** (gKey `b`) — stronger mnemonic, clearer pairing against Statements; (2) "Filings" page renamed **Fiscal** (gKey `f`) to fix a Filings/Filings tab-vs-page name collision, same bug class as the earlier Periods/Periods issue — the Filings *tab* keeps its name; (3) Payables reassigned gKey `p` (fresh mnemonic, freed by Fiscal moving off it); Receivables' reservation moves from `g v` to `g r` (freed by Books moving off it) — `g v` now genuinely free; (4) deep-link compatibility redirects dropped entirely — single-user install, clean cutover, no shim code (§2.3); (5) `?tab=` removed from the URL scheme app-wide (it was already silently drifting out of sync on client-side tab switches) — replaced with per-page `sessionStorage` for last-active tab, session-scoped only (§2.4, **later corrected in round 3 below — this was wrong**); (6) Vendors/Customers tab naming resolved — role-specific labels, not "Partners" in both places; (7) company switcher confirmed as-is, no Jurisdiction/Currency columns needed; (8) AP Control's `dateRelevance` confirmed `asOf`. |
| 2026-08-27 | Review round 3 applied (external review against actual source): (1) **`action-catalog.js` added as a first-class consumer** — 20 hardcoded palette-navigation routes need remapping, not previously mentioned; full table in new §2.5, including a flagged ambiguity for `partner.save`/`partner.upsert` (Vendors vs. Customers target) and a provisional call on `fx.revaluation_post`/`report.refresh_vat_return`; (2) **round 2's §2.4 was wrong and is corrected**: dropping `?tab=` entirely would have broken 15+ of those same palette deep-links (`?tab=coa&new=1` etc. are load-bearing navigation, not decorative bookmark support) — `?tab=` stays authoritative on initial load, `sessionStorage` only fills in when no `?tab=` is present; (3) `common.js`'s `topBarContext` page-chrome map (new §2.6) needs its `'master-data'`/`'reports'` keys updated too — confirmed currently inert (falls back to the same empty default either way), so flagged as hygiene, not a functional risk; (4) §3.3 corrected — the Filings tab is a **pure rename of the existing "Deadlines" tab** (confirmed at `periods.js` line 86), not an extraction from the nested Periods rows; the nested rows are a separate deletion of duplicate content, not a migration; (5) §3.4 clarified — Extensions is one tab backed by **two** existing action families (`posting_rules.attr.*`, `ai.attr.*`), no new unified action; (6) §3.5 flagged the `vat_code`/`wht_code` PK-column-name mismatch the merged Tax Codes grid must resolve; (7) §2.3 now explicitly names the two dead 2026-08-11 redirect blocks in `settings.js` (lines 5–15) that must be deleted, not just left inert, since they'd otherwise 302 straight into now-nonexistent routes; (8) §7 flagged the `posting_rules.attr.list` palette entry's dead `?tab=postrules` target as required cleanup; (9) §6 item 4 noted FX revaluation UI's likely landing spot (Exchange Rates or Fiscal) for whoever builds it next. |
