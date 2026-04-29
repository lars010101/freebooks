#!/usr/bin/env node
/**
 * freeBooks Report Generator
 * Generates financial reports (TB, PL, BS, GL) from DuckDB
 * Usage: node generate.js [--company <id>] [--year <yyyy>] [--report all|pl|bs|tb|gl] [--out <dir>] [--db <path>]
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}

const COMPANY  = arg('company', 'example_sg');
const YEAR     = parseInt(arg('year', String(new Date().getFullYear())), 10);
const REPORT   = arg('report', 'all');
const OUT_DIR  = arg('out',  path.join(os.homedir(), 'freebooks-reports'));
const DB_PATH  = arg('db',   process.env.DB_PATH || path.join(os.homedir(), '.freebooks', 'freebooks.duckdb'));

// ── DuckDB ────────────────────────────────────────────────────────────────────
const duckdb = require(path.join(__dirname, '../api/node_modules/duckdb'));

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n === null || n === undefined || isNaN(Number(n))) return '-';
  const v = Number(n);
  const abs = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return v < 0 ? `(${abs})` : abs;
}
function fmtRaw(n) {
  if (n === null || n === undefined || isNaN(Number(n))) return '';
  return Number(n).toFixed(2);
}
function csvEsc(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}
function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function writeFile(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('  wrote', filePath);
}

// ── DB query wrapper ──────────────────────────────────────────────────────────
function query(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, ...params, (err, rows) => {
      if (err) reject(err); else resolve(rows || []);
    });
  });
}

// ── CSS ───────────────────────────────────────────────────────────────────────
const CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 11pt; color: #111; margin: 0; padding: 0; }
  .page { max-width: 210mm; margin: 0 auto; padding: 20mm 15mm; }
  h1 { font-size: 16pt; margin: 0 0 2px; }
  h2 { font-size: 13pt; margin: 0 0 16px; color: #444; font-weight: normal; }
  .meta { font-size: 9pt; color: #666; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  th { background: #1a1a2e; color: #fff; padding: 6px 8px; text-align: left; font-size: 9pt; }
  th.num { text-align: right; }
  td { padding: 5px 8px; border-bottom: 1px solid #e8e8e8; font-size: 10pt; vertical-align: top; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr:nth-child(even) td { background: #f9f9fb; }
  tr.subtotal td { font-weight: bold; background: #eef0f8; border-top: 1px solid #aab; border-bottom: 1px solid #aab; }
  tr.total td { font-weight: bold; background: #1a1a2e; color: #fff; }
  tr.total td.num { color: #fff; }
  tr.section-header td { font-weight: bold; background: #dde3f0; font-size: 10pt; padding: 6px 8px; }
  .footer { font-size: 8pt; color: #888; border-top: 1px solid #ddd; padding-top: 8px; margin-top: 32px; text-align: right; }
  @media print {
    body { font-size: 10pt; }
    .page { padding: 10mm 10mm; max-width: 100%; }
    th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    tr.subtotal td, tr.total td, tr.section-header td { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`;

function htmlDoc(company, title, year, bodyHtml) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${company} — ${title} ${year}</title>
<style>${CSS}</style>
</head>
<body>
<div class="page">
  <h1>${escHtml(company)}</h1>
  <h2>${escHtml(title)} — FY${year}</h2>
  <div class="meta">Company ID: ${escHtml(COMPANY)} &nbsp;|&nbsp; Fiscal Year: ${year}</div>
  ${bodyHtml}
  <div class="footer">Generated: ${now}</div>
</div>
</body>
</html>`;
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Report: Trial Balance ─────────────────────────────────────────────────────
async function genTB(db, company, year, outDir) {
  console.log('\n[TB] Trial Balance');
  const startDate = `${year - 1}-01-01`; // adjust if fiscal year != calendar year
  const endDate   = `${year}-12-31`;

  const sql = `
    SELECT
      a.account_code,
      a.account_name,
      a.account_type,
      COALESCE(SUM(CASE WHEN jl.debit_amount  > 0 THEN jl.debit_amount  ELSE 0 END), 0) AS total_debit,
      COALESCE(SUM(CASE WHEN jl.credit_amount > 0 THEN jl.credit_amount ELSE 0 END), 0) AS total_credit,
      COALESCE(SUM(jl.debit_amount - jl.credit_amount), 0) AS net_balance
    FROM accounts a
    LEFT JOIN journal_lines jl
      ON jl.account_id = a.account_id
      AND jl.company_id = ?
    LEFT JOIN journal_batches jb
      ON jb.batch_id = jl.batch_id
      AND jb.entry_date BETWEEN ? AND ?
    WHERE a.company_id = ?
    GROUP BY a.account_code, a.account_name, a.account_type
    ORDER BY a.account_code
  `;

  const rows = await query(db, sql, [company, startDate, endDate, company]);

  // CSV
  const csvLines = ['account_code,account_name,account_type,total_debit,total_credit,net_balance'];
  for (const r of rows) {
    csvLines.push([r.account_code, r.account_name, r.account_type, fmtRaw(r.total_debit), fmtRaw(r.total_credit), fmtRaw(r.net_balance)].map(csvEsc).join(','));
  }
  writeFile(path.join(outDir, `${company}_tb_${year}.csv`), csvLines.join('\n'));

  // HTML
  let tbody = '';
  let sumDr = 0, sumCr = 0, sumNet = 0;
  for (const r of rows) {
    sumDr  += Number(r.total_debit)  || 0;
    sumCr  += Number(r.total_credit) || 0;
    sumNet += Number(r.net_balance)  || 0;
    tbody += `<tr>
      <td>${escHtml(r.account_code)}</td>
      <td>${escHtml(r.account_name)}</td>
      <td>${escHtml(r.account_type)}</td>
      <td class="num">${fmt(r.total_debit)}</td>
      <td class="num">${fmt(r.total_credit)}</td>
      <td class="num">${fmt(r.net_balance)}</td>
    </tr>`;
  }
  tbody += `<tr class="total">
    <td colspan="3">TOTAL</td>
    <td class="num">${fmt(sumDr)}</td>
    <td class="num">${fmt(sumCr)}</td>
    <td class="num">${fmt(sumNet)}</td>
  </tr>`;

  const table = `<table>
    <thead><tr>
      <th>Code</th><th>Account Name</th><th>Type</th>
      <th class="num">Debit</th><th class="num">Credit</th><th class="num">Net Balance</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>`;

  writeFile(path.join(outDir, `${company}_tb_${year}.html`), htmlDoc(company, 'Trial Balance', year, table));
  console.log(`  ${rows.length} accounts`);
}

// ── Report: Profit & Loss ─────────────────────────────────────────────────────
async function genPL(db, company, year, outDir) {
  console.log('\n[PL] Profit & Loss');

  async function fetchPL(y) {
    const s = `${y}-01-01`, e = `${y}-12-31`;
    return query(db, `
      SELECT
        a.account_code,
        a.account_name,
        a.account_type,
        COALESCE(SUM(jl.debit_amount - jl.credit_amount), 0) AS net_balance
      FROM accounts a
      LEFT JOIN journal_lines jl ON jl.account_id = a.account_id AND jl.company_id = ?
      LEFT JOIN journal_batches jb ON jb.batch_id = jl.batch_id AND jb.entry_date BETWEEN ? AND ?
      WHERE a.company_id = ? AND a.account_type IN ('Revenue','Expense','Income')
      GROUP BY a.account_code, a.account_name, a.account_type
      ORDER BY a.account_type, a.account_code
    `, [company, s, e, company]);
  }

  const [curRows, priorRows] = await Promise.all([fetchPL(year), fetchPL(year - 1)]);
  const priorMap = {};
  for (const r of priorRows) priorMap[r.account_code] = r.net_balance;

  // Group by type
  const groups = {};
  for (const r of curRows) {
    if (!groups[r.account_type]) groups[r.account_type] = [];
    groups[r.account_type].push(r);
  }

  // CSV
  const csvLines = ['account_code,account_name,account_type,current_year,prior_year'];
  for (const r of curRows) {
    csvLines.push([r.account_code, r.account_name, r.account_type, fmtRaw(r.net_balance), fmtRaw(priorMap[r.account_code] ?? 0)].map(csvEsc).join(','));
  }
  writeFile(path.join(outDir, `${company}_pl_${year}.csv`), csvLines.join('\n'));

  // HTML
  let tbody = '';
  let totalRevCur = 0, totalRevPrior = 0, totalExpCur = 0, totalExpPrior = 0;
  const typeOrder = ['Revenue', 'Income', 'Expense'];
  const allTypes  = [...new Set([...typeOrder, ...Object.keys(groups)])];

  for (const type of allTypes) {
    const rows = groups[type];
    if (!rows || rows.length === 0) continue;
    tbody += `<tr class="section-header"><td colspan="4">${escHtml(type)}</td></tr>`;
    let subtotCur = 0, subtotPrior = 0;
    for (const r of rows) {
      const cur   = Number(r.net_balance) || 0;
      const prior = Number(priorMap[r.account_code] ?? 0);
      subtotCur += cur; subtotPrior += prior;
      if (type === 'Revenue' || type === 'Income') { totalRevCur += cur; totalRevPrior += prior; }
      else { totalExpCur += cur; totalExpPrior += prior; }
      tbody += `<tr>
        <td>${escHtml(r.account_code)}</td>
        <td>${escHtml(r.account_name)}</td>
        <td class="num">${fmt(cur)}</td>
        <td class="num">${fmt(prior)}</td>
      </tr>`;
    }
    tbody += `<tr class="subtotal">
      <td colspan="2">Total ${escHtml(type)}</td>
      <td class="num">${fmt(subtotCur)}</td>
      <td class="num">${fmt(subtotPrior)}</td>
    </tr>`;
  }

  const netCur   = totalRevCur   - totalExpCur;
  const netPrior = totalRevPrior - totalExpPrior;
  tbody += `<tr class="total">
    <td colspan="2">NET PROFIT / (LOSS)</td>
    <td class="num">${fmt(netCur)}</td>
    <td class="num">${fmt(netPrior)}</td>
  </tr>`;

  const table = `<table>
    <thead><tr>
      <th>Code</th><th>Account Name</th>
      <th class="num">FY${year}</th><th class="num">FY${year - 1}</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>`;

  writeFile(path.join(outDir, `${company}_pl_${year}.html`), htmlDoc(company, 'Profit & Loss Statement', year, table));
  console.log(`  ${curRows.length} accounts`);
}

// ── Report: Balance Sheet ─────────────────────────────────────────────────────
async function genBS(db, company, year, outDir) {
  console.log('\n[BS] Balance Sheet');
  const endDate = `${year}-12-31`;

  const rows = await query(db, `
    SELECT
      a.account_code,
      a.account_name,
      a.account_type,
      COALESCE(a.bs_category, a.account_type) AS bs_category,
      COALESCE(SUM(jl.debit_amount - jl.credit_amount), 0) AS net_balance
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.account_id AND jl.company_id = ?
    LEFT JOIN journal_batches jb ON jb.batch_id = jl.batch_id AND jb.entry_date <= ?
    WHERE a.company_id = ? AND a.account_type IN ('Asset','Liability','Equity')
    GROUP BY a.account_code, a.account_name, a.account_type, bs_category
    ORDER BY a.account_type, a.account_code
  `, [company, endDate, company]);

  // CSV
  const csvLines = ['account_code,account_name,account_type,bs_category,net_balance'];
  for (const r of rows) {
    csvLines.push([r.account_code, r.account_name, r.account_type, r.bs_category, fmtRaw(r.net_balance)].map(csvEsc).join(','));
  }
  writeFile(path.join(outDir, `${company}_bs_${year}.csv`), csvLines.join('\n'));

  // HTML — group by bs_category
  const groups = {};
  for (const r of rows) {
    if (!groups[r.bs_category]) groups[r.bs_category] = [];
    groups[r.bs_category].push(r);
  }

  let tbody = '';
  const catOrder = ['Current Asset','Non-Current Asset','Asset','Current Liability','Non-Current Liability','Liability','Equity'];
  const allCats  = [...new Set([...catOrder, ...Object.keys(groups)])];
  let totalAssets = 0, totalLiab = 0, totalEq = 0;

  for (const cat of allCats) {
    const catRows = groups[cat];
    if (!catRows || catRows.length === 0) continue;
    tbody += `<tr class="section-header"><td colspan="3">${escHtml(cat)}</td></tr>`;
    let subtot = 0;
    for (const r of catRows) {
      const bal = Number(r.net_balance) || 0;
      subtot += bal;
      const type = r.account_type;
      if (type === 'Asset') totalAssets += bal;
      else if (type === 'Liability') totalLiab += bal;
      else totalEq += bal;
      tbody += `<tr>
        <td>${escHtml(r.account_code)}</td>
        <td>${escHtml(r.account_name)}</td>
        <td class="num">${fmt(bal)}</td>
      </tr>`;
    }
    tbody += `<tr class="subtotal">
      <td colspan="2">Total ${escHtml(cat)}</td>
      <td class="num">${fmt(subtot)}</td>
    </tr>`;
  }
  tbody += `<tr class="total"><td colspan="2">TOTAL ASSETS</td><td class="num">${fmt(totalAssets)}</td></tr>`;
  tbody += `<tr class="total"><td colspan="2">TOTAL LIABILITIES + EQUITY</td><td class="num">${fmt(totalLiab + totalEq)}</td></tr>`;

  const table = `<table>
    <thead><tr><th>Code</th><th>Account Name</th><th class="num">Balance</th></tr></thead>
    <tbody>${tbody}</tbody>
  </table>`;

  writeFile(path.join(outDir, `${company}_bs_${year}.html`), htmlDoc(company, 'Balance Sheet', year, table));
  console.log(`  ${rows.length} accounts`);
}

// ── Report: General Ledger ────────────────────────────────────────────────────
async function genGL(db, company, year, outDir) {
  console.log('\n[GL] General Ledger');
  const startDate = `${year}-01-01`, endDate = `${year}-12-31`;

  const rows = await query(db, `
    SELECT
      jb.entry_date   AS date,
      jl.batch_id,
      a.account_code,
      COALESCE(jl.description, jb.description, '') AS description,
      jl.debit_amount  AS debit,
      jl.credit_amount AS credit
    FROM journal_lines jl
    JOIN accounts a         ON a.account_id = jl.account_id
    JOIN journal_batches jb ON jb.batch_id  = jl.batch_id
    WHERE jl.company_id = ?
      AND jb.entry_date BETWEEN ? AND ?
    ORDER BY a.account_code, jb.entry_date, jl.batch_id
  `, [company, startDate, endDate]);

  // Compute running balance per account
  let runBal = 0, lastAcct = null;
  const enriched = rows.map(r => {
    if (r.account_code !== lastAcct) { runBal = 0; lastAcct = r.account_code; }
    runBal += (Number(r.debit) || 0) - (Number(r.credit) || 0);
    return { ...r, running_balance: runBal };
  });

  // CSV
  const csvLines = ['date,batch_id,account_code,description,debit,credit,running_balance'];
  for (const r of enriched) {
    csvLines.push([r.date, r.batch_id, r.account_code, r.description, fmtRaw(r.debit), fmtRaw(r.credit), fmtRaw(r.running_balance)].map(csvEsc).join(','));
  }
  writeFile(path.join(outDir, `${company}_gl_${year}.csv`), csvLines.join('\n'));

  // HTML
  let tbody = '';
  for (const r of enriched) {
    tbody += `<tr>
      <td>${escHtml(r.date ? String(r.date).slice(0,10) : '')}</td>
      <td>${escHtml(r.batch_id)}</td>
      <td>${escHtml(r.account_code)}</td>
      <td>${escHtml(r.description)}</td>
      <td class="num">${r.debit  ? fmt(r.debit)  : ''}</td>
      <td class="num">${r.credit ? fmt(r.credit) : ''}</td>
      <td class="num">${fmt(r.running_balance)}</td>
    </tr>`;
  }

  const table = `<table>
    <thead><tr>
      <th>Date</th><th>Batch</th><th>Account</th><th>Description</th>
      <th class="num">Debit</th><th class="num">Credit</th><th class="num">Running Balance</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>`;

  writeFile(path.join(outDir, `${company}_gl_${year}.html`), htmlDoc(company, 'General Ledger', year, table));
  console.log(`  ${enriched.length} lines`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`freeBooks Report Generator`);
  console.log(`  Company : ${COMPANY}`);
  console.log(`  Year    : ${YEAR}`);
  console.log(`  Report  : ${REPORT}`);
  console.log(`  DB      : ${DB_PATH}`);
  console.log(`  Out     : ${OUT_DIR}`);

  if (!fs.existsSync(DB_PATH)) {
    console.error(`\nERROR: DuckDB file not found: ${DB_PATH}`);
    process.exit(1);
  }

  mkdirp(OUT_DIR);

  const db = new duckdb.Database(DB_PATH, { access_mode: 'READ_ONLY' });

  const run = REPORT === 'all' ? ['tb','pl','bs','gl'] : [REPORT];

  for (const r of run) {
    switch (r) {
      case 'tb': await genTB(db, COMPANY, YEAR, OUT_DIR); break;
      case 'pl': await genPL(db, COMPANY, YEAR, OUT_DIR); break;
      case 'bs': await genBS(db, COMPANY, YEAR, OUT_DIR); break;
      case 'gl': await genGL(db, COMPANY, YEAR, OUT_DIR); break;
      default:
        console.error(`Unknown report: ${r}`);
    }
  }

  db.close();
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
