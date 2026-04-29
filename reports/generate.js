#!/usr/bin/env node
/**
 * freeBooks — HTML & CSV Report Generator
 *
 * Queries DuckDB macros and produces print-ready HTML + CSV files.
 *
 * Usage:
 *   node /opt/freebooks/reports/generate.js [options]
 *
 * Options:
 *   --company   company_id        (default: example_sg)
 *   --start     YYYY-MM-DD        (default: company fy_start)
 *   --end       YYYY-MM-DD        (default: company fy_end)
 *   --report    pl|bs|tb|gl|all   (default: all)
 *   --out       output directory  (default: ~/freebooks-reports)
 *   --db        DuckDB file path  (default: ~/.freebooks/freebooks.duckdb)
 */

'use strict';

const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const Database = require(path.resolve(__dirname, '../api/node_modules/duckdb')).Database;

// ── Args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
}

const COMPANY  = arg('company', 'example_sg');
const PERIOD   = arg('period',  null);  // e.g. FY2026
const REPORT   = arg('report',  'all');
const OUT_DIR  = arg('out',     path.join(os.homedir(), 'freebooks-reports'));
const DB_PATH  = arg('db',      path.join(os.homedir(), '.freebooks', 'freebooks.duckdb'));

fs.mkdirSync(OUT_DIR, { recursive: true });

// ── DB helpers ────────────────────────────────────────────────────────────────
function dbAll(con, sql, params = []) {
  return new Promise((resolve, reject) =>
    con.all(sql, ...params, (err, rows) => err ? reject(err) : resolve(rows)));
}

// ── Number formatting ─────────────────────────────────────────────────────────
function fmt(n) {
  if (n === null || n === undefined) return '';
  const num = parseFloat(n);
  if (isNaN(num)) return '';
  const abs = Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return num < 0 ? `(${abs})` : abs;
}

// ── HTML template ─────────────────────────────────────────────────────────────
function html(title, company, period, tableHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 11pt; color: #1a1a1a; background: #fff; }
  .page { max-width: 900px; margin: 0 auto; padding: 32px 40px; }
  .header { border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; margin-bottom: 24px; }
  .company { font-size: 16pt; font-weight: 700; }
  .report-title { font-size: 13pt; color: #444; margin-top: 4px; }
  .period { font-size: 10pt; color: #666; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { text-align: left; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.05em;
       color: #555; border-bottom: 1px solid #ccc; padding: 6px 8px; }
  th.num { text-align: right; }
  td { padding: 5px 8px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.account td { }
  tr.subtotal td { font-weight: 600; border-top: 1px solid #aaa; border-bottom: 2px solid #aaa;
                   background: #f8f8f8; }
  tr.type_total td { font-weight: 700; background: #efefef; }
  tr.total td { font-weight: 700; font-size: 11pt; border-top: 2px solid #1a1a1a;
                border-bottom: 3px double #1a1a1a; background: #f0f0f0; }
  tr.section-header td { font-weight: 700; font-size: 10pt; text-transform: uppercase;
                          letter-spacing: 0.05em; color: #444; padding-top: 16px; border-bottom: none;
                          background: none; }
  tr.zero td.num { color: #bbb; }
  .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #ddd;
            font-size: 9pt; color: #888; }
  @media print {
    body { font-size: 10pt; }
    .page { padding: 0; max-width: 100%; }
    @page { margin: 20mm; size: A4; }
  }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="company">${company}</div>
    <div class="report-title">${title}</div>
    <div class="period">${period}</div>
  </div>
  ${tableHtml}
  <div class="footer">Generated: ${new Date().toISOString().slice(0, 10)} · freeBooks</div>
</div>
</body>
</html>`;
}

// ── CSV writer ────────────────────────────────────────────────────────────────
function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = v => v === null || v === undefined ? '' : String(v).includes(',') ? `"${v}"` : String(v);
  return [headers.join(','), ...rows.map(r => headers.map(h => escape(r[h])).join(','))].join('\n');
}

// ── P&L ──────────────────────────────────────────────────────────────────────
async function genPL(con, company, start, end, companyName) {
  const rows = await dbAll(con, `SELECT * FROM pl(?, ?, ?)`, [company, start, end]);

  let lastSection = null;
  let tableRows = '';
  for (const r of rows) {
    if (r.row_type === 'account' && r.section !== lastSection) {
      tableRows += `<tr class="section-header"><td colspan="3">${r.section}</td></tr>`;
      lastSection = r.section;
    }
    const cls = r.row_type + (r.amount == 0 && r.row_type === 'account' ? ' zero' : '');
    const code = r.account_code || '';
    const name = r.row_type === 'total' ? `<strong>${r.account_name}</strong>` : r.account_name;
    tableRows += `<tr class="${cls}"><td>${code}</td><td>${name}</td><td class="num">${fmt(r.amount)}</td></tr>`;
  }

  const tableHtml = `<table>
    <thead><tr><th>Code</th><th>Description</th><th class="num">Amount</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>`;

  return { tableHtml, rows };
}

// ── BS ───────────────────────────────────────────────────────────────────────
async function genBS(con, company, end, companyName) {
  const rows = await dbAll(con, `SELECT * FROM bs(?, ?)`, [company, end]);

  let lastType = null;
  let tableRows = '';
  for (const r of rows) {
    if (r.row_type === 'type_total') continue; // show at bottom instead
    if (r.account_type !== lastType) {
      tableRows += `<tr class="section-header"><td colspan="3">${r.account_type}</td></tr>`;
      lastType = r.account_type;
    }
    const cls = r.row_type + (r.balance == 0 && r.row_type === 'account' ? ' zero' : '');
    const code = r.account_code || '';
    const name = r.row_type === 'subtotal' ? `<em>${r.account_name}</em>` : r.account_name;
    tableRows += `<tr class="${cls}"><td>${code}</td><td>${name}</td><td class="num">${fmt(r.balance)}</td></tr>`;
  }
  // Type totals
  const typeTotals = rows.filter(r => r.row_type === 'type_total');
  for (const r of typeTotals) {
    tableRows += `<tr class="type_total"><td></td><td>${r.account_name}</td><td class="num">${fmt(r.balance)}</td></tr>`;
  }

  const tableHtml = `<table>
    <thead><tr><th>Code</th><th>Description</th><th class="num">Balance</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>`;

  return { tableHtml, rows };
}

// ── TB ───────────────────────────────────────────────────────────────────────
async function genTB(con, company, start, end) {
  const rows = await dbAll(con, `SELECT * FROM tb(?, ?, ?)`, [company, start, end]);

  let tableRows = rows.map(r => `<tr class="account">
    <td>${r.account_code}</td><td>${r.account_name}</td><td>${r.account_type}</td>
    <td class="num">${fmt(r.total_debit)}</td>
    <td class="num">${fmt(r.total_credit)}</td>
    <td class="num">${fmt(r.net_balance)}</td>
  </tr>`).join('');

  // Totals row
  const totDr  = rows.reduce((s, r) => s + parseFloat(r.total_debit  || 0), 0);
  const totCr  = rows.reduce((s, r) => s + parseFloat(r.total_credit || 0), 0);
  const totNet = rows.reduce((s, r) => s + parseFloat(r.net_balance  || 0), 0);
  tableRows += `<tr class="total"><td></td><td><strong>TOTAL</strong></td><td></td>
    <td class="num">${fmt(totDr)}</td><td class="num">${fmt(totCr)}</td><td class="num">${fmt(totNet)}</td>
  </tr>`;

  const tableHtml = `<table>
    <thead><tr><th>Code</th><th>Account</th><th>Type</th>
      <th class="num">Debit</th><th class="num">Credit</th><th class="num">Net</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>`;

  return { tableHtml, rows };
}

// ── Journal ──────────────────────────────────────────────────────────────────
async function genJournal(con, company, start, end) {
  const rows = await dbAll(con, `SELECT * FROM journal(?, ?, ?)`, [company, start, end]);

  let lastBatch = null;
  let batchDebit = 0, batchCredit = 0;
  let tableRows = '';

  const flush = () => {
    if (lastBatch !== null) {
      tableRows += `<tr class="subtotal"><td></td><td></td><td></td><td class="num">${fmt(batchDebit)}</td><td class="num">${fmt(batchCredit)}</td></tr>
      <tr><td colspan="5" style="padding:4px 0"></td></tr>`;
      batchDebit = 0; batchCredit = 0;
    }
  };

  for (const r of rows) {
    if (r.batch_id !== lastBatch) {
      flush();
      const dateStr = new Date(r.date).toISOString().slice(0, 10);
      tableRows += `<tr class="section-header"><td>${dateStr}</td><td colspan="4">${r.batch_id}${r.description ? ' — ' + r.description : ''}</td></tr>`;
      lastBatch = r.batch_id;
    }
    batchDebit  += parseFloat(r.debit  || 0);
    batchCredit += parseFloat(r.credit || 0);
    tableRows += `<tr class="account">
      <td></td><td>${r.account_code}</td><td>${r.account_name || ''}</td>
      <td class="num">${fmt(r.debit)}</td><td class="num">${fmt(r.credit)}</td>
    </tr>`;
  }
  flush();

  const tableHtml = `<table>
    <thead><tr><th>Date / Ref</th><th>Code</th><th>Account</th>
      <th class="num">Debit</th><th class="num">Credit</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>`;

  return { tableHtml, rows };
}

// ── GL ───────────────────────────────────────────────────────────────────────
async function genGL(con, company, start, end) {
  const rows = await dbAll(con, `SELECT * FROM gl(?, ?, ?)`, [company, start, end]);

  let lastAcct = null;
  let runBal = 0;
  let tableRows = '';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.account_code !== lastAcct) {
      // Closing balance for previous account
      if (lastAcct !== null) {
        tableRows += `<tr class="subtotal"><td></td><td></td><td>Closing Balance</td><td class="num"></td><td class="num"></td><td class="num">${fmt(runBal)}</td></tr>
        <tr><td colspan="6" style="padding:8px 0"></td></tr>`;
      }
      runBal = 0;
      tableRows += `<tr class="section-header"><td colspan="6">${r.account_code} — ${r.account_name || ''}</td></tr>`;
      lastAcct = r.account_code;
    }
    runBal += parseFloat(r.debit || 0) - parseFloat(r.credit || 0);
    const dateStr = new Date(r.date).toISOString().slice(0, 10);
    tableRows += `<tr class="account">
      <td>${dateStr}</td><td>${r.batch_id}</td><td>${r.description || ''}</td>
      <td class="num">${fmt(r.debit)}</td><td class="num">${fmt(r.credit)}</td>
      <td class="num">${fmt(runBal)}</td>
    </tr>`;
  }
  // Closing balance for last account
  if (lastAcct !== null) {
    tableRows += `<tr class="subtotal"><td></td><td></td><td>Closing Balance</td><td class="num"></td><td class="num"></td><td class="num">${fmt(runBal)}</td></tr>`;
  }

  const tableHtml = `<table>
    <thead><tr><th>Date</th><th>Ref</th><th>Description</th>
      <th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>`;

  return { tableHtml, rows };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const db  = new Database(DB_PATH, { access_mode: 'READ_ONLY' });
  const con = db.connect();

  // Get company info
  const [co] = await dbAll(con, `SELECT company_name FROM companies WHERE company_id = ?`, [COMPANY]);
  if (!co) { console.error(`Company '${COMPANY}' not found.`); process.exit(1); }

  // Resolve period: --period FY2026, or --start/--end, or latest unlocked period
  let START, END, periodLabel;
  if (PERIOD) {
    const [p] = await dbAll(con, `SELECT start_date, end_date, period_name FROM periods WHERE company_id = ? AND period_name = ?`, [COMPANY, PERIOD]);
    if (!p) { console.error(`Period '${PERIOD}' not found for '${COMPANY}'.`); process.exit(1); }
    START = new Date(p.start_date).toISOString().slice(0, 10);
    END   = new Date(p.end_date).toISOString().slice(0, 10);
    periodLabel = p.period_name;
  } else if (arg('start', null) && arg('end', null)) {
    START = arg('start', null);
    END   = arg('end', null);
    periodLabel = `${START} to ${END}`;
  } else {
    // Default: latest period
    const [p] = await dbAll(con, `SELECT start_date, end_date, period_name FROM periods WHERE company_id = ? ORDER BY end_date DESC LIMIT 1`, [COMPANY]);
    if (!p) { console.error(`No periods found for '${COMPANY}'. Use --period or --start/--end.`); process.exit(1); }
    START = new Date(p.start_date).toISOString().slice(0, 10);
    END   = new Date(p.end_date).toISOString().slice(0, 10);
    periodLabel = p.period_name;
  }
  const period = `${periodLabel}  (${START} to ${END})`;

  const reports = REPORT === 'all' ? ['pl', 'bs', 'tb', 'gl', 'journal'] : [REPORT];

  for (const rep of reports) {
    console.log(`Generating ${rep.toUpperCase()}...`);
    let result;

    if (rep === 'pl')      result = await genPL(con, COMPANY, START, END, co.company_name);
    if (rep === 'bs')      result = await genBS(con, COMPANY, END,   co.company_name);
    if (rep === 'tb')      result = await genTB(con, COMPANY, START, END);
    if (rep === 'gl')      result = await genGL(con, COMPANY, START, END);
    if (rep === 'journal') result = await genJournal(con, COMPANY, START, END);

    const safePeriod = periodLabel.replace(/[^a-zA-Z0-9_-]/g, '_');
    const baseName   = `${COMPANY}_${rep}_${safePeriod}`;
    const titles = { pl: 'Profit & Loss', bs: 'Balance Sheet', tb: 'Trial Balance', gl: 'General Ledger', journal: 'Journal' };

    // HTML
    const htmlOut = path.join(OUT_DIR, baseName + '.html');
    fs.writeFileSync(htmlOut, html(titles[rep], co.company_name, period, result.tableHtml));
    console.log(`  → ${htmlOut}`);

    // CSV
    const csvOut = path.join(OUT_DIR, baseName + '.csv');
    fs.writeFileSync(csvOut, toCSV(result.rows));
    console.log(`  → ${csvOut}`);
  }

  con.close();
  await new Promise(r => db.close(r));
  console.log('\nDone ✓');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
