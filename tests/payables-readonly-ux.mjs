// Payables > Bills is read-only (#312): bills are created and edited only on
// the full bill page (bill-edit.js).
//
// Boots a throwaway server, seeds an SE company with one draft bill, then on
// /:company/payables?billIds=<draft> (pinned, so the period selector doesn't
// matter) checks that:
//   - i on the draft opens no inline editor (no inputs appear in the table);
//   - Space unfolds the draft's lines (read-only);
//   - Enter opens /bill/<id>;
//   - the "+ Add bill" row opens /bill/new.
//
// Run: node tests/payables-readonly-ux.mjs   (skips without Chromium)

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
  console.log('=== Payables read-only UX regression — SKIP ===');
  console.log('playwright-core is not installed. Skipping (exit 0).');
  process.exit(0);
}

const srv = await startTestServer({ withAdminToken: false });
const BASE = srv.baseUrl;
const CO = 'ROBILLS';
const td = testDates();
let browser;
try {
  console.log('=== Payables read-only UX regression ===');
  const { AP, EXP } = await seedCompany(BASE, CO, { jurisdiction: 'SE', currency: 'SEK' });
  const draft = await api(BASE, 'bill.draft.save', { companyId: CO, bill: {
    partner_name: 'Acme AB', vendor_ref: 'RO-1', date: td.day20, due_date: td.day25,
    currency: 'SEK', ap_account: AP,
    lines: [{ description: 'Read-only line', expense_account: EXP, amount: 500 }] } });
  if (draft.status !== 200) throw new Error('draft.save: ' + JSON.stringify(draft.body));
  const billId = draft.body.data.billId;

  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    if (/Executable doesn't exist|browserType\.launch/.test(String(e && e.message))) {
      console.log('=== Payables read-only UX regression — SKIP ===');
      console.log('Playwright browser binary not installed. Run: npx playwright-core install chromium');
      process.exit(0);
    }
    throw e;
  }
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const listUrl = `${BASE}/${CO}/payables?billIds=${encodeURIComponent(billId)}`;

  await page.goto(listUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('#bills-tbody tr[data-key]', { timeout: 10000 });
  await page.click('#bills-tbody tr[data-key] td[data-field="date"]');

  await page.keyboard.press('i');
  await page.waitForTimeout(300);
  ok('i opens no inline editor', await page.locator('#bills-tbody input').count() === 0);

  await page.keyboard.press(' ');
  await page.waitForFunction(() => document.body.innerText.includes('Read-only line'), null, { timeout: 5000 }).catch(() => {});
  ok('Space unfolds the draft lines', (await page.textContent('#bills-tbody')).includes('Read-only line'));
  ok('unfolded lines are read-only', await page.locator('#bills-tbody input').count() === 0);

  await page.keyboard.press('Enter');
  await page.waitForURL(u => u.pathname.endsWith('/bill/' + billId), { timeout: 5000 }).catch(() => {});
  ok('Enter opens the bill page', new URL(page.url()).pathname === `/${CO}/bill/${billId}`, page.url());

  await page.goto(listUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('#bills-tbody tr.fb-add-row', { timeout: 10000 });
  await page.click('#bills-tbody tr.fb-add-row');
  await page.waitForURL(u => u.pathname.endsWith('/bill/new'), { timeout: 5000 }).catch(() => {});
  ok('+ Add bill opens /bill/new', new URL(page.url()).pathname === `/${CO}/bill/new`, page.url());

  ok('no uncaught JS errors', errors.length === 0, errors.join('; '));
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
} finally {
  if (browser) await browser.close();
  await srv.cleanup();
}
process.exit(fail ? 1 : 0);
