'use strict';
/**
 * Verification test for the periodsChildren _new_ guard in api/src/pages/periods.js.
 *
 * periodsChildren is inline client-side JS (not importable), so this test
 * extracts the function source from the page file, evals it in a minimal
 * sandbox with stubbed postAction / caches, and asserts:
 *   1. { _key: '_new_1' } → returns [] and does NOT call postAction
 *   2. { _key: 'FY2025' } → returns [] synchronously (async fetch path)
 *      AND calls postAction (i.e. the fetch path is still live)
 *
 * Realm note: the sandbox is a separate vm context, so arrays returned from
 * periodsChildren have a different Array constructor than the test realm.
 * deepStrictEqual rejects cross-realm arrays, so we assert via Array.isArray
 * (cross-realm safe) + .length instead.
 *
 * Run: node --test tests/periods-children-guard.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const file = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'api',
  'src',
  'pages',
  'periods.js',
);

const src = fs.readFileSync(file, 'utf8');

function extractFn(name) {
  const m = src.match(new RegExp(`function ${name}\\b[\\s\\S]*?\\n}\\n`));
  assert.ok(m, `function ${name} not found in ${file}`);
  return m[0];
}

const periodsChildrenSrc = extractFn('periodsChildren');
const fetchPeriodChildrenSrc = extractFn('fetchPeriodChildren');
const filingChildRowSrc = extractFn('filingChildRow');
const checklistChildRowSrc = extractFn('checklistChildRow');

function makeSandbox() {
  const calls = [];
  const sb = {
    periodChildCache: {},
    postAction: (action, payload) => {
      calls.push({ action, payload });
      return Promise.resolve({ data: { filings: [{ id: 1 }], items: [{ id: 'c1' }] } });
    },
    FB: { status: { show() {} } },
    periodsList: { render() {} },
    Promise,
    Object,
    String,
    filingChildRow: (f) => ({ _kind: 'filing', ...f }),
    checklistChildRow: (c) => ({ _kind: 'checklist', ...c }),
  };
  vm.createContext(sb);
  vm.runInContext(
    periodsChildrenSrc + fetchPeriodChildrenSrc + filingChildRowSrc + checklistChildRowSrc,
    sb,
  );
  return { sb, calls };
}

function assertEmptyArray(val, msg) {
  assert.equal(Array.isArray(val), true, msg + ' (should be array)');
  assert.equal(val.length, 0, msg + ' (should be empty)');
}

test('periodsChildren({ _key: "_new_1" }) returns [] and skips fetch', () => {
  const { sb, calls } = makeSandbox();
  const out = sb.periodsChildren({ _key: '_new_1' });
  assertEmptyArray(out, 'unsaved _new_ row should yield no children');
  assert.equal(calls.length, 0, 'no postAction fetch should be attempted');
  assert.equal(
    sb.periodChildCache['_new_1'],
    undefined,
    'no cache entry created for _new_ row',
  );
});

test('periodsChildren({ _key: "FY2025" }) triggers the fetch path', async () => {
  const { sb, calls } = makeSandbox();
  const out = sb.periodsChildren({ _key: 'FY2025' });
  assertEmptyArray(out, 'first call returns [] while fetch is in flight');
  assert.equal(
    sb.periodChildCache['FY2025'].fetching,
    true,
    'cache entry created with fetching=true',
  );

  const actions = calls.map((c) => c.action).sort();
  assert.deepEqual(
    actions,
    ['filing.list', 'period.close_check'],
    'both child-fetch actions must be dispatched for a real period',
  );
  for (const c of calls) {
    assert.equal(c.payload.periodId, 'FY2025', 'payload carries periodId through');
  }

  await new Promise((r) => setImmediate(r));
  assert.equal(
    sb.periodChildCache['FY2025'].fetched,
    true,
    'cache entry flips to fetched after fetch resolves',
  );
});

test('guard is a prefix match — "_new_*" keys skip, mid-string does not', () => {
  const { sb } = makeSandbox();

  for (const k of ['_new_1', '_new_42', '_new_', '_new_foo']) {
    sb.periodChildCache = {};
    const out = sb.periodsChildren({ _key: k });
    assertEmptyArray(out, `key "${k}" should be guarded`);
    assert.equal(
      sb.periodChildCache[k],
      undefined,
      `no cache entry for "${k}"`,
    );
  }

  // A key that merely contains _new_ mid-string should NOT be guarded.
  sb.periodChildCache = {};
  sb.periodsChildren({ _key: 'FY_new_x' });
  assert.ok(
    sb.periodChildCache['FY_new_x'],
    'mid-string _new_ should NOT trip the guard (fetch path engaged)',
  );
});
