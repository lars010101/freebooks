import re

with open("sheets/state.gs", "r") as f:
    text = f.read()

# Fix applyStaleIndicator_
start = text.find("function applyStaleIndicator_(sheet) {")
if start != -1:
    end = text.find("}", start) + 1
    new_fn = """function applyStaleIndicator_(sheet) {
  var sheetName = sheet.getName();
  var noOverwrite = ['PL', 'BS', 'CF', 'CF-skuld', 'SCE', 'Integrity', 'Integrity Check', 'Period Balances', 'COA'];
  if (noOverwrite.indexOf(sheetName) !== -1) {
    try { sheet.setTabColor('red'); } catch(e) {}
  }
}"""
    text = text[:start] + new_fn + text[end:]

# Fix clearStaleIndicator_
start = text.find("function clearStaleIndicator_(sheetName) {")
if start != -1:
    end = text.find("}", start) + 1
    new_fn = """function clearStaleIndicator_(sheetName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  try {
    var config = TAB_CONFIG[sheetName] || { color: null };
    sheet.setTabColor(config.color);
  } catch(e) {}
}"""
    text = text[:start] + new_fn + text[end:]

with open("sheets/state.gs", "w") as f:
    f.write(text)

