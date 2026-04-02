import re

with open("sheets/ui.gs", "r") as f:
    ui = f.read()

ui = ui.replace('Math.min(data.length, 5)', 'Math.min(data.length, 10)')

old_block = """  // Internal/cache sheets: write headers at row 1, data at row 2 (no metadata row)
  var internalSheets = ['COA', 'Mappings', 'VAT Codes', 'Centers', 'Bills'];
  var isInternal = internalSheets.indexOf(sheetName) !== -1;
  var headerRowNum = isInternal ? 1 : 2;
  var dataStartRow = isInternal ? 2 : 3;

  // Clear appropriately
  if (isInternal) {
    sheet.clear();
  } else {
    // Preserve row 1 metadata
    if (sheet.getLastRow() > 1) {
      sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), Math.max(sheet.getLastColumn(), columns.length)).clear();
    }
  }"""

new_block = """  // Global Metadata block
  var companyId = PropertiesService.getScriptProperties().getProperty('COMPANY_ID') || '';
  var currency = 'Base'; 
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  
  if (sheetName !== 'General Settings') {
    sheet.getRange('A1:B1').setValues([['Company:', companyId]]);
    sheet.getRange('A2:B2').setValues([['Currency:', currency]]);
    sheet.getRange('A3:B3').setValues([['Refreshed:', now]]);
    sheet.getRange('A1:A3').setFontWeight('bold');
  }

  // Write headers at row 6, data at row 7
  var headerRowNum = sheetName === 'General Settings' ? 1 : 6;
  var dataStartRow = sheetName === 'General Settings' ? 2 : 7;

  // Clear appropriately
  if (sheetName === 'General Settings') {
    sheet.clear();
  } else {
    if (sheet.getLastRow() >= headerRowNum) {
      sheet.getRange(headerRowNum, 1, Math.max(sheet.getLastRow() - headerRowNum + 1, 1), Math.max(sheet.getLastColumn(), columns.length)).clear();
    }
  }"""

ui = ui.replace(old_block, new_block)

with open("sheets/ui.gs", "w") as f:
    f.write(ui)
