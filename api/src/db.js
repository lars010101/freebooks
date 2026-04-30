'use strict';
/**
 * freeBooks — DuckDB connection singleton
 *
 * Wraps the duckdb callback API in promise helpers.
 * One database connection shared across the process lifetime.
 */

const path = require('path');
const Database = require('duckdb').Database;

const DB_PATH = process.env.DB_PATH || path.join(require('os').homedir(), '.freebooks', 'freebooks.duckdb');

let _db = null;

function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
  }
  return _db;
}

/**
 * Run a query and return all rows.
 * Supports named parameters via { named: true, params: {...} }.
 *
 * DuckDB node doesn't support named params natively — we substitute
 * @paramName → ? and pass values in key order.
 *
 * @param {string} sql
 * @param {object} [params] - { paramName: value, ... }
 * @returns {Promise<object[]>}
 */
function query(sql, params = {}) {
  return new Promise((resolve, reject) => {
    const { sql: finalSql, values } = bindParams(sql, params);
    const conn = getDb().connect();
    conn.all(finalSql, ...values, (err, rows) => {
      conn.close();
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

/**
 * Execute a statement (INSERT / UPDATE / DELETE / DDL).
 * Returns nothing meaningful.
 */
function exec(sql, params = {}) {
  return new Promise((resolve, reject) => {
    const { sql: finalSql, values } = bindParams(sql, params);
    const conn = getDb().connect();
    conn.run(finalSql, ...values, (err) => {
      conn.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Bulk insert rows into a table.
 * Uses a prepared statement for efficiency.
 *
 * @param {string} table
 * @param {object[]} rows
 */
async function bulkInsert(table, rows) {
  if (!rows || rows.length === 0) return;

  const keys = Object.keys(rows[0]);
  const placeholders = keys.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;

  const db = getDb();
  const conn = db.connect();

  await new Promise((resolve, reject) => {
    conn.run('BEGIN', (err) => { if (err) reject(err); else resolve(); });
  });

  try {
    const stmt = conn.prepare(sql);

    for (const row of rows) {
      const values = keys.map((k) => row[k] ?? null);
      await new Promise((resolve, reject) => {
        stmt.run(...values, (err) => { if (err) reject(err); else resolve(); });
      });
    }

    stmt.finalize();

    await new Promise((resolve, reject) => {
      conn.run('COMMIT', (err) => { if (err) reject(err); else resolve(); });
    });
  } catch (err) {
    await new Promise((resolve) => {
      conn.run('ROLLBACK', () => resolve());
    });
    throw err;
  } finally {
    conn.close();
  }
}

/**
 * Replace @paramName tokens with positional ? and return ordered values.
 */
function bindParams(sql, params) {
  const values = [];
  const finalSql = sql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
    if (!(name in params)) throw new Error(`Missing query parameter: ${name}`);
    values.push(params[name]);
    return '?';
  });
  return { sql: finalSql, values };
}

module.exports = { getDb, query, exec, bulkInsert };
