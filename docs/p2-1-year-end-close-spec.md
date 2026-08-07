# P2-1 — Year-End Close & Period Close Support

**Date:** 2026-08-07 · **Status:** PROPOSED (awaiting magnus ratification)

## 1. Problem

freebooks has no `period.close` action. The balance sheet computes "Unallocated net income / (loss)" live from P&L account balances (`reports/render.js:121-174`) — functionally equivalent to QuickBooks' calculated Retained Earnings. This is correct for in-app reporting and already meets the bar for US-style companies that have no statutory export requiring materialized balances.

The gap: **statutory export formats that read materialized account balances**. SE's SIE export emits `#RES` lines from the Closing-type account (8999). Gredor's SIE parser derives "Årets resultat" exclusively from `#RES` lines. Without a posted closing entry, the SIE file is wrong regardless of what the app's live math says. SG has the same pattern (999999/203070). The driver is export-format requirements, not an accounting-philosophy difference between jurisdictions.

Secondary issues discovered during analysis:
- `re_rollforward` macro (`db/macros.sql:531`) and `integrity_extended` macro (`db/macros.sql:604`) hard-code SG account codes (999999/203070). Both report FAIL against SE companies. Same bug class: jurisdiction-specific account references not parameterized.
- `gl()` macro (`db/macros.sql:469-490`) computes opening balance as cumulative `SUM(debit_home) - SUM(credit_home)` before period start with no account-type distinction. Revenue/Expense accounts show stale cumulative opening balances (e.g. account 3001 shows opening 13,289 for FY2026 — all from 2015, no activity since). This is a pre-existing bug, not caused by the summary-close approach. Fix: `CASE` in the opening-balance CTE — temporary accounts always open at 0.

## 2. Design principles

1. **The live injection in `render.js` is the permanent source of truth for equity presentation** — not a fallback. It is the QuickBooks pattern: Retained Earnings is a calculated line, not a posted balance. This does not change.

2. **Closing entries exist solely to materialize balances for downstream export formats.** The requirement is "does a statutory export need a real ledger balance on the closing/RE account," not "does this jurisdiction use a different bookkeeping method."

3. **Summary entry, not line-by-line zeroing.** Historical closes (both SE and SG, imported from Visma/QuickBooks) post only two lines — the net result moves from the Closing account to the RE account. P&L accounts stay cumulative; `pl()` handles this correctly via date-range filtering. This matches the existing data and the QuickBooks model.

4. **Jurisdiction pack declares whether closing is required and which accounts to use.** No hard-coded account codes in the action logic.

5. **No auto-lock.** `period.close` does not lock the period. Locking is a separate manual step. But an inbox item surfaces periods that are past their end date without a posted close.

## 3. Jurisdiction pack declaration

Add a `closing` block to `jurisdiction.json`:

```json
"closing": {
  "required": true,
  "retainedEarningsAccount": "2099",
  "closingAccount": "8999"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `required` | boolean | yes | Whether a closing posting is expected for this jurisdiction. `false` or omitted → `period.close` returns a no-op message; live injection is the permanent source of truth. |
| `retainedEarningsAccount` | string | yes (if `required: true`) | The equity account that receives the year's net result. SE: `2099`, SG: `203070`. |
| `closingAccount` | string \| null | no (if `required: true`) | The intermediate "income summary" account. SE: `8999`, SG: `999999`. Nullable for charts that post straight to RE with no intermediate account — the close posts a single self-balancing pair to RE only (or a two-line entry where both legs hit RE from the P&L summary). If null, the close posts one line per direction: the net result goes directly to the RE account with an offsetting line to a system-generated contra. **Open question:** is the null case a single line to RE (unbalanced?) or a two-line entry where both legs are RE? The answer is: if `closingAccount` is null, the entry is a single two-line batch — D/C RE for the net, and the offsetting line posts to RE as well (net zero on RE, which is wrong). Actually the null case doesn't make sense for a summary entry — you need *somewhere* for the offsetting leg. **Decision: `closingAccount` is required when `required: true`.** If a jurisdiction has no intermediate account, the P&L accounts themselves are the contra — but that's line-by-line zeroing, which we're not doing. So: `closingAccount` is required. |

**Correction on `closingAccount`:** Required when `required: true`. The summary entry always needs two accounts: the closing/summary account and the RE account. A jurisdiction that posts straight to RE without an intermediate account would need a different mechanism (line-by-line zeroing) — out of scope for P2-1.

### Pack updates

**SE pack** (`db/jurisdictions/SE/jurisdiction.json`):
```json
"closing": {
  "required": true,
  "retainedEarningsAccount": "2099",
  "closingAccount": "8999"
}
```

**SG pack** (`db/jurisdictions/SG/jurisdiction.json`):
```json
"closing": {
  "required": true,
  "retainedEarningsAccount": "203070",
  "closingAccount": "999999"
}
```

**Pack linter** (`tests/jurisdiction-packs.mjs`): validate the `closing` block when present — `required: true` demands both account codes; accounts must exist in the pack's COA with the correct `account_type` (closingAccount → `Closing`, retainedEarningsAccount → `Equity`).

## 4. `period.close` action

**Catalog entry** (`action-catalog.js`):
```js
'period.close': {
  roles: ['owner', 'admin'],
  mutating: true,
  idempotent: true,
  audit: true,
  description: 'Post year-end closing entry: move P&L net result to retained earnings (jurisdiction-pack driven).',
  params: { periodId: 'string' }
}
```

Role: `owner`/`admin` only — this is a material posting action, not agent-callable. Not added to `AGENT_ALLOWED`.

### Handler logic

```
period.close(ctx):
  1. Load jurisdiction pack for company.
  2. If pack.closing.required !== true → return { closed: false, reason: 'closing not required for jurisdiction' }
  3. Load closingAccount + retainedEarningsAccount from pack.
  4. Validate both accounts exist in the company's COA with correct account_type.
  5. Resolve period by periodId (latest version, same pattern as period.close_check).
  6. Guard: check if a close batch already exists for this period.
     - Query: any batch on period.end_date involving closingAccount where source = 'period_close'
     - If found → return { closed: true, already: true, batchId } (idempotent no-op)
  7. Compute P&L net for the period:
     SUM(CASE WHEN Revenue THEN credit_home - debit_home ELSE 0 END) -
     SUM(CASE WHEN Expense THEN debit_home - credit_home ELSE 0 END)
     WHERE date BETWEEN period.start_date AND period.end_date
     AND account_type IN ('Revenue', 'Expense')
  8. If P&L net = 0 → return { closed: true, net: 0, message: 'P&L is zero, no closing entry needed' }
  9. Post a balanced journal batch:
     - source: 'period_close'
     - reference: 'CLOSE/<periodId>'
     - date: period.end_date
     - If profit (net > 0):
       Line 1: D closingAccount, net, description: 'Year-end close: P&L net to closing'
       Line 2: C retainedEarningsAccount, net, description: 'Year-end close: result to retained earnings'
     - If loss (net < 0):
       Line 1: C closingAccount, |net|, description: 'Year-end close: P&L net to closing'
       Line 2: D retainedEarningsAccount, |net|, description: 'Year-end close: result to retained earnings'
  10. Audit log: action=period.close, entity=period, details={ periodId, net, batchId }
  11. Emit event: period.closed, entity_type=period, payload={ periodId, net, batchId, closedAt }
  12. Return { closed: true, periodId, net, batchId }
```

**Idempotency:** Standard `Idempotency-Key` support per standing rule 3. The double-close guard (step 6) provides a natural idempotency independent of the key — a second call for the same period is a no-op.

**Reversal:** `journal.reverse` on the close batch. No special handling needed — the existing reversal mechanism works. This re-opens the period (P&L net is back in the live injection). A reversed close can be re-posted by calling `period.close` again (the guard checks for `source = 'period_close'`, not the reversal — but a reversed batch's `reversed_by` is set, so the guard should skip batches where `reversed_by IS NOT NULL`).

**Guard refinement (step 6):**
```sql
SELECT DISTINCT batch_id FROM journal_entries
WHERE company_id = ?
  AND date = ?  -- period.end_date
  AND account_code = ?  -- closingAccount
  AND source = 'period_close'
  AND reversed_by IS NULL
```

## 5. Inbox item: period not closed

**Class B** inbox item (operational, not a ledger approval). Surfaces when a period's end date has passed and no close batch exists.

### `inbox.list` extension

Add a new Class B item type `period_unclosed` to the `inbox.list` aggregator:

```
queryPeriodUnclosed(companyId):
  1. Load jurisdiction pack. If closing.required !== true → return [] (no items).
  2. For each period where end_date < TODAY and end_date >= TODAY - 90 days:
     a. Check if a close batch exists (same guard as period.close step 6).
     b. If no close batch → emit item:
       {
         type: 'period_unclosed',
         source: 'system',
         date: period.end_date,
         summary: `Period ${period.period_name} ended ${period.end_date} — not yet closed`,
         verbs: ['close'],  // 'close' → calls period.close
         payload_ref: period.period_name,
         status: 'proposed',
         reference: period.period_name,
         description: `${daysPast} days since period end`
       }
  3. Return items, sorted by end_date ascending (oldest first).
```

**Threshold:** 90 days after period end (configurable per pack in a future iteration; hard-coded 90 for now). Items appear only for the most recent unclosed period — not a historical backlog of every unclosed period since inception. If multiple periods are unclosed, only the oldest unclosed period surfaces (closest to its deadline).

**Verb:** `close` → dispatches `period.close` with `periodId = payload_ref`. The inbox renders this as a single action — no drill-through needed.

**Inbox filter:** `status='unclosed'` filter view shows all unclosed periods (not just the most recent).

## 6. SRU export gate

**SIE export** (`/api/:company/report?type=sie`): no gate. SIE is a general-purpose transfer format (import to another accounting system, backup, etc.). Always available.

**SRU export** (`/api/:company/sru/ink2`, `/api/:company/sru/info`): require the period to be **locked**. The SRU is a submission-specific statutory file. Gate:

```
handleSruInk2 / handleSruInfo:
  1. Resolve the period from ?year= (same as today).
  2. Query: SELECT locked FROM periods WHERE company_id = ? AND period_name = ?
  3. If not locked → HTTP 409 CONFLICT, body: { ok: false, error: { code: 'PERIOD_NOT_LOCKED', message: 'Period must be locked before generating SRU files. Lock the period in Settings → Periods.' } }
  4. If locked → proceed with existing generation logic.
```

This is a new gate, not a warning. The SRU is a filing artifact — allowing generation from an unlocked period risks delivering stale figures if the books change after generation. The lock is the operator's commitment that the books are final.

`?check=1` (dry-run) is also gated — even a dry-run should reflect locked books.

## 7. `gl()` opening-balance fix

`db/macros.sql:480-489` — the `opening` CTE computes opening balance as `SUM(je.debit_home) - SUM(je.credit_home)` for all dates before the period start, with no account-type distinction. Revenue/Expense accounts carry cumulative balances into the opening figure.

**Fix:** Add a `CASE` on `account_type` — temporary accounts (Revenue, Expense, Cost of Sales, Closing) always open at 0:

```sql
opening AS (
  SELECT
    aa.account_code,
    aa.account_name,
    COALESCE(
      CASE WHEN a.account_type IN ('Revenue', 'Expense', 'Cost of Sales', 'Closing')
           THEN 0
           ELSE SUM(je.debit_home) - SUM(je.credit_home)
      END, 0
    ) AS opening_balance
  FROM active_accounts aa
  LEFT JOIN accounts a ON a.company_id = cid AND a.account_code = aa.account_code
  LEFT JOIN journal_entries je ON je.company_id = cid
    AND je.account_code = aa.account_code
    AND je.date < CAST(start_date AS DATE)
  GROUP BY aa.account_code, aa.account_name, a.account_type
)
```

The `LEFT JOIN accounts` is needed to get `account_type` into the CTE (the existing `active_accounts` CTE only selects `account_code` and `account_name`). Add `a.account_type` to the `GROUP BY`.

This is a targeted fix to the `gl()` macro only. No other macros are affected — `pl()` already filters by date range, `bs()` already excludes non-permanent types, `tb()` computes period movements not cumulative balances.

## 8. `re_rollforward` and `integrity_extended` fix

Both macros hard-code SG account codes. Fix: parameterize via a subquery that reads the closing account from the company's COA (the single account with `account_type = 'Closing'`) and the RE account from the jurisdiction pack.

### `re_rollforward` (`db/macros.sql:531`)

Replace hardcoded `203070` and `999999` with a subquery:

```sql
-- Discover closing + RE accounts from COA
closing_acct AS (
  SELECT account_code FROM accounts
  WHERE company_id = cid AND account_type = 'Closing'
  LIMIT 1
),
re_acct AS (
  SELECT account_code FROM accounts
  WHERE company_id = cid AND account_type = 'Equity'
    AND account_subtype = 'Equity'
    -- Heuristic: the RE account is the one that isn't share capital (2081/203080)
    -- and isn't prior-year (2098). In practice: the account whose code matches
    -- the pack's retainedEarningsAccount declaration.
  LIMIT 1
)
```

**Problem:** the macro can't read the jurisdiction pack (it's a DuckDB macro, not application code). Two options:

**(a) Pass account codes as macro parameters.** `re_rollforward(cid, closing_account, re_account)`. The caller (application code) reads the pack and passes the codes. Clean separation — the macro stays pure SQL, the application handles jurisdiction logic.

**(b) Discover from COA inside the macro.** The Closing account is discoverable (`account_type = 'Closing'`, usually unique). The RE account is harder — there are multiple Equity accounts. Heuristics (exclude share capital, exclude prior-year) are fragile. This is why the pack declares it explicitly.

**Recommendation: (a) — parameterize the macro.** The application layer reads the pack's `closing.closingAccount` and `closing.retainedEarningsAccount` and passes them as arguments. `re_rollforward(cid, closingAccount, reAccount)`. Callers: `reports/render.js` (integrity report), and any API action that surfaces the roll-forward.

### `integrity_extended` (`db/macros.sql:604`)

Same fix: parameterize. `integrity_extended(cid, startDate, endDate, closingAccount)`. The "P&L vs Closing Entry" check uses the closing account to detect closing entries.

**Callers:** `reports/render.js` — the integrity report page. Update the call site to read the pack and pass the account code.

### Macro signature change

```
re_rollforward(cid) → re_rollforward(cid, closing_account, re_account)
integrity_extended(cid, start_date, end_date) → integrity_extended(cid, start_date, end_date, closing_account)
```

Breaking change for any existing callers. Search the codebase for all call sites and update them. The macros are DuckDB `CREATE OR REPLACE MACRO` — re-application via `schema.sql` at boot updates them in place.

## 9. What is NOT in scope

- **Line-by-line zeroing of P&L accounts.** Not happening. The summary entry matches existing data and the QuickBooks model.
- **Changing the live injection in `render.js`.** It stays as the permanent source of truth. No code change to `render.js:121-174`.
- **AGM rebooking (2099 → 2098/2091).** Separate operation (annual meeting's disposition of prior-year results). Out of scope. Future `period.disposition` action if needed.
- **Auto-locking periods after close.** No. Locking is manual. The inbox item surfaces the gap.
- **P2-2, P2-3, P2-4a.** Not in this PR.

## 10. Files changed

| File | Change |
|------|--------|
| `db/jurisdictions/SE/jurisdiction.json` | Add `closing` block |
| `db/jurisdictions/SG/jurisdiction.json` | Add `closing` block |
| `api/src/action-catalog.js` | Add `period.close` catalog entry |
| `api/src/periods-page-service.js` or new `api/src/period-close.js` | `period.close` handler |
| `api/src/index.js` | Route `period.close` to handler |
| `api/src/inbox.js` | Add `queryPeriodUnclosed` + `status='unclosed'` filter |
| `api/src/reports.js` | SRU export gate (locked check) |
| `db/macros.sql` | Fix `gl()` opening balance; parameterize `re_rollforward` + `integrity_extended` |
| `reports/render.js` | Update `re_rollforward` + `integrity_extended` call sites to pass account codes |
| `api/src/jurisdiction-packs.js` | Add `getClosingConfig(companyId)` helper |
| `tests/jurisdiction-packs.mjs` | Pack linter: validate `closing` block |
| New test file | Contract tests for `period.close` (idempotent, guard, pack-driven, reversal) |
| `docs/review-roadmap.md` | Status update entry |

## 11. Test plan

1. **`period.close` on SE company (mdab_se, FY2025):** the close already exists (manual entry). Calling `period.close` should detect the existing close batch and return `{ closed: true, already: true }`. But the existing close has `source = 'csv_import'`, not `source = 'period_close'` — so the guard won't find it. This is expected: the guard looks for `period.close`-generated batches, not legacy closes. Calling `period.close` would post a *second* close entry. **This is a problem.**

   **Resolution:** The guard should also check for any batch on the period end date involving the closing account, regardless of source. If a batch already moves the net to the RE account, a second close would double-count. Change the guard:

   ```sql
   SELECT DISTINCT batch_id FROM journal_entries
   WHERE company_id = ?
     AND date = ?  -- period.end_date
     AND account_code = ?  -- closingAccount
     AND reversed_by IS NULL
   ```

   This catches both `period.close`-generated batches (`source = 'period_close'`) and legacy/imported closes (`source = 'csv_import'`). The guard is: "any un-reversed batch involving the closing account on the period end date counts as a close."

   **But:** the FY2015 close has many lines (it's a full TB close, not just 8999↔2099). The closing account (8999) appears in that batch. So the guard would correctly detect it and refuse to double-close.

   **Edge case:** what if the period has activity on the closing account that isn't a close entry? Unlikely for a "Closing"-type account — it should only be touched by close entries. Acceptable risk.

2. **`period.close` on a period with zero P&L:** returns `{ closed: true, net: 0, message: 'P&L is zero' }`. No batch posted.

3. **`period.close` idempotency:** call twice with the same `Idempotency-Key` → second call returns cached result. Call twice without key → second call hits the guard and returns `{ closed: true, already: true }`.

4. **`period.close` reversal:** reverse the close batch via `journal.reverse`, then call `period.close` again → posts a new close batch (the reversed one is skipped by the `reversed_by IS NULL` filter).

5. **`period.close` on a jurisdiction with `required: false`:** returns no-op.

6. **SRU export gate:** attempt SRU generation on an unlocked period → 409. Lock the period → succeeds.

7. **SIE export:** no gate — always succeeds regardless of lock state.

8. **`gl()` opening balance:** pull GL for account 3001 for FY2026 → opening balance should be 0, not 13,289.

9. **`re_rollforward` with parameterized accounts:** run against mdab_se with `('mdab_se', '8999', '2099')` → should show correct closing entries and PASS status. Run against inteligo_sg with `('inteligo_sg', '999999', '203070')` → should also pass.

10. **Inbox item:** a company with an unclosed period past 90 days → `inbox.list` includes a `period_unclosed` item.

## 12. Open questions

None remaining — all four decisions from the design thread are incorporated. Proceed to ratification.
