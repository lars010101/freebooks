'use strict';
/**
 * freeBooks — Chat with AI tests (docs/chat-with-ai-spec.md)
 *
 * Black-box over the action API for the deterministic/gated parts of the
 * flow: the LLM-unreachable error path (no llm_endpoint_url configured —
 * the same limitation the existing ai.test_connection tests accept, since
 * the server under test runs in a child process and there is no way to
 * mock a real LLM response from here), the permission gate's CRUD surface,
 * and role gating. Category fetchers + aliasing are unit-tested directly
 * against chat.js's exported _internal (in-process, own throwaway DB).
 * Run: npm test  (in api/)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startTestServer, api, sql, seedCompany } = require('../test-utils/helpers');

let srv;
let baseUrl;
const CO = 'CT';

before(async () => {
  srv = await startTestServer({ withAdminToken: true });
  baseUrl = srv.baseUrl;
  await seedCompany(baseUrl, CO);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@ct', 'CT', 'owner', now(), 'test')`);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('viewer@ct', 'CT', 'viewer', now(), 'test')`);
});

after(async () => { await srv.cleanup(); });

// ── LLM-unreachable path (§2 step 9) — no llm_endpoint_url configured ──────

test('chat.send with no LLM endpoint configured writes an error turn, not a silent drop', async () => {
  const turnId = 'turn-noconfig-1';
  const r = await api(baseUrl, 'chat.send', { companyId: CO, userEmail: 'owner@ct', message: 'is the agent running?', turnId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.error, true);
  assert.match(r.body.data.reply, /Couldn't reach the configured LLM endpoint/);

  const hist = await api(baseUrl, 'chat.history.list', { companyId: CO, userEmail: 'owner@ct' });
  const msgs = hist.body.data.messages;
  assert.equal(msgs.length, 2, 'user + assistant-error both written to history');
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].content, 'is the agent running?');
  assert.equal(msgs[1].role, 'assistant');
  assert.match(msgs[1].content, /Couldn't reach the configured LLM endpoint/);
});

// ── Dispatch-level required params (catalog-driven — same mechanism every
// other action gets, asserted here for chat.send specifically) ────────────

test('chat.send missing turnId → 400 INVALID_INPUT', async () => {
  const r = await api(baseUrl, 'chat.send', { companyId: CO, userEmail: 'owner@ct', message: 'hi' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'INVALID_INPUT');
});

// ── Role gate — viewer is below chat.send's data_entry floor ──────────────

test('chat.send as viewer → FORBIDDEN', async () => {
  const r = await api(baseUrl, 'chat.send', { companyId: CO, userEmail: 'viewer@ct', message: 'hi', turnId: 'turn-viewer-1' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'FORBIDDEN');
});

// ── chat.permission.decide on an unknown turn ──────────────────────────────

test('chat.permission.decide on a nonexistent turn → NOT_FOUND', async () => {
  const r = await api(baseUrl, 'chat.permission.decide',
    { companyId: CO, userEmail: 'owner@ct', turnId: 'no-such-turn', category: 'coa', decision: 'approve_once' });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'NOT_FOUND');
});

test('chat.permission.decide with an unknown category → INVALID_INPUT', async () => {
  const r = await api(baseUrl, 'chat.permission.decide',
    { companyId: CO, userEmail: 'owner@ct', turnId: 'no-such-turn', category: 'not_a_real_category', decision: 'approve_once' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'INVALID_INPUT');
});

// ── chat.permissions.list / revoke round-trip ──────────────────────────────

test('chat.permissions.list starts empty; revoke on an unset category is a harmless no-op', async () => {
  const list = await api(baseUrl, 'chat.permissions.list', { companyId: CO, userEmail: 'owner@ct' });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.permissions, []);

  const revoke = await api(baseUrl, 'chat.permissions.revoke', { companyId: CO, userEmail: 'owner@ct', category: 'coa' });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.body.data.revoked, true);
});

test('chat.permissions.revoke on an unknown category → INVALID_INPUT', async () => {
  const r = await api(baseUrl, 'chat.permissions.revoke', { companyId: CO, userEmail: 'owner@ct', category: 'not_a_real_category' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'INVALID_INPUT');
});

// ── §2a category fetchers + §3 aliasing — unit-tested directly against
// chat.js's _internal export, in a SEPARATE throwaway DB file of their own
// (own process, own db.js singleton). This deliberately does NOT touch
// srv's dbPath — that file is held open by srv's child-process server for
// the whole suite, and DuckDB does not allow a second concurrent connection
// to the same file (see db-caution: querying an already-open DB from
// another process/connection fails with a lock error). runInit's subprocess
// fully exits before returning, so once it resolves the file is free for
// this process's own connection. ───────────────────────────────────────────
test('category fetchers + aliasing (isolated DB)', async (t) => {
  const { runInit } = require('../test-utils/helpers');
  const dbPath = `/tmp/fb-chat-unit-${process.pid}.duckdb`;
  for (const suffix of ['', '.wal']) { try { fs.unlinkSync(dbPath + suffix); } catch { /* fresh */ } }
  await runInit(dbPath);
  process.env.FREEBOOKS_DB_PATH = dbPath;
  delete require.cache[require.resolve('../src/db')];
  delete require.cache[require.resolve('../src/chat')];
  const { bulkInsert } = require('../src/db');
  const { _internal } = require('../src/chat');
  const UCO = 'UT';

  await bulkInsert('accounts', [{
    company_id: UCO, account_code: '1930', account_name: 'Bank', account_type: 'Asset',
    is_active: true, effective_from: '2020-01-01', created_at: new Date().toISOString(),
  }]);

  await t.test('coa returns the seeded account', async () => {
    const coa = await _internal.fetchCategoryData('coa', UCO, {});
    assert.ok(Array.isArray(coa) && coa.length === 1, 'coa returns rows');
    assert.equal(coa[0].account_code, '1930');
  });

  await t.test('agent_status returns the expected shape', async () => {
    const status = await _internal.fetchCategoryData('agent_status', UCO, {});
    assert.equal(typeof status.agent_running, 'boolean');
  });

  await t.test('aliasing: same real value always resolves to the same alias, and de-aliases back', async () => {
    const a1 = await _internal.getOrCreateAlias(UCO, 'partner', 'Acme Test Corp');
    const a2 = await _internal.getOrCreateAlias(UCO, 'partner', 'Acme Test Corp');
    assert.equal(a1, a2, 'alias is stable across calls, not re-minted');
    assert.match(a1, /^Vendor_\d+$/);

    const real = await _internal.resolveAlias(UCO, a1);
    assert.equal(real, 'Acme Test Corp');

    const rows = await _internal.applyAliasing(UCO, 'bills', [{ bill_id: 'b1', partner_name: 'Acme Test Corp', amount: 100 }]);
    assert.equal(rows[0].partner_name, a1, 'bills category rows get partner_name aliased');
    assert.equal(rows[0].bill_id, 'b1', 'non-identifier fields pass through unchanged');
  });

  await t.test('aliasing does not apply to non-aliasable categories', async () => {
    const rows = [{ batch_id: 'x', description: 'contains Acme Test Corp in free text' }];
    const out = await _internal.applyAliasing(UCO, 'journal_entries', rows);
    assert.equal(out[0].description, 'contains Acme Test Corp in free text', 'free text is never touched, per §0/§3.4');
  });

  for (const suffix of ['', '.wal']) { try { fs.unlinkSync(dbPath + suffix); } catch { /* already gone */ } }
});
