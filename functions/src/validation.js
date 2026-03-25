/**
 * Skuld — Validation engine
 *
 * All validation rules from design doc §5.
 * Returns { valid: boolean, errors: string[], warnings: string[] }
 */

/**
 * Validate a batch of journal entry lines before posting.
 *
 * @param {object} dataset - BigQuery dataset
 * @param {string} companyId
 * @param {object[]} lines - Array of { account_code, debit, credit, date, currency, fx_rate, vat_code, cost_center, profit_center }
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
async function validateJournalBatch(dataset, companyId, lines) {
  const errors = [];
  const warnings = [];

  if (!lines || lines.length === 0) {
    errors.push('No journal entry lines provided');
    return { valid: false, errors, warnings };
  }

  // Load company
  const [companies] = await dataset.query({
    query: `SELECT * FROM finance.companies WHERE company_id = @companyId`,
    params: { companyId },
  });
  if (companies.length === 0) {
    errors.push(`Company not found: ${companyId}`);
    return { valid: false, errors, warnings };
  }
  const company = companies[0];

  // Load accounts for this company
  const [accounts] = await dataset.query({
    query: `SELECT account_code, account_name, account_type, effective_from, effective_to, is_active
            FROM finance.accounts WHERE company_id = @companyId`,
    params: { companyId },
  });
  const accountMap = new Map(accounts.map((a) => [a.account_code, a]));

  // Load locked periods
  const [settingsRows] = await dataset.query({
    query: `SELECT value FROM finance.settings WHERE company_id = @companyId AND key = 'locked_periods'`,
    params: { companyId },
  });
  const lockedPeriods = settingsRows.length > 0 ? JSON.parse(settingsRows[0].value || '[]') : [];

  // Load valid VAT codes
  const [vatCodes] = await dataset.query({
    query: `SELECT vat_code, effective_from, effective_to FROM finance.vat_codes
            WHERE company_id = @companyId AND is_active = TRUE`,
    params: { companyId },
  });
  const vatCodeMap = new Map(vatCodes.map((v) => [v.vat_code, v]));

  // Load valid centers
  const [centers] = await dataset.query({
    query: `SELECT center_id, center_type FROM finance.centers
            WHERE company_id = @companyId AND is_active = TRUE`,
    params: { companyId },
  });
  const centerSet = new Set(centers.map((c) => c.center_id));

  // --- Per-line validation ---
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLabel = `Line ${i + 1}`;

    // Account exists
    const account = accountMap.get(line.account_code);
    if (!account) {
      errors.push(`${lineLabel}: Account ${line.account_code} does not exist in COA`);
      continue;
    }

    // Account active
    if (!account.is_active) {
      errors.push(`${lineLabel}: Account ${line.account_code} is inactive`);
    }

    // Account active on date (effective dates)
    const entryDate = new Date(line.date);
    if (account.effective_from && entryDate < new Date(account.effective_from)) {
      errors.push(`${lineLabel}: Account ${line.account_code} not active on ${line.date} (starts ${account.effective_from})`);
    }
    if (account.effective_to && entryDate > new Date(account.effective_to)) {
      errors.push(`${lineLabel}: Account ${line.account_code} not active on ${line.date} (ended ${account.effective_to})`);
    }

    // Period not locked
    const period = line.date.substring(0, 7); // YYYY-MM
    if (lockedPeriods.includes(period)) {
      errors.push(`${lineLabel}: Period ${period} is locked`);
    }

    // Date reasonable — not in future
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (entryDate > today) {
      errors.push(`${lineLabel}: Date ${line.date} is in the future`);
    }

    // FX rate present for foreign currency
    if (line.currency && line.currency !== company.currency) {
      if (!line.fx_rate || line.fx_rate <= 0) {
        errors.push(`${lineLabel}: Exchange rate required for foreign currency entry (${line.currency})`);
      }
    }

    // VAT code valid
    if (line.vat_code) {
      const vc = vatCodeMap.get(line.vat_code);
      if (!vc) {
        errors.push(`${lineLabel}: VAT code ${line.vat_code} does not exist or is inactive`);
      } else {
        if (vc.effective_from && entryDate < new Date(vc.effective_from)) {
          errors.push(`${lineLabel}: VAT code ${line.vat_code} not valid on ${line.date}`);
        }
        if (vc.effective_to && entryDate > new Date(vc.effective_to)) {
          errors.push(`${lineLabel}: VAT code ${line.vat_code} not valid on ${line.date}`);
        }
      }
    }

    // VAT advisory (warning, not error)
    if (company.vat_registered && !line.vat_code) {
      if (account && (account.account_type === 'Revenue' || account.account_type === 'Expense')) {
        warnings.push(`${lineLabel}: No VAT code specified for ${account.account_type} account ${line.account_code} — is this intentional?`);
      }
    }

    // Center exists
    if (line.cost_center && !centerSet.has(line.cost_center)) {
      errors.push(`${lineLabel}: Cost center ${line.cost_center} does not exist`);
    }
    if (line.profit_center && !centerSet.has(line.profit_center)) {
      errors.push(`${lineLabel}: Profit center ${line.profit_center} does not exist`);
    }

    // Debit/credit not both non-zero on same line
    if ((line.debit || 0) > 0 && (line.credit || 0) > 0) {
      errors.push(`${lineLabel}: Cannot have both debit and credit on the same line`);
    }

    // At least one of debit/credit must be non-zero
    if ((line.debit || 0) === 0 && (line.credit || 0) === 0) {
      errors.push(`${lineLabel}: Debit and credit are both zero`);
    }
  }

  // --- Batch-level validation ---

  // Entry must balance (in home currency)
  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of lines) {
    const rate = line.fx_rate || 1.0;
    totalDebit += (line.debit || 0) * rate;
    totalCredit += (line.credit || 0) * rate;
  }

  // Allow for floating-point rounding (0.01 tolerance)
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    errors.push(`Entry does not balance: DR ${totalDebit.toFixed(2)} ≠ CR ${totalCredit.toFixed(2)}`);
  }

  // --- Duplicate detection (warning only) ---
  // Check if very similar entries exist in BigQuery
  // (Skipped for performance — can be enabled as an option)

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate a bill before posting.
 */
async function validateBill(dataset, companyId, bill) {
  const errors = [];
  const warnings = [];

  if (!bill.vendor || bill.vendor.trim() === '') {
    errors.push('Vendor name required');
  }

  if (!bill.amount || bill.amount <= 0) {
    errors.push('Bill amount must be positive');
  }

  // Check accounts exist
  const [accounts] = await dataset.query({
    query: `SELECT account_code FROM finance.accounts
            WHERE company_id = @companyId AND account_code IN (@expense, @ap)`,
    params: { companyId, expense: bill.expense_account, ap: bill.ap_account },
  });
  const foundCodes = new Set(accounts.map((a) => a.account_code));

  if (!foundCodes.has(bill.expense_account)) {
    errors.push(`Expense account ${bill.expense_account} does not exist in COA`);
  }
  if (!foundCodes.has(bill.ap_account)) {
    errors.push(`AP account ${bill.ap_account} does not exist in COA`);
  }

  // Due date advisory
  if (bill.due_date && bill.date && new Date(bill.due_date) < new Date(bill.date)) {
    warnings.push('Due date is before bill date');
  }

  return { valid: errors.length === 0, errors, warnings };
}

module.exports = { validateJournalBatch, validateBill };
