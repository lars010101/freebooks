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
