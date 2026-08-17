'use strict';
const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert } = require('./db');

async function handleWht(ctx, action) {
  switch (action) {
    case 'wht.codes.list':   return listWhtCodes(ctx);
    case 'wht.codes.upsert': return upsertWhtCode(ctx);
    case 'wht.codes.delete': return deleteWhtCode(ctx);
    default:
      throw Object.assign(new Error(`Unknown wht action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

async function listWhtCodes(ctx) {
  const { companyId } = ctx;
  return query(
    `SELECT wht_code, description, rate, wht_account, report_box, is_active, effective_from, effective_to
     FROM wht_codes WHERE company_id = @companyId ORDER BY wht_code`,
    { companyId }
  );
}

async function upsertWhtCode(ctx) {
  const { companyId, body } = ctx;
  const w = body.whtCode;
  if (!w || !w.wht_code) throw Object.assign(new Error('wht_code required'), { code: 'INVALID_INPUT' });
  const existing = await query(
    `SELECT wht_code FROM wht_codes WHERE company_id=@companyId AND wht_code=@code LIMIT 1`,
    { companyId, code: w.wht_code }
  );
  const params = {
    companyId, code: w.wht_code,
    description: w.description || '', rate: Number(w.rate) || 0,
    wht_account: w.wht_account || null, report_box: w.report_box || null,
    is_active: w.is_active !== false,
  };
  if (existing.length) {
    await exec(
      `UPDATE wht_codes SET description=@description, rate=@rate, wht_account=@wht_account,
         report_box=@report_box, is_active=@is_active
       WHERE company_id=@companyId AND wht_code=@code`,
      params
    );
  } else {
    await bulkInsert('wht_codes', [{
      company_id: companyId, wht_code: w.wht_code, description: w.description || '',
      rate: Number(w.rate) || 0, wht_account: w.wht_account || null, report_box: w.report_box || null,
      is_active: w.is_active !== false, effective_from: new Date().toISOString().slice(0, 10), effective_to: null,
    }]);
  }
  return { saved: true, wht_code: w.wht_code };
}

async function deleteWhtCode(ctx) {
  const { companyId, body } = ctx;
  const code = body.whtCode;
  if (!code) throw Object.assign(new Error('whtCode required'), { code: 'INVALID_INPUT' });
  await exec(`DELETE FROM wht_codes WHERE company_id=@companyId AND wht_code=@code`, { companyId, code });
  return { deleted: true };
}

module.exports = { handleWht };
