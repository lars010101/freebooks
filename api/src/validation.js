'use strict';
/**
 * freeBooks — Validation engine
 */

const { query } = require('./db');

async function validateJournalBatch(companyId, lines) {
  const errors = [];
  const warnings = [];

  if (!lines || lines.length === 0) {
    errors.push('No journal entry lines provided');
    return { valid: false, errors, warnings };
  }

  const companies = await query(
    `SELECT * FROM companies WHERE company_id = @companyId LIMIT 1`,
    { companyId }
  );
  if (companies.length === 0) {
    errors.push(`Company not found: ${companyId}`);
    return { valid: false, errors, warnings };
  }
  const company = companies[0];

  const accounts = await query(
    `SELECT account_code, account_name, account_type, effective_from, effective_to, is_active
     FROM accounts WHERE company_id = @companyId`,
    { companyId }
  );
  const accountMap = new Map(accounts.map((a) => [a.account_code, a]));

  const periods = await query(
    `SELECT period_name, start_date, end_date, locked
     FROM (SELECT *, ROW_NUMBER() OVER(PARTITION BY period_name ORDER BY created_at DESC) AS rn
           FROM periods WHERE company_id = @companyId) WHERE rn = 1`,
    { companyId }
  );

  const vatCodes = await query(
    `SELECT vat_code, effective_from, effective_to FROM vat_codes WHERE company_id = @companyId AND is_active = TRUE`,
    { companyId }
  );
  const vatCodeMap = new Map(vatCodes.map((v) => [v.vat_code, v]));

  const centers = await query(
    `SELECT center_id FROM centers WHERE company_id = @companyId AND is_active = TRUE`,
    { companyId }
  );
  const centerSet = new Set(centers.map((c) => c.center_id));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLabel = `Line ${i + 1}`;

    const account = accountMap.get(line.account_code);
    if (!account) {
      errors.push(`${lineLabel}: Account ${line.account_code} does not exist in COA`);
      continue;
    }

    if (!account.is_active) errors.push(`${lineLabel}: Account ${line.account_code} is inactive`);

    const entryDate = new Date(line.date);
    if (account.effective_from && entryDate < new Date(account.effective_from)) {
      errors.push(`${lineLabel}: Account ${line.account_code} not active on ${line.date}`);
    }
    if (account.effective_to && entryDate > new Date(account.effective_to)) {
      errors.push(`${lineLabel}: Account ${line.account_code} not active on ${line.date}`);
    }

    const entryDateOnly = new Date(String(line.date).substring(0, 10));
    const coveringPeriods = periods.filter((p) => new Date(p.start_date) <= entryDateOnly && new Date(p.end_date) >= entryDateOnly);
    if (coveringPeriods.length === 0) {
      errors.push(`${lineLabel}: Date ${line.date} does not fall within any defined period`);
    } else if (coveringPeriods.some((p) => p.locked)) {
      errors.push(`${lineLabel}: Date ${line.date} falls into a locked period`);
    }

    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (entryDate > today) errors.push(`${lineLabel}: Date ${line.date} is in the future`);

    if (line.currency && line.currency !== company.currency) {
      if (!line.fx_rate || line.fx_rate <= 0) {
        errors.push(`${lineLabel}: Exchange rate required for foreign currency (${line.currency})`);
      }
    }

    if (line.vat_code) {
      const vc = vatCodeMap.get(line.vat_code);
      if (!vc) {
        errors.push(`${lineLabel}: VAT code ${line.vat_code} does not exist or is inactive`);
      } else {
        if (vc.effective_from && entryDate < new Date(vc.effective_from)) errors.push(`${lineLabel}: VAT code ${line.vat_code} not valid on ${line.date}`);
        if (vc.effective_to && entryDate > new Date(vc.effective_to)) errors.push(`${lineLabel}: VAT code ${line.vat_code} not valid on ${line.date}`);
      }
    }

    if (company.vat_registered && !line.vat_code && account && (account.account_type === 'Revenue' || account.account_type === 'Expense')) {
      warnings.push(`${lineLabel}: No VAT code for ${account.account_type} account ${line.account_code}`);
    }

    if (line.cost_center && !centerSet.has(line.cost_center)) errors.push(`${lineLabel}: Cost center ${line.cost_center} does not exist`);
    if (line.profit_center && !centerSet.has(line.profit_center)) errors.push(`${lineLabel}: Profit center ${line.profit_center} does not exist`);

    if ((line.debit || 0) > 0 && (line.credit || 0) > 0) errors.push(`${lineLabel}: Cannot have both debit and credit on the same line`);
    if ((line.debit || 0) === 0 && (line.credit || 0) === 0) errors.push(`${lineLabel}: Debit and credit are both zero`);
  }

  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of lines) {
    const rate = line.fx_rate || 1.0;
    totalDebit += (line.debit || 0) * rate;
    totalCredit += (line.credit || 0) * rate;
  }
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    errors.push(`Entry does not balance: DR ${totalDebit.toFixed(2)} ≠ CR ${totalCredit.toFixed(2)}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

async function validateBill(companyId, bill) {
  const errors = [];
  const warnings = [];

  if (!bill.vendor || bill.vendor.trim() === '') errors.push('Vendor name required');
  if (!bill.amount || bill.amount <= 0) errors.push('Bill amount must be positive');

  const accounts = await query(
    `SELECT account_code FROM accounts WHERE company_id = @companyId AND account_code IN (@expense, @ap)`,
    { companyId, expense: bill.expense_account, ap: bill.ap_account }
  );
  const foundCodes = new Set(accounts.map((a) => a.account_code));

  if (!foundCodes.has(bill.expense_account)) errors.push(`Expense account ${bill.expense_account} does not exist in COA`);
  if (!foundCodes.has(bill.ap_account)) errors.push(`AP account ${bill.ap_account} does not exist in COA`);

  if (bill.due_date && bill.date && new Date(bill.due_date) < new Date(bill.date)) {
    warnings.push('Due date is before bill date');
  }

  return { valid: errors.length === 0, errors, warnings };
}

module.exports = { validateJournalBatch, validateBill };
