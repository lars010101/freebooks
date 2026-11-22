'use strict';
// Background job scheduler (#311).

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  delete require.cache[require.resolve('../src/scheduler')];
  return require('../src/scheduler');
}
let current = null;
afterEach(() => { if (current) current.stop(); delete process.env.FREEBOOKS_SCHEDULER; });

test('runs each job at start and on its interval; start awaits only awaitStart jobs', async () => {
  const s = current = fresh();
  let gc = 0, scan = 0, slowDone = false;
  s.register({ name: 'gc', intervalMs: 40, run: async () => { gc++; }, awaitStart: true });
  s.register({ name: 'scan', intervalMs: 40, run: async () => { scan++; } });
  s.register({ name: 'slow', intervalMs: 10000, run: () => new Promise(r => setTimeout(() => { slowDone = true; r(); }, 200)) });
  await s.start();
  assert.equal(gc, 1, 'awaitStart job finished before start() resolved');
  assert.equal(slowDone, false, 'non-awaited start run continues in the background');
  await new Promise(r => setTimeout(r, 130));
  assert.ok(gc >= 3 && scan >= 3, `interval runs happened (gc=${gc}, scan=${scan})`);
});

test('a failing job is logged and does not stop the others', async () => {
  const s = current = fresh();
  let ok = 0;
  s.register({ name: 'boom', intervalMs: 30, run: async () => { throw new Error('kaput'); }, awaitStart: true });
  s.register({ name: 'fine', intervalMs: 30, run: async () => { ok++; }, awaitStart: true });
  await s.start();
  await new Promise(r => setTimeout(r, 80));
  const st = Object.fromEntries(s.status().map(j => [j.name, j]));
  assert.equal(st.boom.lastError, 'kaput');
  assert.ok(st.boom.runs >= 2, 'failing job keeps being retried on its interval');
  assert.ok(ok >= 2);
});

test('overlapping runs of the same job are skipped', async () => {
  const s = current = fresh();
  let concurrent = 0, maxConcurrent = 0;
  s.register({ name: 'long', intervalMs: 20, run: async () => {
    concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise(r => setTimeout(r, 90));
    concurrent--;
  } });
  await s.start();
  await new Promise(r => setTimeout(r, 200));
  assert.equal(maxConcurrent, 1);
});

test('FREEBOOKS_SCHEDULER=off runs nothing', async () => {
  process.env.FREEBOOKS_SCHEDULER = 'off';
  const s = current = fresh();
  let n = 0;
  s.register({ name: 'x', intervalMs: 10, run: async () => { n++; }, awaitStart: true });
  await s.start();
  await new Promise(r => setTimeout(r, 40));
  assert.equal(n, 0);
});

test('register validates its input', () => {
  const s = current = fresh();
  assert.throws(() => s.register({ name: 'a', intervalMs: 0, run: () => {} }), /positive/);
  assert.throws(() => s.register({ intervalMs: 10, run: () => {} }), /name/);
  s.register({ name: 'dup', intervalMs: 10, run: () => {} });
  assert.throws(() => s.register({ name: 'dup', intervalMs: 10, run: () => {} }), /already registered/);
});
