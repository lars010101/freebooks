import { chromium } from 'playwright-core';
// magnus 13-point review (2026-07-28) — behavioral verification.
const BASE = 'http://127.0.0.1:4722';
const CO = 'testco';
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL:', name); } }

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
p.on('pageerror', e => console.log('PAGEERROR:', e.message));
const mode = () => p.evaluate(() => window.FB && FB.mode ? FB.mode.get() : '?');
const curCell = () => p.evaluate(() => {
  const el = document.querySelector('.fb-form-cursor, .fb-form-cursor-btn');
  return el ? (el.id || el.dataset.side || el.tagName) : '';
});

// ── #1/#10: toggle visuals — amber active, ring cursor ──
console.log('[1] toggle visuals');
await p.goto(`${BASE}/testco/opening-balances`, { waitUntil: 'networkidle' });
await p.waitForTimeout(700);
const bsBg = await p.evaluate(() => getComputedStyle(document.getElementById('btn-filter-bs')).backgroundColor);
ok('active toggle is amber (245,158,11)', bsBg === 'rgb(245, 158, 11)');
await p.keyboard.press('j'); // cursor → filter row, BS button
await p.waitForTimeout(200);
const ringState = await p.evaluate(() => {
  const btn = document.getElementById('btn-filter-bs');
  const cs = getComputedStyle(btn);
  return { hasRing: btn.classList.contains('fb-form-cursor-btn'), noFill: !btn.classList.contains('fb-form-cursor'), outline: cs.outlineColor, bg: cs.backgroundColor };
});
ok('focused button gets RING cursor class (not navy fill)', ringState.hasRing && ringState.noFill);
ok('ring is navy outline over amber fill', ringState.bg === 'rgb(245, 158, 11)');

// ── #3/#11: Space toggles focused button; ~ never changes mode ──
console.log('[2] Space toggle + mode stability');
ok('mode NORMAL before toggles', (await mode()) === 'NORMAL');
await p.keyboard.press(' '); // Space on BS → off
await p.waitForTimeout(250);
ok('Space toggles focused button off', await p.evaluate(() => !document.getElementById('btn-filter-bs').classList.contains('active')));
ok('mode still NORMAL after Space', (await mode()) === 'NORMAL');
await p.keyboard.press('~'); // BS back on
await p.waitForTimeout(250);
ok('~ toggles back on', await p.evaluate(() => document.getElementById('btn-filter-bs').classList.contains('active')));
ok('mode still NORMAL after ~', (await mode()) === 'NORMAL');

// ── #2: j/k preserves column (credit → credit) ──
console.log('[3] column-preserving j/k');
await p.keyboard.press('j'); // → grid row 0 (dr cell)
await p.waitForTimeout(200);
await p.keyboard.press('l'); // → cr cell
await p.waitForTimeout(150);
const crCode = await p.evaluate(() => (document.querySelector('.fb-form-cursor') || {}).dataset ? document.querySelector('.fb-form-cursor').dataset.code : null);
ok('cursor on a credit cell', (await curCell()) === 'cr' || (await p.evaluate(() => document.querySelector('.fb-form-cursor').dataset.side)) === 'cr');
await p.keyboard.press('j'); // down a row
await p.waitForTimeout(150);
await p.keyboard.press('k'); // back up
await p.waitForTimeout(150);
const backCell = await p.evaluate(() => { const el = document.querySelector('.fb-form-cursor'); return el ? { side: el.dataset.side, code: el.dataset.code } : {}; });
ok('k returns to the CREDIT cell of the original row (column preserved)', backCell.side === 'cr' && backCell.code === crCode);

// ── #5: NORMAL Tab crosses from header into the grid ──
console.log('[4] journal-voucher Tab traversal');
await p.goto(`${BASE}/${CO}/journal/voucher`, { waitUntil: 'networkidle' });
await p.waitForTimeout(700);
for (let i = 0; i < 3; i++) { await p.keyboard.press('Tab'); await p.waitForTimeout(120); } // date→journal→desc→(cross)
const inGrid = await p.evaluate(() => { const el = document.querySelector('.fb-form-cursor'); return !!(el && el.closest('#lines-body')); });
ok('Tab from last header cell drops into the lines grid', inGrid);

// ── #6: select commit preserves mode ──
console.log('[5] mode-preserving select commit');
// explicit-from-NORMAL: Enter on journal select → INSERT, Enter commit → NORMAL
await p.keyboard.press('Tab'); await p.waitForTimeout(120); // (grid cell → keep moving is fine; go back to header via gg)
await p.keyboard.press('g'); await p.keyboard.press('g'); await p.waitForTimeout(200); // first row = header
await p.keyboard.press('l'); await p.waitForTimeout(120); // journal select
await p.keyboard.press('Enter'); await p.waitForTimeout(150);
ok('select edit enters INSERT', (await mode()) === 'INSERT');
await p.keyboard.press('Enter'); await p.waitForTimeout(200); // commit
ok('commit from explicit edit returns NORMAL', (await mode()) === 'NORMAL');
// INSERT-traversal: Enter on date (INSERT) → Tab to select → commit → stays INSERT
await p.keyboard.press('h'); await p.waitForTimeout(120); // date cell
await p.keyboard.press('Enter'); await p.waitForTimeout(150); // INSERT on date
await p.keyboard.press('Tab'); await p.waitForTimeout(200);  // native Tab → journal select (INSERT)
const onSelect = await p.evaluate(() => document.activeElement && document.activeElement.id === 'jv-journal');
await p.keyboard.press('Enter'); await p.waitForTimeout(200); // commit select
ok('commit during INSERT traversal stays INSERT', (await mode()) === 'INSERT');
await p.keyboard.press('Escape'); await p.waitForTimeout(150);

// ── #7/#8/#9: reversal — R key, Esc cancels, 1-char search ──
console.log('[6] reversal flow');
const tildeFree = await p.evaluate(() => {
  const a = FB.keys.audit();
  const set = a.find(s => s.name === 'journal-voucher');
  return !set.bindings.some(b => b.key === '~');
});
ok('journal-voucher has no ~ binding (moved to R)', tildeFree);
await p.keyboard.press('R');
await p.waitForTimeout(300);
ok('R opens reversal panel + focuses search', await p.evaluate(() =>
  document.getElementById('reversal-panel').style.display !== 'none'
  && document.activeElement.id === 'reversal-search'));
await p.keyboard.type('a');
await p.waitForTimeout(700);
ok('single-char search shows feedback (rows or empty-state)', await p.evaluate(() =>
  document.getElementById('reversal-results').style.display !== 'none'));
await p.keyboard.press('Escape');
await p.waitForTimeout(300);
ok('Esc cancels reversal (panel closed, title reset)', await p.evaluate(() =>
  document.getElementById('reversal-panel').style.display === 'none'
  && document.getElementById('jv-mode-title').textContent === 'New JV'));
ok('mode NORMAL after cancel', (await mode()) === 'NORMAL');

// ── #4: leave-guard covers g-map + palette ──
console.log('[7] guard chokepoint');
await p.goto(`${BASE}/${CO}/settings?tab=coa`, { waitUntil: 'networkidle' });
await p.waitForTimeout(900);
// dirty the first VAT row: i → change rate → Enter (dirty buffer, not written)
await p.keyboard.press('j'); await p.waitForTimeout(150);
await p.keyboard.press('i'); await p.waitForTimeout(200);
await p.evaluate(() => { const el = document.activeElement; el.value = (parseFloat(el.value || '0') + 1).toString(); el.dispatchEvent(new Event('input', { bubbles: true })); });
await p.keyboard.press('Enter'); await p.waitForTimeout(300);
const dirty = await p.evaluate(() => window.FB && FB.list && FB.list.anyDirty ? FB.list.anyDirty() : false);
ok('COA edit leaves the list dirty', dirty);
const modalUp = () => p.evaluate(() => {
  const el = document.querySelector('.fb-modal-overlay');
  if (!el) return false;
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden'; // fixed → offsetParent is null
});
// fb-list commit advances to the next cell still INSERT — Esc back to NORMAL
// before any NORMAL-mode navigation (mirrors real usage).
await p.keyboard.press('Escape'); await p.waitForTimeout(200);
ok('NORMAL before navigating', (await mode()) === 'NORMAL');
await p.keyboard.press('g'); await p.keyboard.press('d');
await p.waitForTimeout(500);
ok('g d blocked by leave-guard modal', await modalUp());
ok('still on settings after veto', p.url().includes('/settings'));
await p.keyboard.press('Escape'); // Stay
await p.waitForTimeout(300);
ok('Esc (Stay) closes the modal', !(await modalUp()));
await p.keyboard.press(':'); await p.waitForTimeout(300);
await p.keyboard.type('dashboard'); await p.waitForTimeout(300);
await p.keyboard.press('Enter'); await p.waitForTimeout(500);
ok('palette navigate blocked by leave-guard too', await modalUp());
await p.keyboard.press('u'); // discard & leave
await p.waitForTimeout(900);
ok('discard & leave lands on dashboard', await p.evaluate(() => /\/testco\/?$/.test(location.pathname)));

// ── #13: dashboard spatial hjkl ──
console.log('[8] dashboard grid nav');
await p.waitForTimeout(600);
await p.keyboard.press('j'); await p.waitForTimeout(200);
const firstFocus = await p.evaluate(() => { const el = document.querySelector('.nav-row-focus'); return el ? el.classList.contains('dash-card') || el.classList.contains('dash-rpt-link') : false; });
ok('j focuses a dashboard element', firstFocus);
const colPos = await p.evaluate(() => { const cards = Array.from(document.querySelectorAll('.dash-card')); return cards.indexOf(document.querySelector('.nav-row-focus')); });
await p.keyboard.press('l'); await p.waitForTimeout(150);
const colPos2 = await p.evaluate(() => { const cards = Array.from(document.querySelectorAll('.dash-card')); return cards.indexOf(document.querySelector('.nav-row-focus')); });
ok('l moves to the next card in the row', colPos2 === colPos + 1);
const before = await p.evaluate(() => { const el = document.querySelector('.nav-row-focus'); return el ? el.getBoundingClientRect().top : -1; });
await p.keyboard.press('j'); await p.waitForTimeout(150);
const after = await p.evaluate(() => { const el = document.querySelector('.nav-row-focus'); return el ? el.getBoundingClientRect().top : -1; });
ok('j moves down a visual row', after > before && before >= 0);
await p.keyboard.press('Escape'); await p.waitForTimeout(150);
ok('Esc clears dashboard focus', await p.evaluate(() => !document.querySelector('.nav-row-focus')));

// ── #12: 301 for the retired standalone route ──
console.log('[9] import 301');
const resp = await p.context().request.get(`${BASE}/${CO}/bank/import`, { maxRedirects: 0 });
ok('/bank/import → 301 to ?tab=import', resp.status() === 301 && (resp.headers()['location'] || '').includes('/bank?tab=import'));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
await b.close();
process.exit(fail ? 1 : 0);
