/**
 * Journal document extraction through the shared extraction pipeline (#310).
 *
 * Bill extraction has its own suite (bill-extraction.test.mjs). These tests
 * pin the journal-specific wiring of the shared _extractDocument pipeline: the
 * journal image instruction and prompt-snapshot context reach the LLM call,
 * and the pipeline's failure paths report correctly for journal documents.
 * globalThis.fetch is stubbed; vat.codes.list goes through an injected
 * dispatchAction; DB-backed context queries hit the test runner's throwaway
 * database (db.js NODE_TEST_CONTEXT guard), so they return empty sets.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractJournalDocumentData, _setLoopDeps } from '../api/src/agent-loop.js';

const SETTINGS = { llm_endpoint_url: 'http://llm.test/v1', llm_model: 'test-model', llm_api_key: 'k' };
const IMAGE = { filename: 'receipt.png', contentType: 'image/png', buffer: Buffer.from('fake-png') };

let calls, origFetch, nextResponse;
beforeEach(() => {
  calls = [];
  origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return nextResponse();
  };
  _setLoopDeps({ dispatchAction: async (action) => (action === 'vat.codes.list' ? [] : null), fetchAttachmentFn: null });
});
afterEach(() => {
  globalThis.fetch = origFetch;
  _setLoopDeps({ dispatchAction: null, fetchAttachmentFn: null });
});

function llmReturns(content) {
  return () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

test('image document: journal instruction + journal context summary reach the LLM call', async () => {
  nextResponse = llmReturns(JSON.stringify({ date: '2026-10-01', gross_total: 125, line_items: [] }));
  const r = await extractJournalDocumentData(IMAGE, {}, SETTINGS, 'jx_co', 'agent@test');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://llm.test/v1/chat/completions');
  const user = calls[0].body.messages[1].content;
  assert.equal(user[0].text, 'Extract the journal-entry data from this document.');
  assert.match(user[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(r.prompt_snapshot.content_type, 'image');
  assert.ok('account_count' in r.prompt_snapshot.context, 'journal context summary, not the bill one');
  assert.ok('default_cash_account' in r.prompt_snapshot.context);
  assert.ok(!('partner_count' in r.prompt_snapshot.context));
});

test('no LLM configured → no_llm_configured, no call made', async () => {
  const r = await extractJournalDocumentData(IMAGE, {}, {}, 'jx_co', 'agent@test');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_llm_configured');
  assert.equal(calls.length, 0);
});

test('LLM HTTP error → extraction_failed with status kept', async () => {
  nextResponse = () => new Response('upstream down', { status: 502 });
  const r = await extractJournalDocumentData(IMAGE, {}, SETTINGS, 'jx_co', 'agent@test');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'extraction_failed');
  assert.equal(r.raw_model_output.http_status, 502);
  assert.ok(r.prompt_snapshot, 'prompt snapshot kept on failure');
});

test('non-JSON model content → extraction_failed', async () => {
  nextResponse = llmReturns('not json at all');
  const r = await extractJournalDocumentData(IMAGE, {}, SETTINGS, 'jx_co', 'agent@test');
  assert.equal(r.ok, false);
  assert.equal(r.detail, 'Non-JSON content from LLM');
});
