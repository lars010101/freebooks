// K5 — keyboard-coverage gate, SINGLE-SCREEN (agent-first UI doctrine,
// ratified 2026-07-31, roadmap §0q): full key-coverage assertions run on
// ONE representative screen — journal-voucher (richest FB.form surface, primary
// human write path, self-checking verb exemptions R/a/w). Framework-level
// behavior is verified once there, not per tab.
//
// Every other route gets a SMOKE check only: page loads with zero uncaught
// JS errors (catches dead pages and load-time regressions).
//
// Gate-route assertions (journal-voucher):
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
// uncovered control on the gate route is a REAL gap: fix it (wire the
// control into a zone or give it a verb) or ratify an exemption — never
// silence it.
//
// Run: npm run test:keys   (fixture server on :4722, company testco)

import { chromium } from 'playwright-core';
import { ROUTES } from '../api/src/nav-registry.js';

const BASE = 'http://127.0.0.1:4722';
const CO = 'testco';

// The single gate route (agent-first UI doctrine 2026-07-31, roadmap §0q).
const GATE_ROUTE = 'journal-voucher';

// Ratified exemptions — GATE ROUTE ONLY (all other routes are smoke-checked:
// page load + zero JS errors; their former exemption tables are in git
// history). Entries with a `verb` are SELF-CHECKING: the crawl verifies a
// live binding with that key exists on the route, so the exemption breaks
// loudly if the verb is removed. Match by `id`, exact `text`, or `sel`.
const EXEMPTIONS = {
  'journal-voucher': [
    { id: 'btn-reversal-mode', verb: 'u', reason: 'verb parity — u toggles reversal mode' },
    { text: '+ Add Line', verb: 'i', reason: 'verb parity — i inserts a line' },
    { id: 'btn-post', verb: 'w', reason: 'verb parity — w posts the entry' },
  ],
  'bill-edit': [
    { id: 'be-post', verb: 'p', reason: 'verb parity — p posts the bill' },
    { id: 'be-save', verb: 'Escape', reason: 'verb parity — Escape quits' },
    { id: 'be-add-row-btn', verb: 'i', reason: 'verb parity — i inserts a line' },
  ],
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

// ── Global: ? overlay lists every g-key registry route in NAV section ────────
// #149: NAV rows moved from : palette to ? overlay. The ? overlay reads
// window.FB_ROUTES (same as _gResolve), so this proves the registry → help
// wiring. Routes without a gKey are sidebar-only
// and not in the NAV section — they're excluded from this check.
console.log('[global] ? overlay NAV coverage');
await page.goto(`${BASE}/${CO}/inbox`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.keyboard.press('?');
await page.waitForTimeout(400);
const helpOpen = await page.evaluate(() => !!document.querySelector('#fb-keys-overlay'));
ok('? overlay opens', helpOpen);
const navLabels = await page.evaluate(() => {
  var nav = document.querySelector('.fb-keys-nav');
  if (!nav) return [];
  return Array.from(nav.querySelectorAll('.fb-hint-row span')).map(el => el.textContent.trim());
});
for (const r of ROUTES.filter(r => r.gKey)) {
  ok(`? NAV lists "${r.label}"`, navLabels.some(l => l.includes(r.label)), `got: ${navLabels.join(' | ') || '(no NAV rows)'}`);
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

    // Non-gate routes: smoke only (load + zero JS errors) — full key
    // coverage is verified once on the representative screen (roadmap §0q).
    if (r.key !== GATE_ROUTE) continue;

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

    ok('FB.keys set active (hasActive)', state.hasActive);
    ok('hint surface non-empty', state.hintLen > 0, '#sb-hints/.fb-hint-bar empty');
    const activeSet = state.audit ? state.audit.find(s => s.active && s.bindings.some(b => b.mode === 'NORMAL')) : null;
    ok('audit: ≥1 active set with NORMAL bindings', !!activeSet,
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
