'use strict';
/**
 * freeBooks — per-actor API token tests (agent-readiness spec §2.6)
 *
 * Black-box tests over the action API surface: token create/list/revoke,
 * Bearer-token identity precedence over body userEmail, revoked/invalid token
 * rejection (401, no downgrade to self-asserted identity), the handler-level
 * idempotent revoke, and the role gate that blocks agents from token
 * management. Pure unit checks cover isLoopbackRequest / remoteTokenRequired.
 * Run: npm test  (in api/)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, sql, seedCompany } = require('../test-utils/helpers');

let srv;
let baseUrl;
const CO = 'CT';

before(async () => {
  srv = await startTestServer({ withAdminToken: true });
  baseUrl = srv.baseUrl;
  await seedCompany(baseUrl, CO);
  // Bootstrap owner + agent + viewer roles via admin SQL (not under test here).
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@ct', 'CT', 'owner', now(), 'test')`);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('agent@ct', 'CT', 'agent', now(), 'test')`);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('viewer@ct', 'CT', 'viewer', now(), 'test')`);
});

after(async () => { await srv.cleanup(); });

// ── 1. create + list (hash never leaves storage) ────────────────────────────

test('auth.token.create returns a one-time token; list never exposes the hash', async () => {
  const r = await api(baseUrl, 'auth.token.create',
    { companyId: CO, userEmail: 'owner@ct', email: 'owner@ct', label: 'agent-1' });
  assert.equal(r.status, 200, `create status: ${JSON.stringify(r.body)}`);
  const { tokenId, token, email, label } = r.body.data;
  assert.ok(tokenId, 'tokenId present');
  assert.ok(token.startsWith('fbt_'), 'token has the fbt_ prefix');
  assert.equal(email, 'owner@ct');
  assert.equal(label, 'agent-1');

  // list: the row is present, labelled, and carries NO token_hash key.
  const list = await api(baseUrl, 'auth.token.list',
    { companyId: CO, userEmail: 'owner@ct' });
  assert.equal(list.status, 200);
  const rows = list.body.data;
  const row = rows.find((x) => x.label === 'agent-1');
  assert.ok(row, 'created token row present in list');
  assert.equal('token_hash' in row, false, 'token_hash never returned');

  // admin SQL confirms only the sha256 hex is stored — it differs from the token.
  const stored = await sql(baseUrl, srv.adminToken,
    `SELECT token_hash FROM api_tokens WHERE token_id = '${tokenId}'`); // test-controlled uuid — safe to inline (contract.test.js convention)
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].token_hash, token, 'only the hash is persisted, not the token');
  assert.equal(stored[0].token_hash.length, 64, 'sha256 hex is 64 chars');
});

// ── 2. bearer identity wins over body userEmail ────────────────────────────

test('a valid Bearer token overrides body userEmail; no token keeps legacy trust', async () => {
  // Create a token bound to viewer@ct (owner@ct mints it).
  const mint = await api(baseUrl, 'auth.token.create',
    { companyId: CO, userEmail: 'owner@ct', email: 'viewer@ct', label: 'viewer-token' });
  assert.equal(mint.status, 200, `mint: ${JSON.stringify(mint.body)}`);
  const viewerToken = mint.body.data.token;

  // With the bearer: identity is viewer@ct (NOT the body's owner@ct claim).
  // permissions.list requires owner role → viewer identity → 403 FORBIDDEN.
  const asViewer = await api(baseUrl, 'permissions.list',
    { companyId: CO, userEmail: 'owner@ct' },
    { Authorization: `Bearer ${viewerToken}` });
  assert.equal(asViewer.status, 403);
  assert.equal(asViewer.body.error.code, 'FORBIDDEN');

  // Same call WITHOUT the Authorization header → legacy self-assert path intact
  // (owner@ct is an owner) → 200.
  const asOwner = await api(baseUrl, 'permissions.list',
    { companyId: CO, userEmail: 'owner@ct' });
  assert.equal(asOwner.status, 200);

  // journal.list is viewer-role; the viewer bearer succeeds.
  const journalAsViewer = await api(baseUrl, 'journal.list',
    { companyId: CO, userEmail: 'owner@ct' },
    { Authorization: `Bearer ${viewerToken}` });
  assert.equal(journalAsViewer.status, 200);
});

// ── 3. invalid / unknown token ──────────────────────────────────────────────

test('an invalid Bearer token is rejected with 401 UNAUTHENTICATED (no fallback)', async () => {
  const bogus = 'fbt_' + '0'.repeat(48);
  const r = await api(baseUrl, 'permissions.list',
    { companyId: CO, userEmail: 'owner@ct' },
    { Authorization: `Bearer ${bogus}` });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'UNAUTHENTICATED');
});

// ── 4. revoke (handler-level idempotent) + not-found ─────────────────────────

test('revoke invalidates the token; second revoke is idempotent; unknown id → 404', async () => {
  // Mint a fresh token to revoke.
  const mint = await api(baseUrl, 'auth.token.create',
    { companyId: CO, userEmail: 'owner@ct', email: 'owner@ct', label: 'revoke-me' });
  assert.equal(mint.status, 200);
  const { tokenId, token } = mint.body.data;

  // Revoke it.
  const rev = await api(baseUrl, 'auth.token.revoke',
    { companyId: CO, userEmail: 'owner@ct', tokenId });
  assert.equal(rev.status, 200, `revoke: ${JSON.stringify(rev.body)}`);
  assert.equal(rev.body.data.revoked, true);

  // The revoked token no longer authenticates → 401.
  const afterRevoke = await api(baseUrl, 'permissions.list',
    { companyId: CO, userEmail: 'owner@ct' },
    { Authorization: `Bearer ${token}` });
  assert.equal(afterRevoke.status, 401);
  assert.equal(afterRevoke.body.error.code, 'UNAUTHENTICATED');

  // Second revoke of the same id → 200 alreadyRevoked:true (handler-level idempotent).
  const rev2 = await api(baseUrl, 'auth.token.revoke',
    { companyId: CO, userEmail: 'owner@ct', tokenId });
  assert.equal(rev2.status, 200);
  assert.equal(rev2.body.data.revoked, true);
  assert.equal(rev2.body.data.alreadyRevoked, true);

  // Revoke of a non-existent id → 404 NOT_FOUND.
  const rev404 = await api(baseUrl, 'auth.token.revoke',
    { companyId: CO, userEmail: 'owner@ct', tokenId: 'no-such-id' });
  assert.equal(rev404.status, 404);
  assert.equal(rev404.body.error.code, 'NOT_FOUND');
});

// ── 5. pure units: isLoopbackRequest + remoteTokenRequired ───────────────────

test('isLoopbackRequest recognizes loopback addresses; remoteTokenRequired gates remote clients', () => {
  const { isLoopbackRequest, remoteTokenRequired } = require('../src/auth');

  const loopbackAddrs = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  for (const addr of loopbackAddrs) {
    const req = { socket: { remoteAddress: addr } };
    assert.equal(isLoopbackRequest(req), true, `loopback true for ${addr}`);
  }
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '10.0.0.5' } }), false, 'non-loopback false');
  assert.equal(isLoopbackRequest({}), false, 'no socket false');

  const fakeRemote = { socket: { remoteAddress: '10.0.0.5' } };
  const fakeLoopback = { socket: { remoteAddress: '127.0.0.1' } };

  assert.equal(remoteTokenRequired('token-remote', fakeRemote), true, 'remote client needs a token');
  assert.equal(remoteTokenRequired('trust', fakeRemote), false, 'trust mode never requires a token');
  assert.equal(remoteTokenRequired('token-remote', fakeLoopback), false, 'loopback exempt even in token-remote');
});

// ── 6. agents cannot manage tokens ──────────────────────────────────────────

test('agent-role callers are forbidden from token management', async () => {
  const list = await api(baseUrl, 'auth.token.list',
    { companyId: CO, userEmail: 'agent@ct' });
  assert.equal(list.status, 403);
  assert.equal(list.body.error.code, 'FORBIDDEN');

  const create = await api(baseUrl, 'auth.token.create',
    { companyId: CO, userEmail: 'agent@ct', email: 'agent@ct', label: 'x' });
  assert.equal(create.status, 403);
  assert.equal(create.body.error.code, 'FORBIDDEN');
});
