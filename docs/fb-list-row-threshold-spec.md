# FB.list Row-Count Threshold Spec

Status: **DRAFT — proposal, not yet ratified.** Chosen over the full general-filter-engine alternative (`fb-list-server-filter-spec.md`, considered and set aside — bigger diff than this problem needs). Companion: `fb-list-ux-spec.md` (the machine this extends), and `fb-list-default-period-spec.md` (item 2 — **this spec depends on it**, not the reverse; see §1). **Must ship together with, not ahead of, the default-period spec** — see that spec's §1 for the integration contract.

---

## 1. Purpose, and why this only exists alongside default-period seeding

FB.list currently has no upper bound on what it renders. Every `.list` action picks its own arbitrary `LIMIT` (`fx.rates.list`: hardcoded 500; `bill.list`: default 200) and silently truncates — no indication to the user that older rows exist. This spec replaces silent truncation with an explicit, visible ceiling: past a threshold, tell the user how many rows there are instead of guessing which ones to show them.

**This is safe to ship only because the default-period spec (item 2) exists.** A blocked list needs a way out — some server-connected control the user can adjust to actually shrink `total` and re-check it. Item 2 gives Bills and FX Rates exactly that: a date range, already wired to the backend, already visible on-screen as the default filter. Without it, hitting the threshold on a screen with no server-connected narrowing control is a dead end — blocked, with no path to see anything, which is worse than today's silent truncation, not better. **Do not enable this on a screen that doesn't already have a server-connected way to reduce its result set.** Today that's Bills and FX Rates, via item 2's date-range params, and no other screen.

## 2. Scope cut from the original proposal

The original design (see prior conversation) called for a general server-side filter engine — a shared parser translating the full box-expr grammar (`field:value`, `amount:>`, plain-text fuzzy) into SQL, usable by any `.list` action, plus a fix for `list`-type column-filter dropdowns to source distinct values server-side instead of from loaded rows. **Both are cut from this spec.**

Reasoning: once item 2 exists, the only screens actually at risk of tripping a row-count threshold are Bills and FX Rates, and both already get a server-connected narrowing control from item 2 alone — a full generic filter grammar isn't needed to give them an escape hatch. Building the general parser now would be solving a problem the affected screens no longer have. If a future screen needs threshold protection *and* doesn't have a natural default-scope like a date range, the general filter engine becomes necessary again at that point — not before.

## 3. Backend contract

Extend `bill.list` and `fx.rates.list` only — not every `.list` action. Response shape:

```
{ data: [...], total: N }                      // total <= threshold: rows included as today
{ data: [], total: N, tooMany: true }           // total > threshold: rows omitted, nothing to render
```

**Threshold travels in the request — the backend has no copy of its own to drift.** Caught in review: the spec previously had the frontend constant (§4) and the backend's `total > threshold` check (§6 of the default-period spec) with no stated connection between them — two independently-defined numbers that could silently diverge. Fixed: `threshold` is a required field in the request body, sourced from the one shared constant in `fb-list.js` (§4) every time `list.body()` builds the payload. The backend has no hardcoded fallback value — a request missing `threshold` is rejected (`INVALID_INPUT`), same treatment as `fx.rates.list` already gives a missing `foreignCurrency` (`fb-list-default-period-spec.md` §5a). No silent default to keep in sync means nothing to drift.

**`total` is computed by a cheap `COUNT(*)` query, run before any row data is fetched — not `COUNT(*) OVER()`.** Caught in review, and it's a real correctness issue, not a style preference: `COUNT(*) OVER()` is a window function attached to every row of the result set — computing it requires the full matching row set to be pulled into the application layer (this codebase's `query()` helper returns a fully materialized array, not a cursor) before the handler can even check the count. For the over-threshold case specifically — the one case this whole mechanism exists to protect — that means fetching everything anyway just to throw it away, which defeats the purpose. Two-query pattern, prescribed, not offered as an alternative:

```sql
-- Step 1: cheap, count-only
SELECT COUNT(*) AS _total FROM bills WHERE company_id = @companyId AND date >= @dateFrom AND date <= @dateTo;
-- if _total > @threshold: return { data: [], total: _total, tooMany: true } — stop here, no second query
-- else, step 2:
SELECT * FROM bills WHERE company_id = @companyId AND date >= @dateFrom AND date <= @dateTo ORDER BY date DESC, created_at DESC;
```

Accepts the second round trip as the cost of actually avoiding materialization on the path where it matters. See §7 (indexes) for what makes step 1 cheap in practice, not just in theory.

**Retire the existing hardcoded `LIMIT`s as part of this change, not after it.** Both need to go at the same time `total` is introduced, not left in place alongside it:

- `fx.rates.list`'s hardcoded `LIMIT 500` — if left in place, a filtered result of, say, 800 rows (under the 1,500 threshold, so no block fires) would silently return only 500 of them, with `total` correctly reporting 800. That's a worse bug than today's — a visible, trusted count that doesn't match what actually loaded.
- `bill.list`'s default `limit=200` (and the existing unused `offset` param) — same reasoning. Drop the default limit; the date-range default from item 2 plus this threshold are the real bounds now, an additional hardcoded cap on top just reintroduces the original problem underneath the new one.

When `total <= threshold`: return every matching row, no `LIMIT`. The date-range default already keeps this small in the common case; that's the whole point of depending on item 2 rather than rebuilding pagination.

## 4. Frontend contract (FB.list)

One new number, one new render branch, one new config hook — hooked into the existing `load()` (`api/public/fb-list.js` ~L1296–1335), not a parallel loading path:

- **Threshold** — one shared constant in fb-list.js (not per-screen config), default **1,500**, matching the render-cost analysis this was based on (comfortable up to ~2,000 DOM rows for the current full-`innerHTML`-rebuild render pattern; 1,500 leaves margin). **This is the only definition of the number that exists anywhere** — Bills' and FX Rates' `list.body()` (`fb-list-default-period-spec.md` §7) read it from here and include it in every request; the backend never has its own copy (§3).
- **Hook point** — inside `load()`'s `.then()`, before the existing `saved = (...).map(cfg.list.map)` line:

```js
return p.then(function (rowsRaw) {
  if (rowsRaw && rowsRaw.tooMany) {
    saved = [];
    renderTooMany(rowsRaw.total);
    syncChrome();
    return;
  }
  var rowsData = rowsRaw.data || rowsRaw;
  saved = (Array.isArray(rowsData) ? rowsData : []).map(cfg.list.map);
  render(focusKey);
  ...
});
```

Screens whose backend action doesn't return `total`/`tooMany` at all keep behaving exactly as today — this is opt-in by backend response shape, not a framework-wide behavior change. No regression risk for the other ~14 registers that aren't touched by this spec.

- **`renderTooMany(total)`** — replaces the data-row portion of the tbody with a single spanning message row, structurally the same pattern as the existing add-row (`fb-add-row`: one `<tr><td colspan>`, not a new UI primitive):

```js
'<tr class="fb-toomany-row"><td colspan="' + (cfg.columns.length + 1) + '">'
  + esc(cfg.list.tooManyMessage ? cfg.list.tooManyMessage(total) : (total + ' rows — too many to display. Apply a filter to narrow this down.'))
  + '</td></tr>'
```

- **`list.tooManyMessage(total)`** — new optional config hook, a function returning the message string. Bills and FX Rates should each supply one that names their actual, *currently adjustable* control — not a generic "apply a filter" instruction (there is no generic filter connected to the backend in this scope — see §2), and for FX Rates specifically, not currency, since item 2's §5a already fixes it at the minimum (exactly one) — the date range is the only lever left to name:

```js
// Bills
tooManyMessage: function (total) {
  return total.toLocaleString() + ' bills — narrow the date range above to see this list.';
}

// FX Rates — currency is already as narrow as it gets; date is the only remaining lever
tooManyMessage: function (total) {
  return total.toLocaleString() + ' rates for this currency — narrow the date range above to see this list.';
}
```

- **The add row still renders in the blocked state.** Creating a new Bill or FX Rate shouldn't require first being able to see the existing ones. `canAdd`/the add-row's own click/nav wiring is untouched by this — `renderTooMany` replaces only the data-row portion of the tbody, same way an empty (zero-row, non-blocked) list today still shows the add row alongside nothing else.
- **Leave-guard and dirty tracking are unaffected.** `saved = []` in the blocked state means nothing existing can be dirty; a new row being drafted via the add row behaves exactly as it does on any other screen, blocked or not.

## 5. What this does not do

- Does not add `total` to any action besides `bill.list` and `fx.rates.list`. Every structurally-bounded register (COA, vendors, VAT codes, journal types, cost centers, periods, admin companies, inbox, settings attribute grids) is untouched — they were already assessed as low/negligible risk and don't need this.
- Does not build the general box-expr→SQL parser or fix the `list`-type column-filter dropdown's distinct-value source. Both remain open only if a future screen needs threshold protection without a natural date-range-style escape hatch — see §2.
- Does not solve pagination, load-more, or infinite scroll — considered and rejected earlier in design (see prior conversation), documented here so the decision isn't silently re-litigated without its reasoning attached. The trade-off, stated plainly rather than dismissed: this design genuinely gives up unbounded ad-hoc browsing — there's no way to page through, say, 3,000 bills in position order without narrowing by date first. That's real. But narrowing by a meaningful business dimension (date, currency) is a faster path to a *specific* record than paging through position-ordered pages ever is, and that's the dominant real task for this kind of register — "find the Acme invoice from March," not "skim everything in order." Where paginated skimming would still have a genuine edge — reviewing a large set with no specific target — a CSV export or dedicated report is arguably a better tool for that job than sixty clicks of "next page" regardless of which design this spec picks. **Whether that export path actually exists for Bills/FX Rates today is unconfirmed — worth checking before treating the pagination trade-off as fully closed.** If it doesn't exist, that's a real gap this spec doesn't fill, independent of the threshold/pagination question itself.
- Does not touch Journal — it isn't a standalone FB.list page (dissolved into Reports Hub as Voucher Register); any row-volume concern there is Reports Hub's problem, not this spec's.

## 7. Indexes — required, not optional polish

Checked, not assumed: `db/schema.sql` currently has exactly one index on `bills` (`idx_bills_partner_id`) and none at all on `fx_rates`. Without indexes covering the WHERE clauses this spec and `fb-list-default-period-spec.md` introduce, both the cheap `COUNT(*)` in §3 and the conditional full `SELECT` degrade to full table scans — DuckDB is fast at scanning, but a company with several years of scanner-backfilled FX history (`fb-list-default-period-spec.md` §1) is exactly the case this spec exists for, and it's also the case where a scan is most likely to be noticeable. Required:

```sql
CREATE INDEX IF NOT EXISTS idx_bills_company_date ON bills(company_id, date);

-- fx_rates' WHERE is an OR across from_currency/to_currency plus a date range —
-- a single composite index doesn't cleanly cover an OR the way it covers an AND.
-- Two indexes, letting the planner satisfy either side:
CREATE INDEX IF NOT EXISTS idx_fx_rates_from_date ON fx_rates(from_currency, date);
CREATE INDEX IF NOT EXISTS idx_fx_rates_to_date   ON fx_rates(to_currency, date);
```

Part of this spec's backend contract, not a testing-contract afterthought — ship with the query changes in §3, not discovered as a performance issue after the fact.

## 8. Testing contract

Mirrors `fb-list-ux-spec.md` §12 — live verification of the cycle, not pixel tests.

1. On FX Rates (or Bills), with a filtered/default-scoped result under 1,500 rows: confirm normal rendering, and confirm the row count returned matches the row count actually in the DOM — this is the specific regression the stale-`LIMIT` risk in §3 would produce if missed.
2. Force a result over 1,500 (widen or clear the date default): confirm the block message renders instead of the table, confirm the message names the date control specifically (not a generic "apply a filter" string with nothing behind it), confirm the add row still works.
3. From the blocked state, narrow the date range back down: confirm the list reloads, `total` drops, and rows render normally once under threshold — this is the actual escape-hatch path and the one thing this whole design depends on working.
4. Confirm a screen with no `total` in its backend response (e.g. COA) is pixel-for-pixel unaffected — no accidental framework-wide behavior change.
5. Send a request with `threshold` omitted directly (bypassing the UI): confirm the backend rejects it rather than falling back to a hardcoded value — validates §3's single-source-of-truth fix actually holds server-side, not just as a documented intent.
6. Send the same over-threshold request twice, once with `threshold: 1500` and once with `threshold: 50`: confirm the block point actually moves with the request, not a server-side constant — this is the concrete behavioral proof that the value travels with the request rather than living twice.
7. `EXPLAIN` the count query (either action) against a company with a few thousand rows: confirm the planner uses the §7 indexes rather than a full scan. Cheap to check once, expensive to discover missing in production on the company that finally has enough history for it to matter.
