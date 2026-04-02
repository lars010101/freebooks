import glob

for filepath in glob.glob("sheets/*.gs"):
    with open(filepath, 'r') as f:
        content = f.read()

    # Revert 'General Settings' to 'Settings'
    content = content.replace("'General Settings'", "'Settings'")
    content = content.replace('"General Settings"', '"Settings"')
    
    # Also fix the fallback logic we just added
    old_fallback = "var sheet = ss.getSheetByName('Settings') || ss.getSheetByName('General') || ss.getActiveSheet();"
    new_strict = "var sheet = ss.getSheetByName('Settings');\n      if (!sheet) throw new Error('Settings tab not found');"
    content = content.replace(old_fallback, new_strict)

    with open(filepath, 'w') as f:
        f.write(content)
