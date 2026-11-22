'use strict';
/**
 * freeBooks — schema migrations.
 *
 * One entry point, migrate(conn), shared by server boot (api/src/db.js) and
 * the CLI (db/init.js). Steps, in order:
 *
 *   1. Ensure the schema_migrations table exists.
 *   2. Bring the database to the baseline (version 1):
 *      - fresh database (no `companies` table): apply db/schema.sql;
 *      - pre-migration database (has tables but no recorded version): replay
 *        the frozen db/legacy/pre-baseline.sql the way boot used to
 *        (statement by statement, failures tolerated), plus the one-off
 *        backfills db/init.js used to run.
 *   3. Apply every db/migrations/NNN_name.{sql,js} with NNN above the
 *      recorded version, in order, each in its own transaction. A failure
 *      rolls that migration back and throws, so the server refuses to start
 *      rather than run against a half-migrated schema.
 *   4. Re-apply db/views.sql and db/macros.sql (CREATE OR REPLACE, every
 *      boot). A failure throws.
 *
 * Before step 2 on a pre-migration database, and before step 3 whenever a
 * migration is pending on an existing database, the database file is copied
 * to `<db>.bak-<timestamp>-v<from>` next to it.
 *
 * Writing a migration: add db/migrations/NNN_short_name.sql (statements
 * separated by `;`, full-line `--` comments allowed) or NNN_short_name.js
 * exporting `async function up({ run, all })`. NNN is the next free number
 * (002 onwards; 001 is the baseline). Never edit or renumber a migration that
 * has been merged. db/schema.sql is frozen at version 1: fresh databases run
 * every migration too, so there is one upgrade path and nothing to keep in
 * sync. Write migrations that are safe on a fresh database (check before
 * altering), as 002 does.
 */

const fs = require('fs');
const path = require('path');

const DB_DIR = __dirname;
const BASELINE_VERSION = 1;

function loadStatements(file) {
  // Full-line `--` comments are stripped BEFORE splitting so a semicolon
  // inside a comment cannot fracture a statement.
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function loadMacroBlocks(file) {
  // Macros contain semicolons inside AS TABLE bodies — split on macro boundaries.
  return fs.readFileSync(file, 'utf8')
    .split(/(?=CREATE OR REPLACE MACRO)/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--') && s.startsWith('CREATE'));
}

function listMigrations(dir) {
  if (!fs.existsSync(dir)) return [];
  const seen = new Map();
  const out = [];
  for (const file of fs.readdirSync(dir).sort()) {
    const m = file.match(/^(\d+)_([a-z0-9_]+)\.(sql|js)$/i);
    if (!m) {
      if (file.endsWith('.sql') || file.endsWith('.js')) {
        throw new Error(`Migration file name must be NNN_name.sql or NNN_name.js: ${file}`);
      }
      continue;
    }
    const version = parseInt(m[1], 10);
    if (version <= BASELINE_VERSION) throw new Error(`Migration ${file}: version ${version} is reserved for the baseline; start at 002`);
    if (seen.has(version)) throw new Error(`Duplicate migration version ${version}: ${seen.get(version)} and ${file}`);
    seen.set(version, file);
    out.push({ version, name: m[2], file: path.join(dir, file), kind: m[3].toLowerCase() });
  }
  return out.sort((a, b) => a.version - b.version);
}

function firstLine(err) { return String(err && err.message || err).split('\n')[0]; }

async function migrate(conn, opts = {}) {
  const log = opts.log || (() => {});
  const warn = opts.warn || log;
  const dbPath = opts.dbPath || null;
  const migrationsDir = opts.migrationsDir || path.join(DB_DIR, 'migrations');

  const run = (sql, params) => (params ? conn.run(sql, params) : conn.run(sql));
  const all = async (sql, params) => (await (params ? conn.runAndReadAll(sql, params) : conn.runAndReadAll(sql))).getRowObjects();

  async function inTransaction(fn) {
    await run('BEGIN TRANSACTION');
    try { await fn(); await run('COMMIT'); }
    catch (e) { try { await run('ROLLBACK'); } catch { /* already aborted */ } throw e; }
  }

  async function backup(fromVersion) {
    if (!dbPath || dbPath === ':memory:' || !fs.existsSync(dbPath)) return null;
    await run('CHECKPOINT');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    const target = `${dbPath}.bak-${stamp}-v${fromVersion}`;
    fs.copyFileSync(dbPath, target);
    log(`Backed up database to ${target}`);
    return target;
  }

  const migrations = listMigrations(migrationsDir);
  const latest = migrations.length ? migrations[migrations.length - 1].version : BASELINE_VERSION;

  // ── 1. Version table ──────────────────────────────────────────────────────
  await run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name VARCHAR NOT NULL,
    applied_at TIMESTAMP NOT NULL DEFAULT now()
  )`);
  const recorded = await all('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations');
  let current = Number(recorded[0].v);
  if (current > latest) {
    throw new Error(`Database schema is at version ${current}, but this code only knows up to ${latest}. Run a newer freeBooks, or restore a backup.`);
  }

  // ── 2. Baseline ───────────────────────────────────────────────────────────
  const backups = [];
  let createdFresh = false;
  if (current < BASELINE_VERSION) {
    const hasCompanies = (await all(
      "SELECT 1 FROM duckdb_tables() WHERE schema_name = 'main' AND table_name = 'companies'"
    )).length > 0;
    if (!hasCompanies) {
      await inTransaction(async () => {
        for (const s of loadStatements(path.join(DB_DIR, 'schema.sql'))) await run(s);
        await run('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [BASELINE_VERSION, 'baseline']);
      });
      createdFresh = true;
      log('Created fresh database at baseline (version 1).');
    } else {
      const b = await backup(0);
      if (b) backups.push(b);
      await legacyCatchUp({ run, all, log, warn });
      await run('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [BASELINE_VERSION, 'baseline (legacy catch-up)']);
      log('Brought pre-migration database to baseline (version 1).');
    }
    current = BASELINE_VERSION;
  }

  // ── 3. Numbered migrations ────────────────────────────────────────────────
  const pending = migrations.filter(m => m.version > current);
  if (pending.length > 0 && backups.length === 0 && !createdFresh) {
    const b = await backup(current);
    if (b) backups.push(b);
  }
  for (const m of pending) {
    try {
      await inTransaction(async () => {
        if (m.kind === 'sql') {
          for (const s of loadStatements(m.file)) await run(s);
        } else {
          const mod = require(m.file);
          if (typeof mod.up !== 'function') throw new Error('JS migration must export async function up({ run, all })');
          await mod.up({ run, all });
        }
        await run('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
      });
    } catch (e) {
      throw new Error(`Migration ${path.basename(m.file)} failed and was rolled back: ${firstLine(e)}`
        + (backups.length ? ` (backup: ${backups[backups.length - 1]})` : ''));
    }
    log(`Applied migration ${path.basename(m.file)}.`);
    current = m.version;
  }

  // ── 4. Views and macros (repeatable) ──────────────────────────────────────
  const repeatable = [
    ...loadStatements(path.join(DB_DIR, 'views.sql')),
    ...loadMacroBlocks(path.join(DB_DIR, 'macros.sql')),
  ];
  try {
    await inTransaction(async () => { for (const s of repeatable) await run(s); });
  } catch (e) {
    throw new Error(`Applying views/macros failed: ${firstLine(e)}`);
  }

  return { version: current, applied: pending.map(m => m.version), backups };
}

// ── Pre-migration databases ─────────────────────────────────────────────────
// Reproduces what boot + db/init.js did before versioned migrations existed:
// replay the old schema file (idempotent statements; failures are expected on
// some databases and skipped), then the one-off backfills init.js ran. Frozen:
// never edit db/legacy/pre-baseline.sql or this function to change the schema.
async function legacyCatchUp({ run, all, log, warn }) {
  // Default journals for companies created before journals existed. Seeded
  // before the replay too, so its journal_id backfill (UPDATE journal_entries
  // ... FROM journals) finds them in this one pass; old boot only got there
  // on the second start.
  async function seedDefaultJournals(silent) {
    try {
      const companies = await all('SELECT DISTINCT company_id FROM companies');
      for (const c of companies) {
        for (const j of [{ code: 'MISC', name: 'Miscellaneous' }, { code: 'BANK', name: 'Bank' }, { code: 'ADJ', name: 'Adjustment' }]) {
          await run(`INSERT INTO journals (journal_id, company_id, code, name, active) VALUES ($1, $2, $3, $4, true) ON CONFLICT DO NOTHING`,
            [`${c.company_id}_${j.code.toLowerCase()}`, c.company_id, j.code, j.name]);
        }
      }
    } catch (e) {
      if (!silent) warn(`⚠ Default-journal backfill skipped: ${firstLine(e)}`);
    }
  }
  await seedDefaultJournals(true);

  let skipped = 0;
  const stmts = loadStatements(path.join(DB_DIR, 'legacy', 'pre-baseline.sql'));
  for (const s of stmts) {
    try { await run(s); }
    catch (e) { skipped++; warn(`  legacy statement skipped: ${firstLine(e)} — ${s.slice(0, 90).replace(/\s+/g, ' ')}`); }
  }
  log(`Legacy schema replayed: ${stmts.length - skipped} applied, ${skipped} skipped.`);

  // Unique-constraint backstop for databases created before inline UNIQUE
  // (P0-1). Duplicates → warn and skip; never throws.
  const targets = [
    { table: 'bills',           column: 'bill_id',  index: 'ux_bills_bill_id' },
    { table: 'journal_entries', column: 'entry_id', index: 'ux_journal_entries_entry_id' },
  ];
  for (const t of targets) {
    try {
      const dupes = await all(`SELECT ${t.column} AS v, COUNT(*) AS n FROM ${t.table} GROUP BY ${t.column} HAVING COUNT(*) > 1 LIMIT 1`);
      if (dupes.length > 0) { warn(`⚠ No unique index on ${t.table}.${t.column}: duplicate values exist (e.g. '${dupes[0].v}').`); continue; }
      const existing = await all(`SELECT 1 FROM duckdb_constraints() WHERE table_name = '${t.table}' AND constraint_type = 'UNIQUE' AND constraint_text ILIKE '%${t.column}%'`);
      if (existing.length > 0) continue;
      await run(`CREATE UNIQUE INDEX IF NOT EXISTS ${t.index} ON ${t.table}(${t.column})`);
    } catch (e) {
      warn(`⚠ Unique index on ${t.table}.${t.column} skipped: ${firstLine(e)}`);
    }
  }

  await seedDefaultJournals(false);
}

module.exports = { migrate, listMigrations, loadStatements, BASELINE_VERSION };
