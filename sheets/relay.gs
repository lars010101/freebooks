/**
 * Skuld — Apps Script Thin Relay
 * All business logic lives in Cloud Functions. This file only relays.
 */

// =============================================================================
// Core relay
// =============================================================================

function callSkuld_(action, payload) {
  var config = getConfig_();
  var body = { action: action, companyId: config.companyId, userEmail: Session.getActiveUser().getEmail() };
  if (payload) { for (var k in payload) body[k] = payload[k]; }
  var response = UrlFetchApp.fetch(config.functionUrl, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
    headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
  });
  var result = JSON.parse(response.getContentText());
  if (response.getResponseCode() !== 200) {
    throw new Error(result.error || 'Cloud Function error');
  }
  return result.data;
}

// =============================================================================
// Sidebar
// =============================================================================

function openSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('sidebar-entry').setTitle('⚖️ Skuld').setWidth(340);
  SpreadsheetApp.getUi().showSidebar(html);
}

// =============================================================================
// Sidebar: Entry tab helpers
// =============================================================================

function getSidebarInitData() {
  var accts = callSkuld_('coa.list', {});
  var vats = callSkuld_('vat.codes.list', {});
  return {
    accounts: (accts || []).map(function(a) { return { code: a.account_code, name: a.account_name, type: a.account_type }; }),
    vatCodes: (vats || []).map(function(v) { return { code: v.vat_code, rate: v.rate, description: v.description }; }),
    settings: getSettingsData()
  };
}

function getAccountList() {
  var result = callSkuld_('coa.list', {});
  return (result || []).map(function(a) { return { code: a.account_code, name: a.account_name, type: a.account_type }; });
}

function getVatCodeList() {
  var result = callSkuld_('vat.codes.list', {});
  return (result || []).map(function(v) { return { code: v.vat_code, rate: v.rate, description: v.description }; });
}

function postJournalFromSidebar(lines) {
  return callSkuld_('journal.post', { lines: lines, source: 'manual' });
}

function searchJournalEntries(query) {
  // Search by batch_id, reference, description, or amount
  var result = callSkuld_('journal.list', { limit: 50 });
  if (!result) return [];
  var q = query.toLowerCase();
  return result.filter(function(r) {
    return (r.batch_id && r.batch_id.toLowerCase().indexOf(q) >= 0)
      || (r.reference && r.reference.toLowerCase().indexOf(q) >= 0)
      || (r.description && r.description.toLowerCase().indexOf(q) >= 0)
      || (String(r.debit) === q || String(r.credit) === q);
  });
}

// =============================================================================
// Sidebar: Navigate tab helpers
// =============================================================================

function navigateToTab(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  // Create Journal tab if it doesn't exist
  if (name === 'Journal') {
    var jSheet = ss.getSheetByName('Journal');
    if (!jSheet) {
      jSheet = ss.insertSheet('Journal', 0);
      jSheet.setTabColor('#1a73e8');
      jSheet.setFrozenRows(1);
      var headers = ['Date', 'Batch ID', 'Account Code', 'Debit', 'Credit', 'Currency', 'Description', 'Reference', 'Source', 'VAT Code'];
      jSheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e6e6e6');
    }
    // Just activate — data loads on Refresh Active, not on navigate
    jSheet.showSheet();
    jSheet.activate();
    return;
  }

  // Create FX Rates tab if needed
  if (name === 'FX Rates') {
    var fxSheet = ss.getSheetByName('FX Rates');
    if (!fxSheet) {
      fxSheet = ss.insertSheet('FX Rates');
      fxSheet.setTabColor('#808080'); fxSheet.setFrozenRows(1);
      var h = ['Date', 'From', 'To', 'Rate', 'Source'];
      fxSheet.getRange(1,1,1,h.length).setValues([h]).setFontWeight('bold').setBackground('#e6e6e6');
    }
    fxSheet.showSheet(); fxSheet.activate();
    return;
  }

  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Tab not found: ' + name);
  sheet.showSheet();
  sheet.activate();
}

function runContextAction(action) {
  if (action === 'refreshAll') {
    refreshAllReports_();
    return '✅ All reports refreshed';
  }

  // Context-aware: what tab is active?
  var activeSheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getName();

  if (action === 'refresh') {
    return refreshTab_(activeSheet);
  }
  if (action === 'save') {
    return saveTab_(activeSheet);
  }
  return '❌ Unknown action';
}

function refreshTab_(name) {
  var params = getReportParams_();
  switch (name) {
    case 'Journal':
      navigateToTab('Journal');
      return '✅ Journal loaded';
    case 'TB':
      var r = callSkuld_('report.refresh_tb', params);
      if (r) writeReportToSheet_('TB', r);
      return '✅ Trial Balance refreshed';
    case 'PL':
      var r = callSkuld_('report.refresh_pl', params);
      if (r) writeReportToSheet_('PL', r);
      return '✅ P&L refreshed';
    case 'BS':
      var r = callSkuld_('report.refresh_bs', params);
      if (r) writeReportToSheet_('BS', r);
      return '✅ Balance Sheet refreshed';
    case 'CF':
      var r = callSkuld_('report.refresh_cf', params);
      if (r) writeReportToSheet_('CF', r);
      return '✅ Cash Flow refreshed';
    case 'AP Aging':
      var r = callSkuld_('report.refresh_ap_aging', {});
      if (r) writeReportToSheet_('AP Aging', r);
      return '✅ AP Aging refreshed';
    case 'VAT Return':
      var periodFrom = params.dateFrom || '2025-01-01';
      var periodTo = params.dateTo || '2025-12-31';
      var r = callSkuld_('report.refresh_vat_return', { periodFrom: periodFrom, periodTo: periodTo });
      if (r) writeReportToSheet_('VAT Return', r);
      return '✅ VAT Return refreshed';
    case 'COA':
      var r = callSkuld_('coa.list', {});
      if (r) writeToSheet_('COA', r, ['account_code', 'account_name', 'account_type', 'account_subtype', 'pl_category', 'bs_category', 'cf_category', 'is_active', 'effective_from', 'effective_to']);
      return '✅ COA loaded from database';
    case 'Mappings':
      var r = callSkuld_('mapping.list', {});
      if (r) writeToSheet_('Mappings', r, ['pattern', 'match_type', 'debit_account', 'credit_account', 'description_override', 'vat_code', 'cost_center', 'profit_center', 'priority', 'is_active']);
      return '✅ Mappings loaded from database';
    case 'Bills':
      var r = callSkuld_('bill.list', {});
      if (r) writeToSheet_('Bills', r, ['bill_id', 'vendor', 'vendor_ref', 'date', 'due_date', 'amount', 'currency', 'status', 'amount_paid']);
      return '✅ Bills refreshed';
    case 'Bank Processing':
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Bank Processing');
      var rows = readBankRows_(sheet);
      if (rows.length === 0) return '⚠️ No bank rows to process. Paste data first.';
      var r = callSkuld_('bank.process', { rows: rows });
      if (r) writeBankProcessingResults_(sheet, r.processed);
      return '✅ Processed: ' + r.summary.ruleMatched + ' matched, ' + r.summary.unmatched + ' unmatched';
    default:
      return '⚠️ No refresh action for tab: ' + name;
  }
}

function saveTab_(name) {
  switch (name) {
    case 'COA':
      var data = readSheetData_('COA');
      callSkuld_('coa.save', { accounts: data });
      return '✅ COA saved to database';
    case 'Mappings':
      var data = readSheetData_('Mappings');
      callSkuld_('mapping.save', { mappings: data });
      return '✅ Mappings saved to database';
    case 'Centers':
      var data = readSheetData_('Centers');
      callSkuld_('center.save', { centers: data });
      return '✅ Centers saved to database';
    case 'VAT Codes':
      var data = readSheetData_('VAT Codes');
      callSkuld_('vat.codes.save', { vatCodes: data });
      return '✅ VAT Codes saved to database';
    case 'Bank Processing':
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Bank Processing');
      var entries = readApprovedBankEntries_(sheet);
      var mappings = readNewMappings_(sheet);
      if (entries.length === 0) return '⚠️ No approved entries to post.';
      var r = callSkuld_('bank.approve', { entries: entries, newMappings: mappings });
      return '✅ Posted: ' + r.posted + ' entries' + (r.newMappings > 0 ? ', ' + r.newMappings + ' new mappings' : '');
    case 'Bills':
      // For bills, "save" creates a new bill from the last row
      var bill = readBillForm_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Bills'));
      if (!bill) return '⚠️ No bill data found.';
      var r = callSkuld_('bill.create', { bill: bill });
      if (r && r.created) return '✅ Bill created: ' + r.billId.substring(0, 8);
      return '❌ ' + (r && r.errors ? r.errors.join(', ') : 'Failed');
    default:
      return '⚠️ Tab "' + name + '" is read-only.';
  }
}

function refreshAllReports_() {
  var params = getReportParams_();
  var r;
  r = callSkuld_('report.refresh_tb', params); if (r) writeReportToSheet_('TB', r);
  r = callSkuld_('report.refresh_pl', params); if (r) writeReportToSheet_('PL', r);
  r = callSkuld_('report.refresh_bs', params); if (r) writeReportToSheet_('BS', r);
  r = callSkuld_('report.refresh_cf', params); if (r) writeReportToSheet_('CF', r);
  // Load journal
  var entries = callSkuld_('journal.list', { dateFrom: params.dateFrom, dateTo: params.dateTo, limit: 1000 });
  if (entries) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var jSheet = ss.getSheetByName('Journal');
    if (!jSheet) {
      jSheet = ss.insertSheet('Journal', 0);
      jSheet.setTabColor('#1a73e8'); jSheet.setFrozenRows(1);
      jSheet.getRange(1,1,1,10).setValues([['Date','Batch ID','Account Code','Debit','Credit','Currency','Description','Reference','Source','VAT Code']]).setFontWeight('bold').setBackground('#e6e6e6');
    }
    writeToSheet_('Journal', entries, ['date','batch_id','account_code','debit','credit','currency','description','reference','source','vat_code']);
  }
}

// =============================================================================
// Sidebar: Settings tab helpers
// =============================================================================

function getSettingsData() {
  var props = PropertiesService.getScriptProperties();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var settingsSheet = ss.getSheetByName('Settings');
  var settings = {};
  if (settingsSheet) {
    var data = settingsSheet.getDataRange().getValues();
    for (var i = 0; i < data.length; i++) {
      var k = String(data[i][0]).trim();
      var v = data[i][1];
      if (v instanceof Date) v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      if (k) settings[k] = v;
    }
  }
  return {
    companyId: props.getProperty('COMPANY_ID') || '',
    companyName: settings['Company Name'] || props.getProperty('COMPANY_ID') || '',
    fyStart: formatSettingDate_(settings['FY Start']) || '2025-01-01',
    fyEnd: formatSettingDate_(settings['FY End']) || '2025-12-31',
    periodFrom: formatSettingDate_(settings['Period From'] || settings['FY Start']) || '2025-01-01',
    periodTo: formatSettingDate_(settings['Period To'] || settings['FY End']) || '2025-12-31',
  };
}

function formatSettingDate_(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v);
}

function saveSettingsFromSidebar(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Settings');
  if (!sheet) return;
  var rows = [
    ['Company ID', PropertiesService.getScriptProperties().getProperty('COMPANY_ID')],
    ['Company Name', data.companyName],
    ['Cloud Function URL', PropertiesService.getScriptProperties().getProperty('SKULD_FUNCTION_URL')],
    ['', ''],
    ['FY Start', data.fyStart],
    ['FY End', data.fyEnd],
    ['Period From', data.periodFrom],
    ['Period To', data.periodTo],
    ['Cost Center', ''],
    ['Profit Center', ''],
  ];
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
}

function runSettingsAction(action) {
  switch (action) {
    case 'fetchFx':
      callSkuld_('fx.fetch_rates', {});
      return '✅ FX rates fetched from ECB';
    case 'backup':
      var result = callSkuld_('backup.export', {});
      if (result) {
        var fileName = result.companyId + '_' + result.exportedAt.substring(0, 10) + '.json';
        DriveApp.createFile(fileName, JSON.stringify(result, null, 2), 'application/json');
        return '✅ Backup saved: ' + fileName;
      }
      return '❌ Backup failed';
    default:
      return '❌ Unknown action';
  }
}

// =============================================================================
// Menu (minimal — sidebar is the main UI)
// =============================================================================

function onOpen() {
  SpreadsheetApp.getUi().createMenu('⚖️ Skuld')
    .addItem('Open Sidebar', 'openSidebar')
    .addItem('Refresh All Reports', 'onRefreshAll')
    .addSeparator()
    .addItem('Show All Tabs', 'showAllTabs')
    .addItem('Setup Auto-Open', 'setupTrigger')
    .addToUi();
}

function onRefreshAll() {
  refreshAllReports_();
  SpreadsheetApp.getUi().alert('✅ All reports refreshed.');
}

// =============================================================================
// Trigger setup
// =============================================================================

function onOpenInstallable() {
  onOpen();
  openSidebar();
  hideNonEssentialTabs_();
}

function setupTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'onOpenInstallable') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('onOpenInstallable').forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet()).onOpen().create();
  SpreadsheetApp.getUi().alert('✅ Auto-open trigger installed.');
}

function hideNonEssentialTabs_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hide = ['Import', 'Export', 'Centers', 'VAT Codes', 'Mappings', 'TB', 'PL', 'BS', 'CF', 'AP Aging', 'VAT Return', 'Manual Entry', 'Dashboard', 'Settings'];
  for (var i = 0; i < hide.length; i++) {
    var s = ss.getSheetByName(hide[i]);
    if (s) s.hideSheet();
  }
}

function showAllTabs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) sheets[i].showSheet();
}
