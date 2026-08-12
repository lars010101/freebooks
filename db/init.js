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

const DB_PATH     = process.env.FREEBOOKS_DB_PATH || process.env.DB_PATH || path.join(process.env.HOME || '/root', '.freebooks', 'freebooks.duckdb');
const SCHEMA_FILE  = path.join(__dirname, 'schema.sql');
const MACROS_FILE  = path.join(__dirname, 'macros.sql');

const WAL_PATH    = DB_PATH + '.wal';

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Split a SQL file into individual statements on semicolons.
// Full-line `--` comments are stripped BEFORE splitting so a semicolon inside
// a comment (e.g. "-- ...(default 0.50); ...") cannot fracture a statement.
function loadStatements(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
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

    // ── P0-1: unique-constraint backstop for pre-existing DBs ──────────────
    // Fresh DBs get UNIQUE(...) inline from schema.sql. For DBs created before
    // P0-1, try ALTER TABLE ... ADD CONSTRAINT; current DuckDB does not support
    // that ALTER option, so fall back to CREATE UNIQUE INDEX (same enforcement).
    // Duplicates → loud warning + skip. Any failure → warn + skip. NEVER throws:
    // init must not crash on an existing DB.
    async function applyUniqueConstraints() {
      const targets = [
        { table: 'bills',           column: 'bill_id',  constraint: 'uq_bills_bill_id',           index: 'ux_bills_bill_id' },
        { table: 'journal_entries', column: 'entry_id', constraint: 'uq_journal_entries_entry_id', index: 'ux_journal_entries_entry_id' },
      ];
      for (const t of targets) {
        try {
          // (a) pre-check for duplicates
          const dupeResult = await conn.runAndReadAll(
            `SELECT ${t.column} AS dup_val, COUNT(*) AS cnt FROM ${t.table}
             GROUP BY ${t.column} HAVING COUNT(*) > 1 LIMIT 5`, []);
          const dupeRows = dupeResult.getRowObjects();
          if (dupeRows.length > 0) {
            console.warn(`\n⚠⚠ SKIPPING unique constraint on ${t.table}.${t.column}: duplicate values exist (e.g. '${dupeRows[0].dup_val}' x${dupeRows[0].cnt}). Clean up duplicates and re-run init.`);
            continue;
          }
          // Skip quietly if a unique constraint already exists (fresh DBs from schema.sql)
          const existing = await conn.runAndReadAll(
            `SELECT constraint_name FROM duckdb_constraints()
             WHERE table_name = '${t.table}' AND constraint_type = 'UNIQUE'
               AND constraint_text ILIKE '%${t.column}%'`, []);
          if (existing.getRowObjects().length > 0) continue;
          // (c) ALTER is unsupported on current DuckDB — expect fallback
          try {
            await conn.run(`ALTER TABLE ${t.table} ADD CONSTRAINT ${t.constraint} UNIQUE (${t.column})`, []);
            console.log(`Unique constraint added on ${t.table}.${t.column}.`);
          } catch (alterErr) {
            console.warn(`\nALTER TABLE ADD CONSTRAINT not supported for ${t.table}.${t.column} (${String(alterErr.message).split('\n')[0]}) — using CREATE UNIQUE INDEX fallback.`);
            await conn.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${t.index} ON ${t.table}(${t.column})`, []);
            console.log(`Unique index ${t.index} ensured on ${t.table}.${t.column}.`);
          }
        } catch (err) {
          console.warn(`\n⚠ Unique-constraint migration skipped for ${t.table}.${t.column}: ${err.message}`);
        }
      }
    }

    // ── Partner-proposal-spec §7.1: vendors → partners migration ───────────
    // Renames the vendors table to partners + vendor_id → partner_id, then adds
    // is_vendor/is_customer/default_revenue_account/default_ar_account columns
    // and updates indexes. Follows the applyUniqueConstraints() precedent:
    // guarded (pre-checks if already migrated), feature-detects RENAME support
    // with try/catch + CREATE+DROP fallback, never calls process.exit(1).
    async function applyPartnersMigration() {
      // Check whether vendors table still exists (pre-migration state)
      let vendorExists;
      try {
        vendorExists = await conn.runAndReadAll(
          `SELECT table_name FROM duckdb_tables() WHERE table_name = 'vendors'`, []);
      } catch (e) {
        console.warn(`\n⚠ Partners migration: duckdb_tables() check failed: ${e.message}`);
        return;
      }
      if (vendorExists.getRowObjects().length === 0) return; // already migrated

      // Check whether partners table already exists (partial migration?)
      let partnerExists;
      try {
        partnerExists = await conn.runAndReadAll(
          `SELECT table_name FROM duckdb_tables() WHERE table_name = 'partners'`, []);
      } catch (e) {
        console.warn(`\n⚠ Partners migration: partners table check failed: ${e.message}`);
        return;
      }
      if (partnerExists.getRowObjects().length > 0) {
        // partners exists but vendors still exists — drop vendors (data already migrated)
        try {
          await conn.run('DROP TABLE vendors', []);
          console.log('Partners migration: dropped stale vendors table (partners already exists).');
        } catch (e) {
          console.warn(`\n⚠ Partners migration: could not drop vendors table: ${e.message}`);
        }
        return;
      }

      // Attempt RENAME TABLE + RENAME COLUMN
      try {
        await conn.run('ALTER TABLE vendors RENAME TO partners', []);
        try {
          await conn.run('ALTER TABLE partners RENAME COLUMN vendor_id TO partner_id', []);
        } catch (colErr) {
          console.warn(`RENAME COLUMN unsupported (${String(colErr.message).split('\n')[0]}) — partner_id rename skipped, column stays vendor_id`);
        }
        console.log('Vendors table renamed to partners.');
      } catch (renameErr) {
        // RENAME TABLE unsupported — fallback: CREATE TABLE + DROP TABLE
        console.warn(`RENAME TABLE unsupported (${String(renameErr.message).split('\n')[0]}) — using CREATE+DROP fallback.`);
        try {
          await conn.run(
            `CREATE TABLE partners AS SELECT
              vendor_id AS partner_id, company_id, name, default_currency,
              payment_terms_days, tax_id, notes, is_active, created_at,
              default_expense_account, default_ap_account
             FROM vendors`, []);
          await conn.run('DROP TABLE vendors', []);
          console.log('Partners table created from vendors (CREATE+DROP fallback).');
        } catch (fallbackErr) {
          console.warn(`\n⚠⚠ Partners migration CREATE+DROP fallback failed: ${fallbackErr.message}. Manual migration required.`);
          return;
        }
      }

      // Add partner-type flags + AR-side columns (after rename, so table exists)
      const addColumns = [
        'ALTER TABLE partners ADD COLUMN IF NOT EXISTS is_vendor BOOLEAN DEFAULT TRUE',
        'ALTER TABLE partners ADD COLUMN IF NOT EXISTS is_customer BOOLEAN DEFAULT FALSE',
        'ALTER TABLE partners ADD COLUMN IF NOT EXISTS default_revenue_account VARCHAR',
        'ALTER TABLE partners ADD COLUMN IF NOT EXISTS default_ar_account VARCHAR',
      ];
      for (const sql of addColumns) {
        try { await conn.run(sql, []); }
        catch (e) { console.warn(`Partners migration: ${sql.slice(0, 60)} failed: ${e.message}`); }
      }

      // Update indexes (old indexes reference vendors table name)
      const indexOps = [
        'DROP INDEX IF EXISTS idx_vendors_company',
        'DROP INDEX IF EXISTS idx_vendors_name',
        'CREATE INDEX IF NOT EXISTS idx_partners_company ON partners(company_id)',
        'CREATE INDEX IF NOT EXISTS idx_partners_name ON partners(name)',
        'CREATE INDEX IF NOT EXISTS idx_partners_vendor ON partners(company_id, is_vendor)',
        'CREATE INDEX IF NOT EXISTS idx_partners_customer ON partners(company_id, is_customer)',
      ];
      for (const sql of indexOps) {
        try { await conn.run(sql, []); }
        catch (e) { console.warn(`Partners migration: ${sql.slice(0, 60)} failed: ${e.message}`); }
      }
    }

    async function runNext(i) {
      if (i >= statements.length) {
        console.log(`\nSchema applied (${statements.length} statements).`);
        await seedJournals();
        console.log('Default journals seeded.');
        await applyUniqueConstraints();
        // Force WAL flush before close
        await conn.run('CHECKPOINT', []);
        conn.closeSync();
        instance.closeSync();
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

    // Run the partners migration BEFORE schema.sql statements — an existing
    // DB has a `vendors` table that must be renamed to `partners` (preserving
    // data) before `CREATE TABLE IF NOT EXISTS partners` in schema.sql runs.
    // On a fresh DB, applyPartnersMigration() finds no `vendors` table and
    // no-ops.  This prevents the data-loss race where schema.sql creates an
    // empty `partners` table first, causing the migration to DROP the real
    // `vendors` data.
    await applyPartnersMigration();

    // ── Issue #128: bills.vendor → bills.partner_name column rename ─────────
    // The partners migration renamed the vendors table to partners but left
    // bills.vendor (a denormalized name string, not a FK) as-is. Rename it
    // here with try/catch — DuckDB errors if already renamed (idempotent).
    async function applyBillsVendorRename() {
      // On a fresh DB, the bills table doesn't exist yet (CREATE TABLE runs
      // later in runNext). On an already-migrated DB, the column is already
      // partner_name. Both are expected — only warn on truly unexpected errors.
      try {
        await conn.run('ALTER TABLE bills RENAME COLUMN vendor TO partner_name', []);
      } catch (e) {
        var msg = String(e.message);
        if (/does not exist|not found/i.test(msg)) {
          // Fresh DB (table doesn't exist yet) or already renamed — expected.
        } else {
          console.warn(`\n⚠ bills.vendor rename skipped: ${msg}`);
        }
      }
    }
    await applyBillsVendorRename();


    await runNext(0);
  } // end runSchema
}
