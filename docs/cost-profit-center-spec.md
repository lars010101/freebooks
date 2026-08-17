# Cost/Profit Center Derivation — Spec

**Status:** proposed (rev 4 — incorporates review feedback rounds 1–3)
**Repo:** lars010101/freebooks
**Touches:** `db/schema.sql`, `api/src/centers.js` (new or existing — confirm), `api/src/validation.js`, `api/src/journal.js`, `api/src/bills.js`, `api/src/bank.js`, `api/public/*` (Settings → Master Data → Cost/Profit Centers page)

**Scope note:** an earlier draft also proposed a `parent_id` same-type hierarchy (Cost→Cost and Profit→Profit rollup trees) for consolidated reporting. That's cut for v1 — at SMB scale a flat list of centers is enough, and a self-referencing `parent_id` column with no consumer is a liability (orphaned/cyclic references with nothing checking them) rather than a neutral placeholder. If rollup reporting becomes a real ask later, it's a clean additive migration (`ALTER TABLE centers ADD COLUMN IF NOT EXISTS parent_id VARCHAR`) with zero cost paid now. This version scopes to the actual problem: `cost_center`/`profit_center` are independently-populated free text on three tables today, with nothing enforcing that a bill's or journal line's pair actually matches.

## 1. Problem

`db/schema.sql` currently defines `centers` as a flat table:

```sql
CREATE TABLE IF NOT EXISTS centers (
  company_id  VARCHAR NOT NULL,
  center_id   VARCHAR NOT NULL,
  center_type VARCHAR NOT NULL,
  name        VARCHAR NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);
```

There's no link from a Cost center to the Profit center it belongs to. Worse, three other tables already carry `cost_center` and `profit_center` as **independent free-text VARCHAR columns**, with no FK and no derivation between them:

- `journal_entries.cost_center` / `journal_entries.profit_center`
- `bills.cost_center` / `bills.profit_center`
- `bank_mappings.cost_center` / `bank_mappings.profit_center`

Today a human (or an agent via `journal.propose` / `bill.create`) can post a document with `cost_center = 'CC-SALES-EAST'` and `profit_center = 'PC-APAC'` even if `CC-SALES-EAST` actually belongs to `PC-EMEA`. Nothing in `validation.js` catches this. This spec closes that gap.

## 2. Schema changes

Follow the house migration style already used throughout `schema.sql` (inline `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, appended after the original `CREATE TABLE`, with a banner comment):

```sql
-- =============================================================================
-- MIGRATION: cost→profit center derivation
-- For Cost centers only, links to the Profit center that absorbs their spend.
-- This is the derivation source for journal_entries.profit_center /
-- bills.profit_center at posting time. Backward-compatible: existing centers
-- get profit_center_id = NULL and are backfilled via the one-time
-- reconciliation in §5 before derivation goes live (§4).
-- =============================================================================
ALTER TABLE centers ADD COLUMN IF NOT EXISTS profit_center_id VARCHAR;

CREATE INDEX IF NOT EXISTS idx_centers_company_type ON centers(company_id, center_type);

-- Rollout gate (see §3, §4, §6a, §7): every derivation call site AND
-- center.save's requirement check both read this same flag. Seeded false so
-- deploying the derivation code (§4) is inert on its own — nothing in the
-- posting paths runs differently until an owner explicitly flips this via
-- settings.save. Same seed pattern as vat_tolerance / vat_tolerance_pct above.
INSERT INTO settings (company_id, key, value, updated_at)
SELECT c.company_id, 'center_derivation_enabled', 'false', NOW()
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM settings s
  WHERE s.company_id = c.company_id AND s.key = 'center_derivation_enabled'
);
```

Constraints DuckDB won't enforce for you (`centers` has no declared PK/FK anywhere in the current schema — same pattern as `accounts`, `vat_codes`, etc., so integrity is app-layer, not DB-layer). Enforced in `center.save` — see §6a for the full validation code, and note the `center_derivation_enabled` gate below before assuming the requirement is unconditional.

## 3. Shared derivation helper

Every write path that touches `cost_center`/`profit_center` needs the same lookup. Rather than duplicating it in `journal.js`, `bills.js`, and `bank.js`, add one function — either in a new `api/src/centers.js` (if `center.*` actions don't already live in a dedicated file; the README's module table doesn't list one explicitly, so check whether `center.*` is currently dispatched inline in `index.js`) or, if that file already exists, add it there:

```js
// api/src/centers.js

/**
 * Given a cost_center_id, returns the profit_center_id it's assigned to.
 * Throws if the cost center doesn't exist, is inactive (unless allowInactive
 * is set — see below), or has no profit_center_id set.
 *
 * allowInactive: pass true only from correction/reversal paths (editing or
 * reclassing an entry that already references a since-deactivated cost
 * center). Default false blocks NEW postings against an inactive center but
 * doesn't trap you when fixing something that already used it. Chosen over
 * the alternative of forbidding deactivation while historical references
 * exist — that would require a reference-count check on every deactivate
 * and doesn't handle centers deactivated via CSV import (db/import.js)
 * outside the app layer.
 *
 * Callers MUST check isDerivationEnabled() before calling this in a posting
 * path (§4) — this function itself doesn't check the flag, so calling it
 * unconditionally will throw for any Cost center that hasn't been backfilled
 * yet, even during the intentionally-permissive pre-cutover window.
 */
async function deriveProfitCenter(db, companyId, costCenterId, { allowInactive = false } = {}) {
  if (!costCenterId) return null;
  const [center] = await db.query(
    `SELECT center_type, profit_center_id, is_active
     FROM centers WHERE company_id = ? AND center_id = ?`,
    [companyId, costCenterId]
  );
  if (!center) throw new Error(`Unknown cost_center: ${costCenterId}`);
  if (center.center_type !== 'Cost') {
    throw new Error(`${costCenterId} is not a Cost center`);
  }
  if (!center.is_active && !allowInactive) {
    throw new Error(`Cost center ${costCenterId} is inactive`);
  }
  if (!center.profit_center_id) {
    throw new Error(`Cost center ${costCenterId} has no profit center assigned`);
  }
  return center.profit_center_id;
}

/** Reads the rollout gate from §2. Every posting-path call site (§4) and
 *  center.save (§6a) call this before doing anything derivation-related —
 *  it's the single switch for the whole feature. No caching across requests:
 *  an owner can flip it at any time via settings.save, and the next request
 *  should see it immediately. */
async function isDerivationEnabled(db, companyId) {
  const [row] = await db.query(
    `SELECT value FROM settings WHERE company_id=? AND key='center_derivation_enabled'`,
    [companyId]
  );
  return row?.value === 'true';
}

module.exports = { deriveProfitCenter, isDerivationEnabled };
```

## 4. Wire into each write path

This is the part that's easy to get half-done in a codebase with four separate posting paths. All four need to stop trusting a caller-supplied `profit_center` and derive it instead — but only once `center_derivation_enabled` is true. **Every call site below checks the flag before calling `deriveProfitCenter`.** This makes deploying the code in this section and flipping the setting in §7 step 4 two independent, order-agnostic actions: the code can ship at any time and does nothing until an owner flips the flag, and the flag flip is what actually activates it. When the flag is `false`, each path below behaves exactly as it does today — a caller-supplied `profit_center` (or its absence) passes through unchanged.

### 4a. `journal.js` — `journal.post`

Direct MISC/ADJ journal entries (a human posting straight to `journal_entries`) can set `cost_center` today with no downstream check. `journal_entries` already carries `reverses`/`reversed_by` columns, so a posting batch's reversal status is a first-class signal — use it to decide whether inactive centers are tolerated for *this* post, and pass the same flag to `validateCenterConsistency` (§4d) rather than letting the two layers disagree:

```js
// journal.post
const isReversal = Boolean(batch.reverses); // batch is reversing a prior entry
const derivationEnabled = await isDerivationEnabled(db, companyId);

if (derivationEnabled) {
  for (const line of batch.lines) {
    if (line.cost_center) {
      line.profit_center = await deriveProfitCenter(
        db, companyId, line.cost_center, { allowInactive: isReversal }
      );
    } else if (line.profit_center) {
      // Direct profit-center-only posting (no cost driver) — allow, but validate
      // it resolves to an actual Profit-type center.
      const [pc] = await db.query(
        `SELECT center_type FROM centers WHERE company_id=? AND center_id=?`,
        [companyId, line.profit_center]
      );
      if (!pc || pc.center_type !== 'Profit') {
        throw new Error(`${line.profit_center} is not a valid profit center`);
      }
    }
  }
  await validateCenterConsistency(db, companyId, batch.lines, { allowInactive: isReversal });
}
// else: derivation not enabled for this company yet — line.cost_center /
// line.profit_center persist exactly as supplied, matching pre-migration behavior.
```

This also covers `journal.propose` → `journal.approve`, since approval re-validates and posts through the same `journal_entries` insert path (per the agent-readiness spec, proposals carry the exact `journal.post` row shape in `lines`) — re-run derivation at **approve** time too, not just at propose time, in case the center's `profit_center_id` assignment changed between propose and approve. `journal.reverse`-generated batches carry `reverses` set, so `isReversal` falls out of the same check with no extra plumbing.

### 4b. `bills.js` — `bill.create`

This is your original question, now concrete: the bill form should collect `cost_center` only. On `bill.create`/`bill.draft.save`:

```js
if (bill.cost_center && await isDerivationEnabled(db, companyId)) {
  bill.profit_center = await deriveProfitCenter(db, companyId, bill.cost_center);
}
// else: bill.profit_center passes through whatever the caller supplied (still
// possible pre-cutover, since the form's profit_center input isn't removed
// until §7 step 5, which happens after derivation is enabled).
```

**Granularity assumption (confirm before implementing):** `bills.cost_center` is a single header-level column today, not per-line — this spec keeps that as-is for v1. One bill = one cost center. A bill that should genuinely split across centers (e.g. a utility bill allocated 60% to Ops, 40% to Admin) isn't supported; the workaround is two bills or a manual journal split. This is a pre-existing limitation, not something this spec introduces or fixes. If line-level cost center allocation becomes a real requirement, the derivation point in this section moves from the bill header to each bill line, and the "remove profit_center input" change in §6b applies per-line instead of per-header — flag that as a larger follow-up spec, not a tweak to this one.

Since `bill.create` is on the `agent`-role whitelist (draft bills), this also protects agent-created drafts from carrying a mismatched profit center — once derivation is enabled, the agent shouldn't (and per this change, can't) set `profit_center` directly.

When the bill posts its DR Expense / CR AP journal batch, the derived `profit_center` flows onto the `journal_entries` rows the same way `bill_id` already does — subject to `journal.post`'s own flag check in §4a, so both layers agree.

### 4c. `bank.js` — tier 1 rule matching (`bank_mappings`) and tiers 2–4

`bank_mappings` rows are templates, so the same rule: a saved mapping should only carry `cost_center`; `profit_center` gets derived when the rule fires and produces a `journal.propose` payload, not stored redundantly on the rule itself. Simplify the table rather than dual-track it:

```sql
-- Optional, once all mappings are backfilled (§5): stop writing profit_center
-- on bank_mappings going forward. Leaving the column for now avoids a
-- breaking migration; just stop populating it from mapping.save / mapping.suggest.
```

For tiers 2–4 (open-item match, trigram match, LLM reasoning), wherever the proposal builder currently copies `cost_center`/`profit_center` off the matched bill or historical entry: gate the swap behind `isDerivationEnabled` the same way as §4a/§4b. When enabled, drop the `profit_center` copy and call `deriveProfitCenter` instead — otherwise a stale value on an old bill silently propagates forward. When disabled, keep the existing copy-forward behavior unchanged.

### 4d. `validation.js` — defense in depth

The README already describes this module as doing "period lock + balance + COA + FX rate checks." Add one more, run on every `journal.post` and `journal_proposal` approval — but only when the flag is on, per §4a's gating (the call site in §4a already wraps this inside `if (derivationEnabled)`, so `validateCenterConsistency` itself doesn't need its own internal flag check — it should never be invoked while the flag is false).

**Coverage note:** this must fire whenever `cost_center` is present, not only when both fields are present — the expected post-derivation shape is "caller sets `cost_center`, derivation fills `profit_center`," so a check gated on *both* fields being set would silently pass a row that skipped derivation entirely (`cost_center` set, `profit_center` NULL) straight through, from any write path this spec missed. The function both **validates** (mismatched pair throws) and **guarantees** (missing `profit_center` gets backfilled) — every line leaving it has a correct `profit_center` or none at all.

**`allowInactive` must thread through, not default silently.** §4a passes `allowInactive: true` for reversal batches directly to `deriveProfitCenter` in its own loop — if this function calls `deriveProfitCenter` again internally with the default `false`, a reversal against an entry that referenced a since-deactivated cost center throws here even though the inline derivation two lines earlier already succeeded. The caller in §4a passes the same `isReversal` value through, so the two layers can't disagree:

```js
// validation.js
async function validateCenterConsistency(db, companyId, lines, { allowInactive = false } = {}) {
  for (const line of lines) {
    if (line.cost_center) {
      const expected = await deriveProfitCenter(db, companyId, line.cost_center, { allowInactive });
      if (line.profit_center && line.profit_center !== expected) {
        throw new Error(
          `Line cost_center ${line.cost_center} belongs to profit_center ` +
          `${expected}, but ${line.profit_center} was supplied`
        );
      }
      line.profit_center = expected; // backfill if the write path omitted it
    }
  }
}
```

This is redundant with §4a's inline derivation if derivation always overwrites the caller's value — but keep it, because it also catches any write path you missed (e.g. `db/import.js` CSV import, or a future direct-SQL admin action via `POST /api/admin/query`). If either of those paths is ever wired to call `validateCenterConsistency` directly (outside `journal.post`), it must perform its own `isDerivationEnabled` check first, the same way §4a does — this function has no gate of its own, by design, so it stays a pure consistency check usable from any already-gated caller.

## 5. One-time reconciliation for existing data

Because `cost_center`/`profit_center` have been populated independently on `journal_entries`/`bills` since before this fix, you'll have historical rows where the pair doesn't match any (future) `centers.profit_center_id` assignment. Two options, both worth doing:

1. **Backfill `centers.profit_center_id`** from whatever pairing appears most often in existing `journal_entries`/`bills` for each `cost_center` value, then review manually — this seeds sensible defaults instead of starting from a blank master-data table.
2. **Extend the `integrity` report** (`report?type=integrity`, described in the README as doing RE roll-forward checks) with a new check: flag any posted `journal_entries`/`bills` row where the stored `(cost_center, profit_center)` pair doesn't match the current `centers.profit_center_id` assignment. This gives you an ongoing audit trail rather than a one-shot cleanup, which fits the project's existing "Integrity Check" pattern better than a silent migration script.

## 6. UI changes

### 6a. Settings → Master Data → Cost/Profit Centers (the page in your screenshot)

Built on `fb-list.js` (vim-modal list) + `fb-form.js` (zones/cursor form), per `docs/UI.md` / `docs/settings-ux-spec.md` conventions. Add one column to the list and one field to the "+ Add entry" form:

| Column | Behavior |
|---|---|
| PROFIT CENTER | Only rendered when `TYPE = Cost`. Dropdown sourced from `center.list` filtered to `center_type = 'Profit'`. Hidden entirely for `TYPE = Profit` rows. |

**"Required" timing across the rollout window, enforced consistently client- and server-side:** §7 ships this UI (step 2) before the backfill (step 3) and before derivation goes live (step 4). If the field were hard-required from step 2 onward at *either* layer, existing Cost centers with `profit_center_id = NULL` couldn't be edited (even just renamed) until someone assigned them. The fix is the `center_derivation_enabled` setting from §2/§3: both the UI and `center.save` check the same flag, so there's no window where the client is lenient but the server rejects anyway (or vice versa). Before step 4 flips the flag, an unset Profit Center shows an inline "assignment pending" indicator in the list but does not block saving. `center.save`:

```js
// center.js (or wherever center.* actions dispatch) — center.save
async function saveCenter(db, companyId, input) {
  const { center_id, center_type, name, profit_center_id, is_active } = input;

  if (!['Cost', 'Profit'].includes(center_type)) {
    throw new Error(`center_type must be 'Cost' or 'Profit'`);
  }

  if (center_type === 'Cost') {
    if (profit_center_id) {
      // If supplied, it must always be valid — this check is unconditional,
      // regardless of the derivation-enabled gate below.
      const [target] = await db.query(
        `SELECT center_type FROM centers WHERE company_id=? AND center_id=?`,
        [companyId, profit_center_id]
      );
      if (!target || target.center_type !== 'Profit') {
        throw new Error(`${profit_center_id} is not a valid profit center`);
      }
    } else if (await isDerivationEnabled(db, companyId)) {
      // Only *required* once derivation is live (§2, §7 step 4). Before
      // that, saving a Cost center with no assignment yet is allowed so
      // existing centers stay editable during the backfill window.
      throw new Error(`Cost center ${center_id} requires a profit_center_id`);
    }
  } else if (profit_center_id) {
    throw new Error(`Profit centers must not set profit_center_id`);
  }

  const [existing] = await db.query(
    `SELECT 1 FROM centers WHERE company_id=? AND center_id=?`,
    [companyId, center_id]
  );
  if (!existing) {
    await db.exec(
      `INSERT INTO centers (company_id, center_id, center_type, name, profit_center_id, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [companyId, center_id, center_type, name, profit_center_id ?? null, is_active ?? true]
    );
  } else {
    await db.exec(
      `UPDATE centers SET center_type=?, name=?, profit_center_id=?, is_active=?
       WHERE company_id=? AND center_id=?`,
      [center_type, name, profit_center_id ?? null, is_active ?? true, companyId, center_id]
    );
  }
}
```

And `center.list` needs the joined query so the UI can render the Profit Center dropdown's current value by name, not just id:

```js
// center.list — extended SELECT with self-join for the assigned profit center's name
async function listCenters(db, companyId) {
  return db.query(
    `SELECT c.company_id, c.center_id, c.center_type, c.name, c.is_active,
            c.profit_center_id, pc.name AS profit_center_name
     FROM centers c
     LEFT JOIN centers pc
       ON pc.company_id = c.company_id AND pc.center_id = c.profit_center_id
     WHERE c.company_id = ?
     ORDER BY c.center_type, c.name`,
    [companyId]
  );
}
```

### 6b. Bill entry form

Per our earlier discussion: keep the `cost_center` input, **remove** the `profit_center` input box entirely. Once §4b lands *and derivation is enabled*, the field has nothing for a human to correctly fill in anyway — showing it invites exactly the mismatch this spec closes. (Granularity is header-level per §4b — one dropdown per bill, not per line.)

### 6c. Sales invoice / AR

The README flags AR as **dropped/deferred** ("nav and page scaffolding remain in place but inactive") — so no invoice form work needed right now. When AR comes back, apply the mirror-image rule from earlier in this conversation: invoice lines carry no `cost_center` input, and `profit_center` derives from the product/item master (would need a `profit_center_id` column added to whatever product/item table AR eventually uses) rather than from a `centers`-side lookup.

## 7. Rollout order

1. Schema migration (§2) — safe, additive, no behavior change yet. Seeds `center_derivation_enabled = 'false'` for every company.
2. Ship the Settings UI (§6a) — Profit Center field visible; `center.save` allows Cost centers to save without it because the setting is still `false`.
3. Ship the derivation code (§4) in `journal.js`/`bills.js`/`bank.js`. Because every call site checks `isDerivationEnabled` first, this deploy is inert on its own — no posting behavior changes yet, so it can ship independently of the backfill's progress and doesn't need to be coordinated with step 4 below.
4. Backfill (§5.1) using whatever pairings already exist in the data. Use the integrity-report check (§5.2) or the list view's "pending" indicator to confirm all active Cost centers are assigned before moving on.
5. Flip `center_derivation_enabled` to `'true'` via `settings.save` (owner role) for the company. This is the actual cutover: postings start deriving/validating `profit_center`, and `center.save` starts requiring the assignment on new/edited Cost centers. Since steps 3–4 are already in place, this step is a pure config change with no accompanying code deploy.
6. Remove the bill form's `profit_center` input (§6b) — do this *after* step 5, not before, or users lose the ability to set it manually while derivation isn't live yet.
7. Add the integrity-report check (§5.2) as an ongoing safety net, if not already added in step 4.
8. Tests (§8) should land alongside their corresponding code, not as a final step — listed separately here only for visibility.

## 8. Testing

- **Unit — `deriveProfitCenter`:** happy path (Cost center with valid `profit_center_id`); unknown `center_id`; wrong type (passing a Profit center's id as a cost center); inactive center with `allowInactive: false` (throws) and `allowInactive: true` (succeeds); Cost center with no `profit_center_id` assigned.
- **Unit — `isDerivationEnabled`:** returns `false` when the setting is missing or `'false'`; returns `true` only when it's exactly `'true'`.
- **Unit — `center.save`:** rejects invalid `center_type`; with `center_derivation_enabled = 'false'`, allows a Cost center to save with no `profit_center_id`; with it `'true'`, rejects the same save; if `profit_center_id` *is* supplied, always validates it points at a Profit center regardless of the flag; rejects Profit center with a non-null `profit_center_id`; insert vs. update path both enforce the same checks.
- **Integration — each write path, flag OFF (`center_derivation_enabled = 'false'`):**
  - `journal.post` with `cost_center` set does **not** call derivation and persists the caller-supplied `profit_center` (or its absence) unchanged.
  - `bill.create` with `cost_center` set behaves the same way — no derivation call, caller's `profit_center` passes through.
  - A firing `bank_mappings` tier-1 rule keeps its existing copy-forward `profit_center` behavior, unchanged from pre-migration.
- **Integration — each write path, flag ON (`center_derivation_enabled = 'true'`):**
  - `journal.post` with `cost_center` set derives the correct `profit_center` and persists it.
  - `journal.propose` → `journal.approve` re-derives at approval time (test: change the cost center's `profit_center_id` between propose and approve, confirm the approved entry uses the *new* assignment).
  - `bill.create` (draft, via agent role) derives correctly and rejects an unknown `cost_center`.
  - A firing `bank_mappings` tier-1 rule produces a `journal.propose` payload with a derived (not copied) `profit_center`.
  - Tiers 2–4 in `bank.js` do not propagate a stale `profit_center` from a matched historical bill/entry.
- **Validation (`validateCenterConsistency`, always exercised with the flag ON since it's only invoked from inside that branch):**
  - `cost_center` set, `profit_center` omitted → backfilled to the derived value, no error.
  - `cost_center` set, `profit_center` set but mismatched → throws.
  - `cost_center` set, `profit_center` set and matching → passes through unchanged.
  - Called with `allowInactive: true` (batch has `reverses` set) → passes for an inactive cost center that a non-reversal call (`allowInactive: false`) would reject.
- **Integrity report:** seed a `journal_entries`/`bills` row with a `(cost_center, profit_center)` pair that doesn't match `centers.profit_center_id`, confirm the report flags it.
- **Correction path (end-to-end, flag ON):** deactivate a Cost center referenced by an existing posted entry, then run `journal.reverse` against that entry — confirm the reversal succeeds (inline derivation in §4a *and* `validateCenterConsistency` in §4d both receive `allowInactive: true` and neither throws).
- **Cutover sequencing (end-to-end):** with the flag OFF, post a bill against a Cost center that has no `profit_center_id` assigned yet — confirm it succeeds. Then flip the flag ON without changing any data, and confirm the same posting now fails with "Cost center ... has no profit center assigned" — proving step 5 in §7 is a clean, code-free cutover.
