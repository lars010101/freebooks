#!/usr/bin/env node
/**
 * freeBooks — CSV import script
 *
 * Imports COA.csv, JOURNAL.csv, MAPPING.csv into DuckDB.
 * Handles multiple companies from the same CSV files.
 *
 * Usage:
 *   node db/import.js <data-dir> [db-path]
 *
 * Example:
 *   node db/import.js ~/data_export
 *   node db/import.js ~/data ~/.freebooks/freebooks.duckdb
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const Database = require(path.resolve(__dirname, '../api/node_modules/duckdb')).Database;

const dataDir = process.argv[2];
if (!dataDir) {
  console.error('Usage: node db/import.js <data-dir> [db-path]');
  process.exit(1);
}

const DB_PATH = process.argv[3] || path.join(os.homedir(), '.freebooks', 'freebooks.duckdb');

// Company name → company config
const COMPANIES = {
  ExampleSG: {
    company_id:         'example_sg',
    company_name:       'Example Company SG',
    jurisdiction:       'SG',
    currency:           'SGD',
    reporting_standard: 'SFRS',
    tax_id:             '201703022E',
    fy_start:           '2024-02-01',
    fy_end:             '2026-01-31',
  },
  'Example Company SE': {
    company_id:         'example_se',
    company_name:       'Example Company SE',
    jurisdiction:       'SE',
    currency:           'SEK',
    reporting_standard: 'K2',
    tax_id:             null,
    fy_start:           '2025-01-01',
    fy_end:             '2025-12-31',
  },
};

// ── CSV parser ────────────────────────────────────────────────────────────────
function parseCSV(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split('\n').filter(l => l.trim());
  const headers = splitCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = splitCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => obj[h.trim()] = (vals[i] || '').trim());
    return obj;
  });
}

function splitCSVLine(line) {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuote = !inQuote; }
    else if (c === ',' && !inQuote) { result.push(cur); cur = ''; }
    else { cur += c; }
  }
  result.push(cur);
  return result;
}

// ── Promisify ─────────────────────────────────────────────────────────────────
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, ...params, err => err ? reject(err) : resolve()));
}
function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.all(sql, ...params, (err, rows) => err ? reject(err) : resolve(rows)));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nConnecting to ${DB_PATH}...`);
  const db = new Database(DB_PATH);
  const now = new Date().toISOString();

  const typeToBS = { Asset: 'Current Assets', Liability: 'Current Liabilities', Equity: 'Equity' };

  const coaRows     = parseCSV(path.join(dataDir, 'COA.csv'));
  const journalRows = parseCSV(path.join(dataDir, 'JOURNAL.csv'));
  const mappingRows = parseCSV(path.join(dataDir, 'MAPPING.csv')).filter(r => r['Keyword'] && r['Account']);

  for (const [csvName, cfg] of Object.entries(COMPANIES)) {
    const { company_id } = cfg;
    console.log(`\n── ${cfg.company_name} (${company_id}) ──`);

    // 1. Company
    await dbRun(db, `DELETE FROM companies WHERE company_id = ?`, [company_id]);
    await dbRun(db, `
      INSERT INTO companies (company_id, company_name, jurisdiction, currency,
        reporting_standard, accounting_method, vat_registered, tax_id,
        fy_start, fy_end, created_at)
      VALUES (?, ?, ?, ?, ?, 'accrual', false, ?, ?, ?, ?)
    `, [company_id, cfg.company_name, cfg.jurisdiction, cfg.currency,
        cfg.reporting_standard, cfg.tax_id, cfg.fy_start, cfg.fy_end, now]);

    // 2. COA
    await dbRun(db, `DELETE FROM accounts WHERE company_id = ?`, [company_id]);
    const compCoa = coaRows.filter(r => r['Company'] === csvName);
    for (const row of compCoa) {
      const type = row['Type'] || '';
      await dbRun(db, `
        INSERT INTO accounts (company_id, account_code, account_name, account_type,
          account_subtype, pl_category, bs_category, cf_category, is_active,
          effective_from, effective_to, created_at)
        VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, true, '2015-01-01', NULL, ?)
      `, [company_id, row['Code'], row['Name'], type,
          typeToBS[type] || null, row['CF Category'] || null, now]);
    }
    console.log(`  COA:          ${compCoa.length} accounts`);

    // 3. Bank mappings (ExampleSG only — MDAB uses different mapping format)
    await dbRun(db, `DELETE FROM bank_mappings WHERE company_id = ?`, [company_id]);
    if (csvName === ExampleSG) {
      for (const row of mappingRows) {
        const accountCode = (row['Account'] || '').split(' ')[0];
        const mappingId   = `map-${Math.random().toString(36).slice(2)}`;
        await dbRun(db, `
          INSERT INTO bank_mappings (company_id, mapping_id, pattern, match_type,
            debit_account, credit_account, description_override, vat_code)
          VALUES (?, ?, ?, 'contains', ?, ?, ?, NULL)
        `, [company_id, mappingId, row['Keyword'].toUpperCase(),
            accountCode, accountCode, row['Label'] || null]);
      }
      console.log(`  Bank mappings: ${mappingRows.length}`);
    }

    // 4. Journal entries
    await dbRun(db, `DELETE FROM journal_entries WHERE company_id = ?`, [company_id]);
    const compJournal = journalRows.filter(r => r['Company'] === csvName && r['Date'] && r['Record ID']);
    for (const row of compJournal) {
      const accountCode = (row['Account'] || '').split(' ')[0];
      const debit       = parseFloat(row['Debit'])    || 0;
      const credit      = parseFloat(row['Credit'])   || 0;
      const fxRate      = parseFloat(row['Ccy Rate']) || 1;
      const entryId     = `je-${Math.random().toString(36).slice(2)}`;
      await dbRun(db, `
        INSERT INTO journal_entries (
          company_id, entry_id, batch_id, date, account_code,
          debit, credit, currency, fx_rate, debit_home, credit_home,
          vat_code, vat_amount, vat_amount_home, net_amount, net_amount_home,
          description, reference, source, cost_center, profit_center,
          reverses, reversed_by, bill_id, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, 0, 0, ?, ?, 'csv_import',
          NULL, NULL, NULL, NULL, NULL, 'import', ?)
      `, [company_id, entryId, row['Record ID'], row['Date'], accountCode,
          debit, credit, row['Ccy'] || cfg.currency, fxRate,
          Math.round(debit  * fxRate * 10000) / 10000,
          Math.round(credit * fxRate * 10000) / 10000,
          row['Label'] || null, row['Reference'] || null, now]);
    }
    console.log(`  Journal lines: ${compJournal.length}`);

    // 5. Verify
    const [bal] = await dbAll(db, `
      SELECT ROUND(SUM(debit) - SUM(credit), 4) as imbalance
      FROM journal_entries WHERE company_id = ?`, [company_id]);
    console.log(`  Imbalance:     ${bal.imbalance} (should be 0)`);
  }

  await new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
  console.log('\nImport complete ✓');
}

main().catch(err => { console.error('Import failed:', err.message); process.exit(1); });
