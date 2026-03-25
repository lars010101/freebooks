/**
 * Skuld — Bank statement processing
 *
 * Handles: process (categorise) and approve (post entries).
 */

const { v4: uuid } = require('uuid');
const { expandVatLines } = require('./vat');

/**
 * Route bank actions.
 */
async function handleBank(ctx, action) {
  switch (action) {
    case 'bank.process':
      return processBankStatement(ctx);
    case 'bank.approve':
      return approveBankEntries(ctx);
    default:
      throw Object.assign(new Error(`Unknown bank action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

/**
 * Process bank statement rows — match against rules and open bills.
 *
 * Input body.rows: [{ date, description, amount, currency? }]
 * Returns categorised rows for user review.
 */
async function processBankStatement(ctx) {
  const { dataset, companyId, body } = ctx;
  const { rows: bankRows } = body;

  if (!bankRows || !Array.isArray(bankRows) || bankRows.length === 0) {
    throw Object.assign(new Error('rows array required'), { code: 'INVALID_INPUT' });
  }

  // Load company
  const [companies] = await dataset.query({
    query: `SELECT currency, accounting_method, vat_registered FROM finance.companies WHERE company_id = @companyId`,
    params: { companyId },
  });
  if (companies.length === 0) {
    throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });
  }
  const company = companies[0];

  // Load bank mappings (ordered by priority)
  const [mappings] = await dataset.query({
    query: `SELECT * FROM finance.bank_mappings
            WHERE company_id = @companyId AND is_active = TRUE
            ORDER BY priority ASC`,
    params: { companyId },
  });

  // Load open bills (for matching — only if accrual/hybrid)
  let openBills = [];
  if (company.accounting_method !== 'cash') {
    const [bills] = await dataset.query({
      query: `SELECT bill_id, vendor, vendor_ref, amount_home, amount_paid,
                     (amount_home - amount_paid) AS outstanding, due_date
              FROM finance.bills
              WHERE company_id = @companyId AND status IN ('posted', 'partial')
              ORDER BY due_date`,
      params: { companyId },
    });
    openBills = bills;
  }

  // Load default bank account
  const [settingsRows] = await dataset.query({
    query: `SELECT value FROM finance.settings WHERE company_id = @companyId AND key = 'default_bank_account'`,
    params: { companyId },
  });
  const bankAccount = settingsRows.length > 0 ? settingsRows[0].value : null;

  // Process each row
  const processed = [];

  for (const row of bankRows) {
    const result = {
      original: row,
      matchType: null,       // 'rule', 'bill', 'ai', null
      matchConfidence: null,  // 'high', 'medium', 'low'
      debitAccount: null,
      creditAccount: null,
      vatCode: null,
      costCenter: null,
      profitCenter: null,
      description: row.description,
      billId: null,
      suggestion: null,
    };

    const amount = Math.abs(row.amount);
    const isInflow = row.amount > 0;  // positive = money in

    // Step 1: Try mapping rules
    const mapping = matchMapping(mappings, row.description);
    if (mapping) {
      result.matchType = 'rule';
      result.matchConfidence = 'high';
      result.debitAccount = mapping.debit_account;
      result.creditAccount = mapping.credit_account;
      result.vatCode = mapping.vat_code;
      result.costCenter = mapping.cost_center;
      result.profitCenter = mapping.profit_center;
      if (mapping.description_override) {
        result.description = mapping.description_override;
      }
    }

    // Step 2: Try bill matching (if no rule match and accrual/hybrid)
    if (!result.matchType && openBills.length > 0) {
      const bill = matchBill(openBills, row.description, amount);
      if (bill) {
        result.matchType = 'bill';
        result.matchConfidence = 'medium';
        result.billId = bill.bill_id;
        result.description = `Payment: ${bill.vendor} ${bill.vendor_ref || ''}`.trim();

        if (isInflow) {
          // Receiving payment (unusual for A/P but possible for refunds)
          result.debitAccount = bankAccount;
          result.creditAccount = bill.ap_account || null;
        } else {
          // Paying a bill
          result.debitAccount = bill.ap_account || null;
          result.creditAccount = bankAccount;
        }
      }
    }

    // Step 3: If still unmatched, mark for manual/AI
    if (!result.matchType) {
      result.matchType = null;
      result.matchConfidence = null;
      // Set bank account for the known side
      if (isInflow) {
        result.debitAccount = bankAccount;
      } else {
        result.creditAccount = bankAccount;
      }
    }

    processed.push(result);
  }

  // Summary
  const matched = processed.filter((p) => p.matchType !== null).length;
  const unmatched = processed.length - matched;

  return {
    processed,
    summary: {
      total: processed.length,
      ruleMatched: processed.filter((p) => p.matchType === 'rule').length,
      billMatched: processed.filter((p) => p.matchType === 'bill').length,
      unmatched,
    },
  };
}

/**
 * Match a bank description against mapping rules.
 */
function matchMapping(mappings, description) {
  if (!description) return null;
  const desc = description.toUpperCase();

  for (const m of mappings) {
    const pattern = m.pattern.toUpperCase();

    switch (m.match_type) {
      case 'exact':
        if (desc === pattern) return m;
        break;
      case 'starts_with':
        if (desc.startsWith(pattern.replace(/\*$/, ''))) return m;
        break;
      case 'contains':
        if (desc.includes(pattern.replace(/\*/g, ''))) return m;
        break;
      case 'regex':
        try {
          if (new RegExp(m.pattern, 'i').test(description)) return m;
        } catch {
          // Invalid regex — skip
        }
        break;
    }
  }
  return null;
}

/**
 * Match a bank row against open bills.
 * Simple heuristic: amount match + vendor name in description.
 */
function matchBill(openBills, description, amount) {
  if (!description) return null;
  const desc = description.toUpperCase();

  // First pass: exact amount + vendor name in description
  for (const bill of openBills) {
    const outstanding = Number(bill.outstanding);
    if (Math.abs(outstanding - amount) < 0.01) {
      const vendor = (bill.vendor || '').toUpperCase();
      const ref = (bill.vendor_ref || '').toUpperCase();
      if ((vendor && desc.includes(vendor)) || (ref && desc.includes(ref))) {
        return bill;
      }
    }
  }

  // Second pass: exact amount only (lower confidence)
  for (const bill of openBills) {
    const outstanding = Number(bill.outstanding);
    if (Math.abs(outstanding - amount) < 0.01) {
      return bill;
    }
  }

  return null;
}

/**
 * Approve processed bank entries — post to journal.
 *
 * Input body.entries: [{ date, debitAccount, creditAccount, amount, description,
 *   vatCode?, costCenter?, profitCenter?, billId?, saveAsRule? }]
 * Input body.newMappings: [{ pattern, match_type, debit_account, credit_account, ... }]
 */
async function approveBankEntries(ctx) {
  const { dataset, companyId, userEmail, body } = ctx;
  const { entries, newMappings = [] } = body;

  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    throw Object.assign(new Error('entries array required'), { code: 'INVALID_INPUT' });
  }

  // Load company
  const [companies] = await dataset.query({
    query: `SELECT currency FROM finance.companies WHERE company_id = @companyId`,
    params: { companyId },
  });
  const homeCurrency = companies[0]?.currency || 'USD';

  const results = [];
  const errors = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const amount = Math.abs(entry.amount);
    const batchId = uuid();
    const now = new Date().toISOString();

    try {
      // Build journal lines
      let lines = [
        {
          account_code: entry.debitAccount,
          debit: amount,
          credit: 0,
          date: entry.date,
          description: entry.description,
          vat_code: entry.vatCode || null,
          cost_center: entry.costCenter || null,
          profit_center: entry.profitCenter || null,
        },
        {
          account_code: entry.creditAccount,
          debit: 0,
          credit: amount,
          date: entry.date,
          description: entry.description,
        },
      ];

      // Expand VAT if applicable
      if (entry.vatCode) {
        const expandedDebit = await expandVatLines(dataset, companyId, lines[0]);
        lines = [...expandedDebit, lines[1]];

        // Recalculate credit line to match total debits
        const totalDebit = lines.filter((l) => l !== lines[lines.length - 1])
          .reduce((s, l) => s + (l.debit || 0), 0);
        lines[lines.length - 1].credit = totalDebit;
      }

      // Post via journal service
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
        reference: entry.reference || null,
        source: 'bank_import',
        cost_center: line.cost_center || null,
        profit_center: line.profit_center || null,
        reverses: null,
        reversed_by: null,
        bill_id: entry.billId || null,
        created_by: userEmail,
        created_at: now,
      }));

      await dataset.table('journal_entries').insert(journalRows);

      // Handle bill payment if linked
      if (entry.billId) {
        await dataset.table('bill_payments').insert([{
          company_id: companyId,
          payment_id: uuid(),
          bill_id: entry.billId,
          batch_id: batchId,
          amount,
          date: entry.date,
          method: 'bank_match',
          created_at: now,
        }]);

        // Update bill status
        await dataset.query({
          query: `
            UPDATE finance.bills
            SET amount_paid = amount_paid + @amount,
                status = CASE
                  WHEN amount_paid + @amount >= amount THEN 'paid'
                  ELSE 'partial'
                END
            WHERE company_id = @companyId AND bill_id = @billId
          `,
          params: { companyId, billId: entry.billId, amount },
        });
      }

      results.push({ index: i, batchId, posted: true });
    } catch (err) {
      errors.push({ index: i, error: err.message });
    }
  }

  // Save new mapping rules
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
    await dataset.table('bank_mappings').insert(mappingRows);
  }

  return {
    posted: results.length,
    failed: errors.length,
    newMappings: newMappings.length,
    results,
    errors,
  };
}

module.exports = { handleBank };
