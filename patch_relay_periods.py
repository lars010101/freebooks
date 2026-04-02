import re

with open("sheets/relay.gs", "r") as f:
    relay = f.read()

old_block = """    case 'Settings':
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
      var sheet = ss.getSheetByName('Settings');
      if (!sheet) throw new Error('Settings tab not found');
      if (sheet) {
        sheet.clear();
        sheet.getRange(1, 1, rows.length, 2).setValues(rows);
        sheet.getRange(1, 1, rows.length, 1).setFontWeight('bold').setBackground('#f0f0f0');
        sheet.autoResizeColumns(1, 2);
      }
      return '✅ Settings loaded';"""

new_block = """    case 'Settings':
    case 'General':
      var r = callSkuld_('period.list', {});
      if (r) writeToSheet_('Settings', r, ['company_id', 'company_name', 'base_currency', 'fyxxxx', 'start_date', 'end_date', 'locked']);
      // Data validation for active company could go here, but for now we write the table
      return '✅ Settings loaded from database';"""

relay = relay.replace(old_block, new_block)

with open("sheets/relay.gs", "w") as f:
    f.write(relay)
