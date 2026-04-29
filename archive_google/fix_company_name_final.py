import re

with open("sheets/relay.gs", "r") as f:
    relay = f.read()

# Inject getCompanyInfo_ if not there
helper = """
function getCompanyInfo_(ss, companyId) {
  var info = { name: companyId, currency: '' };
  var cSheet = ss.getSheetByName('Companies');
  if (!cSheet) return info;
  
  var data = cSheet.getDataRange().getValues();
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
    # Inject it before function pbCum_
    relay = relay.replace("function pbCum_", helper + "\nfunction pbCum_")

# Replace all occurrences of the old meta block in build functions
meta_old = """  var companyId = typeof getActiveCompanyId_ === 'function' ? getActiveCompanyId_() : (PropertiesService.getScriptProperties().getProperty('COMPANY_ID') || '');
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  sheet.getRange('A1:B1').setValues([['Company:', companyId]]);
  sheet.getRange('A2:B2').setValues([['Currency:', currency]]);"""

meta_new = """  var cId = typeof getActiveCompanyId_ === 'function' ? getActiveCompanyId_() : (PropertiesService.getScriptProperties().getProperty('COMPANY_ID') || '');
  var cInfo = getCompanyInfo_(ss, cId);
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  sheet.getRange('A1:B1').setValues([['Company:', cInfo.name]]);
  sheet.getRange('A2:B2').setValues([['Currency:', cInfo.currency || '']]);"""

relay = relay.replace(meta_old, meta_new)

with open("sheets/relay.gs", "w") as f:
    f.write(relay)

