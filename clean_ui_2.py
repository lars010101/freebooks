import re

with open("sheets/ui.gs", "r") as f:
    ui = f.read()

# Remove case 'cash_flow':
start = ui.find("    case 'cash_flow':")
if start != -1:
    end = ui.find("break;", start) + 6
    ui = ui[:start] + ui[end:]

# Remove case 'sce':
start = ui.find("    case 'sce':")
if start != -1:
    end = ui.find("break;", start) + 6
    ui = ui[:start] + ui[end:]

# Remove case 'integrity':
start = ui.find("    case 'integrity':")
if start != -1:
    end = ui.find("break;", start) + 6
    ui = ui[:start] + ui[end:]

# Remove empty lines
ui = re.sub(r'\n\s*\n\s*\n', '\n\n', ui)

with open("sheets/ui.gs", "w") as f:
    f.write(ui)

