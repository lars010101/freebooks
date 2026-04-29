import re

with open("sheets/relay.gs", "r") as f:
    text = f.read()

header = """
  var periodsList = getCachePeriods_(ss);
  var latestPeriod = periodsList.length > 0 ? periodsList[periodsList.length - 1] : '';

  // Row 1-3: Global Metadata block
  var companyId = typeof getActiveCompanyId_ === 'function' ? getActiveCompanyId_() : (PropertiesService.getScriptProperties().getProperty('COMPANY_ID') || '');
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  sheet.getRange('A1:B1').setValues([['Company:', companyId]]);
  sheet.getRange('A2:B2').setValues([['Currency:', currency]]);
  sheet.getRange('A3:B3').setValues([['Refreshed:', now]]);
  sheet.getRange('A1:A3').setFontWeight('bold');
  sheet.getRange('A1:B3').setHorizontalAlignment('left');

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

def patch_fn(fn_name, text, is_tb=False):
    start = text.find(f"function {fn_name}(")
    if start == -1: return text
    
    # find where headers begin (after sheet.clear() and column widths)
    clear_idx = text.find("sheet.clear();", start)
    if clear_idx == -1: return text
    
    # find var row = 5;
    row5_idx = text.find("var row = 5;", clear_idx)
    if row5_idx == -1:
        row5_idx = text.find("var row = 4;", clear_idx)
    if row5_idx == -1: return text
    
    # find the end of the column width declarations
    col_width_end = text.rfind("sheet.setColumnWidth", clear_idx, row5_idx)
    if col_width_end == -1:
        insert_idx = clear_idx + len("sheet.clear();\n")
    else:
        insert_idx = text.find(";", col_width_end) + 2
    
    if is_tb:
        hdr = header + """
  // Row 6: Column headers
  sheet.getRange(row, 1, 1, 5).setValues([['Account Code', 'Account Name', 'Debit', 'Credit', 'Net Balance']]).setFontWeight('bold').setBackground('#e6e6e6');
  sheet.setFrozenRows(row);
  row++;
"""
    else:
        hdr = header
        
    end_idx = row5_idx + len("var row = 5;")
    if "var row = 4;" in text[clear_idx:row5_idx+12]:
        end_idx = row5_idx + len("var row = 4;")
    
    return text[:insert_idx] + hdr + text[end_idx:]

for fn in ['buildBS_', 'buildCF_', 'buildSCE_', 'buildIntegrity_']:
    text = patch_fn(fn, text)

text = patch_fn('buildTB_', text, is_tb=True)

with open("sheets/relay.gs", "w") as f:
    f.write(text)

