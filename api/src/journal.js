'use strict';
/**
 * freeBooks — Journal entry service
 * Ported from BigQuery Cloud Function to DuckDB/Express.
 *
 * Key DuckDB simplifications:
 * - No streaming buffer — UPDATE/DELETE work immediately
 * - reversed_by is written directly on the original batch via UPDATE
 * - No QUALIFY workaround needed for latest-row patterns (or use ROW_NUMBER subquery)
 */

const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert } = require('./db');
const { validateJournalBatch } = require('./validation');
const { computeVatSplit } = require('./vat');
const { auditLog } = require('./audit');

async function handleJournal(ctx, action) {
  switch (action) {
    case 'journal.post':    return postEntry(ctx);
    case 'journal.reverse': return reverseEntry(ctx);
    case 'journal.list':    return listEntries(ctx);
    case 'journal.import':  return importEntries(ctx);
    case 'journal.search':  return searchEntries(ctx);
    case 'journal.get':     return getEntry(ctx);
    default:
      throw Object.assign(new Error(`Unknown journal action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

async function searchEntries(ctx) {
  const { companyId, body } = ctx;
  const { q } = body;
  if (!q || q.trim().length < 2) return [];
  const rows = await query(
    `SELECT batch_id, MIN(date) AS date, MAX(reference) AS reference, MAX(description) AS description
     FROM journal_entries
     WHERE company_id = @companyId
       AND reversed_by IS NULL
       AND (reference ILIKE @q OR description ILIKE @q OR batch_id ILIKE @q)
     GROUP BY batch_id
     ORDER BY MIN(date) DESC
     LIMIT 20`,
    { companyId, q: `%${q.trim()}%` }
  );
  return rows;
}

async function getEntry(ctx) {
  const { companyId, body } = ctx;
  const { batchId } = body;
  if (!batchId) throw Object.assign(new Error('batchId required'), { code: 'INVALID_INPUT' });
  return query(
    `SELECT * FROM journal_entries WHERE company_id = @companyId AND batch_id = @batchId ORDER BY account_code`,
    { companyId, batchId }
  );
}

/**
 * Generate the next sequential reference for a journal.
 * Format: {CODE}/{YYYY}/{NNNN}
 * Atomically increments journal_sequences.last_seq and returns the new reference.
 */
async function getNextReference(companyId, journalId, year) {
  // Upsert: insert row if missing, then increment
  await exec(
    `INSERT INTO journal_sequences (company_id, journal_id, year, last_seq)
     VALUES (@companyId, @journalId, @year, 0)
     ON CONFLICT DO NOTHING`,
    { companyId, journalId, year }
  );
  await exec(
    `UPDATE journal_sequences SET last_seq = last_seq + 1
     WHERE company_id = @companyId AND journal_id = @journalId AND year = @year`,
    { companyId, journalId, year }
  );
  const rows = await query(
    `SELECT j.code, s.last_seq
     FROM journal_sequences s
     JOIN journals j ON j.journal_id = s.journal_id
     WHERE s.company_id = @companyId AND s.journal_id = @journalId AND s.year = @year`,
    { companyId, journalId, year }
  );
  if (rows.length === 0) throw new Error('Failed to generate reference');
  const { code, last_seq } = rows[0];
  return `${code}/${year}/${String(last_seq).padStart(5, '0')}`;
}

async function postEntry(ctx) {
  const { companyId, userEmail, body } = ctx;
  const { lines, source = 'manual', journalId } = body;

  if (!lines || !Array.isArray(lines) || lines.length === 0) {
    throw Object.assign(new Error('lines array required'), { code: 'INVALID_INPUT' });
  }

  const companies = await query(
    `SELECT currency, vat_registered FROM companies WHERE company_id = @companyId LIMIT 1`,
    { companyId }
  );
  if (companies.length === 0) throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });
  const company = companies[0];

  const enrichedLines = [];
  for (const line of lines) {
    const currency = line.currency || company.currency;
    const fxRate = currency === company.currency ? 1.0 : (line.fx_rate || 0);
    const debit = line.debit || 0;
    const credit = line.credit || 0;

    let vatAmount = 0, vatAmountHome = 0, netAmount = 0, netAmountHome = 0;
    if (line.vat_code && company.vat_registered) {
      const split = await computeVatSplit(companyId, line.vat_code, debit || credit);
      vatAmount = split.vatAmount;
      netAmount = split.netAmount;
      vatAmountHome = vatAmount * fxRate;
      netAmountHome = netAmount * fxRate;
    }

    enrichedLines.push({ ...line, currency, fx_rate: fxRate, debit, credit, debit_home: debit * fxRate, credit_home: credit * fxRate, vat_amount: vatAmount, vat_amount_home: vatAmountHome, net_amount: netAmount, net_amount_home: netAmountHome });
  }

  const validation = await validateJournalBatch(companyId, enrichedLines);
  if (!validation.valid) return { posted: false, errors: validation.errors, warnings: validation.warnings };

  const batchId = uuid();
  const now = new Date().toISOString();

  // Generate sequential reference if a journalId was provided
  let autoReference = null;
  if (journalId) {
    const entryDate = enrichedLines[0].date;
    const year = parseInt(String(entryDate).substring(0, 4), 10);
    autoReference = await getNextReference(companyId, journalId, year);
  }

  const rows = enrichedLines.map((line) => ({
    company_id: companyId,
    entry_id: uuid(),
    batch_id: batchId,
    date: line.date,
    account_code: line.account_code,
    debit: line.debit,
    credit: line.credit,
    currency: line.currency,
    fx_rate: line.fx_rate,
    debit_home: line.debit_home,
    credit_home: line.credit_home,
    vat_code: line.vat_code || null,
    vat_amount: line.vat_amount,
    vat_amount_home: line.vat_amount_home,
    net_amount: line.net_amount,
    net_amount_home: line.net_amount_home,
    description: line.description || null,
    reference: autoReference || line.reference || null,
    source,
    cost_center: line.cost_center || null,
    profit_center: line.profit_center || null,
    reverses: null,
    reversed_by: null,
    bill_id: line.bill_id || null,
    created_by: userEmail,
    created_at: now,
  }));

  await bulkInsert('journal_entries', rows);

  return { posted: true, batchId, reference: autoReference, lineCount: rows.length, warnings: validation.warnings };
}

async function reverseEntry(ctx) {
  const { companyId, userEmail, body } = ctx;
  const { batchId, reversalDate } = body;

  if (!batchId) throw Object.assign(new Error('batchId required'), { code: 'INVALID_INPUT' });

  const original = await query(
    `SELECT * FROM journal_entries WHERE company_id = @companyId AND batch_id = @batchId`,
    { companyId, batchId }
  );
  if (original.length === 0) throw Object.assign(new Error('Entry not found'), { code: 'NOT_FOUND' });

  // DuckDB: check reversed_by directly (no streaming buffer issue)
  const existing = original[0];
  if (existing.reversed_by) throw Object.assign(new Error('Entry already reversed'), { code: 'ALREADY_REVERSED' });

  // Also check for reversal entries by reverses field
  const existingReversals = await query(
    `SELECT batch_id FROM journal_entries WHERE company_id = @companyId AND reverses = @batchId LIMIT 1`,
    { companyId, batchId }
  );
  if (existingReversals.length > 0) throw Object.assign(new Error('Entry already reversed'), { code: 'ALREADY_REVERSED' });

  const periods = await query(
    `SELECT period_name, start_date, end_date, locked FROM periods WHERE company_id = @companyId`,
    { companyId }
  );

  const rDate = reversalDate || new Date().toISOString().substring(0, 10);
  const rDateObj = new Date(rDate);
  const coveringPeriods = periods.filter((p) => new Date(p.start_date) <= rDateObj && new Date(p.end_date) >= rDateObj);

  if (coveringPeriods.length === 0) throw Object.assign(new Error(`Date ${rDate} does not fall within any defined period`), { code: 'PERIOD_UNDEFINED' });
  if (coveringPeriods.some((p) => p.locked)) throw Object.assign(new Error(`Date ${rDate} falls into a locked period`), { code: 'PERIOD_LOCKED' });

  const newBatchId = uuid();
  const now = new Date().toISOString();

  const reversalRows = original.map((line) => ({
    company_id: companyId,
    entry_id: uuid(),
    batch_id: newBatchId,
    date: rDate,
    account_code: line.account_code,
    debit: line.credit,
    credit: line.debit,
    currency: line.currency,
    fx_rate: line.fx_rate,
    debit_home: line.credit_home,
    credit_home: line.debit_home,
    vat_code: line.vat_code,
    vat_amount: line.vat_amount,
    vat_amount_home: line.vat_amount_home,
    net_amount: line.net_amount,
    net_amount_home: line.net_amount_home,
    description: `Reversal of ${line.reference || line.description || batchId}`,
    reference: `REV-${line.reference || batchId}`,
    source: 'reversal',
    cost_center: line.cost_center,
    profit_center: line.profit_center,
    reverses: batchId,
    reversed_by: null,
    bill_id: line.bill_id,
    created_by: userEmail,
    created_at: now,
  }));

  await bulkInsert('journal_entries', reversalRows);

  // DuckDB: UPDATE works immediately (no streaming buffer constraint)
  await exec(
    `UPDATE journal_entries SET reversed_by = @newBatchId WHERE company_id = @companyId AND batch_id = @batchId`,
    { companyId, batchId, newBatchId }
  );

  return { reversed: true, originalBatchId: batchId, reversalBatchId: newBatchId, lineCount: reversalRows.length };
}

async function listEntries(ctx) {
  const { companyId, body } = ctx;
  const { dateFrom, dateTo, accountCode, source } = body;

  let sql = `SELECT * FROM journal_entries WHERE company_id = @companyId`;
  const params = { companyId };

  if (dateFrom) { sql += ` AND date >= @dateFrom`; params.dateFrom = dateFrom; }
  if (dateTo) { sql += ` AND date <= @dateTo`; params.dateTo = dateTo; }
  if (accountCode) { sql += ` AND account_code = @accountCode`; params.accountCode = accountCode; }
  if (source) { sql += ` AND source = @source`; params.source = source; }

  sql += ` ORDER BY date DESC, batch_id, account_code`;

  return query(sql, params);
}

async function importEntries(ctx) {
  const { companyId, userEmail, body } = ctx;
  const { entries } = body;

  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    throw Object.assign(new Error('entries array required'), { code: 'INVALID_INPUT' });
  }

  const companies = await query(
    `SELECT currency, vat_registered FROM companies WHERE company_id = @companyId LIMIT 1`,
    { companyId }
  );
  if (companies.length === 0) throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });
  const company = companies[0];

  const accounts = await query(
    `SELECT account_code, is_active FROM accounts WHERE company_id = @companyId`,
    { companyId }
  );
  const accountSet = new Set(accounts.filter((a) => a.is_active).map((a) => a.account_code));

  const periods = await query(
    `SELECT period_name, start_date, end_date, locked FROM periods WHERE company_id = @companyId`,
    { companyId }
  );

  const allRows = [];
  const allErrors = [];
  const now = new Date().toISOString();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const { lines, source = 'csv_import' } = entry;
    const batchId = entry.batchId || uuid();
    const entryErrors = [];

    if (!lines || lines.length === 0) { allErrors.push({ entry: i + 1, errors: ['Empty entry'] }); continue; }

    for (const line of lines) {
      if (!accountSet.has(line.account_code)) entryErrors.push(`Unknown account: ${line.account_code}`);
      if (!line.date) entryErrors.push('Missing date');
    }

    const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
    const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.005) entryErrors.push(`Unbalanced: DR ${totalDebit.toFixed(2)} ≠ CR ${totalCredit.toFixed(2)}`);

    for (const line of lines) {
      if (line.date) {
        const d = new Date(String(line.date).substring(0, 10));
        const covering = periods.filter((p) => new Date(p.start_date) <= d && new Date(p.end_date) >= d);
        if (covering.length === 0) { entryErrors.push(`Date ${line.date} not in any period`); break; }
        if (covering.some((p) => p.locked)) { entryErrors.push(`Period locked for date: ${line.date}`); break; }
      }
    }

    if (entryErrors.length > 0) { allErrors.push({ entry: i + 1, batchId, errors: entryErrors }); continue; }

    for (const line of lines) {
      const currency = line.currency || company.currency;
      const fxRate = currency === company.currency ? 1.0 : (line.fx_rate || 1.0);
      const debit = line.debit || 0;
      const credit = line.credit || 0;

      allRows.push({
        company_id: companyId,
        entry_id: uuid(),
        batch_id: batchId,
        date: line.date,
        account_code: line.account_code,
        debit,
        credit,
        currency,
        fx_rate: fxRate,
        debit_home: debit * fxRate,
        credit_home: credit * fxRate,
        vat_code: line.vat_code || null,
        vat_amount: 0,
        vat_amount_home: 0,
        net_amount: 0,
        net_amount_home: 0,
        description: line.description || null,
        reference: line.reference || null,
        source,
        cost_center: line.cost_center || null,
        profit_center: line.profit_center || null,
        reverses: null,
        reversed_by: null,
        bill_id: line.bill_id || null,
        created_by: userEmail || 'import',
        created_at: now,
      });
    }
  }

  if (allErrors.length > 0) {
    return { imported: 0, failed: allErrors.length, totalEntries: entries.length, errors: allErrors };
  }

  await bulkInsert('journal_entries', allRows);

  await auditLog(companyId, 'journal_entries', 'bulk', 'import', userEmail || 'import', null);

  return { imported: entries.length, failed: 0, totalEntries: entries.length, rowsInserted: allRows.length, errors: [] };
}

module.exports = { handleJournal };
