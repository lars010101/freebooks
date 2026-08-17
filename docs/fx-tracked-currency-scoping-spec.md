# FX Tracked-Currency Scoping Spec

Status: **DRAFT — proposal, not yet ratified.** Companion: `fx-automation-spec.md` (the automation this scopes), `fb-list-default-period-spec.md` §7 (the FX Rates currency picker this spec's frontend half replaces — `loadTrackedForeignCurrencies`), `fb-list-row-threshold-spec.md` (the threshold this spec makes far less likely to fire in the first place).

---

## 1. Purpose

The automatic FX scanner currently downloads and stores exchange rate data for every currency a provider publishes, regardless of whether the company has any actual use for it. This spec scopes that down to currencies with genuine, live accounting need — defined precisely, not approximately — and in doing so fixes a data-volume problem significantly larger than anything the threshold/default-period work (`fb-list-row-threshold-spec.md`, `fb-list-default-period-spec.md`) was designed around.

## 2. Current state, verified against the live code

- **The scanner is unscoped.** `ecb.js`'s `fetchRange()` calls `frankfurter.app/${start}..${end}?from=${baseCurrency}` with no target-currency restriction. Frankfurter/ECB publishes a basket of roughly 30 currencies, and the provider stores **both directions for every one of them**:

  ```js
  for (const [currency, rate] of Object.entries(rates)) {
    rows.push({ from_currency: baseCurrency, to_currency: currency, ... });
    rows.push({ from_currency: currency, to_currency: baseCurrency, rate: 1/rate, ... });
  }
  ```

  ~60 rows per publication day, per company, regardless of actual need. Every earlier row-growth estimate in the companion specs assumed roughly one row/day per *needed* currency pair — the real number is ~60 rows/day for a basket nobody asked for. At that rate the 1,500-row threshold isn't a multi-year concern, it's roughly **25 days**.

- **The frontend picker's source is already correctly scoped by type, just not by actual need.** `loadTrackedForeignCurrencies` (`master-data.js` L616–636) calls `partner.list` with no `partner_type` filter — `listPartners()`'s default branch (`partners.js` L62–70, no `is_vendor`/`is_customer` clause) already returns both customers and vendors, so the earlier "vendor-specific" concern was a description problem on my part, not a code problem. No fix needed there.

- **`revaluationPreview` already computes almost exactly the query this spec needs**, independently, for a different purpose (`fx.js` L312–325):

  ```sql
  SELECT je.account_code, a.account_name, je.currency,
         SUM(je.debit - je.credit) AS foreign_balance,
         SUM(je.debit_home - je.credit_home) AS home_balance
  FROM journal_entries je
  JOIN accounts a ON je.company_id = a.company_id AND je.account_code = a.account_code
  WHERE je.company_id = @companyId AND je.date <= @revalDate
    AND je.currency != @homeCurrency AND a.account_type IN (${monetaryTypes})
  GROUP BY je.account_code, a.account_name, je.currency
  HAVING SUM(je.debit - je.credit) != 0
  ```

  `monetaryTypes` is jurisdiction-pack-driven (`fxRevaluationConfigFor(jurisdiction)`), defaulting to `['Asset', 'Liability']` — **Equity excluded**, per IAS 21 (monetary items only). This is the ground-truth signal this spec adopts, not a new invention.

## 3. Decision: currency need = non-zero balance-sheet exposure, not partner defaults, not recency

The design arrived here in steps, each superseded by the next rather than layered on top of it — worth recording why, so the earlier options aren't silently re-proposed later without the reasoning that ruled them out:

- **`partner.default_currency` as the tracking signal — rejected.** It's speculative (a partner *might* generate a foreign-currency transaction, or might not) and doesn't even solve the problem it looks like it solves: the first transaction in any new currency always needs its own point-of-entry rate resolution regardless of what's "tracked" (§5), so pre-tracking ahead of any real transaction buys nothing while directly working against the volume goal this spec exists for. The field itself is unaffected — it still pre-fills the currency box when creating a bill for that partner (`payables-bills.js` L614/635); dropping it as a tracking *signal* doesn't touch that.
- **Recency window (`date >= cutoff`) plus a bill-status check (`'posted', 'partial'`) — an improvement, also superseded.** A pure recency cutoff would drop a currency from tracking based on posting date alone, even if a bill in it is still open and unpaid — wrong, since an old-but-open foreign-currency balance has a live, ongoing need for current rates (§4). Adding a status check patched that for bills specifically, but missed foreign-currency exposure created by a standalone JV with no `bill_id` at all — no comparable "status" field exists there to check.
- **Non-zero balance-sheet exposure — adopted.** One condition, not two ad hoc ones stitched together: sum the original-currency `debit - credit` for every `Asset`/`Liability` (jurisdiction-configurable) account, per currency; non-zero means live need, zero means fully settled regardless of how old the underlying postings are. This is exactly what `revaluationPreview` already computes for its own purpose (§2) — the design isn't new, it's recognizing that revaluation already answers the question this spec is asking and reusing that answer rather than approximating it a second way.

## 4. Backend: `getExposedCurrencies(companyId)` — one shared function, two callers

Extract the query from `revaluationPreview` (§2) into a standalone function, called by revaluation as it already does today, and newly called by the scanner (§5) and the currency-picker action (§6). One definition of "which currencies does this company have real exposure to," not two queries that'll drift the first time one of them changes.

**Netting must happen per-account, not per-currency — caught in review, and it's a real correctness bug, not a style issue.** An earlier version of this function grouped by `currency` alone and checked `HAVING SUM(je.debit - je.credit) != 0` at that level. Consider a EUR receivable at +1,000 and a EUR payable at −1,000: netted together, that's zero — the function would exclude EUR entirely, silently stopping the scanner from tracking it and dropping it from the picker. But `revaluationPreview` (§2) groups by `(account_code, currency)`, not currency alone — it would correctly show *both* accounts, each independently exposed, each needing its own closing rate, each capable of producing its own gain or loss. IAS 21.28 doesn't permit netting a receivable against a payable in the same currency for this purpose — they're independent monetary items. The earlier version of this function was answering a different, wrong question from the one `revaluationPreview` answers, despite the spec claiming they were the same — fixed by matching the grouping level exactly, not just claiming to:

```js
// fx.js (or a new fx-exposure.js, colocated with fx-coverage.js)
async function getExposedCurrencies(companyId, homeCurrency, jurisdiction, asOfDate) {
  const monetaryTypes = (fxRevaluationConfigFor(jurisdiction) || {}).monetaryTypes || ['Asset', 'Liability'];
  const typeParams = {};
  const inClause = monetaryTypes.map((t, i) => { typeParams[`mt${i}`] = t; return `@mt${i}`; }).join(', ');
  const rows = await query(
    `SELECT DISTINCT currency FROM (
       SELECT je.currency, je.account_code
       FROM journal_entries je
       JOIN accounts a ON je.company_id = a.company_id AND je.account_code = a.account_code
       WHERE je.company_id = @companyId AND je.date <= @asOfDate
         AND je.currency != @homeCurrency AND a.account_type IN (${inClause})
       GROUP BY je.currency, je.account_code
       HAVING SUM(je.debit - je.credit) != 0
     ) exposed`,
    { companyId, homeCurrency, asOfDate, ...typeParams }
  );
  return rows.map(r => r.currency);
}
```

Netting now happens exactly where `revaluationPreview` does it — per `(currency, account_code)` in the inner query — before the outer `SELECT DISTINCT` ever collapses to a bare currency list. This makes the earlier "the design isn't new, it's recognizing that revaluation already answers this question" claim actually true, rather than true in intent but not in the SQL.

`revaluationPreview` (`fx.js` L290–343) is refactored to call this for its currency set, then continue its own per-account balance/rate/gain-loss logic as today — no behavior change there, just the currency-list portion sourced from one place instead of inlined.

## 5. Backend: scanner scoping

`fx-scanner.js`'s `scanCompany()` (L70–115, per `fb-list-default-period-spec.md` §1's earlier citation of this file) currently fetches and stores the full basket per period. Add a filter step: call `getExposedCurrencies(companyId, baseCurrency, jurisdiction, today)` once per scan, then filter `coverage.rows` down to rows where `from_currency` or `to_currency` is in that set, before the `INSERT`/`DELETE`-and-replace step (~L109–115). Coverage/publication-day computation stays basket-wide (publication happens for the whole set together, doesn't vary per currency, and `computeCoverage`'s "missing days" logic needs the full picture to work correctly) — only the **persisted rows** narrow, right before they're written to `fx_rates`.

**Timing note, addressed explicitly rather than left implicit:** this introduces a delay between "a currency becomes exposed" and "the scanner starts tracking it" (up to one scan cycle, 6 hours). Confirmed this is safe, not a race condition to guard against:

- Point-of-entry rate resolution (posting a bill/JV) is independent of tracking status, as established in §3 — the first transaction in a new currency always resolves its own rate need regardless.
- `revaluationPreview` already degrades gracefully on a missing rate — it doesn't fail the run, it reports one line (`error: 'No closing rate for X→Y on date'`) and continues with everything else (`fx.js` L330–333). A newly-exposed currency the scanner hasn't caught up to yet shows up as a visible, actionable gap in a preview, not a silent wrong number or a blocked close.
- Revaluation is a periodic business process (month/quarter/year-end), not something triggered instantaneously by a posting — the realistic gap between "exposure first appears" and "someone actually runs revaluation" is days to weeks, comfortably inside a 6-hour catch-up window.

**Stopping matters the same way starting does — and it's asymmetric.** When a currency drops out of `getExposedCurrencies`' result (§8.3 — the exposure nets to zero), the scanner stops *fetching new rows* for it going forward. It does **not** delete anything already stored in `fx_rates` for that currency. Historical rates may still be needed for a later re-run of a past revaluation, an audit, or simply reviewing old activity — none of that requires the currency to still be actively tracked. Stating this explicitly so a future cleanup pass doesn't read "stops tracking" as license to also purge history that was never the problem.

## 6. Frontend: `loadTrackedForeignCurrencies` rewritten

New backend action, `fx.exposed_currencies` (no existing action does this — checked `action-catalog.js`), thin wrapper around `getExposedCurrencies`:

```js
'fx.exposed_currencies': { role: 'viewer', mutating: false,
  description: 'List currencies with non-zero balance-sheet exposure, for the FX Rates currency picker and scanner scoping.' }
```

`master-data.js`'s `loadTrackedForeignCurrencies` (currently querying `partner.list` and scanning `default_currency`, L616–636) is rewritten to call this action instead. `populateFxCurrencyPicker` (L640–656) and everything downstream of it is unaffected — same shape in (`currencies: [...]`), same empty-state/setup-state handling, just a different, more accurate source.

**Empty-state message needs updating to match.** The current text — *"No currencies configured for tracking. Add one on the Company attribute grid."* — was already wrong (§2 of `fb-list-default-period-spec.md`'s review caught the wrong grid reference) and is now describing the wrong mechanism entirely, since there's no "configuring" step at all — exposure is derived, not configured. New text: *"No foreign-currency balances yet. This list populates once a bill or journal entry creates one."*

## 7. Non-goals

- **Point-of-entry rate resolution for posting a bill/JV in an untracked currency.** Assumed to already exist as its own mechanism (existing `fx_rates` lookup or manual entry at save time) — out of scope here, unaffected by this spec either way.
- **A recency window as a standalone mechanism.** Considered (§3) and superseded by the balance-based check, not layered alongside it — don't reintroduce a separate date cutoff on top of this.
- **Changing what `revaluationPreview`/`revaluationPost` compute.** Only their currency-list *source* changes (§4), routed through the shared function instead of inlined — the balance/rate/gain-loss logic downstream of that is untouched.
- **Requesting only needed currencies from the provider's API directly** (a Frankfurter `to=` param limiting the response itself, not just what gets persisted). Checked, not left as an open question: Frankfurter does support this — `GET /latest?to=USD,GBP` is documented behavior (confirmed via the project's own Docker Hub image docs and independent tutorial sources). What's *not* directly confirmed is whether `to=` composes with the `..` date-range endpoint `fetchRange()` actually uses (`/2010-01-01..2010-01-31`) — every source found showed `to=` paired with the single-date/`latest` endpoints, not the range one specifically. Very likely it works the same way given consistent parameter design across the API, but worth a live check rather than an assumption when this is implemented. Still out of scope for this spec either way — it would save the request itself, not just the storage, which is a real further improvement, but the post-fetch filter in §5 is sufficient on its own for the volume problem this spec exists to fix.

## 8. Testing contract

1. A company with zero foreign-currency journal activity: confirm `fx.exposed_currencies` returns empty, confirm the FX Rates picker shows the new empty-state message, confirm the scanner fetches and stores nothing for that company on its next cycle.
2. **The netting case — this is the exact bug §4 was fixed for, so it needs an explicit guard, not just correct-by-inspection SQL.** Two accounts in the same currency with opposing equal balances (e.g. a EUR receivable at +1,000 and a EUR payable at −1,000, netting to zero across the currency but not at either account): confirm the currency still appears in `getExposedCurrencies`' result. This is the one test that would have caught the reviewed bug before it shipped.
3. Post a bill in a new foreign currency, wait for (or manually trigger) the next scan cycle: confirm that currency now appears in `fx.exposed_currencies`' result and the scanner begins storing rows for it — and confirm the *other* ~29 currencies in the provider's basket are still not stored.
4. Pay off that bill in full (balance nets to zero): confirm the currency drops out of `fx.exposed_currencies` on the next check, confirm the scanner stops fetching it going forward, and confirm the rows already stored for it in `fx_rates` are **not** deleted (§5).
5. Create a foreign-currency exposure via a standalone JV with no `bill_id`: confirm it's picked up identically to a bill-driven one — this is the case the earlier bills-only proxy would have missed.
6. Run `fx.revaluation_preview` for a date where one exposed currency has no stored rate (simulate by deleting its `fx_rates` rows for that date): confirm the run completes with an error line for that currency and correct results for every other currency — not a failed/blocked run.
7. Confirm `revaluationPreview`'s own output is unchanged before/after the `getExposedCurrencies` refactor (§4) — same currency set, same balances, same gain/loss numbers, given the underlying query is identical, just relocated.
8. Confirm an index actually covers this query's real shape, not just its table and one column. The query filters `company_id` (equality) and `date` (range) and joins on `account_code`; a composite `(company_id, currency, date)` is closer to what's needed than a bare `(company_id, currency)` — but confirm with `EXPLAIN` against real data rather than assume the ordering is optimal, since DuckDB's columnar engine doesn't necessarily behave like a traditional B-tree index would suggest.
