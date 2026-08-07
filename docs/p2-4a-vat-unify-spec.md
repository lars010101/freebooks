# P2-4a — VAT/Amount Convention Unify (Tax-Exclusive Everywhere)

**Date:** 2026-08-07 · **Status:** RATIFIED (magnus review 2026-08-07 — Q3 flipped to per-code grouping, Q2 backfill conditioned on cutover-scoped control check, Q4 confirmed rename, Q1 confirmed no-change)

## 1. Problem

freebooks has two VAT conventions coexisting on the posting side. The VAT/GST entry model was redesigned on 2026-07-26 (PRs #40–43) to a SAP-style model where bill lines carry only a VAT code and amounts are computed. **Bills are already tax-exclusive** — the user types the net amount per line and VAT is computed on top: `expectedVat = Math.round(lineAmount * rate * 100) / 100` (`bills.js:331,340`).

Two remaining posting paths still treat the entered amount as **tax-INCLUSIVE (gross)** and back-calculate the net, which is inconsistent with bills and with how the two dominant mid-market accounting products handle manual journal entries:

### 1.1 `journal.js` — `enrichAndValidate()` (line 76–82)

When a journal line carries a `vat_code`, `enrichAndValidate` calls `computeVatSplit(companyId, vatCode, debit || credit)`, which treats the debit/credit as **GROSS** and splits it:

```
netAmount = roundCurrency(gross / (1 + rate))
vatAmount = gross - netAmount
```

The posted `journal_entries` row keeps the *gross* in `debit`/`credit` — i.e. the user-entered Debit field becomes the gross line, with `net_amount` and `vat_amount` columns holding the back-calculated split. The journal UI (`journal-new.js`) has a Tax Code column, but the semantic is opaque: the user enters a gross amount in the Debit/Credit field and the system silently splits it with no visible feedback. This is the same `computeVatSplit` that bank import uses (see §1.2) — a single shared function that bakes the tax-inclusive assumption into both surfaces.

### 1.2 `bank.js` — bank import path (line 811–821)

When a bank-imported transaction carries a `vatCode`, the import handler calls `expandVatLines(companyId, lines[0])` (`vat.js:46–68`), which expands the single debit line into a net line + a separate VAT line, treating the bank-statement amount as gross and back-calculating the net via `computeVatSplit`. The credit side is then rebalanced to the expanded debit total.

### 1.3 `vat.js` — `computeVatSplit()` (line 20–44)

The shared split function itself assumes gross input. The reverse-charge branch (line 36–39) is already tax-*exclusive* in effect — it keeps `netAmount = grossAmount` and computes `vatAmount = roundCurrency(grossAmount * rate)` — because RC is self-assessed and the net is the full entered amount. Only the standard-VAT branch (line 41–43) does the gross-to-net division.

### 1.4 What is already tax-exclusive (NO CHANGES needed)

- `bills.js` `createBill()` (line 320–427) — `lineNet = lineAmount` (the user entered net), `expectedVat = lineAmount * rate`, tax posted as separate grouped lines per code.
- `bills.js` `saveDraftBill()` (line 880–955) — server-computed draft totals, tax-exclusive (P2-4b, confirmed done 2026-08-07).
- `sie-import.js` — sets `vat_code=null, vat_amount=0` for all imported lines; SIE import does not process VAT.
- `vat.js` `generateVatReturn()` — a READ path; reads `net_amount_home` and `vat_amount_home` from `journal_entries`. Unaffected by which posting convention produced those columns.

## 2. Design principles

1. **One convention per *input source*.** "Tax-exclusive everywhere" is the headline, but the operative rule is more precise: the amount the human/agent types or the document states is treated at face value, and VAT is computed *on top*. For bills and journal entries the face value is the **net** (the user is encoding the invoice/entry). For bank statements the face value is the **settled cash**, which is *gross* by definition — the bank doesn't know or care about the VAT split. Conflating these two is the root cause of the current inconsistency.

2. **Match the dominant mid-market precedent.** QuickBooks Online (QBO) and Xero both post manual journal entries **tax-exclusively**: the user enters the net amount in the Debit/Credit field, picks a tax code, and the system computes the VAT and posts it as a separate line. Neither offers a gross/net toggle on the journal entry screen. This matches the bills path and is the default a trained bookkeeper expects. Bank imports in both products invert this: the bank amount is the gross settled cash, and a tax code on the bank line means "split this gross into net + VAT." **This spec adopts the same split: journal entries go tax-exclusive; bank import stays tax-inclusive.**

3. **The journal `debit`/`credit` columns hold the net, not the gross.** After this change, a journal line with a VAT code carries `net_amount` in `debit`/`credit` and a *separate* VAT line is created — exactly mirroring `bills.js:329–353`. The `net_amount`/`vat_amount`/`net_amount_home`/`vat_amount_home` columns then agree with `debit`/`credit` rather than disagreeing with them, which also makes `generateVatReturn` read consistently across bills and journals.

4. **Bank import keeps `expandVatLines` as-is.** The bank statement amount IS the gross cash movement — you cannot enter a "net" that differs from what the bank shows. `expandVatLines` is correct for this input source. It stays tax-inclusive. This is the key design tension and is resolved in favor of "the bank amount is always gross" (see §3.3).

5. **No data migration.** Existing journal entries posted tax-inclusively already have the correct net/vat split materialized in `net_amount`/`vat_amount`/`net_amount_home`/`vat_amount_home`. The `debit`/`credit` on those rows is the *gross* the user originally entered — which is internally consistent for the old convention. The change only affects FUTURE postings. Rewriting historical `debit`/`credit` to net would change the GL, break any SIE/SRU golden files, and provide no accounting benefit (see §5).

6. **No stated-VAT override on journal entries.** Bills carry a bill-level `vat_amount_stated` field because the supplier invoice states a VAT figure the operator wants to reconcile against the computed figure (tolerance `max(flat, 1%)`, warn-not-block). Journal entries are manual — the operator controls the amount directly and there is no external document to reconcile against. Adding a stated-VAT field to journal entries would be overengineering for a manual entry surface and contradicts Magnus's preference to simplify when volume doesn't justify complexity. The tolerance check stays bill-only.

7. **English-only UI.** No Swedish terms in the journal entry surface (standing preference). "Tax Code", "VAT", "net" — not "moms", "momskod", "netto".

## 3. Detailed design (per posting path)

### 3.1 Journal entry posting — `enrichAndValidate()` → tax-exclusive

**Current** (`journal.js:76–82`):

```js
if (line.vat_code && company.vat_registered) {
  const split = await computeVatSplit(companyId, line.vat_code, debit || credit);
  vatAmount = split.vatAmount;
  netAmount = split.netAmount;          // = gross / (1 + rate) — back-calculated
  vatAmountHome = vatAmount * fxRate;
  netAmountHome = netAmount * fxRate;
}
enrichedLines.push({ ...line, debit, credit, ..., net_amount: netAmount, vat_amount: vatAmount, ... });
```

The posted row keeps `debit`/`credit` = the *gross* the user typed.

**After** (tax-exclusive — the entered `debit`/`credit` IS the net):

```js
if (line.vat_code && company.vat_registered) {
  const vcRows = await query(
    `SELECT rate, vat_account_input, vat_account_output, is_reverse_charge
     FROM vat_codes WHERE company_id = @companyId AND vat_code = @vatCode AND is_active = true LIMIT 1`,
    { companyId, vatCode: line.vat_code }
  );
  if (vcRows.length > 0) {
    const vc = vcRows[0];
    const rate = Number(vc.rate);
    netAmount = debit || credit;                                   // entered amount IS the net
    vatAmount = Math.round(netAmount * rate * 100) / 100;          // computed on top
    vatAmountHome = vatAmount * fxRate;
    netAmountHome = netAmount * fxRate;
    // carry input/output accounts + isReverseCharge through to the line-expansion step below
    line._vat_meta = { rate, inputAccount: vc.vat_account_input, outputAccount: vc.vat_account_output, isReverseCharge: vc.is_reverse_charge };
  }
}
enrichedLines.push({ ...line, debit, credit, ..., net_amount: netAmount, vat_amount: vatAmount, ... });
```

This mirrors `bills.js:329–353` exactly: `lineNet = lineAmount`, `expectedVat = lineAmount * rate`.

**Line expansion (new, after enrichment):** Today `enrichAndValidate` does NOT expand the journal line into a separate VAT line — it only populates `net_amount`/`vat_amount` on the *same* row while leaving `debit`/`credit` = gross. That produces a single unbalanced-looking line (net in debit, but VAT recorded only in the `vat_amount` column with no offsetting debit). The current code relies on the caller or the UI to handle the VAT line; in practice the journal path does **not** post a separate VAT line today — it just records the split metadata. This is itself a latent defect (the VAT is computed but never posted to a VAT account on journal entries, unlike bills).

**Decision:** bring journal entries onto the bills pattern — post VAT as a separate journal line grouped per code. After enrichment, expand any line carrying a `vat_code` into:

- the original line, with `debit`/`credit` = `netAmount` (unchanged from what the user typed), `vat_code: null`, `vat_amount: 0`, `net_amount: netAmount`;
- a VAT line: `account_code` = input (if debit) or output (if credit) account, `debit`/`credit` = `vatAmount` on the same side, `vat_code: code`, `vat_amount: vatAmount`, `net_amount: 0`, description appended with `(VAT {rate*100}%)`.

For **reverse charge**: post the DR/CR pair (input + output VAT) as bills do (`bills.js:407–413`), netting to zero inside the journal, with the original line kept at the full net amount. This is *simpler* than the current tax-inclusive RC handling because `vatAmount = amount * rate` directly — no gross-to-net division to back out.

**Grouping — per-code, mirroring bills (ratified 2026-08-07).** The codebase already has *two* VAT-line-construction implementations:

1. `expandVatLines`/`computeVatSplit` (`vat.js`) — gross-input, per-line. Built for bank.js's single-entry call site. Never grouped across lines because bank import only ever expands one line at a time.
2. `bills.js` inline logic (`bills.js:396–414`) — net-input, per-code grouped. Loops `for (const code of Object.keys(stdTaxByCode))` and writes exactly one VAT GL row per distinct code on the bill, regardless of how many expense lines used that code. Does not call `expandVatLines` or `computeVatSplit`.

The `bill_lines` subledger (P2-3) is per-line, but that is a different table serving a different purpose than the VAT GL rows. If the goal (Decision 1) is for journal entries to "mirror the bills path exactly," the option that does that is **per-code grouping** — writing fresh grouping logic modeled on bills.js's `stdTaxByCode` pattern, not reusing `expandVatLines` (which is gross-oriented and was never exercised against multi-line batches). A journal batch with three lines split across cost centers but sharing one VAT code is a normal case; per-line expansion would silently produce three VAT rows where bills would produce one, reintroducing exactly the kind of convention drift P2-4a exists to close.

**Decision:** per-code grouping for journal entries — a net-input sibling to bills.js's existing loop. The grouping logic accumulates `vatAmount` per distinct VAT code across all lines in the batch, then writes one VAT GL row per code. `expandVatLines` is NOT reused.

**Balance:** the expanded lines (net line + VAT line(s)) must still balance as a batch. The caller's credit side already balances against the debit side at the *gross* today; after this change the credit side must balance against `net + VAT`. For a single journal entry where the user enters matching debit and credit, this means the credit must equal `net + vatAmount` — i.e. the user enters the **net** on the taxable line and the **gross** on the offsetting line, OR the UI auto-balances (see §4). The cleanest contract: the user enters net on the taxable line, the system computes and posts the VAT line, and the offsetting line is whatever makes the batch balance. The UI should make this visible (§4).

### 3.2 Bank import posting — `expandVatLines` stays tax-inclusive

**No design tension — this is existing, working code.** Bank statement amounts are the actual cash that moved. If a supplier is paid 1,250 SEK including 25% VAT, the bank statement shows **1,250** — that is the settled cash. There is no "net bank amount"; the bank does not record the VAT split. Treating the bank amount as net (1,000) would post a cash movement of 1,000 against a bank statement that says 1,250 — the bank reconciliation would immediately break.

**Decision: bank import stays tax-inclusive — confirmed, no change (ratified 2026-08-07).** `expandVatLines` (`vat.js:46–68`) is correct for its input source: it takes the gross bank amount, splits it into net + VAT, and posts a net line + a separate VAT line. The credit (bank) side keeps the gross; the debit (expense) side becomes net; the VAT line absorbs the difference. This is not a future design choice — `bank.js:817` already calls `expandVatLines(companyId, lines[0])` today, and it works. No change to this function.

This is **not** a violation of "tax-exclusive everywhere." The headline is shorthand for "the amount the operator/document states is treated at face value." For journal entries the stated amount is net (the user is bookkeeping the invoice). For bank statements the stated amount is gross (the bank settled gross cash). The principle is "honor the document" — and the two documents state different things. Both QBO and Xero do exactly this: journal entries tax-exclusive, bank-coded transactions tax-inclusive.

**What changes for bank import:** nothing in the split logic. The only cleanup is the shared-function question (§3.3) and an explicit code comment documenting *why* bank import is tax-inclusive while journal entries are not, so the next reader doesn't "fix" the inconsistency by unifying them the wrong way.

### 3.3 `computeVatSplit` and `expandVatLines` in `vat.js`

`computeVatSplit` (line 20–44) is the tax-inclusive split function. After this change:

- **Journal entries no longer call it.** `enrichAndValidate` computes `vatAmount = amount * rate` directly (tax-exclusive), mirroring `bills.js:340`.
- **Bank import still needs a tax-inclusive split.** `expandVatLines` calls `computeVatSplit` internally.

**Decision:** keep `computeVatSplit` and `expandVatLines` in `vat.js`, unchanged. Rename `computeVatSplit` → `computeVatSplitGross` (ratified 2026-08-07). The entire reason P2-4a exists is an unlabeled convention assumption that silently diverged between two call sites; a JSDoc comment is exactly the kind of thing that gets skimmed past — presumably close to how the original bug happened. The rename costs a few call-site edits and makes the assumption impossible to miss at the point of use. The function is not deleted because bank import depends on it.

`expandVatLines` stays as the bank-import-only expander. It is not reused by journal entries — journal entries get their own inline expansion in `enrichAndValidate` (or a new `expandJournalVatLines` helper) that uses the tax-exclusive `vatAmount = amount * rate` formula. The two expanders look similar but encode opposite input semantics; keeping them separate with clear names is less error-prone than a flag-parameter single function.

### 3.4 Reverse charge in journal entries

Under tax-exclusive semantics, RC on a journal entry is straightforward:

```
vatAmount = Math.round(amount * rate * 100) / 100
DR input VAT account,  vatAmount   (if the entry is a debit-side taxable line)
CR output VAT account, vatAmount  (paired)
```

The original line stays at the full net `amount`. The RC pair nets to zero inside the batch. This is identical to `bills.js:407–413` and simpler than the current tax-inclusive path (which first back-calculates net from gross, then computes RC on the gross). No special handling.

## 4. UI changes — `journal-new.js`

The Tax Code column already exists on the journal entry screen. The semantic change is: **the Debit/Credit the user enters IS the net amount when a Tax Code is set.** The system computes the VAT and posts it as a separate line. The UI must make this visible so the user isn't surprised by an extra VAT line on the posted batch.

### 4.1 Read-only computed-VAT readout

Add a read-only computed-VAT cell (or a footer readout per line) that shows `net × rate` live as the user types, when a Tax Code is selected. Format: `VAT 250.00` next to a `1,000.00` net debit at 25%. This mirrors how bills show computed VAT per line. No editable VAT amount field (no stated-VAT override per §2.6).

### 4.2 Batch total display

The batch total / balance indicator should show **net + VAT = gross** so the user understands the posted batch will balance to the gross, not just the net they typed. E.g. a debit of 1,000 net + 250 VAT against a credit of 1,250 (the offsetting line the user enters) balances. The UI should prompt/validate that debits = credits *including the computed VAT lines* before `w` (post).

### 4.3 No gross/net toggle

Per §2.2, no toggle. QBO and Xero don't have one on journal entries. Adding one would re-introduce the exact ambiguity this spec removes. The Tax Code column's presence *means* tax-exclusive; its absence *means* no VAT (plain line). One rule, one mental model.

### 4.4 Agent path (`journal.propose`)

`journal.propose` goes through the same `enrichAndValidate` → `postJournalBatch` core (agent-readiness spec §4.3). Agents proposing journal entries with VAT codes will now produce tax-exclusive postings automatically. No agent-side change beyond the shared core. The proposal review surface (inbox `y`/`x`) should show the expanded lines (net + VAT) so the human reviewer sees what will post — same as the bills review surface.

## 5. Migration / compatibility

**No data migration.** Existing `journal_entries` rows with VAT codes were posted tax-inclusively: `debit`/`credit` hold the *gross* the user typed, and `net_amount`/`vat_amount` hold the back-calculated split. These rows are internally consistent for the old convention. Rewriting `debit`/`credit` to net would:

- change the GL (every historical taxable journal line would shrink),
- break the SIE 4 export contract (the `#RES`/`#VER` lines would change),
- break the SRU golden files (`blanketter.sru` byte-equality vs filed 2024),
- provide no accounting benefit — the VAT return reads `net_amount_home`/`vat_amount_home`, which are already correct.

**The change is forward-only.** New journal entries posted after the deploy carry `debit`/`credit` = net and a separate VAT line. Old entries keep their gross in `debit`/`credit` and their split in the `net_*`/`vat_*` columns. The two coexist cleanly because:

- `generateVatReturn` reads `net_amount_home`/`vat_amount_home` — correct under both conventions.
- The GL / TB / BS / P&L read `debit_home`/`credit_home` — for old rows this is gross (the user entered gross, the GL reflects that); for new rows this is net (the user entered net, plus a separate VAT line posted to the VAT account). The VAT account totals are correct under both because old rows recorded the VAT in `vat_amount` but did *not* post a separate VAT line — which is the latent defect noted in §3.1. **This is a one-time inconsistency in historical VAT-account balances** (pre-change journal entries did not post VAT to a VAT account; post-change they do). Acceptable: the volume of historical *journal entries with VAT codes* in the live company (mdu_ab) is low (the books were built from bank statement + skattekonto transactions, not manual VAT-bearing journal entries). The VAT return still reads the `vat_amount_home` column, so the return is correct; only the VAT *account balance* in the GL is understated for the pre-change period by the un-posted journal VAT.

**Mitigation for the historical VAT-account gap — no backfill (ratified 2026-08-07), with one condition.** The `generateVatReturn` function sums `je.net_amount_home`/`je.vat_amount_home` grouped by code (`vat.js:84-95`), independent of whether a GL line was ever posted to the VAT account. So compliance output is unaffected either way — no backfill is needed for VAT return correctness.

**However:** if a future VAT-subledger-vs-GL control report is built (the natural analog to P2-3's AP-subledger-vs-GL control), it must carry an explicit "effective since [P2-4a cutover date]" boundary from day one. Without it, the control would permanently FAIL on every pre-cutover period — the same bug shape as `re_rollforward` and `integrity_extended` hard-coding the wrong jurisdiction's account codes (`db/macros.sql:531,604`), just a different cause. Same bug shape, different cause; worth not repeating.

## 6. Testing

1. **Journal entry, tax-exclusive, standard VAT, per-code grouping:** enter two debit lines of 1,000 net each with the same 25% VAT code. `enrichAndValidate` produces `net_amount=1000` per line, `vat_amount=250` per line. The posted batch has three lines: expense debit 1,000 (line 1), expense debit 1,000 (line 2), VAT-account debit 500 (one grouped row per code). Offset credit = 2,500. Batch balances.

2. **Journal entry, no VAT code:** unchanged behavior — `net_amount=0`, `vat_amount=0`, no expansion. Single line as typed.

3. **Journal entry, reverse charge, tax-exclusive:** debit 1,000 net with an RC code at 25%. Posted batch: expense debit 1,000, input-VAT debit 250, output-VAT credit 250. The RC pair nets to zero; the batch balances against the offset credit of 1,000.

4. **Bank import, tax-inclusive (unchanged):** bank amount 1,250 with a 25% VAT code. `expandVatLines` splits into net 1,000 + VAT 250. Expense debit 1,000, VAT-account debit 250, bank credit 1,250. Unchanged from today.

5. **Bank import, no VAT code:** single line, no expansion. Unchanged.

6. **`generateVatReturn` consistency:** after posting a tax-exclusive journal entry and a tax-inclusive bank import for the same period, the VAT return reports both correctly via `net_amount_home`/`vat_amount_home`.

7. **Migration guard:** existing `journal_entries` rows are untouched — assert no row's `debit`/`credit` changed after deploy (compare a snapshot of `journal_entries` before and after).

8. **UI readout:** on the journal-new page, selecting a Tax Code and typing 1,000 in a Debit cell shows a live `VAT 250.00` readout; the balance indicator includes the computed VAT.

9. **Agent proposal path:** `journal.propose` with a VAT code produces a tax-exclusive expanded batch; `journal.approve` posts it via the same core; the inbox review surface shows both lines.

10. **SIE 4 / SRU golden files unchanged** for historical data (forward-only change). Re-run `sru-golden-2024.mjs` and the SIE round-trip test — must remain byte-identical.

## 7. Out of scope

- **Bills path.** Already tax-exclusive. No change to `bills.js` `createBill`/`saveDraftBill`/`bill.post`.
- **SIE import.** Sets `vat_code=null`. No VAT processing. No change.
- **Bank import split logic.** Stays tax-inclusive (`expandVatLines` unchanged). Only the shared-function naming/JSDoc changes.
- **Stated-VAT override on journal entries.** Not added (§2.6). Bills keep the override.
- **Per-code grouping of VAT on journal entries.** Ratified: per-code grouping IS the design (§3.1, Q3). Fresh net-input grouping logic modeled on bills.js's `stdTaxByCode` pattern — NOT `expandVatLines` reuse.
- **Gross/net toggle on the journal UI.** Not added (§2.2, §4.3).
- **Historical backfill of un-posted journal VAT lines.** Default: no backfill (§5). Magnus to decide if the VAT-account GL discrepancy is material.
- **Changing the `debit`/`credit` of existing posted journal entries.** Never (forward-only).
- **`computeVatSplit` deletion.** Kept for bank import; renamed/annotated only.
- **P2-4b (server-computed draft totals).** Confirmed done 2026-08-07. Not in this spec.
- **P2-7 (`coaStyle`).** Separate item. Not in this spec.

## 8. Files changed (preview — not for execution)

| File | Change |
|------|--------|
| `api/src/journal.js` | `enrichAndValidate` (line 76–82): tax-exclusive VAT compute (`vatAmount = amount * rate`, `netAmount = amount`); add per-line VAT expansion (separate VAT journal line, mirroring `bills.js:329–353`); RC pairs. |
| `api/src/vat.js` | Rename `computeVatSplit` → `computeVatSplitGross` (or JSDoc `grossAmount` tax-inclusive). `expandVatLines` unchanged. No longer imported by `journal.js`. |
| `api/src/pages/journal-new.js` | Read-only computed-VAT readout per line; balance indicator includes computed VAT; no gross/net toggle. |
| `api/src/bank.js` | No logic change. Update the call-site comment to document *why* bank import is tax-inclusive while journal entries are not. |
| `tests/journal-vat.test.js` (new) | Contract tests for §6 cases 1–3, 7, 9. |
| `tests/bank-vat.test.js` (new or extend) | Regression: bank import split unchanged (cases 4–5). |
| `tests/vat-return.test.js` (extend) | Case 6: VAT return consistency across both conventions. |
| `docs/review-roadmap.md` | Status update entry. |

## 9. Ratified decisions (magnus review 2026-08-07)

1. **Bank import stays tax-inclusive — confirmed, no change.** This is existing, working code (`bank.js:817` → `expandVatLines` → `computeVatSplit` on gross). Not a future design choice — the bank amount IS settled cash, and treating it as net would break bank reconciliation. High confidence.

2. **No historical backfill — confirmed.** `generateVatReturn` reads `net_amount_home`/`vat_amount_home` metadata columns directly (`vat.js:84-95`), independent of whether a GL line was posted. Compliance output is unaffected. **Condition:** any future VAT-subledger-vs-GL control report must carry an explicit "effective since [P2-4a cutover date]" boundary from day one — otherwise it permanently FAILs on pre-cutover periods (same bug shape as `re_rollforward`/`integrity_extended` hard-coding wrong jurisdiction accounts).

3. **Per-code grouping — confirmed (flipped from spec's original per-line proposal).** The codebase has two existing VAT-line-construction implementations: `expandVatLines` (gross-input, per-line, built for bank.js's single-entry call site) and bills.js inline logic (net-input, per-code grouped). "Per-line matches bill-line semantics" was inaccurate — bills' GL posting is per-code grouped (`bills.js:396-414`), not per-line. The `bill_lines` subledger (P2-3) is per-line but serves a different purpose. Per-code grouping is the option that actually mirrors the bills path. Implementation: fresh grouping logic modeled on bills.js's `stdTaxByCode` pattern, NOT a reuse of `expandVatLines` (which is gross-oriented and never exercised against multi-line batches).

4. **`computeVatSplit` → `computeVatSplitGross` rename — confirmed.** The entire reason P2-4a exists is an unlabeled convention assumption that silently diverged between two call sites. A JSDoc comment gets skimmed past — the rename makes the assumption impossible to miss at the point of use.
