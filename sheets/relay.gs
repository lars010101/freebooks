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
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Manual Entry');
  var lines = readEntryLines_(sheet);

  if (lines.length === 0) {
    SpreadsheetApp.getUi().alert('No entry lines found.');
    return;
  }

  var result = callSkuld_('journal.post', { lines: lines, source: 'manual' });
  if (result) {
    if (result.posted) {
      SpreadsheetApp.getUi().alert(
        'Posted: ' + result.lineCount + ' lines (batch ' + result.batchId.substring(0, 8) + ')'
        + (result.warnings.length > 0 ? '\n\nWarnings:\n' + result.warnings.join('\n') : '')
      );
      clearEntryForm_(sheet);
    } else {
      SpreadsheetApp.getUi().alert('Validation errors:\n' + result.errors.join('\n'));
    }
  }
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
  SpreadsheetApp.getUi().alert('All reports refreshed.');
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
    .addItem('📝 Post Journal Entry', 'onPostJournalEntry')
    .addItem('↩️ Reverse Entry', 'onReverseEntry')
    .addSeparator()
    .addItem('🏦 Process Bank Statement', 'onProcessBankStatement')
    .addItem('✅ Approve & Post Bank Entries', 'onApproveBankEntries')
    .addSeparator()
    .addItem('📄 Create Bill', 'onCreateBill')
    .addItem('📬 Post Bill', 'onPostBill')
    .addItem('❌ Void Bill', 'onVoidBill')
    .addSeparator()
    .addSubMenu(ui.createMenu('📊 Reports')
      .addItem('Trial Balance', 'onRefreshTB')
      .addItem('Profit & Loss', 'onRefreshPL')
      .addItem('Balance Sheet', 'onRefreshBS')
      .addItem('Cash Flow', 'onRefreshCF')
      .addItem('Dashboard', 'onRefreshDashboard')
      .addItem('AP Aging', 'onRefreshAPAging')
      .addItem('VAT Return', 'onRefreshVATReturn')
      .addItem('Refresh All', 'onRefreshAllReports'))
    .addSeparator()
    .addItem('💱 Fetch FX Rates', 'onFetchFXRates')
    .addItem('💾 Export Backup', 'onExportBackup')
    .addItem('📥 Import Journal Entries', 'onImportJournalEntries')
    .addItem('📤 Export Journal Entries', 'onExportJournalEntries')
    .addSeparator()
    .addSubMenu(ui.createMenu('⚙️ Save')
      .addItem('Save COA', 'onSaveCOA')
      .addItem('Save Mappings', 'onSaveMappings')
      .addItem('Save Centers', 'onSaveCenters')
      .addItem('Save VAT Codes', 'onSaveVATCodes')
      .addItem('Save Settings', 'onSaveSettings'))
    .addToUi();
}
