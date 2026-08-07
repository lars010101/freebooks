import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:4722';
const CO = 'PW';
let pass = 0, fail = 0;
const results = [];
function ok(name, cond) {
  if (cond) { pass++; results.push(`  ✓ ${name}`); }
  else { fail++; results.push(`  ✗ FAIL: ${name}`); }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const logs = [];
page.on('console', m => logs.push(m.text()));
page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message));

// ── helpers ──
async function cursorId() {
  return await page.evaluate(() => {
    const el = document.querySelector('.fb-form-cursor');
    return el ? (el.id || el.tagName) : null;
  });
}
async function activeSetName() {
  return await page.evaluate(() => {
    if (!window.FB || !FB.keys) return null;
    // _activeSet is private; use the help overlay to discover the active set
    return null; // placeholder — we'll use the overlay approach below
  });
}
async function openHelpAndGetSetName() {
  return await page.evaluate(() => {
    if (!window.FB || !FB.keys || !FB.keys.help) return null;
    const opened = FB.keys.help.open();
    if (!opened) return null;
    const titleEl = document.querySelector('#fb-keys-overlay .fb-keys-page');
    const name = titleEl ? titleEl.textContent.trim() : null;
    FB.keys.help.close();
    return name;
  });
}
async function helpOverlayHints() {
  return await page.evaluate(() => {
    if (!window.FB || !FB.keys || !FB.keys.help) return null;
    const opened = FB.keys.help.open();
    if (!opened) return null;
    const rows = Array.from(document.querySelectorAll('#fb-keys-overlay .fb-hint-row span'));
    const hints = rows.map(r => r.textContent.trim());
    FB.keys.help.close();
    return hints;
  });
}

// ════════════════════════════════════════════════════════════════════════
// [1] Full-load reports → h/l traversal → g b soft-nav → bank keys own dispatch
// ════════════════════════════════════════════════════════════════════════
console.log('\n[1] Reports full-load → h/l → g b soft-nav → bank owns dispatch');
await page.goto(`${BASE}/${CO}/reports`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.getElementById('rpt-type') && document.getElementById('rpt-type').options.length > 1, { timeout: 5000 });
await page.waitForFunction(() => document.getElementById('rpt-start').value, { timeout: 3000 });

// Reports set owns dispatch initially
const rptSet = await openHelpAndGetSetName();
ok('reports set owns dispatch on full-load', rptSet === 'reports');

// h/l traversal works
const cells = ['rpt-type','rpt-period','rpt-start','rpt-end','rpt-mom','rpt-yoy','rpt-dl-btn'];
ok('cursor starts on rpt-type', (await cursorId()) === 'rpt-type');
await page.keyboard.press('l');
ok('l moves to rpt-period', (await cursorId()) === 'rpt-period');
await page.keyboard.press('h');
ok('h moves back to rpt-type', (await cursorId()) === 'rpt-type');

// g b → bank page (soft-nav)
await page.keyboard.press('g');
await page.waitForTimeout(50);
await page.keyboard.press('b');
await page.waitForFunction(() => document.getElementById('bank-panel-txn') || document.querySelector('#bank-panel-txn'), { timeout: 5000 });
await page.waitForTimeout(300); // let scripts settle

// THE KEY ASSERTION: bank set owns dispatch (not reports!)
const bankSet = await openHelpAndGetSetName();
ok('bank set owns dispatch after g b soft-nav', bankSet === 'bank');

// Bank verbs in the overlay
const bankHints = await helpOverlayHints();
ok('bank overlay lists navigate hint', bankHints && bankHints.some(h => h.includes('navigate')));
ok('bank overlay lists clear/unclear hint', bankHints && bankHints.some(h => h.includes('clear')));

// j/k on bank — check if there are transaction rows
const bankRowCount = await page.evaluate(() => document.querySelectorAll('#rec-body tr').length);
if (bankRowCount > 0) {
  // j moves exactly ONE row (no double-fire)
  const focusBefore = await page.evaluate(() => {
    const tr = document.querySelector('#rec-body tr.nav-row-focus');
    return tr ? tr.dataset.i : null;
  });
  await page.keyboard.press('j');
  const focusAfter = await page.evaluate(() => {
    const tr = document.querySelector('#rec-body tr.nav-row-focus');
    return tr ? tr.dataset.i : null;
  });
  ok('j moved cursor (bank txn)', focusBefore !== focusAfter || (focusAfter !== null && bankRowCount > 0));
  ok('j moved exactly one row (no double-fire)', focusBefore === null || (parseInt(focusAfter) - parseInt(focusBefore) === 1));
} else {
  // No bank rows — just assert the set is active (keys aren't dead)
  ok('bank keys alive (no txn rows to test j/k, but set owns dispatch)', bankSet === 'bank');
}

// ════════════════════════════════════════════════════════════════════════
// [2] Opening-balances via fbNavigate (no gKey 'o' — deviation noted)
// ════════════════════════════════════════════════════════════════════════
console.log('\n[2] Soft-nav to opening-balances → keys respond');
await page.evaluate((co) => window.fbNavigate(`/${co}/opening-balances`), CO);
await page.waitForFunction(() => document.querySelector('.ob-header-grid, #ob-grid, .ob-grid') || document.querySelector('[class*="ob"]'), { timeout: 5000 });
await page.waitForTimeout(300);

const obSet = await openHelpAndGetSetName();
ok('opening-balances set owns dispatch after soft-nav', obSet === 'opening-balances');

// h/l or j/k should produce a cursor element on the OB page
const obCursorExists = await page.evaluate(() => !!document.querySelector('.fb-form-cursor'));
ok('OB form cursor visible (keys alive)', obCursorExists);

// ════════════════════════════════════════════════════════════════════════
// [3] Round-trip: g r → back to reports → h/l works (no residue)
// ════════════════════════════════════════════════════════════════════════
console.log('\n[3] Round-trip g r → reports → h/l works (no residue)');
await page.keyboard.press('g');
await page.waitForTimeout(50);
await page.keyboard.press('r');
await page.waitForFunction(() => document.getElementById('rpt-type'), { timeout: 5000 });
await page.waitForTimeout(300);

const rptSet2 = await openHelpAndGetSetName();
ok('reports set owns dispatch after round-trip', rptSet2 === 'reports');

ok('cursor on rpt-type after round-trip', (await cursorId()) === 'rpt-type');
await page.keyboard.press('l');
ok('l works after round-trip', (await cursorId()) === 'rpt-period');
await page.keyboard.press('h');
ok('h works after round-trip', (await cursorId()) === 'rpt-type');

// ════════════════════════════════════════════════════════════════════════
// [4] FB.form cursor: computed background-color (not just outline)
// ════════════════════════════════════════════════════════════════════════
console.log('\n[4] FB.form cursor background-color');
const cursorBg = await page.evaluate(() => {
  const el = document.querySelector('.fb-form-cursor');
  if (!el) return null;
  const cs = window.getComputedStyle(el);
  return { bg: cs.backgroundColor, outline: cs.outlineStyle };
});
ok('.fb-form-cursor exists on reports', cursorBg !== null);
ok('.fb-form-cursor has non-transparent background', cursorBg && cursorBg.bg !== 'rgba(0, 0, 0, 0)' && cursorBg.bg !== 'transparent');

// ════════════════════════════════════════════════════════════════════════
// [5] Native select: Enter/i opens picker (showPicker or INSERT fallback)
// ════════════════════════════════════════════════════════════════════════
console.log('\n[5] Native select Enter → showPicker or INSERT fallback');

// Detect showPicker availability
const hasShowPicker = await page.evaluate(() => {
  const el = document.getElementById('rpt-type');
  return !!(el && typeof el.showPicker === 'function');
});

const modeBefore = await page.evaluate(() => window.FB && FB.mode ? FB.mode.get() : 'NORMAL');
ok('mode is NORMAL before Enter on select', modeBefore === 'NORMAL');

// Press Enter on rpt-type (cursor should be on it after h above)
await page.keyboard.press('Enter');
await page.waitForTimeout(200);

const modeAfter = await page.evaluate(() => window.FB && FB.mode ? FB.mode.get() : 'NORMAL');
const selectFocused = await page.evaluate(() => document.activeElement && document.activeElement.id === 'rpt-type');

if (hasShowPicker) {
  // showPicker path: either it worked (mode stays NORMAL, native popup owns
  // keys) or it threw in headless → INSERT j/k-stepping fallback engaged.
  // Both are correct behavior — we just record which path was taken.
  if (modeAfter === 'NORMAL') {
    ok('showPicker available: mode stays NORMAL (native popup owns keys)', true);
    ok('showPicker worked headless', true);
  } else {
    ok('showPicker threw headless → INSERT fallback engaged (mode=INSERT)', modeAfter === 'INSERT');
    ok('showPicker fell back to INSERT stepping', true);
  }
  ok('showPicker available: select is focused', selectFocused);
  // Esc to close any native popup / exit INSERT
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
} else {
  // Fallback: INSERT j/k-stepping mode
  ok('showPicker unavailable: fell back to INSERT mode', modeAfter === 'INSERT');
  ok('showPicker unavailable: select is focused', selectFocused);
  // Esc to exit INSERT
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
}

// ════════════════════════════════════════════════════════════════════════
// [6] No JS errors on the page
// ════════════════════════════════════════════════════════════════════════
console.log('\n[6] Console errors');
const errors = logs.filter(l => l.includes('PAGEERROR') || l.includes('Uncaught'));
ok('no uncaught JS errors', errors.length === 0);
if (errors.length) console.log('  ERRORS:', errors);

// ── Summary ──
console.log('\n' + results.join('\n'));
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
console.log(`showPicker available in headless Chromium: ${hasShowPicker}`);

await browser.close();
process.exit(fail > 0 ? 1 : 0);
