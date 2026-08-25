# extractJournalDocumentData() — AI Extraction for `receipts/` and `journal/`

**Status:** DRAFT — proposed 2026-08-24
**Depends on:** `agent-data-feeding-guide.md` §4.3 (folder→`entityType` routing), §3 (A4 underlag binding — this spec resolves an ambiguity that convention creates, §1.1), §5 ("what good agent output looks like" — the balanced-lines target shape this spec produces); `bill-extraction-spec.md` (sibling spec — shares §2.1's document-read logic by reference, diverges on output shape and account model); `bank-matching-spec.md` §1 (the `lines[]` shape this spec's output matches), §8.3 (agent orchestration precedent); `p2-4a-vat-unify-spec.md` (journal-entry postings are tax-**exclusive** — the single most important constraint this spec has to get right, §3.3); `agent-readiness-spec.md` R2/R5/R7/R8, §4 (single-gateway rule), §10.2 (Class A taxonomy).

## 0. Scope

**In scope:** extracting a balanced journal-entry proposal from a single document (PDF or image) dropped in `receipts/` or `journal/`, calling `journal.propose` to create a standard Class A inbox item for human review.

**One function serves both folders.** Per `agent-data-feeding-guide.md` §4.3, `receipts/` and `journal/` map to the identical `entityType: journal_proposal` and the identical `Extract → journal.propose` path — there is no architectural distinction between them, only an operator-facing one (presumably "expense receipts" vs. "other supporting documents"). Building two extraction functions for one specified pipeline would invent a difference the source spec doesn't make. This spec names the function `extractJournalDocumentData()` rather than `extractReceiptData()` to avoid implying a split that isn't there.

**Out of scope:**

- **No partner/vendor resolution.** `journal_proposals` carries no partner dimension — that's a `bills`-specific concept (`bills-partner-fk-spec.md`). A receipt's merchant name, if extracted at all, is descriptive text in the line `description` or the optional per-line `counterparty` field (`bank-matching-spec.md` §1's shape) — never a structured, matchable master-data reference.
- **No learned-rule / `mapping_suggestions` crystallization for receipt patterns.** The tier 1–4 cascade and its learning loop (`bank-matching-spec.md` §10) are scoped to recurring bank-statement lines across many statements. A document dropped in `receipts/`/`journal/` is typically a one-off; building a parallel learning mechanism here is exactly the kind of premature machinery `bank-matching-spec.md` §0.1 already argues against at this product's scale. Revisit only if receipt volume ever grows enough to justify it.
- **No changes to `journal.propose`, `enrichAndValidate`, or the VAT engine.** This spec produces input for the existing pipeline post-`p2-4a-vat-unify-spec.md`, exactly as it stands.
- **No new database table.** `journal_proposals` is the sole destination — the single-gateway principle (`agent-readiness-spec.md` §0 correction (c), §4.6) is unaffected; this spec adds an extraction function, not a new entity.
- **No UI changes.** Proposals render in the existing Inbox exactly like any other `journal_proposal`.

## 1. Function signature & pipeline position

```js
async function extractJournalDocumentData(attachment, context, companySettings) {
  // attachment: { id, path, mime_type, sha256, company_id, entity_type }
  // context: { accounts, vatCodes, currency, jurisdiction, defaultCashAccount }
  // companySettings: { llm_endpoint_url, llm_api_key, llm_model, llm_temperature }
  // returns: ExtractionResult (see §4)
}
```

Called from a new `processJournalDocument()` in `api/src/agent-loop.js`, parallel to `processBill()`.

### 1.1 No disambiguation needed — every drop-folder event is a fresh document

An earlier draft of this section worried about telling "a fresh document" apart from "underlag being re-attached to an already-decided proposal," since both would produce an identical-looking `attachment.uploaded` event with `entityType: journal_proposal`. That concern doesn't survive tracing through how the watcher actually works: the drop-folder watcher (`agent-data-feeding-guide.md` §4.3) mints a **fresh UUID for every file it picks up**, uniformly across all four subfolders, with no filename convention or addressing scheme that would let a human "aim" a dropped file at an existing proposal. The underlag-reattachment mechanism (mint id → upload → propose with the same id) is something the bank-matching cascade's own code does internally, as evidence for a proposal *it* is creating — that never touches `receipts/`/`journal/` on disk.

**Resolution: `processJournalDocument()` triggers unconditionally on every `attachment.uploaded` event sourced from the `receipts/`/`journal/` watcher.** No existing-proposal check, no disambiguation logic. If a human wants to attach a supporting document to a journal entry they're already reviewing or editing, that's a different, existing-or-future UI affordance (an "attach file" action on the entry itself) — not something that flows through, or needs to be guarded against by, this drop-folder path.

## 2. Input assembly

### 2.1 Document read

Identical to `bill-extraction-spec.md` §2.1 — same text-layer-vs-image-per-page detection, same threshold, same fallback to an image content block. Not re-derived here; see that spec.

### 2.2 Context assembly — `buildJournalExtractionContext()`

- **Chart of accounts — all postable accounts**, not filtered to expense-type the way bill extraction is. A document-sourced journal entry can legitimately touch any account (expense, a reimbursement-payable liability, a specific bank/cash account) — there's no single account category it's confined to the way a bill's line items are.
- VAT/GST codes: code, rate, reverse-charge flag — same shape as `bill-extraction-spec.md` §2.2.
- Company currency + jurisdiction.
- **`defaultCashAccount`** — see §7. Supplied so the model has a fallback credit-side account when the document doesn't indicate a specific payment source.

## 3. Extraction call

### 3.1 Prompt — `buildJournalExtractionPrompt()`

This is where the shape most diverges from bill extraction, and where getting the arithmetic wrong is a real-money mistake, not a UX nit.

**The core instruction — net vs. gross, stated plainly because it's the easiest thing to get backwards:** `journal.propose` posts **tax-exclusive** (`p2-4a-vat-unify-spec.md`, ratified 2026-08-07) — a line's submitted amount is treated as the *net* figure, and the server computes VAT on top and posts it as a separate line. A receipt or invoice states a *gross* total (what was actually paid). Submitting the receipt's printed total directly as a debit amount with a `vat_code` attached would make the server compute VAT **on top of** an already-tax-inclusive number — silently inflating the recorded expense and double-counting the tax. The model must never do this. Concretely, the prompt instructs:

- Read the **gross total actually paid** (the cash-outflow figure) as printed on the document.
- Identify the applicable VAT/GST code from the supplied list, exactly as in bill extraction (§3.1 of that spec) — including recognizing reverse-charge language as a distinct case, not "no code found."
- **Do not compute the net amount.** That division belongs in §3.3, deterministically, from the matched code's own rate — not left to the model, for the same "VAT by code, never by guessed amount" reason `agent-data-feeding-guide.md` §5 already states for the existing cascade.
- Suggest an expense (or other appropriate) account for the debit side.
- Suggest a credit-side (payment/clearing) account **only if the document itself indicates one** (e.g. "paid by card ending 1234," a specific named account) — otherwise leave it unset; §3.3 falls back to `defaultCashAccount`. Don't guess a specific bank account from a generic receipt that gives no such signal.
- If the document itself shows a printed net subtotal *and* a printed VAT amount (many receipts do), report both as printed, alongside the gross total — this gives §3.3 a value to cross-check its own computed net against, rather than only ever trusting a single division.

### 3.2 Model call

Identical reuse of the `fetch`/`response_format: json_object`/temperature convention as `bill-extraction-spec.md` §3.2. No new settings keys, no vision pre-flight check, same rationale.

### 3.3 Response validation (deterministic, no LLM trust) — the net/gross conversion happens here, in code

**The net computation is arithmetic, not a model output.** Given the matched VAT code's rate `r` and the extracted gross amount `g`:

```
net = round(g / (1 + r), 2)     // when a VAT code applies
net = g                          // when no VAT code applies (rate 0 / exempt / no match)
```

This mirrors exactly how `bills.js` already treats a bill's net line amount as the authoritative input and lets the server compute VAT on top (`p2-4a-vat-unify-spec.md` §1.4) — the difference here is that the *document* gives gross, so extraction has to do this one arithmetic step before the figure reaches `journal.propose`, where a human directly typing a journal entry wouldn't have needed to.

**If the document also printed its own net/VAT breakdown** (§3.1's last bullet), cross-check: computed `net` (via division) should match the printed net within `bill_extraction_tolerance`-equivalent tolerance (reuse the same `max(0.50, 1%)` shape — see §7). Mismatch → flag `stated_vat_mismatch`, not a hard failure — this is deliberately handled entirely inside this extraction function's own validation layer, **not** as a new field on `journal_proposals`. `p2-4a-vat-unify-spec.md` §2.6 explicitly and recently (2026-08-07) declined to add a stated-VAT-override field to journal entries, reasoning that "the operator controls the amount directly and there is no external document to reconcile against" for a *manual* journal entry. That reasoning doesn't fully hold for a document-sourced entry — there very much is an external document here — but the fix for that gap belongs in this extraction function's own flags/evidence, not in a schema change that would reopen a recently-ratified decision. If document-sourced entries end up needing the same tolerance-and-warn treatment bills get, that's a legitimate future amendment to `p2-4a-vat-unify-spec.md` itself — not something to route around here.

**Balanced-line construction — this is the part that has to compose correctly with the server's own VAT expansion**, per `p2-4a-vat-unify-spec.md`'s own worked example (§6, test case 1): the server expands a net debit line with a VAT code into *two* debit lines (net + VAT), and validates the batch balances against whatever credit was submitted. So extraction must submit:

- **Debit line:** the suggested expense account, amount = computed `net` (§ above), `vat_code` attached.
- **Credit line:** the resolved clearing account (from the document if stated, else `defaultCashAccount`, §7), amount = the **gross** total — *not* net, and *no* `vat_code` on this line (a cash movement isn't itself subject to VAT treatment).

Submitted this way, the server's expansion turns the debit net line into net+VAT, and the batch balances against the gross credit — exactly the shape `p2-4a-vat-unify-spec.md` §6's test case 1 demonstrates for bills. Submitting the gross figure on **both** sides, or the net figure on the credit side, would either double-count VAT or fail to balance once the server expands it. This is the single most likely place a first implementation gets it wrong, since it's the opposite of what "matching the printed total" naively suggests.

**Multi-line receipts — the same arithmetic, applied per line, not a separate case.** Many real receipts span more than one expense category (a big-box receipt with both office supplies and groceries, each taxed differently) and need more than one debit line. The construction is a direct extension of the single-line formula above, not a different mechanism:

- For each extracted line item `i`, with its own gross amount `g_i` and its own matched VAT code (rate `r_i`, which may differ line to line — a mixed-rate receipt is exactly why this has to be per-line, not computed once for the whole document):
  ```
  net_i = round(g_i / (1 + r_i), 2)     // per line, using that line's own rate
  ```
- Submit one debit line per `net_i` (each carrying its own `vat_code`), plus **one** credit line for the resolved cash/clearing account (§7) at `Σ(g_i)` — the total actual cash outflow, not a per-line credit.
- **Cross-check before submission:** `Σ(g_i)` across extracted lines should equal the document's printed grand total (if one is printed), within the same tolerance as the single-line stated-VAT check (§ above). A mismatch here is a stronger signal than a single-line total mismatch — it usually means a line was missed or hallucinated — but the individual line amounts already extracted may still be correct, so this stays a soft failure: flag `total_mismatch`, set `confidence='low'` (§5.2), and let the human reviewer reconcile against the source document rather than rejecting a proposal that may be mostly right. Same severity treatment as `stated_vat_mismatch`, not folded into it as the same flag — they mean different things (line-level VAT arithmetic vs. document-level line-count completeness) and a reviewer benefits from seeing which one fired.
- **Balance after server expansion:** each debit line independently expands to net+VAT (or stays as-is if its own rate is 0/exempt); the batch balances against the single gross credit line because `Σ(net_i) + Σ(vat_i) = Σ(g_i)` by construction, provided each `net_i` was computed from its own line's rate. This holds regardless of how many debit lines there are — it's the single-line case applied N times against one shared credit line, not new arithmetic.

**Account validation:** the debit account should exist in the supplied chart-of-accounts context; an account code that doesn't validate fails at `journal.propose` itself (`agent-data-feeding-guide.md` §5 — "unknown codes fail validation before queueing"), but checking it here first avoids a wasted round-trip and gives a clearer rejection reason than the generic server error would.

**Date, amount, line-count checks:** reuse the same shape as `bill-extraction-spec.md` §3.3 — a missing date is a hard failure (can't assign a period), a missing/non-positive gross amount is a hard failure, zero identifiable lines is a hard failure.

**One date per document, not per line.** `journal.propose`'s existing line shape carries `date` per line (`bank-matching-spec.md` §1) — kept here rather than moved to an entry-level field, since that's the real, existing API contract and inventing a different one would need an adapter step before every call. But the invariant has to be stated explicitly rather than left implicit: **all lines produced by one extraction share the identical date, extracted once from the document.** A receipt or supporting document represents a single dated event even when it produces multiple debit lines (§ multi-line, above) — there is no scenario where two lines from the same document legitimately carry different dates. If the model returns differing per-line dates, that's a hard failure (malformed output), not something to silently resolve by picking one.

**Confidence derivation:** identical convention to `bill-extraction-spec.md` §3.3 — computed from flag count (`0` → `high`, `1` → `medium`, `2+` → `low`), never self-reported by the model.

## 4. Output schema

```js
{
  ok: true | false,
  confidence: 'high' | 'medium' | 'low',
  data: {
    lines: [
      {
        account_code: string,
        debit: number | null,     // exactly one of debit/credit per line, per journal.propose's existing shape
        credit: number | null,
        date: string,             // never null when ok: true
        description: string,
        vat_code: string | null,  // set only on the debit/expense line, never the credit/clearing line
        currency: string | null,
        counterparty: string | null,  // descriptive only — no partner_id equivalent, see §0
      }
    ],
    gross_total: number,          // the document's stated total — retained for dedup (§6) and audit, not itself submitted as a line amount
  },
  flags: string[],   // 'stated_vat_mismatch' | 'total_mismatch' | 'no_vat_code_detected' | 'reverse_charge_detected' |
                     // 'no_cash_signal' (defaulted to defaultCashAccount) | 'possible_duplicate' (§6)
  raw_model_output: object,
}
```

### 4.1 Mapping to `journal.propose`

`processJournalDocument()` mints a `proposalId` client-side and follows the exact A4 underlag sequence already specified (`agent-data-feeding-guide.md` §3): upload the attachment first under that id (already done — it's how the event fired in the first place, per §1.1, the entityId *is* the proposalId), then call `journal.propose` with `data.lines` and the same id. `_extraction_meta`-equivalent audit data (model, confidence, flags, raw output, prompt/context snapshot — mirroring `bill-extraction-spec.md` §4.2's reasoning) attaches to the `journal_proposals` row the same way `_match_meta` already does for cascade-produced proposals — no new column needed, this reuses the existing field.

## 5. Failure handling

### 5.1 Hard failures → `input_rejections`

Same pattern and same table as `bill-extraction-spec.md` §5.1 and `bank-matching-spec.md` §11: no configured LLM endpoint, LLM call errors, missing date, missing/non-positive gross total, zero valid lines. Same one-shot semantics — the event cursor advances regardless of outcome; a hard failure is terminal for that attachment, not retried on the next poll tick.

### 5.2 Soft failures → proposal still created, `confidence='low'`, flags populated

`stated_vat_mismatch`, `total_mismatch` (multi-line grand-total cross-check, §3.3), `no_cash_signal` (defaulted), ambiguous account choice. Consistent with the existing review posture (`bank-matching-spec.md` §7.1) — no proposal ever bypasses the inbox regardless of confidence; a low-confidence proposal is still a proposal, not a rejection.

## 6. Duplicate / re-drop protection

A re-scanned or re-photographed version of the same receipt has a different sha256 but the same content. Check for an existing non-rejected `journal_proposals` (or already-approved `journal_entries`) row matching `(gross_total, date, company_id)` within a short window (e.g. same day ± 1) and a description-similarity threshold. On match: flag `possible_duplicate` on the new proposal's evidence rather than silently creating a second one — but still create it (matching `bill-extraction-spec.md` §6's reasoning: a genuine repeat expense on the same day isn't impossible, so flag, don't suppress).

## 7. Configuration — reuses the existing `default_role` mechanism, no new schema

No new LLM settings — reuses the existing endpoint/key/model/temperature.

**No new settings key either.** `accounts.default_role` is an existing, shipped column (`db/schema.sql`, `settings-ux-spec.md` §7, PR #47 2026-07-27) — a plain `VARCHAR`, not a DB-level enum, currently holding `NULL` / `'AP'` / `'Expense'` / `'FX Gain/Loss'` per account, single-holder-enforced server-side inside `coa.upsert`. It was added specifically to *replace* an older pattern of global settings keys (`default_ap_account`, `default_expense_account`) with one flag living on the account itself — introducing a fresh settings key here would reintroduce exactly the dual-source-of-truth problem that migration eliminated.

**Resolution: add a new `default_role` value — proposed `'Cash'`** — rather than a settings key. This costs:

- A third choice on the existing COA-tab dropdown (currently "—/AP/Expense"), alongside whatever selection mechanism already handles `'FX Gain/Loss'`.
- Extending `coa.upsert`'s existing single-holder enforcement to also cover the new value — mechanically identical to how `'AP'`/`'Expense'` are already handled, not new design.
- `buildJournalExtractionContext()` (§2.2) fetches it exactly the way `partner-proposal-spec.md` already fetches `default_ap_account` — `account.list` filtered by `default_role='Cash'`.

Zero schema migration — the column already exists and accepts any string.

**Naming — resolved as `Cash`, not `Clearing`.** `Clearing` reads as a suspense/holding account — the wrong economic description for what's actually happening on this line, which is a real cash, petty-cash, or bank outflow, not a transitional clearing entry. `Cash` matches the event and is immediately legible to an operator picking from the COA dropdown ("default cash account") without requiring them to infer what "clearing" refers to in this context.

## 8. What this spec does NOT do

- Does not implement receipt-vendor/partner resolution (§0 — not applicable to `journal_proposals`).
- Does not implement a learned-rule/crystallization mechanism for recurring receipt patterns (§0).
- Does not change `journal.propose`, `enrichAndValidate`, or `vat.js`.
- Does not add a stated-VAT-override field to `journal_proposals` — the mismatch check (§3.3) lives entirely in this extraction function's own flags, not in schema.
- Does not add UI for the new `'Cash'` `default_role` dropdown choice itself (§7) — that's a small COA-tab change, not part of this extraction spec.

## 9. Files changed (anticipated)

| File | Change |
|---|---|
| `api/src/agent-loop.js` | Add `processJournalDocument()`, `extractJournalDocumentData()`, `buildJournalExtractionContext()`, `buildJournalExtractionPrompt()`; triggers unconditionally per §1.1 — no existing-proposal check |
| `api/src/journal.js` | No change to `journal.propose`/`enrichAndValidate` themselves |
| `api/src/pages/payables-vendors.js` (or wherever the COA dropdown lives per settings-ux-spec §7) | Add `'Cash'` as a third `default_role` dropdown choice |
| `api/src/index.js` / `coa.upsert` handler | Extend existing single-holder enforcement to cover `default_role='Cash'` |
| `db/schema.sql` | No change — `accounts.default_role` already exists as a free-text column |

## 10. Open questions

1. **Duplicate-detection window** — §6 proposes same-day ±1 as a starting point; untested against real receipt-drop patterns (e.g. a recurring daily parking charge would need a tighter or amount-plus-description-specific window to avoid false-positive duplicate flags).
2. **Relationship to a future stated-VAT amendment on `p2-4a-vat-unify-spec.md` itself** (§3.3) — if document-sourced entries prove common enough that the flag-only treatment feels insufficient, the right fix is amending that spec's ratified decision, not building around it indefinitely here.
