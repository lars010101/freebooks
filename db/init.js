#!/usr/bin/env node
/**
 * freeBooks — DB initializer
 * Runs db/schema.sql against the local DuckDB file.
 * Safe to run multiple times — tables use IF NOT EXISTS, views use OR REPLACE.
 *
 * Usage:
 *   node db/init.js
 *   DB_PATH=/path/to/freebooks.duckdb node db/init.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const Database = require(path.resolve(__dirname, '../api/node_modules/duckdb')).Database;

const DB_PATH     = process.env.DB_PATH || path.join(process.env.HOME || '/root', '.freebooks', 'freebooks.duckdb');
const SCHEMA_FILE  = path.join(__dirname, 'schema.sql');
const MACROS_FILE  = path.join(__dirname, 'macros.sql');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Split a SQL file into individual statements on semicolons
function loadStatements(file) {
  return fs.readFileSync(file, 'utf8')
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));
}

// Macros contain semicolons inside AS TABLE bodies — run the whole file as one exec
function loadMacroBlocks(file) {
  const text = fs.readFileSync(file, 'utf8');
  // Split on CREATE OR REPLACE MACRO boundaries
  return text
    .split(/(?=CREATE OR REPLACE MACRO)/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--') && s.startsWith('CREATE'));
}

const statements = [
  ...loadStatements(SCHEMA_FILE),
  ...loadMacroBlocks(MACROS_FILE),
];

console.log(`Opening DuckDB at: ${DB_PATH}`);
const db = new Database(DB_PATH);
const con = db.connect();

const DEFAULT_JOURNALS = [
  { code: 'MISC', name: 'Miscellaneous' },
  { code: 'BANK', name: 'Bank' },
  { code: 'ADJ',  name: 'Adjustment' },
];

function seedJournals(callback) {
  con.all(`SELECT company_id FROM companies`, (err, companies) => {
    if (err || !companies || companies.length === 0) { callback(); return; }
    let pending = 0;
    for (const company of companies) {
      for (const j of DEFAULT_JOURNALS) {
        const journalId = `${company.company_id}_${j.code.toLowerCase()}`;
        pending++;
        const sql = `INSERT INTO journals (journal_id, company_id, code, name, active)
          VALUES ('${journalId}', '${company.company_id}', '${j.code}', '${j.name}', true)
          ON CONFLICT DO NOTHING`;
        con.exec(sql, (e) => {
          if (e) console.warn(`Journal seed warning (${company.company_id}/${j.code}): ${e.message}`);
          pending--;
          if (pending === 0) callback();
        });
      }
    }
    if (pending === 0) callback();
  });
}

function runNext(i) {
  if (i >= statements.length) {
    console.log(`Schema applied (${statements.length} statements).`);
    seedJournals(() => {
      console.log('Default journals seeded.');
      con.close();
      db.close(() => process.exit(0));
    });
    return;
  }
  con.exec(statements[i] + ';', (err) => {
    if (err) {
      console.error(`Failed on statement ${i + 1}:\n${statements[i].slice(0, 120)}\nError: ${err.message}`);
      process.exit(1);
    }
    runNext(i + 1);
  });
}

runNext(0);
