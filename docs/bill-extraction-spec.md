# extractBillData() — AI Document Extraction for AP Intake

**Status:** DRAFT — proposed 2026-08-24, revised 2026-08-24 (partner terminology corrected; §11.1 superseded by `partner-proposal-spec.md`)
**Depends on:** `agent-data-feeding-guide.md` §4.3 (folder→`entityType` routing this spec's trigger relies on), `b9-self-contained-agent-spec.md` (tier-4 LLM call pattern reused in §3.2), `bills-partner-fk-spec.md` (this spec's output maps directly onto `bills.partner_name`/`bills.partner_id`, §4.2), `partner-proposal-spec.md` (§6.2 Trigger B — the new-partner mechanism this spec feeds data into rather than reimplementing, §11.1).
**Context:** `extractBillData()` was ported from the B7 script into `api/src/agent-loop.js` as part of B9, but flagged explicitly as "placeholder bill extraction (stays as placeholder)." This spec replaces the placeholder with a real implementation. Per `docs/agent-data-feeding-guide.md` §4.3, all four intake folders have a defined `entityType`/processing path — `bank/` has the full tier 1–4 cascade already implemented; `bills/` has the plumbing (`processBill()` → `bill.create`) but no extraction logic; `receipts/` and `journal/` are specified to go `Extract → journal.propose`, but that extraction function doesn't exist yet either. This spec covers `bills/` only — `receipts/`/`journal/` need a differently-shaped extractor (balanced journal lines, not vendor/line-item/total) and are left for a follow-on spec.

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
- Report line items and the stated total as printed — don't let the model do the arithmetic; that's checked deterministically in §3.3.
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
  - Every line's `amount` is a positive number (reject non-numeric/null/negative as a hard failure input for that line — it does not silently become 0).
  - At least one line is present; zero lines is a hard failure (§5.1).
  - Duplicate `description` values with different `amount`s are flagged (`duplicate_line_description`) — a common OCR failure mode where one line item gets split or misread as two.

**Totals:** `sum(lines[].amount)` must equal `total_stated` within `bill_extraction_tolerance` (§7) — mismatch sets `total_mismatch`, not silently accepted.

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
        amount: number,
        expense_account: string | null,
        vat_code: string | null,
        needs_review: boolean,
      }
    ],
    total_stated: number,
    total_computed: number,
  },
  flags: string[],           // 'total_mismatch' | 'ambiguous_partner_match' | 'no_vat_code_detected' |
                             // 'reverse_charge_detected' | 'duplicate_line_description' |
                             // 'possible_duplicate' (see §6) — confidence (above) is derived
                             // from this array's length per §3.3, never from the model itself.
  raw_model_output: object,  // retained for audit and for a future learning-loop spec, not shown by default
}
```

### 4.2 Mapping to `bill.create`

`processBill()` maps `ExtractionResult.data` onto `bill.create` with `status='draft'`. `partner_name_raw` and `partner_id` map directly onto `bills.partner_name` and `bills.partner_id` (`bills-partner-fk-spec.md` §3.1, §4) — no adapter needed; a `null` `partner_id` is the exact same accepted state as today's free-text vendor entry (`bills-partner-fk-spec.md` §0.2). A new `_extraction_meta` field (parallel to `journal_proposals._match_meta`) stores model, confidence, flags, raw model output, **and the exact prompt + context sent** (not just the response) — without the input snapshot, a wrong extraction isn't reproducible and it's impossible to tell later whether a bad result came from a bad prompt/context or a model error. This also feeds the deferred learning-loop spec.

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

One new company-level setting, matching the existing VAT-tolerance pattern:

| Key | Type | Default | Description |
|---|---|---|---|
| `bill_extraction_tolerance` | string (decimal) | `'0.50'` | Max allowed difference between stated and computed total before flagging `total_mismatch` |

Default mirrors the shape of the ratified VAT tolerance (`max(0.50, 1%)`) rather than a flat near-zero value — bills go through OCR/vision extraction, and a flat `0.01` would flag routine rounding (e.g. `1,234.50` read as `1,234.49`) as a mismatch. This is a distinct setting from VAT tolerance, not a shared one, since bill totals and VAT amounts are different quantities with different sources of error.

## 8. What this spec does NOT do

- Does not implement `receipts/` folder behavior (separate spec).
- Does not implement a correction learning loop — deferred until real dogfooding data exists.
- Does not change `bill.create`, the Inbox UI, or the draft-bill form.
- Does not add vision-capability negotiation with the LLM provider.
- Does not auto-create partners — always surfaces `needs_new_partner` for the mechanism `partner-proposal-spec.md` already owns (§11.1).

## 9. Files changed (anticipated)

| File | Change |
|---|---|
| `api/src/agent-loop.js` | Replace placeholder `extractBillData()`; add `buildBillExtractionContext()`, `buildBillExtractionPrompt()` |
| `api/src/bills.js` | No change to `bill.create` itself; `processBill()` passes `_extraction_meta` through |
| `api/src/pages/settings.js` | Add `bill_extraction_tolerance` field near the existing VAT tolerance setting |
| `db/schema.sql` | Add `_extraction_meta` (JSON) — column vs. side table, see Open Question 1 |
| `api/package.json` | Add a PDF text-extraction dependency (e.g. `pdf-parse`) |

## 10. Open questions

1. **`_extraction_meta` storage** — inline JSON column on `bills`, or a separate `bill_extraction_meta` side table keyed by `bill_id`? `journal_proposals` uses an inline column, but `bills` is a larger, more heavily-touched table — a side table may avoid migration risk.
2. **Vision-capability signaling** — leave failures silent-and-flagged indefinitely (per the "no instance lifecycle management" precedent), or add a manual "this model supports images" checkbox to the Settings/AI tab to short-circuit doomed attempts? Leaning toward leaving it as-is; flagging for confirmation.
3. **Tolerance setting placement** — alongside VAT tolerance, or its own field once an AP settings section exists? Cosmetic.
4. **Underlag binding for `bill.create`.** `agent-data-feeding-guide.md`'s event table states attachment processing happens "with the same `proposalId` for underlag binding" across all four folder types, and the drop-folder watcher (§4.3) mints a UUID as `entityId` at upload time uniformly — including for `bills/`. But §4.5b never actually specifies how that pre-minted id reconciles with the bill `bill.create` produces: does `bill.create` accept a client-supplied id (so the attachment's existing `entityId` becomes the bill's id, and the binding just carries over), or does it return a new `bill_id` requiring an explicit re-bind step — the way bank-statement lines are explicitly re-uploaded under each `proposalId` (§4.3)? This needs to be checked against the actual `bill.create` implementation before `processBill()` is written, not assumed either way — get it wrong and the source invoice image silently stops being retrievable as underlag for the bill it produced.

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
