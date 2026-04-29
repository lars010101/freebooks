import os
import glob

def patch_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    # The exact string matches we want to replace
    replacements = [
        (
            "`SELECT currency, vat_registered FROM finance.companies WHERE company_id = @companyId`",
            "`SELECT currency, vat_registered FROM finance.companies WHERE company_id = @companyId QUALIFY ROW_NUMBER() OVER(PARTITION BY company_id ORDER BY created_at DESC) = 1`"
        ),
        (
            "`SELECT currency, accounting_method, vat_registered FROM finance.companies WHERE company_id = @companyId`",
            "`SELECT currency, accounting_method, vat_registered FROM finance.companies WHERE company_id = @companyId QUALIFY ROW_NUMBER() OVER(PARTITION BY company_id ORDER BY created_at DESC) = 1`"
        ),
        (
            "`SELECT currency FROM finance.companies WHERE company_id = @companyId`",
            "`SELECT currency FROM finance.companies WHERE company_id = @companyId QUALIFY ROW_NUMBER() OVER(PARTITION BY company_id ORDER BY created_at DESC) = 1`"
        ),
        (
            "`SELECT fy_start, fy_end FROM finance.companies WHERE company_id = @companyId LIMIT 1`",
            "`SELECT fy_start, fy_end FROM finance.companies WHERE company_id = @companyId QUALIFY ROW_NUMBER() OVER(PARTITION BY company_id ORDER BY created_at DESC) = 1`"
        ),
        (
            "`SELECT company_name, fy_start, fy_end FROM finance.companies WHERE company_id = @companyId LIMIT 1`",
            "`SELECT company_name, fy_start, fy_end FROM finance.companies WHERE company_id = @companyId QUALIFY ROW_NUMBER() OVER(PARTITION BY company_id ORDER BY created_at DESC) = 1`"
        ),
        (
            "`SELECT company_id FROM finance.companies WHERE company_id = @companyId`",
            "`SELECT company_id FROM finance.companies WHERE company_id = @companyId QUALIFY ROW_NUMBER() OVER(PARTITION BY company_id ORDER BY created_at DESC) = 1`"
        )
    ]

    new_content = content
    for old, new in replacements:
        new_content = new_content.replace(old, new)

    if new_content != content:
        with open(filepath, 'w') as f:
            f.write(new_content)
        print(f"Patched {filepath}")

for root, _, files in os.walk('functions/src'):
    for file in files:
        if file.endswith('.js'):
            patch_file(os.path.join(root, file))

