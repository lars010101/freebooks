'use strict';
/**
 * freeBooks — FX coverage computation (fx-automation-spec §3)
 *
 * Coverage = stored days vs the provider's actual publication days —
 * never vs naive weekdays. Weekends and ECB/TARGET holidays have no
 * publication, so they never count as missing.
 *
 * Uses the provider's fetchRange to get the ground truth publication dates,
 * then diffs against stored fx_rates dates (any source counts as covered).
 */

const { query } = require('./db');

/**
 * Compute coverage for a date range.
 *
 * @param companyId
 * @param baseCurrency  e.g. 'SEK'
 * @param startDate     YYYY-MM-DD
 * @param endDate       YYYY-MM-DD (inclusive, capped at today by caller)
 * @param provider      provider module (must have fetchRange or fetchRates)
 * @param source        provider name for rate row matching
 * @returns { status: 'na'|'red'|'green', missing: [dates], publicationDays: [dates] }
 */
async function computeCoverage(companyId, baseCurrency, startDate, endDate, provider, source) {
  // 1. Get the provider's publication days + the actual rate rows in one
  // call (so the scanner can insert them directly without re-fetching).
  let publicationDays;
  let fetchedRows = null;
  try {
    const result = await getPublicationDaysWithRows(provider, baseCurrency, startDate, endDate);
    publicationDays = result.days;
    fetchedRows = result.rows;
  } catch (e) {
    // Provider down or unreachable — can't determine coverage
    return { status: 'na', missing: [], publicationDays: [], rows: null, error: e.message };
  }

  if (!publicationDays || publicationDays.length === 0) {
    // No publication days in range (e.g. future range, all weekends)
    return { status: 'na', missing: [], publicationDays: [], rows: null };
  }

  // 2. Get stored rate dates for this currency pair in the range
  const storedRows = await query(
    `SELECT DISTINCT date FROM fx_rates
     WHERE date >= @start AND date <= @end
       AND (from_currency = @base OR to_currency = @base)`,
    { start: startDate, end: endDate, base: baseCurrency }
  );
  const storedDays = new Set(storedRows.map(r => String(r.date).slice(0, 10)));

  // 3. Diff: which publication days are NOT in stored days?
  const missing = publicationDays.filter(d => !storedDays.has(d));

  if (missing.length === 0) {
    return { status: 'green', missing: [], publicationDays, rows: null };
  }

  return { status: 'red', missing, publicationDays, rows: fetchedRows };
}

/**
 * Recompute coverage using ONLY stored dates against already-known
 * publication days — no provider call. Use this after inserting fetched
 * rows to confirm the gap closed (or didn't) without re-downloading data.
 */
async function recomputeCoverage(companyId, baseCurrency, startDate, endDate, publicationDays) {
  if (!publicationDays || publicationDays.length === 0) {
    return { status: 'na', missing: [] };
  }
  const storedRows = await query(
    `SELECT DISTINCT date FROM fx_rates
     WHERE date >= @start AND date <= @end
       AND (from_currency = @base OR to_currency = @base)`,
    { start: startDate, end: endDate, base: baseCurrency }
  );
  const storedDays = new Set(storedRows.map(r => String(r.date).slice(0, 10)));
  const missing = publicationDays.filter(d => !storedDays.has(d));
  if (missing.length === 0) return { status: 'green', missing: [] };
  return { status: 'red', missing };
}

/**
 * Get the provider's actual publication days for a date range.
 *
 * If the provider has fetchRange, use it directly — the dates in the response
 * are the ground truth publication calendar.
 *
 * If not, fall back to calling fetchRates for each day (inefficient, used only
 * by providers without a range endpoint).
 */
async function getPublicationDays(provider, baseCurrency, startDate, endDate, apiKey) {
  return (await getPublicationDaysWithRows(provider, baseCurrency, startDate, endDate, apiKey)).days;
}

/**
 * Like getPublicationDays, but also returns the fetched rate rows so callers
 * that need the data (e.g. the scanner inserting missing rates) don't have to
 * download the same range a second time.
 *
 * @returns { days: [YYYY-MM-DD], rows: [rateRow, ...] }
 */
async function getPublicationDaysWithRows(provider, baseCurrency, startDate, endDate, apiKey) {
  // Prefer fetchRange (spec §2)
  if (typeof provider.fetchRange === 'function') {
    const rows = await provider.fetchRange(baseCurrency, startDate, endDate, apiKey);
    // The dates the provider actually returned ARE the publication days
    const days = [...new Set(rows.map(r => r.date))].sort();
    return { days, rows };
  }

  // Fallback: per-day fetchRates (spec §2 — providers without fetchRange)
  // This is a best-effort heuristic: we call fetchRates for each day and
  // collect the dates that actually return data.
  const days = [];
  const allRows = [];
  let cur = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');

  while (cur <= end) {
    const ymd = cur.toISOString().slice(0, 10);
    try {
      const rows = await provider.fetchRates(baseCurrency, ymd, apiKey);
      if (rows && rows.length > 0) {
        const rateDate = rows[0].date || ymd;
        if (!days.includes(rateDate)) days.push(rateDate);
        allRows.push(...rows);
      }
    } catch (e) {
      // Provider didn't have data for this day — skip (not a publication day)
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  return { days: days.sort(), rows: allRows };
}

/**
 * Fetch rates for a date range using the provider's fetchRange if available,
 * or fall back to per-day fetchRates.
 *
 * @returns array of rate rows (same shape as provider.fetchRates output)
 */
async function fetchRange(provider, baseCurrency, startDate, endDate, apiKey) {
  if (typeof provider.fetchRange === 'function') {
    return provider.fetchRange(baseCurrency, startDate, endDate, apiKey);
  }

  // Fallback: per-day loop
  const allRows = [];
  let cur = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');

  while (cur <= end) {
    const ymd = cur.toISOString().slice(0, 10);
    try {
      const rows = await provider.fetchRates(baseCurrency, ymd, apiKey);
      if (rows && rows.length > 0) allRows.push(...rows);
    } catch (e) {
      // skip
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  return allRows;
}

module.exports = { computeCoverage, recomputeCoverage, getPublicationDays, getPublicationDaysWithRows, fetchRange };
