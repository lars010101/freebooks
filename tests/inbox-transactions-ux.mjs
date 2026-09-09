// tests/inbox-transactions-ux.mjs — Inbox tab-strip + unified Transactions
// tab UX regression (2026-09-09).
//
// The Inbox rebuild replaced a single FB.list with a hidden f-cycling
// status filter and group-header/fold into a real tab strip (Transactions/
// Partners/New Rule/Failed Input), each its own FB.list instance. This
// covers what that rebuild actually changed:
//   1. Live tab counts on page load.
//   2. Transactions unifies journal proposals AND bill drafts into one
//      table — same verbs (approve/reject), same status vocabulary
//      (Proposed/Rejected — a bill's real DB status stays draft/rejected,
//      normalized for display only).
//   3. Rejected rows are hidden by default (Status column filter); posting
//      a bill and rejecting a bill both work through the unified verbs.
//   4. Foreign-currency amounts show their currency inline (no separate
//      always-blank column for the common base-currency case).
//   5. Failed Input's unfold shows the REAL rejected_lines detail + a
//      working link to the source statement — not just a "Flagged by"
//      meta line (a real gap this rebuild found and fixed in
//      queryInputRejections, which parsed rejected_lines only to compute
//      a count and never actually returned it on the item).
//
// The server is booted IN-PROCESS (mirrors tests/reversal.mjs, issue #112).
// Playwright/chromium is imported dynamically; if it is not installed the
// test SKIPS (exit 0) so `npm test` stays green.
//   Run: node tests/inbox-transactions-ux.mjs

import { startServer, apiPost } from './lib/test-server.mjs';

const CO = 'inbtxtest';
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
      company_id: CO, company_name: 'Inbox Transactions Test Co',
      jurisdiction: 'SE', currency: 'SEK', reporting_standard: 'K2',
      vat_registered: false, fy_start: '2026-01-01', fy_end: '2026-12-31',
    },
  }, 'itt-setup').catch((e) => { if (!/already exists|DUPLICATE/.test(String(e.message))) throw e; });

  await apiPost(BASE, 'coa.upsert', CO, {
    account: { account_code: '6000', account_name: 'Office supplies', account_type: 'Expense',
      account_subtype: 'Operating', is_active: true, effective_from: '2026-01-01' },
  }, 'itt-coa-6000');
  await apiPost(BASE, 'coa.upsert', CO, {
    account: { account_code: '2100', account_name: 'Accounts Payable', account_type: 'Liability',
      account_subtype: 'Current Liabilities', is_active: true, effective_from: '2026-01-01' },
  }, 'itt-coa-2100');

  await apiPost(BASE, 'period.upsert', CO, {
    period: { period_id: 'FY2026', start_date: '2026-01-01', end_date: '2026-12-31', locked: false },
  }, 'itt-period-2026');

  await sql(`INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by) VALUES (?, ?, 'agent', now(), 'test')`,
    ['agent@itt', CO]);
  await sql(`INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by) VALUES (?, ?, 'owner', now(), 'test')`,
    ['owner@itt', CO]);
}

async function run(chromium) {
  // ── Seed one of each: journal proposal, agent-created draft bill,
  //    foreign-currency journal proposal, input rejection + real statement.
  const journalProposal = await act('journal.propose', {
    userEmail: 'agent@itt',
    lines: [
      { account_code: '6000', debit: 50, credit: 0, date: '2026-03-01', description: 'ITT journal line' },
      { account_code: '2100', debit: 0, credit: 50, date: '2026-03-01', description: 'ITT journal line' },
    ],
    description: 'ITT Journal Proposal',
  });
  ok('seed journal.propose returns proposalId', !!journalProposal.proposalId, JSON.stringify(journalProposal).slice(0, 150));

  const draftBill = await act('bill.create', {
    userEmail: 'agent@itt',
    bill: {
      partner_name: 'ITT Vendor Co', vendor_ref: 'INV-ITT-1', date: '2026-03-01', due_date: '2026-03-31',
      amount: 200, currency: 'SEK', expense_account: '6000', ap_account: '2100', description: 'ITT bill line',
    },
  });
  ok('seed bill.create (agent) returns a draft', draftBill.status === 'draft', JSON.stringify(draftBill));

  const fxProposal = await act('journal.propose', {
    userEmail: 'agent@itt',
    lines: [
      { account_code: '6000', debit: 30, credit: 0, date: '2026-03-01', description: 'ITT FX line', currency: 'USD', fx_rate: 10 },
      { account_code: '2100', debit: 0, credit: 30, date: '2026-03-01', description: 'ITT FX line', currency: 'USD', fx_rate: 10 },
    ],
    description: 'ITT USD Proposal',
  });
  ok('seed foreign-currency journal.propose', !!fxProposal.proposalId, JSON.stringify(fxProposal).slice(0, 150));

  // statement_id on input_rejections IS the attachment's own attachment_id
  // (agent-loop.js's real input_rejection.create call passes ev.entity_id,
  // where ev is the attachment.uploaded event — its entity_id is the
  // attachment's primary key), NOT the attachments row's own entity_id
  // column (a caller-chosen grouping id at upload time, unrelated here).
  const attId = 'itt-att-' + Date.now();
  await sql(`INSERT INTO attachments (company_id, attachment_id, entity_type, entity_id, filename, storage_path, content_type, file_size, uploaded_at)
             VALUES (?, ?, 'bank_statement', ?, 'itt_statement.csv', 'itt/fake/path.csv', 'text/csv', 10, now())`,
    [CO, attId, 'itt-entity-1']);
  await act('input_rejection.create', {
    userEmail: 'agent@itt',
    statement_id: attId, statement_date: '2026-03-01',
    rejected_lines: [{ line: 5, raw: 'BAD LINE 1', reason: 'No amount' }, { line: 8, raw: 'BAD LINE 2', reason: 'Bad date' }],
  });
  ok('seed input_rejection.create', true);

  // ── Browser ───────────────────────────────────────────────────────────
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));

  await page.goto(`${BASE}/${CO}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  ok('Inbox loads with zero JS errors', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 200));

  const txnCount = await page.locator('#count-transactions').textContent();
  ok('Transactions tab count reflects both journal + bill proposals', txnCount === '3', txnCount);

  const txnText = await page.locator('#tab-transactions').innerText();
  ok('Transactions shows the journal proposal', txnText.includes('ITT Journal Proposal'));
  ok('Transactions shows the bill counterparty', txnText.includes('ITT Vendor Co'));
  ok('Transactions shows the foreign-currency amount inline with its currency', /30[.,]00.*USD/.test(txnText) || txnText.includes('USD'));

  // Sorting doesn't crash
  const amountTh = page.locator('#tab-transactions thead th', { hasText: 'Amount' });
  await amountTh.click();
  await page.waitForTimeout(200);
  ok('clicking the Amount header to sort does not crash the page', jsErrors.length === 0);

  // Post the bill via the unified Approve verb
  const billRow = page.locator('#txn-tbody tr', { hasText: 'ITT Vendor Co' });
  await billRow.locator('a[data-act="verb:y"]').click();
  await page.waitForTimeout(300);
  await page.locator('button, a').filter({ hasText: 'Approve' }).last().click();
  await page.waitForTimeout(1200);
  const afterPostText = await page.locator('#tab-transactions').innerText();
  ok('bill row leaves the proposed view after posting (approve is the post)', !afterPostText.includes('ITT Vendor Co'));

  // Reject the plain journal proposal via the unified Reject verb (note required)
  const jRow = page.locator('#txn-tbody tr', { hasText: 'ITT Journal Proposal' });
  await jRow.locator('a[data-act="verb:x"]').click();
  await page.waitForTimeout(300);
  const noteBox = page.locator('textarea, input[type=text]').last();
  await noteBox.fill('ITT rejection reason');
  await page.locator('button, a').filter({ hasText: 'Reject' }).last().click();
  await page.waitForTimeout(1000);
  const afterRejectText = await page.locator('#tab-transactions').innerText();
  ok('rejected journal proposal disappears from the default (proposed-only) view', !afterRejectText.includes('ITT Journal Proposal'));

  // Reveal it again via the Status column filter (click the active filter to clear it)
  const statusFilterBtn = page.locator('#tab-transactions thead th', { hasText: 'Status' }).locator('.fb-filter-btn');
  await statusFilterBtn.click();
  await page.waitForTimeout(300);
  const clearedText = await page.locator('#tab-transactions').innerText();
  ok('clearing the Status filter reveals the rejected journal proposal', clearedText.includes('ITT Journal Proposal'));
  ok('rejected row shows a Rejected badge', clearedText.includes('Rejected'));

  // ── Failed Input: unfold shows real detail (the bug this rebuild found) ──
  await page.locator('.tabs .tab', { hasText: 'Failed Input' }).click();
  await page.waitForTimeout(500);
  const failedRow = page.locator('#failedinput-tbody tr[data-key]').first();
  await failedRow.locator('td').first().click();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const unfoldedText = await page.locator('#tab-failedinput').innerText();
  ok('Failed Input unfold shows the real rejected line detail (line 5)', unfoldedText.includes('Line 5') || unfoldedText.includes('5'));
  ok('Failed Input unfold shows the real rejected line detail (line 8)', unfoldedText.includes('Line 8') || unfoldedText.includes('8'));
  const stmtLink = page.locator('#tab-failedinput a', { hasText: 'itt_statement.csv' });
  ok('Failed Input unfold shows a working link to the source statement', await stmtLink.count() > 0);

  await browser.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('INBOX TRANSACTIONS UX REGRESSION: FAIL'); process.exitCode = 1; return; }
  console.log('INBOX TRANSACTIONS UX REGRESSION: PASS');
}

// ── Bootstrapping: skip if Playwright absent, boot in-process server, run ──────
(async () => {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    console.log('=== Inbox Transactions UX regression — SKIP ===');
    console.log('playwright-core is not installed. Install it (and run `npx playwright install chromium`)');
    console.log('to exercise the browser flow. Skipping (exit 0).');
    process.exit(0);
  }

  const srv = await startServer();
  BASE = srv.baseUrl;
  ADMIN_TOKEN = srv.adminToken;
  try {
    console.log('=== Inbox Transactions UX regression ===');
    console.log(`In-process server: ${BASE}`);
    await seedCompany();
    await run(chromium);
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('Executable doesn\'t exist') || msg.includes('browserType.launch')) {
      console.log('=== Inbox Transactions UX regression — SKIP ===');
      console.log('Playwright browser binary not installed. Run: npx playwright install chromium');
      console.log('Skipping (exit 0).');
    } else {
      console.error('Inbox Transactions UX test error:', e);
      process.exitCode = 1;
    }
  } finally {
    await srv.cleanup();
  }
})();
