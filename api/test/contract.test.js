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
    partner_name: 'Acme Pte Ltd', vendor_ref: 'INV-1', date: TD.day20, due_date: TD.day25,
    currency: 'SGD', ap_account: AP, amount: 100,
    lines: [{ description: 'Office supplies', expense_account: EXP, amount: 100, vat_code: '' }],
    ...overrides,
  };
}

// Wall-clock determinism for void reversals: bill.void / bill.payment.void
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

test('bill.payment.record: full home payment settles, idempotent replay does not duplicate', async () => {
  // SG template ships bank accounts cf_category='Excluded' — mark 1020 as Cash (app-wide bank marker)
  await sql(baseUrl, srv.adminToken,
    `UPDATE accounts SET cf_category='Cash' WHERE company_id='CT' AND account_code='1020'`);

  const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'PAY-1' }) });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const billId = c.body.data.billId;

  const payload = { companyId: CO, billId, date: TD.day21, bankAccount: '1020', amount: 100, reference: 'TT-123' };
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

  const p1 = await api(baseUrl, 'bill.payment.record', { companyId: CO, billId, date: TD.day21, bankAccount: '1020', amount: 40 });
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.equal(p1.body.data.status, 'partial');
  assert.equal(p1.body.data.outstanding, 60);

  const over = await api(baseUrl, 'bill.payment.record', { companyId: CO, billId, date: TD.day21, bankAccount: '1020', amount: 61 });
  assert.equal(over.status, 400);
  assert.match(over.body.error.message, /exceeds outstanding/);

  const p2 = await api(baseUrl, 'bill.payment.record', { companyId: CO, billId, date: TD.day22, bankAccount: '1020', amount: 60 });
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
  const pay = await api(baseUrl, 'bill.payment.record', {
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

test('bill.payment.record: validation errors named', async () => {
  const missing = await api(baseUrl, 'bill.payment.record', { companyId: CO, billId: 'nope', date: TD.day21, bankAccount: '1020', amount: 1 });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');

  const d = await api(baseUrl, 'bill.draft.save', {
    companyId: CO,
    bill: { partner_name: 'Acme Pte Ltd', vendor_ref: 'PAY-DRAFT-1', date: TD.day21, currency: 'SGD', ap_account: AP, status: 'draft', lines: [{ description: 'x', expense_account: EXP, amount: 10, vat_code: '' }] },
  });
  const onDraft = await api(baseUrl, 'bill.payment.record', { companyId: CO, billId: d.body.data.billId, date: TD.day21, bankAccount: '1020', amount: 10 });
  assert.equal(onDraft.status, 409);
  assert.match(onDraft.body.error.message, /draft/);

  const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'PAY-3' }) });
  const nonCash = await api(baseUrl, 'bill.payment.record', { companyId: CO, billId: c.body.data.billId, date: TD.day21, bankAccount: AP, amount: 10 });
  assert.equal(nonCash.status, 400);
  assert.match(nonCash.body.error.message, /cf_category/);
});

test('bill.payment.void: reverses journal, restores bill, refuses double-void', async () => {
  const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'PAY-4' }) });
  const billId = c.body.data.billId;
  const pay = await api(baseUrl, 'bill.payment.record', { companyId: CO, billId, date: TD.day21, bankAccount: '1020', amount: 100 });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  const { paymentId, batchId } = pay.body.data;

  await seedVoidCoverPeriod();
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

test('bank.process: amount-only match demoted to suggestion; partner/ref tiers', async () => {
  // Distinct amount (101) so only this test's bill matches by amount
  const c = await api(baseUrl, 'bill.create', { companyId: CO, bill: validBill({ vendor_ref: 'INV-TIER-A', amount: 101, lines: [{ description: 'x', expense_account: EXP, amount: 101, vat_code: '' }] }) });
  assert.equal(c.status, 200, JSON.stringify(c.body));

  const proc = await api(baseUrl, 'bank.process', {
    companyId: CO,
    bankAccount: '1020',
    rows: [
      { date: TD.day21, description: 'GIRO TRANSFER 998877', amount: -101 },        // amount-only → suggest
      { date: TD.day21, description: 'PAYMENT ACME PTE LTD', amount: -101 },        // partner substring → medium
      { date: TD.day21, description: 'TRF INV-TIER-A 9988', amount: -101 },         // ref whole token → high
      { date: TD.day21, description: 'TRF INV-TIER-A99', amount: -101 },           // ref glued to digits: substring, not token → medium
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
  const pay = await api(baseUrl, 'bill.payment.record', { companyId: CO, billId, date: TD.day21, bankAccount: '1020', amount: 100 });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));

  const before = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM journal_entries WHERE company_id='CT' AND bill_id='${billId}'`);

  const proc = await api(baseUrl, 'bank.process', {
    companyId: CO,
    bankAccount: '1020',
    rows: [{ date: TD.day21, description: 'GIRO ACME PAY-REC-1', amount: -100 }],
  });
  assert.equal(proc.status, 200, JSON.stringify(proc.body));
  const row = proc.body.data.processed[0];
  assert.equal(row.matchType, 'recorded_payment', 'tagged as already-recorded');
  assert.ok(row.paymentBatchId, 'payment batch attached for clearing');

  const ap = await api(baseUrl, 'bank.approve', {
    companyId: CO,
    entries: [{ date: TD.day21, description: row.description, amount: -100, recordedPayment: true, paymentBatchId: row.paymentBatchId, bankAccount: '1020' }],
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

  // The journal-new-style query (entity_type='journal', entity_id=batchId) finds them.
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
