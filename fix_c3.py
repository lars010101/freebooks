import re

with open("sheets/relay.gs", "r") as f:
    text = f.read()

def shift_pl(match):
    s = match.group(0)
    s = s.replace("'C3'", "'C4'")
    s = s.replace('"C3"', '"C4"')
    s = s.replace("'C$3'", "'C$4'")
    s = s.replace("'C2'", "'C4'")
    s = s.replace('"C2"', '"C4"')
    s = s.replace("'C$2'", "'C$4'")
    return s

text = re.sub(r'function buildPL_\(sheet, ss\).*?^\}', shift_pl, text, flags=re.DOTALL|re.MULTILINE)
text = re.sub(r'function buildBS_\(sheet, ss\).*?^\}', shift_pl, text, flags=re.DOTALL|re.MULTILINE)
text = re.sub(r'function buildCF_\(sheet, ss\).*?^\}', shift_pl, text, flags=re.DOTALL|re.MULTILINE)
text = re.sub(r'function buildTB_\(sheet, ss\).*?^\}', shift_pl, text, flags=re.DOTALL|re.MULTILINE)
text = re.sub(r'function buildSCE_\(sheet, ss\).*?^\}', shift_pl, text, flags=re.DOTALL|re.MULTILINE)
text = re.sub(r'function buildIntegrity_\(sheet, ss\).*?^\}', shift_pl, text, flags=re.DOTALL|re.MULTILINE)

with open("sheets/relay.gs", "w") as f:
    f.write(text)
