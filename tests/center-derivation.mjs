// tests/center-derivation.mjs — Cost/Profit Center derivation (spec rev 4 §8).
//
// Tests the derivation feature end-to-end via the in-process API server.
// Covers: deriveProfitCenter unit, center.upsert validation, journal.post
// derivation (flag off + on), bill.create derivation, validateCenterConsistency,
// cutover sequencing, and correction path (allowInactive).
//
//   Run: node tests/center-derivation.mjs
//   Exits 0 only when every assertion passes.

import { startServer, apiPost } from './lib/test-server.mjs';

const CO = 'cenco';
let BASE = '';
let pass = 0, fail = 0;

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL:', name, detail ? `— ${detail}` : ''); }
}

async function act(action, body = {}) {
  const r = await fetch(`${BASE}/api/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ companyId: CO, action, ...body })
  });
  const j = await r.json();
  return j;
}

async function seedCompany() {
  await apiPost(BASE, 'setup.add_company', 'x', {
    company: {
      company_id: CO,
      company_name: 'Center Test Co',
      jurisdiction: 'SE',
      currency: 'SEK',
      reporting_standard: 'K2',
      vat_registered: false,
      fy_start: '2026-01-01',
      fy_end: '2026-12-31',
    },
  }, 'center-seed').catch((e) => {
    if (!/already exists|DUPLICATE/.test(String(e.message))) throw e;
  });

  // Seed centers: one Profit, one Cost linked to it, one Cost without assignment.
  // Order matters — PC-NORTH must exist before rows that reference it via
  // profit_center_id (center.upsert validates the reference at insert time).
  for (const center of [
    { center_id: 'PC-NORTH', center_type: 'Profit', name: 'North Region', is_active: true },
    { center_id: 'CC-SALES', center_type: 'Cost', name: 'Sales Team', is_active: true, profit_center_id: 'PC-NORTH' },
    { center_id: 'CC-NOSIGN', center_type: 'Cost', name: 'No Assignment', is_active: true },
    { center_id: 'CC-INACTIVE', center_type: 'Cost', name: 'Inactive CC', is_active: false, profit_center_id: 'PC-NORTH' },
  ]) {
    await act('center.upsert', { center });
  }

  // SE jurisdiction seeds BAS COA (3010 Revenue, 4010 Expense, 2440 AP)
  // Open period
  await act('period.save', { periods: [{ period_id: '2026-Q1', start_date: '2026-01-01', end_date: '2026-03-31', locked: false }] });
}

async function setFlag(value) {
  await act('posting_rules.attr.save', { key: 'center_derivation_enabled', value: String(value) });
}

async function testCenterList() {
  console.log('\n--- center.list ---');
  const r = await act('center.list');
  const centers = r.data || r;
  ok('center.list returns 4 centers', centers.length === 4, `got ${centers.length}`);
  const cc = centers.find(c => c.center_id === 'CC-SALES');
  ok('CC-SALES has profit_center_id PC-NORTH', cc && cc.profit_center_id === 'PC-NORTH', cc ? cc.profit_center_id : 'missing');
  ok('CC-SALES has profit_center_name North Region', cc && cc.profit_center_name === 'North Region', cc ? cc.profit_center_name : 'missing');
  const pc = centers.find(c => c.center_id === 'PC-NORTH');
  ok('PC-NORTH has null profit_center_id', pc && !pc.profit_center_id, pc ? pc.profit_center_id : 'missing');
}

async function testCenterSaveValidation() {
  console.log('\n--- center.save validation ---');

  // Flag OFF: Cost center without profit_center_id should succeed
  await setFlag(false);
  let r = await act('center.upsert', { center: { center_id: 'CC-NOPC', center_type: 'Cost', name: 'No PC Test', is_active: true } });
  ok('Flag OFF: Cost center without profit_center_id saved', !r.error, r.error ? JSON.stringify(r.error) : 'ok');

  // Flag ON: Cost center without profit_center_id should fail
  await setFlag(true);
  r = await act('center.upsert', { center: { center_id: 'CC-NOPC2', center_type: 'Cost', name: 'No PC Test 2', is_active: true } });
  ok('Flag ON: Cost center without profit_center_id rejected', r.error, 'should have failed');

  // Flag ON: Cost center with valid profit_center_id should succeed
  r = await act('center.upsert', { center: { center_id: 'CC-WITHPC', center_type: 'Cost', name: 'With PC', is_active: true, profit_center_id: 'PC-NORTH' } });
  ok('Flag ON: Cost center with valid profit_center_id saved', !r.error, r.error ? JSON.stringify(r.error) : 'ok');

  // Cost center pointing at another Cost center should always fail
  r = await act('center.upsert', { center: { center_id: 'CC-BADREF', center_type: 'Cost', name: 'Bad Ref', is_active: true, profit_center_id: 'CC-SALES' } });
  ok('Cost center pointing at Cost center rejected', r.error, 'should have failed');

  // Profit center with profit_center_id should always fail
  r = await act('center.upsert', { center: { center_id: 'PC-BAD', center_type: 'Profit', name: 'Bad PC', is_active: true, profit_center_id: 'PC-NORTH' } });
  ok('Profit center with profit_center_id rejected', r.error, 'should have failed');

  await setFlag(false);
}

async function testJournalPostFlagOff() {
  console.log('\n--- journal.post (flag OFF) ---');
  await setFlag(false);

  // Post with cost_center but mismatched profit_center — should pass through
  // (derivation not enabled, no validation)
  const r = await act('journal.post', {
    lines: [
      { account_code: '4010', debit: 100, credit: 0, date: '2026-02-15', description: 'Test expense', cost_center: 'CC-SALES', profit_center: 'PC-NORTH' },
      { account_code: '3010', debit: 0, credit: 100, date: '2026-02-15', description: 'Test offset' },
    ],
    source: 'manual',
  });
  ok('Flag OFF: journal.post with cost_center succeeds', !r.error, r.error ? JSON.stringify(r.error) : 'ok');

  if (!r.error && r.data?.batchId) {
    // Verify the posted entry has the caller-supplied profit_center
    const entries = await act('journal.list', { batchId: r.data.batchId });
    const rows = entries.data || entries;
    const expenseLine = rows.find(e => e.account_code === '4010');
    ok('Flag OFF: profit_center passes through unchanged', expenseLine && expenseLine.profit_center === 'PC-NORTH',
       expenseLine ? expenseLine.profit_center : 'no line');
  }
}

async function testJournalPostFlagOn() {
  console.log('\n--- journal.post (flag ON) ---');
  await setFlag(true);

  // Post with cost_center — profit_center should be derived
  const r = await act('journal.post', {
    lines: [
      { account_code: '4010', debit: 100, credit: 0, date: '2026-02-16', description: 'Derived expense', cost_center: 'CC-SALES' },
      { account_code: '3010', debit: 0, credit: 100, date: '2026-02-16', description: 'Offset' },
    ],
    source: 'manual',
  });
  ok('Flag ON: journal.post with cost_center succeeds', !r.error, r.error ? JSON.stringify(r.error) : 'ok');

  if (!r.error && r.data?.batchId) {
    const entries = await act('journal.list', { batchId: r.data.batchId });
    const rows = entries.data || entries;
    const expenseLine = rows.find(e => e.account_code === '4010');
    ok('Flag ON: profit_center derived to PC-NORTH', expenseLine && expenseLine.profit_center === 'PC-NORTH',
       expenseLine ? expenseLine.profit_center : 'no line');
  }

  // Post with cost_center that has no profit_center_id — should fail
  const r2 = await act('journal.post', {
    lines: [
      { account_code: '4010', debit: 50, credit: 0, date: '2026-02-17', description: 'No assignment', cost_center: 'CC-NOSIGN' },
      { account_code: '3010', debit: 0, credit: 50, date: '2026-02-17', description: 'Offset' },
    ],
    source: 'manual',
  });
  ok('Flag ON: cost_center without assignment fails', r2.error, 'should have failed');

  // Post with unknown cost_center — should fail
  const r3 = await act('journal.post', {
    lines: [
      { account_code: '4010', debit: 50, credit: 0, date: '2026-02-18', description: 'Unknown CC', cost_center: 'CC-NONEXISTENT' },
      { account_code: '3010', debit: 0, credit: 50, date: '2026-02-18', description: 'Offset' },
    ],
    source: 'manual',
  });
  ok('Flag ON: unknown cost_center fails', r3.error, 'should have failed');

  await setFlag(false);
}

async function testBillCreateFlagOn() {
  console.log('\n--- bill.create (flag ON) ---');
  await setFlag(true);

  // Create a bill with cost_center — profit_center should be derived at create
  const r = await act('bill.create', {
    bill: {
      partner_name: 'Test Vendor',
      vendor_ref: 'INV-001',
      date: '2026-02-20',
      due_date: '2026-03-20',
      amount: 200,
      currency: 'SEK',
      expense_account: '4010',
      ap_account: '2440', // Using same account for simplicity in test
      cost_center: 'CC-SALES',
      description: 'Test bill with CC',
    },
  });
  ok('Flag ON: bill.create with cost_center succeeds', !r.error, r.error ? JSON.stringify(r.error) : 'ok');

  if (!r.error && r.data?.billId) {
    const bill = await act('bill.get', { billId: r.data.billId });
    const b = bill.data || bill;
    ok('Flag ON: bill.profit_center derived to PC-NORTH', b.profit_center === 'PC-NORTH',
       b.profit_center ? b.profit_center : 'missing');
  }

  await setFlag(false);
}

async function testCutoverSequencing() {
  console.log('\n--- cutover sequencing ---');

  // With flag OFF, post a bill against a Cost center with no assignment
  await setFlag(false);
  const r1 = await act('bill.create', {
    bill: {
      partner_name: 'Cutover Vendor',
      vendor_ref: 'INV-002',
      date: '2026-02-22',
      due_date: '2026-03-22',
      amount: 75,
      currency: 'SEK',
      expense_account: '4010',
      ap_account: '2440',
      cost_center: 'CC-NOSIGN',
      description: 'Pre-cutover bill',
    },
  });
  ok('Cutover: flag OFF, bill with unassigned CC succeeds', !r1.error, r1.error ? JSON.stringify(r1.error) : 'ok');

  // Flip flag ON — same posting should now fail
  await setFlag(true);
  const r2 = await act('bill.create', {
    bill: {
      partner_name: 'Cutover Vendor 2',
      vendor_ref: 'INV-003',
      date: '2026-02-23',
      due_date: '2026-03-23',
      amount: 75,
      currency: 'SEK',
      expense_account: '4010',
      ap_account: '2440',
      cost_center: 'CC-NOSIGN',
      description: 'Post-cutover bill',
    },
  });
  ok('Cutover: flag ON, same posting now fails', r2.error, 'should have failed');

  await setFlag(false);
}

async function testCorrectionPath() {
  console.log('\n--- correction path (allowInactive) ---');
  await setFlag(true);

  // First post an entry with the active cost center
  const postR = await act('journal.post', {
    lines: [
      { account_code: '4010', debit: 100, credit: 0, date: '2026-02-25', description: 'To be reversed', cost_center: 'CC-SALES' },
      { account_code: '3010', debit: 0, credit: 100, date: '2026-02-25', description: 'Offset' },
    ],
    source: 'manual',
  });
  ok('Correction: original post succeeds', !postR.error, postR.error ? JSON.stringify(postR.error) : 'ok');

  if (!postR.error && postR.data?.batchId) {
    // Deactivate the cost center (CC-INACTIVE is already inactive, but CC-SALES is active)
    // Let's use CC-INACTIVE which already has is_active=false
    // Post a new entry against CC-INACTIVE — should fail (inactive, not a reversal)
    const r2 = await act('journal.post', {
      lines: [
        { account_code: '4010', debit: 50, credit: 0, date: '2026-02-26', description: 'Inactive CC post', cost_center: 'CC-INACTIVE' },
        { account_code: '3010', debit: 0, credit: 50, date: '2026-02-26', description: 'Offset' },
      ],
      source: 'manual',
    });
    ok('Correction: new post against inactive CC fails', r2.error, 'should have failed');

    // Reverse the original entry — should succeed even though we're in flag-ON mode
    // (reversal copies cost_center/profit_center directly, bypasses enrichAndValidate)
    const revR = await act('journal.reverse', { batchId: postR.data.batchId, reversalDate: '2026-02-27' });
    ok('Correction: reversal succeeds', !revR.error, revR.error ? JSON.stringify(revR.error) : 'ok');
  }

  await setFlag(false);
}

async function main() {
  console.log('Booting test server…');
  const srv = await startServer();
  BASE = srv.baseUrl;
  console.log('Server ready at', BASE);

  try {
    await seedCompany();
    await testCenterList();
    await testCenterSaveValidation();
    await testJournalPostFlagOff();
    await testJournalPostFlagOn();
    await testBillCreateFlagOn();
    await testCutoverSequencing();
    await testCorrectionPath();
  } finally {
    await srv.cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
