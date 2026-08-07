import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:4722';
const CO = 'PW';
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL:', name); } }

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const logs = [];
page.on('console', m => logs.push(m.text()));
page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message));

const cursorId = () => page.evaluate(() => {
  const el = document.querySelector('.fb-form-cursor');
  return el ? (el.id || el.tagName) : null;
});
const getMode = () => page.evaluate(() => window.FB && FB.mode ? FB.mode.get() : '?');
const activeTag = () => page.evaluate(() => (document.activeElement || {}).tagName + '#' + ((document.activeElement || {}).id || ''));

console.log('\n[1] Tab never enters INSERT; INSERT only via i/Enter');
await page.goto(`${BASE}/${CO}/reports`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.getElementById('rpt-period').options.length > 1);

ok('cursor starts on rpt-type', (await cursorId()) === 'rpt-type');
ok('NORMAL at rest', (await getMode()) === 'NORMAL');

await page.keyboard.press('Tab');
await page.waitForTimeout(150);
ok('Tab moves cursor → rpt-period', (await cursorId()) === 'rpt-period');
ok('Tab stays NORMAL', (await getMode()) === 'NORMAL');
ok('Tab does NOT move DOM focus (body focused)', (await activeTag()) === 'BODY#');

await page.keyboard.press('Shift+Tab');
await page.waitForTimeout(150);
ok('Shift+Tab moves back → rpt-type', (await cursorId()) === 'rpt-type');
ok('still NORMAL', (await getMode()) === 'NORMAL');

// picker disabled so Enter takes the deterministic INSERT-stepping path
await page.evaluate(() => { try { delete HTMLSelectElement.prototype.showPicker; } catch (e) { HTMLSelectElement.prototype.showPicker = undefined; } });
await page.keyboard.press('i');
await page.waitForTimeout(150);
ok('i enters INSERT', (await getMode()) === 'INSERT');
ok('i focuses the select', (await activeTag()) === 'SELECT#rpt-type');

await page.keyboard.press('Tab'); // INSERT Tab = native traversal + cursor follows
await page.waitForTimeout(150);
ok('Tab in INSERT moves focus → rpt-period', (await activeTag()).startsWith('SELECT#rpt-period'));
ok('Tab in INSERT stays INSERT', (await getMode()) === 'INSERT');

await page.keyboard.press('Escape');
await page.waitForTimeout(150);
ok('Esc exits INSERT → NORMAL', (await getMode()) === 'NORMAL');

console.log('\n[2] onCommit — report runs on any cell commit, debounced to one load');
// pick a report type via the mouse-equivalent path to establish a loaded iframe
const rptVal = await page.evaluate(() => {
  const sel = document.getElementById('rpt-type');
  for (let i = 0; i < sel.options.length; i++) if (sel.options[i].value && !sel.options[i].disabled) return sel.options[i].value;
  return null;
});
ok('report type available', !!rptVal);
await page.selectOption('#rpt-type', rptVal);
await page.waitForFunction(() => {
  const f = document.getElementById('report-frame');
  return f && f.src && !f.src.endsWith('about:blank');
}, { timeout: 10000 });
await page.waitForTimeout(500);

// instrument load counter
await page.evaluate(() => {
  window._loads = 0;
  document.getElementById('report-frame').addEventListener('load', () => window._loads++);
});

// commit the type select via the stepping path: fires change AND onCommit —
// debounce must collapse to exactly ONE load
await page.evaluate(() => { const el = document.getElementById('rpt-type'); el.focus(); el.blur(); });
await page.keyboard.press('Enter'); // edit (picker disabled → INSERT stepping)
await page.waitForTimeout(150);
await page.keyboard.press('j');     // step to next option
await page.waitForTimeout(100);
await page.keyboard.press('Enter'); // commitSelect → change + onCommit
await page.waitForTimeout(900);
ok('select commit triggered report load', (await page.evaluate(() => window._loads)) >= 1);
ok('debounced to exactly ONE load (change+onCommit collapsed)', (await page.evaluate(() => window._loads)) === 1);

// commit the UNCHANGED end-date cell with Enter → onCommit must still run the report
await page.evaluate(() => { window._loads = 0; });
// cursor to rpt-end: Tab through (NORMAL) — type→period→start→end
for (let i = 0; i < 3; i++) { await page.keyboard.press('Tab'); await page.waitForTimeout(80); }
ok('cursor on rpt-end', (await cursorId()) === 'rpt-end');
await page.keyboard.press('Enter');  // edit date
await page.waitForTimeout(120);
await page.keyboard.press('Enter');  // commit unchanged → advance + onCommit
await page.waitForTimeout(900);
ok('Enter on unchanged date cell still runs the report', (await page.evaluate(() => window._loads)) === 1);

console.log('\n[3] Palette + g i — Bank Import reachable');
await page.goto(`${BASE}/${CO}/bank`, { waitUntil: 'networkidle' });
await page.keyboard.press(':');
await page.waitForTimeout(300);
await page.keyboard.type('bank import');
await page.waitForTimeout(300);
const paletteRow = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('*')).filter(el =>
    el.children.length === 0 && /Bank Import/i.test(el.textContent || ''));
  return rows.length ? rows[0].parentElement.textContent : null;
});
ok('palette lists a Bank Import row for query "bank import"', !!paletteRow);
ok('palette row shows the g i hint', !!(paletteRow && /g\s*i/.test(paletteRow)));
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

await page.keyboard.press('g');
await page.keyboard.press('i');
await page.waitForTimeout(900);
// Import is a Bank tab since 2026-07-28: g i lands on /bank?tab=import with
// the panel visible and the wizard lazily initialized.
ok('g i lands on /bank?tab=import', page.url().includes(`/${CO}/bank`) && page.url().includes('tab=import'));
ok('import tab active + panel visible', await page.evaluate(() =>
  document.getElementById('bank-tab-import').classList.contains('active')
  && document.getElementById('bank-panel-import').style.display !== 'none'));
ok('import wizard initialized', await page.evaluate(() => window.__fbImportInited === true));

console.log('\n[4] Console errors');
const errs = logs.filter(l => l.startsWith('PAGEERROR'));
ok('no uncaught JS errors', errs.length === 0);
if (errs.length) console.log(errs.join('\n'));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
await browser.close();
process.exit(fail ? 1 : 0);
