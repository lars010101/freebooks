'use strict';
/**
 * freeBooks — FX gap scanner (fx-automation-spec §6)
 *
 * Server job: on startup + every 6h (env-tunable FREEBOOKS_FX_SCAN_MS).
 * Per company (rev. 3): a company is automated iff fx_tracking='auto' AND
 * its provider is a real one (not 'manual'). Zero qualifying companies →
 * short-circuit: nothing is downloaded, no coverage computation, no
 * notifications.
 *
 * For each qualifying company, for each period intersecting [company start, today]:
 *   1. Compute coverage (§3): stored days vs provider's publication days
 *   2. Fetch missing ranges via fetchRange
 *   3. Recompute coverage
 *   4. Still missing → raise notification (§7)
 */

const path = require('path');
const fs = require('fs');
const { query, exec, bulkInsert } = require('./db');
const { loadProviderConfig, MANUAL_PROVIDER, providerExists } = require('./fx');
const { computeCoverage, fetchRange } = require('./fx-coverage');
const { raiseNotification } = require('./notifications');

const SCAN_MS = parseInt(process.env.FREEBOOKS_FX_SCAN_MS || (6 * 60 * 60 * 1000), 10);

/**
 * Run one scan cycle. Called on boot and on the interval timer.
 * Never throws — failures are logged, not fatal.
 */
async function runFxScan() {
  try {
    // Get all companies with fx_tracking='auto' and a real provider
    const companies = await query(
      `SELECT c.company_id, c.currency
         FROM companies c
         JOIN settings s ON c.company_id = s.company_id AND s.key = 'fx_tracking' AND s.value = 'auto'
         JOIN settings p ON c.company_id = p.company_id AND p.key = 'fx_provider' AND p.value != 'manual'
         ORDER BY c.company_id`
    );

    if (companies.length === 0) {
      // Short-circuit (rev. 2026-07-27): zero qualifying companies
      return { scanned: 0, fetched: 0, notified: 0 };
    }

    let totalFetched = 0;
    let totalNotified = 0;

    for (const co of companies) {
      try {
        const result = await scanCompany(co.company_id, co.currency);
        totalFetched += result.fetched;
        totalNotified += result.notified;
      } catch (e) {
        console.error(`FX scan error for ${co.company_id}:`, e.message);
      }
    }

    return { scanned: companies.length, fetched: totalFetched, notified: totalNotified };
  } catch (e) {
    console.error('FX scan failed:', e.message);
    return { error: e.message };
  }
}

/**
 * Scan one company: compute coverage, fetch missing, recompute, notify.
 */
async function scanCompany(companyId, baseCurrency) {
  const { providerName, apiKey } = await loadProviderConfig(companyId);
  if (providerName === MANUAL_PROVIDER || !providerExists(providerName)) {
    return { fetched: 0, notified: 0 };
  }

  // Get the provider module
  const providerPath = path.join(__dirname, 'fxProviders', providerName + '.js');
  const provider = require(providerPath);
  const source = providerName;

  // Get all periods for this company
  const periods = await query(
    `SELECT period_name, start_date, end_date FROM (
       SELECT *, ROW_NUMBER() OVER(PARTITION BY period_name ORDER BY created_at DESC) AS rn
       FROM periods WHERE company_id = @companyId
     ) WHERE rn = 1 ORDER BY start_date`,
    { companyId }
  );

  const today = new Date().toISOString().slice(0, 10);
  let fetched = 0;
  let notified = 0;

  for (const period of periods) {
    const start = String(period.start_date).slice(0, 10);
    const end = String(period.end_date).slice(0, 10);
    const effectiveEnd = end < today ? end : today;

    if (start > today) continue; // future period — skip

    // 1. Compute coverage
    const coverage = await computeCoverage(companyId, baseCurrency, start, effectiveEnd, provider, source);

    if (coverage.status === 'na' || coverage.status === 'green') continue;

    // 2. Fetch missing ranges
    if (coverage.missing && coverage.missing.length > 0) {
      try {
        const minMissing = coverage.missing[0];
        const maxMissing = coverage.missing[coverage.missing.length - 1];
        const rows = await fetchRange(provider, baseCurrency, minMissing, maxMissing, apiKey);
        if (rows && rows.length > 0) {
          // Delete existing rows for these dates+source, then insert
          const dates = [...new Set(rows.map(r => r.date))];
          for (const d of dates) {
            await exec(
              `DELETE FROM fx_rates WHERE date = @date AND source = @source AND (from_currency = @base OR to_currency = @base)`,
              { date: d, source, base: baseCurrency }
            );
          }
          await bulkInsert('fx_rates', rows);
          fetched += rows.length / 2;
        }
      } catch (e) {
        console.error(`FX fetch error for ${companyId} period ${period.period_name}:`, e.message);
      }
    }

    // 3. Recompute coverage
    const rechecked = await computeCoverage(companyId, baseCurrency, start, effectiveEnd, provider, source);

    // 4. Still missing → raise notification
    if (rechecked.status === 'red' && rechecked.missing && rechecked.missing.length > 0) {
      const issueKey = `fx-gap:${companyId}:${period.period_name}`;
      const msg = `FX rate gap: ${rechecked.missing.length} day(s) missing for ${period.period_name} (${baseCurrency}). First missing: ${rechecked.missing[0]}`;
      const raised = await raiseNotification(companyId, 'fx-gap', msg, issueKey);
      if (raised) notified++;
    }
  }

  return { fetched, notified };
}

/**
 * Start the scanner: run once at boot, then on interval.
 * Timer is unref'd so it never keeps the event loop alive on its own.
 */
function startFxScanner() {
  // Run once at boot (fire-and-forget)
  runFxScan().catch((e) => console.error('Boot FX scan failed:', e.message));

  // Schedule recurring scan
  const timer = setInterval(() => {
    runFxScan().catch((e) => console.error('Scheduled FX scan failed:', e.message));
  }, SCAN_MS);
  timer.unref();

  return { scanIntervalMs: SCAN_MS };
}

module.exports = { runFxScan, scanCompany, startFxScanner };
