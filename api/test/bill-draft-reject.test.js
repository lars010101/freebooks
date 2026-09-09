'use strict';
/**
 * freeBooks — bill.draft.reject contract tests.
 *
 * A rejected draft bill is terminal — stays in place with status='rejected'
 * (same doctrine as journal.reject), never a hard delete like
 * bill.draft.delete. Added with the Inbox rebuild (2026-09-09) so a bill
 * row can behave identically to a journal proposal row on reject (the row
 * stays visible under the Transactions tab's rejected filter instead of
 * vanishing).
 *
 * Black-box tests over the action API. Run: node --test api/test/bill-draft-reject.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, sql, seedCompany, testDates } = require('../test-utils/helpers');
const TD = testDates();

let srv;
let baseUrl;
const CO = 'BR';
let AP, EXP;

before(async () => {
  srv = await startTestServer({ withAdminToken: true });
  baseUrl = srv.baseUrl;
  const seeded = await seedCompany(baseUrl, CO, { jurisdiction: 'SG', currency: 'SGD' });
  AP = seeded.AP; EXP = seeded.EXP;
  assert.ok(AP && EXP, 'seed must yield AP + Expense account codes');

  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@br', 'BR', 'owner', now(), 'test')`);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('agent@br', 'BR', 'agent', now(), 'test')`);
});

after(async () => { await srv.cleanup(); });

async function ownerApi(action, payload = {}) {
  return api(baseUrl, action, { companyId: CO, userEmail: 'owner@br', ...payload });
}
async function agentApi(action, payload = {}) {
  return api(baseUrl, action, { companyId: CO, userEmail: 'agent@br', ...payload });
}

/** Agent-creates a draft bill (bill.create redirects to a draft for an agent actor), returns billId. */
async function seedDraftBill(desc) {
  const r = await agentApi('bill.create', {
    bill: {
      partner_name: 'Test Vendor Co', vendor_ref: 'INV-' + Math.random().toString(36).slice(2, 8),
      date: TD.day15, due_date: TD.day25, amount: 100, currency: 'SGD',
      expense_account: EXP, ap_account: AP, description: desc,
    },
  });
  assert.equal(r.status, 200, `bill.create failed: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.data.status, 'draft', 'an agent actor must get a draft, not a posted bill');
  return r.body.data.billId;
}

test('bill.draft.reject: happy path sets status=rejected and stamps the reviewer triple', async () => {
  const billId = await seedDraftBill('reject happy path');
  const r = await ownerApi('bill.draft.reject', { billId, note: 'vendor cannot be verified' });
  assert.equal(r.status, 200, `reject failed: ${JSON.stringify(r.body)}`);
  assert.deepEqual(r.body.data, { rejected: true, billId });

  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT status, reviewed_by, reviewed_at, review_note FROM bills WHERE company_id='BR' AND bill_id=?`, [billId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'rejected', 'the row stays in place — never deleted, unlike bill.draft.delete');
  assert.equal(rows[0].reviewed_by, 'owner@br');
  assert.ok(rows[0].reviewed_at);
  assert.equal(rows[0].review_note, 'vendor cannot be verified');
});

test('bill.draft.reject: note is required', async () => {
  const billId = await seedDraftBill('reject no note');
  const r = await ownerApi('bill.draft.reject', { billId });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'INVALID_INPUT');
});

test('bill.draft.reject: a second reject on the same (now-rejected) bill is INVALID_STATUS', async () => {
  const billId = await seedDraftBill('reject twice');
  const r1 = await ownerApi('bill.draft.reject', { billId, note: 'first rejection' });
  assert.equal(r1.status, 200);

  const r2 = await ownerApi('bill.draft.reject', { billId, note: 'second rejection' });
  assert.equal(r2.status, 409, `expected INVALID_STATUS, got ${JSON.stringify(r2.body)}`);
  assert.equal(r2.body.error.code, 'INVALID_STATUS');
  assert.match(r2.body.error.message, /only 'draft' can be rejected/);
});

test('bill.draft.reject: a posted bill cannot be rejected', async () => {
  const billId = await seedDraftBill('reject after post');
  const post = await ownerApi('bill.draft.post', { billId });
  assert.equal(post.status, 200, `post failed: ${JSON.stringify(post.body)}`);

  const r = await ownerApi('bill.draft.reject', { billId, note: 'too late' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'INVALID_STATUS');
});

test('bill.draft.reject: unknown billId is NOT_FOUND', async () => {
  const r = await ownerApi('bill.draft.reject', { billId: 'nonexistent-bill-id', note: 'x' });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'NOT_FOUND');
});

test('bill.draft.reject: agent role is FORBIDDEN (data_entry action, not agentWritable)', async () => {
  const billId = await seedDraftBill('reject agent forbidden');
  const r = await agentApi('bill.draft.reject', { billId, note: 'x' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'FORBIDDEN');
});

test('bill.draft.reject: a rejected bill still shows up in bill.list (same as draft does today)', async () => {
  const billId = await seedDraftBill('reject visible in bill.list');
  await ownerApi('bill.draft.reject', { billId, note: 'visibility check' });

  const list = await ownerApi('bill.list', { threshold: 10000 });
  assert.equal(list.status, 200, `bill.list failed: ${JSON.stringify(list.body)}`);
  const rows = (list.body.data && list.body.data.data) || [];
  const found = Array.isArray(rows) ? rows.find((b) => b.bill_id === billId) : null;
  assert.ok(found, 'rejected bill should still be listed (same posture as draft bills today)');
  assert.equal(found.status, 'rejected');
});
