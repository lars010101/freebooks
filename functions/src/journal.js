/**
 * Skuld — Journal entry service
 *
 * Handles: post, reverse, list, import, export
 */

const { v4: uuid } = require('uuid');
const { validateJournalBatch } = require('./validation');
const { computeVatSplit } = require('./vat');
const { auditLog } = require('./audit');

/**
 * Route journal actions.
 */
async function handleJournal(ctx, action) {
  switch (action) {
    case 'journal.post':
      return postEntry(ctx);
    case 'journal.reverse':
      return reverseEntry(ctx);
    case 'journal.list':
      return listEntries(ctx);
    case 'journal.import':
      return importEntries(ctx);
    case 'journal.export':
      return exportEntries(ctx);
    default:
      throw Object.assign(new Error(`Unknown journal action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

/**
 * Post a new journal entry (one balanced batch of lines).
 *
 * Input body.lines: [{ date, account_code, debit, credit, description, reference,
 *   currency?, fx_rate?, vat_code?, cost_center?, profit_center? }]
 * Input body.source: 'manual' | 'bank_import' | 'csv_import' | 'opening_balance'
 */
async function postEntry(ctx) {
  const { dataset, companyId, userEmail, body } = ctx;
  const { lines, source = 'manual' } = body;

  if (!lines || !Array.isArray(lines) || lines.length === 0) {
    throw Object.assign(new Error('lines array required'), { code: 'INVALID_INPUT' });
  }

  // Load company for currency default
  const [companies] = await dataset.query({
    query: `SELECT currency, vat_registered FROM finance.companies WHERE company_id = @companyId`,
    params: { companyId },
  });
  if (companies.length === 0) {
    throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });
  }
  const company = companies[0];

  // Enrich lines with defaults
  const enrichedLines = [];
  for (const line of lines) {
    const currency = line.currency || company.currency;
    const fxRate = currency === company.currency ? 1.0 : (line.fx_rate || 0);
    const debit = line.debit || 0;
    const credit = line.credit || 0;

    // VAT split (if VAT code provided and company is VAT registered)
    let vatAmount = 0;
    let vatAmountHome = 0;
    let netAmount = 0;
    let netAmountHome = 0;

    if (line.vat_code && company.vat_registered) {
      const split = await computeVatSplit(dataset, companyId, line.vat_code, debit || credit);
      vatAmount = split.vatAmount;
      netAmount = split.netAmount;
      vatAmountHome = vatAmount * fxRate;
      netAmountHome = netAmount * fxRate;
    }

    enrichedLines.push({
      ...line,
      currency,
      fx_rate: fxRate,
      debit,
      credit,
      debit_home: debit * fxRate,
      credit_home: credit * fxRate,
      vat_amount: vatAmount,
      vat_amount_home: vatAmountHome,
      net_amount: netAmount,
      net_amount_home: netAmountHome,
    });
  }

  // Validate
  const validation = await validateJournalBatch(dataset, companyId, enrichedLines);
  if (!validation.valid) {
    return { posted: false, errors: validation.errors, warnings: validation.warnings };
  }

  // Generate IDs
  const batchId = uuid();
  const now = new Date().toISOString();

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
    reference: line.reference || null,
    source,
    cost_center: line.cost_center || null,
    profit_center: line.profit_center || null,
    reverses: null,
    reversed_by: null,
    bill_id: line.bill_id || null,
    created_by: userEmail,
    created_at: now,
  }));

  await dataset.table('journal_entries').insert(rows);

  return {
    posted: true,
    batchId,
    lineCount: rows.length,
    warnings: validation.warnings,
  };
}

/**
 * Reverse an existing journal entry.
 *
 * Input body: { batchId, reversalDate? }
 */
async function reverseEntry(ctx) {
  const { dataset, companyId, userEmail, body } = ctx;
  const { batchId, reversalDate } = body;

  if (!batchId) {
    throw Object.assign(new Error('batchId required'), { code: 'INVALID_INPUT' });
  }

  // Load original entry
  const [original] = await dataset.query({
    query: `SELECT * FROM finance.journal_entries
            WHERE company_id = @companyId AND batch_id = @batchId`,
    params: { companyId, batchId },
  });

  if (original.length === 0) {
    throw Object.assign(new Error('Entry not found'), { code: 'NOT_FOUND' });
  }

  // Check not already reversed
  if (original[0].reversed_by) {
    throw Object.assign(new Error('Entry already reversed'), { code: 'ALREADY_REVERSED' });
  }

  // Check original period not locked
  const [settingsRows] = await dataset.query({
    query: `SELECT value FROM finance.settings WHERE company_id = @companyId AND key = 'locked_periods'`,
    params: { companyId },
  });
  const lockedPeriods = settingsRows.length > 0 ? JSON.parse(settingsRows[0].value || '[]') : [];

  const rDate = reversalDate || new Date().toISOString().substring(0, 10);
  const rPeriod = rDate.substring(0, 7);
  if (lockedPeriods.includes(rPeriod)) {
    throw Object.assign(new Error(`Reversal period ${rPeriod} is locked`), { code: 'PERIOD_LOCKED' });
  }

  // Create reversed lines (swap debit/credit)
  const newBatchId = uuid();
  const now = new Date().toISOString();

  const reversalRows = original.map((line) => ({
    company_id: companyId,
    entry_id: uuid(),
    batch_id: newBatchId,
    date: rDate,
    account_code: line.account_code,
    debit: line.credit,       // swapped
    credit: line.debit,       // swapped
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

  // Insert reversal
  await dataset.table('journal_entries').insert(reversalRows);

  // Mark original as reversed
  await dataset.query({
    query: `UPDATE finance.journal_entries SET reversed_by = @newBatchId
            WHERE company_id = @companyId AND batch_id = @batchId`,
    params: { companyId, batchId, newBatchId },
  });

  return {
    reversed: true,
    originalBatchId: batchId,
    reversalBatchId: newBatchId,
    lineCount: reversalRows.length,
  };
}

/**
 * List journal entries with optional filters.
 *
 * Input body: { dateFrom?, dateTo?, accountCode?, source?, limit?, offset? }
 */
async function listEntries(ctx) {
  const { dataset, companyId, body } = ctx;
  const { dateFrom, dateTo, accountCode, source, limit = 500, offset = 0 } = body;

  let query = `SELECT * FROM finance.journal_entries WHERE company_id = @companyId`;
  const params = { companyId };

  if (dateFrom) {
    query += ` AND date >= @dateFrom`;
    params.dateFrom = dateFrom;
  }
  if (dateTo) {
    query += ` AND date <= @dateTo`;
    params.dateTo = dateTo;
  }
  if (accountCode) {
    query += ` AND account_code = @accountCode`;
    params.accountCode = accountCode;
  }
  if (source) {
    query += ` AND source = @source`;
    params.source = source;
  }

  query += ` ORDER BY date DESC, created_at DESC LIMIT @limit OFFSET @offset`;
  params.limit = limit;
  params.offset = offset;

  const [rows] = await dataset.query({ query, params });
  return rows;
}

/**
 * Import multiple journal entries (batch of batches).
 *
 * Input body.entries: [{ lines: [...], source }]
 * Validates all, posts all or none.
 */
async function importEntries(ctx) {
  const { body } = ctx;
  const { entries } = body;

  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    throw Object.assign(new Error('entries array required'), { code: 'INVALID_INPUT' });
  }

  const results = [];
  const allErrors = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const entryCtx = {
      ...ctx,
      body: { lines: entry.lines, source: entry.source || 'csv_import' },
    };

    try {
      const result = await postEntry(entryCtx);
      if (!result.posted) {
        allErrors.push({ entry: i + 1, errors: result.errors });
      } else {
        results.push(result);
      }
    } catch (err) {
      allErrors.push({ entry: i + 1, errors: [err.message] });
    }
  }

  return {
    imported: results.length,
    failed: allErrors.length,
    errors: allErrors,
    results,
  };
}

/**
 * Export journal entries as structured data.
 *
 * Input body: { dateFrom?, dateTo?, format? }
 */
async function exportEntries(ctx) {
  const { dataset, companyId, body } = ctx;
  const { dateFrom, dateTo } = body;

  let query = `SELECT * FROM finance.journal_entries WHERE company_id = @companyId`;
  const params = { companyId };

  if (dateFrom) {
    query += ` AND date >= @dateFrom`;
    params.dateFrom = dateFrom;
  }
  if (dateTo) {
    query += ` AND date <= @dateTo`;
    params.dateTo = dateTo;
  }

  query += ` ORDER BY date, batch_id, entry_id`;

  const [rows] = await dataset.query({ query, params });
  return { entries: rows, count: rows.length };
}

module.exports = { handleJournal };
