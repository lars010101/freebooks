'use strict';
/**
 * freeBooks — Bills-due scanner
 *
 * Server job: on startup + every FREEBOOKS_BILLS_DUE_SCAN_MS (default daily —
 * due dates don't move hour to hour). Same shape as reminder-scanner.js: a
 * producer into the notifications table.
 *
 * Replaces the Inbox's former 'bills' filter view (§10.7 item 4): a bill_due
 * item carries no in-place decision, only a "go look" verb (o = open in
 * Payables) — that's a notification, not an approval queue item. Links
 * straight to the bill's read-only detail page (/:company/bill/:id, already
 * used as a deep-link target by documents.js and bank-payments.js) rather
 * than the bare Payables list, so the bell takes you to the specific bill.
 *
 * Dedupe: one open notification per bill (issue_key = bill-due:<company>:
 * <bill_id>). No status suffix — a bill escalating from "due" to "overdue"
 * does not force a fresh notification; it re-raises once the existing one
 * is marked read and the bill is still outstanding on the next scan. This
 * matches fx-gap's dedupe model (a persisting condition, not a graduated
 * severity) — a deliberate choice for consistency, not an oversight.
 */

const { query } = require('./db');
const { raiseNotification } = require('./notifications');

const SCAN_MS = parseInt(process.env.FREEBOOKS_BILLS_DUE_SCAN_MS || (24 * 60 * 60 * 1000), 10);

/**
 * Run one scan cycle. Called on boot and on the interval timer.
 * Never throws — failures are logged, not fatal.
 */
async function runBillsDueScan() {
  try {
    const companies = await query(`SELECT company_id FROM companies ORDER BY company_id`);
    let notified = 0;
    for (const co of companies) {
      try {
        notified += await scanCompany(co.company_id);
      } catch (e) {
        console.error(`Bills-due scan error for ${co.company_id}:`, e.message);
      }
    }
    return { scanned: companies.length, notified };
  } catch (e) {
    console.error('Bills-due scan failed:', e.message);
    return { error: e.message };
  }
}

async function scanCompany(companyId) {
  const rows = await query(
    `SELECT bill_id, partner_name, vendor_ref, due_date, amount, amount_paid, currency
     FROM bills
     WHERE company_id = @companyId
       AND status IN ('posted', 'partial')
       AND amount_paid < amount
     ORDER BY due_date ASC`,
    { companyId }
  );

  const today = new Date().toISOString().slice(0, 10);
  let notified = 0;
  for (const row of rows) {
    const outstanding = Number(row.amount) - Number(row.amount_paid || 0);
    const overdue = String(row.due_date).slice(0, 10) < today;
    const issueKey = `bill-due:${companyId}:${row.bill_id}`;
    const msg = `${row.partner_name}${row.vendor_ref ? ' (' + row.vendor_ref + ')' : ''} — `
      + `${outstanding.toFixed(2)} ${row.currency || ''} ${overdue ? 'overdue since' : 'due'} ${String(row.due_date).slice(0, 10)}`;
    const linkUrl = `/${companyId}/bill/${row.bill_id}`;
    const raised = await raiseNotification(companyId, 'bill-due', msg, issueKey, linkUrl);
    if (raised) notified++;
  }
  return notified;
}

/**
 * Start the scanner: run once at boot, then on interval.
 * Timer is unref'd so it never keeps the event loop alive on its own.
 */
function startBillsDueScanner() {
  runBillsDueScan().catch((e) => console.error('Boot bills-due scan failed:', e.message));

  const timer = setInterval(() => {
    runBillsDueScan().catch((e) => console.error('Scheduled bills-due scan failed:', e.message));
  }, SCAN_MS);
  timer.unref();

  return { scanIntervalMs: SCAN_MS };
}

module.exports = { runBillsDueScan, scanCompany, startBillsDueScanner };
