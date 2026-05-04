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
const { DuckDBInstance } = require(path.resolve(__dirname, '../api/node_modules/@duckdb/node-api'));

const DB_PATH     = process.env.DB_PATH || path.join(process.env.HOME || '/root', '.freebooks', 'freebooks.duckdb');
const SCHEMA_FILE  = path.join(__dirname, 'schema.sql');
const MACROS_FILE  = path.join(__dirname, 'macros.sql');

const WAL_PATH    = DB_PATH + '.wal';

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Split a SQL file into individual statements on semicolons
function loadStatements(file) {
  return fs.readFileSync(file, 'utf8')
    .split(';')
    .map(s => s.trim())
    .filter(s => {
      if (!s.length) return false;
      // Strip comment lines — check if any actual SQL remains
      const sql = s.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim();
      return sql.length > 0;
    });
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

// ── Via-server mode: POST statements to admin endpoint ──────────────────────
const API_URL = process.env.API_URL || process.argv.includes('--via-server') ? 'http://localhost:3000' : null;

if (API_URL) {
  const http = require('http');
  console.log(`Applying ${statements.length} statements via server at ${API_URL} ...`);
  function postNext(i) {
    if (i >= statements.length) { console.log('Done.'); return; }
    const body = JSON.stringify({ sql: statements[i] });
    const req = http.request(`${API_URL}/api/admin/query`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          const r = JSON.parse(d);
          if (r.error) console.warn(`  stmt ${i+1} warn: ${r.error}`);
          else process.stdout.write('.');
          postNext(i + 1);
        });
      });
    req.on('error', e => { console.error('Request error:', e.message); process.exit(1); });
    req.write(body); req.end();
  }
  postNext(0);
} else {
  // ── Direct DB mode ──────────────────────────────────────────────────────────
  console.log(`Opening DuckDB at: ${DB_PATH}`);

  async function openWithWalRecovery() {
    try {
      return await DuckDBInstance.create(DB_PATH);
    } catch (err) {
      if (fs.existsSync(WAL_PATH)) {
        console.warn(`⚠ DuckDB WAL replay failed — removing stale WAL and retrying.`);
        fs.unlinkSync(WAL_PATH);
        return await DuckDBInstance.create(DB_PATH);
      }
      throw err;
    }
  }

  openWithWalRecovery().then(runSchema).catch(err => {
    console.error('Fatal: could not open database:', err.message);
    process.exit(1);
  });

  async function runSchema(instance) {
    const conn = await instance.connect();

    const DEFAULT_JOURNALS = [
      { code: 'MISC', name: 'Miscellaneous' },
      { code: 'BANK', name: 'Bank' },
      { code: 'ADJ',  name: 'Adjustment' },
    ];

    async function seedJournals() {
      try {
        const companies = await conn.runAndReadAll('SELECT company_id FROM companies', []);
        const companyRows = companies.getRowObjects();
        if (!companyRows || companyRows.length === 0) return;

        for (const company of companyRows) {
          for (const j of DEFAULT_JOURNALS) {
            const journalId = `${company.company_id}_${j.code.toLowerCase()}`;
            const sql = `INSERT INTO journals (journal_id, company_id, code, name, active)
              VALUES ($1, $2, $3, $4, true)
              ON CONFLICT DO NOTHING`;
            try {
              await conn.run(sql, [journalId, company.company_id, j.code, j.name]);
            } catch (e) {
              if (!e.message.includes('already exists')) {
                console.warn(`Journal seed warning (${company.company_id}/${j.code}): ${e.message}`);
              }
            }
          }
        }
      } catch (err) {
        console.warn(`Seed journals warning: ${err.message}`);
      }
    }

    async function runNext(i) {
      if (i >= statements.length) {
        console.log(`\nSchema applied (${statements.length} statements).`);
        await seedJournals();
        console.log('Default journals seeded.');
        // Force WAL flush before close
        await conn.run('CHECKPOINT', []);
        await instance.close();
        process.exit(0);
        return;
      }
      try {
        await conn.run(statements[i], []);
        process.stdout.write('.');
        await runNext(i + 1);
      } catch (err) {
        console.error(`Failed on statement ${i + 1}:\n${statements[i].slice(0, 120)}\nError: ${err.message}`);
        process.exit(1);
      }
    }

    await runNext(0);
  } // end runSchema
}
