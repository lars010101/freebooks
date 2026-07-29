# freebooks — Architecture & UX Review + Roadmap

**Date:** 2026-07-20 · **Basis:** full three-agent code review at HEAD `601d0d1` · **Status:** agreed direction; P0 in execution

---

## 0. Status update — 2026-07-22

**Landed since the review:** P0-1…P0-5 ✅ (PR #1). P1-1 ✅ (action catalog). P1-2 ✅ (seed harness + 17 contract tests). P1-3 ✅ — fb-core (FB.mode/FB.keys/FB.nav/FB.util/FB.dropdown); Bills ✅, Vendors ✅, Bank ✅ (Transactions tab; Mappings deferred — per-row-input table), Settings ✅ (Periods, COA, VAT Codes, Journals — all modal-edit read-first pattern; Company/FX Rates unchanged — form-style). P1-4 ✅ (full-page bill editor shipped; bill-new.js deleted — 1490 LOC removed). P1-5 ✅ (VAT warnings surfaced). P1-6 ✅ (`?` overlay which-key). P1-7 ✅ (dropdown unification). P1-8 ✅ (read models v1 — `view.bills` + `view.bank`). P1-9 ✅ (payment matching — dual path, shared settlement core).

**New finding — the gap in the "middleware" answer is the READ side, not a missing layer.** The command side (action RPC) is now hardened and agent-testable as prescribed. But every screen hand-assembles its view model client-side: page load fans out to multiple action calls + per-row follow-ups (bills: vendor.list + bill.list + bill.lines per unfold; bank: accounts + journals + reconciliation + balances; bank-import: accounts + journals + bills). That means N+1 round-trips, duplicated assembly logic in template JS, and no server-side place to put derived data (aging buckets, running balances, match suggestions). **Proposal (P1-8 — APPROVED by magnus 2026-07-22; v1 DONE on branch `p1/read-models`):** complement the command API with page-shaped read endpoints — one request per screen, server-joined. CQRS-lite: commands stay action-RPC + idempotent + audited; queries become read models. **v1 shipped `view.bills` + `view.bank` as catalog actions on the existing dispatch** (not separate REST routes — one unified path, manifest-discoverable, viewer role). Pages migrate onto them in P1-4/P1-3; later views (`view.vendors`, `view.journal`, `view.bill`) follow as pages need them.

**Open by priority:** P1-10 `:` command palette (spec ✅ 2026-07-22; build after P1-3 so derived page verbs cover the whole app — P1-3 now done, unblocked) → P2 accounting completeness (year-end close, FX reval monetary-only, `bill_lines` subledger, server-computed draft totals, VAT convention unify) → P3 scope (AR, feeds).

---

## 0b. Status update — 2026-07-23

**Landed:** P1-10 `:` command palette ✅ (built 2026-07-22, commit `d1c2110`, merged — disposition map in `action-catalog.js`, FB.palette in `fb-core.js`, fuzzy narrowing, catalog actions executable in place; Payables exposes 9 verbs).

**FB.list consolidation** (P1-3 follow-through; branch `p3/fb-list-consolidation`, PR #20): ONE list machine (`api/public/fb-list.js`) now owns every flat register — Settings (Periods, COA, Tax Codes, Journals) ✅, Vendors ✅ (also fixes its Esc-*saves* doctrine violation), FX Rates ✅ (ECB rows read-only via `editable`/`deletable` predicates). **Add row** ✅: the ghost input-replica was rejected by magnus (2026-07-23) and replaced with a muted `+ Add entry` text row pinned at the list **bottom** (QuickBooks/Xero pattern) — reachable by click, `j` (sticky), `G`; `gg`/`G` are now framework-level. Shared leave-guard modal ✅ (Save/Discard/Stay across all lists on a page). Bills **Option A** ✅: Esc exits INSERT only (no more Esc-saves on Bills), `w` writes the dirty buffer. **Verb convention ratified:** `o`/`O` = new master, `a`/`A` = add child. Contract documented in **`docs/fb-list-ux-spec.md`** (new, ratified 2026-07-23).

**Open by priority:** Bank Mappings → FB.list (+ delete legacy ghost CSS/`activateMappingGhost`) → Bills → FB.list with `tree: true` (fold = row property; last bespoke list surface) → P2 accounting completeness (P2-1 year-end close, P2-2 FX reval monetary-only, P2-3 `bill_lines` subledger, P2-4 VAT convention unify + server-computed draft totals, P2-5 MCP server, P2-6 rebinding — priority pending magnus) → P3 scope (AR, feeds). *(Superseded by §0c — Bills migration done 2026-07-24.)*

---

## 0c. Status update — 2026-07-25

**Column filters + settings consistency ("the four decisions")** — ratified 2026-07-23 (Slack design thread; `c4b1a52`), implemented same day and framework-shipped. **None of this is open:**

- ≡ per-column header filters + `/` command box + `hint:` config + list-level actions in FB.list (`c57561c`, fb-list-ux-spec §8); filterable-by-default columns (`c8f0420`); plain-text cross-column substring default when no screen predicate (`2f91935`); tree filters evaluate on parents, children follow (`9da098c`).
- Settings adoption (`659f79b`): COA's separate filter box deleted (Code/Name use `filterType: 'text'`); GST stale joint-save hint deleted **and** dead `vat.codes.save` server action removed (`37f372f`); Journals hint → sidebar via `hint:` config; FX provider + API key → Company tab with explicit Save (auto-save-on-select abolished); Fetch Rates stays on Exchange Rates as the `f` verb + header button.

**Bills → FB.list `tree: true`** ✅ done 2026-07-24 (PRs #30–#35): fold = row property; Bills' bespoke render/draft/filter/nav machinery (~450 lines of filter code included) **deleted, not ported**; post-migration alignment/edit-mode fixes through `efa17f1`. **Bank Mappings is now the last bespoke list.**

**FB.dropdown** ✅ implemented 2026-07-21 (`6c5cdc4`, `fb-core.js`) — the "PROPOSED / not yet implemented" header in payables-ux-spec.md was stale and is corrected.

**Audit trail gap closed** (2026-07-25, PR #36): `setup.add_company` is audited under the created company (was silently dropped on the NOT NULL constraint).

**Open by priority:** Bank Mappings → FB.list (+ delete legacy ghost CSS/`activateMappingGhost`) → P2 accounting completeness (P2-1 year-end close, P2-2 FX reval monetary-only, P2-3 `bill_lines` subledger, P2-4 VAT convention unify + server-computed draft totals, P2-5 MCP server, P2-6 rebinding — priority pending magnus) → P3 scope (AR, feeds). *(Superseded by §0d — 2026-07-27.)*

---

## 0d. Status update — 2026-07-27

**VAT/GST entry-model redesign ✅ (2026-07-26, PRs #40–#43):** SAP-style — bill lines carry only a tax code, amounts always computed, tax posts as separate journal lines grouped per code; stated-VAT override = editable bill-footer cell (bill-level only; tolerance `max(0.50, 1%)`, warn-not-block; delta on the largest code's row); per-line overrides dropped; reverse-charge = computed-only DR/CR pairs. Latent bug fixed: RC bills previously posted **unbalanced journals** (AP credit included self-assessed RC VAT). Post warnings (`data.warnings`) now render in the status bar. Full contract: payables-ux-spec §VAT/GST Handling.

**Settings finalization ✅ (PRs #46–#47):** Company tab = FB.list **attribute/value grid** (`canAdd: false` fixed rows, per-row typed editors, server-authoritative `company.attr.list`/`company.attr.save`) — rows incl. VAT Tolerance flat/%, Multi-Currency (`fx_tracking`), FX Provider (per-company, `manual` first-class), FX API Key; the tolerance + provider panels are deleted; danger zone → `company.delete` (last-company + posted-books guards); COA **Default flag** column (single-holder enforced in the same write). **Relevance flags** gate the app (`vat_registered`, `fx_tracking`): tabs hidden + `h`/`l` skips, bills/journal/bill-detail tax + currency surfaces gated, CCY locked to base when `'off'`. FB.list framework gains `canAdd` + column `editor(row)` (now in fb-list-ux-spec §6). settings-ux-spec §7 items 1–9 all closed.

**Dashboard/Reports delineation ✅ (spec PR #44, impl PR #48 — `docs/reports-dashboard-spec.md`):** Dashboard = KPI cards + drill-through only (embedded report viewer removed; pt typography → rem/CSS-vars); card figures computed via `pl()`/`bs()` macros — single computation path with Reports, also fixing the old card SQL's mixed-transaction-currency sums. New `api/src/report-registry.js` = single declarative report list driving the hub dropdown (categorized optgroups), MoM/YoY enablement and start-date behavior; `?t=` drill-through selects + auto-loads. Registry is the foundation for the annual-report composite + authority export adapters (spec §5/§6 — unbuilt).

**Open by priority:** Bank Mappings → FB.list (the last bespoke list; + delete legacy ghost CSS/`activateMappingGhost`) → Receivables (AR; FB.list from day one) → P2 accounting completeness (P2-1 year-end close, P2-2 FX reval monetary-only, P2-3 `bill_lines` subledger, P2-4 VAT convention unify + server-computed draft totals, P2-5 MCP server, P2-6 rebinding — priority pending magnus) → P3 scope (feeds). FX automation core (fx-automation-spec build-order items 1, 3–5) remains **specced, awaiting scheduling**. *(Superseded by §0e — Bank Mappings done 2026-07-27.)*

---

## 0e. Status update — 2026-07-27

**Bank Mappings → FB.list ✅ (this update):** the app's LAST bespoke list migrated onto the one FB.list machine (`api/src/pages/bank.js`). Bank → Mappings is now a flat FB.list register — same declarative config as Vendors/FX/Settings (columns: pattern / match_type (select, `filterType:'list'`) / debit_account (text + `attach` account dropdown mirroring `vendorAttachAcct`) / description_override (nullable) / priority (number) / is_active (checkbox); `mapping.list`/`mapping.upsert`/`mapping.delete` server actions untouched). The legacy per-row-input table, ghost create-row pinned at top, `activateMappingGhost` / `prependBlankMappingRow` / `appendBlankMappingRow` / `saveMappingRow` / `deleteMappingRow` / `loadMappings` / `attachMappingAcctDd` machinery, the `_mapSel`/`_mapCursor`/`_mappingRows` cursor, the bespoke `FB.keys.register('bank-mappings', …)` block, and the `#mappings-body` ghost-row click listener were all **deleted**. The entire `.fb-ghost-row` CSS block in `api/public/common.css` (kept only for bank.js) was **deleted** — the framework add row is a different mechanism. **EVERY list in the app now runs on the one FB.list machine** (fb-list-ux-spec §1, §11 item 1 closed).

**Open by priority:** Receivables (AR; FB.list from day one) → P2 accounting completeness (P2-1 year-end close, P2-2 FX reval monetary-only, P2-3 `bill_lines` subledger, P2-4 VAT convention unify + server-computed draft totals, P2-5 MCP server, P2-6 rebinding — priority pending magnus) → P3 scope (feeds). FX automation core (fx-automation-spec build-order items 1, 3–5) remains **specced, awaiting scheduling**.

---

## 0f. Status update — 2026-07-28

**Keyboard-navigation program ratified** (Slack design thread): gap analysis confirmed 11/16 page modules register no `FB.keys` set, no go-to map existed, and the company switcher/modals were mouse-only. Decisions: `g`-map + palette **both** (not either/or); forms get the **bill-edit modal model** (NORMAL rest + Tab inside edits — explicitly NOT QBO always-insert); danger-zone = **type-to-confirm**; **`~` = the universal toggle verb** (Vendors precedent; vim's toggle-case key); Opening Balances surfaces under **Settings** (Xero conversion-balances pattern). Full contract: **`docs/keyboard-ux-spec.md`** (new). Phases: K1 nav → K2 modal/binding-stack → K3 `FB.form` → K4 attachments/reconcile → K5 CI coverage crawl.

**K1 landed ✅ (this update):** `api/src/nav-registry.js` = single-source route table driving sidebar + `{`/`}` + new `g`-prefix go-to map (`g r/b/p/s`) + palette `Go to …` rows (deduped vs the action catalog). One pending-`g` state in fb-core — the duplicate `gg` state machines in `common.js` and `fb-list.js` are **deleted**; fb-core's `gg` fires `FB.nav.onGG` hooks (visibility-guarded) for list first-row. **Company switcher** (`g c`) is keyboard-driven: `j`/`k`/`Enter`/`Esc`, owns all keys while open (help-overlay precedent). Bank transaction clear/unclear migrated **`c` → `~`**. Settings → Company gains the **Opening Balances** link (the app's last truly orphaned page).

**Open by priority:** K2 binding stack + modal keyboard contract → K3 `FB.form` (journal-new pilot) → K4 attachments/reconcile → K5 CI crawl → then the backlog above (Receivables → P2 → P3).

---

## 0g. Status update — 2026-07-28 (K2)

**K2 landed ✅ (this update):** `FB.keys.push/pop` — a LIFO modal scope stack in fb-core `_dispatch`; a pushed scope owns keys exclusively (page sets, switcher, g-prefix, `common.js` inert; unmatched keys swallowed but not `preventDefault`'ed so modal inputs still type). **`FB.modal`** ships as the one modal: `Esc`/backdrop = cancel (NEVER confirms), per-modal button letters shown in the buttons, **type-to-confirm** for destructive actions (exact-match arms the danger button; Enter in the input fires it; the button carries no letter key — GitHub pattern). **Retrofits:** the FB.list leave-guard (`w` = write & leave, `u` = revert & leave, `Esc` = Stay — keys mirror the write/revert doctrine) and the settings danger-zone modal (type the exact company name; server refusals surface in-modal). Both were mouse-only before. Contract: keyboard-ux-spec §7.

---

## 0h. Status update — 2026-07-28 (K3)

**K3a landed ✅ (this update): `FB.form`** (`api/public/fb-form.js`) — the one form machine, Model B (bill-edit modal model: NORMAL rest + Tab inside edits). Config = ordered zones with `rows()`/`cells()`; the framework owns the cursor (`j`/`k` rows across zones, `h`/`l` cells, sticky everywhere), mode transitions (`i`/`Enter` edit, `Esc` exit-never-writes, Enter advances fb-list-parity), dropdown key routing in INSERT (pages must NOT pass `keys:true` to FB.dropdown anymore), focus sync (mouse click moves the cursor), and hint rendering. **journal-new is the pilot:** zones = reversal panel → header → JV grid; verbs `a` add line, `x` delete line, `w` post (disabled-guard), `q` quit, `~` reversal mode (search focus + arrows/Enter results). journal-new previously had **no** FB.keys set — matrix navigation was raw DOM Tab. Contract: keyboard-ux-spec §8. Merge note: #56 originally landed on the K1 branch, not main — repaired via #57.

**Open by priority:** K3b — FB.form adoption: reports filter bar, bank-import mapping, opening-balances, new-company → K4 attachments/reconcile → K5 CI crawl.

---

## 0i. Status update — 2026-07-28 (K3b)

**K3b landed ✅ (this update):** FB.form adopted on the four remaining form pages — **reports** (`~` cycles MoM/YoY, `d` download menu with j/k/Enter/Esc mini-scope), **bank-import** (wizard zones upload→mapping→review; `a` attach, `p` paste CSV, `w` stage-dispatched process/post, `b` link bill, `Space` skip; bill-panel arrows/Enter; the bespoke document-Esc listener deleted), **opening-balances** (`w` post guard, `~` cycles BS/All/Non-zero), **new-company** (fields + periods grid; `a`/`x` period rows, `w` create). Every app page that takes data now has a NORMAL-mode keyboard layer; the original gap list is closed except attachments (K4) and reconcile-as-list (K4). Spec: keyboard-ux-spec §8 K3b.

---

## 0l. Status update — 2026-07-28 (K5)

**K5 landed ✅ (this update):** the keyboard-coverage gate — `tests/keys-coverage.mjs` (`npm run test:keys`; no CI runner exists, so the gate is the suite). Per route it asserts zero uncaught JS errors, a live `FB.keys` set, a non-empty hint surface, ≥1 active NORMAL binding (`FB.keys.audit()`), and that **every visible interactive control is keyboard-managed** (inside an `FB.coverage.roots()` element, a native text-entry field, or a ratified — sometimes self-checking — exemption). The gate replaces per-tab key verification with one framework-level proof (69/69, 0 triage). Gaps it caught and closed: dashboard had no key set at all (FB.nav over cards/report links added); bill-detail ran legacy-only keys (FB.keys set delegating to fbKeyActions); bank filters had no verb (`f` = cycle cleared-filter); new-company had no hint surface (inline `#nc-hints`); fb-core `hasActive()` misreported sets without an `active` fn; and **bill-edit was fully dead on non-VAT companies** (unguarded `#be-tot-gst` listener killed the entire page script — keys, post wiring, attachments). Mouse-only by ratified design: `#hdr-clear-all`, settings `#cr-delete-btn`, bill-edit `.be-line-x` (FB.form migration roadmap). receivables is a stub exemption until AR ships. Spec: keyboard-ux-spec §9 K5. **The K1–K5 keyboard program is complete.**

---

## 0m. Status update — 2026-07-29 (Phase A specced)

**Agent-readiness tranche (Phase A) specced** (this update; **`docs/agent-readiness-spec.md`**, status PROPOSED): A1 actor attribution (`agent` role at level 1.5, actor class derived from the DB role — never asserted; dispatch-level **default-deny whitelist** — agents read + `bill.propose` + `attachment.upload` only; `audit_log` gains `actor_type` + `request_id`), A2 append-only business-event stream (`events` table + monotonic `event_seq`, emission at state-transition handlers, `event.list` polling = the agent input channel; idempotent replay provably never double-emits), A3 bill proposal flow (`proposed`/`rejected` statuses, `bill.propose/approve/reject`, review queue **integrated into the Bills FB.list** — `y` approve / `x` reject row verbs + Payables nav badge, no new page). Context: agent-driven operating model (agents prepare, humans approve; API-only agent access; WORM backups) agreed in the 2026-07-29 design thread. K1–K5 keyboard program complete per §0l.

**Open by priority:** Receivables (AR; FB.list from day one) → **Phase A agent-readiness (A1→A2→A3, on ratification)** → P2 accounting completeness (P2-1 year-end close, P2-2 FX reval monetary-only, P2-3 `bill_lines` subledger, P2-4 VAT convention unify + server-computed draft totals, P2-5 MCP server — consumes A1/A2 —, P2-6 rebinding — priority pending magnus) → P3 scope (feeds — built on `bill.propose` + `event.list`). FX automation core remains specced, awaiting scheduling. *(Supersedes the backlog line in §0f.)*

---

## 0k. Status update — 2026-07-28 (K4)

**K4 landed ✅ (this update):** attachment unification + reconcile verification. (A) **`A` = attach everywhere** — legacy `fbKeyActions` pages route shift-a to a new `attach` verb (common.js; bill-detail migrated off `a`); FB.form pages declare `A` (journal-new). (B) **journal-new pending queue** is an FB.form zone (`j`/`k` rows, `x` removes staged file; shared `.fb-attach-row` markup; new shared `api/public/fb-attachments.js` helper module). (C) **reconcile**: the audit's mouse-only-checkboxes item predates the FB.list migration — /bank/reconcile 301-redirects to /bank, whose Transactions tab already has j/k + `~` clear/unclear on the checkbox's own persistence path; closed with end-to-end verification (toggle + persistence), no new code. (D) **K3c regression fixed**: the default FB.form `active()` guard checked zone 0 only — journal-new (empty reversal zone at rest) and bank-import (closed bill panel at rest) were key-dead; guard now scans all zones. bill-edit queue nav deferred (K4b); bill-detail keeps its bespoke combined nav (key unified only). Spec: keyboard-ux-spec §9 K4.

---

## 0j. Status update — 2026-07-28 (K3c)

**K3c landed ✅ (this update):** four owner-reported bugs fixed in one PR. (A) **Soft-nav key lifecycle** — `FB.keys.resetPage()` in `fb-core.js` (teardown callbacks + remove page sets above the core baseline + clear scope stack/g-prefix/gg-hooks); `common.js fbNavigate` calls it after the `#page-main` swap, before script re-execution; `FB.form` registers a teardown for its document-level `focusin`/`focusout` listeners and gets a default `active()` guard (first zone row still in DOM). Fixes key-deadness on bank, opening-balances, and every soft-nav destination after reports. (B) **FB.form cursor highlight** — `.fb-form-cursor` now uses `var(--accent)` background (mirroring `nav-row-focus`) instead of outline-only; theme-aware via CSS vars. (C) **Native select picker on Enter** — `i`/`Enter` on a `<select>` cell calls `el.showPicker()` when available (native popup owns keys, form stays NORMAL); INSERT `j`/`k`-stepping is the fallback when `showPicker` is unavailable or throws. Spec: keyboard-ux-spec §8 K3c.

---

## 0m. Status update — 2026-07-29 (deadline reprioritization)

**Reprioritized for Swedish statutory filings (magnus 2026-07-29):** FY end 2025-12-31; **Bolagsverket årsredovisning due 2026-07-31**, **INK2 (Skatteverket) due 2026-08-02**. Books to be completed from bank statement + skattekonto transactions only. Receivables and payables extras explicitly dropped for this cycle; AR stub remains.

**Deadline track (supersedes the §0e order):**
1. Statement intake — bank-import CSV presets for magnus's bank + Skatteverket skattekonto export (skattekonto = bank-type account, BAS 1630).
2. Agent booking — immediate: agent drives the existing action API, journal batches approved by magnus in-thread (no code). Build: Phase A agent-readiness rescoped (agent role + action whitelist, events + `event.list`, journal/bank-transaction proposals + y/x queue; bill proposals dropped with payables) + **P2-5 MCP server pulled forward** alongside it.
3. **P2-1 year-end close to retained earnings** — pulled forward; required for a correct balansräkning.
4. Annual-report composite (reports-dashboard-spec §5) — resultaträkning + balansräkning + noter, registry-driven; K2-vs-K3 structure pending magnus.
5. Submission adapters (spec §6) — SRU files for INK2 (BAS→räkenskapsschema mapping + INK2S/INK2R generation) and the Bolagsverket årsredovisning package.

**Parked until after submission:** Receivables (dropped), payables extras (bill-edit FB.form migration, payment-matching deferrals), P2-2 FX reval (unless FX balances surface in the books), P2-3 `bill_lines` subledger, P2-4 VAT unify, P2-6 rebinding, P3 feeds, FX automation.

---

## 1. Verdict

1. **Payables-as-standard is the right call.** The vim-modal tree-table with direct post and per-line accounts is a genuinely differentiated, coherent design. The rest of the app should be refactored to match it — but only after the pattern is extracted into shared code (see §4, P1-8).
2. **The "middleware API" already exists.** `POST /api` action-RPC (~70 actions) with business logic server-side *is* the middleware layer. The gap is not a missing layer — it is that the existing layer is **uncontracted** (no schema/catalog), **unsafe to retry** (no idempotency, no unique constraints), **inconsistent** (two error channels), and **unauthenticated** (self-asserted `userEmail`, open admin SQL endpoint).
3. **UX dissatisfaction is structural, not aesthetic.** Four different keyboard/navigation implementations across tabs, two parallel mode systems bridged by `stopImmediatePropagation`, dead discoverability features (`?` button, `:` palette), and stale hints. Fix by extracting one shared core, not by polishing each tab.

---

## 2. Current state

### 2.1 Architecture

- Single Node/Express process; DuckDB via `@duckdb/node-api`; raw SQL inline in every handler; idempotent `db/schema.sql` re-application as "migrations" (no version tracking).
- **RPC-over-single-endpoint:** `POST /api` `{action, companyId, userEmail, ...}` → `ACTION_ROLES` permission map (`index.js`) → module switch. ~70 actions across bills, journal, bank, FX, VAT, COA, reports, settings, permissions, setup.
- REST-ish extras: `GET /api/:company/report?type=pl|bs|cf|tb|gl&format=csv`, `GET /health`, `POST /api/upload`, `GET /api/attachments/:id`, and **`POST /api/admin/query` — arbitrary SQL, unauthenticated** (P0-5).
- Frontend: server-rendered template strings in `api/src/pages/*.js` (no framework, no build). `payables-bills.js` emits ~2,537 LOC of client JS. SPA-ish `fbNavigate` swaps `#page-main` and re-executes inline scripts.
- **Zero tests.** No test script, no test files; CI only builds/pushes the Docker image.

### 2.2 Accounting / data logic

**Strengths (keep):**
- Void-not-delete: posted bills void with automatic journal reversal; paid/partial bills refuse void. Journal entries never deleted — reversal entries only, double-reverse guarded.
- Period lock enforced server-side (`validation.js`, `bills.js`, `journal.reverse`, import).
- Draft→post is UPDATE-in-place: preserves `bill_id`, `created_at`, attachments.
- Tax-exclusive bill entry; VAT always computed from the line's VAT code (no per-line VAT amounts); bill-level stated-VAT override (editable footer cell) with tolerance `max(flat, pct×expected)` — warn, not block; tax posted as separate journal lines grouped per VAT code, rounding delta on largest line; reverse-charge computed-only DR/CR pairs (redesign ratified 2026-07-26).
- Exact-date-only FX resolution; settlement FX gain/loss via booking-rate method; `integrity()` macro as detective control.

**Gaps (evidence):**

| # | Finding | Evidence | Severity |
|---|---------|----------|----------|
| 1 | `journal.entry.update` rewrites posted lines — no period-lock check, no audit | `journal.js:32-66` | **High** — violates append-only ledger |
| 2 | `audit_log` wired in exactly one place | `journal.js:443` (import only) | **High** — no accountability |
| 3 | No PK/unique on `bills`/`journal_entries`; no FKs anywhere. Retried `bill.create` duplicates the bill + journal lines | `schema.sql:41,129`, `bills.js:202` | **High** — blocks agent automation |
| 4 | No year-end close to retained earnings; BS injects "unallocated net income" live | `reports/render.js:118-167` | Medium |
| 5 | FX revaluation includes **Equity** accounts — IAS 21 revalues monetary items only | `fx.js:196-265` | Medium |
| 6 | Two VAT conventions coexist: bills tax-exclusive vs `journal.post` tax-inclusive gross split | `bills.js` vs `vat.js:computeVatSplit` | Medium |
| 7 | No `bill_lines` subledger — posted bill lines exist only as journal entries; drafts as JSON | schema | Medium — no subledger-vs-GL control |
| 8 | Auth effectively optional: permission check skipped when `userEmail` omitted; no tokens/sessions | `index.js:132` | **High** for any non-local use |
| 9 | No AR/invoicing (stub page), no bank feeds (CSV only) | README, `receivables.js` | Scope |

### 2.3 UX state

- **Reference standard:** Payables → Bills (vim-modal tree-table, bill-level INSERT, direct `p` post, per-line AP/expense accounts, supplier-stated VAT override).
- **Divergent implementations:** Vendors uses cell-nav with different verbs (`d`/`~` vs `x`); `bill-new.js` is a **third, conflicting bill-entry UI** still linked from "+ Bill" and violates the spec (manual FX-rate input); settings/journal/bank are old form-style with `pt` typography violations; receivables is a 34-line stub. (Dashboard removed from this list 2026-07-27: viewer stripped, cards on macros, rem/CSS-vars — reports-dashboard-spec §7.)
- **Fragile duality:** `cursor._mode` (page) vs `_fbVimMode` (common.js) coexist via capture-phase `stopImmediatePropagation`.
- **Discoverability broken:** "?" button has no handler; `:` palette dispatches to undefined `fbCmdDispatch`; footer hints stale ("o new bill/line"); no help overlay.
- ~~**Warnings swallowed**~~ **Fixed 2026-07-26** (VAT redesign): post paths render `data.warnings` in the status bar ("Posted with warning: …", warn level). The same redesign fixed a latent RC bug: reverse-charge bills previously posted **unbalanced journals** (AP credit included self-assessed RC VAT; `bills.vat_amount` double-counted RC) — AP is now net + standard VAT only.
- **Duplication:** `esc`/`fmtDate`/`statusBadge`/account-autocomplete/keyboard-nav reimplemented 3–4× each across pages.
- **Dead code:** `bill.draft.preview` endpoint + `.preview-row` CSS, pagination in `payables-bills.js`, `.bak` files, `fbOpenCmdPalette` no-op.

---

## 3. The API / middleware question

**Recommendation: harden the existing layer; do not build a new one.**

The client already sends raw inputs and the server computes everything (FX, VAT + tolerance, journal construction, period lock). That is exactly the right trust boundary for agent-driven testing. What is missing, in priority order:

1. **Idempotency** — agents retry; today a retry double-posts.
2. **One error envelope** — today: always-HTTP-500 *and* HTTP-200-with-`{created:false, errors}`; two incompatible channels make assertions unreliable.
3. **Machine-readable action catalog** — JSON Schema per action at `GET /api/actions`; agents get self-discovery, we get contract tests nearly free.
4. **Auth** — token-based; `userEmail` self-assertion is not auth. Admin SQL endpoint must be gated or removed.
5. **Optional, high value:** an **MCP server** over the catalog — agents (including Hermes profiles) then drive freebooks as native tools.

**Explicitly rejected:** rewriting to REST for its own sake (action-RPC + catalog gives the same toolability without churn); a separate middleware service (adds latency/ops, solves nothing); replacing DuckDB (fine at this scale; the API insulates it).

**Testing rule going forward:** no feature ships UI-first. API action + schema + contract test first; UI as a thin client. UI automation shrinks to ~5 smoke checks (page loads, mode toggles, row renders) — visuals only.

---

## 4. Roadmap

### P0 — API trust (makes the core agent-testable)

| # | Item | Acceptance criteria |
|---|------|---------------------|
| P0-1 | **Idempotency keys + unique constraints.** `Idempotency-Key` header (or `idempotencyKey` body field) on posting actions (`bill.create`, `bill.draft.post`, `bill.void`, `journal.post`, `journal.reverse`, `journal.import`, `bank.process`, `fx.revaluation_post`). Stored responses replayed verbatim with `Idempotent-Replay: true`. UNIQUE constraints on `bills.bill_id`, `journal_entries.entry_id` (+ natural keys where clean). | Retried `bill.create` with same key returns the same `bill_id`; exactly one bill and one balanced journal batch in DB. Duplicate key during in-flight request does not double-execute. |
| P0-2 | **Single error envelope.** All failures: `{ok:false, error:{code, message, details?}}` with mapped HTTP codes (400 INVALID_INPUT, 403 FORBIDDEN, 404 NOT_FOUND, 409 CONFLICT/PERIOD_LOCKED, 500 otherwise). Remove the 200-with-`{created:false,errors}` channel in `bills.js`. Update ALL frontend fetch call sites. Preserve VAT tolerance warnings as `data.warnings` on success. | `curl` invalid bill → HTTP 400 + envelope; nonexistent entity → 404; locked period → 409. Frontend renders envelope errors in status bar; no `alert()` regressions. Template-string syntax check passes for every touched page. |
| P0-3 | **`journal.entry.update` lockdown.** Period-lock check; refuse entries belonging to a bill batch (`bill_id` set — use `bill.void`); refuse reversed/reversing entries; write audit row. | Locked period → 409; bill-batch entry → 409 with guidance; audit row present. |
| P0-4 | **Audit wiring.** `auditLog()` on every mutating action: bill create/post/void, journal post/reverse/update/import, settings save, COA save/update/delete, VAT codes, permissions, company save, FX revaluation post. | Each action leaves an `audit_log` row with user, action, entity, details JSON. |
| P0-5 | **Admin endpoint auth.** `/api/admin/query` requires `Authorization: Bearer $FREEBOOKS_ADMIN_TOKEN`; if the env var is unset the endpoint returns 403 (disabled). README documented. | No token → 403; wrong token → 403; correct token → works. |

### P1 — Contract & consistency

- **P1-1 Action catalog:** ~~zod schemas per action~~ ✅ **DONE 2026-07-22** (PR #2 foundation + branch `p1/action-catalog` HEAD): 70-action catalog in `api/src/action-catalog.js` (role/mutating/idempotent/audit/description/params), live manifest at `GET /api/actions`, dispatch-level validation — required params AND declared types enforced (400 naming the field). Plain param tables instead of zod (zero deps, sufficient at this scale; revisit if nested payload schemas become necessary).
- **P1-2 Seed harness + contract tests:** scripted test-company setup (jurisdiction COA, periods, vendors, bills); `node:test` + supertest suite over the catalog; CI gate (extend workflow beyond docker build).
- **P1-3 Shared UI core:** one mode manager, one key dispatcher, one nav abstraction, one utils module (`esc`, `fmtDate`, `statusBadge`, autocomplete). Migrate Bills onto it; then Vendors, Journal, Bank, Settings follow the payables pattern. Eliminate the `_fbVimMode`/`cursor._mode` duality. **Status 2026-07-22:** fb-core exists (FB.mode/FB.keys/FB.nav/FB.util/FB.dropdown); Bills ✅, Vendors ✅, Bank ✅ (Transactions tab: j/k cursor via FB.nav, `c` clear/unclear, Esc semantics, hints follow tab switch; Mappings deferred — per-row-input table, not a vim list), Settings ✅ (Periods, COA, VAT Codes, Journals — all read-first modal-edit pattern with dirty-buffer, dirty-dot tab indicators, FB.nav cursor, FB.keys bindings, sidebar hints; Company/FX Rates unchanged — form-style, not vim lists). Journal dashboard view is a report (not a vim list); journal-new is a data-entry form deferred to P1-4 editor rebuild territory. **Update 2026-07-23:** flat registers unified under **FB.list** (one machine; screens declare config only) — Settings 4 lists + Vendors + FX Rates migrated; bottom add-row create slot; shared leave-guard. Remaining: Bank Mappings, Bills (`tree: true`). See `docs/fb-list-ux-spec.md`.
- **P1-4 Replace `bill-new.js` with a shared full-page bill editor** (agreed 2026-07-20): the foldable tree-table stays the default creation path for common bills; the new page is the **escape hatch for complex bills** (many lines, attachments, per-line centers). Same INSERT-mode semantics (Tab traversal, Esc saves-and-returns, same bindings), same endpoints, one shared editor component for create-complex and edit. `bill-detail.js` remains the read/management surface for posted documents. Gets its own spec section before implementation.
- **P1-5 Surface VAT tolerance warnings** in the status bar (no new visual chrome — per magnus's clutter rule).
- **P1-9 Payment matching UX** ✅ **DONE 2026-07-22** (branch `p1/payment-matching`, 5 commits; suite 28/28). Dual path (magnus: "go for B"): manual pay-on-bill + bank-import matching. Shared settlement core (`api/src/settlement.js`) — both paths settle identically (FX booking-rate split included). `bill.payment.record`/`bill.payments`/`bill.payment.void` (cataloged, idempotent, audited); `bill_payments` extended (`amount_foreign`, `reference`, `voided_at/by`). Bills UI: `p` on posted/partial → inline payment row; payment history on unfold; `x` on payment row voids. Import: silent amount-only auto-match **dead** — now confirm-required `bill_suggest` (amber, pre-skipped); vendor_ref whole-token promotes to high; rows matching recorded manual payments tag `recorded_payment` and **clear** on approve (no double-post). Deferred: multi-bill settlement, bank-tab manual match, tolerance tiers.
- **P1-6 Discoverability:** ✅ **DONE 2026-07-22** (branch `p1/discoverability`). `?` opens a which-key-style overlay of the active binding set — EXHAUSTIVE (every hinted binding, NORMAL | INSERT columns) where the sidebar stays the curated hintBar subset; both surfaces + dispatch generated from the same FB.keys table via shared `_groupHints` — cannot drift. NORMAL-mode-only trigger, never while typing; swallows keys while open; Esc/`?`/backdrop close; topbar `?` button wired as mouse parity. `:` palette **removed** (dispatched to undefined `fbCmdDispatch`; `fbOpenCmdPalette` a no-op stub — doubly dead code, deleted per rule 6; proper replacement specced as P1-10). Cache-buster bumped. Suite 28/28.
- **P1-10 Command palette:** ✅ **DONE 2026-07-23** (spec 2026-07-22, magnus's design; built same day, commit `d1c2110`). The existing topbar input hosts two modes: `/` = search (unchanged), `:` = command mode with a hits dropdown below the input — NO separate overlay/bar (magnus decision 1). Mouse entry is always search; commands are keyboard-only (decision 2). Sources: page verbs derived from the active FB.keys binding table (executor = the binding's own `run`) + ALL catalog API actions via an execute/navigate-to-form/excluded disposition map in `action-catalog.js` (decision 3 — new actions default to navigate, palette grows with the API). Rows show key equivalents — palette doubles as a teacher. Deferred: arguments, aliases, chaining, `/`-mode hits dropdown. Pairs with P2-6. Spec: payables-ux-spec.md §P1-10.

### P2 — Accounting completeness

- **P2-1** Year-end close routine to retained earnings (replaces live "unallocated net income" injection).
- **P2-2** FX revaluation: monetary items only (drop Equity).
- **P2-3** `bill_lines` subledger table + AP-subledger-vs-GL control report.
- **P2-4** Unify VAT/amount conventions (tax-exclusive everywhere; convert `journal.post` path). Also: `bill.draft.save` currently trusts a client-computed `bill.amount` — the server should compute draft totals from lines like `createBill` does at post (found via contract tests).
- **P2-5** MCP server over the action catalog.
- **P2-6 (candidate)** User-editable keybindings in Settings (raised by magnus 2026-07-22). Recommendation: build only AFTER all tabs migrate onto FB.keys — bindings are declarative data, so a remap layer (per-user overrides, conflict detection, reset-to-default) then covers the whole app in one shot. Industry reference: accounting software generally doesn't offer rebinding; power tools (Linear, Superhuman) do — fits the keyboard-first philosophy. Priority pending magnus.

### P3 — Scope

- **P3-1** AR/invoicing module built on the payables pattern (customers, invoices, AR aging, receipts).
- **P3-2** Bank feeds (beyond CSV import).
- **P3-3** FX rate automation (agreed with magnus 2026-07-23, spec'd NOT built): `fx_tracking` company flag, provider `fetchRange`, period-create backfill hook, FX status column on Periods (coverage vs provider publication days — never naive weekdays), 6h gap scanner, and a minimal notifications subsystem (table + actions + 🔔 badge/dropdown). Spec: `docs/fx-automation-spec.md`.

---

## 5. Standing rules (from this review)

1. Every feature: API action + schema + contract test **first**, UI second.
2. The posted ledger is append-only; corrections via reversing entries, never mutation.
3. Every mutating action is idempotent (key accepted) and audited.
4. Backend warnings must have a UI channel; warnings never silently dropped.
5. Spec docs updated in the same commit as behavior changes (payables-ux-spec precedent).
6. Dead code deleted, not commented — including endpoints, CSS, and `.bak` files.
