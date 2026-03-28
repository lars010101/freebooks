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
  'PL-skuld':       { color: '#1a73e8', category: 'reports', label: 'P&L (skuld)' },
  'BS':             { color: '#1a73e8', category: 'reports', label: 'Balance Sheet' },
  'BS-skuld':       { color: '#1a73e8', category: 'reports', label: 'BS (skuld)' },
  'COA':            { color: '#1a73e8', category: 'reports', label: 'COA' },
  'Bank':           { color: '#1a73e8', category: 'reports', label: 'Bank' },
  'CF':             { color: '#1a73e8', category: 'reports', label: 'Cash Flow' },
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
  'Journal', 'PL', 'BS', 'Bank', 'CF', 'SCE', 'TB', 'AP Aging', 'VAT Return', 'Integrity', 'Dashboard',
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
      var r = callSkuld_('report.refresh_pl', params);
      if (r) writeReportToSheet_('PL', r);
      return '✅ P&L refreshed';
    case 'PL-skuld':
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var coaSheet = ss.getSheetByName('COA');
      var cacheSheet = ss.getSheetByName('_CACHE_BALANCES');
      if (!coaSheet) return '❌ COA sheet not found — please refresh COA first';
      if (!cacheSheet) return '❌ _CACHE_BALANCES not found — please rebuild cache first';
      var plSkuldSheet = navigateToTab('PL-skuld');
      buildSkuldPL_(plSkuldSheet, ss);
      return '✅ P&L (skuld) built — change period in B3';
    case 'BS':
      var r = callSkuld_('report.refresh_bs', params);
      if (r) writeReportToSheet_('BS', r);
      return '✅ Balance Sheet refreshed';
    case 'BS-skuld':
      var ss2 = SpreadsheetApp.getActiveSpreadsheet();
      var coaSheet2 = ss2.getSheetByName('COA');
      var cacheSheet2 = ss2.getSheetByName('_CACHE_BALANCES');
      if (!coaSheet2) return '❌ COA sheet not found — please refresh COA first';
      if (!cacheSheet2) return '❌ _CACHE_BALANCES not found — please rebuild cache first';
      var bsSkuldSheet = navigateToTab('BS-skuld');
      buildSkuldBS_(bsSkuldSheet, ss2);
      return '✅ BS (skuld) built — change period in B3';
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
      var cacheSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('_CACHE_BALANCES');
      if (cacheSheet) {
        // Dynamically find the column just beyond the last data column for the trigger cell
        var triggerCol = cacheSheet.getLastColumn() + 1;
        var colLetter = colNumToLetter_(triggerCol);
        var triggerRange = cacheSheet.getRange(colLetter + '1');
        triggerRange.setValue(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'));
        // Ensure timestamp named range always points to this trigger cell
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
  r = callSkuld_('report.refresh_pl', params); if (r) writeReportToSheet_('PL', r);
  r = callSkuld_('report.refresh_bs', params); if (r) writeReportToSheet_('BS', r);
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
  var hide = ['Import', 'Centers', 'VAT Codes', 'Mappings', 'TB', 'PL', 'BS', 'CF', 'AP Aging', 'VAT Return', 'SCE', 'Integrity', 'Manual Entry', 'Dashboard', 'Settings'];
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
 * Build or refresh the PL-skuld tab using skuld() formulas.
 * Reads P&L accounts from the COA tab and creates a formatted P&L report.
 */
function buildSkuldPL_(sheet, ss) {
  var coaSheet = ss.getSheetByName('COA');
  var cacheSheet = ss.getSheetByName('_CACHE_BALANCES');
  if (!coaSheet) { Logger.log('PL-skuld error: COA sheet not found'); return; }
  if (!cacheSheet) { Logger.log('PL-skuld error: _CACHE_BALANCES sheet not found'); return; }

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
  sheet.setColumnWidth(1, 400);
  sheet.setColumnWidth(2, 160);
  sheet.setColumnWidth(3, 160);

  // Row 1: Company header
  sheet.getRange(1, 1).setValue('Company').setFontWeight('bold');
  sheet.getRange(1, 2).setValue(companyName).setFontWeight('bold');
  sheet.getRange(1, 3).setValue('');

  // Row 2: Currency
  sheet.getRange(2, 1).setValue('Currency').setFontWeight('bold');
  sheet.getRange(2, 2).setValue(currency);

  // Row 3: Period selector label + cell (C3 = period input)
  sheet.getRange(3, 1).setValue('Period').setFontWeight('bold');
  sheet.getRange(3, 2).setValue('FY2025').setFontWeight('bold'); // default
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
    sheet.getRange(row, 1).setValue(acct.code + '  ' + acct.name);
    // skuld formula: =skuld(timestamp, period, accountCode)
    sheet.getRange(row, 2).setFormula("=skuld('_CACHE_BALANCES'!ZZ1,B3,A" + row + ")");
    sheet.getRange(row, 2).setNumberFormat('#,##0.00;(#,##0.00);0.00');
    row++;
  }
  var revEnd = row - 1;

  // TOTAL REVENUE row
  if (revEnd >= revStart) {
    sheet.getRange(row, 1).setValue('TOTAL REVENUE').setFontWeight('bold');
    sheet.getRange(row, 2).setFormula('=SUMIF(A' + revStart + ':A' + revEnd + ',"3*",B' + revStart + ':B' + revEnd + ')').setFontWeight('bold');
    sheet.getRange(row, 2).setNumberFormat('#,##0.00;(#,##0.00);0.00');
    sheet.getRange(row, 1, 1, 2).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
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
    sheet.getRange(row, 1).setValue(acct.code + '  ' + acct.name);
    sheet.getRange(row, 2).setFormula("=skuld('_CACHE_BALANCES'!ZZ1,B3,A" + row + ")");
    sheet.getRange(row, 2).setNumberFormat('#,##0.00;(#,##0.00);0.00');
    row++;
  }
  var expEnd = row - 1;

  // TOTAL EXPENSES row
  if (expEnd >= expStart) {
    sheet.getRange(row, 1).setValue('TOTAL EXPENSES').setFontWeight('bold');
    sheet.getRange(row, 2).setFormula('=SUMIF(A' + expStart + ':A' + expEnd + ',"4*",B' + expStart + ':B' + expEnd + ')').setFontWeight('bold');
    sheet.getRange(row, 2).setNumberFormat('#,##0.00;(#,##0.00);0.00');
    sheet.getRange(row, 1, 1, 2).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
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
  sheet.getRange(row, 2).setFormula('=B' + totRevRow + '-B' + totExpRow).setFontWeight('bold').setFontSize(11);
  sheet.getRange(row, 2).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  sheet.getRange(row, 1, 1, 2).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sheet.setFrozenRows(4);
}

/**
 * Build or refresh the BS-skuld tab using skuld() formulas.
 */
function buildSkuldBS_(sheet, ss) {
  var coaSheet = ss.getSheetByName('COA');
  if (!coaSheet) { Logger.log('BS-skuld error: COA sheet not found'); return; }

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
    if (type === 'Asset' || type === 'Liability' || type === 'Equity') {
      bsAccounts.push({
        code: String(row[acctCodeIdx] || '').trim(),
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
  sheet.setColumnWidth(1, 400);
  sheet.setColumnWidth(2, 160);

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
      sheet.getRange(row, 1, 1, 2).setBackground('#f0f0f0');
      row++;
    }
    sheet.getRange(row, 1).setValue(acct.code + '  ' + acct.name);
    sheet.getRange(row, 2).setFormula("=skuld('_CACHE_BALANCES'!ZZ1,B3,A" + row + ")");
    sheet.getRange(row, 2).setNumberFormat('#,##0.00;(#,##0.00);0.00');
    row++;
  }
  if (currentSection !== null) sections[currentSection].end = row - 1;

  // Write section totals
  var startRow = 5;
  sheet.getRange(row, 1).setValue('TOTAL ASSETS').setFontWeight('bold');
  if (sections.Asset.start && sections.Asset.end) {
    sheet.getRange(row, 2).setFormula('=SUMIF(A' + sections.Asset.start + ':A' + sections.Asset.end + ',"1*",B' + sections.Asset.start + ':B' + sections.Asset.end + ')').setFontWeight('bold');
  }
  sheet.getRange(row, 2).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  sheet.getRange(row, 1, 1, 2).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  row++;
  sheet.getRange(row, 1).setValue('TOTAL LIABILITIES').setFontWeight('bold');
  if (sections.Liability.start && sections.Liability.end) {
    sheet.getRange(row, 2).setFormula('=SUMIF(A' + sections.Liability.start + ':A' + sections.Liability.end + ',"2*",B' + sections.Liability.start + ':B' + sections.Liability.end + ')').setFontWeight('bold');
  }
  sheet.getRange(row, 2).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  sheet.getRange(row, 1, 1, 2).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  row++;
  sheet.getRange(row, 1).setValue('TOTAL EQUITY').setFontWeight('bold');
  if (sections.Equity.start && sections.Equity.end) {
    sheet.getRange(row, 2).setFormula('=SUMIF(A' + sections.Equity.start + ':A' + sections.Equity.end + ',"3*",B' + sections.Equity.start + ':B' + sections.Equity.end + ')').setFontWeight('bold');
  }
  sheet.getRange(row, 2).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  sheet.getRange(row, 1, 1, 2).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  sheet.setFrozenRows(4);
}
