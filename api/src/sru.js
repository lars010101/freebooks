'use strict';
/**
 * freeBooks — SRU (Skatteverket) INK2 export generator.
 *
 * Produces blanketter.sru (INK2 / INK2R / INK2S blanket blocks) and INFO.SRU
 * per the official 2025P4 specification. See db/jurisdictions/SE/sru_ink2.json
 * for the account→field mapping that drives the field values.
 *
 * Exposed as Express routes (wired in api/src/reports.js):
 *   GET /api/:company/sru/ink2?year=YYYY&loss_cf=N[&check=1]
 *   GET /api/:company/sru/info?year=YYYY&kontakt=&telefon=&email=
 *
 * Self-contained: receives the same `app`/makeQuery helpers as the other
 * report handlers. No external dependencies.
 */

const path = require('path');
const fs = require('fs');
const { queryPositional } = require('./db');

const MAPPING_PATH = path.resolve(__dirname, '../../db/jurisdictions/SE/sru_ink2.json');

function loadMapping() {
  return JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf8'));
}

// Standard half-up rounding of the absolute value, per spec.
function roundHalfUp(x) {
  return Math.round(Math.abs(x));
}

// Pad a 2-digit month/day.
function pad2(n) { return String(n).padStart(2, '0'); }

// YYYYMMDD from a date-ish value (handles 'YYYY-MM-DD' and Date).
function ymd(dateVal) {
  const s = String(dateVal);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + m[2] + m[3];
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
  return s.replace(/-/g, '');
}

// "YYYYMMDD HHMMSS" timestamp token for #IDENTITET / #SKAPAD.
function timestampToken(d) {
  d = d || new Date();
  return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) +
    ' ' + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds());
}

// Strip non-digits from a tax_id ("556880-6854" → "5568806854") and prefix "16".
function orgnrKey(taxId) {
  const digits = String(taxId || '').replace(/\D+/g, '');
  return '16' + digits;
}

function packageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
    return pkg.version || '1.0.0';
  } catch (e) {
    return '1.0.0';
  }
}

/**
 * Core generator: compute the SRU field set for a company + year.
 * Returns { fields: {INK2, INK2R, INK2S}, warnings: [...], period, company }.
 *
 * `query` here is a positional-params (?, $1) runner (queryPositional) so the
 * generator stays decoupled from any per-handler query factory.
 */
async function computeSru(query, companyId, year, lossCfRaw) {
  const mapping = loadMapping();
  const lossCf = lossCfRaw == null ? null : Number(lossCfRaw);

  // ── Company + period ──────────────────────────────────────────────────────
  const coRows = await query(
    `SELECT company_id, company_name, tax_id, jurisdiction FROM companies
     WHERE company_id = ? ORDER BY created_at DESC LIMIT 1`,
    [companyId]
  );
  if (coRows.length === 0) {
    const err = new Error('Company not found'); err.code = 'NOT_FOUND'; throw err;
  }
  const company = coRows[0];

  const jan1 = `${year}-01-01`;
  const dec31 = `${year}-12-31`;
  const periodRows = await query(
    `SELECT start_date, end_date FROM periods
     WHERE company_id = ? AND start_date <= ? AND end_date >= ?
     ORDER BY start_date ASC LIMIT 1`,
    [companyId, jan1, dec31]
  );
  if (periodRows.length === 0) {
    const err = new Error(`No period covers year ${year}`); err.code = 'INVALID_INPUT'; throw err;
  }
  const period = periodRows[0];
  const startYmd = ymd(period.start_date);
  const endYmd = ymd(period.end_date);

  // ── Accounts (code → account_type) ────────────────────────────────────────
  const acctRows = await query(
    `SELECT account_code, account_type FROM accounts WHERE company_id = ?`,
    [companyId]
  );
  const acctType = {};
  for (const r of acctRows) acctType[r.account_code] = r.account_type;

  // ── Aggregate per mapped field ─────────────────────────────────────────────
  // For each field we run one scoped SUM over journal_entries.
  const warnings = [];

  async function sumAccounts(accounts, sign, scope) {
    // sign: 'dr' → SUM(debit_home - credit_home); 'cr' → SUM(credit_home - debit_home)
    // scope: 'yearend' → date <= endYmd; 'year' → date BETWEEN start AND end
    const expr = sign === 'cr' ? 'credit_home - debit_home' : 'debit_home - credit_home';
    let where = `company_id = ? AND account_code IN (${accounts.map(() => '?').join(',')})`;
    let params = [companyId, ...accounts];
    if (scope === 'yearend') {
      where += ` AND date <= ?`;
      params.push(period.end_date);
    } else {
      where += ` AND date >= ? AND date <= ?`;
      params.push(period.start_date, period.end_date);
    }
    const rows = await query(`SELECT COALESCE(SUM(${expr}), 0) AS v FROM journal_entries WHERE ${where}`, params);
    return Number(rows[0].v) || 0;
  }

  const fields = { INK2: {}, INK2R: {}, INK2S: {} };

  // 7011/7012 (räkenskapsår start/end) appear in EVERY blanket block.
  fields.INK2['7011'] = startYmd;
  fields.INK2['7012'] = endYmd;
  fields.INK2R['7011'] = startYmd;
  fields.INK2R['7012'] = endYmd;
  fields.INK2S['7011'] = startYmd;
  fields.INK2S['7012'] = endYmd;

  // INK2R fields
  for (const [code, spec] of Object.entries(mapping.INK2R)) {
    let sign, scope;
    if (spec.kind === 'asset') { sign = 'dr'; scope = 'yearend'; }
    else if (spec.kind === 'equity' || spec.kind === 'liability') { sign = 'cr'; scope = 'yearend'; }
    else if (spec.kind === 'cost') { sign = 'dr'; scope = 'year'; }
    else if (spec.kind === 'income') { sign = 'cr'; scope = 'year'; }
    else { sign = 'dr'; scope = 'yearend'; }
    const raw = await sumAccounts(spec.accounts, sign, scope);
    const val = roundHalfUp(raw);
    if (val > 0) {
      fields.INK2R[code] = val;
    } else if (raw < -0.005) {
      warnings.push(`INK2R ${code} value negative (${raw.toFixed(2)}) — dropped`);
    }
  }

  // ── Book result (7450 årets vinst / 7550 årets förlust) ───────────────────
  // (CR-DR over Revenue in year) − (DR-CR over Expense in year).
  // Closing accounts are excluded by the type filter.
  const revRows = await query(
    `SELECT COALESCE(SUM(credit_home - debit_home), 0) AS v
     FROM journal_entries je
     JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
     WHERE je.company_id = ? AND a.account_type = 'Revenue'
       AND je.date >= ? AND je.date <= ?`,
    [companyId, period.start_date, period.end_date]
  );
  const expRows = await query(
    `SELECT COALESCE(SUM(debit_home - credit_home), 0) AS v
     FROM journal_entries je
     JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
     WHERE je.company_id = ? AND a.account_type = 'Expense'
       AND je.date >= ? AND je.date <= ?`,
    [companyId, period.start_date, period.end_date]
  );
  const revenue = Number(revRows[0].v) || 0;
  const expense = Number(expRows[0].v) || 0;
  const bookResult = revenue - expense;

  if (bookResult >= 0) {
    fields.INK2R['7450'] = roundHalfUp(bookResult);
  } else {
    fields.INK2R['7550'] = roundHalfUp(Math.abs(bookResult));
  }

  // ── INK2S fields ──────────────────────────────────────────────────────────
  // 7650/7750 = same book result sign as 7450/7550.
  if (bookResult >= 0) {
    fields.INK2S['7650'] = roundHalfUp(bookResult);
  } else {
    fields.INK2S['7750'] = roundHalfUp(Math.abs(bookResult));
  }

  // 7754 = round(CR-DR within year of 8314), if > 0.
  if (mapping.INK2S['7754']) {
    const raw7754 = await sumAccounts(mapping.INK2S['7754'].accounts, 'cr', 'year');
    const v7754 = roundHalfUp(raw7754);
    if (v7754 > 0) fields.INK2S['7754'] = v7754;
    else if (raw7754 < -0.005) warnings.push(`INK2S 7754 value negative (${raw7754.toFixed(2)}) — dropped`);
  }
  const val7754 = fields.INK2S['7754'] || 0;

  // 7763 = opening tax loss carryforward (query param loss_cf).
  const isSwedish = (company.jurisdiction || 'SE') === 'SE';
  if (lossCf == null) {
    if (isSwedish) warnings.push('loss_cf not given');
    fields.INK2S['7763'] = 0;
  } else if (lossCf > 0) {
    fields.INK2S['7763'] = roundHalfUp(lossCf);
  } else {
    fields.INK2S['7763'] = 0;
  }
  const openingLoss = fields.INK2S['7763'] || 0;

  // Tax result = book_result − 7754 value.
  const taxResult = bookResult - val7754;

  // 7670 (taxable result) vs 7770 (closing loss carryforward).
  if (taxResult >= 0) {
    fields.INK2S['7670'] = roundHalfUp(taxResult);
    const closingLoss = openingLoss - roundHalfUp(taxResult);
    if (closingLoss > 0) fields.INK2S['7770'] = closingLoss;
  } else {
    const added = roundHalfUp(Math.abs(taxResult));
    const closingLoss = openingLoss + added;
    if (closingLoss > 0) fields.INK2S['7770'] = closingLoss;
  }

  // 8041 / 8045 — constants (no consultant, no audit).
  fields.INK2S['8041'] = 'X';
  fields.INK2S['8045'] = 'X';

  // ── INK2 blanket: 7011/7012 always; 7104 (profit) or 7114 (loss) ─────────
  fields.INK2['7011'] = startYmd;
  fields.INK2['7012'] = endYmd;
  if (fields.INK2S['7670']) {
    fields.INK2['7104'] = fields.INK2S['7670'];
  }
  if (fields.INK2S['7770']) {
    fields.INK2['7114'] = fields.INK2S['7770'];
  }

  // ── Warnings: accounts with non-zero activity NOT covered by the mapping ─
  const mappedAccounts = new Set();
  for (const spec of Object.values(mapping.INK2R)) spec.accounts.forEach(a => mappedAccounts.add(a));
  for (const spec of Object.values(mapping.INK2S)) spec.accounts.forEach(a => mappedAccounts.add(a));

  const activityRows = await query(
    `SELECT account_code, COALESCE(SUM(ABS(debit_home) + ABS(credit_home)), 0) AS gross
     FROM journal_entries
     WHERE company_id = ? AND date >= ? AND date <= ?
     GROUP BY account_code
     ORDER BY account_code`,
    [companyId, period.start_date, period.end_date]
  );
  for (const r of activityRows) {
    if (Number(r.gross) > 0.005 && !mappedAccounts.has(r.account_code)) {
      // Skip pure closing accounts — they are intentionally not declared.
      const t = acctType[r.account_code];
      if (t === 'Closing') continue;
      warnings.push(`Account ${r.account_code} (${t || 'unknown'}) has activity not covered by SRU mapping`);
    }
  }

  // Also flag year-end balance accounts not covered (balance-sheet items with a
  // non-zero closing balance that the mapping drops).
  const balRows = await query(
    `SELECT account_code, COALESCE(SUM(debit_home - credit_home), 0) AS bal
     FROM journal_entries
     WHERE company_id = ? AND date <= ?
     GROUP BY account_code
     ORDER BY account_code`,
    [companyId, period.end_date]
  );
  for (const r of balRows) {
    if (Math.abs(Number(r.bal)) > 0.005 && !mappedAccounts.has(r.account_code)) {
      const t = acctType[r.account_code];
      if (t === 'Closing') continue;
      // Avoid double-warning with the activity warning above.
      const already = warnings.some(w => w.startsWith(`Account ${r.account_code} `));
      if (!already) {
        warnings.push(`Account ${r.account_code} (${t || 'unknown'}) has year-end balance not covered by SRU mapping`);
      }
    }
  }

  return { fields, warnings, period, company, bookResult, taxResult };
}

// ── Blanket block emitter ───────────────────────────────────────────────────
// Order of #UPPGIFT codes within each blanket (spec field order).
const INK2_ORDER = ['7011', '7012', '7104', '7114'];
const INK2R_ORDER = ['7011', '7012', '7251', '7261', '7281', '7301', '7302', '7365', '7368', '7513', '7417', '7450', '7550'];
const INK2S_ORDER = ['7011', '7012', '7650', '7750', '7754', '7763', '7670', '7770', '8041', '8045'];

function emitBlanket(version, identity, name, fields, order) {
  const lines = [];
  lines.push(`#BLANKETT ${version}`);
  lines.push(`#IDENTITET ${identity}`);
  lines.push(`#NAMN ${name}`);
  for (const code of order) {
    if (fields[code] !== undefined && fields[code] !== null) {
      lines.push(`#UPPGIFT ${code} ${fields[code]}`);
    }
  }
  lines.push(`#BLANKETTSLUT`);
  return lines.join('\n');
}

function buildSruText(computed, year) {
  const { fields, company } = computed;
  const identity = orgnrKey(company.tax_id) + ' ' + timestampToken();
  const name = company.company_name;
  const yr = year;
  const blocks = [
    emitBlanket(`INK2-${yr}P4`, identity, name, fields.INK2, INK2_ORDER),
    emitBlanket(`INK2R-${yr}P4`, identity, name, fields.INK2R, INK2R_ORDER),
    emitBlanket(`INK2S-${yr}P4`, identity, name, fields.INK2S, INK2S_ORDER),
  ];
  return blocks.join('\n') + '\n#FIL_SLUT\n';
}

// ── INFO.SRU ────────────────────────────────────────────────────────────────
function buildInfoText(company, params) {
  const ts = timestampToken();
  const ver = packageVersion();
  const orgnr = orgnrKey(company.tax_id);
  const lines = [
    `#DATABESKRIVNING_START`,
    `#PRODUKT SRU`,
    `#SKAPAD ${ts}`,
    `#PROGRAM freebooks ${ver}`,
    `#FILNAMN BLANKETTER.SRU`,
    `#DATABESKRIVNING_SLUT`,
    `#MEDIELEV_START`,
    `#ORGNR ${orgnr}`,
    `#NAMN ${company.company_name}`,
    `#ADRESS `,
    `#POSTNR `,
    `#POSTORT `,
    `#AVDELNING `,
    `#KONTAKT ${params.kontakt || ''}`,
    `#EMAIL ${params.email || ''}`,
    `#TELEFON ${params.telefon || ''}`,
    `#FAX `,
    `#MEDIELEV_SLUT`,
  ];
  return lines.join('\n') + '\n';
}

// ── Express handlers ─────────────────────────────────────────────────────────
async function handleSruInk2(req, res) {
  const { company } = req.params;
  const { year, loss_cf, check } = req.query;
  if (!year) return res.status(400).json({ error: 'Missing ?year=' });
  const yr = parseInt(String(year), 10);
  if (!Number.isFinite(yr)) return res.status(400).json({ error: 'Invalid year' });

  try {
    const computed = await computeSru(queryPositional, company, yr, loss_cf);
    if (check === '1' || check === 1) {
      return res.json({ fields: computed.fields, warnings: computed.warnings });
    }
    const text = buildSruText(computed, yr);
    if (computed.warnings.length) {
      const header = computed.warnings.join(' | ');
      res.setHeader('X-SRU-Warnings', header.length > 400 ? header.slice(0, 397) + '...' : header);
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="blanketter.sru"`);
    return res.send(text);
  } catch (err) {
    console.error('SRU ink2 error:', err);
    const status = err.code === 'NOT_FOUND' ? 404 : (err.code === 'INVALID_INPUT' ? 400 : 500);
    return res.status(status).json({ error: err.message || 'SRU generation failed' });
  }
}

async function handleSruInfo(req, res) {
  const { company } = req.params;
  const { year, kontakt, telefon, email } = req.query;
  if (!year) return res.status(400).json({ error: 'Missing ?year=' });

  try {
    const coRows = await queryPositional(
      `SELECT company_id, company_name, tax_id, jurisdiction FROM companies
       WHERE company_id = ? ORDER BY created_at DESC LIMIT 1`,
      [company]
    );
    if (coRows.length === 0) return res.status(404).json({ error: 'Company not found' });
    const text = buildInfoText(coRows[0], { kontakt, telefon, email });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="INFO.SRU"`);
    return res.send(text);
  } catch (err) {
    console.error('SRU info error:', err);
    return res.status(500).json({ error: err.message || 'INFO.SRU generation failed' });
  }
}

module.exports = {
  computeSru,
  buildSruText,
  buildInfoText,
  handleSruInk2,
  handleSruInfo,
};
