'use strict';
// Roadmap §0r residual (a): an oversized event payload was sliced mid-string
// at 4000 chars and stored as INVALID JSON — every JSON.parse consumer
// (agents polling event.list, the MCP event_list tool) broke on exactly the
// largest events. Hermetic unit test of the serializer: no DB, no server.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { serializePayload, MAX_PAYLOAD_CHARS } = require('../src/events');

test('small payload round-trips byte-identical', () => {
  const obj = { a: 1, b: 'x', nested: { c: [1, 2, 3] } };
  const out = serializePayload(obj);
  assert.equal(out, JSON.stringify(obj));
  assert.deepEqual(JSON.parse(out), obj);
});

test('null/undefined payload → null (no row payload)', () => {
  assert.equal(serializePayload(null), null);
  assert.equal(serializePayload(undefined), null);
});

test('oversized payload → VALID marked envelope within the cap', () => {
  const big = { description: 'x'.repeat(MAX_PAYLOAD_CHARS * 3), n: 42 };
  const out = serializePayload(big);
  assert.ok(out.length <= MAX_PAYLOAD_CHARS, `len ${out.length} exceeds cap ${MAX_PAYLOAD_CHARS}`);
  const parsed = JSON.parse(out); // must not throw — this is the regression
  assert.equal(parsed._truncated, true);
  assert.equal(parsed.original_chars, JSON.stringify(big).length);
  assert.equal(typeof parsed.preview, 'string');
  assert.ok(parsed.preview.length > 0, 'preview keeps the head of the original JSON');
});

test('non-serializable payload degrades to a valid string', () => {
  const circular = {}; circular.self = circular;
  const out = serializePayload(circular);
  assert.equal(out, JSON.stringify(String(circular)));
});
