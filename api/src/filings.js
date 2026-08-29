'use strict';
/**
 * freeBooks — Generic filing engine + SRU/INK2 route handlers.
 *
 * Splits the former hand-coded `api/src/sru.js` per the jurisdiction-pack spec
 * (docs/jurisdiction-pack.md §3/§7) into:
 *   - DATA  : db/jurisdictions/SE/filings/ink2.json   (the descriptor)
 *   - ENGINE: this file (api/src/filings.js)          (computeFiling + routes)
 *   - FORMAT: api/src/emitters/sruLines.js            (#UPPGIFT line emitter)
 *
 * Routes (unchanged, byte-compatible):
 *   GET /api/:company/sru/ink2?year=YYYY&loss_cf=N[&check=1]
 *   GET /api/:company/sru/info?year=YYYY&kontakt=&telefon=&email=
 *
 * The golden test (tests/sru-golden-2024.mjs) is the acceptance contract:
 * generated blanketter.sru must stay byte-identical to the filed reference.
 */

const path = require('path');
const fs = require('fs');
const { queryPositional } = require('./db');
const { contactAttributesFor } = require('./jurisdiction-packs');

// ── Descriptor + emitter loading ─────────────────────────────────────────────
function loadDescriptor(jurisdiction) {
  const dir = path.resolve(__dirname, '../../db/jurisdictions', jurisdiction || 'SE', 'filings');
  const file = path.join(dir, 'ink2.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const err = new Error(`Invalid filing descriptor at ${file}: ${e.message}`);
    err.code = 'INVALID_INPUT';
    throw err;
  }
}

function loadEmitter(desc) {
  if (!desc.emitter || !/^[a-z0-9_-]+$/i.test(desc.emitter)) {
    const err = new Error(`Invalid emitter name '${desc.emitter}'`);
    err.code = 'INVALID_INPUT';
    throw err;
  }
  return require('./emitters/' + desc.emitter);
}

// ── Core generator ───────────────────────────────────────────────────────────
// `query` is a positional-params runner (queryPositional) so the engine stays
// decoupled from any per-handler query factory. `overrides` = { loss_cf } where
// loss_cf is the raw query-param string or null.
async function computeFiling(query, companyId, year, overrides) {
  overrides = overrides || {};
  const warnings = [];

  // ── 1. Company ─────────────────────────────────────────────────────────────
  const coRows = await query(
    `SELECT company_id, company_name, tax_id, jurisdiction FROM companies
     WHERE company_id = ? ORDER BY created_at DESC LIMIT 1`,
    [companyId]
  );
  if (coRows.length === 0) {
    const err = new Error('Company not found'); err.code = 'NOT_FOUND'; throw err;
  }
  const company = coRows[0];
  const jurisdiction = company.jurisdiction || 'SE';

  // ── 2. Descriptor + emitter ─────────────────────────────────────────────────
  const descriptor = loadDescriptor(jurisdiction);
  const emitter = loadEmitter(descriptor);
  const roundHalfUp = emitter.roundHalfUp; // single shared impl (emitter module)

  // ── 3. Period (+ tax_attrs) ─────────────────────────────────────────────────
  const jan1 = `${year}-01-01`;
  const dec31 = `${year}-12-31`;
  const periodRows = await query(
    `SELECT start_date, end_date, tax_attrs FROM periods
     WHERE company_id = ? AND start_date <= ? AND end_date >= ?
     ORDER BY start_date ASC LIMIT 1`,
    [companyId, jan1, dec31]
  );
  if (periodRows.length === 0) {
    const err = new Error(`No period covers year ${year}`); err.code = 'INVALID_INPUT'; throw err;
  }
  const period = periodRows[0];
  const startYmd = emitter.ymd(period.start_date);
  const endYmd = emitter.ymd(period.end_date);

  let periodAttrs = {};
  try {
    if (period.tax_attrs) periodAttrs = JSON.parse(period.tax_attrs);
  } catch (e) { /* malformed tax_attrs — treat as empty */ }
  if (!periodAttrs || typeof periodAttrs !== 'object') periodAttrs = {};

  // ── 4. Accounts (code → account_type) ───────────────────────────────────────
  const acctRows = await query(
    `SELECT account_code, account_type FROM accounts WHERE company_id = ?`,
    [companyId]
  );
  const acctType = {};
  for (const r of acctRows) acctType[r.account_code] = r.account_type;

  // ── 5. sumAccounts — EXACT current SQL semantics ───────────────────────────
  async function sumAccounts(accounts, sign, scope) {
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

  // ── 6. Field maps + 7011/7012 injected into every blanket ───────────────────
  const blanketts = descriptor.blanketts || ['INK2', 'INK2R', 'INK2S'];
  const fields = {};
  for (const b of blanketts) fields[b] = {};
  for (const b of blanketts) {
    fields[b]['7011'] = startYmd;
    fields[b]['7012'] = endYmd;
  }
  const descFields = descriptor.fields || {};

  // Helper: find which blanket a field code belongs to (for copy sources).
  function blanketOf(code) {
    const def = descFields[code];
    return def && def.blankett ? def.blankett : null;
  }
  function fieldVal(code) {
    const b = blanketOf(code);
    return b ? fields[b][code] : undefined;
  }

  // ── 7. Compute in dependency phases ────────────────────────────────────────
  // (a) kind fields
  for (const [code, spec] of Object.entries(descFields)) {
    if (!spec.kind || !spec.accounts) continue;
    const b = spec.blankett;
    let sign, scope;
    if (spec.kind === 'asset') { sign = 'dr'; scope = 'yearend'; }
    else if (spec.kind === 'equity' || spec.kind === 'liability') { sign = 'cr'; scope = 'yearend'; }
    else if (spec.kind === 'cost') { sign = 'dr'; scope = 'year'; }
    else if (spec.kind === 'income') { sign = 'cr'; scope = 'year'; }
    else { sign = 'dr'; scope = 'yearend'; }
    const raw = await sumAccounts(spec.accounts, sign, scope);
    const val = roundHalfUp(raw);
    if (val > 0) {
      fields[b][code] = val;
    } else if (raw < -0.005) {
      warnings.push(`${b} ${code} value negative (${raw.toFixed(2)}) — dropped`);
    }
  }

  // (b) book_result + sign_split on book_result
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

  for (const [code, spec] of Object.entries(descFields)) {
    if (spec.op !== 'sign_split_profit' && spec.op !== 'sign_split_loss') continue;
    if (spec.source !== 'book_result') continue;
    const b = spec.blankett;
    if (spec.op === 'sign_split_profit') {
      if (bookResult >= 0) fields[b][code] = roundHalfUp(bookResult);
    } else { // sign_split_loss
      if (bookResult < 0) fields[b][code] = roundHalfUp(Math.abs(bookResult));
    }
  }

  // (c) tax_result = book_result − (emitted 7754 || 0) + sign_split on tax_result
  const val7754 = fieldVal('7754') || 0;
  const taxResult = bookResult - val7754;

  for (const [code, spec] of Object.entries(descFields)) {
    if (spec.op !== 'sign_split_profit' && spec.op !== 'sign_split_loss') continue;
    if (spec.source !== 'tax_result') continue;
    const b = spec.blankett;
    if (spec.op === 'sign_split_profit') {
      if (taxResult >= 0) fields[b][code] = roundHalfUp(taxResult);
    } else {
      if (taxResult < 0) fields[b][code] = roundHalfUp(Math.abs(taxResult));
    }
  }

  // (d) tax_attr (7763 loss_cf)
  let openingLoss = 0;
  for (const [code, spec] of Object.entries(descFields)) {
    if (spec.op !== 'tax_attr') continue;
    const b = spec.blankett;
    const value = overrides[spec.attr] != null
      ? Number(overrides[spec.attr])
      : (periodAttrs[spec.attr] != null ? Number(periodAttrs[spec.attr]) : null);
    if (value == null) {
      if (jurisdiction === 'SE') warnings.push(`${spec.attr} not given`);
      if (spec.emitZero) fields[b][code] = 0;
    } else {
      fields[b][code] = value > 0 ? roundHalfUp(value) : 0;
    }
    if (spec.attr === 'loss_cf') openingLoss = fields[b][code] || 0;
  }

  // (e) loss_closing (7770)
  for (const [code, spec] of Object.entries(descFields)) {
    if (spec.op !== 'loss_closing') continue;
    const b = spec.blankett;
    let closing;
    if (taxResult >= 0) {
      closing = openingLoss - roundHalfUp(taxResult);
    } else {
      closing = openingLoss + roundHalfUp(Math.abs(taxResult));
    }
    if (closing > 0) fields[b][code] = closing;
  }

  // (f) copy (7104←7670, 7114←7770): copy only when source field present (truthy).
  for (const [code, spec] of Object.entries(descFields)) {
    if (spec.op !== 'copy') continue;
    const b = spec.blankett;
    const src = fieldVal(spec.source);
    if (src) fields[b][code] = src;
  }

  // (g) flag (8041/8045): emit descriptor.value when attrVal === emitWhen.
  for (const [code, spec] of Object.entries(descFields)) {
    if (spec.op !== 'flag') continue;
    const b = spec.blankett;
    const attrVal = periodAttrs[spec.attr] != null ? periodAttrs[spec.attr] : false;
    if (attrVal === spec.emitWhen) fields[b][code] = spec.value;
  }

  // ── 8. Coverage warnings (EXACT current SQL + logic) ────────────────────────
  const mappedAccounts = new Set();
  for (const spec of Object.values(descFields)) {
    if (spec.accounts) spec.accounts.forEach((a) => mappedAccounts.add(a));
  }

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
      const t = acctType[r.account_code];
      if (t === 'Closing') continue;
      warnings.push(`Account ${r.account_code} (${t || 'unknown'}) has activity not covered by SRU mapping`);
    }
  }

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
      const already = warnings.some((w) => w.startsWith(`Account ${r.account_code} `));
      if (!already) {
        warnings.push(`Account ${r.account_code} (${t || 'unknown'}) has year-end balance not covered by SRU mapping`);
      }
    }
  }

  return { fields, warnings, period, company, bookResult, taxResult, descriptor, emitter };
}

// ── Mandatory contact validation (shared by info + ink2) ────────────────────
// Walks the pack's required contact attributes for the company's jurisdiction
// and returns an array of human-readable problem strings. Blank required
// values are flagged; postnr (the only format-bearing field today) is also
// format-checked when non-empty. Never throws — callers decide what to do.
function validateSruContact(company, contact) {
  const problems = [];
  for (const attr of contactAttributesFor(company.jurisdiction)) {
    if (!attr.required) continue;
    const v = contact[attr.key];
    if (!v || !String(v).trim()) {
      problems.push(`${attr.label} is required for SRU filing`);
    } else if (attr.format && !new RegExp(attr.format).test(String(v).trim())) {
      // Format owner today is postnr; message names the 5-digit expectation.
      problems.push('Postal code must be a valid Swedish zip code (5 digits)');
    }
  }
  return problems;
}

// Load the company's contact_* settings into a plain object keyed by the
// attribute name (prefix stripped). Positional query style matches the rest
// of this module.
async function loadContact(query, companyId) {
  const rows = await query(`SELECT key, value FROM settings WHERE company_id = ?`, [companyId]);
  const contact = {};
  for (const r of rows) {
    if (String(r.key).startsWith('contact_')) contact[String(r.key).slice('contact_'.length)] = r.value;
  }
  return contact;
}

// ── Express handlers ──────────────────────────────────────────────────────────
async function handleSruInk2(req, res) {
  const { company } = req.params;
  const { year, loss_cf, check } = req.query;
  if (!year) return res.status(400).json({ error: 'Missing ?year=' });
  const yr = parseInt(String(year), 10);
  if (!Number.isFinite(yr)) return res.status(400).json({ error: 'Invalid year' });

  try {
    // Mandatory MEDIELEV contact validation (postnr/postort). Runs BEFORE
    // computeFiling so the short-circuit fires even on empty books —
    // Skatteverket rejects INFO.SRU with blank #POSTNR/#POSTORT regardless of
    // the blanket contents. With ?check=1 the problems are appended to
    // warnings and never block the check flow.
    const coRows = await queryPositional(
      `SELECT company_id, company_name, tax_id, jurisdiction FROM companies
       WHERE company_id = ? ORDER BY created_at DESC LIMIT 1`,
      [company]
    );
    if (coRows.length === 0) {
      const err = new Error('Company not found'); err.code = 'NOT_FOUND'; throw err;
    }
    // P2-1: SRU export gate — period must be locked before generating SRU files.
    const periodName = 'FY' + yr;
    const lockRows = await queryPositional(
      `SELECT locked FROM (SELECT *, ROW_NUMBER() OVER(PARTITION BY period_name ORDER BY created_at DESC) AS rn FROM periods WHERE company_id = ? AND period_name = ?) WHERE rn = 1`,
      [company, periodName]
    );
    if (lockRows.length > 0 && !lockRows[0].locked) {
      return res.status(409).json({ ok: false, error: { code: 'PERIOD_NOT_LOCKED', message: 'Period must be locked before generating SRU files. Lock the period in Settings → Periods.' } });
    }
    const contact = await loadContact(queryPositional, company);
    const problems = validateSruContact(coRows[0], contact);
    if (check === '1' || check === 1) {
      const computed = await computeFiling(queryPositional, company, yr, { loss_cf });
      if (problems.length) computed.warnings.push(...problems);
      return res.json({ fields: computed.fields, warnings: computed.warnings });
    }
    if (problems.length) {
      return res.status(400).json({ error: problems.join(' | ') + ' — set them under Settings → Company' });
    }
    const computed = await computeFiling(queryPositional, company, yr, { loss_cf });
    const text = computed.emitter.emitSru(computed, computed.descriptor, yr);
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
    const co = coRows[0];
    // P2-1: SRU export gate — period must be locked before generating SRU files.
    const yr = parseInt(String(year), 10);
    if (Number.isFinite(yr)) {
      const periodName = 'FY' + yr;
      const lockRows = await queryPositional(
        `SELECT locked FROM (SELECT *, ROW_NUMBER() OVER(PARTITION BY period_name ORDER BY created_at DESC) AS rn FROM periods WHERE company_id = ? AND period_name = ?) WHERE rn = 1`,
        [company, periodName]
      );
      if (lockRows.length > 0 && !lockRows[0].locked) {
        return res.status(409).json({ ok: false, error: { code: 'PERIOD_NOT_LOCKED', message: 'Period must be locked before generating SRU files. Lock the period in Settings → Periods.' } });
      }
    }
    const contact = await loadContact(queryPositional, company);
    const problems = validateSruContact(co, contact);
    if (problems.length) {
      return res.status(400).json({ error: problems.join(' | ') + ' — set them under Settings → Company' });
    }
    const descriptor = loadDescriptor(co.jurisdiction || 'SE');
    const emitter = loadEmitter(descriptor);
    const text = emitter.emitInfo(co, { kontakt, telefon, email }, contact);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="INFO.SRU"`);
    return res.send(text);
  } catch (err) {
    console.error('SRU info error:', err);
    return res.status(500).json({ error: err.message || 'INFO.SRU generation failed' });
  }
}

module.exports = {
  handleSruInk2,
  handleSruInfo,
};
