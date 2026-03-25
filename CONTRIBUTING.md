# Contributing to Skuld

Thank you for considering contributing to Skuld! Here's how you can help.

## Adding a New Jurisdiction

This is the most impactful contribution. Each jurisdiction pack makes Skuld usable in a new country.

### Steps

1. **Copy the template:**
   ```bash
   cp -r jurisdictions/_template jurisdictions/XX  # XX = ISO country code
   ```

2. **Fill in `manifest.json`:**
   - Country name, currency, reporting standard
   - Default accounting method
   - VAT/GST name, rates, registration threshold
   - Tax authority and company registry names

3. **Create the Chart of Accounts (`coa_*.json`):**
   - Account codes and names per the country's standard chart
   - `account_type`: Asset, Liability, Equity, Revenue, Expense
   - `pl_category`: P&L line mapping (null for BS accounts)
   - `bs_category`: Balance Sheet section
   - `cf_category`: Cash Flow classification
   - Use the country's official standard chart as reference

4. **Create VAT codes (`vat_codes.json`):**
   - All applicable rates (standard, reduced, zero, exempt)
   - Input/output account mappings
   - `report_box`: maps to the official VAT return form boxes
   - Include reverse charge codes if applicable

5. **Optional: AI prompts (`prompts/`):**
   - Annual report narrative prompts
   - Tax return preparation prompts
   - Jurisdiction-specific accounting rules context

6. **Add test data (`tests/test_data.json`):**
   - Sample journal entries with known-correct report outputs
   - Used to validate the jurisdiction pack produces accurate results

7. **Submit a Pull Request:**
   - Title: `Add jurisdiction: XX (Country Name)`
   - Describe any country-specific accounting rules or special considerations

### What Reviewers Check

- COA completeness against the official standard
- VAT rate accuracy (verified against tax authority website)
- Report box mappings match actual tax/VAT return forms
- Test data produces correct results
- `manifest.json` is complete and accurate

## Bug Reports

Open an issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your jurisdiction (if relevant)

## Code Contributions

### Setup

```bash
git clone https://github.com/skuld-finance/skuld.git
cd skuld/functions
npm install
npm test
```

### Structure

- `functions/src/` — Cloud Functions logic (Node.js)
- `sheets/` — Apps Script relay (Google Apps Script)
- `schema/` — BigQuery DDL and migrations
- `jurisdictions/` — Country-specific data packs

### Guidelines

- All business logic goes in Cloud Functions, never in Apps Script
- Apps Script is a thin relay only
- Add tests for new functionality
- Follow existing code style
- Document any new settings or configuration

## License

By contributing, you agree that your contributions will be licensed under the AGPL-3.0 license.
