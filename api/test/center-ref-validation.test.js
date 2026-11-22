'use strict';
/**
 * freeBooks — issue #304: cost/profit center references are validated even
 * when center_derivation_enabled is off. Derivation strictness (auto-derive,
 * require cost→profit linkage) stays gated; "does this resolve to a real,
 * correctly-typed, active center" does not.
 *
 * Black-box over the action API. Run: npm test (in api/).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, sql, seedCompany, testDates } = require('../test-utils/helpers');
const TD = testDates();

let srv;
let baseUrl;
const CO = 'CRV';
const OWNER = 'owner@crv';
let AP, EXP;

before(async () => {
  srv = await startTestServer({ withAdminToken: true });
  baseUrl = srv.baseUrl;
  const seeded = await seedCompany(baseUrl, CO);
  AP = seeded.AP; EXP = seeded.EXP;
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by) VALUES ('${OWNER}', '${CO}', 'owner', now(), 'test')`);
  // Derivation stays OFF (no center_derivation_enabled row). A Cost center
  // without a profit assignment is allowed in that state.
  for (const center of [
    { center_id: 'PC-1', center_type: 'Profit', name: 'Region', is_active: true },
    { center_id: 'CC-1', center_type: 'Cost', name: 'Team', is_active: true },
    { center_id: 'CC-OLD', center_type: 'Cost', name: 'Old team', is_active: false },
  ]) {
    const r = await api(baseUrl, 'center.upsert', { companyId: CO, userEmail: OWNER, center });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
});

after(async () => { await srv.cleanup(); });

function post(centers) {
  return api(baseUrl, 'journal.post', {
    companyId: CO, userEmail: OWNER,
    lines: [
      { account_code: EXP, date: TD.day20, description: 'x', debit: 100, credit: 0, ...centers },
      { account_code: AP, date: TD.day20, description: 'x', debit: 0, credit: 100 },
    ],
  });
}

test('#304 derivation off: valid cost + profit centers post', async () => {
  const r = await post({ cost_center: 'CC-1', profit_center: 'PC-1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('#304 derivation off: unknown cost center is rejected', async () => {
  const r = await post({ cost_center: 'NOPE' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error.message, /Unknown cost center/);
});

test('#304 derivation off: wrong-type references are rejected', async () => {
  let r = await post({ cost_center: 'PC-1' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error.message, /not a Cost center/);
  r = await post({ profit_center: 'CC-1' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error.message, /not a Profit center/);
});

test('#304 derivation off: inactive cost center is rejected', async () => {
  const r = await post({ cost_center: 'CC-OLD' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error.message, /inactive/);
});

test('#304 derivation off: bill.create rejects an unknown line cost center', async () => {
  const r = await api(baseUrl, 'bill.create', {
    companyId: CO, userEmail: OWNER,
    bill: {
      partner_name: 'Acme Pte Ltd', vendor_ref: 'CRV-1', date: TD.day20, due_date: TD.day25,
      currency: 'SGD', ap_account: AP,
      lines: [{ description: 'x', expense_account: EXP, amount: 100, vat_code: '', cost_center: 'NOPE' }],
    },
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error.message, /Unknown cost center/);
});
