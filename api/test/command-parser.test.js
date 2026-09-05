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

// ── global-search-spec.md §0: `:` command mode is fully retired — its parser
// (ALIASES, tokenize(), parse(), grammarFor()) was removed 2026-09-05 after
// confirming zero callers anywhere. parseSearchScope()/SEARCH_SCOPES are the
// only surviving API — fb-core.js's FB.search calls parseSearchScope directly
// for the `/p:`/`/a:`/`/j:`/`/b:` power-user fast paths (spec §7).

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
