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
  var currency = '';
  var settingsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Companies');
  if (settingsSheet && sheetName !== 'Companies' && sheetName !== 'Periods') {
    var sData = settingsSheet.getDataRange().getValues();
    for (var s = 0; s < sData.length; s++) {
      var label = String(sData[s][0]).toLowerCase().trim();
      if (label === 'currency:') { currency = sData[s][1] || ''; break; }
    }
  }
  if (!currency) {
    // Fallback: read from the Period table data if Settings has base_currency column
    currency = '';
  }
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  
  // Clear the entire sheet to ensure no ghost data from old layouts remains
  sheet.clear();

  // Rows 1-3: metadata block on ALL tabs
  sheet.getRange('A1:B1').setValues([['Company:', companyId]]);
  sheet.getRange('A2:B2').setValues([['Currency:', currency]]);
  sheet.getRange('A3:B3').setValues([['Refreshed:', now]]);
  sheet.getRange('A1:A3').setFontWeight('bold');

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

    case 'profit_and_loss':
      if (reportData.multiPeriod) {
        writeMultiPeriodPL_(sheet, reportData);
      } else {
        writeSinglePeriodPL_(sheet, reportData);
      }
      break;

    case 'balance_sheet':
      if (reportData.multiPeriod) {
        writeMultiPeriodBS_(sheet, reportData);
      } else {
        writeSinglePeriodBS_(sheet, reportData);
      }
      break;

    case 'cash_flow':
      writeCashFlowReport_(sheet, reportData);
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

    case 'sce':
      writeSCEReport_(sheet, reportData);
      break;

    case 'integrity':
      writeIntegrityReport_(sheet, reportData);
      break;

    default:
      // Generic: dump as JSON
      sheet.getRange(2, 1).setValue(JSON.stringify(reportData, null, 2));
  }

  // Auto-resize columns — skip for reports that set explicit widths
  var skipAutoResize = ['profit_and_loss', 'balance_sheet', 'cash_flow', 'sce', 'integrity'];
  if (skipAutoResize.indexOf(reportData.report) === -1) {
    var lastCol = sheet.getLastColumn();
    for (var c = 1; c <= Math.max(lastCol, 6); c++) {
      sheet.autoResizeColumn(c);
    }
  }
}

/**
 * Write categorised P&L-style report.
 */
function writeCategorisedReport_(sheet, categories, label) {
  var row = 2;
  for (var i = 0; i < categories.length; i++) {
    var cat = categories[i];
    sheet.getRange(row, 1).setValue(cat.category).setFontWeight('bold');
    row++;
    for (var j = 0; j < cat.accounts.length; j++) {
      var acc = cat.accounts[j];
      sheet.getRange(row, 2).setValue(acc.accountCode);
      sheet.getRange(row, 3).setValue(acc.accountName);
      sheet.getRange(row, 4).setValue(acc.amount);
      row++;
    }
    sheet.getRange(row, 3).setValue('Subtotal').setFontWeight('bold');
    sheet.getRange(row, 4).setValue(cat.total);
    row += 2;
  }
}

/**
 * Write a Balance Sheet section.
 */
function writeBSSection_(sheet, title, categories, startRow) {
  var row = startRow;
  sheet.getRange(row, 1).setValue(title).setFontWeight('bold');
  row++;
  for (var i = 0; i < categories.length; i++) {
    var cat = categories[i];
    sheet.getRange(row, 2).setValue(cat.category).setFontWeight('bold');
    row++;
    for (var j = 0; j < cat.accounts.length; j++) {
      sheet.getRange(row, 3).setValue(cat.accounts[j].accountCode);
      sheet.getRange(row, 4).setValue(cat.accounts[j].accountName);
      sheet.getRange(row, 5).setValue(cat.accounts[j].balance);
      row++;
    }
  }
  return row;
}

// =============================================================================
// Multi-period report writers
// =============================================================================

/**
 * Write multi-period P&L report.
 * Matches original Apps Script formatting: company/currency header, year headers,
 * date sub-headers, section headers, account rows, totals with borders, separators.
 *
 * Uses column A for labels/account names, columns B onwards for period amounts.
 */
function writeMultiPeriodPL_(sheet, data) {
  var numFmt = '#,##0.00;(#,##0.00);0.00';
  var numPeriods = data.periods.length;
  var lastCol = String.fromCharCode(65 + numPeriods); // A + numPeriods

  // Clear ALL formatting before writing
  var maxRow = Math.max(sheet.getMaxRows(), 100);
  var maxCol = Math.max(sheet.getMaxColumns(), numPeriods + 1);
  var fullRange = sheet.getRange(1, 1, maxRow, maxCol);
  fullRange.breakApart();
  fullRange.clearContent();
  fullRange.setFontWeight('normal');
  fullRange.setBackground(null);
  fullRange.setBorder(false, false, false, false, false, false);
  fullRange.setFontSize(10);
  fullRange.setHorizontalAlignment('left');

  // Column widths
  sheet.setColumnWidth(1, 400); // Account name column
  for (var p = 0; p < numPeriods; p++) {
    sheet.setColumnWidth(2 + p, 130);
  }

  // Row 1: Company
  sheet.getRange(1, 1).setValue('').setFontWeight('bold');
  // Read company name from Settings sheet or use a placeholder
  var settingsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Companies');
  var companyName = '';
  if (settingsSheet) {
    var settingsData = settingsSheet.getDataRange().getValues();
    for (var s = 0; s < settingsData.length; s++) {
      if (String(settingsData[s][0]).trim().toLowerCase() === 'company_id' ||
          String(settingsData[s][0]).trim().toLowerCase() === 'company') {
        companyName = String(settingsData[s][1]).trim();
        break;
      }
    }
  }
  sheet.getRange(1, 2).setValue('').setFontWeight('bold');

  // Row 2: Currency
  sheet.getRange(2, 1).setValue('').setFontWeight('bold');
  var currency = '';
  if (settingsSheet) {
    var settingsData2 = settingsSheet.getDataRange().getValues();
    for (var s = 0; s < settingsData2.length; s++) {
      if (String(settingsData2[s][0]).trim().toLowerCase() === 'currency') {
        currency = String(settingsData2[s][1]).trim();
        break;
      }
    }
  }
  sheet.getRange(2, 2).setValue('');

  // Row 3: Period headers (bold, right-aligned)
  for (var p = 0; p < numPeriods; p++) {
    sheet.getRange(3, 2 + p).setValue(data.periods[p])
      .setFontWeight('bold')
      .setHorizontalAlignment('right');
  }

  // Row 4: separator
  sheet.getRange('4:4').setBackground('#eeeeee');

  // Separate revenue and expense categories
  var revCategories = [];
  var expCategories = [];
  for (var i = 0; i < data.categories.length; i++) {
    var cat = data.categories[i];
    // Determine if category has revenue or expense accounts
    var hasRevenue = false, hasExpense = false;
    for (var j = 0; j < cat.accounts.length; j++) {
      if (cat.accounts[j].accountType === 'Revenue') hasRevenue = true;
      if (cat.accounts[j].accountType === 'Expense') hasExpense = true;
    }
    if (hasRevenue) revCategories.push(cat);
    else if (hasExpense) expCategories.push(cat);
    else {
      // Default: if totals are positive → revenue-like, else expense-like
      var anyPositive = cat.totals.some(function(t) { return t > 0; });
      if (anyPositive) revCategories.push(cat);
      else expCategories.push(cat);
    }
  }

  var row = 5;

  // ── REVENUE section ──
  sheet.getRange(row, 1).setValue('REVENUE').setFontWeight('bold').setFontSize(11);
  row++;

  for (var i = 0; i < revCategories.length; i++) {
    var cat = revCategories[i];
    // Category sub-header (if multiple revenue categories)
    if (revCategories.length > 1) {
      sheet.getRange(row, 1).setValue(cat.category).setFontWeight('bold');
      row++;
    }
    for (var j = 0; j < cat.accounts.length; j++) {
      var acc = cat.accounts[j];
      sheet.getRange(row, 1).setValue(acc.accountCode + ' ' + acc.accountName);
      for (var p = 0; p < numPeriods; p++) {
        sheet.getRange(row, 2 + p).setValue(acc.amounts[p] || 0);
      }
      row++;
    }
  }

  // TOTAL REVENUE
  sheet.getRange(row, 1).setValue('TOTAL REVENUE').setFontWeight('bold');
  for (var p = 0; p < numPeriods; p++) {
    sheet.getRange(row, 2 + p).setValue(data.totalRevenue[p]).setFontWeight('bold');
  }
  // Border: solid top and bottom
  sheet.getRange(row, 1, 1, numPeriods + 1)
    .setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  row++;

  // Separator
  sheet.getRange(row + ':' + row).setBackground('#eeeeee');
  row++;

  // ── EXPENSES section ──
  sheet.getRange(row, 1).setValue('EXPENSES').setFontWeight('bold').setFontSize(11);
  row++;

  for (var i = 0; i < expCategories.length; i++) {
    var cat = expCategories[i];
    if (expCategories.length > 1) {
      sheet.getRange(row, 1).setValue(cat.category).setFontWeight('bold');
      row++;
    }
    for (var j = 0; j < cat.accounts.length; j++) {
      var acc = cat.accounts[j];
      sheet.getRange(row, 1).setValue(acc.accountCode + ' ' + acc.accountName);
      for (var p = 0; p < numPeriods; p++) {
        sheet.getRange(row, 2 + p).setValue(acc.amounts[p] || 0);
      }
      row++;
    }
  }

  // TOTAL EXPENSES
  sheet.getRange(row, 1).setValue('TOTAL EXPENSES').setFontWeight('bold');
  for (var p = 0; p < numPeriods; p++) {
    sheet.getRange(row, 2 + p).setValue(data.totalExpenses[p]).setFontWeight('bold');
  }
  sheet.getRange(row, 1, 1, numPeriods + 1)
    .setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  row++;

  // Separator
  sheet.getRange(row + ':' + row).setBackground('#eeeeee');
  row++;

  // ── NET PROFIT / (LOSS) ──
  sheet.getRange(row, 1).setValue('NET PROFIT / (LOSS)').setFontWeight('bold').setFontSize(11);
  for (var p = 0; p < numPeriods; p++) {
    sheet.getRange(row, 2 + p).setValue(data.netIncome[p]).setFontWeight('bold').setFontSize(11);
  }
  // Heavy border (SOLID_MEDIUM)
  sheet.getRange(row, 1, 1, numPeriods + 1)
    .setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  // Number format for all data columns
  sheet.getRange(5, 2, row - 4, numPeriods).setNumberFormat(numFmt);

  // Right-align data columns
  sheet.getRange(3, 2, row - 2, numPeriods).setHorizontalAlignment('right');
}

/**
 * Write multi-period Balance Sheet report.
 * Matches original Apps Script formatting: company/currency header, period headers,
 * ASSETS / LIABILITIES / EQUITY sections, totals with borders, CHECK row.
 *
 * Uses column A for labels/account names, columns B onwards for period amounts.
 */
function writeMultiPeriodBS_(sheet, data) {
  var numFmt = '#,##0.00;(#,##0.00);0.00';
  var numPeriods = data.periods.length;

  // Clear ALL formatting before writing
  var maxRow = Math.max(sheet.getMaxRows(), 100);
  var maxCol = Math.max(sheet.getMaxColumns(), numPeriods + 1);
  var fullRange = sheet.getRange(1, 1, maxRow, maxCol);
  fullRange.breakApart();
  fullRange.clearContent();
  fullRange.setFontWeight('normal');
  fullRange.setBackground(null);
  fullRange.setBorder(false, false, false, false, false, false);
  fullRange.setFontSize(10);
  fullRange.setHorizontalAlignment('left');

  // Column widths
  sheet.setColumnWidth(1, 400);
  for (var p = 0; p < numPeriods; p++) {
    sheet.setColumnWidth(2 + p, 140);
  }

  // Row 1: Company
  sheet.getRange(1, 1).setValue('').setFontWeight('bold');
  var settingsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Companies');
  var companyName = '';
  var currency = '';
  if (settingsSheet) {
    var settingsData = settingsSheet.getDataRange().getValues();
    for (var s = 0; s < settingsData.length; s++) {
      var key = String(settingsData[s][0]).trim().toLowerCase();
      if (key === 'company_id' || key === 'company') companyName = String(settingsData[s][1]).trim();
      if (key === 'currency') currency = String(settingsData[s][1]).trim();
    }
  }
  sheet.getRange(1, 2).setValue('').setFontWeight('bold');

  // Row 2: Currency
  sheet.getRange(2, 1).setValue('').setFontWeight('bold');
  sheet.getRange(2, 2).setValue('');

  // Row 3: Period headers (bold, right-aligned) — "As at ..."
  for (var p = 0; p < numPeriods; p++) {
    sheet.getRange(3, 2 + p).setValue(data.periods[p])
      .setFontWeight('bold')
      .setHorizontalAlignment('right')
      .setFontSize(9);
  }

  // Row 4: separator
  sheet.getRange('4:4').setBackground('#eeeeee');

  var row = 5;

  // Helper: write a BS section (ASSETS, LIABILITIES, or EQUITY)
  function writeBSMultiSection_(title, categories, sRow) {
    // Section header
    sheet.getRange(sRow, 1).setValue(title).setFontWeight('bold').setFontSize(11);
    sRow++;

    for (var i = 0; i < categories.length; i++) {
      var cat = categories[i];

      // Category sub-header (if multiple categories in section)
      if (categories.length > 1) {
        sheet.getRange(sRow, 1).setValue('  ' + cat.category).setFontWeight('bold');
        sRow++;
      }

      // Account rows
      for (var j = 0; j < cat.accounts.length; j++) {
        var acc = cat.accounts[j];
        sheet.getRange(sRow, 1).setValue(acc.accountCode + ' ' + acc.accountName);
        for (var p = 0; p < numPeriods; p++) {
          sheet.getRange(sRow, 2 + p).setValue(acc.amounts[p] || 0);
        }
        sRow++;
      }
    }
    return sRow;
  }

  // ── ASSETS ──
  row = writeBSMultiSection_('ASSETS', data.assets, row);
  // TOTAL ASSETS
  sheet.getRange(row, 1).setValue('TOTAL ASSETS').setFontWeight('bold');
  for (var p = 0; p < numPeriods; p++) {
    sheet.getRange(row, 2 + p).setValue(data.totalAssets[p]).setFontWeight('bold');
  }
  sheet.getRange(row, 1, 1, numPeriods + 1)
    .setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  var totalAssetsRow = row;
  row++;

  // Separator
  sheet.getRange(row + ':' + row).setBackground('#eeeeee');
  row++;

  // ── LIABILITIES ──
  row = writeBSMultiSection_('LIABILITIES', data.liabilities, row);
  // TOTAL LIABILITIES
  sheet.getRange(row, 1).setValue('TOTAL LIABILITIES').setFontWeight('bold');
  for (var p = 0; p < numPeriods; p++) {
    sheet.getRange(row, 2 + p).setValue(data.totalLiabilities[p]).setFontWeight('bold');
  }
  sheet.getRange(row, 1, 1, numPeriods + 1)
    .setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  row++;

  // Separator
  sheet.getRange(row + ':' + row).setBackground('#eeeeee');
  row++;

  // ── EQUITY ──
  row = writeBSMultiSection_('EQUITY', data.equity, row);

  // Net Income row (if present)
  if (data.netIncome) {
    sheet.getRange(row, 1).setValue('Unclosed P&L');
    for (var p = 0; p < numPeriods; p++) {
      sheet.getRange(row, 2 + p).setValue(data.netIncome[p] || 0);
    }
    row++;
  }

  // TOTAL EQUITY
  sheet.getRange(row, 1).setValue('TOTAL EQUITY').setFontWeight('bold');
  for (var p = 0; p < numPeriods; p++) {
    sheet.getRange(row, 2 + p).setValue(data.totalEquity[p]).setFontWeight('bold');
  }
  sheet.getRange(row, 1, 1, numPeriods + 1)
    .setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  row++;

  // Separator
  sheet.getRange(row + ':' + row).setBackground('#eeeeee');
  row++;

  // TOTAL LIABILITIES & EQUITY
  sheet.getRange(row, 1).setValue('TOTAL LIABILITIES & EQUITY').setFontWeight('bold').setFontSize(11);
  for (var p = 0; p < numPeriods; p++) {
    sheet.getRange(row, 2 + p).setValue(data.totalLiabilities[p] + data.totalEquity[p])
      .setFontWeight('bold').setFontSize(11);
  }
  // Heavy border
  sheet.getRange(row, 1, 1, numPeriods + 1)
    .setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  row++;

  // CHECK: Assets − (L+E)
  sheet.getRange(row + ':' + row).setBackground('#eeeeee');
  row++;
  sheet.getRange(row, 1).setValue('CHECK: Assets − (L+E)').setFontWeight('bold');
  for (var p = 0; p < numPeriods; p++) {
    var diff = data.totalAssets[p] - (data.totalLiabilities[p] + data.totalEquity[p]);
    sheet.getRange(row, 2 + p).setValue(diff);
  }

  // Number format for all data columns
  sheet.getRange(5, 2, row - 4, numPeriods).setNumberFormat(numFmt);

  // Right-align data columns
  sheet.getRange(3, 2, row - 2, numPeriods).setHorizontalAlignment('right');
}

/**
 * Write single-period P&L with proper formatting.
 * Matches the original Apps Script structure: company header, sections, borders.
 */
function writeSinglePeriodPL_(sheet, data) {
  var numFmt = '#,##0.00;(#,##0.00);0.00';

  // Column widths
  sheet.setColumnWidth(1, 400);
  sheet.setColumnWidth(2, 130);

  // Row 1: Company
  sheet.getRange(1, 1).setValue('').setFontWeight('bold');
  var settingsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Companies');
  var companyName = '';
  var currency = '';
  if (settingsSheet) {
    var settingsData = settingsSheet.getDataRange().getValues();
    for (var s = 0; s < settingsData.length; s++) {
      var key = String(settingsData[s][0]).trim().toLowerCase();
      if (key === 'company_id' || key === 'company') companyName = String(settingsData[s][1]).trim();
      if (key === 'currency') currency = String(settingsData[s][1]).trim();
    }
  }
  sheet.getRange(1, 2).setValue('').setFontWeight('bold');

  // Row 2: Currency + Period
  sheet.getRange(2, 1).setValue('').setFontWeight('bold');
  sheet.getRange(2, 2).setValue('');

  // Row 3: Period
  var period = periodLabel(data.dateFrom, data.dateTo);
  sheet.getRange(3, 2).setValue(period).setFontWeight('bold').setHorizontalAlignment('right');

  // Row 4: separator
  sheet.getRange('4:4').setBackground('#eeeeee');

  // Separate revenue and expense categories
  var revCategories = [];
  var expCategories = [];
  for (var i = 0; i < data.categories.length; i++) {
    var cat = data.categories[i];
    var hasRevenue = cat.accounts.some(function(a) { return a.accountType === 'Revenue'; });
    if (hasRevenue) revCategories.push(cat);
    else expCategories.push(cat);
  }

  var row = 5;

  // REVENUE
  sheet.getRange(row, 1).setValue('REVENUE').setFontWeight('bold').setFontSize(11);
  row++;

  for (var i = 0; i < revCategories.length; i++) {
    var cat = revCategories[i];
    if (revCategories.length > 1) {
      sheet.getRange(row, 1).setValue(cat.category).setFontWeight('bold');
      row++;
    }
    for (var j = 0; j < cat.accounts.length; j++) {
      sheet.getRange(row, 1).setValue(cat.accounts[j].accountCode + ' ' + cat.accounts[j].accountName);
      sheet.getRange(row, 2).setValue(cat.accounts[j].amount);
      row++;
    }
  }

  sheet.getRange(row, 1).setValue('TOTAL REVENUE').setFontWeight('bold');
  sheet.getRange(row, 2).setValue(data.totalRevenue).setFontWeight('bold');
  sheet.getRange(row, 1, 1, 2)
    .setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  row++;
  sheet.getRange(row + ':' + row).setBackground('#eeeeee');
  row++;

  // EXPENSES
  sheet.getRange(row, 1).setValue('EXPENSES').setFontWeight('bold').setFontSize(11);
  row++;

  for (var i = 0; i < expCategories.length; i++) {
    var cat = expCategories[i];
    if (expCategories.length > 1) {
      sheet.getRange(row, 1).setValue(cat.category).setFontWeight('bold');
      row++;
    }
    for (var j = 0; j < cat.accounts.length; j++) {
      sheet.getRange(row, 1).setValue(cat.accounts[j].accountCode + ' ' + cat.accounts[j].accountName);
      sheet.getRange(row, 2).setValue(cat.accounts[j].amount);
      row++;
    }
  }

  sheet.getRange(row, 1).setValue('TOTAL EXPENSES').setFontWeight('bold');
  sheet.getRange(row, 2).setValue(data.totalExpenses).setFontWeight('bold');
  sheet.getRange(row, 1, 1, 2)
    .setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  row++;
  sheet.getRange(row + ':' + row).setBackground('#eeeeee');
  row++;

  // NET PROFIT / (LOSS)
  sheet.getRange(row, 1).setValue('NET PROFIT / (LOSS)').setFontWeight('bold').setFontSize(11);
  sheet.getRange(row, 2).setValue(data.netIncome).setFontWeight('bold').setFontSize(11);
  sheet.getRange(row, 1, 1, 2)
    .setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  // Number format
  sheet.getRange(5, 2, row - 4, 1).setNumberFormat(numFmt);
  sheet.getRange(3, 2, row - 2, 1).setHorizontalAlignment('right');
}

/**
 * Helper: format period label from dateFrom/dateTo strings.
 * (Mirrors the server-side periodLabel function for single-period use.)
 */
function periodLabel(dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return 'All Time';
  if (!dateFrom) return 'As at ' + dateTo;
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var df = new Date(dateFrom + 'T00:00:00Z');
  var dt = new Date(dateTo + 'T00:00:00Z');
  return months[df.getUTCMonth()] + ' ' + df.getUTCFullYear() + ' – ' + months[dt.getUTCMonth()] + ' ' + dt.getUTCFullYear();
}

/**
 * Write single-period Balance Sheet with proper formatting.
 */
function writeSinglePeriodBS_(sheet, data) {
  var numFmt = '#,##0.00;(#,##0.00);0.00';

  // Column widths
  sheet.setColumnWidth(1, 400);
  sheet.setColumnWidth(2, 140);

  // Row 1: Company
  sheet.getRange(1, 1).setValue('').setFontWeight('bold');
  var settingsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Companies');
  var companyName = '';
  var currency = '';
  if (settingsSheet) {
    var settingsData = settingsSheet.getDataRange().getValues();
    for (var s = 0; s < settingsData.length; s++) {
      var key = String(settingsData[s][0]).trim().toLowerCase();
      if (key === 'company_id' || key === 'company') companyName = String(settingsData[s][1]).trim();
      if (key === 'currency') currency = String(settingsData[s][1]).trim();
    }
  }
  sheet.getRange(1, 2).setValue('').setFontWeight('bold');

  // Row 2: Currency
  sheet.getRange(2, 1).setValue('').setFontWeight('bold');
  sheet.getRange(2, 2).setValue('');

  // Row 3: As at date
  sheet.getRange(3, 2).setValue('As at ' + (data.asAt || '')).setFontWeight('bold').setHorizontalAlignment('right');

  // Row 4: separator
  sheet.getRange('4:4').setBackground('#eeeeee');

  var row = 5;

  // Helper: write a single-period BS section
  function writeSection_(title, categories, startRow) {
    sheet.getRange(startRow, 1).setValue(title).setFontWeight('bold').setFontSize(11);
    startRow++;
    for (var i = 0; i < categories.length; i++) {
      var cat = categories[i];
      if (categories.length > 1) {
        sheet.getRange(startRow, 1).setValue('  ' + cat.category).setFontWeight('bold');
        startRow++;
      }
      for (var j = 0; j < cat.accounts.length; j++) {
        sheet.getRange(startRow, 1).setValue(cat.accounts[j].accountCode + ' ' + cat.accounts[j].accountName);
        sheet.getRange(startRow, 2).setValue(cat.accounts[j].balance);
        startRow++;
      }
    }
    return startRow;
  }

  // ASSETS
  row = writeSection_('ASSETS', data.assets, row);
  sheet.getRange(row, 1).setValue('TOTAL ASSETS').setFontWeight('bold');
  sheet.getRange(row, 2).setValue(data.totalAssets).setFontWeight('bold');
  sheet.getRange(row, 1, 1, 2).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  row++;
  sheet.getRange(row + ':' + row).setBackground('#eeeeee');
  row++;

  // LIABILITIES
  row = writeSection_('LIABILITIES', data.liabilities, row);
  sheet.getRange(row, 1).setValue('TOTAL LIABILITIES').setFontWeight('bold');
  sheet.getRange(row, 2).setValue(data.totalLiabilities).setFontWeight('bold');
  sheet.getRange(row, 1, 1, 2).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  row++;
  sheet.getRange(row + ':' + row).setBackground('#eeeeee');
  row++;

  // EQUITY
  row = writeSection_('EQUITY', data.equity, row);

  // Unclosed P&L
  if (data.netIncome && Math.abs(data.netIncome) > 0.005) {
    sheet.getRange(row, 1).setValue('Unclosed P&L');
    sheet.getRange(row, 2).setValue(data.netIncome);
    row++;
  }

  sheet.getRange(row, 1).setValue('TOTAL EQUITY').setFontWeight('bold');
  sheet.getRange(row, 2).setValue(data.totalEquity).setFontWeight('bold');
  sheet.getRange(row, 1, 1, 2).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  row++;
  sheet.getRange(row + ':' + row).setBackground('#eeeeee');
  row++;

  // TOTAL LIABILITIES & EQUITY
  sheet.getRange(row, 1).setValue('TOTAL LIABILITIES & EQUITY').setFontWeight('bold').setFontSize(11);
  sheet.getRange(row, 2).setValue(data.totalLiabilities + data.totalEquity).setFontWeight('bold').setFontSize(11);
  sheet.getRange(row, 1, 1, 2).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  row++;

  // CHECK
  sheet.getRange(row + ':' + row).setBackground('#eeeeee');
  row++;
  sheet.getRange(row, 1).setValue('CHECK: Assets − (L+E)').setFontWeight('bold');
  sheet.getRange(row, 2).setValue(data.totalAssets - (data.totalLiabilities + data.totalEquity));

  // Number format
  sheet.getRange(5, 2, row - 4, 1).setNumberFormat(numFmt);
  sheet.getRange(3, 2, row - 2, 1).setHorizontalAlignment('right');
}

/**
 * Write Statement of Changes in Equity report.
 * Columnar layout: blank | Share Capital | Retained Earnings | Dividends | Total
 */
function writeSCEReport_(sheet, data) {
  var numFmt = '#,##0.00;(#,##0.00);0.00';

  // Column widths
  sheet.setColumnWidth(1, 250);
  sheet.setColumnWidth(2, 140);
  sheet.setColumnWidth(3, 160);
  sheet.setColumnWidth(4, 140);
  sheet.setColumnWidth(5, 140);

  // Title
  sheet.getRange(1, 1).setValue('STATEMENT OF CHANGES IN EQUITY').setFontWeight('bold').setFontSize(12);
  sheet.getRange(2, 1).setValue('Period: ' + (data.period || data.dateFrom + ' – ' + data.dateTo)).setFontStyle('italic');
  sheet.getRange(3, 1, 1, 5).setBackground('#d9d9d9'); // separator

  // Column headers
  var row = 4;
  sheet.getRange(row, 2).setValue('Share Capital').setFontWeight('bold');
  sheet.getRange(row, 3).setValue('Retained Earnings').setFontWeight('bold');
  sheet.getRange(row, 4).setValue('Dividends').setFontWeight('bold');
  sheet.getRange(row, 5).setValue('Total').setFontWeight('bold');
  row++;

  // Data rows
  for (var i = 0; i < data.rows.length; i++) {
    var r = data.rows[i];
    var isClosing = (r.label === 'Closing Balance');
    var isOpening = (r.label === 'Opening Balance');

    sheet.getRange(row, 1).setValue(r.label);
    if (isOpening || isClosing) {
      sheet.getRange(row, 1).setFontWeight('bold');
    }

    // Write values — only show non-zero in appropriate columns
    sheet.getRange(row, 2).setValue(r.shareCapital || 0);
    sheet.getRange(row, 3).setValue(r.retainedEarnings || 0);
    sheet.getRange(row, 4).setValue(r.dividends || 0);
    sheet.getRange(row, 5).setValue(r.total || 0).setFontWeight('bold');

    if (isClosing) {
      // Separator before closing
      sheet.getRange(row - 1, 1, 1, 5).setBackground('#eeeeee');
      // Closing row highlight
      sheet.getRange(row, 1, 1, 5).setBackground('#e8f0fe');
      sheet.getRange(row, 1).setFontWeight('bold');
    }

    row++;
  }

  // Number format for all value cells
  sheet.getRange(5, 2, row - 5, 4).setNumberFormat(numFmt);
}

/**
 * Write Cash Flow Statement report.
 * Matches original Google Sheet format exactly:
 *   Company / Period / Currency header
 *   Operating Activities → Cash from operations
 *   Investing Activities → Cash from investing
 *   Financing Activities → Cash from financing
 *   Unclassified
 *   Net change in cash
 *   Cash at beginning / end of period
 *   CHECK: BS cash balance / Difference
 */
function writeCashFlowReport_(sheet, data) {
  var numFmt = '#,##0.00;(#,##0.00);0.00';

  // Clear ALL formatting before writing
  var maxRow = Math.max(sheet.getMaxRows(), 100);
  var maxCol = Math.max(sheet.getMaxColumns(), 6);
  var fullRange = sheet.getRange(1, 1, maxRow, maxCol);
  fullRange.breakApart();
  fullRange.clearContent();
  fullRange.setFontWeight('normal');
  fullRange.setBackground(null);
  fullRange.setBorder(false, false, false, false, false, false);
  fullRange.setFontSize(10);
  fullRange.setHorizontalAlignment('left');

  // Column widths
  sheet.setColumnWidth(1, 350);
  sheet.setColumnWidth(2, 140);

  // Read company/currency from Settings
  var settingsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Companies');
  var companyName = '', currency = '';
  if (settingsSheet) {
    var settingsData = settingsSheet.getDataRange().getValues();
    for (var s = 0; s < settingsData.length; s++) {
      var key = String(settingsData[s][0]).trim().toLowerCase();
      if (key === 'company_id' || key === 'company' || key === 'company name') companyName = String(settingsData[s][1]).trim();
      if (key === 'currency') currency = String(settingsData[s][1]).trim();
    }
  }

  // Header
  sheet.getRange(1, 1).setValue('').setFontWeight('bold');
  sheet.getRange(1, 2).setValue('').setFontWeight('bold');
  sheet.getRange(2, 1).setValue('Period').setFontWeight('bold');
  sheet.getRange(2, 2).setValue(periodLabel(data.dateFrom, data.dateTo));
  sheet.getRange(3, 1).setValue('').setFontWeight('bold');
  sheet.getRange(3, 2).setValue('');

  // Row 4: separator
  sheet.getRange('4:4').setBackground('#eeeeee');

  // Title
  var row = 5;
  sheet.getRange(row, 1).setValue('CASH FLOW STATEMENT').setFontWeight('bold').setFontSize(12);
  sheet.getRange(row, 2).setValue('Amount').setFontWeight('bold').setHorizontalAlignment('right');
  row += 2;

  // Helper: write a section
  function writeSection_(label, sublabel, amount, sRow) {
    sheet.getRange(sRow, 1).setValue(label).setFontWeight('bold').setFontSize(11);
    sRow++;
    sheet.getRange(sRow, 1).setValue('  ' + sublabel);
    sheet.getRange(sRow, 2).setValue(amount);
    sRow++;
    sRow++; // blank
    sheet.getRange(sRow, 1).setValue('Net cash from ' + label.toLowerCase().replace(' activities', '')).setFontWeight('bold');
    sheet.getRange(sRow, 2).setValue(amount).setFontWeight('bold');
    sheet.getRange(sRow, 1, 1, 2).setBorder(null, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
    sRow++;
    sRow++; // blank
    return sRow;
  }

  // Operating Activities
  row = writeSection_('Operating Activities', 'Cash from operations', data.sections.operating.cashFromOperations, row);

  // Investing Activities
  row = writeSection_('Investing Activities', 'Cash from investing', data.sections.investing.total, row);

  // Financing Activities
  row = writeSection_('Financing Activities', 'Cash from financing', data.sections.financing.total, row);

  // Unclassified (if any)
  sheet.getRange(row, 1).setValue('  Unclassified');
  sheet.getRange(row, 2).setValue(data.unclassifiedTotal || 0);
  row += 2;

  // Net change in cash
  sheet.getRange(row, 1).setValue('Net change in cash').setFontWeight('bold').setFontSize(11);
  sheet.getRange(row, 2).setValue(data.netChangeCash).setFontWeight('bold').setFontSize(11);
  sheet.getRange(row, 1, 1, 2).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  row += 2;

  // Cash at beginning / end of period
  sheet.getRange(row, 1).setValue('Cash at beginning of period');
  sheet.getRange(row, 2).setValue(data.openingCash);
  row++;
  sheet.getRange(row, 1).setValue('Cash at end of period');
  sheet.getRange(row, 2).setValue(data.closingCash);
  row += 2;

  // CHECK
  sheet.getRange(row, 1).setValue('CHECK: BS cash balance').setFontWeight('bold');
  sheet.getRange(row, 2).setValue(data.bsCashBalance);
  row++;
  sheet.getRange(row, 1).setValue('Difference').setFontWeight('bold');
  sheet.getRange(row, 2).setValue(data.checkDiff);
  if (Math.abs(data.checkDiff) < 0.01) {
    sheet.getRange(row, 2).setBackground('#e6f4ea');
  } else {
    sheet.getRange(row, 2).setBackground('#fce8e6');
  }

  // Number format for all data column
  sheet.getRange(5, 2, row - 4, 1).setNumberFormat(numFmt);
  sheet.getRange(5, 2, row - 4, 1).setHorizontalAlignment('right');
}

/**
 * Write Integrity Check report.
 * Matches the original createIntegrityChecksV5() formatting:
 *   Section A: 7 single-year checks
 *   Section B: RE Roll-Forward table
 *   Section C: P&L vs Closing — All Years table
 */
function writeIntegrityReport_(sheet, data) {
  var numFmt = '#,##0.00;(#,##0.00);0.00';

  // Column widths
  sheet.setColumnWidth(1, 280);
  sheet.setColumnWidth(2, 120);
  sheet.setColumnWidth(3, 140);
  sheet.setColumnWidth(4, 140);
  sheet.setColumnWidth(5, 130);
  sheet.setColumnWidth(6, 160);

  // ── Section A: Single-Year Checks ──────────────────────────────────
  sheet.getRange(1, 1, 1, 6).setBackground('#d9d9d9'); // separator
  var row = 2;
  sheet.getRange(row, 1).setValue('SINGLE-YEAR CHECKS').setFontWeight('bold').setFontSize(12);
  sheet.getRange(row, 3).setValue('Value').setFontWeight('bold');
  sheet.getRange(row, 4).setValue('Status').setFontWeight('bold');
  row += 2;

  // Write each check section
  for (var c = 0; c < data.checks.length; c++) {
    var check = data.checks[c];
    sheet.getRange(row, 1).setValue(check.name).setFontWeight('bold');
    row++;

    for (var it = 0; it < check.items.length; it++) {
      var item = check.items[it];
      sheet.getRange(row, 1).setValue('   ' + item.label);
      if (item.value !== null && item.value !== undefined) {
        sheet.getRange(row, 3).setValue(item.value).setNumberFormat(numFmt);
      }
      if (item.status) {
        sheet.getRange(row, 4).setValue(item.status);
        // Colour the status
        if (item.status.indexOf('✅') >= 0) {
          sheet.getRange(row, 4).setBackground('#e6f4ea');
        } else if (item.status.indexOf('❌') >= 0) {
          sheet.getRange(row, 4).setBackground('#fce8e6');
        } else if (item.status.indexOf('⚠️') >= 0) {
          sheet.getRange(row, 4).setBackground('#fff3cd');
        }
      }
      row++;
    }
    row++; // blank row between checks
  }

  // ── Section B: RE Roll-Forward ─────────────────────────────────────
  row++;
  sheet.getRange(row, 1, 1, 6).setBackground('#d9d9d9'); // separator
  row++;
  sheet.getRange(row, 1).setValue('RETAINED EARNINGS ROLL-FORWARD').setFontWeight('bold').setFontSize(12);
  row += 2;

  // Table headers
  var reHeaders = ['FY', 'Period', 'Opening RE', 'RE Movement', 'Closing RE', 'Continuity'];
  for (var h = 0; h < reHeaders.length; h++) {
    sheet.getRange(row, h + 1).setValue(reHeaders[h]).setFontWeight('bold');
  }
  row++;

  // Table data
  if (data.reRollForward) {
    for (var r = 0; r < data.reRollForward.length; r++) {
      var re = data.reRollForward[r];
      // Skip FYs with no data (all zeros)
      if (re.openingRE === 0 && re.reMovement === 0 && re.closingRE === 0 && r > 0) continue;
      sheet.getRange(row, 1).setValue(re.fy).setNumberFormat('0');
      sheet.getRange(row, 2).setValue(re.period);
      sheet.getRange(row, 3).setValue(re.openingRE).setNumberFormat(numFmt);
      sheet.getRange(row, 4).setValue(re.reMovement).setNumberFormat(numFmt);
      sheet.getRange(row, 5).setValue(re.closingRE).setNumberFormat(numFmt);
      sheet.getRange(row, 6).setValue(re.continuity);
      // Colour continuity
      if (re.continuity && re.continuity.indexOf('❌') >= 0) {
        sheet.getRange(row, 6).setBackground('#fce8e6');
      }
      row++;
    }
  }

  // ── Section C: P&L vs Closing — All Years ──────────────────────────
  row += 2;
  sheet.getRange(row, 1, 1, 6).setBackground('#d9d9d9'); // separator
  row++;
  sheet.getRange(row, 1).setValue('P&L vs CLOSING ENTRY — ALL YEARS').setFontWeight('bold').setFontSize(12);
  row += 2;

  // Table headers
  var plHeaders = ['FY', 'Period', 'P&L Net', 'Closing', 'Diff', 'Status'];
  for (var h = 0; h < plHeaders.length; h++) {
    sheet.getRange(row, h + 1).setValue(plHeaders[h]).setFontWeight('bold');
  }
  row++;

  // Table data
  if (data.plVsClosing) {
    for (var p = 0; p < data.plVsClosing.length; p++) {
      var pl = data.plVsClosing[p];
      // Skip FYs with no data
      if (pl.plNet === 0 && pl.closing === 0 && pl.status === '—') continue;
      sheet.getRange(row, 1).setValue(pl.fy).setNumberFormat('0');
      sheet.getRange(row, 2).setValue(pl.period);
      sheet.getRange(row, 3).setValue(pl.plNet).setNumberFormat(numFmt);
      sheet.getRange(row, 4).setValue(pl.closing).setNumberFormat(numFmt);
      sheet.getRange(row, 5).setValue(pl.diff).setNumberFormat(numFmt);
      sheet.getRange(row, 6).setValue(pl.status);
      // Colour status
      if (pl.status.indexOf('❌') >= 0) {
        sheet.getRange(row, 6).setBackground('#fce8e6');
      } else if (pl.status.indexOf('⚠️') >= 0) {
        sheet.getRange(row, 6).setBackground('#fff3cd');
      } else if (pl.status.indexOf('✅') >= 0) {
        sheet.getRange(row, 6).setBackground('#e6f4ea');
      }
      row++;
    }
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
