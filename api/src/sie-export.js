'use strict';

// ── SIE 4 export (Standard Import Export, SIE-gruppen spec v4) ───────────────
// Emits a complete ledger extract: chart of accounts, fiscal years, opening and
// closing balances, result balances, and all vouchers as #VER/#TRANS blocks.
// Encoding: code page 437 (PC8) per spec — Swedish chars mapped explicitly.
//
// Conventions:
//   - Amounts are debit-positive (credits negative), decimal point, 2 decimals.
//   - Account classes: Revenue/Expense → #RES (year movement); all others → #IB/#UB.
//   - 'Closing' accounts (e.g. 8999) appear in vouchers but carry no balance tags.
//   - Vouchers are numbered sequentially per year in serie "A" (freebooks manual
//     entries don't persist a journal series on the lines).

function shiftYear(d, delta) {
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y + delta, m - 1, day));
  return dt.toISOString().slice(0, 10);
}

const CP437 = { 'å': 134, 'ä': 132, 'ö': 148, 'Å': 143, 'Ä': 142, 'Ö': 153, 'é': 130, 'É': 144, 'ü': 129, 'Ü': 154, '§': 21, '°': 248, '–': 45, '—': 45, '"': 34 };
function pc8(str) {
  const out = [];
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (cp < 128) out.push(cp);
    else if (CP437[ch] !== undefined) out.push(CP437[ch]);
    else out.push(63); // '?'
  }
  return Buffer.from(out);
}

const q = (s) => `"${String(s == null ? '' : s).replace(/"/g, "'")}"`;
const amt = (v) => (Math.round((Number(v) || 0) * 100) / 100).toFixed(2);
const ymd = (d) => String(d).slice(0, 10).replace(/-/g, '');

async function renderSie(query, companyId, start, end, opts = {}) {
  const companies = await query(
    `SELECT company_name, tax_id, currency FROM companies WHERE company_id = ? LIMIT 1`, [companyId]);
  if (!companies.length) throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });
  const company = companies[0];

  const accts = await query(
    `SELECT account_code, account_name, account_type FROM accounts
     WHERE company_id = ? AND is_active = true ORDER BY account_code`, [companyId]);

  const priorStart = shiftYear(start, -1);
  const priorEnd = shiftYear(end, -1);
  const years = [
    { idx: 0, start, end },
    { idx: -1, start: priorStart, end: priorEnd },
  ];

  const balAt = async (upto) => {
    const rows = await query(
      `SELECT account_code, SUM(debit_home) dr, SUM(credit_home) cr FROM journal_entries
       WHERE company_id = ? AND date <= ? GROUP BY account_code`, [companyId, upto]);
    const m = {};
    for (const r of rows) m[r.account_code] = (Number(r.dr) || 0) - (Number(r.cr) || 0);
    return m;
  };
  const movement = async (from, to) => {
    const rows = await query(
      `SELECT account_code, SUM(debit_home) dr, SUM(credit_home) cr FROM journal_entries
       WHERE company_id = ? AND date >= ? AND date <= ? GROUP BY account_code`, [companyId, from, to]);
    const m = {};
    for (const r of rows) m[r.account_code] = (Number(r.dr) || 0) - (Number(r.cr) || 0);
    return m;
  };

  // Vouchers for the current year: batch_id groups a voucher's lines.
  const lines = await query(
    `SELECT batch_id, CAST(date AS VARCHAR) d, account_code, debit_home, credit_home,
            COALESCE(reference, description, '') AS vtext
     FROM journal_entries
     WHERE company_id = ? AND date >= ? AND date <= ?
     ORDER BY date, batch_id, account_code`, [companyId, start, end]);
  const batches = new Map();
  for (const l of lines) {
    if (!batches.has(l.batch_id)) batches.set(l.batch_id, { date: l.d, text: l.vtext, lines: [] });
    const b = batches.get(l.batch_id);
    if (l.d < b.date) b.date = l.d;
    if (!b.text && l.vtext) b.text = l.vtext;
    b.lines.push(l);
  }
  const ordered = [...batches.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  const L = [];
  L.push('#FLAGGA 0');
  L.push('#PROGRAM "freebooks" "1.0"');
  L.push('#FORMAT PC8');
  L.push(`#GEN ${ymd(new Date().toISOString().slice(0, 10))}`);
  L.push('#SIETYP 4');
  const orgnr = (company.tax_id || '').replace(/\D/g, '');
  if (orgnr) L.push(`#ORGNR ${orgnr}`);
  L.push(`#FNAMN ${q(company.company_name)}`);
  for (const y of years) L.push(`#RAR ${y.idx} ${ymd(y.start)} ${ymd(y.end)}`);
  L.push('#KPTYP BAS');
  for (const a of accts) L.push(`#KONTO ${a.account_code} ${q(a.account_name)}`);

  const isResult = (a) => a.account_type === 'Revenue' || a.account_type === 'Expense' || a.account_type === 'Closing';
  // Closing accounts (8999) MUST carry a #RES line: Gredor derives "Årets resultat"
  // in the RR from accounts 8990–8999 and warns when absent/zero (verified against
  // GredorTools/gredor-frontend sieUtils.ts). Its movement IS the year's result.

  for (const y of years) {
    const d0 = new Date(Date.UTC(Number(y.start.slice(0, 4)), Number(y.start.slice(5, 7)) - 1, Number(y.start.slice(8, 10)) - 1));
    const startM1 = d0.toISOString().slice(0, 10);
    const [open, close, mov] = [await balAt(startM1), await balAt(y.end), await movement(y.start, y.end)];
    for (const a of accts) {
      if (isResult(a)) {
        const v = mov[a.account_code] || 0;
        if (Math.abs(v) > 0.0001) L.push(`#RES ${y.idx} ${a.account_code} ${amt(v)}`);
      } else {
        const ib = open[a.account_code] || 0;
        const ub = close[a.account_code] || 0;
        if (Math.abs(ib) > 0.0001) L.push(`#IB ${y.idx} ${a.account_code} ${amt(ib)}`);
        if (Math.abs(ub) > 0.0001) L.push(`#UB ${y.idx} ${a.account_code} ${amt(ub)}`);
      }
    }
  }

  ordered.forEach((b, i) => {
    L.push(`#VER A ${i + 1} ${ymd(b.date)} ${q(b.text)}`);
    L.push('{');
    for (const l of b.lines) {
      const v = (Number(l.debit_home) || 0) - (Number(l.credit_home) || 0);
      L.push(`#TRANS ${l.account_code} {} ${amt(v)} ${ymd(l.d)}`);
    }
    L.push('}');
  });

  const text = L.join('\r\n') + '\r\n';
  return {
    buffer: pc8(text),
    filename: `SIE4_${orgnr || companyId}_${ymd(start)}-${ymd(end)}.se`,
  };
}

module.exports = { renderSie };
