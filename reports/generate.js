#!/usr/bin/env node
/**
 * freeBooks — HTML & CSV Report Generator (CLI)
 *
 * Calls render.js functions and writes to stdout or --out file.
 *
 * Usage:
 *   node reports/generate.js [options]
 *
 * Options:
 *   --company   company_id              (default: example_sg)
 *   --start     YYYY-MM-DD
 *   --end       YYYY-MM-DD
 *   --period    FY2026                  (alternative to --start/--end)
 *   --report    pl|bs|tb|gl|journal|cf|sce|integrity|all   (default: all)
 *   --format    html|csv|both           (default: both)
 *   --out       output directory or file path
 *   --step      month|year              (generates comparative multi-period)
 *   --db        DuckDB file path        (default: ~/.freebooks/freebooks.duckdb)
 */

'use strict';

const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const Database = require(path.resolve(__dirname, '../api/node_modules/duckdb')).Database;
const { renderReport, renderComparative, generatePeriods } = require('./render');

// ── Args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
}

const COMPANY  = arg('company', 'example_sg');
const PERIOD   = arg('period',  null);
const REPORT   = arg('report',  'all');
const FORMAT   = arg('format',  'both');
const OUT      = arg('out',     null);   // stdout if null (for single reports)
const STEP     = arg('step',    null);
const DB_PATH  = arg('db',      path.join(os.homedir(), '.freebooks', 'freebooks.duckdb'));

// ── DB helpers ────────────────────────────────────────────────────────────────
function makeQuery(con) {
  return function query(sql, params = []) {
    return new Promise((resolve, reject) =>
      con.all(sql, ...params, (err, rows) => err ? reject(err) : resolve(rows || [])));
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const db  = new Database(DB_PATH, { access_mode: 'READ_ONLY' });
  const con = db.connect();
  const query = makeQuery(con);

  // Verify company
  const [co] = await query(`SELECT company_name FROM companies WHERE company_id = ?`, [COMPANY]);
  if (!co) { console.error(`Company '${COMPANY}' not found.`); process.exit(1); }

  // Resolve period/date range
  let START, END, periodLabel;
  if (PERIOD) {
    const [p] = await query(
      `SELECT start_date, end_date, period_name FROM periods WHERE company_id = ? AND period_name = ?`,
      [COMPANY, PERIOD]
    );
    if (!p) { console.error(`Period '${PERIOD}' not found for '${COMPANY}'.`); process.exit(1); }
    START = new Date(p.start_date).toISOString().slice(0, 10);
    END   = new Date(p.end_date).toISOString().slice(0, 10);
    periodLabel = p.period_name;
  } else if (arg('start', null) && arg('end', null)) {
    START = arg('start', null);
    END   = arg('end',   null);
    periodLabel = `${START} to ${END}`;
  } else {
    // Default: latest period
    const [p] = await query(
      `SELECT start_date, end_date, period_name FROM periods WHERE company_id = ? ORDER BY end_date DESC LIMIT 1`,
      [COMPANY]
    );
    if (!p) { console.error(`No periods found for '${COMPANY}'. Use --period or --start/--end.`); process.exit(1); }
    START = new Date(p.start_date).toISOString().slice(0, 10);
    END   = new Date(p.end_date).toISOString().slice(0, 10);
    periodLabel = p.period_name;
  }

  const reports = REPORT === 'all'
    ? ['pl', 'bs', 'tb', 'gl', 'journal', 'cf', 'sce', 'integrity']
    : [REPORT];

  for (const rep of reports) {
    console.error(`Generating ${rep.toUpperCase()}...`);

    let result;
    if (STEP === 'month' || STEP === 'year') {
      const periods = generatePeriods(START, END, STEP);
      result = await renderComparative(query, COMPANY, rep, periods);
    } else {
      result = await renderReport(query, COMPANY, rep, START, END);
    }

    if (!OUT) {
      // Single report mode — write to stdout (HTML by default, CSV if requested)
      if (FORMAT === 'csv') {
        process.stdout.write(result.csv);
      } else {
        process.stdout.write(result.html);
      }
    } else {
      // OUT is a directory (multi-report) or file path (single)
      const isDir = !path.extname(OUT) || reports.length > 1;
      if (isDir) {
        fs.mkdirSync(OUT, { recursive: true });
        if (FORMAT === 'html' || FORMAT === 'both') {
          const p = path.join(OUT, result.filename + '.html');
          fs.writeFileSync(p, result.html);
          console.error(`  → ${p}`);
        }
        if (FORMAT === 'csv' || FORMAT === 'both') {
          const p = path.join(OUT, result.filename + '.csv');
          fs.writeFileSync(p, result.csv);
          console.error(`  → ${p}`);
        }
      } else {
        // Treat OUT as a file path
        const ext = path.extname(OUT).toLowerCase();
        const content = ext === '.csv' ? result.csv : result.html;
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, content);
        console.error(`  → ${OUT}`);
      }
    }
  }

  con.close();
  await new Promise(r => db.close(r));
  if (OUT) console.error('\nDone ✓');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
