/**
 * Skuld — Report generation
 *
 * Generates: Trial Balance, P&L, Balance Sheet, Cash Flow, Dashboard, AP Aging,
 *            VAT Return, Statement of Changes in Equity, Integrity Check
 * All queries run against BigQuery. Results returned to Apps Script for Sheet display.
 */

const { generateVatReturn } = require('./vat');
const { buildAccountBalancesCache } = require('./reports_cache');

/**
 * Route report actions.
 */
async function handleReports(ctx, action) {
  switch (action) {
    case 'report.refresh_ap_aging':
      return refreshAPAging(ctx);
    case 'report.refresh_vat_return':
      return generateVatReturn(ctx);
    case 'report.cache_balances':
      return buildAccountBalancesCache(ctx);
    default:
      throw Object.assign(new Error(`Unknown report action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

// =============================================================================
// Period detection helpers
// =============================================================================

/**
 * Fetch company FY start/end from the companies table.
 * Returns { fyStartMonth, fyStartDay, fyEndMonth, fyEndDay }.
 * fy_start/fy_end are stored as MM-DD strings (e.g. '02-01', '01-31').
 */
async function getCompanyFY(dataset, companyId) {
  const [rows] = await dataset.query({
    query: `SELECT fy_start, fy_end FROM finance.companies WHERE company_id = @companyId QUALIFY ROW_NUMBER() OVER(PARTITION BY company_id ORDER BY created_at DESC) = 1`,
    params: { companyId },
  });
  if (!rows || rows.length === 0) {
    return { fyStartMonth: 1, fyStartDay: 1, fyEndMonth: 12, fyEndDay: 31 };
  }
  const fy = rows[0];
  // fy_start/fy_end may be DATE objects ({value:'2025-02-01'}) or strings
  const fyStartStr = String(fy.fy_start?.value || fy.fy_start || '2025-01-01');
  const fyEndStr = String(fy.fy_end?.value || fy.fy_end || '2025-12-31');
  // Parse YYYY-MM-DD — extract month and day
  const fsParts = fyStartStr.split('-').map(Number);
  const feParts = fyEndStr.split('-').map(Number);
  const sm = fsParts.length === 3 ? fsParts[1] : fsParts[0];
  const sd = fsParts.length === 3 ? fsParts[2] : fsParts[1];
  const em = feParts.length === 3 ? feParts[1] : feParts[0];
  const ed = feParts.length === 3 ? feParts[2] : feParts[1];
  return { fyStartMonth: sm, fyStartDay: sd, fyEndMonth: em, fyEndDay: ed };
}

/**
 * Get last day of a given month.
 */
function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/**
 * Format a date as YYYY-MM-DD.
 */
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Format period label from date range.
 */
function periodLabel(dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return 'All Time';
  if (!dateFrom) return `As at ${dateTo}`;
  const df = new Date(dateFrom + 'T00:00:00Z');
  const dt = new Date(dateTo + 'T00:00:00Z');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  // Single month
  if (df.getUTCMonth() === dt.getUTCMonth() && df.getUTCFullYear() === dt.getUTCFullYear()) {
    return `${months[df.getUTCMonth()]} ${df.getUTCFullYear()}`;
  }
  // Full year or multi-month
  return `${months[df.getUTCMonth()]} ${df.getUTCFullYear()} – ${months[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

/**
 * Detect period type from dateFrom/dateTo and company FY settings.
 * Returns: { type: 'fy'|'quarter'|'month'|'single', periods: [{ dateFrom, dateTo, label }] }
 */
function detectPeriods(dateFrom, dateTo, fy) {
  if (!dateFrom || !dateTo) {
    return { type: 'single', periods: [{ dateFrom: dateFrom || null, dateTo: dateTo || null, label: periodLabel(dateFrom, dateTo) }] };
  }

  const df = new Date(dateFrom + 'T00:00:00Z');
  const dt = new Date(dateTo + 'T00:00:00Z');

  const fromDay = df.getUTCDate();
  const fromMonth = df.getUTCMonth() + 1; // 1-based
  const fromYear = df.getUTCFullYear();
  const toDay = dt.getUTCDate();
  const toMonth = dt.getUTCMonth() + 1;
  const toYear = dt.getUTCFullYear();
  const toLastDay = lastDayOfMonth(toYear, toMonth);

  // Must start on 1st and end on last day of month for any multi-period
  if (fromDay !== 1 || toDay !== toLastDay) {
    return { type: 'single', periods: [{ dateFrom, dateTo, label: periodLabel(dateFrom, dateTo) }] };
  }

  // Check FY match: from = FY start, to = FY end
  if (fromMonth === fy.fyStartMonth && fromDay === fy.fyStartDay &&
      toMonth === fy.fyEndMonth && toDay === fy.fyEndDay) {
    // Generate 5 FY periods rolling back
    const periods = [];
    for (let i = 0; i < 5; i++) {
      const fyFromYear = fromYear - i;
      let fyToYear;
      // Handle FY that spans calendar years (e.g. Feb 2025 - Jan 2026)
      if (fy.fyEndMonth < fy.fyStartMonth) {
        fyToYear = fyFromYear + 1;
      } else {
        fyToYear = fyFromYear;
      }
      const pFrom = `${fyFromYear}-${String(fy.fyStartMonth).padStart(2,'0')}-${String(fy.fyStartDay).padStart(2,'0')}`;
      const pToDay = lastDayOfMonth(fyToYear, fy.fyEndMonth);
      const pTo = `${fyToYear}-${String(fy.fyEndMonth).padStart(2,'0')}-${String(pToDay).padStart(2,'0')}`;
      periods.push({ dateFrom: pFrom, dateTo: pTo, label: periodLabel(pFrom, pTo) });
    }
    return { type: 'fy', periods };
  }

  // Check quarter match: 3-month span
  let monthSpan;
  if (toMonth >= fromMonth) {
    monthSpan = toMonth - fromMonth + 1;
  } else {
    monthSpan = (12 - fromMonth + 1) + toMonth;
  }

  if (monthSpan === 3 && fromYear === toYear) {
    // Generate 5 quarters rolling back
    const periods = [];
    for (let i = 0; i < 5; i++) {
      let qStartMonth = fromMonth - (i * 3);
      let qStartYear = fromYear;
      while (qStartMonth < 1) { qStartMonth += 12; qStartYear--; }
      let qEndMonth = qStartMonth + 2;
      let qEndYear = qStartYear;
      if (qEndMonth > 12) { qEndMonth -= 12; qEndYear++; }
      const qFromDay = 1;
      const qToDay = lastDayOfMonth(qEndYear, qEndMonth);
      const pFrom = `${qStartYear}-${String(qStartMonth).padStart(2,'0')}-01`;
      const pTo = `${qEndYear}-${String(qEndMonth).padStart(2,'0')}-${String(qToDay).padStart(2,'0')}`;
      periods.push({ dateFrom: pFrom, dateTo: pTo, label: periodLabel(pFrom, pTo) });
    }
    return { type: 'quarter', periods };
  }

  // Check month match: 1-month span
  if (monthSpan === 1 && fromYear === toYear) {
    // Generate 13 months rolling back
    const periods = [];
    for (let i = 0; i < 13; i++) {
      let mMonth = fromMonth - i;
      let mYear = fromYear;
      while (mMonth < 1) { mMonth += 12; mYear--; }
      const mToDay = lastDayOfMonth(mYear, mMonth);
      const pFrom = `${mYear}-${String(mMonth).padStart(2,'0')}-01`;
      const pTo = `${mYear}-${String(mMonth).padStart(2,'0')}-${String(mToDay).padStart(2,'0')}`;
      periods.push({ dateFrom: pFrom, dateTo: pTo, label: periodLabel(pFrom, pTo) });
    }
    return { type: 'month', periods };
  }

  // Default: single period
  return { type: 'single', periods: [{ dateFrom, dateTo, label: periodLabel(dateFrom, dateTo) }] };
}


module.exports = { handleReports };
