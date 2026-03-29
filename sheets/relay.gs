function buildCF_(sheet, ss) {
  var coaSheet    = ss.getSheetByName('COA');
  var cacheSheet  = ss.getSheetByName('_CACHE_BALANCES');
  if (!coaSheet)   { Logger.log('CF error: COA sheet not found');        return; }
  if (!cacheSheet) { Logger.log('CF error: _CACHE_BALANCES not found');   return; }

  // ── Read COA ─────────────────────────────────────────────────────────────────
  var coaData  = coaSheet.getDataRange().getValues();
  var cHdrs   = coaData[0];
  var cCode   = cHdrs.indexOf('Account Code');
  var cName   = cHdrs.indexOf('Account Name');
  var cType   = cHdrs.indexOf('Account Type');
  var cCFCat  = cHdrs.indexOf('CF Category');

  var opAccounts   = [];  // Op-WC, Op-NonCash
  var invAccounts  = [];  // Investing
  var finAccounts  = [];  // Financing
  var cashAccounts = [];  // Cash

  for (var i = 1; i < coaData.length; i++) {
    var row2  = coaData[i];
    var type  = String(row2[cType]  || '').trim();
    var code  = String(row2[cCode]  || '').trim();
    var name  = String(row2[cName]  || '').trim();
    var cfCat = String(row2[cCFCat] || '').trim();

    if (!code) continue;
    if (type === 'Asset' || type === 'Liability' || type === 'Equity') {
      if      (cfCat === 'Cash')                        cashAccounts.push({ code: code, name: name, type: type });
      else if (cfCat === 'Op-WC' || cfCat === 'Op-NonCash') opAccounts.push({ code: code, name: name, type: type });
      else if (cfCat === 'Investing')                  invAccounts.push({ code: code, name: name, type: type });
      else if (cfCat === 'Financing')                  finAccounts.push({ code: code, name: name, type: type });
    }
  }

  function sortByCode(a, b) { return a.code.localeCompare(b.code, undefined, { numeric: true }); }
  opAccounts.sort(sortByCode);
  invAccounts.sort(sortByCode);
  finAccounts.sort(sortByCode);
  cashAccounts.sort(sortByCode);

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

  // ── Prepare sheet ─────────────────────────────────────────────────────────────
  sheet.clear();
  sheet.setColumnWidth(1, 110);
  sheet.setColumnWidth(2, 280);
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

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function sectionHdr(label) {
    sheet.getRange(row, 1).setValue(label).setFontWeight('bold').setFontSize(11);
    sheet.getRange(row, 1, 1, 3).setBackground('#d0d0d0');
    sheet.getRange(row, 1, 1, 3).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
    row++;
  }

  function acctRow(acct, delta, signFlip) {
    sheet.getRange(row, 1).setValue(acct.code);
    sheet.getRange(row, 2).setFormula('=IFERROR(VLOOKUP(A' + row + ',COA!A:B,2,FALSE),"")');
    var sign = signFlip ? '-' : '';
    var mode = delta ? 'true' : 'false';
    sheet.getRange(row, 3).setFormula('=' + sign + 'skuld(timestamp,B$3,A' + row + ',' + mode + ')');
    sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
    row++;
  }

  function totalRow(label, startRow, endRow, isBold, bgColor) {
    if (endRow < startRow) { row++; return null; }
    sheet.getRange(row, 1).setValue(label).setFontWeight(isBold ? 'bold' : 'normal');
    sheet.getRange(row, 3).setFormula('=SUM(C' + startRow + ':C' + endRow + ')').setFontWeight(isBold ? 'bold' : 'normal');
    sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
    if (bgColor) {
      sheet.getRange(row, 1, 1, 3).setBackground(bgColor);
      sheet.getRange(row, 3).setBackground(bgColor);
    }
    sheet.getRange(row, 1, 1, 3).setBorder(true, null, true, null, null, null, '#000000', isBold ? SpreadsheetApp.BorderStyle.SOLID_MEDIUM : SpreadsheetApp.BorderStyle.SOLID);
    var r = row; row++;
    return r;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // OPENING CASH
  // ─────────────────────────────────────────────────────────────────────────────
  sectionHdr('CASH FLOW STATEMENT');
  var openingCashRow = row;
  if (cashAccounts.length > 0) {
    var cashCodes = cashAccounts.map(function(a) { return 'skuld(timestamp,B$3,' + a.code + ',false)'; }).join('+');
    sheet.getRange(row, 1).setValue('Opening Cash Balance').setFontStyle('italic').setFontColor('#555555');
    sheet.getRange(row, 3).setFormula('=' + cashCodes).setFontStyle('italic').setFontColor('#555555');
    sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  } else {
    sheet.getRange(row, 1).setValue('Opening Cash Balance').setFontStyle('italic').setFontColor('#555555');
    sheet.getRange(row, 3).setValue(0).setFontStyle('italic').setFontColor('#555555');
    sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  }
  row++;

  // ── NET INCOME ────────────────────────────────────────────────────────────────
  // Re-read COA for P&L accounts
  var plRevAccts = [], plExpAccts = [];
  for (var i = 1; i < coaData.length; i++) {
    var row2 = coaData[i];
    var type = String(row2[cType] || '').trim();
    var code = String(row2[cCode] || '').trim();
    if (!code) continue;
    if (type === 'Revenue') plRevAccts.push({ code: code });
    if (type === 'Expense') plExpAccts.push({ code: code });
  }
  plRevAccts.sort(sortByCode);
  plExpAccts.sort(sortByCode);

  sectionHdr('REVENUE');
  var revS = row;
  for (var i = 0; i < plRevAccts.length; i++) acctRow(plRevAccts[i], true, false);
  var revE = row - 1;
  var revTot = totalRow('TOTAL REVENUE', revS, revE, true, '#f0f0f0');
  row++;

  sectionHdr('EXPENSES');
  var expS = row;
  for (var i = 0; i < plExpAccts.length; i++) acctRow(plExpAccts[i], true, false);
  var expE = row - 1;
  var expTot = totalRow('TOTAL EXPENSES', expS, expE, true, '#f0f0f0');
  row++;

  var niRow = row;
  sheet.getRange(row, 1).setValue('NET INCOME').setFontWeight('bold').setFontSize(11);
  if (revTot && expTot) {
    sheet.getRange(row, 3).setFormula('=C' + revTot + '-C' + expTot).setFontWeight('bold').setFontSize(11);
  } else {
    sheet.getRange(row, 3).setValue(0).setFontWeight('bold').setFontSize(11);
  }
  sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  sheet.getRange(row, 1, 1, 3).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  row++;
  row++;

  // ─────────────────────────────────────────────────────────────────────────────
  // OPERATING ACTIVITIES
  // ─────────────────────────────────────────────────────────────────────────────
  sectionHdr('Operating Activities');
  var opS = row;
  for (var i = 0; i < opAccounts.length; i++) {
    var acct = opAccounts[i];
    acctRow(acct, true, acct.type === 'Asset');
  }
  var opE = row - 1;
  var opTot = totalRow('Total Operating', opS, opE, true, '#e0e0e0');

  // ─────────────────────────────────────────────────────────────────────────────
  // INVESTING ACTIVITIES
  // ─────────────────────────────────────────────────────────────────────────────
  sectionHdr('Investing Activities');
  var invS = row;
  for (var i = 0; i < invAccounts.length; i++) {
    var acct = invAccounts[i];
    acctRow(acct, true, acct.type === 'Asset');
  }
  var invE = row - 1;
  var invTot = totalRow('Total Investing', invS, invE, true, '#e0e0e0');

  // ─────────────────────────────────────────────────────────────────────────────
  // FINANCING ACTIVITIES
  // ─────────────────────────────────────────────────────────────────────────────
  sectionHdr('Financing Activities');
  var finS = row;
  for (var i = 0; i < finAccounts.length; i++) {
    var acct = finAccounts[i];
    acctRow(acct, true, acct.type === 'Asset');
  }
  var finE = row - 1;
  var finTot = totalRow('Total Financing', finS, finE, true, '#e0e0e0');

  // ─────────────────────────────────────────────────────────────────────────────
  // NET CASH CHANGE
  // ─────────────────────────────────────────────────────────────────────────────
  row++;
  var netCashRow = row;
  sheet.getRange(row, 1).setValue('NET CASH CHANGE').setFontWeight('bold');
  var parts = ['C' + niRow];
  if (opTot)  parts.push('C' + opTot);
  if (invTot) parts.push('C' + invTot);
  if (finTot) parts.push('C' + finTot);
  sheet.getRange(row, 3).setFormula('=(' + parts.join('+') + ')').setFontWeight('bold');
  sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  sheet.getRange(row, 1, 1, 3).setBackground('#c8c8c8');
  sheet.getRange(row, 1, 1, 3).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  row++;

  var closingCashRow = row;
  sheet.getRange(row, 1).setValue('CLOSING CASH BALANCE').setFontWeight('bold').setFontSize(11);
  sheet.getRange(row, 3).setFormula('=C' + openingCashRow + '+C' + netCashRow).setFontWeight('bold').setFontSize(11);
  sheet.getRange(row, 3).setNumberFormat('#,##0.00;(#,##0.00);0.00');
  sheet.getRange(row, 1, 1, 3).setBackground('#c0c0c0');
  sheet.getRange(row, 1, 1, 3).setBorder(true, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  sheet.setFrozenRows(4);
  Logger.log('CF-skuld built: %d rows', row);
}

