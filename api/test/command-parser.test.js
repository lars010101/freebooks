'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// fb-command.js is a browser IIFE that sets window.FB.command.
// We simulate a minimal browser env to load and test it.
// In browsers, `window.FB = ...` also creates global `FB`. To replicate
// that in Node, we alias window → global so property writes land on the
// global object and bare `FB` references resolve.
global.window = global;
global.document = { createElement: function() { return { style: {}, classList: { add: function(){}, remove: function(){} } }; } };
global.localStorage = { getItem: function(){return null;}, setItem: function(){} };

// Load the IIFE
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'fb-command.js'), 'utf8');
eval(src);

const cmd = global.window.FB.command;

// ── global-search-spec.md §0: fb-command.js's `:` is now fully retired — its
// last two commands, vat-tolerance/gst-tolerance, are gone (edited through
// Settings → Extensions instead). ALIASES is empty; parse()/tokenize()/
// grammarFor() remain as general infrastructure (Tier-0 raw catalog-action
// parsing, unknown-command handling), exercised below with generic input.

test('tokenize: basic whitespace split', () => {
  const r = cmd.tokenize('foo 500 bar');
  assert.deepStrictEqual(r.tokens, ['foo', '500', 'bar']);
  assert.strictEqual(r.bang, false);
});

test('tokenize: trailing bang extracted', () => {
  const r = cmd.tokenize('foo 500 bar !');
  assert.deepStrictEqual(r.tokens, ['foo', '500', 'bar']);
  assert.strictEqual(r.bang, true);
});

test('grammarFor: null for a retired alias (bill)', () => {
  assert.strictEqual(cmd.grammarFor('bill'), null);
});

test('grammarFor: null for unknown alias', () => {
  assert.strictEqual(cmd.grammarFor('frobnicate'), null);
});

test('parse: :bill is now unknown — alias retired (global-search-spec.md §0)', () => {
  const r = cmd.parse(':bill acme 1200');
  assert.strictEqual(r.type, 'unknown');
});

test('parse: :report is now unknown — replaced by search categories (§5)', () => {
  const r = cmd.parse(':report pl');
  assert.strictEqual(r.type, 'unknown');
});

test('parse: :token is now unknown — migrated to Access tab UI', () => {
  const r = cmd.parse(':token create agent-hermes');
  assert.strictEqual(r.type, 'unknown');
});

test('parse: raw catalog action (Tier 0 escape hatch, unchanged)', () => {
  const r = cmd.parse(':journal.propose companyId=abc');
  assert.strictEqual(r.type, 'raw');
  assert.strictEqual(r.action, 'journal.propose');
});

test('parse: unknown command', () => {
  const r = cmd.parse(':frobnicate');
  assert.strictEqual(r.type, 'unknown');
  assert.ok(r.error);
});

test('parse: empty', () => {
  const r = cmd.parse(':');
  assert.strictEqual(r.type, 'empty');
});

// ── parseSearchScope / SEARCH_SCOPES — survive unchanged (global-search-spec.md
// §7): fb-core.js's FB.search calls these directly for the `/p:`/`/a:`/`/j:`/
// `/b:` power-user fast paths.

test('parseSearchScope: /p:acme', () => {
  const r = cmd.parseSearchScope('/p:acme');
  assert.strictEqual(r.scope, 'partner');
  assert.strictEqual(r.query, 'acme');
});

test('parseSearchScope: /a:cash', () => {
  const r = cmd.parseSearchScope('/a:cash');
  assert.strictEqual(r.scope, 'account');
  assert.strictEqual(r.query, 'cash');
});

test('parseSearchScope: /j:1023', () => {
  const r = cmd.parseSearchScope('/j:1023');
  assert.strictEqual(r.scope, 'journal');
  assert.strictEqual(r.query, '1023');
});

test('parseSearchScope: /b:', () => {
  const r = cmd.parseSearchScope('/b:');
  assert.strictEqual(r.scope, 'bill');
  assert.strictEqual(r.query, '');
});

test('parseSearchScope: unscoped', () => {
  const r = cmd.parseSearchScope('/acme');
  assert.strictEqual(r.scope, null);
  assert.strictEqual(r.query, 'acme');
});
