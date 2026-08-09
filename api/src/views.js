'use strict';
/**
 * freeBooks — Read models (P1-8)
 *
 * Page-shaped read endpoints: one action call returns everything a screen
 * needs at load. Commands stay on the action-RPC command path (idempotent,
 * audited); these are pure reads (role viewer, no audit, no idempotency).
 *
 * Rationale: pages previously assembled view models client-side — bills page
 * fanned out to partner.list + bill.list + bill.lines per unfold; bank page to
 * accounts + journals + reconciliation + balances. Server-side joins kill the
 * N+1 HTTP round-trips and give derived data a home. Reuses the exact list
 * logic from the command modules (exported for this purpose) so read models
 * can never drift from command behavior.
 *
 * Consumed by: contract tests now; pages migrate onto these in P1-4/P1-3.
 */

const { query } = require('./db');
const { listBills, getBillLines } = require('./bills');
const { listReconcile } = require('./bank');
const { listPartners } = require('./partners');

async function handleViews(ctx, action) {
  switch (action) {
    case 'view.bills': return viewBills(ctx);
    case 'view.bank':  return viewBank(ctx);
    default:
      throw Object.assign(new Error(`Unknown view action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

/**
 * Payables Bills tab in one call: vendors + bills with embedded lines.
 * Draft lines come from draft_lines JSON (parsed, same shape as bill.lines);
 * posted lines from journal entries. Lines are fetched per bill server-side
 * (DuckDB-local, no HTTP fan-out) — batch-optimize only if profiling says so.
 */
async function viewBills(ctx) {
  const { companyId, body } = ctx;
  const [vendors, bills] = await Promise.all([
    listPartners({ companyId }),
    listBills({ companyId, body }),
  ]);
  const billsWithLines = [];
  for (const b of bills) {
    const lines = await getBillLines({ companyId, body: { billId: b.bill_id } });
    billsWithLines.push({ ...b, lines });
  }
  return { vendors, bills: billsWithLines };
}

/**
 * Bank tab in one call: cash accounts + journals, and when accountCode is
 * given, the reconciliation view (rows + openingBalance) for that account.
 */
async function viewBank(ctx) {
  const { companyId, body } = ctx;
  const { accountCode, dateFrom, dateTo } = body;
  const [accounts, journals] = await Promise.all([
    query(
      `SELECT account_code, account_name FROM accounts
       WHERE company_id = @companyId AND cf_category = 'Cash' ORDER BY account_code`,
      { companyId }
    ),
    query(
      `SELECT journal_id, code, name FROM journals
       WHERE company_id = @companyId AND active ORDER BY code`,
      { companyId }
    ),
  ]);
  const reconciliation = accountCode
    ? await listReconcile({ companyId, body: { accountCode, dateFrom, dateTo } })
    : null;
  return { accounts, journals, reconciliation };
}

module.exports = { handleViews };
