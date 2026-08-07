# Bill / Receipt Extraction — Layered `extractBillData()`

**Date:** 2026-08-07 · **Status:** RATIFIED (magnus 2026-08-07 — all 4 open questions resolved, §13)
**Scope:** Replace the `extractBillData()` stub in `api/src/agent-loop.js` (line 473) with a layered extraction that reads supplier-invoice PDFs/images and fills in a `bill.create` draft without any human typing. Builds on the B9 in-process agent pipeline and the bills routing in `agent-data-feeding-guide.md §4.5b` (Option C).

## 1. Problem

`extractBillData(att, payload)` is currently a stub:

```js
function extractBillData(att, payload) {
  warn(`bill ${payload.filename || att.filename}: extraction not implemented — creating skeleton draft`);
  return {
    currency: null, lines: [],
    _source_attachment_id: payload.entityId || null,
    _source_filename: payload.filename || att.filename || null,
  };
}
```

Every dropped bill becomes a skeleton draft. The human opens the inbox item, retypes vendor / amount / date / lines from the PDF by hand, then posts. For the common B2B case — a **digital-origin PDF** with an embedded text layer — this is pure manual transcription that a model can do. The gap is extraction, not routing: the `bill → processBill → bill.create` (draft) path already exists and is ratified (§4.5b). The stub just feeds it nothing.

This spec adds extraction. It does **not** change routing, the drop-folder watcher, `bill.create` params, the inbox `bill_draft` type, or the tier-4 bank-statement LLM path.

## 2. Design principles

1. **Layered, fail-soft, no new mandatory config.** Layer 1 (local PDF text + existing LLM) needs zero new settings and handles the common digital-PDF case. Layers 2–3 only activate when layer 1 finds nothing. A company with just the existing `llm_*` config gets working extraction today; vision is opt-in.

2. **Reuse the existing LLM call shape.** Layer 1 uses the same OpenAI-compatible `POST {endpoint}/v1/chat/completions` with `response_format: { type: 'json_object' }` as `tier4LLMReason()` (agent-loop.js:253–312). Same `fetch`, same auth header, same temperature, same model. No new HTTP client, no new SDK.

3. **Extraction proposes; the human posts.** Output of `extractBillData()` is a `bill` object handed to the existing `bill.create` (agent actor → `saveDraftBill`, bills.js:109). The draft lands in the inbox as `bill_draft` (agent-readiness-spec §10.2); `y` posts it. Extraction never posts, never validates strictly — an LLM that guesses a wrong account code still produces a draft a human can fix. This preserves the "approve is the post" gate from §4.5b.

4. **Skeleton is the floor, not an error.** If every layer fails or no LLM is configured, `extractBillData()` returns the current skeleton (§6.3). The bill still appears in the inbox; the human fills it. Failure of extraction must never block bill intake.

5. **Vision is a separate provider, not an upgrade to the text LLM.** A company may use a cheap text model for tier-4 residual matching and a vision-capable model for bill images (or none). Vision config is three new per-company settings rows, fully optional. If unset, layer 2 is skipped entirely (not retried with the text endpoint).

6. **No system dependencies.** Layer 1 uses `pdf-parse` (pure-JS npm package, no `pdftotext`/system binary). Keeps the "clone + npm install + run" deployment story unchanged.

## 3. Architecture overview

```
attachment.uploaded (entityType: bill)
        │
        ▼
processBill(ev, companyId, agentEmail, companySettings)        ── unchanged (agent-loop.js:482)
        │  fetchAttachment(entity_id) → { contentType, filename, buffer, text }
        ▼
extractBillData(att, payload, companySettings, companyId, agentEmail)   ── NEW (replaces stub)
        │
        ├─ Layer 1: local PDF text → text LLM   (digital PDFs)
        ├─ Layer 2: vision LLM (base64 image)    (scanned PDFs, JPG/PNG)
        └─ Layer 3: skeleton draft (current stub)  (fallback)
        │
        ▼  returns a bill object
bill.create  (agent actor → saveDraftBill)    ── unchanged (bills.js:109)
        │
        ▼
inbox: type='bill_draft', verbs ['y','x']    ── unchanged
```

`extractBillData()` becomes `async` (it was sync; the stub had no I/O). `processBill()` already `await`s it implicitly through `_dispatchAction` — actually it calls `extractBillData` synchronously on line 492; that call gains `await`. No other caller.

## 4. Settings — new per-company keys

Three new rows in the existing `settings` table (key-value, per-company), stored/saved via the existing `settings.get` / `settings.save` actions (B9 spec §1). No new API actions.

| Key | Type | Default | Description |
|---|---|---|---|
| `llm_vision_endpoint_url` | string | (empty) | OpenAI-compatible vision endpoint URL. Empty → layer 2 disabled (fall through to layer 3). |
| `llm_vision_model` | string | (empty) | Vision-capable model name (e.g. `gpt-4o-mini`, `qwen2-vl-7b-instruct`). Empty → layer 2 disabled. |
| `llm_vision_api_key` | string | (empty) | Bearer token for the vision endpoint. **Empty → reuse `llm_api_key`** (same provider, different model is the common case). |

Layer 2 is considered **configured** iff `llm_vision_endpoint_url` AND `llm_vision_model` are both non-empty. `llm_vision_api_key` falling back to `llm_api_key` is intentional — most deployments use one provider/key for both text and vision, just different model names.

These join the existing `llm_endpoint_url`, `llm_api_key`, `llm_model`, `llm_temperature` rows (B9 spec §1 table). Same CRUD path, same Settings/AI tab.

## 5. Settings/AI tab UI (`api/src/pages/settings.js`)

Add a new subsection under the existing "LLM provider" block (settings.js:220–249), titled **"Vision LLM (bill/receipt image extraction)"**. Three rows mirroring the existing LLM provider table:

```html
<div style="...same panel styling as the LLM provider block...">
  <div style="font-size:10pt;color:#333;margin-bottom:8px">
    <strong>Vision LLM</strong> — OpenAI-compatible vision-capable endpoint for bill/receipt
    image extraction (scanned PDFs and JPG/PNG). Optional — leave blank to disable image
    extraction; digital PDFs still extract via the text LLM above.
  </div>
  <table class="edit-table" style="background:transparent">
    <tbody>
      <tr>
        <td style="white-space:nowrap">Vision endpoint URL</td>
        <td><input type="text" id="ai-vision-endpoint" style="width:400px"
            placeholder="https://api.openai.com or http://127.0.0.1:8080"
            onchange="markDirty('ai')"></td>
      </tr>
      <tr>
        <td style="white-space:nowrap">Vision model</td>
        <td><input type="text" id="ai-vision-model" style="width:300px"
            placeholder="gpt-4o-mini" onchange="markDirty('ai')"></td>
      </tr>
      <tr>
        <td style="white-space:nowrap">Vision API key</td>
        <td><input type="password" id="ai-vision-key" style="width:400px"
            placeholder="(optional — leave blank to reuse the LLM API key)"
            onchange="markDirty('ai')"></td>
      </tr>
    </tbody>
  </table>
</div>
```

**`loadAiSettings()`** (settings.js:1155) gains three lines:
```js
document.getElementById('ai-vision-endpoint').value = s.llm_vision_endpoint_url || '';
document.getElementById('ai-vision-model').value   = s.llm_vision_model || '';
document.getElementById('ai-vision-key').value    = s.llm_vision_api_key || '';
```

**`saveAiSettings()`** (settings.js:1183) gains three keys in the `settings` object:
```js
llm_vision_endpoint_url: document.getElementById('ai-vision-endpoint').value,
llm_vision_model:        document.getElementById('ai-vision-model').value,
llm_vision_api_key:      document.getElementById('ai-vision-key').value,
```

No new tab, no new save button — the existing "Save AI settings" button persists all rows together.

## 6. Layered extraction — `extractBillData()`

### 6.0 Signature and inputs

```js
async function extractBillData(att, payload, companySettings, companyId, agentEmail)
```

`processBill()` (agent-loop.js:491–492) passes `companySettings`, `companyId`, `agentEmail` through (it already has all three). `att` is the `fetchAttachment` result: `{ contentType, filename, buffer, text }` (index.js:1754). `payload` is `{ entityId, filename, contentType }`.

The function returns a `bill` object (the shape `bill.create`'s `saveDraftBill` expects — §7) or throws on an internal bug; it never returns `null` (the skeleton is the floor, so `processBill`'s `if (!bill) return` guard at line 493 stays as a defensive no-op).

### 6.1 Layer 1 — local PDF text → text LLM (digital PDFs)

**Trigger:** `contentType` is `application/pdf` (or `.pdf`/`.PDF` filename). JPG/PNG skip straight to layer 2.

**Step 1a — extract embedded text.** Use `pdf-parse` (pure JS, no system deps):

```js
const pdfParse = require('pdf-parse');
let text = '';
try {
  const parsed = await pdfParse(att.buffer);
  text = (parsed.text || '').trim();
} catch (e) {
  warn(`bill ${filename}: pdf-parse failed: ${e.message} — trying vision layer`);
  // fall through to layer 2
}
```

If `text.length < 50` (heuristic: a real invoice has at least a vendor name + an amount; scanned PDFs yield empty/garbage), treat as "no usable text" and fall through to layer 2. The 50-char floor is deliberately low — it exists to reject the empty-buffer case, not to be a quality gate.

**Step 1b — text LLM extraction.** Only if text was found AND `llm_endpoint_url` is configured (the same gate as `tier4LLMReason`, agent-loop.js:255). Reuse the existing LLM call pattern verbatim — same `fetch`, same auth header construction, same `response_format: { type: 'json_object' }`, same `temperature: parseFloat(llm_temperature || '0.1')`, same `model: llm_model || 'default'`:

```js
const url = companySettings.llm_endpoint_url;
if (!url) {
  // no text LLM configured → skip to layer 2 (vision), or 3 if no vision either
} else {
  const systemPrompt = buildBillExtractionPrompt(coa, vatCodes);   // §8
  const userPrompt = text;
  const response = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model, messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      temperature: parseFloat(companySettings.llm_temperature || '0.1'),
      response_format: { type: 'json_object' },
    }),
  });
  // ... same ok-check, content extraction, JSON.parse as tier4LLMReason (§6.4)
}
```

If layer 1 returns a parsed bill object → return it. If the text LLM is not configured, or the call throws, or JSON is unparseable → fall through to layer 2 (do not return the skeleton yet — vision may still work).

### 6.2 Layer 2 — vision LLM (scanned PDFs and images)

**Trigger:** layer 1 found no text (scanned PDF) OR the file is an image (`image/jpeg`, `image/png`, or `.jpg/.jpeg/.png` filename). AND layer 2 is configured (`llm_vision_endpoint_url` AND `llm_vision_model` both non-empty).

If layer 2 is not configured → fall through to layer 3.

**Step 2a — base64-encode the file.** Use the raw `att.buffer` (already loaded by `fetchAttachment`, index.js:1753). Determine the MIME type for the data URL from `att.contentType` (fall back to `application/octet-stream`):

```js
const b64 = att.buffer.toString('base64');
const dataUrl = `data:${att.contentType};base64,${b64}`;
```

For scanned PDFs, vision models that accept PDF input natively can take the PDF bytes directly; models that don't will simply fail to extract and layer 3 catches it. We do not pre-rasterize PDFs to images in-process (that needs a system dep — violates principle 6). The data URL uses the actual content type; the model/provider decides whether it can read it.

**Step 2b — vision LLM call.** OpenAI-compatible chat/completions with an image content part in the user message (the standard `image_url` content-type block):

```js
const vUrl  = companySettings.llm_vision_endpoint_url;
const vModel = companySettings.llm_vision_model;
const vKey  = companySettings.llm_vision_api_key || companySettings.llm_api_key || '';
const systemPrompt = buildBillExtractionPrompt(coa, vatCodes);   // §8 — same prompt as layer 1
const response = await fetch(`${vUrl.replace(/\/$/, '')}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(vKey ? { 'Authorization': `Bearer ${vKey}` } : {}),
  },
  body: JSON.stringify({
    model: vModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: [
        { type: 'text', text: 'Extract the bill data from this document image.' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ] },
    ],
    temperature: parseFloat(companySettings.llm_temperature || '0.1'),
    response_format: { type: 'json_object' },
  }),
});
```

Same ok-check / content-extraction / JSON.parse as layer 1 (§6.4). On success → return the bill object. On any failure → layer 3.

### 6.3 Layer 3 — skeleton draft (fallback, current behavior)

If both layers fail or no LLM is configured, return the current skeleton with a warning:

```js
warn(`bill ${filename}: extraction failed (no text, no vision, or LLM error) — creating skeleton draft`);
return {
  currency: null, lines: [],
  _source_attachment_id: payload.entityId || null,
  _source_filename: payload.filename || att.filename || null,
};
```

The bill still appears in the inbox; the human fills it manually. `saveDraftBill` already tolerates `vendor`/`date` being null (bills.js:867 — "vendor and date optional — allows skeleton draft creation on row init").

### 6.4 Shared LLM response handling (layers 1 and 2)

Identical to `tier4LLMReason()` (agent-loop.js:282–311):

```
- response.ok === false  → warn(`bill: LLM HTTP ${status}: ${body.slice(0,200)}`); fall through
- data.choices[0].message.content missing → warn('bill: empty LLM response'); fall through
- JSON.parse(content) throws → warn(`bill: non-JSON response: ${content.slice(0,200)}`); fall through
- parsed object lacks vendor/amount/lines → warn('bill: LLM JSON missing required fields'); fall through
- otherwise → normalize to bill.create shape (§7) and return
```

"Fall through" = proceed to the next layer (1→2→3), not throw.

## 7. Output normalization — `bill.create` draft shape

The LLM returns the JSON described in §8. `extractBillData()` maps it to the object `bill.create` (via `saveDraftBill`, bills.js) expects. Required/used fields, with the LLM key in parentheses:

| `bill` field | Source | Notes |
|---|---|---|
| `vendor` | `vendor` | Required by validation if amount present; null allowed for skeleton. |
| `vendor_ref` | `vendor_invoice_number` (optional) | The supplier's invoice/reference number. |
| `date` | `bill_date` | ISO `YYYY-MM-DD`. Null for skeleton. |
| `due_date` | `due_date` | ISO `YYYY-MM-DD` or null. |
| `currency` | `currency` | ISO 4217 (e.g. `SEK`, `EUR`). Falls back to company currency if absent. |
| `amount` | `amount` | Total bill amount (tax-inclusive). Computed from `lines` sum if absent (server recompute, bills.js:880). |
| `expense_account` | first line's `account_code_hint` | Single-line fallback; multi-line uses `lines[].expense_account`. |
| `ap_account` | (server default) | Leave null — `applyCompanyDefaults` (bills.js:48) fills it. |
| `vat_code` | first line's `vat_code` | Bill-level VAT for the single-line case. |
| `vat_amount` | sum of line VAT, or LLM `vat_amount` | Stated bill-level VAT total if the LLM provides one; else 0 (drafts tolerate 0, bills.js:954). |
| `description` | `notes` (optional) | Free text. |
| `lines` | `lines[]` | Each: `{ expense_account: account_code_hint, amount, vat_code, description, quantity?, unit_price?, vat_rate? }`. Server recompute of totals from lines (bills.js:880) means the LLM's `amount` per line is the source of truth for the draft's displayed total. |
| `_source_attachment_id` | payload.entityId | Carried through for attachment linkage (existing skeleton behavior). |
| `_source_filename` | payload.filename | Same. |

Fields the LLM cannot reliably produce (cost_center, profit_center, fx_rate) are left null; server defaults + human review fill them. The draft is explicitly a **proposal**, not a final entry — `account_code_hint` and `vat_code` are *suggestions* the human reviews before `y` (post).

**Tolerance:** the server already validates drafts leniently (vendor/date optional for skeleton init, bills.js:867). An LLM that returns a non-existent account code does **not** fail `extractBillData()` — it produces a draft with a bad hint; the human fixes it in the inbox or `bill.draft.post` validation catches it at post time. Extraction's job is to save typing, not to guarantee a postable bill.

## 8. Structured extraction prompt (shared, layers 1 and 2)

One `buildBillExtractionPrompt(coa, vatCodes)` function produces the system prompt for both layers — only the user-message content differs (text vs. image). Model it on `buildTier4Prompt()` (agent-loop.js:234):

```
You are a bookkeeping assistant. Extract bill data from the document below.
Return a JSON object with these fields:

  vendor              — supplier name (string)
  vendor_vat_code     — supplier VAT/registration number if visible (string | null)
  vendor_invoice_number — supplier's invoice/reference number if visible (string | null)
  bill_date            — invoice date, ISO YYYY-MM-DD (string | null)
  due_date             — payment due date, ISO YYYY-MM-DD (string | null)
  currency             — ISO 4217 currency code if visible (string, e.g. "SEK")
  amount               — total bill amount, tax-inclusive, as a number
  vat_amount           — stated total VAT/tax amount, as a number (0 if none stated)
  lines                — array of line items, each:
    {
      description,       — line description (string)
      account_code_hint,  — best-guess account code from the chart of accounts below (string | null)
      quantity,           — quantity if stated (number, default 1)
      unit_price,         — unit price if stated (number | null)
      amount,             — line total amount including tax (number)
      vat_code,           — VAT code from the list below if identifiable (string | null)
      vat_rate            — VAT rate as a percent if stated (number | null)
    }
  notes                — any other useful free-text notes (string | null)

Use the company's chart of accounts and VAT codes below to suggest
account_code_hint and vat_code. If unsure, still fill the field with your best
guess — a human reviews the result. Do not omit lines. Amounts are numbers,
not strings.

Chart of accounts (code name):
<coa lines — "code name" one per line, same format as buildTier4Prompt>

VAT codes (code rate):
<vat code lines — "code rate%" one per line>
```

The COA is loaded the same way `buildTier4Context()` does (agent-loop.js:455): `await _dispatchAction('freebooks_read', { action: 'account.list', params: {} }, companyId, agentEmail)`. VAT codes via `vat.list` (or `freebooks_read` over `vat_codes` table) — same read-model path. Both are read once per `extractBillData()` call and passed into `buildBillExtractionPrompt()`. If either read fails, the prompt is built with empty lists (the LLM still extracts vendor/amount/date; account hints come back null). The prompt is built fresh per call (no caching) — COA can change between bills.

`response_format: { type: 'json_object' }` is set on the request (same as tier4) so the model returns valid JSON, not prose wrapped around JSON.

## 9. Error handling summary

| Failure | Behavior |
|---|---|
| `pdf-parse` throws (corrupt/encrypted PDF) | warn + fall through to layer 2 |
| Layer 1 finds text but `llm_endpoint_url` unset | skip layer 1's LLM call → fall through to layer 2 |
| Text LLM HTTP non-2xx | warn (status + body snippet) → fall through to layer 2 |
| Text LLM returns empty content | warn → fall through to layer 2 |
| Text LLM returns non-JSON | warn (content snippet) → fall through to layer 2 |
| Text LLM JSON missing required fields | warn → fall through to layer 2 |
| File is an image (no layer 1) | start at layer 2 |
| Layer 2 not configured (`llm_vision_*` empty) | fall through to layer 3 (skeleton) |
| Layer 2 vision LLM HTTP non-2xx | warn → fall through to layer 3 |
| Layer 2 returns non-JSON / missing fields | warn → fall through to layer 3 |
| `fetchAttachment` itself fails | handled upstream in `processBill` (agent-loop.js:487–489) — returns early, no draft. Unchanged. |
| Extraction succeeds but `bill.create` fails | handled upstream in `processBill` (agent-loop.js:500–502) — logs error, no draft. Unchanged. |

The extraction function itself **never throws** to `processBill` — every internal failure is caught and degrades to the skeleton (layer 3). The only way `processBill` sees a thrown error from this path is if `fetchAttachment` failed before `extractBillData` was called, which is unchanged.

## 10. What does NOT change

- **Drop-folder watcher / file intake** (`api/src/feed-watcher.js`, `feedWatcherUpload`) — unchanged. Files still land as attachments with `entityType` derived from the folder (`bills/` → `bill`).
- **Entity-type routing** (`processEvent`, agent-loop.js:510) — `entityType === 'bill'` still routes to `processBill`. Unchanged.
- **`bill.create` action and its params** (action-catalog.js:192, bills.js `createBill`/`saveDraftBill`) — unchanged. The agent actor still saves a draft; the human still posts via `bill.draft.post`.
- **Inbox `bill_draft` type** (agent-readiness-spec §10.2, bank-matching-spec §10.4a) — unchanged. `inbox.list` still fans out to `bills` for `status='draft'` rows.
- **Tier-4 bank-statement LLM path** (`tier4LLMReason`, agent-loop.js:253) — completely separate. Bill extraction adds a new `buildBillExtractionPrompt` and a new call site; it does not touch the bank-statement cascade, `buildTier4Prompt`, or `buildTier4Context`. The two share the *call shape* (fetch + response_format) but not code paths.
- **The skeleton draft's existing fields** — layer 3 returns exactly the current stub object (agent-loop.js:475–479), so any downstream code keyed on `_source_attachment_id` / `_source_filename` keeps working.
- **`processBill`'s structure** (agent-loop.js:482–503) — only line 492 changes from `const bill = extractBillData(att, payload);` to `const bill = await extractBillData(att, payload, companySettings, companyId, agentEmail);`. The `if (!bill) return` guard and the `bill.create` dispatch are untouched.

## 11. Dependency

- **`pdf-parse`** (npm). Pure JavaScript, no native bindings, no system binaries (`pdftotext`/`poppler`). Add to `package.json` dependencies. This is the only new dependency. Tested against the standard "digital invoice PDF" case; deliberately degrades to layer 2 for scanned PDFs (no text layer) rather than pulling in a rasterizer.

## 12. Contract tests

Tests live in `tests/` (Node's built-in test runner, same as the existing tier-4 / bank-statement tests). `extractBillData` is exported (agent-loop.js:506 already exports it), so tests import it directly.

### 12.1 Text-PDF extraction path (layer 1)
- **Fixture:** a small text-layer PDF generated in-test (e.g. `pdf-lib` writes a one-page PDF with "Vendor: Acme\nAmount: 1000\nDate: 2026-08-07\n…") — no binary fixture checked in.
- **Mock:** `fetch` is stubbed (global `globalThis.fetch`) to return a canned `choices[0].message.content` JSON matching §8's shape. Assert the request body has `response_format: { type: 'json_object' }` and `model === 'test-model'`.
- **Assert:** `extractBillData()` returns a bill object with `vendor === 'Acme'`, `amount === 1000`, `date === '2026-08-07'`, `lines` populated, and `_source_attachment_id` carried through.
- **Assert:** `fetch` was called once (layer 2 not invoked).

### 12.2 Image / scanned-PDF path (layer 2)
- **Fixture:** `att.buffer` is a 1×1 PNG; `contentType: 'image/png'`. Layer 1 is skipped (image, not PDF).
- **Settings:** `llm_vision_endpoint_url` + `llm_vision_model` set; `llm_vision_api_key` blank (falls back to `llm_api_key`).
- **Mock:** `fetch` returns the same canned JSON as 12.1.
- **Assert:** the request body's `messages[1].content` is an array containing an `{ type: 'image_url', image_url: { url: 'data:image/png;base64,…' } }` part; `Authorization` header uses `llm_api_key` (the fallback); `model === 'test-vision-model'`.
- **Assert:** returned bill object is populated.

### 12.3 No vision config → graceful skeleton fallback (layer 3)
- **Fixture:** image attachment (skips layer 1). `llm_vision_endpoint_url` empty.
- **Assert:** `fetch` is **not** called at all; `extractBillData()` returns the skeleton object (`{ currency: null, lines: [], _source_attachment_id, _source_filename }`); a warn was logged.

### 12.4 No LLM configured at all → skeleton
- **Fixture:** text PDF. `llm_endpoint_url` empty, `llm_vision_endpoint_url` empty.
- **Assert:** `fetch` not called; skeleton returned.

### 12.5 LLM returns unparseable JSON → layer 3 (no vision) / layer 2 (vision configured)
- **Mock:** text LLM returns content `"not json"`. No vision configured.
- **Assert:** skeleton returned with a warn.
- **Variant:** vision configured → text LLM fails, vision LLM succeeds → bill populated from vision.

### 12.6 `bill.create` failure does not create a draft
- This is `processBill`'s existing behavior (agent-loop.js:500–502), unchanged by this spec. Test exists already or is added at the `processBill` level: mock `_dispatchAction('bill.create')` to throw; assert no draft row and an error logged. Documents the contract, doesn't test `extractBillData` directly.

### 12.7 Non-regression: skeleton still works end-to-end
- With no LLM config at all, drop a PDF through `processBill`; assert a `status='draft'` bill row exists in the `bills` table with `vendor IS NULL` and the attachment linked (the pre-spec behavior). Confirms the floor didn't move.

## 13. Resolved decisions (ratified by magnus 2026-08-07)

1. **Per-line VAT preferred, summed to bill-level.** The prompt asks for both; the normalizer (§7) prefers per-line and sums to bill-level. Confirmed this matches the draft editor's expectation (bill-edit.js reads `lines[].vat_code`).

2. **VAT codes included in the prompt.** §8 loads VAT codes via `vat.list` and includes them in the system prompt so the LLM can suggest `vat_code` per line. Tier-4 bank statements don't pass VAT codes (bills have explicit VAT lines, bank statements don't) — bill extraction is the correct precedent for including them.

3. **Scanned PDFs through vision: let it fail to layer 3.** Some vision endpoints accept PDFs natively (OpenAI does); others only accept JPEG/PNG and will 4xx. The spec's stance: let it fail to layer 3 (skeleton) rather than pulling in a PDF rasterizer dep. Optional rasterization deferred to a future enhancement if it becomes a real problem.

4. **Prompt caching deferred.** COA + VAT codes are re-read and rebuilt per bill. At small-company volume (tens of bills/month) this is irrelevant. Defer to a follow-up if volume ever justifies it.
