'use strict';
/**
 * freeBooks — opening-balance-flattened-spec contract tests.
 *
 * Covers:
 *  - OPEN period validation (start must equal end)
 *  - OPEN period must be oldest (no earlier periods)
 *  - Non-OPEN period blocked from starting on or before OPEN's date
 *  - openingBalance.post without OPEN journal → error
 *  - openingBalance.post without OPEN period → error
 *  - openingBalance.post with locked OPEN period → error
 *  - openingBalance.post with valid OPEN journal + period → success,
 *    lines stamped with journal_id
 *
 * Run: node --test test/opening-balance.test.js  (in api/)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, sql, seedCompany, testDates } = require('../test-utils/helpers');
const TD = testDates();

let srv;
let baseUrl;

before(async () => {
  srv = await startTestServer({ withAdminToken: true });
  baseUrl = srv.baseUrl;
});

after(async () => { await srv.cleanup(); });

// Helper: seed a fresh company + grant owner rights. Returns seeded accounts.
async function freshCompany(coId) {
  const seeded = await seedCompany(baseUrl, coId, { jurisdiction: 'SG', currency: 'SGD' });
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@ob', ?, 'owner', now(), 'test')`,
    [coId]
  );
  return seeded;
}

// Helper: create the OPEN journal via journals.save.
async function createOpenJournal(coId) {
  const r = await api(baseUrl, 'journals.save', {
    companyId: coId,
    userEmail: 'owner@ob',
    journal: { code: 'OPEN', name: 'Opening Balances' },
  });
  assert.equal(r.status, 200, `journals.save OPEN failed: ${JSON.stringify(r.body)}`);
  return r.body.data || r.body;
}

// Helper: create the OPEN period (single-day) via period.upsert.
async function createOpenPeriod(coId, date) {
  const r = await api(baseUrl, 'period.upsert', {
    companyId: coId,
    period: { period_id: 'OPEN', start_date: date, end_date: date },
  });
  return r;
}

// ── Period validation ──────────────────────────────────────────────────────

test('OPEN period with start != end is rejected', async () => {
  const CO = 'OB_T1';
  await freshCompany(CO);
  // Pass start != end directly (not via createOpenPeriod which forces equality).
  const r = await api(baseUrl, 'period.upsert', {
    companyId: CO,
    period: { period_id: 'OPEN', start_date: '2025-01-01', end_date: '2025-01-31' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'VALIDATION');
  assert.match(r.body.error.message, /start_date and end_date must be equal/i);
});

test('OPEN period is accepted when start == end', async () => {
  const CO = 'OB_T2';
  await freshCompany(CO);
  const openDate = '2026-01-01';
  const r = await createOpenPeriod(CO, openDate);
  assert.equal(r.status, 200, `OPEN period create failed: ${JSON.stringify(r.body)}`);
});

test('OPEN period rejected when an earlier period already exists', async () => {
  const CO = 'OB_T3';
  await freshCompany(CO);
  // Clear seeded periods, then create one that ends before the OPEN date so
  // OPEN would NOT be the oldest.
  await sql(baseUrl, srv.adminToken, `DELETE FROM periods WHERE company_id = ?`, [CO]);
  await api(baseUrl, 'period.upsert', {
    companyId: CO,
    period: { period_id: 'EARLY', start_date: '2025-01-01', end_date: '2025-01-31' },
  });
  // Now try OPEN at a date AFTER the EARLY period ends.
  const r = await createOpenPeriod(CO, '2025-06-01');
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'VALIDATION');
  assert.match(r.body.error.message, /must be the oldest period/i);
});

test('non-OPEN period blocked from starting on or before OPEN date', async () => {
  const CO = 'OB_T4';
  await freshCompany(CO);
  const openDate = '2025-01-01';
  // OPEN is the oldest (the seeded period for previous month is AFTER 2025-01-01
  // only if previous month is later — it isn't, so delete it first to be safe).
  await sql(baseUrl, srv.adminToken,
    `DELETE FROM periods WHERE company_id = ?`, [CO]);
  const r1 = await createOpenPeriod(CO, openDate);
  assert.equal(r1.status, 200, `OPEN create failed: ${JSON.stringify(r1.body)}`);

  // Now try to create a period starting on OPEN's date → blocked.
  const r2 = await api(baseUrl, 'period.upsert', {
    companyId: CO,
    period: { period_id: 'FY2025', start_date: openDate, end_date: '2025-12-31' },
  });
  assert.equal(r2.status, 400);
  assert.equal(r2.body.error.code, 'VALIDATION');
  assert.match(r2.body.error.message, /on or before the OPEN period date/i);

  // A period starting AFTER OPEN is fine.
  const r3 = await api(baseUrl, 'period.upsert', {
    companyId: CO,
    period: { period_id: 'FY2026', start_date: '2025-01-02', end_date: '2025-12-31' },
  });
  assert.equal(r3.status, 200, `post-OPEN period failed: ${JSON.stringify(r3.body)}`);
});

// ── openingBalance.post ────────────────────────────────────────────────────

test('openingBalance.post without OPEN journal → error', async () => {
  const CO = 'OB_T5';
  const seeded = await freshCompany(CO);
  // Create OPEN period but NOT the journal.
  await sql(baseUrl, srv.adminToken, `DELETE FROM periods WHERE company_id = ?`, [CO]);
  await createOpenPeriod(CO, '2025-01-01');

  const r = await api(baseUrl, 'openingBalance.post', {
    companyId: CO, userEmail: 'owner@ob',
    lines: [
      { account_code: seeded.AP, debit: 100 },
      { account_code: seeded.accounts[0].account_code, credit: 100 },
    ],
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /OPEN Journal required/i);
});

test('openingBalance.post without OPEN period → error', async () => {
  const CO = 'OB_T6';
  const seeded = await freshCompany(CO);
  await createOpenJournal(CO);
  // No OPEN period created.
  await sql(baseUrl, srv.adminToken, `DELETE FROM periods WHERE company_id = ?`, [CO]);

  const r = await api(baseUrl, 'openingBalance.post', {
    companyId: CO, userEmail: 'owner@ob',
    lines: [
      { account_code: seeded.AP, debit: 100 },
      { account_code: seeded.accounts[0].account_code, credit: 100 },
    ],
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /OPEN Period required/i);
});

test('openingBalance.post with locked OPEN period → error', async () => {
  const CO = 'OB_T7';
  const seeded = await freshCompany(CO);
  await createOpenJournal(CO);
  await sql(baseUrl, srv.adminToken, `DELETE FROM periods WHERE company_id = ?`, [CO]);
  // Create OPEN period locked.
  const r1 = await api(baseUrl, 'period.upsert', {
    companyId: CO,
    period: { period_id: 'OPEN', start_date: '2025-01-01', end_date: '2025-01-01', locked: true },
  });
  assert.equal(r1.status, 200, `locked OPEN create failed: ${JSON.stringify(r1.body)}`);

  const r = await api(baseUrl, 'openingBalance.post', {
    companyId: CO, userEmail: 'owner@ob',
    lines: [
      { account_code: seeded.AP, debit: 100 },
      { account_code: seeded.accounts[0].account_code, credit: 100 },
    ],
  });
  // PERIOD_LOCKED maps to HTTP 409 Conflict.
  assert.equal(r.status, 409);
  assert.match(r.body.error.message, /OPEN Period is locked/i);
});

test('openingBalance.post with valid OPEN journal + period → success, journal_id stamped', async () => {
  const CO = 'OB_T8';
  const seeded = await freshCompany(CO);
  const openJournal = await createOpenJournal(CO);
  const openJournalId = openJournal.journalId;
  await sql(baseUrl, srv.adminToken, `DELETE FROM periods WHERE company_id = ?`, [CO]);
  // Use a date within the seeded accounts' effective_from range (the FY start).
  // TD.fyStart = YYYY-01-01 of the test year; accounts are active from there.
  const openDate = TD.fyStart;
  await createOpenPeriod(CO, openDate);

  // Find an asset account and a liability/equity account for a balanced pair.
  const cash = seeded.accounts.find(a => a.account_type === 'Asset');
  const equity = seeded.accounts.find(a => a.account_type === 'Equity') ||
    seeded.accounts.find(a => a.account_type === 'Liability');
  assert.ok(cash, 'need an Asset account');
  assert.ok(equity, 'need an Equity or Liability account');

  const r = await api(baseUrl, 'openingBalance.post', {
    companyId: CO, userEmail: 'owner@ob',
    lines: [
      { account_code: cash.account_code, debit: 500 },
      { account_code: equity.account_code, credit: 500 },
    ],
  });
  assert.equal(r.status, 200, `openingBalance.post failed: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.data.posted, true);
  assert.ok(r.body.data.batchId, 'should return a batchId');

  // Verify the journal_entries rows: date frozen to OPEN, source = opening_balance,
  // journal_id = OPEN journal, description = "Opening balances".
  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT account_code, date, source, journal_id, description
     FROM journal_entries WHERE company_id = ? AND batch_id = ?`,
    [CO, r.body.data.batchId]
  );
  assert.equal(rows.length, 2, 'batch should have 2 lines');
  for (const row of rows) {
    assert.equal(String(row.date).slice(0, 10), openDate, 'date frozen to OPEN period date');
    assert.equal(row.source, 'opening_balance');
    assert.equal(row.journal_id, openJournalId, 'journal_id stamped as OPEN');
    assert.equal(row.description, 'Opening balances');
  }
});
