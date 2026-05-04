'use strict';
const path = require('path');
const fs = require('fs');
const { DuckDBInstance } = require('@duckdb/node-api');

const DB_PATH = process.env.DB_PATH || path.join(require('os').homedir(), '.freebooks', 'freebooks.duckdb');
const WAL_PATH = DB_PATH + '.wal';

let _instance = null;
let _conn = null;
let _dbReady = null;

async function _openWithWalRecovery() {
  try {
    _instance = await DuckDBInstance.create(DB_PATH);
  } catch (err) {
    if (fs.existsSync(WAL_PATH)) {
      console.warn('⚠ DuckDB WAL replay failed — removing stale WAL and retrying.');
      fs.unlinkSync(WAL_PATH);
      _instance = await DuckDBInstance.create(DB_PATH);
    } else {
      throw err;
    }
  }
  _conn = await _instance.connect();
  return _conn;
}

function ensureDb() {
  if (_dbReady) return _dbReady;
  _dbReady = _openWithWalRecovery();
  return _dbReady;
}

function getDb() {
  // Returns connection synchronously — only safe after ensureDb() has resolved.
  // Kept for backward compat. Prefer ensureDb() at startup.
  if (!_conn) throw new Error('DB not yet initialised — call ensureDb() first');
  return _conn;
}

/**
 * Replace @paramName tokens with positional $1, $2... and return ordered values array.
 */
function bindParams(sql, params = {}) {
  const values = [];
  const finalSql = sql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
    if (!(name in params)) throw new Error(`Missing query parameter: ${name}`);
    values.push(params[name]);
    return `$${values.length}`;
  });
  return { sql: finalSql, values };
}

async function query(sql, params = {}) {
  const conn = await ensureDb();
  const { sql: finalSql, values } = bindParams(sql, params);
  const result = await conn.runAndReadAll(finalSql, values);
  return result.getRowObjects();
}

async function exec(sql, params = {}) {
  const conn = await ensureDb();
  const { sql: finalSql, values } = bindParams(sql, params);
  await conn.run(finalSql, values);
}

async function bulkInsert(table, rows) {
  if (!rows || rows.length === 0) return;
  const conn = await ensureDb();
  const keys = Object.keys(rows[0]);
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;

  await conn.run('BEGIN');
  try {
    const stmt = await conn.prepare(sql);
    for (const row of rows) {
      const values = keys.map(k => row[k] ?? null);
      await stmt.run(values);
    }
    stmt.destroy();
    await conn.run('COMMIT');
  } catch (err) {
    try {
      await conn.run('ROLLBACK');
    } catch {}
    throw err;
  }
}

/**
 * Handle positional ? params and convert to $1, $2... for internal use.
 */
async function queryPositional(sql, params = []) {
  const conn = await ensureDb();
  // Replace ? with $1, $2, $3...
  let i = 0;
  const finalSql = sql.replace(/\?/g, () => `$${++i}`);
  const result = await conn.runAndReadAll(finalSql, params);
  return result.getRowObjects();
}

module.exports = { getDb, ensureDb, query, exec, bulkInsert, queryPositional };
