# extractBillData() — AI Document Extraction for AP Intake

**Status:** IMPLEMENTED — revised 2026-08-26 after a second validation pass against live code (following a code fix between passes). The VAT double-counting bug from the previous pass is **confirmed fixed** (`_validateExtraction()` now converts gross→net, `processBill()` passes the converted amount). Two issues remain: the conversion mutates in place rather than preserving both `gross_amount` and `net_amount` (§3.3/§4.1), and the source-attachment link is still not persisted anywhere (§4.2, Open Question 4 — unchanged from the prior pass, not yet fixed).
**Depends on:** `agent-data-feeding-guide.md` §4.3 (folder→`entityType` routing this spec's trigger relies on), `b9-self-contained-agent-spec.md` (tier-4 LLM call pattern reused in §3.2), `bills-partner-fk-spec.md` (this spec's output maps directly onto `bills.partner_name`/`bills.partner_id`, §4.2), `partner-proposal-spec.md` (§6.2 Trigger B — the new-partner mechanism this spec feeds data into rather than reimplementing, §11.1), `p2-4a-vat-unify-spec.md` §1.4 (bills are tax-exclusive — line amounts are net; `vat_amount_stated` is a transient input field `bill.create` uses to reconcile against computed VAT, not a persisted column — confirmed directly against `bills.js` source, §3.3/§4.2).
**Context:** `extractBillData()` was originally a placeholder ported from the B7 script (B9 spec) and has since been fully implemented. This document was originally written to design that implementation; it's now been revalidated line-by-line against the actual deployed code, correcting both a bug in that code and several incorrect assumptions in the spec's own earlier drafts (see the Status line above and the inline corrections throughout).

## 0. Scope

**In scope:** extracting structured bill data (vendor, dates, currency, line items, VAT/GST, total) from a single uploaded attachment (PDF or image) dropped in `bills/`, producing a draft bill via `bill.create` for human review in the existing Inbox approval queue.

**Out of scope:**

- **No automatic posting.** Output is always a draft bill (`status='draft'`) — same posting/approval boundary as `journal_proposals`.
- **No silent partner creation.** Extraction proposes a partner match or flags "no match" (`needs_new_partner`); it never inserts into `partners` unattended. The new-partner path itself is not designed here — it's already fully specified in `partner-proposal-spec.md`'s Trigger B (§6.2); see the corrected §11.1.
- **No changes to the VAT engine.** Reuses `vat.js`'s existing tolerance mechanism rather than adding a parallel one.
- **No new LLM provider configuration.** Reuses the Settings/AI tab (`llm_endpoint_url`/`llm_api_key`/`llm_model`/`llm_temperature`) shipped in B9 — no provider dropdown, no vision-specific config.
- **No `receipts/`/`journal/` behavior.** Per `agent-data-feeding-guide.md` §4.3, both are already specified to route `Extract → journal.propose` — the pipeline isn't undefined, only the extraction function is unbuilt. That extractor targets a different output shape (balanced journal lines) than a bill's vendor/line-item/total shape, so it's a separate spec rather than an extension of this one.
- **No learning loop.** A `matching_history`-style correction loop for extraction is deferred until real dogfooding data exists (see prior discussion — prove the review pattern on AP before extending or automating further).
- **No UI/UX changes.** Extraction populates the existing draft-bill shape; any friction surfaced by dogfooding is a follow-on, scoped spec — not this one.

## 1. Function signature & pipeline position

Called from `processBill()` in `api/src/agent-loop.js`, triggered when an `attachment.upload` event with `entityType='bill'` appears (i.e., a file dropped in `bills/`):

```js
async function extractBillData(attachment, context, companySettings) {
  // attachment: { id, path, mime_type, sha256, company_id, entity_type }
  // context: { partners, accounts, vatCodes, currency, jurisdiction }
  // companySettings: { llm_endpoint_url, llm_api_key, llm_model, llm_temperature }
  // returns: ExtractionResult (see §4)
}
```

Runs once per new attachment event — not re-triggered on manual edit, matching the existing tier-4 "count-in == count-out" discipline elsewhere in the cascade.

## 2. Input assembly

### 2.1 Document read

Two content paths depending on `mime_type` (pdf/jpg/png — same whitelist as existing attachment handling):

- **PDF with an extractable text layer** → local text extraction (e.g. `pdf-parse`, no network call) → fed to the LLM as plain text.
- **Scanned PDF or image (jpg/png)** → base64-encoded and sent as an image content block to the configured endpoint.

Detecting scanned vs. text-native: check **per page**, not on the aggregated document. If every page's extracted character count is above a threshold (e.g. 40 chars), use the text path. If *any single page* falls under that threshold, treat the entire document as image-based and fall through to the image path — a multi-page PDF with a text-native cover page and scanned pages behind it must not be extracted from page 1 alone.

### 2.2 Context assembly — `buildBillExtractionContext()`

Parallel to the existing `buildTier4Context()` (reuse/refactor into a shared "company financial context" builder if convenient, not required):

- Partner master (`partners` where `is_vendor = TRUE`): `partner_id`, name, default currency, default expense account, default VAT code — so the model is steered toward matching existing vendor-flagged partners rather than inventing new ones. Filtering to `is_vendor = TRUE` matters, not just for prompt relevance: matching a customer-only partner would later trip the `INVALID_PARTNER_TYPE` guard at `bill.create` (`bills-partner-fk-spec.md` §5).
- Chart of accounts: expense-type accounts only (`accounts.type = 'expense'`, using the existing type column — no new classification logic needed), to keep the prompt small.
- VAT/GST codes: code, rate, reverse-charge flag.
- Company currency + jurisdiction (for tax-authority-specific terms — VAT vs. GST, "Moms" for SE).

## 3. Extraction call

### 3.1 Prompt — `buildBillExtractionPrompt()`

System prompt instructs the model to:

- Extract into the schema in §4.1.
- Match the extracted counterparty name against the supplied partner list (vendor-flagged partners only — fuzzy matching allowed, but flag ambiguity rather than silently picking between close candidates).
- Only assign a VAT/GST code if a rate is actually printed on the document — otherwise leave null and flag, never guess a tax treatment.
- Never invent a due date if none is printed.
- Report line items as **gross amounts, tax-inclusive** (as actually printed) — not net. An earlier draft of this spec assumed most invoices print net line amounts and asked the model to report net directly; that's an unverified assumption about document conventions, and asking the model to silently convert gross-to-net when a document happens to print gross would be exactly the "let the model do arithmetic" failure this spec otherwise avoids. Reporting gross-as-printed is a direct read regardless of the document's own convention, and the net conversion is computed deterministically in §3.3 — mirroring `extractJournalDocumentData()`'s already-correct pattern (`journal-document-extraction-spec.md` §3.3) exactly, rather than diverging from it.
- Report the invoice's own **stated VAT amount** if printed, separately — this becomes a transient field on the `bill.create` payload (§4.2), *not* a persisted `bills` column (there isn't one — confirmed directly against `bills.js`, see §4.2), and is not something this extraction function reconciles itself; that reconciliation already exists downstream in `createBill()`.
- Recognize reverse-charge language (e.g. "Reverse charge", "Omvänd betalningsskyldighet" for SE) as a distinct case from "no VAT code found" — these documents legitimately carry no printed rate. Set `reverse_charge_detected` rather than leaving the reviewer to see the same generic `no_vat_code_detected` flag they'd see for a genuinely incomplete document (see §4.1).
- Default every line's `expense_account` to the matched partner's `default_expense_account` (supplied in context, §2.2) and only override it where the document clearly indicates a different account — don't force a fresh choice among all expense accounts for every line. This narrows the decision space instead of asking the model to pick from the full chart on every line item.

### 3.2 Model call

Reuses the exact `fetch` pattern from `tier4LLMReason()` — same endpoint, same auth header, same `response_format: json_object` convention. No new settings keys.

`temperature` stays at the configured `llm_temperature` (default `0.1`) — this is a data-extraction task, not a creative one.

No pre-flight vision-capability check. If the configured model can't handle images, the call will typically error or return unusable JSON, which is caught by validation (§3.3) and routed to `input_rejections` with a clear reason — consistent with the "no instance lifecycle management" philosophy already established for the LLM provider (B9 §10).

### 3.3 Response validation (deterministic, no LLM trust)

The model's own `confidence` self-report (if any) is discarded entirely — every flag and the final `confidence` bucket (§4.1) are computed here, not taken from the prompt response.

**Partner match — deterministic, not LLM-judged.** If the model proposes a counterparty match, compute a string-similarity ratio (e.g. Levenshtein ratio) between the extracted name and candidate partners **restricted to `partners WHERE is_vendor = TRUE`** for this company — never match against a customer-only partner, since that would later trip the `INVALID_PARTNER_TYPE` guard at `bill.create` (`bills-partner-fk-spec.md` §5):
  - ratio ≥ 0.90 → clear match, set `partner_id`.
  - 0.70–0.89 → ambiguous: keep the proposed `partner_id` but set flag `ambiguous_partner_match` for review. This band does **not** trigger new-partner creation — a plausible match stays attached to the bill for a human to confirm or correct.
  - < 0.70 → treat as no match: `partner_id: null`, `needs_new_partner: true`. This is the only band that feeds the new-partner path — see the corrected §11.1, which points to `partner-proposal-spec.md`'s Trigger B rather than a new mechanism invented here.
  These thresholds are code constants, not a company setting — not something an operator needs to tune.

**Line-level checks (cheap, catch hallucinations early):**
  - Every line's `gross_amount` is a positive number (reject non-numeric/null/negative as a hard failure input for that line — it does not silently become 0).
  - At least one line is present; zero lines is a hard failure (§5.1).
  - Duplicate `description` values with different `amount`s are flagged (`duplicate_line_description`) — a common OCR failure mode where one line item gets split or misread as two.

**Totals — completeness check.** `sum(lines[].gross_amount)` (as reported per line — see §3.1) must equal the gross `total_stated` within tolerance (§7) — mismatch sets `total_mismatch`. This is a straightforward gross-vs-gross comparison; there is no net/gross mismatch to reconcile here because both sides are gross at this point in the pipeline. An earlier draft of this spec introduced a `net_subtotal_stated` field and a more elaborate two-branch check — that's retracted as unnecessary complexity once the per-line values stay consistently gross through this check, matching the simpler approach already verified in the deployed sibling function (`_validateJournalExtraction`'s `sumGross` check).

**Net conversion — the double-count bug is now fixed in deployed code, but introduced a new, narrower problem.** `bill.create`'s `lines[].amount` is treated as **net** by `bills.js` (`lineNet = lineAmount`, confirmed directly from source — `p2-4a-vat-unify-spec.md` §1.4). Every line above was validated as **gross**. The conversion:

```
net_i = round(gross_i / (1 + r_i), 2)     // when the line has a matched vat_code with rate r_i
net_i = gross_i                            // when no vat_code applies
```

is now implemented in `_validateExtraction()` (`agent-loop.js` lines 903–922, confirmed) — the double-counting bug from the previous validation pass is genuinely fixed; `processBill()` now passes the converted net amount through. **But the fix as deployed mutates `l.amount` from gross to net in place, rather than keeping both.** That destroys the original printed gross figure per line — after conversion, the only place the gross amount survives at all is buried in `raw_model_output`, not as a queryable structured field. **The required fix: preserve both.** `gross_amount` (as validated, tax-inclusive, matching what's printed) and `net_amount` (computed) must both be present on each line in `ExtractionResult.data.lines[]` — not one field silently overwritten by the other. This is cheap (one extra field per line) and the alternative — reconstructing a line's original gross amount by re-parsing `raw_model_output` — is exactly the kind of audit-trail loss this spec's `_extraction_meta`/prompt-snapshot retention (§4.2) exists to prevent elsewhere; losing it here via in-place mutation undercuts that same principle.

**VAT reconciliation itself is not this function's job.** `vat_amount_stated` is populated straight from the document (§3.1) and passed as a field on the `bill.create` payload — it is not a persisted column (§4.2). `createBill()` already reconciles it against computed VAT via `getVatTolerance()` (settings keys `vat_tolerance`/`vat_tolerance_pct`, default `0.50`/`0.01` — confirmed directly from `bills.js`): within tolerance, the stated figure is actually absorbed into the posted VAT amount (the delta lands on the largest computed tax line); outside tolerance, a warning is emitted but the bill still posts. Extraction does not duplicate any of this — it only supplies the input.

**Currency:** must be a valid ISO 4217 code (cross-checked against `db/currencies.json`).

**VAT/GST code:** must exist in this company's `vat_codes`; if the document's rate doesn't match any configured code, leave unset and flag `no_vat_code_detected` — unless reverse-charge language was detected (§3.1), in which case flag `reverse_charge_detected` instead, since that's an expected document shape, not a defect.

**Invoice date:** required, not merely nullable. A bill with no extractable invoice date cannot be assigned to an accounting period — treat a missing `invoice_date` as a hard failure (§5.1), same tier as missing total or currency.

**Confidence derivation (§4.1):** computed from flag count, not self-reported — `0` flags → `high`, `1` → `medium`, `2+` → `low`. Stated explicitly here so it lives in code, not in prompt-following behavior.

## 4. Output schema

### 4.1 `ExtractionResult`

`invoice_date`, `currency`, `total_stated`, and a non-empty `lines[]` are guaranteed non-null whenever `ok: true` — their absence is exactly what makes a result `ok: false` (§5.1) rather than a low-confidence draft. When `ok: false`, `data` is omitted entirely; the caller only needs the rejection reason for `input_rejections`, not a partial shape.

```js
{
  ok: true | false,
  confidence: 'high' | 'medium' | 'low',  // only meaningful when ok: true
  data: {
    partner_id: string | null,       // null is a valid, expected state — see §11.1
    partner_name_raw: string,        // maps directly onto bills.partner_name (bills-partner-fk-spec.md §3.1)
    needs_new_partner: boolean,
    currency: string,                // never null when ok: true
    invoice_number: string | null,   // genuinely optional — some documents omit it
    invoice_date: string,            // never null when ok: true (§3.3)
    due_date: string | null,         // genuinely optional
    lines: [
      {
        description: string,
        gross_amount: number,    // as validated in §3.3 — tax-inclusive, matches what's printed
        net_amount: number,      // computed in §3.3 from gross_amount and the matched vat_code's rate —
                                  // THIS is what bill.create's lines[].amount must receive, not gross_amount
        expense_account: string | null,
        vat_code: string | null,
        needs_review: boolean,
      }
    ],
    vat_amount_stated: number | null,    // printed VAT figure, if shown — NOT a persisted bills column;
                                          // passed as a transient field on the bill.create payload (§4.2),
                                          // reconciled against computed VAT by createBill() itself
    total_stated: number,                // the gross grand total — never null when ok: true
    total_computed: number,              // sum(lines[].gross_amount) — gross, for the §3.3 completeness check
  },
  flags: string[],           // 'total_mismatch' | 'ambiguous_partner_match' | 'no_vat_code_detected' |
                             // 'reverse_charge_detected' | 'duplicate_line_description' |
                             // 'possible_duplicate' (see §6) — confidence (above) is derived
                             // from this array's length per §3.3, never from the model itself.
  raw_model_output: object,  // retained for audit and for a future learning-loop spec, not shown by default
}
```

### 4.2 Mapping to `bill.create`

`processBill()` maps `ExtractionResult.data` onto `bill.create` with `status='draft'`. **`bill.create`'s `lines[].amount` receives each line's `net_amount`** — confirmed fixed in deployed code (`agent-loop.js` line 1233 passes the converted amount, following the in-place conversion in `_validateExtraction()` lines 903–922). The remaining fix is narrower than originally found: stop the in-place mutation and emit both `gross_amount` and `net_amount` as separate fields (§3.3), so `bill.create` still receives `net_amount` but the original gross figure isn't destroyed in the process. `partner_name_raw` and `partner_id` map directly onto `bills.partner_name` and `bills.partner_id` (`bills-partner-fk-spec.md` §3.1, §4) — no adapter needed; a `null` `partner_id` is the exact same accepted state as today's free-text vendor entry (`bills-partner-fk-spec.md` §0.2). `vat_amount_stated` is passed as a transient field on the `bill.create` payload — **there is no `bills.vat_amount_stated` column** (confirmed against `schema.sql` — no such column exists anywhere, including in later `ALTER TABLE` migrations); `createBill()` uses it only as an input to `getVatTolerance()`'s reconciliation, after which the (possibly adjusted) figure is posted into the existing `vat_amount` column. A new `_extraction_meta` field (already implemented as a side table, `bill_extraction_meta` — confirmed populated, see §9) stores model, confidence, flags, raw model output, **and the exact prompt + context sent** (not just the response) — without the input snapshot, a wrong extraction isn't reproducible and it's impossible to tell later whether a bad result came from a bad prompt/context or a model error. This also feeds the deferred learning-loop spec.

**Second confirmed gap, still unfixed as of this pass: the source-attachment link isn't persisted.** `processBill()` sets `_source_attachment_id`/`_source_filename` on the `bill` object (`agent-loop.js` lines 1238–1239) — but the `bills` table has no such columns anywhere in `schema.sql`, and they aren't written to `bill_extraction_meta` either. Both fields are silently dropped; there is still no way to look up which attachment produced a given bill. **Recommended fix, unchanged from the prior pass:** wire `replaceDraftId` through to `bill.create`, passing the attachment's existing `entityId` — this makes the bill's own id *the same id* the attachment was already uploaded under, preserving the link with no new column at all, and is more consistent with how underlag binding works elsewhere in this codebase (bank/journal proposals) than a bolt-on reference column would be.

## 5. Failure handling

### 5.1 Hard failures → `input_rejections` (existing table, same pattern as bank import's `checkCriticalData()`)

- No `llm_endpoint_url` configured → `no_llm_configured`.
- LLM call errors (timeout, 5xx, malformed JSON) → `extraction_failed`, raw error retained for operator debugging.
- No extractable total, currency, or **invoice date** → `missing_critical_data`. A bill with no date can't be assigned to an accounting period, so this is treated the same as a missing total, not left as a nullable field. These do **not** become draft bills — they surface as Class B inbox items, same as unmatched bank lines.
- Zero valid line items after line-level validation (§3.3) → `missing_critical_data`.

**One-shot semantics:** a hard failure is a *terminal* outcome for that attachment event, not a retry-eligible one. `input_rejections` is written and the event cursor (`agent_last_seq`) advances regardless of extraction outcome — a failed extraction does not get silently re-attempted on the next poll tick. Reprocessing only happens if a human drops a corrected file, which produces a new sha256 and therefore a genuinely new attachment/event, not a replay of the old one.

### 5.2 Soft failures → draft bill still created, `confidence='low'`, flags populated

Total mismatch, ambiguous partner match, missing VAT code, or any line marked `needs_review`. Drafts stay cheap; review is the safety net — this preserves the existing AP posture rather than introducing a new "silent guess" failure mode.

## 6. Duplicate / re-drop protection

Separate from the existing sha256 attachment dedup (which only catches an identical file re-dropped): a re-scanned or re-photographed version of the same invoice has a different hash but the same content.

After extraction, check for an existing non-voided bill matching `(partner_id, invoice_number, total_stated)` for this company. **This check must not assume `partner_id` is populated** — a `null` `partner_id` is an expected, accepted state (`bills-partner-fk-spec.md` §0.2; §11.1 below), and without a fallback, every bill from an unrecognized partner would silently bypass duplicate detection. When `partner_id` is null, match on `(partner_name_raw, invoice_number, total_stated)` instead.

On match: attach the new document to the existing bill instead of creating a second draft, and flag `possible_duplicate` rather than discarding outright — a genuine repeat charge from the same partner for the same amount (e.g. an identical recurring subscription) isn't actually rare.

## 7. Settings / configuration

No new LLM settings — reuses `llm_endpoint_url` / `llm_api_key` / `llm_model` / `llm_temperature` as-is.

**`bill_extraction_tolerance` is real, already implemented, and correctly shared with `extractJournalDocumentData()` — a prior draft of this spec incorrectly retracted it.** Checked directly against `agent-loop.js`: both `_validateExtraction` (bills) and `_validateJournalExtraction` (journal docs) read `companySettings.bill_extraction_tolerance` (default `'0.50'`) for their respective gross-vs-gross completeness checks. This is a distinct, legitimately separate mechanism from `bills.js`'s own `vat_tolerance`/`vat_tolerance_pct` settings (§3.3) — the two check different things (line-item completeness vs. stated-VAT reconciliation) and both existing side by side is correct, not duplicative. The name is slightly misleading now that it's shared across two extraction functions, but renaming a settings key already read in two places is a larger, separate change — not bundled into this correction.

| Key | Type | Default | Description |
|---|---|---|---|
| `bill_extraction_tolerance` | string (decimal) | `'0.50'` | Max allowed difference between sum(gross line amounts) and gross `total_stated` before flagging `total_mismatch`. Shared with `extractJournalDocumentData()`'s equivalent check. |

## 8. What this spec does NOT do

- Does not implement `receipts/` folder behavior (separate spec).
- Does not implement a correction learning loop — deferred until real dogfooding data exists.
- Does not change `bill.create`, the Inbox UI, or the draft-bill form.
- Does not add vision-capability negotiation with the LLM provider.
- Does not auto-create partners — always surfaces `needs_new_partner` for the mechanism `partner-proposal-spec.md` already owns (§11.1).

## 9. Files changed (confirmed against source, second pass)

| File | Change |
|---|---|
| `api/src/agent-loop.js` | ~~Fix `processBill()` line 1211~~ — **done**, confirmed (double-count bug fixed). **Remaining:** stop `_validateExtraction()`'s in-place `l.amount` gross→net mutation (lines 903–922); emit `gross_amount`/`net_amount` as separate fields instead. Decide and wire the source-attachment link (§4.2 — still unfixed; `_source_attachment_id`/`_source_filename` set at lines 1238–1239 but dropped, nothing persists them). |
| `api/src/bills.js` | No change — confirmed correct, the bug was entirely caller-side |
| `api/src/pages/settings.js` | No change — `bill_extraction_tolerance` confirmed shared correctly (§7) |
| `db/schema.sql` | Add a persisted column for the source-attachment reference, if that's the chosen fix over `replaceDraftId` (§4.2) |
| `api/package.json` | No change |

## 10. Open questions

1. ~~`_extraction_meta` storage~~ — **Resolved:** confirmed as a side table, `bill_extraction_meta`, populated correctly.
2. **Vision-capability signaling** — leave failures silent-and-flagged indefinitely, or add a manual capability checkbox to Settings/AI? Still genuinely open; no vision-capability handling exists either way in the current implementation.
3. ~~Exact existing tolerance constant/setting name~~ — **Resolved:** `companySettings.bill_extraction_tolerance` (default `'0.50'`), confirmed shared verbatim with `_validateJournalExtraction()`.
4. **Source-attachment persistence (§4.2) — confirmed still unfixed on this second pass.** Recommendation stands: wire `replaceDraftId` through to `bill.create` using the attachment's existing `entityId`, rather than adding a new reference column — more consistent with how underlag binding works elsewhere in this codebase. Not yet implemented as of this validation.
5. ~~Underlag binding — mechanism exists~~ — superseded by Open Question 4 above; the mechanism (`replaceDraftId`) is confirmed to exist, only its use in `processBill()` remains outstanding.
6. **`_extraction_meta` built from a simple evidence object, not the retained prompt/context snapshot, in the `partner.propose` trigger (§11.1).** Minor, lower priority than the above — the `evidence` payload `_maybeProposePartner()` receives (`agent-loop.js` lines 1291–1307) is a simple object rather than pulling from `_extraction_meta` as this spec describes. Worth a follow-up but not blocking.

## 11. Resolved decisions

### 11.1 `needs_new_partner` handling — no new mechanism; wires into the already-ratified `partner-proposal-spec.md` (revised 2026-08-24)

**This section originally proposed a new `vendor_proposals`/`vendor_suggestions` table and matching actions. That design is retracted.** `partner-proposal-spec.md` already specifies exactly this mechanism — more completely, with the partners-unification model, auto-learning, and both a bank-matching and a bill-extraction trigger — and its own dependency line names this spec explicitly for its Trigger B ("Bill extraction," §6.2, §2.3). The two documents were written to compose, not to duplicate each other; re-specifying the same concept under a different name here would produce two competing, drifting implementations. This spec's remaining job for the no-match case is narrow: hand `processBill()` the right data, correctly named, for the *existing* `partner.propose` call — not to invent a new approval path.

**What `extractBillData()` produces (already specified above, using partner terminology throughout):**

- `partner_id: string | null` — set only on a confident deterministic match (ratio ≥ 0.90, §3.3) against `partners WHERE is_vendor = TRUE`.
- `partner_name_raw: string` — always present, maps directly onto `bills.partner_name`.
- `needs_new_partner: boolean` — `true` only below the 0.70 ratio floor. The 0.70–0.89 ambiguous band does *not* set this — a plausible-but-unconfirmed match stays attached to the bill for human review; it does not also spawn a new-partner proposal.

**Composition with `partner-proposal-spec.md` §6.2 (Trigger B):** after `bill.create` returns (the draft already carries `partner_id: null`, `partner_name: <raw>`), `processBill()` reads `needs_new_partner` off the extraction result. If true, it calls `partner.propose` (role `agent`, per that spec's §4.2/§4.3) with:

| `partner.propose` param | Sourced from |
|---|---|
| `name` | `partner_name_raw` |
| `default_expense_account` | The extraction's suggested `expense_account`, if any (§4.1 `lines[]`) |
| `default_ap_account` | The company's default AP account (`account.list` filtered `default_role='AP'`) — fetched by `processBill()` itself, not part of extraction's output |
| `suggested_vat_code` | The extraction's `vat_code` field(s), if any |
| `evidence` | Built by `processBill()` from `_extraction_meta` (§4.2) — the retained raw model output and prompt/context snapshot is sufficient material |
| `source_bill_id` | The `bill_id` `bill.create` just returned |

This is `processBill()`'s responsibility, not `extractBillData()`'s — `extractBillData()` remains a pure extraction function with no knowledge of the proposal/approval machinery, consistent with its scope (§0). Duplicate-suppression before actually firing `partner.propose` (an existing partner already matching this name, or an already-pending proposal) is `partner-proposal-spec.md` §2.4's job unchanged — `processBill()` doesn't re-implement that check.
