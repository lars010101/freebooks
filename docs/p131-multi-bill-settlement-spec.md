## P1-9b — Multi-bill settlement (one payment → N bills) (SHIPPED 2026-08-12 — commit `c8e56e0`, PR #202 — closes issue #131)

*(Deferred from P1-9 on 2026-07-22 as "needs an allocation UI; defer to its own phase." Built and merged 2026-08-12. This section back-fills the spec that was never written before the code landed.)*

**2026-09-02: item 4's UI (the `Shift+P` inline multi-select panel) is
superseded** — `bill-post-payment-consolidation-spec.md` retires `p`/`P` on
Bills entirely and moves multi-bill payment entry into the New Payment page
(`/payment/new`), reached unscoped from the top-bar `+` New menu (the only
multi-bill entry point now). Items 1–3 and 5–6 (the action shape, settlement
core, validation, void-as-one-unit, and idempotency) are backend and
unchanged by that move.

### Purpose

The single-bill payment path shipped in P1-9 covers the common case, but not the monthly-statement case: a vendor sends one statement covering several bills, paid with a single lump-sum bank transfer. Recording that as N separate `bill.payment.record` calls loses the fact that they were one payment, and forces the operator to manually split an amount they were only ever given as a total.

### Prior state

- `bill.payment.record` (P1-9) took exactly one `billId` + `amount`.
- `settleBillPayment` (settlement.js) posted a single 2-line (or 3-line FX) journal per call.
- No UI path existed for selecting multiple bills against one payment; `bill.match` (candidate lookup) was dormant and unrelated to this gap.

### Shipped scope

1. **Same action, dispatched on shape.** `bill.payment.record` branches in `handleBills`: a body carrying `allocations` (array of `{billId, amount}`) routes to `recordMultiBillPayment` instead of the single-bill path. No new action name — the action catalog documents both shapes under one entry.
2. **`settleMultiBillPayment` (settlement.js).** One batch, N allocations:
   - Per-bill AP debit line via the shared `buildAllocationLines` helper — same booking-rate FX logic as the single-bill path, each bill keeps its own booking rate.
   - Per-bill FX gain/loss line where the diff is material.
   - **One** `CR Bank` line for the summed total.
   - N `bill_payments` rows sharing one `batch_id`.
   - Runs inside `withTransaction` (new dedicated-connection wrapper added to `db.js`) — a validation failure on bill 2 rolls back bill 1's update too. FX-rate lookup and journal-reference allocation happen *outside* the transaction (DuckDB is single-writer; the ambient connection would deadlock against the transaction's dedicated one).
3. **Validation (server-side, hard constraints for Phase 1):**
   - All allocated bills same currency.
   - All allocated bills same vendor (case-insensitive `partner_name` match).
   - Each allocation amount > 0 and ≤ that bill's outstanding.
   - At least one allocation.
   - Shares `validateBillForPayment` with the single-bill path (status/amount checks) — extracted so the two paths can't drift apart.
4. **UI — `Shift+P`** on a posted/partial bill (Bills list, `payables-bills.js`) opens an inline multi-select allocation panel — same child-row pattern as the single-pay row, no modal:
   - Checkbox-select additional bills from the same vendor.
   - Enter one total payment amount; auto-distribute across selected bills, with per-row override.
   - Live balance indicator (`Allocated: X / Y ✓` or `⚠ N unallocated/over`) — submit is blocked until allocated equals total.
   - Date, bank account (defaults to last-used), optional reference, FX-rate field for foreign-currency vendors.
   - `Enter` submits, `Esc` cancels, full keyboard nav within the panel.
5. **Void.** A multi-bill payment voids as **one unit** — `bill.payment.void` on any payment row belonging to the batch reverses the whole batch (all N bills' journal lines and `amount_paid`), with an explicit confirmation ("This was part of a multi-bill payment. Voiding will reverse the entire payment (all bills)").
6. **Idempotency.** Same `Idempotency-Key` handling as the single-bill path — a retried multi-bill request doesn't double-post.

### Explicitly out of scope (Phase 1)

- **Cross-vendor payments** — rejected server-side (`VALIDATION`). A holding company paying two unrelated vendors in one batch isn't supported.
- **Mixed-currency payments** — rejected server-side. All allocated bills must share a currency.
- **Partial-batch void** — void is all-or-nothing; you cannot unwind one bill out of a settled batch without reversing the whole thing.
- **Vendor credit / prepayment application** — a payment can only allocate against open bills, not create or consume a standing credit balance.

These are reasonable Phase 2 candidates if real usage shows the need, but weren't required by the original monthly-statement case and would meaningfully raise validation complexity (cross-currency needs a combined FX-rate model; partial-batch void needs to reconstruct partial journal reversals from a shared batch).

### Tests

9 contract tests (`api/test/contract.test.js`): split across N bills (journal balances), cross-vendor rejected, mixed-currency rejected, over-allocation rejected, empty-allocations rejected, foreign-currency per-allocation FX lines (journal balances), whole-batch void, atomic rollback (bill 2 already paid → bill 1's update rolls back), idempotency.

### Housekeeping

Issue #131 is fully resolved by the above and should be closed — the merge doesn't appear to have auto-closed it.
