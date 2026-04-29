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

// Split SQL file into individual statements (skip blank lines and comments)
function loadStatements(file) {
  return fs.readFileSync(file, 'utf8')
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));
}

const raw = fs.readFileSync(SCHEMA_FILE, 'utf8');
const statements = [
  ...loadStatements(SCHEMA_FILE),
  ...loadStatements(MACROS_FILE),
];

console.log(`Opening DuckDB at: ${DB_PATH}`);
const db = new Database(DB_PATH);
const con = db.connect();

function runNext(i) {
  if (i >= statements.length) {
    console.log(`Schema applied (${statements.length} statements).`);
    con.close();
    db.close(() => process.exit(0));
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
