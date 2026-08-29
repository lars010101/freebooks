# freebooks — Fiscal/Filings Lifecycle Spec: Submission Status, Due-Date Overrides, Tax-Attribute Carryforward

**Date:** 2026-08-28 · **Status:** PROPOSED
**Scope:** Give the Fiscal page's Filings tab (`api/src/pages/fiscal.js`) a real write surface: mark a filing instance submitted (with a frozen, audit-safe copy of what was actually filed), unmark it, override its due date, and record year-over-year tax attributes that currently have no capture path anywhere in freeBooks (INK2 loss carryforward, periodiseringsfond tranche schedule, Annual Report governance facts). Documentation only — no code changes ship with this spec; it is the design for a later implementation pass.
**Companions:** `docs/reports-dashboard-spec.md` (§5–6 froze the in-app Annual Report renderer 2026-07-30 — *"read-only viewer only, no further development... Gredor owns SE årsredovisning production/submission via the SIE 4 export"* — and explicitly deferred *"Submission-status tracking comes later, on top of the registry."* This spec is that deferred work), `docs/ia-restructure-2-spec.md` (§3.3 — the Filings tab as it exists today: a pure rename of the old "Deadlines" tab, flat, no write surface).
**Consumers:** `api/src/periods-page-service.js` (new actions, `filing.list` extensions), `api/src/filings.js` (extracted lock-check helper, reused compute/emit functions), `api/src/action-catalog.js` (new catalog entries), `api/src/index.js` (`period.list` bug fix), `api/src/attachments.js` (reused unchanged — generic entity-keyed attachment store), `api/src/pages/fiscal.js` (UI), `db/jurisdictions/SE/filings/{ink2,annual-report}.json`, `db/jurisdictions/SG/filings/annual-report.json`.

---

## 0. Explicitly out of scope

1. **3:12/K10 per-shareholder tax tracking** (`sparat utdelningsutrymme` / saved dividend allowance, `omkostnadsbelopp` / share acquisition cost, wage-based `gränsbelopp` inputs). freeBooks has no shareholder/cap-table data model at all today — no ownership percentages, no per-owner records of any kind. Building correct 3:12 carryforward needs that model first; it is a separate, materially larger project and is not designed here.
2. **Wiring periodiseringsfond tranches into INK2 tax computation.** This spec adds *tracking* (amount, origin year, 6-year statutory reversal deadline, reversed flag) so the schedule isn't lost, with a UI warning when a tranche is due to reverse. It does not add periodiseringsfond box codes to `ink2.json`'s `fields` map or otherwise change what SRU output computes — that's a tax-correctness change deserving its own review, not a byproduct of a status-tracking feature.
3. **Deleting `report-composite.js` or the `report?type=ar` route.** The Annual Report's live in-app view stops being *linked* from the Filings tab, but the renderer and its jurisdiction-pack template data are left in place, unused-but-harmless. Deleting working code is a separate, explicit cleanup call, not bundled here.
4. **VAT-period-level locking.** freeBooks models one `locked` flag per fiscal-year period row; VAT reporting intervals (`vatIntervalsFor()`) are computed sub-slices of that one row, not separate lockable entities. This spec does not add sub-period locking (see §6).

---

## 1. Problem statement

1. **No submitted-status write path exists.** `filing.list` (`api/src/periods-page-service.js`) computes `state: 'filed' | 'draft'` by reading `periods.tax_attrs.filings[key].filed_at` (line ~156, ~186), but nothing anywhere ever writes to that key. The Filings tab has always been read-only in practice, not just in the "v1" label the code comments it with.
2. **Live-recompute vs. frozen-submission integrity gap.** `blanketter.sru`, `INFO.SRU`, and the VAT-return HTML view are all recomputed live from ledger data on every click (`api/src/filings.js` `handleSruInk2`/`handleSruInfo`; `api/src/reports.js` lines 86–113 for `type=vat-return`). If a filing is ever marked submitted from a bare status flag, a later ledger edit in that period would make "download" produce different bytes than what was actually filed — an audit-integrity risk, not just a UX gap. The fix is structural: submission must snapshot the exact bytes, not just flip a boolean.
3. **Due-date overrides have no write path, and the read path has a cross-year key collision.** `deadline_overrides` (a `settings` table JSON blob) is already read by `filing.list` (line ~154, ~184: `overrides[key] || computeDueDate(...)`) but nothing writes it, and for `fiscal_year`-kind filings (INK2, Annual Report) the lookup key is the bare descriptor id (`"ink2"`) — identical across every fiscal year. An override meant for one year's INK2 due date would silently apply to *every* year's INK2. (`vat_period`-kind filings already use a unique key, `${d.id}@${iv.start}` — no collision there.)
4. **The Annual Report will no longer be produced by freeBooks.** Per business-process decision: Gredor (external, open source) produces the actual filed PDF. freeBooks needs an upload + submitted-status flow for it, replacing the in-app live view as the tab's Annual Report artifact.
5. **INK2 needs a PDF-submission alternative to SRU.** Skatteverket accepts INK2 either as SRU e-filing or paper/PDF submission. The primary workflow is SRU-only, but supporting the alternative is low-cost if designed in from the start.
6. **Two pieces of year-over-year tax continuity data are designed for but never actually captured**, discovered while auditing what's at risk if Gredor becomes unavailable:
   - **INK2 loss carryforward** (`tax_attrs.loss_cf`) — `computeFiling` (`api/src/filings.js` lines 204–219) already reads `periodAttrs.loss_cf` as the opening loss for the year, with a manual `?loss_cf=N` URL override as the only alternative. Nothing ever writes the *computed closing loss* forward into next year's period, so today it must be retyped by hand every year from the prior INK2S line 7770.
   - **Periodiseringsfond tranches** — the balance sheet carries only the *aggregate* untaxed-reserve balance (accounts like 2153); there's no record anywhere of which year each tranche was set aside or its 6-year statutory reversal deadline. That breakdown is unrecoverable from ledger data alone once memory of it fades.
   - Investigating this further into full 3:12/K10 shareholder tracking was considered and explicitly ruled out of scope (§0.1) — it needs a shareholder data model freeBooks doesn't have.
7. **A latent bug would make any of the above unsafe to build on the existing client-side write pattern.** `period.list` (`api/src/index.js` lines 1703–1714) selects `tax_attrs` in its SQL but drops it from the mapped response. The Close Checklist's `~`-attest toggle (`api/src/pages/fiscal.js` lines 268–292, `toggleCheck()`) already depends on reading `p.tax_attrs` from this action, always gets `undefined`, and so every attestation write replaces the *entire* `tax_attrs` column with a single-item object — silently erasing any other checklist item's attestation (and would erase `filings`/`loss_cf`/etc. too, if new code reused this pattern). This must be fixed before anything else in this spec is built, and independently fixes an existing shipped-feature bug.

---

## 2. Data model

No schema changes. Everything lives in the existing `periods.tax_attrs` VARCHAR/JSON column (`db/schema.sql` line 634) and the existing `settings` table's `deadline_overrides` JSON row.

```jsonc
// periods.tax_attrs, per fiscal-year period row
{
  "checklist": { "...": true },              // existing, unchanged
  "filings": {
    "<filingKey>": {
      "filed_at": "2026-08-28T12:00:00Z",
      "method": "sru" | "pdf" | null,          // null for filing kinds with no file artifact (e.g. vat-return)
      "attachment_ids": ["<uuid>", "..."]
    }
  },
  "loss_cf": 0,                                // INK2 opening loss for THIS period (auto-carried from prior year's closing loss, or manually overridden)
  "periodiseringsfond": [
    { "year": 2024, "amount": 50000, "reversed": false }
  ],
  "ar_facts": {                                // Annual Report governance facts — see §2.1 for who actually reads this
    "board_members": [{ "name": "...", "role": "..." }],
    "shares_total": 50000, "quota_value": 1,
    "proposed_dividend": 0,
    "employees_avg": 0, "employees_men": 0, "employees_women": 0,
    "salaries_total": 0, "salaries_board": 0, "social_total": 0, "pension_total": 0,
    "pledged": "", "subsequent": "", "verksamhet": "", "handelser_ar": ""
  }
}
```

### 2.1 What actually reads `ar_facts`

Named explicitly because leaving it implicit is exactly how a data store ends up with no consumer: **the Fiscal page's own "Facts ▸" expand-row (§9) is the only reader.** There is no export path, no Gredor-ingestible format, and no automated consumer — that's a deliberate scope boundary, not an oversight. The purpose is narrower than "feed the annual report pipeline": it's a human-readable, human-editable record of the governance facts that currently exist only as one-time hardcoded values in `db/jurisdictions/SE/filings/annual-report.json`'s `variants.K2.facts` block (§0.3 leaves that file in place, unused by any renderer after this spec). If Gredor is ever unavailable, the resilience value is that a person can open the Facts panel and manually re-enter board members/share capital/dividend figures into whatever replaces it — not that any system automatically produces a filing from this data. If a real export/ingestion path is wanted later, that's a follow-up spec with a named consumer on the other end, not something to half-build here.

**`filingKey` — the fix for the cross-year collision (§1.3).** Standardize one globally-unique key everywhere a filing instance needs identifying (filed-state storage, due-date overrides, attachment `entityId`):
- `vat_period` kind (VAT return): `${descriptor.id}@${interval.start}` — unchanged, already unique.
- `fiscal_year` kind (INK2, Annual Report): `${descriptor.id}@${period.period_name}` — **new**, replaces the bare `descriptor.id` used today.

`filing.list` must expose this as a `key` field on every returned row so the client never reconstructs it (avoids drift between client and server key logic).

`deadline_overrides` (existing `settings` row, `key='deadline_overrides'`, `value` = JSON `{ "<filingKey>": "YYYY-MM-DD" }`) needs no shape change — only the corrected, collision-free keys.

---

## 3. Prerequisite: fix `period.list`

`api/src/index.js` lines 1703–1714 — add `tax_attrs: r.tax_attrs ? JSON.parse(r.tax_attrs) : {}` to the mapped row. One line. This must land before any of §4's actions are built if they end up reusing a client-round-trip pattern anywhere, and it retroactively fixes the Close Checklist data-loss bug described in §1.7 regardless.

To avoid depending on the client round-trip at all for the new writes, §4's actions each do their own atomic server-side read-modify-write (below), rather than the "fetch full list client-side, patch, re-upsert whole period" pattern the checklist currently (buggily) uses.

**Shared helper**, new in `api/src/periods-page-service.js`: `patchPeriodTaxAttrs(companyId, periodId, patchFn)` — fresh `SELECT tax_attrs FROM periods WHERE company_id=@c AND period_name=@p`, `JSON.parse`, `patchFn(taxAttrs)` (mutates in place), `UPDATE periods SET tax_attrs=@json, updated_at=@now WHERE company_id=@c AND period_name=@p`. Three of §4's four actions route through this.

**Sibling helper** for `filing.set_due_override`: `patchDeadlineOverrides(companyId, patchFn)` — same shape, scoped to the `deadline_overrides` settings row: fresh `SELECT value FROM settings WHERE company_id=@c AND key='deadline_overrides'`, `JSON.parse` (or `{}` if the row doesn't exist yet), `patchFn(overrides)` (mutates in place), then upsert the row back (`UPDATE`/`INSERT` on existence, same as `settings.save`'s per-row branch). This is **not** the same guarantee `settings.save` provides: `settings.save` upserts atomically *per settings row* (`api/src/index.js` lines 1804–1811, keyed on `key`), which protects `deadline_overrides` from being clobbered by writes to *other* settings keys — but `deadline_overrides` itself is one row whose *value* is a JSON map of every filing's override. Two concurrent `filing.set_due_override` calls for two different filing keys would each `SELECT` the same blob, patch a different key, and `UPDATE` — last write wins, silently dropping the other edit. That is exactly the same clobber class §1.7/§3 fixes for `tax_attrs`, just one level down (inside a row's value instead of across rows), so it gets the same atomic-read-modify-write treatment via its own dedicated helper, not the bare `settings.save` per-row pattern.

---

## 4. New actions

All new actions live in `api/src/periods-page-service.js` (`handlePeriodsService`, alongside the existing `filing.list`/`period.close_check`), cataloged in `api/src/action-catalog.js` next to the existing `filing.list` entry (line ~352). Role `owner`, `mutating: true`, **no** `agentWritable` flag on any of them — matches `period.upsert`'s human-only posture (the existing R2 doctrine: agents never lock or finalize a filing).

| Action | Params | Behavior |
|---|---|---|
| `filing.mark_submitted` | `{ periodId, key, method: 'sru'\|'pdf', attachmentId? }` | See §5/§6. Writes `taxAttrs.filings[key] = { filed_at, method, attachment_ids }` via `patchPeriodTaxAttrs`. For `key` starting `ink2@...`, also runs the loss-carryforward step (§7). Emits `filing.submitted`. |
| `filing.unmark_submitted` | `{ periodId, key }` | Deletes `taxAttrs.filings[key]`. Attachments are **never** deleted (audit trail). Emits `filing.unsubmitted`. Exists so a mistaken submit is correctable without touching attachment history. |
| `filing.set_due_override` | `{ key, dueDate }` | `dueDate: null` clears. Via `patchDeadlineOverrides` (above): `overrides[key] = dueDate` or `delete overrides[key]`. |
| `filing.save_period_attrs` | `{ periodId, patch: { loss_cf?, periodiseringsfond?, ar_facts? } }` | Via `patchPeriodTaxAttrs`. Each provided top-level key is replaced **wholesale**, except `ar_facts`: `loss_cf` — scalar, replace. `periodiseringsfond` — **full array replace**, not merged/appended; a caller wanting to edit one tranche must send the complete array back (the client-side editor in §9 always holds and resubmits the full list, so this is natural there — flagged here so a future server-side caller doesn't shallow-merge an array and produce a spliced/partial one). `ar_facts` — the one exception: shallow-merged key-by-key, so a partial edit (e.g. just `proposed_dividend`) doesn't clobber the other facts. Write path for manual loss-carryforward correction, periodiseringsfond tranche edits, and the Annual Report facts form. |

---

## 5. Submission mechanics: snapshot, don't just flag

**`method: 'sru'`** (INK2 only) — `filing.mark_submitted` calls `computeFiling`, `loadDescriptor`, `loadEmitter`, `loadContact`, `validateSruContact` **directly** (already exported from `api/src/filings.js`; no HTTP round-trip), producing byte-identical output to what `handleSruInk2`/`handleSruInfo` would generate right now. Runs the same `validateSruContact` gate the download route uses (400 on missing required contact fields). Stores the resulting `blanketter.sru` and `INFO.SRU` text as two separate attachments via `storeAttachment()` (`api/src/attachments.js`, unchanged) — `entityType: 'filing', entityId: key`. Both `attachment_id`s go into `taxAttrs.filings[key].attachment_ids`.

**`method: 'pdf'`** (INK2 alternative, Annual Report only option) — the client uploads the PDF *first*, through the existing generic `attachment.upload` action (`entityType: 'filing', entityId: key` — no new upload action needed; `api/src/attachments.js` already handles storage, sha256 dedupe, and serving). `filing.mark_submitted` then takes the resulting `attachmentId`, verifies it exists and belongs to this company + entity, and records it.

Either way, once submitted, the Filings tab should link to the **frozen attachment**, not the live-recompute route — "what we filed" stops silently drifting if the ledger changes afterward.

---

## 6. Period-locked precondition — scope decision

`api/src/filings.js` already gates SRU generation on the period being locked (P2-1: `handleSruInk2` lines 349–356, `handleSruInfo` lines 396–407 — `409 PERIOD_NOT_LOCKED` if `!locked`), using a hardcoded `'FY' + year` period-name convention.

This spec generalizes that gate to `filing.mark_submitted`, scoped by `period_kind`:
- **`fiscal_year`-kind filings (INK2, Annual Report): locked required.** Both are year-end closing documents; extending the existing INK2 precedent to Annual Report is a natural, low-risk generalization, not a new policy.
- **`vat_period`-kind filings (VAT return): locked NOT required.** VAT returns are filed periodically throughout the fiscal year, always well before year-end close — requiring the whole fiscal-year period to be locked first would make VAT-return submission impossible for most of the year. freeBooks also has no separate, lockable "VAT period" concept today (§0.4) — only whole fiscal-year periods carry a `locked` flag.

Implementation detail: extract the duplicated lock-check in `handleSruInk2`/`handleSruInfo` into a shared `isPeriodLocked(query, companyId, periodName)` helper in `api/src/filings.js`, reused by both the existing routes (unchanged behavior, unchanged `'FY'+year` convention) and the new action (which instead uses the `periodId` the client already has from `filing.list`, rather than reconstructing it — more robust, but the existing routes' convention is left as-is, out of scope to fix here).

---

## 7. Loss-carryforward auto-fix

Part of `filing.mark_submitted` when `key` is `ink2@...` and `method` succeeds: scan `computed.descriptor.fields` (the loaded `ink2.json`) for the entry with `op === 'loss_closing'`, read the computed value at `computed.fields[thatBlankett][thatCode]` — this is the year's closing loss.

**The field is conditionally absent, not always present.** `filings.js` line 231 only sets it `if (closing > 0)` — when this year's taxable result fully absorbs the opening loss (`closing <= 0`), the field is `undefined`, not `0`. Treat `undefined` the same as `0`: there is genuinely no loss left to carry. Do **not** interpret "absent" as "skip the write" — that would leave next year's `loss_cf` at whatever stale value (or none) it already had, which is wrong once this year's filing has determined the loss is fully used up. So: `const closingLoss = computed.fields[blankett][code] || 0;` and always proceed to the next step with that value.

**Only if next fiscal year's period row already exists** (never auto-create a period), `patchPeriodTaxAttrs` that next period to set `loss_cf` to `closingLoss` (which may be `0`). If the next period doesn't exist yet, skip the whole step silently — the figure carries once that period is created and this year's filing is (re-)marked submitted, or via the manual `filing.save_period_attrs` override.

---

## 8. Jurisdiction pack changes

- `db/jurisdictions/SE/filings/ink2.json`: add `"methods": ["sru", "pdf"]`.
- `db/jurisdictions/SE/filings/annual-report.json`, `db/jurisdictions/SG/filings/annual-report.json`: add `"methods": ["pdf"]`. `variants`/`facts`/`notes` template blocks are left in place, unused by any route after this change (§0.3) — not deleted.
- `db/jurisdictions/SE/filings/vat-return.json`: unchanged.
- `tests/jurisdiction-packs.mjs` does not whitelist descriptor fields — `methods` needs no linter change, but the suite should be re-run to confirm.

In `listFilings()` (`api/src/periods-page-service.js`, the `annual-report` branch around lines 170–178): remove the `{ kind: 'view', label: 'View annual report', href: '.../report?type=ar...' }` artifact. **Keep the SIE 4 export artifact unchanged** (same branch, gated on `integrations.sie.export`) — it's the ledger→Gredor handoff format (per `docs/reports-dashboard-spec.md` line 41/48), unrelated to the in-app PDF renderer being dropped.

---

## 9. Frontend — `api/src/pages/fiscal.js`

- `loadFilings()`: use the server-exposed `f.key` everywhere; no client-side key reconstruction.
- Per-row actions cell, extending the artifact-link rendering already in place:
  - **Submitted rows:** "Filed" badge (existing) + link(s) to the frozen attachment(s) — `filing.list` should additionally return `f.submitted_attachments: [{attachment_id, filename}]`, sourced server-side from `taxAttrs.filings[key].attachment_ids` joined against `attachments`, so the client doesn't need a second round trip — + a small "Unsubmit" chip → confirms, calls `filing.unmark_submitted`.
  - **Draft rows:** `ink2` (methods sru+pdf) — existing SRU download chips stay; add "Upload PDF" (wired to `attachment.upload`, `entityType:'filing', entityId:f.key`) and "Mark Submitted" (infers method: uses a just-uploaded PDF if present, else submits via `sru` with server-side auto-snapshot). `annual-report` (pdf only) — "Upload PDF" + "Mark Submitted", no SRU option. `vat-return` — a lightweight "Mark Submitted" only (`method: null`, no file artifact to snapshot).
  - **Due date cell:** click-to-edit inline (small `<input type=date>` swapped in on click, styled with the `.dirty-val`/`.chip` conventions already in this file's CSS — a bespoke handler, since this table is hand-rolled HTML, not an `FB.list` grid like the Periods tab) → `filing.set_due_override` on save.
- New inline expand-rows (chip toggles a `<tr>` below — a fresh, small version of the idea behind `payables.js`'s `.preview-row`, since `fiscal.js` has no such row type yet). **Consistency debt, noted not fixed:** this makes a third distinct expand-row mechanism in the codebase (`FB.list`'s own row-expansion, `payables.js`'s hand-rolled `.preview-row`, now this one). Unifying them is a reasonable future cleanup but out of scope here — each existing one is already bespoke to its table's needs (`FB.list`'s is framework-owned; `payables.js`'s is hand-rolled HTML like this one), so a third small bespoke version is consistent with the status quo, not a new pattern:
  - **"Facts ▸"** on the `annual-report` row → form for `ar_facts` → `filing.save_period_attrs`.
  - **"Periodiseringsfond ▸"** on the `ink2` row → editable tranche list (year, amount, reversed checkbox), warning badge (reuse `.due-past` styling) when `year + 6 <= currentYear && !reversed` → `filing.save_period_attrs`. The manual loss-carryforward override field lives in this same panel.

---

## 10. Verification (for the implementation pass)

- `tests/jurisdiction-packs.mjs` must still pass after the `methods` field additions.
- `tests/sru-golden-2024.mjs` must stay byte-identical — `filing.mark_submitted`'s SRU snapshot path reuses `computeFiling`/`emitSru` unchanged, so this is the regression guard that the snapshot matches the download route exactly.
- Manual walkthrough: lock a period → mark an INK2 filing submitted via SRU → confirm two attachment rows (`attachment.list`, `entityType:'filing'`) and that the Filings row now shows Filed + links to the frozen copy, not the live route. Edit a due date on one year's INK2, confirm the *other* year's INK2 due date is unaffected (regression check for §2's key fix). Toggle Close Checklist attestations on two different items in the same period, confirm both persist (regression check for §3's fix).

---

## 11. Changelog

| Date | Change |
|------|--------|
| 2026-08-28 | Spec drafted from a business-process discussion (BLANKETTER.SRU/INFO.SRU generated by freeBooks, need SUBMITTED status; Swedish Annual Report dropped in favor of Gredor-produced PDF + upload; INK2 supports SRU or PDF; due dates need to be user-editable) plus a follow-up audit of what year-over-year tax continuity data would be at risk if Gredor became unavailable (loss carryforward, periodiseringsfond; full 3:12/K10 shareholder tracking considered and explicitly deferred — no shareholder data model exists). Status: PROPOSED, pending ratification. Documentation only; implementation held for a later pass. |
| 2026-08-29 | Review round applied, all findings verified against the actual code before fixing: (1) **§4 `filing.set_due_override` had the same clobber hazard §3 fixes for `tax_attrs`, one level down** — it claimed `settings.save`'s per-row upsert made a bare read-patch-write on `deadline_overrides` safe, but `settings.save`'s atomicity is per settings *row* (`api/src/index.js` lines 1804–1811), not per key *within* a row's JSON value, and `deadline_overrides` is one row holding every filing's overrides as a map — two concurrent calls for different filing keys would silently drop one. Fixed: new §3 sibling helper `patchDeadlineOverrides`, same atomic SELECT-parse-patch-UPDATE shape as `patchPeriodTaxAttrs`, §4's table corrected to reference it. (2) **§7's loss-carryforward read assumed the closing-loss field is always present** — verified `filings.js` line 231 (`if (closing > 0) fields[b][code] = closing`): the field is `undefined`, not `0`, whenever this year's result fully absorbs the opening loss. §7 now states this explicitly and specifies treating `undefined` as `0` (still write it forward, don't skip the carry-forward step — skipping would leave a stale value in place). (3) **§2's `ar_facts` had no defined consumer** — "record-keeping only, no renderer consumes this" left it unclear whether anything ever reads it back. New §2.1 names the Fiscal page's own Facts panel as the sole reader (human reference/re-entry if Gredor disappears, not an export/ingestion pipeline) and states explicitly that no automated consumer is in scope here. Minor: §9 now flags the expand-row pattern as a known third-mechanism consistency debt (not fixed); §4's `filing.save_period_attrs` row now states the `periodiseringsfond` full-array-replace vs. `ar_facts` shallow-merge asymmetry explicitly. |
