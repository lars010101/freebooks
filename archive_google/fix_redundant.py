import re

with open("sheets/relay.gs", "r") as f:
    text = f.read()

# Fix redundant Integrity in TAB_CONFIG
text = text.replace("'Integrity':     { color: '#ff9800', category: 'reports' },\n  'Integrity':           { color: '#ff9800', category: 'reports' },", "'Integrity':           { color: '#ff9800', category: 'reports' },")

# Fix duplicate CF in formulaTabs
text = text.replace("['PL', 'BS', 'CF', 'CF', 'SCE', 'TB', 'Integrity']", "['PL', 'BS', 'CF', 'SCE', 'TB', 'Integrity']")
text = text.replace("['PL', 'BS', 'CF', 'CF', 'SCE', 'Integrity', 'Integrity']", "['PL', 'BS', 'CF', 'SCE', 'Integrity']")

with open("sheets/relay.gs", "w") as f:
    f.write(text)

with open("sheets/state.gs", "r") as f:
    text = f.read()
text = text.replace("['PL', 'BS', 'CF', 'CF', 'SCE', 'Integrity', 'Integrity', 'Period Balances', 'COA']", "['PL', 'BS', 'CF', 'SCE', 'Integrity', 'Period Balances', 'COA']")
with open("sheets/state.gs", "w") as f:
    f.write(text)
