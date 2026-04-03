/**
 * Skuld — Accounts Payable (A/P) — Bill management
 *
 * Lifecycle:
 *   bill.create      — create and immediately post journal (DR expense / CR ap)
 *                      OR, if payment_batch_id supplied, mark as paid immediately
 *                      (bank payment already recorded; bill is just a records linkage)
 *   bill.void        — reverse journal entries and mark void
 *   bill.list        — list bills with optional filters
 *   bill.match       — find open bills matching a bank payment (vendor + amount + date proximity)
 */

const { v4: uuid } = require('uuid');
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

/**
 * Create a bill and immediately post the journal entry.
 *
 * If payment_batch_id is supplied, no journal is created — the payment was already
 * recorded via bank statement processing. The bill is immediately marked 'paid'.
 *
 * Normal path:
 *   DR expense_account   net_amount
 *   DR vat_input_account vat_amount  (if VAT registered)
 *   CR ap_account        gross_amount
 */
async function createBill(ctx) {
  const { dataset, companyId, userEmail, body } = ctx;
  const { bill, payment_batch_id } = body;

  if (!bill) throw Object.assign(new Error('bill object required'), { code: 'INVALID_INPUT' });

  const validation = await validateBill(dataset, companyId, bill);
  if (!validation.valid) {
    return { created: false, errors: validation.errors, warnings: validation.warnings };
  }

  const [companies] = await dataset.query({
    query: `SELECT currency, vat_registered FROM finance.companies WHERE company_id = @companyId QUALIFY ROW_NUMBER() OVER(PARTITION BY company_id ORDER BY created_at DESC) = 1`,
    params: { companyId },
  });
  const company = companies[0];
  const currency = bill.currency || company.currency;
  const fxRate = currency === company.currency ? 1.0 : (bill.fx_rate || 1.0);

  let vatAmount = 0;
  let netAmount = bill.amount;
  if (bill.vat_code && company.vat_registered) {
    const split = await computeVatSplit(dataset, companyId, bill.vat_code, bill.amount);
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

  // If bank payment already recorded, mark paid immediately — no journal needed
  if (payment_batch_id) {
    await dataset.table('bills').insert([{ ...billRow, status: 'paid', amount_paid: bill.amount }]);
    await dataset.table('bill_payments').insert([{
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

  // Standard path: post journal immediately
  const batchId = uuid();
  const lines = [];
  const desc = [bill.vendor, bill.vendor_ref, bill.description].filter(Boolean).join(' / ');

  // Expense line
  lines.push({
    company_id: companyId, entry_id: uuid(), batch_id: batchId,
    date: bill.date, account_code: bill.expense_account,
    debit: netAmount, credit: 0,
    currency, fx_rate: fxRate,
    debit_home: netAmount * fxRate, credit_home: 0,
    vat_code: null, vat_amount: 0, vat_amount_home: 0,
    net_amount: netAmount, net_amount_home: netAmount * fxRate,
    description: desc, reference: bill.vendor_ref || null,
    source: 'manual', cost_center: bill.cost_center || null,
    profit_center: bill.profit_center || null,
    reverses: null, reversed_by: null, bill_id: billId,
    created_by: userEmail, created_at: now,
  });

  // VAT line
  if (bill.vat_code && vatAmount > 0) {
    const split = await computeVatSplit(dataset, companyId, bill.vat_code, bill.amount);
    lines.push({
      company_id: companyId, entry_id: uuid(), batch_id: batchId,
      date: bill.date, account_code: split.inputAccount,
      debit: vatAmount, credit: 0,
      currency, fx_rate: fxRate,
      debit_home: vatAmount * fxRate, credit_home: 0,
      vat_code: bill.vat_code, vat_amount: vatAmount, vat_amount_home: vatAmount * fxRate,
      net_amount: 0, net_amount_home: 0,
      description: `VAT: ${bill.vendor}`, reference: bill.vendor_ref || null,
      source: 'manual', cost_center: null, profit_center: null,
      reverses: null, reversed_by: null, bill_id: billId,
      created_by: userEmail, created_at: now,
    });
    if (split.isReverseCharge) {
      lines.push({
        company_id: companyId, entry_id: uuid(), batch_id: batchId,
        date: bill.date, account_code: split.outputAccount,
        debit: 0, credit: vatAmount,
        currency, fx_rate: fxRate,
        debit_home: 0, credit_home: vatAmount * fxRate,
        vat_code: bill.vat_code, vat_amount: vatAmount, vat_amount_home: vatAmount * fxRate,
        net_amount: 0, net_amount_home: 0,
        description: `Output VAT RC: ${bill.vendor}`, reference: bill.vendor_ref || null,
        source: 'manual', cost_center: null, profit_center: null,
        reverses: null, reversed_by: null, bill_id: billId,
        created_by: userEmail, created_at: now,
      });
    }
  }

  // AP credit line
  lines.push({
    company_id: companyId, entry_id: uuid(), batch_id: batchId,
    date: bill.date, account_code: bill.ap_account,
    debit: 0, credit: bill.amount,
    currency, fx_rate: fxRate,
    debit_home: 0, credit_home: bill.amount * fxRate,
    vat_code: null, vat_amount: 0, vat_amount_home: 0,
    net_amount: 0, net_amount_home: 0,
    description: `AP: ${desc}`, reference: bill.vendor_ref || null,
    source: 'manual', cost_center: null, profit_center: null,
    reverses: null, reversed_by: null, bill_id: billId,
    created_by: userEmail, created_at: now,
  });

  await dataset.table('journal_entries').insert(lines);
  await dataset.table('bills').insert([{ ...billRow, status: 'posted', amount_paid: 0 }]);

  return { created: true, billId, batchId, status: 'posted', lineCount: lines.length, warnings: validation.warnings };
}

/**
 * Void a bill — reverses all journal entries and marks void.
 */
async function voidBill(ctx) {
  const { dataset, companyId, body } = ctx;
  const { billId } = body;
  if (!billId) throw Object.assign(new Error('billId required'), { code: 'INVALID_INPUT' });

  const [bills] = await dataset.query({
    query: `SELECT * FROM finance.bills WHERE company_id = @companyId AND bill_id = @billId`,
    params: { companyId, billId },
  });
  if (bills.length === 0) throw Object.assign(new Error('Bill not found'), { code: 'NOT_FOUND' });

  const bill = bills[0];
  if (bill.status === 'void') throw Object.assign(new Error('Bill is already void'), { code: 'INVALID_STATUS' });
  if (bill.status === 'paid') throw Object.assign(new Error('Cannot void a paid bill — reverse the payment journal first'), { code: 'INVALID_STATUS' });

  if (bill.status === 'posted' || bill.status === 'partial') {
    const [entries] = await dataset.query({
      query: `SELECT DISTINCT batch_id FROM finance.journal_entries WHERE company_id = @companyId AND bill_id = @billId`,
      params: { companyId, billId },
    });
    const { handleJournal } = require('./journal');
    for (const entry of entries) {
      await handleJournal({ ...ctx, body: { batchId: entry.batch_id } }, 'journal.reverse');
    }
  }

  await dataset.query({
    query: `UPDATE finance.bills SET status = 'void' WHERE company_id = @companyId AND bill_id = @billId`,
    params: { companyId, billId },
  });

  return { voided: true, billId };
}

/**
 * List bills. Returns all bills or filtered by status/vendor/date.
 */
async function listBills(ctx) {
  const { dataset, companyId, body } = ctx;
  const { status, vendor, dateFrom, dateTo, limit = 200, offset = 0 } = body;

  let query = `SELECT * FROM finance.bills WHERE company_id = @companyId`;
  const params = { companyId };

  if (status) { query += ` AND status = @status`; params.status = status; }
  if (vendor) { query += ` AND UPPER(vendor) LIKE CONCAT('%', UPPER(@vendor), '%')`; params.vendor = vendor; }
  if (dateFrom) { query += ` AND date >= @dateFrom`; params.dateFrom = dateFrom; }
  if (dateTo) { query += ` AND date <= @dateTo`; params.dateTo = dateTo; }

  query += ` ORDER BY date DESC, created_at DESC LIMIT @limit OFFSET @offset`;
  params.limit = limit;
  params.offset = offset;

  const [rows] = await dataset.query({ query, params });
  return rows;
}

/**
 * Find open bills that might match a bank payment.
 * Matches on: amount, currency, vendor name similarity, date proximity (within 90 days).
 */
async function matchBill(ctx) {
  const { dataset, companyId, body } = ctx;
  const { amount, currency, vendor, date } = body;
  if (!amount) throw Object.assign(new Error('amount required'), { code: 'INVALID_INPUT' });

  const params = { companyId, amount: Number(amount) };
  const clauses = [];

  if (vendor) {
    clauses.push(`AND UPPER(vendor) LIKE CONCAT('%', UPPER(@vendor), '%')`);
    params.vendor = vendor;
  }
  if (date) {
    clauses.push(`AND date BETWEEN DATE_SUB(@payDate, INTERVAL 90 DAY) AND DATE_ADD(@payDate, INTERVAL 90 DAY)`);
    params.payDate = date;
  }
  if (currency) {
    clauses.push(`AND currency = @currency`);
    params.currency = currency;
  }

  const [rows] = await dataset.query({
    query: `SELECT bill_id, vendor, vendor_ref, date, due_date, amount, currency, status, amount_paid, ap_account, description
            FROM finance.bills
            WHERE company_id = @companyId
              AND status IN ('posted', 'partial')
              AND ABS(amount - @amount) < 0.01
              ${clauses.join(' ')}
            ORDER BY date DESC
            LIMIT 10`,
    params,
  });
  return rows;
}

module.exports = { handleBills };
