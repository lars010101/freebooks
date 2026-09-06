# Bills: Withholding Tax (WHT), Booked at Posting — Spec

**Status:** Draft v1
**Scope:** `db/schema.sql`, a new `api/src/wht.js`, `api/src/bills.js`, `api/src/setup.js`, `api/src/pages/common.js`, `api/src/pages/bill-edit.js`, `api/src/pages/master-data.js`, `api/src/action-catalog.js`, `api/src/index.js`, `db/jurisdictions/SG/`.
**Depends on:** `bill-line-items-layout-prep-spec.md` (fills the `wht`/`WHT_ON` slot it reserved) and, loosely, `bill-line-items-qty-rate-spec.md` (no functional dependency — both just add columns to the same row). **Same assumption as the #3 spec:** written against the layout-prep spec's shape as designed, not a fresh inspection of your implementation.
**Chosen design:** liability booked when the bill posts (your choice) — the AP credit is reduced by the withheld amount, and a new credit line books it to a WHT payable account instead. This is materially bigger than #3: it's a genuinely new tax engine, not a reserved slot being filled in, so this spec is longer and has more real design decisions in it.

---

## 0. Design decisions, stated up front

Seven calls made while grounding this against your actual code and jurisdiction-pack architecture — worth reading before the diffs, since each one shapes something downstream. (Started at six; §0.6 got added after a review pass caught a third `createBill` code path this spec hadn't accounted for.)

### 0.1 Not gated by jurisdiction pack — a settings toggle, like `fx_tracking`

Singapore has a real withholding obligation (IRAS S45, on certain payments to non-residents); Sweden's domestic B2B system doesn't have an equivalent for ordinary vendor bills. That made jurisdiction-pack gating (like `SIE`'s `integrations` declaration) tempting. Went the other way: **`wht_tracking` is a plain company setting, mirroring `fx_tracking` exactly** — freely toggleable regardless of jurisdiction, not locked by the pack. Two reasons: it matches how `vat_codes` already works (jurisdiction-seeded, but a company can add more via `vat.codes.upsert` regardless), and it avoids hardcoding jurisdiction-specific UI gating logic for what is, underneath, a pretty generic "reduce what you pay, remit the rest" mechanism that isn't actually unique to Singapore. What *is* jurisdiction-specific is which starter codes get seeded (§2) — a Swedish company can still turn `wht_tracking` on for an unusual case and add its own code manually, same as adding an unusual VAT code today.

### 0.2 `bills.amount` changes meaning: net-of-WHT, not gross

Checked this against `settlement.js` before deciding, not just in the abstract: `bill_payments`/settlement logic (`newAmountPaid >= Number(bill.amount)`) reconciles cash actually paid to the vendor against `bills.amount`. If `bills.amount` stayed at the full gross figure while only the net-of-WHT portion is ever paid in cash, a bill would sit at `'partial'` forever even after the vendor's genuinely been paid in full — wrong. So: **`bills.amount` (and `amount_home`) become net-of-WHT** — what's actually owed to and payable to the vendor. The pre-WHT gross figure doesn't disappear; it's still derivable (net + VAT lines, or the new `bills.wht_amount` column added back), but AP aging, `bill_payments`, and "record a payment" all now correctly reconcile against what actually leaves the bank account to the vendor.

### 0.3 WHT payable is a plain GL liability account — no new subledger, no remittance tracker

Once WHT is credited to its payable account at posting, remitting it to the tax authority (IRAS/Skatteverket) is **just a normal manual journal entry** — Dr WHT Payable, Cr Cash — through the existing Journal Voucher screen, the same way any other liability gets settled. No new "WHT remittance" table, no filing-status tracking, no dedicated report. This mirrors the app's own existing restraint elsewhere (AR/invoicing was explicitly dropped rather than half-built) and keeps this spec to "compute and post the liability correctly," not "build a second AP-like subledger for the tax authority." A basic Trial Balance / General Ledger pull on the WHT payable account already tells you the outstanding balance — that's enough for v1.

### 0.4 Computed on the line's net (pre-VAT) amount — same base as VAT, not asserted as universally correct

WHT can legitimately be computed on gross, net, or a treaty-specific base depending on jurisdiction and payment type — this is exactly the kind of thing that varies by real tax rule, not something to assert confidently in code. Went with the same base VAT already uses (`lineNet`, i.e. the line's tax-exclusive amount) purely for consistency with the one tax engine that already exists here, not because it's asserted to be correct for every WHT scenario. If a specific code needs gross-basis calculation, that's a real but separate follow-up (§6) — not guessed at here.

### 0.5 No stated/override mechanism in v1

VAT has a whole supplier-stated-total-with-tolerance mechanism (`vat_amount_stated`, `getVatTolerance`). Deliberately not mirrored here — that's meaningful added complexity, and WHT is typically company-computed (you decide the rate based on the payment type and treaty), not supplier-stated the way GST-on-an-invoice is. If it turns out vendors do sometimes state their own WHT figure, that's a scoped, self-contained follow-up once the core mechanism is proven — same reasoning as deferring the qty/rate override in the #3 spec.

### 0.6 The bank-import (`payment_batch_id`) path is intentionally not WHT-aware — because it isn't VAT-aware either

Checked `createBill` closely and found a third code path beyond the two §5.3 originally described: `if (payment_batch_id) { ... }`, used when a bill is created directly from a matched bank transaction (already paid, no AP journal of its own — the bank-approval batch owns that journal). This path returns early, before the VAT/WHT accumulation loop even runs, and its own VAT handling is already just `vat_amount: 0` hardcoded — no `vat_codes` lookup happens there today. So WHT not being computed on this path isn't a new gap this spec introduces; it's consistent with how VAT already isn't really computed there either. Stated explicitly, not silently assumed: **if a bank-imported bill's lines carry a `wht_code`, no WHT payable gets booked and `bills.amount` stays at the gross figure** — §5.7 covers exactly what does and doesn't change there.

### 0.7 Seed codes are illustrative, not tax advice — and are never hardcoded past the initial seed

The `db/jurisdictions/SG/wht_codes.json` template in §2 ships one or two example codes so the feature isn't empty out of the box. **Rates and applicability need verification against current IRAS rules and your specific vendor arrangements/treaties before relying on them** — this spec is describing where the number lives and how it flows through the ledger, not asserting what the number should be. Worth being explicit about the mechanism, not just the caveat: the seed JSON is read exactly once, at `setup.add_company` time, to populate that company's own `wht_codes` row (§2.1). After that, `bills.js`'s posting logic never reads the JSON file or any hardcoded constant again — every computation is a fresh `SELECT rate FROM wht_codes` at post time (§5.1). So the 17% in the template is a starting value a user can — and, given this section's caveat, should — correct via the Settings screen (§7) before it matters, exactly the same way a wrong VAT rate would be corrected today. See acceptance criterion §11.6.

---

## 1. Schema

```sql
-- db/schema.sql, appended per the file's existing incremental-migration convention

-- Mirrors vat_codes (db/schema.sql ~L79), minus the input/output split (WHT
-- only ever has one direction — you withhold from the vendor, you owe the
-- tax authority — so one account, not two) and minus is_reverse_charge
-- (not a WHT concept).
--
-- wht_account is nullable, matching vat_codes.vat_account_input — a code can
-- exist before an account is assigned to it (exactly what the seed in §2
-- ships). The NOT NULL enforcement belongs in validateBill (§5.1a), at the
-- point a code is actually used on a bill, not in the schema — a schema
-- constraint here would fail company setup itself (bulkInsert-ing the seed
-- row) rather than the one bill that actually needs the account to exist.
CREATE TABLE IF NOT EXISTS wht_codes (
  company_id     VARCHAR        NOT NULL,
  wht_code       VARCHAR        NOT NULL,
  description    VARCHAR        NOT NULL,
  rate           DECIMAL(8,4)   NOT NULL,
  wht_account    VARCHAR,
  report_box     VARCHAR,
  is_active      BOOLEAN        NOT NULL DEFAULT TRUE,
  effective_from DATE           NOT NULL,
  effective_to   DATE
);

ALTER TABLE bill_lines     ADD COLUMN IF NOT EXISTS wht_code VARCHAR;
ALTER TABLE bills          ADD COLUMN IF NOT EXISTS wht_code VARCHAR;
ALTER TABLE bills          ADD COLUMN IF NOT EXISTS wht_amount DECIMAL(18,4) DEFAULT 0;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS wht_code VARCHAR;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS wht_amount DECIMAL(18,4) DEFAULT 0;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS wht_amount_home DECIMAL(18,4) DEFAULT 0;
```

`bills.wht_code`/`bills.wht_amount` mirror `bills.vat_code`/`bills.vat_amount` exactly (§6.3 shows where they're set). `bill_lines.wht_code` mirrors `bill_lines.vat_code` — no `wht_amount` column on `bill_lines`, same reasoning as VAT: the amount is computed at posting time from code × rate, never stored redundantly on the subledger row (confirmed by checking — `bill_lines` doesn't have a `vat_amount` column either).

---

## 2. Jurisdiction pack: seed data

```json
// db/jurisdictions/SG/wht_codes.json — NEW file.
// Illustrative starting point only — verify against current IRAS rules
// and your actual vendor arrangements before relying on these (§0.7).
[
  {
    "wht_code": "SG-S45-SVC",
    "description": "S45 — Services / management fees to non-resident",
    "rate": 0.17,
    "wht_account": null,
    "report_box": null
  }
]
```

`wht_account` is `null` in the template — same pattern `vat_codes.json`'s `vat_account_input`/`vat_account_output` use for codes that need a company-specific account before they're usable (e.g. `SG0`/`SGEX` in the existing file). Whoever sets this company up picks or creates a "WHT Payable" liability account and fills it in via the settings screen (§7) before the code can actually be selected on a bill.

**`db/jurisdictions/SE/` gets no `wht_codes.json` at all** — mirrors how optional integrations are already handled (`setup.js`'s `if (fs.existsSync(vatPath))` guard around VAT seeding, the SIE `integrations` declaration existing only on `SE`'s `jurisdiction.json`). No file means nothing seeds, not an empty array.

### 2.1 `setup.js` — seed `wht_codes` the same way `vat_codes` is seeded

**Location:** right after the existing VAT-codes seeding block (`api/src/setup.js`, around the `resolvedVatCodes`/`bulkInsert('vat_codes', vatCodes)` lines).

```js
// Mirrors the vat_codes block immediately above this — same existence guard,
// same shape. No wht_codes.json for a jurisdiction (e.g. SE) means nothing
// seeds; the company can still add codes manually later (§0.1).
let resolvedWhtCodes = null;
const whtPath = path.join(JURISDICTIONS_DIR, jurisdiction, 'wht_codes.json');
if (fs.existsSync(whtPath)) {
  resolvedWhtCodes = JSON.parse(fs.readFileSync(whtPath, 'utf8'));
}
let whtCodesInserted = 0;
if (resolvedWhtCodes && Array.isArray(resolvedWhtCodes) && resolvedWhtCodes.length > 0) {
  const whtCodes = resolvedWhtCodes.map((w) => ({
    company_id: company.company_id,
    wht_code: w.wht_code,
    description: w.description,
    rate: w.rate,
    wht_account: w.wht_account || null,
    report_box: w.report_box || null,
    is_active: true,
    effective_from: company.fy_start,
    effective_to: null,
  }));
  await bulkInsert('wht_codes', whtCodes);
  whtCodesInserted = whtCodes.length;
}
```

Also add `'wht_codes'` to the `expected` tables list a few lines above the VAT block (`const expected = [..., 'vat_codes', ...]`) so `diag`/readiness checks pick it up the same way.

---

## 3. Relevance flag — `WHT_ON`, mirroring `fxOn` exactly

**`api/src/pages/common.js`, `getRelevanceFlags()`:**

```js
// Before: returns { vatRegistered, fxTracking, baseCurrency }
// After: add whtTracking, same shape/derivation as fxTracking (a plain
// settings-table lookup, default 'false' — see §0.1 on why this isn't
// jurisdiction-gated).
return {
  vatRegistered: !co || co.vat_registered !== false && co.vat_registered !== 0,
  fxTracking: settings.fx_tracking === 'true' ? 'true' : 'false',
  whtTracking: settings.wht_tracking === 'true' ? 'true' : 'false',
  baseCurrency: (co && co.base_currency) || ''
};
```

Also add `whtTracking: 'false'` to the two early-return fallback objects in the same function (the `!companyId` guard and the `catch` block) — both currently return `{ vatRegistered: true, fxTracking: 'false', baseCurrency: '' }`.

**`api/src/pages/bill-edit.js`**, alongside the existing `vatOn`/`fxOn` derivation in `buildBillEditPage()`:

```js
const whtOn = !!(flags && flags.whtTracking === 'true');
```

And in the embedded script, alongside `VAT_ON`/`FX_ON`:

```js
const WHT_ON = ${whtOn ? 'true' : 'false'};
```

No settings-table row needs seeding at company-creation time beyond what `setup.js` already writes for `fx_tracking` (default `'false'`) — add one line to that same `bulkInsert('settings', [...])` block:

```js
{ company_id: company.company_id, key: 'wht_tracking', value: 'false', updated_at: now },
```

---

## 4. `api/src/wht.js` — new module, mirrors `api/src/vat.js`

```js
'use strict';
const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert } = require('./db');

async function handleWht(ctx, action) {
  switch (action) {
    case 'wht.codes.list':   return listWhtCodes(ctx);
    case 'wht.codes.upsert': return upsertWhtCode(ctx);
    case 'wht.codes.delete': return deleteWhtCode(ctx);
    default:
      throw Object.assign(new Error(`Unknown wht action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

async function listWhtCodes(ctx) {
  const { companyId } = ctx;
  return query(
    `SELECT wht_code, description, rate, wht_account, report_box, is_active, effective_from, effective_to
     FROM wht_codes WHERE company_id = @companyId ORDER BY wht_code`,
    { companyId }
  );
}

async function upsertWhtCode(ctx) {
  const { companyId, body } = ctx;
  const w = body.whtCode;
  if (!w || !w.wht_code) throw Object.assign(new Error('wht_code required'), { code: 'INVALID_INPUT' });
  const existing = await query(
    `SELECT wht_code FROM wht_codes WHERE company_id=@companyId AND wht_code=@code LIMIT 1`,
    { companyId, code: w.wht_code }
  );
  const params = {
    companyId, code: w.wht_code,
    description: w.description || '', rate: Number(w.rate) || 0,
    wht_account: w.wht_account || null, report_box: w.report_box || null,
    is_active: w.is_active !== false,
  };
  if (existing.length) {
    await exec(
      `UPDATE wht_codes SET description=@description, rate=@rate, wht_account=@wht_account,
         report_box=@report_box, is_active=@is_active
       WHERE company_id=@companyId AND wht_code=@code`,
      params
    );
  } else {
    await bulkInsert('wht_codes', [{
      company_id: companyId, wht_code: w.wht_code, description: w.description || '',
      rate: Number(w.rate) || 0, wht_account: w.wht_account || null, report_box: w.report_box || null,
      is_active: w.is_active !== false, effective_from: new Date().toISOString().slice(0, 10), effective_to: null,
    }]);
  }
  return { saved: true, wht_code: w.wht_code };
}

async function deleteWhtCode(ctx) {
  const { companyId, body } = ctx;
  const code = body.whtCode;
  if (!code) throw Object.assign(new Error('whtCode required'), { code: 'INVALID_INPUT' });
  await exec(`DELETE FROM wht_codes WHERE company_id=@companyId AND wht_code=@code`, { companyId, code });
  return { deleted: true };
}

module.exports = { handleWht };
```

(`upsertWhtCode`'s existence-check-then-branch mirrors the per-row, no-multi-statement-magic style already established for this codebase's DuckDB access — same reasoning `bills-partner-fk-spec.md` §2.1 gives for looping instead of a single `UPDATE ... FROM`.)

### 4.1 Wiring — three files, small additions each

**`api/src/index.js`:**
- `const { handleWht } = require('./wht');` (alongside the existing `const { handleVat } = require('./vat');`)
- `case 'wht': result = await handleWht(ctx, action); break;` (alongside `case 'vat':`)
- `wht: () => require('./wht').handleWht(ctx, action),` in the agent/MCP dispatch map (alongside `vat: () => require('./vat').handleVat(ctx, action),`) — needed so `wht.codes.list` is reachable from the agent surface (an agent proposing a `journal.propose`/`bill.create` involving WHT needs to be able to read which codes exist).

**`api/src/action-catalog.js`**, alongside the existing `// ── VAT codes ──` block:

```js
// ── WHT codes ────────────────────────────────────────────────────────────
'wht.codes.list':   { role: 'viewer', mutating: false, description: 'List withholding-tax codes.' },
'wht.codes.upsert': { role: 'owner', mutating: true, description: 'Insert or update one WHT code.',
  params: { whtCode: { type: 'object', required: true } } },
'wht.codes.delete': { role: 'owner', mutating: true, description: 'Delete one WHT code.',
  params: { whtCode: { type: 'string', required: true } } },
```

Same roles as their `vat.codes.*` counterparts — `list` is agent-readable (a read), `upsert`/`delete` are `owner`-only master-data mutations, matching how `vat.codes.upsert` is scoped.

---

## 5. `bills.js` — the actual posting logic

This is the core of the spec — everything above exists to make this section possible. Grounded against the real VAT loop (`api/src/bills.js`, `createBill`, roughly lines 344–445) rather than described abstractly.

### 5.1 A parallel accumulation loop, alongside the VAT one

**Before** (existing VAT accumulation, inside the `for (const expLine of expenseLines)` loop):

```js
const stdTaxByCode = {};
const rcTaxByCode = {};
for (const expLine of expenseLines) {
  const lineAmount = Number(expLine.amount || 0);
  const lineNet = lineAmount;
  if (expLine.vat_code && company.vat_registered) {
    // ... existing VAT lookup + accumulation ...
  }
  // ... existing DR expense line push ...
}
```

**After** — add a `whtByCode` accumulator alongside `stdTaxByCode`/`rcTaxByCode`, populated in the same loop (one extra lookup per line, same shape as the VAT one, no RC-style split since WHT has no reverse-charge concept):

```js
const stdTaxByCode = {};
const rcTaxByCode = {};
const whtByCode = {};  // wht_code -> { account, computed, net }
for (const expLine of expenseLines) {
  const lineAmount = Number(expLine.amount || 0);
  const lineNet = lineAmount;
  if (expLine.vat_code && company.vat_registered) {
    // ... existing VAT lookup + accumulation, unchanged ...
  }
  if (expLine.wht_code) {
    // No wht_tracking gate here, unlike VAT's `company.vat_registered` check
    // above — deliberate (§0.1): the setting controls whether the UI shows
    // the column, not whether a code that's actually present on a line gets
    // honored. An API/agent caller or an old draft can carry a wht_code
    // regardless of the current toggle state, and it should still compute.
    const whtRows = await query(
      `SELECT rate, wht_account FROM wht_codes WHERE company_id = @companyId AND wht_code = @whtCode AND is_active = true LIMIT 1`,
      { companyId, whtCode: expLine.wht_code }
    );
    if (whtRows.length > 0) {
      const wc = whtRows[0];
      const expectedWht = Math.round(lineNet * Number(wc.rate) * 100) / 100;  // base per §0.4
      const b = whtByCode[expLine.wht_code] || (whtByCode[expLine.wht_code] = { account: wc.wht_account, computed: 0, net: 0 });
      b.computed += expectedWht;
      b.net += lineNet;
    } else {
      // Unlike VAT's silent skip on an unmatched code: WHT codes are
      // user-typed (not picked from a small jurisdiction-seeded list, §7),
      // so a typo is a real risk a silent skip would mask. Warn, don't fail
      // — validateBill (§5.1a) already hard-fails the cases that matter
      // (missing account); this is just "you referenced a code that isn't
      // there," which shouldn't block a post but should be visible.
      validation.warnings.push(`WHT code ${expLine.wht_code} not found or inactive — line posted without withholding`);
    }
  }
  // ... existing DR expense line push, unchanged ...
}
```

No `company.wht_registered`-style gate the way VAT checks `company.vat_registered` — §0.1 already decided this isn't jurisdiction/registration-gated, just per-line code presence.

### 5.1a `validateBill` — reject a missing payable account before any journal line gets built

**Real bug found while grounding this, not a hypothetical:** `journal_entries.account_code` is `NOT NULL` (checked `db/schema.sql` directly — no FK, just the constraint). §2's seed template ships `wht_account: null` by design, and §5.1's loop pushes that value straight into a journal credit line's `account_code`. `bulkInsert` writes all rows in a single `INSERT` statement, so this fails atomically rather than corrupting data — but it fails as a raw DB constraint error, not a message anyone should have to see. Fix it the same way the AP account is already handled: reject it in `validateBill` (`api/src/validation.js`), before `createBill` builds a single journal line.

**Location:** right after the existing `if (apAcct && !foundCodes.has(apAcct)) errors.push(...)` line (`api/src/validation.js`, ~line 167).

```js
// WHT: every line's wht_code must exist, be active, and have a payable
// account configured — otherwise posting either silently under-books a real
// tax liability or crashes on the NOT NULL constraint described above.
// Reject it here, the same way a missing AP account already is.
const whtCodesUsed = Array.from(new Set(
  (Array.isArray(bill.lines) ? bill.lines : [])
    .map(l => (l && l.wht_code ? String(l.wht_code).trim() : ''))
    .filter(Boolean)
));
if (whtCodesUsed.length) {
  const wPlaceholders = whtCodesUsed.map((_, i) => '@wc' + i).join(', ');
  const wParams = { companyId };
  whtCodesUsed.forEach((c, i) => { wParams['wc' + i] = c; });
  const whtRows = await query(
    `SELECT wht_code, wht_account, is_active FROM wht_codes WHERE company_id = @companyId AND wht_code IN (${wPlaceholders})`,
    wParams
  );
  const whtFound = {};
  whtRows.forEach((r) => { whtFound[r.wht_code] = r; });
  whtCodesUsed.forEach((code) => {
    const row = whtFound[code];
    if (!row || row.is_active === false) errors.push(`WHT code ${code} does not exist or is inactive`);
    else if (!row.wht_account) errors.push(`WHT code ${code} has no payable account configured — set it in Settings → WHT Codes`);
  });
}
```

**One deliberate edge case, not engineered around:** `validateBill` runs before the `payment_batch_id` branch too (§0.6), which never actually computes WHT. So a bank-imported bill whose lines happen to carry a misconfigured `wht_code` gets rejected by this check even though that code path wouldn't have used it anyway. Left as-is rather than adding a conditional — rejecting is the safe default (forces a fix or removing the code), and a bank-imported bill carrying an explicit per-line WHT code is expected to be rare.

### 5.2 Credit lines: reduce AP, add WHT payable — right after the existing VAT tax-line writing

**Before** (right after the VAT DR tax lines are written, before the totals section):

```js
const totalNetAmount = lines.filter(l => l.net_amount > 0 && !l.vat_code).reduce((s, l) => s + Number(l.net_amount || 0), 0) || totalAmount;
const totalVatAmount = totalStdVat + totalRcVat;
const totalDebit = totalNetAmount + totalStdVat;

lines.push({ ..., account_code: bill.ap_account, debit: 0, credit: totalDebit, ..., description: `AP: ${desc}`, ... });
```

**After** — write one CR line per WHT code first (mirrors the VAT DR-per-code loop), then reduce the AP credit by the total:

```js
const totalNetAmount = lines.filter(l => l.net_amount > 0 && !l.vat_code).reduce((s, l) => s + Number(l.net_amount || 0), 0) || totalAmount;
const totalVatAmount = totalStdVat + totalRcVat;
const totalDebit = totalNetAmount + totalStdVat;  // unchanged — this is still the full gross, DR side never changes

let totalWht = 0;
for (const code of Object.keys(whtByCode)) {
  const b = whtByCode[code];
  const amt = Math.round(b.computed * 100) / 100;
  if (amt === 0) continue;
  totalWht += amt;
  lines.push({ company_id: companyId, entry_id: uuid(), batch_id: batchId, date: bill.date, account_code: b.account, debit: 0, credit: amt, currency, fx_rate: fxRate, debit_home: 0, credit_home: amt * fxRate, vat_code: null, vat_amount: 0, vat_amount_home: 0, wht_code: code, wht_amount: amt, wht_amount_home: amt * fxRate, net_amount: 0, net_amount_home: 0, description: `WHT Payable: ${bill.partner_name}`, reference: apRef, source: 'manual', cost_center: null, profit_center: null, reverses: null, reversed_by: null, bill_id: billId, created_by: userEmail, created_at: now });
}
const totalAp = totalDebit - totalWht;  // this is the new bills.amount (§0.2)

lines.push({ ..., account_code: bill.ap_account, debit: 0, credit: totalAp, credit_home: totalAp * fxRate, ..., description: `AP: ${desc}`, ... });
```

The entry still balances: DR side (`totalDebit`, unchanged) = CR side (`totalAp + totalWht` = `totalDebit`, by construction).

`net_amount: 0` on this line, not `b.net` — checked the existing RC-output VAT credit line (`bills.js`, the `rcTaxByCode` loop's second `lines.push`) and it already sets `net_amount: 0, net_amount_home: 0` on its credit line, reserving `net_amount` for the *debit*-side tax lines where it represents the taxable base. The WHT credit line is credit-side, same as that RC-output line — matching its convention instead of repurposing `net_amount` as generic metadata on a liability line, which would only coincidentally not collide with anything today (VAT return queries filtering on `net_amount_home` would work by accident, only because `vat_code IS NULL` on WHT lines — fragile, not a reason to rely on it).

### 5.3 `bills.amount`/`amount_home`/`wht_amount`/`wht_code` — the two tax-computing write paths (the third, non-computing one is §5.7)

Both the draft→posted `UPDATE` and the direct-insert branch currently use `totalDebit` for `amount`/`amount_home`. Per §0.2, both become `totalAp`:

**`UPDATE bills SET ...` branch** — change `amount: totalDebit, amount_home: totalDebit * fxRate,` to `amount: totalAp, amount_home: totalAp * fxRate,`, and add `wht_code=@wht_code, wht_amount=@wht_amount` to the `SET` clause + params — `wht_code: expenseLines[0].wht_code || null`.

**Not `Object.keys(whtByCode)[0]`, as an earlier draft of this spec had it** — checked `firstVatCode`'s actual definition (`bills.js`: `const firstVatCode = expenseLines[0].vat_code;`) and it's genuinely just "line 1's code," full stop, regardless of whether line 1's code ended up computing a nonzero amount. `Object.keys(whtByCode)[0]` is a different rule — "the first code that successfully matched an active DB row," which for a bill where line 1 has no WHT and line 2 does would disagree with what the VAT equivalent would report for the same bill shape. Aligned to `expenseLines[0].wht_code` for actual consistency rather than a merely similar-looking one.

**Direct-insert branch** — change:
```js
await bulkInsert('bills', [{ ...billRow, amount: totalDebit, amount_home: totalDebit * fxRate, vat_amount: totalVatAmount, net_amount: totalNetAmount, status: 'posted', amount_paid: 0 }]);
```
to:
```js
await bulkInsert('bills', [{ ...billRow, amount: totalAp, amount_home: totalAp * fxRate, vat_amount: totalVatAmount, net_amount: totalNetAmount, wht_code: expenseLines[0].wht_code || null, wht_amount: totalWht, status: 'posted', amount_paid: 0 }]);
```

**`emitEvent('bill.posted', ...)`** — also reads `amount: totalDebit` a few lines later. Change to `amount: totalAp` too, or the event stream (which the agent inbox and any external consumer reads) would report a different figure than `bill.get` returns for the same bill — exactly the class of drift bug this codebase has caught more than once already (`bills-partner-fk-spec.md` §3.3, the header-cleanup spec's §1.5).

### 5.4 `billLineRows` (the `bill_lines` subledger insert) — add `wht_code`

Same spot as the #3 spec's `quantity`/`unit_price` addition — add `wht_code: expLine.wht_code || null,` to the mapped object.

### 5.5 `saveDraftBill` — the draft-total preview needs the same treatment

`saveDraftBill` runs its own lighter VAT computation to show a live draft total before anything's posted — a batched rate-cache fetch, then one loop over `bill.lines` computing `netTotal`/`stdComputed`. It needs a parallel WHT pass so a draft's displayed/stored `amount` is *also* net-of-WHT before posting — otherwise a draft would show one total and posting would produce a different (correct) one, exactly the "client and server disagree" bug this spec should avoid introducing. Written against the actual function this time, not described abstractly — the batched-fetch-then-single-loop shape below matches how the existing VAT computation there already works (unlike `createBill`'s per-line VAT lookup, §5.1's WHT addition mirrors *this* function's own convention: pre-fetch once, not once per line).

**Before** (`saveDraftBill`, inside the `if (Array.isArray(bill.lines) && bill.lines.length)` branch):

```js
const seenCodes = Array.from(new Set(
  bill.lines.map(l => (l && l.vat_code ? String(l.vat_code).trim() : '')).filter(Boolean)
));
const rateCache = {};
if (seenCodes.length) {
  // ... existing VAT rate-cache query, unchanged ...
}
let netTotal = 0, stdComputed = 0, legacyStatedSum = 0, sawLegacyOverride = false;
for (const l of bill.lines) {
  const amt = Number(l.amount || 0);
  netTotal += amt;
  // ... existing VAT accumulation, unchanged ...
}
// ... statedForDraft resolution, unchanged ...
totalAmount = netTotal + ((statedForDraft !== null && stdComputed > 0) ? statedForDraft : stdComputed);
```

**After** — a matching WHT rate-cache fetch alongside the VAT one, a `whtTotal` accumulator folded into the *same* loop (not a second pass over `bill.lines`), and the final line changed to subtract it:

```js
const seenCodes = Array.from(new Set(
  bill.lines.map(l => (l && l.vat_code ? String(l.vat_code).trim() : '')).filter(Boolean)
));
const rateCache = {};
if (seenCodes.length) {
  // ... existing VAT rate-cache query, unchanged ...
}
const seenWhtCodes = Array.from(new Set(
  bill.lines.map(l => (l && l.wht_code ? String(l.wht_code).trim() : '')).filter(Boolean)
));
const whtRateCache = {}; // code -> rate
if (seenWhtCodes.length) {
  const wPlaceholders = seenWhtCodes.map((_, i) => `@wc${i}`).join(',');
  const wParams = { companyId };
  seenWhtCodes.forEach((c, i) => { wParams[`wc${i}`] = c; });
  const whtRateRows = await query(
    `SELECT wht_code, rate FROM wht_codes WHERE company_id = @companyId AND wht_code IN (${wPlaceholders}) AND is_active = true`,
    wParams
  );
  for (const r of whtRateRows) whtRateCache[r.wht_code] = Number(r.rate);
}
let netTotal = 0, stdComputed = 0, legacyStatedSum = 0, sawLegacyOverride = false, whtTotal = 0;
for (const l of bill.lines) {
  const amt = Number(l.amount || 0);
  netTotal += amt;
  const wcode = (l && l.wht_code ? String(l.wht_code).trim() : '');
  if (wcode && whtRateCache[wcode] != null) {
    whtTotal += Math.round(amt * whtRateCache[wcode] * 100) / 100;  // same base + rounding as §5.1
  }
  // ... existing VAT accumulation, unchanged ...
}
// ... statedForDraft resolution, unchanged ...
totalAmount = netTotal + ((statedForDraft !== null && stdComputed > 0) ? statedForDraft : stdComputed) - whtTotal;
```

Same `Math.round(amt * rate * 100) / 100` per-line rounding as §5.1's `expectedWht`, so a draft's preview and its eventual posted total genuinely agree, not just approximately.

### 5.6 `postDraftBill` — the whitelist, again

Third time this exact bug class has come up in this codebase (`partner_id`, then `ap_account`, now this) — `postDraftBill`'s `resolvedLines` map needs `wht_code: l.wht_code || null,` added, or it silently drops on every draft-to-post transition. Same fix shape as the #3 spec's §5.2.

### 5.7 The `payment_batch_id` branch — columns added for schema completeness, logic intentionally untouched

Per §0.6, this branch (`createBill`, `if (payment_batch_id) { ... }`) never reaches the VAT/WHT loop at all — it returns early with `amount: totalAmount` (raw line sum, no tax computation of any kind, matching its existing `vat_amount: 0` hardcode). Not adding WHT computation here — that would mean teaching a bank-import-reconciliation path to also run tax logic it was never designed to run, a much bigger and riskier change than this spec's scope. What *does* need to change, purely for schema/row consistency: both of this branch's `bills` writes (the `UPDATE ... SET` for `replaceDraftId`, and the `bulkInsert` for a fresh row) should explicitly set `wht_code: null, wht_amount: 0` rather than leaving those two new columns implicitly `NULL`/absent — so every `bills` row has a well-defined value for them regardless of which of the three `createBill` branches wrote it, instead of two branches setting real values and a third leaving the column's default to do the work silently.

---

## 6. `bill-edit.js` — line editor integration

### 6.1 `LINE_COLUMNS` — uncomment the reserved slot

```js
{ id: 'wht',  label: 'WHT code',           cls: 'bl-wht',    tier: 2, conditionalOn: () => WHT_ON },
```

Exactly as the layout-prep spec left it commented, `conditionalOn` included this time (unlike qty/rate — WHT genuinely is optional per company, per §0.1).

### 6.2 `renderCell()` — new case, and a dropdown attach mirroring `attachVat`

```js
case 'wht': inner = '<input class="bl-wht" value="' + FB.util.escAttr(data.wht_code || '') + '" autocomplete="off" placeholder="—">'; break;
```

New helper, next to the existing `attachVat()`:

```js
function attachWht(input) {
  FB.dropdown.attach(input, {
    minWidth: 220,
    source: q => {
      q = (q || '').toLowerCase();
      return [{ wht_code: '', description: 'none', rate: 0 }].concat(S.whtCodes)
        .filter(w => (w.wht_code || '').toLowerCase().includes(q) || (w.description || '').toLowerCase().includes(q))
        .map(w => ({ primary: w.wht_code || '—', secondary: w.description || '', data: w }));
    },
    onPick: (it, inp) => { inp.value = it.data.wht_code; inp.dispatchEvent(new Event('input', { bubbles: true })); },
  });
}
```

Wired in `addLine()` alongside `if (VAT_ON) attachVat(...)`: `if (WHT_ON) attachWht(row.querySelector('.bl-wht'));`.

### 6.3 Data loading — `S.whtCodes`, alongside `S.vatCodes`

`S` gains a `whtCodes: []` entry, and the init `Promise.all(...)` block gains a conditional load exactly mirroring the existing `VAT_ON` one:

```js
...(WHT_ON ? [apiAction('wht.codes.list').then(d => { S.whtCodes = d || []; })] : []),
```

### 6.4 `collectLines()` / `prefillFromDraft()` — carry `wht_code`

Same shape as every other per-line field: add `wht_code: (function(){ var w = row.querySelector('.bl-wht'); return w ? (w.value.trim() || '') : ''; })(),` to `collectLines()`'s returned object, and `wht_code: l.wht_code || '',` to the `addLine({...})` call in `prefillFromDraft()`.

### 6.5 Totals footer — a new line, not a redefinition of "Gross"

Deliberately not repurposing the existing "Gross" figure (still net + VAT, unchanged meaning — §0.2 keeps that distinction explicit rather than quietly redefining a label a returning user already knows). Add a WHT deduction and a new "Payable to vendor" figure alongside it:

**Before** (the `.totals` block, current three spans):

```html
<span>Net <b id="be-tot-net">0.00</b></span>
${vatOn ? '<span ...>GST <input id="be-tot-gst" .../></span>' : ''}
<span>Gross <b id="be-tot-gross">0.00</b></span>
```

**After:**

```html
<span>Net <b id="be-tot-net">0.00</b></span>
${vatOn ? '<span ...>GST <input id="be-tot-gst" .../></span>' : ''}
<span>Gross <b id="be-tot-gross">0.00</b></span>
${whtOn ? '<span title="Withheld and remitted to the tax authority separately — not paid to the vendor">WHT <b id="be-tot-wht" style="color:#b26a00">0.00</b></span><span>Payable to vendor <b id="be-tot-payable">0.00</b></span>' : ''}
```

`updateTotals()` gains a WHT pass mirroring the existing VAT-code-rows computation (same `S.whtCodes` lookup shape as `vatRateOf()`), setting `be-tot-wht` to the sum and `be-tot-payable` to `gross - wht`. No stated/override input for WHT (§0.5), so this is display-only — unlike `#be-tot-gst`, there's no matching input element here, just two more `<b>` totals fed by the same client-side preview calculation `updateTotals()` already does for GST.

**Superseded (2026-09-06, bill-line-item-grid-spec.md):** the footer shape above (`#be-tot-gst` input, `#be-code-rows`) no longer exists — both VAT and WHT moved from footer text into real per-code grid rows sharing the line-items table. §0.5's decision is unchanged: WHT still has no stated/override mechanism, so its grid row renders with a genuinely disabled Debit/Credit input (`editable: false` in `computeAutoLines()`), not merely a display-only convention as it was for the old footer `<b>` totals. The `WHT — <code>` row credits the code's `wht_account`, mirroring the `CR WHT Payable` line `bills.js` already posts.

---

## 7. Settings UI — mirrors the existing VAT Codes screen almost exactly

**Found the exact pattern to copy:** `api/src/pages/master-data.js` already has a full VAT Codes management screen (an `FB.list` tree/table config: `blank()`, `isBlank()`, `validate()`, `list.url`/`list.map`, `save.action: 'vat.codes.upsert'`, `del.action: 'vat.codes.delete'` — lines ~440–468). A WHT Codes tab is a near-verbatim copy of that config, swapping `vat` for `wht`, `input_account`/`output_account` for a single `wht_account`, and dropping `is_reverse_charge` (not a WHT field, §1). This spec doesn't reproduce the full config here — it's a mechanical adaptation of an existing, working block, not new design — but it **is** a required dependency, not an optional follow-up: without it, WHT codes can only be created via direct API calls, and the feature isn't usable through the UI at all.

Also needs: a `wht_tracking` on/off toggle in the relevant settings page, mirroring wherever `fx_tracking` is currently exposed (not inspected in detail here — same shape, same settings action).

---

## 8. What is explicitly out of scope

- **Any remittance/filing tracking** — §0.3. Settling the WHT payable account is a manual journal entry, same as any other liability, forever (unless a future spec decides otherwise).
- **A stated/override mechanism for WHT** — §0.5.
- **Gross-basis (vs. net-basis) computation per code** — §0.4. Every code uses the same base as VAT for now.
- ~~**The posted-bill view doesn't show WHT**~~ — **closed** (2026-09-06, bill-line-item-grid-spec.md): the WHT auto-row is a real grid row present in both editable and locked rendering (locked just disables its inputs, same as every other line), so a posted bill's WHT amount is visible without a separate follow-up.
- **AP Aging report changes** — it already reads `bills.amount`/`amount_paid`, which are now correctly net-of-WHT by construction (§0.2); no code change needed there, but worth a manual spot-check once implemented rather than assumed. **Known display gap, accepted for v1:** a bill list or aging report showing a bill that was 1,000 gross with 170 WHT will show 830, with nothing on that screen explaining why — the totals footer (§6.5) only surfaces the breakdown on the bill editor itself. Fine to ship without fixing, but worth telling users up front rather than letting them discover it.
- **Treaty-rate lookups, WHT certificates, or any other jurisdiction-specific compliance mechanics** beyond "pick a code, apply its rate."

---

## 9. Rollout order

Bigger than the #3 spec's, and phasing matters more here — each phase is independently testable before the next depends on it:

1. **§1 (schema) + §2 (jurisdiction seed) + §4 (`wht.js` module + wiring).** Nothing posts differently yet. Verify: a fresh SG company gets a seeded `wht_codes` row; `wht.codes.list`/`upsert`/`delete` work via direct API calls; a fresh SE company gets none.
2. **§3 (relevance flag).** Still no behavior change — `WHT_ON` just becomes computable. Verify `getRelevanceFlags()` returns the right `whtTracking` value before and after flipping the setting.
3. **§5 (posting logic), tested via direct API calls, not the UI yet.** This is the highest-risk phase — it changes what `bills.amount` means. Verify thoroughly (§10) before touching the UI at all, since a bug here corrupts ledger data, not just a display.
4. **§6 (bill editor) + §7 (settings UI) together**, once §5 is confirmed correct independently.

## 10. Test coverage

- A bill with one WHT-coded line posts with: the expected WHT credit line on the correct account; the AP credit reduced by exactly that amount; `bills.amount` equal to gross minus WHT; the journal entry still balances (DR total = CR total).
- A bill with WHT **and** VAT on the same line posts correctly with all three effects present (DR expense, DR input VAT, CR AP net of WHT, CR WHT payable) and still balances.
- `bill.posted` event's `amount` matches `bill.get`'s `amount` for the same bill (regression test for §5.3's `emitEvent` fix).
- Draft-save → draft-post preserves `wht_code` (regression test for §5.6, same pattern as the #3 spec's §5.2 test and `bills-partner-fk-spec.md`'s original `partner_id` test).
- A draft's previewed total (§5.5) matches what actually posts (§5.1–5.3) for the same set of lines — the specific "client and server must agree" case called out in §5.5.
- A bill with no WHT-coded lines behaves identically to today in every respect, including for companies where `wht_tracking` is off entirely.
- Settlement: recording a payment for the full `bills.amount` (net-of-WHT) marks the bill `'paid'`, not stuck at `'partial'` — the specific scenario §0.2 was written to fix.

## 11. Acceptance criteria

1. `wht_codes`, seeded from the jurisdiction pack where one exists (SG), empty where one doesn't (SE), manually addable regardless via the settings screen.
2. `wht_tracking` off by default for every company; turning it on reveals the WHT column/dropdown on bill lines and the totals-footer deduction, matching how `VAT_ON`/`FX_ON` already gate their columns.
3. Posting a WHT-coded bill produces a balanced journal entry with the AP credit reduced and a WHT payable credit added, per §5.2's math.
4. `bills.amount` is net-of-WHT everywhere it's read: `bill.get`, `bill.list`, AP aging, and `bill_payments`/settlement all agree.
5. A bill with no WHT involved is byte-for-byte unaffected — same journal lines, same `bills.amount`, as before this spec.
6. The rate applied at posting is always read from `wht_codes.rate` at that moment — never a literal number anywhere in `bills.js` or any other server file. Changing a rate via the Settings screen (§7) changes what the *next* bill posts with, with no code change and no redeploy. (The 17% in `db/jurisdictions/SG/wht_codes.json` is a one-time seed value written into the company's own row at setup — from that point on it's ordinary editable data, identical in kind to a VAT rate.)
7. A bill referencing a `wht_code` with no `wht_account` configured is rejected at validation with a clear message, before any journal line is built — never a raw NOT NULL constraint error (§5.1a).
8. A bill referencing a `wht_code` that doesn't exist or is inactive is also rejected at validation (same check, §5.1a) — not silently posted without withholding.

## 12. File-by-file change list

| File | Change |
|---|---|
| `db/schema.sql` | New `wht_codes` table; add `wht_code` to `bill_lines`; add `wht_code`/`wht_amount` to `bills`; add `wht_code`/`wht_amount`/`wht_amount_home` to `journal_entries` (§1). |
| `db/jurisdictions/SG/wht_codes.json` | New file, illustrative seed codes (§2, §0.7). |
| `db/jurisdictions/SE/` | No change — no `wht_codes.json` added (§2). |
| `api/src/setup.js` | Seed `wht_codes` from the jurisdiction pack (§2.1); add `wht_codes` to the `expected` tables list; seed `wht_tracking: 'false'` into `settings` (§3). |
| `api/src/wht.js` | New file — `handleWht`, `listWhtCodes`, `upsertWhtCode`, `deleteWhtCode` (§4). |
| `api/src/index.js` | Register `handleWht` in the main dispatch switch and the agent/MCP handlers map (§4.1). |
| `api/src/action-catalog.js` | Add `wht.codes.list`/`upsert`/`delete` entries (§4.1). |
| `api/src/pages/common.js` | `getRelevanceFlags()` returns `whtTracking` (§3). |
| `api/src/validation.js` | `validateBill()` rejects a missing/inactive/account-less `wht_code` before `createBill` builds any journal line (§5.1a). |
| `api/src/bills.js` | `whtByCode` accumulation + unmatched-code warning in `createBill`'s line loop (§5.1); WHT credit lines (`net_amount: 0`) + reduced AP credit (§5.2); `bills.amount`/`wht_code` (from `expenseLines[0].wht_code`)/`wht_amount` in both write paths, `emitEvent` fix (§5.3); `wht_code` in `billLineRows` (§5.4); parallel WHT pass folded into `saveDraftBill`'s existing draft-total loop (§5.5); `wht_code` in `postDraftBill`'s `resolvedLines` (§5.6); `wht_code: null, wht_amount: 0` added to both `payment_batch_id`-branch writes, logic otherwise untouched (§5.7). |
| `api/src/pages/bill-edit.js` | `whtOn`/`WHT_ON` derivation (§3); uncomment `wht` in `LINE_COLUMNS` (§6.1); `renderCell` case + `attachWht()` (§6.2); `S.whtCodes` + conditional load (§6.3); `wht_code` in `collectLines()`/`prefillFromDraft()` (§6.4); totals-footer WHT/payable spans + `updateTotals()` pass (§6.5). |
| `api/src/pages/master-data.js` | New WHT Codes tab, adapted from the existing VAT Codes config (§7). |
