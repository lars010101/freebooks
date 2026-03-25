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
    companyId: props.getProperty('COMPANY_ID') || '',
  };
}

/**
 * Get the active company ID for this spreadsheet.
 */
function getActiveCompanyId_() {
  var config = getConfig_();
  return config.companyId;
}

/**
 * Get report parameters from the current Sheet's filter cells.
 * Expects a "Parameters" area in the active report sheet or Settings.
 */
function getReportParams_() {
  var settings = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Settings');
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
