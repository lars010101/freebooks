'use strict';
/**
 * Bill extraction v2 — contract tests (bill-extraction-spec v2, ratified 2026-08-24).
 *
 * Run:  node --test tests/bill-extraction.test.mjs
 *
 * Tests exercise:
 *   - extractBillData(): ExtractionResult schema, hard failures, soft failures
 *   - _validateExtraction(): deterministic validation (vendor match, totals,
 *     line checks, reverse-charge, confidence derivation)
 *   - processBill(): end-to-end (draft creation, input_rejections, meta write)
 *   - buildBillExtractionPrompt(): prompt includes context
 *
 * The text-LLM path uses pdf-parse; we stub it via require.cache (no binary
 * PDF fixture needed) so the tests are deterministic and add no deps beyond
 * pdf-parse itself. globalThis.fetch is stubbed to return canned chat-completion
 * envelopes. dispatchAction / fetchAttachment are injected via _setLoopDeps
 * (test-only hook) so no live DB / timer is required.
 */

import { test, beforeEach, afterEach } from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import {
  extractBillData,
  processBill,
  _setLoopDeps,
  _validateExtraction,
  buildBillExtractionPrompt,
} from '../api/src/agent-loop.js';

const require = createRequire(import.meta.url);

// ── Fixtures ───────────────────────────────────────────────────────────────

// A canned LLM extraction matching the v2 schema.
const CANNED = {
  partner_name_raw: 'Acme Corp',
  partner_id: null,
  currency: 'SEK',
  invoice_number: 'INV-001',
  invoice_date: '2026-08-07',
  due_date: '2026-08-21',
  total_stated: 1000,
  vat_amount_stated: 200,
  lines: [
    {
      description: 'Consulting',
      amount: 1000,
      expense_account: '6000',
      vat_code: 'S25',
      reverse_charge: false,
    },
  ],
};

// A canned extraction with total mismatch (sum of lines != total_stated).
const CANNED_MISMATCH = {
  ...CANNED,
  total_stated: 1500, // lines sum to 1000 — mismatch
};

// A canned extraction with no invoice_date (hard failure).
const CANNED_NO_DATE = {
  ...CANNED,
  invoice_date: null,
};

// A canned extraction with zero lines (hard failure).
const CANNED_NO_LINES = {
  ...CANNED,
  lines: [],
};

// A canned extraction with negative line amount (hard failure).
const CANNED_NEG_LINE = {
  ...CANNED,
  lines: [{ ...CANNED.lines[0], amount: -100 }],
};

// A canned extraction with reverse-charge line.
const CANNED_REVERSE_CHARGE = {
  ...CANNED,
  lines: [
    {
      description: 'Service',
      amount: 800,
      expense_account: '6000',
      vat_code: null,
      reverse_charge: true,
    },
    {
      description: 'Goods',
      amount: 200,
      expense_account: '4000',
      vat_code: 'S25',
      reverse_charge: false,
    },
  ],
  total_stated: 1000,
};

// A canned extraction with duplicate line descriptions but different amounts.
const CANNED_DUP_DESC = {
  ...CANNED,
  lines: [
    { description: 'Service', amount: 600, expense_account: '6000', vat_code: 'S25', reverse_charge: false },
    { description: 'Service', amount: 400, expense_account: '6000', vat_code: 'S25', reverse_charge: false },
  ],
  total_stated: 1000,
};

// A 1×1 PNG (valid, tiny) for image-path tests.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
  'base64',
);

// ── Mock helpers ────────────────────────────────────────────────────────────

let _origFetch;
let _fetchCalls;
let _fetchImpl;

function mockFetch(impl) {
  _fetchImpl = impl;
  _fetchCalls = [];
  _origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const call = { url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null };
    _fetchCalls.push(call);
    return impl(url, opts, call);
  };
}

function restoreFetch() {
  if (_origFetch !== undefined) globalThis.fetch = _origFetch;
  _origFetch = undefined;
  _fetchImpl = null;
  _fetchCalls = null;
}

function okResponse(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
  };
}

function failResponse(status, body) {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body || 'error',
  };
}

// Stub pdf-parse in the require cache so extractBillData's lazy require gets
// our mock. `text` is the per-page embedded text the fake PDF yields (same
// text repeated on every one of `numpages` pages). Mirrors pdf-parse@2's real
// shape — a named `PDFParse` class, not a callable default export — so the
// stub actually exercises the same require/construct/getText/getScreenshot/
// destroy call pattern the real dependency requires.
let _pdfOriginal;
function stubPdfParse(text, numpages = 1) {
  const modPath = require.resolve('pdf-parse');
  _pdfOriginal = require.cache[modPath];
  class FakePDFParse {
    constructor(opts) { this._data = opts && opts.data; }
    async getText() {
      const pages = Array.from({ length: numpages }, () => ({ text }));
      return { pages, text, total: numpages };
    }
    async getScreenshot() {
      const pages = Array.from({ length: numpages }, (_, i) => ({ data: this._data, pageNumber: i + 1 }));
      return { pages, total: numpages };
    }
    async destroy() {}
  }
  require.cache[modPath] = {
    id: modPath, filename: modPath, loaded: true,
    exports: { PDFParse: FakePDFParse },
  };
}
function restorePdfParse() {
  const modPath = require.resolve('pdf-parse');
  if (_pdfOriginal) require.cache[modPath] = _pdfOriginal;
  else delete require.cache[modPath];
  _pdfOriginal = undefined;
}

// A mock dispatchAction that returns partner list, COA, VAT codes, and bill.create.
function makeDispatch(billCreateImpl) {
  return async (action, params, companyId, agentEmail) => {
    if (action === 'coa.list') {
      return [{ account_code: '6000', account_name: 'Consulting', account_type: 'Expense' }];
    }
    if (action === 'vat.codes.list') {
      return [{ vat_code: 'S25', rate: 0.25, is_reverse_charge: false }];
    }
    if (action === 'bill.create') return billCreateImpl(params);
    if (action === 'input_rejection.create') return { rejection_id: 'rej-1', status: 'open' };
    if (action === 'partner.propose') return { proposal_id: 'pp-1' };
    throw new Error(`unexpected action ${action}`);
  };
}

beforeEach(() => {
  _setLoopDeps({ dispatchAction: null, fetchAttachmentFn: null });
});

afterEach(() => {
  restoreFetch();
  restorePdfParse();
  _setLoopDeps({ dispatchAction: null, fetchAttachmentFn: null });
});

// ── 1. Text-PDF extraction path ────────────────────────────────────────────

test('1. text-PDF extraction returns ExtractionResult with ok=true', async () => {
  stubPdfParse('Vendor: Acme Corp\nAmount: 1000\nDate: 2026-08-07\nInvoice: INV-001\nDue: 2026-08-21\nCurrency: SEK\nThis is a digital invoice with an embedded text layer long enough to pass the per-page threshold.');
  mockFetch(() => okResponse(JSON.stringify(CANNED)));

  _setLoopDeps({
    dispatchAction: makeDispatch(() => ({ bill_id: 'b-1' })),
    fetchAttachmentFn: null,
  });

  const att = { contentType: 'application/pdf', filename: 'invoice.pdf', buffer: Buffer.from('%PDF-1.4 dummy'), text: '' };
  const payload = { entityId: 'att-1', filename: 'invoice.pdf', contentType: 'application/pdf' };
  const settings = {
    llm_endpoint_url: 'https://llm.example.com',
    llm_api_key: 'text-key',
    llm_model: 'test-model',
    llm_temperature: '0.1',
  };

  const result = await extractBillData(att, payload, settings, 'CO', 'agent@ct');

  assert.equal(result.ok, true);
  assert.equal(result.data.partner_name_raw, 'Acme Corp');
  assert.equal(result.data.currency, 'SEK');
  assert.equal(result.data.invoice_number, 'INV-001');
  assert.equal(result.data.invoice_date, '2026-08-07');
  assert.equal(result.data.due_date, '2026-08-21');
  assert.equal(result.data.total_stated, 1000);
  assert.ok(Array.isArray(result.data.lines) && result.data.lines.length === 1);
  assert.equal(result.data.lines[0].expense_account, '6000');
  assert.equal(result.data.lines[0].vat_code, 'S25');
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.flags, []);
  assert.ok(result.prompt_snapshot, 'prompt_snapshot retained');
  assert.ok(result.raw_model_output, 'raw_model_output retained');

  // Exactly one LLM call — text path, not image.
  assert.equal(_fetchCalls.length, 1);
  const req = _fetchCalls[0];
  assert.equal(req.body.model, 'test-model');
  assert.deepEqual(req.body.response_format, { type: 'json_object' });
  assert.equal(req.opts.headers['Authorization'], 'Bearer text-key');
  assert.equal(req.url, 'https://llm.example.com/v1/chat/completions');
  // User message is the extracted text (a string), not an image_url array.
  assert.equal(typeof req.body.messages[1].content, 'string');
});

// ── 2. Image extraction path (same endpoint, image_url content) ────────────

test('2. image extraction uses the same endpoint with image_url content', async () => {
  mockFetch(() => okResponse(JSON.stringify(CANNED)));

  _setLoopDeps({
    dispatchAction: makeDispatch(() => ({ bill_id: 'b-2' })),
    fetchAttachmentFn: null,
  });

  const att = { contentType: 'image/png', filename: 'receipt.png', buffer: PNG_1x1, text: '' };
  const payload = { entityId: 'att-2', filename: 'receipt.png', contentType: 'image/png' };
  const settings = {
    llm_endpoint_url: 'https://llm.example.com',
    llm_api_key: 'text-key',
    llm_model: 'test-model',
    llm_temperature: '0.1',
  };

  const result = await extractBillData(att, payload, settings, 'CO', 'agent@ct');

  assert.equal(result.ok, true);
  assert.equal(result.data.partner_name_raw, 'Acme Corp');

  assert.equal(_fetchCalls.length, 1);
  const req = _fetchCalls[0];
  assert.equal(req.body.model, 'test-model');
  assert.deepEqual(req.body.response_format, { type: 'json_object' });
  // User message is an array with a text part + an image_url part.
  const userContent = req.body.messages[1].content;
  assert.ok(Array.isArray(userContent), 'user content is a multimodal array');
  const imgPart = userContent.find((p) => p.type === 'image_url');
  assert.ok(imgPart, 'image_url part present');
  assert.match(imgPart.image_url.url, /^data:image\/png;base64,/);
});

// ── 3. Hard failure: no LLM configured ────────────────────────────────────

test('3. no LLM configured returns ok=false with no_llm_configured', async () => {
  mockFetch(() => okResponse(JSON.stringify(CANNED)));

  const att = { contentType: 'image/png', filename: 'receipt.png', buffer: PNG_1x1, text: '' };
  const payload = { entityId: 'att-3', filename: 'receipt.png', contentType: 'image/png' };
  const settings = {}; // no llm_endpoint_url

  const result = await extractBillData(att, payload, settings, 'CO', 'agent@ct');

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_llm_configured');
  assert.equal(_fetchCalls.length, 0, 'fetch never called');
});

// ── 4. Hard failure: missing critical data (no invoice_date) ───────────────

test('4. missing invoice_date returns ok=false with missing_critical_data', async () => {
  stubPdfParse('Vendor: Acme\nAmount: 1000\nCurrency: SEK\nThis text is long enough to pass the per-page threshold for sure.');
  mockFetch(() => okResponse(JSON.stringify(CANNED_NO_DATE)));

  _setLoopDeps({
    dispatchAction: makeDispatch(() => ({ bill_id: 'b-4' })),
    fetchAttachmentFn: null,
  });

  const att = { contentType: 'application/pdf', filename: 'invoice.pdf', buffer: Buffer.from('%PDF-1.4 dummy'), text: '' };
  const payload = { entityId: 'att-4', filename: 'invoice.pdf', contentType: 'application/pdf' };
  const settings = {
    llm_endpoint_url: 'https://llm.example.com',
    llm_model: 'test-model',
  };

  const result = await extractBillData(att, payload, settings, 'CO', 'agent@ct');

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_critical_data');
  assert.match(result.detail, /invoice date/i);
});

// ── 5. Hard failure: zero lines ────────────────────────────────────────────

test('5. zero lines returns ok=false with missing_critical_data', async () => {
  stubPdfParse('Vendor: Acme\nAmount: 1000\nDate: 2026-08-07\nCurrency: SEK\nThis text is long enough to pass the per-page threshold for sure.');
  mockFetch(() => okResponse(JSON.stringify(CANNED_NO_LINES)));

  _setLoopDeps({
    dispatchAction: makeDispatch(() => ({ bill_id: 'b-5' })),
    fetchAttachmentFn: null,
  });

  const att = { contentType: 'application/pdf', filename: 'invoice.pdf', buffer: Buffer.from('%PDF-1.4 dummy'), text: '' };
  const payload = { entityId: 'att-5', filename: 'invoice.pdf', contentType: 'application/pdf' };
  const settings = {
    llm_endpoint_url: 'https://llm.example.com',
    llm_model: 'test-model',
  };

  const result = await extractBillData(att, payload, settings, 'CO', 'agent@ct');

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_critical_data');
  assert.match(result.detail, /line/i);
});

// ── 6. Hard failure: negative line amount ──────────────────────────────────

test('6. negative line amount returns ok=false with missing_critical_data', async () => {
  stubPdfParse('Vendor: Acme\nAmount: 1000\nDate: 2026-08-07\nCurrency: SEK\nThis text is long enough to pass the per-page threshold for sure.');
  mockFetch(() => okResponse(JSON.stringify(CANNED_NEG_LINE)));

  _setLoopDeps({
    dispatchAction: makeDispatch(() => ({ bill_id: 'b-6' })),
    fetchAttachmentFn: null,
  });

  const att = { contentType: 'application/pdf', filename: 'invoice.pdf', buffer: Buffer.from('%PDF-1.4 dummy'), text: '' };
  const payload = { entityId: 'att-6', filename: 'invoice.pdf', contentType: 'application/pdf' };
  const settings = {
    llm_endpoint_url: 'https://llm.example.com',
    llm_model: 'test-model',
  };

  const result = await extractBillData(att, payload, settings, 'CO', 'agent@ct');

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_critical_data');
  assert.match(result.detail, /line amount invalid/i);
});

// ── 7. Hard failure: LLM HTTP error ────────────────────────────────────────

test('7. LLM HTTP error returns ok=false with extraction_failed', async () => {
  stubPdfParse('Vendor: Acme\nAmount: 1000\nDate: 2026-08-07\nCurrency: SEK\nThis text is long enough to pass the per-page threshold for sure.');
  mockFetch(() => failResponse(500, 'Internal Server Error'));

  _setLoopDeps({
    dispatchAction: makeDispatch(() => ({ bill_id: 'b-7' })),
    fetchAttachmentFn: null,
  });

  const att = { contentType: 'application/pdf', filename: 'invoice.pdf', buffer: Buffer.from('%PDF-1.4 dummy'), text: '' };
  const payload = { entityId: 'att-7', filename: 'invoice.pdf', contentType: 'application/pdf' };
  const settings = {
    llm_endpoint_url: 'https://llm.example.com',
    llm_model: 'test-model',
  };

  const result = await extractBillData(att, payload, settings, 'CO', 'agent@ct');

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'extraction_failed');
  assert.match(result.detail, /HTTP 500/);
});

// ── 8. Hard failure: non-JSON content from LLM ─────────────────────────────

test('8. non-JSON LLM content returns ok=false with extraction_failed', async () => {
  stubPdfParse('Vendor: Acme\nAmount: 1000\nDate: 2026-08-07\nCurrency: SEK\nThis text is long enough to pass the per-page threshold for sure.');
  mockFetch(() => okResponse('not json'));

  _setLoopDeps({
    dispatchAction: makeDispatch(() => ({ bill_id: 'b-8' })),
    fetchAttachmentFn: null,
  });

  const att = { contentType: 'application/pdf', filename: 'invoice.pdf', buffer: Buffer.from('%PDF-1.4 dummy'), text: '' };
  const payload = { entityId: 'att-8', filename: 'invoice.pdf', contentType: 'application/pdf' };
  const settings = {
    llm_endpoint_url: 'https://llm.example.com',
    llm_model: 'test-model',
  };

  const result = await extractBillData(att, payload, settings, 'CO', 'agent@ct');

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'extraction_failed');
  assert.match(result.detail, /Non-JSON/);
});

// ── 9. Soft failure: total_mismatch flag + confidence=medium ────────────────

test('9. total mismatch sets total_mismatch flag and confidence=medium', async () => {
  stubPdfParse('Vendor: Acme\nAmount: 1500\nDate: 2026-08-07\nCurrency: SEK\nThis text is long enough to pass the per-page threshold for sure.');
  mockFetch(() => okResponse(JSON.stringify(CANNED_MISMATCH)));

  _setLoopDeps({
    dispatchAction: makeDispatch(() => ({ bill_id: 'b-9' })),
    fetchAttachmentFn: null,
  });

  const att = { contentType: 'application/pdf', filename: 'invoice.pdf', buffer: Buffer.from('%PDF-1.4 dummy'), text: '' };
  const payload = { entityId: 'att-9', filename: 'invoice.pdf', contentType: 'application/pdf' };
  const settings = {
    llm_endpoint_url: 'https://llm.example.com',
    llm_model: 'test-model',
    bill_extraction_tolerance: '0.50',
  };

  const result = await extractBillData(att, payload, settings, 'CO', 'agent@ct');

  assert.equal(result.ok, true);
  assert.ok(result.flags.includes('total_mismatch'));
  assert.equal(result.confidence, 'medium');
  assert.equal(result.data.lines[0].needs_review, true);
});

// ── 10. Reverse-charge detection ────────────────────────────────────────────

test('10. reverse-charge line sets reverse_charge_detected flag', async () => {
  stubPdfParse('Vendor: Acme\nReverse charge\nAmount: 1000\nDate: 2026-08-07\nCurrency: SEK\nThis text is long enough to pass the per-page threshold for sure.');
  mockFetch(() => okResponse(JSON.stringify(CANNED_REVERSE_CHARGE)));

  _setLoopDeps({
    dispatchAction: makeDispatch(() => ({ bill_id: 'b-10' })),
    fetchAttachmentFn: null,
  });

  const att = { contentType: 'application/pdf', filename: 'invoice.pdf', buffer: Buffer.from('%PDF-1.4 dummy'), text: '' };
  const payload = { entityId: 'att-10', filename: 'invoice.pdf', contentType: 'application/pdf' };
  const settings = {
    llm_endpoint_url: 'https://llm.example.com',
    llm_model: 'test-model',
  };

  const result = await extractBillData(att, payload, settings, 'CO', 'agent@ct');

  assert.equal(result.ok, true);
  assert.ok(result.flags.includes('reverse_charge_detected'));
  assert.ok(result.data.lines[0].reverse_charge);
  assert.equal(result.data.lines[0].vat_code, null);
  assert.equal(result.data.lines[0].needs_review, true);
  // confidence: 1 flag (reverse_charge_detected) → medium
  // (no_vat_code_detected should NOT fire because RC was detected)
  assert.equal(result.confidence, 'medium');
});

// ── 11. Duplicate line description with different amounts ───────────────────

test('11. duplicate line descriptions with different amounts sets flag', async () => {
  stubPdfParse('Vendor: Acme\nAmount: 1000\nDate: 2026-08-07\nCurrency: SEK\nThis text is long enough to pass the per-page threshold for sure.');
  mockFetch(() => okResponse(JSON.stringify(CANNED_DUP_DESC)));

  _setLoopDeps({
    dispatchAction: makeDispatch(() => ({ bill_id: 'b-11' })),
    fetchAttachmentFn: null,
  });

  const att = { contentType: 'application/pdf', filename: 'invoice.pdf', buffer: Buffer.from('%PDF-1.4 dummy'), text: '' };
  const payload = { entityId: 'att-11', filename: 'invoice.pdf', contentType: 'application/pdf' };
  const settings = {
    llm_endpoint_url: 'https://llm.example.com',
    llm_model: 'test-model',
  };

  const result = await extractBillData(att, payload, settings, 'CO', 'agent@ct');

  assert.equal(result.ok, true);
  assert.ok(result.flags.includes('duplicate_line_description'));
  assert.ok(result.data.lines.some((l) => l.needs_review));
});

// ── 12. Scanned PDF (low text) falls through to image path ──────────────────

test('12. scanned PDF with low text per-page uses image path', async () => {
  // numpages=3 but very little text → perPageAvg below threshold
  stubPdfParse('short', 3);
  mockFetch(() => okResponse(JSON.stringify(CANNED)));

  _setLoopDeps({
    dispatchAction: makeDispatch(() => ({ bill_id: 'b-12' })),
    fetchAttachmentFn: null,
  });

  const att = { contentType: 'application/pdf', filename: 'scan.pdf', buffer: PNG_1x1, text: '' };
  const payload = { entityId: 'att-12', filename: 'scan.pdf', contentType: 'application/pdf' };
  const settings = {
    llm_endpoint_url: 'https://llm.example.com',
    llm_model: 'test-model',
  };

  const result = await extractBillData(att, payload, settings, 'CO', 'agent@ct');

  assert.equal(result.ok, true);
  assert.equal(_fetchCalls.length, 1);
  // Image path → multimodal content
  const userContent = _fetchCalls[0].body.messages[1].content;
  assert.ok(Array.isArray(userContent), 'image path used');
});

// ── 13. _validateExtraction: vendor matching ────────────────────────────────

test('13. _validateExtraction: partner_id match accepts when name matches', () => {
  const context = {
    partners: [{ partner_id: 'p-1', name: 'Acme Corp', default_expense_account: '6000' }],
    expenseAccounts: [],
    vatCodes: [{ vat_code: 'S25', rate: 0.25, is_reverse_charge: false }],
  };
  const parsed = {
    partner_name_raw: 'Acme Corp',
    partner_id: 'p-1',
    currency: 'SEK',
    invoice_date: '2026-08-07',
    total_stated: 1000,
    lines: [{ description: 'Service', amount: 1000, vat_code: 'S25', reverse_charge: false }],
  };
  const result = _validateExtraction(parsed, context, {});
  assert.equal(result.ok, true);
  assert.equal(result.data.partner_id, 'p-1');
  assert.equal(result.data.needs_new_partner, false);
  assert.equal(result.confidence, 'high');
});

test('13b. _validateExtraction: partner_id null + partner_name_raw unmatched → needs_new_partner', () => {
  const context = {
    partners: [{ partner_id: 'p-1', name: 'Acme Corp', default_expense_account: '6000' }],
    expenseAccounts: [],
    vatCodes: [{ vat_code: 'S25', rate: 0.25, is_reverse_charge: false }],
  };
  const parsed = {
    partner_name_raw: 'Completely Different Vendor Name',
    partner_id: null,
    currency: 'SEK',
    invoice_date: '2026-08-07',
    total_stated: 1000,
    lines: [{ description: 'Service', amount: 1000, vat_code: 'S25', reverse_charge: false }],
  };
  const result = _validateExtraction(parsed, context, {});
  assert.equal(result.ok, true);
  assert.equal(result.data.partner_id, null);
  assert.equal(result.data.needs_new_partner, true);
});

// ── 14. processBill: hard failure creates input_rejection ───────────────────

test('14. processBill routes hard failure to input_rejection.create', async () => {
  stubPdfParse('Vendor: Acme\nAmount: 1000\nDate: 2026-08-07\nCurrency: SEK\nThis text is long enough to pass the per-page threshold for sure.');
  mockFetch(() => okResponse(JSON.stringify(CANNED_NO_DATE)));

  let rejectionCreated = false;
  let billCreated = false;
  const dispatch = makeDispatch(async (params) => {
    billCreated = true;
    return { bill_id: 'b-fail' };
  });
  // Override input_rejection.create
  const origDispatch = dispatch;
  const wrappedDispatch = async (action, params, companyId, agentEmail) => {
    if (action === 'input_rejection.create') {
      rejectionCreated = true;
      return { rejection_id: 'rej-1', status: 'open' };
    }
    return origDispatch(action, params, companyId, agentEmail);
  };
  _setLoopDeps({
    dispatchAction: wrappedDispatch,
    fetchAttachmentFn: async () => ({
      contentType: 'application/pdf', filename: 'invoice.pdf', buffer: Buffer.from('%PDF-1.4'), text: '',
    }),
  });

  const ev = { entity_id: 'att-14' };
  const settings = {
    llm_endpoint_url: 'https://llm.example.com',
    llm_model: 'test-model',
  };

  await assert.doesNotReject(() => processBill(ev, 'CO', 'agent@ct', settings));

  assert.equal(rejectionCreated, true, 'input_rejection.create was called');
  assert.equal(billCreated, false, 'bill.create was NOT called');
});

// ── 15. processBill: successful extraction creates draft + meta ──────────────

test('15. processBill creates draft bill and writes _extraction_meta', async () => {
  stubPdfParse('Vendor: Acme\nAmount: 1000\nDate: 2026-08-07\nCurrency: SEK\nThis text is long enough to pass the per-page threshold for sure.');
  mockFetch(() => okResponse(JSON.stringify(CANNED)));

  let createdBill = null;
  let metaInserted = false;
  let metaBillId = null;

  const dispatch = makeDispatch(async (params) => {
    createdBill = params.bill;
    return { bill_id: 'b-15' };
  });

  // We need to also intercept the exec call for bill_extraction_meta INSERT.
  // Since we can't intercept exec directly (it's in the module scope), we
  // just verify the bill object carries _extraction_meta and bill.create is
  // called. The meta insert is best-effort and logged on failure.
  _setLoopDeps({
    dispatchAction: dispatch,
    fetchAttachmentFn: async () => ({
      contentType: 'application/pdf', filename: 'invoice.pdf', buffer: Buffer.from('%PDF-1.4'), text: '',
    }),
  });

  const ev = { entity_id: 'att-15' };
  const settings = {
    llm_endpoint_url: 'https://llm.example.com',
    llm_model: 'test-model',
  };

  await processBill(ev, 'CO', 'agent@ct', settings);

  assert.ok(createdBill, 'bill.create was called with a bill object');
  assert.equal(createdBill.partner_name, 'Acme Corp');
  assert.equal(createdBill.currency, 'SEK');
  assert.equal(createdBill.date, '2026-08-07');
  assert.equal(createdBill.amount, 1000);
  assert.ok(createdBill._extraction_meta, '_extraction_meta present on bill');
  assert.equal(createdBill._extraction_meta.confidence, 'high');
  assert.equal(createdBill._extraction_meta.model, 'test-model');
  assert.ok(createdBill._extraction_meta.prompt_snapshot, 'prompt_snapshot in _extraction_meta');
  assert.ok(createdBill._extraction_meta.raw_model_output, 'raw_model_output in _extraction_meta');
});

// ── 16. Prompt builder includes partner list, COA, and VAT codes ─────────────

test('16. buildBillExtractionPrompt includes partner list, COA, and VAT codes', () => {
  const prompt = buildBillExtractionPrompt({
    partners: [{ partner_id: 'p-1', name: 'Acme Corp', default_expense_account: '6000' }],
    expenseAccounts: [{ account_code: '6000', account_name: 'Consulting' }],
    vatCodes: [{ vat_code: 'S25', rate: 0.25, is_reverse_charge: false }],
    currency: 'SEK',
    jurisdiction: 'SE',
  });
  assert.match(prompt, /Partner list/);
  assert.match(prompt, /Acme Corp/);
  assert.match(prompt, /Chart of expense accounts/);
  assert.match(prompt, /6000 Consulting/);
  assert.match(prompt, /VAT codes/);
  assert.match(prompt, /S25 25%/);
  assert.match(prompt, /reverse_charge/);
  assert.match(prompt, /partner_name_raw/);
  assert.match(prompt, /total_stated/);
  assert.match(prompt, /invoice_date/);
});

// ── 17. Gross→net conversion: line amount with VAT code is converted ──────

test('17. _validateExtraction converts gross line amount to net when VAT code present', () => {
  const context = {
    partners: [],
    expenseAccounts: [],
    vatCodes: [{ vat_code: 'S25', rate: 0.25, is_reverse_charge: false }],
  };
  const parsed = {
    partner_name_raw: 'Acme Corp',
    partner_id: null,
    currency: 'SEK',
    invoice_date: '2026-08-07',
    total_stated: 1000, // gross
    lines: [{ description: 'Service', amount: 1000, vat_code: 'S25', reverse_charge: false }],
  };
  const result = _validateExtraction(parsed, context, {});
  assert.equal(result.ok, true);
  // 1000 gross @ 25% → net = round(1000 / 1.25, 2) = 800
  assert.equal(result.data.lines[0].amount, 800);
  assert.equal(result.data.total_stated, 1000, 'total_stated retains gross');
  assert.equal(result.data.total_computed, 1000, 'total_computed retains gross sum');
});

// ── 18. Gross→net: no VAT code means amount stays as-is ─────────────────────

test('18. _validateExtraction leaves amount unchanged when no VAT code', () => {
  const context = {
    partners: [],
    expenseAccounts: [],
    vatCodes: [{ vat_code: 'S25', rate: 0.25, is_reverse_charge: false }],
  };
  const parsed = {
    partner_name_raw: 'Acme Corp',
    partner_id: null,
    currency: 'SEK',
    invoice_date: '2026-08-07',
    total_stated: 1000,
    lines: [{ description: 'Service', amount: 1000, vat_code: null, reverse_charge: false }],
  };
  const result = _validateExtraction(parsed, context, {});
  assert.equal(result.ok, true);
  assert.equal(result.data.lines[0].amount, 1000, 'no conversion without VAT code');
});

// ── 19. Gross→net: multi-line with different rates ─────────────────────────

test('19. _validateExtraction converts multi-line gross to net per line', () => {
  const context = {
    partners: [],
    expenseAccounts: [],
    vatCodes: [
      { vat_code: 'S25', rate: 0.25, is_reverse_charge: false },
      { vat_code: 'S12', rate: 0.12, is_reverse_charge: false },
    ],
  };
  const parsed = {
    partner_name_raw: 'Acme Corp',
    partner_id: null,
    currency: 'SEK',
    invoice_date: '2026-08-07',
    total_stated: 1120, // 500 gross @25% + 620 gross @12%
    lines: [
      { description: 'Consulting', amount: 500, vat_code: 'S25', reverse_charge: false },
      { description: 'Goods', amount: 620, vat_code: 'S12', reverse_charge: false },
    ],
  };
  const result = _validateExtraction(parsed, context, {});
  assert.equal(result.ok, true);
  // 500 / 1.25 = 400
  assert.equal(result.data.lines[0].amount, 400);
  // 620 / 1.12 = 553.57
  assert.equal(result.data.lines[1].amount, 553.57);
  assert.equal(result.data.total_stated, 1120, 'total_stated retains gross');
});
