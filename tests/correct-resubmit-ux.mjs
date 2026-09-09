// tests/correct-resubmit-ux.mjs — Correct & Resubmit UX regression (2026-09-08).
//
// Covers the real, browser-facing path a rejected journal proposal takes:
//   1. Inbox's rejected-proposal filter shows a "c" (correct & resubmit) chip
//      that navigates to journal-voucher.js?correct=<proposalId>.
//   2. That page pre-fills the ORIGINAL (wrong) date/description/lines,
//      fully editable, and shows the rejection reason in a banner.
//   3. Editing + posting links the new batch back to the proposal
//      (corrected_by_batch_id) without touching the proposal's own status —
//      it stays 'rejected' for the record, never revised or reposted through.
//
// The server is booted IN-PROCESS (mirrors tests/reversal.mjs, issue #112).
// Playwright/chromium is imported dynamically; if it is not installed the
// test SKIPS (exit 0) so `npm test` stays green.
//   Run: node tests/correct-resubmit-ux.mjs

import { startServer, apiPost } from './lib/test-server.mjs';

const CO = 'crtest';
let BASE = '';
let ADMIN_TOKEN = '';

let pass = 0, fail = 0;
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

async function sql(query, params = []) {
  const r = await fetch(`${BASE}/api/admin/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ sql: query, params }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`admin query failed ${r.status}: ${JSON.stringify(body)}`);
  return body.rows || [];
}

async function seedCompany() {
  await apiPost(BASE, 'setup.add_company', 'x', {
    company: {
      company_id: CO, company_name: 'Correct Resubmit Test Co',
      jurisdiction: 'SE', currency: 'SEK', reporting_standard: 'K2',
      vat_registered: false, fy_start: '2026-01-01', fy_end: '2026-12-31',
    },
  }, 'crt-setup').catch((e) => { if (!/already exists|DUPLICATE/.test(String(e.message))) throw e; });

  // 1930 (Bank) comes from the SE template; 6000 (the CORRECT expense
  // account) and 6999 (a deliberately WRONG one, standing in for whatever
  // mismatch a real rejection would flag) both need upserting.
  await apiPost(BASE, 'coa.upsert', CO, {
    account: {
      account_code: '6000', account_name: 'Office supplies', account_type: 'Expense',
      account_subtype: 'Operating', is_active: true, effective_from: '2026-01-01',
    },
  }, 'crt-coa-6000');
  await apiPost(BASE, 'coa.upsert', CO, {
    account: {
      account_code: '6999', account_name: 'Misc bad account', account_type: 'Expense',
      account_subtype: 'Operating', is_active: true, effective_from: '2026-01-01',
    },
  }, 'crt-coa-6999');

  await apiPost(BASE, 'period.upsert', CO, {
    period: { period_id: 'FY2026', start_date: '2026-01-01', end_date: '2026-12-31', locked: false },
  }, 'crt-period-2026');
}

async function run(chromium) {
  // ── Seed a rejected proposal ─────────────────────────────────────────────
  const propose = await act('journal.propose', {
    lines: [
      { account_code: '6999', debit: 100, credit: 0, date: '2026-03-01', description: 'wrong account' },
      { account_code: '1930', debit: 0, credit: 100, date: '2026-03-01', description: 'wrong account' },
    ],
    description: 'CRTEST Office Supplies March',
  });
  ok('seed journal.propose returns proposalId', !!propose.proposalId, JSON.stringify(propose).slice(0, 160));
  const PROPOSAL_ID = propose.proposalId;

  const REASON = 'Wrong account — should be 6000 Office supplies, not 6999';
  const reject = await act('journal.reject', { proposalId: PROPOSAL_ID, note: REASON });
  ok('seed journal.reject succeeds', reject.rejected === true, JSON.stringify(reject));

  // ── Browser: Inbox shows the "c" chip on the rejected filter ────────────
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));

  await page.goto(`${BASE}/${CO}`, { waitUntil: 'networkidle' });
  ok('Inbox loads with zero JS errors', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 200));

  // Rejected rows are hidden by default on the Transactions tab (Status
  // column filter defaults to status:proposed, per the Inbox rebuild
  // 2026-09-09) — clicking the already-active filter button clears it,
  // revealing rejected rows too (fb-list.js's "click an active column
  // filter to clear it" convention).
  const statusFilterBtn = page.locator('#tab-transactions thead th', { hasText: 'Status' }).locator('.fb-filter-btn');
  await statusFilterBtn.click();
  await page.waitForTimeout(400);
  const bodyText = await page.locator('#tab-transactions').innerText();
  ok('Inbox shows the seeded rejected proposal once the Status filter is cleared', bodyText.includes('CRTEST'), bodyText.slice(0, 300));

  const chip = page.locator('a[data-act="verb:c"]').first();
  const chipCount = await page.locator('a[data-act="verb:c"]').count();
  ok('rejected row carries the correct & resubmit (c) chip', chipCount > 0, `count=${chipCount}`);

  if (chipCount > 0) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => null),
      chip.click(),
    ]);
    await page.waitForTimeout(500);
    ok('clicking the chip navigates to journal-voucher.js?correct=<id>',
      page.url().includes(`/journal/voucher?correct=${encodeURIComponent(PROPOSAL_ID)}`), page.url());
  }

  // ── journal-voucher.js: correction pre-fill ──────────────────────────────
  const bannerVisible = await page.locator('#correction-banner').isVisible().catch(() => false);
  ok('correction banner is visible', bannerVisible);
  const reason = await page.locator('#correction-reason').textContent().catch(() => '');
  ok('banner shows the rejection reason', (reason || '').includes('Wrong account'), reason);

  const date = await page.locator('#entry-date').inputValue();
  ok('date pre-fills to the ORIGINAL date, not today', date === '2026-03-01', date);
  const acct0 = await page.locator('#lines-body tr').nth(0).locator('.acct-input').inputValue();
  ok('line 1 pre-fills the original (wrong) account 6999', acct0.startsWith('6999'), acct0);
  const debit0 = await page.locator('#lines-body tr').nth(0).locator('.debit-input').inputValue();
  ok('line 1 pre-fills the original debit amount', debit0 === '100', debit0);
  const reversalBtnVisible = await page.locator('#btn-reversal-mode').isVisible().catch(() => true);
  ok('reversal button is hidden in correction mode (nothing posted yet to reverse)', !reversalBtnVisible);

  // ── Fix the wrong account and post ───────────────────────────────────────
  const acctInput0 = page.locator('#lines-body tr').nth(0).locator('.acct-input');
  await acctInput0.click();
  await acctInput0.fill('');
  await acctInput0.type('6000', { delay: 15 });
  await page.waitForTimeout(250);
  await acctInput0.press('Tab');
  await page.waitForTimeout(150);

  await page.locator('#btn-post').click();
  await page.waitForTimeout(1200);
  const status = await page.locator('#status-msg').textContent();
  ok('correction posts successfully', /Posted/.test(status || ''), status);

  await browser.close();

  // ── Audit link: corrected_by_batch_id stamped, proposal stays rejected ──
  const rows = await sql(
    `SELECT status, corrected_by_batch_id FROM journal_proposals WHERE company_id = ? AND proposal_id = ?`,
    [CO, PROPOSAL_ID]);
  ok('journal_proposals row found after correction', rows.length === 1, JSON.stringify(rows));
  if (rows.length === 1) {
    ok('proposal stays status=rejected (never revised/reposted through itself)', rows[0].status === 'rejected', rows[0].status);
    ok('corrected_by_batch_id is stamped with the new batch', !!rows[0].corrected_by_batch_id, JSON.stringify(rows[0]));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('CORRECT & RESUBMIT UX REGRESSION: FAIL'); process.exitCode = 1; return; }
  console.log('CORRECT & RESUBMIT UX REGRESSION: PASS');
}

// ── Bootstrapping: skip if Playwright absent, boot in-process server, run ──────
(async () => {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    console.log('=== Correct & Resubmit UX regression — SKIP ===');
    console.log('playwright-core is not installed. Install it (and run `npx playwright install chromium`)');
    console.log('to exercise the browser flow. Skipping (exit 0).');
    process.exit(0);
  }

  const srv = await startServer();
  BASE = srv.baseUrl;
  ADMIN_TOKEN = srv.adminToken;
  try {
    console.log('=== Correct & Resubmit UX regression ===');
    console.log(`In-process server: ${BASE}`);
    await seedCompany();
    await run(chromium);
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('Executable doesn\'t exist') || msg.includes('browserType.launch')) {
      console.log('=== Correct & Resubmit UX regression — SKIP ===');
      console.log('Playwright browser binary not installed. Run: npx playwright install chromium');
      console.log('Skipping (exit 0).');
    } else {
      console.error('Correct & Resubmit UX test error:', e);
      process.exitCode = 1;
    }
  } finally {
    await srv.cleanup();
  }
})();
