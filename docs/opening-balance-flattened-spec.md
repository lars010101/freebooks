# Opening Balance Tab — Flattened Spec

## Goal
Replace the current Settings → Opening Balance tab (instructions + page-level Date/Journal/Description + separate filter controls) with a single `FB.list`. No page furniture, no separate filter bar, no page-level input fields.

## When opening balances apply
Only during migration — a one-time event per tenant, not an ongoing entry type. That constraint is what makes it safe to fully hardcode Journal, Period, and Description rather than treat them as user input.

## Resolved design: reserved Journal + reserved Period

**Journal — hardcoded `OPEN`**
A dedicated journal, used only for opening-balance postings, reserved and non-selectable elsewhere. Keeps opening balances cleanly filterable/auditable forever (`journal_id = OPEN` always means "this came from migration"), unlike reusing a general-purpose journal like MISC.

**Not auto-seeded.** The OPEN journal is created manually by the user (via the journals UI) only when migrating. If the user clicks POST without an OPEN journal, the error message states: *"OPEN Journal required for migrated data. Create it, try again."*

**Period — hardcoded `OPEN`**
A dedicated, reserved period representing the migration anchor point. **Start date must equal end date** — `OPEN` is a single-day cutover point, not a range. This removes any ambiguity about which boundary to use: there's only one date.

**Description — hardcoded `"Opening balances"`**
Not shown as a column in the grid (see Column spec below — dropped per review).

**Date — frozen at posting, derived from Period `OPEN`**
When opening balances are posted, the system reads Period `OPEN`'s date (start = end, so a single unambiguous value) *at that moment* and writes it as a literal value onto each line. It is not re-derived later — a posted transaction's date never moves, even if Period `OPEN` is edited afterward.

No fallback (e.g. prompt-on-POST) if `OPEN` doesn't exist — see validation below.

## OPEN and fiscal-year boundaries
`OPEN`'s date does not need to align with a fiscal-year boundary — it can fall on any day of the year, since it's just a cutover point, independent of how fiscal years are drawn.

This matters because migration rarely happens on a year boundary. Example: a tenant migrates May 7, 2027, but their fiscal year normally runs Feb 1 – Jan 31. Rather than forcing a full twelve-month FY2028 that includes months with no data in the new system, the transition year is shortened to start the day after `OPEN`: FY2028 becomes May 8, 2027 – Jan 31, 2028. Every subsequent year (FY2029 onward) returns to the normal Feb 1 – Jan 31 length. This is standard practice for any mid-cycle books restart (migrations, fiscal year changes, carve-outs) and requires no special-casing beyond it: the existing "no period may start on or before `OPEN`'s date" validation already accepts this stub year, since May 8 falls after May 7.

Two consequences worth flagging to whoever owns the fiscal-year/period feature:
- The period-setup model must support a variable-length fiscal year (at minimum, one irregular first year), not just irregular periods within a standard-length year. *(Note: the current data model already supports this — `periods` has no fiscal-year-length constraint at the schema level, and `companies.fy_start`/`fy_end` are freely set. No new code needed.)*
- Activity before `OPEN` (Feb 1 – May 7, 2027 in the example) isn't part of any fiscal year in the new system — that's a deliberate effect of shortening the year, not a bug. A report spanning the full pre-migration-to-post-migration year would need to be assembled from the old system, not this one.

## Schema change: `journal_id` on `journal_entries`

Add `journal_id VARCHAR` column to `journal_entries`. This makes the journal link explicit and queryable, rather than relying on the `reference` string prefix. Opening-balance lines are filtered via `WHERE journal_id = (SELECT journal_id FROM journals WHERE company_id = ? AND code = 'OPEN')` — a real join, not string-pattern matching.

Migration: `ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS journal_id VARCHAR`. Backfill existing rows by joining `journal_sequences` → `journals` on the reference prefix, or leave null for legacy rows (they default to MISC via the existing resolveDefaultJournalId logic).

## Future item: reference format refactor (not in scope for this spec)

The current `reference` format is `{JOURNAL_CODE}/{YEAR}/{NNNNN}` (e.g. `MISC/2027/00001`), minted from `journal_sequences`. With `journal_id` now a separate column, the journal code embedded in the reference string is redundant. A future refactor could simplify `reference` to a plain sequential doc number (per-journal or global, TBD — SAP uses per-journal number ranges). This touches `postJournalBatch`, `getNextReference`, `getNextReferenceBatch`, journal page display, search, and SIE export, and warrants its own spec. Not part of the opening-balance work.

## Validation

**On POST (opening balances):**
1. Journal `OPEN` exists → else error: *"OPEN Journal required for migrated data. Create it, try again."*
2. Period `OPEN` exists **and is unlocked** → else error message in the status bar.

**On Period creation (`period.upsert` only — `period.save` is used only in the new-company wizard, before any OPEN period exists):**
- **Creating Period `OPEN` itself:** verify no existing period has an end date earlier than `OPEN`'s date. Since creating `OPEN` is optional and can happen at any time (not forced during setup), this check is what secures `OPEN` as the oldest period regardless of creation order — it catches the case where ordinary periods were already created before `OPEN` existed.
- **Creating any other period (once `OPEN` exists):** block a start date on or before Period `OPEN`'s date. This is the forward-looking counterpart — together with the check above, `OPEN` can never end up with an earlier period on either side of its creation.
- Enforce start date = end date specifically when creating/editing the `OPEN` period itself (not a general constraint on periods generally, which normally do span a range).

## Column spec (grid contents)

| Column | Editable | Filterable | Notes |
|---|---|---|---|
| Account | Yes | Yes (header filter) | |
| Debit | Yes | Yes | |
| Credit | Yes | Yes | |
| Date | No | Not meaningful — always uniform | Derived from Period `OPEN` at POST time, frozen; shown read-only |
| Journal | No | Not meaningful | Always `OPEN`; shown read-only |

Description ("Opening balances") is not a grid column — it's implicit in the context (the tab is titled Opening Balances). Dropped per review.

## Resolved review items
1. **`journal_entries` has no journal column** → resolved: add `journal_id` column (schema migration, see above).
2. **`period.save` bypasses validation** → resolved: `period.save` is only used in the new-company wizard (before any OPEN period exists), so it cannot violate the OPEN validation rules. No action needed.
3. **OPEN journal creation lifecycle** → resolved: not auto-seeded. Error-on-POST guides the user to create it manually.
4. **Description column** → resolved: dropped. Not shown as a grid column.

## Answers to original open questions
1. **Zero-duration period safety:** Safe. No code path divides by period length or assumes a minimum duration. All queries use inclusive `BETWEEN` or `>= / <=` date comparisons. A single-day OPEN period is safe.
2. **Variable-length stub fiscal year:** Already supported by the current data model. `periods` has no fiscal-year-length constraint at the schema level. `companies.fy_start`/`fy_end` are freely set. No new code needed.
