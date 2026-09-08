'use strict';
/**
 * freeBooks — Correct & Resubmit contract tests (journal.proposal.correct).
 *
 * A rejected journal_proposal is terminal — never edited, never reposted
 * through itself. The fix is an ordinary journal.post; journal.proposal.correct
 * only runs AFTER that post succeeds, to (a) stamp the audit link
 * (corrected_by_batch_id) back onto the rejected proposal and (b) feed the
 * corrected lines into the same crystallization pipeline journal.approve uses
 * (§3.1), so a human's fix teaches the mapping-suggestion learner exactly
 * like an unedited approval would.
 *
 * Black-box tests over the action API. Run: node --test api/test/journal-proposal-correct.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, sql, seedCompany, testDates } = require('../test-utils/helpers');
const TD = testDates();

let srv;
let baseUrl;
const CO = 'JC';
let AP, EXP, BANK;

before(async () => {
  srv = await startTestServer({ withAdminToken: true });
  baseUrl = srv.baseUrl;
  const seeded = await seedCompany(baseUrl, CO, { jurisdiction: 'SG', currency: 'SGD' });
  AP = seeded.AP;
  EXP = seeded.EXP;
  assert.ok(AP && EXP, 'seed must yield AP + Expense account codes');

  const coa = await api(baseUrl, 'coa.list', { companyId: CO });
  const accounts = coa.body.data || [];
  const bankAcct = accounts.find((a) => a.account_type === 'Asset' && /bank/i.test(a.account_name || ''));
  BANK = bankAcct ? bankAcct.account_code : accounts.find((a) => a.account_type === 'Asset').account_code;
  assert.ok(BANK, 'seed must yield a bank account');

  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@jc', 'JC', 'owner', now(), 'test')`);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('agent@jc', 'JC', 'agent', now(), 'test')`);
});

after(async () => { await srv.cleanup(); });

async function ownerApi(action, payload = {}) {
  return api(baseUrl, action, { companyId: CO, userEmail: 'owner@jc', ...payload });
}
async function agentApi(action, payload = {}) {
  return api(baseUrl, action, { companyId: CO, userEmail: 'agent@jc', ...payload });
}

/** Propose + reject a fresh proposal, returning its proposalId. */
async function proposeAndReject(desc, matchMeta) {
  const propose = await agentApi('journal.propose', {
    lines: [
      { account_code: BANK, debit: 0, credit: 100, date: TD.day15, description: desc },
      { account_code: EXP, debit: 100, credit: 0, date: TD.day15, description: desc },
    ],
    description: desc,
    _match_meta: matchMeta,
  });
  assert.equal(propose.status, 200, `propose failed: ${JSON.stringify(propose.body)}`);
  const proposalId = propose.body.data.proposalId;

  const reject = await ownerApi('journal.reject', { proposalId, note: 'wrong account' });
  assert.equal(reject.status, 200, `reject failed: ${JSON.stringify(reject.body)}`);
  return proposalId;
}

/** Post a plain balanced batch, returning its batchId. */
async function postCorrectionBatch(desc, account = EXP) {
  const post = await ownerApi('journal.post', {
    lines: [
      { account_code: BANK, debit: 0, credit: 100, date: TD.day15, description: desc },
      { account_code: account, debit: 100, credit: 0, date: TD.day15, description: desc },
    ],
  });
  assert.equal(post.status, 200, `post failed: ${JSON.stringify(post.body)}`);
  return post.body.data.batchId;
}

test('journal.proposal.correct: happy path stamps corrected_by_batch_id, proposal stays rejected', async () => {
  const proposalId = await proposeAndReject('CORRECT HAPPY PATH');
  const batchId = await postCorrectionBatch('CORRECT HAPPY PATH (fixed)');

  const r = await ownerApi('journal.proposal.correct', { proposalId, batchId });
  assert.equal(r.status, 200, `correct failed: ${JSON.stringify(r.body)}`);
  assert.deepEqual(r.body.data, { corrected: true, proposalId, batchId });

  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT status, corrected_by_batch_id FROM journal_proposals WHERE company_id='JC' AND proposal_id=?`,
    [proposalId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'rejected', 'the proposal itself is never revised — it stays Rejected for the record');
  assert.equal(rows[0].corrected_by_batch_id, batchId);
});

test('journal.proposal.correct: idempotent retry with the same batchId is a no-op success', async () => {
  const proposalId = await proposeAndReject('CORRECT IDEMPOTENT');
  const batchId = await postCorrectionBatch('CORRECT IDEMPOTENT (fixed)');

  const r1 = await ownerApi('journal.proposal.correct', { proposalId, batchId });
  assert.equal(r1.status, 200);
  const r2 = await ownerApi('journal.proposal.correct', { proposalId, batchId });
  assert.equal(r2.status, 200, `retry failed: ${JSON.stringify(r2.body)}`);
  assert.deepEqual(r2.body.data, { corrected: true, proposalId, batchId });
});

test('journal.proposal.correct: a second, DIFFERENT batchId is rejected', async () => {
  const proposalId = await proposeAndReject('CORRECT DIFFERENT BATCH');
  const batchId1 = await postCorrectionBatch('CORRECT DIFFERENT BATCH (fixed 1)');
  const batchId2 = await postCorrectionBatch('CORRECT DIFFERENT BATCH (fixed 2)');

  const r1 = await ownerApi('journal.proposal.correct', { proposalId, batchId: batchId1 });
  assert.equal(r1.status, 200);

  const r2 = await ownerApi('journal.proposal.correct', { proposalId, batchId: batchId2 });
  assert.equal(r2.status, 409, `expected CONFLICT-shaped rejection, got ${JSON.stringify(r2.body)}`);
  assert.equal(r2.body.error.code, 'INVALID_STATUS');
  assert.match(r2.body.error.message, /already corrected by a different batch/);
});

test('journal.proposal.correct: a still-PROPOSED proposal cannot be corrected', async () => {
  // Needs a real posted batch to get past the batch-existence check first —
  // any batch will do, it's the proposal's own status that must fail here.
  const batchId = await postCorrectionBatch('CORRECT STILL PROPOSED (unrelated batch)');
  const propose = await agentApi('journal.propose', {
    lines: [
      { account_code: BANK, debit: 0, credit: 60, date: TD.day15, description: 'CORRECT STILL PROPOSED' },
      { account_code: EXP, debit: 60, credit: 0, date: TD.day15, description: 'CORRECT STILL PROPOSED' },
    ],
    description: 'CORRECT STILL PROPOSED',
  });
  assert.equal(propose.status, 200);
  const proposalId = propose.body.data.proposalId;

  const r = await ownerApi('journal.proposal.correct', { proposalId, batchId });
  assert.equal(r.status, 409, `expected CONFLICT-shaped rejection, got ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error.code, 'INVALID_STATUS');
  assert.match(r.body.error.message, /only 'rejected' can be corrected/);
});

test('journal.proposal.correct: unknown proposalId is NOT_FOUND', async () => {
  const batchId = await postCorrectionBatch('CORRECT UNKNOWN PROPOSAL');
  const r = await ownerApi('journal.proposal.correct', { proposalId: 'nonexistent-proposal-id', batchId });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'NOT_FOUND');
});

test('journal.proposal.correct: unknown batchId is NOT_FOUND', async () => {
  const proposalId = await proposeAndReject('CORRECT UNKNOWN BATCH');
  const r = await ownerApi('journal.proposal.correct', { proposalId, batchId: 'nonexistent-batch-id' });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'NOT_FOUND');
  assert.match(r.body.error.message, /batch not found/);
});

test('journal.proposal.correct: agent role is FORBIDDEN (data_entry action, not agentWritable)', async () => {
  const proposalId = await proposeAndReject('CORRECT AGENT FORBIDDEN');
  const batchId = await postCorrectionBatch('CORRECT AGENT FORBIDDEN (fixed)');

  const r = await agentApi('journal.proposal.correct', { proposalId, batchId });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'FORBIDDEN');
});

test('journal.proposal.correct: crystallizes a mapping suggestion for a tier-4 correction', async () => {
  const proposalId = await proposeAndReject('CRYSTAL CORRECT VENDOR', {
    tier: 4, source_type: 'llm_semantic', confidence: { account: { value: EXP, confidence: 0.7 } },
  });
  const batchId = await postCorrectionBatch('CRYSTAL CORRECT VENDOR (fixed)');

  const r = await ownerApi('journal.proposal.correct', { proposalId, batchId });
  assert.equal(r.status, 200, `correct failed: ${JSON.stringify(r.body)}`);

  const suggestions = await sql(baseUrl, srv.adminToken,
    `SELECT * FROM mapping_suggestions WHERE company_id='JC' AND source_proposal_id=?`, [proposalId]);
  assert.ok(suggestions.length > 0, 'correcting a tier-4 proposal should crystallize a mapping suggestion');
  assert.equal(suggestions[0].suggested_account, EXP);
  assert.equal(suggestions[0].status, 'proposed');

  await ownerApi('mapping.suggestion.reject', { suggestionId: suggestions[0].suggestion_id });
});

test('journal.proposal.correct: does NOT crystallize for a non-tier-4 correction', async () => {
  const proposalId = await proposeAndReject('NO CRYSTAL CORRECT', {
    tier: 1, source_type: 'learned_rule', confidence: { account: { value: EXP, confidence: 0.95 } },
  });
  const batchId = await postCorrectionBatch('NO CRYSTAL CORRECT (fixed)');

  const r = await ownerApi('journal.proposal.correct', { proposalId, batchId });
  assert.equal(r.status, 200);

  const suggestions = await sql(baseUrl, srv.adminToken,
    `SELECT * FROM mapping_suggestions WHERE company_id='JC' AND source_proposal_id=?`, [proposalId]);
  assert.equal(suggestions.length, 0, 'crystallization should NOT fire for a tier-1 correction');
});
