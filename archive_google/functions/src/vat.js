/**
 * Skuld — VAT / GST engine
 *
 * Handles VAT splitting, reverse charge, and VAT return generation.
 */

const { v4: uuid } = require('uuid');

/**
 * Route VAT actions.
 */
async function handleVat(ctx, action) {
  switch (action) {
    case 'vat.codes.list':
      return listVatCodes(ctx);
    case 'vat.codes.save':
      return saveVatCodes(ctx);
    default:
      throw Object.assign(new Error(`Unknown VAT action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

/**
 * Compute VAT split from a gross amount.
 *
 * Given a gross amount (incl. VAT) and a VAT code, returns:
 * { netAmount, vatAmount, rate, isReverseCharge, inputAccount, outputAccount }
 *
 * @param {object} dataset
 * @param {string} companyId
 * @param {string} vatCode
 * @param {number} grossAmount - absolute value (debit or credit)
 * @returns {object}
 */
async function computeVatSplit(dataset, companyId, vatCode, grossAmount) {
  const [rows] = await dataset.query({
    query: `SELECT rate, vat_account_input, vat_account_output, is_reverse_charge
            FROM finance.vat_codes
            WHERE company_id = @companyId AND vat_code = @vatCode AND is_active = TRUE
            LIMIT 1`,
    params: { companyId, vatCode },
  });

  if (rows.length === 0) {
    // No VAT code found — return zero split
    return {
      netAmount: grossAmount,
      vatAmount: 0,
      rate: 0,
      isReverseCharge: false,
      inputAccount: null,
      outputAccount: null,
    };
  }

  const vc = rows[0];
  const rate = Number(vc.rate);

  if (vc.is_reverse_charge) {
    // Reverse charge: gross = net (no VAT included in the price)
    // VAT is calculated on top for reporting, but nets to zero
    const vatAmount = roundCurrency(grossAmount * rate);
    return {
      netAmount: grossAmount,
      vatAmount,
      rate,
      isReverseCharge: true,
      inputAccount: vc.vat_account_input,
      outputAccount: vc.vat_account_output,
    };
  }

  // Normal VAT: gross includes VAT
  // net = gross / (1 + rate)
  // vat = gross - net
  const netAmount = roundCurrency(grossAmount / (1 + rate));
  const vatAmount = roundCurrency(grossAmount - netAmount);

  return {
    netAmount,
    vatAmount,
    rate,
    isReverseCharge: false,
    inputAccount: vc.vat_account_input,
    outputAccount: vc.vat_account_output,
  };
}

/**
 * Expand a single user entry line into multiple journal lines with VAT split.
 *
 * For a purchase: user enters gross amount against expense account.
 * System creates:
 *   DR expense_account  net_amount
 *   DR vat_input_account vat_amount
 *   CR bank/AP account   gross_amount
 *
 * For reverse charge, additionally:
 *   DR vat_input_account  vat_amount (deductible)
 *   CR vat_output_account vat_amount (obligation)
 *
 * @param {object} dataset
 * @param {string} companyId
 * @param {object} entry - { account_code, debit, credit, vat_code, ... }
 * @returns {object[]} - expanded journal lines
 */
async function expandVatLines(dataset, companyId, entry) {
  if (!entry.vat_code) {
    return [entry]; // No VAT — return as-is
  }

  const amount = entry.debit || entry.credit;
  const isDebit = entry.debit > 0;
  const split = await computeVatSplit(dataset, companyId, entry.vat_code, amount);

  if (split.vatAmount === 0) {
    return [entry]; // Zero-rate or exempt — return as-is
  }

  const lines = [];

  if (split.isReverseCharge) {
    // Reverse charge: full amount to expense, VAT to both input and output
    lines.push({
      ...entry,
      // Keep original amount (gross = net for RC)
    });

    // Input VAT (deductible)
    lines.push({
      account_code: split.inputAccount,
      debit: isDebit ? split.vatAmount : 0,
      credit: isDebit ? 0 : split.vatAmount,
      date: entry.date,
      description: `${entry.description || ''} (input VAT RC)`.trim(),
      vat_code: entry.vat_code,
      vat_amount: split.vatAmount,
      net_amount: 0,
    });

    // Output VAT (obligation — opposite side)
    lines.push({
      account_code: split.outputAccount,
      debit: isDebit ? 0 : split.vatAmount,
      credit: isDebit ? split.vatAmount : 0,
      date: entry.date,
      description: `${entry.description || ''} (output VAT RC)`.trim(),
      vat_code: entry.vat_code,
      vat_amount: split.vatAmount,
      net_amount: 0,
    });
  } else {
    // Normal VAT: split gross into net + VAT
    // Expense/revenue line gets net amount
    lines.push({
      ...entry,
      debit: isDebit ? split.netAmount : 0,
      credit: isDebit ? 0 : split.netAmount,
      net_amount: split.netAmount,
      vat_amount: 0,
    });

    // VAT line
    const vatAccount = isDebit ? split.inputAccount : split.outputAccount;
    lines.push({
      account_code: vatAccount,
      debit: isDebit ? split.vatAmount : 0,
      credit: isDebit ? 0 : split.vatAmount,
      date: entry.date,
      description: `${entry.description || ''} (VAT ${(split.rate * 100).toFixed(0)}%)`.trim(),
      vat_code: entry.vat_code,
      vat_amount: split.vatAmount,
      net_amount: 0,
    });
  }

  return lines;
}

/**
 * Generate VAT return data for a period.
 *
 * Sums journal entries by vat_code → maps to report_box.
 *
 * @param {object} ctx
 * @returns {object} - { period, boxes: [{ box, description, amount }] }
 */
async function generateVatReturn(ctx) {
  const { dataset, companyId, body } = ctx;
  const { periodFrom, periodTo } = body;

  if (!periodFrom || !periodTo) {
    throw Object.assign(new Error('periodFrom and periodTo required'), { code: 'INVALID_INPUT' });
  }

  // Get all VAT-coded entries in the period
  const [entries] = await dataset.query({
    query: `
      SELECT
        je.vat_code,
        vc.description AS vat_description,
        vc.report_box,
        vc.rate,
        SUM(je.net_amount_home) AS total_net,
        SUM(je.vat_amount_home) AS total_vat,
        SUM(je.debit_home) AS total_debit,
        SUM(je.credit_home) AS total_credit
      FROM finance.journal_entries je
      JOIN finance.vat_codes vc
        ON je.company_id = vc.company_id AND je.vat_code = vc.vat_code
      WHERE je.company_id = @companyId
        AND je.date >= @periodFrom
        AND je.date <= @periodTo
        AND je.vat_code IS NOT NULL
      GROUP BY je.vat_code, vc.description, vc.report_box, vc.rate
      ORDER BY vc.report_box
    `,
    params: { companyId, periodFrom, periodTo },
  });

  // Group by report_box
  const boxes = new Map();
  for (const row of entries) {
    const box = row.report_box || 'UNASSIGNED';
    if (!boxes.has(box)) {
      boxes.set(box, { box, items: [], totalNet: 0, totalVat: 0 });
    }
    const b = boxes.get(box);
    b.items.push({
      vatCode: row.vat_code,
      description: row.vat_description,
      rate: row.rate,
      net: Number(row.total_net),
      vat: Number(row.total_vat),
    });
    b.totalNet += Number(row.total_net);
    b.totalVat += Number(row.total_vat);
  }

  return {
    companyId,
    periodFrom,
    periodTo,
    boxes: Array.from(boxes.values()),
  };
}

// --- List / Save VAT codes ---

async function listVatCodes(ctx) {
  const { dataset, companyId } = ctx;
  const [rows] = await dataset.query({
    query: `SELECT * FROM finance.vat_codes WHERE company_id = @companyId ORDER BY vat_code`,
    params: { companyId },
  });
  return rows;
}

async function saveVatCodes(ctx) {
  const { dataset, companyId, body } = ctx;
  const { vatCodes } = body;

  if (!vatCodes || !Array.isArray(vatCodes)) {
    throw Object.assign(new Error('vatCodes array required'), { code: 'INVALID_INPUT' });
  }

  await dataset.query({
    query: `DELETE FROM finance.vat_codes WHERE company_id = @companyId`,
    params: { companyId },
  });

  const rows = vatCodes.map((vc) => ({
    company_id: companyId,
    vat_code: vc.vat_code,
    description: vc.description,
    rate: vc.rate,
    vat_account_input: vc.vat_account_input || null,
    vat_account_output: vc.vat_account_output || null,
    report_box: vc.report_box || null,
    is_reverse_charge: vc.is_reverse_charge || false,
    is_active: vc.is_active !== false,
    effective_from: vc.effective_from,
    effective_to: vc.effective_to || null,
  }));

  if (rows.length > 0) {
    await dataset.table('vat_codes').insert(rows);
  }
  return { saved: rows.length };
}

// --- Utility ---

function roundCurrency(amount) {
  return Math.round(amount * 100) / 100;
}

module.exports = { handleVat, computeVatSplit, expandVatLines, generateVatReturn };
