'use strict';

/**
 * freeBooks — SIE import contract tests
 *
 * Black-box tests over the action API (sie.import) plus a direct unit check of
 * decodeBuffer. Mirrors api/test/contract.test.js: throwaway server + DB,
 * companies seeded through the public action API. Assertions are entity-scoped
 * (WHERE reference / company), never global row counts.
 *
 * Run: npm test  (in api/)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, sql, seedCompany, testDates } = require('../test-utils/helpers');
const TD = testDates();
const { decodeBuffer } = require('../src/sie-import');

let srv;
let baseUrl;

before(async () => {
  srv = await startTestServer({ withAdminToken: true });
  baseUrl = srv.baseUrl;
});

after(async () => { await srv.cleanup(); });

// ── 1. decodeBuffer ───────────────────────────────────────────────────────────

test('decodeBuffer: CP437 byte 0x86 decodes to å; valid UTF-8 decodes as UTF-8', () => {
  // 0x86 is not a valid UTF-8 lead byte → falls back to CP437, where 0x86 = 'å'.
  const cp437 = decodeBuffer(Buffer.from([0x86]));
  assert.equal(cp437, 'å', 'CP437 0x86 → å');

  // A valid UTF-8 buffer decodes via the UTF-8 path.
  const utf8 = decodeBuffer(Buffer.from('Café åäö', 'utf-8'));
  assert.equal(utf8, 'Café åäö', 'UTF-8 buffer preserved');
});

// ── 2. Round-trip: export company A → import into company B ───────────────────

const A = 'SIE_A';
const B = 'SIE_B';

// Shared across the round-trip tests (2 & 3): primed by the first round-trip
// test, reused by the dryRun:false import + duplicate re-import. node:test runs
// tests sequentially within a file.
let sharedBase64 = null;

test('round-trip: A posts entries, export SIE, dryRun import into B writes nothing', async () => {
  const sa = await seedCompany(baseUrl, A, { jurisdiction: 'SE', currency: 'SEK' });
  const sb = await seedCompany(baseUrl, B, { jurisdiction: 'SE', currency: 'SEK' });
  // seedCompany's AP heuristic matches /payable/i — English-only. SE BAS 2440 is
  // "Leverantörsskulder", so pick accounts from the returned list directly.
  sa.AP = sa.accounts.find((a) => a.account_code === '2440')?.account_code
    || sa.accounts.find((a) => a.account_type === 'Liability')?.account_code;
  sa.EXP = sa.EXP || sa.accounts.find((a) => a.account_type === 'Expense')?.account_code;
  assert.ok(sa.EXP && sa.AP, 'SE BAS template yields AP + Expense accounts');

  // SE template accounts are effective_from the company FY start,
  // so entries must post inside the FY; seedCompany already created the current month period.
  // Post 3 balanced entries in A (2026-07-15, inside the seeded period).
  for (const amt of [100, 50, 25]) {
    const r = await api(baseUrl, 'journal.post', {
      companyId: A,
      lines: [
        { account_code: sa.EXP, debit: amt, date: TD.day15, description: `entry ${amt}` },
        { account_code: sa.AP, credit: amt, date: TD.day15, description: `entry ${amt}` },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }

  // Export A as SIE 4 for FY2026.
  const sieRes = await fetch(`${baseUrl}/api/${A}/report?type=sie&start=${TD.fyStart}&end=${TD.fyEnd}`);
  assert.equal(sieRes.status, 200);
  const sieBuf = Buffer.from(await sieRes.arrayBuffer());
  assert.ok(sieBuf.length > 0, 'SIE export non-empty');
  const contentBase64 = sieBuf.toString('base64');
  sharedBase64 = contentBase64;

  // dryRun defaults to true → B must have ZERO journal entries afterwards.
  const dry = await api(baseUrl, 'sie.import', { companyId: B, contentBase64 });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.data.dryRun, true, 'dryRun defaults true');
  assert.equal(dry.body.data.vouchers.imported, 3, '3 vouchers would be imported (hypothetical)');

  const bCount = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM journal_entries WHERE company_id='${B}'`);
  assert.equal(Number(bCount[0].c), 0, 'dryRun writes no journal entries to B');
});

test('round-trip: dryRun:false import → B balances equal A; reconciliation clean', async () => {
  assert.ok(sharedBase64, 'sharedBase64 primed by the dryRun test');
  const real = await api(baseUrl, 'sie.import', { companyId: B, contentBase64: sharedBase64, dryRun: false });
  assert.equal(real.status, 200, JSON.stringify(real.body));
  assert.equal(real.body.data.dryRun, false);
  assert.equal(real.body.data.vouchers.imported, 3, '3 vouchers imported');
  assert.equal(real.body.data.vouchers.failed.length, 0, 'no failed vouchers');
  assert.deepEqual(real.body.data.reconciliation.diffs, [], 'reconciliation has no diffs');

  // Per-account balances in B must equal A's for the period.
  const balA = await sql(baseUrl, srv.adminToken,
    `SELECT account_code, ROUND(SUM(debit_home - credit_home), 2) bal
     FROM journal_entries WHERE company_id='${A}' GROUP BY account_code`);
  const balB = await sql(baseUrl, srv.adminToken,
    `SELECT account_code, ROUND(SUM(debit_home - credit_home), 2) bal
     FROM journal_entries WHERE company_id='${B}' GROUP BY account_code`);
  const mapA = Object.fromEntries(balA.map((r) => [r.account_code, Number(r.bal)]));
  const mapB = Object.fromEntries(balB.map((r) => [r.account_code, Number(r.bal)]));
  assert.deepEqual(mapB, mapA, 'B per-account balances match A');
});

// ── 3. Duplicate re-import ────────────────────────────────────────────────────

test('duplicate re-import: imported 0, skippedDuplicate === all', async () => {
  const again = await api(baseUrl, 'sie.import', { companyId: B, contentBase64: sharedBase64, dryRun: false });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.data.vouchers.imported, 0, 're-import imports nothing');
  assert.equal(again.body.data.vouchers.skippedDuplicate, 3, 'all 3 skipped as duplicates');
});

// ── 2b. Jurisdiction gating (integrations.sie in the pack) ───────────────────

test('jurisdiction gating: sie.import + SIE export reject non-SE companies', async () => {
  const SG = 'SIE_SG';
  await seedCompany(baseUrl, SG, { jurisdiction: 'SG', currency: 'SGD' });

  const imp = await api(baseUrl, 'sie.import', { companyId: SG, content: '#SIETYP 4\n', dryRun: false });
  assert.equal(imp.status, 400, JSON.stringify(imp.body));
  assert.match(imp.body.error.message, /SIE import not available for jurisdiction SG/);

  const exp = await fetch(`${baseUrl}/api/${SG}/report?type=sie&start=${TD.fyStart}&end=${TD.fyEnd}`);
  assert.equal(exp.status, 400);
  const expBody = await exp.json();
  assert.match(expBody.error, /SIE export not available for jurisdiction SG/);

  // SE stays allowed (pack declares integrations.sie) — dryRun parse of a
  // minimal file reaches the normal response shape, not a gate rejection.
  const SE1 = 'SIE_SE1';
  await seedCompany(baseUrl, SE1, { jurisdiction: 'SE', currency: 'SEK' });
  const okImp = await api(baseUrl, 'sie.import', { companyId: SE1, content: `#SIETYP 4\n#RAR 0 ${TD.sieFYStart} ${TD.sieFYEnd}\n` });
  assert.equal(okImp.status, 200, JSON.stringify(okImp.body));
});

// ── 4. Unbalanced #VER fails, balanced imports ───────────────────────────────

test('unbalanced #VER is failed, balanced #VER imports', async () => {
  const C = 'SIE_C';
  await seedCompany(baseUrl, C, { jurisdiction: 'SE', currency: 'SEK' });

  const sie = [
    '#FLAGGA 0',
    '#PROGRAM "test" "1"',
    '#FORMAT PC8',
    '#SIETYP 4',
    `#RAR 0 ${TD.sieFYStart} ${TD.sieFYEnd}`,
    '#KONTO 1910 "Bank"',
    '#KONTO 2440 "AP"',
    `#VER A 1 ${TD.sieDay15} "balanced"`,
    '{',
    `#TRANS 1910 {} 50 ${TD.sieDay15}`,
    `#TRANS 2440 {} -50 ${TD.sieDay15}`,
    '}',
    `#VER A 2 ${TD.sieDay15} "unbalanced"`,
    '{',
    `#TRANS 1910 {} 30 ${TD.sieDay15}`,
    `#TRANS 2440 {} -10 ${TD.sieDay15}`,
    '}',
    '',
  ].join('\r\n');

  const r = await api(baseUrl, 'sie.import', { companyId: C, content: sie, dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.vouchers.imported, 1, 'balanced voucher imported');
  assert.equal(r.body.data.vouchers.failed.length, 1, 'unbalanced voucher failed');
  assert.equal(r.body.data.vouchers.failed[0].ref, 'SIE A 2');
  assert.ok(/Unbalanced/.test(r.body.data.vouchers.failed[0].errors.join('; ')));

  // Entity-scoped: only the balanced voucher's lines reached the ledger.
  const rows = await sql(baseUrl, srv.adminToken,
    `SELECT reference, COUNT(*) n FROM journal_entries
     WHERE company_id='${C}' AND source='sie_import' GROUP BY reference`);
  const byRef = Object.fromEntries(rows.map((x) => [x.reference, Number(x.n)]));
  assert.equal(byRef['SIE A 1'], 2, 'balanced voucher has 2 lines');
  assert.equal(byRef['SIE A 2'], undefined, 'unbalanced voucher wrote nothing');
});

// ── 5. #RTRANS excluded / #BTRANS included ────────────────────────────────────

test('#RTRANS excluded, #BTRANS included — imported lines reflect TRANS+BTRANS only', async () => {
  const D = 'SIE_D';
  await seedCompany(baseUrl, D, { jurisdiction: 'SE', currency: 'SEK' });

  const sie = [
    '#FLAGGA 0',
    '#PROGRAM "test" "1"',
    '#FORMAT PC8',
    '#SIETYP 4',
    `#RAR 0 ${TD.sieFYStart} ${TD.sieFYEnd}`,
    '#KONTO 1910 "Bank"',
    '#KONTO 2440 "AP"',
    `#VER A 1 ${TD.sieDay15} "mixed"`,
    '{',
    `#TRANS 1910 {} 100 ${TD.sieDay15}`,
    `#RTRANS 1910 {} -50 ${TD.sieDay15}`,
    `#BTRANS 2440 {} -100 ${TD.sieDay15}`,
    '}',
    '',
  ].join('\r\n');

  const r = await api(baseUrl, 'sie.import', { companyId: D, content: sie, dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.vouchers.imported, 1, 'voucher imported (TRANS+BTRANS balance)');
  assert.equal(r.body.data.dimsDiscarded, 3, 'three {…} dim lists discarded');

  // 1910 net = +100 (the -50 RTRANS must NOT be counted); 2440 = -100.
  const bal = await sql(baseUrl, srv.adminToken,
    `SELECT account_code, ROUND(SUM(debit_home - credit_home), 2) bal
     FROM journal_entries WHERE company_id='${D}' AND reference='SIE A 1' GROUP BY account_code`);
  const map = Object.fromEntries(bal.map((x) => [x.account_code, Number(x.bal)]));
  assert.equal(map['1910'], 100, '1910 = +100 (RTRANS -50 excluded)');
  assert.equal(map['2440'], -100, '2440 = -100 (BTRANS included)');
  assert.equal(Object.keys(map).length, 2, 'exactly 2 account lines');
});

// ── 6. SIE type 1: only #KONTO + #RAR + #IB (summing to 0) ────────────────────

test('SIE type 1: opening balances posted, no vouchers', async () => {
  const E = 'SIE_E';
  await seedCompany(baseUrl, E, { jurisdiction: 'SE', currency: 'SEK' });

  const sie = [
    '#FLAGGA 0',
    '#PROGRAM "test" "1"',
    '#FORMAT PC8',
    '#SIETYP 1',
    `#RAR 0 ${TD.sieFYStart} ${TD.sieFYEnd}`,
    '#KONTO 1910 "Bank"',
    '#KONTO 2010 "Equity"',
    '#IB 0 1910 100',
    '#IB 0 2010 -100',
    '',
  ].join('\r\n');

  const r = await api(baseUrl, 'sie.import', { companyId: E, content: sie, dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.vouchers.inFile, 0, 'no vouchers in file');
  assert.equal(r.body.data.vouchers.imported, 0);
  assert.ok(r.body.data.openingBalance.posted, 'opening balance posted');
  assert.equal(r.body.data.openingBalance.inFile, 2, '2 #IB rows');

  // The OB batch exists, balanced, scoped to company + reference.
  const ob = await sql(baseUrl, srv.adminToken,
    `SELECT ROUND(SUM(debit_home),2) dr, ROUND(SUM(credit_home),2) cr, COUNT(*) n
     FROM journal_entries WHERE company_id='${E}' AND reference='SIE OB'`);
  assert.equal(Number(ob[0].n), 2, '2 OB lines posted');
  assert.equal(Number(ob[0].dr), Number(ob[0].cr), 'OB balanced');
  assert.equal(Number(ob[0].dr), 100);

  // No voucher-sourced rows.
  const v = await sql(baseUrl, srv.adminToken,
    `SELECT COUNT(*) c FROM journal_entries WHERE company_id='${E}' AND source='sie_import' AND reference <> 'SIE OB'`);
  assert.equal(Number(v[0].c), 0, 'no voucher rows');
});
