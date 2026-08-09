'use strict';
/**
 * Bill / receipt extraction — contract tests (bill-extraction-spec §12).
 *
 * Run:  node --test tests/bill-extraction.test.mjs
 *
 * Tests exercise the layered extractBillData() directly:
 *   Layer 1: PDF text → text LLM   (12.1, 12.4, 12.5)
 *   Layer 2: vision LLM (image)     (12.2, 12.3, 12.5-variant)
 *   Layer 3: skeleton fallback      (12.3, 12.4, 12.5, 12.7)
 * plus processBill-level contracts (12.6 bill.create failure, 12.7 end-to-end).
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
import { extractBillData, processBill, _setLoopDeps, buildBillExtractionPrompt } from '../api/src/agent-loop.js';

// ESM can't see `require`/`require.cache` directly, but createRequire shares the
// process-wide CommonJS module cache — so stubbing pdf-parse here affects the
// lazy `require('pdf-parse')` inside extractBillData (agent-loop.js is CJS).
const require = createRequire(import.meta.url);

// ── Fixtures ───────────────────────────────────────────────────────────────

// A canned LLM extraction (matches the §8 JSON shape — LLM output field is `vendor`).
const CANNED = {
  vendor: 'Acme',
  vendor_vat_code: 'SE556677889901',
  vendor_invoice_number: 'INV-001',
  bill_date: '2026-08-07',
  due_date: '2026-08-21',
  currency: 'SEK',
  amount: 1000,
  vat_amount: 200,
  lines: [
    {
      description: 'Consulting',
      account_code_hint: '6000',
      quantity: 1,
      unit_price: 1000,
      amount: 1000,
      vat_code: 'S25',
      vat_rate: 25,
    },
  ],
  notes: 'Monthly retainer',
};

// A 1×1 PNG (valid, tiny) for image-path tests.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
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
// our mock. `text` is the embedded text the fake PDF yields.
let _pdfOriginal;
function stubPdfParse(text) {
  const modPath = require.resolve('pdf-parse');
  _pdfOriginal = require.cache[modPath];
  require.cache[modPath] = {
    id: modPath, filename: modPath, loaded: true,
    exports: async () => ({ text, numpages: 1 }),
  };
}
function restorePdfParse() {
  const modPath = require.resolve('pdf-parse');
  if (_pdfOriginal) require.cache[modPath] = _pdfOriginal;
  else delete require.cache[modPath];
  _pdfOriginal = undefined;
}

// A mock dispatchAction that returns a small COA + VAT list for the
// freebooks_read sub-actions and delegates bill.create to an impl.
function makeDispatch(billCreateImpl) {
  return async (action, params, companyId, agentEmail) => {
    if (action === 'freebooks_read') {
      const sub = params && params.action;
      if (sub === 'account.list') return [{ account_code: '4000', account_name: 'Supplies' }];
      if (sub === 'vat.codes.list') return [{ vat_code: 'S25', rate: 0.25 }];
      return [];
    }
    if (action === 'bill.create') return billCreateImpl(params);
    throw new Error(`unexpected action ${action}`);
  };
}

beforeEach(() => {
  // Start each test with no injected deps + a COA-returning dispatch is set
  // per-test where needed. Reset to null by default.
  _setLoopDeps({ dispatchAction: null, fetchAttachmentFn: null });
});

afterEach(() => {
  restoreFetch();
  restorePdfParse();
  _setLoopDeps({ dispatchAction: null, fetchAttachmentFn: null });
});

// ── 12.1 Text-PDF extraction path (layer 1) ────────────────────────────────

test('12.1 text-PDF extraction uses the text LLM (layer 1) and populates the bill', async () => {
  stubPdfParse('Vendor: Acme\nAmount: 1000\nDate: 2026-08-07\nVendor invoice: INV-001\nDue: 2026-08-21\nCurrency: SEK\nThis is a digital invoice with an embedded text layer long enough to pass the heuristic.');
  mockFetch(() => okResponse(JSON.stringify(CANNED)));

  const att = { contentType: 'application/pdf', filename: 'invoice.pdf', buffer: Buffer.from('%PDF-1.4 dummy'), text: '' };
  const payload = { entityId: 'att-1', filename: 'invoice.pdf', contentType: 'application/pdf' };
  const settings = {
    llm_endpoint_url: 'https://llm.example.com',
    llm_api_key: 'text-key',
    llm_model: 'test-model',
    llm_temperature: '0.1',
  };

  const bill = await extractBillData(att, payload, settings, 'CO', 'agent@ct');

  // Bill populated from the canned LLM response.
  assert.equal(bill.partner_name, 'Acme');
  assert.equal(bill.amount, 1000);
  assert.equal(bill.date, '2026-08-07');
  assert.equal(bill.due_date, '2026-08-21');
  assert.equal(bill.currency, 'SEK');
  assert.equal(bill.vendor_ref, 'INV-001');
  assert.ok(Array.isArray(bill.lines) && bill.lines.length === 1);
  assert.equal(bill.lines[0].expense_account, '6000');
  assert.equal(bill.lines[0].vat_code, 'S25');
  assert.equal(bill._source_attachment_id, 'att-1');

  // Exactly one LLM call — layer 2 (vision) must NOT have been invoked.
  assert.equal(_fetchCalls.length, 1, 'layer 1 LLM called exactly once; layer 2 not invoked');
  const req = _fetchCalls[0];
  assert.equal(req.body.model, 'test-model');
  assert.deepEqual(req.body.response_format, { type: 'json_object' });
  assert.equal(req.opts.headers['Authorization'], 'Bearer text-key');
  assert.equal(req.url, 'https://llm.example.com/v1/chat/completions');
  // User message is the extracted text (a string), not an image_url array.
  assert.equal(typeof req.body.messages[1].content, 'string');
});

// ── 12.2 Image / scanned-PDF path (layer 2) ────────────────────────────────

test('12.2 image extraction uses the vision LLM with image_url content + API key fallback', async () => {
  mockFetch(() => okResponse(JSON.stringify(CANNED)));

  const att = { contentType: 'image/png', filename: 'receipt.png', buffer: PNG_1x1, text: '' };
  const payload = { entityId: 'att-2', filename: 'receipt.png', contentType: 'image/png' };
  const settings = {
    llm_api_key: 'text-key', // vision key blank → must fall back to this
    llm_vision_endpoint_url: 'https://vision.example.com',
    llm_vision_model: 'test-vision-model',
    llm_temperature: '0.1',
    // llm_vision_api_key intentionally omitted (empty)
  };

  const bill = await extractBillData(att, payload, settings, 'CO', 'agent@ct');

  assert.equal(bill.partner_name, 'Acme');
  assert.equal(bill.amount, 1000);
  assert.equal(bill._source_attachment_id, 'att-2');

  assert.equal(_fetchCalls.length, 1, 'vision LLM called exactly once');
  const req = _fetchCalls[0];
  assert.equal(req.body.model, 'test-vision-model');
  assert.deepEqual(req.body.response_format, { type: 'json_object' });
  // Authorization falls back to llm_api_key.
  assert.equal(req.opts.headers['Authorization'], 'Bearer text-key');
  assert.equal(req.url, 'https://vision.example.com/v1/chat/completions');

  // User message is an array with a text part + an image_url part.
  const userContent = req.body.messages[1].content;
  assert.ok(Array.isArray(userContent), 'user content is a multimodal array');
  const imgPart = userContent.find((p) => p.type === 'image_url');
  assert.ok(imgPart, 'image_url part present');
  assert.ok(typeof imgPart.image_url.url === 'string');
  assert.match(imgPart.image_url.url, /^data:image\/png;base64,/);
});

// ── 12.3 No vision config → skeleton fallback (layer 3) ────────────────────

test('12.3 image with no vision config falls back to skeleton without calling fetch', async () => {
  mockFetch(() => okResponse(JSON.stringify(CANNED)));

  const att = { contentType: 'image/png', filename: 'receipt.png', buffer: PNG_1x1, text: '' };
  const payload = { entityId: 'att-3', filename: 'receipt.png', contentType: 'image/png' };
  const settings = {}; // no vision config, no text LLM

  const bill = await extractBillData(att, payload, settings, 'CO', 'agent@ct');

  assert.equal(_fetchCalls.length, 0, 'fetch never called');
  assert.equal(bill.currency, null);
  assert.deepEqual(bill.lines, []);
  assert.equal(bill._source_attachment_id, 'att-3');
  assert.equal(bill._source_filename, 'receipt.png');
});

// ── 12.4 No LLM configured at all → skeleton ───────────────────────────────

test('12.4 text PDF with no LLM configured at all falls back to skeleton', async () => {
  stubPdfParse('Vendor: Acme\nAmount: 1000\nDate: 2026-08-07\nThis text layer is long enough to clear the 50-char floor heuristic for sure.');
  mockFetch(() => okResponse(JSON.stringify(CANNED)));

  const att = { contentType: 'application/pdf', filename: 'invoice.pdf', buffer: Buffer.from('%PDF-1.4 dummy'), text: '' };
  const payload = { entityId: 'att-4', filename: 'invoice.pdf', contentType: 'application/pdf' };
  const settings = {}; // no llm_endpoint_url, no vision

  const bill = await extractBillData(att, payload, settings, 'CO', 'agent@ct');

  assert.equal(_fetchCalls.length, 0, 'fetch never called');
  assert.equal(bill.currency, null);
  assert.deepEqual(bill.lines, []);
  assert.equal(bill._source_attachment_id, 'att-4');
});

// ── 12.5 Unparseable LLM JSON → fall through ────────────────────────────────

test('12.5 text LLM returns non-JSON and no vision → skeleton (layer 3)', async () => {
  stubPdfParse('Vendor: Acme\nAmount: 1000\nDate: 2026-08-07\nPlenty of embedded text to exceed the 50 character floor comfortably.');
  mockFetch(() => okResponse('not json'));

  const att = { contentType: 'application/pdf', filename: 'invoice.pdf', buffer: Buffer.from('%PDF-1.4 dummy'), text: '' };
  const payload = { entityId: 'att-5', filename: 'invoice.pdf', contentType: 'application/pdf' };
  const settings = {
    llm_endpoint_url: 'https://llm.example.com',
    llm_model: 'test-model',
    // no vision configured
  };

  const bill = await extractBillData(att, payload, settings, 'CO', 'agent@ct');

  assert.equal(_fetchCalls.length, 1, 'text LLM attempted once');
  assert.equal(bill.currency, null, 'fell through to skeleton');
  assert.deepEqual(bill.lines, []);
});

test('12.5-variant text LLM fails → vision LLM succeeds (layer 2)', async () => {
  stubPdfParse('Vendor: Acme\nAmount: 1000\nDate: 2026-08-07\nEmbedded text that exceeds the heuristic floor so layer 1 is entered and calls the text LLM.');
  // First call (text LLM, model test-model) → non-JSON. Second (vision) → canned.
  mockFetch((_url, _opts, call) => {
    if (call.body.model === 'test-model') return okResponse('not json');
    return okResponse(JSON.stringify(CANNED));
  });

  const att = { contentType: 'application/pdf', filename: 'scan.pdf', buffer: PNG_1x1, text: '' };
  const payload = { entityId: 'att-5b', filename: 'scan.pdf', contentType: 'application/pdf' };
  const settings = {
    llm_endpoint_url: 'https://llm.example.com',
    llm_model: 'test-model',
    llm_vision_endpoint_url: 'https://vision.example.com',
    llm_vision_model: 'test-vision-model',
  };

  const bill = await extractBillData(att, payload, settings, 'CO', 'agent@ct');

  assert.equal(_fetchCalls.length, 2, 'text LLM then vision LLM both called');
  assert.equal(bill.partner_name, 'Acme', 'bill populated from vision layer');
  assert.equal(bill.amount, 1000);
  // Second call used the vision model + image_url content.
  const visionReq = _fetchCalls[1];
  assert.equal(visionReq.body.model, 'test-vision-model');
  assert.ok(Array.isArray(visionReq.body.messages[1].content));
});

// ── 12.6 bill.create failure does not create a draft ───────────────────────

test('12.6 bill.create failure is handled by processBill (no draft, no throw)', async () => {
  stubPdfParse('Vendor: Acme\nAmount: 1000\nDate: 2026-08-07\nNo LLM configured, so extraction yields a skeleton; bill.create then throws.');
  let billCreateCalls = 0;
  const dispatch = makeDispatch(async (params) => {
    billCreateCalls++;
    throw new Error('boom: bill.create failed');
  });
  _setLoopDeps({ dispatchAction: dispatch, fetchAttachmentFn: async () => ({
    contentType: 'application/pdf', filename: 'invoice.pdf', buffer: Buffer.from('%PDF-1.4'), text: '',
  }) });

  // No LLM configured → extractBillData returns skeleton; processBill then
  // dispatches bill.create which throws.
  const ev = { entity_id: 'att-6' };
  const settings = {};

  // processBill must not throw — it catches the bill.create error.
  await assert.doesNotReject(() => processBill(ev, 'CO', 'agent@ct', settings));

  assert.equal(billCreateCalls, 1, 'bill.create was attempted exactly once');
  // No draft created because the dispatch threw — the contract is that the
  // error is logged and intake is not blocked (no throw to the caller).
});

// ── 12.7 Non-regression: skeleton still works end-to-end ───────────────────

test('12.7 with no LLM config a dropped PDF still produces a skeleton bill.create draft', async () => {
  stubPdfParse('Vendor: Acme\nAmount: 1000\nDate: 2026-08-07\nNo LLM endpoints configured so this falls all the way to the skeleton floor.');
  let createdBill = null;
  const dispatch = makeDispatch(async (params) => {
    createdBill = params.bill;
    return { bill_id: 'b-skeleton-1' };
  });
  _setLoopDeps({ dispatchAction: dispatch, fetchAttachmentFn: async () => ({
    contentType: 'application/pdf', filename: 'invoice.pdf', buffer: Buffer.from('%PDF-1.4'), text: '',
  }) });

  const ev = { entity_id: 'att-7' };
  const settings = {}; // no LLM, no vision

  await processBill(ev, 'CO', 'agent@ct', settings);

  assert.ok(createdBill, 'bill.create was called with a bill object');
  // Skeleton shape: partner_name absent/null, no lines, attachment linkage carried through.
  assert.ok(!createdBill.partner_name, 'partner_name null/absent in skeleton');
  assert.equal(createdBill.currency, null);
  assert.deepEqual(createdBill.lines, []);
  assert.equal(createdBill._source_attachment_id, 'att-7');
  assert.equal(createdBill._source_filename, 'invoice.pdf');
});

// ── Prompt builder sanity (spec §8) ─────────────────────────────────────────

test('buildBillExtractionPrompt includes COA and VAT codes', () => {
  const prompt = buildBillExtractionPrompt(
    [{ account_code: '4000', account_name: 'Supplies' }, { account_code: '6000', account_name: 'Consulting' }],
    [{ vat_code: 'S25', rate: 0.25 }],
  );
  assert.match(prompt, /Chart of accounts \(code name\):/);
  assert.match(prompt, /4000 Supplies/);
  assert.match(prompt, /6000 Consulting/);
  assert.match(prompt, /VAT codes \(code rate\):/);
  assert.match(prompt, /S25 25%/);
  assert.match(prompt, /vendor_invoice_number/);
  assert.match(prompt, /account_code_hint/);
  assert.match(prompt, /vat_code/);
});
