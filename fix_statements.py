import re

with open("sheets/relay.gs", "r") as f:
    relay = f.read()

universal_header = """
  var periodsList = getCachePeriods_(ss);
  var latestPeriod = periodsList.length > 0 ? periodsList[periodsList.length - 1] : '';

  // Row 1-3: Global Metadata block
  var companyId = typeof getActiveCompanyId_ === 'function' ? getActiveCompanyId_() : (PropertiesService.getScriptProperties().getProperty('COMPANY_ID') || '');
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  sheet.getRange('A1:B1').setValues([['Company:', companyId]]);
  sheet.getRange('A2:B2').setValues([['Currency:', currency]]);
  sheet.getRange('A3:B3').setValues([['Refreshed:', now]]);
  sheet.getRange('A1:A3').setFontWeight('bold');

  // Row 4: Period selector
  sheet.getRange(4, 1).setValue(''); 
  sheet.getRange(4, 2).setValue('Period:').setFontWeight('bold');
  sheet.getRange(4, 3).setValue(latestPeriod).setFontWeight('bold');
  setPeriodDropdown_(ss, sheet.getRange(4, 3));
  sheet.getRange(4, 3).setBackground('#e8f0fe');

  // Row 5: Separator
  sheet.getRange('5:5').setBackground('#eeeeee');

  var row = 6;
"""

# Replace in buildPL_
old_pl = """  // Row 1: Company header
  sheet.getRange(1, 1).setValue('').setFontWeight('bold');
  sheet.getRange(1, 2).setValue('').setFontWeight('bold');
  sheet.getRange(1, 3).setValue('');

  // Row 2: Currency
  sheet.getRange(2, 1).setValue('').setFontWeight('bold');
  sheet.getRange(2, 2).setValue('');

  // Row 3: Period selector
  sheet.getRange(3, 1).setValue(''); sheet.getRange(3, 2).setValue('Period').setFontWeight('bold');
  sheet.getRange(3, 3).setValue('FY2025').setFontWeight('bold');
  setPeriodDropdown_(ss, sheet.getRange(3, 3));
  sheet.getRange(3, 3).setBackground('#e8f0fe');

  // Row 4: Separator
  sheet.getRange('4:4').setBackground('#eeeeee');

  var row = 5;"""
relay = relay.replace(old_pl, universal_header)

# buildBS_
old_bs = """  // Row 1: Company header
  sheet.getRange(1, 1).setValue('').setFontWeight('bold');
  sheet.getRange(1, 2).setValue('').setFontWeight('bold');

  // Row 2: Currency
  sheet.getRange(2, 1).setValue('').setFontWeight('bold');
  sheet.getRange(2, 2).setValue('');

  // Row 3: Period selector
  sheet.getRange(3, 1).setValue(''); sheet.getRange(3, 2).setValue('Period').setFontWeight('bold');
  sheet.getRange(3, 3).setValue('FY2025').setFontWeight('bold');
  setPeriodDropdown_(ss, sheet.getRange(3, 3));
  sheet.getRange(3, 3).setBackground('#e8f0fe');

  // Row 4: Separator
  sheet.getRange('4:4').setBackground('#eeeeee');

  var row = 5;"""
relay = relay.replace(old_bs, universal_header)

# buildCF_
old_cf = """  // ── Headers ──────────────────────────────────────────────────────────────────
  sheet.getRange(1, 1).setValue('').setFontWeight('bold');
  sheet.getRange(1, 2).setValue('').setFontWeight('bold');

  sheet.getRange(2, 1).setValue('').setFontWeight('bold');
  sheet.getRange(2, 2).setValue('');

  sheet.getRange(3, 1).setValue(''); sheet.getRange(3, 2).setValue('Period').setFontWeight('bold');
  sheet.getRange(3, 3).setValue('FY2025').setFontWeight('bold');
  setPeriodDropdown_(ss, sheet.getRange(3, 3));
  sheet.getRange(3, 3).setBackground('#e8f0fe');

  sheet.getRange('4:4').setBackground('#eeeeee');

  var row = 5;"""
relay = relay.replace(old_cf, universal_header)

# buildTB_
old_tb = """  // Row 1: Company
  sheet.getRange(1, 1).setValue('').setFontWeight('bold');
  sheet.getRange(1, 2).setValue('').setFontWeight('bold');

  // Row 2: Currency
  sheet.getRange(2, 1).setValue('').setFontWeight('bold');
  sheet.getRange(2, 2).setValue('');

  // Row 3: Period selector
  sheet.getRange(3, 1).setValue(''); sheet.getRange(3, 2).setValue('Period').setFontWeight('bold');
  sheet.getRange(3, 3).setValue('FY2025').setFontWeight('bold').setBackground('#e8f0fe');
  setPeriodDropdown_(ss, sheet.getRange(3, 3));

  // Row 4: Column headers
  sheet.getRange(4, 1, 1, 5).setValues([['Account Code', 'Account Name', 'Debit', 'Credit', 'Net Balance']]).setFontWeight('bold').setBackground('#e6e6e6');
  sheet.setFrozenRows(4);

  var row = 5;"""
tb_header = universal_header + """
  // Row 6: Column headers
  sheet.getRange(row, 1, 1, 5).setValues([['Account Code', 'Account Name', 'Debit', 'Credit', 'Net Balance']]).setFontWeight('bold').setBackground('#e6e6e6');
  sheet.setFrozenRows(row);
  row++;
"""
relay = relay.replace(old_tb, tb_header)

# buildSCE_
old_sce = """  // Row 1: Company header
  sheet.getRange(1, 1).setValue('').setFontWeight('bold');
  sheet.getRange(1, 2).setValue('').setFontWeight('bold');

  // Row 2: Currency
  sheet.getRange(2, 1).setValue('').setFontWeight('bold');
  sheet.getRange(2, 2).setValue('');

  // Row 3: Period selector
  sheet.getRange(3, 1).setValue(''); sheet.getRange(3, 2).setValue('Period').setFontWeight('bold');
  sheet.getRange(3, 3).setValue('FY2025').setFontWeight('bold');
  setPeriodDropdown_(ss, sheet.getRange(3, 3));
  sheet.getRange(3, 3).setBackground('#e8f0fe');

  // Row 4: Separator
  sheet.getRange('4:4').setBackground('#eeeeee');

  var row = 5;"""
relay = relay.replace(old_sce, universal_header)

# buildIntegrity_
old_int = """  // Headers
  sheet.getRange(1, 1).setValue('').setFontWeight('bold');
  sheet.getRange(1, 2).setValue('').setFontWeight('bold');

  sheet.getRange(2, 1).setValue(''); sheet.getRange(2, 2).setValue('Period').setFontWeight('bold');
  sheet.getRange(2, 3).setValue('FY2025').setFontWeight('bold');
  setPeriodDropdown_(ss, sheet.getRange(2, 3));
  sheet.getRange(2, 3).setBackground('#e8f0fe');

  sheet.getRange('3:3').setBackground('#eeeeee');

  var row = 4;"""
relay = relay.replace(old_int, universal_header)

# Fix pbCum, pbDelta, getCachePeriods_ rows (2->6)
relay = relay.replace("PB + '!$2:$2'", "PB + '!$6:$6'")
relay = relay.replace("getRange(2, 1, 1", "getRange(6, 1, 1")

# Fix the alerts string
relay = relay.replace("'✅ P&L generated.\\nChange period in C3.'", "'✅ P&L generated.\\nChange period in C4.'")
relay = relay.replace("'✅ Balance Sheet generated.\\nChange period in C3.'", "'✅ Balance Sheet generated.\\nChange period in C4.'")
relay = relay.replace("'✅ Cash Flow generated.\\nChange period in C3.'", "'✅ Cash Flow generated.\\nChange period in C4.'")
relay = relay.replace("'✅ Trial Balance generated.\\nChange period in C3.'", "'✅ Trial Balance generated.\\nChange period in C4.'")
relay = relay.replace("'✅ Statement of Changes in Equity generated.\\nChange period in C3.'", "'✅ Statement of Changes in Equity generated.\\nChange period in C4.'")
relay = relay.replace("'✅ Integrity Check generated.\\nChange period in C2.'", "'✅ Integrity Check generated.\\nChange period in C4.'")

# Safely rename 'C$3' inside the PL/BS formulas ONLY
def replace_in_function(code, fn_name, target, replacement):
    start = code.find(f"function {fn_name}(")
    if start == -1: return code
    end = code.find("function ", start + 20)
    if end == -1: end = len(code)
    sub = code[start:end]
    sub = sub.replace(target, replacement)
    return code[:start] + sub + code[end:]

for fn in ['buildPL_', 'buildBS_', 'buildCF_', 'buildTB_', 'buildSCE_', 'buildIntegrity_']:
    relay = replace_in_function(relay, fn, "'C$3'", "'C$4'")
    relay = replace_in_function(relay, fn, "'C3'", "'C4'")
    relay = replace_in_function(relay, fn, '"C3"', '"C4"')
    relay = replace_in_function(relay, fn, "'C$2'", "'C$4'")
    relay = replace_in_function(relay, fn, "'C2'", "'C4'")
    relay = replace_in_function(relay, fn, '"C2"', '"C4"')

# We also need to fix `getSheetDataWithHeaders_` which was previously skipping metadata rows incorrectly
relay = relay.replace(
"""    if (firstCell === 'period:' || firstCell === 'refresh sheet to populate with data' || firstCell === '' || firstCell === 'data as of:') {
      continue;
    }""",
"""    if (firstCell === 'company:' || firstCell === 'currency:' || firstCell === 'refreshed:' || 
        firstCell === 'data as of:' || firstCell === 'period:' || 
        firstCell === 'refresh sheet to populate with data' || firstCell === '') {
      continue;
    }"""
)

with open("sheets/relay.gs", "w") as f:
    f.write(relay)

