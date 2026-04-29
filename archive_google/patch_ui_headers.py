import re

with open("sheets/ui.gs", "r") as f:
    ui = f.read()

# Update readSheetData_
# headerRowIdx from 0 to 5. Instead of Math.min(data.length, 5), use Math.min(data.length, 10).
ui = ui.replace('Math.min(data.length, 5)', 'Math.min(data.length, 10)')

# Update writeToSheet_
def repl_write(m):
    return """
  // Global Metadata block
  var companyId = PropertiesService.getScriptProperties().getProperty('COMPANY_ID') || '';
  var currency = 'Base'; // Could fetch from Settings but usually injected by reports
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  
  if (sheetName !== 'General Settings') {
    sheet.getRange('A1:B1').setValues([['Company:', companyId]]);
    sheet.getRange('A2:B2').setValues([['Currency:', currency]]);
    sheet.getRange('A3:B3').setValues([['Refreshed:', now]]);
    sheet.getRange('A1:A3').setFontWeight('bold');
  }

  // Internal/cache sheets: write headers at row 6, data at row 7
  var headerRowNum = sheetName === 'General Settings' ? 1 : 6;
  var dataStartRow = sheetName === 'General Settings' ? 2 : 7;

  // Clear appropriately
  if (sheetName !== 'General Settings') {
    if (sheet.getLastRow() >= headerRowNum) {
      sheet.getRange(headerRowNum, 1, Math.max(sheet.getLastRow() - headerRowNum + 1, 1), Math.max(sheet.getLastColumn(), columns.length)).clear();
    }
  } else {
    sheet.clear();
  }
"""

ui = re.sub(r"  // Internal/cache sheets: write headers at row 1.*?  }", repl_write, ui, flags=re.DOTALL)

with open("sheets/ui.gs", "w") as f:
    f.write(ui)

