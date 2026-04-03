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
 * Queries the periods table in BigQuery via the Cloud Function for authoritative dates.
 * Falls back to local cache (Period Balances sheet) if the call fails.
 */
function resolvePeriodToDates_(periodStr) {
  if (!periodStr) return null;
  periodStr = String(periodStr).trim();

  // Try: query the database for the exact period dates
  try {
    var periods = callSkuld_('period.list', {});
    if (periods && periods.length > 0) {
      for (var i = 0; i < periods.length; i++) {
        var p = periods[i];
        var pName = String(p.period_name || p.period_id || '').trim();
        if (pName === periodStr) {
          var sd = p.start_date && p.start_date.value ? p.start_date.value : String(p.start_date || '');
          var ed = p.end_date && p.end_date.value ? p.end_date.value : String(p.end_date || '');
          if (sd && ed) return { dateFrom: sd, dateTo: ed };
        }
      }
    }
  } catch (e) {
    // Fall through to local calculation
  }

  // Fallback: calculate locally from FY start month
  var fyStartMonth = 1; // default calendar year
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var pbSheet = ss.getSheetByName('Period Balances');
    if (pbSheet && pbSheet.getLastColumn() > 1) {
      var dateRow = pbSheet.getRange(2, 1, 1, pbSheet.getLastColumn()).getValues()[0];
      for (var di = 0; di < dateRow.length; di++) {
        var d = dateRow[di];
        if (d instanceof Date) {
          fyStartMonth = d.getMonth() + 1;
          break;
        }
      }
    }
  } catch (e) { /* keep default */ }

  var fyMatch = periodStr.match(/^FY(\d{4})$/i);
  if (fyMatch) {
    var fyEndYear = parseInt(fyMatch[1], 10);
    var startYear = (fyStartMonth > 1) ? fyEndYear - 1 : fyEndYear;
    var dateFrom = startYear + '-' + pad2_(fyStartMonth) + '-01';
    var endMonth = (fyStartMonth === 1) ? 12 : fyStartMonth - 1;
    var endYear = (fyStartMonth === 1) ? fyEndYear : fyEndYear;
    var dateTo = endYear + '-' + pad2_(endMonth) + '-' + lastDay_(endYear, endMonth);
    return { dateFrom: dateFrom, dateTo: dateTo };
  }

  var pMatch = periodStr.match(/^(\d{4})P(\d{1,2})$/i);
  if (pMatch) {
    var fyEndYear = parseInt(pMatch[1], 10);
    var periodNum = parseInt(pMatch[2], 10);
    if (periodNum < 1 || periodNum > 12) return null;
    var calMonth = ((fyStartMonth - 1 + periodNum - 1) % 12) + 1;
    var calYear = (fyStartMonth === 1) ? fyEndYear : (calMonth >= fyStartMonth ? fyEndYear - 1 : fyEndYear);
    var dateFrom = calYear + '-' + pad2_(calMonth) + '-01';
    var dateTo = calYear + '-' + pad2_(calMonth) + '-' + lastDay_(calYear, calMonth);
    return { dateFrom: dateFrom, dateTo: dateTo };
  }

  return null;
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
