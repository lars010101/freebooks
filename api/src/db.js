'use strict';
const path = require('path');
const fs = require('fs');
const { DuckDBInstance } = require('@duckdb/node-api');

const DB_PATH = process.env.FREEBOOKS_DB_PATH || process.env.DB_PATH || path.join(require('os').homedir(), '.freebooks', 'freebooks.duckdb');
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
  // Versioned migrations (db/migrate.js). A failed migration throws, so boot
  // stops instead of serving a half-migrated schema.
  const { migrate } = require('../../db/migrate');
  const r = await migrate(_conn, { dbPath: DB_PATH, log: m => console.log(m), warn: m => console.warn(m) });
  console.log(`Database schema at version ${r.version}.`);
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
/**
 * Normalize values for JSON serialization: convert Date/BigInt to primitives.
 */
function normalizeValue(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'bigint') return Number(val);
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    const iso = val.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (typeof val === 'object') {
    // @duckdb/node-api returns DuckDB-specific typed objects (DuckDBDateValue etc.)
    // Try .toJSON() — many DuckDB types implement this
    if (typeof val.toJSON === 'function') {
      try {
        const j = val.toJSON();
        if (j instanceof Date) {
          if (isNaN(j.getTime())) return null;
          const iso = j.toISOString();
          return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
        }
        if (j !== null && typeof j !== 'object') return j;
      } catch {}
    }
    // Try valueOf() — some DuckDB types return epoch millis
    const prim = val.valueOf();
    if (prim !== val) {
      if (typeof prim === 'bigint') return Number(prim);
      if (typeof prim === 'number' && !isNaN(prim)) {
        const d = new Date(prim);
        if (!isNaN(d.getTime())) {
          const iso = d.toISOString();
          return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
        }
        return prim;
      }
      if (typeof prim === 'string' && prim !== '[object Object]') return prim;
    }
    // toString as last resort
    const str = String(val);
    return str === '[object Object]' ? null : str;
  }
  return val;
}

/**
 * Normalize all rows: apply normalizeValue to each field.
 */
function normalizeRows(rows) {
  return rows.map(row => {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[k] = normalizeValue(v);
    return out;
  });
}

/**
 * Convert @paramName → $paramName (named) and return {paramName: value} object.
 * @duckdb/node-api uses named binding only — positional $1/$2 not supported.
 */
function bindParams(sql, params = {}) {
  const namedParams = {};
  const finalSql = sql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
    if (!(name in params)) throw new Error(`Missing query parameter: ${name}`);
    namedParams[name] = params[name];
    return `$${name}`;
  });
  return { sql: finalSql, params: namedParams };
}

async function query(sql, params = {}) {
  const conn = await ensureDb();
  const { sql: finalSql, params: namedParams } = bindParams(sql, params);
  const hasParams = Object.keys(namedParams).length > 0;
  const result = hasParams
    ? await conn.runAndReadAll(finalSql, namedParams)
    : await conn.runAndReadAll(finalSql);
  return normalizeRows(result.getRowObjects());
}

async function exec(sql, params = {}) {
  const conn = await ensureDb();
  const { sql: finalSql, params: namedParams } = bindParams(sql, params);
  const hasParams = Object.keys(namedParams).length > 0;
  if (hasParams) {
    await conn.run(finalSql, namedParams);
  } else {
    await conn.run(finalSql);
  }
}

async function bulkInsert(table, rows) {
  if (!rows || rows.length === 0) return;
  const conn = await ensureDb();
  await bulkInsertOn(conn, table, rows);
}

/**
 * Transaction-scoped helpers: identical logic to query/exec/bulkInsert but
 * operate on a passed connection object (a dedicated DuckDB connection
 * opened by withTransaction) instead of the shared _conn. This keeps a
 * transaction's reads/writes on its own connection so BEGIN/COMMIT/ROLLBACK
 * actually scope the work (the shared _conn is unaffected).
 */
async function queryOn(conn, sql, params = {}) {
  const { sql: finalSql, params: namedParams } = bindParams(sql, params);
  const hasParams = Object.keys(namedParams).length > 0;
  const result = hasParams
    ? await conn.runAndReadAll(finalSql, namedParams)
    : await conn.runAndReadAll(finalSql);
  return normalizeRows(result.getRowObjects());
}

async function execOn(conn, sql, params = {}) {
  const { sql: finalSql, params: namedParams } = bindParams(sql, params);
  const hasParams = Object.keys(namedParams).length > 0;
  if (hasParams) {
    await conn.run(finalSql, namedParams);
  } else {
    await conn.run(finalSql);
  }
}

async function bulkInsertOn(conn, table, rows) {
  if (!rows || rows.length === 0) return;
  const keys = Object.keys(rows[0]);
  const columnList = keys.map(k => `"${k}"`).join(', ');

  // Build one INSERT with all rows as named params — single round-trip
  const allParams = {};
  const valueClauses = rows.map((row, rowIdx) => {
    const placeholders = keys.map(k => {
      const paramName = `${k}_r${rowIdx}`;
      allParams[paramName] = row[k] ?? null;
      return `$${paramName}`;
    });
    return `(${placeholders.join(', ')})`;
  });

  const sql = `INSERT INTO "${table}" (${columnList}) VALUES ${valueClauses.join(', ')}`;
  await conn.run(sql, allParams);
}

/**
 * Return the DuckDBInstance. Throws if the DB has not been initialised
 * (ensureDb() must have resolved first). withTransaction uses this to open
 * a dedicated connection separate from the shared _conn.
 */
function getInstance() {
  if (!_instance) throw new Error('DB not yet initialised — call ensureDb() first');
  return _instance;
}

/**
 * Run fn inside a single DuckDB transaction on a DEDICATED connection.
 * Opens a fresh connection via _instance.connect(), runs BEGIN, passes scoped
 * query/exec/bulkInsert helpers (bound to that connection) to fn, COMMITs on
 * success, ROLLBACKs on error, and closes the connection in finally.
 *
 * The scoped helpers use the dedicated connection exclusively, so all reads
 * and writes inside fn see the transaction's uncommitted state and are
 * atomically committed or rolled back together. The shared _conn is untouched.
 */
async function withTransaction(fn) {
  const instance = getInstance();
  const conn = await instance.connect();
  await conn.run('BEGIN');
  try {
    const result = await fn({
      query:  (sql, params) => queryOn(conn, sql, params),
      exec:   (sql, params) => execOn(conn, sql, params),
      bulkInsert: (table, rows) => bulkInsertOn(conn, table, rows),
    });
    await conn.run('COMMIT');
    return result;
  } catch (err) {
    await conn.run('ROLLBACK');
    throw err;
  } finally {
    try { conn.closeSync(); } catch (e) { /* best effort */ }
  }
}

/**
 * Positional params: handles both ? (sequential) and $N (1-based reusable) style.
 * Values are internal/trusted — inlined as SQL literals to avoid binding issues.
 */
async function queryPositional(sql, params = []) {
  const conn = await ensureDb();
  let seqIdx = 0;
  const inlineVal = (val) => {
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    return `'${String(val).replace(/'/g, "''")}'`;
  };
  const finalSql = sql.replace(/\?(::(?:[A-Za-z]+))?|\$(\d+)(::(?:[A-Za-z]+))?/g, (match, cast1, num, cast2) => {
    const val = num ? params[parseInt(num, 10) - 1] : params[seqIdx++];
    const cast = cast1 || cast2 || '';
    return inlineVal(val) + cast;
  });
  const result = await conn.runAndReadAll(finalSql);
  return normalizeRows(result.getRowObjects());
}

module.exports = { getDb, ensureDb, query, exec, bulkInsert, queryPositional, withTransaction, getInstance };
