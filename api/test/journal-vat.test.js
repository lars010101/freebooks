'use strict';
/**
 * freeBooks — P2-4a VAT/amount convention unify: journal VAT contract tests.
 *
 * Verifies that journal entries are TAX-EXCLUSIVE: the entered debit/credit IS
 * the net, VAT is computed on top (amount × rate) and posted as separate
 * per-code GL lines (mirroring bills.js:396-414). Bank import stays
 * tax-INCLUSIVE (computeVatSplitGross) — covered separately, not here.
 *
 * Cases:
 *   1. Standard tax-exclusive posting: 1000 net + 25% → expense DR 1000,
 *      VAT DR 250, offset CR 1250.
 *   2. Per-code grouping: two lines, same code → ONE VAT GL line (500).
 *   3. Reverse charge: RC code → DR input + CR output pair, nets to zero.
 *   4. No VAT code: single pair, no expansion.
 *
 * Black-box over the action API (HTTP against a throwaway server + DuckDB),
 * same harness as test/contract.test.js. Run: npm test (in api/).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, sql, testDates } = require('../test-utils/helpers');
const TD = testDates();

let srv;
let baseUrl;
const CO = 'JV';
const OWNER = 'owner@jv';
// SE jurisdiction accounts (seeded via setup.add_company jurisdiction='SE').
let EXP1, EXP2, AP;
const VAT_IN_25 = '2641';   // SE25 input (expense / debit side)
const VAT_OUT_25 = '2611';  // SE25 output (revenue / credit side)
const VAT_IN_RC = '2645';   // SERC input
const VAT_OUT_RC = '2614';  // SERC output

before(async () => {
  srv = await startTestServer({ withAdminToken: true });
  baseUrl = srv.baseUrl;

  // Seed a VAT-REGISTERED Swedish company. setup.add_company loads the SE COA
  // + SE VAT codes (SE25, SERC, …) automatically when vat_registered=true.
  const c = await api(baseUrl, 'setup.add_company', {
    company: {
      company_id: CO,
      company_name: 'JV Test AB',
      jurisdiction: 'SE',
      currency: 'SEK',
      fy_start: TD.fyStart,
      fy_end: TD.fyEnd,
      vat_registered: true,
    },
  });
  assert.equal(c.status, 200, `setup.add_company failed: ${JSON.stringify(c.body)}`);

  // Period covering the current month (reversal defaults use today).
  await api(baseUrl, 'period.upsert', {
    companyId: CO,
    period: { period_id: TD.periodId, start_date: TD.startDate, end_date: TD.endDate },
  });

  // Grant an owner so journal.post is authorized (inline — matches contract.test.js).
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     SELECT 'owner@jv', 'JV', 'owner', now(), 'test'
     WHERE NOT EXISTS (SELECT 1 FROM user_permissions WHERE email='owner@jv' AND company_id='JV')`);

  // Pick accounts from the seeded SE COA.
  const coa = await api(baseUrl, 'coa.list', { companyId: CO });
  const accounts = coa.body.data || [];
  EXP1 = accounts.find((a) => a.account_code === '4010');   // Inköp varer (Expense)
  EXP2 = accounts.find((a) => a.account_code === '5010');   // Lokalhyra (Expense)
  AP = accounts.find((a) => a.account_code === '2440');     // Leverantörsskulder (Liability)
  assert.ok(EXP1 && EXP1.account_code, 'Expense account 4010 seeded');
  assert.ok(EXP2 && EXP2.account_code, 'Expense account 5010 seeded');
  assert.ok(AP && AP.account_code, 'AP account 2440 seeded');
});

after(async () => { await srv.cleanup(); });

/** Post lines and return the persisted journal_entries rows for the batch. */
async function postAndFetch(lines, label) {
  const r = await api(baseUrl, 'journal.post', { companyId: CO, userEmail: OWNER, lines });
  assert.equal(r.status, 200, `${label}: post failed: ${JSON.stringify(r.body)}`);
  const batchId = r.body.data.batchId;
  const safe = String(batchId).replace(/'/g, "''");
  const entries = await sql(baseUrl, srv.adminToken,
    `SELECT account_code, debit, credit, vat_code, vat_amount, net_amount, description
     FROM journal_entries WHERE company_id='JV' AND batch_id='${safe}'
     ORDER BY account_code, entry_id`);
  return { batchId, entries, warnings: r.body.data.warnings || [] };
}

function sum(rows, field) {
  return Math.round(rows.reduce((s, r) => s + Number(r[field] || 0), 0) * 100) / 100;
}

// ── 1. Standard tax-exclusive posting ────────────────────────────────────────

test('tax-exclusive journal: 1000 net + SE25 → expense DR 1000, VAT DR 250, offset CR 1250', async () => {
  const { entries } = await postAndFetch([
    { account_code: EXP1.account_code, debit: 1000, vat_code: 'SE25', date: TD.day15, description: 'office supplies' },
    { account_code: AP.account_code, credit: 1250, date: TD.day15, description: 'offset' },
  ], 'std-vat');

  // Three lines: expense (4010), VAT GL (2641), offset (2440).
  assert.equal(entries.length, 3, `expected 3 lines, got ${entries.length}: ${JSON.stringify(entries)}`);

  const expense = entries.find((e) => e.account_code === EXP1.account_code);
  const vatLine = entries.find((e) => e.account_code === VAT_IN_25);
  const offset = entries.find((e) => e.account_code === AP.account_code);

  assert.ok(expense, 'expense line present');
  assert.equal(Number(expense.debit), 1000, 'expense debit = net 1000');
  assert.equal(Number(expense.credit), 0);
  assert.equal(expense.vat_code, null, 'original line vat_code nulled');
  assert.equal(Number(expense.vat_amount), 0, 'original line vat_amount 0');
  assert.equal(Number(expense.net_amount), 1000, 'original line net_amount = entered net');

  assert.ok(vatLine, 'VAT GL line present (2641)');
  assert.equal(Number(vatLine.debit), 250, 'VAT GL debit = 250 (1000 × 25%)');
  assert.equal(Number(vatLine.credit), 0);
  assert.equal(vatLine.vat_code, 'SE25', 'VAT GL line carries the code');
  assert.equal(Number(vatLine.vat_amount), 250, 'VAT GL vat_amount = 250');
  assert.equal(Number(vatLine.net_amount), 0, 'VAT GL net_amount = 0');
  assert.match(String(vatLine.description || ''), /VAT 25%/i, 'VAT GL description tags the rate');

  assert.ok(offset, 'offset line present');
  assert.equal(Number(offset.credit), 1250, 'offset credit = gross 1250');

  // The posted batch balances (net + VAT = gross).
  assert.equal(sum(entries, 'debit'), 1250, 'total debit = 1250');
  assert.equal(sum(entries, 'credit'), 1250, 'total credit = 1250');
});

// ── 2. Per-code grouping ─────────────────────────────────────────────────────

test('per-code grouping: two lines same SE25 code → ONE VAT GL line of 500', async () => {
  const { entries } = await postAndFetch([
    { account_code: EXP1.account_code, debit: 1000, vat_code: 'SE25', date: TD.day16, description: 'line A' },
    { account_code: EXP2.account_code, debit: 1000, vat_code: 'SE25', date: TD.day16, description: 'line B' },
    { account_code: AP.account_code, credit: 2500, date: TD.day16, description: 'offset' },
  ], 'grouping');

  // Two expense lines + ONE VAT GL line + one offset = 4 lines.
  assert.equal(entries.length, 4, `expected 4 lines, got ${entries.length}: ${JSON.stringify(entries)}`);

  const vatLines = entries.filter((e) => e.account_code === VAT_IN_25);
  assert.equal(vatLines.length, 1, 'exactly ONE VAT GL line for the shared code');
  assert.equal(Number(vatLines[0].debit), 500, 'grouped VAT GL debit = 500 (1000+1000 × 25%)');
  assert.equal(vatLines[0].vat_code, 'SE25');
  assert.equal(Number(vatLines[0].vat_amount), 500);

  const expenses = entries.filter((e) => e.account_code === EXP1.account_code || e.account_code === EXP2.account_code);
  assert.equal(expenses.length, 2, 'two original expense lines preserved');
  for (const e of expenses) {
    assert.equal(e.vat_code, null, 'original line vat_code nulled');
    assert.equal(Number(e.net_amount), 1000);
  }

  assert.equal(sum(entries, 'debit'), 2500, 'total debit = 2500');
  assert.equal(sum(entries, 'credit'), 2500, 'total credit = 2500');
});

// ── 3. Reverse charge ────────────────────────────────────────────────────────

test('reverse charge: SERC → DR input (2645) + CR output (2614), nets to zero', async () => {
  const { entries } = await postAndFetch([
    { account_code: EXP1.account_code, debit: 1000, vat_code: 'SERC', date: TD.day17, description: 'EU purchase RC' },
    { account_code: AP.account_code, credit: 1000, date: TD.day17, description: 'offset (net — RC self-assessed)' },
  ], 'rc');

  // expense + RC input + RC output + offset = 4 lines.
  assert.equal(entries.length, 4, `expected 4 lines, got ${entries.length}: ${JSON.stringify(entries)}`);

  const expense = entries.find((e) => e.account_code === EXP1.account_code);
  const rcIn = entries.find((e) => e.account_code === VAT_IN_RC);
  const rcOut = entries.find((e) => e.account_code === VAT_OUT_RC);
  const offset = entries.find((e) => e.account_code === AP.account_code);

  assert.ok(expense && rcIn && rcOut && offset, 'all four lines present');

  // Original line is net-only (vat nulled).
  assert.equal(Number(expense.debit), 1000);
  assert.equal(expense.vat_code, null);
  assert.equal(Number(expense.net_amount), 1000);

  // RC pair: DR input 250, CR output 250 — nets to zero.
  assert.equal(Number(rcIn.debit), 250, 'RC input DR = 250');
  assert.equal(Number(rcIn.credit), 0);
  assert.equal(rcIn.vat_code, 'SERC');
  assert.equal(Number(rcIn.vat_amount), 250);

  assert.equal(Number(rcOut.credit), 250, 'RC output CR = 250');
  assert.equal(Number(rcOut.debit), 0);
  assert.equal(rcOut.vat_code, 'SERC');
  assert.equal(Number(rcOut.vat_amount), 250);

  // The RC pair nets to zero: 250 DR == 250 CR.
  assert.equal(Number(rcIn.debit) - Number(rcOut.credit), 0, 'RC pair nets to zero');

  // Offset is the NET (RC is self-assessed — never owed to vendor).
  assert.equal(Number(offset.credit), 1000, 'offset credit = net 1000 (RC not owed to vendor)');

  // Whole batch balances: DR (1000 + 250) = CR (250 + 1000) = 1250.
  assert.equal(sum(entries, 'debit'), 1250, 'total debit = 1250');
  assert.equal(sum(entries, 'credit'), 1250, 'total credit = 1250');
});

// ── 4. No VAT code ────────────────────────────────────────────────────────────

test('no VAT code: a plain pair posts with no VAT GL expansion', async () => {
  const { entries } = await postAndFetch([
    { account_code: EXP1.account_code, debit: 100, date: TD.day18, description: 'plain' },
    { account_code: AP.account_code, credit: 100, date: TD.day18, description: 'plain offset' },
  ], 'no-vat');

  // Exactly two lines — no VAT GL lines added.
  assert.equal(entries.length, 2, `expected 2 lines, got ${entries.length}: ${JSON.stringify(entries)}`);
  assert.equal(entries.filter((e) => e.vat_code).length, 0, 'no line carries a vat_code');
  assert.equal(sum(entries, 'debit'), 100);
  assert.equal(sum(entries, 'credit'), 100);
});
