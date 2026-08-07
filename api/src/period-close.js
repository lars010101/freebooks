'use strict';
/**
 * freeBooks — period.close handler (P2-1).
 * Posts a summary year-end closing entry: P&L net → closing account → RE account.
 * Jurisdiction-pack driven (closingConfigFor). Not a line-by-line zeroing.
 */
const { query, bulkInsert } = require('./db');
const { auditLog } = require('./audit');
const { emitEvent } = require('./events');
const { closingConfigFor } = require('./jurisdiction-packs');
const { v4: uuid } = require('uuid');

async function handleClose(ctx) {
  const { companyId, userEmail, body } = ctx;
  if (!body.periodId) throw Object.assign(new Error('periodId required'), { code: 'INVALID_INPUT' });

  // 1. Load company to get jurisdiction
  const coRows = await query(
    `SELECT jurisdiction FROM companies WHERE company_id = @companyId ORDER BY created_at DESC LIMIT 1`,
    { companyId }
  );
  if (!coRows.length) throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });
  const jurisdiction = coRows[0].jurisdiction || 'SE';

  // 2. Load closing config from pack
  const closing = closingConfigFor(jurisdiction);
  if (!closing || closing.required !== true) {
    return { closed: false, reason: 'Closing not required for jurisdiction ' + jurisdiction };
  }
  const closingAccount = closing.closingAccount;
  const reAccount = closing.retainedEarningsAccount;
  if (!closingAccount || !reAccount) {
    throw Object.assign(new Error('Pack closing config missing account codes'), { code: 'INVALID_INPUT' });
  }

  // 3. Resolve period (latest version, same pattern as period.close_check)
  const periodRows = await query(
    `SELECT period_name, start_date, end_date FROM (
       SELECT *, ROW_NUMBER() OVER(PARTITION BY period_name ORDER BY created_at DESC) AS rn
       FROM periods WHERE company_id = @companyId AND period_name = @pid
     ) WHERE rn = 1`,
    { companyId, pid: body.periodId }
  );
  if (!periodRows.length) throw Object.assign(new Error(`Period '${body.periodId}' not found`), { code: 'NOT_FOUND' });
  const period = periodRows[0];
  const s = String(period.start_date).slice(0, 10);
  const e = String(period.end_date).slice(0, 10);

  // 4. Guard: check for existing close batch on period end date involving closing account
  const existing = await query(
    `SELECT DISTINCT batch_id FROM journal_entries
     WHERE company_id = @companyId
       AND date = @endDate
       AND account_code = @closingAcct
       AND reversed_by IS NULL`,
    { companyId, endDate: e, closingAcct: closingAccount }
  );
  if (existing.length > 0) {
    return { closed: true, already: true, batchId: existing[0].batch_id };
  }

  // 5. Compute P&L net for the period
  const plRows = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN a.account_type = 'Revenue' THEN je.credit_home - je.debit_home ELSE 0 END), 0) -
       COALESCE(SUM(CASE WHEN a.account_type IN ('Expense', 'Cost of Sales') THEN je.debit_home - je.credit_home ELSE 0 END), 0) AS pl_net
     FROM journal_entries je
     JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
     WHERE je.company_id = @companyId
       AND je.date BETWEEN @start AND @end
       AND a.account_type IN ('Revenue', 'Expense', 'Cost of Sales')`,
    { companyId, start: s, end: e }
  );
  const plNet = Number(plRows[0].pl_net || 0);

  // 6. If zero P&L, no entry needed
  if (Math.abs(plNet) < 0.005) {
    await auditLog(companyId, 'period', body.periodId, 'period.close', userEmail, null);
    return { closed: true, periodId: body.periodId, net: 0, message: 'P&L is zero, no closing entry needed' };
  }

  // 7. Post balanced journal batch
  const batchId = uuid();
  const now = new Date().toISOString();
  const isProfit = plNet > 0;
  const amount = Math.abs(plNet);
  const baseLine = {
    company_id: companyId, batch_id: batchId, date: e, currency: '',
    fx_rate: 1.0, vat_code: null, vat_amount: 0, vat_amount_home: 0,
    net_amount: 0, net_amount_home: 0, source: 'period_close',
    cost_center: null, profit_center: null, reverses: null, reversed_by: null,
    bill_id: null, created_by: userEmail, created_at: now
  };

  // For profit: D closingAccount (zero the closing acct), C reAccount (result to RE)
  // For loss: C closingAccount, D reAccount
  const lines = [
    { ...baseLine, entry_id: uuid(), account_code: closingAccount,
      debit: isProfit ? amount : 0, credit: isProfit ? 0 : amount,
      debit_home: isProfit ? amount : 0, credit_home: isProfit ? 0 : amount,
      description: 'Year-end close: P&L net to closing', reference: 'CLOSE/' + body.periodId },
    { ...baseLine, entry_id: uuid(), account_code: reAccount,
      debit: isProfit ? 0 : amount, credit: isProfit ? amount : 0,
      debit_home: isProfit ? 0 : amount, credit_home: isProfit ? amount : 0,
      description: 'Year-end close: result to retained earnings', reference: 'CLOSE/' + body.periodId },
  ];

  // Set currency from company
  const coCur = await query(`SELECT currency FROM companies WHERE company_id = @companyId ORDER BY created_at DESC LIMIT 1`, { companyId });
  if (coCur.length) lines.forEach(l => l.currency = coCur[0].currency);

  await bulkInsert('journal_entries', lines);

  // 8. Audit + event
  await auditLog(companyId, 'period', body.periodId, 'period.close', userEmail, null);
  await emitEvent(ctx, 'period.closed', 'period', body.periodId, { periodId: body.periodId, net: plNet, batchId, closedAt: now });

  return { closed: true, periodId: body.periodId, net: plNet, batchId };
}

module.exports = { handleClose };
