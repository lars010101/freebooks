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
const { settleBillPayment, settleMultiBillPayment } = require('./settlement');
const { getRate } = require('./fx');
const { emitEvent } = require('./events');
const { deriveProfitCenter, isDerivationEnabled } = require('./centers');
// computeVatSplit removed — bills now use tax-exclusive direct VAT lookup

// Read company-level default AP and expense account codes from the accounts
// table via the account-level Default flag (default_role column) — the
// successor to the legacy default_ap_account / default_expense_account
// settings keys (settings-ux-spec §7 item 1). Returns { ap: '', expense: '' }
// when no account is flagged (blank fallback). db/schema.sql backfills the
// flag from the legacy settings rows for existing companies.
async function getCompanyDefaultAccounts(companyId) {
  const rows = await query(
    `SELECT default_role, account_code
     FROM accounts
     WHERE company_id = @companyId AND default_role IN ('AP', 'Expense')`,
    { companyId }
  );
  const out = { ap: '', expense: '' };
  for (const r of rows) {
    if (r.default_role === 'AP') out.ap = (r.account_code || '').trim();
    if (r.default_role === 'Expense') out.expense = (r.account_code || '').trim();
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
// The bill-level stated VAT total is always accepted; a warning is emitted when
// |stated - computed| > max(flat, pct * computed), computed = Σ over standard
// (non-reverse-charge) lines. Redesign 2026-07-26.
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
    case 'bill.payment.record': return ctx.body.allocations ? recordMultiBillPayment(ctx) : recordBillPayment(ctx);
    case 'bill.payment.void':   return voidBillPayment(ctx);
    case 'bill.payments':       return listBillPayments(ctx);
    default:
      throw Object.assign(new Error(`Unknown bill action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

async function createBill(ctx) {
  // B1 (agent-readiness-spec §4.5b): when the caller is an agent, bill.create
  // saves a DRAFT (status='draft', no journal entries) instead of posting.
  // The draft enters the inbox as a Class A item; a human posts it via
  // bill.draft.post (the "approve is the post" pattern, §4.1). An agent must
  // never post directly — the catalog role is 'agent' (1.5) and bill.create is
  // in AGENT_ALLOWED, so agents pass the dispatch guard; this handler gate
  // keeps them off the post path. Human callers are unaffected.
  if (ctx.actor && ctx.actor.actorType === 'agent') {
    return saveDraftBill(ctx);
  }
  const { companyId, userEmail, body } = ctx;
  const { bill, payment_batch_id } = body;

  // Replace draft: when _replaceDraftId is set, we promote the draft row to
  // 'posted' via an in-place UPDATE (no DELETE) so the draft's bill_id,
  // created_at, created_by, and any attachments are preserved. See below.
  const replaceDraftId = body._replaceDraftId;

  if (!bill) throw Object.assign(new Error('bill object required'), { code: 'INVALID_INPUT' });

  // ── bills-partner-fk-spec §5: vendor-type guard ──────────────────────
  // If partner_id is present, verify the partner is flagged is_vendor=TRUE.
  // NULL/absent partner_id (free-text or unmatched name) passes through unguarded.
  if (bill.partner_id) {
    const partnerRows = await query(
      `SELECT is_vendor FROM partners WHERE company_id = @companyId AND partner_id = @partnerId LIMIT 1`,
      { companyId, partnerId: bill.partner_id }
    );
    if (partnerRows.length && partnerRows[0].is_vendor === false) {
      throw Object.assign(new Error('Selected partner is not flagged as a vendor'), { code: 'INVALID_PARTNER_TYPE' });
    }
  }

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

  // VAT tolerance settings (used when a bill-level stated VAT total is provided)
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

  // Spec §4b: derive profit_center from cost_center when derivation is enabled.
  if (bill.cost_center && await isDerivationEnabled(companyId)) {
    bill.profit_center = await deriveProfitCenter(companyId, bill.cost_center);
  }

  // When posting a draft, reuse the draft's bill_id (preserves attachments +
  // audit trail). Otherwise mint a fresh id for a direct create+post.
  const billId = replaceDraftId || uuid();
  const now = new Date().toISOString();

  const billRow = {
    company_id: companyId,
    bill_id: billId,
    partner_name: bill.partner_name,
    partner_id: bill.partner_id || null,
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
           partner_name=@partner_name, vendor_ref=@vendor_ref, date=@date, due_date=@due_date,
           amount=@amount, amount_home=@amount_home, currency=@currency, fx_rate=@fx_rate,
           expense_account=@expense_account, ap_account=@ap_account,
           vat_code=@vat_code, vat_amount=@vat_amount, net_amount=@net_amount,
           wht_code=@wht_code, wht_amount=@wht_amount,
           cost_center=@cost_center, profit_center=@profit_center,
           description=@description, draft_lines=NULL
         WHERE bill_id=@bill_id AND company_id=@company_id AND status='draft'`,
        {
          company_id: companyId,
          bill_id: billId,
          partner_name: billRow.partner_name,
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
          wht_code: null,
          wht_amount: 0,
          cost_center: billRow.cost_center,
          profit_center: billRow.profit_center,
          description: billRow.description,
          amount_paid: totalAmount,
        }
      );
    } else {
      await bulkInsert('bills', [{ ...billRow, status: 'paid', amount_paid: totalAmount, wht_code: null, wht_amount: 0 }]);
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
    // A2 (§3.2): a bill_payments row is inserted here (settlement path) →
    // emit bill.payment.recorded. The journal for this payment is owned by
    // the external bank.approve batch (payment_batch_id), not posted here.
    await emitEvent(ctx, 'bill.payment.recorded', 'payment', billId, {
      billId,
      amount: totalAmount,
      currency,
      method: 'bank_match',
      date: bill.date,
      status: 'paid',
    });
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
  const desc = [bill.partner_name, bill.vendor_ref, bill.description].filter(Boolean).join(' / ');

  // One DR line per expense line. VAT is accumulated per VAT code and posted
  // as GROUPED tax lines after the loop (redesign 2026-07-26: computed-only
  // line tax, bill-level stated VAT, one tax journal line per code).
  const stdTaxByCode = {}; // standard code -> { account, computed, net }
  const rcTaxByCode = {};  // reverse-charge code -> { inputAccount, outputAccount, computed, net }
  const whtByCode = {};    // wht code -> { account, computed, net }
  for (const expLine of expenseLines) {
    const lineAmount = Number(expLine.amount || 0);
    const lineNet = lineAmount; // tax-exclusive — the user entered the net amount
    if (expLine.vat_code && company.vat_registered) {
      const vatRows = await query(
        `SELECT rate, vat_account_input, vat_account_output, is_reverse_charge
         FROM vat_codes WHERE company_id = @companyId AND vat_code = @vatCode AND is_active = true LIMIT 1`,
        { companyId, vatCode: expLine.vat_code }
      );
      if (vatRows.length > 0) {
        const vc = vatRows[0];
        const expectedVat = Math.round(lineAmount * Number(vc.rate) * 100) / 100;
        if (vc.is_reverse_charge) {
          const b = rcTaxByCode[expLine.vat_code] || (rcTaxByCode[expLine.vat_code] = { inputAccount: vc.vat_account_input, outputAccount: vc.vat_account_output, computed: 0, net: 0 });
          b.computed += expectedVat;
          b.net += lineNet;
        } else {
          const b = stdTaxByCode[expLine.vat_code] || (stdTaxByCode[expLine.vat_code] = { account: vc.vat_account_input, computed: 0, net: 0 });
          b.computed += expectedVat;
          b.net += lineNet;
        }
      }
    }
    if (expLine.wht_code) {
      const whtRows = await query(
        `SELECT rate, wht_account FROM wht_codes WHERE company_id = @companyId AND wht_code = @whtCode AND is_active = true LIMIT 1`,
        { companyId, whtCode: expLine.wht_code }
      );
      if (whtRows.length > 0) {
        const wc = whtRows[0];
        const expectedWht = Math.round(lineNet * Number(wc.rate) * 100) / 100;
        const b = whtByCode[expLine.wht_code] || (whtByCode[expLine.wht_code] = { account: wc.wht_account, computed: 0, net: 0 });
        b.computed += expectedWht;
        b.net += lineNet;
      } else {
        validation.warnings.push(`WHT code ${expLine.wht_code} not found or inactive — line posted without withholding`);
      }
    }
    const lineDesc = expLine.description ? `${desc} / ${expLine.description}` : desc;
    lines.push({ company_id: companyId, entry_id: uuid(), batch_id: batchId, date: bill.date, account_code: expLine.expense_account, debit: lineNet, credit: 0, currency, fx_rate: fxRate, debit_home: lineNet * fxRate, credit_home: 0, vat_code: null, vat_amount: 0, vat_amount_home: 0, net_amount: lineNet, net_amount_home: lineNet * fxRate, description: lineDesc, reference: apRef, source: 'manual', cost_center: expLine.cost_center || bill.cost_center || null, profit_center: expLine.profit_center || bill.profit_center || null, reverses: null, reversed_by: null, bill_id: billId, created_by: userEmail, created_at: now });
  }

  // ── P2-3: write bill_lines subledger (expense lines only) ──
  const round4 = (n) => Math.round(n * 10000) / 10000;
  const billLineRows = expenseLines.map((expLine, i) => {
    const lineAmount = Number(expLine.amount || 0);
    return {
      company_id: companyId,
      bill_id: billId,
      line_number: i + 1,
      expense_account: expLine.expense_account,
      amount: lineAmount,
      amount_home: round4(lineAmount * fxRate),
      vat_code: expLine.vat_code || null,
      description: expLine.description || null,
      cost_center: expLine.cost_center || bill.cost_center || null,
      profit_center: expLine.profit_center || bill.profit_center || null,
      wht_code: expLine.wht_code || null,
      created_at: now,
    };
  });

  // Bill-level supplier-stated VAT (redesign 2026-07-26) — the only override
  // surface. Compared against Σ computed over standard (non-RC) codes; the
  // delta lands on the largest computed tax line. RC lines never absorb it.
  const computedStdTotal = Math.round(Object.values(stdTaxByCode).reduce((s, b) => s + b.computed, 0) * 100) / 100;
  const _statedRaw = bill.vat_amount_stated;
  const statedVat = (_statedRaw !== null && _statedRaw !== undefined && _statedRaw !== '' && !isNaN(Number(_statedRaw))) ? Number(_statedRaw) : null;
  if (statedVat !== null) {
    const eligible = Object.keys(stdTaxByCode).filter((c) => stdTaxByCode[c].computed > 0);
    if (eligible.length === 0) {
      validation.warnings.push('Stated VAT ignored — no taxable (non-reverse-charge) lines on this bill; check VAT codes');
    } else {
      const diff = Math.abs(statedVat - computedStdTotal);
      const tol = Math.max(vatTolerance.flat, computedStdTotal * vatTolerance.pct);
      if (diff > tol) {
        validation.warnings.push(`Stated VAT ${statedVat.toFixed(2)} differs from computed ${computedStdTotal.toFixed(2)} by ${diff.toFixed(2)} — verify supplier invoice`);
      }
      const largest = eligible.reduce((a, b) => (stdTaxByCode[a].computed >= stdTaxByCode[b].computed ? a : b));
      stdTaxByCode[largest].computed += Math.round((statedVat - computedStdTotal) * 100) / 100;
    }
  }

  // Grouped tax lines: one DR per standard VAT code; RC pairs per RC code.
  // Zero-amount tax rows are not written (a zero-rated code produces no row).
  let totalStdVat = 0;
  let totalRcVat = 0;
  for (const code of Object.keys(stdTaxByCode)) {
    const b = stdTaxByCode[code];
    const amt = Math.round(b.computed * 100) / 100;
    if (amt === 0) continue;
    totalStdVat += amt;
    lines.push({ company_id: companyId, entry_id: uuid(), batch_id: batchId, date: bill.date, account_code: b.account, debit: amt, credit: 0, currency, fx_rate: fxRate, debit_home: amt * fxRate, credit_home: 0, vat_code: code, vat_amount: amt, vat_amount_home: amt * fxRate, net_amount: b.net, net_amount_home: b.net * fxRate, description: `GST Input: ${bill.partner_name}`, reference: apRef, source: 'manual', cost_center: null, profit_center: null, reverses: null, reversed_by: null, bill_id: billId, created_by: userEmail, created_at: now });
  }
  for (const code of Object.keys(rcTaxByCode)) {
    const b = rcTaxByCode[code];
    const amt = Math.round(b.computed * 100) / 100;
    if (amt === 0) continue;
    totalRcVat += amt;
    lines.push({ company_id: companyId, entry_id: uuid(), batch_id: batchId, date: bill.date, account_code: b.inputAccount, debit: amt, credit: 0, currency, fx_rate: fxRate, debit_home: amt * fxRate, credit_home: 0, vat_code: code, vat_amount: amt, vat_amount_home: amt * fxRate, net_amount: b.net, net_amount_home: b.net * fxRate, description: `Input VAT RC: ${bill.partner_name}`, reference: apRef, source: 'manual', cost_center: null, profit_center: null, reverses: null, reversed_by: null, bill_id: billId, created_by: userEmail, created_at: now });
    lines.push({ company_id: companyId, entry_id: uuid(), batch_id: batchId, date: bill.date, account_code: b.outputAccount, debit: 0, credit: amt, currency, fx_rate: fxRate, debit_home: 0, credit_home: amt * fxRate, vat_code: code, vat_amount: amt, vat_amount_home: amt * fxRate, net_amount: 0, net_amount_home: 0, description: `Output VAT RC: ${bill.partner_name}`, reference: apRef, source: 'manual', cost_center: null, profit_center: null, reverses: null, reversed_by: null, bill_id: billId, created_by: userEmail, created_at: now });
  }

  // Totals for the AP credit and the bill record. AP owes net + standard VAT
  // only: reverse-charge VAT is self-assessed (its DR/CR pair nets to zero
  // inside the journal) and is never owed to the partner. bills.vat_amount
  // counts DR tax rows only (standard incl. stated delta + RC input).
  const totalNetAmount = lines.filter(l => l.net_amount > 0 && !l.vat_code).reduce((s, l) => s + Number(l.net_amount || 0), 0) || totalAmount;
  const totalVatAmount = totalStdVat + totalRcVat;
  const totalDebit = totalNetAmount + totalStdVat;

  // WHT credit lines: one CR per WHT code (mirrors the grouped VAT pattern).
  // The AP credit below is reduced by the total withheld so the journal still
  // balances: net + std VAT = DR expense/std-VAT = CR AP + CR WHT payable.
  let totalWht = 0;
  for (const code of Object.keys(whtByCode)) {
    const b = whtByCode[code];
    const amt = Math.round(b.computed * 100) / 100;
    if (amt === 0) continue;
    totalWht += amt;
    lines.push({ company_id: companyId, entry_id: uuid(), batch_id: batchId, date: bill.date, account_code: b.account, debit: 0, credit: amt, currency, fx_rate: fxRate, debit_home: 0, credit_home: amt * fxRate, wht_code: code, wht_amount: amt, wht_amount_home: amt * fxRate, vat_code: null, vat_amount: 0, vat_amount_home: 0, net_amount: 0, net_amount_home: 0, description: `WHT Payable: ${bill.partner_name}`, reference: apRef, source: 'manual', cost_center: null, profit_center: null, reverses: null, reversed_by: null, bill_id: billId, created_by: userEmail, created_at: now });
  }

  const totalAp = totalDebit - totalWht;

  // Single CR AP line for total (net + VAT − WHT)
  lines.push({ company_id: companyId, entry_id: uuid(), batch_id: batchId, date: bill.date, account_code: bill.ap_account, debit: 0, credit: totalAp, currency, fx_rate: fxRate, debit_home: 0, credit_home: totalAp * fxRate, vat_code: null, vat_amount: 0, vat_amount_home: 0, net_amount: 0, net_amount_home: 0, description: `AP: ${desc}`, reference: apRef, source: 'manual', cost_center: null, profit_center: null, reverses: null, reversed_by: null, bill_id: billId, created_by: userEmail, created_at: now });

  await bulkInsert('journal_entries', lines);
  await bulkInsert('bill_lines', billLineRows);  // P2-3
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
         partner_name=@partner_name, vendor_ref=@vendor_ref, date=@date, due_date=@due_date,
         amount=@amount, amount_home=@amount_home, currency=@currency, fx_rate=@fx_rate,
         expense_account=@expense_account, ap_account=@ap_account,
         vat_code=@vat_code, vat_amount=@vat_amount, net_amount=@net_amount,
         wht_code=@wht_code, wht_amount=@wht_amount,
         cost_center=@cost_center, profit_center=@profit_center,
         description=@description, draft_lines=NULL, amount_paid=0
       WHERE bill_id=@bill_id AND company_id=@company_id AND status='draft'`,
      {
        company_id: companyId,
        bill_id: billId,
        partner_name: billRow.partner_name,
        vendor_ref: billRow.vendor_ref,
        date: billRow.date,
        due_date: billRow.due_date,
        amount: totalAp,
        amount_home: totalAp * fxRate,
        currency: billRow.currency,
        fx_rate: billRow.fx_rate,
        expense_account: billRow.expense_account,
        ap_account: billRow.ap_account,
        vat_code: billRow.vat_code,
        vat_amount: totalVatAmount,
        net_amount: totalNetAmount,
        wht_code: expenseLines[0].wht_code || null,
        wht_amount: totalWht,
        cost_center: billRow.cost_center,
        profit_center: billRow.profit_center,
        description: billRow.description,
      }
    );
  } else {
    await bulkInsert('bills', [{ ...billRow, amount: totalAp, amount_home: totalAp * fxRate, vat_amount: totalVatAmount, net_amount: totalNetAmount, wht_code: expenseLines[0].wht_code || null, wht_amount: totalWht, status: 'posted', amount_paid: 0 }]);
  }

  // A2 (§3.2): emit bill.posted on the draft→posted transition. The
  // payment_batch_id branch above creates the bill as 'paid' via an external
  // bank batch (no journal posted here) and emits bill.payment.recorded
  // instead; this branch posts the bill's own AP journal → bill.posted.
  await emitEvent(ctx, 'bill.posted', 'bill', billId, {
    partner_name: bill.partner_name,
    date: bill.date,
    amount: totalAp,
    currency,
    status: 'posted',
    batchId,
    lineCount: lines.length,
  });

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
      try {
        await handleJournal({ ...ctx, body: { batchId: entry.batch_id } }, 'journal.reverse');
      } catch (e) {
        // Payment-void reversals share the bill_id tag: a bill whose payment
        // was voided returns to 'posted', and this loop would otherwise
        // double-reverse that batch and fail the whole void.
        if (e && e.code === 'ALREADY_REVERSED') continue;
        throw e;
      }
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
 * validateBillForPayment — shared per-bill validation for the single-bill
 * (recordBillPayment) and multi-bill (settleMultiBillPayment) payment paths.
 * Loads the bill via queryFn (ambient query by default, or a transaction-
 * scoped query for the atomic multi-bill path), enforces the status/amount/
 * outstanding checks, and returns the validated bill + outstanding + isForeign
 * flag. Throws NOT_FOUND / INVALID_STATUS / VALIDATION on failure.
 *
 * homeCurrency is optional — when omitted it is resolved inside via queryFn
 * (one extra round-trip). Callers that already have it pass it in to avoid
 * the lookup (recordBillPayment resolves it once for its shared checks).
 */
async function validateBillForPayment(companyId, billId, allocAmount, queryFn, homeCurrency) {
  const q = queryFn || query;
  const billRows = await q(
    `SELECT * FROM bills WHERE company_id = @companyId AND bill_id = @billId LIMIT 1`,
    { companyId, billId }
  );
  if (!billRows || billRows.length === 0) {
    throw Object.assign(new Error('Bill not found'), { code: 'NOT_FOUND' });
  }
  const bill = billRows[0];

  if (bill.status === 'draft') {
    throw Object.assign(new Error('Bill is still a draft — post it before recording a payment'), { code: 'INVALID_STATUS' });
  }
  if (bill.status === 'void') {
    throw Object.assign(new Error('Bill is void'), { code: 'INVALID_STATUS' });
  }
  if (bill.status === 'paid') {
    throw Object.assign(new Error('Bill is already fully paid'), { code: 'INVALID_STATUS' });
  }

  const amt = Number(allocAmount);
  if (!(amt > 0)) {
    throw Object.assign(new Error('amount must be greater than zero'), { code: 'VALIDATION' });
  }
  const round4 = (n) => Math.round(n * 10000) / 10000;
  const outstanding = round4(Number(bill.amount) - Number(bill.amount_paid));
  if (amt > outstanding + 0.005) {
    throw Object.assign(new Error(`Amount ${amt} exceeds outstanding ${outstanding} ${bill.currency}`), { code: 'VALIDATION' });
  }

  let hc = homeCurrency;
  if (!hc) {
    const co = await q(`SELECT currency FROM companies WHERE company_id = @companyId LIMIT 1`, { companyId });
    hc = (co && co[0] && co[0].currency) || 'USD';
  }
  return { bill, outstanding, isForeign: !!(bill.currency && bill.currency !== hc) };
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

  // Per-bill validation (shared with the multi-bill path).
  const { bill } = await validateBillForPayment(companyId, billId, amount, query, homeCurrency);
  const round4 = (n) => Math.round(n * 10000) / 10000;

  const isForeign = bill.currency && bill.currency !== homeCurrency;
  let bankAmount;
  let settledForeign = null;
  if (isForeign) {
    settledForeign = Number(amount);
    let rate = fxRate != null ? Number(fxRate) : null;
    if (rate == null) {
      rate = await getRate(bill.currency, homeCurrency, String(date).substring(0, 10));
      if (rate == null) {
        throw Object.assign(new Error(`No FX rate for ${bill.currency} on ${String(date).substring(0, 10)} — add it in Settings → Exchange Rates`), { code: 'VALIDATION' });
      }
    }
    bankAmount = round4(settledForeign * rate);
  } else {
    bankAmount = Number(amount);
  }

  const s = await settleBillPayment({
    ctx,
    companyId, userEmail, billId,
    bankAccount,
    homeCurrency,
    bankAmount,
    date: String(date).substring(0, 10),
    description: `Payment: ${bill.partner_name} ${bill.vendor_ref || ''}`.trim(),
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

/**
 * bill.payment.record (multi-bill branch) — settle one bank payment across
 * N bills from the same vendor in the same currency (issue #131). Dispatched
 * from handleBills when body.allocations is present. Delegates the atomic
 * settlement to settleMultiBillPayment (settlement.js) which runs inside a
 * withTransaction wrapper. Resolves homeCurrency + journalId the same way
 * recordBillPayment does (shared pre-transaction reads).
 */
async function recordMultiBillPayment(ctx) {
  const { companyId, userEmail, body } = ctx;
  const { date, bankAccount, allocations, reference = null, fxRate = null } = body;

  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw Object.assign(new Error('allocations must be a non-empty array'), { code: 'VALIDATION' });
  }
  for (const a of allocations) {
    if (!a.billId || !(Number(a.amount) > 0)) {
      throw Object.assign(new Error('each allocation needs billId and amount > 0'), { code: 'VALIDATION' });
    }
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

  const result = await settleMultiBillPayment({
    ctx,
    companyId,
    userEmail,
    date: String(date).substring(0, 10),
    bankAccount,
    homeCurrency,
    allocations,
    fxRate,
    paymentReference: reference,
    journalId,
  });

  return result;
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

  // Detect multi-bill payment: a batch_id shared by >1 non-voided bill_payments rows.
  const siblings = await query(
    `SELECT payment_id, bill_id, amount, amount_foreign FROM bill_payments
     WHERE company_id = @companyId AND batch_id = @batchId AND voided_at IS NULL`,
    { companyId, batchId: payment.batch_id }
  );
  const isMulti = siblings.length > 1;

  // Reverse the settlement journal (period-lock + double-reverse guards live in journal.reverse).
  // journal.reverse is batch-level — one call reverses the entire multi-bill journal batch.
  const { handleJournal } = require('./journal');
  await handleJournal({ ...ctx, body: { batchId: payment.batch_id } }, 'journal.reverse');

  if (isMulti) {
    // Multi-bill void: reverse the whole batch, then restore every sibling bill.
    const voidedPayments = [];
    for (const sib of siblings) {
      const billRows = await query(
        `SELECT * FROM bills WHERE company_id = @companyId AND bill_id = @billId LIMIT 1`,
        { companyId, billId: sib.bill_id }
      );
      if (billRows.length === 0) continue; // bill gone — skip (best effort)
      const sibBill = billRows[0];
      // amount_paid tracked in bill currency: unwind by the foreign amount when present
      const decrement = Number(sib.amount_foreign != null ? sib.amount_foreign : sib.amount);
      const newPaid = Math.max(0, Math.round((Number(sibBill.amount_paid) - decrement) * 10000) / 10000);
      const newStatus = newPaid <= 0.005 ? 'posted' : 'partial';
      await exec(
        `UPDATE bills SET amount_paid = @newPaid, status = @newStatus WHERE company_id = @companyId AND bill_id = @billId`,
        { companyId, billId: sib.bill_id, newPaid, newStatus }
      );
      await exec(
        `UPDATE bill_payments SET voided_at = NOW(), voided_by = @voidedBy WHERE company_id = @companyId AND payment_id = @paymentId`,
        { companyId, paymentId: sib.payment_id, voidedBy: userEmail || 'user' }
      );

      await emitEvent(ctx, 'bill.payment.voided', 'payment', sib.payment_id, {
        billId: sib.bill_id,
        amount: Number(sib.amount_foreign != null ? sib.amount_foreign : sib.amount),
        newStatus,
        amountPaid: newPaid,
      });
      voidedPayments.push({ paymentId: sib.payment_id, billId: sib.bill_id, newStatus, amountPaid: newPaid });
    }
    return { voided: true, paymentIds: voidedPayments.map((v) => v.paymentId), payments: voidedPayments };
  }

  // ── Single-bill void (existing path) ──
  const billRows = await query(
    `SELECT * FROM bills WHERE company_id = @companyId AND bill_id = @billId LIMIT 1`,
    { companyId, billId: payment.bill_id }
  );
  if (billRows.length === 0) throw Object.assign(new Error('Bill not found'), { code: 'NOT_FOUND' });
  const bill = billRows[0];
  if (bill.status === 'void') throw Object.assign(new Error('Bill is void'), { code: 'INVALID_STATUS' });

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

  // A2 (§3.2): emit bill.payment.voided. Reverses the settlement journal,
  // decrements amount_paid, restores bill status (all done above).
  await emitEvent(ctx, 'bill.payment.voided', 'payment', paymentId, {
    billId: payment.bill_id,
    amount: Number(payment.amount_foreign != null ? payment.amount_foreign : payment.amount),
    newStatus,
    amountPaid: newPaid,
  });

  return { voided: true, paymentId, newStatus, amountPaid: newPaid };
}

async function listBills(ctx) {
  const { companyId, body } = ctx;
  const { status, partner_name, description, dateFrom, dateTo, threshold } = body;

  if (threshold == null) {
    throw Object.assign(new Error('threshold required'), { code: 'INVALID_INPUT' });
  }

  let where = ` WHERE company_id = @companyId`;
  const params = { companyId };

  if (status) { where += ` AND status = @status`; params.status = status; }
  if (partner_name) { where += ` AND UPPER(partner_name) LIKE '%' || UPPER(@partner_name) || '%'`; params.partner_name = partner_name; }
  if (description) { where += ` AND UPPER(description) LIKE '%' || UPPER(@description) || '%'`; params.description = description; }
  if (dateFrom) { where += ` AND date >= @dateFrom`; params.dateFrom = dateFrom; }
  if (dateTo) { where += ` AND date <= @dateTo`; params.dateTo = dateTo; }

  // Step 1: cheap COUNT — avoids materializing the full row set on the over-threshold path
  const countRow = await query(`SELECT COUNT(*) AS _total FROM bills` + where, params);
  const total = countRow[0]._total;

  if (total > threshold) {
    return { data: [], total, tooMany: true };
  }

  // Step 2: only fetch rows when under threshold — no LIMIT, the date range + threshold are the bounds
  const rows = await query(`SELECT * FROM bills` + where + ` ORDER BY date DESC, created_at DESC`, params);
  return { data: rows, total };
}

async function matchBill(ctx) {
  const { companyId, body } = ctx;
  const { amount, currency, partner_name, date } = body;
  if (!amount) throw Object.assign(new Error('amount required'), { code: 'INVALID_INPUT' });

  let sql = `SELECT bill_id, partner_name, vendor_ref, date, due_date, amount, currency, status, amount_paid, ap_account, description
             FROM bills
             WHERE company_id = @companyId
               AND status IN ('posted', 'partial')
               AND ABS(amount - @amount) < 0.01`;
  const params = { companyId, amount: Number(amount) };

  if (partner_name) { sql += ` AND UPPER(partner_name) LIKE '%' || UPPER(@partner_name) || '%'`; params.partner_name = partner_name; }
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
  // Posted/partial/paid/void: read from bill_lines subledger (P2-3)
  return query(
    `SELECT
       CAST(bl.line_number AS VARCHAR) AS entry_id,
       bl.expense_account AS account_code,
       a.account_name,
       bl.description,
       bl.amount,
       bl.vat_code,
       b.currency,
       b.fx_rate,
       bl.amount_home
     FROM bill_lines bl
     JOIN bills b ON b.company_id = bl.company_id AND b.bill_id = bl.bill_id
     LEFT JOIN accounts a ON a.company_id = bl.company_id AND a.account_code = bl.expense_account
     WHERE bl.company_id = @companyId AND bl.bill_id = @billId
     ORDER BY bl.line_number`,
    { companyId, billId }
  );
}

async function getAgingReport(ctx) {
  const { companyId, body } = ctx;
  const { asOfDate, currency } = body;
  const asOf = asOfDate || new Date().toISOString().slice(0, 10);

  let sql = `
    SELECT
      bill_id, partner_name, vendor_ref, date, due_date, amount, currency,
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
  sql += ` ORDER BY partner_name, due_date`;
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
  // partner_name and date optional — allows skeleton draft creation on row init

  // ── bills-partner-fk-spec §5: vendor-type guard (same as createBill) ──
  if (bill.partner_id) {
    const partnerRows = await query(
      `SELECT is_vendor FROM partners WHERE company_id = @companyId AND partner_id = @partnerId LIMIT 1`,
      { companyId, partnerId: bill.partner_id }
    );
    if (partnerRows.length && partnerRows[0].is_vendor === false) {
      throw Object.assign(new Error('Selected partner is not flagged as a vendor'), { code: 'INVALID_PARTNER_TYPE' });
    }
  }

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
  // The total is GROSS (net + VAT) so the parent row matches the live editor
  // total. VAT per line is always computed (amount × rate from vat_codes) —
  // the only override surface is the bill-level stated VAT total (redesign
  // 2026-07-26). Reverse-charge VAT is self-assessed and never owed to the
  // partner, so it is NOT part of the bill gross.
  let totalAmount;
  let statedForDraft = null;
  if (Array.isArray(bill.lines) && bill.lines.length) {
    // Build a rate/RC cache for the VAT codes referenced by the lines.
    const seenCodes = Array.from(new Set(
      bill.lines.map(l => (l && l.vat_code ? String(l.vat_code).trim() : '')).filter(Boolean)
    ));
    const rateCache = {}; // code -> { rate, rc }
    if (seenCodes.length) {
      const placeholders = seenCodes.map((_, i) => `@vc${i}`).join(',');
      const params = { companyId };
      seenCodes.forEach((c, i) => { params[`vc${i}`] = c; });
      const rateRows = await query(
        `SELECT vat_code, rate, is_reverse_charge FROM vat_codes WHERE company_id = @companyId AND vat_code IN (${placeholders}) AND is_active = true`,
        params
      );
      for (const r of rateRows) rateCache[r.vat_code] = { rate: Number(r.rate), rc: !!r.is_reverse_charge };
    }
    const seenWhtCodes = Array.from(new Set(
      bill.lines.map(l => (l && l.wht_code ? String(l.wht_code).trim() : '')).filter(Boolean)
    ));
    const whtRateCache = {};
    if (seenWhtCodes.length) {
      const wPlaceholders = seenWhtCodes.map((_, i) => `@wc${i}`).join(',');
      const wParams = { companyId };
      seenWhtCodes.forEach((c, i) => { wParams[`wc${i}`] = c; });
      const whtRateRows = await query(
        `SELECT wht_code, rate FROM wht_codes WHERE company_id = @companyId AND wht_code IN (${wPlaceholders}) AND is_active = true`,
        wParams
      );
      for (const r of whtRateRows) whtRateCache[r.wht_code] = Number(r.rate);
    }
    let netTotal = 0, stdComputed = 0, legacyStatedSum = 0, sawLegacyOverride = false, whtTotal = 0;
    for (const l of bill.lines) {
      const amt = Number(l.amount || 0);
      netTotal += amt;
      const wcode = (l && l.wht_code ? String(l.wht_code).trim() : '');
      if (wcode && whtRateCache[wcode] != null) {
        whtTotal += Math.round(amt * whtRateCache[wcode] * 100) / 100;
      }
      const code = (l && l.vat_code ? String(l.vat_code).trim() : '');
      const info = code ? rateCache[code] : undefined;
      const computed = info ? Math.round(amt * info.rate * 100) / 100 : 0;
      if (info && info.rc) continue; // RC: self-assessed, always computed, never stated
      stdComputed += computed;
      const ov = l.vat_amount_override;
      if (ov !== null && ov !== undefined && ov !== '' && !isNaN(Number(ov))) {
        legacyStatedSum += Number(ov);
        sawLegacyOverride = true;
      } else {
        legacyStatedSum += computed;
      }
    }
    // Bill-level stated VAT: the explicit field wins; otherwise lift legacy
    // per-line overrides (pre-2026-07-26 drafts) so they are not silently lost.
    const raw = bill.vat_amount_stated;
    if (raw !== null && raw !== undefined && raw !== '' && !isNaN(Number(raw))) {
      statedForDraft = Number(raw);
    } else if (sawLegacyOverride && Math.round((legacyStatedSum - stdComputed) * 100) / 100 !== 0) {
      statedForDraft = Math.round(legacyStatedSum * 100) / 100;
    }
    // Stated VAT only counts toward gross when taxable (non-RC) lines exist —
    // mirrors createBill, which ignores stated otherwise (with a warning).
    totalAmount = netTotal + ((statedForDraft !== null && stdComputed > 0) ? statedForDraft : stdComputed) - whtTotal;
  } else {
    totalAmount = parseFloat(bill.amount) || 0;
  }

  // Spec §4b: derive profit_center from cost_center when derivation is enabled.
  if (bill.cost_center && await isDerivationEnabled(companyId)) {
    bill.profit_center = await deriveProfitCenter(companyId, bill.cost_center);
  }

  const billRow = {
    company_id: companyId,
    bill_id: billId,
    partner_name: bill.partner_name,
    partner_id: bill.partner_id || null,
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
    vat_amount: statedForDraft !== null ? statedForDraft : 0, // drafts: holds the bill-level stated VAT total (0 = none)
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
      `UPDATE bills SET partner_name=@partner_name, partner_id=@partner_id, vendor_ref=@vendor_ref, date=@date, due_date=@due_date, amount=@amount, currency=@currency, expense_account=@expense_account, ap_account=@ap_account, vat_amount=@vat_amount, cost_center=@cost_center, profit_center=@profit_center, description=@description, draft_lines=@draft_lines WHERE bill_id=@bill_id AND company_id=@company_id AND status='draft'`,
      { partner_name: billRow.partner_name, partner_id: billRow.partner_id, vendor_ref: billRow.vendor_ref, date: billRow.date, due_date: billRow.due_date, amount: billRow.amount, currency: billRow.currency, expense_account: billRow.expense_account, ap_account: billRow.ap_account, vat_amount: billRow.vat_amount, cost_center: billRow.cost_center, profit_center: billRow.profit_center, description: billRow.description, draft_lines: bill.lines ? JSON.stringify(bill.lines) : null, bill_id: billId, company_id: companyId }
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
          cost_center: l.cost_center || null,
          profit_center: l.profit_center || null,
          wht_code: l.wht_code || null,
        };
      })
    : [
        { expense_account: bill.expense_account, amount: bill.amount, vat_code: bill.vat_code || null, description: bill.description || '' },
      ];

  // Overrides from the post review popup (e.g. user-edited lines) take precedence
  const finalLines = (overrides && Array.isArray(overrides.lines) && overrides.lines.length > 0)
    ? overrides.lines
    : resolvedLines;

  // Bill-level stated VAT (redesign 2026-07-26). Precedence: explicit value
  // from the post popup → value stored on the draft row at save time
  // (bills.vat_amount holds the stated total for drafts; 0 = none) → lift
  // legacy per-line overrides from pre-redesign draft JSON so the
  // supplier-stated total is not silently lost.
  let statedForPost = null;
  const _rawStated = overrides && overrides.vat_amount_stated;
  if (_rawStated !== null && _rawStated !== undefined && _rawStated !== '' && !isNaN(Number(_rawStated))) {
    statedForPost = Number(_rawStated);
  } else if (Number(draft.vat_amount) > 0) {
    statedForPost = Number(draft.vat_amount);
  } else if (Array.isArray(draftLines) && draftLines.some(l => l && l.vat_amount_override !== null && l.vat_amount_override !== undefined && !isNaN(Number(l.vat_amount_override)))) {
    const _codes = Array.from(new Set(draftLines.map(l => (l && l.vat_code ? String(l.vat_code).trim() : '')).filter(Boolean)));
    const _info = {};
    if (_codes.length) {
      const _ph = _codes.map((_, i) => `@c${i}`).join(',');
      const _params = { companyId };
      _codes.forEach((c, i) => { _params[`c${i}`] = c; });
      const _rows = await query(`SELECT vat_code, rate, is_reverse_charge FROM vat_codes WHERE company_id = @companyId AND vat_code IN (${_ph}) AND is_active = true`, _params);
      for (const r of _rows) _info[r.vat_code] = { rate: Number(r.rate), rc: !!r.is_reverse_charge };
    }
    let _lifted = 0, _computedStd = 0;
    for (const l of draftLines) {
      const _amt = Number(l.amount || 0);
      const _ci = l.vat_code ? _info[String(l.vat_code).trim()] : undefined;
      if (_ci && _ci.rc) continue; // RC overrides were always ignored (read-only)
      const _computed = _ci ? Math.round(_amt * _ci.rate * 100) / 100 : 0;
      _computedStd += _computed;
      const _ov = l.vat_amount_override;
      _lifted += (_ov !== null && _ov !== undefined && !isNaN(Number(_ov))) ? Number(_ov) : _computed;
    }
    if (Math.round((_lifted - _computedStd) * 100) / 100 !== 0) statedForPost = Math.round(_lifted * 100) / 100;
  }

  // Reuse createBill logic by delegating
  return createBill({
    ...ctx,
    body: {
      bill: {
        partner_name: bill.partner_name,
        partner_id: bill.partner_id || null,
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
        vat_amount_stated: statedForPost,
      },
      _replaceDraftId: billId, // signal to createBill to UPDATE the draft row in-place
    }
  });
}


module.exports = { handleBills, listBills, getBillLines, validateBillForPayment };
