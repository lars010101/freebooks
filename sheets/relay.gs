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
    
    // State Engine: Track global DB post for relevant write actions
    var writeActions = [
      'journal.post', 'coa.save', 'mapping.save', 'center.save', 
      'vat.codes.save', 'journal.import', 'bank.approve', 'bill.create', 
      'settings.save'
    ];
    if (writeActions.indexOf(action) !== -1) {
      try {
        if (typeof markGlobalDatabasePost === 'function') markGlobalDatabasePost();
      } catch(e) {}
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
// Uses CacheService to avoid BigQuery round-trips on every sidebar open.
function getSidebarInitDataWithAccounts() {
  var cache = CacheService.getDocumentCache();
  var cachedAccts = cache.get('skuld_accounts');
  var cachedVats = cache.get('skuld_vat_codes');

  var accounts, vatCodes;

  if (cachedAccts) {
    accounts = JSON.parse(cachedAccts);
  } else {
    var accts = callSkuld_('coa.list', {});
    accounts = (accts || []).map(function(a) { return { code: a.account_code, name: a.account_name, type: a.account_type }; });
    try { cache.put('skuld_accounts', JSON.stringify(accounts), 21600); } catch (e) { /* cache too large, skip */ }
  }

  if (cachedVats) {
    vatCodes = JSON.parse(cachedVats);
  } else {
    var vats = callSkuld_('vat.codes.list', {});
    vatCodes = (vats || []).map(function(v) { return { code: v.vat_code, rate: v.rate, description: v.description }; });
    try { cache.put('skuld_vat_codes', JSON.stringify(vatCodes), 21600); } catch (e) { /* cache too large, skip */ }
  }

  return { accounts: accounts, vatCodes: vatCodes, settings: getSettingsData() };
}

/**
 * Invalidate cached accounts and/or VAT codes.
 * Called after Show COA, Show Tax Codes, or Save COA/VAT operations.
 */
function invalidateAccountCache_() {
  var cache = CacheService.getDocumentCache();
  cache.removeAll(['skuld_accounts', 'skuld_vat_codes']);
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
  // NEW / ENTRY (Green)
  'New Journal entry':   { color: '#34a853', category: 'new' },
  'Bank statement':      { color: '#34a853', category: 'new' },
  'Bank Processing':     { color: '#34a853', category: 'new' },
  'Transaction import':  { color: '#34a853', category: 'new' },
  'Import':              { color: '#34a853', category: 'new' },

  // ACCOUNTING RECORDS (Blue)
  'Journal':             { color: '#4285f4', category: 'records' },
  'GL':                  { color: '#4285f4', category: 'records' },
  'General Ledger':      { color: '#4285f4', category: 'records' },
  'TB':                  { color: '#4285f4', category: 'records' },
  'Period Balances':     { color: '#4285f4', category: 'records' },

  // FINANCIAL STATEMENTS (Purple)
  'PL':                  { color: '#9c27b0', category: 'statements' },
  'BS':                  { color: '#9c27b0', category: 'statements' },
  'CF':                  { color: '#9c27b0', category: 'statements' },
  'SCE':                 { color: '#9c27b0', category: 'statements' },

  // MANAGEMENT / TAX REPORTS (Orange)
  'AP Aging':            { color: '#ff9800', category: 'reports' },
  'Tax Report':          { color: '#ff9800', category: 'reports' },
  'VAT Return':          { color: '#ff9800', category: 'reports' },
  'Integrity Check':     { color: '#ff9800', category: 'reports' },
  'Integrity':           { color: '#ff9800', category: 'reports' },

  // SETTINGS (Gray)
  'Settings':            { color: '#9e9e9e', category: 'settings' },
  'General':             { color: '#9e9e9e', category: 'settings' },
  'Bank map':            { color: '#9e9e9e', category: 'settings' },
  'Mappings':            { color: '#9e9e9e', category: 'settings' },
  'Tax codes':           { color: '#9e9e9e', category: 'settings' },
  'VAT Codes':           { color: '#9e9e9e', category: 'settings' },
  'Profit/cost centers': { color: '#9e9e9e', category: 'settings' },
  'Centers':             { color: '#9e9e9e', category: 'settings' },
  'COA':                 { color: '#9e9e9e', category: 'settings' }
};

function navigateToTab(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var config = TAB_CONFIG[name] || { color: '#5f6368', category: 'reports' };
  
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    // Create new sheet with appropriate color
    sheet = ss.insertSheet(name);
    sheet.setTabColor(config.color);
    sheet.setFrozenRows(1);
    var formulaTabs = ['PL', 'BS', 'CF', 'CF-skuld', 'SCE', 'TB', 'Integrity'];
    if (formulaTabs.indexOf(name) !== -1) {
      sheet.getRange('A1').setValue('Please wait while generating report...').setFontColor('#999999').setFontStyle('italic');
    } else {
      sheet.getRange('A1').setValue('Refresh sheet to populate with data').setFontColor('#999999').setFontStyle('italic');
    }
    
    // No hardcoded headers — all headers load dynamically from database upon refresh.
    // Exception: Import sheet needs paste instructions.
    if (name === 'Import') {
      var h = ['Batch ID', 'Date', 'Account Code', 'Debit', 'Credit', 'Currency', 'FX Rate', 'Description', 'Reference', 'Source'];
      sheet.getRange(1,1,1,h.length).setValues([h]).setFontWeight('bold').setBackground('#fce8b2');
      sheet.getRange(2,1).setValue('Paste journal data below. Group lines by Batch ID. Hit Save to import.');
      sheet.getRange(2,1,1,h.length).merge().setFontStyle('italic').setFontColor('#666666');
    }
  }
  // Always ensure correct taxonomy color
  try { sheet.setTabColor(config.color); } catch(e) {}
  sheet.showSheet();
  sheet.activate();

  // Formula-driven tabs are built by their generate* functions, not here.

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
  var result = _refreshTabInternal_(name, period);
  if (result && result.indexOf('✅') === 0) {
    try {
      if (typeof markSheetRefreshed === 'function') markSheetRefreshed(name);
    } catch(e) {}
  }
  // Flush so data is visible before any alert fires
  SpreadsheetApp.flush();
  return result;
}

function _refreshTabInternal_(name, period) {
  var params = period || getReportParams_();
  try {
    switch (name) {
    case 'Journal':
      var entries = callSkuld_('journal.list', { dateFrom: params.dateFrom, dateTo: params.dateTo });
      if (entries) {
        writeToSheet_('Journal', entries, ['date','batch_id','account_code','debit','credit','currency','description','reference','source','vat_code']);
      }
      return '✅ Journal loaded (' + (entries ? entries.length : 0) + ' rows)';
    case 'General Ledger':
    case 'GL':
      // GL is formula-driven — no Cloud Function call needed.
      // It reads from Journal sheet and Period Balances.
      // "Refresh" for GL means: rebuild the formula template for the current account/period.
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss.getSheetByName('Journal') || ss.getSheetByName('Journal').getLastRow() < 3) return '❌ Journal sheet has no data. Load the Journal first.';
      if (!ss.getSheetByName('Period Balances')) return '❌ Period Balances not found. Refresh the cache first.';
      if (!ss.getSheetByName('COA')) return '❌ COA not found. Load it first.';
      try { buildGL_(ss.getSheetByName(name), ss, params); } catch (e) { return '❌ GL Error: ' + e.message; }
      return '✅ General Ledger built for account ' + (params.glAccount || 'all') + ', period ' + (params.period || '');
    case 'TB':
      var ssTB = SpreadsheetApp.getActiveSpreadsheet();
      if (!ssTB.getSheetByName('COA') || !ssTB.getSheetByName('Period Balances')) return '❌ COA or cache not found';
      try { buildTB_(ssTB.getSheetByName('TB'), ssTB); } catch (e) { return '❌ Error: ' + e.message; }
      return '✅ Trial Balance rebuilt — change period in B3';
    case 'PL':
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var coaSheet = ss.getSheetByName('COA');
      var cacheSheet = ss.getSheetByName('Period Balances');
      if (!coaSheet) return '❌ COA sheet not found';
      if (!cacheSheet) return '❌ Period Balances not found';
      try {
        buildPL_(ss.getSheetByName('PL'), ss);
      } catch (e) {
        return '❌ Error: ' + e.message;
      }
      return '✅ P&L rebuilt — change period in B3';
    case 'BS':
      var ss2 = SpreadsheetApp.getActiveSpreadsheet();
      var coaSheet2 = ss2.getSheetByName('COA');
      var cacheSheet2 = ss2.getSheetByName('Period Balances');
      if (!coaSheet2) return '❌ COA sheet not found';
      if (!cacheSheet2) return '❌ Period Balances not found';
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
      var cacheSheet2 = ss2.getSheetByName('Period Balances');
      if (!coaSheet2)   return '❌ COA sheet not found';
      if (!cacheSheet2) return '❌ Period Balances not found';
      try {
        buildCF_(ss2.getSheetByName('CF-skuld'), ss2);
      } catch (e) {
        return '❌ Error: ' + e.message;
      }
      return '✅ Cash Flow (skuld) rebuilt — multi-period, all FY columns';
    case 'AP Aging':
      var r = callSkuld_('report.refresh_ap_aging', { period: params.period });
      if (r) writeReportToSheet_('AP Aging', r);
      var apSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('AP Aging');
      if (apSheet) {
        apSheet.getRange('A1').setValue('Period:').setFontWeight('bold');
        if (params.period) apSheet.getRange('B1').setValue(params.period).setFontWeight('bold');
      }
      return '✅ AP Aging refreshed';
    case 'VAT Return':
    case 'Tax Report':
      var periodFrom = params.dateFrom || '2025-01-01';
      var periodTo = params.dateTo || '2025-12-31';
      var r = callSkuld_('report.refresh_vat_return', { periodFrom: periodFrom, periodTo: periodTo, period: params.period });
      if (r) writeReportToSheet_('VAT Return', r);
      return '✅ VAT Return refreshed';
    case 'SCE':
      var ssSCE = SpreadsheetApp.getActiveSpreadsheet();
      if (!ssSCE.getSheetByName('COA') || !ssSCE.getSheetByName('Period Balances')) return '❌ COA or cache not found';
      try { buildSCE_(ssSCE.getSheetByName('SCE'), ssSCE); } catch (e) { return '❌ Error: ' + e.message; }
      return '✅ SCE rebuilt — change period in B3';
    case 'Integrity':
      var ssInt = SpreadsheetApp.getActiveSpreadsheet();
      if (!ssInt.getSheetByName('COA') || !ssInt.getSheetByName('Period Balances')) return '❌ COA or cache not found';
      try { buildIntegrity_(ssInt.getSheetByName('Integrity'), ssInt); } catch (e) { return '❌ Error: ' + e.message; }
      return '✅ Integrity Check rebuilt — change period in B2';
    case 'Period Balances':
      var r = callSkuld_('report.cache_balances', {});
      if (r && r.rows) writeToSheet_('Period Balances', r.rows, r.columns);
      return '✅ Period Balances refreshed (' + (r && r.columns ? r.columns.length : 0) + ' periods)';
    case 'COA':
      var r = callSkuld_('coa.list', {});
      if (r) writeToSheet_('COA', r, ['account_code', 'account_name', 'account_type', 'account_subtype', 'pl_category', 'bs_category', 'cf_category', 'is_active', 'effective_from', 'effective_to']);
      return '✅ COA loaded from database';
    case 'Mappings':
    case 'Bank map':
    case 'Bank map':
      var r = callSkuld_('mapping.list', {});
      if (r) writeToSheet_('Mappings', r, ['pattern', 'match_type', 'debit_account', 'credit_account', 'description_override', 'vat_code', 'cost_center', 'profit_center', 'priority', 'is_active']);
      return '✅ Mappings loaded from database';
    case 'Bills':
      var r = callSkuld_('bill.list', {});
      if (r) writeToSheet_('Bills', r, ['bill_id', 'vendor', 'vendor_ref', 'date', 'due_date', 'amount', 'currency', 'status', 'amount_paid']);
      return '✅ Bills refreshed';
    case 'Settings':
    case 'General':
      var r = callSkuld_('period.list', {});
      if (r) {
        writeToSheet_('Settings', r, ['company_id', 'company_name', 'base_currency', 'period_id', 'start_date', 'end_date', 'locked']);
        // Build Data Validation dropdown for B1 (company selector)
        var ss = SpreadsheetApp.getActiveSpreadsheet();
        var sSheet = ss.getSheetByName('Settings');
        if (sSheet) {
          // Extract unique company IDs from the data
          var companyIds = [];
          var seen = {};
          for (var i = 0; i < r.length; i++) {
            var cid = r[i].company_id;
            if (cid && !seen[cid]) { companyIds.push(cid); seen[cid] = true; }
          }
          if (companyIds.length > 0) {
            var rule = SpreadsheetApp.newDataValidation()
              .requireValueInList(companyIds, true)
              .setAllowInvalid(false)
              .build();
            var currentCompany = PropertiesService.getScriptProperties().getProperty('COMPANY_ID') || companyIds[0];
            sSheet.getRange('B1').setDataValidation(rule).setValue(currentCompany);
          }
          // B2: VLOOKUP currency from the table based on B1 selection
          sSheet.getRange('B2').setFormula('=IFERROR(VLOOKUP(B1,A7:C,3,FALSE),"")');
        }
      }
      return '✅ Settings loaded from database';
    case 'Bank Processing':
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Bank Processing');
      var rows = readBankRows_(sheet);
      if (rows.length === 0) return '⚠️ No bank rows to process. Paste data first.';
      var r = callSkuld_('bank.process', { rows: rows });
      if (r) writeBankProcessingResults_(sheet, r.processed);
      return '✅ Processed: ' + r.summary.ruleMatched + ' matched, ' + r.summary.unmatched + ' unmatched';
    default:
      return '⚠️ Refresh to populate with database data.';
  }
  } catch (e) {
    return '❌ Error: ' + e.message;
  }
}

function saveTab_(name) {
  if (typeof validateBeforePost === 'function') {
    // Only check tabs that support this logic
    var isInput = [
      'New Journal entry', 'Bank statement', 'Transaction import', 
      'Settings', 'General', 'Bank map', 'Tax codes', 'Profit/cost centers',
      'COA', 'Mappings', 'Centers', 'VAT Codes', 'Import', 'Bank Processing'
    ].indexOf(name) !== -1;
    
    if (isInput) {
      if (!validateBeforePost(name)) {
        return '⚠️ Post aborted: No new edits detected.';
      }
    }
  }
  return _saveTabInternal_(name);
}

function _saveTabInternal_(name) {
  switch (name) {
    case 'COA':
      var data = readSheetData_('COA');
      callSkuld_('coa.save', { accounts: data });
      invalidateAccountCache_();
      return '✅ COA saved to database';
    case 'Mappings':
    case 'Bank map':
      var data = readSheetData_('Mappings');
      callSkuld_('mapping.save', { mappings: data });
      return '✅ Mappings saved to database';
    case 'Centers':
    case 'Profit/cost centers':
      var data = readSheetData_('Centers');
      callSkuld_('center.save', { centers: data });
      return '✅ Centers saved to database';
    case 'VAT Codes':
    case 'Tax codes':
      var data = readSheetData_('VAT Codes');
      callSkuld_('vat.codes.save', { vatCodes: data });
      invalidateAccountCache_();
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
    case 'Settings':
    case 'General':
      var data = readSettingsFromSheet_();
      return callSkuld_('settings.save', { settings: data }) ? '✅ Settings saved' : '❌ Failed to save';
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
  var entries = callSkuld_('journal.list', { dateFrom: params.dateFrom, dateTo: params.dateTo, period: params.period });
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
    minAccountLength: settings['Min Account Length'] || '',
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
    ['', ''],
    ['Min Account Length', data.minAccountLength || ''],
  ];
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);

  // Also save min_account_length to BQ settings table
  if (data.minAccountLength) {
    try {
      callSkuld_('settings.save', { settings: { 'min_account_length': String(data.minAccountLength) } });
    } catch (e) {
      Logger.log('Failed to save min_account_length to BQ: ' + e.message);
    }
  }
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
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('⚖️ Skuld')
    .addSubMenu(ui.createMenu('New')
      .addItem('Journal entry', 'newJournalEntry')
      .addItem('Bank statement', 'newBankStatement')
      .addItem('Transaction import', 'newTransactionImport'))
    .addSubMenu(ui.createMenu('Accounting records')
      .addItem('Journal', 'showJournal')
      .addItem('General Ledger', 'showGL')
      .addItem('Trial Balances', 'generateTB'))
    .addSubMenu(ui.createMenu('Financial statements')
      .addItem('Profit & Loss', 'generatePL')
      .addItem('Statement of Changes in Equity', 'generateSCE')
      .addItem('Balance Sheet', 'generateBS')
      .addItem('Cash Flow', 'generateCF'))
    .addSubMenu(ui.createMenu('Management/tax reports')
      .addItem('AP Aging', 'showAPAging')
      .addItem('Tax Report', 'showTaxReport')
      .addItem('Integrity Check', 'generateIntegrity'))
    .addSubMenu(ui.createMenu('Settings')
      .addItem('General', 'showSettings')
      .addItem('Bank map', 'showMappings')
      .addItem('Tax codes', 'showTaxCodes')
      .addItem('Profit/cost centers', 'showCenters')
      .addSeparator()
      .addItem('Chart of Accounts', 'showCOA'))
    .addSeparator()
    .addItem('Post to database', 'postActiveSheet')
    .addItem('Refresh sheet', 'refreshActiveSheet')
    .addToUi();
}

function refreshAll() {
  refreshAllReports_();
  SpreadsheetApp.getUi().alert('✅ All sheets refreshed.');
}

// =============================================================================
// Generate Report — writes formulas into the ACTIVE (blank) sheet
// =============================================================================

/**
 * Guard: checks the active sheet is completely blank.
 * Returns the sheet if blank, or null (with alert) if not.
 */
function requireBlankSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  var ui = SpreadsheetApp.getUi();

  if (sheet.getLastRow() > 0 || sheet.getLastColumn() > 0) {
    ui.alert('Sheet not blank',
      'The active sheet must be completely empty to generate a report.\n' +
      'Create a new sheet or clear this one first.',
      ui.ButtonSet.OK);
    return null;
  }

  // Pre-flight: COA and cache must exist
  if (!ss.getSheetByName('COA')) {
    ui.alert('Missing data', 'COA sheet not found. Load it first from the sidebar.', ui.ButtonSet.OK);
    return null;
  }
  if (!ss.getSheetByName('Period Balances')) {
    ui.alert('Missing data', 'Period Balances not found. Use Show → Period Balances first.', ui.ButtonSet.OK);
    return null;
  }

  return sheet;
}

function generatePL() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  navigateToTab('PL');
  var sheet = ss.getSheetByName('PL');
  buildPL_(sheet, ss);
  SpreadsheetApp.getUi().alert('✅ P&L generated.\nChange period in C3.');
}

function generateBS() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  navigateToTab('BS');
  var sheet = ss.getSheetByName('BS');
  buildBS_(sheet, ss);
  SpreadsheetApp.getUi().alert('✅ Balance Sheet generated.\nChange period in C3.');
}

function generateCF() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  navigateToTab('CF');
  var sheet = ss.getSheetByName('CF');
  buildCF_(sheet, ss);
  SpreadsheetApp.getUi().alert('✅ Cash Flow generated.\nChange period in C3.');
}

function generateTB() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  navigateToTab('TB');
  var sheet = ss.getSheetByName('TB');
  buildTB_(sheet, ss);
  SpreadsheetApp.getUi().alert('✅ Trial Balance generated.\nChange period in C3.');
}

function generateSCE() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  navigateToTab('SCE');
  var sheet = ss.getSheetByName('SCE');
  buildSCE_(sheet, ss);
  SpreadsheetApp.getUi().alert('✅ Statement of Changes in Equity generated.\nChange period in C3.');
}

function generateIntegrity() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  navigateToTab('Integrity');
  var sheet = ss.getSheetByName('Integrity');
  buildIntegrity_(sheet, ss);
  SpreadsheetApp.getUi().alert('✅ Integrity Check generated.\nChange period in C2.');
}

// =============================================================================
// New — input sheets
// =============================================================================

function newJournalEntry() {
  openSidebar();
}

function newBankStatement() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  navigateToTab('Bank statement');
  SpreadsheetApp.getUi().alert('Paste your bank statement data below the headers.\nUse Refresh Active Sheet to process when ready.');
}

function newTransactionImport() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  navigateToTab('Transaction import');
  SpreadsheetApp.getUi().alert('Paste journal data below. Group lines by Batch ID.\nUse Refresh Active Sheet to import when ready.');
}

// =============================================================================
// Show — fetch data from backend into sheets
// =============================================================================

function showJournal() {
  navigateToTab('Journal');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
}

function showTaxReport() {
  navigateToTab('Tax Report');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
}

function showAPAging() {
  navigateToTab('AP Aging');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
}

function showCOA() {
  navigateToTab('COA');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
}

function showMappings() {
  navigateToTab('Bank map');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
}

function showTaxCodes() {
  navigateToTab('Tax codes');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
}

function showCenters() {
  navigateToTab('Profit/cost centers');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
}

function showPeriodBalances() {
  navigateToTab('Period Balances');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
}

function refreshActiveSheet() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var name = sheet.getName();
  
  // 1. Route formula-based reports to Period Balances cache refresh
  var formulaReports = ['PL', 'BS', 'CF', 'CF-skuld', 'SCE', 'Integrity', 'Integrity Check'];
  if (formulaReports.indexOf(name) !== -1) {
    var result = refreshTab_('Period Balances');
    SpreadsheetApp.getUi().alert(result + '\n\n(Financial statements update automatically via formulas once the cache is refreshed)');
    return;
  }
  
  // 2. Handle direct pull reports that require a period
  var params = getReportParams_();
  
  // 2a. General Ledger: needs period + account, formula-driven
  var glSheets = ['General Ledger', 'GL'];
  if (glSheets.indexOf(name) !== -1) {
    var periodVal = String(sheet.getRange('B1').getValue()).trim();
    if (!periodVal || periodVal === '') {
      var ui = SpreadsheetApp.getUi();
      var response = ui.prompt('Period', 'For which period? (e.g., FY2026 or 2026P4):', ui.ButtonSet.OK_CANCEL);
      if (response.getSelectedButton() == ui.Button.CANCEL) return;
      periodVal = response.getResponseText().trim();
      if (!periodVal) return;
    }
    periodVal = normalizePeriod_(periodVal);
    sheet.getRange('A1').setValue('Period:').setFontWeight('bold');
    sheet.getRange('B1').setValue(periodVal).setFontWeight('bold');
    params.period = periodVal;
    var resolved = resolvePeriodToDates_(periodVal);
    if (resolved) { params.dateFrom = resolved.dateFrom; params.dateTo = resolved.dateTo; }
    
    // Account is read from B2 dropdown (user sets it on the sheet)
    var acctVal = String(sheet.getRange('B2').getValue()).trim();
    params.glAccount = acctVal || '';
    
    var result = refreshTab_(name, params);
    SpreadsheetApp.getUi().alert(result);
    return;
  }
  
  // 2b. Other direct pull reports
  var directPulls = ['Journal', 'TB', 'Trial Balance', 'AP Aging', 'Tax Report', 'VAT Return'];
  if (directPulls.indexOf(name) !== -1) {
    // Try to read period from cell B1
    var periodVal = String(sheet.getRange('B1').getValue()).trim();
    
    // If no valid period found on sheet, prompt the user
    if (!periodVal || periodVal === '') {
      var ui = SpreadsheetApp.getUi();
      var response = ui.prompt('Missing Period', 'For which period should this data be loaded? (e.g., FY2026 or 2026P4):', ui.ButtonSet.OK_CANCEL);
      if (response.getSelectedButton() == ui.Button.CANCEL) {
        return; // User cancelled
      }
      periodVal = response.getResponseText().trim();
      if (periodVal) {
        periodVal = response.getResponseText().trim();
      } else {
        return; // User cancelled
      }
    }
    // Write period metadata to row 1
    periodVal = normalizePeriod_(periodVal);
    sheet.getRange('A1').setValue('Period:').setFontWeight('bold');
    sheet.getRange('B1').setValue(periodVal).setFontWeight('bold');
    
    // Resolve the period string to actual dateFrom/dateTo
    params.period = periodVal;
    var resolved = resolvePeriodToDates_(periodVal);
    if (resolved) {
      params.dateFrom = resolved.dateFrom;
      params.dateTo = resolved.dateTo;
    }
  }
  
  // Direct pulls with period filtering
  if (directPulls.indexOf(name) !== -1) {
    var result = refreshTab_(name, params);
    SpreadsheetApp.getUi().alert(result);
    return;
  }
  
  // Static full-load tabs (no period needed)
  var staticTabs = ['COA', 'Mappings', 'Bank map', 'Tax codes', 'VAT Codes', 'Centers', 'Profit/cost centers', 'Period Balances', 'Bills', 'Settings', 'General'];
  if (staticTabs.indexOf(name) !== -1) {
    var result = refreshTab_(name, params);
    SpreadsheetApp.getUi().alert(result);
    return;
  }
  
  // Unrecognized sheet type
  SpreadsheetApp.getUi().alert('⚠️ No refresh action for this sheet type.');
}

// =============================================================================
// Sheet protection — permanent sheets cannot be deleted
// =============================================================================

/**
 * Protect COA, Period Balances, and Settings so they cannot be deleted.
 * Called after Load operations that create/update these sheets.
 * Uses editor-only protection (the owner can still edit content).
 */
function protectPermanentSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var permanentTabs = ['COA', 'Period Balances', 'Settings'];

  for (var i = 0; i < permanentTabs.length; i++) {
    var sheet = ss.getSheetByName(permanentTabs[i]);
    if (!sheet) continue;

    // Check if already protected (avoid duplicating protections)
    var protections = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    var alreadyProtected = false;
    for (var p = 0; p < protections.length; p++) {
      if (protections[p].getDescription() === 'Skuld permanent sheet') {
        alreadyProtected = true;
        break;
      }
    }
    if (alreadyProtected) continue;

    var protection = sheet.protect().setDescription('Skuld permanent sheet');
    // Allow the current user to edit content (protection prevents deletion, not editing)
    protection.setWarningOnly(true);
  }
}

// =============================================================================
// Trigger setup
// =============================================================================

function onOpenInstallable() {
  onOpen();
  protectPermanentSheets_();
  // Only open sidebar if user opted in
  if (getAutoOpenState()) {
    openSidebar();
  }
}

function setupTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'onOpenInstallable') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('onOpenInstallable').forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet()).onOpen().create();
  SpreadsheetApp.getUi().alert('✅ Auto-open trigger installed.');
}

function removeTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'onOpenInstallable') ScriptApp.deleteTrigger(triggers[i]);
  }
}

// =============================================================================
// Sidebar auto-open preference
// =============================================================================

function getAutoOpenState() {
  var props = PropertiesService.getUserProperties();
  return props.getProperty('SIDEBAR_AUTO_OPEN') === 'true';
}

function setAutoOpen(enabled) {
  var props = PropertiesService.getUserProperties();
  if (enabled) {
    props.setProperty('SIDEBAR_AUTO_OPEN', 'true');
    setupTrigger();
    return '✅ Sidebar will open automatically on every load.';
  } else {
    props.deleteProperty('SIDEBAR_AUTO_OPEN');
    removeTrigger();
    return '✅ Auto-open disabled.';
  }
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
// Report tabs (formula-driven, reads from Period Balances via INDEX/MATCH)
// =============================================================================

// Formula helpers — return spreadsheet formula strings for Period Balances lookups.
// acctRef: cell ref for account code (e.g. '$A5')
// periodRef: cell ref for period header (e.g. 'C$3')
// For literal account codes or periods, wrap in quotes before calling.

var PB = "'Period Balances'";

/**
 * Read sheet data skipping metadata row(s).
 * Returns { headers: [...], data: [[...], ...], headerIdx: N }
 * where headers is the header row values and data starts from the row after headers.
 */
function getSheetDataWithHeaders_(sheet) {
  var allData = sheet.getDataRange().getValues();
  if (allData.length === 0) return { headers: [], data: [], headerIdx: 0 };
  
  var headerIdx = 0;
  for (var h = 0; h < Math.min(allData.length, 5); h++) {
    var firstCell = String(allData[h][0] || '').trim().toLowerCase();
    if (firstCell === 'period:' || firstCell === 'refresh sheet to populate with data' || firstCell === '' || firstCell === 'data as of:') {
      continue;
    }
    headerIdx = h;
    break;
  }
  
  return {
    headers: allData[headerIdx],
    data: allData.slice(headerIdx + 1),
    headerIdx: headerIdx
  };
}

/**
 * Stamp cache freshness timestamp on a financial statement sheet.
 * Reads the Period Balances refresh time and displays it in E1.
 * Uses a non-intrusive position that won't conflict with the report layout.
 */
function stampCacheFreshness_(sheet) {
  sheet.getRange('E4').setFormula('=\'Period Balances\'!C4').setFontColor('#888888').setFontSize(9);
}

/** Cumulative balance: INDEX/MATCH lookup from Period Balances. */
/**
 * Wrap account ref to handle string/number type mismatch.
 * If acctRef is a cell ref like '$A5', wrap with TEXT(...,"0") to force string.
 * If acctRef is a literal like '"300002"', it's already a string.
 */
function acctMatch_(acctRef) {
  // Use TEXT to coerce Period Balances column A to string for comparison
  return 'MATCH(' + acctRef + '&"",' + PB + '!$A:$A&"",0)';
}

function pbCum_(acctRef, periodRef) {
  return 'IFERROR(INDEX(' + PB + '!$A:$ZZ,' + acctMatch_(acctRef) + ',MATCH(' + periodRef + ',' + PB + '!$2:$2,0)),0)';
}

/** Period movement (delta): current period value minus prior period column. */
function pbDelta_(acctRef, periodRef) {
  return 'IFERROR(INDEX(' + PB + '!$A:$ZZ,' + acctMatch_(acctRef) + ',MATCH(' + periodRef + ',' + PB + '!$2:$2,0))-INDEX(' + PB + '!$A:$ZZ,' + acctMatch_(acctRef) + ',MATCH(' + periodRef + ',' + PB + '!$2:$2,0)-1),0)';
}

/**
 * Read period column headers from Period Balances row 2 and return as array.
 * Filters to only FYxxxx and xxxxPxx entries.
 */
function getCachePeriods_(ss) {
  var pbSheet = ss.getSheetByName('Period Balances');
  if (!pbSheet || pbSheet.getLastColumn() < 2) return [];
  var headers = pbSheet.getRange(2, 1, 1, pbSheet.getLastColumn()).getValues()[0];
  var periods = [];
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i] || '').trim();
    if (/^FY\d{4}$/.test(h) || /^\d{4}P\d{2}$/.test(h)) periods.push(h);
  }
  return periods;
}

/**
 * Apply a data validation dropdown of available periods to a cell.
 */
function setPeriodDropdown_(ss, cell) {
  var periods = getCachePeriods_(ss);
  if (periods.length === 0) return;
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(periods, true)
    .setAllowInvalid(false)
    .build();
  cell.setDataValidation(rule);
}

/**
 * Build or refresh the PL tab using INDEX/MATCH formulas against Period Balances.
 * Reads P&L accounts from the COA tab and creates a formatted P&L report.
 */

/**
 * Build the General Ledger tab using formulas against Journal and Period Balances.
 *
 * Layout:
 *   A1: Period:    B1: [period]    C1: Data as of timestamp
 *   A2: Account:   B2: [account code dropdown]   C2: =VLOOKUP(B2,COA!A:B,2,FALSE)
 *   A3: (blank)    B3: Opening Balance:    C3: =INDEX/MATCH from Period Balances (prior period)
 *   Row 4: Headers (Date | Batch ID | Description | Debit | Credit | Running Balance)
 *   Rows 5-34: INDEX/MATCH formulas pulling Nth matching transaction from Journal
 *   Row 35: Closing Balance (from formulas) | Closing Balance (from Period Balances) | Check
 *
 * The user can insert rows and drag formulas to accommodate more than 30 transactions.
 */
function buildGL_(sheet, ss, params) {
  var journalSheet = ss.getSheetByName('Journal');
  var cacheSheet = ss.getSheetByName('Period Balances');
  var coaSheet = ss.getSheetByName('COA');
  if (!journalSheet) throw new Error('Journal sheet not found');
  if (!cacheSheet) throw new Error('Period Balances not found');
  if (!coaSheet) throw new Error('COA not found');

  var period = params.period || '';
  var account = params.glAccount || '';

  // Resolve prior period column name for opening balance
  var priorPeriod = '';
  if (period) {
    var fyMatch = period.match(/^FY(\d{4})$/i);
    var pMatch = period.match(/^(\d{4})P(\d{1,2})$/i);
    if (fyMatch) {
      priorPeriod = 'FY' + (parseInt(fyMatch[1], 10) - 1);
    } else if (pMatch) {
      var yr = parseInt(pMatch[1], 10);
      var pn = parseInt(pMatch[2], 10);
      if (pn === 1) {
        priorPeriod = 'FY' + (yr - 1);
      } else {
        priorPeriod = yr + 'P' + (pn - 1 < 10 ? '0' + (pn - 1) : (pn - 1));
      }
    }
  }

  // Clear everything below row 1 (preserve period metadata)
  if (sheet.getLastRow() > 1 || sheet.getLastColumn() > 0) {
    sheet.getRange(2, 1, Math.max(sheet.getLastRow(), 2), Math.max(sheet.getLastColumn(), 10)).clear();
  }

  // Column widths
  sheet.setColumnWidth(1, 100);  // Date
  sheet.setColumnWidth(2, 120);  // Batch ID
  sheet.setColumnWidth(3, 280);  // Description
  sheet.setColumnWidth(4, 120);  // Debit
  sheet.setColumnWidth(5, 120);  // Credit
  sheet.setColumnWidth(6, 140);  // Running Balance

  // Row 2: Account selector
  sheet.getRange('A2').setValue('Account:').setFontWeight('bold');
  // Data validation dropdown from COA — only leaf accounts (length >= min account length)
  var minLen = 6; // default
  var settingsSheet = ss.getSheetByName('Settings');
  if (settingsSheet) {
    var sData = settingsSheet.getDataRange().getValues();
    for (var s = 0; s < sData.length; s++) {
      var k = String(sData[s][0] || '').trim().toLowerCase();
      if (k === 'min account length') {
        var v = parseInt(sData[s][1], 10);
        if (v > 0) minLen = v;
        break;
      }
    }
  }
  var _coaGL = getSheetDataWithHeaders_(coaSheet);
  var coaData = [_coaGL.headers].concat(_coaGL.data);
  var leafAccounts = [];
  for (var i = 1; i < coaData.length; i++) {
    var code = String(coaData[i][0] || '').trim();
    if (code.length >= minLen) leafAccounts.push(code);
  }
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(leafAccounts, true)
    .setAllowInvalid(false)
    .build();
  // Default to the user's chosen account, or first leaf account
  var defaultAcct = account || (leafAccounts.length > 0 ? leafAccounts[0] : '');
  sheet.getRange('B2').setValue(defaultAcct).setDataValidation(rule).setFontWeight('bold');
  // Account name lookup
  sheet.getRange('C2').setFormula('=IFERROR(VLOOKUP(B2,COA!A:B,2,FALSE),"")');

  // Row 3: Opening balance
  sheet.getRange('A3').setValue('');
  sheet.getRange('B3').setValue('Opening Balance:').setFontWeight('bold');
  if (priorPeriod) {
    sheet.getRange('C3').setFormula('=' + pbCum_('B2', '"' + priorPeriod + '"'));
  } else {
    sheet.getRange('C3').setValue(0);
  }
  sheet.getRange('C3').setNumberFormat('#,##0.00;(#,##0.00);0.00').setFontWeight('bold');
  sheet.getRange('A3:F3').setBackground('#f0f0f0');

  // Row 4: Column headers
  var headers = ['Date', 'Batch ID', 'Description', 'Debit', 'Credit', 'Running Balance'];
  sheet.getRange(4, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e6e6e6');
  sheet.setFrozenRows(4);

  // Rows 5-34: Transaction formulas (30 slots)
  // Strategy: Use SMALL/IF array formulas to find the Nth row in Journal
  // that matches the account code AND falls within the period date range.
  // Journal layout (from row 3): A=Date, B=Batch ID, C=Account Code, D=Debit, E=Credit, F=Currency, G=Description
  // Strategy: Use FILTER+SORT to extract matching rows, then INDEX by row number.
  // Journal layout (writeToSheet_ puts headers at row 2, data from row 3):
  //   A=Date, B=Batch ID, C=Account Code, D=Debit, E=Credit, F=Currency, G=Description
  var NUM_SLOTS = 30;
  var dateFrom = params.dateFrom || '1900-01-01';
  var dateTo = params.dateTo || '2099-12-31';

  // The FILTER expression that gets all matching rows sorted by date.
  // Returns a multi-column array: Date, Batch ID, Description, Debit, Credit
  var filterExpr = 'SORT(FILTER(Journal!A3:G,Journal!C3:C=$B$2,Journal!A3:A>=DATEVALUE("' + dateFrom + '"),Journal!A3:A<=DATEVALUE("' + dateTo + '")),1,TRUE)';

  for (var i = 0; i < NUM_SLOTS; i++) {
    var n = i + 1; // Nth row from filtered result
    var row = 5 + i;

    // Date (col 1 of filter)
    sheet.getRange(row, 1).setFormula('=IFERROR(INDEX(' + filterExpr + ',' + n + ',1),"")').setNumberFormat('yyyy-mm-dd');
    // Batch ID (col 2 of filter)
    sheet.getRange(row, 2).setFormula('=IFERROR(INDEX(' + filterExpr + ',' + n + ',2),"")');
    // Description (col 7 of filter)
    sheet.getRange(row, 3).setFormula('=IFERROR(INDEX(' + filterExpr + ',' + n + ',7),"")');
    // Debit (col 4 of filter)
    sheet.getRange(row, 4).setFormula('=IFERROR(INDEX(' + filterExpr + ',' + n + ',4),"")');
    sheet.getRange(row, 4).setNumberFormat('#,##0.00;(#,##0.00);""');
    // Credit (col 5 of filter)
    sheet.getRange(row, 5).setFormula('=IFERROR(INDEX(' + filterExpr + ',' + n + ',5),"")');
    sheet.getRange(row, 5).setNumberFormat('#,##0.00;(#,##0.00);""');
    // Running Balance = Opening + cumulative (Debit - Credit) through this row
    sheet.getRange(row, 6).setFormula('=IF(A' + row + '="","",$C$3+SUM($D$5:D' + row + ')-SUM($E$5:E' + row + '))');
    sheet.getRange(row, 6).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  }

  // Row 35: Closing balance
  var closeRow = 5 + NUM_SLOTS;
  sheet.getRange(closeRow, 1, 1, 6).setBackground('#f0f0f0');
  sheet.getRange(closeRow, 3).setValue('Closing Balance (calculated):').setFontWeight('bold');
  sheet.getRange(closeRow, 6).setFormula('=IF(A' + (closeRow - 1) + '="",$C$3+SUM($D$5:$D$' + (closeRow - 1) + ')-SUM($E$5:$E$' + (closeRow - 1) + '),F' + (closeRow - 1) + ')');
  sheet.getRange(closeRow, 6).setNumberFormat('#,##0.00;(#,##0.00);0.00').setFontWeight('bold');

  // Row 36: Closing from Period Balances
  var checkRow = closeRow + 1;
  sheet.getRange(checkRow, 3).setValue('Closing Balance (Period Balances):').setFontWeight('bold');
  if (period) {
    sheet.getRange(checkRow, 6).setFormula('=' + pbCum_('B2', '"' + period + '"'));
  } else {
    sheet.getRange(checkRow, 6).setValue(0);
  }
  sheet.getRange(checkRow, 6).setNumberFormat('#,##0.00;(#,##0.00);0.00').setFontWeight('bold');

  // Row 37: Check
  var diffRow = checkRow + 1;
  sheet.getRange(diffRow, 3).setValue('Difference:').setFontStyle('italic').setFontColor('#555555');
  sheet.getRange(diffRow, 6).setFormula('=F' + closeRow + '-F' + checkRow);
  sheet.getRange(diffRow, 6).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  sheet.getRange(diffRow + 1, 3).setValue('Status:').setFontStyle('italic');
  sheet.getRange(diffRow + 1, 6).setFormula('=IF(ABS(F' + diffRow + ')<0.01,"\u2705 Balanced","\u274c Mismatch")');

  Logger.log('GL built for account: ' + account + ', period: ' + period);
}

function buildPL_(sheet, ss) {
  var coaSheet = ss.getSheetByName('COA');
  var cacheSheet = ss.getSheetByName('Period Balances');
  if (!coaSheet) { Logger.log('PL error: COA sheet not found'); return; }
  if (!cacheSheet) { Logger.log('PL error: Period Balances sheet not found'); return; }

  // Get COA data
  var _coa = getSheetDataWithHeaders_(coaSheet);
  var coaData = [_coa.headers].concat(_coa.data);
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
    var code = String(row[acctCodeIdx] || '').trim();
    if (!code || code.length < 6) continue; // Exclude calculated parent accounts
    if (type === 'Revenue' || type === 'Expense') {
      plAccounts.push({
        code: code,
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
  sheet.setColumnWidth(1, 100);  // Account code
  sheet.setColumnWidth(2, 300);  // Account name (VLOOKUP from COA)
  sheet.setColumnWidth(3, 160);  // Balance

  // Row 1: Company header
  sheet.getRange(1, 1).setValue('').setFontWeight('bold');
  sheet.getRange(1, 2).setValue('').setFontWeight('bold');
  sheet.getRange(1, 3).setValue('');

  // Row 2: Currency
  sheet.getRange(2, 1).setValue('').setFontWeight('bold');
  sheet.getRange(2, 2).setValue('');

  // Row 3: Period selector
  sheet.getRange(3, 1).setValue(''); sheet.getRange(3, 2).setValue('Period').setFontWeight('bold');
  sheet.getRange(3, 3).setValue('FY2025').setFontWeight('bold');
  setPeriodDropdown_(ss, sheet.getRange(3, 3));
  sheet.getRange(3, 3).setBackground('#e8f0fe');

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
    sheet.getRange(row, 2).setFormula('=IFERROR(VLOOKUP($A' + row + ',COA!$A:$B,2,FALSE),"")');
    // Col C: period movement, negated (revenue is credit-normal, show positive)
    sheet.getRange(row, 3).setFormula('=-' + pbDelta_('$A' + row, 'C$3'));
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
    sheet.getRange(row, 2).setFormula('=IFERROR(VLOOKUP($A' + row + ',COA!$A:$B,2,FALSE),"")');
    // Col C: period movement (expenses are debit-normal, positive = spent)
    sheet.getRange(row, 3).setFormula('=' + pbDelta_('$A' + row, 'C$3'));
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
  stampCacheFreshness_(sheet);
}

/**
 * Build or refresh the BS tab using INDEX/MATCH formulas against Period Balances.
 */
function buildBS_(sheet, ss) {
  var coaSheet = ss.getSheetByName('COA');
  if (!coaSheet) { Logger.log('BS error: COA sheet not found'); return; }

  var _coa = getSheetDataWithHeaders_(coaSheet);
  var coaData = [_coa.headers].concat(_coa.data);
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
    // Exclude 999999 closing/clearing account and calculated parent accounts
    if (code.indexOf('999999') === 0 || code.length < 6) continue;
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

  sheet.getRange(1, 1).setValue('').setFontWeight('bold');
  sheet.getRange(1, 2).setValue('').setFontWeight('bold');
  sheet.getRange(2, 1).setValue('').setFontWeight('bold');
  sheet.getRange(2, 2).setValue('');
  sheet.getRange(3, 1).setValue(''); sheet.getRange(3, 2).setValue('Period').setFontWeight('bold');
  sheet.getRange(3, 3).setValue('FY2025').setFontWeight('bold');
  setPeriodDropdown_(ss, sheet.getRange(3, 3));
  sheet.getRange(3, 3).setBackground('#e8f0fe');
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
    sheet.getRange(row, 2).setFormula('=IFERROR(VLOOKUP($A' + row + ',COA!$A:$B,2,FALSE),"")');
    // Assets: raw (positive debit balance). L+E: negate (credit balance shown as positive).
    var sign = (acct.type === 'Liability' || acct.type === 'Equity') ? '=-' : '=';
    sheet.getRange(row, 3).setFormula(sign + pbCum_('$A' + row, 'C$3'));
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
  stampCacheFreshness_(sheet);
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
 *   Opening Cash = cumulative balance through prior period
 *   CHECK = cumulative balance through selected period
 */
/**
 * Build or refresh the _CF_CACHE hidden sheet.
 * Scans Journal for entries touching Cash accounts, classifies the contra side.
 * 
 * Output columns: Period | CfClass | Amount
 * CfClass: Operating, Investing, Financing, Unclassified
 *
 * Logic per batch (group of journal lines with same Batch ID):
 *   1. If batch contains a Cash account line → it's a cash transaction
 *   2. For each NON-cash line in the batch:
 *      - Look up the account's CF Category in COA
 *      - P&L accounts (Revenue/Expense) or blank CF Category → Operating
 *      - Op-WC or Op-NonCash → Operating
 *      - Investing → Investing
 *      - Financing → Financing
 *      - Cash → skip (this is the cash side)
 *      - Equity with no CF Category → Financing
 *      - Otherwise → Unclassified
 *   3. Amount = the cash impact (debit - credit on the Cash account line)
 *      But we record the CONTRA side amounts with flipped sign for proper CF presentation
 */
function buildCF_(sheet, ss) {
  var coaSheet    = ss.getSheetByName('COA');
  var cacheSheet  = ss.getSheetByName('Period Balances');
  if (!coaSheet)   { Logger.log('CF error: COA sheet not found');        return; }
  if (!cacheSheet) { Logger.log('CF error: Period Balances not found');   return; }

  // ── Read COA ─────────────────────────────────────────────────────────────────
  var _coaCF = getSheetDataWithHeaders_(coaSheet); var coaData = [_coaCF.headers].concat(_coaCF.data);
  var cHdrs  = coaData[0];
  // Build a case-insensitive map of header indices
  var colMap = {};
  for (var c = 0; c < cHdrs.length; c++) {
    colMap[String(cHdrs[c]).trim().toLowerCase()] = c;
  }
  var cCode  = colMap['account code'];
  var cName  = colMap['account name'];
  var cType  = colMap['account type'];
  var cCFCat = colMap['cf category'];

  var opAccts = [], invAccts = [], finAccts = [], cashAccts = [];

  for (var i = 1; i < coaData.length; i++) {
    var row2 = coaData[i];
    var type  = String(row2[cType]  || '').trim();
    var code  = String(row2[cCode]  || '').trim();
    var cfCat = String(row2[cCFCat] || '').trim();
    if (!code) continue;
    // Exclude calculated parent accounts
    if (code.length < 6) continue;
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
  var _cache = getSheetDataWithHeaders_(cacheSheet); var cacheData = [_cache.headers].concat(_cache.data);
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

  sheet.getRange(1, 1).setValue('').setFontWeight('bold');
  sheet.getRange(1, 2).setValue('').setFontWeight('bold');
  sheet.getRange(2, 1).setValue('').setFontWeight('bold');
  sheet.getRange(2, 2).setValue('');
  sheet.getRange(3, 1).setValue(''); sheet.getRange(3, 2).setValue('Period').setFontWeight('bold');
  sheet.getRange(3, 3).setValue('FY2026').setFontWeight('bold');
  setPeriodDropdown_(ss, sheet.getRange(3, 3));
  sheet.getRange(3, 3).setBackground('#e8f0fe');

  // Row 3, Col C: compute prior period name dynamically
  // ="FY"&(VALUE(RIGHT(B3,4))-1) → e.g. "FY2025" when B3="FY2026"
  sheet.getRange(2, 3).setFormula('="FY"&(VALUE(RIGHT(C3,4))-1)');
  sheet.getRange(2, 3).setFontColor('#ffffff');  // hide it

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
  function cfAcctRow(code) {
    sheet.getRange(row, 1).setValue(code);
    sheet.getRange(row, 2).setFormula('=IFERROR(VLOOKUP($A' + row + ',COA!$A:$B,2,FALSE),"")');
    sheet.getRange(row, 3).setFormula('=-' + pbDelta_('$A' + row, 'C$3'));
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
  // Sum all P&L account deltas inline.
  // Instead, compute inline: Net Income is implicit in "Cash from operations" line.
  // The original report shows one line "Cash from operations" = NI + WC adjustments.
  // We replicate that: NI row + individual WC rows, then "Net cash from operating" = sum.

  secHdr('Operating Activities');
  // Net Income row (label: Cash from operations (NI))
  var niRow = row;
  sheet.getRange(row, 2).setValue('Cash from operations (Net Income)');
  // Each P&L code gets its own INDEX/MATCH delta lookup.
  // Use SUMPRODUCT or build inline: need all P&L account codes.
  
  var plCodes = [];
  for (var i = 1; i < coaData.length; i++) {
    var type = String(coaData[i][cType] || '').trim();
    var code = String(coaData[i][cCode] || '').trim();
    if (!code) continue;
    // Exclude calculated parent accounts (length < 6) from explicit arrays to avoid double counting
    if (code.length < 6) continue;
    if (type === 'Revenue' || type === 'Expense') plCodes.push(code);
  }
  if (plCodes.length > 0) {
    var plParts = plCodes.map(function(c) { return pbDelta_('"' + c + '"', 'C$3'); });
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
  var adjRow = row;
  sheet.getRange(row, 2).setValue('Non-cash adjustments (manual)');
  sheet.getRange(row, 3).setValue(0).setNumberFormat('#,##0.00;(#,##0.00);0.00').setBackground('#fff2cc');
  row++;

  // ── NET CHANGE IN CASH ───────────────────────────────────────────────────────
  var netCashRow = row;
  sheet.getRange(row, 2).setValue('Net change in cash').setFontWeight('bold');
  sheet.getRange(row, 1, 1, 3).setBackground('#c8c8c8');
  var ncParts = ['C' + opTotRow];
  if (invTot) ncParts.push('C' + invTot);
  if (finTot) ncParts.push('C' + finTot);
  ncParts.push('C' + adjRow);
  sheet.getRange(row, 3).setFormula('=(' + ncParts.join('+') + ')').setFontWeight('bold');
  sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  sheet.getRange(row, 1, 1, 3).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  row++;

  // ── CASH AT BEGINNING OF PERIOD ──────────────────────────────────────────────
  // Cumulative cash balance for all periods BEFORE selected period.
  // Cumulative cash balance for all periods BEFORE selected period.
  var openRow = row;
  if (cashAccts.length > 0) {
    var openParts = cashAccts.map(function(a) {
      return pbCum_('"' + a.code + '"', 'C$2');
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
      return pbCum_('"' + a.code + '"', 'C$3');
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
  stampCacheFreshness_(sheet);
  Logger.log('CF-skuld built: %d rows', row);
}



/**
 * Build the TB (Trial Balance) tab using INDEX/MATCH formulas against Period Balances.
 *
 * Layout: Col A = account code, Col B = account name, Col C = Debit, Col D = Credit, Col E = Balance
 * Period selector in B3. Shows cumulative balances through selected period.
 * Debit-normal accounts (Asset, Expense): positive balance shown in Debit column.
 * Credit-normal accounts (Liability, Equity, Revenue): positive balance shown in Credit column.
 */
function buildTB_(sheet, ss) {
  var coaSheet = ss.getSheetByName('COA');
  if (!coaSheet) { Logger.log('TB error: COA sheet not found'); return; }

  var _coa = getSheetDataWithHeaders_(coaSheet);
  var coaData = [_coa.headers].concat(_coa.data);
  var cHdrs = coaData[0];
  var cCode = cHdrs.indexOf('Account Code');
  var cName = cHdrs.indexOf('Account Name');
  var cType = cHdrs.indexOf('Account Type');

  var accounts = [];
  for (var i = 1; i < coaData.length; i++) {
    var code = String(coaData[i][cCode] || '').trim();
    var type = String(coaData[i][cType] || '').trim();
    if (!code) continue;
    if (code.length < 6) continue; // Exclude calculated parent accounts to prevent double-counting
    // TB includes ALL leaf accounts (including 999999) — must balance
    accounts.push({ code: code, type: type });
  }
  accounts.sort(function(a, b) { return a.code.localeCompare(b.code, undefined, { numeric: true }); });

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
  sheet.setColumnWidth(2, 280);
  sheet.setColumnWidth(3, 140);
  sheet.setColumnWidth(4, 140);
  sheet.setColumnWidth(5, 140);

  sheet.getRange(1, 1).setValue('').setFontWeight('bold');
  sheet.getRange(1, 2).setValue('').setFontWeight('bold');
  sheet.getRange(2, 1).setValue('').setFontWeight('bold');
  sheet.getRange(2, 2).setValue('');
  sheet.getRange(3, 1).setValue(''); sheet.getRange(3, 2).setValue('Period').setFontWeight('bold');
  sheet.getRange(3, 3).setValue('FY2025').setFontWeight('bold').setBackground('#e8f0fe');
  setPeriodDropdown_(ss, sheet.getRange(3, 3));

  // Headers row 4
  sheet.getRange(4, 1).setValue('Account Code').setFontWeight('bold');
  sheet.getRange(4, 2).setValue('Account Name').setFontWeight('bold');
  sheet.getRange(4, 3).setValue('Debit').setFontWeight('bold');
  sheet.getRange(4, 4).setValue('Credit').setFontWeight('bold');
  sheet.getRange(4, 5).setValue('Balance').setFontWeight('bold');
  sheet.getRange(4, 1, 1, 5).setBackground('#e6e6e6');

  var row = 5;
  var startRow = row;
  for (var i = 0; i < accounts.length; i++) {
    var acct = accounts[i];
    sheet.getRange(row, 1).setValue(acct.code);
    sheet.getRange(row, 2).setFormula('=IFERROR(VLOOKUP($A' + row + ',COA!$A:$B,2,FALSE),"")');
    // Balance = cumulative (debit - credit). Positive = debit balance.
    // Col E: cumulative balance from Period Balances
    sheet.getRange(row, 5).setFormula('=' + pbCum_('$A' + row, 'C$3'));
    // Col C (Debit): show positive balances
    sheet.getRange(row, 3).setFormula('=IF(E' + row + '>0,E' + row + ',0)');
    // Col D (Credit): show absolute value of negative balances
    sheet.getRange(row, 4).setFormula('=IF(E' + row + '<0,-E' + row + ',0)');
    sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
    sheet.getRange(row, 4).setNumberFormat('#,##0.00;(#,##0.00);0.00');
    sheet.getRange(row, 5).setNumberFormat('#,##0.00;(#,##0.00);0.00');
    row++;
  }
  var endRow = row - 1;

  // Totals
  sheet.getRange(row, 1).setValue('TOTAL').setFontWeight('bold');
  sheet.getRange(row, 3).setFormula('=SUM(C' + startRow + ':C' + endRow + ')').setFontWeight('bold');
  sheet.getRange(row, 4).setFormula('=SUM(D' + startRow + ':D' + endRow + ')').setFontWeight('bold');
  sheet.getRange(row, 5).setFormula('=SUM(E' + startRow + ':E' + endRow + ')').setFontWeight('bold');
  sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  sheet.getRange(row, 4).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  sheet.getRange(row, 5).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  sheet.getRange(row, 1, 1, 5).setBackground('#e0e0e0');
  sheet.getRange(row, 1, 1, 5).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  row++;

  // Check: total debit should equal total credit
  sheet.getRange(row, 1).setValue('CHECK: Debit = Credit').setFontStyle('italic').setFontColor('#555555');
  sheet.getRange(row, 3).setFormula('=C' + (row - 1) + '-D' + (row - 1)).setFontStyle('italic').setFontColor('#555555');
  sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');

  sheet.setFrozenRows(4);
  stampCacheFreshness_(sheet);
  Logger.log('TB built: %d accounts', endRow - startRow + 1);
}

/**
 * Build the SCE (Statement of Changes in Equity) tab using INDEX/MATCH formulas against Period Balances.
 *
 * Layout:
 *   Row labels: Opening Balance, Net Profit, Dividends, Share Capital movements, Other RE, Closing Balance
 *   Columns: Label | Share Capital | Retained Earnings | Dividends | Total
 *   Period selector in B3.
 *   Prior period computed as C3 = "FY"&(RIGHT(B3,4)-1)
 *
 * Equity account classification:
 *   203080 → Share Capital
 *   203070 → Retained Earnings
 *   203040 → Dividends
 *   Others → Retained Earnings (default)
 */
function buildSCE_(sheet, ss) {
  var coaSheet = ss.getSheetByName('COA');
  if (!coaSheet) { Logger.log('SCE error: COA sheet not found'); return; }

  var _coa = getSheetDataWithHeaders_(coaSheet);
  var coaData = [_coa.headers].concat(_coa.data);
  var cHdrs = coaData[0];
  var cCode = cHdrs.indexOf('Account Code');
  var cType = cHdrs.indexOf('Account Type');

  // Classify equity accounts
  var scAccts = [];  // Share Capital
  var reAccts = [];  // Retained Earnings
  var divAccts = []; // Dividends

  for (var i = 1; i < coaData.length; i++) {
    var code = String(coaData[i][cCode] || '').trim();
    var type = String(coaData[i][cType] || '').trim();
    if (!code || type !== 'Equity') continue;
    if (code.indexOf('999999') === 0) continue;
    if (code.length < 6) continue; // Exclude calculated parent accounts
    if (code.indexOf('203080') === 0 || code.indexOf('2081') === 0) scAccts.push(code);
    else if (code.indexOf('203040') === 0 || code.indexOf('2898') === 0) divAccts.push(code);
    else reAccts.push(code); // 203070 and others → RE bucket
  }

  // Also need P&L accounts for Net Income
  var plCodes = [];
  for (var i = 1; i < coaData.length; i++) {
    var type = String(coaData[i][cType] || '').trim();
    var code = String(coaData[i][cCode] || '').trim();
    if (!code) continue;
    // Exclude calculated parent accounts (length < 6) from explicit arrays to avoid double counting
    if (code.length < 6) continue;
    if (type === 'Revenue' || type === 'Expense') plCodes.push(code);
  }

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
  sheet.setColumnWidth(1, 210);
  sheet.setColumnWidth(2, 150);
  sheet.setColumnWidth(3, 150);
  sheet.setColumnWidth(4, 150);
  sheet.setColumnWidth(5, 150);

  sheet.getRange(1, 1).setValue('').setFontWeight('bold');
  sheet.getRange(1, 2).setValue('').setFontWeight('bold');
  sheet.getRange(2, 1).setValue('').setFontWeight('bold');
  sheet.getRange(2, 2).setValue('');
  sheet.getRange(3, 1).setValue(''); sheet.getRange(3, 2).setValue('Period').setFontWeight('bold');
  sheet.getRange(3, 3).setValue('FY2026').setFontWeight('bold').setBackground('#e8f0fe');
  setPeriodDropdown_(ss, sheet.getRange(3, 3));
  // C3 = prior period name (hidden)
  sheet.getRange(2, 3).setFormula('="FY"&(VALUE(RIGHT(C3,4))-1)');
  sheet.getRange(2, 3).setFontColor('#ffffff');

  // Headers row 4
  sheet.getRange(4, 1).setValue('').setFontWeight('bold');
  sheet.getRange(4, 2).setValue('Share Capital').setFontWeight('bold');
  sheet.getRange(4, 3).setValue('Retained Earnings').setFontWeight('bold');
  sheet.getRange(4, 4).setValue('Dividends').setFontWeight('bold');
  sheet.getRange(4, 5).setValue('Total').setFontWeight('bold');
  sheet.getRange(4, 1, 1, 5).setBackground('#e6e6e6');

  var fmt = '#,##0.00;(#,##0.00);0.00';

  // Helper: build sum formula for a list of account codes
  // Negated because equity credit balances are stored as negative in cache
  function sumFormula(codes, period, isDelta) {
    if (codes.length === 0) return '0';
    var fn = isDelta ? pbDelta_ : pbCum_;
    return '-(' + codes.map(function(c) { return fn('"' + c + '"', period); }).join('+') + ')';
  }

  var row = 5;

  // ── Opening Balance ──────────────────────────────────────────────────────────
  // Opening = cumulative through PRIOR period (negated for credit-normal equity)
  // Negate because equity credit balances are stored as negative in cache
  sheet.getRange(row, 1).setValue('Opening Balance').setFontWeight('bold');
  sheet.getRange(row, 2).setFormula('=' + sumFormula(scAccts, 'C$2', false)).setNumberFormat(fmt);
  sheet.getRange(row, 3).setFormula('=' + sumFormula(reAccts, 'C$2', false)).setNumberFormat(fmt);
  sheet.getRange(row, 4).setFormula('=' + sumFormula(divAccts, 'C$2', false)).setNumberFormat(fmt);
  sheet.getRange(row, 5).setFormula('=SUM(B' + row + ':D' + row + ')').setNumberFormat(fmt);
  sheet.getRange(row, 1, 1, 5).setBackground('#f0f0f0');
  sheet.getRange(row, 1, 1, 5).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  var openRow = row;
  row++;

  // ── Net Profit / (Loss) ──────────────────────────────────────────────────────
  // NI = -(sum of P&L deltas) = SUM(credit-debit) for P&L period
  var niRow = row;
  sheet.getRange(row, 1).setValue('Net Profit / (Loss)');
  sheet.getRange(row, 2).setValue(0).setNumberFormat(fmt); // SC: 0
  // NI formula: negate sum of P&L movements (debit-credit → credit-debit)
  if (plCodes.length > 0) {
    var niParts = plCodes.map(function(c) { return pbDelta_('"' + c + '"', 'C$3'); });
    sheet.getRange(row, 3).setFormula('=-(' + niParts.join('+') + ')').setNumberFormat(fmt);
  } else {
    sheet.getRange(row, 3).setValue(0).setNumberFormat(fmt);
  }
  sheet.getRange(row, 4).setValue(0).setNumberFormat(fmt); // Div: 0
  sheet.getRange(row, 5).setFormula('=SUM(B' + row + ':D' + row + ')').setNumberFormat(fmt);
  row++;

  // ── Dividends declared ───────────────────────────────────────────────────────
  var divRow = row;
  sheet.getRange(row, 1).setValue('Dividends declared');
  sheet.getRange(row, 2).setValue(0).setNumberFormat(fmt);
  sheet.getRange(row, 3).setValue(0).setNumberFormat(fmt);
  sheet.getRange(row, 4).setFormula('=' + sumFormula(divAccts, 'C$3', true)).setNumberFormat(fmt);
  sheet.getRange(row, 5).setFormula('=SUM(B' + row + ':D' + row + ')').setNumberFormat(fmt);
  row++;

  // ── Share Capital movements ──────────────────────────────────────────────────
  var scMovRow = row;
  sheet.getRange(row, 1).setValue('Share capital movements');
  sheet.getRange(row, 2).setFormula('=' + sumFormula(scAccts, 'C$3', true)).setNumberFormat(fmt);
  sheet.getRange(row, 3).setValue(0).setNumberFormat(fmt);
  sheet.getRange(row, 4).setValue(0).setNumberFormat(fmt);
  sheet.getRange(row, 5).setFormula('=SUM(B' + row + ':D' + row + ')').setNumberFormat(fmt);
  row++;

  // ── Other RE movements ───────────────────────────────────────────────────────
  // Total RE movement for the period minus Net Income = other RE movements
  var otherRow = row;
  sheet.getRange(row, 1).setValue('Other RE movements');
  sheet.getRange(row, 2).setValue(0).setNumberFormat(fmt);
  // Other RE = total RE delta - NI
  sheet.getRange(row, 3).setFormula('=' + sumFormula(reAccts, 'C$3', true) + '-C' + niRow).setNumberFormat(fmt);
  sheet.getRange(row, 4).setValue(0).setNumberFormat(fmt);
  sheet.getRange(row, 5).setFormula('=SUM(B' + row + ':D' + row + ')').setNumberFormat(fmt);
  row++;

  // ── Closing Balance ──────────────────────────────────────────────────────────
  // Closing = Opening + all movements
  var closeRow = row;
  sheet.getRange(row, 1).setValue('Closing Balance').setFontWeight('bold');
  sheet.getRange(row, 2).setFormula('=SUM(B' + openRow + ':B' + (row - 1) + ')').setFontWeight('bold').setNumberFormat(fmt);
  sheet.getRange(row, 3).setFormula('=SUM(C' + openRow + ':C' + (row - 1) + ')').setFontWeight('bold').setNumberFormat(fmt);
  sheet.getRange(row, 4).setFormula('=SUM(D' + openRow + ':D' + (row - 1) + ')').setFontWeight('bold').setNumberFormat(fmt);
  sheet.getRange(row, 5).setFormula('=SUM(B' + row + ':D' + row + ')').setFontWeight('bold').setNumberFormat(fmt);
  sheet.getRange(row, 1, 1, 5).setBackground('#e0e0e0');
  sheet.getRange(row, 1, 1, 5).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  sheet.setFrozenRows(4);
  stampCacheFreshness_(sheet);
  Logger.log('SCE built');
}
/**
 * Build the Integrity Check tab.
 * Transparent spreadsheet design: uses explicit account numbers in Col A, 
 * labels in Col B, INDEX/MATCH formulas in Col C, and native SUM() for totals.
 * Users can easily drag periods or insert new accounts.
 */
function buildIntegrity_(sheet, ss) {
  var coaSheet = ss.getSheetByName('COA');
  var cacheSheet = ss.getSheetByName('Period Balances');
  if (!coaSheet) { Logger.log('Integrity error: COA not found'); return; }
  if (!cacheSheet) { Logger.log('Integrity error: cache not found'); return; }

  var _coa = getSheetDataWithHeaders_(coaSheet);
  var coaData = [_coa.headers].concat(_coa.data);
  var cHdrs = coaData[0];
  
  // Case-insensitive header lookup
  var colMap = {};
  for (var c = 0; c < cHdrs.length; c++) {
    colMap[String(cHdrs[c]).trim().toLowerCase()] = c;
  }
  var cCode  = colMap['account code'];
  var cType  = colMap['account type'];
  var cCFCat = colMap['cf category'];

  var uncatAccts = [];
  var cashAccts = [];
  
  for (var i = 1; i < coaData.length; i++) {
    var code = String(coaData[i][cCode] || '').trim();
    var type = String(coaData[i][cType] || '').trim();
    var cfCat = cCFCat >= 0 ? String(coaData[i][cCFCat] || '').trim() : '';
    
    if (!code || code.length < 6 || code.indexOf('999999') === 0) continue;
    
    if ((type === 'Asset' || type === 'Liability') && !cfCat) uncatAccts.push(code);
    if (cfCat === 'Cash') cashAccts.push(code);
  }

  // Read FY periods from cache
  var _cacheInt = getSheetDataWithHeaders_(cacheSheet);
  var cacheHdrs = _cacheInt.headers;
  var fyPeriods = [];
  for (var ci = 0; ci < cacheHdrs.length; ci++) {
    var h = String(cacheHdrs[ci] || '').trim();
    if (/^FY\d{4}$/.test(h)) fyPeriods.push(h);
  }
  fyPeriods.sort();

  var companyName = '';
  var settingsSheet = ss.getSheetByName('Settings');
  if (settingsSheet) {
    var sData = settingsSheet.getDataRange().getValues();
    for (var s = 0; s < sData.length; s++) {
      if (String(sData[s][0] || '').trim().toLowerCase() === 'company') companyName = String(sData[s][1] || '').trim();
    }
  }

  sheet.clear();
  sheet.setColumnWidth(1, 80);
  sheet.setColumnWidth(2, 280);
  sheet.setColumnWidth(3, 140);
  sheet.setColumnWidth(4, 100);
  sheet.setColumnWidth(5, 120);

  sheet.getRange(1, 1).setValue('').setFontWeight('bold');
  sheet.getRange(1, 2).setValue('').setFontWeight('bold');
  
  sheet.getRange(2, 1).setValue(''); 
  sheet.getRange(2, 2).setValue('Period').setFontWeight('bold');
  sheet.getRange(2, 3).setValue('FY2026').setFontWeight('bold').setBackground('#e8f0fe');
  setPeriodDropdown_(ss, sheet.getRange(2, 3));
  sheet.getRange(1, 3).setFormula('="FY"&(VALUE(RIGHT(C2,4))-1)').setFontColor('#ffffff'); // Prior period hidden

  var fmt = '#,##0.00;(#,##0.00);0.00';
  var row = 4;

  function secHdr(title) {
    sheet.getRange(row, 1).setValue(title).setFontWeight('bold');
    sheet.getRange(row, 1, 1, 4).setBackground('#d0d0d0');
    row++;
  }

  function checkRow(code, label, isDelta) {
    sheet.getRange(row, 1).setValue(code).setFontColor('#888888');
    sheet.getRange(row, 2).setValue(label);
    var formula = isDelta ? pbDelta_('$A' + row, 'C$2') : pbCum_('$A' + row, 'C$2');
    sheet.getRange(row, 3).setFormula('=' + formula).setNumberFormat(fmt);
    row++;
  }

  // ── 1. Trial Balance ──────────────────────────────────────────────────────────
  secHdr('1. Trial Balance: Debit = Credit');
  var tbStart = row;
  checkRow('1', 'Total Assets', false);
  checkRow('2', 'Total Liabilities + Equity', false);
  var tbRow3 = row; checkRow('3', 'Total Revenue', false);
  var tbRow5 = row; checkRow('5', 'Total Expenses', false);
  var tbRow6 = row; checkRow('6', 'Total Other Expenses', false);
  var tbRow9 = row; checkRow('999999', 'Undistributed Profits/Losses', false);
  var tbEnd = row - 1;
  sheet.getRange(row, 2).setValue('Sum all (should be 0)').setFontWeight('bold');
  sheet.getRange(row, 3).setFormula('=SUM(C' + tbStart + ':C' + tbEnd + ')').setNumberFormat(fmt).setFontWeight('bold');
  sheet.getRange(row, 4).setFormula('=IF(ABS(C' + row + ')<0.01,"✅","❌")');
  row++; row++;

  // ── 2. Balance Sheet: A = L + E ──────────────────────────────────────────────
  secHdr('2. Balance Sheet: A = L + E');
  var bsStart = row;
  checkRow('1', 'Total Assets', false);
  checkRow('2', 'Total Liabilities + Equity', false);
  sheet.getRange(row, 2).setValue('Unclosed P&L (3 + 5 + 6 + 999999)');
  sheet.getRange(row, 3).setFormula('=C' + tbRow3 + '+C' + tbRow5 + '+C' + tbRow6 + '+C' + tbRow9).setNumberFormat(fmt);
  row++;
  var bsEnd = row - 1;
  sheet.getRange(row, 2).setValue('A + L+E + Unclosed (should be 0)').setFontWeight('bold');
  sheet.getRange(row, 3).setFormula('=SUM(C' + bsStart + ':C' + bsEnd + ')').setNumberFormat(fmt).setFontWeight('bold');
  sheet.getRange(row, 4).setFormula('=IF(ABS(C' + row + ')<0.01,"✅","❌")');
  row++; row++;

  // ── 3. P&L vs Closing ────────────────────────────────────────────────────────
  secHdr('3. P&L Net = Closing Entry Net (Period Delta)');
  var plStart = row;
  checkRow('3', 'Total Revenue', true);
  checkRow('5', 'Total Expenses', true);
  checkRow('6', 'Total Other Expenses', true);
  checkRow('999999', 'Closing Entries', true);
  var plEnd = row - 1;
  sheet.getRange(row, 2).setValue('Sum all (should be 0)').setFontWeight('bold');
  sheet.getRange(row, 3).setFormula('=SUM(C' + plStart + ':C' + plEnd + ')').setNumberFormat(fmt).setFontWeight('bold');
  sheet.getRange(row, 4).setFormula('=IF(ABS(C' + row + ')<0.01,"✅","❌")');
  row++; row++;

  sheet.getRange(row, 1).setValue('RETAINED EARNINGS ROLL-FORWARD').setFontWeight('bold').setBackground('#c0c0c0');
  sheet.getRange(row, 1, 1, 5).setBackground('#c0c0c0');
  row++;
  sheet.getRange(row, 1).setValue('FY').setFontWeight('bold');
  sheet.getRange(row, 2).setValue('Opening RE').setFontWeight('bold');
  sheet.getRange(row, 3).setValue('RE Movement').setFontWeight('bold');
  sheet.getRange(row, 4).setValue('Closing RE').setFontWeight('bold');
  sheet.getRange(row, 5).setValue('Check').setFontWeight('bold');
  sheet.getRange(row, 1, 1, 5).setBackground('#e6e6e6');
  row++;

  var reCodes = [];
  for (var i = 1; i < coaData.length; i++) {
    var code = String(coaData[i][cCode] || '').trim();
    var type = String(coaData[i][cType] || '').trim();
    if (!code || type !== 'Equity') continue;
    if (code.length < 6 || code.indexOf('999999') === 0 || code.indexOf('203080') === 0 || code.indexOf('2081') === 0 || code.indexOf('203040') === 0 || code.indexOf('2898') === 0) continue;
    reCodes.push(code);
  }

  function reSum(fy, isDelta) {
    if (reCodes.length === 0) return '0';
    var fn = isDelta ? pbDelta_ : pbCum_;
    return '(' + reCodes.map(function(c) { return fn('"' + c + '"', '"' + fy + '"'); }).join('+') + ')';
  }

  for (var fi = 0; fi < fyPeriods.length; fi++) {
    var fy = fyPeriods[fi];
    var priorFy = fi > 0 ? fyPeriods[fi - 1] : null;
    sheet.getRange(row, 1).setValue(fy);
    if (priorFy) {
      sheet.getRange(row, 2).setFormula('=-' + reSum(priorFy, false)).setNumberFormat(fmt);
    } else {
      sheet.getRange(row, 2).setValue(0).setNumberFormat(fmt);
    }
    sheet.getRange(row, 3).setFormula('=-' + reSum(fy, true)).setNumberFormat(fmt);
    sheet.getRange(row, 4).setFormula('=B' + row + '+C' + row).setNumberFormat(fmt);
    if (fi === 0) {
      sheet.getRange(row, 5).setValue('—');
    } else {
      sheet.getRange(row, 5).setFormula('=IF(ABS(B' + row + '-D' + (row - 1) + ')<0.01,"✅","❌")');
    }
    row++;
  }
  row++;

  // ══════════════════════════════════════════════════════════════════════════════
  // P&L vs CLOSING ENTRY — ALL YEARS
  // ══════════════════════════════════════════════════════════════════════════════
  sheet.getRange(row, 1).setValue('P&L vs CLOSING ENTRY — ALL YEARS').setFontWeight('bold').setBackground('#c0c0c0');
  sheet.getRange(row, 1, 1, 5).setBackground('#c0c0c0');
  row++;
  sheet.getRange(row, 1).setValue('FY').setFontWeight('bold');
  sheet.getRange(row, 2).setValue('P&L Net').setFontWeight('bold');
  sheet.getRange(row, 3).setValue('Closing').setFontWeight('bold');
  sheet.getRange(row, 4).setValue('Diff').setFontWeight('bold');
  sheet.getRange(row, 5).setValue('Status').setFontWeight('bold');
  sheet.getRange(row, 1, 1, 5).setBackground('#e6e6e6');
  row++;

  for (var fi = 0; fi < fyPeriods.length; fi++) {
    var fy = fyPeriods[fi];
    sheet.getRange(row, 1).setValue(fy);
    sheet.getRange(row, 2).setFormula('=' + pbDelta_('"3"', '"' + fy + '"') + '+' + pbDelta_('"5"', '"' + fy + '"') + '+' + pbDelta_('"6"', '"' + fy + '"')).setNumberFormat(fmt);
    sheet.getRange(row, 3).setFormula('=' + pbDelta_('"999999"', '"' + fy + '"')).setNumberFormat(fmt);
    sheet.getRange(row, 4).setFormula('=B' + row + '+C' + row).setNumberFormat(fmt);
    sheet.getRange(row, 5).setFormula('=IF(ABS(D' + row + ')<0.01,"✅","❌")');
    row++;
  }

  sheet.setFrozenRows(3);
  stampCacheFreshness_(sheet);
  Logger.log('Integrity built');
}


function showGL() {
  navigateToTab('General Ledger');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
}

function showSettings() {
  navigateToTab('Settings');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
}

function postActiveSheet() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var name = sheet.getName();
  var result = saveTab_(name);
  SpreadsheetApp.getUi().alert(result);
}
