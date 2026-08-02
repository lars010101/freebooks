'use strict';

// ── SIE import (Standard Import Export, SIE-gruppen spec v1–v4) ───────────────
// Parses a SIE file (chart of accounts, fiscal years, opening/closing/result
// balances, vouchers) and imports it into a freebooks company: upserts missing
// accounts, auto-creates calendar-year periods for voucher/OB dates that have
// none, posts vouchers as balanced journal_batches, and optionally posts the
// year-0 opening balance. A reconciliation cross-check compares declared
// #UB/#RES against computed (#IB + voucher movement) per account — warn-only.
//
// Encoding: the file is tried as UTF-8 (fatal) first; on failure it is decoded
// as IBM code page 437 (PC8), the encoding the SIE 4 export emits.
//
// Conventions (mirror sie-export.js):
//   - Amounts are debit-positive (credits negative); Number() preserves sign.
//   - Revenue/Expense/Closing accounts → #RES (year movement); others → #IB/#UB.
//   - Round-trips the freebooks SIE 4 export: serie "A", verno 1..n, reference
//     "SIE A <verno>", one batch_id per voucher.

const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert } = require('./db');
const { packIntegration } = require('./jurisdiction-packs');

// ── CP437 decode ─────────────────────────────────────────────────────────────
// Standard IBM code page 437 mapping for bytes 0x80–0xFF (128 code points,
// index = byte − 0x80). The SIE 4 export emits PC8; Swedish chars å/ä/ö/Å/Ä/Ö
// live here (0x86=å, 0x84=ä, 0x94=ö, 0x8F=Å, 0x8E=Ä, 0x99=Ö, 0x9A=Ü, 0x82=é).
const CP437_HIGH = [
  0x00C7,0x00FC,0x00E9,0x00E2,0x00E4,0x00E0,0x00E5,0x00E7,0x00EA,0x00EB,0x00E8,0x00EF,0x00EE,0x00EC,0x00C4,0x00C5, // 80-8F
  0x00C9,0x00E6,0x00C6,0x00F4,0x00F6,0x00F2,0x00FB,0x00F9,0x00FF,0x00D6,0x00DC,0x00A2,0x00A3,0x00A5,0x20A7,0x0192, // 90-9F
  0x00E1,0x00ED,0x00F3,0x00FA,0x00F1,0x00D1,0x00AA,0x00BA,0x00BF,0x2310,0x00AC,0x00BD,0x00BC,0x00A1,0x00AB,0x00BB, // A0-AF
  0x2591,0x2592,0x2593,0x2502,0x2524,0x2561,0x2562,0x2556,0x2555,0x2563,0x2551,0x2557,0x255D,0x255C,0x255B,0x2510, // B0-BF
  0x2514,0x2534,0x252C,0x251C,0x2500,0x253C,0x255E,0x255F,0x255A,0x2554,0x2569,0x2566,0x2560,0x2550,0x256C,0x2559, // C0-CF
  0x2558,0x2565,0x2564,0x2555,0x2552,0x2553,0x256B,0x256A,0x2558,0x250C,0x2588,0x2584,0x258C,0x2590,0x2580,0x03B1, // D0-DF (0xD8 placeholder; never in SIE)
  0x03B2,0x0393,0x03C0,0x03A3,0x03C3,0x00B5,0x03C4,0x03A6,0x0398,0x03A9,0x03B4,0x221E,0x03C6,0x03B5,0x2229,0x2261, // E0-EF
  0x00B1,0x2265,0x2264,0x2320,0x2321,0x00F7,0x2248,0x00B0,0x2219,0x00B7,0x221A,0x207F,0x00B2,0x25A0,0x00A0,0x00A0, // F0-FF
];
const CP437_HIGH_STR = CP437_HIGH.map((cp) => String.fromCharCode(cp)).join('');

function decodeBuffer(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    let out = '';
    for (let i = 0; i < b.length; i++) {
      const byte = b[i];
      out += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH_STR[byte - 0x80];
    }
    return out;
  }
}

// ── Tokenizer ────────────────────────────────────────────────────────────────
// SIE tokens: quoted strings "..." (no escapes per spec), { , } , and bare
// words. One logical line → one record; handle \r\n and \n.
function tokenizeLine(line) {
  const tokens = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < n && line[j] !== '"') j++;
      tokens.push({ type: 'string', value: line.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (c === '{' || c === '}') {
      tokens.push({ type: 'brace', value: c });
      i++;
      continue;
    }
    let j = i;
    while (j < n && line[j] !== ' ' && line[j] !== '\t' && line[j] !== '\r'
           && line[j] !== '"' && line[j] !== '{' && line[j] !== '}') j++;
    tokens.push({ type: 'word', value: line.slice(i, j) });
    i = j;
  }
  return tokens;
}

function convDate(s) {
  if (!s || typeof s !== 'string') return null;
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  return s;
}

function tokValue(tok) { return tok ? tok.value : null; }

// ── Parser ───────────────────────────────────────────────────────────────────
function parseSie(buf) {
  const text = Buffer.isBuffer(buf) ? decodeBuffer(buf) : String(buf);
  const lines = text.split(/\r\n|\n|\r/);

  const meta = {
    flagga: null, program: null, format: null, gen: null, sieType: 4,
    fnamn: null, orgnr: null, valuta: null, kptyp: null,
  };
  const years = [];
  const accounts = [];
  const ktypeMap = {};
  const balances = [];
  const vouchers = [];
  const ignoredTags = {};
  let dimsDiscarded = 0;
  const warnings = [];
  let currentVoucher = null;

  const ignore = (tag) => { ignoredTags[tag] = (ignoredTags[tag] || 0) + 1; };

  for (const rawLine of lines) {
    if (rawLine.trim() === '') continue;
    const tokens = tokenizeLine(rawLine);
    if (tokens.length === 0) continue;
    const first = tokens[0];
    if (first.type !== 'word' || !first.value.startsWith('#')) {
      // Non-tag line (e.g. a stray `{`/`}` on its own line) — the voucher open/
      // close braces are handled inline when they appear as the first token.
      if (first.type === 'brace' && first.value === '}') {
        if (currentVoucher) { vouchers.push(currentVoucher); currentVoucher = null; }
      }
      continue;
    }

    const tag = first.value;
    const rest = tokens.slice(1);

    switch (tag) {
      case '#FLAGGA': meta['flagga'] = tokValue(rest[0]); break;
      case '#PROGRAM':
        meta.program = { name: tokValue(rest[0]), version: tokValue(rest[1]) };
        break;
      case '#FORMAT': meta.format = tokValue(rest[0]); break;
      case '#GEN': meta.gen = tokValue(rest[0]); break;
      case '#SIETYP': meta.sieType = rest[0] ? Number(rest[0].value) : 4; break;
      case '#FNAMN': meta.fnamn = tokValue(rest[0]); break;
      case '#ORGNR': meta.orgnr = tokValue(rest[0]); break;
      case '#VALUTA': meta.valuta = tokValue(rest[0]); break;
      case '#KPTYP': meta.kptyp = tokValue(rest[0]); break;
      case '#RAR': {
        const idx = rest[0] ? Number(rest[0].value) : 0;
        const start = convDate(tokValue(rest[1]));
        const end = convDate(tokValue(rest[2]));
        years.push({ idx, start, end });
        break;
      }
      case '#KONTO':
        accounts.push({
          code: tokValue(rest[0]),
          name: rest[1] ? rest[1].value : '',
        });
        break;
      case '#KTYP':
        if (rest[0]) ktypeMap[rest[0].value] = rest[1] ? rest[1].value : null;
        break;
      case '#IB':
      case '#UB':
      case '#RES': {
        const kind = tag.slice(1);
        const idx = rest[0] ? Number(rest[0].value) : 0;
        const code = tokValue(rest[1]);
        const amountTok = rest[2];
        const amount = amountTok ? Number(amountTok.value) : 0;
        // Skip any trailing {…} dim list + quantity; count the dim block.
        for (let k = 3; k < rest.length; k++) {
          if (rest[k].type === 'brace' && rest[k].value === '{') {
            let depth = 1; k++;
            while (k < rest.length && depth > 0) {
              if (rest[k].type === 'brace' && rest[k].value === '{') depth++;
              else if (rest[k].type === 'brace' && rest[k].value === '}') depth--;
              k++;
            }
            k--; // step back so the for-loop increment lands correctly
            dimsDiscarded++;
          }
        }
        balances.push({ yearIdx: idx, kind, code, amount });
        break;
      }
      case '#VER': {
        // Flush a still-open voucher (malformed file) before starting a new one.
        if (currentVoucher) { vouchers.push(currentVoucher); currentVoucher = null; }
        const serie = tokValue(rest[0]);
        const verno = tokValue(rest[1]);
        const date = convDate(tokValue(rest[2]));
        const text2 = rest[3] ? rest[3].value : null;
        currentVoucher = { serie, verno, date, text: text2, lines: [] };
        break;
      }
      case '#TRANS':
      case '#BTRANS':
      case '#RTRANS': {
        if (!currentVoucher) {
          // #TRANS outside a #VER block — skip but count dims if present.
          ignore(tag + '_orphan');
          break;
        }
        let p = 0;
        const code = tokValue(rest[p++]);
        // optional {…} dimension list
        if (p < rest.length && rest[p].type === 'brace' && rest[p].value === '{') {
          let depth = 1; p++;
          while (p < rest.length && depth > 0) {
            if (rest[p].type === 'brace' && rest[p].value === '{') depth++;
            else if (rest[p].type === 'brace' && rest[p].value === '}') depth--;
            p++;
          }
          dimsDiscarded++;
        }
        const amount = rest[p] ? Number(rest[p].value) : 0;
        if (rest[p]) p++;
        let lineDate = currentVoucher.date;
        if (p < rest.length && rest[p].type === 'word' && /^\d{8}$/.test(rest[p].value)) {
          lineDate = convDate(rest[p].value);
          p++;
        }
        let lineText = null;
        if (p < rest.length && rest[p].type === 'string') {
          lineText = rest[p].value;
          p++;
        }
        // remaining token (if any) = quantity — ignored
        if (tag === '#RTRANS') break; // EXCLUDE the line
        currentVoucher.lines.push({ code, amount, date: lineDate, text: lineText });
        break;
      }
      default:
        ignore(tag);
        break;
    }
  }

  // Flush a trailing open voucher.
  if (currentVoucher) { vouchers.push(currentVoucher); currentVoucher = null; }

  // Attach ktyp letter to accounts (optional field).
  for (const a of accounts) {
    if (ktypeMap[a.code] !== undefined) a.ktyp = ktypeMap[a.code];
  }

  return {
    meta,
    years,
    accounts,
    balances,
    vouchers,
    ignoredTags,
    dimsDiscarded,
    warnings,
  };
}

// ── Account-type inference ─────────────────────────────────────────────────────
const KTYP_TO_TYPE = { T: 'Asset', S: 'Liability', I: 'Revenue', K: 'Expense' };

function inferAccountType(code, ktyp) {
  if (ktyp && KTYP_TO_TYPE[ktyp]) return { type: KTYP_TO_TYPE[ktyp], inferred: false };
  const c = String(code || '');
  if (/^1/.test(c)) return { type: 'Asset', inferred: false };
  if (/^20/.test(c)) return { type: 'Equity', inferred: false };
  if (/^2/.test(c)) return { type: 'Liability', inferred: false };
  if (/^3/.test(c)) return { type: 'Revenue', inferred: false };
  if (/^89/.test(c)) return { type: 'Closing', inferred: false };
  if (/^[4-9]/.test(c)) return { type: 'Expense', inferred: false };
  return { type: 'Expense', inferred: true };
}

const RESULT_TYPES = new Set(['Revenue', 'Expense', 'Closing']);

// ── Importer ──────────────────────────────────────────────────────────────────
async function importSie(ctx) {
  const { companyId, userEmail, body } = ctx;
  const dryRun = body.dryRun !== false; // default true
  const importOpeningBalances = body.importOpeningBalances !== false; // default true

  // Resolve file content.
  let parsed;
  if (body.contentBase64) {
    parsed = parseSie(Buffer.from(body.contentBase64, 'base64'));
  } else if (body.content != null && body.content !== '') {
    parsed = parseSie(String(body.content));
  } else {
    throw Object.assign(new Error('contentBase64 or content required'), { code: 'INVALID_INPUT' });
  }

  // Company lookup.
  const companies = await query(
    `SELECT company_name, tax_id, currency, jurisdiction FROM companies WHERE company_id = @companyId LIMIT 1`,
    { companyId }
  );
  if (!companies.length) throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });
  const company = companies[0];

  // SIE is a Swedish statutory format — import only where the jurisdiction
  // pack declares integrations.sie.import.
  const sieInteg = packIntegration(company.jurisdiction, 'sie');
  if (!sieInteg || !sieInteg.import) {
    throw Object.assign(
      new Error(`SIE import not available for jurisdiction ${company.jurisdiction || 'unknown'}`),
      { code: 'INVALID_INPUT' }
    );
  }

  const warnings = [];

  // ORGNR mismatch — warn, never block.
  const fileOrgnr = (parsed.meta.orgnr || '').toString().replace(/\D/g, '');
  const dbTaxId = (company.tax_id || '').toString().replace(/\D/g, '');
  if (fileOrgnr && dbTaxId && fileOrgnr !== dbTaxId) {
    warnings.push({ code: 'orgnr_mismatch', file: fileOrgnr, company: dbTaxId });
  }

  // Garbage-file guard: nothing parseable at all.
  if (parsed.years.length === 0 && parsed.accounts.length === 0
      && parsed.vouchers.length === 0 && parsed.balances.length === 0) {
    throw Object.assign(new Error('SIE file contained no parseable records'), { code: 'SIE_PARSE' });
  }

  const now = new Date().toISOString();

  // ── Accounts: upsert missing codes ────────────────────────────────────────
  const existingAccts = await query(
    `SELECT account_code, account_type FROM accounts WHERE company_id = @companyId`,
    { companyId }
  );
  const existingCodes = new Set(existingAccts.map((a) => a.account_code));
  const dbTypeByCode = new Map(existingAccts.map((a) => [a.account_code, a.account_type]));

  const createdAccounts = [];
  const accountRowsToInsert = [];
  for (const a of parsed.accounts) {
    if (!a.code || existingCodes.has(a.code)) continue;
    const { type, inferred } = inferAccountType(a.code, a.ktyp);
    if (inferred) {
      warnings.push({ code: 'account_type_inferred', account: a.code, type });
    }
    createdAccounts.push(a.code);
    accountRowsToInsert.push({
      company_id: companyId,
      account_code: a.code,
      account_name: a.name || a.code,
      account_type: type,
      account_subtype: null,
      cf_category: null,
      is_active: true,
      effective_from: '1970-01-01',
      effective_to: null,
      created_at: now,
    });
  }

  if (!dryRun && accountRowsToInsert.length > 0) {
    await bulkInsert('accounts', accountRowsToInsert);
    for (const r of accountRowsToInsert) {
      existingCodes.add(r.account_code);
      dbTypeByCode.set(r.account_code, r.account_type);
    }
  }

  // Build a type lookup for every account that appears anywhere (parsed, db,
  // balances, voucher lines) — used by the reconciliation cross-check.
  const typeOf = (code) => {
    if (dbTypeByCode.has(code)) return dbTypeByCode.get(code);
    // parsed account? (in dryRun the upsert hasn't run, so use ktyp/inference)
    const parsedAcct = parsed.accounts.find((a) => a.code === code);
    if (parsedAcct) return inferAccountType(code, parsedAcct.ktyp).type;
    return inferAccountType(code, null).type;
  };

  const validAccount = (code) => existingCodes.has(code)
    || parsed.accounts.some((a) => a.code === code);

  // ── Periods: auto-create calendar-year periods for uncovered dates ─────────
  let periods = await query(
    `SELECT period_name, start_date, end_date, locked
     FROM (SELECT *, ROW_NUMBER() OVER(PARTITION BY period_name ORDER BY created_at DESC) AS rn
           FROM periods WHERE company_id = @companyId) WHERE rn = 1`,
    { companyId }
  );

  const findPeriod = (d) => periods.find((p) => p.start_date <= d && p.end_date >= d) || null;

  // Collect all dates that need an auto-created calendar-year period.
  const yearsToCreate = new Set();
  const allVoucherDates = [];
  for (const v of parsed.vouchers) {
    for (const ln of v.lines) {
      const d = ln.date || v.date;
      allVoucherDates.push(d);
      if (d && !findPeriod(d)) yearsToCreate.add(d.slice(0, 4));
    }
  }
  const year0 = parsed.years.find((y) => y.idx === 0) || null;
  let obDate = null;
  if (year0) obDate = year0.start;
  if (obDate && !findPeriod(obDate)) yearsToCreate.add(obDate.slice(0, 4));

  if (!dryRun) {
    for (const y of yearsToCreate) {
      const start = `${y}-01-01`;
      const end = `${y}-12-31`;
      // Skip if a same-named period already exists (avoid clutter).
      const dup = periods.find((p) => p.period_name === y);
      if (dup) continue;
      await exec(
        `INSERT INTO periods (company_id, period_name, start_date, end_date, locked)
         VALUES (@companyId, @name, @start, @end, false)`,
        { companyId, name: y, start, end }
      );
      periods.push({ period_name: y, start_date: start, end_date: end, locked: false });
    }
  } else {
    // Hypothetical: pretend the calendar-year periods exist (unlocked) so dryRun
    // validation does not fail vouchers solely for a missing period.
    for (const y of yearsToCreate) {
      const start = `${y}-01-01`;
      const end = `${y}-12-31`;
      if (!periods.find((p) => p.period_name === y)) {
        periods.push({ period_name: y, start_date: start, end_date: end, locked: false });
      }
    }
  }

  // ── Vouchers ───────────────────────────────────────────────────────────────
  const failedVouchers = [];
  let imported = 0;
  let skippedDuplicate = 0;
  const allVoucherRows = [];
  // Lines that will reach the ledger, used for the reconciliation cross-check.
  const importedLinesForRecon = [];

  for (const v of parsed.vouchers) {
    const ref = `SIE ${v.serie || ''} ${v.verno || ''}`.trim();
    const errors = [];

    // Duplicate check.
    const dup = await query(
      `SELECT 1 FROM journal_entries WHERE company_id = @companyId AND reference = @ref LIMIT 1`,
      { companyId, ref }
    );
    if (dup.length > 0) { skippedDuplicate++; continue; }

    if (v.lines.length === 0) { errors.push('Voucher has no transaction lines'); }

    // Unknown account check.
    for (const ln of v.lines) {
      if (!validAccount(ln.code)) errors.push(`Unknown account: ${ln.code}`);
    }

    // Balance check (debit-positive sign convention).
    const sumAmount = v.lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    const dr = v.lines.reduce((s, l) => s + Math.max(0, Number(l.amount) || 0), 0);
    const cr = v.lines.reduce((s, l) => s + Math.max(0, -(Number(l.amount) || 0)), 0);
    if (Math.abs(sumAmount) > 0.005) {
      errors.push(`Unbalanced: DR ${dr.toFixed(2)} ≠ CR ${cr.toFixed(2)}`);
    }

    // Period check per line (effective date = line.date || voucher.date).
    let periodError = null;
    for (const ln of v.lines) {
      const d = ln.date || v.date;
      if (!d) { periodError = `Missing date`; break; }
      const cp = findPeriod(d);
      if (!cp) { periodError = `Date ${d} not in any period`; break; }
      if (cp.locked) { periodError = `Period locked for date: ${d}`; break; }
    }
    if (periodError) errors.push(periodError);

    if (errors.length > 0) {
      failedVouchers.push({ ref, errors });
      continue;
    }

    // Build journal_entries rows for this voucher (one batch_id per voucher).
    const batchId = uuid();
    for (const ln of v.lines) {
      const amount = Number(ln.amount) || 0;
      const debit = amount > 0 ? amount : 0;
      const credit = amount < 0 ? -amount : 0;
      const lineDate = ln.date || v.date;
      const row = {
        company_id: companyId,
        entry_id: uuid(),
        batch_id: batchId,
        date: lineDate,
        account_code: ln.code,
        debit,
        credit,
        currency: company.currency,
        fx_rate: 1.0,
        debit_home: debit,
        credit_home: credit,
        vat_code: null,
        vat_amount: 0,
        vat_amount_home: 0,
        net_amount: 0,
        net_amount_home: 0,
        description: ln.text || v.text || null,
        reference: ref,
        source: 'sie_import',
        cost_center: null,
        profit_center: null,
        reverses: null,
        reversed_by: null,
        bill_id: null,
        created_by: userEmail || 'sie-import',
        created_at: now,
      };
      allVoucherRows.push(row);
      importedLinesForRecon.push({ code: ln.code, amount, date: lineDate });
    }
    imported++;
  }

  if (!dryRun && allVoucherRows.length > 0) {
    await bulkInsert('journal_entries', allVoucherRows);
  }

  // ── Opening balances (#IB yearIdx 0) ──────────────────────────────────────
  const ibRows = parsed.balances.filter((b) => b.kind === 'IB' && b.yearIdx === 0);
  let openingBalance;
  if (!importOpeningBalances || ibRows.length === 0) {
    openingBalance = { inFile: ibRows.length, skipped: true, reason: importOpeningBalances ? 'no #IB rows for year 0' : 'importOpeningBalances disabled' };
  } else {
    const obRef = 'SIE OB';
    const obDup = await query(
      `SELECT 1 FROM journal_entries WHERE company_id = @companyId AND reference = @ref LIMIT 1`,
      { companyId, ref: obRef }
    );
    if (obDup.length > 0) {
      openingBalance = { inFile: ibRows.length, skipped: true, reason: 'duplicate SIE OB already imported' };
    } else {
      const obSum = ibRows.reduce((s, b) => s + (Number(b.amount) || 0), 0);
      const obDr = ibRows.reduce((s, b) => s + Math.max(0, Number(b.amount) || 0), 0);
      const obCr = ibRows.reduce((s, b) => s + Math.max(0, -(Number(b.amount) || 0)), 0);
      if (Math.abs(obSum) > 0.005) {
        openingBalance = { inFile: ibRows.length, failed: true, reason: `Unbalanced: DR ${obDr.toFixed(2)} ≠ CR ${obCr.toFixed(2)}` };
      } else {
        const obBatchId = uuid();
        const obRows = [];
        for (const b of ibRows) {
          const amount = Number(b.amount) || 0;
          const debit = amount > 0 ? amount : 0;
          const credit = amount < 0 ? -amount : 0;
          obRows.push({
            company_id: companyId,
            entry_id: uuid(),
            batch_id: obBatchId,
            date: obDate,
            account_code: b.code,
            debit,
            credit,
            currency: company.currency,
            fx_rate: 1.0,
            debit_home: debit,
            credit_home: credit,
            vat_code: null,
            vat_amount: 0,
            vat_amount_home: 0,
            net_amount: 0,
            net_amount_home: 0,
            description: 'SIE opening balance',
            reference: obRef,
            source: 'sie_import',
            cost_center: null,
            profit_center: null,
            reverses: null,
            reversed_by: null,
            bill_id: null,
            created_by: userEmail || 'sie-import',
            created_at: now,
          });
          importedLinesForRecon.push({ code: b.code, amount, date: obDate });
        }
        if (!dryRun && obRows.length > 0) {
          await bulkInsert('journal_entries', obRows);
        }
        openingBalance = {
          inFile: ibRows.length,
          [dryRun ? 'wouldPost' : 'posted']: obRows.length,
        };
      }
    }
  }

  // ── Reconciliation cross-check (year 0) ────────────────────────────────────
  // computed = #IB(yearIdx 0, per account) + Σ imported voucher lines dated
  //            within the year-0 range.
  // declared = #UB yearIdx 0 (non-result accounts) | #RES yearIdx 0 (result
  //            accounts: Revenue/Expense/Closing per the type map); absent = 0.
  let reconciliation = { checked: 0, diffs: [] };
  if (year0) {
    const computed = {};
    for (const b of parsed.balances) {
      if (b.kind === 'IB' && b.yearIdx === 0) {
        computed[b.code] = (computed[b.code] || 0) + (Number(b.amount) || 0);
      }
    }
    for (const ln of importedLinesForRecon) {
      if (ln.date && ln.date >= year0.start && ln.date <= year0.end) {
        computed[ln.code] = (computed[ln.code] || 0) + (Number(ln.amount) || 0);
      }
    }

    const declared = {};
    const seenCodes = new Set();
    for (const b of parsed.balances) {
      if (b.yearIdx !== 0) continue;
      const isResult = RESULT_TYPES.has(typeOf(b.code));
      if (b.kind === 'UB' && !isResult) declared[b.code] = Number(b.amount) || 0;
      if (b.kind === 'RES' && isResult) declared[b.code] = Number(b.amount) || 0;
      seenCodes.add(b.code);
    }
    // Also consider accounts that have a computed balance but no declared row.
    for (const code of Object.keys(computed)) seenCodes.add(code);
    for (const code of Object.keys(declared)) seenCodes.add(code);

    const diffs = [];
    for (const code of seenCodes) {
      const c = computed[code] || 0;
      const d = declared[code] || 0;
      const diff = c - d;
      if (Math.abs(diff) > 0.01) {
        const isResult = RESULT_TYPES.has(typeOf(code));
        diffs.push({
          account: code,
          kind: isResult ? 'RES' : 'UB',
          declared: d,
          computed: c,
          diff,
        });
      }
    }
    reconciliation = { checked: seenCodes.size, diffs };
  }

  return {
    dryRun,
    file: {
      sieType: parsed.meta.sieType,
      fnamn: parsed.meta.fnamn,
      orgnr: parsed.meta.orgnr,
      program: parsed.meta.program,
      gen: parsed.meta.gen,
      valuta: parsed.meta.valuta,
    },
    accounts: {
      inFile: parsed.accounts.length,
      created: createdAccounts,
      existing: existingAccts.length,
    },
    vouchers: {
      inFile: parsed.vouchers.length,
      imported,
      skippedDuplicate,
      failed: failedVouchers,
    },
    openingBalance,
    reconciliation,
    dimsDiscarded: parsed.dimsDiscarded,
    ignoredTags: parsed.ignoredTags,
    warnings,
  };
}

// ── Dispatch ──────────────────────────────────────────────────────────────────
async function handleSie(ctx, action) {
  switch (action) {
    case 'sie.import': return importSie(ctx);
    default:
      throw Object.assign(new Error(`Unknown sie action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

module.exports = { parseSie, decodeBuffer, handleSie };