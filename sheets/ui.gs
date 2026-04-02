/**
 * Skuld — UI Helpers
 *
 * Sheet reading/writing utilities used by the relay functions.
 * These handle the translation between Sheet layout and API payloads.
 */

// =============================================================================
// Generic Sheet ↔ Data helpers
// =============================================================================

/**
 * Read all data from a named sheet as array of objects.
 * First row = headers (keys), remaining rows = values.
 */
function readSheetData_(sheetName) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return [];

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  // Find the header row: first row that looks like column headers (skip metadata rows)
  var headerRowIdx = 0;
  for (var h = 0; h < Math.min(data.length, 10); h++) {
    var firstCell = String(data[h][0] || '').trim().toLowerCase();
    // Skip known metadata prefixes or empty cells
    if (firstCell === 'company:' || firstCell === 'currency:' || firstCell === 'refreshed:' || 
        firstCell === 'data as of:' || firstCell === 'period:' || 
        firstCell === 'refresh sheet to populate with data' || firstCell === '') {
      continue;
    }
    headerRowIdx = h;
    break;
  }

  var headers = data[headerRowIdx].map(function(h) {
    return String(h).trim().toLowerCase().replace(/\s+/g, '_');
  });
  var rows = [];

  for (var i = headerRowIdx + 1; i < data.length; i++) {
    var row = data[i];
    // Skip empty rows
    if (!row[0] && !row[1]) continue;

    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      var val = row[j];
      if (val instanceof Date) {
        val = Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      }
      obj[headers[j]] = val;
    }
    rows.push(obj);
  }

  return rows;
}

/**
 * Write an array of objects to a named sheet.
 * @param {string} sheetName
 * @param {object[]} data - Array of row objects
 * @param {string[]} columns - Column keys to write (in order)
 */
function writeToSheet_(sheetName, data, columns) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return;

  // Global Metadata block
  var companyId = typeof getActiveCompanyId_ === 'function' ? getActiveCompanyId_() : (PropertiesService.getScriptProperties().getProperty('COMPANY_ID') || '');
  var cName = companyId;
  var currency = '';
  
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cSheet = ss.getSheetByName('Companies');
  if (cSheet) {
    var cData = cSheet.getDataRange().getValues();
    var hIdx = -1;
    for (var i = 0; i < Math.min(cData.length, 10); i++) {
      if (String(cData[i][0]).trim().toLowerCase() === 'company id') { hIdx = i; break; }
    }
    if (hIdx !== -1) {
      var headers = cData[hIdx].map(function(h) { return String(h).trim().toLowerCase(); });
      var idCol = headers.indexOf('company id');
      var nameCol = headers.indexOf('company name');
      var currCol = headers.indexOf('base currency');
      for (var r = hIdx + 1; r < cData.length; r++) {
        if (String(cData[r][idCol]).trim() === companyId) {
          if (nameCol >= 0 && cData[r][nameCol]) cName = String(cData[r][nameCol]).trim();
          if (currCol >= 0 && cData[r][currCol]) currency = String(cData[r][currCol]).trim();
          break;
        }
      }
    }
  }

  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  
  // Read existing period if any
  var currentPeriod = String(sheet.getRange('B4').getValue()).trim();

  // Clear the entire sheet to ensure no ghost data from old layouts remains
  sheet.clear();

  // Rows 1-3: metadata block on ALL tabs
  sheet.getRange('A1:B1').setValues([['Company:', cName]]);
  sheet.getRange('A2:B2').setValues([['Currency:', currency]]);
  sheet.getRange('A3:B3').setValues([['Refreshed:', now]]);
  sheet.getRange('A1:A3').setFontWeight('bold');

  // Row 4: Period selector for Journal tab
  if (sheetName === 'Journal') {
    var periodsList = getCachePeriods_(ss);
    var latestPeriod = periodsList.length > 0 ? periodsList[periodsList.length - 1] : '';
    var displayPeriod = currentPeriod || latestPeriod;
    sheet.getRange('A4').setValue('Period:').setFontWeight('bold');
    sheet.getRange('B4').setValue(displayPeriod).setFontWeight('bold');
    setPeriodDropdown_(ss, sheet.getRange('B4'));
    sheet.getRange('B4').setBackground('#e8f0fe');
    sheet.getRange('5:5').setBackground('#eeeeee');
  }

  // Headers always start on row 6, data on row 7
  var headerRowNum = 6;
  var dataStartRow = 7;

  // Write headers
  var headerRow = columns.map(function(c) {
    return c.replace(/_/g, ' ').replace(/\b\w/g, function(l) { return l.toUpperCase(); });
  });
  sheet.getRange(headerRowNum, 1, 1, columns.length).setValues([headerRow]);
  sheet.getRange(headerRowNum, 1, 1, columns.length).setFontWeight('bold').setBackground('#e6e6e6');
  sheet.setFrozenRows(headerRowNum);

  if (!data || data.length === 0) {
    for (var c = 1; c <= columns.length; c++) sheet.autoResizeColumn(c);
    return;
  }

  // Write data
  var rows = data.map(function(item) {
    return columns.map(function(col) {
      var val = item[col];
      if (val === undefined || val === null) return '';
      if (typeof val === 'object' && val.value !== undefined) return val.value;
      return val;
    });
  });

  if (rows.length > 0) {
    sheet.getRange(dataStartRow, 1, rows.length, columns.length).setValues(rows);
  }

  // Auto-resize all used columns
  for (var c = 1; c <= columns.length; c++) {
    sheet.autoResizeColumn(c);
  }
}

/**
 * Write report data to sheet. Handles different report formats.
 */
function writeReportToSheet_(sheetName, reportData) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return;

  // Clear existing data, formatting, AND merges (keep header row)
  if (sheet.getLastRow() > 1) {
    var cr = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), Math.max(sheet.getLastColumn(), 10));
    cr.breakApart();
    cr.clearContent();
    cr.setFontWeight('normal');
    cr.setBackground(null);
    cr.setBorder(false, false, false, false, false, false);
  }

  switch (reportData.report) {
    case 'trial_balance':
      writeToSheet_(sheetName, reportData.rows, [
        'accountCode', 'accountName', 'accountType', 'debit', 'credit', 'balance'
      ]);
      break;

    case 'dashboard':
      var dRow = 2;
      var metrics = [
        ['Revenue', reportData.revenue],
        ['Expenses', reportData.expenses],
        ['Net Income', reportData.netIncome],
        ['', ''],
        ['Total Assets', reportData.totalAssets],
        ['Total Liabilities', reportData.totalLiabilities],
        ['Total Equity', reportData.totalEquity],
        ['Balanced', reportData.balanced ? 'Yes' : 'No'],
        ['', ''],
        ['Journal Entries', reportData.entryCount],
        ['First Entry', unwrapValue_(reportData.firstDate)],
        ['Last Entry', unwrapValue_(reportData.lastDate)],
      ];
      for (var m = 0; m < metrics.length; m++) {
        sheet.getRange(dRow + m, 1).setValue(metrics[m][0]);
        sheet.getRange(dRow + m, 2).setValue(metrics[m][1]);
        if (metrics[m][0]) sheet.getRange(dRow + m, 1).setFontWeight('bold');
      }
      sheet.autoResizeColumn(1);
      sheet.autoResizeColumn(2);
      break;

    case 'ap_aging':
      var aRow = 2;
      for (var b = 0; b < reportData.buckets.length; b++) {
        var bucket = reportData.buckets[b];
        sheet.getRange(aRow, 1).setValue(bucket.label).setFontWeight('bold');
        sheet.getRange(aRow, 4).setValue(bucket.total);
        aRow++;
        for (var bi = 0; bi < bucket.bills.length; bi++) {
          var bill = bucket.bills[bi];
          sheet.getRange(aRow, 2).setValue(bill.vendor);
          sheet.getRange(aRow, 3).setValue(bill.vendorRef);
          sheet.getRange(aRow, 4).setValue(bill.outstanding);
          sheet.getRange(aRow, 5).setValue(bill.daysPastDue + ' days');
          aRow++;
        }
        aRow++;
      }
      sheet.getRange(aRow, 1).setValue('TOTAL').setFontWeight('bold');
      sheet.getRange(aRow, 4).setValue(reportData.totalOutstanding);
      break;

    default:
      // Generic: dump as JSON
      sheet.getRange(2, 1).setValue(JSON.stringify(reportData, null, 2));
  }

  // Auto-resize columns
  var lastCol = sheet.getLastColumn();
  for (var c = 1; c <= Math.max(lastCol, 6); c++) {
    sheet.autoResizeColumn(c);
  }
}

// =============================================================================
// Entry-specific readers
// =============================================================================

/**
 * Read journal entry lines from the Manual Entry sheet.
 */
function readEntryLines_(sheet) {
  return readSheetData_('Manual Entry');
}

/**
 * Read bank statement rows from the Bank Processing sheet.
 */
function readBankRows_(sheet) {
  var data = readSheetData_('Bank Processing');
  return data.map(function(row) {
    return {
      date: row.date || row.Date,
      description: row.description || row.Description,
      amount: Number(row.amount || row.Amount || 0),
      currency: row.currency || row.Currency || undefined,
    };
  });
}

/**
 * Read approved bank entries (after processing) from the Bank Processing sheet.
 */
function readApprovedBankEntries_(sheet) {
  var data = readSheetData_('Bank Processing');
  return data.filter(function(row) {
    return row.approved === true || row.approved === 'TRUE' || row.Approved === true;
  }).map(function(row) {
    return {
      date: row.date || row.Date,
      debitAccount: row.debit_account || row['Debit Account'],
      creditAccount: row.credit_account || row['Credit Account'],
      amount: Number(row.amount || row.Amount || 0),
      description: row.description || row.Description,
      vatCode: row.vat_code || row['VAT Code'] || undefined,
      costCenter: row.cost_center || row['Cost Center'] || undefined,
      profitCenter: row.profit_center || row['Profit Center'] || undefined,
      billId: row.bill_id || row['Bill ID'] || undefined,
    };
  });
}

/**
 * Read new mapping rules flagged by user.
 */
function readNewMappings_(sheet) {
  var data = readSheetData_('Bank Processing');
  return data.filter(function(row) {
    return row.save_rule === true || row.save_rule === 'TRUE' || row['Save Rule'] === true;
  }).map(function(row) {
    return {
      pattern: row.description || row.Description,
      match_type: 'contains',
      debit_account: row.debit_account || row['Debit Account'],
      credit_account: row.credit_account || row['Credit Account'],
      vat_code: row.vat_code || row['VAT Code'] || undefined,
    };
  });
}

/**
 * Read bill form data from the Bills sheet.
 */
function readBillForm_(sheet) {
  var data = readSheetData_('Bills');
  if (data.length === 0) return null;
  // Last row is the new bill being entered
  var row = data[data.length - 1];
  return {
    vendor: row.vendor || row.Vendor,
    vendor_ref: row.vendor_ref || row['Vendor Ref'],
    date: row.date || row.Date,
    due_date: row.due_date || row['Due Date'],
    amount: Number(row.amount || row.Amount || 0),
    currency: row.currency || row.Currency || undefined,
    expense_account: row.expense_account || row['Expense Account'],
    ap_account: row.ap_account || row['AP Account'],
    vat_code: row.vat_code || row['VAT Code'] || undefined,
    cost_center: row.cost_center || row['Cost Center'] || undefined,
    profit_center: row.profit_center || row['Profit Center'] || undefined,
    description: row.description || row.Description || undefined,
  };
}

/**
 * Get the selected bill ID from the Bills sheet.
 */
function getSelectedBillId_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Bills');
  var row = sheet.getActiveCell().getRow();
  if (row < 2) {
    SpreadsheetApp.getUi().alert('Select a bill row first.');
    return null;
  }
  return sheet.getRange(row, 1).getValue(); // bill_id is column 1
}

/**
 * Read settings as key-value object from the Settings sheet.
 */
function readSettingsFromSheet_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Companies');
  if (!sheet) return {};
  var data = sheet.getDataRange().getValues();
  var settings = {};
  for (var i = 0; i < data.length; i++) {
    var key = String(data[i][0]).trim();
    var value = data[i][1];
    if (key && key !== 'Setting' && key !== 'Key') {
      settings[key] = value instanceof Date
        ? Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : String(value);
    }
  }
  return settings;
}

/**
 * Read import data — expects CSV-like format on Import sheet.
 */
function readImportData_() {
  var data = readSheetData_('Import');
  // Group by batch (if batch_id column exists) or treat each row as single-line entry
  var batches = {};
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    // Skip instruction/comment rows (no valid date or account code)
    var dateVal = row.date || row.Date || '';
    var acctVal = row.account_code || row['Account Code'] || row.account || '';
    if (!dateVal || !acctVal) continue;
    var batchKey = row.batch_id || row['Batch ID'] || 'batch_' + i;
    if (!batches[batchKey]) {
      batches[batchKey] = { lines: [], source: row.source || row.Source || 'csv_import', batchId: batchKey.indexOf('batch_') === 0 ? undefined : batchKey };
    }
    batches[batchKey].lines.push({
      date: row.date || row.Date,
      account_code: row.account_code || row['Account Code'] || row.account,
      debit: Number(row.debit || row.Debit || 0),
      credit: Number(row.credit || row.Credit || 0),
      description: row.description || row.Description || '',
      reference: row.reference || row.Reference || '',
      currency: row.currency || row.Currency || undefined,
      fx_rate: row.fx_rate ? Number(row.fx_rate) : undefined,
      vat_code: row.vat_code || row['VAT Code'] || undefined,
      cost_center: row.cost_center || row['Cost Center'] || undefined,
      profit_center: row.profit_center || row['Profit Center'] || undefined,
    });
  }
  return Object.values(batches);
}

/**
 * Clear the Manual Entry form after successful posting.
 */
function clearEntryForm_(sheet) {
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
  }
}

/**
 * Write processed bank statement results back to the Bank Processing sheet.
 */
function writeBankProcessingResults_(sheet, processed) {
  // Write results starting from column after the input columns
  // Assumes input: Date | Description | Amount | Currency
  // Output: Match Type | Debit Account | Credit Account | VAT Code | Bill ID | Description | Approved | Save Rule
  var startCol = 5; // Column E
  var headers = ['Match Type', 'Debit Account', 'Credit Account', 'VAT Code',
                 'Bill ID', 'Suggested Desc', 'Approved', 'Save Rule'];

  sheet.getRange(1, startCol, 1, headers.length).setValues([headers]).setFontWeight('bold');

  for (var i = 0; i < processed.length; i++) {
    var p = processed[i];
    var row = i + 2;
    sheet.getRange(row, startCol).setValue(p.matchType || 'unmatched');
    sheet.getRange(row, startCol + 1).setValue(p.debitAccount || '');
    sheet.getRange(row, startCol + 2).setValue(p.creditAccount || '');
    sheet.getRange(row, startCol + 3).setValue(p.vatCode || '');
    sheet.getRange(row, startCol + 4).setValue(p.billId || '');
    sheet.getRange(row, startCol + 5).setValue(p.description || '');
    sheet.getRange(row, startCol + 6).setValue(false); // Approved checkbox
    sheet.getRange(row, startCol + 7).setValue(false); // Save Rule checkbox

    // Colour coding
    var bg;
    switch (p.matchType) {
      case 'rule': bg = '#d4edda'; break;  // green
      case 'bill': bg = '#cce5ff'; break;  // blue
      case 'ai':   bg = '#fff3cd'; break;  // yellow
      default:     bg = '#f8d7da'; break;   // red
    }
    sheet.getRange(row, 1, 1, startCol + headers.length - 1).setBackground(bg);
  }
}

/**
 * Unwrap BigQuery value objects.
 * BigQuery sometimes returns dates as {value: '2025-01-15'} — extract the string.
 */
function unwrapValue_(val) {
  if (val === null || val === undefined) return '—';
  if (typeof val === 'object' && val.value !== undefined) return val.value;
  return val;
}
