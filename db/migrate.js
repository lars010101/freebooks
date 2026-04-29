#!/usr/bin/env node
/**
 * freeBooks — DuckDB migration script
 *
 * Runs db/schema.sql against a local DuckDB file.
 * Default DB path: ../data/freebooks.duckdb
 *
 * Usage:
 *   node db/migrate.js
 *   DB_PATH=/path/to/freebooks.duckdb node db/migrate.js
 */

'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('duckdb').Database;

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'freebooks.duckdb');
const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');

console.log(`Opening DuckDB at: ${DB_PATH}`);
const db = new Database(DB_PATH);

db.exec(schema, (err) => {
  if (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
  console.log('Migration complete — all tables created (or already exist).');

  db.close((closeErr) => {
    if (closeErr) {
      console.error('Error closing DB:', closeErr.message);
      process.exit(1);
    }
    process.exit(0);
  });
});
