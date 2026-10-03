'use strict';
/**
 * freeBooks — Inbox bill-draft stated-VAT warning.
 *
 * Bill drafts in the Inbox review queue carry a ⚠ when the supplier-stated
 * VAT (bills.vat_amount / draft_lines.vatAmountsStated) differs from the
 * computed VAT by more than max(flat, pct × computed) — the same rule
 * createBill applies at post time (bills.js statedVatWarning).
 *
 * Black-box over the action API against a throwaway server + DuckDB, same
 * harness as test/contract.test.js. Run: npm test (in api/).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, sql, testDates } = require('../test-utils/helpers');
const TD = testDates();

let srv;
let baseUrl;
const CO = 'IV';
const OWNER = 'owner@iv';
const AP = '2440';    // SE Leverantörsskulder
const EXP = '4010';   // SE Inköp varer

before(async () => {
  srv = await startTestServer({ withAdminToken: true });
  baseUrl = srv.baseUrl;
  const c = await api(baseUrl, 'setup.add_company', {
    company: {
      company_id: CO, company_name: 'IV Test AB', jurisdiction: 'SE', currency: 'SEK',
      fy_start: TD.fyStart, fy_end: TD.fyEnd, vat_registered: true,
    },
  });
  assert.equal(c.status, 200, `setup.add_company failed: ${JSON.stringify(c.body)}`);
  await api(baseUrl, 'period.upsert', {
    companyId: CO,
    period: { period_id: TD.periodId, start_date: TD.startDate, end_date: TD.endDate },
  });
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('${OWNER}', '${CO}', 'owner', now(), 'test')`);
});

after(async () => { await srv.cleanup(); });

// 1000 net @ SE25 → 250.00 computed VAT (default tolerance max(0.50, 1%) = 2.50).
async function saveDraft(ref, extra) {
  const r = await api(baseUrl, 'bill.draft.save', {
    companyId: CO, userEmail: OWNER,
    bill: {
      partner_name: 'Acme AB', vendor_ref: ref, date: TD.day20, due_date: TD.day25,
      currency: 'SEK', ap_account: AP,
      lines: [{ description: 'Goods', expense_account: EXP, amount: 1000, vat_code: 'SE25' }],
      ...extra,
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.data.billId;
}

async function draftItem(billId) {
  const inbox = await api(baseUrl, 'inbox.list', { companyId: CO, userEmail: OWNER, limit: 100 });
  assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
  const item = inbox.body.data.items.find((i) => i.type === 'bill_draft' && i.payload_ref === billId);
  assert.ok(item, 'draft appears in the inbox');
  return item;
}

test('stated VAT outside tolerance → vat_mismatch warning with the numbers', async () => {
  const id = await saveDraft('IV-BAD', { vat_amount_stated: 300 });
  const item = await draftItem(id);
  assert.deepEqual(item.warnings, ['vat_mismatch']);
  assert.match(item.vat_warning, /Stated VAT 300\.00 differs from computed 250\.00 by 50\.00/);
});

test('stated VAT within tolerance → no warning', async () => {
  const id = await saveDraft('IV-OK', { vat_amount_stated: 251 });
  const item = await draftItem(id);
  assert.deepEqual(item.warnings, []);
  assert.equal(item.vat_warning, '');
});

test('no stated VAT → no warning', async () => {
  const id = await saveDraft('IV-NONE', {});
  const item = await draftItem(id);
  assert.deepEqual(item.warnings, []);
});

test('per-code stated VAT (bill-edit grid) outside tolerance → warning names the code', async () => {
  const id = await saveDraft('IV-CODE', { vat_amounts_stated: { SE25: 300 } });
  const item = await draftItem(id);
  assert.deepEqual(item.warnings, ['vat_mismatch']);
  assert.match(item.vat_warning, /Stated VAT for SE25 300\.00 differs from computed 250\.00/);
});

test('posting the same draft emits the identical warning text (shared helper)', async () => {
  const id = await saveDraft('IV-POST', { vat_amount_stated: 300 });
  const item = await draftItem(id);
  const post = await api(baseUrl, 'bill.draft.post', { companyId: CO, userEmail: OWNER, billId: id });
  assert.equal(post.status, 200, JSON.stringify(post.body));
  const warnings = post.body.data.warnings || [];
  assert.ok(warnings.includes(item.vat_warning),
    `post warnings ${JSON.stringify(warnings)} should include inbox text "${item.vat_warning}"`);
});
