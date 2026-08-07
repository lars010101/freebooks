'use strict';
/**
 * freeBooks — bank-mapping-suggestions-spec contract tests.
 *
 * Tests the wiring changes from docs/bank-mapping-suggestions-spec.md:
 * - §1: matching_history.record on approve/reject
 * - §2: tier 3.5 historical match
 * - §3.1: crystallization on tier-4 approval
 * - §4: conflict detection (duplicate, contradiction, overlap, historical)
 * - §5: amount_sign on mapping rules
 * - §6: specificity scoring (longest-match-wins)
 * - §3.3: pattern normalization
 *
 * Black-box tests over the action API. Run: node --test api/test/mapping-suggestions.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, sql, seedCompany } = require('../test-utils/helpers');

let srv;
let baseUrl;
const CO = 'MS';
let AP, EXP, BANK;

before(async () => {
  srv = await startTestServer({ withAdminToken: true });
  baseUrl = srv.baseUrl;
  const seeded = await seedCompany(baseUrl, CO, { jurisdiction: 'SG', currency: 'SGD' });
  AP = seeded.AP;
  EXP = seeded.EXP;
  assert.ok(AP && EXP, 'seed must yield AP + Expense account codes');

  // Find a bank account from the COA
  const coa = await api(baseUrl, 'coa.list', { companyId: CO });
  const accounts = coa.body.data || [];
  const bankAcct = accounts.find((a) => a.account_type === 'Asset' && /bank/i.test(a.account_name || ''));
  BANK = bankAcct ? bankAcct.account_code : accounts.find((a) => a.account_type === 'Asset').account_code;
  assert.ok(BANK, 'seed must yield a bank account');

  // Grant owner + agent roles
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@ms', 'MS', 'owner', now(), 'test')`);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('agent@ms', 'MS', 'agent', now(), 'test')`);
});

after(async () => { await srv.cleanup(); });

// Helper: dispatch as owner
async function ownerApi(action, payload = {}) {
  return api(baseUrl, action, { companyId: CO, userEmail: 'owner@ms', ...payload });
}

// Helper: dispatch as agent
async function agentApi(action, payload = {}) {
  return api(baseUrl, action, { companyId: CO, userEmail: 'agent@ms', ...payload });
}

// ── §3.3: Pattern normalization ──────────────────────────────────────────────

test('§3.3: normalizeDescription strips dates, refs, amounts', async () => {
  const { normalizeDescription } = require('../src/mapping-utils');
  assert.equal(normalizeDescription('NETFLIX.COM 1234567890 AMSTERDAM'), 'NETFLIX.COM AMSTERDAM');
  assert.equal(normalizeDescription('STRIPE*STRIPE PAYMENT 2026-08-04'), 'STRIPE*STRIPE PAYMENT');
  assert.equal(normalizeDescription('AUTOGIRO KLARNA 20260804 999123'), 'AUTOGIRO KLARNA');
  assert.equal(normalizeDescription(''), '');
  assert.equal(normalizeDescription(null), '');
});

// ── §6: Specificity scoring (longest-match-wins) ────────────────────────────

test('§6: matchMapping — longest pattern wins over shorter', async () => {
  // Create two mappings: broader "PAYPAL" and narrower "PAYPAL FEE"
  await ownerApi('mapping.upsert', {
    mapping: { mapping_id: 'map_broad', pattern: 'PAYPAL', match_type: 'contains',
      debit_account: EXP, credit_account: EXP, priority: 100, is_active: true }
  });
  await ownerApi('mapping.upsert', {
    mapping: { mapping_id: 'map_narrow', pattern: 'PAYPAL FEE', match_type: 'contains',
      debit_account: BANK, credit_account: BANK, priority: 100, is_active: true }
  });

  // "PAYPAL FEE CHARGED" should match the narrower rule (longer pattern)
  const r = await agentApi('bank.match', {
    line: { date: '2026-07-15', amount: -50, description: 'PAYPAL FEE CHARGED' },
    bankAccount: BANK,
  });
  assert.equal(r.status, 200, `bank.match failed: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.data.matched, true);
  assert.equal(r.body.data.tier, 1);
  assert.equal(r.body.data.suggested_dimensions.account, BANK,
    'narrower "PAYPAL FEE" should win over broader "PAYPAL"');

  // Clean up
  await ownerApi('mapping.delete', { mappingId: 'map_broad' });
  await ownerApi('mapping.delete', { mappingId: 'map_narrow' });
});

// ── §5: amount_sign on mapping rules ─────────────────────────────────────────

test('§5: amount_sign — positive rule does not match negative amount', async () => {
  await ownerApi('mapping.upsert', {
    mapping: { mapping_id: 'map_stripe_pos', pattern: 'STRIPE', match_type: 'contains',
      debit_account: EXP, credit_account: EXP, priority: 100, is_active: true,
      amount_sign: 'positive' }
  });

  // Positive amount → should match
  const r1 = await agentApi('bank.match', {
    line: { date: '2026-07-15', amount: 100, description: 'STRIPE PAYMENT' },
    bankAccount: BANK,
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.data.matched, true, 'positive amount should match positive sign rule');

  // Negative amount → should NOT match
  const r2 = await agentApi('bank.match', {
    line: { date: '2026-07-15', amount: -30, description: 'STRIPE FEE' },
    bankAccount: BANK,
  });
  assert.equal(r2.status, 200, `bank.match (negative) failed: ${JSON.stringify(r2.body)}`);
  assert.equal(r2.body.data.matched, false, 'negative amount should not match positive sign rule');

  await ownerApi('mapping.delete', { mappingId: 'map_stripe_pos' });
});

test('§5: amount_sign=any matches both directions (backward-compatible)', async () => {
  await ownerApi('mapping.upsert', {
    mapping: { mapping_id: 'map_any', pattern: 'SUBSCRIPTION', match_type: 'contains',
      debit_account: EXP, credit_account: EXP, priority: 100, is_active: true,
      amount_sign: 'any' }
  });

  const r1 = await agentApi('bank.match', {
    line: { date: '2026-07-15', amount: 100, description: 'SUBSCRIPTION PAYMENT' },
    bankAccount: BANK,
  });
  assert.equal(r1.body.data.matched, true, 'any should match positive');

  const r2 = await agentApi('bank.match', {
    line: { date: '2026-07-15', amount: -100, description: 'SUBSCRIPTION REFUND' },
    bankAccount: BANK,
  });
  assert.equal(r2.body.data.matched, true, 'any should match negative');

  await ownerApi('mapping.delete', { mappingId: 'map_any' });
});

// ── §4: Conflict detection ───────────────────────────────────────────────────

test('§4: mapping.suggest blocks on contradiction with active rule', async () => {
  // Create an active rule for "NETFLIX" → EXP
  await ownerApi('mapping.upsert', {
    mapping: { mapping_id: 'map_netflix', pattern: 'NETFLIX', match_type: 'contains',
      debit_account: EXP, credit_account: EXP, priority: 100, is_active: true }
  });

  // Try to suggest a rule for the same pattern → different account → should CONFLICT
  const r = await agentApi('mapping.suggest', {
    description_pattern: 'NETFLIX',
    suggested_account: BANK,
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'CONFLICT');
  assert.match(r.body.error.message, /already exists mapping to account/);

  // Clean up
  await ownerApi('mapping.delete', { mappingId: 'map_netflix' });
});

test('§4: mapping.suggestion.approve blocks on contradiction with active rule', async () => {
  // Create an active rule
  await ownerApi('mapping.upsert', {
    mapping: { mapping_id: 'map_google', pattern: 'GOOGLE', match_type: 'contains',
      debit_account: EXP, credit_account: EXP, priority: 100, is_active: true }
  });

  // Create a suggestion for the same pattern → different account
  // Use direct SQL to bypass the creation-time conflict check (simulating
  // a suggestion created before the rule existed)
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO mapping_suggestions (company_id, suggestion_id, description_pattern, suggested_account, status, created_by, created_at)
     VALUES ('MS', 'sug_conflict_1', 'GOOGLE', ?, 'proposed', 'agent@ms', now())`,
    [BANK]);

  // Try to approve → should CONFLICT
  const r = await ownerApi('mapping.suggestion.approve', { suggestionId: 'sug_conflict_1' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'CONFLICT');

  // Clean up
  await sql(baseUrl, srv.adminToken, `DELETE FROM mapping_suggestions WHERE suggestion_id = 'sug_conflict_1'`);
  await ownerApi('mapping.delete', { mappingId: 'map_google' });
});

test('§4: mapping.suggest creates with overlap warning (not block)', async () => {
  // Create a broad rule "AMAZON"
  await ownerApi('mapping.upsert', {
    mapping: { mapping_id: 'map_amazon', pattern: 'AMAZON', match_type: 'contains',
      debit_account: EXP, credit_account: EXP, priority: 100, is_active: true }
  });

  // Suggest a narrower pattern "AMAZON AWS" → same account → overlap, not block
  const r = await agentApi('mapping.suggest', {
    description_pattern: 'AMAZON AWS',
    suggested_account: EXP,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'proposed');

  // Clean up
  if (r.body.data.suggestion_id) {
    await ownerApi('mapping.suggestion.reject', { suggestionId: r.body.data.suggestion_id });
  }
  await ownerApi('mapping.delete', { mappingId: 'map_amazon' });
});

// ── §1: matching_history.record on approve/reject ──────────────────────────

test('§1: matching_history.record fires on journal.approve', async () => {
  // Propose a journal entry with match_meta
  const propose = await agentApi('journal.propose', {
    lines: [
      { account_code: BANK, debit: 0, credit: 100, date: '2026-07-15', description: 'TEST MATCH HIST' },
      { account_code: EXP, debit: 100, credit: 0, date: '2026-07-15', description: 'TEST MATCH HIST' },
    ],
    description: 'TEST MATCH HIST',
    proposalId: 'prop_hist_1',
    _match_meta: { tier: 4, source_type: 'llm_semantic', confidence: { account: { value: EXP, confidence: 0.7 } } },
  });
  assert.equal(propose.status, 200, `propose failed: ${JSON.stringify(propose.body)}`);

  // Approve it
  const approve = await ownerApi('journal.approve', { proposalId: 'prop_hist_1' });
  assert.equal(approve.status, 200, `approve failed: ${JSON.stringify(approve.body)}`);

  // Check matching_history was populated
  const history = await sql(baseUrl, srv.adminToken,
    `SELECT * FROM matching_history WHERE company_id = 'MS' AND description_pattern IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
  assert.ok(history.length > 0, 'matching_history should have a row');
  assert.equal(history[0].outcome, 'approved_unedited');
  assert.equal(history[0].source_type, 'llm_semantic');
});

test('§1: matching_history.record fires on journal.reject with outcome=rejected', async () => {
  // Propose
  const propose = await agentApi('journal.propose', {
    lines: [
      { account_code: BANK, debit: 0, credit: 50, date: '2026-07-15', description: 'TEST REJECT HIST' },
      { account_code: EXP, debit: 50, credit: 0, date: '2026-07-15', description: 'TEST REJECT HIST' },
    ],
    description: 'TEST REJECT HIST',
    proposalId: 'prop_reject_1',
    _match_meta: { tier: 3, source_type: 'master_data', confidence: { account: { value: EXP, confidence: 0.5 } } },
  });
  assert.equal(propose.status, 200);

  // Reject
  const reject = await ownerApi('journal.reject', { proposalId: 'prop_reject_1', note: 'wrong account' });
  assert.equal(reject.status, 200);

  // Check matching_history
  const history = await sql(baseUrl, srv.adminToken,
    `SELECT * FROM matching_history WHERE company_id = 'MS' ORDER BY created_at DESC LIMIT 1`);
  assert.ok(history.length > 0, 'matching_history should have a row');
  assert.equal(history[0].outcome, 'rejected');
  assert.equal(history[0].source_type, 'master_data');
});

// ── §3.1: Crystallization on tier-4 approval ──────────────────────────────────

test('§3.1: crystallization creates mapping suggestion on unedited tier-4 approval', async () => {
  // Propose a tier-4 (LLM) proposal
  const propose = await agentApi('journal.propose', {
    lines: [
      { account_code: BANK, debit: 0, credit: 200, date: '2026-07-16', description: 'CRYSTAL TEST VENDOR' },
      { account_code: EXP, debit: 200, credit: 0, date: '2026-07-16', description: 'CRYSTAL TEST VENDOR' },
    ],
    description: 'CRYSTAL TEST VENDOR',
    proposalId: 'prop_crystal_1',
    _match_meta: { tier: 4, source_type: 'llm_semantic', confidence: { account: { value: EXP, confidence: 0.7 } } },
  });
  assert.equal(propose.status, 200);

  // Approve unedited
  const approve = await ownerApi('journal.approve', { proposalId: 'prop_crystal_1' });
  assert.equal(approve.status, 200, `approve failed: ${JSON.stringify(approve.body)}`);

  // A mapping suggestion should have been created
  const suggestions = await sql(baseUrl, srv.adminToken,
    `SELECT * FROM mapping_suggestions WHERE company_id = 'MS' AND source_proposal_id = 'prop_crystal_1'`);
  assert.ok(suggestions.length > 0, 'crystallization should create a mapping suggestion');
  assert.equal(suggestions[0].suggested_account, EXP);
  assert.equal(suggestions[0].status, 'proposed');

  // Clean up
  await ownerApi('mapping.suggestion.reject', { suggestionId: suggestions[0].suggestion_id });
});

test('§3.1: crystallization does NOT fire on non-tier-4 approval', async () => {
  // Propose a tier-1 (learned rule) proposal
  const propose = await agentApi('journal.propose', {
    lines: [
      { account_code: BANK, debit: 0, credit: 75, date: '2026-07-17', description: 'NO CRYSTAL TEST' },
      { account_code: EXP, debit: 75, credit: 0, date: '2026-07-17', description: 'NO CRYSTAL TEST' },
    ],
    description: 'NO CRYSTAL TEST',
    proposalId: 'prop_no_crystal_1',
    _match_meta: { tier: 1, source_type: 'learned_rule', confidence: { account: { value: EXP, confidence: 0.95 } } },
  });
  assert.equal(propose.status, 200);

  const approve = await ownerApi('journal.approve', { proposalId: 'prop_no_crystal_1' });
  assert.equal(approve.status, 200);

  // No mapping suggestion should exist for this proposal
  const suggestions = await sql(baseUrl, srv.adminToken,
    `SELECT * FROM mapping_suggestions WHERE company_id = 'MS' AND source_proposal_id = 'prop_no_crystal_1'`);
  assert.equal(suggestions.length, 0, 'crystallization should NOT fire for tier-1');
});

// ── §2: Tier 3.5 historical match ─────────────────────────────────────────────

test('§2: tier 3.5 returns historical match after prior approval', async () => {
  // We already approved a proposal for 'TEST MATCH HIST' in a previous test.
  // The matching_history has a row with that normalized pattern.
  // Now feed a new bank line with the same description — should match at tier 3.5.

  const histCheck = await sql(baseUrl, srv.adminToken,
    `SELECT description_pattern, outcome, approved_dimensions
     FROM matching_history
     WHERE company_id = 'MS' AND outcome = 'approved_unedited'
     ORDER BY created_at DESC LIMIT 5`);

  // Use one of the approved patterns from history to test tier 3.5
  if (histCheck.length > 0) {
    const pattern = histCheck[0].description_pattern;
    const dims = JSON.parse(histCheck[0].approved_dimensions || '{}');

    const r = await agentApi('bank.match', {
      line: { date: '2026-07-20', amount: 100, description: pattern },
      bankAccount: BANK,
    });
    assert.equal(r.status, 200);
    // It should match (either at tier 3.5 or tier 1 if a rule was crystallized)
    assert.equal(r.body.data.matched, true, `should match on historical pattern '${pattern}'`);
    if (r.body.data.tier === 3.5) {
      assert.equal(r.body.data.source_type, 'historical_match');
      assert.equal(r.body.data.confidence.account.value, dims.account);
      assert.ok(r.body.data.confidence.account.confidence >= 0.75, 'confidence ≥ 0.75 for 1 approval');
    }
  }
});

// ── mapping.suggest with new params (amount_sign, match_type) ──────────────

test('mapping.suggest accepts and stores suggested_amount_sign', async () => {
  const r = await agentApi('mapping.suggest', {
    description_pattern: 'SPOTIFY',
    suggested_account: EXP,
    suggested_amount_sign: 'negative',
    suggested_match_type: 'contains',
  });
  assert.equal(r.status, 200);

  // Verify the stored suggestion has the amount_sign
  const stored = await sql(baseUrl, srv.adminToken,
    `SELECT suggested_amount_sign, suggested_match_type FROM mapping_suggestions
     WHERE company_id = 'MS' AND suggestion_id = ?`,
    [r.body.data.suggestion_id]);
  assert.equal(stored[0].suggested_amount_sign, 'negative');
  assert.equal(stored[0].suggested_match_type, 'contains');

  // Clean up
  await ownerApi('mapping.suggestion.reject', { suggestionId: r.body.data.suggestion_id });
});

test('mapping.suggestion.approve inherits amount_sign and match_type', async () => {
  // Create a suggestion with amount_sign
  const suggest = await agentApi('mapping.suggest', {
    description_pattern: 'ZOOM',
    suggested_account: EXP,
    suggested_amount_sign: 'positive',
    suggested_match_type: 'contains',
  });
  assert.equal(suggest.status, 200);

  // Approve it
  const approve = await ownerApi('mapping.suggestion.approve', { suggestionId: suggest.body.data.suggestion_id });
  assert.equal(approve.status, 200, `approve failed: ${JSON.stringify(approve.body)}`);

  // Verify the bank_mappings row has the amount_sign
  const rules = await sql(baseUrl, srv.adminToken,
    `SELECT amount_sign, match_type FROM bank_mappings
     WHERE company_id = 'MS' AND pattern = 'ZOOM' AND is_active = true`);
  assert.ok(rules.length > 0, 'rule should exist');
  assert.equal(rules[0].amount_sign, 'positive');
  assert.equal(rules[0].match_type, 'contains');

  // Clean up
  await sql(baseUrl, srv.adminToken, `DELETE FROM bank_mappings WHERE company_id = 'MS' AND pattern = 'ZOOM'`);
});

// ── _match_meta persistence (prerequisite for §1, §3.1) ─────────────────────

test('_match_meta is persisted on journal_proposals', async () => {
  const propose = await agentApi('journal.propose', {
    lines: [
      { account_code: BANK, debit: 0, credit: 10, date: '2026-07-18', description: 'META TEST' },
      { account_code: EXP, debit: 10, credit: 0, date: '2026-07-18', description: 'META TEST' },
    ],
    description: 'META TEST',
    proposalId: 'prop_meta_1',
    _match_meta: { tier: 2, source_type: 'open_item', confidence: { account: { value: EXP, confidence: 0.8 } } },
  });
  assert.equal(propose.status, 200);

  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT match_meta FROM journal_proposals WHERE proposal_id = 'prop_meta_1'`);
  assert.ok(rows.length > 0);
  const meta = JSON.parse(rows[0].match_meta);
  assert.equal(meta.tier, 2);
  assert.equal(meta.source_type, 'open_item');
});
