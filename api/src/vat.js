'use strict';
/**
 * freeBooks — VAT / GST engine
 * Ported from BigQuery Cloud Function to DuckDB/Express.
 */

const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert } = require('./db');

async function handleVat(ctx, action) {
  switch (action) {
    case 'vat.codes.list': return listVatCodes(ctx);
    case 'vat.codes.upsert': return upsertVatCode(ctx);
    case 'vat.codes.delete': return deleteVatCode(ctx);
    default:
      throw Object.assign(new Error(`Unknown VAT action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

async function computeVatSplit(companyId, vatCode, grossAmount) {
  const rows = await query(
    `SELECT rate, vat_account_input, vat_account_output, is_reverse_charge
     FROM vat_codes
     WHERE company_id = @companyId AND vat_code = @vatCode AND is_active = TRUE
     LIMIT 1`,
    { companyId, vatCode }
  );

  if (rows.length === 0) {
    return { netAmount: grossAmount, vatAmount: 0, rate: 0, isReverseCharge: false, inputAccount: null, outputAccount: null };
  }

  const vc = rows[0];
  const rate = Number(vc.rate);

  if (vc.is_reverse_charge) {
    const vatAmount = roundCurrency(grossAmount * rate);
    return { netAmount: grossAmount, vatAmount, rate, isReverseCharge: true, inputAccount: vc.vat_account_input, outputAccount: vc.vat_account_output };
  }

  const netAmount = roundCurrency(grossAmount / (1 + rate));
  const vatAmount = roundCurrency(grossAmount - netAmount);
  return { netAmount, vatAmount, rate, isReverseCharge: false, inputAccount: vc.vat_account_input, outputAccount: vc.vat_account_output };
}

async function expandVatLines(companyId, entry) {
  if (!entry.vat_code) return [entry];

  const amount = entry.debit || entry.credit;
  const isDebit = entry.debit > 0;
  const split = await computeVatSplit(companyId, entry.vat_code, amount);

  if (split.vatAmount === 0) return [entry];

  const lines = [];

  if (split.isReverseCharge) {
    lines.push({ ...entry });
    lines.push({ account_code: split.inputAccount, debit: isDebit ? split.vatAmount : 0, credit: isDebit ? 0 : split.vatAmount, date: entry.date, description: `${entry.description || ''} (input VAT RC)`.trim(), vat_code: entry.vat_code, vat_amount: split.vatAmount, net_amount: 0 });
    lines.push({ account_code: split.outputAccount, debit: isDebit ? 0 : split.vatAmount, credit: isDebit ? split.vatAmount : 0, date: entry.date, description: `${entry.description || ''} (output VAT RC)`.trim(), vat_code: entry.vat_code, vat_amount: split.vatAmount, net_amount: 0 });
  } else {
    lines.push({ ...entry, debit: isDebit ? split.netAmount : 0, credit: isDebit ? 0 : split.netAmount, net_amount: split.netAmount, vat_amount: 0 });
    const vatAccount = isDebit ? split.inputAccount : split.outputAccount;
    lines.push({ account_code: vatAccount, debit: isDebit ? split.vatAmount : 0, credit: isDebit ? 0 : split.vatAmount, date: entry.date, description: `${entry.description || ''} (VAT ${(split.rate * 100).toFixed(0)}%)`.trim(), vat_code: entry.vat_code, vat_amount: split.vatAmount, net_amount: 0 });
  }

  return lines;
}

async function generateVatReturn(ctx) {
  const { companyId, body } = ctx;
  const { periodFrom, periodTo } = body;

  if (!periodFrom || !periodTo) {
    throw Object.assign(new Error('periodFrom and periodTo required'), { code: 'INVALID_INPUT' });
  }

  const entries = await query(
    `SELECT
       je.vat_code,
       vc.description AS vat_description,
       vc.report_box,
       vc.rate,
       SUM(je.net_amount_home) AS total_net,
       SUM(je.vat_amount_home) AS total_vat,
       SUM(je.debit_home) AS total_debit,
       SUM(je.credit_home) AS total_credit
     FROM journal_entries je
     JOIN vat_codes vc ON je.company_id = vc.company_id AND je.vat_code = vc.vat_code
     WHERE je.company_id = @companyId
       AND je.date >= @periodFrom
       AND je.date <= @periodTo
       AND je.vat_code IS NOT NULL
     GROUP BY je.vat_code, vc.description, vc.report_box, vc.rate
     ORDER BY vc.report_box`,
    { companyId, periodFrom, periodTo }
  );

  const boxes = new Map();
  for (const row of entries) {
    const box = row.report_box || 'UNASSIGNED';
    if (!boxes.has(box)) boxes.set(box, { box, items: [], totalNet: 0, totalVat: 0 });
    const b = boxes.get(box);
    b.items.push({ vatCode: row.vat_code, description: row.vat_description, rate: row.rate, net: Number(row.total_net), vat: Number(row.total_vat) });
    b.totalNet += Number(row.total_net);
    b.totalVat += Number(row.total_vat);
  }

  return { companyId, periodFrom, periodTo, boxes: Array.from(boxes.values()) };
}

async function listVatCodes(ctx) {
  const { companyId } = ctx;
  return query(`SELECT * FROM vat_codes WHERE company_id = @companyId ORDER BY vat_code`, { companyId });
}

async function upsertVatCode(ctx) {
  const { companyId, body } = ctx;
  const { vatCode } = body;
  if (!vatCode || !vatCode.vat_code) throw Object.assign(new Error('vat_code required'), { code: 'INVALID_INPUT' });
  const existing = await query(`SELECT vat_code FROM vat_codes WHERE company_id = @companyId AND vat_code = @code`, { companyId, code: vatCode.vat_code });
  if (existing.length > 0) {
    await exec(`UPDATE vat_codes SET description=@desc, rate=@rate, input_account=@inp, output_account=@out, report_box=@box, is_reverse_charge=@rc, is_active=@active WHERE company_id=@companyId AND vat_code=@code`,
      { companyId, code: vatCode.vat_code, desc: vatCode.description || null, rate: vatCode.rate || 0, inp: vatCode.input_account || null, out: vatCode.output_account || null, box: vatCode.report_box || null, rc: !!vatCode.is_reverse_charge, active: vatCode.is_active !== false });
  } else {
    await bulkInsert('vat_codes', [{ company_id: companyId, vat_code: vatCode.vat_code, description: vatCode.description || null, rate: vatCode.rate || 0, input_account: vatCode.input_account || null, output_account: vatCode.output_account || null, report_box: vatCode.report_box || null, is_reverse_charge: !!vatCode.is_reverse_charge, is_active: vatCode.is_active !== false }]);
  }
  return { saved: true };
}

async function deleteVatCode(ctx) {
  const { companyId, body } = ctx;
  const { vatCode } = body;
  if (!vatCode) throw Object.assign(new Error('vatCode required'), { code: 'INVALID_INPUT' });
  await exec(`DELETE FROM vat_codes WHERE company_id = @companyId AND vat_code = @vatCode`, { companyId, vatCode });
  return { deleted: true };
}

function roundCurrency(amount) {
  return Math.round(amount * 100) / 100;
}

module.exports = { handleVat, computeVatSplit, expandVatLines, generateVatReturn };
