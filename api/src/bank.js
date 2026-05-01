'use strict';
/**
 * freeBooks — Bank statement processing
 * Ported from BigQuery Cloud Function to DuckDB/Express.
 */

const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert } = require('./db');
const { expandVatLines } = require('./vat');
const { getNextReference } = require('./journal');

async function handleBank(ctx, action) {
  switch (action) {
    case 'bank.process':         return processBankStatement(ctx);
    case 'bank.approve':         return approveBankEntries(ctx);
    case 'bank.reconcile.list':  return listReconcile(ctx);
    case 'bank.reconcile.clear': return clearReconcile(ctx);
    default:
      throw Object.assign(new Error(`Unknown bank action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

async function processBankStatement(ctx) {
  const { companyId, body } = ctx;
  const { rows: bankRows, bankAccount: bodyBankAccount } = body;

  if (!bankRows || !Array.isArray(bankRows) || bankRows.length === 0) {
    throw Object.assign(new Error('rows array required'), { code: 'INVALID_INPUT' });
  }

  const companies = await query(
    `SELECT currency, accounting_method, vat_registered FROM companies WHERE company_id = @companyId LIMIT 1`,
    { companyId }
  );
  if (companies.length === 0) throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });
  const company = companies[0];

  const mappings = await query(
    `SELECT * FROM bank_mappings WHERE company_id = @companyId AND is_active = TRUE ORDER BY priority ASC`,
    { companyId }
  );

  let openBills = [];
  if (company.accounting_method !== 'cash') {
    openBills = await query(
      `SELECT bill_id, vendor, vendor_ref, amount_home, amount_paid,
              (amount_home - amount_paid) AS outstanding, due_date
       FROM bills
       WHERE company_id = @companyId AND status IN ('posted', 'partial')
       ORDER BY due_date`,
      { companyId }
    );
  }

  const settingsRows = await query(
    `SELECT value FROM settings WHERE company_id = @companyId AND key = 'default_bank_account'`,
    { companyId }
  );
  const bankAccount = settingsRows.length > 0 ? settingsRows[0].value : (bodyBankAccount || null);

  const processed = [];
  for (const row of bankRows) {
    const result = {
      original: row,
      matchType: null,
      matchConfidence: null,
      debitAccount: null,
      creditAccount: null,
      vatCode: null,
      costCenter: null,
      profitCenter: null,
      description: row.description,
      billId: null,
    };

    const amount = Math.abs(row.amount);
    const isInflow = row.amount > 0;

    const mapping = matchMapping(mappings, row.description);
    if (mapping) {
      result.matchType = 'rule';
      result.matchConfidence = 'high';
      // offset_account (stored in debit_account) is the non-bank side.
      // Bank side is determined by amount sign.
      const offsetAccount = mapping.debit_account;
      const hasExplicitCredit = mapping.credit_account && mapping.credit_account !== mapping.debit_account;
      if (hasExplicitCredit) {
        // Legacy explicit DR/CR mapping
        result.debitAccount = mapping.debit_account;
        result.creditAccount = mapping.credit_account;
      } else {
        // Auto-assign bank side based on amount sign
        result.debitAccount = isInflow ? bankAccount : offsetAccount;
        result.creditAccount = isInflow ? offsetAccount : bankAccount;
      }
      result.vatCode = mapping.vat_code;
      result.costCenter = mapping.cost_center;
      result.profitCenter = mapping.profit_center;
      if (mapping.description_override) result.description = mapping.description_override;
    }

    if (!result.matchType && openBills.length > 0) {
      const bill = matchBillRow(openBills, row.description, amount);
      if (bill) {
        result.matchType = 'bill';
        result.matchConfidence = 'medium';
        result.billId = bill.bill_id;
        result.description = `Payment: ${bill.vendor} ${bill.vendor_ref || ''}`.trim();
        result.debitAccount = isInflow ? bankAccount : (bill.ap_account || null);
        result.creditAccount = isInflow ? (bill.ap_account || null) : bankAccount;
      }
    }

    if (!result.matchType) {
      if (isInflow) result.debitAccount = bankAccount;
      else result.creditAccount = bankAccount;
    }

    processed.push(result);
  }

  return {
    processed,
    summary: {
      total: processed.length,
      ruleMatched: processed.filter((p) => p.matchType === 'rule').length,
      billMatched: processed.filter((p) => p.matchType === 'bill').length,
      unmatched: processed.filter((p) => !p.matchType).length,
    },
  };
}

function matchMapping(mappings, description) {
  if (!description) return null;
  const desc = description.toUpperCase();
  for (const m of mappings) {
    const pattern = m.pattern.toUpperCase();
    switch (m.match_type) {
      case 'exact': if (desc === pattern) return m; break;
      case 'starts_with': if (desc.startsWith(pattern.replace(/\*$/, ''))) return m; break;
      case 'contains': if (desc.includes(pattern.replace(/\*/g, ''))) return m; break;
      case 'regex':
        try { if (new RegExp(m.pattern, 'i').test(description)) return m; } catch { /* invalid regex */ }
        break;
    }
  }
  return null;
}

function matchBillRow(openBills, description, amount) {
  if (!description) return null;
  const desc = description.toUpperCase();
  for (const bill of openBills) {
    const outstanding = Number(bill.outstanding);
    if (Math.abs(outstanding - amount) < 0.01) {
      const vendor = (bill.vendor || '').toUpperCase();
      const ref = (bill.vendor_ref || '').toUpperCase();
      if ((vendor && desc.includes(vendor)) || (ref && desc.includes(ref))) return bill;
    }
  }
  for (const bill of openBills) {
    if (Math.abs(Number(bill.outstanding) - amount) < 0.01) return bill;
  }
  return null;
}

async function approveBankEntries(ctx) {
  const { companyId, userEmail, body } = ctx;
  const { entries, newMappings = [], journalId: requestedJournalId } = body;

  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    throw Object.assign(new Error('entries array required'), { code: 'INVALID_INPUT' });
  }

  const companies = await query(
    `SELECT currency FROM companies WHERE company_id = @companyId LIMIT 1`,
    { companyId }
  );
  const homeCurrency = companies[0]?.currency || 'USD';

  const results = [];
  const errors = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const amount = Math.abs(entry.amount);
    const batchId = uuid();
    const now = new Date().toISOString();

    try {
      // Use journal from request, or fall back to BANK journal
      let bankJournalId = requestedJournalId || null;
      if (!bankJournalId) {
        const bankJournals = await query(
          `SELECT journal_id FROM journals WHERE company_id = @companyId AND code = 'BANK' AND active = true LIMIT 1`,
          { companyId }
        );
        bankJournalId = bankJournals.length > 0 ? bankJournals[0].journal_id : null;
      }
      const year = parseInt(String(entry.date).substring(0, 4), 10);
      const reference = bankJournalId ? await getNextReference(companyId, bankJournalId, year) : null;

      let lines = [
        { account_code: entry.debitAccount, debit: amount, credit: 0, date: entry.date, description: entry.description, vat_code: entry.vatCode || null, cost_center: entry.costCenter || null, profit_center: entry.profitCenter || null },
        { account_code: entry.creditAccount, debit: 0, credit: amount, date: entry.date, description: entry.description },
      ];

      if (entry.vatCode) {
        const expandedDebit = await expandVatLines(companyId, lines[0]);
        lines = [...expandedDebit, lines[1]];
        const totalDebit = lines.slice(0, -1).reduce((s, l) => s + (l.debit || 0), 0);
        lines[lines.length - 1].credit = totalDebit;
      }

      const journalRows = lines.map((line) => ({
        company_id: companyId,
        entry_id: uuid(),
        batch_id: batchId,
        date: line.date,
        account_code: line.account_code,
        debit: line.debit || 0,
        credit: line.credit || 0,
        currency: entry.currency || homeCurrency,
        fx_rate: entry.fxRate || 1.0,
        debit_home: (line.debit || 0) * (entry.fxRate || 1.0),
        credit_home: (line.credit || 0) * (entry.fxRate || 1.0),
        vat_code: line.vat_code || null,
        vat_amount: line.vat_amount || 0,
        vat_amount_home: (line.vat_amount || 0) * (entry.fxRate || 1.0),
        net_amount: line.net_amount || 0,
        net_amount_home: (line.net_amount || 0) * (entry.fxRate || 1.0),
        description: line.description || entry.description,
        reference,
        source: 'bank_import',
        cost_center: line.cost_center || null,
        profit_center: line.profit_center || null,
        reverses: null,
        reversed_by: null,
        bill_id: entry.billId || null,
        created_by: userEmail,
        created_at: now,
      }));

      await bulkInsert('journal_entries', journalRows);

      if (entry.billId) {
        await bulkInsert('bill_payments', [{
          company_id: companyId,
          payment_id: uuid(),
          bill_id: entry.billId,
          batch_id: batchId,
          amount,
          date: entry.date,
          method: 'bank_match',
          created_at: now,
        }]);

        // DuckDB: direct UPDATE works (no streaming buffer constraint)
        await exec(
          `UPDATE bills SET amount_paid = amount_paid + @amount,
           status = CASE WHEN amount_paid + @amount >= amount_home THEN 'paid' ELSE 'partial' END
           WHERE company_id = @companyId AND bill_id = @billId`,
          { companyId, billId: entry.billId, amount }
        );
      }

      results.push({ index: i, batchId, posted: true });
    } catch (err) {
      errors.push({ index: i, error: err.message });
    }
  }

  if (newMappings.length > 0) {
    const mappingRows = newMappings.map((m) => ({
      company_id: companyId,
      mapping_id: uuid(),
      pattern: m.pattern,
      match_type: m.match_type || 'contains',
      debit_account: m.debit_account,
      credit_account: m.credit_account,
      description_override: m.description_override || null,
      vat_code: m.vat_code || null,
      cost_center: m.cost_center || null,
      profit_center: m.profit_center || null,
      priority: m.priority || 100,
      is_active: true,
    }));
    await bulkInsert('bank_mappings', mappingRows);
  }

  return { posted: results.length, failed: errors.length, newMappings: newMappings.length, results, errors };
}

async function listReconcile(ctx) {
  const { companyId, body } = ctx;
  const { accountCode, dateFrom, dateTo } = body;
  if (!accountCode) throw Object.assign(new Error('accountCode required'), { code: 'INVALID_INPUT' });

  // Fetch opening balance (all activity before dateFrom)
  let openingBalance = 0;
  if (dateFrom) {
    const ob = await query(
      `SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS balance
       FROM journal_entries
       WHERE company_id = @companyId AND account_code = @accountCode AND date < @dateFrom`,
      { companyId, accountCode, dateFrom }
    );
    openingBalance = ob.length > 0 ? parseFloat(ob[0].balance || 0) : 0;
  }

  const rows = await query(
    `SELECT je.batch_id, je.date, je.reference, je.description,
            SUM(je.debit) AS debit, SUM(je.credit) AS credit,
            MAX(r.cleared_at) AS cleared_at
     FROM journal_entries je
     LEFT JOIN reconciliations r ON r.company_id = je.company_id AND r.batch_id = je.batch_id AND r.account_code = je.account_code
     WHERE je.company_id = @companyId AND je.account_code = @accountCode
       ${dateFrom ? 'AND je.date >= @dateFrom' : ''}
       ${dateTo   ? 'AND je.date <= @dateTo'   : ''}
     GROUP BY je.batch_id, je.date, je.reference, je.description
     ORDER BY je.date, je.batch_id`,
    { companyId, accountCode, ...(dateFrom && { dateFrom }), ...(dateTo && { dateTo }) }
  );
  return { rows: rows.map(r => ({ ...r, cleared: !!r.cleared_at })), openingBalance };
}

async function clearReconcile(ctx) {
  const { companyId, userEmail, body } = ctx;
  const { batchId, accountCode, cleared } = body;
  if (!batchId || !accountCode) throw Object.assign(new Error('batchId and accountCode required'), { code: 'INVALID_INPUT' });
  if (cleared) {
    await exec(
      `INSERT INTO reconciliations (company_id, batch_id, account_code, cleared_at, cleared_by)
       VALUES (@companyId, @batchId, @accountCode, NOW(), @clearedBy)
       ON CONFLICT DO NOTHING`,
      { companyId, batchId, accountCode, clearedBy: userEmail || 'user' }
    );
  } else {
    await exec(
      `DELETE FROM reconciliations WHERE company_id = @companyId AND batch_id = @batchId AND account_code = @accountCode`,
      { companyId, batchId, accountCode }
    );
  }
  return { ok: true };
}

module.exports = { handleBank };
