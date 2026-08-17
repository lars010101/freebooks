# Bills → Partners Link: `bills.partner_id` Spec

**Status:** Draft v2 (ratified) — amended after review: §2.1 switched to per-row loop as primary (not `UPDATE ... FROM`); §3.2 amended to cover the existing-draft UPDATE SET clause.
**Depends on:** `partner-proposal-spec.md` (§1 Partners model); `partner-flags-ui-fix-spec.md` (§3, whose §3.2 server-side guard this spec unblocks).
**Amends:** `partner-proposal-spec.md` §1.4, which deferred the `bills.vendor`/`partner_name` → FK link as a future milestone. (The `vendor` → `partner_name` *rename* already shipped, per `schema.sql`'s `ALTER TABLE bills RENAME COLUMN vendor TO partner_name;` — only the FK itself remains outstanding.)

---

## 0. Context and scope

`bills.partner_name` is a free-text `VARCHAR NOT NULL` with no link to `partners.partner_id`. `partner-flags-ui-fix-spec.md` §3.2 needed exactly this link to guard bill creation against non-vendor partners, and deferred itself pending it. This spec is that follow-up.

### 0.1 Non-goal: this does not introduce an enforced foreign key

DuckDB, as pinned in this project, does not support `ALTER TABLE ... ADD CONSTRAINT` — `db/init.js`'s existing `applyUniqueConstraints()` already discovered and documented this (comment: *"current DuckDB does not support that ALTER option"*) and falls back to a plain `CREATE UNIQUE INDEX` for the same enforcement. Separately, **no table in `schema.sql` uses `FOREIGN KEY`/`REFERENCES` anywhere** — every cross-table relationship in this codebase (`bills.company_id`, `journal_entries.company_id`, etc.) is an unenforced, indexed lookup column. `bills.partner_id` follows that established convention: a nullable, indexed `VARCHAR`, with referential integrity enforced at the application layer (§3), not the database layer. "FK" in this spec's title means "the link," not a SQL `FOREIGN KEY` constraint.

### 0.2 Why nullable, and why it stays nullable

Bill entry today accepts a typed vendor name that doesn't need to match an existing partner (`payables-bills.js`'s blur-resolve comment: *"Leave typed-but-unknown values intact for server-side validation"*). That's existing, deliberate behavior, not a bug — this spec preserves it. `partner_id` is `NULL` whenever the bill's `partner_name` wasn't resolved to a `partners` row, and stays `NOT NULL`-free indefinitely (§5 defines exactly how the guard treats `NULL`).

---

## 1. Schema change

**File:** `db/schema.sql` (append, following the file's existing incremental-migration convention — see the `ALTER TABLE bills RENAME COLUMN vendor TO partner_name;` and `partners` flag additions already present near the end of the file).

```sql
ALTER TABLE bills ADD COLUMN IF NOT EXISTS partner_id VARCHAR;
CREATE INDEX IF NOT EXISTS idx_bills_partner_id ON bills(partner_id);
```

No `NOT NULL`, no `FOREIGN KEY` (§0.1). Index name follows the `idx_<table>_<column>` convention already used by `idx_partners_vendor` / `idx_partners_customer`.

---

## 2. Backfill

**File:** `db/init.js`, as a new idempotent migration step alongside the existing vendors→partners block, following the same idiom: check-before-act, never throw, `console.log`/`console.warn` on outcome, safe to run on every startup.

### 2.1 Resolution approach — per-row loop (primary)

For every bill with `partner_id IS NULL`, attempt a case-insensitive name match against `partners` within the same company. Use a per-row loop (read matches via `SELECT`, issue individual `UPDATE ... WHERE bill_id = @id`), mirroring how `applyUniqueConstraints()` already loops per-target rather than assuming multi-table SQL support. This is the proven pattern in this codebase; a single `UPDATE ... FROM` statement is version-dependent in DuckDB and risks crashing `init.js` if the try/catch isn't tight enough. At this project's bill volume the performance difference is negligible.

Per-row logic:

```js
const unmatched = await query(
  `SELECT bill_id, partner_name FROM bills WHERE company_id IS NOT NULL AND partner_id IS NULL`,
  {}
);
let matchedCount = 0;
for (const row of unmatched) {
  const matches = await query(
    `SELECT partner_id FROM partners
     WHERE LOWER(TRIM(name)) = LOWER(TRIM(@name))
     LIMIT 1`,
    { name: row.partner_name }
  );
  if (matches.length) {
    await exec(
      `UPDATE bills SET partner_id = @pid WHERE bill_id = @bid`,
      { pid: matches[0].partner_id, bid: row.bill_id }
    );
    matchedCount++;
  }
}
```

### 2.2 Idempotency

The `AND bills.partner_id IS NULL` guard makes re-running a no-op for already-resolved rows — safe on every `init.js` run, consistent with the rest of the file.

### 2.3 Unmatched rows are reported, not resolved

Rows that don't match (typo'd names, a partner later renamed, a partner later deleted, or a deliberately free-text vendor never added to `partners`) are left with `partner_id = NULL` — this is not an error state (§0.2). Log a count and a sample for visibility, matching the existing `console.warn` style used for duplicate/skip cases elsewhere in `init.js`:

```js
console.log(`Bills-partner backfill: matched ${matchedCount}, left unmatched ${unmatchedCount} (unresolved partner_name — expected for free-text vendors).`);
```

No automated fuzzy-matching, no auto-creation of missing partners — out of scope, and risky at this project's low bill-volume scale (§0.3 of `partner-flags-ui-fix-spec.md`).

---

## 3. Server-side write paths

**File:** `api/src/bills.js`. Three write functions currently construct a `partner_name`-only `billRow`/passthrough object; each needs `partner_id` added. A fourth was checked and needs no change.

### 3.1 `createBill` (`bill.create`)

Add `partner_id: bill.partner_id || null` to the `billRow` object alongside the existing `partner_name: bill.partner_name`.

### 3.2 `saveDraftBill` (`bill.draft.save`)

Same addition to its own, separately-constructed `billRow` object. **Additionally**, the existing-draft UPDATE path (`UPDATE bills SET partner_name=@partner_name, ... WHERE bill_id=@bill_id`) must include `partner_id=@partner_id` in its SET clause and params, or editing and re-saving an existing draft would silently lose `partner_id` — the same class of bug as §3.3.

### 3.3 `postDraftBill` (`bill.draft.post`) — requires care

This function reads the full draft row (`SELECT * FROM bills WHERE bill_id=@id ...`), which — once §1 and §2 land — *will* include `draft.partner_id`. But `postDraftBill` does not forward the spread row to `createBill`; it rebuilds an explicit field-by-field object:

```js
return createBill({
  ...ctx,
  body: {
    bill: {
      partner_name: bill.partner_name,
      vendor_ref: bill.vendor_ref,
      date: bill.date,
      // ...
```

This explicit whitelist does **not** include `partner_id` today, and would silently drop it even after §1/§2/§3.1 ship — the same class of bug as `partner-flags-ui-fix-spec.md`'s §2 finding (a save path silently discarding a field that exists on the row). **Fix:** add `partner_id: bill.partner_id,` to this object.

### 3.4 `updateBill` (`bill.update`) — no change needed

Confirmed this action only ever touches `vendor_ref`, `due_date`, and `description` (an explicit `setParts` allowlist) — it doesn't read or write `partner_name` today and this spec doesn't add `partner_id` to it either. Reassigning a bill's partner after creation is out of scope; if a wrong partner was picked, the existing correction path (void + re-enter, or draft delete + re-enter) applies unchanged.

### 3.5 `getBill`, `listBills` — no change needed

Both use `SELECT *`, so `partner_id` flows through automatically once §1 lands. `matchBill` uses an explicit column list for its bank-reconciliation matching query and doesn't need `partner_id` — its matching logic is amount/date/currency-based, not partner-based; leave as-is.

---

## 4. Client-side wiring

### 4.1 `payables-bills.js` — smaller than it first appears

Contrary to the impression that this page only sends `partner_name`: the partner_id capture is **already implemented**, just not fully connected. `billAttachPartner`'s `onPick` and blur-resolve handlers already write `inp.dataset.partnerId = v.partner_id`, and `harvestExtra` already lifts it onto the row buffer: `buf.partner_id = ds.partnerId || row.partner_id || ''`. The DEV NOTE comment above `billAttachPartner` (referencing "Task 6e") confirms this was mid-flight, planned work.

The only missing wire is `billSaveBody()`, which builds the final `{ bill: {...} }` POST payload and currently omits `partner_id` even though `b.partner_id` is available on the buffer by the time it's called. **Fix:** add `partner_id: b.partner_id || null` to `billSaveBody`'s returned object. One line.

(The list-row mapping around `_key: b.bill_id, ...` already defensively reads `partner_id: b.partner_id || ''` from loaded rows — that was already written in anticipation of `bill.list` eventually returning it, which §3.5 now delivers for free.)

### 4.2 `bill-edit.js` — needs the capture step `payables-bills.js` already has

This page's `FB.dropdown.attach` `onPick` handler currently discards the picked partner's id — it copies `it.primary` (name), and uses `v.default_currency`/`v.default_ap_account`/`v.payment_terms_days` for defaults, but never stores `v.partner_id` anywhere. **Fix:**

1. In `onPick`, store the id (e.g. `S.selectedPartnerId = v.partner_id;`, mirroring the `payables-bills.js` dataset pattern or using the page's existing `S` state object).
2. In the save-payload construction (where `partner_name: document.getElementById('be-partner-name').value.trim()` is built), add `partner_id: S.selectedPartnerId || null`.
3. In `prefillFromDraft`, when editing an existing draft, set `S.selectedPartnerId = bill.partner_id || null` (now returned by `bill.get` per §3.5) so re-saving an already-linked draft doesn't lose the link.
4. If the user types a name without picking from the dropdown (or edits a prefilled name), `S.selectedPartnerId` should be cleared/left `null` — same accepted free-text behavior as §0.2, not a regression to fix.

---

## 5. The §3.2 guard (now unblocked)

**File:** `api/src/bills.js`, in `createBill` and `saveDraftBill` (the two entry points that accept a client-supplied `partner_id`; `postDraftBill` inherits the check for free by delegating to `createBill`).

```js
if (bill.partner_id) {
  const rows = await query(
    `SELECT is_vendor FROM partners WHERE company_id = @companyId AND partner_id = @partnerId LIMIT 1`,
    { companyId, partnerId: bill.partner_id }
  );
  if (rows.length && rows[0].is_vendor === false) {
    throw Object.assign(new Error('Selected partner is not flagged as a vendor'), { code: 'INVALID_PARTNER_TYPE' });
  }
}
```

Guard fires **only** when `partner_id` is present and resolves to a partner with `is_vendor=FALSE`. A `NULL`/absent `partner_id` (free-text or unmatched name, §0.2) or a missing partner row passes through unguarded — identical to today's behavior, so this cannot newly reject a bill that would have succeeded before this spec.

---

## 6. Rollout order

Given this touches the bill creation path — the most test-covered path in the repo — land in this order, each independently verifiable before the next:

1. **§1 + §2** (schema + backfill). Zero behavior change: the column exists and is populated, but nothing reads or writes it yet. Safe to ship and observe.
2. **§3.1–3.3 + §4.1–4.2** (write paths + client wiring), guard *not yet* enabled. Verify via `bill.list`/`bill.get` that newly created and newly edited bills carry a correct `partner_id`, across both `payables-bills.js` and `bill-edit.js`, for both direct-post and draft-save-then-post flows.
3. **§5** (the guard), only once step 2 is confirmed working end-to-end. Enabling the guard before wiring is verified risks rejecting legitimate bills due to a wiring gap rather than an actual vendor/customer mismatch — worse than the current no-guard state.

---

## 7. Test coverage

New/updated tests needed around the existing bill-creation suite:

- `partner_id` round-trips: create → get, draft-save → draft-post → get, edit-and-resave a draft.
- Backfill: matches a case/whitespace-varied name; leaves a genuinely unmatched name as `NULL`; re-running is a no-op.
- Guard: rejects `partner_id` pointing at `is_vendor=FALSE`; allows `is_vendor=TRUE`; allows `partner_id=NULL` (free-text path unaffected).
- `postDraftBill`'s passthrough specifically — a regression test asserting `partner_id` survives the draft→post transition, given §3.3 is a whitelist-drop risk by construction.

---

## 8. Out of scope

- Enforcing `NOT NULL` on `bills.partner_id` — stays optional indefinitely (§0.2).
- A real DuckDB `FOREIGN KEY` constraint (§0.1).
- Upgrading the multi-bill-settlement partner-match (`payables-bills.js`'s `openMultiPayPanel`, currently keyed on case-insensitive `partner_name`) to key on `partner_id` instead — a reasonable future cleanup once this lands, not required here.
- Any change to `bill.match` or AR-side fields.

## 9. Acceptance criteria

1. `bills.partner_id` exists, indexed, nullable; re-running `init.js` is a no-op on an already-migrated DB.
2. Backfill correctly links existing bills where a case/whitespace-insensitive name match exists; leaves the rest `NULL` with a logged count.
3. Creating a bill via either entry UI, picking a partner from the dropdown, results in a stored `partner_id` matching that partner.
4. Typing a free-text vendor name without picking from the dropdown still succeeds, with `partner_id = NULL`, exactly as today.
5. Saving a draft, then posting it later, preserves `partner_id` (regression-guards §3.3).
6. Editing an existing linked draft in `bill-edit.js` and re-saving does not null out `partner_id`.
7. A direct API call creating a bill with `partner_id` pointing at an `is_vendor=FALSE` partner is rejected with `INVALID_PARTNER_TYPE`; the same call with `partner_id=NULL` or a valid vendor succeeds.

## 10. File-by-file change list

| File | Change |
|---|---|
| `db/schema.sql` | Add `bills.partner_id` column + index (§1) |
| `db/init.js` | Add idempotent backfill step (§2) |
| `api/src/bills.js` | `createBill`, `saveDraftBill`, `postDraftBill` pass `partner_id` through; add §5 guard to `createBill`/`saveDraftBill` (§3, §5) |
| `api/src/pages/payables-bills.js` | Add `partner_id` to `billSaveBody()`'s return (§4.1) |
| `api/src/pages/bill-edit.js` | Capture `partner_id` on pick, include in save payload, restore on `prefillFromDraft` (§4.2) |
