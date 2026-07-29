// K5 — keyboard-coverage crawl: the framework-level gate that replaces
// per-tab key verification (keyboard-ux-spec §coverage gate).
//
// For every route in the single-source registry (api/src/nav-registry.js,
// plus the two parameterized create/detail pages mounted in reports.js):
//   a. page loads with zero uncaught JS errors
//   b. FB.keys.hasActive() — a registered binding set is live
//   c. the hint surface (#sb-hints or an inline .fb-hint-bar) is non-empty
//   d. FB.keys.audit() shows ≥1 ACTIVE set with ≥1 NORMAL binding
//   e. every visible interactive control inside #page-main is covered:
//        i.  contained in an FB.coverage.roots() element (FB.form zone row,
//            FB.list table, FB.nav row set, attach panel, open dropdown), OR
//        ii. a native text-entry field (input text/date/number/etc.,
//            textarea, select — INSERT-mode typing IS the keyboard path), OR
//        iii. listed in EXEMPTIONS below with a ratified reason.
//
// Global (once): the `:` palette lists 'Go to {label}' for every registry
// entry with palette:true (registry → palette wiring can't silently drift).
//
// Exit 0 only when every check passes AND the triage list is empty. Any
// uncovered control is a REAL gap: fix it (wire the control into a zone or
// give it a verb) or ratify an exemption in the spec — never silence it.
//
// Run: npm run test:keys   (fixture server on :4722, company testco)

import { chromium } from 'playwright-core';
import { ROUTES } from '../api/src/nav-registry.js';

const BASE = 'http://127.0.0.1:4722';
const CO = 'testco';

// Ratified exemptions — each entry cites its justification; entries with a
// `verb` are SELF-CHECKING: the crawl verifies a live binding with that key
// exists on the route, so the exemption breaks loudly if the verb is removed.
// Match by `id`, exact `text`, or `sel` (css selector).
const EXEMPTIONS = {
  'bank': [
    { id: 'filter-cleared', verb: 'f', reason: 'verb parity — f cycles filter states (uncleared → cleared → both); individual checkboxes stay mouse-native' },
    { id: 'filter-uncleared', verb: 'f', reason: 'verb parity — f cycles filter states (uncleared → cleared → both); individual checkboxes stay mouse-native' },
    { id: 'hdr-clear-all', reason: 'ratified: bulk convenience only — per-row ~ is the keyboard path; QBO/Xero have no bulk-clear hotkey (mouse parity preserved)' },
  ],
  'settings': [
    { id: 'cr-delete-btn', reason: 'ratified: danger-zone trigger is deliberately mouse-only (GitHub/QBO precedent); the K2 modal owns keyboard confirm via type-to-confirm once open' },
  ],
  'journal-new': [
    { id: 'btn-reversal-mode', verb: 'R', reason: 'verb parity — R toggles reversal mode' },
    { text: '+ Add Line', verb: 'a', reason: 'verb parity — a adds a line' },
    { id: 'btn-post', verb: 'w', reason: 'verb parity — w posts the entry' },
  ],
  'new-company': [
    { text: '+ Add Period', verb: 'a', reason: 'verb parity — a adds a period row' },
    { id: 'btn-create', verb: 'w', reason: 'verb parity — w creates the company' },
  ],
  'bill-detail': [
    { text: '📎 Add Attachment', verb: 'A', reason: 'verb parity — A opens the attach picker' },
  ],
  'bill-edit': [
    { sel: '.be-line-x', reason: 'ratified: row-level mouse affordance on an INSERT-first surface; keyboard line-delete lands with bill-edit FB.form migration (roadmap)' },
    { id: 'be-attach-btn', verb: 'A', reason: 'verb parity — A opens the file picker' },
    { id: 'be-post', verb: 'p', reason: 'verb parity — p posts the bill' },
    { id: 'be-save', verb: 'q', reason: 'verb parity — q quits the editor' },
  ],
};

// Stub routes (no workflows yet) — key assertions relax to JS-errors +
// control-coverage only, with the reason cited. Removed the day the module
// ships (AR: FB.list from day one — ratified backlog).
const STUB_ROUTES = {
  'receivables': 'stub page (Coming Soon) — AR module is the next ratified backlog item and builds on FB.list from day one',
};

let pass = 0, fail = 0;
const triage = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL:', name, detail ? `— ${detail}` : ''); }
}

async function act(action, body = {}) {
  const r = await fetch(`${BASE}/api/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ companyId: CO, action, ...body })
  });
  const j = await r.json();
  if (j.error) throw new Error(`${action}: ${JSON.stringify(j.error)}`);
  return j.data !== undefined ? j.data : j;
}

// ── Route table: registry routes + parameterized pages outside the registry ──
const bills = await act('bill.list');
const BILL_ID = bills[0] && bills[0].bill_id;
const routes = ROUTES.map(r => ({
  key: r.key,
  path: r.absolute ? r.route : r.route.replace(':company', CO),
  palette: r.palette, label: r.label,
}));
routes.push({ key: 'bill-edit', path: `/${CO}/bill/edit`, palette: false, label: 'Bill Edit' });
if (BILL_ID) routes.push({ key: 'bill-detail', path: `/${CO}/bill/${BILL_ID}`, palette: false, label: 'Bill Detail' });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

// ── Global: palette lists every palette:true registry route ──────────────────
console.log('[global] palette route coverage');
await page.goto(`${BASE}/${CO}/bank`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.keyboard.press(':');
await page.waitForTimeout(400);
const paletteOpen = await page.evaluate(() => !!document.querySelector('.fb-palette'));
ok('palette opens on :', paletteOpen);
// The default view shows key hints + catalog actions; route rows are found
// by typing the destination (registry → palette wiring is what we prove).
// Re-open the palette per route — clearing the input mid-session flips the
// palette out of command mode and non-sidebar route rows vanish (probe-
// verified), so each check starts from a fresh ':' open.
for (const r of ROUTES.filter(r => r.palette)) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await page.keyboard.press(':');
  await page.waitForTimeout(300);
  await page.keyboard.type(r.label, { delay: 15 });
  await page.waitForTimeout(250);
  const labels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.fb-palette-row .fb-palette-label')).map(el => el.textContent.trim()));
  ok(`palette lists "Go to ${r.label}"`, labels.some(l => l.includes(r.label)), `got: ${labels.slice(0, 6).join(' | ') || '(no rows)'}`);
}
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// ── Per-route crawl ──────────────────────────────────────────────────────────
const COVERAGE_EVAL = `(function () {
  var main = document.getElementById('page-main') || document.body;
  var roots = (window.FB && FB.coverage) ? FB.coverage.roots() : [];
  var TEXTY = { text: 1, date: 1, number: 1, email: 1, search: 1, password: 1, month: 1, time: 1, '': 1 };
  var out = [];
  var els = main.querySelectorAll('button, select, input:not([type=hidden]):not([type=file]), textarea, a[onclick], [contenteditable=true]');
  els.forEach(function (el) {
    if (!el.offsetParent || el.disabled) return;
    // rule i: inside a coverage root
    for (var i = 0; i < roots.length; i++) {
      if (roots[i] && roots[i].contains(el)) return;
    }
    // rule ii: native text-entry field (INSERT-mode typing is the path)
    var tag = el.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'select') return;
    if (tag === 'input' && TEXTY[(el.getAttribute('type') || '').toLowerCase()]) return;
    // uncovered — describe for triage
    out.push({
      id: el.id || null,
      tag: tag,
      type: (el.getAttribute('type') || ''),
      cls: (el.className && el.className.baseVal === undefined) ? String(el.className).slice(0, 60) : '',
      text: (el.textContent || '').trim().slice(0, 40),
      html: el.outerHTML.slice(0, 120)
    });
  });
  return out;
})()`;

for (const r of routes) {
  console.log(`\n[${r.key}] ${r.path}`);
  const errors = [];
  const onErr = e => errors.push(String(e).slice(0, 200));
  page.on('pageerror', onErr);
  try {
    await page.goto(`${BASE}${r.path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    ok('zero uncaught JS errors', errors.length === 0, errors[0]);

    const state = await page.evaluate(() => {
      var sb = document.getElementById('sb-hints');
      var inlineHint = document.querySelector('.fb-hint-bar');
      return {
        hasKeysApi: !!(window.FB && FB.keys && FB.keys.audit),
        hasActive: !!(window.FB && FB.keys && FB.keys.hasActive && FB.keys.hasActive()),
        hintLen: (sb ? sb.textContent.trim().length : 0) + (inlineHint ? inlineHint.textContent.trim().length : 0),
        audit: (window.FB && FB.keys && FB.keys.audit) ? FB.keys.audit() : null
      };
    });

    const stub = STUB_ROUTES[r.key];
    if (stub) console.log(`  · stub route — ${stub}`);
    ok('FB.keys set active (hasActive)', stub || state.hasActive);
    ok('hint surface non-empty', stub || state.hintLen > 0, '#sb-hints/.fb-hint-bar empty');
    const activeSet = state.audit ? state.audit.find(s => s.active && s.bindings.some(b => b.mode === 'NORMAL')) : null;
    ok('audit: ≥1 active set with NORMAL bindings', stub || !!activeSet,
      state.audit ? `sets: ${state.audit.map(s => `${s.name}(${s.active ? 'on' : 'off'})`).join(', ')}` : 'audit() missing');

    // control coverage — exemptions match by id / exact text / selector;
    // `verb` exemptions are self-checking (a live binding must exist)
    const uncovered = await page.evaluate(COVERAGE_EVAL);
    const exempt = (EXEMPTIONS[r.key] || []);
    const activeKeys = state.audit
      ? [].concat(...state.audit.filter(s => s.active).map(s => s.bindings.map(b => b.key)))
      : [];
    const real = [];
    for (const u of uncovered) {
      const x = exempt.find(x =>
        (x.id && u.id === x.id) ||
        (x.text && u.text === x.text) ||
        (x.sel && u.cls && u.cls.split(' ').indexOf(x.sel.replace('.', '')) >= 0));
      if (!x) { real.push(u); continue; }
      if (x.verb && !activeKeys.includes(x.verb)) {
        real.push({ ...u, html: u.html + ` [exemption broken: verb "${x.verb}" has no live binding]` });
      }
    }
    ok(`all visible controls covered (${uncovered.length - real.length} exempt)`, real.length === 0,
      `${real.length} uncovered`);
    real.forEach(u => triage.push({ route: r.path, id: u.id, tag: u.tag, type: u.type, text: u.text, html: u.html }));
  } catch (e) {
    fail++;
    console.log('  ✗ FAIL: route error —', String(e).slice(0, 200));
    triage.push({ route: r.path, id: null, tag: 'ROUTE', type: '', text: String(e).slice(0, 120), html: '' });
  } finally {
    page.off('pageerror', onErr);
  }
}

// ── Triage ───────────────────────────────────────────────────────────────────
console.log('\n=== TRIAGE (uncovered controls) ===');
if (!triage.length) console.log('  (none — every visible control is keyboard-managed)');
triage.forEach(t => {
  console.log(`  ${t.route} | ${t.id ? '#' + t.id : t.tag + (t.type ? `[type=${t.type}]` : '')} | ${t.text}`);
  if (t.html) console.log(`      ${t.html}`);
});

console.log(`\n=== ${pass} passed, ${fail} failed, ${triage.length} triage ===`);
await browser.close();
process.exit(fail === 0 && triage.length === 0 ? 0 : 1);
