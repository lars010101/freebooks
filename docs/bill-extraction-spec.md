# extractBillData() — AI Document Extraction for AP Intake

**Status:** DRAFT — proposed 2026-08-24, pending review
**Context:** `extractBillData()` was ported from the B7 script into `api/src/agent-loop.js` as part of B9, but flagged explicitly as "placeholder bill extraction (stays as placeholder)." This spec replaces the placeholder with a real implementation. It fills the one gap identified as highest-leverage after auditing the four intake folders (`bank/`, `bills/`, `receipts/`, `journal/`) — `bank/` has the full tier 1–4 cascade; `bills/` has the plumbing (`processBill()` → `bill.create`) but no actual document understanding; `receipts/` and `journal/` have no processing logic at all and are out of scope here.

## 0. Scope

**In scope:** extracting structured bill data (vendor, dates, currency, line items, VAT/GST, total) from a single uploaded attachment (PDF or image) dropped in `bills/`, producing a draft bill via `bill.create` for human review in the existing Inbox approval queue.

**Out of scope:**

- **No automatic posting.** Output is always a draft bill (`status='draft'`) — same posting/approval boundary as `journal_proposals`.
- **No silent vendor creation.** Extraction proposes a vendor match or flags "new vendor needed"; it never inserts into `vendors` unattended, consistent with `vendor.*` write actions being human-gated today.
- **No changes to the VAT engine.** Reuses `vat.js`'s existing tolerance mechanism rather than adding a parallel one.
- **No new LLM provider configuration.** Reuses the Settings/AI tab (`llm_endpoint_url`/`llm_api_key`/`llm_model`/`llm_temperature`) shipped in B9 — no provider dropdown, no vision-specific config.
- **No `receipts/` behavior.** `extractBillData()` is written to be reusable there, but receipts likely need "match against an existing bill/bank line" logic rather than "create a new bill" — that's a separate spec.
- **No learning loop.** A `matching_history`-style correction loop for extraction is deferred until real dogfooding data exists (see prior discussion — prove the review pattern on AP before extending or automating further).
- **No UI/UX changes.** Extraction populates the existing draft-bill shape; any friction surfaced by dogfooding is a follow-on, scoped spec — not this one.

## 1. Function signature & pipeline position

Called from `processBill()` in `api/src/agent-loop.js`, triggered when an `attachment.upload` event with `entityType='bill'` appears (i.e., a file dropped in `bills/`):

```js
async function extractBillData(attachment, context, companySettings) {
  // attachment: { id, path, mime_type, sha256, company_id, entity_type }
  // context: { vendors, accounts, vatCodes, currency, jurisdiction }
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

- Vendor master: id, name, default currency, default expense account, default VAT code — so the model is steered toward matching existing vendors rather than inventing new ones.
- Chart of accounts: expense-type accounts only (`accounts.type = 'expense'`, using the existing type column — no new classification logic needed), to keep the prompt small.
- VAT/GST codes: code, rate, reverse-charge flag.
- Company currency + jurisdiction (for tax-authority-specific terms — VAT vs. GST, "Moms" for SE).

## 3. Extraction call

### 3.1 Prompt — `buildBillExtractionPrompt()`

System prompt instructs the model to:

- Extract into the schema in §4.1.
- Match vendor name against the supplied vendor list (fuzzy matching allowed, but flag ambiguity rather than silently picking between close candidates).
- Only assign a VAT/GST code if a rate is actually printed on the document — otherwise leave null and flag, never guess a tax treatment.
- Never invent a due date if none is printed.
- Report line items and the stated total as printed — don't let the model do the arithmetic; that's checked deterministically in §3.3.
- Recognize reverse-charge language (e.g. "Reverse charge", "Omvänd betalningsskyldighet" for SE) as a distinct case from "no VAT code found" — these documents legitimately carry no printed rate. Set `reverse_charge_detected` rather than leaving the reviewer to see the same generic `no_vat_code_detected` flag they'd see for a genuinely incomplete document (see §4.1).
- Default every line's `expense_account` to the vendor's `default_expense_account` (supplied in context, §2.2) and only override it where the document clearly indicates a different account — don't force a fresh choice among all expense accounts for every line. This narrows the decision space instead of asking the model to pick from the full chart on every line item.

### 3.2 Model call

Reuses the exact `fetch` pattern from `tier4LLMReason()` — same endpoint, same auth header, same `response_format: json_object` convention. No new settings keys.

`temperature` stays at the configured `llm_temperature` (default `0.1`) — this is a data-extraction task, not a creative one.

No pre-flight vision-capability check. If the configured model can't handle images, the call will typically error or return unusable JSON, which is caught by validation (§3.3) and routed to `input_rejections` with a clear reason — consistent with the "no instance lifecycle management" philosophy already established for the LLM provider (B9 §10).

### 3.3 Response validation (deterministic, no LLM trust)

The model's own `confidence` self-report (if any) is discarded entirely — every flag and the final `confidence` bucket (§4.1) are computed here, not taken from the prompt response.

**Vendor match — deterministic, not LLM-judged.** If the model proposes a `vendor_id`, compute a string-similarity ratio (e.g. Levenshtein ratio) between `vendor_name_raw` and that vendor's stored name:
  - ratio ≥ 0.90 → clear match, accept `vendor_id`.
  - 0.70–0.89 → ambiguous: keep the proposed `vendor_id` but set flag `ambiguous_vendor` for review.
  - < 0.70 → treat as no match: `vendor_id: null`, `needs_new_vendor: true` (routes to `vendor.propose`, §11.1).
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
    vendor_id: string | null,        // null is a valid, expected state — see §11.1
    vendor_name_raw: string,
    needs_new_vendor: boolean,
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
  flags: string[],           // 'total_mismatch' | 'ambiguous_vendor' | 'no_vat_code_detected' |
                             // 'reverse_charge_detected' | 'duplicate_line_description' |
                             // 'possible_duplicate' (see §6) — confidence (above) is derived
                             // from this array's length per §3.3, never from the model itself.
  raw_model_output: object,  // retained for audit and for a future learning-loop spec, not shown by default
}
```

### 4.2 Mapping to `bill.create`

`processBill()` maps `ExtractionResult.data` onto `bill.create` with `status='draft'`. A new `_extraction_meta` field (parallel to `journal_proposals._match_meta`) stores model, confidence, flags, raw model output, **and the exact prompt + context sent** (not just the response) — without the input snapshot, a wrong extraction isn't reproducible and it's impossible to tell later whether a bad result came from a bad prompt/context or a model error. This also feeds the deferred learning-loop spec.

## 5. Failure handling

### 5.1 Hard failures → `input_rejections` (existing table, same pattern as bank import's `checkCriticalData()`)

- No `llm_endpoint_url` configured → `no_llm_configured`.
- LLM call errors (timeout, 5xx, malformed JSON) → `extraction_failed`, raw error retained for operator debugging.
- No extractable total, currency, or **invoice date** → `missing_critical_data`. A bill with no date can't be assigned to an accounting period, so this is treated the same as a missing total, not left as a nullable field. These do **not** become draft bills — they surface as Class B inbox items, same as unmatched bank lines.
- Zero valid line items after line-level validation (§3.3) → `missing_critical_data`.

**One-shot semantics:** a hard failure is a *terminal* outcome for that attachment event, not a retry-eligible one. `input_rejections` is written and the event cursor (`agent_last_seq`) advances regardless of extraction outcome — a failed extraction does not get silently re-attempted on the next poll tick. Reprocessing only happens if a human drops a corrected file, which produces a new sha256 and therefore a genuinely new attachment/event, not a replay of the old one.

### 5.2 Soft failures → draft bill still created, `confidence='low'`, flags populated

Total mismatch, ambiguous vendor, missing VAT code, or any line marked `needs_review`. Drafts stay cheap; review is the safety net — this preserves the existing AP posture rather than introducing a new "silent guess" failure mode.

## 6. Duplicate / re-drop protection

Separate from the existing sha256 attachment dedup (which only catches an identical file re-dropped): a re-scanned or re-photographed version of the same invoice has a different hash but the same content.

After extraction, check for an existing non-voided bill matching `(vendor_id, invoice_number, total_stated)` for this company. **This check must not assume `vendor_id` is populated** — §11.1 establishes that `vendor_id` can legitimately be `null` while a vendor proposal is pending, and without a fallback, every bill from an unrecognized vendor would silently bypass duplicate detection. When `vendor_id` is null, match on `(vendor_name_raw, invoice_number, total_stated)` instead.

On match: attach the new document to the existing bill instead of creating a second draft, and flag `possible_duplicate` rather than discarding outright — a genuine repeat charge from the same vendor for the same amount (e.g. an identical recurring subscription) isn't actually rare.

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
- Does not auto-create vendors — always surfaces `needs_new_vendor` for a human decision.

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

## 11. Resolved decisions

### 11.1 `needs_new_vendor` handling — separate approval queue (resolved 2026-08-24)

A `needs_new_vendor` result does **not** fold into the draft-bill review screen. It's modeled as its own approvable item, consistent with the existing pattern used by `journal_proposals`, `mapping_suggestions`, and `input_rejections` — all first-class, independently actionable, and surfaced through the existing unified Inbox (`inbox.list`) rather than embedded in whatever screen produced them. This keeps the approval workflow decoupled from the current draft-bill UI, which may change independently.

**New table — `vendor_proposals`:**

| Column | Purpose |
|---|---|
| `id` | Proposal id |
| `company_id` | Scope |
| `vendor_name_raw` | As extracted from the document |
| `suggested_defaults` | JSON — proposed currency, expense account, VAT code (editable at approval time) |
| `source_attachment_id` | The document that triggered this proposal |
| `status` | `proposed` / `approved` / `rejected` |
| `created_at`, `resolved_at`, `resolved_by` | Audit trail |

**New actions** (naming parallels `journal.propose`/`mapping.suggest`):

| Action | Min. role | Behavior |
|---|---|---|
| `vendor.propose` | `agent` | Creates a `vendor_proposals` row from `extractBillData()`'s `needs_new_vendor` output |
| `vendor.propose.approve` | `data_entry` | Creates the vendor from `suggested_defaults` (editable), marks `approved`, back-fills `vendor_id` on every linked draft bill **that is not voided or deleted** — a bill removed between proposal creation and approval is skipped and logged, not silently left dangling |
| `vendor.propose.reject` | `data_entry` | Marks `rejected`; linked bill(s) keep `vendor_id: null` and require a human to assign an *existing* vendor via the normal bill-edit flow |

**Bill linkage while pending:** `bill.create` is still called immediately with `vendor_id: null`; the bill's `_extraction_meta` carries `pending_vendor_proposal_id`. The draft bill sits in the Inbox as a bill with an unresolved dependency — it isn't blocked from existing, just from being complete.

**Deduplication:** Before creating a new proposal, check for an existing `proposed`-status row with a matching (fuzzy) `vendor_name_raw` for the company; if found, link the new bill to that proposal instead of creating a second one. This directly reuses the conflict-detection approach `mapping_suggestions` already applies via `detectMappingConflicts`, rather than introducing a new dedup mechanism.

**Surfacing:** New Class B item type in the existing Inbox aggregator (`inbox.list`) — no new page, no new nav entry.
