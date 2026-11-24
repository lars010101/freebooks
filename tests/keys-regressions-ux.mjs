// Keyboard regressions found by the 2026-11-23 keybinding audit.
//
//   1. Journal: j/k move the visible list after switching tabs. Report lists
//      treated a missing tbody as active, so a visited tab's list (swapped
//      out of the DOM) kept swallowing j/k.
//   2. Bill page, x on the header (cursor starts there):
//        new (not yet saved)  → nothing happens;
//        saved draft          → confirm, then the draft is deleted;
//        posted, nothing paid → confirm, then voided (reversal entry).
//   3. W on a posted, part-paid bill writes off the remainder.
//   4. The ? overlay lists only keys that do something here: no Edit/Write/
//      Undo on read-only lists, "Delete draft" vs "Void (reverse)" by bill
//      state, every active list (Settings → Access shows both lists), and
//      the navigation rows p / g w / Esc / ? with h/l as tabs.
//
// Run: node tests/keys-regressions-ux.mjs   (skips without Chromium)

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { startTestServer, api, sql, seedCompany, testDates } = require('../api/test-utils/helpers');

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

const srv = await startTestServer();
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
  // Part-paid bill: 100 posted, 99.50 paid → 0.50 left (inside the default
  // write-off threshold of max(1.00, 1%)).
  const partId = await draft('KR-W');
  await api(B, 'bill.draft.post', { companyId: CO, billId: partId });
  await sql(B, srv.adminToken, `UPDATE accounts SET cf_category='Cash' WHERE company_id='${CO}' AND account_code='1930'`);
  const woAcct = accounts.find(a => a.account_type === 'Expense' && a.account_code !== EXP).account_code;
  await sql(B, srv.adminToken, `UPDATE accounts SET default_role='Write-off' WHERE company_id='${CO}' AND account_code='${woAcct}'`);
  const pay = await api(B, 'payment.record', { companyId: CO, billId: partId, date: TD.day21, bankAccount: '1930', amount: 99.5, reference: 'KR' });
  if (pay.status !== 200) throw new Error('payment.record: ' + JSON.stringify(pay.body));
  // An owner and one API token, so Settings → Access has rows in both lists.
  await sql(B, srv.adminToken, `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by) VALUES ('owner@kr', '${CO}', 'owner', now(), 'test')`);
  const tok = await api(B, 'auth.token.create', { companyId: CO, userEmail: 'owner@kr', email: 'owner@kr', label: 'kr-token' });
  if (tok.status !== 200) throw new Error('auth.token.create: ' + JSON.stringify(tok.body));
  const billOutstanding = async (id) => {
    const r = await api(B, 'bill.get', { companyId: CO, billId: id });
    const d = r.body.data || {};
    return Math.round((Number(d.amount) - Number(d.amount_paid)) * 100) / 100;
  };
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

  // Help overlay text for the current page state.
  const help = async () => {
    await blur();
    await page.keyboard.press('?'); await page.waitForTimeout(150);
    const t = await page.evaluate(() => { const el = document.getElementById('fb-keys-overlay'); return el ? el.innerText : ''; });
    await page.evaluate(() => FB.keys.help.close());
    return t;
  };

  // 4a. Read-only list: no Edit / Write / Undo; navigation rows present
  await page.goto(`${B}/${CO}/payables`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#bills-tbody tr[data-key]', { timeout: 8000 });
  await page.click('#bills-tbody tr[data-key] td[data-field="date"]');
  let h = await help();
  ok('Bills help has no Edit / Write / Undo', !/\bEdit\b|\bWrite\b(?! off)|\bUndo\b/.test(h), h.replace(/\s+/g, ' ').slice(-300));
  ok('Bills help keeps Open', /\bOpen\b/.test(h));
  ok('help lists p, g w, Esc and ? with h/l as tabs',
    /Period selector/.test(h) && /Switch company/.test(h) && /Close \/ cancel/.test(h) && /This help/.test(h) && /Previous \/ next tab/.test(h));

  // 5. c no longer clears filters (2026-11-24); Esc does, and help says so
  await page.evaluate(() => { const l = FB.list.visible && FB.list.visible(); if (l && l.applyFilterExpr) l.applyFilterExpr('vendor_ref:KR-P'); });
  await page.waitForTimeout(200);
  const rows = () => page.locator('#bills-tbody tr[data-key]').count();
  const filtered = await rows();
  await page.click('#bills-tbody tr[data-key] td[data-field="date"]').catch(() => {});
  h = await help();
  ok('filtered list help: Esc clear filters, no c', /Esc\s*clear filters/i.test(h) && !/\bc\s*clear filters/i.test(h), h.replace(/\s+/g, ' ').slice(-300));
  await blur();
  await page.keyboard.press('c'); await page.waitForTimeout(200);
  ok('c leaves the filter on', (await rows()) === filtered, `rows ${filtered} → ${await rows()}`);
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  ok('Esc clears the filter', (await rows()) > filtered, `rows ${filtered} → ${await rows()}`);

  // 4b. Settings → Access shows both lists
  await page.goto(`${B}/${CO}/settings`, { waitUntil: 'networkidle' });
  await page.locator('.tabs .tab', { hasText: 'Access' }).click();
  await page.waitForTimeout(800);
  h = await help();
  ok('Settings → Access: grants list owns the shared keys by default', /Settings-access\b/.test(h) && !/Settings-access-tokens/.test(h));
  await page.click('#access-tokens-body tr[data-key] td');
  await page.waitForTimeout(200);
  h = await help();
  ok('after clicking a token row, help shows the tokens list', /Settings-access-tokens/.test(h), h.replace(/\s+/g, ' ').slice(-300));

  // 4c. Bill help follows the bill's state (draft before it is deleted below)
  await page.goto(`${B}/${CO}/bill/${draftId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  h = await help();
  ok('draft bill help: Delete draft, no Void', /Delete draft/.test(h) && !/Void/.test(h));
  await page.goto(`${B}/${CO}/bill/${postedId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  h = await help();
  ok('posted bill help: Void (reverse), no Delete draft', /Void \(reverse\)/.test(h) && !/Delete draft/.test(h));

  // 3. W on a part-paid bill
  await page.goto(`${B}/${CO}/bill/${partId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  h = await help();
  ok('part-paid bill help: Write off remainder, no Void', /Write off remainder/.test(h) && !/Void/.test(h));
  await blur();
  await page.keyboard.press('W');
  const wo = page.getByRole('button', { name: 'Write off' });
  await wo.waitFor({ timeout: 5000 }).catch(() => {});
  ok('W asks to write off the remainder', await wo.count() === 1);
  if (await wo.count()) { await wo.click(); await page.waitForTimeout(1200); }
  ok('remainder written off', (await billOutstanding(partId)) === 0, `outstanding ${await billOutstanding(partId)}`);

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
  // 6. Enter on a read-only register row drills to the entry (ia-spec §10);
  // FB.list used to swallow Enter there and do nothing.
  await page.keyboard.press('Enter');
  await page.waitForURL(u => /\/journal\/voucher\?batch=/.test(u.href), { timeout: 5000 }).catch(() => {});
  ok('Enter on a Line items row opens its journal entry', /\/journal\/voucher\?batch=/.test(page.url()), page.url().replace(B, ''));

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
