'use strict';
/**
 * SRU INK2 golden test — reconstructs Magnus Davidson Utveckling AB's real filed
 * 2024 books from the journal + balance-sheet CSV exports, then asserts the
 * generated blanketter.sru is byte-identical (modulo #IDENTITET timestamp) to
 * the reference file.
 *
 * Plain node script: exit 1 on mismatch, no test framework.
 *   node tests/sru-golden-2024.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const API = 'http://localhost:4722/api';
const SRU_GET = (c, qs) => `http://localhost:4722/api/${c}/sru/ink2?${qs}`;
const REFERENCE = '/home/ubuntu/accounting/workspace-legal-accountant/mdu_ab_blanketter_2024_reference.sru';
const JOURNAL_CSV = '/home/ubuntu/.hermes/profiles/accountant/cache/documents/doc_ef85f26ea0c4_journal_2024-01-01_2024-12-31.csv';
const BS_CSV = '/home/ubuntu/.hermes/profiles/accountant/cache/documents/doc_aeee68fa39a0_bs_2024-01-01_2024-12-31.csv';

const COMPANY_ID = 'zz_srugold3';

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function apiPost(action, companyId, body, idempotencyKey) {
  const payload = { action, companyId, ...(body || {}) };
  if (idempotencyKey) payload.idempotencyKey = idempotencyKey;
  const headers = { 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(API, { method: 'POST', headers, body: JSON.stringify(payload) });
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`API ${action} failed: ${JSON.stringify(json.error)}`);
  }
  return json.data;
}

async function apiGetText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}: ${await res.text()}`);
  return res.text();
}

async function apiGetJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── CSV parsing ──────────────────────────────────────────────────────────────
// Quoted CSV with a comma thousands separator inside amounts ("1,205.00").
function parseCsv(text) {
  const rows = [];
  let i = 0, field = '', inQuotes = false;
  const chars = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let row = [];
  while (i < chars.length) {
    const ch = chars[i];
    if (inQuotes) {
      if (ch === '"') {
        if (chars[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // Drop fully-empty trailing rows.
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

// Parse an amount cell: strip thousands commas, parenthesized → negative.
function parseAmount(s) {
  if (s == null) return 0;
  let t = String(s).trim();
  if (t === '') return 0;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  t = t.replace(/,/g, '').trim();
  if (t === '') return 0;
  let n = Number(t);
  if (isNaN(n)) return 0;
  return neg ? -n : n;
}

// ── Step 1: create company ────────────────────────────────────────────────────
async function ensureCompany() {
  const company = {
    company_id: COMPANY_ID,
    company_name: 'Magnus Davidson Utveckling AB',
    jurisdiction: 'SE',
    currency: 'SEK',
    reporting_standard: 'K2',
    vat_registered: false,
    tax_id: '556880-6854',
    fy_start: '2023-01-01',
    fy_end: '2024-12-31',
  };
  try {
    await apiPost('setup.add_company', 'x', { company }, 'gold-setup');
    console.log('Company created.');
  } catch (e) {
    if (String(e.message).includes('already exists') || String(e.message).includes('DUPLICATE')) {
      console.log('Company already exists — continuing (idempotent rerun).');
    } else {
      throw e;
    }
  }
}

// ── Step 2: upsert account 8314 + period + any missing accounts ───────────────
// The SE COA template lacks several accounts that appear in the 2024 books
// (e.g. 2098, 2898, 1350, 1941, 1942, 1980, 2490, 2893). We upsert every
// referenced account that is missing, inferring its type from the BS section
// header (Asset/Equity/Liability) and falling back to BAS-range heuristics
// for P&L / closing accounts that only appear in the journal.
function inferTypeFromCode(code) {
  const c = String(code);
  if (c === '8314') return 'Revenue';
  if (c === '8999') return 'Closing';
  if (c.startsWith('8')) return 'Revenue'; // 8xxx financial income by BAS
  if (c.startsWith('7') || c.startsWith('6') || c.startsWith('5') || c.startsWith('4') || c.startsWith('3')) return 'Expense';
  if (c.startsWith('20')) return 'Equity';
  if (c.startsWith('2')) return 'Liability';
  if (c.startsWith('1')) return 'Asset';
  return 'Asset';
}

async function ensureAccountAndPeriod(journalData, bsData, idx, bsIdx) {
  // Track the BS section (Asset/Equity/Liability) as we walk the BS rows.
  let section = 'Asset';
  const bsAccountMeta = {}; // code -> {name, type}
  for (const row of bsData) {
    const code = (row[bsIdx['Code']] || '').trim();
    const desc = (row[bsIdx['Description']] || '').trim();
    if (!code) {
      if (desc === 'Asset' || desc === 'Equity' || desc === 'Liability') section = desc;
      continue;
    }
    const type = section === 'Asset' ? 'Asset' : section === 'Equity' ? 'Equity' : 'Liability';
    bsAccountMeta[code] = { name: desc, type };
  }

  // Account names from the journal (Account Name column).
  const journalAccountName = {};
  for (const row of journalData) {
    const acct = (row[idx['Account']] || '').trim();
    if (!acct) continue;
    const name = (row[idx['Account Name']] || '').trim();
    if (name) journalAccountName[acct] = name;
  }

  // Union of all referenced accounts.
  const needed = new Set([
    ...Object.keys(journalAccountName),
    ...Object.keys(bsAccountMeta),
  ]);

  // Always ensure 8314 is Revenue (template lacks it).
  needed.add('8314');

  const existing = await apiPost('coa.list', COMPANY_ID, {}, 'gold-coa-list');
  const existingCodes = new Set(existing.map(a => a.account_code));

  const subtypeFor = (code, type) => {
    if (type === 'Asset') return 'Current Assets';
    if (type === 'Equity') return 'Equity';
    if (type === 'Liability') return 'Current Liabilities';
    if (type === 'Revenue') return 'Financial Items';
    if (type === 'Expense') return 'Operating Expenses';
    return 'Other';
  };

  for (const code of [...needed].sort()) {
    if (existingCodes.has(code)) {
      // 8314 may exist with wrong type — force it to Revenue via upsert.
      if (code !== '8314') continue;
    }
    const meta = bsAccountMeta[code];
    const type = meta ? meta.type : inferTypeFromCode(code);
    const name = (meta && meta.name) || journalAccountName[code] || `Account ${code}`;
    await apiPost('coa.upsert', COMPANY_ID, {
      account: {
        account_code: code,
        account_name: name,
        account_type: type,
        account_subtype: subtypeFor(code, type),
        is_active: true,
        effective_from: '2023-01-01',
      },
    }, `gold-coa-${code}`);
  }

  await apiPost('period.upsert', COMPANY_ID, {
    period: { period_id: 'FY2023', start_date: '2023-01-01', end_date: '2023-12-31', locked: false },
  }, 'gold-period-2023');
  await apiPost('period.upsert', COMPANY_ID, {
    period: { period_id: 'FY2024', start_date: '2024-01-01', end_date: '2024-12-31', locked: false },
  }, 'gold-period-2024');
}

// ── Step 3-6: parse CSVs, post opening plug, post journal entries, verify BS ──
async function loadAndPostBooks(journalData, bsData, idx, bsIdx) {
  // Per-account 2024 net movement (DR - CR). Skip rows where both Debit & Credit empty.
  const movement = {};
  for (const row of journalData) {
    const acct = (row[idx['Account']] || '').trim();
    if (!acct) continue;
    const dr = parseAmount(row[idx['Debit']]);
    const cr = parseAmount(row[idx['Credit']]);
    if (dr === 0 && cr === 0) continue; // trailing zero row (2898)
    movement[acct] = (movement[acct] || 0) + (dr - cr);
  }

  // BS closing balances. Convert BS "Balance" (natural sign by section) to
  // DR-CR using the account type, which we read from the COA via coa.list.
  const closingNatural = {}; // account -> raw BS balance (natural sign, paren neg)
  for (const row of bsData) {
    const code = (row[bsIdx['Code']] || '').trim();
    if (!code) continue; // section header rows have no Code
    const bal = parseAmount(row[bsIdx['Balance']]);
    closingNatural[code] = bal;
  }

  // Account types from the server (to convert natural balance → DR-CR).
  const accounts = await apiPost('coa.list', COMPANY_ID, {}, 'gold-coa-list');
  const acctType = {};
  for (const a of accounts) acctType[a.account_code] = a.account_type;

  // Convert BS closing to DR-CR convention.
  // Asset/Expense → natural == DR-CR (positive = DR). Equity/Liability/Revenue/Closing → DR-CR = -natural.
  function toDrCr(code, natural) {
    const t = acctType[code];
    if (t === 'Equity' || t === 'Liability' || t === 'Revenue') return -natural;
    return natural; // Asset, Expense, Closing, unknown
  }
  const closingDrCr = {};
  for (const code of Object.keys(closingNatural)) {
    closingDrCr[code] = toDrCr(code, closingNatural[code]);
  }

  // Union of all accounts that appear in journal movement or BS closing.
  // Opening plug = closing(DR-CR) − movement(DR-CR) for EVERY account (full
  // opening trial balance): BS accounts get their opening balances; P&L
  // accounts (absent from the BS CSV, closing 0) get their reversed year
  // movements. Balances in total because every journal entry balances and the
  // closing TB balances. Dated 2023-12-31 (BEFORE the fiscal year) so the
  // SRU "within-year" sums stay equal to the real 2024 journal movements.
  const bsAccounts = new Set(Object.keys(closingDrCr));
  const allAccounts = new Set([...Object.keys(movement), ...bsAccounts]);

  const plugs = [];
  const plugTable = [];
  for (const acct of [...allAccounts].sort()) {
    const mov = movement[acct] || 0;
    const clos = closingDrCr[acct] || 0; // P&L accounts close at 0
    const plug = clos - mov;
    if (Math.abs(plug) > 0.005) {
      plugs.push({ account_code: acct, debit: plug > 0 ? Number(plug.toFixed(2)) : 0, credit: plug < 0 ? Number(Math.abs(plug).toFixed(2)) : 0 });
      plugTable.push({ acct, closing: clos, movement: mov, plug });
    }
  }

  // Assert the opening plug balances in total (DR == CR).
  const totalDr = plugs.reduce((s, p) => s + p.debit, 0);
  const totalCr = plugs.reduce((s, p) => s + p.credit, 0);
  if (Math.abs(totalDr - totalCr) > 0.005) {
    console.error('Opening plug does NOT balance!');
    console.error(`Total DR = ${totalDr.toFixed(2)}, Total CR = ${totalCr.toFixed(2)}`);
    console.table(plugTable.map(p => ({ account: p.acct, closing: p.closing.toFixed(2), movement: p.movement.toFixed(2), plug: p.plug.toFixed(2) })));
    process.exit(1);
  }
  console.log(`Opening plug balances: DR ${totalDr.toFixed(2)} == CR ${totalCr.toFixed(2)} (${plugs.length} lines).`);

  // Post the opening plug as ONE journal.post dated 2023-12-31, ref 'Opening plug'.
  await apiPost('journal.post', COMPANY_ID, {
    lines: plugs.map(p => ({
      date: '2023-12-31',
      account_code: p.account_code,
      debit: p.debit,
      credit: p.credit,
      reference: 'Opening plug',
      description: 'Opening plug',
    })),
  }, 'gold-ob');

  // ── Post 2024 journal entries grouped by (Date, Reference) ──────────────
  // Skip the zero rows again. description = Description column.
  const groups = new Map();
  let n = 0;
  for (const row of journalData) {
    const date = (row[idx['Date']] || '').trim();
    const ref = (row[idx['Reference']] || '').trim();
    const acct = (row[idx['Account']] || '').trim();
    if (!date || !acct) continue;
    const dr = parseAmount(row[idx['Debit']]);
    const cr = parseAmount(row[idx['Credit']]);
    if (dr === 0 && cr === 0) continue;
    const desc = (row[idx['Description']] || '').trim();
    const key = `${date}||${ref}`;
    if (!groups.has(key)) groups.set(key, { date, reference: ref, lines: [] });
    groups.get(key).lines.push({ date, account_code: acct, debit: dr, credit: cr, reference: ref, description: desc });
    n++;
  }
  console.log(`Posting ${groups.size} journal groups (${n} non-zero lines).`);

  let gi = 0;
  for (const [, g] of groups) {
    gi++;
    await apiPost('journal.post', COMPANY_ID, { lines: g.lines }, `gold-${gi}`);
  }

  // ── Verify closing balances == BS CSV ───────────────────────────────────
  const mismatches = [];
  for (const code of Object.keys(closingDrCr)) {
    const expected = closingDrCr[code];
    const balRows = await apiPost('journal.account_balance', COMPANY_ID, { account_code: code }, `gold-bal-${code}`);
    const actual = Number(balRows[0]?.balance ?? 0);
    if (Math.abs(actual - expected) > 0.005) {
      mismatches.push({ account: code, expected: expected.toFixed(2), actual: actual.toFixed(2) });
    }
  }
  // Note: P&L accounts (Revenue/Expense/Closing) are not listed on the BS and are
  // not closed out to zero in this dataset, so they retain their year-end
  // movement balances — we do NOT assert they net to 0. Only BS accounts are
  // compared to the BS CSV.
  if (mismatches.length) {
    console.error('Closing balance mismatches vs BS CSV:');
    console.table(mismatches);
    process.exit(1);
  }
  console.log(`Closing balances match BS CSV for ${Object.keys(closingDrCr).length} BS accounts.`);
}

// ── Step 7-8: generate SRU, diff vs reference, check=1 warnings ───────────────
function normalizeIdent(text) {
  return text.replace(/^(#IDENTITET \d+ )\d{8} \d{6}$/gm, '$1<TIMESTAMP>');
}

async function generateAndCompare() {
  const url = SRU_GET(COMPANY_ID, 'year=2024&loss_cf=85146');
  const generated = await apiGetText(url);
  const reference = fs.readFileSync(REFERENCE, 'utf8');

  const gNorm = normalizeIdent(generated).split('\n');
  const rNorm = normalizeIdent(reference).split('\n');

  if (gNorm.join('\n') === rNorm.join('\n')) {
    console.log('GOLDEN PASS');
  } else {
    console.error('GOLDEN FAIL — diff (generated vs reference):');
    const maxLen = Math.max(gNorm.length, rNorm.length);
    for (let i = 0; i < maxLen; i++) {
      const g = gNorm[i] !== undefined ? gNorm[i] : '<EOF>';
      const r = rNorm[i] !== undefined ? rNorm[i] : '<EOF>';
      if (g !== r) {
        console.error(`@@ line ${i + 1}`);
        console.error(`- ref : ${JSON.stringify(r)}`);
        console.error(`+ gen : ${JSON.stringify(g)}`);
      }
    }
    process.exit(1);
  }

  // check=1 warnings
  const checkUrl = SRU_GET(COMPANY_ID, 'year=2024&loss_cf=85146&check=1');
  const check = await apiGetJson(checkUrl);
  console.log('\ncheck=1 fields:', JSON.stringify(check.fields, null, 2));
  console.log('check=1 warnings:', JSON.stringify(check.warnings, null, 2));

  // Also print the generated SRU for reference.
  console.log('\n--- Generated blanketter.sru ---');
  console.log(generated);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  try {
    console.log('=== SRU Golden Test (2024) ===');
    await ensureCompany();

    // Parse CSVs once, share between account-setup and book-posting.
    const journalRows = parseCsv(fs.readFileSync(JOURNAL_CSV, 'utf8'));
    const bsRows = parseCsv(fs.readFileSync(BS_CSV, 'utf8'));
    const journalHeader = journalRows[0].map(h => h.trim());
    const idx = Object.fromEntries(journalHeader.map((h, i) => [h, i]));
    const journalData = journalRows.slice(1);
    const bsHeader = bsRows[0].map(h => h.trim());
    const bsIdx = Object.fromEntries(bsHeader.map((h, i) => [h, i]));
    const bsData = bsRows.slice(1);

    await ensureAccountAndPeriod(journalData, bsData, idx, bsIdx);
    await loadAndPostBooks(journalData, bsData, idx, bsIdx);
    await generateAndCompare();
    console.log('\nDone.');
  } catch (e) {
    console.error('Golden test error:', e);
    process.exit(1);
  }
})();
