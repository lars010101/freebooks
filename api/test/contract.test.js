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
const crypto = require('node:crypto');
const fs = require('node:fs');
const { startTestServer, api, sql, seedCompany, testDates } = require('../test-utils/helpers');
const { ACTIONS } = require('../src/action-catalog');

let srv;
let baseUrl;
const CO = 'CT';
let AP, EXP;
const KEY = process.env.CONTRACT_TEST_KEY || 'idem-1';
const TD = testDates();

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
                   'journal.reverse', 'journal.import', 'fx.revaluation_post']) {
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
    partner_name: 'Acme Pte Ltd', vendor_ref: 'INV-1', date: TD.day20, due_date: TD.day25,
    currency: 'SGD', ap_account: AP, amount: 100,
    lines: [{ description: 'Office supplies', expense_account: EXP, amount: 100, vat_code: '' }],
    ...overrides,
  };
}

// Wall-clock determinism for void reversals: bill.void / payment.void
// reverse via journal.reverse with NO reversalDate → server defaults to
// "today". Seed a wide window (last month → next month, UTC) so the reversal
// date is covered regardless of run date. Scoped locally, not in before().
async function seedVoidCoverPeriod() {
  const today = new Date().toISOString().slice(0, 10);
  const [y, m] = today.split('-').map(Number);
  const startY = m <= 1 ? y - 1 : y;
  const startM = m <= 1 ? 12 : m - 1;
  const endY = m >= 12 ? y + 1 : y;
  const endM = m >= 12 ? 1 : m + 1;
  const endLast = new Date(Date.UTC(endY, endM, 0)).getUTCDate();
  const r = await api(baseUrl, 'period.upsert', {
    companyId: CO,
    period: {
      period_id: `VOID-COVER-${y}${String(m).padStart(2, '0')}`,
      start_date: `${startY}-${String(startM).padStart(2, '0')}-01`,
      end_date: `${endY}-${String(endM).padStart(2, '0')}-${String(endLast).padStart(2, '0')}`,
    },
  });
  assert.equal(r.status, 200, `seedVoidCoverPeriod failed: ${JSON.stringify(r.body)}`);
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
  for (const expected of ['Partner name required', 'Invoice Ref is required', 'Due date is required']) {
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

  const list = await api(baseUrl, 'bill.list', { companyId: CO, status: 'posted', threshold: 1500 });
  assert.equal(list.status, 200);
  assert.ok(list.body.data.data.length >= 2, 'posted bills listed');

  const posted = list.body.data.data[0];
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

  await seedVoidCoverPeriod();
  const voided = await api(baseUrl, 'bill.void', { companyId: CO, billId: draftId });
  assert.equal(voided.status, 200, JSON.stringify(voided.body));

  const reversal = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM journal_entries WHERE company_id='CT' AND bill_id='${draftId}' AND reverses IS NOT NULL`);
  assert.ok(Number(reversal[0].c) >= 1, 'reversal entries exist after void');
});

// ── P2-3: bill_lines subledger ──────────────────────────────────────────────

test('P2-3: createBill writes bill_lines rows', async () => {
  const bill = validBill({
    vendor_ref: 'P23-WRITE',
    amount: 100,
    lines: [
      { description: 'Line A', expense_account: EXP, amount: 60, vat_code: '' },
      { description: 'Line B', expense_account: EXP, amount: 40, vat_code: '' },
    ],
  });
  const { status, body } = await api(baseUrl, 'bill.create', { companyId: CO, bill });
  assert.equal(status, 200, JSON.stringify(body));
  const billId = body.data.billId;

  const lines = await api(baseUrl, 'bill.lines', { companyId: CO, billId });
  assert.equal(lines.status, 200);
  const data = lines.body.data;
  assert.ok(Array.isArray(data) && data.length === 2, '2 bill_lines rows');
  assert.equal(data[0].account_code, EXP, 'first line expense account');
  assert.equal(Number(data[0].amount), 60, 'first line amount');
  assert.equal(data[1].account_code, EXP, 'second line expense account');
  assert.equal(Number(data[1].amount), 40, 'second line amount');
});

test('P2-3: bill.lines reads from bill_lines for posted bills', async () => {
  const { status, body } = await api(baseUrl, 'bill.create', {
    companyId: CO,
    bill: validBill({ vendor_ref: 'P23-READ' }),
  });
  assert.equal(status, 200, JSON.stringify(body));
  const billId = body.data.billId;

  const lines = await api(baseUrl, 'bill.lines', { companyId: CO, billId });
  assert.equal(lines.status, 200);
  const data = lines.body.data;
  assert.ok(Array.isArray(data) && data.length >= 1, 'lines returned');
  // entry_id should be a line number string ("1", "2", ...), NOT a UUID
  const eid = String(data[0].entry_id);
  assert.ok(/^\d+$/.test(eid), `entry_id is a line number, not a UUID: ${eid}`);
  assert.ok(eid.length < 36, 'entry_id is short (line number), not a UUID');
});

test('P2-3: bill.void preserves bill_lines rows', async () => {
  const { status, body } = await api(baseUrl, 'bill.create', {
    companyId: CO,
    bill: validBill({
      vendor_ref: 'P23-VOID',
      amount: 100,
      lines: [
        { description: 'Line A', expense_account: EXP, amount: 60, vat_code: '' },
        { description: 'Line B', expense_account: EXP, amount: 40, vat_code: '' },
      ],
    }),
  });
  assert.equal(status, 200, JSON.stringify(body));
  const billId = body.data.billId;

  await seedVoidCoverPeriod();
  const voided = await api(baseUrl, 'bill.void', { companyId: CO, billId });
  assert.equal(voided.status, 200, JSON.stringify(voided.body));

  // bill_lines rows must survive voiding (never mutated)
  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM bill_lines WHERE company_id='CT' AND bill_id='${billId}'`);
  assert.equal(Number(rows[0].c), 2, '2 bill_lines rows preserved after void');
});

test('P2-3: AP control report renders', async () => {
  const r = await fetch(`${baseUrl}/api/${CO}/report?type=ap-control&end=${TD.fyEnd}`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('AP Control'), 'HTML contains AP Control title');
  assert.ok(html.includes('<table'), 'HTML contains a table');
});

// ── Period lock ─────────────────────────────────────────────────────────────

test('locked period rejects posting with 409 PERIOD_LOCKED', async () => {
  await api(baseUrl, 'period.upsert', {
    companyId: CO,
    period: { period_id: TD.prevPeriodId, start_date: TD.prevMonthStart, end_date: TD.prevMonthEnd, locked: true },
  });
  const { status, body } = await api(baseUrl, 'bill.create', {
    companyId: CO, bill: validBill({ vendor_ref: 'LOCK-1', date: TD.prevDay15, due_date: TD.day15 }),
  });
  assert.equal(status, 409);
  assert.equal(body.error.code, 'PERIOD_LOCKED');
});

// ── Journal ─────────────────────────────────────────────────────────────────

test('journal.post enforces balance; reverse works; double-reverse refused', async () => {
  const unbalanced = await api(baseUrl, 'journal.post', {
    companyId: CO,
    lines: [
      { account_code: EXP, debit: 10, date: TD.day20, description: 'x' },
      { account_code: AP, credit: 5, date: TD.day20, description: 'x' },
    ],
  });
  assert.equal(unbalanced.status, 400);
  assert.equal(unbalanced.body.error.code, 'VALIDATION');

  const posted = await api(baseUrl, 'journal.post', {
    companyId: CO, userEmail: 'owner@ct',
    lines: [
      { account_code: EXP, debit: 25, date: TD.day20, description: 'coffee' },
      { account_code: AP, credit: 25, date: TD.day20, description: 'coffee' },
    ],
  });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const batchId = posted.body.data.batchId;

  const reversed = await api(baseUrl, 'journal.reverse', { companyId: CO, batchId, reversalDate: TD.day21 });
  assert.equal(reversed.status, 200, JSON.stringify(reversed.body));

  const again = await api(baseUrl, 'journal.reverse', { companyId: CO, batchId, reversalDate: TD.day21 });
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
      { account_code: EXP, debit: 7, date: TD.day20, description: 'pre-edit' },
      { account_code: AP, credit: 7, date: TD.day20, description: 'pre-edit' },
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

  await api(baseUrl, 'posting_rules.attr.save', { companyId: CO, userEmail: 'owner@ct', key: 'vat_tolerance', value: 0.99 });
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
  const r = await fetch(`${baseUrl}/api/${CO}/report?type=tb&start=${TD.startDate}&end=${TD.endDate}&format=csv`);
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

test('view.bills returns partners + bills with embedded lines (posted AND draft)', async () => {
  // Posted bill
  const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'INV-VIEW-1' }) });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  // Draft bill with two lines
  const d = await api(baseUrl, 'bill.draft.save', {
    companyId: CO,
    bill: {
      partner_name: 'Acme Pte Ltd', vendor_ref: 'DRAFT-VIEW-1', date: TD.day21, currency: 'SGD',
      ap_account: AP, status: 'draft',
      lines: [
        { description: 'L1', expense_account: EXP, amount: 40, vat_code: '' },
        { description: 'L2', expense_account: EXP, amount: 60, vat_code: '' },
      ],
    },
  });
  assert.equal(d.status, 200, JSON.stringify(d.body));

  const v = await api(baseUrl, 'view.bills', { companyId: CO, partner_name: 'Acme' });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.ok(Array.isArray(v.body.data.partners), 'partners array');
  assert.ok(v.body.data.partners.length >= 1, 'seeded partner present');
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
    const r = await api(baseUrl, 'view.bank', { companyId: CO, accountCode: cash.account_code, dateFrom: TD.startDate, dateTo: TD.endDate });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.data.reconciliation.rows), 'reconciliation rows array');
    assert.equal(typeof r.body.data.reconciliation.openingBalance, 'number', 'openingBalance numeric');
  }
});

test('per-line centers: line override beats header through draft save + post', async () => {
  for (const center of [
    { center_id: 'CC-OPS', center_type: 'Cost', name: 'Operations' },
    { center_id: 'CC-RND', center_type: 'Cost', name: 'R&D' },
  ]) {
    const cs = await api(baseUrl, 'center.upsert', { companyId: CO, center });
    assert.equal(cs.status, 200, JSON.stringify(cs.body));
  }

  // Header center CC-OPS; line 2 overrides to CC-RND
  const d = await api(baseUrl, 'bill.draft.save', {
    companyId: CO,
    bill: {
      partner_name: 'Acme Pte Ltd', vendor_ref: 'CC-TEST-1', date: TD.day21, currency: 'SGD',
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
      partner_name: 'Acme Pte Ltd', vendor_ref: 'CC-TEST-1', date: TD.day21, currency: 'SGD',
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

test('payment.record: full home payment settles, idempotent replay does not duplicate', async () => {
  // SG template ships bank accounts cf_category='Excluded' — mark 1020 as Cash (app-wide bank marker)
  await sql(baseUrl, srv.adminToken,
    `UPDATE accounts SET cf_category='Cash' WHERE company_id='CT' AND account_code='1020'`);

  const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'PAY-1' }) });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const billId = c.body.data.billId;

  const payload = { companyId: CO, billId, date: TD.day21, bankAccount: '1020', amount: 100, reference: 'TT-123' };
  const pay = await api(baseUrl, 'payment.record', payload, { 'Idempotency-Key': 'pay-1' });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  assert.equal(pay.body.data.status, 'paid');
  assert.equal(pay.body.data.outstanding, 0);

  const replay = await api(baseUrl, 'payment.record', payload, { 'Idempotency-Key': 'pay-1' });
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
     FROM payments bp JOIN journal_entries je ON je.batch_id = bp.batch_id AND je.company_id = bp.company_id
     WHERE bp.company_id='CT' AND bp.bill_id='${billId}'`);
  assert.equal(Number(bp[0].c), 2, 'one payment row joined to its 2 journal lines — no duplicate on replay');
  assert.equal(String(bp[0].m), 'manual');
  assert.equal(String(bp[0].r), 'TT-123');
  assert.equal(String(bp[0].s), 'manual_payment');
});

test('payment.record: partial payments, overpayment refused, payment.list history', async () => {
  const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'PAY-2' }) });
  const billId = c.body.data.billId;

  const p1 = await api(baseUrl, 'payment.record', { companyId: CO, billId, date: TD.day21, bankAccount: '1020', amount: 40 });
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.equal(p1.body.data.status, 'partial');
  assert.equal(p1.body.data.outstanding, 60);

  const over = await api(baseUrl, 'payment.record', { companyId: CO, billId, date: TD.day21, bankAccount: '1020', amount: 61 });
  assert.equal(over.status, 400);
  assert.match(over.body.error.message, /exceeds outstanding/);

  const p2 = await api(baseUrl, 'payment.record', { companyId: CO, billId, date: TD.day22, bankAccount: '1020', amount: 60 });
  assert.equal(p2.status, 200);
  assert.equal(p2.body.data.status, 'paid');

  const hist = await api(baseUrl, 'payment.list', { companyId: CO, billId });
  assert.equal(hist.status, 200, JSON.stringify(hist.body));
  assert.equal(hist.body.data.length, 2, 'two payments in history');
  assert.equal(Number(hist.body.data[0].amount), 40, 'ordered by date');
  assert.equal(Number(hist.body.data[1].amount), 60);
  assert.ok(hist.body.data.every((p) => p.method === 'manual' && !p.voided_at));
});

test('payment.record: foreign-currency bill posts FX gain/loss split', async () => {
  await api(baseUrl, 'coa.upsert', {
    companyId: CO,
    account: { account_code: EXP, account_name: 'FX Expense', account_type: 'Expense', is_active: true, default_role: 'FX Gain/Loss', effective_from: TD.day1 }
  });
  const rateSave = await api(baseUrl, 'fx.rates.save', {
    companyId: CO, rates: [{ date: TD.day20, from_currency: 'USD', to_currency: 'SGD', rate: 1.35 }],
  });
  assert.equal(rateSave.status, 200, JSON.stringify(rateSave.body));

  const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'PAY-FX-1', currency: 'USD' }) });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const billId = c.body.data.billId;

  // Pay 100 USD at 1.30 (bankAmount 130 SGD; booked at 1.35 = 135) → 5 SGD gain
  const pay = await api(baseUrl, 'payment.record', {
    companyId: CO, billId, date: TD.day21, bankAccount: '1020', amount: 100, fxRate: 1.30,
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

test('payment.record: validation errors named', async () => {
  const missing = await api(baseUrl, 'payment.record', { companyId: CO, billId: 'nope', date: TD.day21, bankAccount: '1020', amount: 1 });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');

  const d = await api(baseUrl, 'bill.draft.save', {
    companyId: CO,
    bill: { partner_name: 'Acme Pte Ltd', vendor_ref: 'PAY-DRAFT-1', date: TD.day21, currency: 'SGD', ap_account: AP, status: 'draft', lines: [{ description: 'x', expense_account: EXP, amount: 10, vat_code: '' }] },
  });
  const onDraft = await api(baseUrl, 'payment.record', { companyId: CO, billId: d.body.data.billId, date: TD.day21, bankAccount: '1020', amount: 10 });
  assert.equal(onDraft.status, 409);
  assert.match(onDraft.body.error.message, /draft/);

  const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'PAY-3' }) });
  const nonCash = await api(baseUrl, 'payment.record', { companyId: CO, billId: c.body.data.billId, date: TD.day21, bankAccount: AP, amount: 10 });
  assert.equal(nonCash.status, 400);
  assert.match(nonCash.body.error.message, /cf_category/);
});

test('payment.void: reverses journal, restores bill, refuses double-void', async () => {
  const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'PAY-4' }) });
  const billId = c.body.data.billId;
  const pay = await api(baseUrl, 'payment.record', { companyId: CO, billId, date: TD.day21, bankAccount: '1020', amount: 100 });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  const { paymentId, batchId } = pay.body.data;

  await seedVoidCoverPeriod();
  const v = await api(baseUrl, 'payment.void', { companyId: CO, paymentId });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.data.voided, true);
  assert.equal(v.body.data.newStatus, 'posted');
  assert.equal(v.body.data.amountPaid, 0);

  const rev = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM journal_entries WHERE company_id='CT' AND reverses='${batchId}'`);
  assert.ok(Number(rev[0].c) >= 2, 'reversal journal lines exist');

  const bp = await sql(baseUrl, srv.adminToken,
    `SELECT voided_at FROM payments WHERE company_id='CT' AND payment_id='${paymentId}'`);
  assert.ok(bp[0].voided_at, 'payment marked voided (append-only subledger)');

  const bill = await sql(baseUrl, srv.adminToken,
    `SELECT status, amount_paid FROM bills WHERE company_id='CT' AND bill_id='${billId}'`);
  assert.equal(String(bill[0].status), 'posted');
  assert.equal(Number(bill[0].amount_paid), 0);

  const again = await api(baseUrl, 'payment.void', { companyId: CO, paymentId });
  assert.equal(again.status, 409);
  assert.match(again.body.error.message, /already voided/);
});

// ── bank-match-bill-settlement-spec.md ──────────────────────────────────────

test('bank.match Tier 2: home-currency shortfall classifies as partial_payment, not fx_rounding (matchOpenItem hardcoded-USD regression)', async () => {
  // Distinctive, non-round amount — CT accumulates many other tests' open
  // bills (round amounts like 40/60/80/100) across this shared-fixture file,
  // and Tier 2 searches across ALL open bills company-wide; a round amount
  // here risks an exact/tolerance match against a DIFFERENT test's bill.
  const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'MATCH-1', amount: 811.47, lines: [{ description: 'Office supplies', expense_account: EXP, amount: 811.47, vat_code: '' }] }) });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const billId = c.body.data.billId;

  // outstanding 811.47, bank amount 808.47 → delta 3 (pct 0.37%, outside the
  // 1-2% early_payment_discount band; absDelta 3, outside the 5-50
  // bank_fee_netted band) — the only bands left are fx_rounding (currency
  // check) or partial_payment. CT's home currency is SGD (test-utils/
  // helpers.js seedCompany default), so a hardcoded 'USD' home-currency
  // comparison would misclassify this SGD bill as foreign.
  const m = await api(baseUrl, 'bank.match', {
    companyId: CO, bankAccount: '1020',
    line: { date: TD.day21, amount: -808.47, description: 'Acme Pte Ltd payment' },
  });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.data.matched, true);
  assert.equal(m.body.data.tier, 2);
  assert.equal(m.body.data.evidence[0].discrepancy_type, 'partial_payment', 'home-currency shortfall — not fx_rounding');
  assert.equal(m.body.data.evidence[0].bill_id, billId);

  const apLine = m.body.data.lines.find((l) => l.bill_id);
  assert.ok(apLine, 'AP-side line tagged with bill_id (bank-match-bill-settlement-spec §2.1)');
  assert.equal(apLine.bill_id, billId);
  assert.equal(Number(apLine.debit), 808.47);
});

test('bank.match Tier 2: foreign-currency bill never exact-matches, matches fx_rounding instead, bill_id-tagged (§4.4 / §2.3)', async () => {
  await api(baseUrl, 'fx.rates.save', {
    companyId: CO, rates: [{ date: TD.day20, from_currency: 'USD', to_currency: 'SGD', rate: 1.35 }],
  });
  const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'MATCH-FX-1', currency: 'USD', amount: 923.61, lines: [{ description: 'Office supplies', expense_account: EXP, amount: 923.61, vat_code: '' }] }) });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const billId = c.body.data.billId;
  const billRow = await sql(baseUrl, srv.adminToken,
    `SELECT amount_home FROM bills WHERE company_id='CT' AND bill_id='${billId}'`);
  const outstanding = Number(billRow[0].amount_home);

  // Bank amount equal to the booking-rate home-currency value — under the
  // old code this hit the exact-match loop; §4.4 excludes foreign bills
  // from that loop entirely and routes it through the bounded band instead
  // (still matches, since 0% drift is trivially within any positive band).
  const m = await api(baseUrl, 'bank.match', {
    companyId: CO, bankAccount: '1020',
    line: { date: TD.day21, amount: -outstanding, description: 'Acme Pte Ltd payment' },
  });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.data.matched, true, 'the bounded-band path still catches a zero-drift case');
  assert.equal(m.body.data.evidence[0].discrepancy_type, 'fx_rounding', 'never open_item_exact for a foreign bill (§4.4)');
  const apLine = m.body.data.lines.find((l) => l.bill_id === billId);
  assert.ok(apLine, 'AP-side line now tagged with bill_id — §2.3 FX allocation ships this pass');
  assert.equal(m.body.data.lines.length, 2, 'zero drift from the booking rate → no FX gain/loss line needed');
});

test('bank-match-bill-settlement: approving a Tier-2-matched proposal settles the bill, no double-post', async () => {
  const c = await api(baseUrl, 'bill.create', {
    companyId: CO,
    bill: validBill({ vendor_ref: 'SETTLE-1', amount: 654.32, lines: [{ description: 'Office supplies', expense_account: EXP, amount: 654.32, vat_code: '' }] }),
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const billId = c.body.data.billId;

  const m = await api(baseUrl, 'bank.match', {
    companyId: CO, bankAccount: '1020',
    line: { date: TD.day21, amount: -654.32, description: 'Acme Pte Ltd payment' },
  });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.data.matched, true);
  assert.ok(m.body.data.lines.some((l) => l.bill_id === billId), 'matched line tagged with bill_id');

  const propose = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-bankmatch-settle-' + Date.now(),
    lines: m.body.data.lines,
  });
  assert.equal(propose.status, 200, JSON.stringify(propose.body));
  const proposalId = propose.body.data.proposalId;

  const approve = await api(baseUrl, 'journal.approve', { companyId: CO, userEmail: 'owner@ct', proposalId });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  const batchId = approve.body.data.batchId;

  const bill = await sql(baseUrl, srv.adminToken,
    `SELECT status, amount_paid FROM bills WHERE company_id='CT' AND bill_id='${billId}'`);
  assert.equal(String(bill[0].status), 'paid', 'bill settled to paid on approve — the gap this spec closes');
  assert.equal(Number(bill[0].amount_paid), 654.32);

  const bp = await sql(baseUrl, srv.adminToken,
    `SELECT method, batch_id, amount FROM payments WHERE company_id='CT' AND bill_id='${billId}'`);
  assert.equal(bp.length, 1, 'one payments row written');
  assert.equal(String(bp[0].method), 'bank_match');
  assert.equal(String(bp[0].batch_id), batchId, 'payments row links to the batch postJournalBatch already posted — not a second batch');
  assert.equal(Number(bp[0].amount), 654.32);

  // No double-post: the batch postJournalBatch posted has exactly its 2 lines
  // (not 4, which a stray settleBillPayment call would produce). Note this
  // bill_id also appears on a SECOND, earlier batch — the bill's own
  // creation posting (source 'manual', from bill.create) — that's expected:
  // every journal_entries row touching a bill's AP account carries that
  // bill's bill_id for traceability, not just settlement rows. The
  // authoritative "settled exactly once" signal is the single payments
  // row already asserted above, not a bare count of batches referencing
  // bill_id.
  const je = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM journal_entries WHERE company_id='CT' AND batch_id='${batchId}'`);
  assert.equal(Number(je[0].c), 2, 'exactly the 2 lines postJournalBatch posted once');
  const settlementLines = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM journal_entries WHERE company_id='CT' AND batch_id='${batchId}' AND bill_id='${billId}'`);
  assert.equal(Number(settlementLines[0].c), 1, 'exactly one line in the settlement batch is tagged to this bill (the AP line, not the bank line)');
});

// ── bank-matching-spec.md §4.3 / §4.4 ───────────────────────────────────────
// Dedicated fresh company per test, not CT: matchOpenItem's partial_payment
// fallback has no real amount floor beyond "less than outstanding" and
// returns the FIRST qualifying bill in due_date order — against CT's
// hundreds of accumulated bills from every other test in this file, a
// loosely-banded amount can be greedily claimed by an unrelated bill before
// ever reaching the one this test created. Same isolation idiom this file
// already uses for A5/A3j-adjacent tests (CO5, CO_P, etc.).

function bmBill(ap, exp, overrides = {}) {
  return {
    partner_name: 'Acme Pte Ltd', vendor_ref: 'INV-1', date: TD.day20, due_date: TD.day25,
    currency: 'SGD', ap_account: ap, amount: 100,
    lines: [{ description: 'Consulting', expense_account: exp, amount: 100, vat_code: '' }],
    ...overrides,
  };
}

test('bank.match §4.3: bidirectional name corroboration — bank description shorter than the registered vendor name', async () => {
  const CO_BM = 'CBM1';
  const seeded = await seedCompany(baseUrl, CO_BM);
  await grantFor(CO_BM);

  const c = await api(baseUrl, 'bill.create', {
    companyId: CO_BM,
    bill: bmBill(seeded.AP, seeded.EXP, { vendor_ref: 'NS-1', partner_name: 'NorthStar Pte Ltd', amount: 733.19, lines: [{ description: 'Consulting', expense_account: seeded.EXP, amount: 733.19, vat_code: '' }] }),
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const billId = c.body.data.billId;

  // delta 20 (within the 5-50 bank_fee_netted band); description is just
  // "NORTHSTAR" — shorter than "NorthStar Pte Ltd", so the OLD unidirectional
  // check (desc.includes(partner)) could never corroborate this. No ref in
  // the description either, so only the name-corroboration fix is exercised.
  const m = await api(baseUrl, 'bank.match', {
    companyId: CO_BM, bankAccount: '1020',
    line: { date: TD.day21, amount: -713.19, description: 'NORTHSTAR' },
  });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.data.matched, true);
  assert.equal(m.body.data.evidence[0].discrepancy_type, 'bank_fee_netted');
  assert.equal(m.body.data.evidence[0].bill_id, billId);
  // 0.70 base + 0.10 corroboration bump — under the pre-fix unidirectional
  // check this would stay at 0.70 (uncorroborated).
  assert.ok(Math.abs(m.body.data.confidence.account.confidence - 0.80) < 0.001, 'name corroboration via the bidirectional check bumped confidence');
});

test('bank.match §4.4 + §2.3: foreign bill within the FX band, ref-corroborated → fx_rounding, bill_id-tagged, settles on approve', async () => {
  const CO_BM = 'CBM2';
  const seeded = await seedCompany(baseUrl, CO_BM);
  await grantFor(CO_BM);
  await api(baseUrl, 'fx.rates.save', { companyId: CO_BM, rates: [{ date: TD.day20, from_currency: 'USD', to_currency: 'SGD', rate: 1.35 }] });
  // FX Gain/Loss account — required for the proper 3-line booking-rate
  // entry; without one, bank.js deliberately falls back to the untagged
  // path (an unbalanced 2-line entry isn't an option — see bank.js comment).
  const fxAcctRow = await api(baseUrl, 'coa.upsert', {
    companyId: CO_BM,
    account: { account_code: seeded.EXP + '9', account_name: 'FX Gain/Loss', account_type: 'Expense', is_active: true, default_role: 'FX Gain/Loss', effective_from: TD.startDate },
  });
  assert.equal(fxAcctRow.status, 200, JSON.stringify(fxAcctRow.body));
  const c = await api(baseUrl, 'bill.create', {
    companyId: CO_BM,
    bill: bmBill(seeded.AP, seeded.EXP, { vendor_ref: 'FX-2', currency: 'USD', amount: 456.78, lines: [{ description: 'Consulting', expense_account: seeded.EXP, amount: 456.78, vat_code: '' }] }),
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const billId = c.body.data.billId;

  // expected home ≈ 456.78 × 1.35 = 616.65; 647.49 is ~5% above that — well
  // within the default 15% band, above the 50%-of-expected floor (so this
  // is fx_rounding, not partial_payment) — and far enough to require a real
  // FX gain/loss line (30.84), not a negligible-diff freebie.
  const m = await api(baseUrl, 'bank.match', {
    companyId: CO_BM, bankAccount: '1020',
    line: { date: TD.day25, amount: -647.49, description: 'WIRE PAYMENT REF FX-2' },
  });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.data.matched, true);
  assert.equal(m.body.data.tier, 2);
  assert.equal(m.body.data.evidence[0].discrepancy_type, 'fx_rounding');
  assert.equal(m.body.data.evidence[0].bill_id, billId);
  assert.ok(m.body.data.confidence.account.confidence >= 0.75, 'ref-corroborated fx_rounding baseline (0.75) or higher with due-date proximity');
  assert.equal(m.body.data.lines.length, 3, 'AP (booking rate) + FX gain/loss + bank — proper booking-rate entry, not a naive 2-line one');
  assert.ok(m.body.data.lines.every((l) => l.bill_id === billId || l.account_code === '1020'), 'AP and FX lines both tagged, bank line is not');
  const sumDebit = m.body.data.lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const sumCredit = m.body.data.lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  assert.ok(Math.abs(sumDebit - sumCredit) < 0.01, 'balanced entry');
  assert.ok(Math.abs(sumCredit - 647.49) < 0.01, 'total equals the actual bank amount');

  // Propose + approve — the actual gap this closes: does approval settle
  // the bill, not just post a correct-but-inert journal entry?
  const propose = await api(baseUrl, 'journal.propose', {
    companyId: CO_BM, userEmail: 'agent@ct', requestId: 'req-fx-settle-' + Date.now(),
    lines: m.body.data.lines,
  });
  assert.equal(propose.status, 200, JSON.stringify(propose.body));
  const approve = await api(baseUrl, 'journal.approve', { companyId: CO_BM, userEmail: 'owner@ct', proposalId: propose.body.data.proposalId });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  const batchId = approve.body.data.batchId;

  const bill = await sql(baseUrl, srv.adminToken, `SELECT status, amount_paid FROM bills WHERE company_id='${CO_BM}' AND bill_id='${billId}'`);
  assert.equal(String(bill[0].status), 'paid', 'full remaining foreign balance settled → paid');
  assert.ok(Math.abs(Number(bill[0].amount_paid) - 456.78) < 0.01, 'amount_paid tracked in the bill\'s OWN (foreign) currency, not the bank amount');

  const bp = await sql(baseUrl, srv.adminToken, `SELECT method, amount, amount_foreign, batch_id FROM payments WHERE company_id='${CO_BM}' AND bill_id='${billId}'`);
  assert.equal(bp.length, 1);
  assert.equal(String(bp[0].method), 'bank_match');
  assert.ok(Math.abs(Number(bp[0].amount) - 647.49) < 0.01, 'payments.amount is the bank-currency total (AP + FX lines)');
  assert.ok(Math.abs(Number(bp[0].amount_foreign) - 456.78) < 0.01);
  assert.equal(String(bp[0].batch_id), batchId, 'no second/duplicate journal batch');
});

test('bank.match §4.4 + §2.3: foreign bill genuine partial payment → 2-line entry (booking rate, no FX line), bill stays partial', async () => {
  const CO_BM = 'CBM2b';
  const seeded = await seedCompany(baseUrl, CO_BM);
  await grantFor(CO_BM);
  await api(baseUrl, 'fx.rates.save', { companyId: CO_BM, rates: [{ date: TD.day20, from_currency: 'USD', to_currency: 'SGD', rate: 1.35 }] });
  const c = await api(baseUrl, 'bill.create', {
    companyId: CO_BM,
    bill: bmBill(seeded.AP, seeded.EXP, { vendor_ref: 'FX-7', currency: 'USD', amount: 600, lines: [{ description: 'Consulting', expense_account: seeded.EXP, amount: 600, vat_code: '' }] }),
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const billId = c.body.data.billId;

  // expected home = 600 × 1.35 = 810; 324 is 40% of that — below the 50%
  // floor, so partial_payment (not fx_rounding). partial_payment assumes
  // the booking rate applies (no independent way to separate "how much"
  // from "what rate" off one number), so this should be a clean 2-line
  // entry, not 3.
  const m = await api(baseUrl, 'bank.match', {
    companyId: CO_BM, bankAccount: '1020',
    line: { date: TD.day21, amount: -324, description: 'WIRE PAYMENT REF FX-7' },
  });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.data.evidence[0].discrepancy_type, 'partial_payment');
  assert.equal(m.body.data.lines.length, 2, 'no FX line — booking rate assumed, zero implied diff');
  assert.ok(m.body.data.lines.some((l) => l.bill_id === billId));

  const propose = await api(baseUrl, 'journal.propose', {
    companyId: CO_BM, userEmail: 'agent@ct', requestId: 'req-fx-partial-' + Date.now(),
    lines: m.body.data.lines,
  });
  assert.equal(propose.status, 200, JSON.stringify(propose.body));
  const approve = await api(baseUrl, 'journal.approve', { companyId: CO_BM, userEmail: 'owner@ct', proposalId: propose.body.data.proposalId });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));

  const bill = await sql(baseUrl, srv.adminToken, `SELECT status, amount_paid FROM bills WHERE company_id='${CO_BM}' AND bill_id='${billId}'`);
  assert.equal(String(bill[0].status), 'partial', 'well short of the full 600 owed');
  // 324 home ÷ 1.35 booking rate = 240 foreign
  assert.ok(Math.abs(Number(bill[0].amount_paid) - 240) < 0.01, 'amount_paid tracked in foreign currency, derived via the booking rate');
});

test('Thread D: settlement.blocked when no FX Gain/Loss account — journal.approve refuses (banner-worthy VALIDATION), no posting, bill untouched', async () => {
  const CO_BM = 'CBM10';
  const seeded = await seedCompany(baseUrl, CO_BM);
  await grantFor(CO_BM);
  await api(baseUrl, 'fx.rates.save', { companyId: CO_BM, rates: [{ date: TD.day20, from_currency: 'USD', to_currency: 'SGD', rate: 1.35 }] });
  // Deliberately NO FX Gain/Loss account — this is the missing-setup case.
  const c = await api(baseUrl, 'bill.create', {
    companyId: CO_BM,
    bill: bmBill(seeded.AP, seeded.EXP, { vendor_ref: 'FX-10', currency: 'USD', amount: 456.78, lines: [{ description: 'Consulting', expense_account: seeded.EXP, amount: 456.78, vat_code: '' }] }),
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const billId = c.body.data.billId;

  const m = await api(baseUrl, 'bank.match', {
    companyId: CO_BM, bankAccount: '1020',
    line: { date: TD.day25, amount: -647.49, description: 'WIRE PAYMENT REF FX-10' },
  });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.data.evidence[0].discrepancy_type, 'fx_rounding');
  assert.ok(m.body.data.settlement && m.body.data.settlement.blocked, 'no FX Gain/Loss account configured → blocked');
  assert.equal(m.body.data.settlement.billId, billId);
  assert.ok(/FX Gain\/Loss/.test(m.body.data.settlement.blockedReason || ''), 'reason names the missing setup');
  assert.ok(!m.body.data.lines.some((l) => l.bill_id === billId), 'blocked → falls back to the untagged path, no bill_id tag');

  // Mirrors how agent-loop.js threads match.settlement into _match_meta —
  // these tests call journal.propose directly, not via agent-loop.
  const propose = await api(baseUrl, 'journal.propose', {
    companyId: CO_BM, userEmail: 'agent@ct', requestId: 'req-fx-blocked-' + Date.now(),
    lines: m.body.data.lines, _match_meta: { settlement: m.body.data.settlement },
  });
  assert.equal(propose.status, 200, JSON.stringify(propose.body));

  const approve = await api(baseUrl, 'journal.approve', { companyId: CO_BM, userEmail: 'owner@ct', proposalId: propose.body.data.proposalId });
  assert.notEqual(approve.status, 200, 'blocked settlement must refuse approval');
  assert.ok(/FX Gain\/Loss/.test((approve.body.error && approve.body.error.message) || ''), 'error message carries the blockedReason for the banner');

  const bill = await sql(baseUrl, srv.adminToken, `SELECT status, amount_paid FROM bills WHERE company_id='${CO_BM}' AND bill_id='${billId}'`);
  assert.equal(String(bill[0].status), 'posted', 'refused approval must not touch the bill (still unpaid, not open/partial/paid)');
  assert.equal(Number(bill[0].amount_paid), 0);
  const proposalRow = await sql(baseUrl, srv.adminToken, `SELECT status FROM journal_proposals WHERE company_id='${CO_BM}' AND proposal_id='${propose.body.data.proposalId}'`);
  assert.equal(String(proposalRow[0].status), 'proposed', 'the atomic claim must not have transitioned — no partial post left behind');
});

test('Thread D: bank.match.toggleSettlement flips full→partial (and back), rebuilding AP/FX lines against the same bank amount', async () => {
  const CO_BM = 'CBM11';
  const seeded = await seedCompany(baseUrl, CO_BM);
  await grantFor(CO_BM);
  await api(baseUrl, 'fx.rates.save', { companyId: CO_BM, rates: [{ date: TD.day20, from_currency: 'USD', to_currency: 'SGD', rate: 1.35 }] });
  const fxAcctRow = await api(baseUrl, 'coa.upsert', {
    companyId: CO_BM,
    account: { account_code: seeded.EXP + '9', account_name: 'FX Gain/Loss', account_type: 'Expense', is_active: true, default_role: 'FX Gain/Loss', effective_from: TD.startDate },
  });
  assert.equal(fxAcctRow.status, 200, JSON.stringify(fxAcctRow.body));
  const c = await api(baseUrl, 'bill.create', {
    companyId: CO_BM,
    bill: bmBill(seeded.AP, seeded.EXP, { vendor_ref: 'FX-9', currency: 'USD', amount: 600, lines: [{ description: 'Consulting', expense_account: seeded.EXP, amount: 600, vat_code: '' }] }),
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const billId = c.body.data.billId;

  // expected home = 600 × 1.35 = 810; 750 is ~92.6% of that (in-band, above
  // the 50% fx_rounding/partial_payment floor) → default mode 'full'.
  const m = await api(baseUrl, 'bank.match', {
    companyId: CO_BM, bankAccount: '1020',
    line: { date: TD.day25, amount: -750, description: 'WIRE PAYMENT REF FX-9' },
  });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.data.evidence[0].discrepancy_type, 'fx_rounding');
  assert.equal(m.body.data.settlement.blocked, false);
  assert.equal(m.body.data.settlement.mode, 'full', 'fx_rounding defaults to full settlement');

  const propose = await api(baseUrl, 'journal.propose', {
    companyId: CO_BM, userEmail: 'agent@ct', requestId: 'req-fx-toggle-' + Date.now(),
    lines: m.body.data.lines, _match_meta: { settlement: m.body.data.settlement },
  });
  assert.equal(propose.status, 200, JSON.stringify(propose.body));
  const proposalId = propose.body.data.proposalId;

  const toggle1 = await api(baseUrl, 'bank.match.toggleSettlement', { companyId: CO_BM, userEmail: 'owner@ct', proposalId, billId });
  assert.equal(toggle1.status, 200, JSON.stringify(toggle1.body));
  assert.equal(toggle1.body.data.mode, 'partial');

  const afterToggle1 = await sql(baseUrl, srv.adminToken, `SELECT lines, match_meta FROM journal_proposals WHERE company_id='${CO_BM}' AND proposal_id='${proposalId}'`);
  const linesAfter1 = JSON.parse(afterToggle1[0].lines);
  const metaAfter1 = JSON.parse(afterToggle1[0].match_meta);
  assert.equal(metaAfter1.settlement.mode, 'partial');
  // 750 booked at the booking rate (1.35, no independent FX diff assumed in
  // partial mode) → clean 2-line entry, same bank total as before.
  assert.equal(linesAfter1.length, 2, 'partial mode: booking-rate assumed, no FX line');
  const sumDebit1 = linesAfter1.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const sumCredit1 = linesAfter1.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  assert.ok(Math.abs(sumDebit1 - sumCredit1) < 0.01, 'toggled entry still balances');
  assert.ok(Math.abs(sumCredit1 - 750) < 0.01, 'bank-side total unchanged by the toggle (bankShare invariant)');

  // Toggle back to full — should reconstruct the original 3-line entry.
  const toggle2 = await api(baseUrl, 'bank.match.toggleSettlement', { companyId: CO_BM, userEmail: 'owner@ct', proposalId, billId });
  assert.equal(toggle2.status, 200, JSON.stringify(toggle2.body));
  assert.equal(toggle2.body.data.mode, 'full');

  const approve = await api(baseUrl, 'journal.approve', { companyId: CO_BM, userEmail: 'owner@ct', proposalId });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  const bill = await sql(baseUrl, srv.adminToken, `SELECT status, amount_paid FROM bills WHERE company_id='${CO_BM}' AND bill_id='${billId}'`);
  assert.equal(String(bill[0].status), 'paid', 'toggled back to full before approval → full remaining balance settled');
  assert.ok(Math.abs(Number(bill[0].amount_paid) - 600) < 0.01);
});

test('bank.match §4.4: foreign bill in-band but uncorroborated → no match (gate, not a confidence bonus)', async () => {
  const CO_BM = 'CBM3';
  const seeded = await seedCompany(baseUrl, CO_BM);
  await grantFor(CO_BM);
  await api(baseUrl, 'fx.rates.save', { companyId: CO_BM, rates: [{ date: TD.day20, from_currency: 'USD', to_currency: 'SGD', rate: 1.35 }] });
  const c = await api(baseUrl, 'bill.create', {
    companyId: CO_BM,
    bill: bmBill(seeded.AP, seeded.EXP, { vendor_ref: 'FX-3', currency: 'USD', amount: 567.89, lines: [{ description: 'Consulting', expense_account: seeded.EXP, amount: 567.89, vat_code: '' }] }),
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));

  // expected home ≈ 567.89 × 1.35 = 766.65; 800 is within the 15% band, but
  // the description names neither the vendor nor the invoice ref.
  const m = await api(baseUrl, 'bank.match', {
    companyId: CO_BM, bankAccount: '1020',
    line: { date: TD.day21, amount: -800, description: 'MISC OUTGOING WIRE' },
  });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.data.matched, false, 'amount alone is not enough evidence at a 15% band — corroboration gates it');
});

test('bank.match §4.4: foreign bill outside the band even with corroboration → no match', async () => {
  const CO_BM = 'CBM4';
  const seeded = await seedCompany(baseUrl, CO_BM);
  await grantFor(CO_BM);
  await api(baseUrl, 'fx.rates.save', { companyId: CO_BM, rates: [{ date: TD.day20, from_currency: 'USD', to_currency: 'SGD', rate: 1.35 }] });
  const c = await api(baseUrl, 'bill.create', {
    companyId: CO_BM,
    bill: bmBill(seeded.AP, seeded.EXP, { vendor_ref: 'FX-4', currency: 'USD', amount: 678.90, lines: [{ description: 'Consulting', expense_account: seeded.EXP, amount: 678.90, vat_code: '' }] }),
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));

  // expected home ≈ 678.90 × 1.35 = 916.52; expected max at 15% ≈ 1053.99.
  // 1200 is well beyond that even though the ref is right there in the
  // description — the band gate is checked before corroboration runs at all.
  const m = await api(baseUrl, 'bank.match', {
    companyId: CO_BM, bankAccount: '1020',
    line: { date: TD.day21, amount: -1200, description: 'WIRE PAYMENT REF FX-4' },
  });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.data.matched, false, 'outside the band, corroboration or not');
});

test('bank.match §4.4: two equally-plausible foreign bills → ambiguous, no match (candidate cardinality)', async () => {
  const CO_BM = 'CBM5';
  const seeded = await seedCompany(baseUrl, CO_BM);
  await grantFor(CO_BM);
  await api(baseUrl, 'fx.rates.save', { companyId: CO_BM, rates: [{ date: TD.day20, from_currency: 'USD', to_currency: 'SGD', rate: 1.35 }] });
  const billBody = () => bmBill(seeded.AP, seeded.EXP, { partner_name: 'Ambiguous Vendor Ltd', currency: 'USD', amount: 789.01, lines: [{ description: 'Consulting', expense_account: seeded.EXP, amount: 789.01, vat_code: '' }] });
  const c1 = await api(baseUrl, 'bill.create', { companyId: CO_BM, bill: { ...billBody(), vendor_ref: 'FX-6A' } });
  const c2 = await api(baseUrl, 'bill.create', { companyId: CO_BM, bill: { ...billBody(), vendor_ref: 'FX-6B' } });
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  assert.equal(c2.status, 200, JSON.stringify(c2.body));

  // Same vendor, same amount, same currency — both bills' bands cover this
  // line, and the description corroborates both via the shared vendor name
  // (it names neither ref specifically). Genuinely ambiguous which bill
  // this payment is for.
  const m = await api(baseUrl, 'bank.match', {
    companyId: CO_BM, bankAccount: '1020',
    line: { date: TD.day21, amount: -1065.16, description: 'PAYMENT TO AMBIGUOUS VENDOR LTD' },
  });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.data.matched, false, 'two bills both fit and both corroborate — falls through rather than guessing');
});

test('fx_match_band_pct is a Settings → Extensions attribute and actually changes match behavior', async () => {
  const CO_BM = 'CBM6';
  const seeded = await seedCompany(baseUrl, CO_BM);
  await grantFor(CO_BM);

  const list = await api(baseUrl, 'posting_rules.attr.list', { companyId: CO_BM });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const row = list.body.data.find((r) => r.key === 'fx_match_band_pct');
  assert.ok(row, 'fx_match_band_pct row present in Settings → Extensions');
  assert.equal(row.display, '15.00%', 'defaults to 15%');

  await api(baseUrl, 'fx.rates.save', { companyId: CO_BM, rates: [{ date: TD.day20, from_currency: 'USD', to_currency: 'SGD', rate: 1.35 }] });
  const c = await api(baseUrl, 'bill.create', {
    companyId: CO_BM,
    bill: bmBill(seeded.AP, seeded.EXP, { vendor_ref: 'FX-5', currency: 'USD', amount: 890.12, lines: [{ description: 'Consulting', expense_account: seeded.EXP, amount: 890.12, vat_code: '' }] }),
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));

  // expected home ≈ 890.12 × 1.35 = 1201.66; 1321.83 is ~10% above that —
  // inside the default 15% band, outside a tightened 5% band.
  const line = { date: TD.day21, amount: -1321.83, description: 'WIRE PAYMENT REF FX-5' };
  const before = await api(baseUrl, 'bank.match', { companyId: CO_BM, bankAccount: '1020', line });
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.equal(before.body.data.matched, true, 'a 10% drift matches at the default 15% band');

  const save = await api(baseUrl, 'posting_rules.attr.save', { companyId: CO_BM, key: 'fx_match_band_pct', value: 5 });
  assert.equal(save.status, 200, JSON.stringify(save.body));

  const after = await api(baseUrl, 'bank.match', { companyId: CO_BM, bankAccount: '1020', line });
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.equal(after.body.data.matched, false, 'the same 10% drift no longer matches once the band is tightened to 5%');
});

test('bank.match §4.1: two equally-plausible home-currency bills → ambiguous, no match (candidate cardinality, issue #133)', async () => {
  const CO_BM = 'CBM7';
  const seeded = await seedCompany(baseUrl, CO_BM);
  await grantFor(CO_BM);

  // Same amount, different vendors, neither corroborated by the bank
  // description — both bills' early_payment_discount band (1.5% below
  // 900.00) covers this line equally. Genuinely ambiguous which bill this
  // payment is for; corroboration only boosts confidence on this path, it
  // doesn't gate, so the ambiguity must be caught before either bill is
  // returned.
  const c1 = await api(baseUrl, 'bill.create', { companyId: CO_BM, bill: bmBill(seeded.AP, seeded.EXP, { partner_name: 'Vendor Alpha Pte Ltd', vendor_ref: 'HA-1', amount: 900, lines: [{ description: 'Consulting', expense_account: seeded.EXP, amount: 900, vat_code: '' }] }) });
  const c2 = await api(baseUrl, 'bill.create', { companyId: CO_BM, bill: bmBill(seeded.AP, seeded.EXP, { partner_name: 'Vendor Beta Pte Ltd', vendor_ref: 'HB-1', amount: 900, lines: [{ description: 'Consulting', expense_account: seeded.EXP, amount: 900, vat_code: '' }] }) });
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  assert.equal(c2.status, 200, JSON.stringify(c2.body));

  const m = await api(baseUrl, 'bank.match', {
    companyId: CO_BM, bankAccount: '1020',
    line: { date: TD.day21, amount: -886.50, description: 'MISC PAYMENT' },
  });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.data.matched, false, 'two bills both fit the same tolerance band — falls through rather than guessing');
});

test('bill_match_tolerance_pct is a Settings → Extensions attribute and actually changes match classification (issue #133)', async () => {
  const CO_BM = 'CBM8';
  const seeded = await seedCompany(baseUrl, CO_BM);
  await grantFor(CO_BM);

  const list = await api(baseUrl, 'posting_rules.attr.list', { companyId: CO_BM });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const row = list.body.data.find((r) => r.key === 'bill_match_tolerance_pct');
  assert.ok(row, 'bill_match_tolerance_pct row present in Settings → Extensions');
  assert.equal(row.display, '2.00%', 'defaults to 2%');

  const c = await api(baseUrl, 'bill.create', { companyId: CO_BM, bill: bmBill(seeded.AP, seeded.EXP, { vendor_ref: 'TOL-1', amount: 2000, lines: [{ description: 'Consulting', expense_account: seeded.EXP, amount: 2000, vat_code: '' }] }) });
  assert.equal(c.status, 200, JSON.stringify(c.body));

  // delta 60 on outstanding 2000 → pct 3%: outside the default 2% early-
  // payment-discount band and outside the flat 5-50 bank_fee_netted band
  // (60 > 50) → falls to partial_payment (0.50). Uncorroborated description.
  const line = { date: TD.day21, amount: -1940.00, description: 'MISC WIRE TRANSFER' };
  const before = await api(baseUrl, 'bank.match', { companyId: CO_BM, bankAccount: '1020', line });
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.equal(before.body.data.matched, true);
  assert.equal(before.body.data.evidence[0].discrepancy_type, 'partial_payment', 'a 3% shortfall is outside the default 2% tolerance');
  assert.ok(Math.abs(before.body.data.confidence.account.confidence - 0.50) < 0.001);

  const save = await api(baseUrl, 'posting_rules.attr.save', { companyId: CO_BM, key: 'bill_match_tolerance_pct', value: 5 });
  assert.equal(save.status, 200, JSON.stringify(save.body));

  const after = await api(baseUrl, 'bank.match', { companyId: CO_BM, bankAccount: '1020', line });
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.equal(after.body.data.evidence[0].discrepancy_type, 'early_payment_discount', 'the same 3% shortfall now fits once the tolerance is widened to 5%');
  assert.ok(Math.abs(after.body.data.confidence.account.confidence - 0.85) < 0.001);
});

// ── A1: agent actor model (§2) ──────────────────────────────────────────────

test('A1 guard matrix: agent FORBIDDEN on every mutating catalog action', async () => {
  // Spec §2.3 default-deny: iterate every catalog action flagged mutating,
  // call as the agent user, and assert 403/FORBIDDEN for each. The guard
  // runs before param validation, so missing params don't leak a 400.
  // The agent-writable actions (those carrying agentWritable:true in the
  // catalog — the single source of truth for dispatch's AGENT_ALLOWED set,
  // see api/src/action-catalog.js + api/src/index.js) are excluded from the
  // default-deny assertion here, since they pass the guard by design. Their
  // admittance is exercised by the A3j propose tests, the attachment.upload
  // hardening tests, and the dedicated Phase B agent-writable tests below.
  const AGENT_WHITELIST = new Set(Object.entries(ACTIONS).filter(([, m]) => m.agentWritable).map(([name]) => name));
  const mutatingActions = Object.entries(ACTIONS)
    .filter(([, m]) => m.mutating === true)
    .map(([name]) => name)
    .filter((name) => !AGENT_WHITELIST.has(name));
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
  // Spec §8.1 fail-closed proof, using the test.fail_closed_fixture catalog
  // entry (action-catalog.js — no handler, exists solely for this test) —
  // mutating:true at role viewer, so the agent (level 1.5 ≥ 1) PASSES the
  // numeric role check, isolating the §2.3 whitelist guard as the only thing
  // that can deny it. This exercises the exact path any FUTURE new mutating
  // action will hit: not in AGENT_ALLOWED → FORBIDDEN, by default, until
  // explicitly whitelisted. This file is a black-box HTTP test against a
  // spawned server process (see header comment), so this fixture can't be
  // injected here at test time — it has to be a real catalog entry the
  // spawned process itself loads.
  const { status, body } = await api(baseUrl, 'test.fail_closed_fixture', { companyId: CO, userEmail: 'agent@ct' });
  assert.equal(status, 403, 'mutating action outside the whitelist must be denied to agents');
  assert.equal(body?.error?.code, 'FORBIDDEN');
  assert.match(body?.error?.message, /finalize or mutate master data/,
    'denial must come from the whitelist guard, not the role check (agent passes the role check at viewer level)');

  // Sanity: a human data_entry user reaches past the guard (there's no real
  // handler behind this fixture — module 'test' hits dispatch's default case,
  // 'Unknown module' — anything except the guard's FORBIDDEN proves the
  // guard is actor-class-specific, R6 eligibility is server-side).
  const hr = await api(baseUrl, 'test.fail_closed_fixture', { companyId: CO, userEmail: 'owner@ct' });
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
  const r = await api(baseUrl, 'posting_rules.attr.save', {
    companyId: CO, userEmail: 'owner@ct', requestId: 'req-owner-a1',
    key: 'vat_tolerance', value: 1.01,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT actor_type, request_id, changed_by FROM audit_log
     WHERE company_id='CT' AND request_id='req-owner-a1'
       AND table_name='api' AND record_id='posting_rules.attr.save'`);
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
  const fr = await api(baseUrl, 'posting_rules.attr.save', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-agent-a1',
    key: 'vat_tolerance', value: 2.0,
  });
  assert.equal(fr.status, 403);
  assert.equal(fr.body.error.code, 'FORBIDDEN');
  const agentRows = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM audit_log WHERE company_id='CT' AND request_id='req-agent-a1'`);
  assert.equal(Number(agentRows[0].c), 0, 'forbidden agent call writes no audit row (guard before audit)');
});

// ── A2: event emission + event.list (§3, §8 items 5-6) ─────────────────────

// Helper: fetch event rows for a given type/entity from the events table.
async function eventsFor(type, entityId) {
  // admin sql() takes raw SQL only (no bound params) — values are
  // test-controlled literals (dot event types, uuids), safe to inline.
  return sql(baseUrl, srv.adminToken,
    `SELECT event_seq, event_type, entity_type, entity_id, actor_type, actor_id, request_id, payload
     FROM events WHERE company_id='CT' AND event_type='${type}' AND entity_id='${entityId}'
     ORDER BY event_seq`);
}

test('A2: journal.post emits journal.posted once with correct entity + actor fields', async () => {
  const rid = 'req-journal-posted-' + Date.now();
  const posted = await api(baseUrl, 'journal.post', {
    companyId: CO, userEmail: 'owner@ct', requestId: rid,
    lines: [
      { account_code: EXP, debit: 33, date: TD.day20, description: 'A2 journal' },
      { account_code: AP, credit: 33, date: TD.day20, description: 'A2 journal' },
    ],
  });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const batchId = posted.body.data.batchId;

  const rows = await eventsFor('journal.posted', batchId);
  assert.equal(rows.length, 1, 'exactly one journal.posted event');
  const ev = rows[0];
  assert.equal(ev.entity_type, 'journal');
  assert.equal(ev.entity_id, batchId);
  assert.equal(ev.actor_type, 'human', 'owner call → actor_type human');
  assert.equal(ev.actor_id, 'owner@ct');
  assert.equal(ev.request_id, rid, 'request_id stamped from body.requestId');
  const payload = JSON.parse(ev.payload);
  assert.equal(payload.lineCount, 2);
  assert.equal(payload.totalDebit, 33);
  assert.equal(payload.currency, 'SGD');
  assert.ok(payload.date && payload.reference !== undefined, 'payload carries date + reference');
});

test('A2: idempotent replay of journal.post emits ONE journal.posted (R4)', async () => {
  const idemKey = 'a2-r4-' + Date.now();
  const payload = {
    companyId: CO, userEmail: 'owner@ct', requestId: 'req-r4',
    lines: [
      { account_code: EXP, debit: 12, date: TD.day20, description: 'R4' },
      { account_code: AP, credit: 12, date: TD.day20, description: 'R4' },
    ],
  };
  const first = await api(baseUrl, 'journal.post', payload, { 'Idempotency-Key': idemKey });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const replay = await api(baseUrl, 'journal.post', payload, { 'Idempotency-Key': idemKey });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('idempotent-replay'), 'true', 'replay short-circuited');
  assert.equal(replay.body.data.batchId, first.body.data.batchId, 'same batchId');

  const rows = await eventsFor('journal.posted', first.body.data.batchId);
  assert.equal(rows.length, 1, 'R4: idempotent replay must not double-emit (handler never ran on replay)');
});

test('A2: event.list — ordering asc, after_seq polling, type filter', async () => {
  // Capture the current high-water mark, then post a fresh journal.
  const before = await api(baseUrl, 'event.list', { companyId: CO, limit: 500 });
  assert.equal(before.status, 200, JSON.stringify(before.body));
  const list = before.body.data;
  assert.ok(Array.isArray(list), 'event.list returns an array');
  // Ordering: ascending by event_seq.
  for (let i = 1; i < list.length; i++) {
    assert.ok(Number(list[i].event_seq) >= Number(list[i - 1].event_seq), 'ascending order');
  }
  const highWater = list.length > 0 ? Number(list[list.length - 1].event_seq) : 0;

  const posted = await api(baseUrl, 'journal.post', {
    companyId: CO, userEmail: 'owner@ct', requestId: 'req-poll',
    lines: [
      { account_code: EXP, debit: 9, date: TD.day20, description: 'poll' },
      { account_code: AP, credit: 9, date: TD.day20, description: 'poll' },
    ],
  });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));

  // after_seq polling: only rows newer than highWater come back.
  const poll = await api(baseUrl, 'event.list', { companyId: CO, after_seq: highWater, limit: 500 });
  assert.equal(poll.status, 200, JSON.stringify(poll.body));
  const polled = poll.body.data;
  assert.ok(polled.length >= 1, 'polling returns at least the new event');
  assert.ok(polled.every((r) => Number(r.event_seq) > highWater), 'all polled rows are newer than after_seq');
  const jp = polled.find((r) => r.event_type === 'journal.posted' && r.entity_id === posted.body.data.batchId);
  assert.ok(jp, 'the freshly posted batch appears in the poll');

  // type filter: request only journal.posted → no other event types leak.
  const filtered = await api(baseUrl, 'event.list', { companyId: CO, type: 'journal.posted', limit: 500 });
  assert.equal(filtered.status, 200, JSON.stringify(filtered.body));
  const frows = filtered.body.data;
  assert.ok(frows.length >= 1, 'journal.posted rows exist');
  assert.ok(frows.every((r) => r.event_type === 'journal.posted'), 'type filter excludes other event types');
});

test('A2: event.list limit cap — request 9999 is capped at 500', async () => {
  // Seed 501 synthetic event rows via admin SQL (the events table is the
  // contract surface; how rows arrive is not). This proves the LIMIT ceiling
  // without 501 HTTP action round-trips.
  const baseSeq = Date.now();
  const values = [];
  for (let i = 0; i < 501; i++) {
    values.push(`('CT','journal.posted','journal','cap-${baseSeq}-${i}','human','cap@ct','req-cap-${baseSeq}','{}')`);
  }
  // DuckDB: multi-row INSERT in chunks to keep the statement well-formed.
  const CHUNK = 100;
  for (let s = 0; s < values.length; s += CHUNK) {
    const slice = values.slice(s, s + CHUNK).join(',');
    await sql(baseUrl, srv.adminToken,
      `INSERT INTO events (company_id, event_type, entity_type, entity_id, actor_type, actor_id, request_id, payload)
       VALUES ${slice}`);
  }

  const r = await api(baseUrl, 'event.list', { companyId: CO, limit: 9999 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.data.length <= 500, `limit 9999 capped at 500 (got ${r.body.data.length})`);
  assert.equal(r.body.data.length, 500, 'exactly 500 returned when >500 exist and limit=9999');
  // Ordering preserved even at the cap.
  for (let i = 1; i < r.body.data.length; i++) {
    assert.ok(Number(r.body.data[i].event_seq) >= Number(r.body.data[i - 1].event_seq), 'capped list still ascending');
  }
});

test('A2: period.locked / period.unlocked emit on transition (second call site)', async () => {
  // Create a fresh period (born unlocked — no event on creation).
  const pid = 'A2-' + Date.now();
  const create = await api(baseUrl, 'period.upsert', {
    companyId: CO, period: { period_id: pid, start_date: TD.nextMonthStart, end_date: TD.nextMonthEnd, locked: false },
  });
  assert.equal(create.status, 200, JSON.stringify(create.body));
  let born = await eventsFor('period.locked', pid);
  assert.equal(born.length, 0, 'a period born unlocked emits no event');

  // Lock it → period.locked.
  const lock = await api(baseUrl, 'period.upsert', {
    companyId: CO, period: { period_id: pid, start_date: TD.nextMonthStart, end_date: TD.nextMonthEnd, locked: true },
  });
  assert.equal(lock.status, 200, JSON.stringify(lock.body));
  let locked = await eventsFor('period.locked', pid);
  assert.equal(locked.length, 1, 'period.locked emitted on unlocked→locked transition');
  assert.equal(locked[0].actor_type, 'human');

  // Re-lock (no transition) → no new event.
  await api(baseUrl, 'period.upsert', {
    companyId: CO, period: { period_id: pid, start_date: TD.nextMonthStart, end_date: TD.nextMonthEnd, locked: true },
  });
  locked = await eventsFor('period.locked', pid);
  assert.equal(locked.length, 1, 'locked→locked is not a transition (no new event)');

  // Unlock → period.unlocked.
  const unlock = await api(baseUrl, 'period.upsert', {
    companyId: CO, period: { period_id: pid, start_date: TD.nextMonthStart, end_date: TD.nextMonthEnd, locked: false },
  });
  assert.equal(unlock.status, 200, JSON.stringify(unlock.body));
  const unlocked = await eventsFor('period.unlocked', pid);
  assert.equal(unlocked.length, 1, 'period.unlocked emitted on locked→unlocked transition');
});

test('A2: attachment.uploaded stamps agent actor_type (R3) on the /api/upload route', async () => {
  // The upload route sits outside the action API, so its emitEvent ctx is
  // built from the request — the actor class must still come from the DB
  // role (resolveActor), never asserted/hardcoded. Upload as the seeded
  // agent account → actor_type 'agent', request_id from X-Request-Id.
  const fd = new FormData();
  fd.append('companyId', CO);
  fd.append('entityType', 'journal');
  fd.append('entityId', 'a2-upload-test');
  fd.append('uploadedBy', 'agent@ct');
  fd.append('file', new Blob(['a2 upload test'], { type: 'text/plain' }), 'a2-upload.txt');
  const r = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: { 'X-Request-Id': 'req-upload-a2' },
    body: fd,
  });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().text()));
  const up = await r.json();
  const attachmentId = up.data.attachment_id;
  assert.ok(attachmentId, 'upload returns attachment_id');

  try {
    const rows = await eventsFor('attachment.uploaded', attachmentId);
    assert.equal(rows.length, 1, 'attachment.uploaded emitted');
    assert.equal(rows[0].actor_type, 'agent', 'agent account upload stamps actor_type agent (not misattributed human)');
    assert.equal(rows[0].actor_id, 'agent@ct');
    assert.equal(rows[0].request_id, 'req-upload-a2', 'request_id from X-Request-Id header');
    const payload = JSON.parse(rows[0].payload);
    assert.equal(payload.filename, 'a2-upload.txt');
  } finally {
    // Clean up file + row through the API (owner action).
    const del = await api(baseUrl, 'attachment.delete', { companyId: CO, userEmail: 'owner@ct', attachmentId });
    assert.equal(del.status, 200, JSON.stringify(del.body));
  }
});

// ── A3j: journal proposal prepare/approve flow (§4, §8 items 2-5, 8) ────────

// Helper: fetch proposal rows from journal_proposals via admin SQL (raw SQL,
// test-controlled literals — safe to inline).
async function proposalsFor(proposalId) {
  return sql(baseUrl, srv.adminToken,
    `SELECT proposal_id, journal_id, date, reference, description, source, status,
            batch_id, created_by, request_id, reviewed_by, reviewed_at, review_note,
            created_at, updated_at
     FROM journal_proposals WHERE company_id='CT' AND proposal_id='${proposalId}'`);
}

// Balanced 2-line batch used across the A3j tests. Agent proposes this shape.
function proposalLines(amount = 50, date = TD.day20) {
  return [
    { account_code: EXP, debit: amount, date, description: 'A3j expense' },
    { account_code: AP, credit: amount, date, description: 'A3j expense' },
  ];
}

test('A3j happy path: agent propose → owner approve posts with human created_by + events', async () => {
  // Agent proposes → 200 + proposalId.
  const rid = 'req-a3j-happy-' + Date.now();
  const propose = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: 'agent@ct', requestId: rid,
    lines: proposalLines(50),
  });
  assert.equal(propose.status, 200, JSON.stringify(propose.body));
  const proposalId = propose.body.data.proposalId;
  assert.ok(proposalId, 'propose returns proposalId');
  assert.ok(Array.isArray(propose.body.data.warnings), 'warnings array present');

  // Nothing reached journal_entries yet (R5).
  const pre = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM journal_entries WHERE company_id='CT' AND created_by='agent@ct'`);
  assert.equal(Number(pre[0].c), 0, 'agent propose writes NO journal_entries rows');

  // journal.proposal.get shows enriched lines + agent created_by.
  const get = await api(baseUrl, 'journal.proposal.get', { companyId: CO, proposalId });
  assert.equal(get.status, 200, JSON.stringify(get.body));
  const p = get.body.data;
  assert.ok(Array.isArray(p.lines) && p.lines.length === 2, 'enriched lines parsed');
  assert.equal(p.created_by, 'agent@ct', 'proposal created_by = agent (origin)');
  assert.equal(p.status, 'proposed');
  assert.equal(p.source, 'agent', 'agent caller → source agent');
  assert.equal(p.request_id, rid, 'request_id stamped from body.requestId');
  assert.ok(p.lines[0].debit_home != null && p.lines[0].fx_rate != null, 'lines enriched');

  // Agent is FORBIDDEN from approve/reject (whitelist excludes them — §2.3).
  const agentApprove = await api(baseUrl, 'journal.approve', { companyId: CO, userEmail: 'agent@ct', proposalId });
  assert.equal(agentApprove.status, 403, 'agent may not approve');
  assert.equal(agentApprove.body.error.code, 'FORBIDDEN');
  const agentReject = await api(baseUrl, 'journal.reject', { companyId: CO, userEmail: 'agent@ct', proposalId, note: 'x' });
  assert.equal(agentReject.status, 403, 'agent may not reject');
  assert.equal(agentReject.body.error.code, 'FORBIDDEN');

  // Owner approves → journal_entries rows exist with created_by='owner@ct'.
  const approve = await api(baseUrl, 'journal.approve', {
    companyId: CO, userEmail: 'owner@ct', proposalId, note: 'looks good',
  });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  const batchId = approve.body.data.batchId;
  assert.ok(batchId, 'approve returns batchId');

  const je = await sql(baseUrl, srv.adminToken,
    `SELECT created_by, source FROM journal_entries WHERE company_id='CT' AND batch_id='${batchId}' LIMIT 1`);
  assert.equal(je.length, 1, 'posted journal entries exist');
  assert.equal(String(je[0].created_by), 'owner@ct', 'created_by is the HUMAN poster, not the agent');
  assert.equal(String(je[0].source), 'proposal', 'source marks proposal origin');

  // Proposal row: status 'posted', reviewed_by='owner@ct', batch_id set.
  const prows = await proposalsFor(proposalId);
  assert.equal(prows.length, 1);
  assert.equal(String(prows[0].status), 'posted');
  assert.equal(String(prows[0].reviewed_by), 'owner@ct');
  assert.equal(String(prows[0].batch_id), batchId, 'proposal batch_id links to posted batch');
  assert.equal(String(prows[0].review_note), 'looks good');

  // Events: exactly ONE journal.proposed, ONE journal.approved, ONE journal.posted.
  const proposedEv = await eventsFor('journal.proposed', proposalId);
  assert.equal(proposedEv.length, 1, 'exactly one journal.proposed event');
  assert.equal(proposedEv[0].actor_type, 'agent', 'proposed event stamped agent actor_type');
  const approvedEv = await eventsFor('journal.approved', proposalId);
  assert.equal(approvedEv.length, 1, 'exactly one journal.approved event');
  assert.equal(approvedEv[0].actor_type, 'human', 'approved event stamped human actor_type');
  const postedEv = await eventsFor('journal.posted', batchId);
  assert.equal(postedEv.length, 1, 'exactly one journal.posted event (from postJournalBatch inside approve)');
});

test('A3j reject is terminal: note required; approve/reject/upsert on rejected all INVALID_STATUS', async () => {
  const propose = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-a3j-reject',
    lines: proposalLines(30),
  });
  assert.equal(propose.status, 200, JSON.stringify(propose.body));
  const proposalId = propose.body.data.proposalId;

  // Reject WITHOUT note → INVALID_INPUT.
  const noNote = await api(baseUrl, 'journal.reject', { companyId: CO, userEmail: 'owner@ct', proposalId });
  assert.equal(noNote.status, 400);
  assert.equal(noNote.body.error.code, 'INVALID_INPUT');

  // Reject WITH note → rejected.
  const reject = await api(baseUrl, 'journal.reject', {
    companyId: CO, userEmail: 'owner@ct', proposalId, note: 'wrong account',
  });
  assert.equal(reject.status, 200, JSON.stringify(reject.body));
  assert.equal(reject.body.data.rejected, true);

  // journal.rejected event payload carries the note.
  const rejEv = await eventsFor('journal.rejected', proposalId);
  assert.equal(rejEv.length, 1, 'journal.rejected emitted');
  const rejPayload = JSON.parse(rejEv[0].payload);
  assert.equal(rejPayload.note, 'wrong account', 'event payload carries the note');
  assert.equal(rejPayload.reviewedBy, 'owner@ct');

  // approve on the rejected row → INVALID_STATUS.
  const approveAfterReject = await api(baseUrl, 'journal.approve', { companyId: CO, userEmail: 'owner@ct', proposalId });
  assert.equal(approveAfterReject.status, 409);
  assert.equal(approveAfterReject.body.error.code, 'INVALID_STATUS');

  // reject again on the rejected row → INVALID_STATUS.
  const rejectAgain = await api(baseUrl, 'journal.reject', { companyId: CO, userEmail: 'owner@ct', proposalId, note: 'again' });
  assert.equal(rejectAgain.status, 409);
  assert.equal(rejectAgain.body.error.code, 'INVALID_STATUS');

  // upsert-with-proposalId on the rejected row (same agent) → INVALID_STATUS.
  const upsertRejected = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: 'agent@ct', proposalId,
    lines: proposalLines(30),
  });
  assert.equal(upsertRejected.status, 409);
  assert.equal(upsertRejected.body.error.code, 'INVALID_STATUS');

  // No journal_entries were ever created for this proposal (rejected proposals
  // never post — verified by the absence of a batch_id below).
  const prows = await proposalsFor(proposalId);
  assert.equal(String(prows[0].status), 'rejected', 'proposal stays rejected (terminal)');
  assert.ok(!prows[0].batch_id, 'rejected proposal has no batch_id');
});

test('A3j propose-upsert: same-caller edit ✓; other actor ✗; non-proposed ✗', async () => {
  // Agent proposes.
  const first = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-a3j-upsert',
    lines: proposalLines(40),
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const proposalId = first.body.data.proposalId;
  let proposedEv = await eventsFor('journal.proposed', proposalId);
  assert.equal(proposedEv.length, 1, 'one journal.proposed event after first propose');

  // Same agent re-proposes with same proposalId and CHANGED lines → 200, row updated.
  const repropose = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: 'agent@ct', proposalId,
    lines: proposalLines(77),
  });
  assert.equal(repropose.status, 200, JSON.stringify(repropose.body));
  assert.equal(repropose.body.data.proposalId, proposalId, 'same proposalId returned');

  // Still ONE journal.proposed event (upsert edit does not re-emit).
  proposedEv = await eventsFor('journal.proposed', proposalId);
  assert.equal(proposedEv.length, 1, 'upsert edit does not re-emit journal.proposed');

  // The row's lines were updated (77, not 40).
  const get = await api(baseUrl, 'journal.proposal.get', { companyId: CO, proposalId });
  assert.equal(get.body.data.lines[0].debit, 77, 'lines updated by upsert');
  assert.equal(get.body.data.created_by, 'agent@ct', 'created_by unchanged (immutable origin)');

  // Owner (other actor) upserting that proposalId → FORBIDDEN.
  const otherActor = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: 'owner@ct', proposalId,
    lines: proposalLines(77),
  });
  assert.equal(otherActor.status, 403);
  assert.equal(otherActor.body.error.code, 'FORBIDDEN');

  // Approve the proposal (owner) → posted, then upsert after approve → INVALID_STATUS.
  const approve = await api(baseUrl, 'journal.approve', { companyId: CO, userEmail: 'owner@ct', proposalId });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  const upsertPosted = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: 'agent@ct', proposalId,
    lines: proposalLines(77),
  });
  assert.equal(upsertPosted.status, 409);
  assert.equal(upsertPosted.body.error.code, 'INVALID_STATUS');
});

test('A3j propose-upsert preserves created_at; updated_at reflects the most recent touch', async () => {
  // First propose (caller-chosen proposalId).
  const proposalId = 'proposed-upsert-ts-' + Date.now();
  const first = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-a3j-ts',
    proposalId,
    lines: proposalLines(40),
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.proposalId, proposalId);

  let rows = await proposalsFor(proposalId);
  assert.equal(rows.length, 1, 'one proposal row after first propose');
  const firstCreatedAt = rows[0].created_at;
  const firstUpdatedAt = rows[0].updated_at;
  assert.ok(firstCreatedAt, 'created_at stamped on first propose');
  assert.ok(firstUpdatedAt, 'updated_at stamped on first propose');

  // Wait so the second propose's now() is strictly later (ms-resolution clock).
  await new Promise((r) => setTimeout(r, 1200));

  // Same caller re-proposes with the SAME proposalId and CHANGED lines.
  const repropose = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: 'agent@ct', proposalId,
    lines: proposalLines(88),
  });
  assert.equal(repropose.status, 200, JSON.stringify(repropose.body));
  assert.equal(repropose.body.data.proposalId, proposalId, 'same proposalId returned');

  rows = await proposalsFor(proposalId);
  assert.equal(rows.length, 1, 'still one proposal row after re-propose');

  // created_at MUST be unchanged — a retried proposal does not jump the queue.
  assert.equal(String(rows[0].created_at), String(firstCreatedAt),
    'created_at is NOT overwritten on upsert (immutable origin)');

  // updated_at MUST be newer than the original (the row was touched).
  const newUpdatedAt = new Date(String(rows[0].updated_at)).getTime();
  const origUpdatedAt = new Date(String(firstUpdatedAt)).getTime();
  assert.ok(newUpdatedAt > origUpdatedAt,
    'updated_at is bumped to now() on upsert (reflects most recent touch)');

  // updated_at is also newer than created_at (the second touch came later).
  const createdAtMs = new Date(String(rows[0].created_at)).getTime();
  assert.ok(newUpdatedAt > createdAtMs,
    'updated_at > created_at after an upsert (touched after creation)');

  // The row's lines were updated (88, not 40).
  const get = await api(baseUrl, 'journal.proposal.get', { companyId: CO, proposalId });
  assert.equal(get.body.data.lines[0].debit, 88, 'lines updated by upsert');
});

test('A3j idempotent replay: same Idempotency-Key → one proposal, one journal.proposed event', async () => {
  const idemKey = 'a3j-idem-' + Date.now();
  const payload = {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-a3j-idem',
    lines: proposalLines(22),
  };
  const first = await api(baseUrl, 'journal.propose', payload, { 'Idempotency-Key': idemKey });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const proposalId = first.body.data.proposalId;

  const replay = await api(baseUrl, 'journal.propose', payload, { 'Idempotency-Key': idemKey });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('idempotent-replay'), 'true', 'replay short-circuited');
  assert.equal(replay.body.data.proposalId, proposalId, 'same proposalId on replay');

  // Exactly ONE proposal row.
  const rows = await proposalsFor(proposalId);
  assert.equal(rows.length, 1, 'exactly one proposal persisted');
  // Exactly ONE journal.proposed event (handler never ran on replay — R4).
  const ev = await eventsFor('journal.proposed', proposalId);
  assert.equal(ev.length, 1, 'R4: idempotent replay does not double-emit journal.proposed');
});

test('A3j approve-time revalidation: lock period → approve fails PERIOD_LOCKED → unlock → approve succeeds', async () => {
  // Propose a valid batch dated in 2026-07 (period exists, unlocked).
  const propose = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-a3j-reval',
    lines: proposalLines(60, TD.day15),
  });
  assert.equal(propose.status, 200, JSON.stringify(propose.body));
  const proposalId = propose.body.data.proposalId;

  // Lock the 2026-07 period.
  const lock = await api(baseUrl, 'period.upsert', {
    companyId: CO, period: { period_id: TD.periodId, start_date: TD.startDate, end_date: TD.endDate, locked: true },
  });
  assert.equal(lock.status, 200, JSON.stringify(lock.body));

  // Approve fails with the period-locked error code (PERIOD_LOCKED).
  const approveLocked = await api(baseUrl, 'journal.approve', { companyId: CO, userEmail: 'owner@ct', proposalId });
  assert.equal(approveLocked.status, 409, 'approve of a locked-period proposal is 409');
  assert.equal(approveLocked.body.error.code, 'PERIOD_LOCKED', 'period-locked surfaces PERIOD_LOCKED (same as journal.post)');

  // No journal_entries created by the failed approve.
  const prows = await proposalsFor(proposalId);
  assert.equal(String(prows[0].status), 'proposed', 'proposal stays proposed after failed approve');
  assert.ok(!prows[0].batch_id, 'no batch_id stamped on failed approve');

  // Unlock the period → approve succeeds.
  const unlock = await api(baseUrl, 'period.upsert', {
    companyId: CO, period: { period_id: TD.periodId, start_date: TD.startDate, end_date: TD.endDate, locked: false },
  });
  assert.equal(unlock.status, 200, JSON.stringify(unlock.body));

  const approveUnlocked = await api(baseUrl, 'journal.approve', { companyId: CO, userEmail: 'owner@ct', proposalId });
  assert.equal(approveUnlocked.status, 200, JSON.stringify(approveUnlocked.body));
  assert.ok(approveUnlocked.body.data.batchId, 'approve succeeds after unlock');

  // Proposal is now posted.
  const posted = await proposalsFor(proposalId);
  assert.equal(String(posted[0].status), 'posted', 'proposal posted after unlock + approve');
});

test('A3j journal.proposal.list: default status proposed, ordering, limit', async () => {
  // Propose a fresh one for the queue.
  const propose = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-a3j-list',
    lines: proposalLines(11, TD.day25),
  });
  assert.equal(propose.status, 200, JSON.stringify(propose.body));
  const pid = propose.body.data.proposalId;

  const list = await api(baseUrl, 'journal.proposal.list', { companyId: CO });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const items = list.body.data;
  assert.ok(Array.isArray(items), 'list returns array');
  assert.ok(items.length >= 1, 'queue has at least the freshly proposed row');
  assert.ok(items.every((r) => String(r.status) === 'proposed'), 'default status filter is proposed');
  // Ordering: date DESC then created_at DESC.
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1], b = items[i];
    assert.ok(String(a.date) >= String(b.date), 'list ordered by date DESC');
  }
  const found = items.find((r) => String(r.proposal_id) === pid);
  assert.ok(found, 'freshly proposed row is in the list');

  // status filter: 'posted' returns only posted rows.
  const postedList = await api(baseUrl, 'journal.proposal.list', { companyId: CO, status: 'posted' });
  assert.equal(postedList.status, 200);
  assert.ok(postedList.body.data.every((r) => String(r.status) === 'posted'), 'status filter excludes other statuses');

  // limit cap: request 9999 is capped.
  const capped = await api(baseUrl, 'journal.proposal.list', { companyId: CO, limit: 9999 });
  assert.equal(capped.status, 200);
  assert.ok(capped.body.data.length <= 1000, 'limit 9999 capped at 1000');
});

// ── A3j (Phase A hardening): approve/reject atomicity + attribution fallback ─
// These tests scope their assertions to entities they create; appended at the
// very end so the global row-count tests above are unaffected.

test('A3j approve race: two concurrent approves → exactly one posts, one INVALID_STATUS', async () => {
  const lines = proposalLines(44, TD.day18);
  const propose = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-a3j-race-' + Date.now(),
    lines,
  });
  assert.equal(propose.status, 200, JSON.stringify(propose.body));
  const proposalId = propose.body.data.proposalId;

  // Two concurrent approves with DIFFERENT Idempotency-Keys (so both execute).
  // The atomic claim ensures exactly one wins the proposed→posted transition;
  // the loser's UPDATE...RETURNING sees status='posted' → 0 rows → INVALID_STATUS.
  const settled = await Promise.allSettled([
    api(baseUrl, 'journal.approve', { companyId: CO, userEmail: 'owner@ct', proposalId }, { 'Idempotency-Key': 'race-a-' + proposalId }),
    api(baseUrl, 'journal.approve', { companyId: CO, userEmail: 'owner@ct', proposalId }, { 'Idempotency-Key': 'race-b-' + proposalId }),
  ]);

  const oks = settled.filter((r) => r.status === 'fulfilled' && r.value.status === 200);
  const errs = settled.filter((r) => r.status === 'fulfilled' && r.value.status === 409 && r.value.body && r.value.body.error && r.value.body.error.code === 'INVALID_STATUS');
  assert.equal(oks.length, 1, 'exactly one approve succeeds (race winner)');
  assert.equal(errs.length, 1, 'exactly one approve fails INVALID_STATUS (race loser)');
  assert.equal(oks.length + errs.length, 2, 'both attempts resolved to one ok + one INVALID_STATUS');

  const batchId = oks[0].value.body.data.batchId;

  // Exactly ONE batch in journal_entries for the winner's batch_id — no double-post.
  const je = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM journal_entries WHERE company_id='CT' AND batch_id='${batchId}'`);
  assert.equal(Number(je[0].c), lines.length, 'exactly one batch of lines posted (no double-post)');

  // Proposal is posted (the loser's claim did not revert it).
  const prows = await proposalsFor(proposalId);
  assert.equal(String(prows[0].status), 'posted', 'proposal is posted after the race');
  assert.equal(String(prows[0].batch_id), batchId, 'proposal batch_id is the winner batch');
});

test('A3j approve attribution fallback: no userEmail → created_by/reviewed_by/event reviewedBy = anonymous', async () => {
  const propose = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-a3j-anon-' + Date.now(),
    lines: proposalLines(19, TD.day19),
  });
  assert.equal(propose.status, 200, JSON.stringify(propose.body));
  const proposalId = propose.body.data.proposalId;

  // Approve with NO userEmail field → 'anonymous' fallback (install-level trust;
  // dispatch skips the permission check when userEmail is absent and stamps
  // actorType 'human', so the call reaches the handler).
  const approve = await api(baseUrl, 'journal.approve', { companyId: CO, proposalId });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  const batchId = approve.body.data.batchId;

  // journal_entries.created_by = 'anonymous' for the batch.
  const je = await sql(baseUrl, srv.adminToken,
    `SELECT created_by FROM journal_entries WHERE company_id='CT' AND batch_id='${batchId}' LIMIT 1`);
  assert.equal(je.length, 1, 'batch posted');
  assert.equal(String(je[0].created_by), 'anonymous', 'created_by falls back to anonymous');

  // journal_proposals.reviewed_by = 'anonymous'.
  const prows = await proposalsFor(proposalId);
  assert.equal(String(prows[0].reviewed_by), 'anonymous', 'reviewed_by falls back to anonymous');

  // journal.approved event payload reviewedBy = 'anonymous' (payload is JSON text).
  const approvedEv = await eventsFor('journal.approved', proposalId);
  assert.equal(approvedEv.length, 1, 'journal.approved emitted');
  assert.equal(JSON.parse(approvedEv[0].payload).reviewedBy, 'anonymous', 'event payload reviewedBy = anonymous');
});

test('A3j approve post-failure rollback: delete journals row → approve fails → proposal restored to proposed', async () => {
  // Create a dedicated journal series so we don't disturb shared seeded state.
  const journalId = 'ct_testrb_' + Date.now();
  const jsave = await api(baseUrl, 'journals.save', {
    companyId: CO, userEmail: 'owner@ct',
    journal: { journal_id: journalId, code: 'TESTRB', name: 'Rollback test journal', active: true },
  });
  assert.equal(jsave.status, 200, JSON.stringify(jsave.body));

  const propose = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-a3j-rb-' + Date.now(),
    lines: proposalLines(28, TD.day17), journalId,
  });
  assert.equal(propose.status, 200, JSON.stringify(propose.body));
  const proposalId = propose.body.data.proposalId;

  // Delete the journal series row so postJournalBatch's journal existence
  // check fails (throws 'journal not found' inside postJournalBatch — a certain
  // post-failure that happens AFTER the atomic claim, exercising the rollback).
  // No FK constraint exists on journal_sequences/journals, so the DELETE succeeds.
  await sql(baseUrl, srv.adminToken,
    `DELETE FROM journals WHERE company_id='CT' AND journal_id='${journalId}'`);

  const approve = await api(baseUrl, 'journal.approve', { companyId: CO, userEmail: 'owner@ct', proposalId });
  assert.notEqual(approve.status, 200, 'approve must fail when reference generation fails (post-failure)');

  // Compensating rollback: proposal back to status='proposed', reviewed_by NULL, batch_id NULL.
  const prows = await proposalsFor(proposalId);
  assert.equal(String(prows[0].status), 'proposed', 'compensating rollback restored status to proposed');
  assert.ok(prows[0].reviewed_by === null, 'reviewed_by cleared by rollback');
  assert.ok(prows[0].batch_id === null, 'batch_id stays NULL (no dangling batch)');

  // No journal_entries rows leaked for this proposal (the post never completed).
  const je = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM journal_entries WHERE company_id='CT' AND source='proposal' AND created_by='owner@ct' AND date='${TD.day17}'`);
  assert.equal(Number(je[0].c), 0, 'no ledger rows leaked by the failed post');
});

test('A3j reject-after-approve: approve then reject → INVALID_STATUS (terminal complement)', async () => {
  const propose = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-a3j-raa-' + Date.now(),
    lines: proposalLines(37, TD.day16),
  });
  assert.equal(propose.status, 200, JSON.stringify(propose.body));
  const proposalId = propose.body.data.proposalId;

  // Approve → posted.
  const approve = await api(baseUrl, 'journal.approve', { companyId: CO, userEmail: 'owner@ct', proposalId, note: 'go' });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));

  // Reject after approve → INVALID_STATUS (posted is terminal, just like rejected).
  const rejectAfterApprove = await api(baseUrl, 'journal.reject', { companyId: CO, userEmail: 'owner@ct', proposalId, note: 'too late' });
  assert.equal(rejectAfterApprove.status, 409);
  assert.equal(rejectAfterApprove.body.error.code, 'INVALID_STATUS');

  // Proposal stayed posted (the reject claim did not touch it).
  const prows = await proposalsFor(proposalId);
  assert.equal(String(prows[0].status), 'posted', 'proposal stays posted after the failed reject');
});

// ── attachment.upload hardening (Phase A, 2026-07-31) ───────────────────────
// attachment.upload is now a real catalog action (base64 content, role agent,
// idempotent, 32MB decoded cap). Uploads write real files under
// ~/.freebooks/attachments — payloads are tiny and every successful upload is
// cleaned up via attachment.delete. Unique entityIds per test avoid collisions.

test('attachment.upload as agent: tiny text file → 200, row + event stamped', async () => {
  const entityId = 'attach-test-' + Date.now();
  const b64 = Buffer.from('hello attachment', 'utf8').toString('base64');
  const up = await api(baseUrl, 'attachment.upload', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-attach-agent-' + entityId,
    entityType: 'journal', entityId,
    filename: 'hello.txt',
    contentBase64: b64,
    contentType: 'text/plain',
  });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const attachmentId = up.body.data.attachment_id;
  assert.ok(attachmentId, 'attachment_id returned');

  // attachments row exists with uploaded_by = agent@ct.
  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT uploaded_by FROM attachments WHERE company_id='CT' AND attachment_id='${attachmentId}'`);
  assert.equal(rows.length, 1, 'attachments row written');
  assert.equal(String(rows[0].uploaded_by), 'agent@ct', 'uploaded_by stamped as agent@ct');

  // attachment.uploaded event exists with actor_type = 'agent'.
  const evs = await eventsFor('attachment.uploaded', attachmentId);
  assert.ok(evs.length >= 1, 'attachment.uploaded event emitted');
  assert.equal(String(evs[0].actor_type), 'agent', 'event actor_type = agent');

  // Cleanup: attachment.delete as owner@ct.
  const del = await api(baseUrl, 'attachment.delete', { companyId: CO, userEmail: 'owner@ct', attachmentId });
  assert.equal(del.status, 200, JSON.stringify(del.body));
});

test('attachment.upload viewer denied: viewer-role email → 403 FORBIDDEN', async () => {
  // Seed a viewer-role user BEFORE any call as that email (60s permission-cache
  // pitfall: checkPermission caches results, so seed before the first lookup).
  const viewerEmail = 'viewer-attach-' + Date.now() + '@ct';
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('${viewerEmail}', 'CT', 'viewer', now(), 'test')`);

  const up = await api(baseUrl, 'attachment.upload', {
    companyId: CO, userEmail: viewerEmail, requestId: 'req-attach-viewer-' + Date.now(),
    entityType: 'journal', entityId: 'attach-test-viewer-' + Date.now(),
    filename: 'denied.txt',
    contentBase64: Buffer.from('x', 'utf8').toString('base64'),
  });
  assert.equal(up.status, 403, 'viewer must be FORBIDDEN (role check excludes viewers at level 1.5)');
  assert.equal(up.body && up.body.error && up.body.error.code, 'FORBIDDEN', 'FORBIDDEN code');
});

test('attachment.upload idempotent replay: same key twice → same id, one row + one event', async () => {
  const entityId = 'attach-test-idem-' + Date.now();
  const b64 = Buffer.from('idempotent attachment', 'utf8').toString('base64');
  const idemKey = 'attach-idem-' + entityId;
  const payload = {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-attach-idem-' + entityId,
    entityType: 'journal', entityId,
    filename: 'idem.txt',
    contentBase64: b64,
    contentType: 'text/plain',
  };

  const first = await api(baseUrl, 'attachment.upload', payload, { 'Idempotency-Key': idemKey });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const attachmentId = first.body.data.attachment_id;
  assert.ok(attachmentId, 'first upload returns attachment_id');

  const second = await api(baseUrl, 'attachment.upload', payload, { 'Idempotency-Key': idemKey });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.data.attachment_id, attachmentId, 'replay returns the SAME attachment_id');

  // Exactly ONE attachments row for that id (the replay did not re-store).
  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM attachments WHERE company_id='CT' AND attachment_id='${attachmentId}'`);
  assert.equal(Number(rows[0].c), 1, 'exactly one attachments row for the idempotent id');

  // Exactly ONE attachment.uploaded event for that id.
  const evs = await eventsFor('attachment.uploaded', attachmentId);
  assert.equal(evs.length, 1, 'exactly one attachment.uploaded event for the idempotent id');

  // Cleanup.
  const del = await api(baseUrl, 'attachment.delete', { companyId: CO, userEmail: 'owner@ct', attachmentId });
  assert.equal(del.status, 200, JSON.stringify(del.body));
});

test('attachment.upload zero-byte: contentBase64 "" → 400 INVALID_INPUT', async () => {
  const up = await api(baseUrl, 'attachment.upload', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-attach-zero-' + Date.now(),
    entityType: 'journal', entityId: 'attach-test-zero-' + Date.now(),
    filename: 'empty.txt',
    contentBase64: '',
  });
  assert.equal(up.status, 400, 'zero-byte contentBase64 → 400');
  assert.equal(up.body && up.body.error && up.body.error.code, 'INVALID_INPUT', 'INVALID_INPUT code');
});

// ── A4 (§4.7): proposal underlag — propose-time count/warning, list join, ───
// approve re-point. Mirrors spec §8 items 10, 12, 13. Server-side binding only;
// no UI, no schema, no attachments.js internals touched.

// Helper: fetch attachment rows for an entity via admin SQL (test-controlled).
async function attachmentsFor(entityType, entityId) {
  return sql(baseUrl, srv.adminToken,
    `SELECT attachment_id, entity_type, entity_id, filename
     FROM attachments WHERE company_id='CT' AND entity_type='${entityType}' AND entity_id='${entityId}'`);
}

test('A4 propose WITH underlag: 2 uploads → attachment_count=2, no no_underlag warning', async () => {
  // Agent mints a proposalId client-side (§4.7 binding convention: upload-first).
  const proposalId = 'a4-with-' + Date.now();
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

  // Upload TWO source documents bound to the proposalId BEFORE proposing.
  // (A4 stage 2: journal_proposal uploads are whitelisted to pdf/jpeg/png —
  // use application/pdf here so the whitelist admits them.)
  for (let i = 0; i < 2; i++) {
    const up = await api(baseUrl, 'attachment.upload', {
      companyId: CO, userEmail: 'agent@ct', requestId: `req-a4-with-${proposalId}-${i}`,
      entityType: 'journal_proposal', entityId: proposalId,
      filename: `underlag-${i}.pdf`,
      contentBase64: b64(`underlag content ${i}`),
      contentType: 'application/pdf',
    });
    assert.equal(up.status, 200, JSON.stringify(up.body));
  }

  // Propose with the same proposalId → attachment_count=2, NO no_underlag.
  const propose = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-a4-with-propose',
    proposalId,
    lines: proposalLines(50, TD.day20),
  });
  assert.equal(propose.status, 200, JSON.stringify(propose.body));
  assert.equal(propose.body.data.proposalId, proposalId, 'caller-supplied proposalId honored');
  assert.equal(propose.body.data.attachment_count, 2, 'attachment_count reflects the 2 uploaded underlag');
  assert.ok(Array.isArray(propose.body.data.warnings), 'warnings array present');
  assert.ok(!propose.body.data.warnings.includes('no_underlag'),
    'no_underlag warning absent when attachments exist');

  // Cleanup the uploaded files via attachment.delete (owner action).
  const rows = await attachmentsFor('journal_proposal', proposalId);
  for (const r of rows) {
    const del = await api(baseUrl, 'attachment.delete', { companyId: CO, userEmail: 'owner@ct', attachmentId: r.attachment_id });
    assert.equal(del.status, 200, JSON.stringify(del.body));
  }
});

test('A4 propose WITHOUT underlag (R7 warn-not-block): succeeds, attachment_count=0, warnings has no_underlag', async () => {
  const propose = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-a4-no-underlag-' + Date.now(),
    lines: proposalLines(33, TD.day21),
  });
  assert.equal(propose.status, 200, 'R7: propose still succeeds with zero underlag (warn-not-block)');
  assert.equal(propose.body.data.attachment_count, 0, 'attachment_count=0 when no underlag uploaded');
  assert.ok(propose.body.data.warnings.includes('no_underlag'),
    'warnings contains no_underlag when attachment_count is 0');

  // The proposal was actually persisted (not rejected) — verify via .get.
  const get = await api(baseUrl, 'journal.proposal.get', { companyId: CO, proposalId: propose.body.data.proposalId });
  assert.equal(get.status, 200, 'proposal persisted despite no_underlag warning');
  assert.equal(String(get.body.data.status), 'proposed');
});

test('A4 journal.proposal.list carries attachment_count per row (computed join)', async () => {
  // Propose with 1 underlag → its row should show attachment_count=1 in the list.
  const proposalId = 'a4-list-' + Date.now();
  const up = await api(baseUrl, 'attachment.upload', {
    companyId: CO, userEmail: 'agent@ct', requestId: `req-a4-list-attach-${proposalId}`,
    entityType: 'journal_proposal', entityId: proposalId,
    filename: 'list-underlag.pdf',
    contentBase64: Buffer.from('list test', 'utf8').toString('base64'),
    contentType: 'application/pdf',
  });
  assert.equal(up.status, 200, JSON.stringify(up.body));

  const propose = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-a4-list-propose',
    proposalId,
    lines: proposalLines(12, TD.day22),
  });
  assert.equal(propose.status, 200, JSON.stringify(propose.body));

  const list = await api(baseUrl, 'journal.proposal.list', { companyId: CO });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const items = list.body.data;
  const row = items.find((r) => String(r.proposal_id) === proposalId);
  assert.ok(row, 'proposed row present in the list');
  assert.equal(Number(row.attachment_count), 1, 'list row carries attachment_count=1 (computed join)');

  // A no-underlag proposal in the same list shows attachment_count=0.
  const barePropose = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-a4-list-bare',
    lines: proposalLines(7, TD.day22),
  });
  assert.equal(barePropose.status, 200, JSON.stringify(barePropose.body));
  const list2 = await api(baseUrl, 'journal.proposal.list', { companyId: CO });
  const bareRow = list2.body.data.find((r) => String(r.proposal_id) === barePropose.body.data.proposalId);
  assert.ok(bareRow, 'bare proposal row present');
  assert.equal(Number(bareRow.attachment_count), 0, 'bare row carries attachment_count=0');

  // Cleanup the uploaded file.
  const del = await api(baseUrl, 'attachment.delete', { companyId: CO, userEmail: 'owner@ct', attachmentId: up.body.data.attachment_id });
  assert.equal(del.status, 200, JSON.stringify(del.body));
});

test('A4 approve re-points attachments: journal_proposal → journal/batchId (atomic, one transaction)', async () => {
  // Upload 2 underlag bound to a client-minted proposalId, then propose.
  const proposalId = 'a4-approve-' + Date.now();
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const uploadedIds = [];
  for (let i = 0; i < 2; i++) {
    const up = await api(baseUrl, 'attachment.upload', {
      companyId: CO, userEmail: 'agent@ct', requestId: `req-a4-appr-${proposalId}-${i}`,
      entityType: 'journal_proposal', entityId: proposalId,
      filename: `appr-underlag-${i}.pdf`,
      contentBase64: b64(`approve re-point ${i}`),
      contentType: 'application/pdf',
    });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    uploadedIds.push(up.body.data.attachment_id);
  }

  const propose = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-a4-appr-propose',
    proposalId,
    lines: proposalLines(50, TD.day23),
  });
  assert.equal(propose.status, 200, JSON.stringify(propose.body));
  assert.equal(propose.body.data.attachment_count, 2, 'pre-approve: 2 underlag bound');

  // Pre-approve: both rows are entity_type='journal_proposal' / entity_id=proposalId.
  const preRows = await attachmentsFor('journal_proposal', proposalId);
  assert.equal(preRows.length, 2, '2 attachments bound to the proposal before approve');

  // Owner approves → batch posted, attachments re-pointed to journal/batchId.
  const approve = await api(baseUrl, 'journal.approve', {
    companyId: CO, userEmail: 'owner@ct', proposalId, note: 'underlag verified',
  });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  const batchId = approve.body.data.batchId;
  assert.ok(batchId, 'approve returns batchId');

  // The two attachment rows are now entity_type='journal' / entity_id=batchId.
  const postRows = await attachmentsFor('journal', batchId);
  assert.equal(postRows.length, 2, '2 attachments re-pointed to the posted batch');
  assert.deepEqual(
    postRows.map((r) => r.attachment_id).sort(),
    [...uploadedIds].sort(),
    'the SAME two attachment rows were re-pointed (not duplicated)'
  );

  // No attachments remain bound to the proposal entity after re-point.
  const leftover = await attachmentsFor('journal_proposal', proposalId);
  assert.equal(leftover.length, 0, 'no attachments left on the journal_proposal entity after re-point');

  // The journal-voucher-style query (entity_type='journal', entity_id=batchId) finds them.
  const journalList = await api(baseUrl, 'attachment.list', { companyId: CO, entityType: 'journal', entityId: batchId });
  assert.equal(journalList.status, 200, JSON.stringify(journalList.body));
  assert.equal(journalList.body.data.length, 2, 'attachment.list(journal, batchId) returns the 2 re-pointed rows');

  // Cleanup the uploaded files (now under journal/batchId).
  for (const id of uploadedIds) {
    const del = await api(baseUrl, 'attachment.delete', { companyId: CO, userEmail: 'owner@ct', attachmentId: id });
    assert.equal(del.status, 200, JSON.stringify(del.body));
  }
});

// ── A4 stage 2 (§4.7): storage hardening — 15MB cap + type whitelist (scoped ─
// to journal_proposal uploads), global sha256 dedupe, 30-day GC with the hard
// invariant that entity_type='journal' rows are never purged. Spec §4.7 "Disk
// controls" + "Reject / expire + GC"; verification items 14-15.

// (e) journal_proposal upload >15MB rejected.
test('A4 stage2: journal_proposal upload >15MB rejected (INVALID_INPUT, names the 15MB cap)', async () => {
  // 15MB + 1 byte — just over the journal_proposal cap. (Under the 32MB action
  // cap, so the 15MB check inside storeAttachment is what fires.)
  const big = Buffer.alloc(15 * 1024 * 1024 + 1, 0x41);
  const up = await api(baseUrl, 'attachment.upload', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-a4-s2-15mb-' + Date.now(),
    entityType: 'journal_proposal', entityId: 'a4-s2-15mb-' + Date.now(),
    filename: 'big.pdf',
    contentBase64: big.toString('base64'),
    contentType: 'application/pdf',
  });
  assert.equal(up.status, 400, '15MB+ journal_proposal upload rejected');
  assert.equal(up.body && up.body.error && up.body.error.code, 'INVALID_INPUT', 'INVALID_INPUT code');
  assert.match(up.body.error.message, /15MB/, 'error names the 15MB cap');
});

// (f) journal_proposal upload with contentType text/plain rejected.
test('A4 stage2: journal_proposal upload contentType text/plain rejected (INVALID_INPUT, names admitted types)', async () => {
  const up = await api(baseUrl, 'attachment.upload', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-a4-s2-ct-' + Date.now(),
    entityType: 'journal_proposal', entityId: 'a4-s2-ct-' + Date.now(),
    filename: 'doc.txt',
    contentBase64: Buffer.from('plain text underlag', 'utf8').toString('base64'),
    contentType: 'text/plain',
  });
  assert.equal(up.status, 400, 'text/plain journal_proposal upload rejected');
  assert.equal(up.body && up.body.error && up.body.error.code, 'INVALID_INPUT', 'INVALID_INPUT code');
  assert.match(up.body.error.message, /pdf|jpeg|png/i, 'error names the admitted types');
});

// (g) scoping proof: the same oversized + wrong-type payload is still accepted
// under a different entityType (status quo: 32MB cap, no whitelist).
test('A4 stage2: scoping — oversized+wrong-type upload with entityType=journal still accepted', async () => {
  // Same shape that (e)/(f) reject for journal_proposal: >15MB AND text/plain.
  // entityType='journal' keeps the status quo — the 15MB cap and whitelist do
  // not apply (only the 32MB action cap, which this is under).
  const big = Buffer.alloc(15 * 1024 * 1024 + 1, 0x42);
  const up = await api(baseUrl, 'attachment.upload', {
    companyId: CO, userEmail: 'agent@ct', requestId: 'req-a4-s2-scope-' + Date.now(),
    entityType: 'journal', entityId: 'a4-s2-scope-' + Date.now(),
    filename: 'scoped.txt',
    contentBase64: big.toString('base64'),
    contentType: 'text/plain',
  });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.ok(up.body.data.attachment_id, 'accepted under the journal entity type (cap+whitelist are journal_proposal-only)');

  // Cleanup.
  const del = await api(baseUrl, 'attachment.delete', { companyId: CO, userEmail: 'owner@ct', attachmentId: up.body.data.attachment_id });
  assert.equal(del.status, 200, JSON.stringify(del.body));
});

// (h) sha256 dedupe: identical bytes uploaded twice → two metadata rows share
// one storage_path and one sha256; the blob is written once.
test('A4 stage2: sha256 dedupe — identical bytes twice → 2 rows, 1 storage_path, 1 sha256, blob written once', async () => {
  const entityId = 'a4-s2-dedupe-' + Date.now();
  const bytes = Buffer.from('dedupe-me-identical-bytes', 'utf8');
  const b64 = bytes.toString('base64');
  const expectedHash = crypto.createHash('sha256').update(bytes).digest('hex');

  const up1 = await api(baseUrl, 'attachment.upload', {
    companyId: CO, userEmail: 'agent@ct', requestId: `req-a4-s2-dedupe-1-${entityId}`,
    entityType: 'journal_proposal', entityId,
    filename: 'first.pdf',
    contentBase64: b64,
    contentType: 'application/pdf',
  });
  assert.equal(up1.status, 200, JSON.stringify(up1.body));
  const id1 = up1.body.data.attachment_id;

  const up2 = await api(baseUrl, 'attachment.upload', {
    companyId: CO, userEmail: 'agent@ct', requestId: `req-a4-s2-dedupe-2-${entityId}`,
    entityType: 'journal_proposal', entityId,
    filename: 'second.pdf',
    contentBase64: b64,
    contentType: 'application/pdf',
  });
  assert.equal(up2.status, 200, JSON.stringify(up2.body));
  const id2 = up2.body.data.attachment_id;

  assert.notEqual(id1, id2, 'two distinct metadata rows (distinct attachment_ids)');

  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT attachment_id, storage_path, sha256 FROM attachments
     WHERE company_id='CT' AND attachment_id IN ('${id1}','${id2}') ORDER BY attachment_id`);
  assert.equal(rows.length, 2, 'two metadata rows present');
  assert.equal(rows[0].storage_path, rows[1].storage_path,
    'both rows share one storage_path (the blob was not written a second time)');
  assert.ok(rows[0].sha256 && rows[0].sha256 === rows[1].sha256,
    'both rows carry the same sha256');
  assert.equal(rows[0].sha256, expectedHash, 'sha256 matches the uploaded bytes (integrity evidence)');

  // Cleanup (deleteAttachment unlinks the shared blob on the first delete; the
  // second tolerates the already-missing file — both rows are removed).
  for (const id of [id1, id2]) {
    const del = await api(baseUrl, 'attachment.delete', { companyId: CO, userEmail: 'owner@ct', attachmentId: id });
    assert.equal(del.status, 200, JSON.stringify(del.body));
  }
});

// (i) GC: aged orphan + aged rejected-proposal attachments purged; fresh orphan
// + a 'journal'-bound row kept. Rows are aged via admin SQL UPDATE on
// uploaded_at / journal_proposals.reviewed_at.
//
// How the test invokes GC: the fixture server is a child process with its own
// DuckDB connection (DuckDB is single-writer), so the test process cannot
// reach that DB directly, and requiring attachments.js in-process would open a
// conflicting second connection. GC runs at boot and on a 24h setInterval —
// neither fires deterministically during a test. The lightest consistent
// trigger is the token-gated admin endpoint POST /api/admin/gc-attachments
// (mirrors /api/admin/query), which calls the same runAttachmentGC used at boot
// + interval, against the real child-process DB.
test('A4 stage2: GC — purges aged orphan + aged rejected-proposal; keeps fresh orphan + journal-bound row', async () => {
  const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
  const old = daysAgo(40);      // 40 > 30-day grace
  const fresh = new Date().toISOString();
  const tag = 'gc-' + Date.now();

  // (1) Aged orphan: journal_proposal row whose entity_id does NOT exist in
  //     journal_proposals, uploaded_at 40 days ago → GC purges.
  const orphanAgedId = `gc-orphan-aged-${tag}`;
  // (2) Aged rejected proposal: a proposal row status='rejected', reviewed_at
  //     40 days ago, plus an attachment bound to it, uploaded_at 40 days ago →
  //     GC purges the attachment.
  const rejectedProposalId = `gc-rej-prop-${tag}`;
  const rejectedAttachId = `gc-rej-attach-${tag}`;
  // (3) Fresh orphan: journal_proposal row, nonexistent entity, uploaded_at now
  //     → GC keeps (within 30-day grace).
  const orphanFreshId = `gc-orphan-fresh-${tag}`;
  // (4) Journal-bound row: entity_type='journal', uploaded_at 40 days ago → GC
  //     keeps (HARD INVARIANT: never touch entity_type='journal').
  const journalAttachId = `gc-journal-${tag}`;

  // Seed the rejected proposal row directly (minimal valid shape; lines is a
  // JSON string per the schema).
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO journal_proposals (company_id, proposal_id, date, lines, status, created_by, reviewed_at, reviewed_by, created_at)
     VALUES ('CT', '${rejectedProposalId}', DATE '${TD.startDate}', '[]', 'rejected', 'test', '${old}', 'test', '${old}')`);

  // Seed the four attachment rows via admin SQL (storage_path points at a
  // non-existent file; GC best-effort unlinks and tolerates missing files).
  // Each row gets a distinct sha256 so dedupe does not cross-link them.
  const insertAttach = (id, etype, eid, uploadedAt) =>
    sql(baseUrl, srv.adminToken,
      `INSERT INTO attachments (attachment_id, company_id, entity_type, entity_id, filename, content_type, file_size, storage_path, sha256, uploaded_by, uploaded_at)
       VALUES ('${id}', 'CT', '${etype}', '${eid}', 'gc.txt', 'text/plain', 1, 'gc/${id}', '${id}', 'test', '${uploadedAt}')`);
  await insertAttach(orphanAgedId, 'journal_proposal', orphanAgedId, old);
  await insertAttach(rejectedAttachId, 'journal_proposal', rejectedProposalId, old);
  await insertAttach(orphanFreshId, 'journal_proposal', orphanFreshId, fresh);
  await insertAttach(journalAttachId, 'journal', 'gc-journal-entity-' + tag, old);

  // Invoke GC via the token-gated admin endpoint (see comment above).
  const gcRes = await fetch(`${baseUrl}/api/admin/gc-attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${srv.adminToken}` },
  });
  assert.equal(gcRes.status, 200, `GC trigger status: ${gcRes.status}`);
  const gcBody = await gcRes.json();
  assert.ok(gcBody.purged >= 2, `GC purged at least the 2 aged journal_proposal rows (purged=${gcBody.purged})`);

  // Aged orphan purged.
  const agedOrphan = await sql(baseUrl, srv.adminToken,
    `SELECT attachment_id FROM attachments WHERE company_id='CT' AND attachment_id='${orphanAgedId}'`);
  assert.equal(agedOrphan.length, 0, 'aged orphan purged (entity_id no longer in journal_proposals, >30 days)');

  // Aged rejected-proposal attachment purged.
  const agedRej = await sql(baseUrl, srv.adminToken,
    `SELECT attachment_id FROM attachments WHERE company_id='CT' AND attachment_id='${rejectedAttachId}'`);
  assert.equal(agedRej.length, 0, 'aged rejected-proposal attachment purged (status=rejected, reviewed_at >30 days)');

  // Fresh orphan kept (within the 30-day grace).
  const freshOrphan = await sql(baseUrl, srv.adminToken,
    `SELECT attachment_id FROM attachments WHERE company_id='CT' AND attachment_id='${orphanFreshId}'`);
  assert.equal(freshOrphan.length, 1, 'fresh orphan kept (within 30-day grace)');

  // Journal-bound row kept — HARD INVARIANT.
  const journalRow = await sql(baseUrl, srv.adminToken,
    `SELECT attachment_id FROM attachments WHERE company_id='CT' AND attachment_id='${journalAttachId}'`);
  assert.equal(journalRow.length, 1, 'journal-bound row kept (GC never touches entity_type=journal)');

  // Cleanup the survivors + the seeded proposal.
  await sql(baseUrl, srv.adminToken, `DELETE FROM attachments WHERE company_id='CT' AND attachment_id='${orphanFreshId}'`);
  await sql(baseUrl, srv.adminToken, `DELETE FROM attachments WHERE company_id='CT' AND attachment_id='${journalAttachId}'`);
  await sql(baseUrl, srv.adminToken, `DELETE FROM journal_proposals WHERE company_id='CT' AND proposal_id='${rejectedProposalId}'`);
});

// ── Reference doctrine (ratified 2026-08-02): every posted batch carries a ──
// ── sequential {CODE}/{YYYY}/{NNNNN} reference; missing journalId → MISC. ──

test('journal.post without journalId defaults to MISC sequence + warning', async () => {
  const r = await api(baseUrl, 'journal.post', {
    companyId: CO,
    lines: [
      { account_code: EXP, debit: 25, date: TD.day21, description: 'ref doctrine test' },
      { account_code: AP, credit: 25, date: TD.day21, description: 'ref doctrine test' },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.data.posted);
  assert.match(String(r.body.data.reference), /^\d{5}$/, 'reference is bare 5-digit number (MISC journal default)');
  assert.ok((r.body.data.warnings || []).some((w) => /default journal MISC/.test(w)),
    'warning names the MISC default');
});

test('journal.post with explicit journalId mints that journal\'s sequence, no MISC warning', async () => {
  const jrows = await sql(baseUrl, srv.adminToken,
    `SELECT journal_id FROM journals WHERE company_id='CT' AND code='ADJ' AND active=true`);
  const r = await api(baseUrl, 'journal.post', {
    companyId: CO,
    journalId: String(jrows[0].journal_id),
    lines: [
      { account_code: EXP, debit: 30, date: TD.day21, description: 'ref doctrine test 2' },
      { account_code: AP, credit: 30, date: TD.day21, description: 'ref doctrine test 2' },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(String(r.body.data.reference), /^\d{5}$/, 'reference is bare 5-digit number (explicit journal, no prefix)');
  assert.ok(!(r.body.data.warnings || []).some((w) => /default journal MISC/.test(w)));
});

test('journal.import: reference-less entries get MISC sequences; carried references preserved', async () => {
  const r = await api(baseUrl, 'journal.import', {
    companyId: CO,
    entries: [
      { lines: [
        { account_code: EXP, debit: 40, date: TD.day22 },
        { account_code: AP, credit: 40, date: TD.day22 },
      ] },
      { lines: [
        { account_code: EXP, debit: 45, date: TD.day22, reference: 'LEGACY-KEEP-1' },
        { account_code: AP, credit: 45, date: TD.day22 },
      ] },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(Number(r.body.data.referencesMinted), 1, 'exactly one entry needed a minted reference');
  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT DISTINCT reference FROM journal_entries WHERE company_id='CT' AND date='${TD.day22}' AND source='csv_import'`);
  const refs = rows.map((x) => String(x.reference));
  assert.ok(refs.includes('LEGACY-KEEP-1'), 'carried reference preserved');
  assert.ok(refs.some((x) => /^\d{5}$/.test(x)), 'minted MISC sequence present (bare 5-digit number)');
});

// ── A5: unified action inbox (§10) — inbox.list aggregator ─────────────────
// Each A5 test seeds a FRESH company so the inbox contents are exactly what
// the test creates (no cross-test residue from the shared CT company). The
// inbox is read-only; journal.propose/journal.reject reuse the A3j setup idiom.

// Grant owner + agent rights for a fresh company (bootstrap via admin SQL,
// not under test — same pattern as the suite's before hook).
async function grantFor(co) {
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@ct', '${co}', 'owner', now(), 'test'),
            ('agent@ct', '${co}', 'agent', now(), 'test')`);
}

test('A5: inbox.list returns proposed items normalized', async () => {
  const CO5 = 'CIP';
  const seeded = await seedCompany(baseUrl, CO5);
  const ap5 = seeded.AP, exp5 = seeded.EXP;
  await grantFor(CO5);

  // Agent proposes a balanced 2-line batch (A3j §4 setup idiom). The
  // proposal's description/reference columns come from body.description /
  // body.reference (top-level), not per-line descriptions.
  const propose = await api(baseUrl, 'journal.propose', {
    companyId: CO5, userEmail: 'agent@ct', requestId: 'req-a5-prop',
    reference: 'A5-REF',
    description: 'A5 inbox expense',
    lines: [
      { account_code: exp5, debit: 50, date: TD.day20, description: 'A5 inbox expense' },
      { account_code: ap5, credit: 50, date: TD.day20, description: 'A5 inbox expense' },
    ],
  });
  assert.equal(propose.status, 200, JSON.stringify(propose.body));
  const proposalId = propose.body.data.proposalId;
  assert.ok(proposalId, 'propose returns proposalId');

  // inbox.list with no status param → default 'proposed' → exactly this item
  // (P2-1: period_unclosed items may also appear in the default view).
  const inbox = await api(baseUrl, 'inbox.list', { companyId: CO5 });
  assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
  const items = inbox.body.data.items;
  const jpItems = items.filter(i => i.type === 'journal_proposal');
  assert.equal(jpItems.length, 1, 'exactly one proposed journal_proposal item in a fresh company');
  const item = jpItems[0];
  assert.equal(item.type, 'journal_proposal', 'item.type');
  assert.equal(item.source, 'agent', 'item.source (agent caller)');
  assert.deepEqual(item.verbs, ['approve', 'reject', 'open'], 'item.verbs literal');
  assert.equal(item.payload_ref, proposalId, 'payload_ref = proposalId');
  assert.equal(item.amount, 50, 'amount = sum of line debits (50 debit, 0 on credit line)');
  assert.equal(item.counterparty, null, 'counterparty reserved null (Class A)');
  assert.equal(item.status, 'proposed', 'item.status');
  assert.equal(item.reference, 'A5-REF', 'reference carried from the row');
  assert.equal(item.description, 'A5 inbox expense', 'description carried from the row');
  assert.equal(item.attachment_count, 0, 'no underlag → attachment_count 0');
  assert.equal(item.summary, 'A5 inbox expense', 'summary = description || reference || ""');
});

test('A5: inbox.list rejected filter', async () => {
  const CO5 = 'CIR';
  const seeded = await seedCompany(baseUrl, CO5);
  const ap5 = seeded.AP, exp5 = seeded.EXP;
  await grantFor(CO5);

  const propose = await api(baseUrl, 'journal.propose', {
    companyId: CO5, userEmail: 'agent@ct', requestId: 'req-a5-rej',
    lines: [
      { account_code: exp5, debit: 30, date: TD.day20, description: 'A5 reject me' },
      { account_code: ap5, credit: 30, date: TD.day20, description: 'A5 reject me' },
    ],
  });
  assert.equal(propose.status, 200, JSON.stringify(propose.body));
  const proposalId = propose.body.data.proposalId;

  // Owner rejects with a note (A3j §4.3 — note required, terminal).
  const reject = await api(baseUrl, 'journal.reject', {
    companyId: CO5, userEmail: 'owner@ct', proposalId, note: 'fix the account',
  });
  assert.equal(reject.status, 200, JSON.stringify(reject.body));
  assert.equal(reject.body.data.rejected, true);

  // Default (proposed) view → absent (rejected stays out of the default view,
  // void doctrine carried over from §4.4). P2-1: period_unclosed items may
  // appear in the default view — filter for journal_proposal type.
  const def = await api(baseUrl, 'inbox.list', { companyId: CO5 });
  assert.equal(def.status, 200, JSON.stringify(def.body));
  const defJp = def.body.data.items.filter(i => i.type === 'journal_proposal');
  assert.equal(defJp.length, 0, 'rejected absent from default (proposed) view');

  // status:'rejected' → present, carrying the review_note.
  const rej = await api(baseUrl, 'inbox.list', { companyId: CO5, status: 'rejected' });
  assert.equal(rej.status, 200, JSON.stringify(rej.body));
  assert.equal(rej.body.data.items.length, 1, 'rejected present under status:rejected');
  const item = rej.body.data.items[0];
  assert.equal(item.status, 'rejected');
  assert.equal(item.payload_ref, proposalId);
  assert.equal(item.review_note, 'fix the account', 'review_note carried on the normalized item');
  assert.equal(item.type, 'journal_proposal');
});

test('A5: inbox.list empty', async () => {
  const CO5 = 'CIE';
  await seedCompany(baseUrl, CO5); // fresh company, no proposals

  const inbox = await api(baseUrl, 'inbox.list', { companyId: CO5 });
  assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
  // P2-1: period_unclosed items may appear in the default view for fresh
  // companies with unclosed periods. Verify no journal_proposal items.
  const jpItems = inbox.body.data.items.filter(i => i.type === 'journal_proposal');
  assert.equal(jpItems.length, 0, 'no journal_proposal items in a fresh company');
});

// ── Reports registry endpoint (v3 :show command) ────────────────────────────

test('GET /api/:company/reports/registry returns id+label array', async () => {
  const r = await fetch(`${baseUrl}/api/${CO}/reports/registry`);
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.ok(Array.isArray(data), 'returns an array');
  assert.ok(data.length >= 8, 'has known reports');
  for (const item of data) {
    assert.ok(item.id, 'each entry has id');
    assert.ok(item.label, 'each entry has label');
  }
  const ids = data.map(r => r.id);
  assert.ok(ids.includes('pl'), 'includes pl');
  assert.ok(ids.includes('bs'), 'includes bs');
  assert.ok(ids.includes('tb'), 'includes tb');
});

// ── Settings/AI tab: ai.test_connection (issue #179) ────────────────────────

test('ai.test_connection is in the catalog as a read-only viewer action', async () => {
  const r = await fetch(`${baseUrl}/api/actions`);
  const { actions } = await r.json();
  assert.ok(actions['ai.test_connection'], 'ai.test_connection registered in catalog');
  assert.equal(actions['ai.test_connection'].role, 'viewer');
  assert.equal(actions['ai.test_connection'].mutating, false);
});

test('ai.attr.list includes the Test connection Action row', async () => {
  const { status, body } = await api(baseUrl, 'ai.attr.list', { companyId: CO });
  assert.equal(status, 200, JSON.stringify(body));
  const rows = body.data || body;
  assert.ok(Array.isArray(rows), 'ai.attr.list returns an array');
  const tc = rows.find(r => r.key === 'test_connection');
  assert.ok(tc, 'test_connection row present');
  assert.equal(tc.type, 'Action');
  assert.equal(tc.readonly, true);
  assert.ok(tc.editor && tc.editor.type === 'action', 'editor.type is action');
  assert.equal(tc.editor.action, 'ai.test_connection');
});

test('ai.test_connection with no endpoint configured returns ok:false', async () => {
  // CT has no llm_endpoint_url set by default — the action must return a
  // structured { ok: false, error } envelope, not throw.
  const { status, body } = await api(baseUrl, 'ai.test_connection', { companyId: CO });
  assert.equal(status, 200, JSON.stringify(body));
  const d = body.data || body;
  assert.equal(d.ok, false);
  assert.match(d.error, /endpoint URL/i);
});

// ── Issue #131: multi-bill settlement ──────────────────────────────────────
// One bank payment split across N bills from the same vendor in the same
// currency. All N bills settle atomically inside a withTransaction wrapper.

test('payment.record: multi-bill settlement splits one payment across N bills', async () => {
  // SG template ships bank accounts cf_category='Excluded' — mark 1020 as Cash
  await sql(baseUrl, srv.adminToken,
    `UPDATE accounts SET cf_category='Cash' WHERE company_id='CT' AND account_code='1020'`);

  // 3 bills for the same vendor, distinct amounts
  const refs = ['MB-SPLIT-1', 'MB-SPLIT-2', 'MB-SPLIT-3'];
  const amounts = [100, 200, 300];
  const billIds = [];
  for (let i = 0; i < refs.length; i++) {
    const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: refs[i], amount: amounts[i], lines: [{ description: 'x', expense_account: EXP, amount: amounts[i], vat_code: '' }] }) });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    billIds.push(c.body.data.billId);
  }

  const pay = await api(baseUrl, 'payment.record', {
    companyId: CO, date: TD.day21, bankAccount: '1020',
    allocations: [
      { billId: billIds[0], amount: 100 },
      { billId: billIds[1], amount: 200 },
      { billId: billIds[2], amount: 300 },
    ],
  });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  const data = pay.body.data;
  assert.ok(data.batchId, 'batchId returned');
  assert.equal(data.paymentIds.length, 3, '3 paymentIds');
  assert.equal(data.results.length, 3, '3 results');

  // Verify each bill is fully paid
  for (let i = 0; i < 3; i++) {
    const r = data.results.find((r) => r.billId === billIds[i]);
    assert.ok(r, `result for bill ${i}`);
    assert.equal(r.newStatus, 'paid', `bill ${i} paid`);
    assert.equal(r.outstanding, 0, `bill ${i} outstanding 0`);
  }

  // Verify one batch_id, N payments rows
  const bp = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c, COUNT(DISTINCT batch_id) b FROM payments WHERE company_id='CT' AND bill_id IN ('${billIds.join("','")}')`);
  assert.equal(Number(bp[0].c), 3, '3 payments rows');
  assert.equal(Number(bp[0].b), 1, 'all share one batch_id');

  // Verify journal is balanced
  const je = await sql(baseUrl, srv.adminToken,
    `SELECT ROUND(SUM(debit_home),2) dr, ROUND(SUM(credit_home),2) cr FROM journal_entries WHERE company_id='CT' AND batch_id='${data.batchId}'`);
  assert.equal(Number(je[0].dr), Number(je[0].cr), 'multi-bill journal balanced');
  assert.equal(Number(je[0].dr), 600, 'total debit = 600');
});

test('payment.record: multi-bill rejects cross-vendor', async () => {
  const c1 = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'MB-XV-1', partner_name: 'Acme Pte Ltd' }) });
  const c2 = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'MB-XV-2', partner_name: 'Beta Pte Ltd' }) });
  assert.equal(c1.status, 200);
  assert.equal(c2.status, 200);

  const pay = await api(baseUrl, 'payment.record', {
    companyId: CO, date: TD.day21, bankAccount: '1020',
    allocations: [{ billId: c1.body.data.billId, amount: 50 }, { billId: c2.body.data.billId, amount: 50 }],
  });
  assert.equal(pay.status, 400);
  assert.equal(pay.body.error.code, 'VALIDATION');
  assert.match(pay.body.error.message, /same vendor/i);
});

test('payment.record: multi-bill rejects mixed currency', async () => {
  // Need an FX rate for USD bills to be created
  await api(baseUrl, 'fx.rates.save', { companyId: CO, rates: [{ date: TD.day20, from_currency: 'USD', to_currency: 'SGD', rate: 1.35 }] });

  const c1 = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'MB-MC-1', currency: 'SGD' }) });
  const c2 = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'MB-MC-2', currency: 'USD' }) });
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  assert.equal(c2.status, 200, JSON.stringify(c2.body));

  const pay = await api(baseUrl, 'payment.record', {
    companyId: CO, date: TD.day21, bankAccount: '1020', fxRate: 1.35,
    allocations: [{ billId: c1.body.data.billId, amount: 50 }, { billId: c2.body.data.billId, amount: 50 }],
  });
  assert.equal(pay.status, 400);
  assert.equal(pay.body.error.code, 'VALIDATION');
  assert.match(pay.body.error.message, /same currency/i);
});

test('payment.record: multi-bill rejects over-allocation', async () => {
  const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'MB-OV-1', amount: 100, lines: [{ description: 'x', expense_account: EXP, amount: 100, vat_code: '' }] }) });
  assert.equal(c.status, 200);

  const pay = await api(baseUrl, 'payment.record', {
    companyId: CO, date: TD.day21, bankAccount: '1020',
    allocations: [{ billId: c.body.data.billId, amount: 999 }],
  });
  assert.equal(pay.status, 400);
  assert.equal(pay.body.error.code, 'VALIDATION');
  assert.match(pay.body.error.message, /exceeds outstanding/i);
});

test('payment.record: multi-bill rejects empty allocations', async () => {
  const pay = await api(baseUrl, 'payment.record', {
    companyId: CO, date: TD.day21, bankAccount: '1020',
    allocations: [],
  });
  assert.equal(pay.status, 400);
  assert.equal(pay.body.error.code, 'VALIDATION');
});

test('payment.record: multi-bill with foreign currency posts per-allocation FX lines', async () => {
  // Ensure EXP is the FX Gain/Loss account (existing test may have set this)
  await api(baseUrl, 'coa.upsert', {
    companyId: CO,
    account: { account_code: EXP, account_name: 'FX Expense', account_type: 'Expense', is_active: true, default_role: 'FX Gain/Loss', effective_from: TD.day1 },
  });
  // FX rate for bill creation (USD → SGD at 1.35 and 1.40 for two bills)
  await api(baseUrl, 'fx.rates.save', { companyId: CO, rates: [{ date: TD.day20, from_currency: 'USD', to_currency: 'SGD', rate: 1.35 }] });
  await api(baseUrl, 'fx.rates.save', { companyId: CO, rates: [{ date: TD.day21, from_currency: 'USD', to_currency: 'SGD', rate: 1.30 }] });

  // Two USD bills with different fx_rates (bill creation rate 1.35)
  const c1 = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'MB-FX-1', currency: 'USD', fx_rate: 1.35 }) });
  const c2 = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'MB-FX-2', currency: 'USD', fx_rate: 1.40 }) });
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  assert.equal(c2.status, 200, JSON.stringify(c2.body));

  // Pay both at 1.30 (bankRate) — bill 1 booked at 1.35 (gain), bill 2 booked at 1.40 (gain)
  const pay = await api(baseUrl, 'payment.record', {
    companyId: CO, date: TD.day21, bankAccount: '1020', fxRate: 1.30,
    allocations: [
      { billId: c1.body.data.billId, amount: 100 },
      { billId: c2.body.data.billId, amount: 100 },
    ],
  });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  const batchId = pay.body.data.batchId;

  // Verify FX lines exist per bill
  const fxLines = await sql(baseUrl, srv.adminToken,
    `SELECT bill_id, account_code, debit_home, credit_home FROM journal_entries
     WHERE company_id='CT' AND batch_id='${batchId}' AND account_code='${EXP}' ORDER BY bill_id`);
  assert.ok(fxLines.length >= 2, 'at least 2 FX lines (one per bill)');

  // Bill 1: booked 135, bank 130 → 5 gain (credit)
  const fx1 = fxLines.find((l) => l.bill_id === c1.body.data.billId);
  assert.ok(fx1, 'FX line for bill 1');
  assert.equal(Number(fx1.credit_home), 5, 'bill 1 FX gain = 5');

  // Bill 2: booked 140, bank 130 → 10 gain (credit)
  const fx2 = fxLines.find((l) => l.bill_id === c2.body.data.billId);
  assert.ok(fx2, 'FX line for bill 2');
  assert.equal(Number(fx2.credit_home), 10, 'bill 2 FX gain = 10');

  // Journal balanced
  const je = await sql(baseUrl, srv.adminToken,
    `SELECT ROUND(SUM(debit_home),2) dr, ROUND(SUM(credit_home),2) cr FROM journal_entries WHERE company_id='CT' AND batch_id='${batchId}'`);
  assert.equal(Number(je[0].dr), Number(je[0].cr), 'multi-bill FX journal balanced');
});

test('payment.void: voiding multi-bill payment reverses entire batch', async () => {
  const c1 = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'MB-VOID-1', amount: 100, lines: [{ description: 'x', expense_account: EXP, amount: 100, vat_code: '' }] }) });
  const c2 = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'MB-VOID-2', amount: 200, lines: [{ description: 'x', expense_account: EXP, amount: 200, vat_code: '' }] }) });
  assert.equal(c1.status, 200);
  assert.equal(c2.status, 200);

  const pay = await api(baseUrl, 'payment.record', {
    companyId: CO, date: TD.day21, bankAccount: '1020',
    allocations: [
      { billId: c1.body.data.billId, amount: 100 },
      { billId: c2.body.data.billId, amount: 200 },
    ],
  });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  const firstPaymentId = pay.body.data.paymentIds[0];

  await seedVoidCoverPeriod();
  const v = await api(baseUrl, 'payment.void', { companyId: CO, paymentId: firstPaymentId });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.ok(v.body.data.voided, 'voided true');

  // Both payments should be voided
  const voidedCount = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM payments WHERE company_id='CT' AND batch_id='${pay.body.data.batchId}' AND voided_at IS NOT NULL`);
  assert.equal(Number(voidedCount[0].c), 2, 'both payments voided');

  // Both bills restored to posted, amount_paid 0
  for (const billId of [c1.body.data.billId, c2.body.data.billId]) {
    const bill = await sql(baseUrl, srv.adminToken,
      `SELECT status, amount_paid FROM bills WHERE company_id='CT' AND bill_id='${billId}'`);
    assert.equal(String(bill[0].status), 'posted', `bill ${billId} restored to posted`);
    assert.equal(Number(bill[0].amount_paid), 0, `bill ${billId} amount_paid 0`);
  }
});

test('payment.record: multi-bill is atomic — validation failure on bill 2 rolls back bill 1', async () => {
  const c1 = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'MB-ATOM-1', amount: 100, lines: [{ description: 'x', expense_account: EXP, amount: 100, vat_code: '' }] }) });
  const c2 = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'MB-ATOM-2', amount: 100, lines: [{ description: 'x', expense_account: EXP, amount: 100, vat_code: '' }] }) });
  assert.equal(c1.status, 200);
  assert.equal(c2.status, 200);

  // Pay bill 2 fully via single-bill path (makes it 'paid')
  const pay2 = await api(baseUrl, 'payment.record', { companyId: CO, billId: c2.body.data.billId, date: TD.day21, bankAccount: '1020', amount: 100 });
  assert.equal(pay2.status, 200, JSON.stringify(pay2.body));

  // Now try multi-bill settlement on both — bill 2 is already paid → should fail and roll back bill 1
  const multiPay = await api(baseUrl, 'payment.record', {
    companyId: CO, date: TD.day22, bankAccount: '1020',
    allocations: [
      { billId: c1.body.data.billId, amount: 100 },
      { billId: c2.body.data.billId, amount: 100 },
    ],
  });
  assert.notEqual(multiPay.status, 200, 'multi-bill must fail when bill 2 is already paid');
  assert.equal(multiPay.body.error.code, 'INVALID_STATUS');

  // Bill 1 must be unchanged (not paid, amount_paid still 0)
  const bill1 = await sql(baseUrl, srv.adminToken,
    `SELECT status, amount_paid FROM bills WHERE company_id='CT' AND bill_id='${c1.body.data.billId}'`);
  assert.equal(String(bill1[0].status), 'posted', 'bill 1 rolled back to posted');
  assert.equal(Number(bill1[0].amount_paid), 0, 'bill 1 amount_paid still 0');
});

test('payment.record: multi-bill is idempotent', async () => {
  const c1 = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'MB-IDEM-1', amount: 100, lines: [{ description: 'x', expense_account: EXP, amount: 100, vat_code: '' }] }) });
  const c2 = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'MB-IDEM-2', amount: 100, lines: [{ description: 'x', expense_account: EXP, amount: 100, vat_code: '' }] }) });
  assert.equal(c1.status, 200);
  assert.equal(c2.status, 200);

  const payload = {
    companyId: CO, date: TD.day21, bankAccount: '1020',
    allocations: [
      { billId: c1.body.data.billId, amount: 100 },
      { billId: c2.body.data.billId, amount: 100 },
    ],
  };

  const first = await api(baseUrl, 'payment.record', payload, { 'Idempotency-Key': 'mb-idem-1' });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const replay = await api(baseUrl, 'payment.record', payload, { 'Idempotency-Key': 'mb-idem-1' });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('idempotent-replay'), 'true');
  assert.equal(replay.body.data.batchId, first.body.data.batchId, 'replay returns same batchId');

  // No duplicate payments
  const bp = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM payments WHERE company_id='CT' AND batch_id='${first.body.data.batchId}'`);
  assert.equal(Number(bp[0].c), 2, 'exactly 2 payments rows — no duplicate on replay');
});

// ── bills.partner_id (bills-partner-fk-spec §7) ─────────────────────────────

test('partner_id round-trips: create → get returns partner_id', async () => {
  // Create a vendor partner and get its id
  const vp = await api(baseUrl, 'partner.upsert', {
    companyId: CO, partner: { name: 'VendorCo Round-Trip', default_currency: 'SGD', is_vendor: true, is_customer: false },
  });
  assert.equal(vp.status, 200, JSON.stringify(vp.body));
  const partnerId = vp.body.data.partnerId;

  // Create a bill with partner_id
  const c = await api(baseUrl, 'bill.create', {
    companyId: CO,
    bill: validBill({ partner_name: 'VendorCo Round-Trip', partner_id: partnerId, vendor_ref: 'PID-RT-1' }),
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));

  // bill.get should return partner_id
  const g = await api(baseUrl, 'bill.get', { companyId: CO, billId: c.body.data.billId });
  assert.equal(g.status, 200);
  assert.equal(g.body.data.partner_id, partnerId, 'partner_id round-trips through bill.create → bill.get');
});

test('partner_id round-trips: draft save → post → get preserves partner_id', async () => {
  const vp = await api(baseUrl, 'partner.upsert', {
    companyId: CO, partner: { name: 'DraftPostCo', default_currency: 'SGD', is_vendor: true, is_customer: false },
  });
  const partnerId = vp.body.data.partnerId;

  // Save a draft with partner_id
  const d = await api(baseUrl, 'bill.draft.save', {
    companyId: CO,
    bill: { partner_name: 'DraftPostCo', partner_id: partnerId, vendor_ref: 'PID-DRAFT-1', date: TD.day21, currency: 'SGD', ap_account: AP,
      lines: [{ description: 'L1', expense_account: EXP, amount: 50, vat_code: '' }] },
  });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const draftId = d.body.data.billId;

  // Re-save (UPDATE path) — partner_id should survive
  const r = await api(baseUrl, 'bill.draft.save', {
    companyId: CO,
    bill: { bill_id: draftId, partner_name: 'DraftPostCo', partner_id: partnerId, vendor_ref: 'PID-DRAFT-1b', date: TD.day21, currency: 'SGD', ap_account: AP,
      lines: [{ description: 'L1', expense_account: EXP, amount: 50, vat_code: '' }] },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // Post the draft
  const p = await api(baseUrl, 'bill.draft.post', { companyId: CO, billId: draftId });
  assert.equal(p.status, 200, JSON.stringify(p.body));

  // bill.get should still have partner_id (regression-guards §3.3 postDraftBill whitelist)
  const g = await api(baseUrl, 'bill.get', { companyId: CO, billId: draftId });
  assert.equal(g.status, 200);
  assert.equal(g.body.data.partner_id, partnerId, 'partner_id survives draft → post (postDraftBill passthrough)');
});

test('partner_id null when partner_name is free-text (no dropdown pick)', async () => {
  const c = await api(baseUrl, 'bill.create', {
    companyId: CO,
    bill: validBill({ partner_name: 'Some Unknown Vendor', vendor_ref: 'PID-FREE-1' }),
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const g = await api(baseUrl, 'bill.get', { companyId: CO, billId: c.body.data.billId });
  assert.equal(g.status, 200);
  assert.ok(!g.body.data.partner_id, 'free-text partner_name → partner_id is null/undefined');
});

test('§5 guard: rejects bill.create against non-vendor partner', async () => {
  // Create a customer-only partner
  const cp = await api(baseUrl, 'partner.upsert', {
    companyId: CO, partner: { name: 'CustomerOnly Inc', default_currency: 'SGD', is_vendor: false, is_customer: true },
  });
  assert.equal(cp.status, 200, JSON.stringify(cp.body));
  const customerPartnerId = cp.body.data.partnerId;

  // Attempt to create a bill with this customer-only partner_id
  const c = await api(baseUrl, 'bill.create', {
    companyId: CO,
    bill: validBill({ partner_name: 'CustomerOnly Inc', partner_id: customerPartnerId, vendor_ref: 'PID-GUARD-1' }),
  });
  assert.equal(c.status, 400);
  assert.equal(c.body.error.code, 'INVALID_PARTNER_TYPE');
});

test('§5 guard: rejects draft save against non-vendor partner', async () => {
  const cp = await api(baseUrl, 'partner.upsert', {
    companyId: CO, partner: { name: 'CustOnly Draft', default_currency: 'SGD', is_vendor: false, is_customer: true },
  });
  const customerPartnerId = cp.body.data.partnerId;

  const d = await api(baseUrl, 'bill.draft.save', {
    companyId: CO,
    bill: { partner_name: 'CustOnly Draft', partner_id: customerPartnerId, vendor_ref: 'PID-GUARD-2', date: TD.day21, currency: 'SGD', ap_account: AP,
      lines: [{ description: 'L1', expense_account: EXP, amount: 10, vat_code: '' }] },
  });
  assert.equal(d.status, 400);
  assert.equal(d.body.error.code, 'INVALID_PARTNER_TYPE');
});

test('§5 guard: allows bill.create with partner_id=null (free-text path)', async () => {
  const c = await api(baseUrl, 'bill.create', {
    companyId: CO,
    bill: validBill({ partner_name: 'Free Text Vendor', partner_id: null, vendor_ref: 'PID-NULL-1' }),
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));
});

// ── Access tab: permissions.upsert / permissions.delete (spec §8) ──────────

test('permissions.upsert as owner creates a row, confirmed via permissions.list', async () => {
  const CO_P = 'CPA';
  await seedCompany(baseUrl, CO_P);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@ct', '${CO_P}', 'owner', now(), 'test')`);

  const r = await api(baseUrl, 'permissions.upsert', {
    companyId: CO_P, userEmail: 'owner@ct',
    email: 'newperson@test.com', role: 'viewer',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.saved, 1);

  const list = await api(baseUrl, 'permissions.list', { companyId: CO_P, userEmail: 'owner@ct' });
  assert.equal(list.status, 200);
  const rows = list.body.data;
  const found = rows.find((x) => x.email === 'newperson@test.com' && x.company_id === CO_P);
  assert.ok(found, 'upserted row present in permissions.list');
  assert.equal(found.role, 'viewer');
});

test('permissions.upsert changing role replaces, does not duplicate', async () => {
  const CO_P = 'CPB';
  await seedCompany(baseUrl, CO_P);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@ct', '${CO_P}', 'owner', now(), 'test')`);

  // First upsert: viewer
  const r1 = await api(baseUrl, 'permissions.upsert', {
    companyId: CO_P, userEmail: 'owner@ct',
    email: 'changer@test.com', role: 'viewer',
  });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));

  // Second upsert: same email, different role
  const r2 = await api(baseUrl, 'permissions.upsert', {
    companyId: CO_P, userEmail: 'owner@ct',
    email: 'changer@test.com', role: 'agent',
  });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));

  const cnt = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM user_permissions WHERE company_id='${CO_P}' AND email='changer@test.com'`);
  assert.equal(Number(cnt[0].c), 1, 'exactly one row for this email+company — no duplicate');

  const list = await api(baseUrl, 'permissions.list', { companyId: CO_P, userEmail: 'owner@ct' });
  const row = list.body.data.find((x) => x.email === 'changer@test.com');
  assert.equal(row.role, 'agent', 'role updated to agent');
});

test('permissions.upsert/delete as non-owner → FORBIDDEN', async () => {
  const CO_P = 'CPC';
  await seedCompany(baseUrl, CO_P);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@ct', '${CO_P}', 'owner', now(), 'test'),
            ('viewer@ct', '${CO_P}', 'viewer', now(), 'test')`);

  const up = await api(baseUrl, 'permissions.upsert', {
    companyId: CO_P, userEmail: 'viewer@ct',
    email: 'x@test.com', role: 'viewer',
  });
  assert.equal(up.status, 403);
  assert.equal(up.body.error.code, 'FORBIDDEN');

  const del = await api(baseUrl, 'permissions.delete', {
    companyId: CO_P, userEmail: 'viewer@ct',
    email: 'owner@ct',
  });
  assert.equal(del.status, 403);
  assert.equal(del.body.error.code, 'FORBIDDEN');
});

test('permissions.delete on the only owner → INVALID_STATE, row untouched', async () => {
  const CO_P = 'CPD';
  await seedCompany(baseUrl, CO_P);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@ct', '${CO_P}', 'owner', now(), 'test')`);

  const del = await api(baseUrl, 'permissions.delete', {
    companyId: CO_P, userEmail: 'owner@ct',
    email: 'owner@ct',
  });
  assert.equal(del.status, 400);
  assert.equal(del.body.error.code, 'INVALID_STATE');

  // Row still present
  const cnt = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM user_permissions WHERE company_id='${CO_P}' AND email='owner@ct'`);
  assert.equal(Number(cnt[0].c), 1, 'owner row untouched after failed delete');
});

test('permissions.delete on only company-scoped owner when *-scoped owner exists → succeeds', async () => {
  const CO_P = 'CPE';
  await seedCompany(baseUrl, CO_P);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@ct', '${CO_P}', 'owner', now(), 'test'),
            ('global-owner@ct', '*', 'owner', now(), 'test')`);

  const del = await api(baseUrl, 'permissions.delete', {
    companyId: CO_P, userEmail: 'owner@ct',
    email: 'owner@ct',
  });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(del.body.data.deleted, 1);

  // Company-scoped row gone, global row untouched
  const cnt = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM user_permissions WHERE company_id='${CO_P}' AND email='owner@ct'`);
  assert.equal(Number(cnt[0].c), 0, 'company-scoped owner row deleted');

  const gcnt = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM user_permissions WHERE company_id='*' AND email='global-owner@ct'`);
  assert.equal(Number(gcnt[0].c), 1, 'global owner row untouched');
});

test('permissions.upsert/delete never touch company_id = * rows', async () => {
  const CO_P = 'CPF';
  await seedCompany(baseUrl, CO_P);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@ct', '${CO_P}', 'owner', now(), 'test'),
            ('shared@ct', '*', 'agent', now(), 'test')`);

  // upsert with the same email as the global row — should create a company-scoped row,
  // NOT modify or duplicate the global one
  const up = await api(baseUrl, 'permissions.upsert', {
    companyId: CO_P, userEmail: 'owner@ct',
    email: 'shared@ct', role: 'viewer',
  });
  assert.equal(up.status, 200, JSON.stringify(up.body));

  const gRows = await sql(baseUrl, srv.adminToken,
    `SELECT role FROM user_permissions WHERE company_id='*' AND email='shared@ct'`);
  assert.equal(gRows.length, 1, 'global row still exactly one');
  assert.equal(gRows[0].role, 'agent', 'global row role unchanged');

  const cRows = await sql(baseUrl, srv.adminToken,
    `SELECT role FROM user_permissions WHERE company_id='${CO_P}' AND email='shared@ct'`);
  assert.equal(cRows.length, 1, 'company-scoped row created');
  assert.equal(cRows[0].role, 'viewer', 'company-scoped row has the new role');

  // delete the company-scoped row — global row untouched
  const del = await api(baseUrl, 'permissions.delete', {
    companyId: CO_P, userEmail: 'owner@ct',
    email: 'shared@ct',
  });
  assert.equal(del.status, 200, JSON.stringify(del.body));

  const gAfter = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM user_permissions WHERE company_id='*' AND email='shared@ct'`);
  assert.equal(Number(gAfter[0].c), 1, 'global row survives company-scoped delete');
});

// ── §2.6: agent_pipeline_email — AI-tab picker + getAgentAccount rewrite ──

test('§2.6 ai.attr.list includes agent_pipeline_email row with options from agent-role accounts', async () => {
  const CO_A = 'APA';
  await seedCompany(baseUrl, CO_A);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@ct', '${CO_A}', 'owner', now(), 'test'),
            ('agent-pick@test.com', '${CO_A}', 'agent', now(), 'test')`);

  const { status, body } = await api(baseUrl, 'ai.attr.list', { companyId: CO_A });
  assert.equal(status, 200, JSON.stringify(body));
  const rows = body.data || body;
  const row = rows.find(r => r.key === 'agent_pipeline_email');
  assert.ok(row, 'agent_pipeline_email row present in ai.attr.list');
  assert.equal(row.type, 'Choice');
  assert.equal(row.label, 'Pipeline agent account');
  assert.ok(row.editor, 'editor present');
  assert.equal(row.editor.type, 'select');
  assert.equal(row.editor.nullable, true, 'nullable select (empty = clear)');
  assert.ok(Array.isArray(row.editor.options), 'options is an array');
  const opt = row.editor.options.find(o => o.value === 'agent-pick@test.com');
  assert.ok(opt, 'options populated from live agent-role accounts');
  assert.equal(opt.label, 'agent-pick@test.com');
});

test('§2.6 ai.attr.save agent_pipeline_email with a valid agent email → saved, retrievable', async () => {
  const CO_V = 'APV';
  await seedCompany(baseUrl, CO_V);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@ct', '${CO_V}', 'owner', now(), 'test'),
            ('agent-apv@test.com', '${CO_V}', 'agent', now(), 'test')`);

  // Mixed-case on the wire → stored lowercased (server-authoritative normalization)
  const r = await api(baseUrl, 'ai.attr.save', {
    companyId: CO_V, userEmail: 'owner@ct',
    key: 'agent_pipeline_email', value: 'Agent-APV@Test.com',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.saved, true);

  const list = await api(baseUrl, 'ai.attr.list', { companyId: CO_V });
  assert.equal(list.status, 200);
  const rows = list.body.data || list.body;
  const row = rows.find(x => x.key === 'agent_pipeline_email');
  assert.ok(row, 'agent_pipeline_email row present after save');
  assert.equal(row.value, 'agent-apv@test.com', 'stored value is lowercased');
});

test('§2.6 ai.attr.save agent_pipeline_email with a non-agent email → INVALID_INPUT', async () => {
  const CO_N = 'APN';
  await seedCompany(baseUrl, CO_N);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@ct', '${CO_N}', 'owner', now(), 'test'),
            ('agent-apn@test.com', '${CO_N}', 'agent', now(), 'test'),
            ('viewer-apn@test.com', '${CO_N}', 'viewer', now(), 'test')`);

  const r = await api(baseUrl, 'ai.attr.save', {
    companyId: CO_N, userEmail: 'owner@ct',
    key: 'agent_pipeline_email', value: 'viewer-apn@test.com',
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'INVALID_INPUT');
  assert.match(r.body.error.message, /does not have the agent role/);
});

test('§2.6 ai.attr.save agent_pipeline_email with empty string → clears the setting', async () => {
  const CO_C = 'APC';
  await seedCompany(baseUrl, CO_C);
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@ct', '${CO_C}', 'owner', now(), 'test'),
            ('agent-apc@test.com', '${CO_C}', 'agent', now(), 'test')`);

  // First set it to a real agent email
  const set = await api(baseUrl, 'ai.attr.save', {
    companyId: CO_C, userEmail: 'owner@ct',
    key: 'agent_pipeline_email', value: 'agent-apc@test.com',
  });
  assert.equal(set.status, 200, JSON.stringify(set.body));

  // Then clear with an empty string
  const clr = await api(baseUrl, 'ai.attr.save', {
    companyId: CO_C, userEmail: 'owner@ct',
    key: 'agent_pipeline_email', value: '',
  });
  assert.equal(clr.status, 200, JSON.stringify(clr.body));
  assert.equal(clr.body.data.saved, true);

  const list = await api(baseUrl, 'ai.attr.list', { companyId: CO_C });
  const rows = (list.body.data || list.body);
  const row = rows.find(x => x.key === 'agent_pipeline_email');
  assert.ok(row);
  assert.equal(row.value, '', 'setting cleared to empty string');
});

// ── §2.6: getAgentAccount (direct module tests) ───────────────────────────
// getAgentAccount() is internal to agent-loop.js (no HTTP surface), so we
// exercise it directly against a dedicated in-process DuckDB — a SEPARATE
// file from the contract server's DB to avoid cross-process file locks. The
// schema is applied lazily on first query (db.js _applySchemaOnBoot).

let _alEnv = null;
async function agentLoopEnv() {
  if (_alEnv) return _alEnv;
  const alPath = `/tmp/fb-al-${process.pid}.duckdb`;
  for (const s of ['', '.wal']) { try { fs.unlinkSync(alPath + s); } catch { /* fresh */ } }
  process.env.FREEBOOKS_DB_PATH = alPath;
  // db.js reads FREEBOOKS_DB_PATH at module-load and caches a singleton
  // connection, so clear the cache and re-require to bind to our temp file.
  for (const m of ['../src/db.js', '../src/agent-loop.js']) delete require.cache[require.resolve(m)];
  const db = require('../src/db.js');
  const agentLoop = require('../src/agent-loop.js');
  await db.query('SELECT 1'); // trigger ensureDb + schema apply
  _alEnv = { db, agentLoop };
  return _alEnv;
}

async function alGrant(db, email, companyId, role) {
  await db.exec(
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES (@email, @cid, @role, now(), 'test')`,
    { email, cid: companyId, role }
  );
}

async function alSetPipeline(db, companyId, email) {
  // Mirror putSetting's delete-then-insert (settings has no unique constraint).
  await db.exec(`DELETE FROM settings WHERE company_id = @cid AND key = 'agent_pipeline_email'`, { cid: companyId });
  await db.exec(
    `INSERT INTO settings (company_id, key, value, updated_at)
     VALUES (@cid, 'agent_pipeline_email', @val, now())`,
    { cid: companyId, val: email }
  );
}

test('§2.6 getAgentAccount: 0 agent accounts → null', async () => {
  const { agentLoop } = await agentLoopEnv();
  // Fresh company, no permissions rows, no setting
  const r = await agentLoop.getAgentAccount('AL0');
  assert.equal(r, null, 'no agent-role accounts → null (not guessed)');
});

test('§2.6 getAgentAccount: exactly 1 agent account → that email (zero-config fallback)', async () => {
  const { db, agentLoop } = await agentLoopEnv();
  await alGrant(db, 'solo@al', 'AL1', 'agent');
  const r = await agentLoop.getAgentAccount('AL1');
  assert.equal(r, 'solo@al', 'single agent-role account returned without configuration');
});

test('§2.6 getAgentAccount: 2+ agent accounts, no configured email → null (refuses to guess)', async () => {
  const { db, agentLoop } = await agentLoopEnv();
  await alGrant(db, 'a@al', 'AL2', 'agent');
  await alGrant(db, 'b@al', 'AL2', 'agent');
  const r = await agentLoop.getAgentAccount('AL2');
  assert.equal(r, null, 'ambiguous (2+ candidates) → null rather than a nondeterministic pick');
});

test('§2.6 getAgentAccount: configured email that still has agent role → returns configured email', async () => {
  const { db, agentLoop } = await agentLoopEnv();
  await alGrant(db, 'configured@al', 'AL3', 'agent');
  await alSetPipeline(db, 'AL3', 'configured@al');
  const r = await agentLoop.getAgentAccount('AL3');
  assert.equal(r, 'configured@al', 'explicit choice respected when it still holds the agent role');
});

test('§2.6 getAgentAccount: configured email that lost agent role → null (fail closed)', async () => {
  const { db, agentLoop } = await agentLoopEnv();
  // Email exists but as a viewer, not agent; pipeline is configured to it.
  await alGrant(db, 'gone@al', 'AL4', 'viewer');
  await alSetPipeline(db, 'AL4', 'gone@al');
  const r = await agentLoop.getAgentAccount('AL4');
  assert.equal(r, null, 'fail closed — do not fall back to guessing among the rest');
});