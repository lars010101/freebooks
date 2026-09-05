'use strict';
/**
 * freeBooks — Reconciliation-alert scanner (#138)
 *
 * Server job: on startup + every FREEBOOKS_RECONCILIATION_SCAN_MS (default
 * daily). Same shape as reminder-scanner.js / bills-due-scanner.js.
 *
 * Replaces the Inbox's former 'reconciliation' filter view: a reconciliation
 * alert carries no in-place decision, only a "go look" verb (o = open in
 * Bank Reconciliation) — that's a notification, not an approval queue item.
 * Cash-category accounts holding entries uncleared for more than 30 days
 * raise a bell notification linking to the account's reconciliation tab.
 *
 * Dedupe: one open notification per account (issue_key = reconciliation:
 * <company>:<account_code>). Recomputed live from journal_entries/
 * reconciliations each scan — nothing persisted beyond the notification row
 * itself (R8: aggregate, never stage).
 */

const { query } = require('./db');
const { raiseNotification } = require('./notifications');

const SCAN_MS = parseInt(process.env.FREEBOOKS_RECONCILIATION_SCAN_MS || (24 * 60 * 60 * 1000), 10);

/**
 * Run one scan cycle. Called on boot and on the interval timer.
 * Never throws — failures are logged, not fatal.
 */
async function runReconciliationScan() {
  try {
    const companies = await query(`SELECT company_id FROM companies ORDER BY company_id`);
    let notified = 0;
    for (const co of companies) {
      try {
        notified += await scanCompany(co.company_id);
      } catch (e) {
        console.error(`Reconciliation scan error for ${co.company_id}:`, e.message);
      }
    }
    return { scanned: companies.length, notified };
  } catch (e) {
    console.error('Reconciliation scan failed:', e.message);
    return { error: e.message };
  }
}

async function scanCompany(companyId) {
  const rows = await query(
    `SELECT a.account_code, a.account_name,
            COUNT(DISTINCT je.batch_id) AS stale_count,
            MIN(je.date) AS oldest_date
     FROM journal_entries je
     JOIN accounts a ON a.account_code = je.account_code AND a.company_id = je.company_id
     LEFT JOIN reconciliations r
       ON r.company_id = je.company_id AND r.batch_id = je.batch_id AND r.account_code = je.account_code
     WHERE je.company_id = @companyId AND a.cf_category = 'Cash' AND r.batch_id IS NULL
       AND CAST(je.date AS DATE) < CAST(CURRENT_DATE AS DATE) - INTERVAL '30 days'
     GROUP BY a.account_code, a.account_name`,
    { companyId }
  );

  let notified = 0;
  for (const row of rows) {
    const oldestStr = String(row.oldest_date).slice(0, 10);
    const count = Number(row.stale_count);
    const issueKey = `reconciliation:${companyId}:${row.account_code}`;
    const msg = `${count} uncleared entr${count === 1 ? 'y' : 'ies'} in ${row.account_code} — `
      + `${row.account_name || ''} older than 30 days (oldest ${oldestStr})`;
    const linkUrl = `/${companyId}/bank?tab=reconciliation`;
    const raised = await raiseNotification(companyId, 'reconciliation-alert', msg, issueKey, linkUrl);
    if (raised) notified++;
  }
  return notified;
}

/**
 * Start the scanner: run once at boot, then on interval.
 * Timer is unref'd so it never keeps the event loop alive on its own.
 */
function startReconciliationScanner() {
  runReconciliationScan().catch((e) => console.error('Boot reconciliation scan failed:', e.message));

  const timer = setInterval(() => {
    runReconciliationScan().catch((e) => console.error('Scheduled reconciliation scan failed:', e.message));
  }, SCAN_MS);
  timer.unref();

  return { scanIntervalMs: SCAN_MS };
}

module.exports = { runReconciliationScan, scanCompany, startReconciliationScanner };
