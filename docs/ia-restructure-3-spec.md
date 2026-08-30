# freebooks — IA Restructure Spec 3: Report tab-ification, Books → Journal, Integrity Check relocation

**Date:** 2026-08-30 · **Status:** PROPOSED
**Scope:** (1) **Prerequisite** — replace the iframe-per-selection loading mechanism shared by Statements, Books, and Payables' Aging/Control tabs with a fetch-and-cache fragment loader. (2) Statements' report-type dropdown becomes a visible tab strip (mechanism only, no content change); MoM/YoY step controls stay Statements-exclusive. (3) Books is renamed **Journal**, route path changes `/:company/books` → `/:company/journal` with no redirect (gKey `b`→`j`), its tabs are relabeled, Integrity is removed from it, and it gains the **SIE export** affordance (moved from Books). (4) Accounting keeps its name and its four existing tabs, and gains a fifth: **Integrity**, rendered inline (not via iframe), with a tab-dot indicator on failure. (5) Route-level fallout from the rename — an existing `/:company/journal` redirect handler collides with the new route and must be deleted; a pre-existing dead `/:company/bank` redirect and its unrouted dead-code referrer are flagged for cleanup; `fb-core.js`'s two hardcoded `/books` string checks must be updated in the same change.
**Companions:** `ia-restructure-2-spec.md` (2026-08-27, immediate predecessor — this spec supersedes its §2.1/§3.2/§3.5 entries for Books and Accounting **and its §3.3 claim that SIE export surfaces exclusively through Fiscal → Filings** — after discussion, SIE is treated as an anytime data export tied to the ledger, not a filing artifact, so it stays on the renamed Journal page instead (§3.2). IA2's Filings-exclusivity rule for VAT return/INK2/Annual Report is untouched — this reversal is SIE-specific.), `report-registry.js`, `reports-hub.js`, `payables.js` (shares the iframe pattern §1 fixes), `fb-core.js` (hardcoded `/books` route-string checks, §2.3)
**Consumers:** `api/src/nav-registry.js`, `api/src/report-registry.js`, `api/src/pages/reports-hub.js`, `api/src/pages/payables.js` (inherits the loading-mechanism fix), `api/src/pages/accounting.js`, `api/src/reports.js` (existing `/:company/journal` and `/:company/bank` route handlers, §2.1–2.2), `api/public/fb-core.js` (route-string checks, §2.3), `reports/render.js` (`buildIntegrity` — read, not modified), `db/macros.sql` (`integrity`/`integrity_extended` — read, not modified)

---

## 0. Explicitly out of scope

1. **The periodic/background Integrity Check nag.** Discussed and deliberately deferred — only the tab-local dot indicator ships in this pass. A scheduled check (piggybacking on `agent-loop.js`'s tick, or a new job) plus an Inbox item is a separate, later spec.
2. **The check logic itself.** `integrity()`/`integrity_extended()` (`db/macros.sql`) and `buildIntegrity()` (`reports/render.js`) are unchanged — this spec is about where results surface, not what's evaluated or how the current-year-unclosed-profit adjustment works (already handled, see `review-roadmap.md` discussion 2026-08-29).
3. **Fiscal and Payables page contents.** Unaffected except that Payables' Aging/Control tabs inherit the §1 loading-mechanism fix, since they already share the exact iframe pattern this spec removes elsewhere.
4. **Renaming "Accounting."** Explicitly kept as-is this round (open item from prior discussion, resolved: no rename).

---

## 1. Prerequisite — kill the iframe-per-tab loading pattern

### 1.1 Problem, confirmed against source

Three surfaces currently load report content into a `<iframe src="about:blank">` whose `src` is rewritten to `report?type=X` on selection — a full nested-document navigation, not a fragment fetch:

| Surface | File | Mechanism |
|---|---|---|
| Payables → Aging/Control tabs | `api/src/pages/payables.js:415-422,466-471` (`loadReportFrame`) | `#aging-frame`/`#control-frame` iframe `src` set per tab switch |
| Statements / Books report picker | `api/src/pages/reports-hub.js:76` (`#report-frame`) | Single iframe, `src` set per `<select>` change |

Every switch pays full page-load cost: a new HTTP round trip, a full server-side render (query → HTML string via `reports/render.js`), and a full re-parse of that document's own embedded `<head>`/`commonStyle()` CSS — with no client-side caching, so revisiting a tab you already loaded this session re-does all of it. This is the "I don't like that feeling" reported on Payables (2026-08-29 session), and it is about to be multiplied: Statements moving to a 4-tab strip and Journal (§3.2) keeping 4 report tabs means up to 8 more of these full-navigation loads across two pages that don't have it today, on top of Payables' existing 2.

### 1.2 Fix direction

Replace iframe navigation with `fetch()` of the report fragment, injected into a plain `<div>` in the host page (same DOM, same stylesheet — no nested document, no duplicate `<head>` parse). Cache the fetched fragment per tab for the session (in-memory JS object keyed by report type + the query params that affect it — period/start/end/asOf — is sufficient; no need for `sessionStorage` durability here, this is a perf cache, not navigation state). A tab switch back to an already-fetched combination renders from cache instantly; a param change (period, date range) invalidates that tab's cache entry.

This requires `reports/render.js`'s report builders to be reachable as a fragment response (table HTML without the surrounding `<!DOCTYPE html>`/`<head>`/`commonStyle()` shell) — check whether `report?type=X` already supports a fragment mode (e.g. an `&embed=1` param) before assuming new server work; if it doesn't, that's the one required server-side change here, otherwise this is client-side only.

**This is a blocking prerequisite for §3.1 and §3.2** — do not build the Statements tab strip or the Journal page's tab strip on the current iframe mechanism; that would ship the exact problem being fixed, at greater multiplicity.

---

## 2. Route registry changes (`api/src/nav-registry.js`)

| Key | Route | Label | gKey | Change |
|---|---|---|---|---|
| `statements` | `/:company/statements` | Statements | `t` | unchanged route/label/gKey — picker becomes a tab strip (§3.1), content unchanged |
| `journal` | **`/:company/journal`** *(renamed from `/:company/books`)* | **Journal** *(renamed from Books)* | **`j`** *(was `b`)* | Tabs relabeled, Integrity removed (§3.2) |
| `accounting` | `/:company/accounting` | Accounting | `a` | unchanged route/label/gKey — gains a 5th tab (§3.3) |

**Route path change, confirmed.** `/:company/books` is deleted, not redirected — per IA2's clean-cutover doctrine (§2.3 of that spec: single-user install, no bookmarks to preserve). `/:company/journal` is the sole route from the moment this ships; any internal link still pointing at `/books` (nav-registry consumers, `action-catalog.js` palette entries if any reference it, `common.js`'s `topBarContext` key map per IA2 §2.6's precedent) must be updated in the same change, not left to 404.

### 2.1 CRITICAL — an existing `/:company/journal` route already exists and must be deleted

`api/src/reports.js:261-265` currently registers `/:company/journal` as a 302 redirect to `/books?t=voucher-register`, left over from an earlier dissolution of a standalone Journal page into the Books hub:

```js
app.get('/:company/journal', function(req, res) {
  res.redirect(302, '/' + req.params.company + '/books?t=voucher-register');
});
```

This handler must be **deleted and replaced** with the real page handler for the renamed Journal page — not left alongside it (Express would just use whichever is registered first; leaving both is a guaranteed source of "why doesn't my page load" confusion, not a silent conflict).

`/:company/journal/voucher` (`reports.js:265`, `handleJournalVoucherPage`) sits immediately after it. **Correction to an earlier draft of this finding:** Express's default route matching is exact-segment (`path-to-regexp` compiles `/:company/journal` to match only a two-segment path), so it will **not** match the three-segment `/:company/journal/voucher` regardless of registration order — there is no actual swallow risk here with plain string routes as written today. Worth keeping the general habit of registering more specific paths first as a defensive precaution (in case the new page handler ever grows a wildcard/catch-all for its own tab sub-paths), but it is not a live ordering bug as things stand.

### 2.2 `/:company/bank` — confirmed dead code, recommend deletion rather than repointing

`reports.js:276-278` redirects `/:company/bank` to `/books`, which would 404 once `/books` is deleted. Traced further: nothing reachable actually links to `/bank` today. The only two live references are hardcoded `<a href="/${co.company_id}/bank...">` cards in `api/src/pages/company.js:147,152` — but `handleCompanyPage` (that file's export) is **imported in `reports.js:18` and never registered on any route**, i.e. it's already unreachable dead code left over from Dashboard being dropped (roadmap §0y, 2026-08-03: "Inbox is now the root route"). One of that same dead page's other cards links to `/settings?tab=periods`, also a dead route since IA2 slimmed Settings and explicitly deleted that redirect handler — confirming the whole block predates both migrations and was never cleaned up.

**Recommendation:** delete `reports.js:276-278`'s `/bank` redirect and the dead `company.js` dashboard-card block outright (standing rule 6 — dead code deleted, not commented/repointed). There is no live target to repoint it to; `bank.match`/`bank.reconcile.*` server actions remain in `api/src/bank.js` for the agent pipeline and are unaffected either way.

### 2.3 `fb-core.js` — hardcoded `/books` path-string checks

`api/public/fb-core.js:1137` (`_pageLabelFor()`) and `:1153` (`showTargets()`) string-match on the route path rather than reading the registry key:

```js
if (route.indexOf('/books') === 0) return 'Books';           // :1137
if (meta.route.indexOf('/books') === 0) return;               // :1153, excludes Books from something (needs checking what)
```

Changing `nav-registry.js` does not auto-fix these — both need `/books` → `/journal` and the returned label `'Books'` → `'Journal'` as an explicit, separate edit in the same change.

**`g b` is freed** by this rename and currently has no reservation — same status as `g m`/`g v`/`g d` per IA2's g-key slate comment. Not claimed by this spec.

---

## 3. Section definitions

### 3.1 Statements (`/:company/statements`) — dropdown → tabs

Mechanism-only change, per §1's prerequisite. Same four entries, same order, now rendered as a visible tab strip (`h`/`l` cycles, matching Payables/Accounting's existing tab pattern) instead of a `<select>`:

`Profit & Loss` · `Balance Sheet` · `Cash Flow` · `Statement of Equity`

No relabeling, no reordering, no `REPORT_REGISTRY` id changes.

**MoM/YoY step controls stay on this page's tabs only**, driven per-tab by each entry's existing `multiperiod` flag (`pl`/`bs`/`cf` = true, `sce` = false — unchanged data, already correct in `report-registry.js`). This is a page-level guarantee as much as a per-report one: the Journal page (§3.2) never renders MoM/YoY chrome at all, on any of its four tabs — worth stating explicitly now that both pages share the same tab-strip mechanism, so an implementer doesn't assume symmetric chrome across the two pages by default.

### 3.2 Journal (renamed from Books) — dropdown → tabs, relabeled, Integrity Check removed

| New tab label | `REPORT_REGISTRY` id | Old Books label |
|---|---|---|
| Transactions | `voucher-register` | Transaction Register |
| Line items | `journal` | Journal Line Listing |
| Trial Balance | `tb` | Trial Balance *(unchanged)* |
| General Ledger | `gl` | General Ledger *(unchanged)* |

Only the label strings change for the first two; `REPORT_REGISTRY` ids, routes, and underlying builders (`buildVoucherRegister`, `buildJournal`) are untouched.

**No MoM/YoY chrome on this page** — all four tabs are already `multiperiod: false` in `report-registry.js`; this is confirmed unchanged data, restated here as an explicit page-level contract (§3.1).

**`integrity` is removed from this page's tab list** and from `reportsByPage('books')`'s effective output for Journal — it relocates to Accounting (§3.3). `report-registry.js`'s `REPORT_REGISTRY` entry for `integrity` needs its `page` field changed away from `'books'` — see §3.3's open question on whether it stays in `REPORT_REGISTRY` at all.

**SIE export moves here, stays here — not Fiscal → Filings.** `reports-hub.js:30`'s `sieExportEnabled` gate (`pageKey === 'books'`) needs its literal updated to `'journal'` — a required change regardless of the placement debate. But the placement itself was actively re-litigated: `ia-restructure-2-spec.md` §3.3 states regulatory documents including SIE 4 export should surface "exclusively through the Filings tab" — never implemented in code (the SIE button has only ever lived on the Books hub) and, on reconsideration, wrong for SIE specifically. **Decision (2026-08-30, after pushback):** SIE is an anytime data export of the ledger (IB/UB/RES/VER — the same voucher/balance data as this page's other three tabs), not a filing tied to a due date or a submission workflow the way VAT return/INK2/Annual Report are — those stay Filings-exclusive per IA2, unchanged. SIE belongs with the ledger content it exports, i.e. **Journal**, not Accounting (nothing on Accounting's tabs is transactional data) and not Fiscal → Filings (no filing-workflow fit). Keep it as page-level chrome, visible regardless of which of the four tabs is active — same behavior as today, just re-gated on `'journal'` instead of `'books'`.

### 3.3 Accounting (`/:company/accounting`) — gains an Integrity tab

**Tabs (default: Chart of Accounts):** Chart of Accounts · Tax Codes · Journals · Cost/Profit Centers · **Integrity**

Tab label is **"Integrity"**, not "Integrity Check" — shorter, and the tab strip context (a page of ledger-structure tabs) already implies "check." This is the tab label only; whether `REPORT_REGISTRY`'s `integrity` entry's own `label` field ("Integrity Check", used elsewhere e.g. command palette) also changes to match is a separate, smaller call — recommend renaming it too for consistency rather than carrying two names for the same check, but not fixing that decision here.

Rationale (from discussion): Integrity validates exactly this page's contents (COA structure, journal balance) and is fixed by the same person doing COA/Journals work; it's quiet by default (no dot) unless a check fails.

**Rendering mechanism — deliberately not an iframe.** `ia-restructure-2-spec.md` §5.2 already establishes Accounting's contract as "FB.list on every tab" — no iframe exists on this page today, and embedding the Integrity report via iframe would both break that established pattern and reintroduce the exact loading problem §1 removes elsewhere. Integrity's output is a small, static (no period picker beyond the page-level date context), read-only result set — well suited to a direct `fetch()` of the check results rendered into a plain table by the Accounting page's own script, consistent with §1's fragment-fetch direction. **This is not FB.list** (there's nothing to edit/add/delete — it's a report, not a register), so it's a third rendering mode on this page (FB.list ×4, plain fetched table ×1), which should be stated explicitly in the page's implementation, not left implicit.

**Open question, not resolved here:** does `integrity` stay in `REPORT_REGISTRY` (with `page` repointed, e.g. to a new value or `null` if the registry's `page` field is meant to only describe report-hub pages) so `report?type=integrity` remains independently reachable (e.g. for the command bar, or a future non-Accounting consumer), or does it come out of the registry entirely and become bespoke Accounting-page code? Recommend keeping it in `REPORT_REGISTRY` — the registry is the single declarative report list (per its own header comment) and other consumers (command palette, export adapters) may still want `integrity` addressable by id — but flagging since IA2's registry `page` field currently only has two values (`'statements' | 'books'`) and a third page consuming a registry entry outside the report-hub shell is new.

**Indicator — dot only, no periodic nag (§0 item 1).** Reuse the existing tab-dot mechanic already on Accounting's other four tabs (`#tab-dot-coa` etc., `accounting.js:53-56`) to signal a failing check. **Flag, not resolved:** on the other four tabs, that dot means "you have unsaved edits in this tab" (`markDirty`/`resetDirty`, `accounting.js:101-108`). Reusing the same visual for "this check is failing" is a different semantic riding the same mechanism — a dot on Integrity doesn't mean "unsaved," it means "attention needed." Cheap to ship as-is (same CSS, same DOM pattern, no new component), but if it causes confusion in practice, the two meanings should get visually distinct treatments (e.g. a status-colored dot vs. the existing amber dirty-dot) — not committing to that now, just flagging so it isn't a surprise later.

---

## 4. What does not change

- Fiscal, Payables, Settings, Exchange Rates, Inbox, Documents, Calendar — untouched by this spec (Payables inherits §1's mechanism fix only). Fiscal → Filings specifically does **not** gain SIE export (§3.2) — VAT return/INK2/Annual Report remain its only artifacts, per IA2, unchanged.
- The check logic, tolerances, and current-year-profit adjustment inside `integrity()`/`integrity_extended()`/`buildIntegrity()`.
- `REPORT_CATEGORIES`/`category` optgroup machinery in `report-registry.js` — already noted in that file's own comment as "retained for backward compat but no longer drives optgroups." This spec doesn't touch it, but removing `integrity`'s Books placement makes the Books/Journal category grouping even more vestigial than it already was; a future cleanup pass could drop `REPORT_CATEGORIES` outright once nothing reads it, but that's not this spec's job.

---

## 5. Open questions / deferred (parking lot)

1. **Periodic Integrity nag** — deferred per §0 item 1. Needs its own spec: a scheduled evaluator + Inbox item, modeled on the existing `period_unclosed` Class B pattern.
2. **Dot semantic collision** (dirty-tab vs. check-failed) — flagged in §3.3, not resolved. Ship as one mechanism for now; revisit if it's confusing in practice.
3. **Whether `integrity` stays in `REPORT_REGISTRY`** — flagged in §3.3, leaning toward "stays, with `page` field's contract loosened," not decided.
4. **Whether `REPORT_REGISTRY`'s `integrity.label` ("Integrity Check") is also renamed to "Integrity"** for consistency with the new tab label — recommended in §3.3, not fixed as a requirement.
5. **Whether `report?type=X` already supports a fragment/embed response mode** — needs checking against `reports/render.js` before scoping §1 as client-only vs. requiring a server change.

---

## 6. Changelog

| Date | Change |
|------|--------|
| 2026-08-30 | Spec drafted per design-review discussion (2026-08-29–30 session): iframe-per-tab loading identified as a shared perf problem across Payables/Statements/Books and set as a blocking prerequisite (§1); Statements' dropdown becomes a tab strip (§3.1); Books renamed Journal, tabs relabeled, Integrity removed (§3.2); Accounting keeps its name and gains an Integrity tab rendered inline via fetch (not iframe), with a reused dirty-tab-dot indicator and no periodic nag for now (§3.3). Status: PROPOSED, pending ratification. |
| 2026-08-30 | Round 2 applied: (1) MoM/YoY step controls confirmed Statements-exclusive — stated as an explicit page-level contract on both Statements (§3.1) and Journal (§3.2), though the underlying `multiperiod` data was already correct and unchanged; (2) Accounting's new tab renamed **"Integrity"** (was "Integrity Check") throughout, with a new open question (§5 item 4) on whether `REPORT_REGISTRY`'s own `integrity.label` follows suit; (3) the route-path question is resolved, not deferred — `/:company/books` is deleted outright and replaced by `/:company/journal`, no redirect, per IA2's clean-cutover doctrine; removed from the open-questions parking lot. |
| 2026-08-30 | Round 3 applied, external code review against actual source (findings verified, not taken on faith): (1) **CRITICAL** — an existing `/:company/journal` 302-redirect handler (`reports.js:261-265`, left over from an earlier Journal→Books dissolution) collides with the new route and must be deleted, not left alongside the new page handler (§2.1); corrected the review's route-ordering claim — Express's exact-segment matching means `/:company/journal/voucher` was never actually at swallow risk regardless of registration order; (2) traced `/:company/bank`'s dead redirect (`reports.js:276-278`) to its only live referrer, `company.js:147,152` — itself unreachable dead code (`handleCompanyPage` is imported but never routed, orphaned since Dashboard was dropped 2026-08-03) — recommend deleting both rather than repointing either (§2.2); (3) `fb-core.js:1137,1153`'s hardcoded `/books` string checks added as a required, separate edit — changing `nav-registry.js` does not auto-fix them (§2.3); (4) **SIE export placement re-litigated and reversed:** pushback rejected the Filings-exclusive framing (SIE is an anytime ledger export, not a filing workflow) — decision is **Journal**, not Accounting or Fiscal → Filings; this explicitly supersedes IA2 §3.3's SIE-specific claim (its VAT return/INK2/Annual Report Filings-exclusivity rule is untouched) (§3.2, header Companions line). |
