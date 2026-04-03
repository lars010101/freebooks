/**
 * Skuld — Configuration
 *
 * Reads config from Script Properties (set during setup wizard).
 */

/**
 * Get Skuld configuration.
 */
function getConfig_() {
  var props = PropertiesService.getScriptProperties();
  return {
    functionUrl: props.getProperty('SKULD_FUNCTION_URL') || '',
    projectId: props.getProperty('GCP_PROJECT_ID') || '',
    companyId: getActiveCompanyId_(),
  };
}

/**
 * Get the active company ID for this spreadsheet.
 * Reads from Companies tab B1 if it exists, otherwise falls back to Script Properties.
 * Updates Script Properties if the value on the sheet has changed.
 */
function getActiveCompanyId_() {
  var props = PropertiesService.getScriptProperties();
  var storedCompany = props.getProperty('COMPANY_ID') || '';
  
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var companiesSheet = ss ? ss.getSheetByName('Companies') : null;
  
  if (companiesSheet) {
    var sheetCompany = String(companiesSheet.getRange('B1').getValue() || '').trim();
    if (sheetCompany && sheetCompany !== 'Company ID' && sheetCompany !== storedCompany) {
      // User changed the dropdown. Save it to properties.
      props.setProperty('COMPANY_ID', sheetCompany);
      return sheetCompany;
    }
    if (sheetCompany && sheetCompany !== 'Company ID') {
      return sheetCompany;
    }
  }
  
  return storedCompany;
}

/**
 * Get report parameters from the current Sheet's filter cells.
 * Expects a "Parameters" area in the active report sheet or Settings.
 */

/**
 * Get VAT return period parameters.
 */

/**
 * Format a date value to YYYY-MM-DD string.
 */
function formatDate_(value) {
  if (!value) return undefined;
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(value);
}

/**
 * Resolve a period string (e.g., "FY2026" or "2026P4") into { dateFrom, dateTo }.
 * Uses the company's fiscal year start month from the Settings sheet.
 *
 * Period formats:
 *   FY2026   → full fiscal year ending in 2026
 *   2026P4   → 4th period (month) of that fiscal year
 *   2026P04  → same as above (zero-padded)
 *
 * FY convention: FY2026 means the fiscal year that ENDS in calendar year 2026
 * (or starts in 2025 if FY start month > 1).
 * Period numbering: P1 = first month of FY, P12 = last month of FY.
 */
/**
 * Resolve a period string (e.g. "FY2026" or "2026P04") to { dateFrom, dateTo }.
 * Queries the periods table in BigQuery via the Cloud Function.
 * No local fallback — fails loudly if the database doesn't have the period.
 */
function resolvePeriodToDates_(periodStr) {
  if (!periodStr) return null;
  periodStr = String(periodStr).trim();

  var periods = callSkuld_('period.list', {});
  if (!periods || periods.length === 0) {
    throw new Error('No periods found in database for this company. Load Periods first.');
  }

  for (var i = 0; i < periods.length; i++) {
    var p = periods[i];
    var pName = String(p.period_name || p.period_id || '').trim();
    if (pName === periodStr) {
      var sd = p.start_date && p.start_date.value ? p.start_date.value : String(p.start_date || '');
      var ed = p.end_date && p.end_date.value ? p.end_date.value : String(p.end_date || '');
      if (sd && ed) return { dateFrom: sd, dateTo: ed };
    }
  }

  throw new Error('Period "' + periodStr + '" not found in database. Available: ' +
    periods.map(function(p) { return p.period_name || p.period_id || ''; }).filter(function(n) { return n; }).join(', '));
}

/** Zero-pad a number to 2 digits. */
function pad2_(n) {
  return n < 10 ? '0' + n : '' + n;
}

/**
 * Normalize a period string to match cache column headers.
 * '2025P3' -> '2025P03', 'FY2025' -> 'FY2025' (unchanged), '2025P03' -> '2025P03'
 */
function normalizePeriod_(periodStr) {
  if (!periodStr) return periodStr;
  var m = String(periodStr).trim().match(/^(\d{4})P(\d{1,2})$/i);
  if (m) {
    return m[1] + 'P' + pad2_(parseInt(m[2], 10));
  }
  return String(periodStr).trim();
}

/** Last day of a given month/year. */
function lastDay_(year, month) {
  return pad2_(new Date(year, month, 0).getDate());
}
