with open("sheets/relay.gs", "r") as f:
    lines = f.readlines()

in_refresh = False
in_save = False

new_lines = []
skip = False

for line in lines:
    if "function _refreshTabInternal_" in line:
        in_refresh = True
        in_save = False
    elif "function _saveTabInternal_" in line:
        in_refresh = False
        in_save = True

    if in_refresh and "case 'Settings':" in line:
        skip = True
        new_lines.append("    case 'Settings':\n")
        new_lines.append("    case 'General':\n")
        new_lines.append("      var r = callSkuld_('period.list', {});\n")
        new_lines.append("      if (r) writeToSheet_('Settings', r, ['company_id', 'company_name', 'base_currency', 'fyxxxx', 'start_date', 'end_date', 'locked']);\n")
        new_lines.append("      return '✅ Settings loaded from database';\n")
        continue

    if in_save and "case 'Settings':" in line:
        skip = True
        new_lines.append("    case 'Settings':\n")
        new_lines.append("    case 'General':\n")
        new_lines.append("      var data = readSettingsFromSheet_();\n")
        new_lines.append("      return callSkuld_('settings.save', { settings: data }) ? '✅ Settings saved' : '❌ Failed to save';\n")
        continue

    if skip:
        # We need to skip until the next 'case' or 'default'
        if line.strip().startswith("case '") or line.strip().startswith("default:"):
            skip = False
            if "case 'General':" in line:
                skip = True # skip the fallthrough case too
                continue
        else:
            continue

    if not skip:
        new_lines.append(line)

with open("sheets/relay.gs", "w") as f:
    f.writelines(new_lines)
