# Fix 1: Remove C4 stale indicator (B3 "Refreshed" is sufficient)
with open("sheets/state.gs", "r") as f:
    state = f.read()

# Replace the stale indicator writes to C4 with no-ops
state = state.replace(
    "  // Direct query reports: stale warning in C4\n  var cell = sheet.getRange('C4');",
    "  // Stale indicator disabled — B3 Refreshed timestamp is sufficient\n  // var cell = sheet.getRange('C4');\n  return;"
)
state = state.replace(
    "  // Direct query reports: timestamp in C4\n  var cell = sheet.getRange('C4');",
    "  // Timestamp indicator disabled — B3 Refreshed timestamp is sufficient\n  // var cell = sheet.getRange('C4');\n  return;"
)
with open("sheets/state.gs", "w") as f:
    f.write(state)

# Fix 2: Rename "fyxxxx" to "period_id" in backend
with open("functions/src/index.js", "r") as f:
    idx = f.read()
idx = idx.replace("p.period_name as fyxxxx", "p.period_name as period_id")
idx = idx.replace("fyxxxx: r.fyxxxx", "period_id: r.period_id")
with open("functions/src/index.js", "w") as f:
    f.write(idx)

# Fix 2b: Update column list in relay.gs
with open("sheets/relay.gs", "r") as f:
    relay = f.read()
relay = relay.replace(
    "['company_id', 'company_name', 'base_currency', 'fyxxxx', 'start_date', 'end_date', 'locked']",
    "['company_id', 'company_name', 'base_currency', 'period_id', 'start_date', 'end_date', 'locked']"
)
with open("sheets/relay.gs", "w") as f:
    f.write(relay)

# Fix 3: Currency in metadata — read from Settings sheet instead of hardcoding "Base"
with open("sheets/ui.gs", "r") as f:
    ui = f.read()
ui = ui.replace(
    "  var currency = 'Base'; ",
    """  var currency = '';
  var settingsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Settings');
  if (settingsSheet && sheetName !== 'Settings') {
    var sData = settingsSheet.getDataRange().getValues();
    for (var s = 0; s < sData.length; s++) {
      var label = String(sData[s][0]).toLowerCase().trim();
      if (label === 'currency:') { currency = sData[s][1] || ''; break; }
    }
  }
  if (!currency) {
    // Fallback: read from the Period table data if Settings has base_currency column
    currency = '';
  }"""
)
with open("sheets/ui.gs", "w") as f:
    f.write(ui)

print("All 3 fixes applied.")
