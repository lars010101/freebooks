import re

with open("functions/src/reports.js", "r") as f:
    content = f.read()

# 1. Remove from handleReports switch
def replace_between(text, start_str, end_str, replacement=""):
    start = text.find(start_str)
    if start == -1: return text
    end = text.find(end_str, start)
    if end == -1: return text
    return text[:start] + replacement + text[end:]

content = replace_between(content, "case 'report.refresh_tb':", "case 'report.refresh_ap_aging':")
content = replace_between(content, "case 'report.refresh_sce':", "default:\n      throw Object", "default:\n      throw Object")

# 2. Remove dead functions using same logic as ui.gs
def remove_function(fn_name, text):
    pattern = r"(?:/\*\*(?:(?!\*/).)*\*/\n)?(?:async )?function " + fn_name + r"[^{]*\{"
    match = re.search(pattern, text, re.DOTALL)
    if not match: return text
    
    start_idx = match.start()
    
    open_braces = 0
    idx = match.end() - 1
    in_str = False
    str_char = ''
    while idx < len(text):
        c = text[idx]
        if c in ["'", '"', '`'] and (idx == 0 or text[idx-1] != '\\'):
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
    "refreshTrialBalance",
    "queryPLPeriod",
    "refreshPL",
    "queryBSPeriod",
    "refreshBS",
    "refreshCF",
    "refreshDashboard",
    "refreshSCE",
    "refreshIntegrity"
]

for fn in dead_fns:
    content = remove_function(fn, content)

# 3. Clean up exports
content = replace_between(content, "module.exports = { handleReports };", "module.exports = { handleReports };", "module.exports = { handleReports };")

# 4. Remove empty lines
content = re.sub(r'\n\s*\n\s*\n', '\n\n', content)

with open("functions/src/reports.js", "w") as f:
    f.write(content)

