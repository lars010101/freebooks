# Partner Vendor/Customer Flag — Front-End Completion Spec

**Status:** Draft v2 (for ratification) — revised after review: §3.2 server-side guard removed as unimplementable without a `partners` FK (see §3.2); §1.3 loading-row `colspan` added.
**Depends on:** `partner-proposal-spec.md` (§1 Partners model, §1.4 UI, §5 Inbox integration).
**Amends:** `partner-proposal-spec.md` §1.4, which specified this UI but was left partially implemented.
**Closes:** [gap identified in code review — `is_vendor`/`is_customer` are stored and CRUD-able server-side but not functionally surfaced or safely editable client-side].

---

## 0. Context and scope

### 0.1 Summary of the problem

`partner-proposal-spec.md` §1 unified `vendors` into a single `partners` table carrying `is_vendor` and `is_customer` boolean flags, so a partner can be a vendor, a customer, or both. The schema (`db/schema.sql`) and backend (`api/src/partners.js`) fully implement this: both columns exist, are indexed, and are read/written correctly by every `partner.*` action.

§1.4 of that spec also specified the UI consequences: two checkbox columns on the Partners grid, and a `partner_type='vendor'` filter on the Bills partner dropdown. **Neither was finished.** A code review of the current `main` branch found four places where the flags are either invisible, inert, or silently destroyed by normal use:

1. **Master Data → Partners grid** (`api/src/pages/master-data.js`) declares `is_vendor`/`is_customer` as display columns, but the row-mapping function that turns server data into UI rows drops both fields before they ever reach the column renderer. Every row therefore displays the same constant placeholder ("V", never "C") regardless of the partner's actual database values. The static `<thead>` also has two fewer `<th>` cells than the column config has `<td>` cells per row, so even a correct value would render unlabeled and misaligned.
2. **The same grid's save path** (both the normal row-save and the `~` "toggle active" quick action) omits `is_vendor`/`is_customer` from the `partner.upsert` request body. The backend's `upsertPartner` defaults a missing `is_vendor` to `true` and a missing `is_customer` to `false` — so editing *any* field on a partner row silently resets it to vendor-only, overwriting a customer flag set through any other path (e.g. the agent's `partner.propose` → approve flow).
3. **Payables → Bills partner picker** (`api/src/pages/payables-bills.js`) loads partners via `partner.list` with no `partner_type` filter (contrary to spec §1.4) and shows no vendor/customer indicator in the dropdown. Nothing — client or server — stops a bill from being posted against a customer-only partner.
4. **Inbox partner-proposal review card** (`api/src/inbox.js`, `queryPartnerProposals`) does not select `is_vendor`/`is_customer` from `partner_proposals` and its summary text ("New partner suggested: `<name>`") gives the human reviewer no way to tell what type of partner they're approving before they approve it.

### 0.2 Why this matters now vs. later

AR/invoicing (P3-1) is currently dropped/deferred, so no first-party feature reads `is_customer=TRUE` today — this is not yet causing incorrect financial output. But it is already causing **data loss**: any partner flagged as a customer via the proposal flow and subsequently edited in the Partners grid has had that flag silently reverted. It should be fixed before AR ships, and before the proposal flow is relied on for customer creation, rather than after.

### 0.3 Scale assumptions

Same as `partner-proposal-spec.md` §0.5 — single-digit new partners per year, human review of every proposal. This is a UI-correctness fix, not a new subsystem; no new tables, no new actions.

---

## 1. Fix: Master Data → Partners grid (display)

**File:** `api/src/pages/master-data.js`

### 1.1 Row mapping must carry the flags

`partnersList.list.map()` currently returns an object that omits `is_vendor`/`is_customer` entirely:

```js
map: function(v) { return { partner_id: v.partner_id, name: v.name || '', default_currency: v.default_currency || '',
  payment_terms_days: v.payment_terms_days != null ? v.payment_terms_days : 30,
  default_expense_account: v.default_expense_account || '', default_ap_account: v.default_ap_account || '',
  is_active: v.is_active !== false, _key: v.partner_id }; }
```

**Fix:** add both fields, mirroring the existing `is_active` pattern:

```js
is_vendor: v.is_vendor !== false,
is_customer: v.is_customer === true,
```

### 1.2 Header/column count must match

The static `<thead>` for `#partners-table` has 6 `<th>` cells; the `columns` config has 8 entries (including `is_vendor`, `is_customer`). `fb-list.js` renders one `<td>` per configured column regardless of the `<thead>`, so the mismatch causes two unlabeled, misaligned trailing cells per row.

**Fix:** add two `<th>` cells to the thead. Recommended header labels: `Vendor` and `Customer` (or combine into a single `Type` column — see §1.3).

```html
<thead><tr>
  <th>Partner</th><th style="width:70px;text-align:center">CCY</th>
  <th style="width:110px;text-align:center">Terms (d)</th>
  <th style="width:140px">Expense A/C</th><th style="width:140px">AP A/C</th>
  <th style="width:60px;text-align:center">Vendor</th>
  <th style="width:60px;text-align:center">Customer</th>
  <th style="width:90px;text-align:center">Active</th>
</tr></thead>
```

### 1.3 Loading-row `colspan` must match the new column count

`#partners-body`'s loading placeholder row is hardcoded to the old column count:

```html
<tr><td colspan="6" style="text-align:center;color:#aaa;padding:32px">Loading&#8230;</td></tr>
```

This must become `colspan="8"` once §1.2 adds the two `<th>` cells, or the loading state renders misaligned against the (now 8-column) header row.

### 1.4 Recommended display improvement (optional, not required for correctness)

Two separate V/— and C/— badge columns are functionally fine but visually thin. Consider collapsing into one `Type` column with a single pill: `Vendor`, `Customer`, or `Vendor + Customer`. This is a cosmetic improvement and can be deferred; §1.1 and §1.2 are the required correctness fixes.

---

## 2. Fix: Master Data → Partners grid (edit/save)

**File:** `api/src/pages/master-data.js`

### 2.1 Normal row save

`save.body()` must include both flags, read from the dirty row buffer `d`, not hardcoded:

```js
save: { action: 'partner.upsert',
  body: function(d) { return { partner: {
    partner_id: d._isNew ? null : d._key,
    name: d.name,
    default_currency: d.default_currency || null,
    payment_terms_days: parseInt(d.payment_terms_days, 10) || 30,
    default_expense_account: d.default_expense_account || null,
    default_ap_account: d.default_ap_account || null,
    is_vendor: d.is_vendor !== false,
    is_customer: d.is_customer === true,
    is_active: d.is_active !== false
  } }; },
  focusKey: function(d, res) { return d._isNew ? (res.partnerId || d._key) : d._key; } }
```

### 2.2 `blank()` and `same()` already reference the flags

`blank()` already defaults `is_vendor: true, is_customer: false` for new rows, and `same()` already compares both flags for dirty-detection. Once §1.1 and §2.1 land, these existing functions start working correctly without further changes — they were written against the intended data shape; only the map/save plumbing was missing.

### 2.3 The `~` "toggle active" quick action

The `extraBindings` handler for `~` builds its own request body independent of `save.body()`, and has the identical omission:

```js
var v = { partner_id: d._key, name: d.name, default_currency: d.default_currency || null,
  payment_terms_days: d.payment_terms_days != null ? d.payment_terms_days : 30,
  default_expense_account: d.default_expense_account || null,
  default_ap_account: d.default_ap_account || null,
  is_active: d.is_active === false };
```

**Fix:** add `is_vendor: d.is_vendor !== false, is_customer: d.is_customer === true` to `v`.

**Recommended refactor:** both this handler and `save.body()` now build near-identical partial-partner objects. Consider factoring a single `partnerUpsertBody(d)` helper used by both, so a future field addition only needs to change one place. Not required for this fix but reduces recurrence risk.

### 2.4 Checkbox editability

Confirm (via `fb-list.js`'s checkbox column handling) that `is_vendor`/`is_customer` columns are editable in row-edit mode like any other `type: 'checkbox'` column — no framework change should be needed here since `is_active` already proves the pattern works; this is purely a page-level wiring gap.

---

## 3. Fix: Payables → Bills partner picker

**File:** `api/src/pages/payables-bills.js`

### 3.1 Filter the dropdown source to vendors

Per `partner-proposal-spec.md` §1.4: *"The bills dropdown in bill-entry reads from `partner.list` filtered to `is_vendor=TRUE`."* Current `loadPartners()` in this file calls `partner.list` with no `partner_type`:

```js
function loadPartners() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'partner.list', companyId: COMPANY }) })
  ...
}
```

**Fix:**

```js
body: JSON.stringify({ action:'partner.list', companyId: COMPANY, partner_type: 'vendor' })
```

### 3.2 Server-side guard — deferred

An earlier draft of this spec proposed a server-side guard in `bills.js` rejecting bill creation against a non-vendor partner, keyed on `partner_id`. **This is not implementable as stated: the `bills` table has no `partner_id` column.** `createBill` (`bills.js`, `billRow` construction) stores only `partner_name VARCHAR NOT NULL` — a free-text string, not a foreign key (confirmed in `db/schema.sql`'s `bills` table definition). `partner-proposal-spec.md` §1.4 already flags this (`bills.vendor`/`partner_name` → FK rename is explicitly deferred), and §6 of this spec inherited that deferral without carrying the consequence forward to §3.2.

The only available guard today would be a name lookup:

```sql
SELECT is_vendor FROM partners
WHERE company_id = @companyId AND LOWER(name) = LOWER(@partner_name) LIMIT 1
```

which is fragile in exactly the ways free-text matching always is: case/whitespace variance, a partner renamed after the bill was entered, or a `partner_name` that was typed in and never resolved to a `partners` row at all (bill entry doesn't require picking from the dropdown — a typed, unmatched name is accepted per `payables-bills.js`'s blur-resolve comment in the original code review). Building a guard on this lookup means either silently skipping the check when no match is found (weakening the guard to "warn only, when resolvable") or blocking bill entry for legitimate free-text vendor names, which is a behavior change beyond this spec's scope.

**Decision: defer §3.2.** Ship §3.1 (dropdown filtered to `is_vendor=TRUE`) as the only guard for this cycle. That closes the normal UI path; the only remaining bypass is a direct API/MCP call supplying an arbitrary `partner_name`, which is low-frequency at this project's scale (§0.3) and already possible today for *any* bad `partner_name` (misspelled, nonexistent, etc.) — this spec doesn't need to solve general referential integrity on `bills.partner_name`, only the vendor/customer-flag gap. Re-open a server-side guard once the `partner_id` FK lands (tracked in `partner-proposal-spec.md` §1.4's deferred rename) and can be keyed on an actual id instead of a name match.

### 3.3 Dropdown affordance (optional)

Not required, but worth considering: since §3.1 already filters to vendors, no additional visual indicator is needed in the dropdown itself. If a "dual" partner (both vendor and customer) is picked, no ambiguity exists for a bill — it's being used in its vendor capacity, which is correctly recorded on the bill regardless of the partner's other flag.

---

## 4. Fix: Inbox partner-proposal review card

**File:** `api/src/inbox.js`

### 4.1 Select the flags

`queryPartnerProposals` currently selects:

```sql
SELECT proposal_id, name, status, created_by, created_at
FROM partner_proposals
WHERE company_id = @companyId AND status = 'proposed'
```

**Fix:** add `is_vendor, is_customer` to the select list.

### 4.2 Reflect them in the summary

Replace the constant summary text with one that reflects the proposed type, so a reviewer can approve/reject with full information without opening the detail view:

```js
function partnerProposalSummary(row) {
  if (row.is_vendor !== false && row.is_customer === true) return 'New partner suggested (vendor + customer): ' + row.name;
  if (row.is_customer === true) return 'New customer suggested: ' + row.name;
  return 'New vendor suggested: ' + row.name;
}
```

Use this in place of the current `'New partner suggested: ' + row.name` literal.

---

## 5. Data remediation

Because bug §2 (missing flags on save) has likely been live since the partners unification shipped, some installs may already have partners whose `is_customer` flag was set true (via `partner.proposal.approve`) and then silently reset to false by a subsequent unrelated edit in the Partners grid.

**Recommended action, not a schema migration:** a one-time diagnostic query, run manually or via `admin.query`, to check for partners whose current state looks suspicious relative to `partner_proposals` history:

```sql
SELECT pp.proposal_id, pp.name, pp.is_customer AS proposed_is_customer,
       p.partner_id, p.is_customer AS current_is_customer
FROM partner_proposals pp
JOIN partners p ON p.company_id = pp.company_id AND LOWER(p.name) = LOWER(pp.name)
WHERE pp.status = 'approved' AND pp.is_customer = TRUE AND p.is_customer = FALSE;
```

Any rows returned represent a partner that was approved as a customer and has since lost that flag. This is informational only — resolve by hand (re-toggle `is_customer` in the fixed UI) rather than an automated backfill, since a partner's current `is_customer=FALSE` could also be a deliberate later change.

---

## 6. Out of scope

- AR/invoicing itself (P3-1) — `default_revenue_account` / `default_ar_account` stay unused until that ships.
- Adding a `bills.partner_id` FK and renaming `bills.vendor`/`partner_name` (per `partner-proposal-spec.md` §1.4, deferred as a cosmetic refactor). This spec's §3.2 guard is deferred along with it, for the same reason.
- Any new action, table, or column — this spec only fixes wiring between existing, already-correct backend fields and the UI.

---

## 7. Acceptance criteria

1. Loading Master Data → Partners shows the true `is_vendor`/`is_customer` state per row (verify against a partner seeded with `is_customer=TRUE` via direct DB insert or the proposal-approve flow).
2. Toggling either flag in the grid and saving (`w`) persists correctly on reload.
3. Editing an unrelated field (e.g. payment terms) and saving does **not** change `is_vendor`/`is_customer`.
4. Using `~` to toggle Active does **not** change `is_vendor`/`is_customer`.
5. The Bills partner dropdown lists only partners with `is_vendor=TRUE`.
6. An Inbox partner-proposal card for a proposal with `is_customer=TRUE` visibly says so before approval.
7. Header/column counts match on the Partners grid (no unlabeled trailing cells), including the loading-state row.

Note: a server-side guard against creating a bill for a non-vendor partner (originally item 6 in an earlier draft) is **not** an acceptance criterion for this spec — see §3.2, deferred pending the `partner_id` FK.

## 8. File-by-file change list

| File | Change |
|---|---|
| `api/src/pages/master-data.js` | Fix `list.map()`, `save.body()`, `~` handler body, `<thead>` cell count, loading-row `colspan` (§1, §2) |
| `api/src/pages/payables-bills.js` | Add `partner_type: 'vendor'` to `loadPartners()` (§3.1) |
| `api/src/inbox.js` | Select `is_vendor`/`is_customer` in `queryPartnerProposals`; update summary text (§4) |

`api/src/bills.js` is intentionally **not** in this change list — see §3.2.
