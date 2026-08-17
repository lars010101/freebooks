# FB.list Default-Period Seeding Spec

Status: **DRAFT — proposal, not yet ratified.** Companion: `fb-list-row-threshold-spec.md` (item 1, simplified — **that spec depends on this one**; see §1 below for the exact integration contract), `/api/:company/reports/default-period` (`api/src/reports.js` ~L206–L245, the endpoint this extends), `ap-aging-drilldown-spec.md` (precedent for the return-context/round-trip pattern, already built and live for one path).

---

## 1. Purpose, and the exact contract this owes item 1

`fb-list-row-threshold-spec.md` §1 states plainly: the threshold-and-block mechanism is only safe on a screen that has "a server-connected way to reduce `total`" — without it, hitting the threshold is a dead end, worse than the silent truncation it replaces. This spec is that mechanism, for the two screens that need it: Bills and FX Rates.

Concretely, item 1 needs three things from this spec, and this spec is written to guarantee all three:

1. **A default that's already scoped on first load** — so the common case doesn't hit the threshold at all. (§4, §7)
2. **A visible, adjustable control** on-screen — so item 1's block message ("narrow the date range") points at something that actually exists, not an abstract instruction. (§7)
3. **Adjusting it actually changes `total`** — the date bounds this spec introduces must be applied server-side, in the same query item 1 wraps with `COUNT`/threshold logic, not a client-side-only filter that item 1's backend check never sees. (§6)

**Sequencing: this spec and item 1 ship together, not one ahead of the other.** Item 1 alone is unsafe without this. This spec alone just adds a nicer default to two screens that already work — no urgency on its own. The two are one unit of work.

**FX Rates' growth model, corrected.** An earlier pass at this design assumed FX rate fetching was manual and forward-only, and on that assumption suggested the date default could reasonably be skipped for FX Rates — currency restriction alone (§7) would be enough for a good long while. That assumption no longer holds. `fx-scanner.js` is live: a server-side job on boot + every 6 hours (`FREEBOOKS_FX_SCAN_MS`) that, per qualifying company, backfills coverage for every period from company start to today, not just forward from now. A company with several years of history and automated FX tracking enabled will have its *entire* history backfilled within the first few scan cycles — not gradually accumulated over years. Restricting to one currency (§7) is no longer sufficient on its own to keep a fresh, unscoped view safely under threshold; a company with, say, 5+ years of history and one actively-tracked currency can cross 1,500 rows on its own well within realistic ranges once backfill completes. **The date default stays, and stays mandatory for FX Rates, not just Bills.** §10 below reflects this.

## 2. A structural finding that shapes this spec: it can't be built on the existing `≡` date filter

Checked before designing this, not assumed: FB.list's per-column date filter (`fb-list.js` `openColDropdown()`, `ft === 'date'` branch, ~L667–681) stores exactly one `{ op, value }` pair per field —

```js
} else if (ft === 'date') {
  ...
  colFilters[field] = { op: opSel.value, value: dInp.value };  // one bound: on / before / after
```

`colFilters` itself is a flat object keyed by field name — a second `date:` qualifier in the same expression overwrites the first, it doesn't combine with it. There's no way to express a two-sided start-*and*-end range through the existing column filter or topbar grammar. This isn't an oversight to work around; it means default-period seeding is a genuinely different kind of control, not a pre-filled version of the existing one. Building it as its own thing (§7) rather than stretching `colFilters` to do something it isn't shaped for.

## 3. Zero changes needed to `fb-list.js` itself

Checked, not assumed: `load()` already reads `cfg.list.body()` on every call (`fb-list.js` ~L1305: `post(cfg.list.action, cfg.list.body ? cfg.list.body() : {})`), and `.load()` is already called externally, outside FB.list's own closure — Voucher Register does exactly this (`vrList.load().then(function () {...})`). Both hooks this spec needs already exist. This is entirely page-level work: a small shared control that reads/writes two dates, wires them into `list.body()`, and calls `.load()` on change. No framework diff.

## 4. Backend: extend the existing default-period endpoint

`/api/:company/reports/default-period` already computes `start_date`/`end_date` in its query (`api/src/reports.js` ~L208–L245) but only returns `{ period_id }`. One-line change — return the dates already in hand:

```js
res.json({ period_id: latest[0].period_id, start_date: latest[0].start_date, end_date: latest[0].end_date });
```

Reused as-is by Reports Hub (unaffected — it already does its own period-list cross-reference and can ignore the new fields) and by Bills/FX Rates below, which don't need a periods list at all now — one call resolves directly to usable dates.

## 5. Backend: `bill.list` and `fx.rates.list` accept a date range

New `dateFrom`/`dateTo` body params, naming matched to the existing precedent in `journal.js`'s `listEntries` (`const { dateFrom, dateTo, ... } = body`) rather than inventing a different convention:

- `fx.rates.list` (`api/src/fx.js` ~L149–161) has no date-range param today at all — this is net new there.
- `bill.list` (`api/src/bills.js` ~L820ish) already has `limit`/`offset` (unused by the frontend, per earlier findings) — `dateFrom`/`dateTo` are additive to its existing param set.

## 5a. Backend: hard currency restriction on FX Rates

Decided: FX Rates requires exactly one currency selected at a time — not a default that can be widened to "all," a hard requirement. Narrows a second, independent dimension alongside the date range, which matters more now that §1's corrected growth model is in play.

**The existing `baseCurrency` param on `fx.rates.list` doesn't do this and can't be repurposed to.** Checked directly: `listRates()` (`fx.js` ~L149–165) filters `(from_currency = @base OR to_currency = @base)`, and every row already has the company's base currency on one side by construction (rates are always fetched base-anchored — `fx.js` ~L119, ~L157). So `baseCurrency` set to the company's own base currency matches essentially every row for that company; it was never narrowing to one *foreign* currency, just loosely scoping to "this company's activity" (and even that loosely, given §5b). A genuinely new param is required:

```js
// fx.js — listRates()
const foreignCurrency = body.foreignCurrency;
if (!foreignCurrency) {
  throw Object.assign(new Error('foreignCurrency required'), { code: 'INVALID_INPUT' });
}
sql += ` WHERE (from_currency = @fc OR to_currency = @fc) AND from_currency != to_currency`;
params.fc = foreignCurrency;
```

Rejecting a missing `foreignCurrency` server-side, not just gating it in the UI — the hard-restriction decision should hold even if a screen is ever driven by something other than the current `master-data.js` page (a future integration, a script, whatever calls the action directly).

## 5b. Adjacent finding, now more relevant than when first flagged

`fx_rates` has no `company_id` column at all (`db/schema.sql` ~L250) — isolation between companies rests entirely on `baseCurrency` (and now `foreignCurrency`) being sent correctly by every caller, not on anything the schema enforces. This was flagged as a latent, non-urgent risk before FX automation existed. With `fx-scanner.js` now writing real rate data unattended, per company, on a recurring schedule (§1), the table is genuinely shared and actively growing from multiple companies' automated activity rather than sparse manual entries — the isolation gap is exercised for real now, not hypothetically. Still not this spec's job to fix (no `company_id` migration proposed here), but worth escalating to whoever owns the schema, separately from this work.

## 6. Composition with item 1 — same handler, same query, both pieces present together

This is the part that has to be right for the two specs to actually work as one system, not two diffs that happen to touch the same file. **Both queries below use item 1's two-query pattern (cheap `COUNT`, conditional `SELECT`), not `COUNT(*) OVER()`** — the earlier version of this spec used the window-function form while item 1 separately claimed the combined query avoided materializing the full row set on the over-threshold path, which isn't true of that form (caught in review; see `fb-list-row-threshold-spec.md` §3 for the full reasoning). `threshold` arrives in the request body per that same fix, not as a backend-side constant.

`bill.list`:

```sql
-- Step 1
SELECT COUNT(*) AS _total FROM bills
WHERE company_id = @companyId AND date >= @dateFrom AND date <= @dateTo;
-- if _total > @threshold: return { data: [], total: _total, tooMany: true }, stop
-- Step 2 (only if under threshold)
SELECT * FROM bills
WHERE company_id = @companyId AND date >= @dateFrom AND date <= @dateTo
ORDER BY date DESC, created_at DESC;
```

`fx.rates.list` — **`baseCurrency` restored, not dropped as an earlier version of this sketch had it.** Caught in review: §5b flags that `fx_rates` has no `company_id` column and that `baseCurrency` was the only (loose) company-scoping mechanism available; a prior version of this SQL sketch omitted it entirely, leaving isolation resting solely on `foreignCurrency`. Keeping both costs nothing and narrows correctly — every genuine row already has the company's base currency on one side, so this isn't redundant in the sense of doing nothing, it's a second, independent condition that has to also be true.

One nuance worth being precise about rather than treating the isolation question as binary: for `source != 'manual'` rows (ECB, other providers), two companies sharing both a base and a tracked foreign currency correctly seeing the *same* published rate isn't a leak — it's objectively the same market fact, which is arguably why this table was never given a `company_id` in the first place. The real exposure is `source = 'manual'` rows — a hand-entered rate specific to one company (a negotiated bank rate, say) that could surface in another company's view under those same shared conditions. `baseCurrency` + `foreignCurrency` together don't close that gap for manual entries; nothing short of a schema change (§5b, explicitly not proposed here) fully does. Worth escalating as its own item, not something this spec resolves.

```sql
-- Step 1
SELECT COUNT(*) AS _total FROM fx_rates
WHERE (from_currency = @base OR to_currency = @base)   -- company scoping (loose; §5b)
  AND (from_currency = @fc OR to_currency = @fc)         -- §5a: mandatory, exactly one currency
  AND date >= @dateFrom AND date <= @dateTo;
-- if _total > @threshold: return { data: [], total: _total, tooMany: true }, stop
-- Step 2 (only if under threshold)
SELECT * FROM fx_rates
WHERE (from_currency = @base OR to_currency = @base)
  AND (from_currency = @fc OR to_currency = @fc)
  AND date >= @dateFrom AND date <= @dateTo
ORDER BY date DESC;
```

Handler logic, both actions: run step 1; if `_total > threshold`, return the `tooMany` shape immediately without running step 2 at all — this is what "without materializing the full row set" actually means once the pattern is fixed. For Bills, `dateFrom`/`dateTo` are the only lever that changes `_total`. For FX Rates, both `foreignCurrency` and `dateFrom`/`dateTo` do — but `foreignCurrency` is fixed at "exactly one" by §5a, so in practice date is still the only *adjustable* lever once a currency's chosen, which is what item 1's block message reflects.

**Indexes required for step 1 to actually be cheap** — `bills(company_id, date)`, and `fx_rates(from_currency, date)` / `fx_rates(to_currency, date)` to cover the OR condition. Full requirement and reasoning lives in `fb-list-row-threshold-spec.md` §7, shared between both specs rather than stated twice.

## 7. Frontend: the date-range control, and FX Rates' currency gate

One small shared piece (page-level JS, not inside `fb-list.js`), used identically by Bills and FX Rates for the date range. FX Rates additionally gates on currency selection first. Both screens' `list.body()` sends `threshold` (read from the shared constant in `fb-list.js`, per `fb-list-row-threshold-spec.md` §3/§4) alongside `dateFrom`/`dateTo` (and `foreignCurrency` for FX Rates) on every load — this is the wiring that fix makes concrete, not a separate piece of work.

**Resolution order on load, Bills:**

1. **Return-context URL param, if present** — `?dateFrom=&dateTo=`, the same names as the `bill.list`/`fx.rates.list` body params this ultimately feeds (§5), not a separate name to keep in sync. Wins unconditionally. Nothing produces this today for Bills' own list — that's item 4, a separate spec (`fb-list-bills-return-context-spec.md`) — but the AP-Aging → bill-detail.js round trip already built (`ap-aging-drilldown-spec.md`) established exactly this precedence pattern for its own path. Checking for it here now costs nothing and means item 4 only has to make `bill-detail.js` *send* the param — this page's load logic doesn't change.
2. **Else, fetch `/api/:company/reports/default-period`.**
3. **If that call returns usable dates, seed the control with them and load, as before.**
4. **If it doesn't — no dates back (fresh company, no periods configured yet) or the call errors — do not call `bill.list` at all.** Caught in review: the spec previously only described the happy path. Falling through to an unscoped `bill.list` call on a degenerate response would be exactly the silent-unscoped-load item 1 exists to prevent, just reached by a different door. Render a setup/empty state instead — same structural pattern as item 1's `renderTooMany` (one spanning message row), different trigger and message: *"No accounting periods configured yet."* The add row still renders, same reasoning as the blocked state in item 1 §4 — creating the first record shouldn't require periods to already exist.

**Resolution order on load, FX Rates — currency gates everything else:**

1. **No default currency.** On load, before anything else: if no `foreignCurrency` is already selected (via return-context, or a prior selection this session), render a required picker — "Select a currency to view its rates" — and stop. Don't call `fx.rates.list` at all yet; there's nothing valid to ask for. Options come from whatever currencies the company actually tracks (`fx_tracking`/provider config on the Company attribute grid, per `fx-automation-spec.md` — not a hardcoded list).
2. **If the company has no currencies configured for tracking at all, the picker has nothing to offer — specify this explicitly rather than leaving a bare empty dropdown.** Caught in review. Message: *"No currencies configured for tracking. Add one on the Company attribute grid."* — names the actual place to fix it, consistent with how item 1's `tooManyMessage` names its own control rather than speaking generically.
3. **Once a currency is chosen**, resolve the date range exactly as Bills does above (return-context → default-period → fallback-to-setup-state if that fails), then load.

**Rendering:** two date inputs in the page's toolbar/header — same visual pattern as Reports Hub's own `#rpt-start`/`#rpt-end`, deliberately, rather than a new control shape. Labeled plainly enough that item 1's block message can point at it by name ("narrow the date range above"). FX Rates additionally shows the currency picker as a persistent, always-visible toolbar control (not a one-time gate that disappears) — switching currencies is a normal action, not a rare setup step, given the hard restriction means it's the only way to look at a different currency at all.

**On change:** update the values `list.body()` reads, call `.load()`. That's the entire wiring — no new FB.list capability, per §3.

## 8. Relationship to the existing per-column `date` filter

The two coexist, and that's fine — they operate at different layers. This spec's range control sets what's fetched from the server at all (and is what `total`/the threshold in item 1 responds to). The existing `≡` date column filter (§2) still works exactly as it does today, client-side, further narrowing *within* whatever's already loaded. "This quarter" (this spec) then "only entries after the 15th" (existing `≡` filter) is a reasonable combination, not a conflict — they just need to stay visually distinct (toolbar control vs. column header dropdown) so it's clear they're not the same mechanism.

## 9. Non-goals

- **Bills-list ↔ `bill-detail.js` return-context.** Still not built — `bill-detail.js`'s `Escape` still hardcodes `/payables` regardless of origin. This spec leaves the seam open (§7, resolution order) but doesn't build the producing side. See `fb-list-bills-return-context-spec.md`.
- **Anything from the general filter engine** (`fb-list-server-filter-spec.md`) — explicitly not needed. Simplified item 1 doesn't require it, and neither does this.
- **`fx_rates` gaining a `company_id` column.** Flagged in §5b as worth escalating, not proposed here.

## 10. FX Rates' window width — resolved

Previously open. Now decided, in two parts:

- **With currency fixed to exactly one (§5a, §7), the density concern that made this an open question goes away.** The original worry was that a single calendar period could hold far more rows on FX Rates than the equivalent window on Bills, because multiple currencies were being loaded together. Restrict to one currency and that's no longer true — density per calendar period is now comparable to Bills. FX Rates can use the **same default window as Bills**: the current ledger period, via the same `/api/:company/reports/default-period` call. No special-cased narrower window needed.
- **This does not mean the default can be skipped, per §1's correction.** Aggressive scanner backfill means an established company's full single-currency history can exceed threshold on its own. The default still has to be seeded, same as Bills — just no longer needs to be tighter than Bills' default to be safe.

## 11. Testing contract

Mirrors `fb-list-ux-spec.md` §12, with the item 1 integration point as the centerpiece — this is the thing that has to actually work for the two specs to function as one system:

1. Fresh load of Bills: confirm the range control is pre-filled (not empty), and confirm the resulting `total` is under threshold in a normal dataset.
2. Fresh load of FX Rates: confirm nothing loads and the currency picker is the only interactive element until a currency is chosen; confirm no `fx.rates.list` call fires before that point.
3. Select a currency on FX Rates: confirm the date range then resolves via the same default-period mechanism as Bills, and `total` lands under threshold in a normal dataset.
4. Adjust the range control wider (either screen) until `total` crosses the threshold: confirm item 1's block state fires, and confirm the block message names the date control specifically (not currency — it's already fixed at minimum by §5a, nothing further to narrow there).
5. From the blocked state, narrow the range back down: confirm reload, confirm `total` drops, confirm rows render once under threshold again.
6. On FX Rates, switch the selected currency without touching the date range: confirm `total` recomputes for the new currency and the block state clears or fires independently of whatever it was for the previous currency.
7. Confirm the existing `≡` date column filter still works independently and doesn't fight with the new range control over the same field/state.
8. Manually construct a URL with a return-context param (simulating item 4 before it exists) and confirm it's honored over the computed default — validates the seam in §7 is real, not just documented.
9. Send `fx.rates.list` with no `foreignCurrency` param directly (bypassing the UI): confirm the backend rejects it (§5a) rather than silently returning an unscoped result — the hard restriction has to hold server-side, not just as a UI convention.
10. Simulate a fresh company with no periods defined at all: confirm `bill.list`/`fx.rates.list` are never called, confirm the setup-state message renders instead, confirm the add row (Bills) still works from that state.
11. Simulate the `/api/:company/reports/default-period` call erroring (network failure or 500): confirm the same setup-state fallback fires as the no-periods case — both degenerate paths should behave identically, not just the one that was easy to picture.
12. On FX Rates, simulate a company with `fx_tracking` configured but zero currencies actually set up: confirm the picker shows the "no currencies configured" message from §7 rather than a bare empty dropdown.
13. Confirm `bill.list`/`fx.rates.list` requests actually include `threshold` in the body (inspect the network call, not just the rendered result) — validates the §6/§7 wiring is real, not just that item 1's backend happens to have a matching default.
