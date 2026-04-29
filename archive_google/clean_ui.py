import re

with open("sheets/ui.gs", "r") as f:
    ui = f.read()

# 1. Remove writeReportToSheet_ cases
def replace_between(text, start_str, end_str, replacement=""):
    start = text.find(start_str)
    if start == -1: return text
    end = text.find(end_str, start)
    if end == -1: return text
    return text[:start] + replacement + text[end:]

ui = replace_between(ui, "case 'profit_and_loss':", "case 'cash_flow':\n      writeCashFlowReport_(sheet, reportData);\n      break;")
ui = replace_between(ui, "case 'sce':", "case 'integrity':\n      writeIntegrityReport_(sheet, reportData);\n      break;\n")

# 2. Remove all dead writer functions
def remove_function(fn_name, text):
    # Regex to find function and match its braces
    pattern = r"/\*\*(?:(?!\*/).)*\*/\nfunction " + fn_name + r"[^{]*\{"
    match = re.search(pattern, text, re.DOTALL)
    if not match:
        pattern = r"function " + fn_name + r"[^{]*\{"
        match = re.search(pattern, text, re.DOTALL)
    if not match: return text
    
    start_idx = match.start()
    
    # Simple brace matching
    open_braces = 0
    idx = match.end() - 1
    in_str = False
    str_char = ''
    while idx < len(text):
        c = text[idx]
        if c in ["'", '"'] and (idx == 0 or text[idx-1] != '\\'):
            if not in_str:
                in_str = True
                str_char = c
            elif str_char == c:
                in_str = False
        if not in_str:
            if c == '{': open_braces += 1
            elif c == '}':
                open_braces -= 1
                if open_braces == 0:
                    break
        idx += 1
    
    return text[:start_idx] + text[idx+1:]

dead_fns = [
    "writeCategorisedReport_",
    "writeBSSection_",
    "writeMultiPeriodPL_",
    "writeMultiPeriodBS_",
    "writeSinglePeriodPL_",
    "periodLabel",
    "writeSinglePeriodBS_",
    "writeSCEReport_",
    "writeCashFlowReport_",
    "writeIntegrityReport_"
]

for fn in dead_fns:
    ui = remove_function(fn, ui)

with open("sheets/ui.gs", "w") as f:
    f.write(ui)

