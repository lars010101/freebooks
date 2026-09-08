'use strict';
/**
 * freeBooks — orphan.list / orphan.delete contract tests
 * (calendar-reminders-documents-spec.md §5.5, moved to Documents 2026-09-08).
 *
 * orphaned_files IS the source of truth (R8) — orphan.list is a plain
 * viewer read over it (unresolved rows for the caller's company, oldest
 * first), orphan.delete removes the blob off disk and marks the row
 * resolved. Rows are seeded directly via SQL here (the real producer,
 * attachment-integrity-scanner.js, is a disk scanner — out of scope for a
 * black-box action-API test).
 *
 * Black-box tests over the action API. Run: node --test api/test/orphan-files.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, sql, seedCompany } = require('../test-utils/helpers');
const { randomUUID } = require('node:crypto');

let srv;
let baseUrl;
const CO = 'OF';
const OTHER_CO = 'OF2';

before(async () => {
  srv = await startTestServer({ withAdminToken: true });
  baseUrl = srv.baseUrl;
  await seedCompany(baseUrl, CO, { jurisdiction: 'SG', currency: 'SGD' });
  await seedCompany(baseUrl, OTHER_CO, { jurisdiction: 'SG', currency: 'SGD' });

  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@of', 'OF', 'owner', now(), 'test')`);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('agent@of', 'OF', 'agent', now(), 'test')`);
});

after(async () => { await srv.cleanup(); });

async function ownerApi(action, payload = {}) {
  return api(baseUrl, action, { companyId: CO, userEmail: 'owner@of', ...payload });
}
async function agentApi(action, payload = {}) {
  return api(baseUrl, action, { companyId: CO, userEmail: 'agent@of', ...payload });
}

async function seedOrphan(companyId, relPath, { resolved = false } = {}) {
  const orphanId = randomUUID();
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO orphaned_files (orphan_id, company_id, path, discovered_at, resolved_at)
     VALUES (?, ?, ?, now(), ?)`,
    [orphanId, companyId, relPath, resolved ? new Date().toISOString() : null]);
  return orphanId;
}

test('orphan.list: returns only unresolved rows for the caller\'s company', async () => {
  const mine = await seedOrphan(CO, `${CO}/orphan-test/mine.pdf`);
  await seedOrphan(CO, `${CO}/orphan-test/already-resolved.pdf`, { resolved: true });
  await seedOrphan(OTHER_CO, `${OTHER_CO}/orphan-test/not-mine.pdf`);

  const r = await ownerApi('orphan.list', {});
  assert.equal(r.status, 200, `orphan.list failed: ${JSON.stringify(r.body)}`);
  const rows = r.body.data;
  assert.ok(Array.isArray(rows));

  const ids = rows.map((row) => row.orphan_id);
  assert.ok(ids.includes(mine), 'unresolved row for this company should be listed');
  assert.equal(rows.filter((row) => row.path.includes('already-resolved')).length, 0,
    'a resolved row should not be listed');
  assert.equal(rows.filter((row) => row.path.includes('not-mine')).length, 0,
    'another company\'s row should not be listed');

  const row = rows.find((row) => row.orphan_id === mine);
  assert.equal(row.path, `${CO}/orphan-test/mine.pdf`);
  assert.equal(row.filename, 'mine.pdf', 'filename should be basename(path), not the full path');
  assert.ok(row.discovered_at);
});

test('orphan.list: oldest discovered_at first', async () => {
  const older = randomUUID();
  const newer = randomUUID();
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO orphaned_files (orphan_id, company_id, path, discovered_at) VALUES (?, ?, ?, ?)`,
    [older, CO, `${CO}/orphan-test/older.pdf`, '2020-01-01 00:00:00']);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO orphaned_files (orphan_id, company_id, path, discovered_at) VALUES (?, ?, ?, ?)`,
    [newer, CO, `${CO}/orphan-test/newer.pdf`, '2020-06-01 00:00:00']);

  const r = await ownerApi('orphan.list', {});
  assert.equal(r.status, 200);
  const idxOlder = r.body.data.findIndex((row) => row.orphan_id === older);
  const idxNewer = r.body.data.findIndex((row) => row.orphan_id === newer);
  assert.ok(idxOlder >= 0 && idxNewer >= 0);
  assert.ok(idxOlder < idxNewer, 'the earlier-discovered row should sort first');
});

test('orphan.delete: removes the row from orphan.list and marks it resolved', async () => {
  const orphanId = await seedOrphan(CO, `${CO}/orphan-test/to-delete.pdf`);

  const before = await ownerApi('orphan.list', {});
  assert.ok(before.body.data.some((row) => row.orphan_id === orphanId));

  const del = await ownerApi('orphan.delete', { orphanId });
  assert.equal(del.status, 200, `orphan.delete failed: ${JSON.stringify(del.body)}`);
  assert.deepEqual(del.body.data, { deleted: true, orphan_id: orphanId });

  const after = await ownerApi('orphan.list', {});
  assert.ok(!after.body.data.some((row) => row.orphan_id === orphanId),
    'deleted orphan should no longer be listed');

  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT resolved_at FROM orphaned_files WHERE orphan_id = ?`, [orphanId]);
  assert.ok(rows[0].resolved_at, 'resolved_at should be stamped');
});

test('orphan.delete: tolerates a file already missing on disk (no crash)', async () => {
  // The seeded path never corresponds to a real file under the test
  // server's isolated ATTACHMENTS_ROOT — this exercises the "already
  // gone" fs.unlinkSync catch branch on every run.
  const orphanId = await seedOrphan(CO, `${CO}/orphan-test/never-existed.pdf`);
  const del = await ownerApi('orphan.delete', { orphanId });
  assert.equal(del.status, 200, `orphan.delete should succeed even if the file is already gone: ${JSON.stringify(del.body)}`);
});

test('orphan.delete: unknown orphanId is NOT_FOUND', async () => {
  const r = await ownerApi('orphan.delete', { orphanId: 'nonexistent-orphan-id' });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'NOT_FOUND');
});

test('orphan.delete: an already-resolved orphan is NOT_FOUND (can\'t delete twice)', async () => {
  const orphanId = await seedOrphan(CO, `${CO}/orphan-test/double-delete.pdf`);
  const first = await ownerApi('orphan.delete', { orphanId });
  assert.equal(first.status, 200);

  const second = await ownerApi('orphan.delete', { orphanId });
  assert.equal(second.status, 404, `expected NOT_FOUND on the second delete, got ${JSON.stringify(second.body)}`);
  assert.equal(second.body.error.code, 'NOT_FOUND');
});

test('orphan.delete: agent role is FORBIDDEN (owner-only — a human decides what\'s safe to discard)', async () => {
  const orphanId = await seedOrphan(CO, `${CO}/orphan-test/agent-forbidden.pdf`);
  const r = await agentApi('orphan.delete', { orphanId });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'FORBIDDEN');
});

test('orphan.list: agent role is allowed (viewer action)', async () => {
  const r = await agentApi('orphan.list', {});
  assert.equal(r.status, 200, `agent orphan.list should be allowed: ${JSON.stringify(r.body)}`);
});
