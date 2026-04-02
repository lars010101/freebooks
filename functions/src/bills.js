/**
 * Skuld — Accounts Payable (A/P) — Bill management
 *
 * Handles: create, post, void, list
 */

const { v4: uuid } = require('uuid');
const { validateBill } = require('./validation');
const { computeVatSplit } = require('./vat');

/**
 * Route bill actions.
 */
async function handleBills(ctx, action) {
  switch (action) {
    case 'bill.create':
      return createBill(ctx);
    case 'bill.post':
      return postBill(ctx);
    case 'bill.void':
      return voidBill(ctx);
    case 'bill.list':
      return listBills(ctx);
    default:
      throw Object.assign(new Error(`Unknown bill action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

/**
 * Create a bill in draft status.
 */
async function createBill(ctx) {
  const { dataset, companyId, userEmail, body } = ctx;
  const { bill } = body;

  if (!bill) {
    throw Object.assign(new Error('bill object required'), { code: 'INVALID_INPUT' });
  }

  // Validate
  const validation = await validateBill(dataset, companyId, bill);
  if (!validation.valid) {
    return { created: false, errors: validation.errors, warnings: validation.warnings };
  }

  // Load company for currency
  const [companies] = await dataset.query({
    query: `SELECT currency, vat_registered FROM finance.companies WHERE company_id = @companyId QUALIFY ROW_NUMBER() OVER(PARTITION BY company_id ORDER BY created_at DESC) = 1`,
    params: { companyId },
  });
  const company = companies[0];
  const currency = bill.currency || company.currency;
  const fxRate = currency === company.currency ? 1.0 : (bill.fx_rate || 1.0);

  // Compute VAT split if applicable
  let vatAmount = 0;
  let netAmount = bill.amount;
  if (bill.vat_code && company.vat_registered) {
    const split = await computeVatSplit(dataset, companyId, bill.vat_code, bill.amount);
    vatAmount = split.vatAmount;
    netAmount = split.netAmount;
  }

  const billId = uuid();
  const now = new Date().toISOString();

  const row = {
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
    status: 'draft',
    amount_paid: 0,
    description: bill.description || null,
    created_by: userEmail,
    created_at: now,
  };

  await dataset.table('bills').insert([row]);

  return {
    created: true,
    billId,
    warnings: validation.warnings,
  };
}

/**
 * Post a draft bill — creates the journal entry.
 *
 * DR expense_account  net_amount
 * DR vat_input_account vat_amount  (if VAT)
 * CR ap_account        gross_amount
 */
async function postBill(ctx) {
  const { dataset, companyId, userEmail, body } = ctx;
  const { billId } = body;

  if (!billId) {
    throw Object.assign(new Error('billId required'), { code: 'INVALID_INPUT' });
  }

  // Load bill
  const [bills] = await dataset.query({
    query: `SELECT * FROM finance.bills WHERE company_id = @companyId AND bill_id = @billId`,
    params: { companyId, billId },
  });

  if (bills.length === 0) {
    throw Object.assign(new Error('Bill not found'), { code: 'NOT_FOUND' });
  }

  const bill = bills[0];

  if (bill.status !== 'draft') {
    throw Object.assign(new Error(`Bill is ${bill.status}, can only post draft bills`), { code: 'INVALID_STATUS' });
  }

  const batchId = uuid();
  const now = new Date().toISOString();
  const lines = [];

  // Expense line (net amount)
  lines.push({
    company_id: companyId,
    entry_id: uuid(),
    batch_id: batchId,
    date: bill.date,
    account_code: bill.expense_account,
    debit: Number(bill.net_amount),
    credit: 0,
    currency: bill.currency,
    fx_rate: Number(bill.fx_rate),
    debit_home: Number(bill.net_amount) * Number(bill.fx_rate),
    credit_home: 0,
    vat_code: null,
    vat_amount: 0,
    vat_amount_home: 0,
    net_amount: Number(bill.net_amount),
    net_amount_home: Number(bill.net_amount) * Number(bill.fx_rate),
    description: `${bill.vendor} - ${bill.vendor_ref || bill.description || ''}`.trim(),
    reference: bill.vendor_ref,
    source: 'manual',
    cost_center: bill.cost_center,
    profit_center: bill.profit_center,
    reverses: null,
    reversed_by: null,
    bill_id: billId,
    created_by: userEmail,
    created_at: now,
  });

  // VAT line (if applicable)
  if (bill.vat_code && Number(bill.vat_amount) > 0) {
    // Get VAT accounts
    const split = await computeVatSplit(dataset, companyId, bill.vat_code, Number(bill.amount));

    lines.push({
      company_id: companyId,
      entry_id: uuid(),
      batch_id: batchId,
      date: bill.date,
      account_code: split.inputAccount,
      debit: Number(bill.vat_amount),
      credit: 0,
      currency: bill.currency,
      fx_rate: Number(bill.fx_rate),
      debit_home: Number(bill.vat_amount) * Number(bill.fx_rate),
      credit_home: 0,
      vat_code: bill.vat_code,
      vat_amount: Number(bill.vat_amount),
      vat_amount_home: Number(bill.vat_amount) * Number(bill.fx_rate),
      net_amount: 0,
      net_amount_home: 0,
      description: `VAT: ${bill.vendor}`,
      reference: bill.vendor_ref,
      source: 'manual',
      cost_center: null,
      profit_center: null,
      reverses: null,
      reversed_by: null,
      bill_id: billId,
      created_by: userEmail,
      created_at: now,
    });

    // Reverse charge: add output VAT line
    if (split.isReverseCharge) {
      lines.push({
        company_id: companyId,
        entry_id: uuid(),
        batch_id: batchId,
        date: bill.date,
        account_code: split.outputAccount,
        debit: 0,
        credit: Number(bill.vat_amount),
        currency: bill.currency,
        fx_rate: Number(bill.fx_rate),
        debit_home: 0,
        credit_home: Number(bill.vat_amount) * Number(bill.fx_rate),
        vat_code: bill.vat_code,
        vat_amount: Number(bill.vat_amount),
        vat_amount_home: Number(bill.vat_amount) * Number(bill.fx_rate),
        net_amount: 0,
        net_amount_home: 0,
        description: `Output VAT RC: ${bill.vendor}`,
        reference: bill.vendor_ref,
        source: 'manual',
        cost_center: null,
        profit_center: null,
        reverses: null,
        reversed_by: null,
        bill_id: billId,
        created_by: userEmail,
        created_at: now,
      });
    }
  }

  // AP line (credit — gross amount)
  lines.push({
    company_id: companyId,
    entry_id: uuid(),
    batch_id: batchId,
    date: bill.date,
    account_code: bill.ap_account,
    debit: 0,
    credit: Number(bill.amount),
    currency: bill.currency,
    fx_rate: Number(bill.fx_rate),
    debit_home: 0,
    credit_home: Number(bill.amount) * Number(bill.fx_rate),
    vat_code: null,
    vat_amount: 0,
    vat_amount_home: 0,
    net_amount: 0,
    net_amount_home: 0,
    description: `AP: ${bill.vendor}`,
    reference: bill.vendor_ref,
    source: 'manual',
    cost_center: null,
    profit_center: null,
    reverses: null,
    reversed_by: null,
    bill_id: billId,
    created_by: userEmail,
    created_at: now,
  });

  // Insert journal entries
  await dataset.table('journal_entries').insert(lines);

  // Update bill status
  await dataset.query({
    query: `UPDATE finance.bills SET status = 'posted' WHERE company_id = @companyId AND bill_id = @billId`,
    params: { companyId, billId },
  });

  return {
    posted: true,
    billId,
    batchId,
    lineCount: lines.length,
  };
}

/**
 * Void a bill — reverses the journal entry if posted.
 */
async function voidBill(ctx) {
  const { dataset, companyId, userEmail, body } = ctx;
  const { billId } = body;

  if (!billId) {
    throw Object.assign(new Error('billId required'), { code: 'INVALID_INPUT' });
  }

  const [bills] = await dataset.query({
    query: `SELECT * FROM finance.bills WHERE company_id = @companyId AND bill_id = @billId`,
    params: { companyId, billId },
  });

  if (bills.length === 0) {
    throw Object.assign(new Error('Bill not found'), { code: 'NOT_FOUND' });
  }

  const bill = bills[0];

  if (bill.status === 'paid') {
    throw Object.assign(new Error('Cannot void a paid bill — reverse the payment first'), { code: 'INVALID_STATUS' });
  }

  if (bill.status === 'void') {
    throw Object.assign(new Error('Bill is already void'), { code: 'INVALID_STATUS' });
  }

  // If posted, reverse the journal entries
  if (bill.status === 'posted' || bill.status === 'partial') {
    const [entries] = await dataset.query({
      query: `SELECT DISTINCT batch_id FROM finance.journal_entries
              WHERE company_id = @companyId AND bill_id = @billId`,
      params: { companyId, billId },
    });

    // Import handleJournal for reversal
    const { handleJournal } = require('./journal');
    for (const entry of entries) {
      await handleJournal(
        { ...ctx, body: { batchId: entry.batch_id } },
        'journal.reverse'
      );
    }
  }

  // Update bill status
  await dataset.query({
    query: `UPDATE finance.bills SET status = 'void' WHERE company_id = @companyId AND bill_id = @billId`,
    params: { companyId, billId },
  });

  return { voided: true, billId };
}

/**
 * List bills with optional filters.
 */
async function listBills(ctx) {
  const { dataset, companyId, body } = ctx;
  const { status, vendor, dateFrom, dateTo, limit = 100, offset = 0 } = body;

  let query = `SELECT * FROM finance.bills WHERE company_id = @companyId`;
  const params = { companyId };

  if (status) {
    query += ` AND status = @status`;
    params.status = status;
  }
  if (vendor) {
    query += ` AND UPPER(vendor) LIKE CONCAT('%', UPPER(@vendor), '%')`;
    params.vendor = vendor;
  }
  if (dateFrom) {
    query += ` AND date >= @dateFrom`;
    params.dateFrom = dateFrom;
  }
  if (dateTo) {
    query += ` AND date <= @dateTo`;
    params.dateTo = dateTo;
  }

  query += ` ORDER BY date DESC LIMIT @limit OFFSET @offset`;
  params.limit = limit;
  params.offset = offset;

  const [rows] = await dataset.query({ query, params });
  return rows;
}

module.exports = { handleBills };
