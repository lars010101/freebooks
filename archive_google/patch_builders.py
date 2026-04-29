import re

with open("sheets/relay.gs", "r") as f:
    relay = f.read()

# 1. Replace the hardcoded 'FY2025' with dynamic latest period
relay = relay.replace(".setValue('FY2025').setFontWeight('bold')", ".setValue(latestPeriod).setFontWeight('bold')")

# 2. Inject the `var latestPeriod = ...` code at the top of each `sheet.clear()`
# But wait, there are multiple `sheet.clear()` calls. Let's do it specifically.
# Let's replace `sheet.clear();` with:
replacement = """sheet.clear();
  var periodsList = getCachePeriods_(ss);
  var latestPeriod = periodsList.length > 0 ? periodsList[periodsList.length - 1] : '';"""
relay = relay.replace("sheet.clear();", replacement)

# 3. Add `insertStandardReportMetadata_(sheet, ss);` to the end of each build function
# Find where they end. Usually `Logger.log('... built');` or just before `}`.
builders = ['buildPL_', 'buildBS_', 'buildCF_', 'buildTB_', 'buildSCE_', 'buildIntegrity_', 'buildGL_']

for b in builders:
    # Find the function definition
    start = relay.find(f"function {b}")
    if start == -1: continue
    
    # Find the next function definition or end of file
    next_fn = relay.find("function ", start + 10)
    if next_fn == -1: next_fn = len(relay)
    
    fn_body = relay[start:next_fn]
    
    # Inject before Logger.log or the last }
    if "Logger.log" in fn_body:
        fn_body = fn_body.replace("  Logger.log(", "  insertStandardReportMetadata_(sheet, ss);\n  Logger.log(")
    else:
        # Just inject before the last closing brace
        last_brace = fn_body.rfind("}")
        fn_body = fn_body[:last_brace] + "  insertStandardReportMetadata_(sheet, ss);\n" + fn_body[last_brace:]
        
    relay = relay[:start] + fn_body + relay[next_fn:]

with open("sheets/relay.gs", "w") as f:
    f.write(relay)

