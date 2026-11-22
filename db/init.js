#!/usr/bin/env node
/**
 * freeBooks — DB initializer / migrator (CLI)
 *
 * Creates the database if it doesn't exist, then applies any pending
 * migrations plus views and macros (db/migrate.js). The server does the same
 * on every boot, so running this is only needed to prepare a database
 * without starting the server. Safe to run repeatedly.
 *
 * Run with the server stopped: DuckDB holds an exclusive file lock.
 *
 * Usage:
 *   node db/init.js
 *   FREEBOOKS_DB_PATH=/path/to/freebooks.duckdb node db/init.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { DuckDBInstance } = require(path.resolve(__dirname, '../api/node_modules/@duckdb/node-api'));
const { migrate } = require('./migrate');

const DB_PATH  = process.env.FREEBOOKS_DB_PATH || process.env.DB_PATH || path.join(process.env.HOME || '/root', '.freebooks', 'freebooks.duckdb');
const WAL_PATH = DB_PATH + '.wal';

async function openWithWalRecovery() {
  try {
    return await DuckDBInstance.create(DB_PATH);
  } catch (err) {
    if (fs.existsSync(WAL_PATH)) {
      console.warn('⚠ DuckDB WAL replay failed — removing stale WAL and retrying.');
      fs.unlinkSync(WAL_PATH);
      return await DuckDBInstance.create(DB_PATH);
    }
    throw err;
  }
}

(async () => {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  console.log(`Opening DuckDB at: ${DB_PATH}`);
  const instance = await openWithWalRecovery();
  const conn = await instance.connect();
  try {
    const r = await migrate(conn, { dbPath: DB_PATH, log: m => console.log(m), warn: m => console.warn(m) });
    console.log(`Database schema at version ${r.version}.`);
    await conn.run('CHECKPOINT');
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
})().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
