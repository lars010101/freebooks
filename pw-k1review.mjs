import { chromium } from 'playwright-core';
const b = await chromium.launch();
const p = await (await b.newContext()).newPage();
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n); } };

// ── Fix 1: G/gg absolute scroll (settings COA — long FB.list) ──
console.log('[1] G/gg absolute scroll (settings COA)');
await p.goto('http://127.0.0.1:4722/testco/settings?tab=coa', { waitUntil: 'networkidle' });
await p.waitForTimeout(800);
await p.keyboard.press('G');
await p.waitForTimeout(600);
const afterG = await p.evaluate(() => ({
  winY: window.scrollY,
  bodyH: document.documentElement.scrollHeight - window.innerHeight,
  pm: (() => { const el = document.getElementById('page-main'); return el ? el.scrollHeight - el.clientHeight - el.scrollTop : null; })()
}));
ok(`G scrolls window to absolute bottom (y=${afterG.winY} of ${afterG.bodyH})`, afterG.bodyH <= 0 || Math.abs(afterG.winY - afterG.bodyH) < 5);
ok('G scrolls #page-main to absolute bottom', afterG.pm === null || Math.abs(afterG.pm) < 5);
await p.keyboard.press('g');
await p.waitForTimeout(120);
await p.keyboard.press('g');
await p.waitForTimeout(600);
const afterGg = await p.evaluate(() => ({
  winY: window.scrollY,
  pm: (document.getElementById('page-main') || {}).scrollTop
}));
ok(`gg scrolls window to absolute top (y=${afterGg.winY})`, afterGg.winY === 0);
ok(`gg scrolls #page-main to absolute top (${afterGg.pm})`, !afterGg.pm || afterGg.pm === 0);

// ── Fix 2: g d dashboard, g v receivables ──
console.log('[2] g d / g v');
await p.keyboard.press('g');
await p.waitForTimeout(120);
await p.keyboard.press('d');
await p.waitForTimeout(800);
ok('g d → dashboard', p.url().endsWith('/testco') || p.url().endsWith('/testco/'));
await p.keyboard.press('g');
await p.waitForTimeout(120);
await p.keyboard.press('v');
await p.waitForTimeout(800);
ok('g v → receivables', p.url().includes('/testco/receivables'));

// ── Fix 3: palette api navigate deep-links to the tab ──
console.log('[3] palette VAT row → settings?tab=vat');
await p.goto('http://127.0.0.1:4722/testco', { waitUntil: 'networkidle' });
await p.waitForTimeout(400);
await p.keyboard.press(':');
await p.waitForTimeout(500);
await p.keyboard.type('vat code', { delay: 15 });
await p.waitForTimeout(400);
await p.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('.fb-palette-row'));
  const api = rows.find(r => (r.querySelector('.fb-palette-scope') || {}).textContent === 'api');
  if (api) api.click();
});
await p.waitForTimeout(1200);
ok('lands on settings?tab=vat', p.url().includes('/settings?tab=vat'), );
const vatTabState = await p.evaluate(() => {
  const t = Array.from(document.querySelectorAll('.tab')).find(x => x.textContent.includes('Tax Codes'));
  if (!t || !t.offsetParent) return 'hidden-by-relevance'; // non-VAT company: tab hidden, falls back to Company — correct
  return t.classList.contains('active') ? 'active' : 'inactive';
});
ok('Tax Codes tab active (or hidden on non-VAT — correct fallback)', vatTabState !== 'inactive');

// ── Fix 4: opening-balances toggle filters (hjkl + ~ on focused button) ──
console.log('[4] opening-balances toggle filters');
await p.goto('http://127.0.0.1:4722/testco/opening-balances', { waitUntil: 'networkidle' });
await p.waitForTimeout(800);
ok('P&L button exists', await p.evaluate(() => !!document.getElementById('btn-filter-pl')));
ok('All Accounts button removed (redundant)', await p.evaluate(() => !document.getElementById('btn-filter-all')));
const bsCount = await p.evaluate(() => document.querySelectorAll('.ob-table tbody tr').length);
const curCell = () => p.evaluate(() => (document.querySelector('.fb-form-cursor, .fb-form-cursor-btn') || {}).id || '');

// j → filter row (cursor lands on cell 0 = BS button)
await p.keyboard.press('j');
await p.waitForTimeout(200);
ok('j reaches filter row, cursor on BS button', (await curCell()) === 'btn-filter-bs');

// ~ on BS → off; both off → empty grid (strict semantics)
await p.keyboard.press('~');
await p.waitForTimeout(300);
ok('~ toggles focused BS off', await p.evaluate(() => !document.getElementById('btn-filter-bs').classList.contains('active')));
ok('both off → empty grid', await p.evaluate(() => document.getElementById('ob-tbody').textContent.includes('No accounts')));

// l → P&L button; ~ → on; grid = P&L only
await p.keyboard.press('l');
ok('l moves cursor to P&L button', (await curCell()) === 'btn-filter-pl');
await p.keyboard.press('~');
await p.waitForTimeout(300);
ok('~ toggles P&L on', await p.evaluate(() => document.getElementById('btn-filter-pl').classList.contains('active')));
const plCount = await p.evaluate(() => document.querySelectorAll('.ob-table tbody tr').length);

// h → BS; ~ → on; both on = all accounts
await p.keyboard.press('h');
await p.keyboard.press('~');
await p.waitForTimeout(300);
const bothCount = await p.evaluate(() => document.querySelectorAll('.ob-table tbody tr').length);
console.log(`  rows: bs=${bsCount} pl=${plCount} both=${bothCount}`);
ok('BS+P&L both on = all accounts', bothCount >= bsCount && bothCount > plCount);

// l,l → Non-Zero; ~ → on; no amounts entered → empty; ~ again → rows back
await p.keyboard.press('l'); await p.keyboard.press('l');
ok('cursor on Non-Zero button', (await curCell()) === 'btn-filter-nonzero');
await p.keyboard.press('~');
await p.waitForTimeout(300);
ok('Non-Zero on (no amounts) → empty', await p.evaluate(() => document.getElementById('ob-tbody').textContent.includes('No accounts')));
await p.keyboard.press('~');
await p.waitForTimeout(300);
ok('Non-Zero off → rows back', (await p.evaluate(() => document.querySelectorAll('.ob-table tbody tr').length)) === bothCount);

// Enter activates a focused button (generic button-click parity)
await p.keyboard.press('h');
await p.keyboard.press('Enter'); // P&L off
await p.waitForTimeout(300);
ok('Enter toggles focused button (P&L off)', await p.evaluate(() => !document.getElementById('btn-filter-pl').classList.contains('active')));
const bsOnlyCount = await p.evaluate(() => document.querySelectorAll('.ob-table tbody tr').length);
ok('back to BS-only view', bsOnlyCount === bsCount);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
await b.close();
process.exit(fail ? 1 : 0);
