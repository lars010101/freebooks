import re

with open("sheets/relay.gs", "r") as f:
    text = f.read()

# Remove case 'CF':
start = text.find("    case 'CF':")
if start != -1:
    end = text.find("return '✅ Cash Flow refreshed';", start) + len("return '✅ Cash Flow refreshed';")
    text = text[:start] + text[end+1:]

# Remove case 'CF-skuld':
start = text.find("    case 'CF-skuld':")
if start != -1:
    end = text.find("return '✅ Cash Flow (skuld) rebuilt — multi-period, all FY columns';", start) + len("return '✅ Cash Flow (skuld) rebuilt — multi-period, all FY columns';")
    text = text[:start] + text[end+1:]

with open("sheets/relay.gs", "w") as f:
    f.write(text)

