'use strict';
/**
 * freeBooks — Reminder due-soon scanner (calendar-reminders-documents-spec.md §4.4)
 *
 * Server job: on startup + every FREEBOOKS_REMINDER_SCAN_MS (default daily —
 * due dates don't move hour to hour, unlike FX rate gaps). Same shape as
 * fx-scanner.js: a second producer into the notifications table, the bell UI
 * needs no changes at all.
 *
 * Reuses periods-page-service.js's listReminders (not a duplicate query) so
 * the same idempotent seed-once-from-the-jurisdiction-pack step runs here
 * too — a system reminder starts generating due-soon alerts on this scanner's
 * own schedule, not only after a human has opened the Reminders tab once.
 */

const { query } = require('./db');
const { listReminders } = require('./periods-page-service');
const { raiseNotification } = require('./notifications');

const SCAN_MS = parseInt(process.env.FREEBOOKS_REMINDER_SCAN_MS || (24 * 60 * 60 * 1000), 10);
const LEAD_DAYS = parseInt(process.env.FREEBOOKS_REMINDER_LEAD_DAYS || '7', 10);

/**
 * Run one scan cycle. Called on boot and on the interval timer.
 * Never throws — failures are logged, not fatal.
 */
async function runReminderScan() {
  try {
    const companies = await query(`SELECT company_id FROM companies ORDER BY company_id`);
    let notified = 0;
    for (const co of companies) {
      try {
        notified += await scanCompany(co.company_id);
      } catch (e) {
        console.error(`Reminder scan error for ${co.company_id}:`, e.message);
      }
    }
    return { scanned: companies.length, notified };
  } catch (e) {
    console.error('Reminder scan failed:', e.message);
    return { error: e.message };
  }
}

async function scanCompany(companyId) {
  const { reminders } = await listReminders({ companyId, body: {} });
  const today = new Date();
  const horizon = new Date(today.getTime() + LEAD_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const todayStr = today.toISOString().slice(0, 10);

  let notified = 0;
  for (const r of reminders) {
    if (r.done || !r.due_date) continue;
    const due = String(r.due_date).slice(0, 10);
    if (due > horizon) continue; // not due soon yet
    const overdue = due < todayStr;
    const issueKey = `reminder-due:${companyId}:${r.reminder_id}`;
    const msg = overdue
      ? `Reminder overdue: "${r.label}" was due ${due}`
      : `Reminder due soon: "${r.label}" is due ${due}`;
    const raised = await raiseNotification(companyId, 'reminder-due', msg, issueKey);
    if (raised) notified++;
  }
  return notified;
}

/**
 * Start the scanner: run once at boot, then on interval.
 * Timer is unref'd so it never keeps the event loop alive on its own.
 */
function startReminderScanner() {
  runReminderScan().catch((e) => console.error('Boot reminder scan failed:', e.message));

  const timer = setInterval(() => {
    runReminderScan().catch((e) => console.error('Scheduled reminder scan failed:', e.message));
  }, SCAN_MS);
  timer.unref();

  return { scanIntervalMs: SCAN_MS };
}

module.exports = { runReminderScan, scanCompany, startReminderScanner };
