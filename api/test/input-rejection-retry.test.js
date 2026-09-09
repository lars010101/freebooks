'use strict';
/**
 * freeBooks — input_rejection.retry contract tests.
 *
 * The Inbox Failed Input tab's 'r' verb (bank-matching-spec §11.2 originally
 * anticipated an 'open | retried | discarded' status vocabulary, but retry
 * itself was never built — the chip shipped disabled). Retry re-queues the
 * ORIGINAL attachment for agent reprocessing by re-emitting the same
 * attachment.uploaded event the agent originally reacted to, so a fresh
 * failure goes through the identical processing path a first-time upload
 * takes. Covers: status transition, the re-emitted event's shape, the
 * missing-attachment guard, and the usual not-found/status/role checks.
 *
 * Black-box tests over the action API. Run: node --test api/test/input-rejection-retry.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, sql, seedCompany } = require('../test-utils/helpers');

let srv;
let baseUrl;
const CO = 'IR';

before(async () => {
  srv = await startTestServer({ withAdminToken: true });
  baseUrl = srv.baseUrl;
  await seedCompany(baseUrl, CO, { jurisdiction: 'SE', currency: 'SEK' });

  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@ir', 'IR', 'owner', now(), 'test')`);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('agent@ir', 'IR', 'agent', now(), 'test')`);
});

after(async () => { await srv.cleanup(); });

async function ownerApi(action, payload = {}) {
  return api(baseUrl, action, { companyId: CO, userEmail: 'owner@ir', ...payload });
}
async function agentApi(action, payload = {}) {
  return api(baseUrl, action, { companyId: CO, userEmail: 'agent@ir', ...payload });
}

let seq = 0;
async function seedRejection(overrides = {}) {
  seq += 1;
  const attachmentId = `ir-att-${seq}`;
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO attachments (company_id, attachment_id, entity_type, entity_id, filename, storage_path, content_type, file_size, uploaded_at)
     VALUES (?, ?, 'bank_statement', ?, 'ir_statement.csv', 'ir/fake/path.csv', 'text/csv', 42, now())`,
    [CO, attachmentId, `ir-entity-${seq}`]);
  const r = await agentApi('input_rejection.create', {
    statement_id: attachmentId, statement_date: '2026-03-01',
    rejected_lines: [{ line: 3, raw: 'BAD LINE', reason: 'No amount' }],
    ...overrides,
  });
  assert.equal(r.status, 200, `input_rejection.create failed: ${JSON.stringify(r.body)}`);
  return { rejectionId: r.body.data.rejection_id, attachmentId };
}

test('input_rejection.retry: happy path — status becomes retried, attachment.uploaded re-emitted', async () => {
  const { rejectionId, attachmentId } = await seedRejection();

  const before_ = await sql(baseUrl, srv.adminToken,
    `SELECT event_seq FROM events WHERE company_id='IR' ORDER BY event_seq DESC LIMIT 1`);
  const beforeMaxSeq = before_.length ? Number(before_[0].event_seq) : 0;

  const r = await ownerApi('input_rejection.retry', { rejectionId });
  assert.equal(r.status, 200, `retry failed: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.data.retried, true);
  assert.equal(r.body.data.rejection_id, rejectionId);
  assert.equal(r.body.data.attachment_id, attachmentId);

  const rows = await sql(baseUrl, srv.adminToken, `SELECT status FROM input_rejections WHERE company_id='IR' AND rejection_id=?`, [rejectionId]);
  assert.equal(rows[0].status, 'retried');

  const list = await ownerApi('event.list', { after_seq: beforeMaxSeq, type: 'attachment.uploaded' });
  assert.equal(list.status, 200);
  const reEmitted = list.body.data.find((e) => e.entity_id === attachmentId);
  assert.ok(reEmitted, `expected a re-emitted attachment.uploaded event for ${attachmentId}, got ${JSON.stringify(list.body.data)}`);
  const payload = typeof reEmitted.payload === 'string' ? JSON.parse(reEmitted.payload) : reEmitted.payload;
  assert.equal(payload.entityType, 'bank_statement');
  assert.equal(payload.filename, 'ir_statement.csv');
});

test('input_rejection.retry: unknown rejectionId is NOT_FOUND', async () => {
  const r = await ownerApi('input_rejection.retry', { rejectionId: 'no-such-rejection' });
  assert.equal(r.status, 404, `expected NOT_FOUND, got ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error.code, 'NOT_FOUND');
});

test('input_rejection.retry: a non-open rejection cannot be retried again', async () => {
  const { rejectionId } = await seedRejection();
  const first = await ownerApi('input_rejection.retry', { rejectionId });
  assert.equal(first.status, 200);

  const second = await ownerApi('input_rejection.retry', { rejectionId });
  assert.equal(second.status, 409, `expected INVALID_STATUS, got ${JSON.stringify(second.body)}`);
  assert.equal(second.body.error.code, 'INVALID_STATUS');
});

test('input_rejection.retry: a discarded rejection cannot be retried', async () => {
  const { rejectionId } = await seedRejection();
  const disc = await ownerApi('input_rejection.discard', { rejectionId });
  assert.equal(disc.status, 200);

  const r = await ownerApi('input_rejection.retry', { rejectionId });
  assert.equal(r.status, 409, `expected INVALID_STATUS, got ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error.code, 'INVALID_STATUS');
});

test('input_rejection.retry: the underlying attachment no longer existing is NOT_FOUND, row left open', async () => {
  const { rejectionId, attachmentId } = await seedRejection();
  await sql(baseUrl, srv.adminToken, `DELETE FROM attachments WHERE company_id='IR' AND attachment_id=?`, [attachmentId]);

  const r = await ownerApi('input_rejection.retry', { rejectionId });
  assert.equal(r.status, 404, `expected NOT_FOUND, got ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error.code, 'NOT_FOUND');

  const rows = await sql(baseUrl, srv.adminToken, `SELECT status FROM input_rejections WHERE company_id='IR' AND rejection_id=?`, [rejectionId]);
  assert.equal(rows[0].status, 'open', 'a failed retry (missing attachment) must not change the rejection status');
});

test('input_rejection.retry: rejectionId is required', async () => {
  const r = await ownerApi('input_rejection.retry', {});
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'INVALID_INPUT');
});

test('input_rejection.retry: agent role is FORBIDDEN (data_entry action, same floor as discard)', async () => {
  const { rejectionId } = await seedRejection();
  const r = await agentApi('input_rejection.retry', { rejectionId });
  assert.equal(r.status, 403, `expected FORBIDDEN, got ${JSON.stringify(r.body)}`);
});
