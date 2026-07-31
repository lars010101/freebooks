'use strict';
/**
 * freeBooks — Bank statement processing
 * Ported from BigQuery Cloud Function to DuckDB/Express.
 */

const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert } = require('./db');
const { expandVatLines } = require('./vat');
const { getNextReference, getNextReferenceBatch } = require('./journal');
const { settleBillPayment } = require('./settlement');

async function handleBank(ctx, action) {
  switch (action) {
    case 'bank.process':         return processBankStatement(ctx);
    case 'bank.approve':         return approveBankEntries(ctx);
    case 'bank.reconcile.list':  return listReconcile(ctx);
    case 'bank.reconcile.clear': return clearReconcile(ctx);
    case 'bank.uncleared.list':  return listAllUncleared(ctx);
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
      `SELECT bill_id, vendor, vendor_ref, amount_home, amount_paid, ap_account,
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

  // P1-9 dual path: unvoided manual payments with their bank (credit) leg —
  // an import row matching one must NOT re-post (would double-count the bank side)
  let manualPayments = [];
  if (bankAccount) {
    manualPayments = await query(
      `SELECT bp.payment_id, bp.batch_id, bp.bill_id, bp.date, je.account_code, je.credit
       FROM bill_payments bp
       JOIN journal_entries je ON je.batch_id = bp.batch_id AND je.company_id = bp.company_id
       WHERE bp.company_id = @companyId AND bp.method = 'manual' AND bp.voided_at IS NULL AND je.credit > 0`,
      { companyId }
    );
  }

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

    // P1-9: row evidences an already-recorded manual payment (exact date + amount
    // + this bank account) → tag for clearing on approve, never re-post.
    if (bankAccount && !isInflow) {
      const mp = manualPayments.find((p) =>
        p.account_code === bankAccount &&
        Math.abs(Number(p.credit) - amount) < 0.01 &&
        String(p.date).substring(0, 10) === String(row.date).substring(0, 10)
      );
      if (mp) {
        result.matchType = 'recorded_payment';
        result.matchConfidence = 'high';
        result.paymentId = mp.payment_id;
        result.paymentBatchId = mp.batch_id;
        result.billId = mp.bill_id;
        result.bankAccount = bankAccount;
        result.description = `Already recorded: ${row.description}`;
        processed.push(result);
        continue;
      }
    }

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
      const m = matchBillRow(openBills, row.description, amount);
      if (m) {
        // P1-9 import hardening: amount-only matches become confirm-required
        // suggestions ('bill_suggest'), never silent auto-links.
        result.matchType = m.tier === 'suggest' ? 'bill_suggest' : 'bill';
        result.matchConfidence = m.tier;
        result.billId = m.bill.bill_id;
        result.description = `Payment: ${m.bill.vendor} ${m.bill.vendor_ref || ''}`.trim();
        result.debitAccount = isInflow ? bankAccount : (m.bill.ap_account || null);
        result.creditAccount = isInflow ? (m.bill.ap_account || null) : bankAccount;
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
      billSuggest: processed.filter((p) => p.matchType === 'bill_suggest').length,
      recordedPayment: processed.filter((p) => p.matchType === 'recorded_payment').length,
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
      // vendor_ref as a WHOLE TOKEN in the narrative promotes the match to high
      if (ref) {
        const token = new RegExp('(^|[^A-Z0-9])' + ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Z0-9]|$)');
        if (token.test(desc)) return { bill, tier: 'high' };
      }
      if ((vendor && desc.includes(vendor)) || (ref && desc.includes(ref))) return { bill, tier: 'medium' };
    }
  }
  // Amount-only fallback: returned as a suggestion tier — confirm-required (P1-9)
  for (const bill of openBills) {
    if (Math.abs(Number(bill.outstanding) - amount) < 0.01) return { bill, tier: 'suggest' };
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

  // CHANGE 3: Validate all accounts before posting any entries
  const accountCodes = new Set();
  for (const entry of entries) {
    if (entry.debitAccount) accountCodes.add(entry.debitAccount);
    if (entry.creditAccount) accountCodes.add(entry.creditAccount);
  }
  
  if (accountCodes.size > 0) {
    const placeholders = Array.from(accountCodes).map((_, i) => `@acct${i}`).join(',');
    const params = { companyId };
    Array.from(accountCodes).forEach((code, i) => {
      params[`acct${i}`] = code;
    });
    
    const validAccounts = await query(
      `SELECT account_code FROM accounts WHERE company_id = @companyId AND account_code IN (${placeholders}) AND is_active = true`,
      params
    );
    
    const validCodes = new Set(validAccounts.map(a => a.account_code));
    const invalidCodes = Array.from(accountCodes).filter(code => !validCodes.has(code));
    
    if (invalidCodes.length > 0) {
      throw Object.assign(
        new Error(`Invalid or inactive account codes: ${invalidCodes.join(', ')}`),
        { code: 'INVALID_ACCOUNT' }
      );
    }
  }

  // Pre-fetch once for all entries
  let bankJournalId = requestedJournalId || null;
  if (!bankJournalId) {
    const bankJournals = await query(
      `SELECT journal_id FROM journals WHERE company_id = @companyId AND code = 'BANK' AND active = true LIMIT 1`,
      { companyId }
    );
    bankJournalId = bankJournals.length > 0 ? bankJournals[0].journal_id : null;
  }

  // Pre-allocate references grouped by year — 3 DB calls per year instead of 3 per entry
  const entriesByYear = {};
  for (const entry of entries) {
    if (entry.recordedPayment) continue; // clearing-only entries post nothing — no reference needed
    const yr = parseInt(String(entry.date).substring(0, 4), 10);
    if (!entriesByYear[yr]) entriesByYear[yr] = [];
    entriesByYear[yr].push(entry);
  }
  const referenceMap = new Map(); // entry index → reference string
  if (bankJournalId) {
    for (const [yr, yearEntries] of Object.entries(entriesByYear)) {
      const refs = await getNextReferenceBatch(companyId, bankJournalId, parseInt(yr, 10), yearEntries.length);
      yearEntries.forEach((entry, idx) => {
        const globalIdx = entries.indexOf(entry);
        referenceMap.set(globalIdx, refs[idx]);
      });
    }
  }

  const results = [];
  const errors = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const amount = Math.abs(entry.amount);
    const batchId = uuid();
    const now = new Date().toISOString();

    try {
      // P1-9: row matched an already-recorded manual payment — clear the payment's
      // bank leg in reconciliations, never re-post the journal.
      if (entry.recordedPayment && entry.paymentBatchId) {
        await exec(
          `INSERT INTO reconciliations (company_id, batch_id, account_code, cleared_at, cleared_by)
           VALUES (@companyId, @batchId, @accountCode, NOW(), @clearedBy)
           ON CONFLICT DO NOTHING`,
          { companyId, batchId: entry.paymentBatchId, accountCode: entry.bankAccount, clearedBy: userEmail || 'user' }
        );
        results.push({ index: i, cleared: true, recordedPayment: true });
        continue;
      }

      const reference = referenceMap.get(i) || null;

      // Bill settlements go through the shared settlement core (P1-9) — no generic pre-post
      if (entry.billId && !entry.recordedPayment) {
        const s = await settleBillPayment({
          ctx,
          companyId, userEmail, billId: entry.billId,
          bankAccount: entry.creditAccount,
          homeCurrency,
          bankAmount: amount,
          date: entry.date,
          reference,
          description: entry.description,
          settledForeign: entry.settledForeign != null ? Number(entry.settledForeign) : null,
          billPayRate: entry.billPayRate ? Number(entry.billPayRate) : null,
          method: 'bank_match',
          source: 'bank_import',
          journalId: bankJournalId,
          currency: entry.currency || homeCurrency,
          fxRate: entry.fxRate || 1.0,
        });
        if (s.warning) {
          results.push({ index: i, batchId: s.batchId, posted: true, warning: s.warning });
        }
        if (s.fxDiff !== undefined) {
          results.push({ index: i, batchId: s.batchId, posted: true, fxDiff: s.fxDiff, settledForeign: s.settledForeign, settledBooked: s.settledBooked });
        } else {
          results.push({ index: i, batchId: s.batchId, posted: true });
        }
        continue;
      }

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

      // Post the normal 2-line journal first
      await bulkInsert('journal_entries', journalRows);

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

async function listAllUncleared(ctx) {
  const { companyId } = ctx;
  const rows = await query(
    `SELECT je.batch_id, je.date, je.reference, je.description,
            a.account_code, a.account_name,
            SUM(je.debit) AS debit, SUM(je.credit) AS credit
     FROM journal_entries je
     JOIN accounts a ON a.account_code = je.account_code AND a.company_id = je.company_id
     LEFT JOIN reconciliations r
       ON r.company_id = je.company_id
       AND r.batch_id = je.batch_id
       AND r.account_code = je.account_code
     WHERE je.company_id = @companyId AND a.cf_category = 'Cash' AND r.batch_id IS NULL
     GROUP BY je.batch_id, je.date, je.reference, je.description, a.account_code, a.account_name
     ORDER BY je.date, je.batch_id`,
    { companyId }
  );
  return { rows: rows.map(r => ({ ...r, cleared: false })) };
}

module.exports = { handleBank, listReconcile };
