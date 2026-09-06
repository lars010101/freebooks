# Bill Line-Item Grid: Account/Debit/Credit, Per-Code VAT Override, WHT & Reverse-Charge Rows — Spec

**Status:** Shipped (2026-09-06)
**Scope:** `api/src/pages/bill-edit.js`, `api/src/bills.js`, `api/src/views.js`.
**Depends on:** `bill-line-items-layout-prep-spec.md` (the `LINE_COLUMNS`/tier/`--bl-cols` grid architecture this extends, not replaces), `bill-withholding-tax-spec.md` (the WHT posting mechanism this makes visible), and the VAT redesign of 2026-07-26 (per-line computed VAT, bill-level stated override — the mechanism this narrows to per-code).
**Scoped to `bill-edit.js` only.** `journal-voucher.js` already has its own native Debit/Credit line model (real user-entered double-entry lines, not auto-generated tax/total rows) and isn't touched by this spec. `payables-bills.js`'s tree-table quick-entry and `agent-loop.js`'s extraction pipeline keep sending the old bill-level single-number stated VAT — see §3.4.

---

## 0. Origin

Prompted by a 10-point request to restructure the bill-edit line-items grid: rename the expense-account column, add a Credit column, generate VAT/total lines as real rows instead of a footer, allow per-VAT-code override, and leave VAT/cost-center blank on computed rows. Refined through conversation into the design below — notably, the original "two account columns" idea (one for the debit side, one for credit) was dropped in favor of a single `Account` column plus separate `Debit`/`Credit` amount columns, mirroring `journal-voucher.js`'s existing convention, since a bill line is either a debit or a credit, never both.

The driving insight that shaped §3 and §4: both VAT and WHT **already post as real, separate GL lines** in `bills.js` (grouped per VAT code; one `CR WHT Payable` per WHT code) — the old footer only ever showed *summary* numbers. This spec doesn't invent new computation; it makes the bill-edit grid show what the server already posts.

---

## 1. Column model

`LINE_COLUMNS` (`bill-edit.js`): `Description | Account | Debit | Credit | VAT code | WHT code | Cost center | (delete)`. Tier 1 (always visible, wide layout): `desc`, `acct`, `debit`, `credit` — these are the "what got booked" facts. Tier 2 (collapses first at the Tier-B breakpoint): `vat`, `wht`, `cc`, `del` — classification metadata. This reclassifies `acct` from tier 2 (as it was in the layout-prep spec) to tier 1, since Account is now a core identity column shared by every row, auto-generated ones included, not just a "coding fact" alongside VAT/cost-center.

A user (expense) line is always a debit: Account/Debit/VAT code/WHT code/Cost center are editable, Credit always renders a disabled, empty input — present only so the column stays aligned with the auto-generated rows below it.

---

## 2. Auto-generated rows

`computeAutoLines()` derives, from the current user lines: one row per non-zero **standard** VAT code (Debit, editable — §3), two rows per non-zero **reverse-charge** VAT code (§5), one row per non-zero **WHT** code (Credit, read-only — §4), and one **total** row (Credit = Σ debits above, Account = the bill's AP account). `renderAutoLines()` renders them into `#be-lines-body` after the user lines, tagged `.bl-auto` (in addition to `.bl-row`, so they still pick up the shared grid CSS) and keyed by a stable `data-key` (`vat:<code>`, `rc-dr:<code>`, `rc-cr:<code>`, `wht:<code>`, `total`).

**Reconciliation, not rebuild.** `updateTotals()` runs on every keystroke (including typing into a VAT row's own override input), so a naive full teardown-and-recreate of the auto rows on each call would steal focus mid-keystroke. `renderAutoLines()` instead diffs by `data-key`: an existing row whose subtree contains `document.activeElement` is left untouched; everything else gets its cell values refreshed in place; rows for codes that disappeared are removed; `container.appendChild()` re-establishes DOM order without recreating nodes (verified live — moving a node via `appendChild` does not blur a focused descendant).

`collectLines()` (and everything downstream of it — validation, `gatherBill()`, dirty-tracking) only ever reads `.bl-row:not(.bl-auto)` — auto rows are derived display, never sent to the server as "lines."

---

## 3. Per-VAT-code stated override

### 3.1 Client

Each standard-VAT auto-row's Debit input is editable. Typing into it sets `dataset.stated = '1'` (mirroring the old `#be-tot-gst` convention) and re-runs `updateTotals()`, which reads that flag back via `statedOverride(key)` so the override survives the reconciliation pass above. `collectVatAmountsStated()` walks all `.bl-auto-debit` inputs with `dataset.stated==='1'` and builds `{code: amount}`, sent as `gatherBill().vat_amounts_stated`.

### 3.2 Server (`bills.js`)

Three functions previously computed a single bill-level stated VAT total (delta absorbed by whichever standard code had the largest computed amount): `createBill` (the actual posting/tolerance-check logic), `saveDraftBill` (a duplicate computation for the draft's displayed/stored total), `postDraftBill` (resolves a stated value before delegating to `createBill`). All three now accept `vat_amounts_stated` (a map) as a **first-precedence, mutually exclusive alternative** to the old `vat_amount_stated` (a single number): if the map is present, each code's `stdTaxByCode[code].computed` is compared against its own tolerance and overridden directly — no more "largest code absorbs the delta," which was only ever needed because one aggregate number had to be distributed across possibly-several codes. Per-code override doesn't have that problem, so removing the heuristic is a simplification, not a workaround for one.

### 3.3 Draft persistence

`bills.draft_lines` (a free-form `TEXT` column, no schema change needed) changed shape from a bare lines array to `{lines, vatAmountsStated}`. `getBillLines`, `getBill`, and `postDraftBill` all unwrap it with a bare-array fallback for pre-existing drafts saved before this change. `getBill` additionally surfaces `vat_amounts_stated` on its response for drafts, which `prefillFromExisting` uses to seed `S.vatAmountsStated` — read by `statedOverride()` on the very first `computeAutoLines()` pass, before any `.bl-auto` DOM row exists yet to read `dataset.stated` off of.

### 3.4 Backward compatibility — deliberately not removed

`payables-bills.js` (tree-table quick-entry) and `agent-loop.js` (the AI extraction pipeline) both still send the single-number `vat_amount_stated` — neither has per-code UI, and there was no reason to force a UI change on them for this. Both paths are untouched and still exercise the original "largest code absorbs the delta" logic, now living in the `else` branch of the same code that hosts the per-code path. Verified via a live API round-trip (both surfaces, same company) that neither regressed the other.

---

## 4. WHT row

Per user confirmation: WHT in this app is calculated by the company itself at bill registration (not a supplier-stated figure), so it stays **read-only** — no override surface, matching `bill-withholding-tax-spec.md` §0.5's existing decision. The WHT auto-row's Credit cell renders `disabled` unconditionally (`editable: false` in `computeAutoLines()`), crediting the code's `wht_account` — the same account and amount `bills.js`'s `CR WHT Payable` line already posts.

---

## 5. Reverse-charge VAT rows

A VAT code with `is_reverse_charge = true` (already a real column on `vat_codes`, with its own `vat_account_output` alongside the standard `vat_account_input`) renders as **two** auto-rows instead of one: a DR row to the input account, a CR row to the output account, same computed amount, both non-editable. This mirrors `bills.js`'s existing `rcTaxByCode` posting loop exactly. RC amounts are excluded from the Total row's Credit figure, matching the server's treatment of reverse-charge VAT as self-assessed and never owed to the vendor. No override surface — RC amounts were never eligible for the stated-VAT mechanism even before this spec (`bills.js`'s comment: "RC lines never absorb it").

Verified live (Playwright/Chromium): a bill with one standard code and one RC code renders the RC pair with the correct accounts and amounts, and the Total row's Credit correctly excludes the RC amount.

---

## 6. Keyboard / zone integration

Auto-rows share the `lines` zone (`z===2`) with user lines — no new zone was needed. Two regressions this introduced, found and fixed via live browser testing (not just code review), plus one pre-existing FB.form behavior confirmed to already handle this correctly:

- **`a` (add line) — fixed.** `addLine()` now inserts new rows via `insertBefore` the first `.bl-auto` row (to keep auto-rows pinned last through every `renderAutoLines()` call), so the zone's *last* row is no longer necessarily the *just-added* one. The `add` verb's `run()` now finds the new row by identity (`indexOf` in `api.zoneRows(2)`) instead of assuming `zoneRows(2).length - 1`.
- **`x` (delete) — fixed.** Explicitly excludes `.bl-auto` rows via its `when` clause. Without the guard, `x` on a computed row would `.remove()` it only to have the next `updateTotals()` call regenerate it from the underlying line data — harmless, but a confusing flash with no actual effect.
- **Zero-cell rows — already worked, no change needed.** The WHT/RC/Total rows have no enabled inputs, so `cells()`'s existing `!el.disabled` filter naturally returns nothing for them. Confirmed live that `j`/`k` degrade gracefully to row-only focus (`fb-form-row-focus` with no `fb-form-cursor` cell) exactly like the pre-existing read-only journals zone, and that navigation correctly crosses from the last auto-row into the attachments zone next — no dead-ends, no errors.

`applyLockedMode()` needed no changes: a posted bill's VAT auto-row renders `editable: !S.locked` from the start (§3.1/§4), so it's genuinely disabled from first paint rather than depending on `applyLockedMode`'s separate blanket disable-pass reaching a row that doesn't exist yet at the point that pass runs.

---

## 7. Verification

No component of this spec was accepted on code-reading alone. `node --check` on the source file only validates the outer Node.js template-literal wrapper, not the browser JS living inside it as a string — per this session's earlier discovery of a real shipped bug from exactly that gap — so every stage was verified by extracting the live page's actual `<script>` payload and `node --check`-ing *that*, plus:

- A full API round-trip against `test23` (draft save → `bill.get`/`bill.lines` restore → post → real GL journal balance-check) for the per-code override.
- A live Chromium (Playwright) session for the RC-row rendering, the `a`/`x` keyboard fixes, and the posted-bill locked-VAT-row check — each confirmed via actual DOM/cursor state, not assumption.
- A regression check that the legacy single-number `vat_amount_stated` path (tree-table, agent pipeline) still works unchanged.

All test bills created during verification were voided/deleted afterward.

---

## 8. What is explicitly out of scope

- **`journal-voucher.js`** — untouched; it has its own real double-entry line model already.
- **A WHT override mechanism** — deliberately not built (§4); `bill-withholding-tax-spec.md` §0.5's "no stated/override" decision still holds, now visibly rather than just by omission.
- **Reverse-charge override** — never existed, still doesn't (§5).
- **Qty × unit price** — still the `#3` spec's reserved slot in `LINE_COLUMNS`, untouched here.
