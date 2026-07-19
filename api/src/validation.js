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
  if (!bill.vendor_ref || bill.vendor_ref.trim() === '') errors.push('Invoice Ref is required');
  if (!bill.amount || bill.amount <= 0) errors.push('Bill amount must be positive');

  // Blank account codes are reported as "required" rather than running a COA
  // lookup that would produce a confusing "account undefined does not exist"
  // message. Company defaults are applied upstream (bills.js) so by the time we
  // reach here a blank code genuinely means nothing was configured.
  const expenseAcct = bill.expense_account ? String(bill.expense_account).trim() : '';
  const apAcct = bill.ap_account ? String(bill.ap_account).trim() : '';
  if (!expenseAcct) errors.push('Expense account is required');
  if (!apAcct) errors.push('AP account is required');

  let foundCodes = new Set();
  if (expenseAcct || apAcct) {
    // Pass only the non-empty codes to the IN (...) list to avoid DuckDB
    // treating an empty string as a real (missing) account code.
    const codes = [];
    if (expenseAcct) codes.push(expenseAcct);
    if (apAcct) codes.push(apAcct);
    // Deduplicate so a single empty-side scenario doesn't double-bind params.
    const uniqCodes = Array.from(new Set(codes));
    const placeholders = uniqCodes.map((_, i) => '@code' + i).join(', ');
    const params = { companyId };
    uniqCodes.forEach((c, i) => { params['code' + i] = c; });
    const accounts = await query(
      `SELECT account_code FROM accounts WHERE company_id = @companyId AND account_code IN (${placeholders})`,
      params
    );
    foundCodes = new Set(accounts.map((a) => a.account_code));
  }

  if (expenseAcct && !foundCodes.has(expenseAcct)) errors.push(`Expense account ${expenseAcct} does not exist in COA`);
  if (apAcct && !foundCodes.has(apAcct)) errors.push(`AP account ${apAcct} does not exist in COA`);

  if (bill.due_date && bill.date && new Date(bill.due_date) < new Date(bill.date)) {
    warnings.push('Due date is before bill date');
  }

  // --- Fetch company currency (needed for FX rate validation, 1c) ---
  const companies = await query(
    `SELECT currency FROM companies WHERE company_id = @companyId LIMIT 1`,
    { companyId }
  );
  const companyCurrency = companies.length > 0 ? companies[0].currency : null;

  // --- 1b: Future-date guard (configurable; defaults to warning) ---
  // Setting key 'future_date_warning' may be set to 'warning' (default), 'error', or 'none'.
  // Some businesses pre-date bills legitimately, so we warn by default rather than block.
  const settingsRows = await query(
    `SELECT value FROM settings WHERE company_id = @companyId AND key = 'future_date_warning'`,
    { companyId }
  );
  const futureDateMode = (settingsRows.length > 0 && settingsRows[0].value) || 'warning';

  if (bill.date && futureDateMode !== 'none') {
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    const billDate = new Date(String(bill.date).substring(0, 10));
    if (billDate > today) {
      const msg = `Bill date ${bill.date} is in the future`;
      if (futureDateMode === 'error') {
        errors.push(msg);
      } else {
        warnings.push(msg);
      }
    }
  }

  // --- 1c: FX rate validation for foreign-currency bills ---
  // A foreign-currency bill without a valid FX rate is a real error (not a warning),
  // because amount_home would be computed incorrectly. Mirrors the FX check in
  // validateJournalBatch() (validation.js lines ~85-89).
  const billCurrency = bill.currency || companyCurrency;
  if (companyCurrency && billCurrency && billCurrency !== companyCurrency) {
    if (!bill.fx_rate || Number(bill.fx_rate) <= 0) {
      errors.push(`Exchange rate required for foreign currency (${billCurrency} \u2192 ${companyCurrency})`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

module.exports = { validateJournalBatch, validateBill };
