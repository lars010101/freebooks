/**
 * Skuld — Apps Script Thin Relay
 *
 * This file contains NO business logic.
 * Every function: read from Sheet → call Cloud Function → write result to Sheet.
 */

// =============================================================================
// Core relay function — all actions go through here
// =============================================================================

/**
 * Call the Skuld Cloud Function with a payload.
 * @param {string} action - Action name (e.g., 'journal.post')
 * @param {object} payload - Additional data to send
 * @returns {object} - Response data from Cloud Function
 */
function callSkuld_(action, payload) {
  var config = getConfig_();
  var companyId = getActiveCompanyId_();
  var userEmail = Session.getActiveUser().getEmail();

  var body = {
    action: action,
    companyId: companyId,
    userEmail: userEmail
  };

  // Merge payload
  if (payload) {
    for (var key in payload) {
      body[key] = payload[key];
    }
  }

  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    headers: {
      'Authorization': 'Bearer ' + ScriptApp.getOAuthToken()
    },
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(config.functionUrl, options);
  var code = response.getResponseCode();
  var result = JSON.parse(response.getContentText());

  if (code !== 200) {
    SpreadsheetApp.getUi().alert(
      'Error: ' + (result.error || 'Unknown error')
    );
    return null;
  }

  return result.data;
}

// =============================================================================
// Journal Entry
// =============================================================================

function onPostJournalEntry() {
  var html = HtmlService.createHtmlOutputFromFile('sidebar-entry')
    .setTitle('⚖️ Journal Entry')
    .setWidth(340);
  SpreadsheetApp.getUi().showSidebar(html);
}

/**
 * Get account list for sidebar dropdown.
 */
function getAccountList() {
  var result = callSkuld_('coa.list', {});
  if (!result) return [];
  return result.map(function(a) {
    return { code: a.account_code, name: a.account_name, type: a.account_type };
  });
}

/**
 * Get VAT code list for sidebar dropdown.
 */
function getVatCodeList() {
  var result = callSkuld_('vat.codes.list', {});
  if (!result) return [];
  return result.map(function(v) {
    return { code: v.vat_code, rate: v.rate, description: v.description };
  });
}

/**
 * Post journal entry from sidebar form.
 */
function postJournalFromSidebar(lines) {
  return callSkuld_('journal.post', { lines: lines, source: 'manual' });
}

function onReverseEntry() {
  var batchId = SpreadsheetApp.getUi().prompt('Enter the Batch ID to reverse:').getResponseText();
  if (!batchId) return;

  var result = callSkuld_('journal.reverse', { batchId: batchId.trim() });
  if (result && result.reversed) {
    SpreadsheetApp.getUi().alert('Reversed. New batch: ' + result.reversalBatchId.substring(0, 8));
  }
}

// =============================================================================
// Bank Processing
// =============================================================================

function onProcessBankStatement() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Bank Processing');
  var rows = readBankRows_(sheet);

  if (rows.length === 0) {
    SpreadsheetApp.getUi().alert('No bank statement rows found.');
    return;
  }

  var result = callSkuld_('bank.process', { rows: rows });
  if (result) {
    writeBankProcessingResults_(sheet, result.processed);
    SpreadsheetApp.getUi().alert(
      'Processed: ' + result.summary.total + ' rows\n'
      + 'Rule matched: ' + result.summary.ruleMatched + '\n'
      + 'Bill matched: ' + result.summary.billMatched + '\n'
      + 'Unmatched: ' + result.summary.unmatched
    );
  }
}

function onApproveBankEntries() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Bank Processing');
  var entries = readApprovedBankEntries_(sheet);
  var newMappings = readNewMappings_(sheet);

  var result = callSkuld_('bank.approve', { entries: entries, newMappings: newMappings });
  if (result) {
    SpreadsheetApp.getUi().alert(
      'Posted: ' + result.posted + ' entries\n'
      + (result.failed > 0 ? 'Failed: ' + result.failed + '\n' : '')
      + 'New mappings saved: ' + result.newMappings
    );
  }
}

// =============================================================================
// Bills (A/P)
// =============================================================================

function onCreateBill() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Bills');
  var bill = readBillForm_(sheet);
  var result = callSkuld_('bill.create', { bill: bill });
  if (result && result.created) {
    SpreadsheetApp.getUi().alert('Bill created: ' + result.billId.substring(0, 8));
    onRefreshBills();
  }
}

function onPostBill() {
  var billId = getSelectedBillId_();
  if (!billId) return;
  var result = callSkuld_('bill.post', { billId: billId });
  if (result && result.posted) {
    SpreadsheetApp.getUi().alert('Bill posted. Journal batch: ' + result.batchId.substring(0, 8));
    onRefreshBills();
  }
}

function onVoidBill() {
  var billId = getSelectedBillId_();
  if (!billId) return;
  var result = callSkuld_('bill.void', { billId: billId });
  if (result && result.voided) {
    SpreadsheetApp.getUi().alert('Bill voided.');
    onRefreshBills();
  }
}

function onRefreshBills() {
  var result = callSkuld_('bill.list', {});
  if (result) {
    writeToSheet_('Bills', result, ['bill_id', 'vendor', 'vendor_ref', 'date',
      'due_date', 'amount', 'currency', 'status', 'amount_paid']);
  }
}

// =============================================================================
// Reports
// =============================================================================

function onRefreshTB() {
  var params = getReportParams_();
  var result = callSkuld_('report.refresh_tb', params);
  if (result) { writeReportToSheet_('TB', result); activateSheet_('TB'); }
}

function onRefreshPL() {
  var params = getReportParams_();
  var result = callSkuld_('report.refresh_pl', params);
  if (result) { writeReportToSheet_('PL', result); activateSheet_('PL'); }
}

function onRefreshBS() {
  var params = getReportParams_();
  var result = callSkuld_('report.refresh_bs', params);
  if (result) { writeReportToSheet_('BS', result); activateSheet_('BS'); }
}

function onRefreshCF() {
  var params = getReportParams_();
  var result = callSkuld_('report.refresh_cf', params);
  if (result) { writeReportToSheet_('CF', result); activateSheet_('CF'); }
}

function onRefreshDashboard() {
  var params = getReportParams_();
  var result = callSkuld_('report.refresh_dashboard', params);
  if (result) { writeReportToSheet_('Dashboard', result); activateSheet_('Dashboard'); }
}

function onRefreshAPAging() {
  var result = callSkuld_('report.refresh_ap_aging', {});
  if (result) { writeReportToSheet_('AP Aging', result); activateSheet_('AP Aging'); }
}

function onRefreshVATReturn() {
  var params = getVATReturnParams_();
  var result = callSkuld_('report.refresh_vat_return', params);
  if (result) { writeReportToSheet_('VAT Return', result); activateSheet_('VAT Return'); }
}

function onRefreshAllReports() {
  onRefreshTB();
  onRefreshPL();
  onRefreshBS();
  onRefreshCF();
  onRefreshDashboard();
  activateSheet_('Dashboard');
}

/**
 * Run an action from the sidebar Actions tab.
 */
function runSidebarAction(action) {
  switch (action) {
    case 'refreshAll':
      onRefreshTB();
      onRefreshPL();
      onRefreshBS();
      onRefreshCF();
      onRefreshDashboard();
      return '✅ All reports refreshed';
    case 'fetchFx':
      onFetchFXRates();
      return '✅ FX rates fetched';
    case 'loadCoa':
      onRefreshCOA();
      return '✅ COA loaded to sheet';
    case 'backup':
      onExportBackup();
      return '✅ Backup exported to Drive';
    case 'processBankStatement':
      onProcessBankStatement();
      return '✅ Bank statement processed';
    case 'approveBankEntries':
      onApproveBankEntries();
      return '✅ Bank entries posted';
    default:
      return '❌ Unknown action: ' + action;
  }
}

/**
 * Get status info for the sidebar Status tab.
 */
function getSidebarStatus() {
  var result = callSkuld_('report.refresh_dashboard', getReportParams_());
  if (!result) return '<p>Could not load status.</p>';

  var html = '<div class="info-card">'
    + '<div class="info-row"><span class="label">Revenue</span><span class="value">' + (result.revenue || 0).toLocaleString() + '</span></div>'
    + '<div class="info-row"><span class="label">Expenses</span><span class="value">' + (result.expenses || 0).toLocaleString() + '</span></div>'
    + '<div class="info-row"><span class="label">Net Income</span><span class="value" style="color:' + (result.netIncome >= 0 ? '#137333' : '#c5221f') + '">' + (result.netIncome || 0).toLocaleString() + '</span></div>'
    + '</div>'
    + '<div class="info-card">'
    + '<div class="info-row"><span class="label">Assets</span><span class="value">' + (result.totalAssets || 0).toLocaleString() + '</span></div>'
    + '<div class="info-row"><span class="label">Liabilities</span><span class="value">' + (result.totalLiabilities || 0).toLocaleString() + '</span></div>'
    + '<div class="info-row"><span class="label">Equity</span><span class="value">' + (result.totalEquity || 0).toLocaleString() + '</span></div>'
    + '<div class="info-row"><span class="label">Balanced</span><span class="value">' + (result.balanced ? '✅' : '❌') + '</span></div>'
    + '</div>'
    + '<div class="info-card">'
    + '<div class="info-row"><span class="label">Entries</span><span class="value">' + (result.entryCount || 0) + '</span></div>'
    + '<div class="info-row"><span class="label">First</span><span class="value">' + formatVal_(result.firstDate) + '</span></div>'
    + '<div class="info-row"><span class="label">Last</span><span class="value">' + formatVal_(result.lastDate) + '</span></div>'
    + '</div>';
  return html;
}

function formatVal_(v) {
  if (!v) return '—';
  if (typeof v === 'object' && v.value) return v.value;
  return String(v);
}

/**
 * Activate (bring to front) a named sheet.
 */
function activateSheet_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (sheet) sheet.activate();
}

// =============================================================================
// COA, Mappings, Centers, VAT Codes, Settings
// =============================================================================

function onSaveCOA() {
  var accounts = readSheetData_('COA');
  callSkuld_('coa.save', { accounts: accounts });
}

function onRefreshCOA() {
  var result = callSkuld_('coa.list', {});
  if (result) writeToSheet_('COA', result, ['account_code', 'account_name', 'account_type',
    'account_subtype', 'pl_category', 'bs_category', 'cf_category', 'is_active',
    'effective_from', 'effective_to']);
}

function onSaveMappings() {
  var mappings = readSheetData_('Mappings');
  callSkuld_('mapping.save', { mappings: mappings });
}

function onSaveCenters() {
  var centers = readSheetData_('Centers');
  callSkuld_('center.save', { centers: centers });
}

function onSaveVATCodes() {
  var vatCodes = readSheetData_('VAT Codes');
  callSkuld_('vat.codes.save', { vatCodes: vatCodes });
}

function onSaveSettings() {
  var settings = readSettingsFromSheet_();
  callSkuld_('settings.save', { settings: settings });
}

// =============================================================================
// FX
// =============================================================================

function onFetchFXRates() {
  var result = callSkuld_('fx.fetch_rates', {});
  if (result) {
    SpreadsheetApp.getUi().alert(
      'Fetched ' + result.rateCount + ' rates for ' + result.date
    );
  }
}

// =============================================================================
// Backup
// =============================================================================

function onExportBackup() {
  var result = callSkuld_('backup.export', {});
  if (result) {
    // Save to Google Drive as JSON
    var fileName = result.companyId + '_' + result.exportedAt.substring(0, 10) + '.json';
    DriveApp.createFile(fileName, JSON.stringify(result, null, 2), 'application/json');
    SpreadsheetApp.getUi().alert('Backup saved to Google Drive: ' + fileName);
  }
}

// =============================================================================
// Import
// =============================================================================

function onImportJournalEntries() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Import');
  var entries = readImportData_(sheet);
  var result = callSkuld_('journal.import', { entries: entries });
  if (result) {
    SpreadsheetApp.getUi().alert(
      'Imported: ' + result.imported + '\n'
      + 'Failed: ' + result.failed
      + (result.errors.length > 0 ? '\n\nErrors:\n' + JSON.stringify(result.errors) : '')
    );
  }
}

// =============================================================================
// Export
// =============================================================================

function onExportJournalEntries() {
  var params = getReportParams_();
  var result = callSkuld_('journal.export', params);
  if (result) {
    writeToSheet_('Export', result.entries, [
      'date', 'batch_id', 'account_code', 'debit', 'credit',
      'currency', 'description', 'reference', 'source'
    ]);
  }
}

// =============================================================================
// Menu
// =============================================================================

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('⚖️ Skuld')
    .addItem('📝 New Journal Entry', 'onPostJournalEntry')
    .addItem('↩️ Reverse Entry', 'onReverseEntry')
    .addSeparator()
    .addItem('🏦 Process Bank Statement', 'onProcessBankStatement')
    .addItem('✅ Approve & Post Bank Entries', 'onApproveBankEntries')
    .addSeparator()
    .addItem('📄 Create Bill', 'onCreateBill')
    .addItem('📬 Post Bill', 'onPostBill')
    .addItem('❌ Void Bill', 'onVoidBill')
    .addSeparator()
    .addItem('📊 Refresh All Reports', 'onRefreshAllReports')
    .addItem('💱 Fetch FX Rates', 'onFetchFXRates')
    .addItem('💾 Export Backup', 'onExportBackup')
    .addSeparator()
    .addSubMenu(ui.createMenu('More')
      .addItem('📥 Import Journal Entries', 'onImportJournalEntries')
      .addItem('📤 Export Journal Entries', 'onExportJournalEntries')
      .addItem('📋 Load COA from DB', 'onRefreshCOA')
      .addSeparator()
      .addItem('Save COA', 'onSaveCOA')
      .addItem('Save Mappings', 'onSaveMappings')
      .addItem('Save Centers', 'onSaveCenters')
      .addItem('Save VAT Codes', 'onSaveVATCodes')
      .addItem('Save Settings', 'onSaveSettings'))
    .addToUi();

  // Auto-open sidebar
  onPostJournalEntry();
}
