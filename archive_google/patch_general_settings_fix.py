import re

with open("sheets/relay.gs", "r") as f:
    relay = f.read()

old_block = """      var sheet = ss.getSheetByName('General Settings');
      sheet.clear();
      sheet.getRange(1, 1, rows.length, 2).setValues(rows);
      sheet.getRange(1, 1, rows.length, 1).setFontWeight('bold').setBackground('#f0f0f0');
      sheet.autoResizeColumns(1, 2);
      return '✅ General Settings loaded';"""

new_block = """      var sheet = ss.getSheetByName('General Settings') || ss.getSheetByName('General') || ss.getActiveSheet();
      if (sheet) {
        sheet.clear();
        sheet.getRange(1, 1, rows.length, 2).setValues(rows);
        sheet.getRange(1, 1, rows.length, 1).setFontWeight('bold').setBackground('#f0f0f0');
        sheet.autoResizeColumns(1, 2);
      }
      return '✅ General Settings loaded';"""

relay = relay.replace(old_block, new_block)

with open("sheets/relay.gs", "w") as f:
    f.write(relay)
