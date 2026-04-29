import re

with open("sheets/relay.gs", "r") as f:
    relay = f.read()

# 1. Let's add a helper function `getCompanyInfo_(ss, companyId)` to `relay.gs`
helper = """
function getCompanyInfo_(ss, companyId) {
  var info = { name: companyId, currency: '' };
  var cSheet = ss.getSheetByName('Companies');
  if (!cSheet) return info;
  
  var data = cSheet.getDataRange().getValues();
  // Find headers
  var hIdx = -1;
  for (var i = 0; i < Math.min(data.length, 10); i++) {
    if (String(data[i][0]).trim().toLowerCase() === 'company id') { hIdx = i; break; }
  }
  if (hIdx === -1) return info;
  
  var headers = data[hIdx].map(function(h) { return String(h).trim().toLowerCase(); });
  var idCol = headers.indexOf('company id');
  var nameCol = headers.indexOf('company name');
  var currCol = headers.indexOf('base currency');
  
  for (var r = hIdx + 1; r < data.length; r++) {
    if (String(data[r][idCol]).trim() === companyId) {
      if (nameCol >= 0 && data[r][nameCol]) info.name = String(data[r][nameCol]).trim();
      if (currCol >= 0 && data[r][currCol]) info.currency = String(data[r][currCol]).trim();
      break;
    }
  }
  return info;
}
"""

if "function getCompanyInfo_" not in relay:
    relay = relay.replace("function getConfig_() {", helper + "\nfunction getConfig_() {")
    # Actually, config is in config.gs. Let's just inject it at the bottom of the file or after getCachePeriods_
    relay = relay.replace("function getCachePeriods_", helper + "\nfunction getCachePeriods_")

# 2. In all build functions, replace the old Company Name logic with getCompanyInfo_
old_logic = """  // Get company name and currency from Settings
  var companyName = '', currency = '';
  var settingsSheet = ss.getSheetByName('Companies');
  if (settingsSheet) {
    var sData = settingsSheet.getDataRange().getValues();
    for (var s = 0; s < sData.length; s++) {
      var k = String(sData[s][0] || '').trim().toLowerCase();
      if (k === 'company') companyName = String(sData[s][1] || '').trim();
      if (k === 'currency') currency = String(sData[s][1] || '').trim();
    }
  }"""

new_logic = """  var companyId = typeof getActiveCompanyId_ === 'function' ? getActiveCompanyId_() : (PropertiesService.getScriptProperties().getProperty('COMPANY_ID') || '');
  var cInfo = getCompanyInfo_(ss, companyId);
  var companyName = cInfo.name;
  var currency = cInfo.currency;"""

relay = relay.replace(old_logic, new_logic)

# Wait, buildGL_ doesn't have the old logic. But we want to use companyName instead of companyId in the metadata block.
# The metadata block in ALL reports is:
meta_old = """  var companyId = typeof getActiveCompanyId_ === 'function' ? getActiveCompanyId_() : (PropertiesService.getScriptProperties().getProperty('COMPANY_ID') || '');
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  sheet.getRange('A1:B1').setValues([['Company:', companyId]]);
  sheet.getRange('A2:B2').setValues([['Currency:', currency]]);"""

meta_new = """  var cId = typeof getActiveCompanyId_ === 'function' ? getActiveCompanyId_() : (PropertiesService.getScriptProperties().getProperty('COMPANY_ID') || '');
  var cInfo = getCompanyInfo_(ss, cId);
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  sheet.getRange('A1:B1').setValues([['Company:', cInfo.name]]);
  sheet.getRange('A2:B2').setValues([['Currency:', cInfo.currency || currency]]);"""

relay = relay.replace(meta_old, meta_new)

with open("sheets/relay.gs", "w") as f:
    f.write(relay)

# 3. Update ui.gs for the direct pulls (like Journal, Period Balances)
with open("sheets/ui.gs", "r") as f:
    ui = f.read()

ui_meta_old = """  var companyId = typeof getActiveCompanyId_ === 'function' ? getActiveCompanyId_() : (PropertiesService.getScriptProperties().getProperty('COMPANY_ID') || '');
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
  sheet.getRange('A2:B2').setValues([['Currency:', currency]]);"""

ui_meta_new = """  var companyId = typeof getActiveCompanyId_ === 'function' ? getActiveCompanyId_() : (PropertiesService.getScriptProperties().getProperty('COMPANY_ID') || '');
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
  
  // Clear the entire sheet to ensure no ghost data from old layouts remains
  sheet.clear();

  // Rows 1-3: metadata block on ALL tabs
  sheet.getRange('A1:B1').setValues([['Company:', cName]]);
  sheet.getRange('A2:B2').setValues([['Currency:', currency]]);"""

ui = ui.replace(ui_meta_old, ui_meta_new)

with open("sheets/ui.gs", "w") as f:
    f.write(ui)

