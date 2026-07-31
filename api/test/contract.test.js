'use strict';
/**
 * freeBooks — API contract tests (P1-2)
 *
 * Black-box tests over the action API (the agent surface). No internal
 * imports: everything goes through HTTP against a throwaway server + DB.
 * Run: npm test  (in api/)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, sql, seedCompany } = require('../test-utils/helpers');
const { ACTIONS } = require('../src/action-catalog');

let srv;
let baseUrl;
const CO = 'CT';
let AP, EXP;
const KEY = process.env.CONTRACT_TEST_KEY || 'idem-1';

before(async () => {
  srv = await startTestServer({ withAdminToken: true });
  baseUrl = srv.baseUrl;
  const seeded = await seedCompany(baseUrl, CO);
  AP = seeded.AP; EXP = seeded.EXP;
  assert.ok(AP && EXP, 'seed must yield AP + Expense account codes');
  // grant a test user owner rights (bootstrap via admin SQL, not under test)
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@ct', 'CT', 'owner', now(), 'test')`);
  // A1 (§2.1): seed an agent-role user the same way (no Users UI surface)
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('agent@ct', 'CT', 'agent', now(), 'test')`);
});

after(async () => { await srv.cleanup(); });

// ── Catalog (P1-1) ──────────────────────────────────────────────────────────

test('GET /api/actions serves the full catalog', async () => {
  const r = await fetch(`${baseUrl}/api/actions`);
  assert.equal(r.status, 200);
  const { actions } = await r.json();
  assert.ok(Object.keys(actions).length >= 70, 'catalog covers all actions');
  for (const [name, meta] of Object.entries(actions)) {
    assert.ok(meta.role, `${name} has a role`);
    assert.equal(typeof meta.mutating, 'boolean', `${name} declares mutating`);
  }
  for (const a of ['bill.create', 'bill.draft.post', 'bill.void', 'journal.post',
                   'journal.reverse', 'journal.import', 'bank.process', 'fx.revaluation_post']) {
    assert.equal(actions[a].idempotent, true, `${a} flagged idempotent`);
  }
});

// ── Error envelope (P0-2) ───────────────────────────────────────────────────

test('missing action → 400 envelope', async () => {
  const { status, body } = await api(baseUrl, undefined);
  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'INVALID_INPUT');
});

test('unknown action → 400 envelope', async () => {
  const { status, body } = await api(baseUrl, 'nope.x', { companyId: CO });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_INPUT');
});

test('missing required params are named (catalog validation)', async () => {
  const { status, body } = await api(baseUrl, 'bill.create', { companyId: CO });
  assert.equal(status, 400);
  assert.match(body.error.message, /bill/);
  assert.deepEqual(body.error.details.missing, ['bill']);

  const j = await api(baseUrl, 'journal.post', { companyId: CO });
  assert.equal(j.status, 400);
  assert.deepEqual(j.body.error.details.missing, ['lines']);
});

test('param type mismatches are named (catalog strict types)', async () => {
  // lines must be an array — a string 400s with the field + expected type named
  const r = await api(baseUrl, 'journal.post', { companyId: CO, lines: 'not-an-array' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'INVALID_INPUT');
  assert.match(r.body.error.details.typeMismatch[0], /lines \(expected array/);

  // bill must be an object — a string 400s
  const b = await api(baseUrl, 'bill.create', { companyId: CO, bill: 'x' });
  assert.equal(b.status, 400);
  assert.match(b.body.error.details.typeMismatch[0], /bill \(expected object/);

  // amount accepts numeric strings (form-encoded callers) — passes dispatch,
  // then fails INSIDE bill.match (or succeeds) but never with a type 400
  const m = await api(baseUrl, 'bill.match', { companyId: CO, amount: '100.50', currency: 'SGD' });
  assert.notEqual(m.status, 400, 'numeric string must pass the number type check');

  // date must look like YYYY-MM-DD — garbage 400s
  const d = await api(baseUrl, 'fx.rates.get', { companyId: CO, fromCurrency: 'USD', toCurrency: 'SGD', date: 'yesterday' });
  assert.equal(d.status, 400);
  assert.match(d.body.error.details.typeMismatch[0], /date \(expected date/);
});

test('permission check: unknown userEmail → 403', async () => {
  const { status, body } = await api(baseUrl, 'bill.list', { companyId: CO, userEmail: 'stranger@x' });
  assert.equal(status, 403);
  assert.equal(body.error.code, 'FORBIDDEN');
});


// ── Bill lifecycle + validation ─────────────────────────────────────────────

function validBill(overrides = {}) {
  return {
    vendor: 'Acme Pte Ltd', vendor_ref: 'INV-1', date: '2026-07-20', due_date: '2026-08-19',
    currency: 'SGD', ap_account: AP, amount: 100,
    lines: [{ description: 'Office supplies', expense_account: EXP, amount: 100, vat_code: '' }],
    ...overrides,
  };
}

test('bill.create posts with balanced journal + warnings key', async () => {
  const { status, body } = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill() });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.data.created, true);
  assert.ok(Array.isArray(body.data.warnings), 'warnings array present on success');

  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT ROUND(SUM(debit_home),2) dr, ROUND(SUM(credit_home),2) cr, COUNT(*) n
     FROM journal_entries WHERE company_id='CT' AND bill_id IS NOT NULL`);
  assert.equal(Number(rows[0].dr), Number(rows[0].cr), 'journal balanced');
  assert.equal(Number(rows[0].n), 2, 'one expense line + one AP line (no VAT)');
});

test('bill.create validation names every problem', async () => {
  const { status, body } = await api(baseUrl, 'bill.create', { companyId: CO, bill: {} });
  assert.equal(status, 400);
  const msg = body.error.details.errors.join(' | ');
  for (const expected of ['Vendor name required', 'Invoice Ref is required', 'Due date is required']) {
    assert.ok(msg.includes(expected), `names: ${expected}`);
  }
});

test('bill.create rejects unknown account and missing FX rate', async () => {
  const badAcct = await api(baseUrl, 'bill.create', {
    companyId: CO,
    bill: validBill({ vendor_ref: 'INV-2', ap_account: '9999' }),
  });
  assert.equal(badAcct.status, 400);
  assert.match(badAcct.body.error.message, /9999/);

  const fx = await api(baseUrl, 'bill.create', {
    companyId: CO,
    bill: validBill({ vendor_ref: 'INV-3', currency: 'USD' }),
  });
  assert.equal(fx.status, 400);
  assert.match(fx.body.error.message, /No FX rate found/);
});

test('idempotency: replay returns identical response, no duplicate posting', async () => {
  const bill = validBill({ vendor_ref: 'INV-IDEM' });
  const first = await api(baseUrl, 'bill.create', { companyId: CO, bill }, { 'Idempotency-Key': KEY });
  const replay = await api(baseUrl, 'bill.create', { companyId: CO, bill }, { 'Idempotency-Key': KEY });
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('idempotent-replay'), 'true');
  assert.equal(first.body.data.billId, replay.body.data.billId);

  const n = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM bills WHERE company_id='CT' AND vendor_ref='INV-IDEM'`);
  assert.equal(Number(n[0].c), 1, 'exactly one bill persisted');

  const conflict = await api(baseUrl, 'journal.reverse', { companyId: CO, batchId: 'x' }, { 'Idempotency-Key': KEY });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('bill.get 404s, bill.list filters, bill.lines returns journal lines', async () => {
  const missing = await api(baseUrl, 'bill.get', { companyId: CO, billId: 'nope' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');

  const list = await api(baseUrl, 'bill.list', { companyId: CO, status: 'posted' });
  assert.equal(list.status, 200);
  assert.ok(list.body.data.length >= 2, 'posted bills listed');

  const posted = list.body.data[0];
  const lines = await api(baseUrl, 'bill.lines', { companyId: CO, billId: posted.bill_id });
  assert.equal(lines.status, 200);
  assert.ok(Array.isArray(lines.body.data) && lines.body.data.length >= 1);
});

test('draft flow: save → re-save keeps bill_id → post → void reverses journals', async () => {
  const save = await api(baseUrl, 'bill.draft.save', {
    companyId: CO, bill: validBill({ vendor_ref: 'DRAFT-1' }),
  });
  assert.equal(save.status, 200, JSON.stringify(save.body));
  const draftId = save.body.data.billId;

  // Re-save: the update key is bill.bill_id INSIDE the bill object.
  const resave = await api(baseUrl, 'bill.draft.save', {
    companyId: CO, bill: validBill({ vendor_ref: 'DRAFT-1b', bill_id: draftId }),
  });
  assert.equal(resave.status, 200);
  assert.equal(resave.body.data.billId, draftId, 'UPDATE-in-place preserves bill_id');

  const post = await api(baseUrl, 'bill.draft.post', { companyId: CO, billId: draftId });
  assert.equal(post.status, 200, JSON.stringify(post.body));

  const voided = await api(baseUrl, 'bill.void', { companyId: CO, billId: draftId });
  assert.equal(voided.status, 200, JSON.stringify(voided.body));

  const reversal = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM journal_entries WHERE company_id='CT' AND bill_id='${draftId}' AND reverses IS NOT NULL`);
  assert.ok(Number(reversal[0].c) >= 1, 'reversal entries exist after void');
});

// ── Period lock ─────────────────────────────────────────────────────────────

test('locked period rejects posting with 409 PERIOD_LOCKED', async () => {
  await api(baseUrl, 'period.upsert', {
    companyId: CO,
    period: { period_id: '2026-06', start_date: '2026-06-01', end_date: '2026-06-30', locked: true },
  });
  const { status, body } = await api(baseUrl, 'bill.create', {
    companyId: CO, bill: validBill({ vendor_ref: 'LOCK-1', date: '2026-06-15', due_date: '2026-07-15' }),
  });
  assert.equal(status, 409);
  assert.equal(body.error.code, 'PERIOD_LOCKED');
});

// ── Journal ─────────────────────────────────────────────────────────────────

test('journal.post enforces balance; reverse works; double-reverse refused', async () => {
  const unbalanced = await api(baseUrl, 'journal.post', {
    companyId: CO,
    lines: [
      { account_code: EXP, debit: 10, date: '2026-07-20', description: 'x' },
      { account_code: AP, credit: 5, date: '2026-07-20', description: 'x' },
    ],
  });
  assert.equal(unbalanced.status, 400);
  assert.equal(unbalanced.body.error.code, 'VALIDATION');

  const posted = await api(baseUrl, 'journal.post', {
    companyId: CO, userEmail: 'owner@ct',
    lines: [
      { account_code: EXP, debit: 25, date: '2026-07-20', description: 'coffee' },
      { account_code: AP, credit: 25, date: '2026-07-20', description: 'coffee' },
    ],
  });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const batchId = posted.body.data.batchId;

  const reversed = await api(baseUrl, 'journal.reverse', { companyId: CO, batchId, reversalDate: '2026-07-21' });
  assert.equal(reversed.status, 200, JSON.stringify(reversed.body));

  const again = await api(baseUrl, 'journal.reverse', { companyId: CO, batchId, reversalDate: '2026-07-21' });
  assert.notEqual(again.status, 200, 'double reverse must fail');
});

test('journal.entry.update: lockdown + field-level audit', async () => {
  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT entry_id FROM journal_entries WHERE company_id='CT' AND bill_id IS NOT NULL LIMIT 1`);
  const billEntry = await api(baseUrl, 'journal.entry.update', {
    companyId: CO, entryId: rows[0].entry_id, description: 'hack',
  });
  assert.equal(billEntry.status, 409);
  assert.equal(billEntry.body.error.code, 'CONFLICT');

  // Post a fresh manual entry to edit (prior batches were reversed above).
  const fresh = await api(baseUrl, 'journal.post', {
    companyId: CO, userEmail: 'owner@ct',
    lines: [
      { account_code: EXP, debit: 7, date: '2026-07-20', description: 'pre-edit' },
      { account_code: AP, credit: 7, date: '2026-07-20', description: 'pre-edit' },
    ],
  });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  const manual = await sql(baseUrl, srv.adminToken,
    `SELECT entry_id FROM journal_entries WHERE company_id='CT' AND batch_id='${fresh.body.data.batchId}' LIMIT 1`);
  const upd = await api(baseUrl, 'journal.entry.update', {
    companyId: CO, userEmail: 'owner@ct', entryId: manual[0].entry_id, description: 'edited desc',
  });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));

  const audit = await sql(baseUrl, srv.adminToken,
    `SELECT old_value, new_value, changed_by FROM audit_log
     WHERE company_id='CT' AND table_name='journal_entries' AND action='update' AND record_id='${manual[0].entry_id}'`);
  assert.equal(audit.length, 1, 'field-level audit row written');
  assert.equal(audit[0].old_value, 'pre-edit');
  assert.equal(audit[0].new_value, 'edited desc');
  assert.equal(audit[0].changed_by, 'owner@ct');
});

// ── Audit coverage (P0-4) ───────────────────────────────────────────────────

test('mutating actions audited; reads are not', async () => {
  const before = await sql(baseUrl, srv.adminToken, `SELECT COUNT(*) c FROM audit_log WHERE company_id='CT'`);
  await api(baseUrl, 'bill.list', { companyId: CO });
  const afterRead = await sql(baseUrl, srv.adminToken, `SELECT COUNT(*) c FROM audit_log WHERE company_id='CT'`);
  assert.equal(Number(afterRead[0].c), Number(before[0].c), 'read adds no audit rows');

  await api(baseUrl, 'settings.save', { companyId: CO, userEmail: 'owner@ct', settings: { vat_tolerance: 0.99 } });
  const afterWrite = await sql(baseUrl, srv.adminToken, `SELECT COUNT(*) c FROM audit_log WHERE company_id='CT'`);
  assert.equal(Number(afterWrite[0].c), Number(before[0].c) + 1, 'mutation adds one audit row');
});

// ── Admin endpoint (P0-5) ───────────────────────────────────────────────────

test('admin query gated by bearer token', async () => {
  const noAuth = await fetch(`${baseUrl}/api/admin/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: 'SELECT 1' }),
  });
  assert.equal(noAuth.status, 403);

  const wrong = await fetch(`${baseUrl}/api/admin/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
    body: JSON.stringify({ sql: 'SELECT 1' }),
  });
  assert.equal(wrong.status, 403);
});

// ── Reports ─────────────────────────────────────────────────────────────────

test('trial balance report balances (CSV)', async () => {
  const r = await fetch(`${baseUrl}/api/${CO}/report?type=tb&start=2026-07-01&end=2026-07-31&format=csv`);
  assert.equal(r.status, 200);
  const csv = await r.text();
  const lines = csv.trim().split('\n');
  assert.ok(lines.length > 1, 'TB has rows');
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const drIdx = header.findIndex((h) => h.includes('debit'));
  const crIdx = header.findIndex((h) => h.includes('credit'));
  assert.ok(drIdx >= 0 && crIdx >= 0, `TB has debit/credit columns: ${lines[0]}`);
  let dr = 0, cr = 0;
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    dr += parseFloat(cols[drIdx]) || 0;
    cr += parseFloat(cols[crIdx]) || 0;
  }
  assert.ok(Math.abs(dr - cr) < 0.01, `TB balanced: DR ${dr} = CR ${cr}`);
  assert.ok(dr > 0, 'TB has activity');
});
// ── Read models (P1-8) ──────────────────────────────────────────────────────

test('view.bills returns vendors + bills with embedded lines (posted AND draft)', async () => {
  // Posted bill
  const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'INV-VIEW-1' }) });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  // Draft bill with two lines
  const d = await api(baseUrl, 'bill.draft.save', {
    companyId: CO,
    bill: {
      vendor: 'Acme Pte Ltd', vendor_ref: 'DRAFT-VIEW-1', date: '2026-07-21', currency: 'SGD',
      ap_account: AP, status: 'draft',
      lines: [
        { description: 'L1', expense_account: EXP, amount: 40, vat_code: '' },
        { description: 'L2', expense_account: EXP, amount: 60, vat_code: '' },
      ],
    },
  });
  assert.equal(d.status, 200, JSON.stringify(d.body));

  const v = await api(baseUrl, 'view.bills', { companyId: CO, vendor: 'Acme' });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.ok(Array.isArray(v.body.data.vendors), 'vendors array');
  assert.ok(v.body.data.vendors.length >= 1, 'seeded vendor present');
  const byRef = Object.fromEntries(v.body.data.bills.map((b) => [b.vendor_ref, b]));
  const posted = byRef['INV-VIEW-1'];
  const draft = byRef['DRAFT-VIEW-1'];
  assert.ok(posted, 'posted bill in view');
  assert.ok(Array.isArray(posted.lines) && posted.lines.length >= 1, 'posted bill has embedded journal lines');
  assert.equal(posted.lines[0].account_code, EXP, 'posted line is the expense line');
  assert.ok(draft, 'draft bill in view');
  assert.equal(draft.lines.length, 2, 'draft lines parsed from draft_lines JSON');
  assert.equal(draft.lines[1].description, 'L2');
  assert.equal(draft.lines[0].account_code, EXP, 'draft line maps expense_account → account_code');
});

test('view.bank returns cash accounts + journals; reconciliation when accountCode given', async () => {
  const v = await api(baseUrl, 'view.bank', { companyId: CO });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.ok(Array.isArray(v.body.data.accounts), 'accounts array');
  assert.ok(Array.isArray(v.body.data.journals) && v.body.data.journals.length >= 1, 'seeded journals present');
  assert.equal(v.body.data.reconciliation, null, 'no accountCode → no reconciliation block');

  const cash = v.body.data.accounts[0];
  if (cash) {
    const r = await api(baseUrl, 'view.bank', { companyId: CO, accountCode: cash.account_code, dateFrom: '2026-07-01', dateTo: '2026-07-31' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.data.reconciliation.rows), 'reconciliation rows array');
    assert.equal(typeof r.body.data.reconciliation.openingBalance, 'number', 'openingBalance numeric');
  }
});

test('per-line centers: line override beats header through draft save + post', async () => {
  const cs = await api(baseUrl, 'center.save', {
    companyId: CO,
    centers: [
      { center_id: 'CC-OPS', center_type: 'cost', name: 'Operations' },
      { center_id: 'CC-RND', center_type: 'cost', name: 'R&D' },
    ],
  });
  assert.equal(cs.status, 200, JSON.stringify(cs.body));

  // Header center CC-OPS; line 2 overrides to CC-RND
  const d = await api(baseUrl, 'bill.draft.save', {
    companyId: CO,
    bill: {
      vendor: 'Acme Pte Ltd', vendor_ref: 'CC-TEST-1', date: '2026-07-21', currency: 'SGD',
      ap_account: AP, cost_center: 'CC-OPS', status: 'draft',
      lines: [
        { description: 'Header center line', expense_account: EXP, amount: 30, vat_code: '' },
        { description: 'Override center line', expense_account: EXP, amount: 70, vat_code: '', cost_center: 'CC-RND' },
      ],
    },
  });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const draftId = d.body.data.billId;

  // Re-save (UPDATE path) must also persist centers
  const d2 = await api(baseUrl, 'bill.draft.save', {
    companyId: CO,
    bill: {
      bill_id: draftId,
      vendor: 'Acme Pte Ltd', vendor_ref: 'CC-TEST-1', date: '2026-07-21', currency: 'SGD',
      ap_account: AP, cost_center: 'CC-OPS', status: 'draft',
      lines: [
        { description: 'Header center line', expense_account: EXP, amount: 30, vat_code: '' },
        { description: 'Override center line', expense_account: EXP, amount: 70, vat_code: '', cost_center: 'CC-RND' },
      ],
    },
  });
  assert.equal(d2.status, 200, JSON.stringify(d2.body));

  const p = await api(baseUrl, 'bill.draft.post', { companyId: CO, billId: draftId });
  assert.equal(p.status, 200, JSON.stringify(p.body));

  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT description, cost_center FROM journal_entries
     WHERE company_id='${CO}' AND bill_id='${draftId}' AND debit > 0 ORDER BY description`);
  const byDesc = Object.fromEntries(rows.map((r) => [String(r.description), r.cost_center]));
  const headerLine = Object.keys(byDesc).find((k) => k.includes('Header center line'));
  const overrideLine = Object.keys(byDesc).find((k) => k.includes('Override center line'));
  assert.equal(String(byDesc[headerLine]), 'CC-OPS', 'line without override inherits header center');
  assert.equal(String(byDesc[overrideLine]), 'CC-RND', 'line override wins over header');
});

// ── P1-9: manual bill payments (dual path: pay-on-bill + bank import) ──────
// All COUNT/assertions scoped to entities created by each test (order-fragile pitfall).

test('bill.payment.record: full home payment settles, idempotent replay does not duplicate', async () => {
  // SG template ships bank accounts cf_category='Excluded' — mark 1020 as Cash (app-wide bank marker)
  await sql(baseUrl, srv.adminToken,
    `UPDATE accounts SET cf_category='Cash' WHERE company_id='CT' AND account_code='1020'`);

  const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'PAY-1' }) });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const billId = c.body.data.billId;

  const payload = { companyId: CO, billId, date: '2026-07-21', bankAccount: '1020', amount: 100, reference: 'TT-123' };
  const pay = await api(baseUrl, 'bill.payment.record', payload, { 'Idempotency-Key': 'pay-1' });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  assert.equal(pay.body.data.status, 'paid');
  assert.equal(pay.body.data.outstanding, 0);

  const replay = await api(baseUrl, 'bill.payment.record', payload, { 'Idempotency-Key': 'pay-1' });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('idempotent-replay'), 'true');
  assert.equal(replay.body.data.paymentId, pay.body.data.paymentId, 'replay returns same paymentId');

  const je = await sql(baseUrl, srv.adminToken,
    `SELECT ROUND(SUM(debit_home),2) dr, ROUND(SUM(credit_home),2) cr FROM journal_entries
     WHERE company_id='CT' AND batch_id='${pay.body.data.batchId}'`);
  assert.equal(Number(je[0].dr), Number(je[0].cr), 'settlement journal balanced');
  assert.equal(Number(je[0].dr), 100);

  const bp = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c, MAX(bp.method) m, MAX(bp.reference) r, MAX(je.source) s
     FROM bill_payments bp JOIN journal_entries je ON je.batch_id = bp.batch_id AND je.company_id = bp.company_id
     WHERE bp.company_id='CT' AND bp.bill_id='${billId}'`);
  assert.equal(Number(bp[0].c), 2, 'one payment row joined to its 2 journal lines — no duplicate on replay');
  assert.equal(String(bp[0].m), 'manual');
  assert.equal(String(bp[0].r), 'TT-123');
  assert.equal(String(bp[0].s), 'manual_payment');
});

test('bill.payment.record: partial payments, overpayment refused, bill.payments history', async () => {
  const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'PAY-2' }) });
  const billId = c.body.data.billId;

  const p1 = await api(baseUrl, 'bill.payment.record', { companyId: CO, billId, date: '2026-07-21', bankAccount: '1020', amount: 40 });
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.equal(p1.body.data.status, 'partial');
  assert.equal(p1.body.data.outstanding, 60);

  const over = await api(baseUrl, 'bill.payment.record', { companyId: CO, billId, date: '2026-07-21', bankAccount: '1020', amount: 61 });
  assert.equal(over.status, 400);
  assert.match(over.body.error.message, /exceeds outstanding/);

  const p2 = await api(baseUrl, 'bill.payment.record', { companyId: CO, billId, date: '2026-07-22', bankAccount: '1020', amount: 60 });
  assert.equal(p2.status, 200);
  assert.equal(p2.body.data.status, 'paid');

  const hist = await api(baseUrl, 'bill.payments', { companyId: CO, billId });
  assert.equal(hist.status, 200, JSON.stringify(hist.body));
  assert.equal(hist.body.data.length, 2, 'two payments in history');
  assert.equal(Number(hist.body.data[0].amount), 40, 'ordered by date');
  assert.equal(Number(hist.body.data[1].amount), 60);
  assert.ok(hist.body.data.every((p) => p.method === 'manual' && !p.voided_at));
});

test('bill.payment.record: foreign-currency bill posts FX gain/loss split', async () => {
  await sql(baseUrl, srv.adminToken,
    `DELETE FROM settings WHERE company_id='CT' AND key='fx_gain_loss_account'`);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO settings (company_id, key, value) VALUES ('CT','fx_gain_loss_account','${EXP}')`);
  const rateSave = await api(baseUrl, 'fx.rates.save', {
    companyId: CO, rates: [{ date: '2026-07-20', from_currency: 'USD', to_currency: 'SGD', rate: 1.35 }],
  });
  assert.equal(rateSave.status, 200, JSON.stringify(rateSave.body));

  const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'PAY-FX-1', currency: 'USD' }) });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const billId = c.body.data.billId;

  // Pay 100 USD at 1.30 (bankAmount 130 SGD; booked at 1.35 = 135) → 5 SGD gain
  const pay = await api(baseUrl, 'bill.payment.record', {
    companyId: CO, billId, date: '2026-07-21', bankAccount: '1020', amount: 100, fxRate: 1.30,
  });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  assert.equal(pay.body.data.status, 'paid');

  const je = await sql(baseUrl, srv.adminToken,
    `SELECT account_code, debit_home, credit_home FROM journal_entries
     WHERE company_id='CT' AND batch_id='${pay.body.data.batchId}' ORDER BY debit_home DESC`);
  assert.equal(je.length, 3, '3-line FX settlement journal');
  assert.equal(Number(je[0].debit_home), 135, 'AP cleared at booking rate');
  assert.equal(String(je[0].account_code), AP);
  const fxLine = je.find((r) => String(r.account_code) === EXP);
  assert.ok(fxLine, 'FX gain/loss line present');
  assert.equal(Number(fxLine.credit_home), 5, 'gain credited');
  const bankLine = je.find((r) => String(r.account_code) === '1020');
  assert.equal(Number(bankLine.credit_home), 130, 'bank credited at payment rate');

  const bill = await sql(baseUrl, srv.adminToken,
    `SELECT amount_paid FROM bills WHERE company_id='CT' AND bill_id='${billId}'`);
  assert.equal(Number(bill[0].amount_paid), 100, 'amount_paid tracked in foreign currency');
});

test('bill.payment.record: validation errors named', async () => {
  const missing = await api(baseUrl, 'bill.payment.record', { companyId: CO, billId: 'nope', date: '2026-07-21', bankAccount: '1020', amount: 1 });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');

  const d = await api(baseUrl, 'bill.draft.save', {
    companyId: CO,
    bill: { vendor: 'Acme Pte Ltd', vendor_ref: 'PAY-DRAFT-1', date: '2026-07-21', currency: 'SGD', ap_account: AP, status: 'draft', lines: [{ description: 'x', expense_account: EXP, amount: 10, vat_code: '' }] },
  });
  const onDraft = await api(baseUrl, 'bill.payment.record', { companyId: CO, billId: d.body.data.billId, date: '2026-07-21', bankAccount: '1020', amount: 10 });
  assert.equal(onDraft.status, 409);
  assert.match(onDraft.body.error.message, /draft/);

  const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'PAY-3' }) });
  const nonCash = await api(baseUrl, 'bill.payment.record', { companyId: CO, billId: c.body.data.billId, date: '2026-07-21', bankAccount: AP, amount: 10 });
  assert.equal(nonCash.status, 400);
  assert.match(nonCash.body.error.message, /cf_category/);
});

test('bill.payment.void: reverses journal, restores bill, refuses double-void', async () => {
  const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'PAY-4' }) });
  const billId = c.body.data.billId;
  const pay = await api(baseUrl, 'bill.payment.record', { companyId: CO, billId, date: '2026-07-21', bankAccount: '1020', amount: 100 });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  const { paymentId, batchId } = pay.body.data;

  const v = await api(baseUrl, 'bill.payment.void', { companyId: CO, paymentId });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.data.voided, true);
  assert.equal(v.body.data.newStatus, 'posted');
  assert.equal(v.body.data.amountPaid, 0);

  const rev = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM journal_entries WHERE company_id='CT' AND reverses='${batchId}'`);
  assert.ok(Number(rev[0].c) >= 2, 'reversal journal lines exist');

  const bp = await sql(baseUrl, srv.adminToken,
    `SELECT voided_at FROM bill_payments WHERE company_id='CT' AND payment_id='${paymentId}'`);
  assert.ok(bp[0].voided_at, 'payment marked voided (append-only subledger)');

  const bill = await sql(baseUrl, srv.adminToken,
    `SELECT status, amount_paid FROM bills WHERE company_id='CT' AND bill_id='${billId}'`);
  assert.equal(String(bill[0].status), 'posted');
  assert.equal(Number(bill[0].amount_paid), 0);

  const again = await api(baseUrl, 'bill.payment.void', { companyId: CO, paymentId });
  assert.equal(again.status, 409);
  assert.match(again.body.error.message, /already voided/);
});

test('bank.process: amount-only match demoted to suggestion; vendor/ref tiers', async () => {
  // Distinct amount (101) so only this test's bill matches by amount
  const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'INV-TIER-A', amount: 101, lines: [{ description: 'x', expense_account: EXP, amount: 101, vat_code: '' }] }) });
  assert.equal(c.status, 200, JSON.stringify(c.body));

  const proc = await api(baseUrl, 'bank.process', {
    companyId: CO,
    bankAccount: '1020',
    rows: [
      { date: '2026-07-21', description: 'GIRO TRANSFER 998877', amount: -101 },        // amount-only → suggest
      { date: '2026-07-21', description: 'PAYMENT ACME PTE LTD', amount: -101 },        // vendor substring → medium
      { date: '2026-07-21', description: 'TRF INV-TIER-A 9988', amount: -101 },         // ref whole token → high
      { date: '2026-07-21', description: 'TRF INV-TIER-A99', amount: -101 },           // ref glued to digits: substring, not token → medium
    ],
  });
  assert.equal(proc.status, 200, JSON.stringify(proc.body));
  const p = proc.body.data.processed;
  assert.equal(p[0].matchType, 'bill_suggest', 'amount-only is a suggestion, not an auto-match');
  assert.equal(p[0].matchConfidence, 'suggest');
  assert.ok(p[0].billId, 'suggestion carries the candidate billId');
  assert.equal(p[1].matchType, 'bill');
  assert.equal(p[1].matchConfidence, 'medium');
  assert.equal(p[2].matchType, 'bill');
  assert.equal(p[2].matchConfidence, 'high', 'vendor_ref whole token promotes to high');
  assert.equal(p[3].matchConfidence, 'medium', 'ref substring without token boundary stays medium');
  assert.equal(proc.body.data.summary.billSuggest, 1);
  assert.equal(proc.body.data.summary.billMatched, 3);
});

test('bank.process + approve: import row matching a recorded manual payment clears, never re-posts', async () => {
  const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'PAY-REC-1' }) });
  const billId = c.body.data.billId;
  const pay = await api(baseUrl, 'bill.payment.record', { companyId: CO, billId, date: '2026-07-21', bankAccount: '1020', amount: 100 });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));

  const before = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM journal_entries WHERE company_id='CT' AND bill_id='${billId}'`);

  const proc = await api(baseUrl, 'bank.process', {
    companyId: CO,
    bankAccount: '1020',
    rows: [{ date: '2026-07-21', description: 'GIRO ACME PAY-REC-1', amount: -100 }],
  });
  assert.equal(proc.status, 200, JSON.stringify(proc.body));
  const row = proc.body.data.processed[0];
  assert.equal(row.matchType, 'recorded_payment', 'tagged as already-recorded');
  assert.ok(row.paymentBatchId, 'payment batch attached for clearing');

  const ap = await api(baseUrl, 'bank.approve', {
    companyId: CO,
    entries: [{ date: '2026-07-21', description: row.description, amount: -100, recordedPayment: true, paymentBatchId: row.paymentBatchId, bankAccount: '1020' }],
  });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.equal(ap.body.data.results[0].recordedPayment, true);
  assert.equal(ap.body.data.results[0].cleared, true);

  const after = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM journal_entries WHERE company_id='CT' AND bill_id='${billId}'`);
  assert.equal(Number(after[0].c), Number(before[0].c), 'no new journal lines — no double-count');

  const rec = await sql(baseUrl, srv.adminToken,
    `SELECT account_code FROM reconciliations WHERE company_id='CT' AND batch_id='${row.paymentBatchId}'`);
  assert.equal(String(rec[0].account_code), '1020', 'payment bank leg cleared in reconciliations');
});

// ── A1: agent actor model (§2) ──────────────────────────────────────────────

test('A1 guard matrix: agent FORBIDDEN on every mutating catalog action', async () => {
  // Spec §2.3 default-deny: iterate every catalog action flagged mutating,
  // call as the agent user, and assert 403/FORBIDDEN for each. The guard
  // runs before param validation, so missing params don't leak a 400.
  // (attachment.upload is the one whitelisted mutating action, but it is
  // not a catalog action today — it's a separate /api/upload route — so it
  // is not in this iteration. journal.propose joins the whitelist in A3j.)
  const mutatingActions = Object.entries(ACTIONS)
    .filter(([, m]) => m.mutating === true)
    .map(([name]) => name);
  assert.ok(mutatingActions.length >= 20, 'catalog has many mutating actions to cover');
  for (const action of mutatingActions) {
    const { status, body } = await api(baseUrl, action, { companyId: CO, userEmail: 'agent@ct' });
    assert.equal(status, 403, `${action}: agent must be FORBIDDEN (got ${status} ${body?.error?.code})`);
    assert.equal(body?.error?.code, 'FORBIDDEN', `${action}: FORBIDDEN code`);
  }
});

test('A1: agent can read (non-mutating action passes the guard)', async () => {
  const { status, body } = await api(baseUrl, 'journal.list', { companyId: CO, userEmail: 'agent@ct' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(Array.isArray(body.data), 'agent reads journal list — non-mutating passes the §2.3 guard');
});

test('A1: fail-closed — whitelist guard denies a viewer-level mutating action (role check passes)', async () => {
  // Spec §8.1 fail-closed proof. report.refresh_vat_return is the one
  // catalog action that is mutating:true at role viewer — so the agent
  // (level 1.5 ≥ 1) PASSES the numeric role check, isolating the §2.3
  // whitelist guard as the only thing that can deny it. This exercises the
  // exact path any FUTURE new mutating action will hit: not in
  // AGENT_ALLOWED → FORBIDDEN, by default, until explicitly whitelisted.
  const { status, body } = await api(baseUrl, 'report.refresh_vat_return', { companyId: CO, userEmail: 'agent@ct' });
  assert.equal(status, 403, 'mutating action outside the whitelist must be denied to agents');
  assert.equal(body?.error?.code, 'FORBIDDEN');
  assert.match(body?.error?.message, /finalize or mutate master data/,
    'denial must come from the whitelist guard, not the role check (agent passes the role check at viewer level)');

  // Sanity: a human data_entry user reaches past the guard (handler may
  // fail on missing state — anything except the guard's FORBIDDEN proves
  // the guard is actor-class-specific, R6 eligibility is server-side).
  const hr = await api(baseUrl, 'report.refresh_vat_return', { companyId: CO, userEmail: 'owner@ct' });
  assert.notEqual(hr.body?.error?.message, 'Agents may not finalize or mutate master data',
    'human call is not stopped by the agent whitelist guard');
});

test('A1: setup.* rejected for agent even though setup skips the role check', async () => {
  // setup.* actions bypass the permission check by design; the §2.3 guard
  // blocks agents unconditionally (resolveActor resolves across all
  // companies when companyId is absent, so the agent is recognized).
  const { status, body } = await api(baseUrl, 'setup.init', { userEmail: 'agent@ct' });
  assert.equal(status, 403);
  assert.equal(body.error.code, 'FORBIDDEN');
  assert.match(body.error.message, /setup/);
});

test('A1 audit attribution: actor_type + request_id stamped on audit rows', async () => {
  // Owner mutating call with requestId → dispatch audit (auditCall) row
  // carries actor_type='human' + request_id (§2.4 stamping, end-to-end).
  const r = await api(baseUrl, 'settings.save', {
    companyId: CO, userEmail: 'owner@ct', requestId: 'req-owner-a1',
    settings: { vat_tolerance: 1.01 },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT actor_type, request_id, changed_by FROM audit_log
     WHERE company_id='CT' AND request_id='req-owner-a1'
       AND table_name='api' AND record_id='settings.save'`);
  assert.ok(rows.length >= 1, 'dispatch audit row written for owner call');
  assert.equal(rows[0].actor_type, 'human', 'owner call → actor_type human');
  assert.equal(rows[0].request_id, 'req-owner-a1');
  assert.equal(rows[0].changed_by, 'owner@ct');

  // Agent mutating call → FORBIDDEN by the §2.3 guard (runs before the
  // handler and before auditCall). In A1 agents cannot perform any mutating
  // action (R2), so no agent-origin audit row is produced via auditCall.
  // actor_type='agent' stamping is exercised end-to-end when journal.propose
  // (A3j) or attachment.upload (MCP §5) lands — the stamping code path is
  // identical to the human path verified above, just with actorType='agent'
  // from resolveActor. Here we assert the guard is the choke point: a
  // forbidden agent call writes no audit row at all.
  const fr = await api(baseUrl, 'settings.save', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-agent-a1',
    settings: { vat_tolerance: 2.0 },
  });
  assert.equal(fr.status, 403);
  assert.equal(fr.body.error.code, 'FORBIDDEN');
  const agentRows = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM audit_log WHERE company_id='CT' AND request_id='req-agent-a1'`);
  assert.equal(Number(agentRows[0].c), 0, 'forbidden agent call writes no audit row (guard before audit)');
});
