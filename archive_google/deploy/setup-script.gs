/**
 * SKULD SETUP — Run this once, then delete this file.
 * Select setupSkuld from the dropdown and click Run.
 */
function setupSkuld() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // === CONFIG ===
  var COMPANY_ID = 'techpte_sg';
  var COMPANY_NAME = 'Tech Pte Ltd (SG)';
  var FUNCTION_URL = 'https://us-central1-skuld-491310.cloudfunctions.net/skuld';
  var GCP_PROJECT = 'skuld-491310';
  
  // === TAB DEFINITIONS ===
  var tabs = [
    {name:'Dashboard', color:'#3399ee', headers:['Metric','Value']},
    {name:'Manual Entry', color:'#4db34d', headers:['Date','Account Code','Debit','Credit','Description','Reference','Currency','FX Rate','VAT Code','Cost Center','Profit Center']},
    {name:'Bank Processing', color:'#4db34d', headers:['Date','Description','Amount','Currency','Match Type','Debit Account','Credit Account','VAT Code','Bill ID','Suggested Desc','Approved','Save Rule']},
    {name:'Import', color:'#4db34d', headers:['Batch ID','Date','Account Code','Debit','Credit','Description','Reference','Currency','FX Rate','VAT Code','Cost Center','Profit Center']},
    {name:'Export', color:'#4db34d', headers:['Date','Batch ID','Account Code','Debit','Credit','Currency','Description','Reference','Source']},
    {name:'Bills', color:'#e68033', headers:['Bill ID','Vendor','Vendor Ref','Date','Due Date','Amount','Currency','Expense Account','AP Account','VAT Code','Cost Center','Profit Center','Status','Amount Paid','Description']},
    {name:'COA', color:'#808080', headers:['Account Code','Account Name','Account Type','Account Subtype','PL Category','BS Category','CF Category','Is Active','Effective From','Effective To']},
    {name:'Mappings', color:'#808080', headers:['Pattern','Match Type','Debit Account','Credit Account','Description Override','VAT Code','Cost Center','Profit Center','Priority','Is Active']},
    {name:'Centers', color:'#808080', headers:['Center ID','Center Type','Name','Is Active']},
    {name:'VAT Codes', color:'#808080', headers:['VAT Code','Description','Rate','Input Account','Output Account','Report Box','Reverse Charge','Is Active','Effective From','Effective To']},
    {name:'Settings', color:'#808080', headers:['Setting','Value']},
    {name:'TB', color:'#3366cc', headers:['Account Code','Account Name','Account Type','Debit','Credit','Balance']},
    {name:'PL', color:'#3366cc', headers:['Category','Account Code','Account Name','Amount']},
    {name:'BS', color:'#3366cc', headers:['Section','Category','Account Code','Account Name','Balance']},
    {name:'CF', color:'#3366cc', headers:['Category','Account Code','Account Name','Movement']},
    {name:'AP Aging', color:'#3366cc', headers:['Bucket','Vendor','Vendor Ref','Outstanding','Days Past Due']},
    {name:'VAT Return', color:'#3366cc', headers:['Box','Description','Amount']},
  ];
  
  // === CREATE TABS ===
  // Rename Sheet1 to first tab
  var existingSheets = ss.getSheets();
  existingSheets[0].setName(tabs[0].name);
  
  for (var i = 1; i < tabs.length; i++) {
    ss.insertSheet(tabs[i].name, i);
  }
  
  // Delete any extra default sheets
  var allSheets = ss.getSheets();
  for (var s = allSheets.length - 1; s >= 0; s--) {
    var found = false;
    for (var t = 0; t < tabs.length; t++) {
      if (allSheets[s].getName() === tabs[t].name) { found = true; break; }
    }
    if (!found && allSheets.length > 1) {
      ss.deleteSheet(allSheets[s]);
    }
  }
  
  // === FORMAT EACH TAB ===
  for (var i = 0; i < tabs.length; i++) {
    var sheet = ss.getSheetByName(tabs[i].name);
    if (!sheet) continue;
    
    // Tab color
    sheet.setTabColor(tabs[i].color);
    
    // Freeze header row
    sheet.setFrozenRows(1);
    
    // Write headers
    var headers = tabs[i].headers;
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setValues([headers]);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#e6e6e6');
    
    // Auto-resize
    for (var c = 1; c <= headers.length; c++) {
      sheet.autoResizeColumn(c);
    }
  }
  
  // === POPULATE SETTINGS ===
  var settingsSheet = ss.getSheetByName('Settings');
  var settingsData = [
    ['Company ID', COMPANY_ID],
    ['Company Name', COMPANY_NAME],
    ['Cloud Function URL', FUNCTION_URL],
    ['', ''],
    ['FY Start', '2025-01-01'],
    ['FY End', '2025-12-31'],
    ['Cost Center', ''],
    ['Profit Center', ''],
  ];
  settingsSheet.getRange(2, 1, settingsData.length, 2).setValues(settingsData);
  
  // === POPULATE DASHBOARD ===
  var dashSheet = ss.getSheetByName('Dashboard');
  var dashData = [
    ['Revenue', '—'],
    ['Expenses', '—'],
    ['Net Income', '—'],
    ['', ''],
    ['Total Assets', '—'],
    ['Total Liabilities', '—'],
    ['Total Equity', '—'],
    ['Balanced', '—'],
    ['', ''],
    ['Journal Entries', '0'],
    ['First Entry', '—'],
    ['Last Entry', '—'],
  ];
  dashSheet.getRange(2, 1, dashData.length, 2).setValues(dashData);
  
  // === SET SCRIPT PROPERTIES ===
  var props = PropertiesService.getScriptProperties();
  props.setProperty('SKULD_FUNCTION_URL', FUNCTION_URL);
  props.setProperty('GCP_PROJECT_ID', GCP_PROJECT);
  props.setProperty('COMPANY_ID', COMPANY_ID);
  
  // === DONE ===
  SpreadsheetApp.getUi().alert(
    '✅ Skuld setup complete!\n\n'
    + '17 tabs created and formatted.\n'
    + 'Script properties configured.\n\n'
    + 'Next: Create 3 new script files (relay.gs, config.gs, ui.gs)\n'
    + 'and paste the code from the Skuld repo sheets/ directory.\n'
    + 'Then reload the spreadsheet — the ⚖️ Skuld menu will appear.'
  );
}
