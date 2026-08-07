import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:4722';
const CO = 'testco';
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL:', name); } }

async function act(action, body = {}) {
  const r = await fetch(`${BASE}/api/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ companyId: CO, action, ...body })
  });
  const j = await r.json();
  if (j.error) throw new Error(`${action}: ${JSON.stringify(j.error)}`);
  return j.data !== undefined ? j.data : j;
}

// ── Seed: dedicated cash account 1090 + one JV batch (idempotent) ──
// 1020 accumulated duplicates from an earlier broken idempotence check
// (bank.reconcile.list returns {rows:[...]}, not a bare array) — 1090 is the
// clean, K4-exclusive surface.
console.log('[seed]');
const coa = await act('coa.list');
if (!coa.some(a => a.account_code === '1090')) {
  await act('coa.upsert', { account: { account_code: '1090', account_name: 'K4 Run Bank', account_type: 'Asset', account_subtype: 'Cash and Equivalents', cf_category: 'Cash', is_active: true, effective_from: '2026-01-01' } });
  console.log('  cash account 1090 created');
}
const periods = await act('period.list');
if (!Array.isArray(periods) || !periods.length) {
  const ps = [];
  for (let m = 1; m <= 12; m++) {
    const start = `2026-${String(m).padStart(2, '0')}-01`;
    const end = new Date(Date.UTC(m === 12 ? 2027 : 2026, m === 12 ? 0 : m, 0)).toISOString().slice(0, 10);
    ps.push({ period_id: `2026-${String(m).padStart(2, '0')}`, start_date: start, end_date: end });
  }
  await act('period.save', { periods: ps });
  console.log('  FY2026 periods seeded');
}
const coa2 = await act('coa.list');
const cashCode = '1090';
const rev = coa2.find(a => /revenue|income|sales/i.test(a.account_type || '') || /revenue|income|sales/i.test(a.account_name || '')) || coa2.find(a => /^[34]/.test(a.account_code));
const existingRes = await act('bank.reconcile.list', { accountCode: cashCode, dateFrom: '2026-07-01', dateTo: '2026-07-31' });
const existingRows = Array.isArray(existingRes) ? existingRes : (existingRes.rows || []);
if (!existingRows.length) {
  // date the seed "today": coa.upsert stamps effective_from at creation day,
  // and the reconcile page's default range (month-01 → today) covers it
  const today = new Date().toISOString().slice(0, 10);
  await act('journal.post', { lines: [
    { date: today, account_code: cashCode, debit: 100, credit: 0, description: 'K4 seed in' },
    { date: today, account_code: rev.account_code, debit: 0, credit: 100, description: 'K4 seed offset' }
  ] });
  console.log(`  seed JV posted (DR ${cashCode} / CR ${rev.account_code})`);
} else {
  console.log(`  reconcile rows already present (${existingRows.length})`);
  // prior runs leave the row cleared — reset to uncleared so [3] starts clean
  for (const r of existingRows) {
    if (r.cleared_at) await act('bank.reconcile.clear', { batchId: r.batch_id, accountCode: cashCode, cleared: false });
  }
}
const bills = await act('bill.list');
const BILL_ID = bills[0].bill_id;
console.log('  bill:', BILL_ID.slice(0, 8), '…');

// ── Browser ──
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const logs = [];
page.on('console', m => logs.push(m.text()));
page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message));
const file = n => ({ name: n, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 k4') });
const instrumentFileInput = sel => page.evaluate(s => {
  const el = document.querySelector(s);
  if (el && !el._k4) { el._k4 = 0; const oc = el.click.bind(el); el.click = () => { el._k4++; }; }
}, sel);
const clickCount = sel => page.evaluate(s => (document.querySelector(s) || {})._k4 || 0, sel);

console.log('\n[1] journal-new — A attach + queue zone j/k/x + K3c regression (keys alive with empty reversal zone)');
await page.goto(`${BASE}/${CO}/journal/new`, { waitUntil: 'networkidle' });
await instrumentFileInput('#jv-pre-attach-input');
await page.keyboard.press('A');
await page.waitForTimeout(150);
ok('A opens the attach picker (input clicked)', (await clickCount('#jv-pre-attach-input')) === 1);

await page.setInputFiles('#jv-pre-attach-input', [file('k4-a.pdf'), file('k4-b.pdf')]);
await page.waitForTimeout(200);
ok('2 staged rows render as .fb-attach-row', (await page.locator('#jv-pending-list .fb-attach-row').count()) === 2);

// cursor starts on header zone (zone1); j → first attach row (zone2)
await page.keyboard.press('j');
await page.waitForTimeout(150);
const focus1 = await page.evaluate(() => {
  const r = document.querySelector('#jv-pending-list .fb-attach-row.fb-form-row-focus');
  return r ? r.dataset.attId : null;
});
ok('j reaches the attachment queue (row 0 focused)', focus1 === '0');
await page.keyboard.press('j');
await page.waitForTimeout(120);
const focus2 = await page.evaluate(() => {
  const r = document.querySelector('#jv-pending-list .fb-attach-row.fb-form-row-focus');
  return r ? r.dataset.attId : null;
});
ok('j moves within the queue (row 1)', focus2 === '1');
await page.keyboard.press('x');
await page.waitForTimeout(200);
ok('x removes the cursor staged file (2→1)', (await page.locator('#jv-pending-list .fb-attach-row').count()) === 1);
await page.keyboard.press('A');
await page.waitForTimeout(120);
ok('A still attaches after queue ops', (await clickCount('#jv-pre-attach-input')) === 2);
// K3c regression: form set dispatches with the reversal zone empty
const linesBefore = await page.locator('#lines-body tr').count();
await page.keyboard.press('a');
await page.waitForTimeout(150);
ok('journal-new keys alive (a adds a line — empty reversal zone regression)', (await page.locator('#lines-body tr').count()) === linesBefore + 1);

console.log('\n[2] bill-detail — legacy A = attach (a retired)');
await page.goto(`${BASE}/${CO}/bill/${BILL_ID}`, { waitUntil: 'networkidle' });
await instrumentFileInput('#attach-input');
await page.keyboard.press('A');
await page.waitForTimeout(200);
ok('A opens the attach picker on bill-detail', (await clickCount('#attach-input')) === 1);
await page.keyboard.press('a');
await page.waitForTimeout(200);
ok('a no longer attaches (retired)', (await clickCount('#attach-input')) === 1);

await page.setInputFiles('#attach-input', file('k4-bill.pdf'));
await page.waitForFunction(() => document.querySelectorAll('#attachments-list .attach-row').length > 0, { timeout: 8000 });
ok('upload renders an .attach-row', (await page.locator('#attachments-list .attach-row').count()) >= 1);
// bespoke combined nav: j until an attach row takes .nav-attach-focus
let attachFocused = false;
for (let i = 0; i < 15 && !attachFocused; i++) {
  await page.keyboard.press('j');
  await page.waitForTimeout(100);
  attachFocused = await page.evaluate(() => !!document.querySelector('.attach-row.nav-attach-focus'));
}
ok('j/k combined nav reaches attach rows (focus paints)', attachFocused);
const focusBg = await page.evaluate(() => {
  const r = document.querySelector('.attach-row.nav-attach-focus');
  return r ? getComputedStyle(r).backgroundColor : null;
});
ok('focus style is the dark highlight (CSS intact)', focusBg === 'rgb(26, 26, 26)');

console.log('\n[3] bank Transactions — ~ clear/unclear (the live reconcile surface; /bank/reconcile 301-redirects here)');
await page.goto(`${BASE}/${CO}/bank`, { waitUntil: 'networkidle' });
// select the dedicated clean cash account (page defaults to the first one)
await page.selectOption('#rec-account', '1090');
await page.waitForFunction(() => document.querySelectorAll('#rec-body tr').length > 0, { timeout: 8000 });
// log clear-POST outcomes for diagnosis
page.on('response', async r => {
  if (r.url().includes('/api/action') && (r.request().postData() || '').includes('bank.reconcile.clear')) {
    try { const j = await r.json(); console.log('  [clear POST →]', r.status(), JSON.stringify(j).slice(0, 120)); } catch (e) {}
  }
});
ok('transaction rows auto-load', (await page.locator('#rec-body tr').count()) >= 1);
const unclearedBefore = parseInt(await page.textContent('#sum-uncleared'), 10);
ok('exactly the one seeded batch, uncleared', unclearedBefore === 1);
// j into the rows (bank.js FB.nav paints .nav-row-focus)
let rowFocused = false;
for (let i = 0; i < 5 && !rowFocused; i++) {
  await page.keyboard.press('j');
  await page.waitForTimeout(120);
  rowFocused = await page.evaluate(() => !!document.querySelector('#rec-body tr.nav-row-focus'));
}
ok('j moves into the transaction rows', rowFocused);
const firstRowWasCleared = await page.evaluate(() => document.querySelector('#rec-body tr').classList.contains('cleared'));
await page.keyboard.press('~');
await page.waitForTimeout(700);
const unclearedAfter = parseInt(await page.textContent('#sum-uncleared'), 10);
ok('~ toggles cleared on the cursor row', unclearedAfter === (firstRowWasCleared ? unclearedBefore + 1 : unclearedBefore - 1));
ok('checkbox visual synced to cleared state', await page.evaluate(() => {
  const tr = document.querySelector('#rec-body tr');
  return tr.querySelector('input[type=checkbox]').checked === tr.classList.contains('cleared');
}));
await page.keyboard.press('~');
await page.waitForTimeout(700);
ok('~ toggles back', parseInt(await page.textContent('#sum-uncleared'), 10) === unclearedBefore);
// persistence: clear the first row, full reload, assert the cleared class survived
if (!firstRowWasCleared) {
  await page.keyboard.press('~');
  await page.waitForTimeout(700);
}
await page.reload({ waitUntil: 'networkidle' });
// reload resets #rec-account to the default (first) cash account — re-select 1090
await page.selectOption('#rec-account', '1090');
// the row is now cleared and the Cleared filter is unchecked by default — show it
await page.check('#filter-cleared');
await page.waitForFunction(() => document.querySelectorAll('#rec-body tr').length > 0, { timeout: 8000 });
ok('cleared persists after reload', await page.evaluate(() => document.querySelector('#rec-body tr').classList.contains('cleared')));

console.log('\n[4] bank-import — K3c regression (keys alive with bill panel closed)');
await page.goto(`${BASE}/${CO}/bank/import`, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  document.querySelectorAll('input[type=file]').forEach(el => { if (!el._k4) { el._k4 = 0; const oc = el.click.bind(el); el.click = () => { el._k4++; }; } });
});
await page.keyboard.press('a');
await page.waitForTimeout(200);
const anyClicked = await page.evaluate(() => Array.from(document.querySelectorAll('input[type=file]')).some(el => el._k4 > 0));
ok('bank-import keys alive (a attach works with bill panel closed)', anyClicked);

console.log('\n[5] Console errors');
const errs = logs.filter(l => l.startsWith('PAGEERROR'));
ok('no uncaught JS errors', errs.length === 0);
if (errs.length) console.log(errs.join('\n'));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
await browser.close();
process.exit(fail ? 1 : 0);
