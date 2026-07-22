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
const { getNextReference } = require('./journal');
const { validateBill } = require('./validation');
const { settleBillPayment } = require('./settlement');
const { getRate } = require('./fx');
// computeVatSplit removed — bills now use tax-exclusive direct VAT lookup

// Read company-level default AP and expense account codes from the settings
// table. Returns { ap: '', expense: '' } when unset (blank fallback).
async function getCompanyDefaultAccounts(companyId) {
  const rows = await query(
    `SELECT key, value FROM settings WHERE company_id = @companyId AND key IN ('default_ap_account', 'default_expense_account')`,
    { companyId }
  );
  const out = { ap: '', expense: '' };
  for (const r of rows) {
    if (r.key === 'default_ap_account') out.ap = (r.value || '').trim();
    if (r.key === 'default_expense_account') out.expense = (r.value || '').trim();
  }
  return out;
}

// Apply company defaults as fallbacks for bill-level ap_account/expense_account
// and per-line expense_account. Values that are already set are preserved; the
// result may still be blank ('') when neither the bill nor the company specifies
// a value (validation surfaces a clear "required" error in that case).
function applyCompanyDefaults(bill, defaults) {
  if (!bill) return bill;
  if (!bill.ap_account) bill.ap_account = defaults.ap || '';
  if (!bill.expense_account) bill.expense_account = defaults.expense || '';
  if (Array.isArray(bill.lines)) {
    bill.lines.forEach(function (l) {
      if (l && !l.expense_account) l.expense_account = defaults.expense || '';
    });
  }
  return bill;
}

// Read VAT tolerance settings for a company. Returns { flat, pct } where:
//   flat = flat amount in home currency (default 0.50)
//   pct  = percentage of computed VAT, 0.01 = 1% (default 0.01)
// Override is accepted when |stated - computed| <= max(flat, pct * computed).
async function getVatTolerance(companyId) {
  const rows = await query(
    `SELECT key, value FROM settings WHERE company_id = @companyId AND key IN ('vat_tolerance', 'vat_tolerance_pct')`,
    { companyId }
  );
  let flat = 0.50;
  let pct = 0.01;
  for (const r of rows) {
    const v = parseFloat(r.value);
    if (isNaN(v)) continue;
    if (r.key === 'vat_tolerance') flat = v;
    else if (r.key === 'vat_tolerance_pct') pct = v;
  }
  return { flat, pct };
}

// Compute the tolerance for a single line: max(flat, pct * expectedVat).
function _vatToleranceFor(flat, pct, expectedVat) {
  return Math.max(flat, expectedVat * pct);
}

async function handleBills(ctx, action) {
  switch (action) {
    case 'bill.create': return createBill(ctx);
    case 'bill.void':   return voidBill(ctx);
    case 'bill.list':   return listBills(ctx);
    case 'bill.match':  return matchBill(ctx);
    case 'bill.lines':  return getBillLines(ctx);
    case 'bill.aging':  return getAgingReport(ctx);
    case 'bill.get':    return getBill(ctx);
    case 'bill.update': return updateBill(ctx);
    case 'bill.draft.save': return saveDraftBill(ctx);
    case 'bill.draft.post': return postDraftBill(ctx);
    case 'bill.draft.delete': return deleteDraftBill(ctx);
    case 'bill.payment.record': return recordBillPayment(ctx);
    case 'bill.payment.void':   return voidBillPayment(ctx);
    case 'bill.payments':       return listBillPayments(ctx);
    default:
      throw Object.assign(new Error(`Unknown bill action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

async function createBill(ctx) {
  const { companyId, userEmail, body } = ctx;
  const { bill, payment_batch_id } = body;

  // Replace draft: when _replaceDraftId is set, we promote the draft row to
  // 'posted' via an in-place UPDATE (no DELETE) so the draft's bill_id,
  // created_at, created_by, and any attachments are preserved. See below.
  const replaceDraftId = body._replaceDraftId;

  if (!bill) throw Object.assign(new Error('bill object required'), { code: 'INVALID_INPUT' });

  // Resolve company currency + FX rate BEFORE validation (validateBill checks bill.fx_rate)
  const companies = await query(
    `SELECT currency, vat_registered FROM companies WHERE company_id = @companyId LIMIT 1`,
    { companyId }
  );
  const company = companies[0];
  const currency = bill.currency || company.currency;

  let fxRate = 1.0;
  if (currency !== company.currency) {
    if (bill.fx_rate && Number(bill.fx_rate) > 0) {
      fxRate = Number(bill.fx_rate);
    } else {
      // Resolve from master data (exact-date-only lookup)
      const { getRate } = require('./fx');
      const resolved = await getRate(currency, company.currency, String(bill.date).substring(0, 10));
      if (resolved === null) {
        const errors = [`No FX rate found for ${currency} \u2192 ${company.currency} on ${bill.date}. Add the rate in Settings \u2192 Exchange Rates.`];
        throw Object.assign(new Error(errors.join('; ')), { code: 'INVALID_INPUT', details: { errors } });
      }
      fxRate = resolved;
    }
  }
  bill.fx_rate = fxRate;

  // Apply company-level default AP/expense accounts as fallbacks for any blank
  // bill-level or per-line account codes. Company defaults are themselves
  // optional (blank fallback) — validation will report a clear error if a
  // required account is still missing.
  const companyDefaults = await getCompanyDefaultAccounts(companyId);
  applyCompanyDefaults(bill, companyDefaults);

  // VAT tolerance settings (used when supplier-stated VAT override is provided)
  const vatTolerance = await getVatTolerance(companyId);

  // Pre-resolve lines for validation (amount + expense_account needed by validateBill)
  const _preLines = (Array.isArray(bill.lines) && bill.lines.length >= 1)
    ? bill.lines
    : [{ expense_account: bill.expense_account, amount: bill.amount, vat_code: bill.vat_code, description: bill.description }];
  const _preTotal = _preLines.reduce((s, l) => s + Number(l.amount || 0), 0);
  const billForValidation = {
    ...bill,
    amount: bill.amount || _preTotal,
    expense_account: bill.expense_account || (_preLines[0] && _preLines[0].expense_account),
  };

  const validation = await validateBill(companyId, billForValidation);
  if (!validation.valid) {
    throw Object.assign(new Error(validation.errors.join('; ')), {
      code: 'INVALID_INPUT',
      details: { errors: validation.errors, warnings: validation.warnings },
    });
  }

  // Validation passed. When replacing a draft we UPDATE the draft row in-place
  // (no DELETE) so that bill_id, created_at, created_by, and any attachments
  // linked to the draft's bill_id are preserved. See the UPDATE calls below.

  // --- 1a: Server-side period lock enforcement ---
  // The client-side openPostReviewPopup() checks allPeriods for an unlocked covering
  // period, but a direct API call bypasses that. Enforce here so that the bill date
  // must fall within an unlocked accounting period. Mirrors validateJournalBatch()
  // period logic (validation.js lines ~73-79).
  if (bill.date) {
    const periods = await query(
      `SELECT period_name, start_date, end_date, locked
       FROM (SELECT *, ROW_NUMBER() OVER(PARTITION BY period_name ORDER BY created_at DESC) AS rn
             FROM periods WHERE company_id = @companyId) WHERE rn = 1`,
      { companyId }
    );
    const billDateOnly = new Date(String(bill.date).substring(0, 10));
    const coveringPeriods = periods.filter(
      (p) => new Date(p.start_date) <= billDateOnly && new Date(p.end_date) >= billDateOnly
    );
    if (coveringPeriods.length === 0) {
      const errors = [`Bill date ${bill.date} does not fall within any defined accounting period`];
      throw Object.assign(new Error(errors.join('; ')), {
        code: 'VALIDATION',
        details: { errors, warnings: validation.warnings },
      });
    }
    const lockedPeriods = coveringPeriods.filter((p) => p.locked);
    if (lockedPeriods.length > 0) {
      const errors = [`Bill date ${bill.date} falls into a locked accounting period (${lockedPeriods.map((p) => p.period_name).join(', ')})`];
      throw Object.assign(new Error(errors.join('; ')), {
        code: 'PERIOD_LOCKED',
        details: { errors, warnings: validation.warnings },
      });
    }
  }

  // Resolve expense lines: multi-line or legacy single-line
  const expenseLines = (Array.isArray(bill.lines) && bill.lines.length >= 1)
    ? bill.lines
    : [{ expense_account: bill.expense_account, amount: bill.amount, vat_code: bill.vat_code, description: bill.description }];
  const totalAmount = expenseLines.reduce((s, l) => s + Number(l.amount || 0), 0);

  const firstVatCode = expenseLines[0].vat_code;

  // When posting a draft, reuse the draft's bill_id (preserves attachments +
  // audit trail). Otherwise mint a fresh id for a direct create+post.
  const billId = replaceDraftId || uuid();
  const now = new Date().toISOString();

  const billRow = {
    company_id: companyId,
    bill_id: billId,
    vendor: bill.vendor,
    vendor_ref: bill.vendor_ref || null,
    date: bill.date,
    due_date: bill.due_date,
    amount: totalAmount,
    currency,
    fx_rate: fxRate,
    amount_home: totalAmount * fxRate,
    expense_account: expenseLines[0].expense_account,
    ap_account: bill.ap_account,
    vat_code: firstVatCode || null,
    vat_amount: 0,        // recalculated after journal lines are built
    net_amount: totalAmount, // recalculated after journal lines are built
    cost_center: bill.cost_center || null,
    profit_center: bill.profit_center || null,
    description: bill.description || null,
    created_by: userEmail,
    created_at: now,
  };

  if (payment_batch_id) {
    if (replaceDraftId) {
      // UPDATE the draft row in-place (do NOT touch bill_id/company_id/created_at/created_by)
      await exec(
        `UPDATE bills SET
           status='paid', amount_paid=@amount_paid,
           vendor=@vendor, vendor_ref=@vendor_ref, date=@date, due_date=@due_date,
           amount=@amount, amount_home=@amount_home, currency=@currency, fx_rate=@fx_rate,
           expense_account=@expense_account, ap_account=@ap_account,
           vat_code=@vat_code, vat_amount=@vat_amount, net_amount=@net_amount,
           cost_center=@cost_center, profit_center=@profit_center,
           description=@description, draft_lines=NULL
         WHERE bill_id=@bill_id AND company_id=@company_id AND status='draft'`,
        {
          company_id: companyId,
          bill_id: billId,
          vendor: billRow.vendor,
          vendor_ref: billRow.vendor_ref,
          date: billRow.date,
          due_date: billRow.due_date,
          amount: totalAmount,
          amount_home: totalAmount * fxRate,
          currency: billRow.currency,
          fx_rate: billRow.fx_rate,
          expense_account: billRow.expense_account,
          ap_account: billRow.ap_account,
          vat_code: billRow.vat_code,
          vat_amount: 0,
          net_amount: totalAmount,
          cost_center: billRow.cost_center,
          profit_center: billRow.profit_center,
          description: billRow.description,
          amount_paid: totalAmount,
        }
      );
    } else {
      await bulkInsert('bills', [{ ...billRow, status: 'paid', amount_paid: totalAmount }]);
    }
    await bulkInsert('bill_payments', [{
      company_id: companyId,
      payment_id: uuid(),
      bill_id: billId,
      batch_id: payment_batch_id,
      amount: totalAmount,
      date: bill.date,
      method: 'bank_match',
      created_at: now,
    }]);
    return { created: true, billId, status: 'paid', warnings: validation.warnings };
  }

  const batchId = uuid();
  const year = new Date(bill.date).getFullYear();
  const apJournals = await query(
    `SELECT journal_id FROM journals WHERE company_id = @companyId AND code = 'AP' AND active = true LIMIT 1`,
    { companyId }
  );
  const apJournalId = apJournals.length ? apJournals[0].journal_id : null;
  const apRef = apJournalId
    ? await getNextReference(companyId, apJournalId, year).catch(() => bill.vendor_ref || null)
    : (bill.vendor_ref || null);
  const lines = [];
  const desc = [bill.vendor, bill.vendor_ref, bill.description].filter(Boolean).join(' / ');

  // One DR line per expense line
  let _billLineIdx = 0;
  for (const expLine of expenseLines) {
    const lineAmount = Number(expLine.amount || 0);
    let lineNet = lineAmount;
    let lineVat = 0;
    if (expLine.vat_code && company.vat_registered) {
      // Tax-exclusive: net = lineAmount, vat = lineAmount × rate (added on top)
      const vatRows = await query(
        `SELECT rate, vat_account_input, vat_account_output, is_reverse_charge
         FROM vat_codes WHERE company_id = @companyId AND vat_code = @vatCode AND is_active = true LIMIT 1`,
        { companyId, vatCode: expLine.vat_code }
      );
      if (vatRows.length > 0) {
        const vc = vatRows[0];
        const rate = Number(vc.rate);
        const expectedVat = Math.round(lineAmount * rate * 100) / 100;
        // Reverse charge: VAT is self-assessed — ignore any supplier-stated
        // override and always use the computed amount.
        if (vc.is_reverse_charge) {
          lineVat = expectedVat;
        } else if (expLine.vat_amount_override !== null && expLine.vat_amount_override !== undefined && !isNaN(Number(expLine.vat_amount_override))) {
          // Supplier-stated VAT override: always accepted, but warn if the
          // difference exceeds the configured tolerance.
          lineVat = Number(expLine.vat_amount_override);
          const diff = Math.abs(lineVat - expectedVat);
          const tol = _vatToleranceFor(vatTolerance.flat, vatTolerance.pct, expectedVat);
          if (diff > tol) {
            validation.warnings.push(`Line ${_billLineIdx + 1}: VAT amount ${lineVat.toFixed(2)} differs from computed ${expectedVat.toFixed(2)} by ${diff.toFixed(2)} — verify supplier invoice`);
          }
        } else {
          lineVat = expectedVat;
        }
        const vatInputAccount = expLine.vat_account_override || vc.vat_account_input;
        // lineNet stays = lineAmount (tax-exclusive — the user entered the net amount)

        if (vc.is_reverse_charge) {
          // Reverse charge: DR input VAT, CR output VAT (net effect zero on cash, but both reported)
          lines.push({ company_id: companyId, entry_id: uuid(), batch_id: batchId, date: bill.date, account_code: vc.vat_account_input, debit: lineVat, credit: 0, currency, fx_rate: fxRate, debit_home: lineVat * fxRate, credit_home: 0, vat_code: expLine.vat_code, vat_amount: lineVat, vat_amount_home: lineVat * fxRate, net_amount: lineNet, net_amount_home: lineNet * fxRate, description: `Input VAT RC: ${bill.vendor}`, reference: apRef, source: 'manual', cost_center: null, profit_center: null, reverses: null, reversed_by: null, bill_id: billId, created_by: userEmail, created_at: now });
          lines.push({ company_id: companyId, entry_id: uuid(), batch_id: batchId, date: bill.date, account_code: vc.vat_account_output, debit: 0, credit: lineVat, currency, fx_rate: fxRate, debit_home: 0, credit_home: lineVat * fxRate, vat_code: expLine.vat_code, vat_amount: lineVat, vat_amount_home: lineVat * fxRate, net_amount: 0, net_amount_home: 0, description: `Output VAT RC: ${bill.vendor}`, reference: apRef, source: 'manual', cost_center: null, profit_center: null, reverses: null, reversed_by: null, bill_id: billId, created_by: userEmail, created_at: now });
        } else {
          // Standard input VAT: DR GST input account (one entry per expense line)
          lines.push({ company_id: companyId, entry_id: uuid(), batch_id: batchId, date: bill.date, account_code: vatInputAccount, debit: lineVat, credit: 0, currency, fx_rate: fxRate, debit_home: lineVat * fxRate, credit_home: 0, vat_code: expLine.vat_code, vat_amount: lineVat, vat_amount_home: lineVat * fxRate, net_amount: lineNet, net_amount_home: lineNet * fxRate, description: `GST Input: ${bill.vendor}`, reference: apRef, source: 'manual', cost_center: null, profit_center: null, reverses: null, reversed_by: null, bill_id: billId, created_by: userEmail, created_at: now });
        }
      }
    }
    const lineDesc = expLine.description ? `${desc} / ${expLine.description}` : desc;
    lines.push({ company_id: companyId, entry_id: uuid(), batch_id: batchId, date: bill.date, account_code: expLine.expense_account, debit: lineNet, credit: 0, currency, fx_rate: fxRate, debit_home: lineNet * fxRate, credit_home: 0, vat_code: null, vat_amount: 0, vat_amount_home: 0, net_amount: lineNet, net_amount_home: lineNet * fxRate, description: lineDesc, reference: apRef, source: 'manual', cost_center: expLine.cost_center || bill.cost_center || null, profit_center: expLine.profit_center || bill.profit_center || null, reverses: null, reversed_by: null, bill_id: billId, created_by: userEmail, created_at: now });
    _billLineIdx++;
  }

  // Compute post-loop totals: total debit = net + VAT (used for AP credit and bill record)
  const totalDebit = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const totalVatAmount = lines.filter(l => l.vat_amount > 0).reduce((s, l) => s + Number(l.vat_amount || 0), 0);
  const totalNetAmount = lines.filter(l => l.net_amount > 0 && !l.vat_code).reduce((s, l) => s + Number(l.net_amount || 0), 0) || totalAmount;

  // Single CR AP line for total (net + VAT)
  lines.push({ company_id: companyId, entry_id: uuid(), batch_id: batchId, date: bill.date, account_code: bill.ap_account, debit: 0, credit: totalDebit, currency, fx_rate: fxRate, debit_home: 0, credit_home: totalDebit * fxRate, vat_code: null, vat_amount: 0, vat_amount_home: 0, net_amount: 0, net_amount_home: 0, description: `AP: ${desc}`, reference: apRef, source: 'manual', cost_center: null, profit_center: null, reverses: null, reversed_by: null, bill_id: billId, created_by: userEmail, created_at: now });

  await bulkInsert('journal_entries', lines);
  if (replaceDraftId) {
    // UPDATE the draft row in-place to 'posted'. Drafts have no journal entries,
    // so the bulkInsert above is the first time entries are written for this bill_id.
    // We do NOT touch bill_id, company_id, created_at, or created_by — those stay
    // as the original draft's values (preserves audit trail + attachments).
    // The status='draft' guard in the WHERE clause is a safety net: it ensures we
    // only ever promote a draft, never clobber a posted/paid/void row.
    await exec(
      `UPDATE bills SET
         status='posted',
         vendor=@vendor, vendor_ref=@vendor_ref, date=@date, due_date=@due_date,
         amount=@amount, amount_home=@amount_home, currency=@currency, fx_rate=@fx_rate,
         expense_account=@expense_account, ap_account=@ap_account,
         vat_code=@vat_code, vat_amount=@vat_amount, net_amount=@net_amount,
         cost_center=@cost_center, profit_center=@profit_center,
         description=@description, draft_lines=NULL, amount_paid=0
       WHERE bill_id=@bill_id AND company_id=@company_id AND status='draft'`,
      {
        company_id: companyId,
        bill_id: billId,
        vendor: billRow.vendor,
        vendor_ref: billRow.vendor_ref,
        date: billRow.date,
        due_date: billRow.due_date,
        amount: totalDebit,
        amount_home: totalDebit * fxRate,
        currency: billRow.currency,
        fx_rate: billRow.fx_rate,
        expense_account: billRow.expense_account,
        ap_account: billRow.ap_account,
        vat_code: billRow.vat_code,
        vat_amount: totalVatAmount,
        net_amount: totalNetAmount,
        cost_center: billRow.cost_center,
        profit_center: billRow.profit_center,
        description: billRow.description,
      }
    );
  } else {
    await bulkInsert('bills', [{ ...billRow, amount: totalDebit, amount_home: totalDebit * fxRate, vat_amount: totalVatAmount, net_amount: totalNetAmount, status: 'posted', amount_paid: 0 }]);
  }

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
  if (bill.status === 'partial') throw Object.assign(new Error('Cannot void a partially paid bill. To cancel the outstanding balance, post a credit note (DR AP account / CR expense account) for the remaining amount. Payments already made cannot be reversed.'), { code: 'INVALID_STATUS' });
  if (bill.status === 'paid') throw Object.assign(new Error('Cannot void a paid bill — reverse the payment journal first'), { code: 'INVALID_STATUS' });

  if (bill.status === 'posted') {
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

/**
 * bill.payment.record — manual pay-on-bill (P1-9 dual path).
 * Settles through the SAME core as bank-import approve (FX split included).
 * amount is in the BILL's currency; for foreign bills the home-currency bank
 * amount is derived from fxRate (param) or the day's master-data rate.
 */
async function recordBillPayment(ctx) {
  const { companyId, userEmail, body } = ctx;
  const { billId, date, bankAccount, amount, reference = null, fxRate = null } = body;

  const billRows = await query(
    `SELECT * FROM bills WHERE company_id = @companyId AND bill_id = @billId LIMIT 1`,
    { companyId, billId }
  );
  if (billRows.length === 0) throw Object.assign(new Error('Bill not found'), { code: 'NOT_FOUND' });
  const bill = billRows[0];

  if (bill.status === 'draft') throw Object.assign(new Error('Bill is still a draft — post it before recording a payment'), { code: 'INVALID_STATUS' });
  if (bill.status === 'void') throw Object.assign(new Error('Bill is void'), { code: 'INVALID_STATUS' });
  if (bill.status === 'paid') throw Object.assign(new Error('Bill is already fully paid'), { code: 'INVALID_STATUS' });

  const amt = Number(amount);
  if (!(amt > 0)) throw Object.assign(new Error('amount must be greater than zero'), { code: 'VALIDATION' });
  const round4 = (n) => Math.round(n * 10000) / 10000;
  const outstandingBefore = round4(Number(bill.amount) - Number(bill.amount_paid));
  if (amt > outstandingBefore + 0.005) {
    throw Object.assign(new Error(`Amount ${amt} exceeds outstanding ${outstandingBefore} ${bill.currency}`), { code: 'VALIDATION' });
  }

  // Bank account must be an active cash/bank account (cf_category='Cash' is the app-wide marker)
  const acct = await query(
    `SELECT account_code, cf_category FROM accounts WHERE company_id = @companyId AND account_code = @bankAccount AND is_active = true LIMIT 1`,
    { companyId, bankAccount }
  );
  if (acct.length === 0) throw Object.assign(new Error(`Unknown or inactive account: ${bankAccount}`), { code: 'INVALID_ACCOUNT' });
  if (acct[0].cf_category !== 'Cash') {
    throw Object.assign(new Error(`Not a cash/bank account (cf_category must be 'Cash'): ${bankAccount}`), { code: 'INVALID_ACCOUNT' });
  }

  // Period lock — mirrors createBill's server-side enforcement
  const periods = await query(
    `SELECT period_name, start_date, end_date, locked
     FROM (SELECT *, ROW_NUMBER() OVER(PARTITION BY period_name ORDER BY created_at DESC) AS rn
           FROM periods WHERE company_id = @companyId) WHERE rn = 1`,
    { companyId }
  );
  const payDate = new Date(String(date).substring(0, 10));
  const covering = periods.filter((p) => new Date(p.start_date) <= payDate && new Date(p.end_date) >= payDate);
  if (covering.length === 0) {
    throw Object.assign(new Error(`Payment date ${date} does not fall within any defined accounting period`), { code: 'VALIDATION' });
  }
  const locked = covering.filter((p) => p.locked);
  if (locked.length > 0) {
    throw Object.assign(new Error(`Payment date ${date} falls into a locked accounting period (${locked.map((p) => p.period_name).join(', ')})`), { code: 'PERIOD_LOCKED' });
  }

  const companies = await query(
    `SELECT currency FROM companies WHERE company_id = @companyId LIMIT 1`,
    { companyId }
  );
  const homeCurrency = companies[0]?.currency || 'USD';
  const bankJournals = await query(
    `SELECT journal_id FROM journals WHERE company_id = @companyId AND code = 'BANK' AND active = true LIMIT 1`,
    { companyId }
  );
  const journalId = bankJournals[0]?.journal_id || null;

  const isForeign = bill.currency && bill.currency !== homeCurrency;
  let bankAmount;
  let settledForeign = null;
  if (isForeign) {
    settledForeign = amt;
    let rate = fxRate != null ? Number(fxRate) : null;
    if (rate == null) {
      rate = await getRate(bill.currency, homeCurrency, String(date).substring(0, 10));
      if (rate == null) {
        throw Object.assign(new Error(`No FX rate for ${bill.currency} on ${String(date).substring(0, 10)} — add it in Settings → Exchange Rates`), { code: 'VALIDATION' });
      }
    }
    bankAmount = round4(settledForeign * rate);
  } else {
    bankAmount = amt;
  }

  const s = await settleBillPayment({
    companyId, userEmail, billId,
    bankAccount,
    homeCurrency,
    bankAmount,
    date: String(date).substring(0, 10),
    description: `Payment: ${bill.vendor} ${bill.vendor_ref || ''}`.trim(),
    settledForeign,
    method: 'manual',
    source: 'manual_payment',
    journalId,
    paymentReference: reference,
  });

  const newPaid = round4(Number(bill.amount_paid) + (settledForeign ?? bankAmount));
  const out = {
    paymentId: s.paymentId,
    batchId: s.batchId,
    status: s.newStatus,
    amountPaid: newPaid,
    outstanding: round4(Number(bill.amount) - newPaid),
  };
  if (s.warning) out.warning = s.warning;
  return out;
}

/** bill.payments (viewer) — payment history for a bill. */
async function listBillPayments(ctx) {
  const { companyId, body } = ctx;
  const { billId } = body;
  return query(
    `SELECT payment_id, bill_id, batch_id, amount, amount_foreign, date, method, reference, voided_at
     FROM bill_payments WHERE company_id = @companyId AND bill_id = @billId
     ORDER BY date, created_at`,
    { companyId, billId }
  );
}

/**
 * bill.payment.void — unwind a payment (P1-9 safety valve).
 * Reverses the settlement journal batch, decrements amount_paid, restores
 * bill status, and marks the bill_payments row voided (append-only subledger).
 */
async function voidBillPayment(ctx) {
  const { companyId, userEmail, body } = ctx;
  const { paymentId } = body;

  const rows = await query(
    `SELECT * FROM bill_payments WHERE company_id = @companyId AND payment_id = @paymentId LIMIT 1`,
    { companyId, paymentId }
  );
  if (rows.length === 0) throw Object.assign(new Error('Payment not found'), { code: 'NOT_FOUND' });
  const payment = rows[0];
  if (payment.voided_at) throw Object.assign(new Error('Payment already voided'), { code: 'INVALID_STATUS' });

  const billRows = await query(
    `SELECT * FROM bills WHERE company_id = @companyId AND bill_id = @billId LIMIT 1`,
    { companyId, billId: payment.bill_id }
  );
  if (billRows.length === 0) throw Object.assign(new Error('Bill not found'), { code: 'NOT_FOUND' });
  const bill = billRows[0];
  if (bill.status === 'void') throw Object.assign(new Error('Bill is void'), { code: 'INVALID_STATUS' });

  // Reverse the settlement journal (period-lock + double-reverse guards live in journal.reverse)
  const { handleJournal } = require('./journal');
  await handleJournal({ ...ctx, body: { batchId: payment.batch_id } }, 'journal.reverse');

  // amount_paid is tracked in the bill's currency: unwind by the foreign amount when present
  const decrement = Number(payment.amount_foreign != null ? payment.amount_foreign : payment.amount);
  const newPaid = Math.max(0, Math.round((Number(bill.amount_paid) - decrement) * 10000) / 10000);
  const newStatus = newPaid <= 0.005 ? 'posted' : 'partial';
  await exec(
    `UPDATE bills SET amount_paid = @newPaid, status = @newStatus WHERE company_id = @companyId AND bill_id = @billId`,
    { companyId, billId: payment.bill_id, newPaid, newStatus }
  );
  await exec(
    `UPDATE bill_payments SET voided_at = NOW(), voided_by = @voidedBy WHERE company_id = @companyId AND payment_id = @paymentId`,
    { companyId, paymentId, voidedBy: userEmail || 'user' }
  );

  return { voided: true, paymentId, newStatus, amountPaid: newPaid };
}

async function listBills(ctx) {
  const { companyId, body } = ctx;
  const { status, vendor, description, dateFrom, dateTo, limit = 200, offset = 0 } = body;

  let sql = `SELECT * FROM bills WHERE company_id = @companyId`;
  const params = { companyId };

  if (status) { sql += ` AND status = @status`; params.status = status; }
  if (vendor) { sql += ` AND UPPER(vendor) LIKE '%' || UPPER(@vendor) || '%'`; params.vendor = vendor; }
  if (description) { sql += ` AND UPPER(description) LIKE '%' || UPPER(@description) || '%'`; params.description = description; }
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

async function getBillLines(ctx) {
  const { companyId, body } = ctx;
  const { billId } = body;
  if (!billId) throw Object.assign(new Error('billId required'), { code: 'INVALID_INPUT' });
  // For draft bills, return stored draft_lines JSON instead of journal entries
  const billRows = await query(`SELECT status, draft_lines FROM bills WHERE company_id=@companyId AND bill_id=@billId LIMIT 1`, { companyId, billId });
  if (billRows.length === 0) throw Object.assign(new Error('Bill not found'), { code: 'NOT_FOUND' });
  if (billRows[0].status === 'draft') {
    const raw = billRows[0].draft_lines;
    if (!raw) return [];
    try {
      const lines = JSON.parse(raw);
      return lines.map((l, i) => ({
        entry_id: 'draft_' + i,
        account_code: l.expense_account || '',
        account_name: '',
        description: l.description || '',
        amount: l.amount || 0,
        vat_code: l.vat_code || null,
        currency: l.currency || null,
        fx_rate: 1,
        vat_amount_override: (l.vat_amount_override !== null && l.vat_amount_override !== undefined && !isNaN(Number(l.vat_amount_override))) ? Number(l.vat_amount_override) : null,
      }));
    } catch(e) { return []; }
  }
  return query(
    `SELECT je.entry_id, je.account_code, a.account_name, je.description, je.debit as amount, je.vat_code, je.currency, je.fx_rate
     FROM journal_entries je
     LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
     WHERE je.company_id = @companyId AND je.bill_id = @billId AND je.debit > 0
       AND je.account_code != (SELECT ap_account FROM bills WHERE company_id = @companyId AND bill_id = @billId LIMIT 1)
     ORDER BY je.created_at`,
    { companyId, billId }
  );
}

async function getAgingReport(ctx) {
  const { companyId, body } = ctx;
  const { asOfDate, currency } = body;
  const asOf = asOfDate || new Date().toISOString().slice(0, 10);

  let sql = `
    SELECT
      bill_id, vendor, vendor_ref, date, due_date, amount, currency,
      status, amount_paid, ap_account, description,
      COALESCE(amount - amount_paid, amount) AS balance_due,
      CASE
        WHEN due_date IS NULL OR due_date >= @asOf THEN 'current'
        WHEN DATEDIFF('day', due_date::DATE, @asOf::DATE) <= 30 THEN '1_30'
        WHEN DATEDIFF('day', due_date::DATE, @asOf::DATE) <= 60 THEN '31_60'
        WHEN DATEDIFF('day', due_date::DATE, @asOf::DATE) <= 90 THEN '61_90'
        ELSE '90plus'
      END AS bucket,
      CASE WHEN due_date IS NULL THEN 0 ELSE DATEDIFF('day', due_date::DATE, @asOf::DATE) END AS days_overdue
    FROM bills
    WHERE company_id = @companyId
      AND status IN ('posted', 'partial')
  `;
  const params = { companyId, asOf };
  if (currency) { sql += ` AND currency = @currency`; params.currency = currency; }
  sql += ` ORDER BY vendor, due_date`;
  return query(sql, params);
}

async function getBill(ctx) {
  const { companyId, body } = ctx;
  const { billId } = body;
  if (!billId) throw Object.assign(new Error('billId required'), { code: 'INVALID_INPUT' });
  const rows = await query(
    `SELECT * FROM bills WHERE company_id = @companyId AND bill_id = @billId LIMIT 1`,
    { companyId, billId }
  );
  if (!rows.length) throw Object.assign(new Error('Bill not found'), { code: 'NOT_FOUND' });
  return rows[0];
}

async function updateBill(ctx) {
  const { companyId, body } = ctx;
  const { billId, vendor_ref, due_date, description } = body;
  if (!billId) throw Object.assign(new Error('billId required'), { code: 'INVALID_INPUT' });

  const rows = await query(
    `SELECT status FROM bills WHERE company_id = @companyId AND bill_id = @billId LIMIT 1`,
    { companyId, billId }
  );
  if (!rows.length) throw Object.assign(new Error('Bill not found'), { code: 'NOT_FOUND' });
  if (rows[0].status === 'void') throw Object.assign(new Error('Cannot edit a voided bill'), { code: 'INVALID_STATUS' });

  const setParts = [];
  const params = { companyId, billId };
  if (vendor_ref !== undefined) { setParts.push('vendor_ref = @vendor_ref'); params.vendor_ref = vendor_ref || null; }
  if (due_date !== undefined && due_date) { setParts.push('due_date = @due_date'); params.due_date = due_date; }
  if (description !== undefined) { setParts.push('description = @description'); params.description = description || null; }

  if (!setParts.length) return { updated: false, message: 'No fields to update' };

  await exec(
    `UPDATE bills SET ${setParts.join(', ')} WHERE company_id = @companyId AND bill_id = @billId`,
    params
  );
  return { updated: true, billId };
}

async function saveDraftBill(ctx) {
  const { companyId, body } = ctx;
  const { bill } = body;
  if (!bill) throw Object.assign(new Error('bill required'), { code: 'INVALID_INPUT' });
  // vendor and date optional — allows skeleton draft creation on row init

  // Apply company default accounts (same safety net as createBill) so blank
  // expense/ap accounts fall back to settings before hitting NOT NULL constraints.
  const companyDefaults = await getCompanyDefaultAccounts(companyId);
  applyCompanyDefaults(bill, companyDefaults);

  const existing = bill.bill_id
    ? await query(`SELECT bill_id FROM bills WHERE bill_id = @id AND company_id = @cid AND status = 'draft' LIMIT 1`, { id: bill.bill_id, cid: companyId })
    : [];

  const billId = (existing.length && bill.bill_id) ? bill.bill_id : uuid();
  const now = new Date().toISOString();
  // P2-4: draft totals are computed server-side from lines (editor never sends
  // bill.amount); the client value is only a fallback for line-less drafts.
  const totalAmount = (Array.isArray(bill.lines) && bill.lines.length)
    ? bill.lines.reduce((s, l) => s + Number(l.amount || 0), 0)
    : (parseFloat(bill.amount) || 0);

  const billRow = {
    company_id: companyId,
    bill_id: billId,
    vendor: bill.vendor,
    vendor_ref: bill.vendor_ref || null,
    date: bill.date,
    due_date: bill.due_date || bill.date || null,
    amount: totalAmount,
    currency: bill.currency || 'SGD',
    fx_rate: bill.fx_rate || 1.0,
    amount_home: totalAmount * (bill.fx_rate || 1.0),
    expense_account: (bill.lines && bill.lines[0] && bill.lines[0].expense_account) || bill.expense_account || null,
    // Drafts may legitimately have no AP account yet (3-tier defaults allow
    // blank until post). Store '' (satisfies NOT NULL) — validateBill treats
    // blank as missing at post time.
    ap_account: bill.ap_account || '',
    vat_code: null,
    vat_amount: 0,
    net_amount: totalAmount,
    cost_center: bill.cost_center || null,
    profit_center: bill.profit_center || null,
    description: bill.description || null,
    status: 'draft',
    amount_paid: 0,
    draft_lines: bill.lines ? JSON.stringify(bill.lines) : null,
    created_at: now,
    created_by: ctx.userEmail || null,
  };

  if (existing.length) {
    // update existing draft
    await query(
      `UPDATE bills SET vendor=@vendor, vendor_ref=@vendor_ref, date=@date, due_date=@due_date, amount=@amount, currency=@currency, expense_account=@expense_account, ap_account=@ap_account, cost_center=@cost_center, profit_center=@profit_center, description=@description, draft_lines=@draft_lines WHERE bill_id=@bill_id AND company_id=@company_id AND status='draft'`,
      { vendor: billRow.vendor, vendor_ref: billRow.vendor_ref, date: billRow.date, due_date: billRow.due_date, amount: billRow.amount, currency: billRow.currency, expense_account: billRow.expense_account, ap_account: billRow.ap_account, cost_center: billRow.cost_center, profit_center: billRow.profit_center, description: billRow.description, draft_lines: bill.lines ? JSON.stringify(bill.lines) : null, bill_id: billId, company_id: companyId }
    );
  } else {
    await bulkInsert('bills', [billRow]);
  }
  return { billId, status: 'draft' };
}

async function deleteDraftBill(ctx) {
  const { companyId, body } = ctx;
  const { billId } = body;
  if (!billId) throw Object.assign(new Error('billId required'), { code: 'INVALID_INPUT' });

  // Verify the bill exists and is a draft (not posted)
  const rows = await query(
    `SELECT status FROM bills WHERE company_id = @companyId AND bill_id = @billId`,
    { companyId, billId }
  );
  if (rows.length === 0) {
    throw Object.assign(new Error('Bill not found'), { code: 'NOT_FOUND' });
  }
  if (rows[0].status !== 'draft') {
    throw Object.assign(new Error('Only draft bills can be deleted. Use void for posted bills.'), { code: 'INVALID_STATUS' });
  }

  // Delete the draft bill (draft_lines are stored as a column on bills, so one delete suffices)
  await exec(
    `DELETE FROM bills WHERE company_id = @companyId AND bill_id = @billId`,
    { companyId, billId }
  );

  return { deleted: true, billId };
}

async function postDraftBill(ctx) {
  const { companyId, body } = ctx;
  const { billId, bill: overrides } = body;
  if (!billId) throw Object.assign(new Error('billId required'), { code: 'INVALID_INPUT' });

  const rows = await query(`SELECT * FROM bills WHERE bill_id=@id AND company_id=@cid AND status='draft' LIMIT 1`, { id: billId, cid: companyId });
  if (!rows.length) throw Object.assign(new Error('Draft bill not found'), { code: 'NOT_FOUND' });
  const draft = rows[0];

  // Apply any overrides from the post review popup (e.g. updated account codes)
  const bill = { ...draft, ...(overrides || {}) };

  // Resolve lines: prefer stored draft_lines JSON, fall back to single-line from bill row
  let draftLines = null;
  if (draft.draft_lines) {
    try { draftLines = JSON.parse(draft.draft_lines); } catch (e) { draftLines = null; }
  }
  const resolvedLines = (Array.isArray(draftLines) && draftLines.length > 0)
    ? draftLines.map(function (l) {
        return {
          expense_account: l.expense_account,
          amount: Number(l.amount),
          vat_code: l.vat_code || null,
          description: l.description || '',
          vat_amount_override: (l.vat_amount_override !== null && l.vat_amount_override !== undefined && !isNaN(Number(l.vat_amount_override))) ? Number(l.vat_amount_override) : null,
          vat_account_override: l.vat_account_override || null,
          cost_center: l.cost_center || null,
          profit_center: l.profit_center || null,
        };
      })
    : [
        { expense_account: bill.expense_account, amount: bill.amount, vat_code: bill.vat_code || null, description: bill.description || '', vat_amount_override: null, vat_account_override: null },
      ];

  // Overrides from the post review popup (e.g. user-edited lines) take precedence
  const finalLines = (overrides && Array.isArray(overrides.lines) && overrides.lines.length > 0)
    ? overrides.lines
    : resolvedLines;

  // Reuse createBill logic by delegating
  return createBill({
    ...ctx,
    body: {
      bill: {
        vendor: bill.vendor,
        vendor_ref: bill.vendor_ref,
        date: bill.date,
        due_date: bill.due_date,
        // Coerce the DECIMAL-string amount from the draft row; 0 → createBill
        // derives the total from lines instead of failing positivity.
        amount: Number(bill.amount) || 0,
        currency: bill.currency,
        ap_account: bill.ap_account,
        expense_account: bill.expense_account,
        cost_center: bill.cost_center || null,
        profit_center: bill.profit_center || null,
        description: bill.description,
        fx_rate: bill.fx_rate,
        lines: finalLines,
      },
      _replaceDraftId: billId, // signal to createBill to UPDATE the draft row in-place
    }
  });
}


module.exports = { handleBills, listBills, getBillLines };
