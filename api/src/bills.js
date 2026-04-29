'use strict';
/**
 * freeBooks — Accounts Payable (A/P)
 * Ported from BigQuery Cloud Function to DuckDB/Express.
 *
 * DuckDB simplifications:
 * - Status updates use UPDATE directly (no insert-then-QUALIFY workaround)
 * - No QUALIFY needed — bills table uses direct UPDATE
 */

const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert } = require('./db');
const { validateBill } = require('./validation');
const { computeVatSplit } = require('./vat');

async function handleBills(ctx, action) {
  switch (action) {
    case 'bill.create': return createBill(ctx);
    case 'bill.void':   return voidBill(ctx);
    case 'bill.list':   return listBills(ctx);
    case 'bill.match':  return matchBill(ctx);
    default:
      throw Object.assign(new Error(`Unknown bill action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

async function createBill(ctx) {
  const { companyId, userEmail, body } = ctx;
  const { bill, payment_batch_id } = body;

  if (!bill) throw Object.assign(new Error('bill object required'), { code: 'INVALID_INPUT' });

  const validation = await validateBill(companyId, bill);
  if (!validation.valid) return { created: false, errors: validation.errors, warnings: validation.warnings };

  const companies = await query(
    `SELECT currency, vat_registered FROM companies WHERE company_id = @companyId LIMIT 1`,
    { companyId }
  );
  const company = companies[0];
  const currency = bill.currency || company.currency;
  const fxRate = currency === company.currency ? 1.0 : (bill.fx_rate || 1.0);

  let vatAmount = 0, netAmount = bill.amount;
  if (bill.vat_code && company.vat_registered) {
    const split = await computeVatSplit(companyId, bill.vat_code, bill.amount);
    vatAmount = split.vatAmount;
    netAmount = split.netAmount;
  }

  const billId = uuid();
  const now = new Date().toISOString();

  const billRow = {
    company_id: companyId,
    bill_id: billId,
    vendor: bill.vendor,
    vendor_ref: bill.vendor_ref || null,
    date: bill.date,
    due_date: bill.due_date,
    amount: bill.amount,
    currency,
    fx_rate: fxRate,
    amount_home: bill.amount * fxRate,
    expense_account: bill.expense_account,
    ap_account: bill.ap_account,
    vat_code: bill.vat_code || null,
    vat_amount: vatAmount,
    net_amount: netAmount,
    cost_center: bill.cost_center || null,
    profit_center: bill.profit_center || null,
    description: bill.description || null,
    created_by: userEmail,
    created_at: now,
  };

  if (payment_batch_id) {
    await bulkInsert('bills', [{ ...billRow, status: 'paid', amount_paid: bill.amount }]);
    await bulkInsert('bill_payments', [{
      company_id: companyId,
      payment_id: uuid(),
      bill_id: billId,
      batch_id: payment_batch_id,
      amount: bill.amount,
      date: bill.date,
      method: 'bank_match',
      created_at: now,
    }]);
    return { created: true, billId, status: 'paid', warnings: validation.warnings };
  }

  const batchId = uuid();
  const lines = [];
  const desc = [bill.vendor, bill.vendor_ref, bill.description].filter(Boolean).join(' / ');

  lines.push({ company_id: companyId, entry_id: uuid(), batch_id: batchId, date: bill.date, account_code: bill.expense_account, debit: netAmount, credit: 0, currency, fx_rate: fxRate, debit_home: netAmount * fxRate, credit_home: 0, vat_code: null, vat_amount: 0, vat_amount_home: 0, net_amount: netAmount, net_amount_home: netAmount * fxRate, description: desc, reference: bill.vendor_ref || null, source: 'manual', cost_center: bill.cost_center || null, profit_center: bill.profit_center || null, reverses: null, reversed_by: null, bill_id: billId, created_by: userEmail, created_at: now });

  if (bill.vat_code && vatAmount > 0) {
    const split = await computeVatSplit(companyId, bill.vat_code, bill.amount);
    lines.push({ company_id: companyId, entry_id: uuid(), batch_id: batchId, date: bill.date, account_code: split.inputAccount, debit: vatAmount, credit: 0, currency, fx_rate: fxRate, debit_home: vatAmount * fxRate, credit_home: 0, vat_code: bill.vat_code, vat_amount: vatAmount, vat_amount_home: vatAmount * fxRate, net_amount: 0, net_amount_home: 0, description: `VAT: ${bill.vendor}`, reference: bill.vendor_ref || null, source: 'manual', cost_center: null, profit_center: null, reverses: null, reversed_by: null, bill_id: billId, created_by: userEmail, created_at: now });
    if (split.isReverseCharge) {
      lines.push({ company_id: companyId, entry_id: uuid(), batch_id: batchId, date: bill.date, account_code: split.outputAccount, debit: 0, credit: vatAmount, currency, fx_rate: fxRate, debit_home: 0, credit_home: vatAmount * fxRate, vat_code: bill.vat_code, vat_amount: vatAmount, vat_amount_home: vatAmount * fxRate, net_amount: 0, net_amount_home: 0, description: `Output VAT RC: ${bill.vendor}`, reference: bill.vendor_ref || null, source: 'manual', cost_center: null, profit_center: null, reverses: null, reversed_by: null, bill_id: billId, created_by: userEmail, created_at: now });
    }
  }

  lines.push({ company_id: companyId, entry_id: uuid(), batch_id: batchId, date: bill.date, account_code: bill.ap_account, debit: 0, credit: bill.amount, currency, fx_rate: fxRate, debit_home: 0, credit_home: bill.amount * fxRate, vat_code: null, vat_amount: 0, vat_amount_home: 0, net_amount: 0, net_amount_home: 0, description: `AP: ${desc}`, reference: bill.vendor_ref || null, source: 'manual', cost_center: null, profit_center: null, reverses: null, reversed_by: null, bill_id: billId, created_by: userEmail, created_at: now });

  await bulkInsert('journal_entries', lines);
  await bulkInsert('bills', [{ ...billRow, status: 'posted', amount_paid: 0 }]);

  return { created: true, billId, batchId, status: 'posted', lineCount: lines.length, warnings: validation.warnings };
}

async function voidBill(ctx) {
  const { companyId, body } = ctx;
  const { billId } = body;
  if (!billId) throw Object.assign(new Error('billId required'), { code: 'INVALID_INPUT' });

  const bills = await query(
    `SELECT * FROM bills WHERE company_id = @companyId AND bill_id = @billId ORDER BY created_at DESC LIMIT 1`,
    { companyId, billId }
  );
  if (bills.length === 0) throw Object.assign(new Error('Bill not found'), { code: 'NOT_FOUND' });

  const bill = bills[0];
  if (bill.status === 'void') throw Object.assign(new Error('Bill is already void'), { code: 'INVALID_STATUS' });
  if (bill.status === 'paid') throw Object.assign(new Error('Cannot void a paid bill — reverse the payment journal first'), { code: 'INVALID_STATUS' });

  if (bill.status === 'posted' || bill.status === 'partial') {
    const entries = await query(
      `SELECT DISTINCT batch_id FROM journal_entries WHERE company_id = @companyId AND bill_id = @billId`,
      { companyId, billId }
    );
    const { handleJournal } = require('./journal');
    for (const entry of entries) {
      await handleJournal({ ...ctx, body: { batchId: entry.batch_id } }, 'journal.reverse');
    }
  }

  // DuckDB: direct UPDATE (no streaming buffer workaround needed)
  await exec(
    `UPDATE bills SET status = 'void' WHERE company_id = @companyId AND bill_id = @billId`,
    { companyId, billId }
  );

  return { voided: true, billId };
}

async function listBills(ctx) {
  const { companyId, body } = ctx;
  const { status, vendor, dateFrom, dateTo, limit = 200, offset = 0 } = body;

  let sql = `SELECT * FROM bills WHERE company_id = @companyId`;
  const params = { companyId };

  if (status) { sql += ` AND status = @status`; params.status = status; }
  if (vendor) { sql += ` AND UPPER(vendor) LIKE '%' || UPPER(@vendor) || '%'`; params.vendor = vendor; }
  if (dateFrom) { sql += ` AND date >= @dateFrom`; params.dateFrom = dateFrom; }
  if (dateTo) { sql += ` AND date <= @dateTo`; params.dateTo = dateTo; }

  sql += ` ORDER BY date DESC, created_at DESC LIMIT @lim OFFSET @off`;
  params.lim = limit;
  params.off = offset;

  return query(sql, params);
}

async function matchBill(ctx) {
  const { companyId, body } = ctx;
  const { amount, currency, vendor, date } = body;
  if (!amount) throw Object.assign(new Error('amount required'), { code: 'INVALID_INPUT' });

  let sql = `SELECT bill_id, vendor, vendor_ref, date, due_date, amount, currency, status, amount_paid, ap_account, description
             FROM bills
             WHERE company_id = @companyId
               AND status IN ('posted', 'partial')
               AND ABS(amount - @amount) < 0.01`;
  const params = { companyId, amount: Number(amount) };

  if (vendor) { sql += ` AND UPPER(vendor) LIKE '%' || UPPER(@vendor) || '%'`; params.vendor = vendor; }
  if (date) { sql += ` AND date BETWEEN @dateFrom AND @dateTo`; params.dateFrom = new Date(new Date(date) - 90*86400000).toISOString().substring(0, 10); params.dateTo = new Date(new Date(date).getTime() + 90*86400000).toISOString().substring(0, 10); }
  if (currency) { sql += ` AND currency = @currency`; params.currency = currency; }

  sql += ` ORDER BY date DESC LIMIT 10`;

  return query(sql, params);
}

module.exports = { handleBills };
