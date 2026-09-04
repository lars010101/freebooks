'use strict';
/**
 * freeBooks — Bill payment settlement core (P1-9)
 *
 * Single settlement path shared by bank-import approve (method 'bank_match')
 * and manual pay-on-bill (method 'manual'). Posts the settlement journal
 * (2-line DR AP / CR bank, or 3-line with FX gain/loss split under the
 * booking-rate method — IAS 21), updates bills.amount_paid + status, and
 * writes the payments subledger row.
 *
 * Extracted from approveBankEntries (bank.js) — import outcomes are mirrored
 * branch-for-branch; do not diverge the two paths.
 */

const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert, withTransaction } = require('./db');
const { getNextReference } = require('./journal');
const { emitEvent } = require('./events');
const { getRate } = require('./fx');

const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * applyBillSettlement — the non-journal-posting tail shared by every
 * settlement path (bank-match-bill-settlement-spec.md §3): apply an
 * already-computed amount_paid/status to `bills`, and insert the matching
 * `payments` subledger row. Never touches `journal_entries` and never
 * emits events — callers own their own journal-posting and event-emission
 * exactly as before (see the deadlock note on `settleMultiBillPayment`:
 * emitEvent must not run inside a withTransaction connection).
 *
 * Deliberately takes `newAmountPaid`/`newStatus` as inputs rather than
 * deriving them: the three existing call sites this replaces use three
 * subtly different threshold formulas (bill.amount vs bill.amount_home,
 * with/without a 0.005 epsilon) — pre-existing, not something this
 * extraction should silently unify. Each caller keeps computing its own
 * threshold exactly as before; this helper only applies the result.
 *
 * @param {object} opts
 * @param {string} opts.companyId
 * @param {string} opts.billId
 * @param {number} opts.newAmountPaid
 * @param {string} opts.newStatus        - 'paid' | 'partial'
 * @param {number} opts.bankAmount       - payments.amount (home/bank currency)
 * @param {number|null} [opts.amountForeign] - payments.amount_foreign (null for home-currency bills)
 * @param {string} opts.batchId
 * @param {string} opts.date
 * @param {string} opts.method           - 'manual' | 'bank_match'
 * @param {string|null} [opts.paymentReference]
 * @param {string} [opts.paymentId]      - reuse a pre-generated id (single-bill path); generated if omitted
 * @param {{exec:Function, bulkInsert:Function}} [opts.db] - defaults to the ambient module-level exec/bulkInsert; pass {exec: tx.exec, bulkInsert: tx.bulkInsert} to run inside settleMultiBillPayment's transaction
 * @returns {{paymentId, newStatus, amountPaid}}
 */
async function applyBillSettlement(opts) {
  const {
    companyId, billId, newAmountPaid, newStatus, bankAmount,
    amountForeign = null, batchId, date, method, paymentReference = null,
  } = opts;
  const db = opts.db || { exec, bulkInsert };
  const paymentId = opts.paymentId || uuid();
  const now = new Date().toISOString();

  await db.exec(
    `UPDATE bills SET amount_paid = @newAmountPaid, status = @newStatus WHERE company_id = @companyId AND bill_id = @billId`,
    { companyId, billId, newAmountPaid, newStatus }
  );
  await db.bulkInsert('payments', [{
    company_id: companyId, payment_id: paymentId, bill_id: billId,
    batch_id: batchId, amount: bankAmount, amount_foreign: amountForeign,
    date, method, reference: paymentReference, created_at: now,
  }]);

  return { paymentId, newStatus, amountPaid: newAmountPaid };
}

/**
 * buildAllocationLines — shared per-bill FX line builder for the single-bill
 * (settleBillPayment) and multi-bill (settleMultiBillPayment) settlement
 * paths. Computes the AP debit line (at the bill's booking rate), the
 * optional FX gain/loss line, and the bank-currency share for this
 * allocation under the booking-rate method (IAS 21).
 *
 * @param {object} opts
 * @param {object} opts.bill           - bill row (needs ap_account, fx_rate, currency)
 * @param {number} opts.allocAmount    - amount in BILL currency
 * @param {number} opts.bankRate       - payment-date rate (bill ccy → home)
 * @param {string|null} opts.fxAccount - FX gain/loss account code (null = no FX line)
 * @param {string} opts.homeCurrency
 * @returns {{apLine, fxLine|null, bankShare, fxDiff, settledForeign, settledBooked}}
 */
function buildAllocationLines({ bill, allocAmount, bankRate, fxAccount, homeCurrency, bookingRateOverride }) {
  const settledForeign = Number(allocAmount);
  const isForeign = !!(bill.currency && bill.currency !== homeCurrency);
  const bookingRate = isForeign
    ? (bookingRateOverride != null ? Number(bookingRateOverride) : (Number(bill.fx_rate) || 1))
    : 1;
  const settledBooked = round4(settledForeign * bookingRate);
  const bankShare = round4(settledForeign * Number(bankRate));
  const fxDiff = round4(bankShare - settledBooked);

  const apLine = isForeign
    ? { account_code: bill.ap_account, debit: settledBooked, credit: 0 }
    : { account_code: bill.ap_account, debit: allocAmount, credit: 0 };

  let fxLine = null;
  if (fxAccount && Math.abs(fxDiff) > 0.005) {
    fxLine = {
      account_code: fxAccount,
      debit: fxDiff > 0 ? fxDiff : 0,
      credit: fxDiff < 0 ? Math.abs(fxDiff) : 0,
      description: 'FX ' + (fxDiff > 0 ? 'loss' : 'gain') + ': ' + bill.currency + ' payment',
    };
  }

  return { apLine, fxLine, bankShare, fxDiff, settledForeign, settledBooked };
}

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
 * @param {string|null} [opts.paymentReference] - user-supplied payment reference (payments.reference)
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
    const bankRate = settledForeign > 0 ? (bankAmount / settledForeign) : 1;
    const alloc = buildAllocationLines({
      bill, allocAmount: settledForeign, bankRate, fxAccount, homeCurrency,
      bookingRateOverride: opts.billPayRate,
    });
    const { settledBooked, fxDiff } = alloc;

    if (alloc.fxLine) {
      // 3-line FX journal — all home currency (mirrors import's replacement journal)
      const fxLines = [
        { ...alloc.apLine, description },
        alloc.fxLine,
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
    await applyBillSettlement({
      companyId, billId, newAmountPaid, newStatus, bankAmount,
      amountForeign: settledForeign, batchId, date, method, paymentReference, paymentId,
    });

    result.newStatus = newStatus;
    result.fxDiff = fxDiff;
    result.settledForeign = settledForeign;
    result.settledBooked = settledBooked;
    // A2 (§3.2): emit payment.recorded. Covers the foreign-currency
    // settlement path (manual pay-on-bill + bank import approve share this
    // core — P1-9 dual path, do not diverge).
    await emitEvent(ctx, 'payment.recorded', 'payment', paymentId, {
      billId, amount: settledForeign, currency: bill.currency,
      method, date, status: newStatus, fxRate: opts.billPayRate ? Number(opts.billPayRate) : (Number(bill.fx_rate) || 1),
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
  await applyBillSettlement({
    companyId, billId, newAmountPaid, newStatus, bankAmount,
    amountForeign: null, batchId, date, method, paymentReference, paymentId,
  });

  result.newStatus = newStatus;
  // A2 (§3.2): emit payment.recorded. Home-currency settlement path
  // (manual pay-on-bill + bank import approve share this core).
  await emitEvent(ctx, 'payment.recorded', 'payment', paymentId, {
    billId, amount: bankAmount, currency: bill.currency,
    method, date, status: newStatus,
  });
  return result;
}

/**
 * settleMultiBillPayment — settle one bank payment across N bills from the
 * same vendor in the same currency, atomically (issue #131). Runs inside a
 * withTransaction wrapper so a validation failure on any bill rolls back all
 * bill updates, journal entries, and payments rows.
 *
 * Same-currency + same-vendor only (Phase 1, server-validated). Each bill's
 * FX gain/loss is computed independently via buildAllocationLines (each bill
 * has its own booking rate from bill.fx_rate). One journal batch, N
 * payments rows sharing a batch_id, one CR Bank line for the total.
 *
 * Events (payment.recorded) are emitted AFTER the transaction commits —
 * emitEvent uses the ambient shared connection and must not run inside the
 * dedicated transaction connection (DuckDB single-writer would deadlock).
 */
async function settleMultiBillPayment(opts) {
  const {
    ctx, companyId, userEmail, date, bankAccount, homeCurrency,
    reference, allocations, fxRate, paymentReference, journalId,
  } = opts;

  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw Object.assign(new Error('allocations must be a non-empty array'), { code: 'VALIDATION' });
  }
  for (const a of allocations) {
    if (!a.billId || !(Number(a.amount) > 0)) {
      throw Object.assign(new Error('each allocation needs billId and amount > 0'), { code: 'VALIDATION' });
    }
  }

  const batchId = uuid();
  const now = new Date().toISOString();
  const round4 = (n) => Math.round(n * 10000) / 10000;
  const payDate = String(date).substring(0, 10);

  // Pre-allocate the journal reference OUTSIDE the transaction — getNextReference
  // uses the ambient shared connection (writes to journal_sequences) and would
  // deadlock against the transaction's dedicated connection (DuckDB single-writer).
  let ref = reference || null;
  if (!ref && journalId) {
    const yr = parseInt(payDate.substring(0, 4), 10);
    ref = await getNextReference(companyId, journalId, yr);
  }

  // Resolve the payment-date FX rate OUTSIDE the transaction (getRate uses the
  // ambient connection). Load the first bill's currency to know if this is foreign.
  const firstBillRows = await query(
    `SELECT currency FROM bills WHERE company_id = @companyId AND bill_id = @billId LIMIT 1`,
    { companyId, billId: allocations[0].billId }
  );
  const billCurrency = (firstBillRows[0] && firstBillRows[0].currency) || homeCurrency;
  const isForeign = billCurrency !== homeCurrency;
  let bankRate = 1;
  if (isForeign) {
    bankRate = fxRate != null ? Number(fxRate) : await getRate(billCurrency, homeCurrency, payDate);
    if (bankRate == null) {
      throw Object.assign(new Error(`No FX rate for ${billCurrency} on ${payDate} — add it in Settings → Exchange Rates`), { code: 'VALIDATION' });
    }
  }

  // Lazy require to avoid circular dependency (bills.js → settlement.js → bills.js).
  const { validateBillForPayment } = require('./bills');

  // ── Transaction: all writes + atomicity-critical reads ──
  const txResult = await withTransaction(async (tx) => {
    // Load FX gain/loss account (scoped read)
    const fxRows = await tx.query(
      `SELECT account_code FROM accounts WHERE company_id = @companyId AND default_role = 'FX Gain/Loss' AND is_active = true LIMIT 1`,
      { companyId }
    );
    const fxAccount = (fxRows[0] && fxRows[0].account_code) || null;

    // Bank account validity (scoped read, done once)
    const acct = await tx.query(
      `SELECT account_code, cf_category FROM accounts WHERE company_id = @companyId AND account_code = @bankAccount AND is_active = true LIMIT 1`,
      { companyId, bankAccount }
    );
    if (!acct.length) throw Object.assign(new Error(`Unknown or inactive account: ${bankAccount}`), { code: 'INVALID_ACCOUNT' });
    if (acct[0].cf_category !== 'Cash') {
      throw Object.assign(new Error(`Not a cash/bank account (cf_category must be 'Cash'): ${bankAccount}`), { code: 'INVALID_ACCOUNT' });
    }

    // Period lock (scoped read, done once)
    const periods = await tx.query(
      `SELECT period_name, start_date, end_date, locked
       FROM (SELECT *, ROW_NUMBER() OVER(PARTITION BY period_name ORDER BY created_at DESC) AS rn
             FROM periods WHERE company_id = @companyId) WHERE rn = 1`,
      { companyId }
    );
    const payDateObj = new Date(payDate);
    const covering = periods.filter((p) => new Date(p.start_date) <= payDateObj && new Date(p.end_date) >= payDateObj);
    if (covering.length === 0) {
      throw Object.assign(new Error(`Payment date ${date} does not fall within any defined accounting period`), { code: 'VALIDATION' });
    }
    const lockedPeriods = covering.filter((p) => p.locked);
    if (lockedPeriods.length > 0) {
      throw Object.assign(new Error(`Payment date ${date} falls into a locked accounting period (${lockedPeriods.map((p) => p.period_name).join(', ')})`), { code: 'PERIOD_LOCKED' });
    }

    // Per-allocation validation (scoped query — atomicity-critical)
    const validated = [];
    for (const alloc of allocations) {
      const v = await validateBillForPayment(companyId, alloc.billId, alloc.amount, tx.query, homeCurrency);
      validated.push({ bill: v.bill, outstanding: v.outstanding, alloc });
    }

    // All bills same currency
    const currencies = new Set(validated.map((v) => v.bill.currency));
    if (currencies.size > 1) {
      throw Object.assign(new Error('All bills in a multi-bill payment must be the same currency'), { code: 'VALIDATION' });
    }
    // All bills same vendor (case-insensitive)
    const partners = new Set(validated.map((v) => (v.bill.partner_name || '').toLowerCase()));
    if (partners.size > 1) {
      throw Object.assign(new Error('All bills in a multi-bill payment must be from the same vendor'), { code: 'VALIDATION' });
    }

    // ── Build journal lines ──
    const mkRow = (line) => ({
      company_id: companyId,
      entry_id: uuid(),
      batch_id: batchId,
      date: payDate,
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
      description: line.description || `Multi-bill payment: ${validated[0].bill.partner_name || ''}`,
      reference: ref,
      source: 'manual_payment',
      cost_center: null,
      profit_center: null,
      reverses: null,
      reversed_by: null,
      bill_id: line.bill_id || null,
      created_by: userEmail,
      created_at: now,
    });

    const journalLines = [];
    const results = [];
    const paymentIds = [];
    let totalBankShare = 0;

    for (const { bill, alloc } of validated) {
      const allocResult = buildAllocationLines({
        bill, allocAmount: alloc.amount, bankRate, fxAccount, homeCurrency,
      });
      totalBankShare = round4(totalBankShare + allocResult.bankShare);

      // AP debit line (tagged with bill_id)
      journalLines.push(mkRow({
        ...allocResult.apLine,
        bill_id: bill.bill_id,
        currency: isForeign ? homeCurrency : bill.currency,
        fx_rate: 1.0,
        debit_home: allocResult.apLine.debit,
        credit_home: allocResult.apLine.credit,
      }));

      // FX gain/loss line (tagged with bill_id)
      if (allocResult.fxLine) {
        journalLines.push(mkRow({
          ...allocResult.fxLine,
          bill_id: bill.bill_id,
          currency: homeCurrency,
          fx_rate: 1.0,
          debit_home: allocResult.fxLine.debit,
          credit_home: allocResult.fxLine.credit,
        }));
      }

      // Update bill amount_paid + status, insert payments (scoped to
      // the transaction's own connection via tx.exec/tx.bulkInsert).
      const newAmountPaid = round4(Number(bill.amount_paid) + allocResult.settledForeign);
      const newStatus = newAmountPaid >= Number(bill.amount) - 0.005 ? 'paid' : 'partial';
      const settled = await applyBillSettlement({
        companyId, billId: bill.bill_id, newAmountPaid, newStatus,
        bankAmount: allocResult.bankShare, amountForeign: isForeign ? allocResult.settledForeign : null,
        batchId, date: payDate, method: 'manual', paymentReference,
        db: { exec: tx.exec, bulkInsert: tx.bulkInsert },
      });
      paymentIds.push(settled.paymentId);

      results.push({
        billId: bill.bill_id,
        newStatus,
        amountPaid: newAmountPaid,
        outstanding: round4(Number(bill.amount) - newAmountPaid),
      });
    }

    // One CR Bank line for the total (bill_id = null)
    journalLines.push(mkRow({
      account_code: bankAccount,
      debit: 0,
      credit: totalBankShare,
      bill_id: null,
      currency: isForeign ? homeCurrency : billCurrency,
      fx_rate: 1.0,
      debit_home: 0,
      credit_home: totalBankShare,
    }));

    // Insert journal entries (payments rows were already inserted
    // per-bill above, via applyBillSettlement).
    await tx.bulkInsert('journal_entries', journalLines);

    return { results, paymentIds, validatedBills: validated.map((v) => v.bill) };
  });

  // ── Emit events AFTER the transaction commits ──
  // emitEvent writes via the ambient shared connection — must not run inside
  // the dedicated transaction connection (DuckDB single-writer would deadlock).
  const { results, paymentIds, validatedBills } = txResult;
  for (let i = 0; i < results.length; i++) {
    await emitEvent(ctx, 'payment.recorded', 'payment', paymentIds[i], {
      billId: results[i].billId,
      amount: Number(allocations[i].amount),
      currency: validatedBills[i].currency,
      method: 'manual',
      date: payDate,
      status: results[i].newStatus,
    });
  }

  return { batchId, paymentIds, results };
}

module.exports = { settleBillPayment, settleMultiBillPayment, buildAllocationLines, applyBillSettlement };
