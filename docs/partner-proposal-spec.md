# Partner Proposal & Partners Unification Spec

**Status:** Draft (for ratification).
**Depends on:** agent-readiness-spec (R2, §2.3 whitelist, §10 inbox taxonomy, §5.2 MCP manifest), bank-matching-spec (cascade tiers 1–4, §8.2 action table, §9 write-permission boundary), bank-mapping-suggestions-spec (§3 crystallization, §4 conflict detection), bill-extraction-spec (agent `bill.create` draft flow).
**Closes:** issue #116.
**Amends:** agent-readiness-spec §7 ("Agent-proposed master data … stays human-only until a proposal pattern for master data is designed" — this spec IS that pattern).

---

## 0. Context and scope

### 0.1 The new-vendor problem (issue #116)

When the bank statement matching cascade encounters a counterparty that isn't in the vendor master, the line falls through to tier-4 LLM reasoning. The LLM can classify the transaction (suggest an account, VAT code), but it cannot create the vendor — there's no `vendor.propose` action. The operator must manually create the vendor in the Payables > Vendors tab, then re-match the statement line. If the same counterparty appears again next month, it matches at tier 3 only if the operator remembered to create the vendor; otherwise it's tier 4 again — wasted LLM calls and manual friction on a recurring counterparty.

The same gap exists on the bill-extraction side: when the agent extracts a supplier invoice (`bill.create`) for a vendor not in the master, it creates the bill draft with a vendor name string, but the vendor doesn't exist in the master data. Tier 3 can't match future bank transactions to this vendor by name because the vendor isn't registered.

### 0.2 Partners unification

Vendors and customers are the same entity — a business partner. Today only vendors exist (the `vendors` table); AR/customers are unbuilt (P3-1, dropped). When AR ships, creating a separate `customers` table would duplicate the master-data model (name, tax_id, currency, payment terms, bank details). Instead, unify into a single `partners` table with `is_vendor` / `is_customer` tickbox flags. A partner can be a vendor, a customer, or both.

This is a structural prerequisite for the vendor proposal flow: the proposal creates a partner, not a vendor, so the table and actions should reflect the unified model from the start rather than renaming later.

### 0.3 What this spec covers

- §1 — Partners model: rename `vendors` → `partners`, add `is_vendor`/`is_customer` flags, add AR-side account columns.
- §2 — Partner proposal flow: agent proposes a new partner from bank-statement matching or bill extraction; human approves in the inbox; auto-learns the mapping.
- §3 — Schema: `partners` table (renamed), `partner_proposals` table (new).
- §4 — API actions: renamed existing actions + new proposal actions.
- §5 — Inbox integration: Class B item type `partner_proposal`.
- §6 — Agent loop integration: trigger points and logic.
- §7 — Migration: schema + code changes.
- §8 — Future: AR customer proposals (P3-1 extension point).

### 0.4 What this spec does NOT cover

- AR/invoicing module itself (P3-1 — the full invoice lifecycle, AR aging, receipts).
- Bank feeds (P3 — the feed adapter).
- Receivables matching (the tier-2 open-item cascade on the AR side).
- Vendor bank-detail fields (agent-readiness-spec §7, §9: human-only permanently — BEC fraud vector). This spec does not add bank-account fields to the partners table; when they arrive, they stay human-only.

### 0.5 Scale assumptions

Same as bank-matching-spec §0.1 — small AB, tens of bank-statement lines per month, single-digit new vendors per year. The partner proposal flow is not a high-volume automated pipeline; it's a friction-reduction measure for the handful of times a year a new counterparty appears. The proposal/approval pattern (human reviews every proposal) is the right level of automation at this scale — no auto-creation, no batch approval.

---

## 1. Partners model

### 1.1 Why unify

A vendor and a customer are the same real-world entity: a business partner. Many small businesses have partners who are both — a supplier you also sell to, a consultant who invoices you and is also a customer. Maintaining separate `vendors` and `customers` tables duplicates: name, tax_id, default currency, payment terms, notes, is_active, and (future) bank-account details. It also splits the master-data UI into two pages when a single page with tickboxes is simpler and matches the operator's mental model.

Industry precedent: Xero uses a single "Contacts" list with no vendor/customer distinction at the table level; QBO has separate vendor/customer lists but allows "dual" entries. The unified model is the cleaner design and is what Magnus specified.

### 1.2 Table rename: `vendors` → `partners`

Rename the existing `vendors` table to `partners`. Rename `vendor_id` → `partner_id`. Add columns:

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `is_vendor` | BOOLEAN | TRUE | Partner is a vendor (AP side). Existing rows backfilled TRUE. |
| `is_customer` | BOOLEAN | FALSE | Partner is a customer (AR side). Existing rows backfilled FALSE. |
| `default_revenue_account` | VARCHAR | NULL | AR side: default revenue account when entering an invoice. Nullable — unused until AR ships. |
| `default_ar_account` | VARCHAR | NULL | AR side: default AR control account. Nullable — unused until AR ships. |

The existing columns stay: `name`, `default_currency`, `payment_terms_days`, `tax_id`, `notes`, `is_active`, `default_expense_account`, `default_ap_account`, `created_at`.

A partner with `is_vendor=TRUE, is_customer=FALSE` is a pure vendor (today's behavior). A partner with `is_vendor=TRUE, is_customer=TRUE` is both. A partner with `is_vendor=FALSE, is_customer=TRUE` is a pure customer (only possible when AR ships — v1 won't create these).

### 1.3 Action rename

Existing actions rename from `vendor.*` to `partner.*`:

| Old | New | Role | Notes |
|-----|-----|------|-------|
| `vendor.list` | `partner.list` | viewer | Add optional `partner_type` param: `'vendor'` filters `is_vendor=TRUE`, `'customer'` filters `is_customer=TRUE`, omit = all. |
| `vendor.save` | `partner.save` | owner | Bulk replace. |
| `vendor.delete` | `partner.delete` | owner | Delete by `partnerId`. |
| `vendor.upsert` | `partner.upsert` | owner | Insert/update one partner. `vendorId` param → `partnerId`. |

Backward compatibility: the dispatch handler accepts both old and new action names for one release cycle, logging a deprecation warning on old names. This avoids breaking any external scripts or MCP clients that call `vendor.list`.

**This is net-new machinery — there is no existing alias/deprecation mechanism in the dispatcher.** Today `index.js` line 309 does `const [module] = action.split('.')` and switches on the module prefix (`vendor` → `handleVendors`). The alias map is a new step inserted before the switch:

```javascript
// In index.js handleApiRequest (and _dispatchAction), before the switch:
const ACTION_ALIASES = {
  'vendor.list':   'partner.list',
  'vendor.save':   'partner.save',
  'vendor.delete': 'partner.delete',
  'vendor.upsert': 'partner.upsert',
};
const resolvedAction = ACTION_ALIASES[action] || action;
if (ACTION_ALIASES[action]) {
  console.warn(`[DEPRECATION] action '${action}' is deprecated, use '${resolvedAction}'`);
}
const [module] = resolvedAction.split('.');
// … existing switch on module …
```

This is ~10 lines in `index.js`, applied in both `handleApiRequest` (line 307) and `_dispatchAction` (line 1700) — the two dispatch paths. The alias map is a flat object, not a framework; it has no config surface and no external dependencies. After one release cycle, the map and the warning are deleted along with the old action names.

### 1.4 UI

The Payables > Vendors tab renames to "Partners." The FB.list config adds two checkbox columns: `is_vendor` and `is_customer`. The `partner_type` filter on `partner.list` lets the bills dropdown show only `is_vendor=TRUE` partners. When AR ships, the invoices dropdown filters `is_customer=TRUE`.

The partners tab stays under Payables for now (all partners are vendors today). When AR ships (P3-1), Partners moves to a top-level sidebar item — it serves both AP and AR and doesn't belong under either.

The `bills` table's `vendor` column (a VARCHAR name string, not a FK) stays as-is — it's a denormalized name. Renaming it to `partner_name` is a cosmetic cleanup that touches every bills query; deferred to a future refactor. The bills dropdown in bill-entry reads from `partner.list` filtered to `is_vendor=TRUE`.

**Command-palette entries** (`action-catalog.js` lines 706–707): `vendor.save` and `vendor.upsert` each have a `palette: 'navigate'` entry routing to `/payables?tab=vendors`. These rename to `partner.save` / `partner.upsert` and the route updates to `/payables?tab=partners` (the tab label change). The palette registry is a flat object at the bottom of `action-catalog.js`; old-name entries are removed, new-name entries added. If the alias map (§1.3) is in place, old-name palette entries could be retained temporarily, but since the palette is a UI affordance (not an API contract), it's cleaner to rename outright — the alias map covers API callers, not palette search.

---

## 2. Partner proposal flow

### 2.1 The pattern

The proposal flow follows the exact shape established by `mapping.suggest` → `mapping.suggestion.approve`/`.reject` (bank-matching-spec §10.1, §10.4) and `journal.propose` → `journal.approve`/`.reject` (agent-readiness-spec §4):

1. **Agent proposes** — calls `partner.propose`, which writes to `partner_proposals` (a proposal table, never `partners` itself).
2. **Human reviews** — the proposal surfaces in the inbox as a Class B item (`partner_proposal`). `y` approves, `x` rejects.
3. **Approval is the write** — `partner.proposal.approve` inserts the row into `partners` (human-attributed). R2 satisfied: the agent never writes to `partners` (master data); the mutation is always attributed to the human who approved.
4. **Auto-learn** — after approval, if the originating bank line had a description pattern, a mapping suggestion is created (§2.5) so future transactions match at tier 1.

```
              partner.propose (agent)
                      │
                      ▼
                 proposed ────── partner.proposal.reject (human) ──▶ rejected  [terminal,
                      │              no note required                  kept for audit]
         partner.proposal.approve (human)
                      ▼
                   approved ──▶ partners row created (is_active=TRUE)
                                 + mapping.suggest (if description pattern exists)
```

### 2.2 Why Class B, not Class A

A partner proposal is a master-data decision, not a ledger approval. Approving it doesn't post journal entries — it creates a row in `partners`. This is the same distinction as `mapping_suggestion` (Class B) vs `journal_proposal` (Class A). The inbox taxonomy (agent-readiness-spec §10.2) places master-data decisions in Class B.

### 2.3 When to propose — trigger points

Two trigger points, both in the agent loop:

**Trigger A — Bank statement matching (tier 4 residual).** After the tier-4 LLM processes a residual line and returns a proposal with a counterparty name that doesn't match any existing partner with `is_vendor=TRUE`, the agent calls `partner.propose`. The LLM's suggested account becomes the proposed `default_expense_account`; the company's default AP account (account with `default_role='AP'`) becomes the proposed `default_ap_account`.

**Trigger B — Bill extraction.** When the agent extracts a supplier invoice and calls `bill.create`, if the extracted vendor name doesn't match any existing partner, the agent also calls `partner.propose`. The bill draft is still created (with the vendor name string) — it doesn't wait for the partner to be approved. The partner proposal is a side effect, surfacing in the inbox alongside the bill draft.

Both triggers check the same preconditions (§2.4) and produce the same proposal shape.

### 2.4 Duplicate detection

Before calling `partner.propose`, the agent checks:

1. **Existing partner:** `SELECT partner_id FROM partners WHERE company_id = @cid AND LOWER(name) = LOWER(@name) AND is_vendor = TRUE`. If a partner with this name already exists (case-insensitive), skip — the vendor is already in the master. (Tier 3 should have matched, but this guards against case-sensitivity gaps in the substring match.)
2. **Pending proposal:** `SELECT proposal_id FROM partner_proposals WHERE company_id = @cid AND LOWER(name) = LOWER(@name) AND status = 'proposed'`. If a proposal already exists for this name, skip — don't create duplicates.

If both checks pass, the agent calls `partner.propose`. The duplicate detection runs inside the `partner.propose` handler too (server-side, not just agent-side) — same pattern as `mapping.suggest`'s conflict check (bank-mapping-suggestions-spec §4.5).

### 2.5 Auto-learning after approval

When `partner.proposal.approve` creates the partner, it also checks whether a mapping suggestion should be created:

1. If the proposal carries a `source_proposal_id` (the `journal_proposals` row it originated from), fetch that proposal's description (the bank line description).
2. Normalize the description (same `normalizeDescription` function used by the cascade — bank-mapping-suggestions-spec §3.3).
3. Check whether an active mapping rule already exists for this pattern. If not, check whether a pending mapping suggestion already exists. If neither, call `mapping.suggest` with:
   - `description_pattern` — the normalized pattern
   - `suggested_account` — the approved partner's `default_expense_account`
   - `suggested_vat_code` — if present in the proposal
   - `evidence` — citing the approved partner proposal and the original journal proposal
   - `source_proposal_id` — the original `journal_proposals` row

This means after a partner is approved, the next bank statement line from the same counterparty matches at tier 1 (learned rule) — no LLM call, no inbox friction. The mapping suggestion still goes through its own human approval (bank-matching-spec §10.4) — the auto-learning creates the *suggestion*, not the rule itself.

### 2.6 What the agent cannot propose

- **Bank-account details** — agent-readiness-spec §9: counterparty bank-account data is human-only permanently (BEC fraud vector). The `partner.propose` action has no bank-account fields. When bank-detail fields are added to `partners` in the future, they are human-only, and the proposal flow does not touch them.
- **Account creation** — the agent proposes a partner with *suggested* default account codes (from existing accounts in the COA). It cannot propose creating new accounts. An unknown account code fails validation at propose time, same as `vendor.upsert` today.

---

## 3. Schema

### 3.1 `partners` table (renamed from `vendors`)

**All partners-table ALTERs run in `init.js` as `applyPartnersMigration()`, not in `schema.sql`.** See §7.1 for the full rationale (the rename can't be idempotent in `schema.sql`'s sequential `runNext()` executor, and the `ADD COLUMN` statements depend on the rename having already run — if they stay in `schema.sql` they fire against a table still named `vendors`). The complete migration, in execution order:

```sql
-- Step 1 (init.js applyPartnersMigration): rename table + column
ALTER TABLE vendors RENAME TO partners;
ALTER TABLE partners RENAME COLUMN vendor_id TO partner_id;

-- Step 2 (init.js applyPartnersMigration, after rename succeeds):
ALTER TABLE partners ADD COLUMN IF NOT EXISTS is_vendor BOOLEAN DEFAULT TRUE;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS is_customer BOOLEAN DEFAULT FALSE;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS default_revenue_account VARCHAR;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS default_ar_account VARCHAR;

-- Step 3 (init.js applyPartnersMigration, after columns added): update indexes
DROP INDEX IF EXISTS idx_vendors_company;
DROP INDEX IF EXISTS idx_vendors_name;
CREATE INDEX IF NOT EXISTS idx_partners_company ON partners(company_id);
CREATE INDEX IF NOT EXISTS idx_partners_name ON partners(name);
CREATE INDEX IF NOT EXISTS idx_partners_vendor ON partners(company_id, is_vendor) WHERE is_vendor = TRUE;
CREATE INDEX IF NOT EXISTS idx_partners_customer ON partners(company_id, is_customer) WHERE is_customer = TRUE;
```

The `CREATE TABLE IF NOT EXISTS partner_proposals` statement (§3.2) stays in `schema.sql` — it's a new table with no dependency on the rename, and `IF NOT EXISTS` makes it naturally idempotent.

Existing rows: `is_vendor` backfills TRUE (they're all vendors today), `is_customer` backfills FALSE. The DEFAULT on the column handles this — no explicit UPDATE needed.

### 3.2 `partner_proposals` table (new)

```sql
CREATE TABLE IF NOT EXISTS partner_proposals (
  company_id              VARCHAR NOT NULL,
  proposal_id             VARCHAR NOT NULL UNIQUE,
  name                    VARCHAR NOT NULL,          -- extracted counterparty name
  tax_id                  VARCHAR,                   -- if extractable
  default_currency        VARCHAR,
  payment_terms_days      INTEGER DEFAULT 30,
  default_expense_account VARCHAR,                   -- from LLM suggestion or bill extraction
  default_ap_account      VARCHAR,                   -- from company default AP account
  suggested_vat_code      VARCHAR,                   -- from LLM suggestion
  is_vendor               BOOLEAN DEFAULT TRUE,      -- always TRUE for vendor proposals
  is_customer             BOOLEAN DEFAULT FALSE,     -- could be TRUE if LLM detects both directions
  evidence                JSON,                      -- why the agent is proposing this
  source_proposal_id      VARCHAR,                   -- the journal_proposals row it came from (bank matching)
  source_bill_id          VARCHAR,                   -- the bills row it came from (bill extraction)
  source_description      VARCHAR,                   -- normalized bank line description (for auto-learning)
  status                  VARCHAR NOT NULL DEFAULT 'proposed',  -- proposed | approved | rejected
  created_by              VARCHAR NOT NULL,
  reviewed_by             VARCHAR,
  reviewed_at             TIMESTAMP,
  created_at              TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_partner_proposals_company_status ON partner_proposals(company_id, status);
CREATE INDEX IF NOT EXISTS idx_partner_proposals_name ON partner_proposals(company_id, name);
```

Same lifecycle as `mapping_suggestions` (bank-matching-spec §10.2): `proposed → approved | rejected`, `approved` is the write (inserts into `partners`). `rejected` is terminal. The table is the owning table for this item type (R8 — no staging entity beyond this one table).

---

## 4. API actions

### 4.1 Renamed existing actions

See §1.3. The dispatch handler accepts both old and new names via an alias map for one release cycle.

### 4.2 New proposal actions

| Action | Role | Mutating | Idempotent | Agent-writable | Purpose |
|--------|------|----------|------------|----------------|---------|
| `partner.propose` | `agent` | ✓ | ✓ | ✓ | Agent proposes a new partner. Writes to `partner_proposals`, never to `partners`. Runs duplicate detection at creation (§2.4). |
| `partner.proposal.approve` | `data_entry` | ✓ | — | — | `proposed → approved`. Validates account codes, inserts into `partners` (human-attributed), calls `mapping.suggest` if auto-learning applies (§2.5). Not in AGENT_ALLOWED — human-only. |
| `partner.proposal.reject` | `data_entry` | ✓ | — | — | `proposed → rejected`, terminal. No note required (same as `mapping.suggestion.reject` — a discarded partner proposal is a lighter decision than a rejected journal entry). Not in AGENT_ALLOWED. |
| `partner.proposal.list` | `viewer` | — | — | — | List partner proposals (filter by status: proposed/approved/rejected). |
| `partner.proposal.get` | `viewer` | — | — | — | Get one partner proposal by id. |

**Catalog role notes:**

`partner.propose` uses role `agent` (1.5), not `data_entry` (2) — same dispatch-ordering fix as `journal.propose`, `bank.match`, `mapping.suggest`, and `bill.create` (agent-readiness-spec §4.3). `agent` admits agents (1.5≥1.5), data_entry (2), owner (3); viewers (1) excluded. `agentWritable: true` so the AGENT_ALLOWED set admits it.

`partner.proposal.approve`/`.reject` use role `data_entry` (2), not `agent` — the inverse fix: `data_entry` rejects an agent actor (1.5 < 2) at the numeric role check, which is the point (human-only finalizers). No MCP tool for approve/reject — same as `mapping.suggestion.approve`/`.reject` and `journal.approve`/`.reject` (agent-readiness-spec §5.2).

### 4.3 `partner.propose` parameters

```
partner.propose:
  proposalId            : string  (optional — for idempotent upsert, same-caller only)
  name                  : string  (required)
  tax_id                : string  (optional)
  default_currency      : string  (optional)
  payment_terms_days    : integer (optional, default 30)
  default_expense_account: string (optional — from LLM suggestion)
  default_ap_account    : string  (optional — from company default)
  suggested_vat_code    : string  (optional)
  is_vendor             : boolean (optional, default true)
  is_customer           : boolean (optional, default false)
  evidence              : object  (required — why the agent is proposing)
  source_proposal_id    : string  (optional — journal_proposals row)
  source_bill_id        : string  (optional — bills row)
  source_description    : string  (optional — normalized bank line description)
```

With `proposalId`: upserts a still-`proposed` row created by the same caller (same idempotent-retry convention as `journal.propose` and `mapping.suggest`). Cannot touch another actor's proposal or a non-`proposed` row.

### 4.4 MCP tool

New MCP tool: `partner_propose` — maps to `partner.propose`. Same reasoning as `mapping_suggest` and `bill_create` (agent-readiness-spec §5.2): it's a write, so `freebooks_read` can't cover it, and it gets its own dedicated tool. No `partner_proposal_approve`/`_reject` tool exists or should exist — those are human-only, mirroring the absence of `journal_approve`/`mapping_suggestion_approve`/`bill_post` tools.

### 4.5 Events

New event types (emitted by the handlers, same `emitEvent` pattern):

| Event | Emitted at |
|-------|-----------|
| `partner.proposed` | `partner.propose` — proposal created |
| `partner.proposal.approved` | `partner.proposal.approve` — partner created in `partners` |
| `partner.proposal.rejected` | `partner.proposal.reject` — proposal rejected |

The agent reads these via `event.list` to know whether its proposal was adopted (so it doesn't re-propose an already-rejected partner).

---

## 5. Inbox integration

### 5.1 Class B item type

New Class B type: `partner_proposal`.

```
{
  type: 'partner_proposal',
  source: 'agent',
  counterparty: name,                    // the proposed partner name
  amount: null,                          // not applicable
  date: created_at,
  proposed_at: created_at,
  summary: 'New partner suggested: <name>',
  verbs: ['approve', 'reject', 'open'],
  payload_ref: proposal_id,
  status: 'proposed',
  reference: name,
  description: name,
  created_by: created_by
}
```

Verbs: `y` (approve → `partner.proposal.approve`), `x` (reject → `partner.proposal.reject`), Enter (unfold → `partner.proposal.get` for detail). Same queue idiom as `mapping_suggestion` (agent-readiness-spec §10.4, bank-matching-spec §10.4).

### 5.2 Inbox query

`inbox.list` with `status='partners'` fans out to `queryPartnerProposals(companyId, limit)` — `partner_proposals WHERE status='proposed'`, ordered by `created_at DESC`. Normalized to the standard item shape.

The inbox `f` filter cycle gains a new state: `proposed → rejected → bills → suggestions → partners → proposed` (or the cycle is made dynamic based on which types have items — implementation detail).

### 5.3 Unfold detail

Unfolding a `partner_proposal` item fetches `partner.proposal.get` and renders:

- Proposed name, tax_id, currency, payment terms
- Suggested `default_expense_account`, `default_ap_account`, `suggested_vat_code`
- Evidence (why the agent proposed this — citing the source bank line or bill)
- Source proposal/bill link (if `source_proposal_id` or `source_bill_id` exists)

The human can approve as-is, or reject and manually create the partner with corrections via the Partners tab.

---

## 6. Agent loop integration

### 6.1 Trigger A — Bank statement matching

In `processBankStatement` (agent-loop.js), after the tier-4 LLM returns proposals and `journal.propose` is called for each, the agent checks each tier-4 proposal for a counterparty name:

1. **Extract the counterparty name.** The tier-4 LLM's structured response (`tier4LLMReason` return value, agent-loop.js line 302–311) is a flat array of proposal objects. Each proposal may carry `suggested_dimensions.counterparty` (the bank-matching-spec §1 per-line output shape). If present, that's the counterparty name. If absent (the LLM didn't return it — current `tier4LLMReason` doesn't enforce this field), fall back to extracting a name from the bank line description via the same normalization used for mapping patterns (bank-mapping-suggestions-spec §3.3) — strip dates, reference numbers, currency fragments, and take the leading merchant token. This is a heuristic; the human reviews the proposal regardless. Store the extracted name on the `partner.propose` call as `name`. Check whether a partner with that name exists (§2.4 check 1).
2. If no partner exists and no pending proposal exists (§2.4 check 2), call `partner.propose` with:
   - `name` — the extracted counterparty name
   - `default_expense_account` — the LLM's suggested account (from the proposal's `lines[0].account_code`)
   - `default_ap_account` — the company's default AP account (fetched via `account.list`, filtered by `default_role='AP'`)
   - `suggested_vat_code` — from the proposal's lines (if present)
   - `evidence` — citing the tier-4 LLM source, the bank line description, and the journal proposal id
   - `source_proposal_id` — the journal proposal id
   - `source_description` — the normalized bank line description

This is a best-effort side effect — if `partner.propose` fails (e.g., duplicate detection catches a race), the agent logs a warning and continues. The journal proposal is not affected.

### 6.2 Trigger B — Bill extraction

In the bill-extraction flow (agent-loop.js, `processBill`), after `bill.create` creates the draft, the agent checks the extracted vendor name:

1. If the vendor name doesn't match any existing partner, and no pending proposal exists, call `partner.propose` with:
   - `name` — the extracted vendor name
   - `default_expense_account` — from the bill's `expense_account` (if the extraction LLM suggested one)
   - `default_ap_account` — company default AP account
   - `evidence` — citing the bill extraction source and the bill id
   - `source_bill_id` — the bill id

Same best-effort pattern — failure doesn't affect the bill draft.

### 6.3 Throttling

No throttling needed beyond the duplicate detection (§2.4). A counterparty that appears on multiple statements in the same month produces at most one proposal (subsequent occurrences are blocked by the pending-proposal check). After approval, the partner exists and tier 3 matches — no more proposals for the same name.

---

## 7. Migration

### 7.1 Schema migration

**The rename CANNOT live in `schema.sql`.** `db/init.js` runs `schema.sql` statements sequentially via `runNext()` (line 180–201); any single statement error calls `process.exit(1)` — there is no warn-and-continue path. The existing `ADD COLUMN IF NOT EXISTS` / `DROP COLUMN IF EXISTS` migrations are naturally idempotent, so they survive re-runs inside `schema.sql` without issue. But `ALTER TABLE vendors RENAME TO partners` has no `IF EXISTS` guard in DuckDB — on the second run, `vendors` no longer exists and the statement throws, hard-failing init for every existing installation on every future `git pull && node db/init.js`.

**This is a new kind of migration for this codebase.** No prior migration in `schema.sql` uses `RENAME TABLE` or `RENAME COLUMN` — every prior migration is `ADD COLUMN IF NOT EXISTS` or `DROP COLUMN IF EXISTS`, both naturally idempotent. The one prior encounter with DuckDB's `ALTER TABLE` limits (`ADD CONSTRAINT` unsupported, needing a feature-detection fallback in `init.js` lines 137–178) suggests `RENAME` compatibility should not be assumed either.

**Resolution: the rename runs as a guarded step in `init.js`, not in `schema.sql`.** This follows the exact precedent of `applyUniqueConstraints()` (init.js lines 137–178) — a migration step that:
- Runs after `schema.sql` statements complete
- Pre-checks whether the migration is needed (query `duckdb_tables()` / `information_schema.tables` for `vendors` vs `partners`)
- Skips silently if already migrated (idempotent)
- Feature-detects DuckDB `RENAME TABLE` / `RENAME COLUMN` support with try/catch
- Falls back to a `CREATE TABLE partners AS SELECT … FROM vendors` + `DROP TABLE vendors` if `RENAME` is unsupported (same fallback-to-plan-B pattern as the constraint migration)
- Never calls `process.exit(1)` — logs a warning on failure and continues

**Concrete implementation:**

```javascript
// In init.js, as a new async function applyPartnersMigration(conn), called
// after schema.sql statements complete, before seedJournals():

async function applyPartnersMigration(conn) {
  // Check whether vendors table still exists (pre-migration state)
  const vendorExists = await conn.runAndReadAll(
    `SELECT table_name FROM duckdb_tables() WHERE table_name = 'vendors'`, []);
  if (vendorExists.getRowObjects().length === 0) return; // already migrated

  // Check whether partners table already exists (partial migration?)
  const partnerExists = await conn.runAndReadAll(
    `SELECT table_name FROM duckdb_tables() WHERE table_name = 'partners'`, []);
  if (partnerExists.getRowObjects().length > 0) {
    // partners exists but vendors still exists — drop vendors (data already migrated)
    await conn.run('DROP TABLE vendors', []);
    return;
  }

  // Attempt RENAME TABLE + RENAME COLUMN
  try {
    await conn.run('ALTER TABLE vendors RENAME TO partners', []);
    try {
      await conn.run('ALTER TABLE partners RENAME COLUMN vendor_id TO partner_id', []);
    } catch (colErr) {
      console.warn(`RENAME COLUMN unsupported (${String(colErr.message).split('\\n')[0]}) — partner_id rename skipped, column stays vendor_id`);
    }
    console.log('Vendors table renamed to partners.');
  } catch (renameErr) {
    // RENAME TABLE unsupported — fallback: CREATE TABLE + DROP TABLE
    console.warn(`RENAME TABLE unsupported (${String(renameErr.message).split('\\n')[0]}) — using CREATE+DROP fallback.`);
    await conn.run(
      `CREATE TABLE partners AS SELECT
        vendor_id AS partner_id, company_id, name, default_currency,
        payment_terms_days, tax_id, notes, is_active, created_at,
        default_expense_account, default_ap_account
       FROM vendors`, []);
    await conn.run('DROP TABLE vendors', []);
    console.log('Partners table created from vendors (CREATE+DROP fallback).');
  }

  // Add partner-type flags + AR-side columns (after rename, so table exists)
  await conn.run('ALTER TABLE partners ADD COLUMN IF NOT EXISTS is_vendor BOOLEAN DEFAULT TRUE', []);
  await conn.run('ALTER TABLE partners ADD COLUMN IF NOT EXISTS is_customer BOOLEAN DEFAULT FALSE', []);
  await conn.run('ALTER TABLE partners ADD COLUMN IF NOT EXISTS default_revenue_account VARCHAR', []);
  await conn.run('ALTER TABLE partners ADD COLUMN IF NOT EXISTS default_ar_account VARCHAR', []);

  // Update indexes (old indexes reference vendors table name)
  await conn.run('DROP INDEX IF EXISTS idx_vendors_company', []);
  await conn.run('DROP INDEX IF EXISTS idx_vendors_name', []);
  await conn.run('CREATE INDEX IF NOT EXISTS idx_partners_company ON partners(company_id)', []);
  await conn.run('CREATE INDEX IF NOT EXISTS idx_partners_name ON partners(name)', []);
  await conn.run('CREATE INDEX IF NOT EXISTS idx_partners_vendor ON partners(company_id, is_vendor) WHERE is_vendor = TRUE', []);
  await conn.run('CREATE INDEX IF NOT EXISTS idx_partners_customer ON partners(company_id, is_customer) WHERE is_customer = TRUE', []);
}
```

The `ADD COLUMN IF NOT EXISTS` statements for `is_vendor`, `is_customer`, `default_revenue_account`, `default_ar_account`, and the index drops/creates also run inside `applyPartnersMigration()`, **after** the rename succeeds — not in `schema.sql`. On first run, if they stayed in `schema.sql` they would fire against a table still named `vendors` (the rename hasn't happened yet), crashing `runNext()`. Only `CREATE TABLE IF NOT EXISTS partner_proposals` (§3.2) stays in `schema.sql` — it's a new table with no rename dependency.

**DuckDB version confirmed:** this codebase pins `@duckdb/node-api` 1.5.2-r.1 (DuckDB v1.5.2). Both `ALTER TABLE … RENAME TO` and `ALTER TABLE … RENAME COLUMN` are confirmed supported via runtime test. The try/catch + `CREATE+DROP` fallback is retained as defensive code for any future DuckDB version that changes `ALTER` behavior (same defensive posture as `applyUniqueConstraints`).

### 7.2 Code changes

| File | Change |
|------|--------|
| `db/schema.sql` | `CREATE TABLE IF NOT EXISTS partner_proposals` only. All partners-table ALTERs (rename, add columns, indexes) are in `db/init.js` — see below. |
| `db/init.js` | Add `applyPartnersMigration(conn)` — guarded `RENAME TABLE vendors → partners` + `RENAME COLUMN vendor_id → partner_id` with feature detection and `CREATE+DROP` fallback, followed by `ADD COLUMN IF NOT EXISTS` for `is_vendor`/`is_customer`/`default_revenue_account`/`default_ar_account`, then index drops/creates. Called after `schema.sql` statements, before `seedJournals()`. Follows the `applyUniqueConstraints()` precedent (lines 137–178). |
| `api/src/vendors.js` → `api/src/partners.js` | Rename file. All SQL: `vendors` → `partners`, `vendor_id` → `partner_id`. Add `partner.propose`/`.proposal.approve`/`.reject`/`.list`/`.get` handlers. Add duplicate detection. Add auto-learning (mapping.suggest call in approve). |
| `api/src/action-catalog.js` | Rename `vendor.*` → `partner.*` action entries. Add `partner.propose` (agent, agentWritable, idempotent), `partner.proposal.approve/reject` (data_entry), `partner.proposal.list/get` (viewer). Rename palette entries: `vendor.save`/`vendor.upsert` → `partner.save`/`partner.upsert`, route `/payables?tab=vendors` → `/payables?tab=partners` (lines 706–707). |
| `api/src/index.js` | Add `ACTION_ALIASES` map + deprecation warning before the dispatch switch (both `handleApiRequest` line 307 and `_dispatchAction` line 1700). Rename `case 'vendor'` → `case 'partner'` in the switch. Update import: `handleVendors` → `handlePartners`. |
| `api/src/bank.js` | Tier 3 query: `FROM vendors` → `FROM partners WHERE is_vendor = TRUE`, `vendor_id` → `partner_id` |
| `api/src/inbox.js` | Add `queryPartnerProposals()`. Add `status='partners'` filter. |
| `api/src/agent-loop.js` | Add partner-proposal triggers in `processBankStatement` (after tier-4) and `processBill` (after `bill.create`). |
| `api/src/pages/payables-vendors.js` | Rename to `payables-partners.js`. Action names → `partner.*`. Add `is_vendor`/`is_customer` checkbox columns. Tab label → "Partners". Deep-link `?tab=vendors` → `?tab=partners`. |
| `api/src/pages/bill-edit.js` | `vendor.list` → `partner.list` (with `partner_type='vendor'` filter). |
| `api/src/views.js` | `vendor.list` → `partner.list` in fan-out. |
| `api/src/journal.js` | No change — crystallization calls `mapping.suggest`, not vendor actions. |
| `mcp/src/manifest` | Add `partner_propose` tool. |
| `tests/` | Update contract tests for renamed actions. New tests for proposal flow. |

### 7.3 Backward compatibility

- Old action names (`vendor.list`, `vendor.upsert`, etc.) accepted via alias map for one release cycle. Deprecation warning logged.
- The `bills` table's `vendor` column (VARCHAR name) is unchanged — no migration of bills data.
- The `bill_payments` table is unchanged.
- Existing partners (all vendors today) get `is_vendor=TRUE, is_customer=FALSE` via the column DEFAULT — no explicit backfill needed.

---

## 8. Future: AR customer proposals (P3-1 extension point)

When AR ships (P3-1), the partner proposal flow extends naturally:

- **Customer proposal trigger:** when the agent processes a sales invoice or incoming payment for a counterparty not in `partners` with `is_customer=TRUE`, it calls `partner.propose` with `is_vendor=FALSE, is_customer=TRUE`.
- **AR-side account columns:** `default_revenue_account` and `default_ar_account` on `partners` are already in the schema (§3.1) — nullable, unused until AR ships.
- **AR control account:** the company's default AR account (account with `default_role='AR'` — to be added when AR ships) becomes the proposed `default_ar_account`.
- **Same inbox type:** `partner_proposal` — the inbox item doesn't distinguish vendor vs customer proposals in its type; the `is_vendor`/`is_customer` fields in the unfold detail make the distinction.
- **Same approval flow:** `partner.proposal.approve` creates the partner with the appropriate flags. No separate customer-proposal mechanism.

The partners table and proposal flow are designed to serve both AP and AR from the start. The only AR-specific addition is the trigger point (invoice/payment processing) and the AR-side account columns, which are already in the schema.

---

## 9. Open questions (resolved/tracked)

1. **Alias deprecation timeline.** ✅ Tracked — GitHub issue. Old `vendor.*` action names accepted via alias map for one release cycle. API is install-local; deprecation window can be short.

2. **`bills.vendor` column rename.** ✅ Tracked — GitHub issue. Deferred: the column is a denormalized name string; renaming touches every bills query. Flagged as future cleanup.

3. **Partner proposal + bill draft ordering.** ✅ Resolved — shipped as proposed (§9.3 original). Both items surface independently; `partner_proposals.source_bill_id` provides the data-level link. No explicit inbox linking needed. Closed with issue #116 / PR #124.

4. **Fuzzy duplicate detection.** ✅ Tracked — GitHub issue. Exact case-insensitive match shipped for v1. Fuzzy (trigram) deferred — revisit if duplicate proposals become noisy.

5. **UI: Partners as top-level sidebar item.** ❌ Obsolete — the sidebar is being dissolved (bank-dissolution-spec, ia-spec §5.3). Partners stays under Payables; no future sidebar move applies.
