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
  try {
    var response = UrlFetchApp.fetch(config.functionUrl, {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
      headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
    });
    var result = JSON.parse(response.getContentText());
    if (response.getResponseCode() !== 200) {
      throw new Error(result.error || 'Cloud Function error: ' + response.getResponseCode());
    }
    return result.data;
  } catch (e) {
    throw new Error('Failed to call Skuld: ' + e.message);
  }
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
  // Lazy-load accounts/VAT only when user switches to Entry tab
  // This avoids blocking sidebar open with 8s of BigQuery calls
  return {
    accounts: [],
    vatCodes: [],
    settings: getSettingsData()
  };
}

// Called from sidebar when user switches to Entry tab (lazy load)
function getSidebarInitDataWithAccounts() {
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
  var result = callSkuld_('journal.list', {});
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

// Tab configuration: name, color, category (reports/data/config)
var TAB_CONFIG = {
  // REPORTS (blue)
  'Journal':        { color: '#1a73e8', category: 'reports', label: 'Journal' },
  'PL':             { color: '#1a73e8', category: 'reports', label: 'Profit & Loss' },
  'BS':             { color: '#1a73e8', category: 'reports', label: 'Balance Sheet' },
  'COA':            { color: '#1a73e8', category: 'reports', label: 'COA' },
  'Bank':           { color: '#1a73e8', category: 'reports', label: 'Bank' },
  'CF':             { color: '#1a73e8', category: 'reports', label: 'Cash Flow' },
  'CF-skuld':       { color: '#1a73e8', category: 'reports', label: 'Cash Flow (skuld)' },
  'SCE':            { color: '#1a73e8', category: 'reports', label: 'Changes in Equity' },
  'TB':             { color: '#1a73e8', category: 'reports', label: 'Trial Balance' },
  'AP Aging':       { color: '#1a73e8', category: 'reports', label: 'AP Aging' },
  'VAT Return':     { color: '#1a73e8', category: 'reports', label: 'VAT Return' },
  'Integrity':      { color: '#1a73e8', category: 'reports', label: 'Integrity Check' },
  'Dashboard':      { color: '#1a73e8', category: 'reports', label: 'Dashboard' },

  // DATA ENTRY (green)
  'Bank Processing': { color: '#34a853', category: 'data', label: 'Bank Processing' },
  'Bills':          { color: '#34a853', category: 'data', label: 'Bills' },
  'Import':         { color: '#34a853', category: 'data', label: 'Import' },

  // CONFIGURATION (gray)
  'Mappings':      { color: '#808080', category: 'config', label: 'Bank Mappings' },
  'Centers':        { color: '#808080', category: 'config', label: 'Profit / Cost Centers' },
  'VAT Codes':      { color: '#808080', category: 'config', label: 'VAT Codes' },
  'FX Rates':       { color: '#808080', category: 'config', label: 'FX Rates' },
  'Settings':       { color: '#808080', category: 'config', label: 'Settings' },
};

// Tab creation order (most frequent first within each category)
var TAB_ORDER = [
  // Reports - most frequent
  'Journal', 'PL', 'BS', 'Bank', 'CF', 'CF-skuld', 'SCE', 'TB', 'AP Aging', 'VAT Return', 'Integrity', 'Dashboard',
  // Data Entry
  'Bank Processing', 'Bills', 'Import',
  // Configuration
  'Mappings', 'Centers', 'VAT Codes', 'FX Rates', 'Settings'
];

function navigateToTab(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var config = TAB_CONFIG[name] || { color: '#5f6368', category: 'reports' };
  
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    // Create new sheet with appropriate color
    sheet = ss.insertSheet(name);
    sheet.setTabColor(config.color);
    sheet.setFrozenRows(1);
    
    // Add default headers for known sheets
    if (name === 'Journal') {
      var headers = ['Date', 'Batch ID', 'Account Code', 'Debit', 'Credit', 'Currency', 'Description', 'Reference', 'Source', 'VAT Code'];
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e6e6e6');
    } else if (name === 'FX Rates') {
      var h = ['Date', 'From', 'To', 'Rate', 'Source'];
      sheet.getRange(1,1,1,h.length).setValues([h]).setFontWeight('bold').setBackground('#e6e6e6');
    } else if (name === 'Import') {
      var h = ['Batch ID', 'Date', 'Account Code', 'Debit', 'Credit', 'Currency', 'FX Rate', 'Description', 'Reference', 'Source'];
      sheet.getRange(1,1,1,h.length).setValues([h]).setFontWeight('bold').setBackground('#fce8b2');
      sheet.getRange(2,1).setValue('Paste journal data below. Group lines by Batch ID. Hit Save to import.');
      sheet.getRange(2,1,1,h.length).merge().setFontStyle('italic').setFontColor('#666666');
    }
  }
  sheet.showSheet();
  sheet.activate();

  // Auto-build formula-driven skuld tabs when navigated to
  if (name === 'PL' || name === 'BS' || name === 'CF-skuld') {
    refreshTab_(name);
  }

  return sheet;
}

function runContextAction(action, period) {
  // Context-aware: what tab is active?
  var activeSheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getName();

  if (action === 'refresh') {
    return refreshTab_(activeSheet, period);
  }
  if (action === 'save') {
    return saveTab_(activeSheet);
  }
  return '❌ Unknown action';
}

function refreshTab_(name, period) {
  var params = period || getReportParams_();
  try {
    switch (name) {
    case 'Journal':
      navigateToTab('Journal');
      var entries = callSkuld_('journal.list', { dateFrom: params.dateFrom, dateTo: params.dateTo });
      if (entries) {
        writeToSheet_('Journal', entries, ['date','batch_id','account_code','debit','credit','currency','description','reference','source','vat_code']);
      }
      return '✅ Journal loaded (' + (entries ? entries.length : 0) + ' rows)';
    case 'TB':
      var r = callSkuld_('report.refresh_tb', params);
      if (r) writeReportToSheet_('TB', r);
      return '✅ Trial Balance refreshed';
    case 'PL':
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var coaSheet = ss.getSheetByName('COA');
      var cacheSheet = ss.getSheetByName('_CACHE_BALANCES');
      if (!coaSheet) return '❌ COA sheet not found';
      if (!cacheSheet) return '❌ _CACHE_BALANCES not found';
      try {
        buildPL_(ss.getSheetByName('PL'), ss);
      } catch (e) {
        return '❌ Error: ' + e.message;
      }
      return '✅ P&L rebuilt — change period in B3';
    case 'BS':
      var ss2 = SpreadsheetApp.getActiveSpreadsheet();
      var coaSheet2 = ss2.getSheetByName('COA');
      var cacheSheet2 = ss2.getSheetByName('_CACHE_BALANCES');
      if (!coaSheet2) return '❌ COA sheet not found';
      if (!cacheSheet2) return '❌ _CACHE_BALANCES not found';
      try {
        buildBS_(ss2.getSheetByName('BS'), ss2);
      } catch (e) {
        return '❌ Error: ' + e.message;
      }
      return '✅ Balance Sheet rebuilt — change period in B3';
    case 'CF':
      var r = callSkuld_('report.refresh_cf', params);
      if (r) writeReportToSheet_('CF', r);
      return '✅ Cash Flow refreshed';
    case 'CF-skuld':
      var ss2 = SpreadsheetApp.getActiveSpreadsheet();
      var coaSheet2 = ss2.getSheetByName('COA');
      var cacheSheet2 = ss2.getSheetByName('_CACHE_BALANCES');
      if (!coaSheet2)   return '❌ COA sheet not found';
      if (!cacheSheet2) return '❌ _CACHE_BALANCES not found';
      try {
        buildCF_(ss2.getSheetByName('CF-skuld'), ss2);
      } catch (e) {
        return '❌ Error: ' + e.message;
      }
      return '✅ Cash Flow (skuld) rebuilt — multi-period, all FY columns';
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
    case 'SCE':
      var r = callSkuld_('report.refresh_sce', params);
      if (r) writeReportToSheet_('SCE', r);
      return '✅ Statement of Changes in Equity refreshed';
    case 'Integrity':
      var r = callSkuld_('report.refresh_integrity', params);
      if (r) writeReportToSheet_('Integrity', r);
      var failCount = 0;
      if (r && r.checks) { for (var ci = 0; ci < r.checks.length; ci++) { for (var ii = 0; ii < (r.checks[ci].items||[]).length; ii++) { if ((r.checks[ci].items[ii].status||'').indexOf('❌') >= 0) failCount++; }}}
      return '✅ Integrity Check complete — ' + (failCount === 0 ? 'ALL PASSED ✅' : failCount + ' issue(s) found ❌');
    case '_CACHE_BALANCES':
      var r = callSkuld_('report.cache_balances', {});
      if (r && r.rows) writeToSheet_('_CACHE_BALANCES', r.rows, r.columns);
      if (r && r.columns) {
        // Timestamp goes in the column just beyond the last data column
        // Use r.columns.length (not getLastColumn which resets to 0 after sheet.clear())
        var triggerCol = r.columns.length + 1;
        var colLetter = colNumToLetter_(triggerCol);
        var cacheSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('_CACHE_BALANCES');
        var triggerRange = cacheSheet.getRange(colLetter + '1');
        triggerRange.setValue(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'));
        var ss = SpreadsheetApp.getActiveSpreadsheet();
        ss.setNamedRange('timestamp', triggerRange);
      }
      return '✅ Cache built with ' + (r.columns ? r.columns.length : 0) + ' periods';
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
  } catch (e) {
    return '❌ Error: ' + e.message;
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
    case 'Import':
      var importData = readImportData_();
      if (!importData || importData.length === 0) return '⚠️ No data found on Import sheet (need rows below header).';
      var r = callSkuld_('journal.import', { entries: importData });
      if (r && r.imported > 0) {
        return '✅ Imported ' + r.imported + ' entries (' + r.rowsInserted + ' lines)' +
               (r.failed > 0 ? ' — ⚠️ ' + r.failed + ' failed' : '');
      }
      if (r && r.errors && r.errors.length > 0) {
        var errMsg = r.errors.slice(0, 5).map(function(e) { return 'Entry ' + e.entry + ': ' + e.errors.join(', '); }).join('\n');
        return '❌ Import failed:\n' + errMsg;
      }
      return '❌ Import failed (unknown error)';
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
  r = callSkuld_('report.refresh_cf', params); if (r) writeReportToSheet_('CF', r);
  // Load journal
  var entries = callSkuld_('journal.list', { dateFrom: params.dateFrom, dateTo: params.dateTo });
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
  // Fetch FY dates from BigQuery (companies table) as fallback
  var fyFromBQ = { fyStart: '', fyEnd: '' };
  try {
    var companyData = callSkuld_('settings.get', {});
    if (companyData && companyData.fyStart) {
      fyFromBQ.fyStart = companyData.fyStart;
      fyFromBQ.fyEnd = companyData.fyEnd;
    }
  } catch (e) { /* ignore — use fallbacks */ }

  return {
    companyId: props.getProperty('COMPANY_ID') || '',
    companyName: settings['Company Name'] || props.getProperty('COMPANY_ID') || '',
    fyStart: fyFromBQ.fyStart || formatSettingDate_(settings['FY Start']) || '2025-01-01',
    fyEnd: fyFromBQ.fyEnd || formatSettingDate_(settings['FY End']) || '2025-12-31',
    periodFrom: formatSettingDate_(settings['Period From']) || fyFromBQ.fyStart || formatSettingDate_(settings['FY Start']) || '2025-01-01',
    periodTo: formatSettingDate_(settings['Period To']) || fyFromBQ.fyEnd || formatSettingDate_(settings['FY End']) || '2025-12-31',
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
      var fxResult = callSkuld_('fx.fetch_rates', {});
      if (fxResult && fxResult.rates) {
        // Write rates to FX Rates sheet
        var fxSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('FX Rates');
        if (!fxSheet) {
          fxSheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet('FX Rates');
          fxSheet.setTabColor('#808080');
          fxSheet.setFrozenRows(1);
          fxSheet.getRange(1,1,1,5).setValues([['Date','From','To','Rate','Source']]).setFontWeight('bold').setBackground('#e6e6e6');
        }
        var rateData = fxResult.rates.map(function(r) {
          return [r.date, r.from_currency, r.to_currency, r.rate, r.source];
        });
        fxSheet.getRange(2, 1, rateData.length, 5).setValues(rateData);
        fxSheet.getRange(2, 1, rateData.length, 5).setNumberFormat('0.000000');
        fxSheet.autoResizeColumns();
      }
      return '✅ FX rates fetched: ' + (fxResult ? fxResult.rateCount + ' rates' : 'none');
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
  var hide = ['Import', 'Centers', 'VAT Codes', 'Mappings', 'TB', 'CF', 'AP Aging', 'VAT Return', 'SCE', 'Integrity', 'Manual Entry', 'Dashboard', 'Settings'];
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

// Helper: Convert 1-based column number to Excel-style letter (1->A, 27->AA, etc.)
function colNumToLetter_(n) {
  var letter = '';
  while (n > 0) {
    var mod = (n - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

// =============================================================================
// skuld-based report tabs (formula-driven, reads from _CACHE_BALANCES)
// =============================================================================

/**
 * Build or refresh the PL tab using skuld() formulas.
 * Reads P&L accounts from the COA tab and creates a formatted P&L report.
 */
function buildPL_(sheet, ss) {
  var coaSheet = ss.getSheetByName('COA');
  var cacheSheet = ss.getSheetByName('_CACHE_BALANCES');
  if (!coaSheet) { Logger.log('PL error: COA sheet not found'); return; }
  if (!cacheSheet) { Logger.log('PL error: _CACHE_BALANCES sheet not found'); return; }

  // Get COA data
  var coaData = coaSheet.getDataRange().getValues();
  var headers = coaData[0];
  var acctCodeIdx = headers.indexOf('Account Code');
  var acctNameIdx = headers.indexOf('Account Name');
  var acctTypeIdx = headers.indexOf('Account Type');
  var plCatIdx = headers.indexOf('PL Category');

  // Collect P&L accounts (Revenue + Expense), sorted by type then code
  var plAccounts = [];
  for (var i = 1; i < coaData.length; i++) {
    var row = coaData[i];
    var type = String(row[acctTypeIdx] || '').trim();
    if (type === 'Revenue' || type === 'Expense') {
      plAccounts.push({
        code: String(row[acctCodeIdx] || '').trim(),
        name: String(row[acctNameIdx] || '').trim(),
        type: type,
        plCategory: String(row[plCatIdx] || '').trim()
      });
    }
  }
  plAccounts.sort(function(a, b) {
    if (a.type !== b.type) return a.type === 'Revenue' ? -1 : 1;
    return a.code.localeCompare(b.code, undefined, {numeric: true});
  });

  // Get company name and currency from Settings
  var companyName = '', currency = '';
  var settingsSheet = ss.getSheetByName('Settings');
  if (settingsSheet) {
    var sData = settingsSheet.getDataRange().getValues();
    for (var s = 0; s < sData.length; s++) {
      var k = String(sData[s][0] || '').trim().toLowerCase();
      if (k === 'company') companyName = String(sData[s][1] || '').trim();
      if (k === 'currency') currency = String(sData[s][1] || '').trim();
    }
  }

  // Clear and prepare sheet
  sheet.clear();
  sheet.setColumnWidth(1, 100);  // Account code (pure, for skuld lookup)
  sheet.setColumnWidth(2, 300);  // Account name (VLOOKUP from COA)
  sheet.setColumnWidth(3, 160);  // Balance (skuld formula)

  // Row 1: Company header
  sheet.getRange(1, 1).setValue('Company').setFontWeight('bold');
  sheet.getRange(1, 2).setValue(companyName).setFontWeight('bold');
  sheet.getRange(1, 3).setValue('');

  // Row 2: Currency
  sheet.getRange(2, 1).setValue('Currency').setFontWeight('bold');
  sheet.getRange(2, 2).setValue(currency);

  // Row 3: Period selector
  sheet.getRange(3, 1).setValue('Period').setFontWeight('bold');
  sheet.getRange(3, 2).setValue('FY2025').setFontWeight('bold');
  sheet.getRange(3, 2).setBackground('#e8f0fe');

  // Row 4: Separator
  sheet.getRange('4:4').setBackground('#eeeeee');

  var row = 5;

  // REVENUE section
  sheet.getRange(row, 1).setValue('REVENUE').setFontWeight('bold').setFontSize(11);
  sheet.getRange(row, 1, 1, 3).setBackground('#f0f0f0');
  row++;

  var revStart = row;
  for (var i = 0; i < plAccounts.length; i++) {
    var acct = plAccounts[i];
    if (acct.type !== 'Revenue') continue;
    // Col A: pure account code
    sheet.getRange(row, 1).setValue(acct.code);
    // Col B: VLOOKUP name from COA
    sheet.getRange(row, 2).setFormula('=IFERROR(VLOOKUP(A' + row + ',COA!A:B,2,FALSE),"")');
    // Col C: skuld P&L movement — delta=true for period movement from cumulative cache
    sheet.getRange(row, 3).setFormula('=skuld(timestamp,B$3,A' + row + ',true)');
    sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
    row++;
  }
  var revEnd = row - 1;

  // TOTAL REVENUE row
  if (revEnd >= revStart) {
    sheet.getRange(row, 1).setValue('TOTAL REVENUE').setFontWeight('bold');
    sheet.getRange(row, 3).setFormula('=SUM(C' + String(revStart) + ':C' + String(revEnd) + ')').setFontWeight('bold');
    sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
    sheet.getRange(row, 1, 1, 3).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  }
  row++;
  sheet.getRange(row + ':' + row).setBackground('#eeeeee');
  row++;

  // EXPENSES section
  sheet.getRange(row, 1).setValue('EXPENSES').setFontWeight('bold').setFontSize(11);
  sheet.getRange(row, 1, 1, 3).setBackground('#f0f0f0');
  row++;

  var expStart = row;
  for (var i = 0; i < plAccounts.length; i++) {
    var acct = plAccounts[i];
    if (acct.type !== 'Expense') continue;
    // Col A: pure account code
    sheet.getRange(row, 1).setValue(acct.code);
    // Col B: VLOOKUP name from COA
    sheet.getRange(row, 2).setFormula('=IFERROR(VLOOKUP(A' + row + ',COA!A:B,2,FALSE),"")');
    // Col C: skuld expense movement — delta=true for period movement
    sheet.getRange(row, 3).setFormula('=skuld(timestamp,B$3,A' + row + ',true)');
    sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
    row++;
  }
  var expEnd = row - 1;

  // TOTAL EXPENSES row
  if (expEnd >= expStart) {
    sheet.getRange(row, 1).setValue('TOTAL EXPENSES').setFontWeight('bold');
    sheet.getRange(row, 3).setFormula('=SUM(C' + String(expStart) + ':C' + String(expEnd) + ')').setFontWeight('bold');
    sheet.getRange(row, 2).setNumberFormat('#,##0.00;(#,##0.00);0.00');
    sheet.getRange(row, 1, 1, 3).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  }
  row++;
  sheet.getRange(row + ':' + row).setBackground('#eeeeee');
  row++;

  // NET PROFIT / (LOSS) — depends on rev total at row-6 and exp total at row-3
  // Find the TOTAL REVENUE and TOTAL EXPENSES row indices
  // (we'll just use absolute references once we know them)
  var totRevRow = revEnd + 1;
  var totExpRow = expEnd + 1;
  sheet.getRange(row, 1).setValue('NET PROFIT / (LOSS)').setFontWeight('bold').setFontSize(11);
  sheet.getRange(row, 3).setFormula('=C' + totRevRow + '-C' + totExpRow).setFontWeight('bold').setFontSize(11);
  sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  sheet.getRange(row, 1, 1, 3).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sheet.setFrozenRows(4);
}

/**
 * Build or refresh the BS tab using skuld() formulas.
 */
function buildBS_(sheet, ss) {
  var coaSheet = ss.getSheetByName('COA');
  if (!coaSheet) { Logger.log('BS error: COA sheet not found'); return; }

  var coaData = coaSheet.getDataRange().getValues();
  var headers = coaData[0];
  var acctCodeIdx = headers.indexOf('Account Code');
  var acctNameIdx = headers.indexOf('Account Name');
  var acctTypeIdx = headers.indexOf('Account Type');
  var bsCatIdx = headers.indexOf('BS Category');

  var bsAccounts = [];
  for (var i = 1; i < coaData.length; i++) {
    var row = coaData[i];
    var type = String(row[acctTypeIdx] || '').trim();
    var code = String(row[acctCodeIdx] || '').trim();
    // Exclude 999999 closing/clearing account
    if (code.indexOf('999999') === 0) continue;
    if (type === 'Asset' || type === 'Liability' || type === 'Equity') {
      bsAccounts.push({
        code: code,
        name: String(row[acctNameIdx] || '').trim(),
        type: type,
        bsCategory: String(row[bsCatIdx] || '').trim()
      });
    }
  }
  // Sort: Asset, Liability, Equity, then by code
  bsAccounts.sort(function(a, b) {
    var order = {Asset: 1, Liability: 2, Equity: 3};
    var oa = order[a.type] || 4, ob = order[b.type] || 4;
    if (oa !== ob) return oa - ob;
    return a.code.localeCompare(b.code, undefined, {numeric: true});
  });

  var companyName = '', currency = '';
  var settingsSheet = ss.getSheetByName('Settings');
  if (settingsSheet) {
    var sData = settingsSheet.getDataRange().getValues();
    for (var s = 0; s < sData.length; s++) {
      var k = String(sData[s][0] || '').trim().toLowerCase();
      if (k === 'company') companyName = String(sData[s][1] || '').trim();
      if (k === 'currency') currency = String(sData[s][1] || '').trim();
    }
  }

  sheet.clear();
  sheet.setColumnWidth(1, 100);
  sheet.setColumnWidth(2, 300);
  sheet.setColumnWidth(3, 160);

  sheet.getRange(1, 1).setValue('Company').setFontWeight('bold');
  sheet.getRange(1, 2).setValue(companyName).setFontWeight('bold');
  sheet.getRange(2, 1).setValue('Currency').setFontWeight('bold');
  sheet.getRange(2, 2).setValue(currency);
  sheet.getRange(3, 1).setValue('Period').setFontWeight('bold');
  sheet.getRange(3, 2).setValue('FY2025').setFontWeight('bold');
  sheet.getRange(3, 2).setBackground('#e8f0fe');
  sheet.getRange('4:4').setBackground('#eeeeee');

  var row = 5;
  var sections = {Asset: {start: null, end: null}, Liability: {start: null, end: null}, Equity: {start: null, end: null}};
  var currentSection = null;

  for (var i = 0; i < bsAccounts.length; i++) {
    var acct = bsAccounts[i];
    if (acct.type !== currentSection) {
      if (currentSection !== null) {
        sections[currentSection].end = row - 1;
      }
      currentSection = acct.type;
      sections[currentSection].start = row;
      sheet.getRange(row, 1).setValue(currentSection.toUpperCase()).setFontWeight('bold').setFontSize(11);
      sheet.getRange(row, 1, 1, 3).setBackground('#f0f0f0');
      row++;
    }
    sheet.getRange(row, 1).setValue(acct.code);
    sheet.getRange(row, 2).setFormula('=IFERROR(VLOOKUP(A' + row + ',COA!A:B,2,FALSE),"")');
    // Assets: raw (positive debit balance). L+E: negate (credit balance shown as positive).
    var sign = (acct.type === 'Liability' || acct.type === 'Equity') ? '=-' : '=';
    sheet.getRange(row, 3).setFormula(sign + 'skuld(timestamp,B$3,A' + row + ')');
    sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
    row++;
  }
  if (currentSection !== null) sections[currentSection].end = row - 1;

  // Write section totals
  var startRow = 5;
  sheet.getRange(row, 1).setValue('TOTAL ASSETS').setFontWeight('bold');
  if (sections.Asset.start && sections.Asset.end) {
    sheet.getRange(row, 3).setFormula('=SUM(C' + sections.Asset.start + ':C' + sections.Asset.end + ')').setFontWeight('bold');
  }
  sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  sheet.getRange(row, 1, 1, 3).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  row++;
  sheet.getRange(row, 1).setValue('TOTAL LIABILITIES').setFontWeight('bold');
  if (sections.Liability.start && sections.Liability.end) {
    sheet.getRange(row, 3).setFormula('=SUM(C' + sections.Liability.start + ':C' + sections.Liability.end + ')').setFontWeight('bold');
  }
  sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  sheet.getRange(row, 1, 1, 3).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  row++;
  sheet.getRange(row, 1).setValue('TOTAL EQUITY').setFontWeight('bold');
  if (sections.Equity.start && sections.Equity.end) {
    sheet.getRange(row, 3).setFormula('=SUM(C' + sections.Equity.start + ':C' + sections.Equity.end + ')').setFontWeight('bold');
  }
  sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  sheet.getRange(row, 1, 1, 3).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  sheet.setFrozenRows(4);
}

/**
 * Build the CF-skuld tab.
 *
 * Cache stores SUM(debit - credit) per account per period (movements).
 * CF needs: cumulative balances for cash, negated movements for everything.
 *
 * Sign convention:
 *   Cache value = SUM(debit - credit)
 *   CF impact = -(debit - credit) = credit - debit for ALL BS accounts
 *   Net Income = SUM(credit - debit) for P&L = -SUM(debit - credit) = negate cache
 *   Opening Cash = skuld(priorFY, cashCode) = cumulative balance (direct read)
 *   CHECK = skuld(B3, cashCode) = cumulative balance (direct read)
 */
function buildCF_(sheet, ss) {
  var coaSheet    = ss.getSheetByName('COA');
  var cacheSheet  = ss.getSheetByName('_CACHE_BALANCES');
  if (!coaSheet)   { Logger.log('CF error: COA sheet not found');        return; }
  if (!cacheSheet) { Logger.log('CF error: _CACHE_BALANCES not found');   return; }

  // ── Read COA ─────────────────────────────────────────────────────────────────
  var coaData = coaSheet.getDataRange().getValues();
  var cHdrs  = coaData[0];
  var cCode  = cHdrs.indexOf('Account Code');
  var cName  = cHdrs.indexOf('Account Name');
  var cType  = cHdrs.indexOf('Account Type');
  var cCFCat = cHdrs.indexOf('CF Category');

  var opAccts = [], invAccts = [], finAccts = [], cashAccts = [];

  for (var i = 1; i < coaData.length; i++) {
    var row2 = coaData[i];
    var type  = String(row2[cType]  || '').trim();
    var code  = String(row2[cCode]  || '').trim();
    var cfCat = String(row2[cCFCat] || '').trim();
    if (!code) continue;
    if (type === 'Asset' || type === 'Liability' || type === 'Equity') {
      if      (cfCat === 'Cash')                           cashAccts.push({ code: code, type: type });
      else if (cfCat === 'Op-WC' || cfCat === 'Op-NonCash') opAccts.push({ code: code, type: type });
      else if (cfCat === 'Investing')                      invAccts.push({ code: code, type: type });
      else if (cfCat === 'Financing')                      finAccts.push({ code: code, type: type });
    }
  }
  function byCode(a, b) { return a.code.localeCompare(b.code, undefined, { numeric: true }); }
  opAccts.sort(byCode); invAccts.sort(byCode); finAccts.sort(byCode); cashAccts.sort(byCode);

  // ── Read cache FY periods (for prior period lookup) ──────────────────────────
  var cacheData = cacheSheet.getDataRange().getValues();
  var cacheHdrs = cacheData[0];
  var fyPeriods = [];
  for (var ci = 0; ci < cacheHdrs.length; ci++) {
    var h = String(cacheHdrs[ci] || '').trim();
    if (/^FY\d{4}$/.test(h)) fyPeriods.push(h);
  }
  fyPeriods.sort();

  // ── Company / Currency ───────────────────────────────────────────────────────
  var companyName = '', currency = '';
  var settingsSheet = ss.getSheetByName('Settings');
  if (settingsSheet) {
    var sData = settingsSheet.getDataRange().getValues();
    for (var s = 0; s < sData.length; s++) {
      var k = String(sData[s][0] || '').trim().toLowerCase();
      if (k === 'company')  companyName = String(sData[s][1] || '').trim();
      if (k === 'currency') currency     = String(sData[s][1] || '').trim();
    }
  }

  // ── Sheet setup ─────────────────────────────────────────────────────────────
  sheet.clear();
  sheet.setColumnWidth(1, 110);
  sheet.setColumnWidth(2, 295);
  sheet.setColumnWidth(3, 168);

  sheet.getRange(1, 1).setValue('Company').setFontWeight('bold');
  sheet.getRange(1, 2).setValue(companyName).setFontWeight('bold');
  sheet.getRange(2, 1).setValue('Currency').setFontWeight('bold');
  sheet.getRange(2, 2).setValue(currency);
  sheet.getRange(3, 1).setValue('Period').setFontWeight('bold');
  sheet.getRange(3, 2).setValue('FY2026').setFontWeight('bold');
  sheet.getRange(3, 2).setBackground('#e8f0fe');

  // Row 3, Col C: compute prior period name dynamically
  // ="FY"&(VALUE(RIGHT(B3,4))-1) → e.g. "FY2025" when B3="FY2026"
  sheet.getRange(3, 3).setFormula('="FY"&(VALUE(RIGHT(B3,4))-1)');
  sheet.getRange(3, 3).setFontColor('#ffffff');  // hide it

  sheet.getRange('4:4').setBackground('#eeeeee');

  var row = 5;

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function secHdr(label) {
    sheet.getRange(row, 2).setValue(label).setFontWeight('bold').setFontSize(11);
    sheet.getRange(row, 1, 1, 3).setBackground('#d0d0d0');
    sheet.getRange(row, 1, 1, 3).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
    row++;
  }

  // Write a CF account row
  // The cache stores debit-credit. CF impact = -(debit-credit) for ALL BS accounts.
  // So every row is: =-skuld(timestamp, B$3, code, false)
  function cfAcctRow(code) {
    sheet.getRange(row, 1).setValue(code);
    sheet.getRange(row, 2).setFormula('=IFERROR(VLOOKUP(A' + row + ',COA!A:B,2,FALSE),"")');
    sheet.getRange(row, 3).setFormula('=-skuld(timestamp,B$3,A' + row + ',true)');
    sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
    row++;
  }

  // Section total
  function secTotal(label, startRow, endRow, bg) {
    if (endRow < startRow) { row++; return null; }
    sheet.getRange(row, 2).setValue(label).setFontWeight('bold');
    sheet.getRange(row, 3).setFormula('=SUM(C' + startRow + ':C' + endRow + ')').setFontWeight('bold');
    sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
    if (bg) sheet.getRange(row, 1, 1, 3).setBackground(bg);
    sheet.getRange(row, 1, 1, 3).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
    var r = row; row++;
    return r;
  }

  // ── OPERATING ACTIVITIES ─────────────────────────────────────────────────────
  // In indirect method: starts with "Cash from operations" which includes Net Income
  // Net Income = -(sum of all P&L account movements) = SUM(credit-debit) for P&L
  // Since cache stores debit-credit, Net Income = -SUM(cache P&L values for period)
  // We use: =-skuld(timestamp, B$3, "pnl") ... but skuld("pnl") returns array, not scalar.
  // Instead, compute inline: Net Income is implicit in "Cash from operations" line.
  // The original report shows one line "Cash from operations" = NI + WC adjustments.
  // We replicate that: NI row + individual WC rows, then "Net cash from operating" = sum.

  secHdr('Operating Activities');
  // Net Income row (label: Cash from operations (NI))
  var niRow = row;
  sheet.getRange(row, 2).setValue('Cash from operations (Net Income)');
  // =-skuld(timestamp, B$3, "pnl") won't work (returns array). Sum individual P&L accounts.
  // Use SUMPRODUCT or build inline: need all P&L account codes.
  // Build formula: -(skuld(B3,code1)+skuld(B3,code2)+...)
  var plCodes = [];
  for (var i = 1; i < coaData.length; i++) {
    var type = String(coaData[i][cType] || '').trim();
    var code = String(coaData[i][cCode] || '').trim();
    if (!code) continue;
    if (type === 'Revenue' || type === 'Expense') plCodes.push(code);
  }
  if (plCodes.length > 0) {
    var plParts = plCodes.map(function(c) { return 'skuld(timestamp,B$3,' + c + ',true)'; });
    sheet.getRange(row, 3).setFormula('=-(' + plParts.join('+') + ')');
  } else {
    sheet.getRange(row, 3).setValue(0);
  }
  sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  row++;

  // WC adjustment rows
  var opS = row;
  for (var i = 0; i < opAccts.length; i++) cfAcctRow(opAccts[i].code);
  var opE = row - 1;
  // "Net cash from operating" = NI + sum of WC adjustments
  var opTotRow = row;
  sheet.getRange(row, 2).setValue('Net cash from operating').setFontWeight('bold');
  if (opE >= opS) {
    sheet.getRange(row, 3).setFormula('=C' + niRow + '+SUM(C' + opS + ':C' + opE + ')').setFontWeight('bold');
  } else {
    sheet.getRange(row, 3).setFormula('=C' + niRow).setFontWeight('bold');
  }
  sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  sheet.getRange(row, 1, 1, 3).setBackground('#e0e0e0');
  sheet.getRange(row, 1, 1, 3).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  row++;

  // ── INVESTING ────────────────────────────────────────────────────────────────
  secHdr('Investing Activities');
  var invS = row;
  for (var i = 0; i < invAccts.length; i++) cfAcctRow(invAccts[i].code);
  var invE = row - 1;
  var invTot = secTotal('Net cash from investing', invS, invE, '#e0e0e0');

  // ── FINANCING ────────────────────────────────────────────────────────────────
  secHdr('Financing Activities');
  var finS = row;
  for (var i = 0; i < finAccts.length; i++) cfAcctRow(finAccts[i].code);
  var finE = row - 1;
  var finTot = secTotal('Net cash from financing', finS, finE, '#e0e0e0');

  // ── UNCLASSIFIED ─────────────────────────────────────────────────────────────
  row++;
  sheet.getRange(row, 2).setValue('Unclassified');
  sheet.getRange(row, 3).setValue(0).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  row++;

  // ── NET CHANGE IN CASH ───────────────────────────────────────────────────────
  var netCashRow = row;
  sheet.getRange(row, 2).setValue('Net change in cash').setFontWeight('bold');
  sheet.getRange(row, 1, 1, 3).setBackground('#c8c8c8');
  var ncParts = ['C' + opTotRow];
  if (invTot) ncParts.push('C' + invTot);
  if (finTot) ncParts.push('C' + finTot);
  sheet.getRange(row, 3).setFormula('=(' + ncParts.join('+') + ')').setFontWeight('bold');
  sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  sheet.getRange(row, 1, 1, 3).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  row++;

  // ── CASH AT BEGINNING OF PERIOD ──────────────────────────────────────────────
  // Cumulative cash balance for all periods BEFORE selected period.
  // Use skuld("cum") with the prior period (C3 holds prior FY name).
  var openRow = row;
  if (cashAccts.length > 0) {
    var openParts = cashAccts.map(function(a) {
      return 'skuld(timestamp,C$3,' + a.code + ')';
    }).join('+');
    sheet.getRange(row, 2).setValue('Cash at beginning of period');
    sheet.getRange(row, 3).setFormula('=' + openParts);
  } else {
    sheet.getRange(row, 2).setValue('Cash at beginning of period');
    sheet.getRange(row, 3).setValue(0);
  }
  sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  row++;

  // ── CASH AT END OF PERIOD ────────────────────────────────────────────────────
  var closeRow = row;
  sheet.getRange(row, 2).setValue('Cash at end of period').setFontWeight('bold').setFontSize(11);
  sheet.getRange(row, 1, 1, 3).setBackground('#c0c0c0');
  sheet.getRange(row, 3).setFormula('=C' + openRow + '+C' + netCashRow).setFontWeight('bold').setFontSize(11);
  sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  sheet.getRange(row, 1, 1, 3).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  row++;

  // ── CHECK vs BS ──────────────────────────────────────────────────────────────
  // BS cash balance = cumulative sum of cash accounts through selected period
  if (cashAccts.length > 0) {
    var bsParts = cashAccts.map(function(a) {
      return 'skuld(timestamp,B$3,' + a.code + ')';
    }).join('+');
    var checkRow = row;
    sheet.getRange(row, 2).setValue('CHECK: BS cash balance').setFontStyle('italic').setFontColor('#555555');
    sheet.getRange(row, 3).setFormula('=' + bsParts).setFontStyle('italic').setFontColor('#555555');
    sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
    row++;
    sheet.getRange(row, 2).setValue('Difference').setFontStyle('italic').setFontColor('#555555');
    sheet.getRange(row, 3).setFormula('=C' + closeRow + '-C' + checkRow).setFontStyle('italic').setFontColor('#555555');
    sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  }

  sheet.setFrozenRows(4);
  Logger.log('CF-skuld built: %d rows', row);
}
