import re

with open("functions/src/setup.js", "r") as f:
    setup = f.read()

# Add finance.periods to the initSchema tables array
old_block = """    {
      id: 'settings',
      schema: [
        { name: 'company_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'key', type: 'STRING', mode: 'REQUIRED' },
        { name: 'value', type: 'STRING' },
        { name: 'updated_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
      ],
    },"""

new_block = """    {
      id: 'settings',
      schema: [
        { name: 'company_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'key', type: 'STRING', mode: 'REQUIRED' },
        { name: 'value', type: 'STRING' },
        { name: 'updated_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
      ],
    },
    {
      id: 'periods',
      schema: [
        { name: 'company_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'period_name', type: 'STRING', mode: 'REQUIRED' },
        { name: 'start_date', type: 'DATE', mode: 'REQUIRED' },
        { name: 'end_date', type: 'DATE', mode: 'REQUIRED' },
        { name: 'locked', type: 'BOOL' },
        { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
        { name: 'updated_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
      ],
    },"""

setup = setup.replace(old_block, new_block)

with open("functions/src/setup.js", "w") as f:
    f.write(setup)
