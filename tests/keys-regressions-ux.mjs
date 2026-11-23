// Keyboard regressions found by the 2026-11-23 keybinding audit.
//
//   1. Journal: j/k move the visible list after switching tabs. Report lists
//      treated a missing tbody as active, so a visited tab's list (swapped
//      out of the DOM) kept swallowing j/k.
//   2. Bill page, x on the header (cursor starts there):
//        new (not yet saved)  → nothing happens;
//        saved draft          → confirm, then the draft is deleted;
//        posted, nothing paid → confirm, then voided (reversal entry).
//
// Run: node tests/keys-regressions-ux.mjs   (skips without Chromium)

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { startTestServer, api, seedCompany, testDates } = require('../api/test-utils/helpers');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL:', name, detail ? `— ${detail}` : ''); }
}

let chromium;
try { ({ chromium } = require('playwright-core')); } catch {
  console.log('=== Keyboard regressions UX — SKIP ===');
  process.exit(0);
}

const srv = await startTestServer({ withAdminToken: false });
const B = srv.baseUrl, CO = 'KEYREG', TD = testDates();
let browser;
try {
  console.log('=== Keyboard regressions UX regression ===');
  const { AP, EXP, accounts } = await seedCompany(B, CO, { jurisdiction: 'SE', currency: 'SEK' });
  const ap = AP || accounts.find(a => a.account_code === '2440').account_code;
  // bill.void posts its reversal dated today: give the company the current month too.
  await api(B, 'period.upsert', { companyId: CO, period: { period_id: TD.nextMonthId, start_date: TD.nextMonthStart, end_date: TD.nextMonthEnd } });
  for (let n = 0; n < 3; n++) {
    await api(B, 'journal.post', { companyId: CO, lines: [
      { date: TD.day21, account_code: EXP, debit: 10 + n, credit: 0, description: 'L' + n },
      { date: TD.day21, account_code: '1930', debit: 0, credit: 10 + n, description: 'L' + n }] });
  }
  const draft = async (ref) => (await api(B, 'bill.draft.save', { companyId: CO, bill: {
    partner_name: 'Acme Pte Ltd', vendor_ref: ref, date: TD.day20, due_date: TD.day25, currency: 'SEK',
    ap_account: ap, lines: [{ description: 'Line', expense_account: EXP, amount: 100 }] } })).body.data.billId;
  const draftId = await draft('KR-D');
  const postedId = await draft('KR-P');
  await api(B, 'bill.draft.post', { companyId: CO, billId: postedId });
  const billStatus = async (id) => {
    const r = await api(B, 'bill.get', { companyId: CO, billId: id });
    return r.status === 200 ? (r.body.data || {}).status : `HTTP ${r.status}`;
  };

  try { browser = await chromium.launch({ headless: true }); } catch (e) {
    if (/Executable doesn't exist|browserType\.launch/.test(String(e && e.message))) {
      console.log('=== Keyboard regressions UX regression — SKIP ===');
      process.exit(0);
    }
    throw e;
  }
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const blur = () => page.evaluate(() => document.activeElement && document.activeElement.blur());
  const focused = () => page.evaluate(() => {
    const tr = document.querySelector('tr.nav-row-focus');
    return tr ? ((tr.closest('tbody') || {}).id || '?') + '#' + tr.dataset.idx : null;
  });

  // 1. Journal tab switch
  await page.goto(`${B}/${CO}/journal`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.locator('.tabs .tab').nth(1).click();          // Line items
  await page.waitForSelector('#jl-body tr[data-idx]', { timeout: 8000 });
  await blur();
  await page.keyboard.press('j'); await page.keyboard.press('j');
  await page.waitForTimeout(150);
  const f = await focused();
  ok('j moves the Line items list after leaving Transactions', /^jl-body#[1-9]/.test(f || ''), `focused: ${f}`);

  // 2a. New bill: x on the header does nothing
  await page.goto(`${B}/${CO}/bill/new`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400); await blur();
  await page.keyboard.press('x'); await page.waitForTimeout(300);
  ok('x on a new bill opens no dialog', await page.locator('.fb-modal, [role=dialog]').count() === 0);

  // 2b. Saved draft: x deletes after confirm
  await page.goto(`${B}/${CO}/bill/${draftId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400); await blur();
  await page.keyboard.press('x');
  const del = page.getByRole('button', { name: 'Delete draft' });
  await del.waitFor({ timeout: 5000 }).catch(() => {});
  ok('x on a draft asks to delete it', await del.count() === 1);
  if (await del.count()) {
    await del.click();
    await page.waitForURL(u => u.pathname.endsWith('/payables'), { timeout: 5000 }).catch(() => {});
  }
  ok('draft is deleted', (await billStatus(draftId)) !== 'draft', `status: ${await billStatus(draftId)}`);

  // 2c. Posted, unpaid: x voids after confirm
  await page.goto(`${B}/${CO}/bill/${postedId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400); await blur();
  await page.keyboard.press('x');
  const vd = page.getByRole('button', { name: 'Void bill' });
  await vd.waitFor({ timeout: 5000 }).catch(() => {});
  ok('x on a posted bill asks to void it', await vd.count() === 1);
  if (await vd.count()) {
    await vd.click();
    await page.waitForURL(u => u.pathname.endsWith('/payables'), { timeout: 5000 }).catch(() => {});
  }
  ok('posted bill is voided', (await billStatus(postedId)) === 'void', `status: ${await billStatus(postedId)}`);

  ok('no uncaught JS errors', errors.length === 0, errors.join('; '));
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
} finally {
  if (browser) await browser.close();
  await srv.cleanup();
}
process.exit(fail ? 1 : 0);
