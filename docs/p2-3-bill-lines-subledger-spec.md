# P2-3 — Bill Lines Subledger + AP Control Report

**Date:** 2026-08-07 · **Status:** RATIFIED

## 1. Problem

### 1.1 No `bill_lines` subledger table

Posted bill line items exist only as journal entries. The `getBillLines` function (`bills.js:730-763`) reconstructs them with fragile filtering:

```sql
SELECT ... FROM journal_entries je
WHERE je.bill_id = @billId AND je.debit > 0
  AND je.account_code != (SELECT ap_account FROM bills ...)
```

This returns ALL debit lines except AP — expense lines **and** VAT/GST lines indistinguishably. It breaks on voids (reversed journals make the filter miss or double lines). There is no stable, queryable line-item store.

Drafts are no better: line items are a JSON blob in `bills.draft_lines` (TEXT column, unvalidated shape, no indexing).

### 1.2 No AP subledger-vs-GL control

The `integrity` and `integrity_extended` macros check TB balance, BS balance, orphan accounts, zero lines, and P&L vs closing. There is no check that the AP subledger total ties to the GL AP control account(s). This is a standard accountant's control — every double-entry system carries it.

**Roadmap finding #7:** "No `bill_lines` subledger — posted bill lines exist only as journal entries; drafts as JSON. Medium — no subledger-vs-GL control."

### 1.3 What this spec does NOT change

- The GL posting path (`createBill` journal line construction) is unchanged. `bill_lines` is a **derived projection** written alongside the journal, not a second posting path.
- The `bills` table remains the AP subledger header (vendor, date, amounts, status, ap_account). `bill_lines` stores the line-item detail.
- Drafts stay as JSON in `bills.draft_lines`. Drafts are not posted to the ledger; they don't need subledger rows.

## 2. Design principles

1. **`bill_lines` stores expense lines only** — the user's input lines (`expense_account`, `amount`, `vat_code`, `description`, `cost_center`, `profit_center`). VAT/GST grouped journal lines and the AP credit line are journal-level constructs, not bill-line-level. They stay in `journal_entries` only.

2. **Written on post, never mutated.** `bill_lines` rows are inserted in `createBill` alongside `journal_entries`. No UPDATE path. On `bill.void`, rows stay (historical record); the bill status changes to `void` and the control report filters by status.

3. **Subledger is a projection of the bill, not an independent ledger.** The GL remains the source of truth for posted amounts. `bill_lines` exists for stable retrieval, line-level querying, and subledger reporting — not as a second book of record that can diverge.

4. **Control report compares subledger outstanding to GL AP balance.** The AP control account(s) are identified from `bills.ap_account`. The report reconciles open-bill outstanding balances (subledger) to the GL AP account balance, per AP account.

5. **Home currency throughout.** The control report operates in home currency. `bill_lines` carries `amount_home` and `fx_rate` so line-level home amounts are stable and don't need re-derivation from journal entries.

## 3. Schema: `bill_lines` table

```sql
CREATE TABLE IF NOT EXISTS bill_lines (
  company_id      VARCHAR        NOT NULL,
  bill_id         VARCHAR        NOT NULL,
  line_number     INTEGER        NOT NULL,     -- 1-based ordinal within the bill
  expense_account VARCHAR        NOT NULL,
  amount          DECIMAL(18,4)  NOT NULL,     -- bill currency (tax-exclusive)
  amount_home     DECIMAL(18,4)  NOT NULL,     -- home currency (amount × fx_rate)
  vat_code        VARCHAR,
  description     VARCHAR,
  cost_center     VARCHAR,
  profit_center   VARCHAR,
  created_at      TIMESTAMP     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, bill_id, line_number)
);
CREATE INDEX IF NOT EXISTS idx_bill_lines_company_account
  ON bill_lines(company_id, expense_account);
CREATE INDEX IF NOT EXISTS idx_bill_lines_bill
  ON bill_lines(company_id, bill_id);
```

| Column | Type | Source | Notes |
|--------|------|--------|-------|
| `company_id` | VARCHAR | bill row | Multi-tenant isolation |
| `bill_id` | VARCHAR | bill row | FK to `bills` (no enforced FK — DuckDB) |
| `line_number` | INTEGER | loop index | 1-based ordinal; stable within bill |
| `expense_account` | VARCHAR | `expLine.expense_account` | The charged account |
| `amount` | DECIMAL | `expLine.amount` | Bill currency, tax-exclusive (the net) |
| `amount_home` | DECIMAL | `amount × fxRate` | Home currency, frozen at posting rate |
| `vat_code` | VARCHAR | `expLine.vat_code` | Nullable (non-taxable lines) |
| `description` | VARCHAR | `expLine.description` | Line-level description (may be NULL) |
| `cost_center` | VARCHAR | `expLine.cost_center \|\| bill.cost_center` | Resolved center (same priority as journal) |
| `profit_center` | VARCHAR | `expLine.profit_center \|\| bill.profit_center` | Resolved center |
| `created_at` | TIMESTAMP | `now` | Same timestamp as journal lines |

### Migration: backfill existing posted bills

```sql
INSERT INTO bill_lines (company_id, bill_id, line_number, expense_account, amount, amount_home, vat_code, description, cost_center, profit_center, created_at)
SELECT
  je.company_id,
  je.bill_id,
  ROW_NUMBER() OVER (PARTITION BY je.bill_id ORDER BY je.created_at) AS line_number,
  je.account_code,
  je.debit,
  je.debit_home,
  je.vat_code,
  je.description,
  je.cost_center,
  je.profit_center,
  je.created_at
FROM journal_entries je
WHERE je.bill_id IS NOT NULL
  AND je.debit > 0
  AND je.account_code NOT IN (
    SELECT b.ap_account FROM bills b WHERE b.company_id = je.company_id AND b.bill_id = je.bill_id
  )
  AND je.reversed_by IS NULL
  AND je.bill_id IN (SELECT bill_id FROM bills WHERE status IN ('posted', 'partial', 'paid', 'void'))
ON CONFLICT (company_id, bill_id, line_number) DO NOTHING;
```

**Note:** This backfill uses the same fragile filtering as `getBillLines` today — but it runs once. After migration, `bill_lines` is the stable source and the journal-filtering trick is retired.

**Caveat — VAT/GST lines:** The backfill includes VAT/GST journal lines (they have `debit > 0` and are not the AP account). This is a known limitation of reconstructing from the GL. New posts (post-migration) will write only true expense lines to `bill_lines`. For pre-migration bills, the UI `bill.lines` action will continue to show all debit lines. The control report is unaffected (it operates on `bills` header amounts, not `bill_lines`).

**Decision point:** Accept VAT/GST lines in backfilled `bill_lines` rows (cosmetic — they show in `bill.lines` for old bills), or filter them by joining `accounts.account_type` (VAT/GST accounts are typically `Liability` subtype `Tax`). Recommendation: accept — filtering by account_type in the backfill risks excluding legitimate expense accounts mis-typed as Liability. The forward path (post-migration) writes clean expense-only rows.

## 4. Write path: `createBill` modification

In `bills.js`, after the `expenseLines` loop and before the VAT/GST-grouped journal lines, insert:

```js
// ── P2-3: write bill_lines subledger (expense lines only) ──
const billLineRows = expenseLines.map((expLine, i) => {
  const lineAmount = Number(expLine.amount || 0);
  return {
    company_id: companyId,
    bill_id: billId,
    line_number: i + 1,
    expense_account: expLine.expense_account,
    amount: lineAmount,
    amount_home: round4(lineAmount * fxRate),
    vat_code: expLine.vat_code || null,
    description: expLine.description || null,
    cost_center: expLine.cost_center || bill.cost_center || null,
    profit_center: expLine.profit_center || bill.profit_center || null,
    created_at: now,
  };
});
```

Insert alongside (not instead of) `bulkInsert('journal_entries', lines)`:

```js
await bulkInsert('journal_entries', lines);
await bulkInsert('bill_lines', billLineRows);  // P2-3
```

**Idempotency:** `bill.create` is idempotent (Idempotency-Key). On retry, the `bill_id` already exists and the insert is a no-op (DuckDB `INSERT` with existing PK fails — but the idempotency layer replays the first response, never re-executes). No `ON CONFLICT` needed.

**`bill.draft.post` path:** `postDraftBill` delegates to `createBill` with `_replaceDraftId`. The `bill_lines` insert runs in the same call. Drafts never write `bill_lines` (they haven't posted yet).

**`bill.void` path:** No change. `voidBill` reverses journal entries and sets bill status to `void`. `bill_lines` rows stay. The control report filters `status IN ('posted', 'partial')`, so voided bills drop out of the subledger total naturally.

## 5. Read path: `getBillLines` rewrite

For **posted** bills, read from `bill_lines` instead of reconstructing from journal entries:

```js
async function getBillLines(ctx) {
  const { companyId, body } = ctx;
  const { billId } = body;
  if (!billId) throw Object.assign(new Error('billId required'), { code: 'INVALID_INPUT' });

  const billRows = await query(
    `SELECT status, draft_lines FROM bills WHERE company_id=@companyId AND bill_id=@billId LIMIT 1`,
    { companyId, billId }
  );
  if (billRows.length === 0) throw Object.assign(new Error('Bill not found'), { code: 'NOT_FOUND' });

  if (billRows[0].status === 'draft') {
    // Drafts: unchanged — parse draft_lines JSON
    const raw = billRows[0].draft_lines;
    if (!raw) return [];
    try {
      const lines = JSON.parse(raw);
      return lines.map((l, i) => ({
        entry_id: 'draft_' + i,
        account_code: l.expense_account || '',
        account_name: '',
        description: l.description || '',
        amount: l.amount || 0,
        vat_code: l.vat_code || null,
        currency: l.currency || null,
        fx_rate: 1,
        vat_amount_override: (l.vat_amount_override != null && !isNaN(Number(l.vat_amount_override)))
          ? Number(l.vat_amount_override) : null,
      }));
    } catch (e) { return []; }
  }

  // Posted/partial/paid/void: read from bill_lines subledger (P2-3)
  return query(
    `SELECT
       CAST(line_number AS VARCHAR) AS entry_id,
       expense_account AS account_code,
       a.account_name,
       description,
       amount,
       vat_code,
       b.currency,
       b.fx_rate,
       amount_home
     FROM bill_lines bl
     JOIN bills b ON b.company_id = bl.company_id AND b.bill_id = bl.bill_id
     LEFT JOIN accounts a ON a.company_id = bl.company_id AND a.account_code = bl.expense_account
     WHERE bl.company_id = @companyId AND bl.bill_id = @billId
     ORDER BY bl.line_number`,
    { companyId, billId }
  );
}
```

**Return shape:** Same field names as today (`entry_id`, `account_code`, `account_name`, `description`, `amount`, `vat_code`, `currency`, `fx_rate`). `entry_id` becomes the line number (stringified) instead of a journal `entry_id` — this is a semantic change but the field is used only as a React key in the UI, so no consumer breaks.

**`bill.lines` action catalog entry:** Unchanged (viewer, read-only, `billId` param). The description updates to mention `bill_lines` table for posted bills.

## 6. AP control report

### 6.1 Report registry

Add to `report-registry.js`:

```js
{ id: 'ap-control', label: 'AP Control', category: 'audit', multiperiod: false, needsStart: false },
```

Category: `audit` (it's an integrity check, not a financial statement). `needsStart: false` — it's an as-of-date report (balance at a point in time, not a period range).

### 6.2 Macro: `ap_control`

```sql
CREATE OR REPLACE MACRO ap_control(cid, as_of_date) AS TABLE
WITH
-- GL AP balance per AP account (all journal entries, including reversals)
gl_side AS (
  SELECT
    je.account_code AS ap_account,
    a.account_name,
    SUM(je.credit_home - je.debit_home) AS gl_balance
  FROM journal_entries je
  LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
  WHERE je.company_id = cid
    AND je.date <= CAST(as_of_date AS DATE)
    AND je.account_code IN (SELECT DISTINCT ap_account FROM bills WHERE company_id = cid)
    AND je.reversed_by IS NULL
  GROUP BY je.account_code, a.account_name
),
-- Subledger: open bills per AP account (outstanding in home currency)
subledger_side AS (
  SELECT
    b.ap_account,
    SUM(b.amount_home) AS posted_total,
    SUM(COALESCE((
      SELECT SUM(je.debit_home)
      FROM journal_entries je
      WHERE je.company_id = b.company_id
        AND je.bill_id = b.bill_id
        AND je.account_code = b.ap_account
        AND je.reversed_by IS NULL
        AND je.debit > 0
    ), 0)) AS paid_total,
    SUM(b.amount_home) - SUM(COALESCE((
      SELECT SUM(je.debit_home)
      FROM journal_entries je
      WHERE je.company_id = b.company_id
        AND je.bill_id = b.bill_id
        AND je.account_code = b.ap_account
        AND je.reversed_by IS NULL
        AND je.debit > 0
    ), 0)) AS subledger_balance,
    COUNT(*) AS bill_count
  FROM bills b
  WHERE b.company_id = cid
    AND b.status IN ('posted', 'partial')
    AND b.date <= CAST(as_of_date AS DATE)
  GROUP BY b.ap_account
)
SELECT
  COALESCE(g.ap_account, s.ap_account) AS ap_account,
  COALESCE(g.account_name, '') AS account_name,
  COALESCE(g.gl_balance, 0) AS gl_balance,
  COALESCE(s.subledger_balance, 0) AS subledger_balance,
  COALESCE(s.subledger_balance, 0) - COALESCE(g.gl_balance, 0) AS difference,
  CASE
    WHEN ABS(COALESCE(s.subledger_balance, 0) - COALESCE(g.gl_balance, 0)) <= 0.01 THEN 'OK'
    ELSE 'FAIL'
  END AS status,
  COALESCE(s.bill_count, 0) AS bill_count,
  COALESCE(s.posted_total, 0) AS posted_total,
  COALESCE(s.paid_total, 0) AS paid_total
FROM gl_side g
FULL OUTER JOIN subledger_side s ON g.ap_account = s.ap_account
ORDER BY ap_account;
```

**How it works:**

- **GL side:** All non-reversed journal entries on AP accounts up to the as-of date. `credit_home - debit_home` = the AP liability balance (credit-normal).
- **Subledger side:** Open bills (posted, partial) up to the as-of date. `amount_home` is the original AP credit. Paid total = sum of payment journal debits on the AP account linked to the bill. Outstanding = posted − paid.
- **Reconciliation:** `subledger_balance - gl_balance` should be zero. Non-zero difference means:
  - Manual journal entries on the AP account not linked to a bill (orphan GL entries)
  - FX differences on foreign-currency payments (the payment rate differs from the booking rate — the FX difference posts to the AP account in the current design)
  - Bills whose AP account was changed after posting (not possible in the current code — no UPDATE on ap_account post)

**FX difference handling:** For foreign-currency bills, the GL AP balance includes FX differences from payment settlement. The subledger outstanding (`amount_home − paid_home`) uses the posting rate, not the payment rate. The difference is the FX gain/loss — a real accounting figure, not an error. The report should show it as `WARN` (not `FAIL`) when FX bills exist.

**Refinement — FX-aware status:**

```sql
CASE
  WHEN ABS(diff) <= 0.01 THEN 'OK'
  WHEN EXISTS (
    SELECT 1 FROM bills b
    WHERE b.company_id = cid
      AND b.status IN ('posted', 'partial')
      AND b.currency != (SELECT currency FROM companies WHERE company_id = cid)
      AND b.date <= CAST(as_of_date AS DATE)
  ) AND ABS(diff) < 100 THEN 'WARN'  -- likely FX difference
  ELSE 'FAIL'
END AS status
```

The 100 threshold is a heuristic. Magnus: if you prefer, we can compute the expected FX difference precisely (SUM of FX gain/loss journal lines on the AP account) and match it exactly. That's more correct but more complex. For a small AB with few FX bills, the heuristic is sufficient.

### 6.3 Render path

Add `ap-control` to `render.js`:

```js
async function buildApControl(query, company, asOfDate) {
  const rows = await query(`SELECT * FROM ap_control(?, ?)`, [company, asOfDate]);
  // Render as a table: AP Account | Account Name | GL Balance | Subledger | Diff | Status | Bills | Posted | Paid
  // Status color: OK=green, WARN=amber, FAIL=red (same as integrity report)
  // Zero rows stay permanent (magnus's rule) — if no open bills, show a row with zeros
}
```

Report title: `AP Control Reconciliation`. As-of date defaults to today.

**Zero-row rule (magnus):** If there are no open bills, the report shows one row per AP account with all zeros and status `OK`. No empty-table rendering.

**Whole currency units:** All amounts rounded to whole currency units (no decimals) in the report table, per magnus's rule for report tables. The underlying query retains 4 decimal places; rounding is display-only.

### 6.4 Report hub integration

`pages/reports-hub.js`: `ap-control` appears under the **Audit** category. No start date needed — uses a single as-of date picker (same as AP Aging). No multiperiod comparison.

## 7. Action catalog

No new actions required. The control report is a read endpoint (`GET /api/:company/report?type=ap-control`), not an action. It follows the same route as all other reports.

The `bill.lines` action description updates:

```js
'bill.lines': {
  role: 'viewer', mutating: false,
  description: 'Line items of a bill (draft_lines JSON for drafts, bill_lines subledger for posted).',
  params: { billId: { type: 'string', required: true } },
},
```

## 8. Integrity check integration

Add an AP control check to the `integrity_extended` macro so it surfaces in the existing Integrity Check report alongside the other checks:

```sql
-- AP Subledger vs GL (P2-3)
ap_control_check AS (
  SELECT
    'AP Subledger vs GL' AS check_name,
    CASE WHEN ABS(
      COALESCE((SELECT SUM(credit_home - debit_home) FROM journal_entries
        WHERE company_id = cid
        AND account_code IN (SELECT DISTINCT ap_account FROM bills WHERE company_id = cid)
        AND date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
        AND reversed_by IS NULL), 0)
      -
      COALESCE((SELECT SUM(b.amount_home) FROM bills b
        WHERE b.company_id = cid
        AND b.status IN ('posted', 'partial')
        AND b.date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)), 0)
      +
      COALESCE((SELECT SUM(je.debit_home) FROM journal_entries je
        JOIN bills b ON b.bill_id = je.bill_id AND b.company_id = je.company_id
        WHERE b.company_id = cid
        AND b.status IN ('posted', 'partial')
        AND b.date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
        AND je.account_code = b.ap_account
        AND je.debit > 0
        AND je.reversed_by IS NULL), 0)
    ) <= 0.01 THEN 'OK'
    WHEN EXISTS (
      SELECT 1 FROM bills b
      WHERE b.company_id = cid
      AND b.status IN ('posted', 'partial')
      AND b.currency != (SELECT currency FROM companies WHERE company_id = cid)
      AND b.date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
    ) THEN 'WARN'
    ELSE 'FAIL' END AS status,
    -- Detail string with GL balance vs subledger outstanding
    'GL: ' || ROUND(COALESCE((...), 0), 2) ||
    ' | Subledger: ' || ROUND(COALESCE((...), 0), 2) AS detail
)
```

This is a simplified period-range version (unlike the as-of `ap_control` macro which is point-in-time). It checks whether AP journal movements in the period match bill postings in the period. The full `ap_control` report (§6) is the point-in-time reconciliation; this integrity check is the period-range summary.

**Decision point:** The integrity check version is more complex (period-range, not point-in-time) and may be confusing alongside the full report. Alternative: skip the integrity check integration and rely solely on the `ap-control` report. Recommendation: include a simplified version — having it in the Integrity Check report means it runs every time someone checks integrity, which is the right cadence for a control.

## 9. Tests

### 9.1 Contract tests (`contract.test.js`)

```
P2-3 bill_lines subledger:
  ✓ createBill writes bill_lines rows (one per expense line)
  ✓ bill.lines returns bill_lines for posted bills (not journal entries)
  ✓ bill.lines returns draft_lines JSON for drafts (unchanged)
  ✓ bill.void does not delete bill_lines rows (status=void, rows remain)
  ✓ bill_lines amounts match journal expense lines
  ✓ line_number is sequential 1..N
  ✓ cost_center/profit_center resolved (line-level || bill-level)

P2-3 AP control report:
  ✓ ap-control report shows OK when subledger ties to GL
  ✓ ap-control report shows FAIL when GL has orphan AP entries
  ✓ ap-control report shows WARN when FX bills exist with small diff
  ✓ ap-control report renders zero rows (permanent) when no open bills
  ✓ ap-control report rounds to whole currency units (no decimals)
  ✓ backfill populates bill_lines for pre-migration posted bills
```

### 9.2 Backfill verification

After running the migration, verify:
- Row count: `bill_lines` count = number of expense journal lines across all posted/partial/paid/void bills
- No duplicate `(company_id, bill_id, line_number)` tuples
- Every posted bill has at least one `bill_lines` row

## 10. Implementation order

1. Schema migration (`bill_lines` table + backfill) → `db/schema.sql`
2. Write path (`createBill` modification) → `api/src/bills.js`
3. Read path (`getBillLines` rewrite) → `api/src/bills.js`
4. `ap_control` macro → `db/macros.sql`
5. Render path (`buildApControl`) → `reports/render.js`
6. Report registry entry → `api/src/report-registry.js`
7. Integrity check integration → `db/macros.sql` (`integrity_extended`)
8. Contract tests → `api/test/contract.test.js`

## 11. Out of scope

- **AR subledger:** Receivables are dropped from this cycle. When AR ships (P3-1), the same pattern applies: `invoice_lines` table + AR-control report.
- **Draft line validation:** `draft_lines` JSON remains unvalidated at the schema level. A future hardening pass could add `bill_draft_lines` as a proper table, but drafts are transient and the JSON is sufficient.
- **Payment subledger (`bill_payments` as a subledger):** Already exists and works. The control report reads payment journal lines, not `bill_payments` directly, because the GL truth is in journal entries.
- **Multi-AP-account support:** The control report handles multiple AP accounts (one row each). No UI changes needed — the report is per-account.

## 12. Ratified decisions

1. **Backfill VAT/GST lines:** Accepted. Pre-migration `bill_lines` will include VAT/GST journal lines (cosmetic). Forward path writes clean expense-only rows.

2. **FX-aware status threshold:** Heuristic `ABS(diff) < 100 → WARN` for FX bills. Sufficient for current scale.

3. **Integrity check integration:** Include the simplified AP check in `integrity_extended`.

4. **`entry_id` semantic change:** Accepted. `bill.lines` returns `line_number` (stringified) as `entry_id`.

5. **`amount_paid_home` tracking:** Keep the join. No new stored column.
