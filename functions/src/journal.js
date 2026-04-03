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
    query: `SELECT currency, vat_registered FROM finance.companies WHERE company_id = @companyId QUALIFY ROW_NUMBER() OVER(PARTITION BY company_id ORDER BY created_at DESC) = 1`,
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

  // Check not already reversed — query for existing reversal rather than reading reversed_by
  // (reversed_by UPDATE is blocked while rows are in BigQuery streaming buffer)
  const [existingReversals] = await dataset.query({
    query: `SELECT batch_id FROM finance.journal_entries WHERE company_id = @companyId AND reverses = @batchId LIMIT 1`,
    params: { companyId, batchId },
  });
  if (existingReversals.length > 0) {
    throw Object.assign(new Error('Entry already reversed'), { code: 'ALREADY_REVERSED' });
  }

  // Check original period not locked
  const [periods] = await dataset.query({
    query: `SELECT period_name, start_date, end_date, locked FROM finance.periods WHERE company_id = @companyId`,
    params: { companyId },
  });

  const rDate = reversalDate || new Date().toISOString().substring(0, 10);
  const rDateObj = new Date(rDate);
  const coveringPeriods = periods.filter(p => new Date(p.start_date.value || p.start_date) <= rDateObj && new Date(p.end_date.value || p.end_date) >= rDateObj);
  
  if (coveringPeriods.length === 0) {
    throw Object.assign(new Error(`Date ${rDate} does not fall within any defined period`), { code: 'PERIOD_UNDEFINED' });
  } else if (coveringPeriods.some(p => p.locked)) {
    throw Object.assign(new Error(`Date ${rDate} falls into a locked period`), { code: 'PERIOD_LOCKED' });
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

  // Note: we do NOT update reversed_by on the original entry — BigQuery blocks all DML
  // (UPDATE and MERGE) while rows are in the streaming buffer (~90 min after insert).
  // Double-reversal is prevented by checking for existing reversals via reverses=batchId above.

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
  const { dateFrom, dateTo, accountCode, source } = body;

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

  // No arbitrary row limit — date filters are the right way to scope.
  // Ordering by date + batch_id keeps journal entries intact.
  query += ` ORDER BY date DESC, batch_id, account_code`;

  const [rows] = await dataset.query({ query, params });
  return rows;
}

/**
 * Import multiple journal entries — bulk mode.
 *
 * Input body.entries: [{ lines: [...], source?, batchId? }]
 *   Each entry is one balanced journal entry (2+ lines).
 *   If batchId is provided, it's preserved (for migrations).
 *
 * Performs a single validation pass, then bulk-inserts all rows.
 * Much faster than the per-entry postEntry loop for large imports.
 */
async function importEntries(ctx) {
  const { dataset, companyId, userEmail, body } = ctx;
  const { entries } = body;

  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    throw Object.assign(new Error('entries array required'), { code: 'INVALID_INPUT' });
  }

  // Load reference data once (not per-entry)
  const [companies] = await dataset.query({
    query: `SELECT currency, vat_registered FROM finance.companies WHERE company_id = @companyId QUALIFY ROW_NUMBER() OVER(PARTITION BY company_id ORDER BY created_at DESC) = 1`,
    params: { companyId },
  });
  if (companies.length === 0) {
    throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });
  }
  const company = companies[0];

  const [accounts] = await dataset.query({
    query: `SELECT account_code, is_active FROM finance.accounts WHERE company_id = @companyId`,
    params: { companyId },
  });
  const accountSet = new Set(accounts.filter((a) => a.is_active).map((a) => a.account_code));

  const [periods] = await dataset.query({
    query: `SELECT period_name, start_date, end_date, locked FROM finance.periods WHERE company_id = @companyId`,
    params: { companyId },
  });

  // Validate and build all rows
  const allRows = [];
  const allErrors = [];
  const now = new Date().toISOString();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const { lines, source = 'csv_import' } = entry;
    const batchId = entry.batchId || uuid();
    const entryErrors = [];

    if (!lines || lines.length === 0) {
      allErrors.push({ entry: i + 1, errors: ['Empty entry'] });
      continue;
    }

    // Validate: all accounts must exist
    for (const line of lines) {
      if (!accountSet.has(line.account_code)) {
        entryErrors.push(`Unknown account: ${line.account_code}`);
      }
      if (!line.date) {
        entryErrors.push('Missing date');
      }
    }

    // Validate: debits = credits
    const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
    const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.005) {
      entryErrors.push(`Unbalanced: DR ${totalDebit.toFixed(2)} ≠ CR ${totalCredit.toFixed(2)}`);
    }

    // Check locked periods
    for (const line of lines) {
      if (line.date) {
        const entryDateObj = new Date(line.date.substring(0, 10));
        const coveringPeriods = periods.filter(p => new Date(p.start_date.value || p.start_date) <= entryDateObj && new Date(p.end_date.value || p.end_date) >= entryDateObj);
        if (coveringPeriods.length === 0) {
          entryErrors.push(`Date ${line.date} does not fall within any defined period`);
          break;
        } else if (coveringPeriods.some(p => p.locked)) {
          entryErrors.push(`Period locked for date: ${line.date}`);
          break;
        }
      }
    }

    if (entryErrors.length > 0) {
      allErrors.push({ entry: i + 1, batchId, errors: entryErrors });
      continue;
    }

    // Build rows
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

  // If any errors, return them without inserting
  if (allErrors.length > 0) {
    return {
      imported: 0,
      failed: allErrors.length,
      totalEntries: entries.length,
      errors: allErrors,
    };
  }

  // Bulk insert (BigQuery streaming insert handles up to 10K rows per call)
  const CHUNK = 5000;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    const chunk = allRows.slice(i, i + CHUNK);
    await dataset.table('journal_entries').insert(chunk);
  }

  await auditLog(dataset, companyId, 'journal.import', userEmail, {
    entriesImported: entries.length,
    rowsInserted: allRows.length,
  });

  return {
    imported: entries.length - allErrors.length,
    failed: allErrors.length,
    totalEntries: entries.length,
    rowsInserted: allRows.length,
    errors: allErrors,
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
