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

await page.goto(`${BASE}/${CO}/reports`, { waitUntil: 'networkidle' });
// periods fetch populates #rpt-period + sets default dates
await page.waitForFunction(() => document.getElementById('rpt-period').options.length > 1, { timeout: 5000 });
await page.waitForFunction(() => document.getElementById('rpt-start').value, { timeout: 3000 });

const cells = ['rpt-type','rpt-period','rpt-start','rpt-end','rpt-mom','rpt-yoy','rpt-dl-btn'];
async function cursorId() {
  return await page.evaluate(() => {
    const el = document.querySelector('.fb-form-cursor, .fb-form-cursor-btn');
    return el ? el.id : null;
  });
}
async function mode() {
  return await page.evaluate(() => window.FB && FB.mode ? FB.mode.get() : (document.body.dataset.mode || 'NORMAL'));
}

console.log('\n[1] h/l traversal order + sticky ends');
// start at cell 0 (rpt-type) by default
ok('cursor starts on rpt-type', (await cursorId()) === 'rpt-type');
for (let i = 1; i < cells.length; i++) {
  await page.keyboard.press('l');
  ok(`l → ${cells[i]}`, (await cursorId()) === cells[i]);
}
// sticky right
await page.keyboard.press('l');
ok('sticky right (still rpt-dl-btn)', (await cursorId()) === 'rpt-dl-btn');
for (let i = cells.length - 2; i >= 0; i--) {
  await page.keyboard.press('h');
  ok(`h → ${cells[i]}`, (await cursorId()) === cells[i]);
}
// sticky left
await page.keyboard.press('h');
ok('sticky left (still rpt-type)', (await cursorId()) === 'rpt-type');

console.log('\n[2] Enter on type select → INSERT; j/k navigate; Enter selects + fires report load');
// cursor is on rpt-type
await page.keyboard.press('Enter');
ok('Enter → INSERT mode', (await mode()) === 'INSERT');
ok('type select focused', await page.evaluate(() => document.activeElement && document.activeElement.id === 'rpt-type'));
// j navigates to first non-disabled option (skip the disabled placeholder)
await page.keyboard.press('j');
const afterJ = await page.evaluate(() => document.getElementById('rpt-type').value);
ok('j moved selection off placeholder', afterJ !== '');
const jVal = afterJ;
// Enter commits → fires change → fbLoadReport → iframe src changes
const srcBefore = await page.evaluate(() => document.getElementById('report-frame').src);
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('report-frame').src !== 'about:blank' && !document.getElementById('report-frame').src.endsWith('about:blank'), { timeout: 5000 });
const srcAfter = await page.evaluate(() => document.getElementById('report-frame').src);
ok('Enter committed (iframe loaded)', srcAfter !== srcBefore && srcAfter !== 'about:blank');
ok('selection persisted after commit', (await page.evaluate(() => document.getElementById('rpt-type').value)) === jVal);
ok('back to NORMAL after commit', (await mode()) === 'NORMAL');

console.log('\n[2b] Esc cancels select edit without firing');
// move cursor back to type select (we're in NORMAL on it still? cursor paint — verify)
// Navigate to type then Enter
await page.keyboard.press('h'); // sticky, still type (already there)
await page.keyboard.press('h');
const committedVal = await page.evaluate(() => document.getElementById('rpt-type').value);
await page.keyboard.press('Enter');
ok('Enter → INSERT (again)', (await mode()) === 'INSERT');
await page.keyboard.press('j'); // move to next option
await page.keyboard.press('j');
const movedVal = await page.evaluate(() => document.getElementById('rpt-type').value);
ok('j changed selection (pre-esc)', movedVal !== committedVal);
const iframeSrcPreEsc = await page.evaluate(() => document.getElementById('report-frame').src);
await page.keyboard.press('Escape');
ok('Esc → NORMAL', (await mode()) === 'NORMAL');
ok('Esc reverted selection', (await page.evaluate(() => document.getElementById('rpt-type').value)) === committedVal);
const iframeSrcPostEsc = await page.evaluate(() => document.getElementById('report-frame').src);
ok('Esc did NOT fire report load', iframeSrcPostEsc === iframeSrcPreEsc);

console.log('\n[3] Enter on date cells focuses/commits');
// navigate to rpt-start (cell 2)
await page.keyboard.press('l'); // rpt-period
await page.keyboard.press('l'); // rpt-start
ok('cursor on rpt-start', (await cursorId()) === 'rpt-start');
await page.keyboard.press('Enter');
ok('date input focused in INSERT', (await mode()) === 'INSERT' && await page.evaluate(() => document.activeElement.id === 'rpt-start'));
await page.keyboard.press('Escape');
ok('Esc exits date to NORMAL', (await mode()) === 'NORMAL');
// rpt-end
await page.keyboard.press('l');
ok('cursor on rpt-end', (await cursorId()) === 'rpt-end');
await page.keyboard.press('Enter');
ok('end date focused in INSERT', (await mode()) === 'INSERT' && await page.evaluate(() => document.activeElement.id === 'rpt-end'));
await page.keyboard.press('Escape');
ok('Esc exits end date', (await mode()) === 'NORMAL');

console.log('\n[4] Enter on MoM toggles comparison (multiperiod report = pl)');
// current type is 'pl' (Profit & Loss, multiperiod) — MoM enabled
const momEnabled = await page.evaluate(() => !document.getElementById('rpt-mom').disabled);
ok('MoM enabled for multiperiod (pl)', momEnabled);
// navigate to MoM (cell 4)
await page.keyboard.press('l'); // rpt-dl? no — from rpt-end: l→rpt-mom
ok('cursor on rpt-mom', (await cursorId()) === 'rpt-mom');
const srcPreMom = await page.evaluate(() => document.getElementById('report-frame').src);
await page.keyboard.press('Enter'); // clicks MoM → toggle mom
await page.waitForFunction(() => document.getElementById('rpt-mom').classList.contains('tb-active'), { timeout: 3000 });
ok('MoM toggled on (tb-active)', await page.evaluate(() => document.getElementById('rpt-mom').classList.contains('tb-active')));
await page.waitForFunction(() => /step=mom/.test(document.getElementById('report-frame').src), { timeout: 5000 });
ok('report reloaded with step=mom', /step=mom/.test(await page.evaluate(() => document.getElementById('report-frame').src)));

console.log('\n[5] ~ toggles the FOCUSED comparison button only');
// cursor is still on rpt-mom (tb-active from [4]) — ~ re-toggles → none
ok('cursor still on rpt-mom', (await cursorId()) === 'rpt-mom');
await page.keyboard.press('~');
await page.waitForFunction(() => !document.getElementById('rpt-mom').classList.contains('tb-active'), { timeout: 5000 });
ok('~ on active MoM → off (none)', !(await page.evaluate(() => document.getElementById('rpt-mom').classList.contains('tb-active'))));
await page.waitForFunction(() => !/step=/.test(document.getElementById('report-frame').src), { timeout: 5000 });
ok('report reloaded without step', !/step=/.test(await page.evaluate(() => document.getElementById('report-frame').src)));
// l → YoY; ~ → yoy on
await page.keyboard.press('l');
ok('cursor on rpt-yoy', (await cursorId()) === 'rpt-yoy');
await page.keyboard.press('~');
await page.waitForFunction(() => document.getElementById('rpt-yoy').classList.contains('tb-active'), { timeout: 5000 });
ok('~ on YoY → on', await page.evaluate(() => document.getElementById('rpt-yoy').classList.contains('tb-active')));
// ~ on a NON-button cell (rpt-end date) is a no-op
await page.keyboard.press('h'); await page.keyboard.press('h'); // rpt-start? cells: type,period,start,end,mom,yoy — from yoy: h→mom, h→end
ok('cursor on rpt-end (non-button)', (await cursorId()) === 'rpt-end');
await page.keyboard.press('~');
await page.waitForTimeout(600);
ok('~ on non-button cell = no-op (yoy stays on)', await page.evaluate(() => document.getElementById('rpt-yoy').classList.contains('tb-active')));

console.log('\n[6] d opens download menu (regression)');
await page.keyboard.press('d');
ok('d opened download menu', await page.evaluate(() => document.getElementById('rpt-dl-dd').style.display !== 'none'));
await page.keyboard.press('Escape');
ok('Esc closed download menu', await page.evaluate(() => document.getElementById('rpt-dl-dd').style.display === 'none'));

console.log('\n[7] Esc in NORMAL is a no-op (never writes)');
const normalSrc = await page.evaluate(() => document.getElementById('report-frame').src);
await page.keyboard.press('Escape');
ok('NORMAL Esc: no mode change, no reload', (await mode()) === 'NORMAL' && (await page.evaluate(() => document.getElementById('report-frame').src)) === normalSrc);

// ════════════════════════════════════════════════════════════════════════
// magnus 2026-07-28 reports review
// ════════════════════════════════════════════════════════════════════════
console.log('\n[8] Enter on a toggle button: toggles IN PLACE, no shift, no dual selector');
// reset comparison to none first: cursor to MoM, toggle off if active
await page.evaluate(() => { if (document.getElementById('rpt-mom').classList.contains('tb-active')) document.getElementById('rpt-mom').click(); if (document.getElementById('rpt-yoy').classList.contains('tb-active')) document.getElementById('rpt-yoy').click(); });
// deterministic start: gg → first cell (rpt-type), l×4 → rpt-mom
await page.keyboard.press('g'); await page.keyboard.press('g'); await page.waitForTimeout(200);
for (let i = 0; i < 4; i++) { await page.keyboard.press('l'); await page.waitForTimeout(80); }
ok('cursor on rpt-mom', (await cursorId()) === 'rpt-mom');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
ok('Enter toggled MoM on', await page.evaluate(() => document.getElementById('rpt-mom').classList.contains('tb-active')));
ok('cursor did NOT shift (still rpt-mom)', (await cursorId()) === 'rpt-mom');
ok('button NOT DOM-focused (no dual selector)', await page.evaluate(() => document.activeElement.id !== 'rpt-mom'));
ok('mode NORMAL (no flip)', (await mode()) === 'NORMAL');

console.log('\n[9] Space toggles the VIM-cursor cell only');
await page.keyboard.press('l'); // → rpt-yoy
ok('cursor on rpt-yoy', (await cursorId()) === 'rpt-yoy');
await page.keyboard.press(' ');
await page.waitForTimeout(400);
ok('Space toggled YoY on', await page.evaluate(() => document.getElementById('rpt-yoy').classList.contains('tb-active')));
ok('MoM unchanged (radio: YoY replaced it)', await page.evaluate(() => !document.getElementById('rpt-mom').classList.contains('tb-active')));
ok('exactly one cursor ring in the bar', (await page.evaluate(() => document.querySelectorAll('.fb-form-cursor-btn').length)) === 1);
ok('no button holds DOM focus', await page.evaluate(() => !['rpt-mom','rpt-yoy','rpt-dl-btn'].includes((document.activeElement||{}).id)));

console.log('\n[10] finding A: AP Aging → custom year → P&L reloads (INSERT traversal)');
// type → AP Aging via overlay: cursor h back to rpt-type
for (let i = 0; i < 6; i++) await page.keyboard.press('h');
ok('cursor on rpt-type', (await cursorId()) === 'rpt-type');
await page.keyboard.press('ArrowDown');
await page.waitForFunction(() => FB.dropdown.isOpen(), { timeout: 3000 });
// walk the overlay to AP Aging (active starts at -1; read active item text)
const activeText = () => page.evaluate(() => { const el = document.querySelector('.fb-dd-item.active, .fb-dd-item.fb-dd-active'); return el ? el.textContent.trim() : ''; });
for (let i = 0; i < 15; i++) {
  if ((await activeText()) === 'AP Aging') break;
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(50);
}
ok('overlay active item is AP Aging', (await activeText()) === 'AP Aging');
await page.keyboard.press('Enter');
await page.waitForFunction(() => /type=ap-aging/.test(document.getElementById('report-frame').src), { timeout: 5000 });
ok('AP Aging loaded', true);
// dates → year range
await page.evaluate(() => {
  document.getElementById('rpt-start').value = '2025-01-01';
  document.getElementById('rpt-end').value = '2025-12-31';
  document.getElementById('rpt-end').dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(400);
// INSERT traversal to rpt-type: cursor is on rpt-type after the pick;
// l×2 → rpt-start, Enter (edit date → INSERT), Shift+Tab×2 back to the
// select (reached mid-INSERT — commit must preserve INSERT).
await page.keyboard.press('l'); await page.keyboard.press('l'); await page.waitForTimeout(150);
ok('cursor on rpt-start', (await cursorId()) === 'rpt-start');
await page.keyboard.press('Enter'); await page.waitForTimeout(200);
for (let i = 0; i < 2; i++) { await page.keyboard.press('Shift+Tab'); await page.waitForTimeout(150); }
ok('traversal landed on rpt-type (INSERT)', (await cursorId()) === 'rpt-type' && (await mode()) === 'INSERT');
// step to pl and commit while INSERT
const plSteps = await page.evaluate(() => { const o = document.getElementById('rpt-type'); return o.selectedIndex - Array.from(o.options).findIndex(x => x.value === 'pl'); });
for (let i = 0; i < plSteps; i++) { await page.keyboard.press('k'); await page.waitForTimeout(50); }
await page.keyboard.press('Enter');
await page.waitForFunction(() => /type=pl&start=2025-01-01/.test(document.getElementById('report-frame').src), { timeout: 5000 });
ok('P&L reloaded with custom year after traversal commit', true);
ok('mode preserved (INSERT) after traversal commit', (await mode()) === 'INSERT');
await page.keyboard.press('Escape');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (logs.length) console.log('console/errors:', logs.slice(0,10).join('\n'));
await browser.close();
process.exit(fail ? 1 : 0);
