'use strict';
// Versioned migrations (#307): fresh databases, pre-migration databases and
// numbered migrations all end at the same schema, failures roll back, and a
// backup is taken before an existing database is changed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DuckDBInstance } = require('@duckdb/node-api');
const { migrate, loadStatements, listMigrations } = require('../../db/migrate');
const LATEST = Math.max(1, ...listMigrations(path.resolve(__dirname, '../../db/migrations')).map(m => m.version));

const REPO = path.resolve(__dirname, '../..');
const quiet = { log: () => {}, warn: () => {} };

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fb-mig-')); }

async function open(file) {
  const instance = await DuckDBInstance.create(file);
  const conn = await instance.connect();
  const all = async (sql) => (await conn.runAndReadAll(sql)).getRowObjects();
  const close = () => { conn.closeSync(); instance.closeSync(); };
  return { conn, all, close };
}

// Replays a schema file the way pre-migration boot did: every statement,
// failures ignored.
async function replayTolerant(conn, file) {
  for (const s of loadStatements(file)) { try { await conn.run(s); } catch { /* expected on some */ } }
}

async function snapshot(all, { columnOrder = true } = {}) {
  const cols = await all(`SELECT table_name, column_index, column_name, data_type, column_default, is_nullable
    FROM duckdb_columns() WHERE schema_name = 'main' AND NOT internal ORDER BY table_name, column_index`);
  const columns = cols.map(c => `${c.table_name}.${c.column_name} ${c.data_type} default=${c.column_default} null=${c.is_nullable}` + (columnOrder ? ` @${c.column_index}` : ''));
  if (!columnOrder) columns.sort();
  const indexes = (await all(`SELECT sql FROM duckdb_indexes() WHERE schema_name = 'main' ORDER BY index_name`)).map(r => r.sql);
  const constraints = (await all(`SELECT table_name, constraint_type, constraint_text FROM duckdb_constraints()
    WHERE schema_name = 'main' ORDER BY ALL`)).map(r => `${r.table_name} ${r.constraint_type} ${r.constraint_text}`);
  const views = (await all(`SELECT view_name FROM duckdb_views() WHERE NOT internal ORDER BY view_name`)).map(r => r.view_name);
  const macros = (await all(`SELECT DISTINCT function_name FROM duckdb_functions() WHERE NOT internal AND function_type IN ('macro', 'table_macro') ORDER BY ALL`)).map(r => r.function_name);
  const sequences = (await all(`SELECT sequence_name FROM duckdb_sequences() ORDER BY ALL`)).map(r => r.sequence_name);
  return { columns, indexes, constraints, views, macros, sequences };
}

async function freshSnapshot(dir, opts) {
  const db = await open(path.join(dir, 'fresh.duckdb'));
  try {
    const r = await migrate(db.conn, quiet);
    assert.equal(r.version, LATEST);
    return await snapshot(db.all, opts);
  } finally { db.close(); }
}

test('fresh database: baseline, migrations, views and macros; no backup', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a.duckdb');
  const db = await open(file);
  try {
    const r = await migrate(db.conn, { ...quiet, dbPath: file });
    assert.equal(r.version, LATEST);
    assert.deepEqual(r.backups, []);
    const s = await snapshot(db.all);
    assert.ok(s.columns.length > 300, 'baseline created the tables');
    assert.ok(s.views.includes('v_companies_latest'));
    assert.ok(s.macros.length > 10, 'macros loaded');
    // Re-running is a no-op.
    const again = await migrate(db.conn, { ...quiet, dbPath: file });
    assert.deepEqual(again.applied, []);
    assert.deepEqual(again.backups, []);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pre-migration database at the last legacy schema upgrades to exactly the baseline, data intact', async () => {
  const dir = tmpDir();
  try {
    const expected = await freshSnapshot(dir);
    const file = path.join(dir, 'legacy.duckdb');
    const db = await open(file);
    try {
      await replayTolerant(db.conn, path.join(REPO, 'db/legacy/pre-baseline.sql'));
      await db.conn.run(`INSERT INTO companies (company_id, company_name, jurisdiction, currency, reporting_standard, fy_start, fy_end)
        VALUES ('old_co', 'Old Co', 'SE', 'SEK', 'K2', '2026-01-01', '2026-12-31')`);
      await db.conn.run(`INSERT INTO journal_entries (company_id, entry_id, batch_id, date, account_code, debit, credit, currency, debit_home, credit_home, reference, source)
        VALUES ('old_co', 'e1', 'b1', '2026-03-01', '1930', 100, 0, 'SEK', 100, 0, 'MISC/2026/00001', 'manual')`);
      const r = await migrate(db.conn, { ...quiet, dbPath: file });
      assert.equal(r.version, LATEST);
      assert.equal(r.backups.length, 1, 'backup taken before touching an existing database');
      assert.ok(fs.existsSync(r.backups[0]));
      const s = await snapshot(db.all);
      s.columns = s.columns.filter(c => !c.startsWith('schema_migrations.'));
      expected.columns = expected.columns.filter(c => !c.startsWith('schema_migrations.'));
      assert.deepEqual(s, expected);

      const je = await db.all(`SELECT debit, journal_id FROM journal_entries`);
      assert.equal(je.length, 1);
      assert.equal(Number(je[0].debit), 100);
      assert.equal(je[0].journal_id, 'old_co_misc', 'legacy backfills ran (default journals, then journal_id)');
    } finally { db.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('numbered migrations: applied in order once; a failure rolls back and stops', async () => {
  const dir = tmpDir();
  const migDir = path.join(dir, 'migrations');
  fs.mkdirSync(migDir);
  const file = path.join(dir, 'm.duckdb');
  const db = await open(file);
  try {
    await migrate(db.conn, { ...quiet, dbPath: file, migrationsDir: migDir });

    fs.writeFileSync(path.join(migDir, '002_add_widgets.sql'),
      "-- comment; with a semicolon\nCREATE TABLE widgets (id INTEGER);\nINSERT INTO widgets VALUES (1);");
    fs.writeFileSync(path.join(migDir, '003_js_step.js'),
      "exports.up = async ({ run }) => { await run('INSERT INTO widgets VALUES (2)'); };");
    const r = await migrate(db.conn, { ...quiet, dbPath: file, migrationsDir: migDir });
    assert.deepEqual(r.applied, [2, 3]);
    assert.equal(r.version, 3);
    assert.equal(r.backups.length, 1);
    assert.equal((await db.all('SELECT count(*) AS n FROM widgets'))[0].n, 2n);

    fs.writeFileSync(path.join(migDir, '004_broken.sql'),
      "INSERT INTO widgets VALUES (3);\nSELECT * FROM no_such_table;");
    await assert.rejects(migrate(db.conn, { ...quiet, dbPath: file, migrationsDir: migDir }), /004_broken\.sql failed and was rolled back/);
    assert.equal((await db.all('SELECT count(*) AS n FROM widgets'))[0].n, 2n, 'partial migration rolled back');
    assert.equal((await db.all('SELECT max(version) AS v FROM schema_migrations'))[0].v, 3);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refuses a database newer than the code, and bad migration file names', async () => {
  const dir = tmpDir();
  const migDir = path.join(dir, 'migrations');
  fs.mkdirSync(migDir);
  const db = await open(':memory:');
  try {
    await migrate(db.conn, { ...quiet, migrationsDir: migDir });
    await db.conn.run("INSERT INTO schema_migrations (version, name) VALUES (99, 'future')");
    await assert.rejects(migrate(db.conn, { ...quiet, migrationsDir: migDir }), /version 99/);

    fs.writeFileSync(path.join(migDir, '001_clash.sql'), 'SELECT 1;');
    await assert.rejects(migrate(db.conn, { ...quiet, migrationsDir: migDir }), /reserved for the baseline/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
