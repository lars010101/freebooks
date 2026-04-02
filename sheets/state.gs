/**
 * Skuld — State Engine & Timestamps
 *
 * Manages data freshness timestamps to prevent stale reporting,
 * and tracks unposted edits to prevent redundant database writes.
 */

// Keys for PropertiesService
var KEY_GLOBAL_DB_POST = 'SKULD_GLOBAL_LAST_DB_POST';
var KEY_SHEET_REFRESH_PREFIX = 'SKULD_SHEET_REFRESHED_';
var KEY_SHEET_EDIT_PREFIX = 'SKULD_LAST_EDIT_';

function markGlobalDatabasePost() {
  var props = PropertiesService.getDocumentProperties();
  var now = new Date().toISOString();
  props.setProperty(KEY_GLOBAL_DB_POST, now);
  flagStaleSheets_();
}

function markSheetRefreshed(sheetName) {
  var props = PropertiesService.getDocumentProperties();
  var now = new Date().toISOString();
  props.setProperty(KEY_SHEET_REFRESH_PREFIX + sheetName, now);
  clearStaleIndicator_(sheetName);
}

function isSheetStale(sheetName) {
  var props = PropertiesService.getDocumentProperties();
  var globalPostIso = props.getProperty(KEY_GLOBAL_DB_POST);
  var sheetRefreshIso = props.getProperty(KEY_SHEET_REFRESH_PREFIX + sheetName);
  if (!globalPostIso) return false;
  if (!sheetRefreshIso) return true;
  return new Date(globalPostIso) > new Date(sheetRefreshIso);
}

function flagStaleSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var sheet = sheets[i];
    var sheetName = sheet.getName();
    if (isInputOrSettingsSheet_(sheetName)) continue;
    if (isSheetStale(sheetName)) {
      applyStaleIndicator_(sheet);
    }
  }
}

function isInputOrSettingsSheet_(sheetName) {
  var inputSheets = [
    'New Journal entry', 'Bank statement', 'Transaction import',
    'Companies', 'Periods', 'Bank map', 'Tax', 'Centers',
    'COA', 'Mappings', 'Import', 'Bank Processing', 'Bills'
  ];
  return inputSheets.indexOf(sheetName) !== -1;
}

function applyStaleIndicator_(sheet) {
  var sheetName = sheet.getName();
  var noOverwrite = ['PL', 'BS', 'CF', 'SCE', 'Integrity', 'Period Balances', 'COA'];
  if (noOverwrite.indexOf(sheetName) !== -1) {
    try { sheet.setTabColor('red'); } catch(e) {}
  }
}

function clearStaleIndicator_(sheetName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  try {
    var config = TAB_CONFIG[sheetName] || { color: null };
    sheet.setTabColor(config.color);
  } catch(e) {}
}

function getSheetLastRefreshedString(sheetName) {
  var props = PropertiesService.getDocumentProperties();
  var iso = props.getProperty(KEY_SHEET_REFRESH_PREFIX + sheetName);
  if (!iso) return 'Never';
  var d = new Date(iso);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

function recordSheetEdit(e) {
  if (!e || !e.source) return;
  var sheetName = e.source.getActiveSheet().getName();
  if (isInputOrSettingsSheet_(sheetName)) {
    var props = PropertiesService.getDocumentProperties();
    props.setProperty(KEY_SHEET_EDIT_PREFIX + sheetName, new Date().toISOString());
  }
}

function hasUnpostedEdits(sheetName) {
  var props = PropertiesService.getDocumentProperties();
  var lastEditIso = props.getProperty(KEY_SHEET_EDIT_PREFIX + sheetName);
  var globalPostIso = props.getProperty(KEY_GLOBAL_DB_POST);
  if (!lastEditIso) return false;
  if (!globalPostIso) return true;
  return new Date(lastEditIso) > new Date(globalPostIso);
}

function validateBeforePost(sheetName) {
  if (!hasUnpostedEdits(sheetName)) {
    SpreadsheetApp.getUi().alert('No changes detected since the last post to the database.');
    return false;
  }
  return true;
}

function onEdit(e) {
  recordSheetEdit(e);
}
