#!/usr/bin/env node
/**
 * Skuld — Create Google Sheets template using Service Account
 * 
 * Usage: node create-sheet-sa.js <sa-key-path> <company_name> <company_id> <owner_email> [function_url]
 */

const { google } = require('googleapis');
const fs = require('fs');

const SA_KEY_PATH = process.argv[2];
const COMPANY_NAME = process.argv[3] || 'Skuld Company';
const COMPANY_ID = process.argv[4] || 'company_1';
const OWNER_EMAIL = process.argv[5] || '';
const FUNCTION_URL = process.argv[6] || 'https://us-central1-skuld-491310.cloudfunctions.net/skuld';

if (!SA_KEY_PATH) {
  console.error('Usage: node create-sheet-sa.js <sa-key.json> <company_name> <company_id> <owner_email> [function_url]');
  process.exit(1);
}

const TABS = [
  { name: 'Dashboard', color: { red: 0.2, green: 0.6, blue: 0.9 } },
  { name: 'Manual Entry', color: { red: 0.3, green: 0.7, blue: 0.3 } },
  { name: 'Bank Processing', color: { red: 0.3, green: 0.7, blue: 0.3 } },
  { name: 'Import', color: { red: 0.3, green: 0.7, blue: 0.3 } },
  { name: 'Export', color: { red: 0.3, green: 0.7, blue: 0.3 } },
  { name: 'Bills', color: { red: 0.9, green: 0.5, blue: 0.2 } },
  { name: 'COA', color: { red: 0.5, green: 0.5, blue: 0.5 } },
  { name: 'Mappings', color: { red: 0.5, green: 0.5, blue: 0.5 } },
  { name: 'Centers', color: { red: 0.5, green: 0.5, blue: 0.5 } },
  { name: 'VAT Codes', color: { red: 0.5, green: 0.5, blue: 0.5 } },
  { name: 'Settings', color: { red: 0.5, green: 0.5, blue: 0.5 } },
  { name: 'TB', color: { red: 0.2, green: 0.4, blue: 0.8 } },
  { name: 'PL', color: { red: 0.2, green: 0.4, blue: 0.8 } },
  { name: 'BS', color: { red: 0.2, green: 0.4, blue: 0.8 } },
  { name: 'CF', color: { red: 0.2, green: 0.4, blue: 0.8 } },
  { name: 'AP Aging', color: { red: 0.2, green: 0.4, blue: 0.8 } },
  { name: 'VAT Return', color: { red: 0.2, green: 0.4, blue: 0.8 } },
];

const HEADERS = {
  'Manual Entry': ['Date', 'Account Code', 'Debit', 'Credit', 'Description', 'Reference', 'Currency', 'FX Rate', 'VAT Code', 'Cost Center', 'Profit Center'],
  'Bank Processing': ['Date', 'Description', 'Amount', 'Currency', 'Match Type', 'Debit Account', 'Credit Account', 'VAT Code', 'Bill ID', 'Suggested Desc', 'Approved', 'Save Rule'],
  'Import': ['Batch ID', 'Date', 'Account Code', 'Debit', 'Credit', 'Description', 'Reference', 'Currency', 'FX Rate', 'VAT Code', 'Cost Center', 'Profit Center'],
  'Export': ['Date', 'Batch ID', 'Account Code', 'Debit', 'Credit', 'Currency', 'Description', 'Reference', 'Source'],
  'Bills': ['Bill ID', 'Vendor', 'Vendor Ref', 'Date', 'Due Date', 'Amount', 'Currency', 'Expense Account', 'AP Account', 'VAT Code', 'Cost Center', 'Profit Center', 'Status', 'Amount Paid', 'Description'],
  'COA': ['Account Code', 'Account Name', 'Account Type', 'Account Subtype', 'PL Category', 'BS Category', 'CF Category', 'Is Active', 'Effective From', 'Effective To'],
  'Mappings': ['Pattern', 'Match Type', 'Debit Account', 'Credit Account', 'Description Override', 'VAT Code', 'Cost Center', 'Profit Center', 'Priority', 'Is Active'],
  'Centers': ['Center ID', 'Center Type', 'Name', 'Is Active'],
  'VAT Codes': ['VAT Code', 'Description', 'Rate', 'Input Account', 'Output Account', 'Report Box', 'Reverse Charge', 'Is Active', 'Effective From', 'Effective To'],
  'Settings': ['Setting', 'Value'],
  'TB': ['Account Code', 'Account Name', 'Account Type', 'Debit', 'Credit', 'Balance'],
  'PL': ['Category', 'Account Code', 'Account Name', 'Amount'],
  'BS': ['Section', 'Category', 'Account Code', 'Account Name', 'Balance'],
  'CF': ['Category', 'Account Code', 'Account Name', 'Movement'],
  'Dashboard': ['Metric', 'Value'],
  'AP Aging': ['Bucket', 'Vendor', 'Vendor Ref', 'Outstanding', 'Days Past Due'],
  'VAT Return': ['Box', 'Description', 'Amount'],
};

async function main() {
  // Auth with service account
  const keyFile = JSON.parse(fs.readFileSync(SA_KEY_PATH, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: keyFile,
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
  });

  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  console.log(`Creating Skuld workbook for: ${COMPANY_NAME}`);

  // 1. Create spreadsheet
  const sheetDefs = TABS.map((tab, i) => ({
    properties: {
      sheetId: i,
      title: tab.name,
      index: i,
      tabColor: tab.color,
      gridProperties: { frozenRowCount: 1 },
    },
  }));

  const res = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `Skuld — ${COMPANY_NAME}` },
      sheets: sheetDefs,
    },
  });

  const ssId = res.data.spreadsheetId;
  const ssUrl = res.data.spreadsheetUrl;
  console.log(`Created: ${ssUrl}`);

  // 2. Share with owner
  if (OWNER_EMAIL) {
    await drive.permissions.create({
      fileId: ssId,
      requestBody: {
        type: 'user',
        role: 'writer',
        emailAddress: OWNER_EMAIL,
      },
      transferOwnership: false,
    });
    console.log(`Shared with: ${OWNER_EMAIL}`);
  }

  // 3. Build batch update requests
  const requests = [];

  // Headers for each tab
  for (const [tabName, headers] of Object.entries(HEADERS)) {
    const tabIdx = TABS.findIndex(t => t.name === tabName);
    if (tabIdx === -1) continue;

    requests.push({
      updateCells: {
        range: {
          sheetId: tabIdx,
          startRowIndex: 0, endRowIndex: 1,
          startColumnIndex: 0, endColumnIndex: headers.length,
        },
        rows: [{
          values: headers.map(h => ({
            userEnteredValue: { stringValue: h },
            userEnteredFormat: {
              textFormat: { bold: true },
              backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
            },
          })),
        }],
        fields: 'userEnteredValue,userEnteredFormat',
      },
    });
  }

  // Settings data
  const settingsData = [
    ['Company ID', COMPANY_ID],
    ['Company Name', COMPANY_NAME],
    ['Cloud Function URL', FUNCTION_URL],
    ['', ''],
    ['FY Start', '2025-01-01'],
    ['FY End', '2025-12-31'],
    ['Cost Center', ''],
    ['Profit Center', ''],
  ];
  const settingsIdx = TABS.findIndex(t => t.name === 'Settings');
  requests.push({
    updateCells: {
      range: {
        sheetId: settingsIdx,
        startRowIndex: 1, endRowIndex: 1 + settingsData.length,
        startColumnIndex: 0, endColumnIndex: 2,
      },
      rows: settingsData.map(([k, v]) => ({
        values: [
          { userEnteredValue: { stringValue: k }, userEnteredFormat: { textFormat: { bold: !!k } } },
          { userEnteredValue: { stringValue: v } },
        ],
      })),
      fields: 'userEnteredValue,userEnteredFormat',
    },
  });

  // Dashboard placeholder
  const dashIdx = TABS.findIndex(t => t.name === 'Dashboard');
  const dashData = [
    ['Revenue', '0'], ['Expenses', '0'], ['Net Income', '0'], ['', ''],
    ['Total Assets', '0'], ['Total Liabilities', '0'], ['Total Equity', '0'],
    ['Balanced', '-'], ['', ''],
    ['Journal Entries', '0'], ['First Entry', '-'], ['Last Entry', '-'],
  ];
  requests.push({
    updateCells: {
      range: {
        sheetId: dashIdx,
        startRowIndex: 1, endRowIndex: 1 + dashData.length,
        startColumnIndex: 0, endColumnIndex: 2,
      },
      rows: dashData.map(([k, v]) => ({
        values: [
          { userEnteredValue: { stringValue: k }, userEnteredFormat: { textFormat: { bold: !!k } } },
          { userEnteredValue: { stringValue: v } },
        ],
      })),
      fields: 'userEnteredValue,userEnteredFormat',
    },
  });

  // Auto-resize columns
  for (let i = 0; i < TABS.length; i++) {
    requests.push({
      autoResizeDimensions: {
        dimensions: { sheetId: i, dimension: 'COLUMNS', startIndex: 0, endIndex: 15 },
      },
    });
  }

  // Execute batch
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId,
    requestBody: { requests },
  });

  console.log('Headers and formatting applied.');
  console.log('');
  console.log('=== SETUP COMPLETE ===');
  console.log(`Spreadsheet: ${ssUrl}`);
  console.log(`Company: ${COMPANY_NAME} (${COMPANY_ID})`);
  console.log(`Function URL: ${FUNCTION_URL}`);
  console.log('');
  console.log('Next steps:');
  console.log('1. Open the spreadsheet');
  console.log('2. Go to Extensions → Apps Script');
  console.log('3. Delete any existing code, create 3 files: relay.gs, config.gs, ui.gs');
  console.log('4. Paste the contents from the skuld/sheets/ directory');
  console.log('5. In Apps Script: Project Settings → Script Properties → add:');
  console.log(`   SKULD_FUNCTION_URL = ${FUNCTION_URL}`);
  console.log(`   GCP_PROJECT_ID = skuld-491310`);
  console.log(`   COMPANY_ID = ${COMPANY_ID}`);
  console.log('6. Reload the spreadsheet — the ⚖️ Skuld menu will appear');
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
