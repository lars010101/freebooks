'use strict';
/**
 * freeBooks — Bill payment settlement core (P1-9)
 *
 * Single settlement path shared by bank-import approve (method 'bank_match')
 * and manual pay-on-bill (method 'manual'). Posts the settlement journal
 * (2-line DR AP / CR bank, or 3-line with FX gain/loss split under the
 * booking-rate method — IAS 21), updates bills.amount_paid + status, and
 * writes the bill_payments subledger row.
 *
 * Extracted from approveBankEntries (bank.js) — import outcomes are mirrored
 * branch-for-branch; do not diverge the two paths.
 */

const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert } = require('./db');
const { getNextReference } = require('./journal');
const { emitEvent } = require('./events');

const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * @param {object} opts
 * @param {string} opts.companyId
 * @param {string} [opts.userEmail]
 * @param {string} opts.billId
 * @param {string} opts.bankAccount        - bank/cash account code (credit leg for outflows)
 * @param {string} opts.homeCurrency
 * @param {number} opts.bankAmount         - amount in HOME currency that hit the bank
 * @param {string} opts.date               - payment date (YYYY-MM-DD)
 * @param {string|null} [opts.reference]   - pre-allocated journal reference (import batch allocation)
 * @param {string} [opts.description]
 * @param {number|null} [opts.settledForeign] - amount in BILL currency (foreign bills; null = home bill)
 * @param {number|null} [opts.billPayRate] - booking-rate override (mirrors import's entry.billPayRate)
 * @param {string} opts.method             - 'bank_match' | 'manual'
 * @param {string} opts.source             - journal source tag: 'bank_import' | 'manual_payment'
 * @param {string|null} [opts.journalId]   - BANK journal id (used to allocate a reference when reference is null)
 * @param {string|null} [opts.paymentReference] - user-supplied payment reference (bill_payments.reference)
 * @param {string} [opts.currency]         - journal currency for the plain 2-line path (mirrors import's entry.currency; default home)
 * @param {number} [opts.fxRate]           - journal fx_rate for the plain 2-line path (mirrors import's entry.fxRate; default 1.0)
 * @returns {Promise<{batchId, paymentId, newStatus, fxDiff?, settledForeign?, settledBooked?, warning?}>}
 */
async function settleBillPayment(opts) {
  const {
    ctx, companyId, userEmail, billId, bankAccount, homeCurrency,
    date, description = '', method, source, journalId = null,
    paymentReference = null,
  } = opts;
  const bankAmount = Math.abs(Number(opts.bankAmount));
  const batchId = uuid();
  const paymentId = uuid();
  const now = new Date().toISOString();

  const billRows = await query(
    `SELECT amount, amount_home, amount_paid, currency, fx_rate, ap_account FROM bills
     WHERE company_id = @companyId AND bill_id = @billId LIMIT 1`,
    { companyId, billId }
  );
  const bill = billRows[0];
  if (!bill) throw Object.assign(new Error('Bill not found'), { code: 'NOT_FOUND' });

  // Journal reference: use the pre-allocated one, else allocate from the BANK journal
  let reference = opts.reference || null;
  if (!reference && journalId) {
    const yr = parseInt(String(date).substring(0, 4), 10);
    reference = await getNextReference(companyId, journalId, yr);
  }

  // FX gain/loss account (default_role on accounts, mirrors bank.js)
  const fxRows = await query(
    `SELECT account_code FROM accounts WHERE company_id = @companyId AND default_role = 'FX Gain/Loss' AND is_active = true LIMIT 1`,
    { companyId }
  );
  const fxAccount = fxRows[0]?.account_code || null;

  const mkRow = (line) => ({
    company_id: companyId,
    entry_id: uuid(),
    batch_id: batchId,
    date,
    account_code: line.account_code,
    debit: line.debit || 0,
    credit: line.credit || 0,
    currency: line.currency,
    fx_rate: line.fx_rate,
    debit_home: line.debit_home,
    credit_home: line.credit_home,
    vat_code: null,
    vat_amount: 0,
    vat_amount_home: 0,
    net_amount: 0,
    net_amount_home: 0,
    description: line.description || description,
    reference,
    source,
    cost_center: null,
    profit_center: null,
    reverses: null,
    reversed_by: null,
    bill_id: billId,
    created_by: userEmail,
    created_at: now,
  });

  const result = { batchId, paymentId };
  const isForeign = bill.currency && bill.currency !== homeCurrency && opts.settledForeign != null;

  if (isForeign) {
    // Booking-rate method (IAS 21): AP cleared at the bill's booked rate;
    // FX gain/loss absorbs the remainder. amount_paid tracked in foreign currency.
    const settledForeign = Number(opts.settledForeign);
    const bookingRate = opts.billPayRate ? Number(opts.billPayRate) : (Number(bill.fx_rate) || 1);
    const settledBooked = round4(settledForeign * bookingRate);
    const fxDiff = round4(bankAmount - settledBooked);
    // fxDiff > 0 = loss (paid more home than booked), fxDiff < 0 = gain

    if (fxAccount && Math.abs(fxDiff) > 0.005) {
      // 3-line FX journal — all home currency (mirrors import's replacement journal)
      const fxLines = [
        { account_code: bill.ap_account, debit: settledBooked, credit: 0, description },
        { account_code: fxAccount, debit: fxDiff > 0 ? fxDiff : 0, credit: fxDiff < 0 ? Math.abs(fxDiff) : 0, description: 'FX ' + (fxDiff > 0 ? 'loss' : 'gain') + ': ' + bill.currency + ' payment' },
        { account_code: bankAccount, debit: 0, credit: bankAmount, description },
      ];
      await bulkInsert('journal_entries', fxLines.map((l) => mkRow({
        ...l, currency: homeCurrency, fx_rate: 1.0, debit_home: l.debit, credit_home: l.credit,
      })));
    } else {
      // Negligible diff, or no FX account configured: plain 2-line at the bank amount
      // (mirrors the import's surviving generic post; warning surfaced when the diff is real)
      await bulkInsert('journal_entries', [
        mkRow({ account_code: bill.ap_account, debit: bankAmount, credit: 0, currency: opts.currency || homeCurrency, fx_rate: opts.fxRate || 1.0, debit_home: bankAmount * (opts.fxRate || 1.0), credit_home: 0, description }),
        mkRow({ account_code: bankAccount, debit: 0, credit: bankAmount, currency: opts.currency || homeCurrency, fx_rate: opts.fxRate || 1.0, debit_home: 0, credit_home: bankAmount * (opts.fxRate || 1.0), description }),
      ]);
      if (!fxAccount && Math.abs(fxDiff) > 0.005) {
        result.warning = 'FX diff ' + Math.abs(fxDiff).toFixed(2) + ' ' + homeCurrency + ' not posted — configure FX Gain/Loss account in Settings → Company';
      }
    }

    const newAmountPaid = Number(bill.amount_paid) + settledForeign;
    const newStatus = newAmountPaid >= Number(bill.amount) ? 'paid' : 'partial';
    await exec(
      `UPDATE bills SET amount_paid = @newAmountPaid, status = @newStatus WHERE company_id = @companyId AND bill_id = @billId`,
      { companyId, billId, newAmountPaid, newStatus }
    );

    await bulkInsert('bill_payments', [{
      company_id: companyId, payment_id: paymentId, bill_id: billId,
      batch_id: batchId, amount: bankAmount, amount_foreign: settledForeign,
      date, method, reference: paymentReference, created_at: now,
    }]);

    result.newStatus = newStatus;
    result.fxDiff = fxDiff;
    result.settledForeign = settledForeign;
    result.settledBooked = settledBooked;
    // A2 (§3.2): emit bill.payment.recorded. Covers the foreign-currency
    // settlement path (manual pay-on-bill + bank import approve share this
    // core — P1-9 dual path, do not diverge).
    await emitEvent(ctx, 'bill.payment.recorded', 'payment', paymentId, {
      billId, amount: settledForeign, currency: bill.currency,
      method, date, status: newStatus, fxRate: bookingRate,
    });
    return result;
  }

  // Home-currency bill — plain 2-line settlement
  await bulkInsert('journal_entries', [
    mkRow({ account_code: bill.ap_account, debit: bankAmount, credit: 0, currency: opts.currency || homeCurrency, fx_rate: opts.fxRate || 1.0, debit_home: bankAmount * (opts.fxRate || 1.0), credit_home: 0, description }),
    mkRow({ account_code: bankAccount, debit: 0, credit: bankAmount, currency: opts.currency || homeCurrency, fx_rate: opts.fxRate || 1.0, debit_home: 0, credit_home: bankAmount * (opts.fxRate || 1.0), description }),
  ]);

  const newAmountPaid = Number(bill.amount_paid) + bankAmount;
  const newStatus = newAmountPaid >= Number(bill.amount_home) - 0.005 ? 'paid' : 'partial';
  await exec(
    `UPDATE bills SET amount_paid = @newAmountPaid, status = @newStatus WHERE company_id = @companyId AND bill_id = @billId`,
    { companyId, billId, newAmountPaid, newStatus }
  );

  await bulkInsert('bill_payments', [{
    company_id: companyId, payment_id: paymentId, bill_id: billId,
    batch_id: batchId, amount: bankAmount, amount_foreign: null,
    date, method, reference: paymentReference, created_at: now,
  }]);

  result.newStatus = newStatus;
  // A2 (§3.2): emit bill.payment.recorded. Home-currency settlement path
  // (manual pay-on-bill + bank import approve share this core).
  await emitEvent(ctx, 'bill.payment.recorded', 'payment', paymentId, {
    billId, amount: bankAmount, currency: bill.currency,
    method, date, status: newStatus,
  });
  return result;
}

module.exports = { settleBillPayment };
