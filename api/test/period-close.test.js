'use strict';
/**
 * freeBooks — P2-1 period.close contract tests.
 *
 * Tests the year-end close action: summary entry, idempotency guard,
 * pack-driven account selection, zero-P&L edge case, and reversal.
 *
 * Run: node --test test/period-close.test.js  (in api/)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, sql, seedCompany } = require('../test-utils/helpers');

let srv;
let baseUrl;
const CO = 'PCT'; // period close test company
let AP, EXP, REV, CLOSING, RE;

before(async () => {
  srv = await startTestServer({ withAdminToken: true });
  baseUrl = srv.baseUrl;
  const seeded = await seedCompany(baseUrl, CO, { jurisdiction: 'SG', currency: 'SGD' });
  AP = seeded.AP;
  EXP = seeded.EXP;
  // Find Revenue + Closing + RE accounts from the SG COA
  const accounts = seeded.accounts;
  REV = accounts.find(a => a.account_type === 'Revenue');
  CLOSING = accounts.find(a => a.account_type === 'Closing');
  RE = accounts.find(a => a.account_type === 'Equity' && /retained/i.test(a.account_name || ''));
  assert.ok(REV, 'seed must yield a Revenue account');
  assert.ok(CLOSING, 'seed must yield a Closing account');
  assert.ok(RE, 'seed must yield a Retained Earnings account');

  // Grant owner rights
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@pct', 'PCT', 'owner', now(), 'test')`);
});

after(async () => { await srv.cleanup(); });

// Helper: post a revenue journal entry to create a non-zero P&L
async function postRevenue(amount, date = '2026-07-15') {
  const r = await api(baseUrl, 'journal.post', {
    companyId: CO,
    userEmail: 'owner@pct',
    lines: [
      { account_code: AP, debit: amount, date, description: 'P2-1 test revenue' },
      { account_code: REV.account_code, credit: amount, date, description: 'P2-1 test revenue' },
    ],
  });
  assert.equal(r.status, 200, `journal.post failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

// Helper: post an expense journal entry
async function postExpense(amount, date = '2026-07-16') {
  const r = await api(baseUrl, 'journal.post', {
    companyId: CO,
    userEmail: 'owner@pct',
    lines: [
      { account_code: EXP, debit: amount, date, description: 'P2-1 test expense' },
      { account_code: AP, credit: amount, date, description: 'P2-1 test expense' },
    ],
  });
  assert.equal(r.status, 200, `journal.post failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

test('period.close posts a balanced closing entry for a profitable period', async () => {
  const CO2 = 'PCT2';
  const seeded = await seedCompany(baseUrl, CO2, { jurisdiction: 'SG', currency: 'SGD' });
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@pct', 'PCT2', 'owner', now(), 'test')`);

  // Post revenue > expense → profit
  await api(baseUrl, 'journal.post', {
    companyId: CO2, userEmail: 'owner@pct',
    lines: [
      { account_code: seeded.AP, debit: 200, date: '2026-07-15', description: 'rev' },
      { account_code: seeded.accounts.find(a => a.account_type === 'Revenue').account_code, credit: 200, date: '2026-07-15', description: 'rev' },
    ],
  });
  await api(baseUrl, 'journal.post', {
    companyId: CO2, userEmail: 'owner@pct',
    lines: [
      { account_code: seeded.EXP, debit: 50, date: '2026-07-16', description: 'exp' },
      { account_code: seeded.AP, credit: 50, date: '2026-07-16', description: 'exp' },
    ],
  });

  // Close the period
  const close = await api(baseUrl, 'period.close', {
    companyId: CO2, userEmail: 'owner@pct',
    periodId: '2026-07',
  });
  assert.equal(close.status, 200, `period.close failed: ${JSON.stringify(close.body)}`);
  assert.equal(close.body.data.closed, true);
  assert.equal(close.body.data.periodId, '2026-07');
  assert.equal(close.body.data.net, 150, 'net should be 200 revenue - 50 expense = 150');
  assert.ok(close.body.data.batchId, 'should return a batchId');

  // Verify the journal entry: D closing, C RE (profit)
  const batchRows = await sql(baseUrl, srv.adminToken,
    `SELECT account_code, debit_home, credit_home, source, reference
     FROM journal_entries WHERE company_id = 'PCT2' AND batch_id = ?`,
    [close.body.data.batchId]
  );
  assert.equal(batchRows.length, 2, 'close batch should have 2 lines');
  const closingLine = batchRows.find(r => r.account_code === CLOSING.account_code);
  const reLine = batchRows.find(r => r.account_code === RE.account_code);
  assert.ok(closingLine, 'closing account line exists');
  assert.ok(reLine, 'RE account line exists');
  assert.equal(Number(closingLine.debit_home), 150, 'closing account debited (profit)');
  assert.equal(Number(closingLine.credit_home), 0);
  assert.equal(Number(reLine.credit_home), 150, 'RE account credited (profit)');
  assert.equal(Number(reLine.debit_home), 0);
  assert.equal(closingLine.source, 'period_close');
  assert.equal(closingLine.reference, 'CLOSE/2026-07');
});

test('period.close is idempotent — second call detects existing close', async () => {
  const CO3 = 'PCT3';
  const seeded = await seedCompany(baseUrl, CO3, { jurisdiction: 'SG', currency: 'SGD' });
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@pct', 'PCT3', 'owner', now(), 'test')`);

  // Post some P&L
  const revAcct = seeded.accounts.find(a => a.account_type === 'Revenue').account_code;
  await api(baseUrl, 'journal.post', {
    companyId: CO3, userEmail: 'owner@pct',
    lines: [
      { account_code: seeded.AP, debit: 100, date: '2026-07-15', description: 'rev' },
      { account_code: revAcct, credit: 100, date: '2026-07-15', description: 'rev' },
    ],
  });

  // First close
  const c1 = await api(baseUrl, 'period.close', {
    companyId: CO3, userEmail: 'owner@pct', periodId: '2026-07',
  });
  assert.equal(c1.status, 200);
  assert.equal(c1.body.data.closed, true);
  assert.ok(!c1.body.data.already, 'first close should not be "already"');

  // Second close — should detect existing
  const c2 = await api(baseUrl, 'period.close', {
    companyId: CO3, userEmail: 'owner@pct', periodId: '2026-07',
  });
  assert.equal(c2.status, 200);
  assert.equal(c2.body.data.closed, true);
  assert.equal(c2.body.data.already, true, 'second close should be idempotent no-op');
  assert.equal(c2.body.data.batchId, c1.body.data.batchId, 'same batchId');
});

test('period.close on zero P&L returns early without posting', async () => {
  const CO4 = 'PCT4';
  await seedCompany(baseUrl, CO4, { jurisdiction: 'SG', currency: 'SGD' });
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@pct', 'PCT4', 'owner', now(), 'test')`);

  // No P&L entries posted — P&L net = 0
  const close = await api(baseUrl, 'period.close', {
    companyId: CO4, userEmail: 'owner@pct', periodId: '2026-07',
  });
  assert.equal(close.status, 200);
  assert.equal(close.body.data.closed, true);
  assert.equal(close.body.data.net, 0);
  assert.match(close.body.data.message, /zero/i, 'should explain no entry needed');
  assert.ok(!close.body.data.batchId, 'no batchId for zero P&L');
});

test('period.close requires periodId', async () => {
  const r = await api(baseUrl, 'period.close', {
    companyId: CO, userEmail: 'owner@pct',
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'INVALID_INPUT');
});

test('period.close on unknown period → 404', async () => {
  const r = await api(baseUrl, 'period.close', {
    companyId: CO, userEmail: 'owner@pct', periodId: 'FY1999',
  });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'NOT_FOUND');
});

test('period.close on loss posts C closing, D RE', async () => {
  const CO5 = 'PCT5';
  const seeded = await seedCompany(baseUrl, CO5, { jurisdiction: 'SG', currency: 'SGD' });
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@pct', 'PCT5', 'owner', now(), 'test')`);

  const revAcct = seeded.accounts.find(a => a.account_type === 'Revenue').account_code;

  // Post expense > revenue → loss
  await api(baseUrl, 'journal.post', {
    companyId: CO5, userEmail: 'owner@pct',
    lines: [
      { account_code: revAcct, credit: 50, date: '2026-07-15', description: 'rev' },
      { account_code: seeded.AP, debit: 50, date: '2026-07-15', description: 'rev' },
    ],
  });
  await api(baseUrl, 'journal.post', {
    companyId: CO5, userEmail: 'owner@pct',
    lines: [
      { account_code: seeded.EXP, debit: 200, date: '2026-07-16', description: 'exp' },
      { account_code: seeded.AP, credit: 200, date: '2026-07-16', description: 'exp' },
    ],
  });

  const close = await api(baseUrl, 'period.close', {
    companyId: CO5, userEmail: 'owner@pct', periodId: '2026-07',
  });
  assert.equal(close.status, 200);
  assert.equal(close.body.data.closed, true);
  assert.equal(close.body.data.net, -150, 'net should be 50 revenue - 200 expense = -150');

  // Verify: C closing, D RE (loss)
  const batchRows = await sql(baseUrl, srv.adminToken,
    `SELECT account_code, debit_home, credit_home
     FROM journal_entries WHERE company_id = 'PCT5' AND batch_id = ?`,
    [close.body.data.batchId]
  );
  const closingLine = batchRows.find(r => r.account_code === CLOSING.account_code);
  const reLine = batchRows.find(r => r.account_code === RE.account_code);
  assert.equal(Number(closingLine.credit_home), 150, 'closing account credited (loss)');
  assert.equal(Number(closingLine.debit_home), 0);
  assert.equal(Number(reLine.debit_home), 150, 'RE account debited (loss)');
  assert.equal(Number(reLine.credit_home), 0);
});

test('period.close audit log written', async () => {
  const CO6 = 'PCT6';
  const seeded = await seedCompany(baseUrl, CO6, { jurisdiction: 'SG', currency: 'SGD' });
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@pct', 'PCT6', 'owner', now(), 'test')`);

  const revAcct = seeded.accounts.find(a => a.account_type === 'Revenue').account_code;
  await api(baseUrl, 'journal.post', {
    companyId: CO6, userEmail: 'owner@pct',
    lines: [
      { account_code: seeded.AP, debit: 75, date: '2026-07-15', description: 'rev' },
      { account_code: revAcct, credit: 75, date: '2026-07-15', description: 'rev' },
    ],
  });

  await api(baseUrl, 'period.close', {
    companyId: CO6, userEmail: 'owner@pct', periodId: '2026-07',
  });

  const auditRows = await sql(baseUrl, srv.adminToken,
    `SELECT * FROM audit_log WHERE company_id = 'PCT6' AND action = 'period.close'`
  );
  assert.ok(auditRows.length >= 1, 'audit log row exists for period.close');
  assert.equal(auditRows[0].table_name, 'period');
  assert.equal(auditRows[0].record_id, '2026-07');
});

test('inbox.list includes period_unclosed items for unclosed past periods', async () => {
  const CO7 = 'PCT7';
  await seedCompany(baseUrl, CO7, { jurisdiction: 'SG', currency: 'SGD' });
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@pct', 'PCT7', 'owner', now(), 'test')`);

  // The seeded period '2026-07' has end_date 2026-07-31 — which is in the past
  // and has no close batch. It should surface as a period_unclosed item.
  const inbox = await api(baseUrl, 'inbox.list', {
    companyId: CO7, userEmail: 'owner@pct', status: 'unclosed',
  });
  assert.equal(inbox.status, 200);
  const unclosedItems = inbox.body.data.items.filter(i => i.type === 'period_unclosed');
  assert.ok(unclosedItems.length >= 1, 'should have at least one period_unclosed item');
  assert.equal(unclosedItems[0].verbs.includes('close'), true, 'verb should include close');
  assert.ok(unclosedItems[0].payload_ref, 'payload_ref should be the period name');
});
