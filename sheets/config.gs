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
function getReportParams_() {
  var settings = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Companies');
  if (!settings) return {};

  // Read standard parameters from Settings sheet
  // Row layout: Label | Value
  var data = settings.getDataRange().getValues();
  var params = {};

  for (var i = 0; i < data.length; i++) {
    var label = String(data[i][0]).toLowerCase().trim();
    var value = data[i][1];

    if (label === 'fy start' || label === 'fy_start') params.dateFrom = formatDate_(value);
    if (label === 'fy end' || label === 'fy_end') params.dateTo = formatDate_(value);
    if (label === 'cost center' || label === 'cost_center') params.costCenter = value || undefined;
    if (label === 'profit center' || label === 'profit_center') params.profitCenter = value || undefined;
  }

  return params;
}

/**
 * Get VAT return period parameters.
 */
function getVATReturnParams_() {
  var ui = SpreadsheetApp.getUi();
  var periodFrom = ui.prompt('VAT period from (YYYY-MM-DD):').getResponseText();
  var periodTo = ui.prompt('VAT period to (YYYY-MM-DD):').getResponseText();
  return { periodFrom: periodFrom, periodTo: periodTo };
}

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
function resolvePeriodToDates_(periodStr) {
  if (!periodStr) return null;
  periodStr = String(periodStr).trim();
  
  // Read FY start month from Settings
  var fyStartMonth = 1; // Default: January
  var settings = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Companies');
  if (settings) {
    var data = settings.getDataRange().getValues();
    for (var i = 0; i < data.length; i++) {
      var label = String(data[i][0]).toLowerCase().trim();
      if (label === 'fy start' || label === 'fy_start') {
        var val = data[i][1];
        if (val instanceof Date) {
          fyStartMonth = val.getMonth() + 1;
        } else {
          var parts = String(val).split('-');
          if (parts.length >= 2) fyStartMonth = parseInt(parts[1], 10) || 1;
        }
        break;
      }
    }
  }
  
  // Match FY2026 format
  var fyMatch = periodStr.match(/^FY(\d{4})$/i);
  if (fyMatch) {
    var fyEndYear = parseInt(fyMatch[1], 10);
    // FY starts in (fyEndYear - 1) if fyStartMonth > 1, else fyEndYear
    var startYear = (fyStartMonth > 1) ? fyEndYear - 1 : fyEndYear;
    var dateFrom = startYear + '-' + pad2_(fyStartMonth) + '-01';
    // FY ends one month before fyStartMonth in fyEndYear (or Dec of fyEndYear if Jan start)
    var endMonth = (fyStartMonth === 1) ? 12 : fyStartMonth - 1;
    var endYear = (fyStartMonth === 1) ? fyEndYear : fyEndYear;
    var dateTo = endYear + '-' + pad2_(endMonth) + '-' + lastDay_(endYear, endMonth);
    return { dateFrom: dateFrom, dateTo: dateTo };
  }
  
  // Match 2026P4 or 2026P04 format
  var pMatch = periodStr.match(/^(\d{4})P(\d{1,2})$/i);
  if (pMatch) {
    var fyEndYear = parseInt(pMatch[1], 10);
    var periodNum = parseInt(pMatch[2], 10);
    if (periodNum < 1 || periodNum > 12) return null;
    
    // Calculate calendar month: P1 = fyStartMonth
    var calMonth = ((fyStartMonth - 1 + periodNum - 1) % 12) + 1;
    // Calculate calendar year
    var calYear;
    if (fyStartMonth === 1) {
      calYear = fyEndYear;
    } else {
      // Periods before January are in (fyEndYear - 1)
      calYear = (calMonth >= fyStartMonth) ? fyEndYear - 1 : fyEndYear;
    }
    
    var dateFrom = calYear + '-' + pad2_(calMonth) + '-01';
    var dateTo = calYear + '-' + pad2_(calMonth) + '-' + lastDay_(calYear, calMonth);
    return { dateFrom: dateFrom, dateTo: dateTo };
  }
  
  return null; // Unrecognized format
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
