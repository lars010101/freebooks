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
    await exec(`UPDATE vat_codes SET description=@desc, rate=@rate, vat_account_input=@inp, vat_account_output=@out, report_box=@box, is_reverse_charge=@rc, is_active=@active WHERE company_id=@companyId AND vat_code=@code`,
      { companyId, code: vatCode.vat_code, desc: vatCode.description || null, rate: vatCode.rate || 0, inp: vatCode.input_account || null, out: vatCode.output_account || null, box: vatCode.report_box || null, rc: !!vatCode.is_reverse_charge, active: vatCode.is_active !== false });
  } else {
    await bulkInsert('vat_codes', [{ company_id: companyId, vat_code: vatCode.vat_code, description: vatCode.description || null, rate: vatCode.rate || 0, vat_account_input: vatCode.input_account || null, vat_account_output: vatCode.output_account || null, report_box: vatCode.report_box || null, is_reverse_charge: !!vatCode.is_reverse_charge, is_active: vatCode.is_active !== false, effective_from: vatCode.effective_from || new Date().toISOString().slice(0, 10), effective_to: null }]);
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

module.exports = { handleVat, generateVatReturn };
