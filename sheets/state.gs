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

/**
 * Record that a database write (Post) has occurred globally.
 * This invalidates all currently loaded reports/views.
 */
function markGlobalDatabasePost() {
  var props = PropertiesService.getDocumentProperties();
  var now = new Date().toISOString();
  props.setProperty(KEY_GLOBAL_DB_POST, now);
  
  // Immediately visually flag all open data sheets as stale
  flagStaleSheets_();
}

/**
 * Record that a specific sheet has just pulled fresh data from the database.
 * @param {string} sheetName - The name of the sheet
 */
function markSheetRefreshed(sheetName) {
  var props = PropertiesService.getDocumentProperties();
  var now = new Date().toISOString();
  props.setProperty(KEY_SHEET_REFRESH_PREFIX + sheetName, now);
  
  // Clear the stale indicator on this sheet
  clearStaleIndicator_(sheetName);
}

/**
 * Check if a specific sheet's data is older than the last global database post.
 * @param {string} sheetName - The name of the sheet
 * @returns {boolean} True if the sheet needs to be refreshed
 */
function isSheetStale(sheetName) {
  var props = PropertiesService.getDocumentProperties();
  var globalPostIso = props.getProperty(KEY_GLOBAL_DB_POST);
  var sheetRefreshIso = props.getProperty(KEY_SHEET_REFRESH_PREFIX + sheetName);
  
  // If no global post has ever been recorded, we assume it's not "stale" from a new post
  if (!globalPostIso) return false;
  
  // If global post exists but sheet has NEVER been refreshed, it's definitely stale/empty
  if (!sheetRefreshIso) return true;
  
  var globalPostDate = new Date(globalPostIso);
  var sheetRefreshDate = new Date(sheetRefreshIso);
  
  return globalPostDate > sheetRefreshDate;
}

/**
 * Scan all relevant data sheets and flag them if they are stale.
 */
function flagStaleSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  
  for (var i = 0; i < sheets.length; i++) {
    var sheet = sheets[i];
    var sheetName = sheet.getName();
    
    // Skip entry/settings sheets where data freshness indicator doesn't apply
    if (isInputOrSettingsSheet_(sheetName)) continue;
    
    if (isSheetStale(sheetName)) {
      applyStaleIndicator_(sheet);
    }
  }
}

/**
 * Determine if a sheet is purely for input or settings (doesn't need stale warnings).
 */
function isInputOrSettingsSheet_(sheetName) {
  var inputSheets = [
    'New Journal entry', 'Bank statement', 'Transaction import', 
    'Companies', 'Periods', 'Bank map', 'Tax codes', 'Profit/cost centers',
    'COA', 'Mappings', 'VAT Codes', 'Centers', 'Import', 'Bank Processing', 'Bills'
  ];
  return inputSheets.indexOf(sheetName) !== -1;
}

/**
 * Visually indicate that a sheet is stale.
 * Flags cell A1 and colors the tab red to alert the user.
 */
function applyStaleIndicator_(sheet) {
  var sheetName = sheet.getName();
  
  // Formula-driven reports and internal cache sheets: just flag tab color
  var noOverwrite = ['PL', 'BS', 'CF', 'CF-skuld', 'SCE', 'Integrity', 'Integrity Check', 'Period Balances', 'COA'];
  if (noOverwrite.indexOf(sheetName) !== -1) {
    try { sheet.setTabColor('red'); } catch(e) {}
    return;
  }
  
  // Stale indicator disabled — B3 Refreshed timestamp is sufficient
  // var cell = sheet.getRange('C4');
  return;
  cell.setValue('⚠️ STALE — Refresh needed');
  cell.setFontColor('red');
  cell.setFontWeight('bold');
  
  // Set tab color to red as an immediate visual cue
  try {
    sheet.setTabColor('red');
  } catch(e) {}
}

/**
 * Remove the visual stale indicator from a sheet after a successful refresh.
 */
function clearStaleIndicator_(sheetName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  
  var refreshTimeStr = getSheetLastRefreshedString(sheetName);
  
  // Formula-driven reports: show timestamp referencing cache freshness
  var formulaReports = ['PL', 'BS', 'CF', 'CF-skuld', 'SCE', 'Integrity', 'Integrity Check'];
  if (formulaReports.indexOf(sheetName) !== -1) {
    // Don't overwrite the report layout. Just reset tab color.
    try {
      var config = TAB_CONFIG[sheetName] || { color: null };
      sheet.setTabColor(config.color);
    } catch(e) {}
    return;
  }
  
  // Timestamp indicator disabled — B3 Refreshed timestamp is sufficient
  // var cell = sheet.getRange('C4');
  return;
  cell.setValue('Data as of: ' + refreshTimeStr);
  cell.setFontColor('#0f9d58'); // Google Green
  cell.setFontWeight('normal');
  
  // Reset tab color
  try {
    var config = TAB_CONFIG[sheetName] || { color: null };
    sheet.setTabColor(config.color);
  } catch(e) {}
}

/**
 * Utility function to get human-readable last refresh time for a sheet.
 */
function getSheetLastRefreshedString(sheetName) {
  var props = PropertiesService.getDocumentProperties();
  var iso = props.getProperty(KEY_SHEET_REFRESH_PREFIX + sheetName);
  if (!iso) return 'Never';
  var d = new Date(iso);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

// =============================================================================
// WRITE CONTROLS (Preventing Redundant Posts)
// =============================================================================

/**
 * Called by an onEdit(e) simple trigger.
 * Records that a user has modified an input/settings sheet.
 */
function recordSheetEdit(e) {
  if (!e || !e.source) return;
  var sheetName = e.source.getActiveSheet().getName();
  
  if (isInputOrSettingsSheet_(sheetName)) {
    var props = PropertiesService.getDocumentProperties();
    props.setProperty(KEY_SHEET_EDIT_PREFIX + sheetName, new Date().toISOString());
  }
}

/**
 * Enforces the "Post to database" edit check.
 * Called before posting data. Returns true if unposted edits exist.
 */
function hasUnpostedEdits(sheetName) {
  var props = PropertiesService.getDocumentProperties();
  var lastEditIso = props.getProperty(KEY_SHEET_EDIT_PREFIX + sheetName);
  var globalPostIso = props.getProperty(KEY_GLOBAL_DB_POST);
  
  if (!lastEditIso) return false; // No edits ever recorded for this sheet
  if (!globalPostIso) return true; // Edits exist, but global post never happened
  
  return new Date(lastEditIso) > new Date(globalPostIso);
}

/**
 * Wrapper to validate before posting.
 * Usage: if (!validateBeforePost('New Journal entry')) return;
 */
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

