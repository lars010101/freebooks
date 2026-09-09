'use strict';
/**
 * freeBooks — partner.proposal.approve override-fields contract tests.
 *
 * The Inbox Partners tab (2026-09-09 follow-up) edits Vendor/Customer/
 * Exp account/AP account/Tax code directly on the row before approving —
 * previously partner.proposal.approve only ever took `proposalId` and
 * inserted the agent-proposed values verbatim, with no way for a reviewer
 * to correct them. Every override field is optional; omitting it (any
 * existing caller — a script, an MCP tool, a bare curl) must behave
 * exactly as before.
 *
 * Black-box tests over the action API. Run: node --test api/test/partner-proposal-approve-overrides.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, sql, seedCompany, testDates } = require('../test-utils/helpers');
const TD = testDates();

let srv;
let baseUrl;
const CO = 'PO';
let AP, EXP;

before(async () => {
  srv = await startTestServer({ withAdminToken: true });
  baseUrl = srv.baseUrl;
  const seeded = await seedCompany(baseUrl, CO, { jurisdiction: 'SG', currency: 'SGD' });
  AP = seeded.AP; EXP = seeded.EXP;
  assert.ok(AP && EXP, 'seed must yield AP + Expense account codes');

  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@po', 'PO', 'owner', now(), 'test')`);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('agent@po', 'PO', 'agent', now(), 'test')`);
});

after(async () => { await srv.cleanup(); });

async function ownerApi(action, payload = {}) {
  return api(baseUrl, action, { companyId: CO, userEmail: 'owner@po', ...payload });
}
async function agentApi(action, payload = {}) {
  return api(baseUrl, action, { companyId: CO, userEmail: 'agent@po', ...payload });
}

async function proposePartner(name, overrides = {}) {
  const r = await agentApi('partner.propose', {
    name, evidence: { source: 'test' },
    is_vendor: true, is_customer: false,
    default_expense_account: EXP, default_ap_account: AP,
    ...overrides,
  });
  assert.equal(r.status, 200, `partner.propose failed: ${JSON.stringify(r.body)}`);
  return r.body.data.proposal_id;
}

test('partner.proposal.approve: no overrides — approve is unedited (existing behavior unchanged)', async () => {
  const proposalId = await proposePartner('Unedited Partner Co');
  const r = await ownerApi('partner.proposal.approve', { proposalId });
  assert.equal(r.status, 200, `approve failed: ${JSON.stringify(r.body)}`);

  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT is_vendor, is_customer, default_expense_account, default_ap_account FROM partners WHERE company_id='PO' AND name='Unedited Partner Co'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].is_vendor, true);
  assert.equal(rows[0].is_customer, false);
  assert.equal(rows[0].default_expense_account, EXP);
  assert.equal(rows[0].default_ap_account, AP);
});

test('partner.proposal.approve: isCustomer override lands on the created partner', async () => {
  const proposalId = await proposePartner('Toggle Customer Co');
  const r = await ownerApi('partner.proposal.approve', { proposalId, isCustomer: true });
  assert.equal(r.status, 200, `approve failed: ${JSON.stringify(r.body)}`);

  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT is_customer FROM partners WHERE company_id='PO' AND name='Toggle Customer Co'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].is_customer, true, 'the override must win over the agent-proposed is_customer=false');
});

test('partner.proposal.approve: isVendor=false override lands (a reviewer can un-flag vendor too)', async () => {
  const proposalId = await proposePartner('Untoggle Vendor Co');
  const r = await ownerApi('partner.proposal.approve', { proposalId, isVendor: false, isCustomer: true });
  assert.equal(r.status, 200, `approve failed: ${JSON.stringify(r.body)}`);

  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT is_vendor, is_customer FROM partners WHERE company_id='PO' AND name='Untoggle Vendor Co'`);
  assert.equal(rows[0].is_vendor, false);
  assert.equal(rows[0].is_customer, true);
});

test('partner.proposal.approve: defaultExpenseAccount/defaultApAccount overrides land verbatim', async () => {
  // Seed a second pair of real accounts to override to (distinct from the
  // agent-proposed EXP/AP) so a passing test can't be an accident of them
  // already matching.
  const coa2 = await ownerApi('coa.list', {});
  const accounts = coa2.body.data || [];
  const altExp = accounts.find((a) => a.account_type === 'Expense' && a.account_code !== EXP);
  const altAp = accounts.find((a) => a.account_type === 'Liability' && /payable/i.test(a.account_name || '') && a.account_code !== AP);
  assert.ok(altExp, 'seed COA must have a second Expense account to override to');

  const proposalId = await proposePartner('Override Accounts Co');
  const overrideAp = altAp ? altAp.account_code : AP;
  const r = await ownerApi('partner.proposal.approve', {
    proposalId, defaultExpenseAccount: altExp.account_code, defaultApAccount: overrideAp,
  });
  assert.equal(r.status, 200, `approve failed: ${JSON.stringify(r.body)}`);

  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT default_expense_account, default_ap_account FROM partners WHERE company_id='PO' AND name='Override Accounts Co'`);
  assert.equal(rows[0].default_expense_account, altExp.account_code);
  assert.equal(rows[0].default_ap_account, overrideAp);
});

test('partner.proposal.approve: an invalid overridden account code is rejected (same COA validation as before)', async () => {
  const proposalId = await proposePartner('Bad Override Account Co');
  const r = await ownerApi('partner.proposal.approve', { proposalId, defaultExpenseAccount: 'NONEXISTENT-CODE' });
  assert.equal(r.status, 400, `expected INVALID_ACCOUNT, got ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error.code, 'INVALID_ACCOUNT');

  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT count(*) as c FROM partners WHERE company_id='PO' AND name='Bad Override Account Co'`);
  assert.equal(Number(rows[0].c), 0, 'no partner should be created when the overridden account is invalid');
});

test('partner.proposal.approve: suggestedVatCode override feeds the auto-learn mapping suggestion, not the overridden default', async () => {
  // Auto-learn only fires when the proposal carries source_proposal_id — seed
  // a journal proposal to be the source, matching how a real partner
  // proposal born from a bill/journal review would be linked.
  const jp = await agentApi('journal.propose', {
    lines: [
      { account_code: AP, debit: 0, credit: 10, date: TD.day15, description: 'PO OVERRIDE VAT LEARN TEST' },
      { account_code: EXP, debit: 10, credit: 0, date: TD.day15, description: 'PO OVERRIDE VAT LEARN TEST' },
    ],
    description: 'PO OVERRIDE VAT LEARN TEST',
  });
  assert.equal(jp.status, 200, `journal.propose (source) failed: ${JSON.stringify(jp.body)}`);

  const proposalId = await proposePartner('VAT Override Learn Co', {
    source_proposal_id: jp.body.data.proposalId,
    suggested_vat_code: 'PROPOSED-CODE',
  });
  const r = await ownerApi('partner.proposal.approve', { proposalId, suggestedVatCode: 'OVERRIDDEN-CODE' });
  assert.equal(r.status, 200, `approve failed: ${JSON.stringify(r.body)}`);

  const suggestions = await sql(baseUrl, srv.adminToken,
    `SELECT suggested_vat_code FROM mapping_suggestions WHERE company_id='PO' AND UPPER(description_pattern)=UPPER('PO OVERRIDE VAT LEARN TEST')`);
  assert.equal(suggestions.length, 1, 'auto-learn should crystallize a mapping suggestion from the source proposal');
  assert.equal(suggestions[0].suggested_vat_code, 'OVERRIDDEN-CODE', 'the auto-learn suggestion should teach the OVERRIDDEN vat code, not the originally-proposed one');
});

test('partner.proposal.approve: an existing caller that sends no override fields at all is unaffected (backward compatibility)', async () => {
  const proposalId = await proposePartner('Legacy Caller Co', { is_vendor: false, is_customer: true });
  // Exactly the old call shape — proposalId only.
  const r = await api(baseUrl, 'partner.proposal.approve', { companyId: CO, userEmail: 'owner@po', proposalId });
  assert.equal(r.status, 200, `approve failed: ${JSON.stringify(r.body)}`);

  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT is_vendor, is_customer FROM partners WHERE company_id='PO' AND name='Legacy Caller Co'`);
  assert.equal(rows[0].is_vendor, false);
  assert.equal(rows[0].is_customer, true);
});
