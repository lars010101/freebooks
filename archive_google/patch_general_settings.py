import re

with open("sheets/relay.gs", "r") as f:
    relay = f.read()

# Find the switch in _refreshTabInternal_
old_block = """    case 'Bank Processing':"""
new_block = """    case 'General Settings':
    case 'General':
      var data = getSettingsData();
      var rows = [
        ['Company ID', data.companyId || PropertiesService.getScriptProperties().getProperty('COMPANY_ID')],
        ['Company Name', data.companyName],
        ['Cloud Function URL', PropertiesService.getScriptProperties().getProperty('SKULD_FUNCTION_URL')],
        ['', ''],
        ['FY Start', data.fyStart],
        ['FY End', data.fyEnd],
        ['Min Account Length', data.minAccountLength || '6']
      ];
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheet = ss.getSheetByName('General Settings');
      sheet.clear();
      sheet.getRange(1, 1, rows.length, 2).setValues(rows);
      sheet.getRange(1, 1, rows.length, 1).setFontWeight('bold').setBackground('#f0f0f0');
      sheet.autoResizeColumns(1, 2);
      return '✅ General Settings loaded';
    case 'Bank Processing':"""

relay = relay.replace(old_block, new_block)

with open("sheets/relay.gs", "w") as f:
    f.write(relay)
