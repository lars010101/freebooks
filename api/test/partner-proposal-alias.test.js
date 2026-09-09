'use strict';
/**
 * freeBooks — partner.proposal.alias contract tests.
 *
 * The Inbox Partners tab's Duplicate column (2026-09-09) can now resolve a
 * proposal as "the same real-world partner as an existing one" instead of
 * only approve (create new) or reject (discard) — no alias/merge concept
 * existed anywhere in the backend before this. Covers: no duplicate partner
 * row is created, a source bill gets relinked to the existing partner, the
 * proposal's own status/aliased_to_partner_id land correctly, auto-learning
 * crystallizes from the EXISTING partner's account (not the discarded
 * proposal's guess), and the usual not-found/status guards.
 *
 * Black-box tests over the action API. Run: node --test api/test/partner-proposal-alias.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, sql, seedCompany, testDates } = require('../test-utils/helpers');
const TD = testDates();

let srv;
let baseUrl;
const CO = 'PA';
let AP, EXP;

before(async () => {
  srv = await startTestServer({ withAdminToken: true });
  baseUrl = srv.baseUrl;
  const seeded = await seedCompany(baseUrl, CO, { jurisdiction: 'SG', currency: 'SGD' });
  AP = seeded.AP; EXP = seeded.EXP;
  assert.ok(AP && EXP, 'seed must yield AP + Expense account codes');

  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@pa', 'PA', 'owner', now(), 'test')`);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('agent@pa', 'PA', 'agent', now(), 'test')`);
});

after(async () => { await srv.cleanup(); });

async function ownerApi(action, payload = {}) {
  return api(baseUrl, action, { companyId: CO, userEmail: 'owner@pa', ...payload });
}
async function agentApi(action, payload = {}) {
  return api(baseUrl, action, { companyId: CO, userEmail: 'agent@pa', ...payload });
}

async function makeCanonicalPartner(name, overrides = {}) {
  const r = await ownerApi('partner.upsert', {
    partner: { name, is_vendor: true, default_expense_account: EXP, default_ap_account: AP, ...overrides },
  });
  assert.equal(r.status, 200, `partner.upsert failed: ${JSON.stringify(r.body)}`);
  const rows = await sql(baseUrl, srv.adminToken, `SELECT partner_id FROM partners WHERE company_id='PA' AND name=?`, [name]);
  assert.equal(rows.length, 1);
  return rows[0].partner_id;
}

test('partner.propose: a fuzzy hit against an existing partner carries partnerId on duplicate_warning', async () => {
  const canonicalId = await makeCanonicalPartner('Nordwind Logistics AB');
  const r = await agentApi('partner.propose', {
    name: 'Nordwind Logistics A.B.', evidence: { source: 'test' },
    is_vendor: true, default_expense_account: EXP, default_ap_account: AP,
  });
  assert.equal(r.status, 200, `partner.propose failed: ${JSON.stringify(r.body)}`);
  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT duplicate_warning FROM partner_proposals WHERE company_id='PA' AND proposal_id=?`, [r.body.data.proposal_id]);
  assert.equal(rows.length, 1);
  const dw = JSON.parse(rows[0].duplicate_warning);
  assert.equal(dw.kind, 'partner');
  assert.equal(dw.partnerId, canonicalId, 'duplicate_warning must carry the matched partner_id, not just its name');
});

test('partner.proposal.alias: happy path — no new partner created, proposal aliased', async () => {
  const canonicalId = await makeCanonicalPartner('Baltic Freight OU');
  const propose = await agentApi('partner.propose', {
    name: 'Baltic Freight O.U.', evidence: { source: 'test' }, is_vendor: true,
  });
  assert.equal(propose.status, 200, `partner.propose failed: ${JSON.stringify(propose.body)}`);
  const proposalId = propose.body.data.proposal_id;

  const before_ = await sql(baseUrl, srv.adminToken, `SELECT count(*) as c FROM partners WHERE company_id='PA'`);

  const r = await ownerApi('partner.proposal.alias', { proposalId, partnerId: canonicalId });
  assert.equal(r.status, 200, `alias failed: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.data.aliased, true);
  assert.equal(r.body.data.partner_id, canonicalId);

  const after_ = await sql(baseUrl, srv.adminToken, `SELECT count(*) as c FROM partners WHERE company_id='PA'`);
  assert.equal(Number(after_[0].c), Number(before_[0].c), 'no new partner row should be inserted by aliasing');

  const propRows = await sql(baseUrl, srv.adminToken,
    `SELECT status, aliased_to_partner_id, reviewed_by FROM partner_proposals WHERE company_id='PA' AND proposal_id=?`, [proposalId]);
  assert.equal(propRows[0].status, 'aliased');
  assert.equal(propRows[0].aliased_to_partner_id, canonicalId);
  assert.equal(propRows[0].reviewed_by, 'owner@pa');
});

test('partner.proposal.alias: relinks the source bill to the existing partner', async () => {
  const canonicalId = await makeCanonicalPartner('Cedar Supplies Ltd', { default_expense_account: EXP });

  const draft = await ownerApi('bill.draft.save', {
    bill: {
      partner_name: 'Cedar Supplies Ltd.', vendor_ref: 'INV-1', date: TD.day15, due_date: TD.day25,
      amount: 100, currency: 'SGD', expense_account: EXP, ap_account: AP,
      description: 'PA ALIAS BILL RELINK TEST',
    },
  });
  assert.equal(draft.status, 200, `bill.draft.save failed: ${JSON.stringify(draft.body)}`);
  const billId = draft.body.data.bill_id || draft.body.data.billId;
  assert.ok(billId, `expected a bill id in ${JSON.stringify(draft.body)}`);

  const propose = await agentApi('partner.propose', {
    name: 'Cedar Supplies Ltd.', evidence: { source: 'test' }, is_vendor: true,
    source_bill_id: billId,
  });
  assert.equal(propose.status, 200, `partner.propose failed: ${JSON.stringify(propose.body)}`);
  const proposalId = propose.body.data.proposal_id;

  const r = await ownerApi('partner.proposal.alias', { proposalId, partnerId: canonicalId });
  assert.equal(r.status, 200, `alias failed: ${JSON.stringify(r.body)}`);

  const billRows = await sql(baseUrl, srv.adminToken, `SELECT partner_id, partner_name FROM bills WHERE company_id='PA' AND bill_id=?`, [billId]);
  assert.equal(billRows.length, 1);
  assert.equal(billRows[0].partner_id, canonicalId, 'bill.partner_id must be relinked to the existing (canonical) partner');
  assert.equal(billRows[0].partner_name, 'Cedar Supplies Ltd', 'bill.partner_name should sync to the canonical partner name too');
});

test('partner.proposal.alias: auto-learns a mapping suggestion from the EXISTING partner\'s account, not the proposal\'s own guess', async () => {
  const canonicalId = await makeCanonicalPartner('Fenwick Marine AS', { default_expense_account: EXP });

  const jp = await agentApi('journal.propose', {
    lines: [
      { account_code: AP, debit: 0, credit: 10, date: TD.day15, description: 'PA ALIAS LEARN TEST' },
      { account_code: EXP, debit: 10, credit: 0, date: TD.day15, description: 'PA ALIAS LEARN TEST' },
    ],
    description: 'PA ALIAS LEARN TEST',
  });
  assert.equal(jp.status, 200, `journal.propose (source) failed: ${JSON.stringify(jp.body)}`);

  // Propose with a DIFFERENT guessed account than the canonical partner's own
  // (EXP) so a passing assertion below can't be an accident of them matching.
  const coa = await ownerApi('coa.list', {});
  const accounts = coa.body.data || [];
  const altExp = accounts.find((a) => a.account_type === 'Expense' && a.account_code !== EXP);
  assert.ok(altExp, 'seed COA must have a second Expense account to diverge from');

  const propose = await agentApi('partner.propose', {
    name: 'Fenwick Marine A.S.', evidence: { source: 'test' }, is_vendor: true,
    default_expense_account: altExp.account_code,
    source_proposal_id: jp.body.data.proposalId,
  });
  assert.equal(propose.status, 200, `partner.propose failed: ${JSON.stringify(propose.body)}`);
  const proposalId = propose.body.data.proposal_id;

  const r = await ownerApi('partner.proposal.alias', { proposalId, partnerId: canonicalId });
  assert.equal(r.status, 200, `alias failed: ${JSON.stringify(r.body)}`);

  const suggestions = await sql(baseUrl, srv.adminToken,
    `SELECT suggested_account FROM mapping_suggestions WHERE company_id='PA' AND UPPER(description_pattern)=UPPER('PA ALIAS LEARN TEST')`);
  assert.equal(suggestions.length, 1, 'auto-learn should crystallize a mapping suggestion from the alias');
  assert.equal(suggestions[0].suggested_account, EXP, 'must teach the EXISTING partner\'s own account, not the discarded proposal\'s guessed one');
});

test('partner.proposal.alias: unknown proposalId is NOT_FOUND', async () => {
  const canonicalId = await makeCanonicalPartner('Solstice Rentals BV');
  const r = await ownerApi('partner.proposal.alias', { proposalId: 'nope-nope-nope', partnerId: canonicalId });
  assert.equal(r.status, 404, `expected NOT_FOUND, got ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error.code, 'NOT_FOUND');
});

test('partner.proposal.alias: unknown partnerId is NOT_FOUND, proposal left untouched', async () => {
  const propose = await agentApi('partner.propose', { name: 'Unrelated New Vendor Co', evidence: { source: 'test' }, is_vendor: true });
  const proposalId = propose.body.data.proposal_id;
  const r = await ownerApi('partner.proposal.alias', { proposalId, partnerId: 'no-such-partner-id' });
  assert.equal(r.status, 404, `expected NOT_FOUND, got ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error.code, 'NOT_FOUND');

  const rows = await sql(baseUrl, srv.adminToken, `SELECT status FROM partner_proposals WHERE company_id='PA' AND proposal_id=?`, [proposalId]);
  assert.equal(rows[0].status, 'proposed', 'a failed alias attempt must not change the proposal status');
});

test('partner.proposal.alias: a non-proposed proposal cannot be aliased', async () => {
  const canonicalId = await makeCanonicalPartner('Harborlight Freight AS');
  const propose = await agentApi('partner.propose', { name: 'Already Rejected Co', evidence: { source: 'test' }, is_vendor: true });
  const proposalId = propose.body.data.proposal_id;
  const rej = await ownerApi('partner.proposal.reject', { proposalId });
  assert.equal(rej.status, 200);

  const r = await ownerApi('partner.proposal.alias', { proposalId, partnerId: canonicalId });
  assert.equal(r.status, 409, `expected INVALID_STATUS, got ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error.code, 'INVALID_STATUS');
});

test('partner.proposal.alias: proposalId and partnerId are both required', async () => {
  const canonicalId = await makeCanonicalPartner('Requires Both Fields Co');
  const r1 = await ownerApi('partner.proposal.alias', { partnerId: canonicalId });
  assert.equal(r1.status, 400);
  assert.equal(r1.body.error.code, 'INVALID_INPUT');

  const propose = await agentApi('partner.propose', { name: 'Needs Partner Id Co', evidence: { source: 'test' }, is_vendor: true });
  const r2 = await ownerApi('partner.proposal.alias', { proposalId: propose.body.data.proposal_id });
  assert.equal(r2.status, 400);
  assert.equal(r2.body.error.code, 'INVALID_INPUT');
});

test('partner.proposal.alias: agent role is FORBIDDEN (data_entry action, same floor as approve/reject)', async () => {
  const canonicalId = await makeCanonicalPartner('Agent Forbidden Co');
  const propose = await agentApi('partner.propose', { name: 'Agent Forbidden Duplicate Co', evidence: { source: 'test' }, is_vendor: true });
  const r = await agentApi('partner.proposal.alias', { proposalId: propose.body.data.proposal_id, partnerId: canonicalId });
  assert.equal(r.status, 403, `expected FORBIDDEN, got ${JSON.stringify(r.body)}`);
});
