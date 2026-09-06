# freebooks — Calendar / Reminders / Documents: Fiscal IA Redesign Spec

**Date:** 2026-08-29 · **Status:** PROPOSED (documentation only — no code changes ship with this spec)
**Scope:** Replace the Fiscal page's Filings tab and the Periods tab's FX column with a simpler model, arrived at from a live UX-ideation session, and introduce a new top-level Documents page. Concretely: (1) rename Fiscal → **Calendar**, holding only Periods and a new **Reminders** tab; (2) drop the Periods grid's FX status column in favor of the notification bell, which already exists and already carries this exact signal; (3) replace the Filings tab's submission-tracking write surface (mark-submitted/unmark/due-override/save-period-attrs, SRU/PDF method branching, Facts/Periodiseringsfond expand-panels) with a flat Reminders list — jurisdiction-pack-imported + user-addable — carrying only a Done/Not-done status, with due-soon alerts routed through the existing notification bell; (4) add a new top-level **Documents** page: a single browsable list of every attachment in the system (bill/invoice/JV/filing attachments) plus arbitrary standalone uploads.
**Supersedes:** the Filings-tab portion of `docs/fiscal-filings-lifecycle-spec.md` (ratified 2026-08-29, shipped as `d5e60bf`) — reverted less than a day after ratification. Worth stating plainly rather than glossing over: that spec's submission-tracking machinery (frozen-snapshot integrity, per-filing-type method branching, lock-gating, loss-carryforward auto-fix) was built to solve a real problem (§1–§7 there), but using it surfaced that the complexity cost was higher than the value for how this app is actually used — a plain document archive plus a due-date reminder is enough. That spec's Periods-tab and Close-Checklist portions, and its `period.list` `tax_attrs` bug fix, are **unaffected** and stay as shipped.
**Companions:** `docs/fiscal-filings-lifecycle-spec.md` (superseded portion above), `docs/fx-automation-spec.md` (§6–§7 — the FX scanner and notification bell this spec reuses unchanged), `docs/ia-restructure-2-spec.md` (`nav-registry.js` gKey scheme this spec extends).
**Consumers:** `api/src/pages/fiscal.js` (rewritten/renamed), `api/src/pages/periods-grid.js` (FX column removed), `api/src/periods-page-service.js` (`filing.list` retired, `reminder.*` actions added), `api/src/action-catalog.js`, `api/src/nav-registry.js` (Calendar takes gKey `c`; company switcher moves to `g w` — see §2), `api/src/attachments.js` (extended for company-wide listing, `missing_since` column), `api/src/fx-scanner.js` (pattern reused, not modified), new `api/src/reminder-scanner.js`, new `api/src/attachment-integrity-scanner.js`, new `api/src/pages/documents.js`, `api/src/pages/inbox.js` (new orphaned-file review item kind — see §5.5), `db/schema.sql` (new nullable columns on `attachments`; new `orphaned_files` table).

---

## 0. Explicitly out of scope

1. **Corporate Records — implementation.** §8 now captures an agreed *concept* sketch (periodisation fund tranches, loss carryforward, dividend proposals/decisions, director appointments — dated governance facts, not filing paperwork), but no schema, actions, or UI are designed to a build-ready level here. A separate future spec owns turning §8 into something implementable. See §7 for what happens to the data already written by the superseded spec in the meantime.
2. **Close Checklist's permanent home.** Explicitly deferred throughout the ideation session ("tbc later"). This spec does not move, rename, or modify it — see §2.
3. **Multi-select / bulk delete**, anywhere in the app. Raised during ideation as a real gap (no list in the app supports acting on more than the focused row), explicitly shelved. Any future design for it is system-wide, not specific to Documents, and deserves its own spec given it's a new interaction mode (checkbox multiselect vs. a vim-style Visual range-select), not a one-page feature.
4. **Editing document attributes.** Explicitly ruled out. A user-uploaded document is deleted and re-uploaded, not edited in place; system-linked attachments are read-only from Documents regardless.
5. **VAT-period-level locking**, unchanged from the superseded spec's own §0.4 — still not modeled; out of scope here too.
6. **Documents ↔ Reminders/Periods cross-navigation.** Raised and explicitly rejected during ideation (in response to a "jump from a period row into its filings" idea proposed mid-session). The two surfaces share a Period column/selector for filtering but never link to each other.

---

## 1. Rationale

The Filings tab, as shipped by the superseded spec, models each filing as a strongly-typed object: a submission method (`sru`/`pdf`/`null`), a frozen byte-identical snapshot of what was filed, a lock-gate precondition, and type-specific expand-panels for year-over-year tax continuity data. That model is correct for an app that owns end-to-end tax filing production. It's the wrong shape for how this app is actually used: Gredor (external) produces the actual filed Annual Report PDF already (§1.4 of the superseded spec), and the INK2/VAT-return "submission" step is really just "I did the thing, here's proof if I want to keep it" — a fact a human attests to, not a state machine the software needs to enforce integrity over. Once the uploaded document *is* the record of what was filed, the frozen-snapshot machinery that existed to prevent live-recompute drift (superseded spec §5) has nothing left to protect against.

Separately, the FX status dot on the Periods grid (`periods-grid.js:43-49`, decorated client-side by `decorateFxStatus()` at `periods-grid.js:78-112`) turned out to be a second, redundant signal: `api/src/fx-scanner.js` already runs server-side on boot and every 6h (`FREEBOOKS_FX_SCAN_MS`, started unconditionally at `api/src/index.js:1986`), already computes the same coverage gaps, and already raises them into the notifications table (`raiseNotification`, `notifications.js:87-105`) that the topbar bell already polls and renders (`fb-core.js:3088-3157`). The grid column was UI built without noticing the equivalent signal already had a home.

---

## 2. IA changes

| Before | After |
|---|---|
| **Fiscal** (gKey `f`) — tabs: Periods · Filings · Close Checklist | **Calendar** (gKey `c`) — tabs: Periods · Reminders |
| Company switcher (gKey `c`) | Company switcher (gKey `w`) |
| *(no equivalent)* | **Documents** — new top-level sidebar entry, proposed gKey `d` (free per `nav-registry.js`'s own comment: *"g d / g j = still free"*) |

Close Checklist is **not** moved into Calendar and is **not** given a new home by this spec — it stays exactly where it is today, functionally unchanged, on the page this spec renames to Calendar, purely because no decision has been made about where it belongs (§0.2). This is a placeholder, not a design position.

**gKey reassignment.** Calendar takes over `g c` — decided deliberately, not a default: it's judged a more frequent, higher-value jump than the company switcher, which is single-user-install-typical low-frequency. The switcher moves to `g w` ("workspace switch," unused today, mnemonic in other multi-tenant tools for the same action). Mechanically low-risk: the switcher is explicitly "reserved, not a route" in `nav-registry.js` (handled as a special case in the g-map, not a `ROUTES` entry), so reassigning it doesn't touch the route table's palette/`dateRelevance` bookkeeping — only the two g-chord handler bindings change.

---

## 3. Periods tab

Remove:
- The `fx_status` column (`periods-grid.js:43-49`).
- `decorateFxStatus()` and its `fx.coverage` polling loop (`periods-grid.js:78-112`) and the `window._fxMissing` state it maintains.
- The call to `decorateFxStatus()` in `loadPeriods()` (`periods-grid.js:76`).

No backend change: `fx-scanner.js` and `notifications.js` are untouched and already do the entire job. This is a pure deletion.

---

## 4. Reminders tab (replaces Filings)

### 4.1 Concept

One flat list, two sources of rows:
- **System-imported** — one row per jurisdiction-pack filing descriptor × applicable interval, computed the same way `filing.list` computes them today (descriptor + `vatIntervalsFor`/period matching, `periods-page-service.js`). This is the existing due-date computation, kept; only the write surface around it changes.
- **User-added** — free-form reminders the user creates directly: a label and a due date, optionally tagged to a period.

### 4.2 What's removed from the superseded spec

Deleted entirely, both server and client:
- Actions `filing.mark_submitted`, `filing.unmark_submitted`, `filing.save_period_attrs` (`action-catalog.js:362-395`) and their handlers in `periods-page-service.js`.
- The SRU-vs-PDF method branching, the lock-gated precondition (superseded spec §6), and the loss-carryforward auto-fix (superseded spec §7).
- The Facts and Periodiseringsfond expand-row panels and their handlers in `fiscal.js` (`renderFactsPanel`/`facts-save`, `renderPfPanel`/`pf-add`/`pf-save`, roughly `fiscal.js:346-517` in the current file).
- The frozen-attachment-snapshot mechanics (superseded spec §5) — moot once a filing's "proof" is whatever the user optionally uploads to Documents, not a system-computed byte-identical copy.

**Kept, unchanged:** the read-only artifact/download chips per row (SRU/INFO.SRU download, SIE export) — these were always harmless, always read-only, and predate the superseded spec. They stay as a convenience action on a Reminder row, wired to the same routes as today, with no status implication.

`filing.set_due_override` survives in spirit but is subsumed into the reminder's own due-date field (§4.3) rather than being a separate override action — a Reminder's due date is just an editable field, not a computed value with a separate override layer, because there's no longer a computed "default" needing an override once the mark-submitted machinery is gone. (System-imported rows still get their *initial* due date from the jurisdiction pack's computed schedule; editing it after that is a plain field edit.)

### 4.3 Data model (proposed — for the implementation pass to confirm)

**Revised from this spec's first draft.** The original proposal split storage by row source — system-imported state in a settings-row JSON blob (`reminder_state`, mirroring `deadline_overrides`), user-added rows in their own table. A review pass correctly called that split architecturally inconsistent for no real gain: both row kinds carry the same fields (label, due date, done, optional period), so one table with a `source` column is simpler and avoids inventing a second clobber-prone JSON blob on top of the one (`deadline_overrides`) the superseded spec already had to fix.

```sql
CREATE TABLE IF NOT EXISTS reminders (
  reminder_id  VARCHAR    NOT NULL,   -- the filingKey for system rows; a generated id for user rows
  company_id   VARCHAR    NOT NULL,
  source       VARCHAR    NOT NULL,   -- 'system' | 'user'
  label        VARCHAR    NOT NULL,
  authority    VARCHAR,               -- system rows only; null for user rows
  due_date     DATE,       -- nullable: not every pack descriptor has a due rule (e.g. SG's annual-report.json)
  period_id    VARCHAR,               -- nullable; free-standing user reminders allowed
  done         BOOLEAN    NOT NULL DEFAULT false,
  created_at   TIMESTAMP  NOT NULL DEFAULT NOW()
);
```

System-imported rows keep the same collision-free identity the superseded spec introduced (superseded spec §2.1: `${descriptor.id}@${interval.start}` for VAT, `${descriptor.id}@${period.period_name}` for fiscal-year kinds) — that fix is worth keeping regardless of what else changes — but instead of being recomputed fresh from the jurisdiction pack on every page load, a system row is **seeded once**: `filing.list`'s existing descriptor+interval computation runs an idempotent insert-if-`reminder_id`-not-exists on each load, supplying the pack's computed label/authority/due-date only at creation time. After that it's an ordinary row — editing its due date or marking it done is a plain `UPDATE`, no separate override layer, and a jurisdiction pack update (a new due date for an existing descriptor) only reaches rows created *after* the change, same as any seed-once pattern. This trades a small amount of insert-on-read plumbing for one storage shape instead of two, which is the right side of that trade here.

### 4.4 Notification integration

New `api/src/reminder-scanner.js`, same shape as `fx-scanner.js`: runs on boot + on an interval — a named, env-tunable constant, `FREEBOOKS_REMINDER_SCAN_MS`, consistent with `fx-scanner.js`'s `FREEBOOKS_FX_SCAN_MS` (`fx-scanner.js:22`), defaulting to once daily (due dates don't move hour to hour) — scans `reminders` (§4.3) for `!done` items due within a lead window, calls `raiseNotification(companyId, 'reminder-due', message, `reminder-due:${companyId}:${reminderKey}`)` — same dedupe-on-read behavior FX gaps already get, no changes needed to `notifications.js` or the bell UI at all. Lead-time window (days-before-due to start alerting) is an open parameter — see §9.

### 4.5 UI

Columns: Reminder · Period · Authority · Due Date (inline-editable, same click-to-edit convention already in `fiscal.js:254-275`) · Status (Done/Not done — a checkbox reads most consistently with the true/false semantics stated during ideation) · actions (artifact download chips where applicable; Add/Remove for user rows). Whether a *system-imported* row can be removed outright (vs. only ever marked done) wasn't settled during ideation and is called out in §9 rather than assumed.

---

## 5. Documents (new top-level page)

### 5.1 Concept

A single list of every attachment that exists anywhere in the system — bill, invoice, journal-voucher, and (if any remain) filing attachments — plus a way to upload documents that aren't tied to any existing record (Annual Report PDFs, SRU files, VAT declarations, AGM minutes, etc.).

### 5.2 Columns and their derivation

| Column | System-linked row | User upload |
|---|---|---|
| ID | source doc's existing id/reference | filename |
| Type | the origin ledger/module (Bill / Invoice / JV / …) — this is just `attachments.entity_type`, already stored, no new column needed | picked from an existing type value, or free-text to mint a new one |
| Period | auto-derived from the underlying transaction's date, resolved against the periods table | user selects at upload time |
| Date uploaded | `attachments.uploaded_at`, already stored | same |

### 5.3 What this actually requires backend-side (not free)

`attachment.list` today (`attachments.js:48-64`) is scoped to one `entityType`+`entityId` pair and doesn't even select `entity_type`/`entity_id` in its return columns — it's built for "show me this one record's attachments," not "show me everything." Documents needs:
- A company-wide list mode (entityType/entityId omitted → all rows for the company), with `entity_type`/`entity_id` added to the `SELECT`.
- A period-resolution step: joining/deriving each system-linked row's owning transaction date against the periods table's date ranges, since attachments carry no period today.
- Two new nullable columns on `attachments` for the standalone-upload case, which has no existing entity to derive Type/Period from — added the same idempotent way `sha256` was (`db/schema.sql:615`, `ALTER TABLE attachments ADD COLUMN IF NOT EXISTS ...`), not a fresh `CREATE TABLE`:
  ```sql
  ALTER TABLE attachments ADD COLUMN IF NOT EXISTS doc_type VARCHAR;
  ALTER TABLE attachments ADD COLUMN IF NOT EXISTS period_id VARCHAR;
  ```
  A standalone upload also needs a stable `entity_type` value to file itself under (e.g. `'document'`) with a synthetic `entity_id`, since every existing attachment is entity-keyed and standalone uploads currently have no entity to key off.

None of this is large, but it's real schema and query work, not just a new page reusing `attachment.list` as-is.

### 5.4 Row actions

- **Open file** — reuse the existing download-link pattern (`fb-attachments.js` `rowHtml`, target=`_blank`), unchanged.
- **Go to source** (system-linked rows only) — new. The only precedent in the app for "click a reference, land on the owning record" is `payables-bills.js:1333`'s `ref-link` anchor (vendor ref → bill detail). Documents needs the general case: a small `entity_type → route template` resolver (bill → `/company/bill/:id`, journal → `/company/journal?batch=:id`, etc.). `nav-registry.js`'s `ROUTES` array is the obvious place to *extend* this into, given it already bills itself as "the single source of truth for app navigation" consumed by four subsystems (sidebar, `{`/`}` cycling, the g-prefix map, the `?` help overlay) — but it's a genuine extension, not a slot that already exists: every current `ROUTES` entry is a fixed, id-less page template (`/:company/payables`, never `/:company/bill/:id`), so entity-detail routes with a dynamic id are new structure there, not data that's merely unused today.
- **Delete + re-upload** (user uploads only) — no new action; this is exactly `attachment.delete` (`action-catalog.js`, handler at `attachments.js:68-100`) followed by a fresh `attachment.upload` call, deliberately not a single "replace" action, since there's no in-place edit concept here at all (§0.4).
- **System-linked rows are read-only in Documents** — no delete, no edit. Deletion of a system attachment stays owned by its originating page (`bill-edit.js` — merged from `bill-detail.js` 2026-09-06 — and `journal-voucher.js`), exactly as today; Documents doesn't duplicate that authority. **Exception (2026-09-04, §5.5):** once `missing_since` is set, the file is already gone and unrecoverable, and there's no replace/reupload path for a system-linked row — without an escape hatch, the `attachment-missing` notification (§5.5) would re-raise forever with no way to clear it. Documents shows Delete for these rows too in that state only; it's the same `attachment.delete` call, just gated on `missing_since` instead of `entity_type === 'document'`.

### 5.5 Attachment integrity: missing & orphaned files

Documents is strictly DB-driven (§5.3) — it is never built by scanning `ATTACHMENTS_ROOT`. But the DB and the filesystem can still drift apart (a row's blob deleted/moved outside the app; a blob written without its row ever committing), and nothing today detects that — the existing `runAttachmentGC` (`attachments.js:336-358`) is unrelated: it only purges rows tied to expired/rejected `journal_proposal` drafts, not a folder-vs-table reconciliation. New `api/src/attachment-integrity-scanner.js`, same family as `fx-scanner.js`/`reminder-scanner.js` (boot + interval, `raiseNotification` on findings), runs both directions:

- **DB row, no file** (`storage_path` doesn't resolve on disk) — same idempotent-migration style as `doc_type`/`period_id` above and `sha256` before them:
  ```sql
  ALTER TABLE attachments ADD COLUMN IF NOT EXISTS missing_since TIMESTAMP;
  ```
  Set on first miss, cleared if the file reappears. A notification is raised every scan while still missing (not just on the transition) — same self-healing, unread-issue_key-deduped model as the FX/reminder scanners, so marking the bell notification read can't permanently silence a still-broken attachment. Documents renders a "missing" indicator on that row from the column directly — no live per-row disk check on page load.
- **File, no DB row** (nothing in `attachments.storage_path` matches a path found under `ATTACHMENTS_ROOT`) — can't be a Documents row at all (no DB row means no Type/Period/ID to display, per the same DB-only rule). Instead it becomes a row in a new table, scoped per-company like the FX/reminder scanners:
  ```sql
  CREATE TABLE IF NOT EXISTS orphaned_files (
    orphan_id     VARCHAR    NOT NULL,
    company_id    VARCHAR,             -- nullable: see below
    path          VARCHAR    NOT NULL, -- relative to ATTACHMENTS_ROOT
    discovered_at TIMESTAMP  NOT NULL DEFAULT NOW(),
    resolved_at   TIMESTAMP
  );
  ```
  `ATTACHMENTS_ROOT` itself (`os.homedir()/.freebooks/attachments`) is global, but every real attachment's `storage_path` is written as `${companyId}/${entityType}/${entityId}/${uuid}-${filename}` (`attachments.js:154`) — company_id is always the path's first segment, so the scanner parses it out and `orphaned_files.company_id` is populated the normal way for anything that looks like a real (if orphaned) upload. It stays nullable only for the edge case of a file placed under `ATTACHMENTS_ROOT` by hand, outside that convention entirely — that one has no company to attribute to and needs to surface somewhere company-scoped Inbox review can't reach it; flagged, not resolved, in §9.

**Resolution happens in Inbox, not the notification dropdown.** The bell stays purely a ping (as it is today — `fb-core.js:3088-3157` has no per-item actions beyond mark-read). An orphaned file needing a human verdict is the same shape of task Inbox already exists for ("the human's review queue" — `inbox.js`'s `_kind: 'bill'|'proposal'` rows with an accept/reject review modal, `inbox.js:354-402`). This spec proposes a new `_kind: 'orphan_file'` Inbox row, sourced from the `orphaned_files` table, with two resolutions instead of accept/reject:
  - **View** — open/preview or download the file before deciding; needs a temporary direct-file-serving route, since there's no `attachment_id` to serve it by.
  - **Delete** — delete the blob directly off disk (there's no `attachment.delete` to call; no row exists to delete). No app-managed quarantine — the operator downloads a copy via View first if one is wanted.

---

## 6. Notification system status

No activation work needed anywhere in this spec — confirmed, not assumed. The bell UI (`tb-notif-btn`/`tb-notif-badge`/`tb-notif-dropdown`) is already live in `fb-core.js:3062-3227`, polling `notifications.list`/`notifications.mark_read`, and `fx-scanner.js` is already an active producer into it, started unconditionally at boot (`index.js:1986`). The only new work anywhere in this spec is `reminder-scanner.js` (§4.4) as a second producer, following the exact same `raiseNotification` call shape.

---

## 7. Data left behind by the superseded spec

The superseded spec shipped `periods.tax_attrs.filings[key]`, `loss_cf`, `periodiseringsfond`, and `ar_facts` (superseded spec §2), plus the UI to write and read them. Removing the Facts/Periodiseringsfond expand-panels (§4.2) removes the *only* reader/writer of that data (superseded spec §2.1 named the Facts panel as the sole consumer of `ar_facts`, explicitly). Whatever was already written there in production, if anything, becomes **unreachable, not deleted** — same posture the superseded spec itself took toward the old Annual Report renderer (superseded spec §0.3: "left in place, unused-but-harmless"). This is a known gap this spec opens and does not close; whoever picks up the Corporate Records follow-up (§0.1) should check whether any real `loss_cf`/`periodiseringsfond`/`ar_facts` data exists before that data's only UI disappears.

---

## 8. Corporate Records (concept sketch — not build-ready)

Agreed at the concept level during ideation; not designed to schema/action fidelity here (§0.1) — a future spec owns turning this into something implementable. Replaces the superseded spec's `periods.tax_attrs.periodiseringsfond`/`loss_cf`/`ar_facts` (§7) with a proper append-only ledger of dated company-level governance/tax-continuity facts, instead of JSON nested inside one arbitrary period row.

**Why not just a period row field.** Today's shape forces two different problems into one JSON blob: (a) reassembling "every tranche across every year" means walking every period row, since each tranche lives wherever it happened to be recorded; (b) something like a director appointment isn't naturally period-scoped data at all, yet has nowhere else to live. A dedicated table with its own date column, independently queryable, fixes both without losing anything.

**Every record gets a derived Period, same mechanism as Documents (§5.2)** — read-time join of the record's date against the periods table's ranges, for consistent filtering across the app ("show me everything from FY2025"). That answers cleanly why *not* to special-case periods out of the model: every record has a date, so every record can get one, the same way every Documents row does.

**Two entry types additionally carry an explicit origin-period reference (FK to `period_name`), not just a derived one** — periodisation-fund tranches and loss-carryforward entries, because for those the period isn't incidental metadata, it's part of what the fact *means*: a tranche's 6-year statutory reversal deadline is computed from its origin year, and a loss-carryforward entry's opening/closing figures chain from one specific fiscal year's filing into the next. For every other entry type (dividend proposal/decision, director appointment), the period is purely a derived, incidental fact about when it happened.

**Loss carryforward becomes an append-only history, not a mutable scalar** — one entry per fiscal year (opening amount, closing amount), instead of a single `tax_attrs.loss_cf` value the superseded spec's `filing.mark_submitted` silently overwrote forward (superseded spec §7). "What was last year's carryforward" becomes a query against history rather than trusting whatever the field currently holds.

**Connects to Documents, not duplicates it** — a record can optionally reference a Documents row (the AGM minutes or board resolution backing it), giving the same "reconstruct by hand if Gredor disappears" resilience the original `ar_facts` design was reaching for, without Corporate Records needing its own file storage or Documents needing governance semantics.

**Connects to notifications the same way Reminders does, not through Reminders** — a small scanner in the same family as `fx-scanner.js`/`reminder-scanner.js`/`attachment-integrity-scanner.js` can read Corporate Records directly and raise a notification when, e.g., a tranche crosses its 6-year deadline. No new plumbing through the Reminders tab needed.

**Undecided:** where this lives in the IA. Not Calendar (not primarily date-navigation), not Documents (structured facts, not files), arguably adjacent to Accounting (COA/Tax Codes/Journals) but not obviously the same concern. Own top-level page vs. a tab under something existing is an open call, listed in §9.

---

## 9. Open questions (not settled during ideation)

1. **Can a user remove a system-imported reminder outright**, or only ever mark it done? The ideation wording ("user can add/remove key dates") didn't distinguish system-imported from user-added when it comes to removal.
2. **Reminder due-soon lead time** — how many days before the due date should the notification fire? Not discussed; `fx-scanner.js`'s cadence isn't quite analogous since it's about data-gap detection, not deadline proximity.
3. ~~**Reminders storage shape**~~ — resolved: a review pass flagged the settings-blob/table split as architecturally inconsistent; §4.3 now proposes a single `reminders` table with a `source` column instead.
4. **Corporate Records' home in the IA** (§8) — own top-level page, consistent with how Documents was added, or a tab under an existing section? Not discussed.
5. **Orphaned-file Inbox item schema and semantics** (§5.5) — the `orphaned_files` row shape is now sketched, but whether "Move" permanently suppresses future scanner notifications for that path is still open, as is how a hand-placed file outside the `${companyId}/${entityType}/${entityId}/...` convention (§5.5) — one with no company to attribute to at all — should surface, given Inbox review is inherently company-scoped.

---

## 10. Changelog

| Date | Change |
|------|--------|
| 2026-08-29 | Drafted from a live UX-ideation session, same day the spec it partially supersedes (`fiscal-filings-lifecycle-spec.md`) was ratified and shipped (`d5e60bf`). Status: PROPOSED. |
| 2026-08-29 | Ideation continued: (1) §5.5 added — Documents stays strictly DB-driven per explicit correction; a new attachment-integrity scanner detects missing files (DB row, no blob) and orphaned files (blob, no DB row), routing resolution (Purge/View/Move) through Inbox rather than the notification dropdown, consistent with Inbox's existing "human review queue" role. (2) §8 added — Corporate Records concept sketch, including the resolution that every record gets a derived Period like Documents rows do, with an additional explicit origin-period FK only for the two tax-continuity entry types where the period is load-bearing, not incidental. (3) gKey question resolved: Calendar takes `g c` (judged higher-frequency than the company switcher), switcher moves to `g w`. |
| 2026-08-29 | Review pass applied: (1) §5.3/§5.5 — `doc_type`, `period_id`, and `missing_since` now spelled out as idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migrations, matching the existing `sha256` precedent (`db/schema.sql:615`), not left as unstated additions. (2) §5.5 — `orphaned_files` columns named explicitly, and confirmed (`attachments.js:154`) that `storage_path`'s leading segment is always the owning `company_id`, so the scanner can attribute orphans per-company like the FX/reminder scanners; the one unresolved edge is a hand-placed file outside that path convention, moved to §9. (3) §4.3 — reworked from a settings-blob/table split into a single `reminders` table with a `source` column, per review feedback that the split added a second clobber-prone JSON blob for no real benefit; system rows are now seeded once (idempotent insert-if-not-exists from the jurisdiction pack) rather than recomputed every load. (4) §4.4 — named the scan-interval constant `FREEBOOKS_REMINDER_SCAN_MS`, consistent with `FREEBOOKS_FX_SCAN_MS`. (5) §5.4 — clarified that `nav-registry.js` is a place to *extend* the go-to-source route map into, not one that already holds entity-detail routes with dynamic ids — its current `ROUTES` entries are all fixed, id-less page templates. |
| 2026-09-04 | §5.5 fixed: `attachment-integrity-scanner.js` was only raising `attachment-missing`/`orphaned-file` once, on the transition into the bad state, so marking that bell notification read permanently silenced it even though the file was still missing/orphaned. Changed to re-raise every scan cycle while the condition persists, relying on `raiseNotification`'s unread-issue_key dedupe the same way `fx-scanner.js`/`reminder-scanner.js` already do — read is an acknowledgment, not a fix. |
| 2026-09-04 | §5.4 exception added: with `attachment-missing` now re-raising forever (above), a system-linked row with no file left had no way to clear the alert at all — no delete, no replace/reupload path existed. Documents now shows Delete for a system-linked row once `missing_since` is set (still hidden otherwise); same `attachment.delete` action, matching the "drop quarantine, go with plain delete" precedent already set for orphaned files (`cabddcf`) rather than adding a new detach/soft-remove state. |
