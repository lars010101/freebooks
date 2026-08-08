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

## 0n. Status update — 2026-07-29 (deadline track, day 1)

**FY2025 books complete + filings built (this update).** Mirror company `mdu_ab` on the dev instance: opening balances from the filed 2024-12-31 BS, 25 entries (9 bank fees, 12 skattekonto interest, SEB-closure reclass to **1680 Fordringar hos kreditinstitut** — the bank kept the payout, it's a receivable), AGM disposition via 2098, year-end close. Verified: P&L −500.00, BS 72,544.09, 2024 comparatives byte-equal to the filed BS. Journal export round-tripped through the existing `journal.import` (25/25) — no import build needed; imported on his server same day.

**SRU/INK2 export shipped:** `GET /api/:company/sru/ink2?year=&loss_cf=` (+`&check=1` dry-run) and `/sru/info` — official 2025P4 field spec (SKV 269 successor page + field XLSes); 1680+1630→7261 per the field list. **Golden test** (`tests/sru-golden-2024.mjs`) reproduces his filed 2024 `blanketter.sru` byte-for-byte. The golden test caught a **P0-1 defect: idempotency keys weren't company-scoped** (cross-company replay + PK-violating persist) — fixed by namespacing stored keys `company|key` (`cd095be`).

**Jurisdiction-pack architecture ratified + landed** (`docs/jurisdiction-pack.md`): country packs as data under `db/jurisdictions/<CC>/` (manifest + filing/report descriptors + per-year tax attributes as JSON on periods), directory-scanned, pack linter as CI gate (`tests/jurisdiction-packs.mjs`). First consumer: the **K2 årsredovisning composite** (`report?type=ar`, registry-driven, print-ready HTML + JSON + CSV; SE K2 + SG SFRS descriptors) — all mdu_ab acceptance values exact, balance assertion clean both years. SE template COA completed with 1680/2098/8314 (BAS standards the template lacked).

**Also fixed en route:** `coa.upsert` ignored `effective_from`/`account_type` on update; SE template 8999 typed Expense (closing entry polluted `pl()`); COA subtype dropdown constant disjoint from template vocabulary; COA grid Start-column header/wrap. **Open next:** SRU engine refactor onto `filings/` descriptors + `emitters/`, period tax-attrs columns (7763/8041/8045 from data, per the ratified model), SG filing seam, Phase A (A1/A2/A3j) + MCP.

---

## 0o. Status update — 2026-07-30 (årsredovisning finalization + SIE)

**K2 årsredovisning mirrors the filed Bolagsverket format** (verified against his filed 2024 PDF): förvaltningsberättelse (verksamhet, händelser, flerårsöversikt i tkr with 2099-balance result column, förändring av eget kapital, resultatdisposition) → RR → BR → Not 1 → signatures. Equity table is a movement table per his spec: ingång (balances at start−1) / Utdelning (permanent, from 2898 turnover, 0 = decided-none) / Balanseras i ny räkning (prior result moves between columns; AGM rebooking clears 2099) / Årets resultat (2099 at year end) / utgång — every column sums vertically. Disposition has permanent proposed-Utdelning line (`proposed_dividend` fact, default 0; reduces Balanseras, Totalt fixed). Whole report in hela kronor. RR-vs-BS comparative warning when a prior year's result was inherited via opening balances.

**Filing route decided: Gredor (free, SIE-driven)** — Bolagsverket's form e-service is gone; 25 approved suppliers, cheapest paid = DigitalK2 399 kr. **SIE 4 export shipped** (`report?type=sie`, PC8/CP437, IB/UB/RES/VER, vouchers verified balanced, balances tie). Supplier onboarding for direct system-to-system filing (org cert + firewall + iXBRL) parked.

---

## 0p. Status update — 2026-07-30 (FY2025 filings closed; SE annual-report scope removed)

**FY2025 statutory chain closed.** Årsredovisning filed + signed via **Gredor** from the freebooks SIE 4 file (Gredor initially rejected it — their parser derives Årets resultat only from 899x `#RES` lines; fixed by emitting `#RES` for Closing-type 8999). INK2 delivered: `blanketter.sru` regenerates byte-identical from the books, `check=1` zero warnings, chain ties to the filed 2024 (7763 = 86,053 → 7770 = 86,593; tax result −540 = book −500 − tax-free interest 40). Magnus files in Skatteverket's e-tjänst (due 2026-08-02, Sunday → effective 2026-08-03). Reports round shipped (`4c29ea9`): Gredor 8999 fix, one-menu select overlay (mouse click no longer stacks native popup + FB overlay), download-menu arrow keys, cursor-strength highlight.

**Scope decision (magnus 2026-07-30): SE årsredovisning production + submission removed from freebooks scope.** Gredor (open source, free, SIE-driven) owns it. Consequences:
- §0m item 5's "Bolagsverket årsredovisning package" — **cancelled** (SRU/INK2 half delivered and stays; Gredor does not do tax returns, so Skatteverket SRU remains freebooks scope).
- Direct supplier system-to-system route (org cert + firewall + iXBRL) — **cancelled**, not merely parked.
- `report?type=ar` (K2 composite) — **frozen**: retained as a read-only K2 statement viewer (it derived/verified the FY2025 figures); no further development (no iXBRL, no note expansion, no K3 variant).
- jurisdiction-pack §4 annual-report descriptors + §7 migration items 4–5 — **descoped** (SE covered by Gredor; no live SG need).
- **SIE 4 export is now the SE annual-report integration contract** — it must be maintained: Gredor consumes it and requires the 8999 `#RES` line. Breaking it breaks the filing route.

**Backlog resumes (per §0m, deadline track done):** Phase A agent-readiness (A1 agent role + whitelist, A2 events + `event.list`, A3j journal/bank-transaction proposals + y/x queue; spec `agent-readiness-spec.md`) + P2-5 MCP server → SRU engine refactor onto `filings/` descriptors + `emitters/` + `periods.tax_attrs` (SRU-only now) → P2 accounting completeness (P2-2 FX reval, P2-3 `bill_lines` subledger, P2-4 VAT unify, P2-6 rebinding) → P3 feeds. Receivables stays dropped from this cycle.

## 0q. Status update — 2026-07-31 (agent-first UI doctrine ratified)

**freebooks is agent-first.** Agents prepare, humans approve (agent-readiness-spec, ratified 2026-07-30) — the API/MCP surface is the product; the web UI is a *viewer plus a small human correction surface*. Magnus ratified the simplifying consequences (Slack, 2026-07-31):

1. **Mouse parity dropped.** Existing mouse support stays; parity is no longer a requirement, review criterion, or test gate. New work ships keyboard + API only.
2. **Verb surface frozen.** No new keyboard verbs without explicit magnus ratification. `test:keys` gates ONE representative screen — **journal-new** (richest FB.form surface, primary human write path); all other routes get a load + zero-JS-errors smoke. Per-screen exemption tables retired (git history keeps them).
3. **New scope ships API-first.** UI for new features (Phase A, SRU refactor, P2, P3) is read-only rendering of API results; write-UI only on explicit request. (Extends standing rule 1.)
4. **Dead routes deleted** (standing rule 6): the `/bank/reconcile` and `/bank/import` 301 stubs are removed; internal links point at `/bank?tab=import`.

**Backlog consequences:** P2-6 rebinding **dropped** (contradicts the frozen verb surface). The K-series keyboard program is complete and frozen at current capability — no further K items. Priorities otherwise unchanged: Phase A + P2-5 MCP → SRU engine refactor (SRU-only) → P2 (P2-2 FX reval, P2-3 `bill_lines` subledger, P2-4 VAT unify) → P3 feeds. Receivables stays dropped.

**Explicitly unchanged:** double-entry invariants; the VAT/GST code model with stated-VAT override + tolerances; the SIE 4 export contract (8999 `#RES`); report rendering rules (permanent zero rows, cross-sums, hela kronor); `FB.status.show()` as the only status path; the vim-modal keyboard framework as the human correction path — frozen, not removed.

---

## 0r. Status update — 2026-07-31 (Phase A hardening, PR #73)

Post-merge review of Phase A (medium/high-reasoning pass over PRs #71/#72) found the core sound — guard ordering, fail-closed whitelist, shared posting core, R4/R5 contract-proven — and three seam defects, now fixed on main (`6bd9638`; contract 53/53, mcp-smoke 28/28):

1. **`attachment.upload` is a real catalog action** (role agent, idempotent, base64, 32MB decoded cap) sharing one `storeAttachment` core with the multipart route; the route gained the same role gate + an audit row (uploads were the only unaudited mutation). MCP `attachment_upload` travels via the action with a caller-suppliable Idempotency-Key; `express.json` limit 50mb.
2. **Proposal transitions are atomic** — approve/reject/upsert are claim-first `UPDATE...RETURNING` guarded on `status='proposed'` (a concurrent second transition loses with INVALID_STATUS; no double-post); approve posts inside a compensating-rollback wrapper; the queue UI mints one Idempotency-Key per modal open + an in-flight guard.
3. **Attribution fallback consistency** — reviewer/created_by fall back to `'anonymous'` under install-level trust, matching the propose doctrine.

**Known residuals (backlog, none blocking):** (a) event payload truncation at 4000 chars can emit invalid JSON — truncate to a valid envelope or mark truncated; (b) event emission failure is stderr-only — a lost `attachment.uploaded` means missed agent work with no detection (add reconciliation when P3 makes the stream load-bearing); (c) proposal upsert rewrites `created_at` (edited rows jump the queue order — add `updated_at` if it bothers anyone); (d) the journal register's 500-line `journal.list` window can split a batch's client-side grouping; (e) dispatch idempotency stays check-then-act for *concurrent* same-key calls on other actions (sequential duplicates are safe; Phase A proposal transitions are closed by the atomic claim regardless).

---

## 0s. Status update — 2026-08-01 (A4 proposal underlag ratified)

**A4 — proposal underlag** ratified in the Slack design thread 2026-08-01 (magnus): spec §4.7 + invariant R7 added to `agent-readiness-spec.md`. The binding decision recorded: source documents bind to agent proposals via the **client-minted `proposalId`** (upload-first → `attachment.upload` with `entityType='journal_proposal'`, then `journal.propose` with the same id) rather than an explicit `attachment_ids` param on `journal.propose` — rationale: upload-first matches the real agent pipeline (document exists before the proposal), no API/schema surface change, one binding convention documented client-side. The **warn-not-block** decision recorded: a missing underlag emits `warnings:['no_underlag']` but never rejects the proposal — BFL 5 kap permits egen verifikation (corrections, accruals), so blocking would be wrong; the review surface shows a visible "no underlag" marker and lets the human decide. On approve, attachments re-point to `entity_type='journal'`/`batchId` inside the posting transaction (blob paths unmoved); on reject/expire they stay bound to the dead proposalId and a GC purges them after a 30-day grace (hard invariant: never touch `'journal'`-bound rows). Disk controls tightened to 15 MB + pdf/jpg/png whitelist + sha256 dedupe per company.

**Layer-2 sanity test of Phase A passed on main** (fixture loop): agent propose → human approve → anonymous poster; `attachment.uploaded` event fires; default-deny 403s hold on every non-whitelisted mutating action. **Next:** A4 build as its own PR per standing rule 5, then the SRU engine refactor onto `filings/` descriptors + `emitters/` + `periods.tax_attrs` (SRU-only).

**A4 shipped (this update)** on `phase-a4-underlag` (`f3c8a91`) — code + tests as one PR per standing rule 5; spec §4.7 + R7 pre-landed on main (`6b5d81d`). Gate results on the branch: contract suite 62/60/2 (the 2 failures pre-existing on main and wall-clock fragile — see residual (f)), `tests/mcp-smoke.mjs` 28/28, `npm run test:keys` 26/26 (0 triage), Playwright `pw-phase-a4.mjs` 12/12 (untracked per convention). As-built additions over the ratified §4.7: an operator/test-triggerable GC endpoint `POST /api/admin/gc-attachments` (bearer-token gated exactly like `/api/admin/query`, 403 without `FREEBOOKS_ADMIN_TOKEN`), supplementing the boot-time + 24h `setInterval` GC; idempotent schema evolution for sha256 (`ALTER TABLE attachments ADD COLUMN IF NOT EXISTS sha256` + `idx_attachments_company_sha256`) — the §4.7 binding convention itself stays schema-free; the 15 MB + pdf/jpg/png limits scoped to `entity_type='journal_proposal'` uploads only (other entity types keep the 32 MB status quo); dedupe global across entity types (shared blob unlinked only when no metadata row references the path). **Next:** the SRU engine refactor onto `filings/` descriptors + `emitters/` + `periods.tax_attrs` (SRU-only).

**Residuals (backlog, none blocking):** (f) contract tests 12 ("draft flow: save → re-save keeps bill_id → post → void reverses journals") and 26 ("bill.payment.void") are wall-clock fragile — hardcoded dates vs seeded periods (fail as of 2026-08-01 — "Date 2026-08-01 does not fall within any defined period"; make the fixtures derive dates from the seeded periods).

---

## 0t. Status update — 2026-08-01 (SRU MEDIELEV contact fix — Skatteverket rejection)

**Hotfix: SRU files were REJECTED by Skatteverket at submission** — `#POSTNR` and `#POSTORT` in INFO.SRU's `#MEDIELEV` block are mandatory and were emitted blank (`#ADRESS`/`#POSTNR`/`#POSTORT` hardcoded empty since the SRU path shipped). Fix on `fix/sru-medielev-contact`: the pack's `contactAttributes` (already declared in `jurisdiction.json`, previously unconsumed) now drive the Company settings registry — one generic row per declared attribute (`company.attr.list`), stored as `contact_<key>` settings keys, written via `company.attr.save` with pack-driven validation (`format` regex; SE postnr `^\\d{3}\\s?\\d{2}$` — 5 digits, space optional — and `required: true` flags added to the SE pack). `buildInfoText` populates `#ADRESS`/`#POSTNR`/`#POSTORT` from stored attrs; `#KONTAKT`/`#EMAIL`/`#TELEFON` fall back to stored attrs with query params still winning. **Generation is gated:** `/sru/info` and `/sru/ink2` return 400 naming Settings → Company when required attrs are blank/invalid (the failure mode is now loud at generation, not at Skatteverket); `?check=1` appends the problems to `warnings` instead of blocking. New `api/src/jurisdiction-packs.js` cached loader (also consumed by the SIE gating workstream). **Forward-port: landed** — PR #75 merged first with the blank-MEDIELEV `emitters/sruLines.js`; the PR #76 merge carries this fix onto the new architecture (`emitters/sruLines.js` `emitInfo` takes the stored-attr map; `validateSruContact`/`loadContact` live in `filings.js`; `sru.js` deleted with the refactor). Verification: `api/test/sru-contact.test.js` 6/6 (pack-driven rows SE vs SG, zip format validation, undeclared-key rejection, 400 gate pre-compute, populated MEDIELEV + param override, check=1 warns-not-blocks) + full suite 68/68.

---

## 0u. Status update — 2026-08-01 (SRU engine refactor shipped)

**SRU engine refactor done** (branch `sru-engine-refactor`; jurisdiction-pack §7 items 2–3): `api/src/sru.js` split into engine `api/src/filings.js` + emitter `api/src/emitters/sruLines.js` + descriptor `db/jurisdictions/SE/filings/ink2.json` (flat fields map, per-field `blankett`, kinds + closed op vocabulary — sign_split_profit/loss on book_result|tax_result, tax_attr, loss_closing, copy, flag; 7011/7012 engine-injected per blanket). Old `db/jurisdictions/SE/sru_ink2.json` deleted; routes unchanged (`/api/:company/sru/ink2`, `/sru/info`). `periods.tax_attrs` now feeds `tax_attr` (loss_cf resolution: query-param override → period attr → warning+0) and the `flag` ops (8041/8045 read `consultant`/`audited`, default false → 'X'). Pack linter gained the §6 emitter-existence check; SE `coa.json` gained BAS 1980 (the 7281 mapping always referenced it — the linter exposed it once the descriptor moved under `filings/`). Deferred per §0q API-first: Periods-grid tax_attrs columns (`period.upsert` already accepts `tax_attrs`). Not built: company.attr defaults, §2 rollforward proposal.

**Verification** (old code from `origin/main` worktree vs new, identical copies of the mdu snapshot DB): 2024 + 2025 blanketter.sru **byte-identical** old↔new AND vs the filed 2024 reference / delivered 2025 blanketter (modulo `#IDENTITET` timestamp); `check=1` JSON identical; INFO.SRU identical; period-default proven both directions (no param → 7763=86,053 from `tax_attrs` with zero warnings; old code → 0 + 'loss_cf not given'). Contract suite 60/62 = the 2 known wall-clock date flakes, failure set identical on `origin/main`.

**Golden-test seed inputs lost:** `tests/sru-golden-2024.mjs` loads its 2024 books from two CSVs that lived in the agent profile's document cache (purged). The seeded company `zz_srugold3` (full 2024 books) persists in the dev DB, so the golden assertion stays runnable via direct HTTP against that company (method used above), but the test's CSV-loading phase needs the 2024 journal + BS CSVs re-dropped, or a rework to seed from a checked-in dump. Decision pending magnus. **Update (PR #76 merge):** the golden test now also seeds the mandatory MEDIELEV contact attrs (`contact_postnr`/`contact_postort`) before generating, since the §0t gate 400s without them.

**Backlog:** P2 accounting completeness (P2-3 `bill_lines` subledger, P2-4 VAT unify, P2-7 coaStyle) → P3 feeds. Receivables stays dropped.

---

## 0v. Status update — 2026-08-01 (SIE import)

**`sie.import` shipped** (`feature/sie-import`) — the asymmetry magnus flagged (export without import) is closed. Industry-standard shape (Fortnox / Visma Administration): accepts SIE types 1–4, `contentBase64` transport, CP437(PC8)/UTF-8 auto-detect, `dryRun` **default true** (preview first, commit explicit). Accounts upserted from `#KONTO` (`#KTYP` when present, else BAS class inference: 1→Asset, 20→Equity, 2→Liability, 3→Revenue, 89→Closing, else Expense). Each `#VER` posts as one batch with reference `SIE <serie> <verno>`; re-import skips existing references (natural idempotency + `Idempotency-Key` per standing rule 3); per-voucher errors collected (partial import with result list — not all-or-nothing like `journal.import`). `#IB` year 0 posts as opening-balance batch `SIE OB` (toggle: `importOpeningBalances`); `#UB`/`#RES` serve as a reconciliation cross-check against what was imported (`reconciliation.diffs`, warn-not-block). `#RTRANS` excluded / `#BTRANS` applied; dimension lists discarded (counted); orgnr mismatch → warning. Locked periods fail the affected voucher only; uncovered dates auto-create calendar-year periods. API-first per §0q — no UI; agent whitelist untouched (default-deny holds). Verification: `api/test/sie-import.test.js` 7/7 (round-trip export→import balance parity with clean reconciliation, dry-run writes nothing, duplicate skip, unbalanced rejection, RTRANS/BTRANS, type-1 OB) + full suite 69/69.

**SIE jurisdiction-gated** (same branch, follow-up per magnus): SIE is Sweden-exclusive (SIE-gruppen, BAS conventions), so it belongs to the SE pack per jurisdiction-pack spec §5 (emitters/parsers stay **code**; packs declare capabilities). The SE `jurisdiction.json` now declares `"integrations": { "sie": { "export": true, "import": true } }`; `packIntegration(code, name)` on the shared `jurisdiction-packs.js` loader answers the gate question. Export endpoint `/report?type=sie` and `sie.import` both 400 for undeclared jurisdictions (`SIE export/import not available for jurisdiction <X>`); the reports-hub ⬇ SIE download item only renders when the pack declares export (previously shown unconditionally for SG too). Descriptor extraction of the BAS-class/8999 knobs deferred (single-jurisdiction format — symmetry, not flexibility). Pack-linter key validation rides the `sru-engine-refactor` branch (the §6 linter lives there). Tests: gating test added (`sie-import.test.js` 8/8) + full suite 76/76.

---

## 0w. Status update — 2026-08-02 (agent-first hardening: event payload fix + per-actor API tokens)

**§0r residual (a) CLOSED (PR #79):** oversized event payloads were sliced mid-string at 4000 chars and stored as invalid JSON — JSON.parse consumers (agents on `event.list`, the MCP `event_list` tool) broke on exactly the largest events. `serializePayload()` in events.js guarantees valid JSON within the cap: oversized payloads are wrapped in `{_truncated, original_chars, preview}`; consumers re-fetch full state via the row's entity_type/entity_id. Unit suite 4/4 · full api suite 80/80 · mcp-smoke 28/28.

**Per-actor API tokens shipped (spec §2.5 — the §7 out-of-scope item, pulled in):** Bearer-token auth for the action API. A token is an identity (bound email), not a capability grant — role still resolves from `user_permissions` per call. Valid token overrides body `userEmail`; invalid/revoked → 401 `UNAUTHENTICATED` with no downgrade to self-asserted identity. `FREEBOOKS_AUTH_MODE=token-remote` requires tokens from non-loopback clients — the **two-server deployment mode** (freebooks+DB on host A, agent + MCP server on host B with `FREEBOOKS_API_TOKEN`). Management actions `auth.token.create/list/revoke` are owner-only (agents excluded by the role check AND the §2.3 whitelist); token shown once, sha256 stored. Verification: new `auth-tokens.test.js` 6/6 (one-time mint, hash never listed, bearer-over-body precedence, invalid/revoked 401, idempotent revoke, loopback/remote unit gates, agent 403s) · full suite 86/86 · mcp-smoke 28/28. Two implementation catches at review: DuckDB RETURNING needs `query()` not `exec()` (exec discards rows), and the admin SQL endpoint binds no named params (tests inline literals per contract.test.js convention).

**Known residuals (backlog, none blocking):** per-company token scoping + role ceilings; `last_used_at`; audit-log token provenance (label); Bearer coverage of non-action routes (`/api/upload` multipart, attachment GETs, report routes) — the action API only today; same-host reverse-proxy caveat documented in spec §2.5.

---

## 0x. Status update — 2026-08-02 (operator guides + FREEBOOKS_BIND)

**Agent operations documentation shipped:** `docs/agent-setup-guide.md` (security model, three deployment scenarios — same-host loopback, two-server via SSH-tunnel/Tailscale+token-remote/reverse-proxy with the same-host caveat, cloud-LLM paste-bridge with prompt template + bridge script; token lifecycle; troubleshooting) and `docs/agent-data-feeding-guide.md` (event.list polling contract + per-event agent actions, A4 underlag binding steps, inbound paths — UI/curl/drop-folder watcher/email-in/bank/SIE, idempotency-via-file-hash, approval loop, feed security). README links both from the MCP section.

**`FREEBOOKS_BIND` added (the two-server enabler the guides require):** the API hardcoded `app.listen(PORT, '127.0.0.1')` — loopback-only with no override, which made the token-remote topology unreachable except via SSH tunnel. Bind address is now `process.env.FREEBOOKS_BIND || '127.0.0.1'` (default unchanged; boot log prints the effective `HOST:PORT`). Verified: default boot still loopback-only; `FREEBOOKS_BIND=<ip>` binds the named interface. Full suite 86/86.

---

## 0y. Status update — 2026-08-03 (A5 unified inbox ratified)

**Decision:** the review queue leaves the Journal list and becomes a dedicated **Inbox** page — the single human action surface under agent-first (agent-readiness spec §10, new invariant R8). Ratified by magnus: **(1) replace** — the queue half of the Journal view moves to the inbox; the Journal list becomes the pure posted register, badge and `f` filter move with the queue; **(2) `g i` = Inbox** — letter reclaimed from bank-import (imports are an inbox item type; route/palette unchanged, reachable via `g b`); **(3) hold** — module-native pending views (e.g. Payables drafts) stay until the inbox proves out on journals. The taxonomy covers all action-item types up front: **Class A** pre-ledger approvals (everything converges on `journal_proposals` — the single-gateway rule is unchanged) and **Class B** post-ledger operational items (bills due/overdue, unmatched bank-import lines, receivables [type reserved — module unbuilt], attestation items, agent-raised exceptions). Data layer: read-only `inbox.list` aggregator, no staging entity — each module stays its items' source of truth. Trigger: the observed `f`-filter confusion — merged queue+register conflated ephemeral work with the permanent ledger record. Sequencing: next build item (spec §10.7), PR per standing rule 5.

---

## 0z. Status update — 2026-08-05 (bank-matching cascade + bills routing specced)

**Two new specs ratified** in this session: `docs/bank-matching-spec.md` (v3, rescoped for small-company volume) and the four amendments to `docs/agent-readiness-spec.md` (v2). Three existing specs amended: `docs/agent-data-feeding-guide.md` (subfolder-aware watcher §4.3, bank statement agent processing §4.5, bills routing §4.5b), `docs/ia-spec.md` (nav-registry unchanged — Bank sidebar item stays), and this roadmap.

**Bank-matching cascade** (`docs/bank-matching-spec.md`): a four-tier confidence/evidence cascade for bank statement processing — tier 1 learned rules, tier 2 open-item matching, tier 3 trigram master-data match, tier 4 LLM reasoning. Rescoped for small-company volume (§0.1): plain counters with N=10 floor (no Beta-Binomial), one batch per statement (no content-based clustering), N:M falls through to tier 4 as ordinary residual (no dedicated detection layer). Mappings stay human-only (R2) — agent suggests rules via `mapping_suggestions` table, human approves in inbox (same propose/approve pattern as journal entries). Rule retirement fires inside human-attributed actions (consecutive rejections inside `journal.reject`, bank-account-change inside vendor-edit handler). No auto-posting — BFL 5 kap. Calibration: band-level realized-accuracy counter, no cross-tenant prior.

**Bills routing — Option C ratified** (agent-data-feeding-guide §4.5b): agent extracts supplier invoice → `bill.create` (draft, `agent` role 1.5) → inbox Class A `bill_draft` item → human `y` posts via `bill.post` → open payable → tier 2 bank-statement matching composes. `bill.create` added to `AGENT_ALLOWED` and MCP manifest; `bill.post` stays human-only ("approve is the post" doctrine). New-vendor problem flagged as open (orthogonal — future `vendor.suggest` pattern, same shape as `mapping.suggest`).

**Agent-readiness-spec amendments** (v2): `matching_history.record` + `mapping.suggest` added to `AGENT_ALLOWED` (§2.3) and MCP manifest (§5.2); `attachment.rejected` event type (§3.2); Class B taxonomy broadened to "not a ledger approval" (§10.2, was "post-ledger" — now includes pre-ledger input rejections and mapping suggestions); `bill.create` + `bill_create` MCP tool added (bills routing — Option C).

**Drop-folder watcher** (agent-data-feeding-guide §4.3): folder structure is the classification (`bank/`, `bills/`, `receipts/`, `journal/`, root = legacy default). Optional operator-managed preprocessor routes files to subfolders. Bank statements need `bank_statement` as a new `entityType` on the `attachments` table.

### Build order — Phase B (bank-matching cascade + document routing) — ✅ SHIPPED

Phase B consumed the Phase A agent-readiness tranche (A1 actor model, A2 events, A3j journal proposals, A4 underlag, A5 inbox, MCP server — all shipped). It landed the bank-matching cascade and the document-routing layer. All items shipped across PRs #87–#90, #98, plus B9 (self-contained agent pipeline, PR #89) and mapping-suggestions wiring (PR #90). See §0aa and §0bb for details.

**B1** ✅ Agent-readiness-spec amendments — `matching_history.record`, `mapping.suggest`, `bill.create` added to `AGENT_ALLOWED` + MCP tools; `attachment.rejected` event; Class B taxonomy broadening.

**B2** ✅ `mapping_suggestions` table + suggest/approve/reject actions + inbox `mapping_suggestion` type.

**B3** ✅ `matching_history` table + record/query/calibration actions.

**B4** ✅ `bank.match` action — tiers 1–3 deterministic matching core.

**B5** ✅ Drop-folder watcher + subfolder-aware upload + `bank_statement` entityType. (Demoted to fallback by B9.)

**B6** ✅ Bill drafts as inbox Class A + inbox `bill_draft` type.

**B7** ✅ Agent orchestration loop (tier 4 + end-to-end). (Demoted to fallback by B9.)

**B8** ✅ Input rejections as inbox Class B.

**B9** ✅ Self-contained agent pipeline — in-process module replaces B5+B7 external scripts. See §0aa.

**Wiring** ✅ Mapping-suggestions spec implemented — learning loop, conflict detection, tier 3.5, crystallization, retrospective sweep. See §0bb (PR #90).

**Guard fix** ✅ Agent-writable whitelist updated for Phase B actions (PR #98).

**What stays after Phase B:** P2 accounting completeness (year-end close, FX reval, bill_lines subledger, VAT unify) — all shipped. P3 scope (receivables, bank feeds beyond CSV) — bank feeds partially addressed by B5/B9 (drop-folder, in-process watcher), but full bank API integration remains P3. The new-vendor problem (vendor proposal pattern) is a future extension.

---

## 0aa. Status update — 2026-08-06 (B9 self-contained agent + mapping-suggestions spec)

**B9 — Self-contained agent pipeline ✅ (PR #89).** Phase B's external-script architecture (B5 bash watcher + B7 node script) is replaced by an in-process module inside the Express server. Spec: `docs/b9-self-contained-agent-spec.md` (ratified 2026-08-06).

| Component | Before (B5 + B7) | After (B9) |
|---|---|---|
| Folder watcher | External bash (`freebooks-feed-watch.sh`), `inotifywait` | In-process Node module, `setInterval` + `readdir` |
| Agent loop | External script (`freebooks-agent-loop.js`), HTTP self-call | In-process module (`api/src/agent-loop.js`), direct handler calls via injected `dispatchAction` *(legacy script deleted — issue #108)* |
| LLM config | Env vars, hardcoded tier-4 placeholder | `settings` table keys, Settings/AI tab (3 fields: endpoint_url, api_key, model + temperature) |
| Multi-company | Single `FREEBOOKS_COMPANY` env var | Folder structure `inbox/{company_id}/{type}/` |
| MCP | External agent transport (Hermes) | **Unchanged** |
| External scripts | Primary pipeline | **In-process is sole path** — `freebooks-agent-loop.js` deleted (placeholders never implemented, issue #108); `freebooks-feed-watch.sh` retained as fallback |

The agent loop iterates all companies with `agent_enabled='true'`, sequential per-company per-poll tick. Config read from the settings table (per-company). Cursor (`agent_last_seq`) persisted per-company. Started at boot if any company has the agent enabled.

**B7 items closed:** the external `freebooks-agent-loop.js` script was deleted (issue #108) because its bill extraction and tier-4 LLM were placeholder-only and never implemented. B5's `freebooks-feed-watch.sh` remains as a fallback folder watcher. The in-process loop calls `bank.match` → `journal.propose` → tier-4 LLM → `journal.propose` directly — no HTTP self-call, no tokens, no external process management.

### Mapping-suggestions spec — wiring gaps found in B9 review

**New spec:** `docs/bank-mapping-suggestions-spec.md` (ratified in discussion 2026-08-06, **implemented PR #90**). Filed after reviewing the B9 agent-loop implementation and discovering that several mechanisms specced in bank-matching-spec §10 are built but not wired. Six areas:

1. **`matching_history.record` never called** (§1). The action is in `AGENT_ALLOWED`, the handler is built (index.js §778), the table exists — but neither `journal.approve` nor `journal.reject` calls it, so `matching_history` is always empty. Fix: record outcomes inside the journal approve/reject handlers as a side effect (same pattern as retirement-on-reject, §10.5).

2. **No historical-transaction tier** (§2). The cascade runs tiers 1→2→3→4 with no tier that checks "how was this same description posted last time?" The `matching_history` table and `matching_history.query` exist but are unused. Fix: insert a tier 3.5 (historical outcome match) between tier 3 and tier 4 — exact `description_pattern` lookup against `matching_history` where `outcome='approved_unedited'`, returns the modal account.

3. **Crystallization not wired** (§3.1). Bank-matching-spec §10.4 calls for `mapping.suggest` when a tier-4 proposal is approved unedited, but `approveProposal` (journal.js) never calls it. Fix: wire the call into `journal.approve` as a side effect of unedited tier-4 approvals.

4. **No retrospective sweep** (§3.2). A pattern that recurs across multiple proposals (even tier 2/3 matches) without ever getting a rule is a candidate for a tier-1 rule, but nothing scans for this. Fix: a throttled (daily) function in the agent loop that groups `journal_proposals` by normalized description pattern, filters to recurring unruled patterns, and calls `mapping.suggest`. Agent-only capability — a journal handler sees one proposal at a time and cannot detect aggregate recurrence.

5. **No conflict detection** (§4). `mapping.suggestion.approve` writes to `bank_mappings` with zero conflict checking. Three conflict classes: duplicate (same pattern, same account — harmless redundancy), contradiction (same pattern, different account — first-match-wins ambiguity), shadowing (overlapping patterns — broader rule may shadow narrower). Fix: a `detectMappingConflicts` function checked at both suggestion creation and approval, against **both** `bank_mappings` (active rules) and `mapping_suggestions` (pending suggestions — two pending suggestions with overlapping patterns can coexist silently). Plus a historical regression test: run the proposed rule's pattern matcher against `journal_proposals` to find transactions it would have matched that were posted to a different account — empirical conflict detection against ground truth.

6. **No amount conditions on rules** (§5) + **no specificity scoring** (§6). The `bank_mappings` schema has no amount field, so it cannot express "STRIPE AND amount > 0 → revenue, STRIPE AND amount < 0 → fees" — two legitimate rules disambiguated by direction appear as a false contradiction. And `matchMapping` is first-match-wins by priority with no specificity scoring, so overlapping patterns resolve by insertion order. Fixes: add `amount_sign` column (positive/negative/any); change `matchMapping` to longest-match-wins (most specific pattern first, priority as tiebreaker — QBO/Xero pattern).

**Build order for the wiring fixes:** §1 (record outcomes) and §5 (amount_sign schema) and §6 (specificity scoring) have no dependencies and can ship independently. §2 (historical tier) depends on §1. §4 (conflict detection) depends on §5 and §6. §3 (suggestion triggers) depends on §4. See the spec's §7 for the full dependency graph.

**What stays after B9 + mapping-suggestions spec:** P2 accounting completeness (year-end close, FX reval, bill_lines subledger, VAT unify) — unchanged. P3 scope (receivables, bank feeds beyond CSV) — unchanged. The new-vendor problem (vendor proposal pattern) remains a future Phase B extension.

---

## 0bb. Status update — 2026-08-07 (mapping-suggestions wiring shipped, PR #90)

**Mapping-suggestions spec implemented ✅ (PR #90, branch `feature/mapping-suggestions-wiring`).** All six sections of `docs/bank-mapping-suggestions-spec.md` are wired. The learning loop that B9 left disconnected is now closed — approved/rejected proposals feed `matching_history`, the cascade consults prior outcomes at tier 3.5, and recurring patterns crystallize into mapping suggestions.

| Spec § | What shipped | Key files |
|---|---|---|
| **§1** | `matching_history.record` fires inside `approveProposal`/`rejectProposal`. `_match_meta` persisted on `journal_proposals` (new JSON column). | `journal.js`, `schema.sql` |
| **§2** | Tier 3.5 historical match — queries `matching_history` for `approved_unedited` outcomes, returns modal account with calibrated confidence (0.75/0.82/0.88). | `bank.js` |
| **§3.1** | Crystallization — unedited tier-4 approvals auto-create `mapping_suggestions` rows. | `journal.js` |
| **§3.2** | Retrospective sweep — throttled (24h) in `agent-loop.js`, scans posted proposals for recurring unruled patterns (≥3). | `agent-loop.js` |
| **§3.3** | `normalizeDescription` — strips dates, ref numbers, amounts, trailing country codes. | `mapping-utils.js` (new) |
| **§4** | `detectMappingConflicts` — checks active rules + pending suggestions + historical regression. Wired into `mapping.suggest` and `mapping.suggestion.approve`. | `mapping-utils.js`, `index.js` |
| **§5** | `amount_sign` column on `bank_mappings` + `mapping_suggestions`. `matchMapping` filters by direction. Same-pattern rules with different `amount_sign` are NOT in conflict. | `schema.sql`, `bank.js`, `index.js` |
| **§6** | `matchMapping` rewritten to longest-match-wins (pattern length desc, priority asc as tiebreaker). | `bank.js` |

**Bug fix en route:** tier 3 vendor query referenced `expense_account` (actual column: `default_expense_account`). Was unreachable before because tier 1 always matched; `amount_sign` filtering now lets the cascade fall through to tier 3, exposing the bug.

**Test results:** new contract tests 15/15. Existing suite 68/68 (the pre-existing `bill.create` agent guard test failure was fixed in P2-3 — the test's `AGENT_WHITELIST` was stale, missing 4 Phase B actions). MCP smoke 27/28 (same pre-existing tool-list assertion — not caused by this PR).

**PR #90 status:** merged (commit `972e0ac`).

**What stays after mapping-suggestions wiring:** P2 accounting completeness (P2-1 year-end close, P2-2 FX reval, P2-3 bill_lines subledger, P2-4a VAT unify — P2-4b server-computed draft totals confirmed done) — unchanged. P3 scope (receivables, bank feeds beyond CSV) — unchanged. The new-vendor problem (vendor proposal pattern) remains a future Phase B extension.

---

## 0cc. Status update — 2026-08-07 (P2-4b confirmed done, README overclaim fixed)

**P2-4b (server-computed draft totals) confirmed DONE** (magnus review, 2026-08-07): `saveDraftBill` (`bills.js:850-905`) computes `totalAmount` server-side from `bill.lines` (VAT rate cache, stated-VAT handling, RC exclusion). The `bill.amount || _preTotal` at line 164 is inside `createBill`'s pre-validation and is overwritten by server-computed `totalAmount` further down. Roadmap P2-4 split into P2-4a (VAT unify, still open) and P2-4b (draft totals, done).

**README overclaim fixed** (`README.md:14`): the public README stated "Year-end net income closes to retained earnings on posting the year-end close (no live injection)" — but no `period.close` action exists and `render.js:121-174` still injects an unallocated-net-income row live. Corrected to describe the manual close + live injection accurately.

**Next:** P2-1 year-end close spec — design discussion, no code until ratified.

---

## 0dd. Status update — 2026-08-07 (P2-1 year-end close shipped)

**P2-1 year-end close ✅ (branch `feature/p2-1-year-end-close`).** Spec: `docs/p2-1-year-end-close-spec.md` (ratified by magnus 2026-08-07). The close action posts a summary entry (Closing ↔ RE), jurisdiction-pack driven. No line-by-line zeroing — the live injection in `render.js` is the permanent source of truth for equity presentation (the QuickBooks pattern). Closing entries exist solely to materialize balances for downstream export formats (SIE `#RES` lines on the Closing-type account).

**What shipped:**

| Component | What | Key files |
|-----------|------|-----------|
| **Jurisdiction pack `closing` block** | SE: `{ required: true, reAccount: "2099", closingAccount: "8999" }`. SG: `{ required: true, reAccount: "203070", closingAccount: "999999" }`. A hypothetical US pack: `required: false` — close never invoked, live injection is permanent. | `db/jurisdictions/SE/jurisdiction.json`, `db/jurisdictions/SG/jurisdiction.json` |
| **`closingConfigFor()` helper** | Reads `closing` block from pack. | `api/src/jurisdiction-packs.js` |
| **`period.close` action** | Summary entry: P&L net → closing account → RE account. Idempotent (guard checks any un-reversed batch involving the closing account on period end date). Audited. Emits `period.closed` event. Role: owner/admin only. | `api/src/period-close.js`, `api/src/action-catalog.js`, `api/src/index.js` |
| **Inbox `period_unclosed` items** | Class B item surfacing periods past their end date (90-day window) with no posted close. Verbs: `['close']`. | `api/src/inbox.js` |
| **SRU export gate** | `/sru/ink2` and `/sru/info` return 409 `PERIOD_NOT_LOCKED` when the period is not locked. SIE export remains ungated (general-purpose format). | `api/src/filings.js` |
| **`gl()` opening-balance fix** | Temporary accounts (Revenue, Expense, Cost of Sales, Closing) always open at 0. `CASE` on `account_type` in the opening-balance CTE. | `db/macros.sql` |
| **`re_rollforward` parameterized** | `re_rollforward(cid, closing_account, re_account)` — no more hardcoded 999999/203070. All periods now show OK against both SE and SG live data. | `db/macros.sql`, `reports/render.js` |
| **`integrity_extended` parameterized** | `integrity_extended(cid, start, end, closing_account)` — no more hardcoded 999999. | `db/macros.sql`, `reports/render.js` |
| **Pack linter** | Validates `closing` block: `required` boolean, account codes exist in COA, correct `account_type` (Closing/Equity). | `tests/jurisdiction-packs.mjs` |
| **SG COA fix** | Added missing 999999 (Closing) and 203070 (Equity, Retained Earnings) accounts to the SG COA — they were referenced by the closing block but not in the template. | `db/jurisdictions/SG/coa.json` |

**Verification:**
- Contract tests: 68/68 (pre-existing `bill.create` agent guard test failure fixed in P2-3 — stale `AGENT_WHITELIST` in the test, not a code bug).
- New `period-close.test.js`: 8/8 (profit, loss, zero P&L, idempotency, missing params, unknown period, audit log, inbox item).
- Pack linter: OK SE, OK SG.
- SRU contact tests: 6/6.
- Live DB verification: `re_rollforward` all OK (was all FAIL), `integrity_extended` shows real numbers (was 0), `gl()` temporary accounts open at 0 (was cumulative).
- **Sign convention fix** (second commit): `integrity_extended` P&L vs Closing Entry check changed from subtraction to addition — P&L net + closing entry = 0 (opposite sides of the closing entry). All 20 periods (11 mdab_se + 9 inteligo_sg) now show OK.

**Design decisions (ratified by magnus 2026-08-07):**
1. No auto-lock after close. Inbox surfaces unclosed periods past 90 days.
2. `re_rollforward` + `integrity_extended` fixed as part of P2-1 (same root cause).
3. AGM rebooking (2099 → 2098/2091) is separate — not in P2-1.
4. SIE export ungated (general-purpose). SRU export gated on locked period (submission-specific).

**What stays:** P2-3 bill_lines subledger, P2-4a VAT unify, P2-7 coaStyle — unchanged priority. P3 scope — unchanged. *(P2-3 and P2-4a subsequently shipped — see §0ff, §0gg.)*

---

## 0ee. Status update — 2026-08-07 (P2-2 FX revaluation shipped)

**P2-2 FX revaluation ✅ (PR #95, branch `feature/p2-2-fx-reval-pack-driven`).** Direction ratified by magnus 2026-08-07: IAS 21 is the standard but jurisdiction-specific implementation details (which accounts, which rate) belong in the jurisdiction pack, not hardcoded in software. The LLM has no role — FX revaluation is deterministic arithmetic (foreign balance × closing rate − home balance). The preview → review → post flow already existed and is the right UX.

**What shipped:**

| Component | What | Key files |
|-----------|------|-----------|
| **Jurisdiction pack `fxRevaluation` block** | SE: `{ monetaryTypes: ["Asset", "Liability"], gainLossAccount: "7960" }` (Valutakursdifferenser). SG: `{ monetaryTypes: ["Asset", "Liability"], gainLossAccount: "8030" }` (Foreign Exchange Gain/Loss). | `db/jurisdictions/SE/jurisdiction.json`, `db/jurisdictions/SG/jurisdiction.json` |
| **`fxRevaluationConfigFor()` helper** | Reads `fxRevaluation` block from pack. Mirrors `closingConfigFor` pattern. Returns `null` when pack declares no block — callers fall back to `['Asset', 'Liability']` (safe default, no Equity). | `api/src/jurisdiction-packs.js` |
| **`fx.js` revaluationPreview** | Reads `monetaryTypes` from pack config instead of hardcoding `('Asset', 'Liability', 'Equity')`. Equity dropped (IAS 21 — monetary items only). Dynamic `IN (@mt0, @mt1, …)` clause. | `api/src/fx.js` |
| **`fx.js` revaluationPost** | Falls back to pack `gainLossAccount` when caller doesn't pass `fxGainLossAccount` explicitly. | `api/src/fx.js` |
| **Pack linter** | Validates `fxRevaluation` block when present: `monetaryTypes` non-empty array, `gainLossAccount` exists in COA with `account_type: 'Expense'`. | `tests/jurisdiction-packs.mjs` |
| **Test** | Pack config presence/correctness (SE/SG), `fxRevaluationConfigFor` null fallback, source-level Equity check. | `tests/fx-reval.mjs` |

**Verification:**
- Pack linter: OK SE, OK SG.
- FX reval test: all passed.
- Modules load clean.

**Design decision (ratified by magnus 2026-08-07):** Four options were evaluated — (A) software feature with hardcoded fix, (B) jurisdiction-pack-driven config, (C) report + manual journal entry, (D) LLM-assisted. Option B selected: the rules live in the pack, the engine computes, the LLM stays out of it (wrong tool for arithmetic). Option C subsumed by the existing preview. P2-7 (`coaStyle`) raised in the same discussion — the engine is identifier-agnostic, but the UI assumes numeric codes.

**What stays:** P2-3 bill_lines subledger, P2-4a VAT unify, P2-7 coaStyle — unchanged priority. P3 scope — unchanged. *(P2-3 and P2-4a subsequently shipped — see §0ff, §0gg.)*

---

## 0ff. Status update — 2026-08-07 (P2-3 bill lines subledger shipped)

**P2-3 bill lines subledger + AP control report ✅** (branch `feature/p2-3-bill-lines-subledger`). Spec: `docs/p2-3-bill-lines-subledger-spec.md` (ratified by magnus 2026-08-07).

**What shipped:**

| Component | What | Key files |
|-----------|------|-----------|
| **`bill_lines` table** | Expense line items for posted bills: `line_number`, `expense_account`, `amount`, `amount_home`, `vat_code`, `description`, `cost_center`, `profit_center`. Written alongside `journal_entries` in `createBill`; never mutated. Drafts stay as JSON in `bills.draft_lines`. | `db/schema.sql` |
| **Backfill migration** | Reconstructs `bill_lines` for existing posted/partial/paid/void bills from journal entries (one-time, `ON CONFLICT DO NOTHING`). VAT/GST lines included for pre-migration bills (cosmetic — accepted per ratified decision §12.1). | `db/schema.sql` |
| **Write path** | `createBill` builds `billLineRows` from `expenseLines` and inserts via `bulkInsert('bill_lines', ...)` alongside journal entries. `bill.void` preserves rows (status=void, control report filters by status). | `api/src/bills.js` |
| **Read path** | `getBillLines` rewritten: posted bills read from `bill_lines` (stable, indexed, no fragile journal filtering); drafts unchanged (JSON). `entry_id` is now `line_number` (stringified) — used as React key only. | `api/src/bills.js` |
| **`ap_control` macro** | Point-in-time subledger-vs-GL reconciliation per AP account. GL side: non-reversed journal entries on AP accounts. Subledger side: open bills (posted, partial) − payments. FX-aware status: WARN for foreign-currency bills with diff < 100. | `db/macros.sql` |
| **`ap-control` report** | `GET /api/:company/report?type=ap-control&end=…`. Audit category, as-of date (no start), no multiperiod. Zero rows permanent (one row of zeros, status OK). Whole currency units (no decimals). | `reports/render.js`, `api/src/report-registry.js`, `api/src/reports.js` |
| **Integrity check integration** | `integrity_extended` gains `ap_control_check` CTE — period-range AP subledger-vs-GL check surfaces on every Integrity Check run. | `db/macros.sql` |
| **Action catalog** | `bill.lines` description updated to mention `bill_lines` subledger for posted bills. | `api/src/action-catalog.js` |

**Verification:** contract tests 72/72 (the pre-existing `bill.create` agent guard test failure is fixed in this PR — the test's `AGENT_WHITELIST` was stale, missing 4 Phase B actions added to `AGENT_ALLOWED`). New P2-3 tests 4/4 (bill_lines write, bill.lines read, void preserves rows, AP control report renders).

**Ratified decisions (magnus 2026-08-07):** backfill VAT/GST lines accepted; FX heuristic sufficient; integrity check integration included; `entry_id` semantic change accepted; paid-home computed from join (no stored column).

**What stays:** P2-7 coaStyle — unchanged priority. P3 scope — unchanged.

---

## 0gg. Status update — 2026-08-07 (P2-4a VAT unify shipped)

**P2-4a VAT/amount convention unify ✅ (PR #100, branch `feature/p2-4a-vat-unify`).** Spec ratified and shipped same day. Journal entries are now tax-exclusive — the entered debit/credit IS the net, VAT is computed on top (`amount × rate`) and posted as separate per-code GL lines, mirroring `bills.js:396-414`. Bank import stays tax-inclusive (settled cash = gross — `expandVatLines` → `computeVatSplitGross` unchanged). Both `journal.post` and `journal.approve` paths get the expansion automatically via `enrichAndValidate`.

**What shipped:**

| Component | What | Key files |
|-----------|------|-----------|
| **`computeVatSplitGross` rename** | `computeVatSplit` → `computeVatSplitGross` in `vat.js` (function + `module.exports` + `expandVatLines` call). JSDoc makes the tax-inclusive assumption unmissable at the call site. | `api/src/vat.js` |
| **Tax-exclusive `enrichAndValidate`** | Entered debit/credit IS the net. `vatAmount = Math.round(amount × rate × 100) / 100`. Fetches VAT code metadata (rate, input/output accounts, is_reverse_charge) and attaches as `_vatMeta`. | `api/src/journal.js` |
| **`expandJournalVatLines`** | New function. Per-code grouping: one VAT GL line per distinct code (standard VAT); DR input + CR output pair per RC code (nets to zero). Original lines keep entered debit/credit as net; `vat_code` nulled, `vat_amount` zeroed. Called before validation so balance check sees the full expanded set. | `api/src/journal.js` |
| **Bank import comment** | Call-site comment documents why bank import stays tax-INCLUSIVE (bank amount = settled gross cash; do NOT unify with journal path). | `api/src/bank.js` |
| **Journal UI** | Per-line computed-VAT readout cell; total VAT in totals bar; balance check includes VAT: `(dr + vatDebit) − (cr + vatCredit)`. | `api/src/pages/journal-new.js` |
| **Contract tests** | 4 tests: standard (1000 net + 25% → DR 1000 + VAT DR 250 + CR 1250), per-code grouping (two lines same code → one VAT GL line of 500), RC (DR input + CR output, nets to zero), no-VAT (plain pair). | `api/test/journal-vat.test.js` |

**Design decisions (ratified by magnus 2026-08-07):**
1. Journal entries → tax-exclusive (matches bills; QBO/Xero precedent).
2. Bank import → stays tax-inclusive (settled cash = gross; existing working code).
3. Per-code VAT grouping (new net-input logic modeled on `bills.js` `stdTaxByCode`, NOT `expandVatLines` reuse).
4. `computeVatSplit` → `computeVatSplitGross` rename (unlabeled convention assumption must be unmissable at call site).
5. No historical backfill (`generateVatReturn` reads metadata columns, not GL). Future VAT-subledger-vs-GL control must be cutover-scoped.
6. No stated-VAT override, no gross/net toggle.

**Verification:** 123/123 API tests pass (including 4 new). `node --check` all modified files. SRU golden + reversal integration tests need running server (pre-existing ECONNREFUSED).

**What stays:** P2-7 coaStyle — unchanged priority. P3 scope — unchanged.

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

- **P2-1** ~~Year-end close routine to retained earnings (replaces live "unallocated net income" injection).~~ ✅ **DONE 2026-08-07** (PR #93) — `period.close` action posts summary closing entry (Closing ↔ RE), jurisdiction-pack driven. `gl()` opening-balance fix, `re_rollforward` + `integrity_extended` parameterized. See §0dd.
- **P2-2** ~~FX revaluation: monetary items only (drop Equity).~~ ✅ **DONE 2026-08-07** (PR #95) — jurisdiction-pack-driven `fxRevaluation` block (`monetaryTypes`, `gainLossAccount`). Engine reads pack config instead of hardcoding `('Asset', 'Liability', 'Equity')` in `fx.js`. Drops Equity by default (IAS 21 — monetary items only). `fxRevaluationConfigFor()` helper in `jurisdiction-packs.js`. Pack linter validates the block. Direction ratified by magnus 2026-08-07: IAS 21 is the standard but jurisdiction-specific implementation details belong in the pack, not hardcoded in software. The LLM has no role — deterministic arithmetic. See §0ee.
- **P2-3** ~~`bill_lines` subledger table + AP-subledger-vs-GL control report.~~ ✅ **DONE 2026-08-07** (branch `feature/p2-3-bill-lines-subledger`) — `bill_lines` table stores expense line items (written alongside `journal_entries` in `createBill`, never mutated); `getBillLines` reads from `bill_lines` for posted bills (drafts unchanged). `ap_control` macro: point-in-time subledger-vs-GL reconciliation per AP account, FX-aware WARN. `ap-control` report in the Audit category. `integrity_extended` gains `ap_control_check` CTE. Backfill for existing posted bills. Spec: `docs/p2-3-bill-lines-subledger-spec.md`. See §0ff.
- **P2-4a** ~~Unify VAT/amount conventions — tax-exclusive journal entries (mirrors bills path); bank import stays tax-inclusive (settled cash = gross).~~ ✅ **DONE 2026-08-07** (PR #100) — `enrichAndValidate` in `journal.js` now tax-exclusive (entered amount IS net; `vatAmount = amount × rate`); new `expandJournalVatLines` posts per-code grouped VAT GL lines mirroring `bills.js:396-414`; RC posts DR input + CR output pair. `computeVatSplit` → `computeVatSplitGross` rename (JSDoc makes tax-inclusive assumption unmissable). Bank import unchanged (tax-inclusive, settled cash = gross). Journal-new.js UI: per-line computed-VAT readout, balance includes VAT. 4 contract tests. Spec: `docs/p2-4a-vat-unify-spec.md`. See §0gg.
- **P2-4b** ~~Server-computed draft totals~~ ✅ **DONE** — `saveDraftBill` (`bills.js:850`) computes `totalAmount` server-side from `bill.lines`; the client `bill.amount` is only a fallback for line-less drafts. The `bill.amount || _preTotal` at line 164 is inside `createBill`'s pre-validation and is overwritten by server-computed `totalAmount` further down.
- **P2-5** ~~MCP server over the action catalog.~~ ✅ **DONE 2026-08-02** (PR #72) — stdio MCP front end for the whitelisted agent surface. Shipped as Phase A 4/4, pulled forward from P2 per §0n deadline track.
- **P2-6 (candidate)** User-editable keybindings in Settings (raised by magnus 2026-07-22). Recommendation: build only AFTER all tabs migrate onto FB.keys — bindings are declarative data, so a remap layer (per-user overrides, conflict detection, reset-to-default) then covers the whole app in one shot. Industry reference: accounting software generally doesn't offer rebinding; power tools (Linear, Superhuman) do — fits the keyboard-first philosophy. Priority pending magnus. **Dropped 2026-08-07** — contradicts the frozen verb surface; K-series keyboard program complete.
- **P2-7** Jurisdiction-pack COA style (`coaStyle`): pack declares whether account codes are numeric or name-based (`codeType: "numeric" | "name"`), drives UI column header (`codeLabel`) and width (`codeWidth`). Today both packs (SE, SG) ship numeric codes; SG does not require account numbers by law — small SG Pte Ltd companies can run a named chart. The `account_code` column is `VARCHAR NOT NULL` (works with any identifier), but the UI assumes short numeric codes (narrow columns, "Account No." headers). `coaStyle` lets the pack declare the convention; the software adapts. Cross-cutting: affects COA, journal lines, bill lines, FX reval gain/loss account, closing config — all reference `account_code`. Raised by magnus 2026-08-07 in the context of P2-2 (does the pack approach work for jurisdictions without account numbers? Answer: yes — the engine is identifier-agnostic; the gap is UI display, not computation).

### P3 — Scope

- **P3-1** AR/invoicing module built on the payables pattern (customers, invoices, AR aging, receipts).
- **P3-2** ~~Bank feeds (beyond CSV import).~~ **Dropped 2026-08-07** — Phase B delivers the full processing pipeline: drop-folder watcher (B5/B9) uploads statements, agent loop runs the 4-tier matching cascade, proposals land in inbox for human approval, learning loop closes via matching_history + mapping_suggestions. The only remaining manual step is downloading the statement from the bank website (~30s/month). Bank API auto-fetch (PSD2/Open Banking, Tink, Plaid) is low-value engineering for that convenience at target scale. Revisit only if real-time or near-real-time bank data becomes a concrete requirement.
- **P3-3** FX rate automation (agreed with magnus 2026-07-23, spec'd NOT built): `fx_tracking` company flag, provider `fetchRange`, period-create backfill hook, FX status column on Periods (coverage vs provider publication days — never naive weekdays), 6h gap scanner, and a minimal notifications subsystem (table + actions + 🔔 badge/dropdown). Spec: `docs/fx-automation-spec.md`.

---

## 5. Standing rules (from this review)

1. Every feature: API action + schema + contract test **first**, UI second.
2. The posted ledger is append-only; corrections via reversing entries, never mutation.
3. Every mutating action is idempotent (key accepted) and audited.
4. Backend warnings must have a UI channel; warnings never silently dropped.
5. Spec docs updated in the same commit as behavior changes (payables-ux-spec precedent).
6. Dead code deleted, not commented — including endpoints, CSS, and `.bak` files.
