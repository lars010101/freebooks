'use strict';
/**
 * freeBooks — VAT codes upsert contract tests.
 *
 * Covers the vat.codes.upsert action's INSERT and UPDATE paths.
 * Regression guard for the bug where upsertVatCode wrote to
 * non-existent columns (input_account/output_account) instead of
 * the schema-defined vat_account_input/vat_account_output.
 *
 * Black-box over the action API (HTTP against a throwaway server + DuckDB),
 * same harness as test/contract.test.js. Run: npm test (in api/).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, sql, seedCompany } = require('../test-utils/helpers');

let srv;
let baseUrl;
const CO = 'VU';

before(async () => {
  srv = await startTestServer({ withAdminToken: true });
  baseUrl = srv.baseUrl;
  await seedCompany(baseUrl, CO);
  // grant a test user owner rights (bootstrap via admin SQL, not under test)
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@vu', 'VU', 'owner', now(), 'test')`);
});

after(async () => { await srv.cleanup(); });

// ── 1. INSERT path ───────────────────────────────────────────────────────────

test('vat.codes.upsert INSERT: new code lands in vat_codes with correct columns', async () => {
  const r = await api(baseUrl, 'vat.codes.upsert', {
    companyId: CO,
    vatCode: {
      vat_code: 'T15',
      description: 'Test 15%',
      rate: 0.15,
      input_account: '2641',
      output_account: '2611',
      report_box: null,
      is_reverse_charge: false,
      is_active: true,
    },
  });
  assert.equal(r.status, 200, `upsert failed: ${JSON.stringify(r.body)}`);

  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT * FROM vat_codes WHERE company_id='VU' AND vat_code='T15'`);
  assert.equal(rows.length, 1, `expected 1 row, got ${rows.length}`);
  const vc = rows[0];
  assert.equal(vc.vat_account_input, '2641', 'vat_account_input stored correctly');
  assert.equal(vc.vat_account_output, '2611', 'vat_account_output stored correctly');
  assert.equal(vc.description, 'Test 15%', 'description stored correctly');
  assert.equal(Number(vc.rate), 0.15, 'rate stored correctly');
});

// ── 2. UPDATE path ───────────────────────────────────────────────────────────

test('vat.codes.upsert UPDATE: existing code updated with correct columns', async () => {
  const r = await api(baseUrl, 'vat.codes.upsert', {
    companyId: CO,
    vatCode: {
      vat_code: 'T15',
      description: 'Updated 15%',
      rate: 0.15,
      input_account: '2642',
      output_account: '2611',
      report_box: null,
      is_reverse_charge: false,
      is_active: true,
    },
  });
  assert.equal(r.status, 200, `upsert update failed: ${JSON.stringify(r.body)}`);

  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT * FROM vat_codes WHERE company_id='VU' AND vat_code='T15'`);
  assert.equal(rows.length, 1, `expected 1 row after update, got ${rows.length}`);
  const vc = rows[0];
  assert.equal(vc.description, 'Updated 15%', 'description updated');
  assert.equal(vc.vat_account_input, '2642', 'vat_account_input updated correctly');
  assert.equal(vc.vat_account_output, '2611', 'vat_account_output unchanged');
});
