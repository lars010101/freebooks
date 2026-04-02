import os
import glob

for filepath in glob.glob("skuld/sheets/*.gs"):
    with open(filepath, 'r') as f:
        content = f.read()

    # The issue was I did: sed -i 's/Settings/General Settings/g' skuld/sheets/*.gs
    # Let's fix the specific string literals instead.
    # We want to change the tab name 'Settings' to 'General Settings'.
    # We can just change 'Settings' to 'General Settings' when it's in quotes: "'Settings'" -> "'General Settings'"
    content = content.replace("'Settings'", "'General Settings'")
    content = content.replace('"Settings"', '"General Settings"')
    
    with open(filepath, 'w') as f:
        f.write(content)
