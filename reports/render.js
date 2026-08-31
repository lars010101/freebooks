'use strict';
/**
 * freeBooks — Shared Report Render Module
 *
 * Exports renderReport() and renderComparative() for use by both:
 *   - generate.js (CLI)
 *   - api/src/reports.js (Express HTTP)
 *
 * The `query` parameter is an async function: (sql, posParams[]) => rows[]
 */

// ── Asset versioning ─────────────────────────────────────────────────────────
// Mirrors api/src/pages/common.js's assetV(): ?v= tracks the file's own mtime,
// so the buster changes exactly when the file does, letting the browser's
// normal HTTP cache (maxAge:0+etag on /public, see api/src/index.js) actually
// work between loads instead of a Date.now() buster forcing a full re-fetch
// and re-parse of common.css/fb-core.js/fb-list.js on every single iframe
// report load (root cause of Journal's "Transactions/Line items/GL render
// slowly" report — confirmed live, see ia-restructure-3-spec.md §6 changelog).
// Duplicated rather than imported: this module is also used standalone by
// generate.js (CLI), so it can't depend on api/src/pages/common.js.
const _fs = require('fs');
const _path = require('path');
function _assetV(file) {
  try { return _fs.statSync(_path.join(__dirname, '..', 'api', 'public', file)).mtimeMs; }
  catch (e) { return Date.now(); }
}

// ── Number formatting ─────────────────────────────────────────────────────────
function fmt(n) {
  if (n === null || n === undefined) return '';
  const num = parseFloat(n);
  if (isNaN(num)) return '';
  const abs = Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return num < 0 ? `(${abs})` : abs;
}

// Debit/Credit cells specifically (Trial Balance, General Ledger): a zero
// value renders blank, not "0.00" — unlike fmt(), used everywhere else
// (PL/BS/CF/Net/Balance columns included) where a genuine zero is still
// shown as a number.
function fmtDC(n) {
  const num = parseFloat(n);
  if (isNaN(num) || num === 0) return '';
  return fmt(n);
}

// ── HTML page wrapper ─────────────────────────────────────────────────────────
function htmlPage(title, company, period, tableHtml, opts = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📒</text></svg>">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 11pt; color: #1a1a1a; background: #fff; }
  .page { max-width: 900px; margin: 0; padding: 32px 40px; }
  .page.wide { max-width: none; margin: 0; padding: 24px 32px; }
  .page.wide .table-wrap { overflow-x: auto; }
  .page.wide th { white-space: nowrap; }
  .page.wide td:nth-child(2) { min-width: 160px; }
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
  tr.subtotal td { font-weight: 600; border-top: 1px solid #aaa; border-bottom: 2px solid #aaa; background: #f8f8f8; }
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
<div class="page${opts.wide ? ' wide' : ''}">
  <div class="header">
    <div class="company">${company}</div>
    <div class="report-title">${title}</div>
    <div class="period">${period}</div>
  </div>
  ${opts.wide ? '<div class="table-wrap">' + tableHtml + '</div>' : tableHtml}
  <div class="footer">Generated: ${new Date().toISOString().slice(0, 10)} · freeBooks</div>
</div>
</body>
</html>`;
}

// ── CSV ───────────────────────────────────────────────────────────────────────
function toCSV(rows) {
  if (!rows || !rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map(r => headers.map(h => escape(r[h])).join(','))].join('\n');
}

// ── Report table generators ───────────────────────────────────────────────────

async function buildPL(query, company, start, end) {
  const rows = await query(`SELECT * FROM pl(?, ?, ?)`, [company, start, end]);
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
    const codeCell = code
      ? `<a href="/${company}/journal?t=gl&account=${encodeURIComponent(code)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}" target="_parent">${code}</a>`
      : code;
    tableRows += `<tr class="${cls}"><td>${codeCell}</td><td>${name}</td><td class="num">${fmt(r.amount)}</td></tr>`;
  }
  const tableHtml = `<table>
    <thead><tr><th>Code</th><th>Description</th><th class="num">Amount</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>`;
  return { tableHtml, rows };
}

async function buildBS(query, company, start, end) {
  // BS macro takes (company, end_date) — use end date
  const rows = await query(`SELECT * FROM bs(?, ?)`, [company, end]);

  // Compute unallocated net income for the period (P&L not yet closed to RE)
  const [niRow] = await query(
    `SELECT
       COALESCE((
         SELECT
           SUM(CASE WHEN a.account_type = 'Revenue' THEN je.credit_home - je.debit_home ELSE 0 END) -
           SUM(CASE WHEN a.account_type IN ('Expense','Cost of Sales') THEN je.debit_home - je.credit_home ELSE 0 END)
         FROM journal_entries je
         JOIN accounts a ON a.account_code = je.account_code AND a.company_id = je.company_id
         WHERE je.company_id = ? AND je.date <= ?
           AND a.account_type NOT IN ('Closing')
       ), 0) -
       COALESCE((
         SELECT SUM(je.debit_home - je.credit_home)
         FROM journal_entries je
         JOIN accounts a ON a.account_code = je.account_code AND a.company_id = je.company_id
         WHERE je.company_id = ? AND je.date <= ?
           AND a.account_type = 'Closing'
       ), 0) AS net_income`,
    [company, end, company, end]
  ).catch(() => [{ net_income: 0 }]);
  const netIncome = Number(niRow?.net_income || 0);

  const sorted = [...rows].sort((a, b) => {
    const typeOrder = { Asset: 0, Equity: 1, Liability: 2 };
    const tA = typeOrder[a.account_type] ?? 99;
    const tB = typeOrder[b.account_type] ?? 99;
    if (tA !== tB) return tA - tB;
    // type_total always last within its group
    const totA = a.row_type === 'type_total' ? 1 : 0;
    const totB = b.row_type === 'type_total' ? 1 : 0;
    if (totA !== totB) return totA - totB;
    // subtotal after account within same bs_category
    if (a.bs_category < b.bs_category) return -1;
    if (a.bs_category > b.bs_category) return 1;
    const rtOrder = { account: 0, subtotal: 1 };
    return (rtOrder[a.row_type] ?? 0) - (rtOrder[b.row_type] ?? 0);
  });
  let lastType = null;
  let tableRows = '';
  const collectedTypeTotals = [];
  for (const r of sorted) {
    if (r.row_type === 'type_total') {
      collectedTypeTotals.push(r);
      if (/equity/i.test(r.account_name)) {
        // Insert unallocated net income row before TOTAL EQUITY (if non-zero)
        if (netIncome !== 0) {
          tableRows += `<tr class="account"><td></td><td><em>Unallocated net income / (loss)</em></td><td class="num">${fmt(netIncome)}</td></tr>`;
        }
        // Adjust TOTAL EQUITY to include net income
        const adjustedTotal = parseFloat(r.balance || 0) + netIncome;
        tableRows += `<tr class="type_total"><td></td><td><strong>${r.account_name}</strong></td><td class="num">${fmt(adjustedTotal)}</td></tr>`;
      } else {
        tableRows += `<tr class="type_total"><td></td><td><strong>${r.account_name}</strong></td><td class="num">${fmt(r.balance)}</td></tr>`;
      }
      continue;
    }
    if (r.account_type !== lastType) {
      tableRows += `<tr class="section-header"><td colspan="3">${r.account_type}</td></tr>`;
      lastType = r.account_type;
    }
    const cls = r.row_type + (r.balance == 0 && r.row_type === 'account' ? ' zero' : '');
    const code = r.account_code || '';
    const name = r.row_type === 'subtotal' ? `<em>${r.account_name}</em>` : r.account_name;
    const codeCell = code
      ? `<a href="/${company}/journal?t=gl&account=${encodeURIComponent(code)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}" target="_parent">${code}</a>`
      : code;
    tableRows += `<tr class="${cls}"><td>${codeCell}</td><td>${name}</td><td class="num">${fmt(r.balance)}</td></tr>`;
  }
  // Compute TOTAL EQUITY + LIABILITIES (equity total already adjusted above)
  const equityTypeTotal = collectedTypeTotals.find(r => /equity/i.test(r.account_name));
  const adjustedEquityTotal = equityTypeTotal ? parseFloat(equityTypeTotal.balance || 0) + netIncome : netIncome;
  const liabilityTotal = collectedTypeTotals
    .filter(r => /liabilit/i.test(r.account_name))
    .reduce((sum, r) => sum + parseFloat(r.balance || 0), 0);
  const eqLiabTotal = adjustedEquityTotal + liabilityTotal;
  tableRows += `<tr class="total"><td></td><td><strong>TOTAL EQUITY + LIABILITIES</strong></td><td class="num">${fmt(eqLiabTotal)}</td></tr>`;
  const tableHtml = `<table>
    <thead><tr><th>Code</th><th>Description</th><th class="num">Balance</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>`;
  return { tableHtml, rows };
}

async function buildTB(query, company, start, end) {
  const rows = await query(`SELECT * FROM tb(?, ?, ?)`, [company, start, end]);
  let tableRows = rows.map(r => `<tr class="account">
      <td>${r.account_type}</td><td><a href="/${company}/journal?t=gl&account=${encodeURIComponent(r.account_code)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}" target="_parent">${r.account_code}</a></td><td>${r.account_name}</td>
    <td class="num">${fmtDC(r.total_debit)}</td>
    <td class="num">${fmtDC(r.total_credit)}</td>
    <td class="num">${fmt(r.net_balance)}</td>
  </tr>`).join('');
  const totDr  = rows.reduce((s, r) => s + parseFloat(r.total_debit  || 0), 0);
  const totCr  = rows.reduce((s, r) => s + parseFloat(r.total_credit || 0), 0);
  const totNet = rows.reduce((s, r) => s + parseFloat(r.net_balance  || 0), 0);
  tableRows += `<tr class="total"><td></td><td></td><td><strong>TOTAL</strong></td>
    <td class="num">${fmtDC(totDr)}</td><td class="num">${fmtDC(totCr)}</td><td class="num">${fmt(totNet)}</td>
  </tr>`;
  const tableHtml = `<table>
    <thead><tr><th>Type</th><th>Code</th><th>Account</th>
      <th class="num">Debit</th><th class="num">Credit</th><th class="num">Net</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>`;
  return { tableHtml, rows };
}

// ── General Ledger ────────────────────────────────────────────────────────────
// FB.list, groupKey: 'account_code' — same mechanism as Journal Line Listing
// (2026-08-30 follow-up: magnus wanted the bespoke Account-code search bar
// replaced by a native column-header filter, plus persistent/sticky column
// headers). Each account's rows — Opening Balance, transactions, Closing
// Balance — form one group; filtering the Account column keeps the whole
// group together (Opening through Closing), matching what the old bespoke
// filter already did (show one account's full ledger), just via fb-list's
// native ≡ dropdown instead of a separate search box. Running balance stays
// entirely server-computed, sequential by date within each account, exactly
// as before — filtering only hides/shows groups client-side, it never
// recomputes balances. Date/Debit/Credit/Balance are deliberately NOT
// sortable: this report's balance column is only meaningful in date order,
// and fb-list's groupKey sort would reorder rows within nothing (it sorts
// which group comes first, not rows inside a group) — but making these
// columns look sortable would still invite a click that does nothing useful.
// The account section-header row folds into the Opening Balance row's own
// Description cell ("1680 — Fordringar hos kreditinstitut") — fb-list has no
// separate "group header" row type, so a standalone full-width header row
// isn't representable as one more data row the way the old hand-built table
// let it be.
async function buildGL(query, company, start, end, account) {
  let companyName = company;
  try {
    const [co] = await query(`SELECT company_name FROM companies WHERE company_id = ?`, [company]);
    if (co) companyName = co.company_name;
  } catch (_) {}

  let rows = await query(`SELECT * FROM gl(?, ?, ?)`, [company, start, end]);
  // Drill-through pre-filter (TB/P&L/BS/CF account-code links carry ?account=)
  // stays server-side, unchanged from before this rewrite.
  if (account) rows = rows.filter(r => r.account_code === account);

  const rowsData = [];
  let lastAcct = null;
  let runBal = 0;
  let seq = 0;
  for (const r of rows) {
    if (r.account_code !== lastAcct) {
      if (lastAcct !== null) {
        rowsData.push({ _key: 'gl-' + (seq++), account_code: lastAcct, _kind: 'closing',
          date: '', reference: '', description: 'Closing Balance', debit: 0, credit: 0, balance: runBal });
      }
      runBal = 0;
      lastAcct = r.account_code;
    }
    if (r.batch_id === 'Opening Balance') {
      const obAmt = parseFloat(r.debit_home || r.debit || 0) - parseFloat(r.credit_home || r.credit || 0);
      runBal = obAmt;
      rowsData.push({ _key: 'gl-' + (seq++), account_code: r.account_code, _kind: 'opening',
        account_label: r.account_code + ' — ' + (r.account_name || ''),
        date: '', reference: '', description: 'Opening Balance', debit: 0, credit: 0, balance: runBal });
    } else {
      runBal += parseFloat(r.debit_home || r.debit || 0) - parseFloat(r.credit_home || r.credit || 0);
      rowsData.push({
        _key: r.entry_id || ('gl-' + (seq++)),
        account_code: r.account_code,
        _kind: 'txn',
        batch_id: r.batch_id,
        date: new Date(r.date).toISOString().slice(0, 10),
        reference: r.reference || r.batch_id,
        description: r.description || '',
        debit: Number(r.debit_home || r.debit || 0),
        credit: Number(r.credit_home || r.credit || 0),
        balance: runBal,
      });
    }
  }
  if (lastAcct !== null) {
    rowsData.push({ _key: 'gl-' + (seq++), account_code: lastAcct, _kind: 'closing',
      date: '', reference: '', description: 'Closing Balance', debit: 0, credit: 0, balance: runBal });
  }

  const tableHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>General Ledger — freeBooks</title>
<link rel="stylesheet" href="/public/common.css?v=${_assetV('common.css')}">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; overflow: hidden; }
  body { font-family: 'Inter', Arial, sans-serif; font-size: 10pt; color: #1a1a1a; background: #fff; }
  /* Flex column filling the iframe's fixed height exactly — .table-wrap is
     the ONLY element that scrolls. A magic-number max-height (calc(100vh -
     Npx), guessing how tall the header/footer are) left the body itself
     free to overflow the iframe's own height whenever that guess was off,
     giving a SECOND scrollbar (the iframe's own html/body, which scrolls by
     default when its content overflows) on top of table-wrap's — this
     flex layout makes that structurally impossible: header/footer take
     their natural size, table-wrap gets exactly what's left. */
  .page { height: 100%; display: flex; flex-direction: column; max-width: min(94vw, 1600px); margin: 0; padding: 24px 32px; }
  .header { flex-shrink: 0; border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; margin-bottom: 18px; }
  /* On-screen this repeats page/tab chrome the app already shows (company,
     period) — hidden here, restored for print/PDF, since PDF export opens
     this exact standalone document raw (ia-restructure-3-spec.md §6.2). */
  .header { display: none; }
  @media print { .header { display: block; } }
  .company { font-size: 16pt; font-weight: 700; }
  .report-title { font-size: 13pt; color: #444; margin-top: 4px; }
  .period { font-size: 10pt; color: #666; margin-top: 2px; }
  .table-wrap { flex: 1; min-height: 0; overflow-x: auto; overflow-y: auto; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  /* Persistent/sticky column headers (magnus 2026-08-30) — the table-wrap
     above is the scroll container the header stays pinned against. */
  th { position: sticky; top: 0; z-index: 2; text-align: left; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.05em; color: #555; background: #fff; border-bottom: 1px solid #ccc; padding: 6px 8px; }
  th.num { text-align: right; }
  td { padding: 5px 8px; border-bottom: 1px solid #f0f0f0; vertical-align: middle; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.gl-opening td, tr.gl-closing td { font-weight: 600; background: #fafafa; }
  tr.gl-opening td.account-label { font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; }
  tr.gl-txn:hover td { background: #fafafa; }
  .no-results { text-align: center; color: #888; padding: 20px; }
  .footer { flex-shrink: 0; margin-top: 12px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 9pt; color: #888; }
  .doc-link { color: #18293f; text-decoration: underline; }
  .pe-ro { color: #bbb; }
  /* FB.list keyboard-focus in the iframe */
  tr.nav-row-focus:not(.row-editing) > td {
    background: #18293f !important; color: #fff !important; outline: none;
  }
  tr.nav-row-focus:not(.row-editing) > td a { color: #fff !important; }
  /* FB.list column filter/sort UI. common.css (linked above) declares its own
     th.fb-th-filterable { position: relative } globally, at the SAME
     specificity as this selector — cascade order (this block comes later in
     the document) is what makes position:sticky win here instead, not
     specificity. Re-declaring sticky explicitly rather than just dropping
     position: relative, since dropping it only beat the (already-removed)
     local duplicate of this rule, not common.css's copy. */
  th.fb-th-filterable { position: sticky; top: 0; padding-right: 24px; }
  th .fb-filter-btn { position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
    cursor: pointer; opacity: 0.4; font-size: 14px; line-height: 1; }
  th:hover .fb-filter-btn { opacity: 1; color: #555; }
  th .fb-filter-btn.fb-filter-active { opacity: 1; color: #18293f; font-weight: 700; }
  th.fb-th-sortable { cursor: pointer; user-select: none; }
  .th-sort { font-size: 0.6875rem; color: #18293a; width: 12px; text-align: center; flex-shrink: 0; margin-left: 2px; }
  .th-sort:empty { display: none; }
  .fb-col-filter-dd { position: fixed; background: #fff; border: 1px solid #ccc; border-radius: 4px;
    box-shadow: 0 2px 12px rgba(0,0,0,.15); z-index: 9999; padding: 8px; min-width: 180px; }
  .fb-col-filter-dd .fb-cf-input, .fb-col-filter-dd .fb-cf-op {
    padding: 4px 6px; border: 1px solid #ddd; border-radius: 3px; font-size: 10pt; margin-bottom: 6px; }
  .fb-cf-list { max-height: 240px; overflow-y: auto; }
  .fb-cf-item { padding: 4px 8px; cursor: pointer; border-radius: 3px; font-size: 10pt; }
  .fb-cf-item:hover { background: #f2f4f7; }
  .fb-cf-clear { color: #6b7a95; font-style: italic; }
  td[data-field="date"], td[data-field="reference"] { white-space: nowrap; }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="company">${companyName}</div>
    <div class="report-title">General Ledger</div>
    <div class="period">${start} to ${end}</div>
  </div>

  <div class="table-wrap">
    <table class="edit-table">
      <thead>
        <tr>
          <th data-field="account_code">Account</th>
          <th data-field="date">Date</th>
          <th data-field="reference">Doc No</th>
          <th data-field="description">Description</th>
          <th data-field="debit" class="num">Debit</th>
          <th data-field="credit" class="num">Credit</th>
          <th data-field="balance" class="num">Balance</th>
        </tr>
      </thead>
      <tbody id="gl-body"></tbody>
    </table>
  </div>

  <div class="footer">Generated: ${new Date().toISOString().slice(0, 10)} · freeBooks · General Ledger</div>
</div>

<script src="/public/fb-core.js?v=${_assetV('fb-core.js')}"></script>
<script src="/public/fb-list.js?v=${_assetV('fb-list.js')}"></script>
<script>
  var COMPANY = ${JSON.stringify(company)};
  var GL_ROWS = ${JSON.stringify(rowsData)};
  var REPORT_START = ${JSON.stringify(start || '')};
  var REPORT_END = ${JSON.stringify(end || '')};

  function drillHref(batchId) {
    var extra = '';
    if (REPORT_START) extra += '&rpt_start=' + encodeURIComponent(REPORT_START);
    if (REPORT_END) extra += '&rpt_end=' + encodeURIComponent(REPORT_END);
    return '/' + COMPANY + '/journal/voucher?batch=' + encodeURIComponent(batchId) + '&from=gl' + extra;
  }

  function amtDisplay(v) {
    var n = Number(v || 0);
    if (!n) return '';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function balDisplay(v) {
    var n = Number(v || 0);
    var abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return n < 0 ? '(' + abs + ')' : abs;
  }

  var glList = FB.list.create({
    keysId: 'gl',
    active: function () { return true; },
    tbody: 'gl-body',
    companyId: function () { return COMPANY; },
    canAdd: false,
    editable: function () { return false; },
    same: function () { return true; },
    validate: function () { return null; },
    groupKey: 'account_code',
    columns: [
      // Account only carries a value on the Opening Balance row (the account's
      // first row) — same "first row of the atomic unit only" convention as
      // Journal Line Listing's Doc No/Journal/Date.
      { field: 'account_code', label: 'Account', type: 'text', filterType: 'text', sortable: true,
        display: function (v, r) {
          if (r._kind !== 'opening') return '';
          return '<span class="account-label">' + esc(r.account_label || v) + '</span>';
        } },
      { field: 'date', label: 'Date', type: 'text', filterType: 'date',
        display: function (v) { return v ? esc(v) : ''; } },
      { field: 'reference', label: 'Doc No', type: 'text', filterType: 'text',
        display: function (v, r) {
          if (!v || r._kind !== 'txn') return v ? esc(v) : '';
          return '<a class="doc-link" href="' + drillHref(r.batch_id) + '" target="_parent" onclick="event.stopPropagation()">' + esc(v) + '</a>';
        } },
      { field: 'description', label: 'Description', type: 'text', filterType: 'text', sortable: true,
        display: function (v, r) { return v ? esc(v) : (r._kind === 'txn' ? '<span class="pe-ro">—</span>' : ''); } },
      { field: 'debit', label: 'Debit', type: 'number', filterType: 'amount', align: 'right',
        display: amtDisplay },
      { field: 'credit', label: 'Credit', type: 'number', filterType: 'amount', align: 'right',
        display: amtDisplay },
      { field: 'balance', label: 'Balance', type: 'number', filterType: null, align: 'right',
        display: balDisplay },
    ],
    list: {
      fetch: function () { return Promise.resolve(GL_ROWS); },
      map: function (r) { return Object.assign({}, r, { _key: r._key }); }
    },
    // fb-list.js has no per-row class hook — apply the opening/closing/txn
    // style class ourselves after every render (onChrome fires post-render
    // unconditionally, per fb-list.js's syncChrome() — not just on initial
    // load, so this stays correct across filtering/sorting too, unlike a
    // one-shot post-load.then() would). data-key holds _key on every <tr>.
    onChrome: function () {
      var body = document.getElementById('gl-body');
      if (!body) return;
      body.querySelectorAll('tr[data-key]').forEach(function (tr) {
        var r = GL_ROWS_BY_KEY[tr.getAttribute('data-key')];
        if (!r) return;
        tr.classList.remove('gl-opening', 'gl-closing', 'gl-txn');
        tr.classList.add(r._kind === 'opening' ? 'gl-opening' : r._kind === 'closing' ? 'gl-closing' : 'gl-txn');
      });
    }
  });

  var GL_ROWS_BY_KEY = {};
  GL_ROWS.forEach(function (r) { GL_ROWS_BY_KEY[r._key] = r; });
  glList.load();
</script>
</body>
</html>`;
  return { tableHtml, rows };
}

// ── Journal Line Listing ──────────────────────────────────────────────────────
// Line-level detail (one row per journal_entries line), FB.list tree:true —
// the same native mechanism Bills/Inbox use to keep a group's rows together
// under any column filter/sort ("children follow their parent" — fb-list.js's
// own tree-filter/tree-sort doctrine). One batch's lines are the tree: the
// first line (by account_code) is the parent and carries Doc No; the rest are
// children with Doc No blank, so a batch reads as one atomic unit no matter
// how the list is filtered or sorted, and Doc No never repeats within it.
// Rewritten 2026-08-30 (docs/ia-restructure-3-spec.md follow-up) — was a
// bespoke fetch/sort/filter implementation with an explicit Search/Clear bar;
// now server-renders every line once (like buildVoucherRegister) and lets
// FB.list's native column-header filter/sort replace that bar entirely.
async function buildJournal(query, company, start, end) {
  let companyName = company;
  try {
    const [co] = await query(`SELECT company_name FROM companies WHERE company_id = ?`, [company]);
    if (co) companyName = co.company_name;
  } catch (_) {}

  const lines = await query(
    `SELECT je.entry_id, je.batch_id, je.date, je.reference, je.description,
            je.account_code, a.account_name, je.debit, je.credit, j.code AS journal_code
     FROM journal_entries je
     LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
     LEFT JOIN journals j ON j.journal_id = je.journal_id
     WHERE je.company_id = ? AND je.date >= ? AND je.date <= ?
     ORDER BY je.date DESC, je.batch_id, je.account_code, je.entry_id`,
    [company, start, end]
  );

  // Journal/Date/Doc No carry their FULL value on every row here — never
  // blanked in the underlying data, only on screen (see the jlBlankRepeats
  // render hook below). CSV/PDF export reads this array directly, and per
  // ia-restructure-3-spec.md §6.4 must always show the complete data.
  const rowsData = lines.map((l) => ({
    _key: l.entry_id,
    batch_id: l.batch_id,
    journal: l.journal_code || '',
    date: String(l.date || '').slice(0, 10),
    reference: l.reference || '',
    account_code: l.account_code || '',
    account_name: l.account_name || '',
    description: l.description || '',
    debit: Number(l.debit || 0),
    credit: Number(l.credit || 0),
  }));

  const tableHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Journal Line Listing — freeBooks</title>
<link rel="stylesheet" href="/public/common.css?v=${_assetV('common.css')}">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', Arial, sans-serif; font-size: 10pt; color: #1a1a1a; background: #fff; }
  .page { max-width: min(94vw, 1600px); margin: 0; padding: 24px 32px; }
  .header { border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; margin-bottom: 18px; }
  /* On-screen this repeats page/tab chrome the app already shows (company,
     period) — hidden here, restored for print/PDF, since PDF export opens
     this exact standalone document raw (ia-restructure-3-spec.md §6.2). */
  .header { display: none; }
  @media print { .header { display: block; } }
  .company { font-size: 16pt; font-weight: 700; }
  .report-title { font-size: 13pt; color: #444; margin-top: 4px; }
  .period { font-size: 10pt; color: #666; margin-top: 2px; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th { text-align: left; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.05em; color: #555; border-bottom: 1px solid #ccc; padding: 6px 8px; }
  th.num { text-align: right; }
  td { padding: 5px 8px; border-bottom: 1px solid #f0f0f0; vertical-align: middle; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr:hover td { background: #fafafa; }
  .no-results { text-align: center; color: #888; padding: 20px; }
  .footer { margin-top: 28px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 9pt; color: #888; }
  .doc-link { color: #18293f; text-decoration: underline; }
  .pe-ro { color: #bbb; }
  /* FB.list keyboard-focus in the iframe */
  tr.nav-row-focus:not(.row-editing) > td {
    background: #18293f !important; color: #fff !important; outline: none;
  }
  tr.nav-row-focus:not(.row-editing) > td a { color: #fff !important; }
  /* FB.list column filter/sort UI */
  th.fb-th-filterable { position: relative; padding-right: 24px; }
  th .fb-filter-btn { position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
    cursor: pointer; opacity: 0.4; font-size: 14px; line-height: 1; }
  th:hover .fb-filter-btn { opacity: 1; color: #555; }
  th .fb-filter-btn.fb-filter-active { opacity: 1; color: #18293f; font-weight: 700; }
  th.fb-th-sortable { cursor: pointer; user-select: none; }
  .th-sort { font-size: 0.6875rem; color: #18293a; width: 12px; text-align: center; flex-shrink: 0; margin-left: 2px; }
  .th-sort:empty { display: none; }
  .fb-col-filter-dd { position: fixed; background: #fff; border: 1px solid #ccc; border-radius: 4px;
    box-shadow: 0 2px 12px rgba(0,0,0,.15); z-index: 9999; padding: 8px; min-width: 180px; }
  .fb-col-filter-dd .fb-cf-input, .fb-col-filter-dd .fb-cf-op {
    padding: 4px 6px; border: 1px solid #ddd; border-radius: 3px; font-size: 10pt; margin-bottom: 6px; }
  .fb-cf-list { max-height: 240px; overflow-y: auto; }
  .fb-cf-item { padding: 4px 8px; cursor: pointer; border-radius: 3px; font-size: 10pt; }
  .fb-cf-item:hover { background: #f2f4f7; }
  .fb-cf-clear { color: #6b7a95; font-style: italic; }
  td[data-field="date"], td[data-field="reference"] { white-space: nowrap; }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="company">${companyName}</div>
    <div class="report-title">Journal Line Listing</div>
    <div class="period">${start || ''} to ${end || ''}</div>
  </div>

  <div class="table-wrap">
    <table class="edit-table">
      <thead>
        <tr>
          <th data-field="date">Date</th>
          <th data-field="journal">Journal</th>
          <th data-field="reference">Doc No</th>
          <th data-field="account_code">Account</th>
          <th data-field="account_name">Account Name</th>
          <th data-field="debit" class="num">Debit</th>
          <th data-field="credit" class="num">Credit</th>
          <th data-field="description">Description</th>
        </tr>
      </thead>
      <tbody id="jl-body"></tbody>
    </table>
  </div>

  <div class="footer">Generated: ${new Date().toISOString().slice(0, 10)} · freeBooks · Journal Line Listing</div>
</div>

<script src="/public/fb-core.js?v=${_assetV('fb-core.js')}"></script>
<script src="/public/fb-list.js?v=${_assetV('fb-list.js')}"></script>
<script>
  var COMPANY = ${JSON.stringify(company)};
  var JL_ROWS = ${JSON.stringify(rowsData)};
  var REPORT_START = ${JSON.stringify(start || '')};
  var REPORT_END = ${JSON.stringify(end || '')};

  function drillHref(batchId) {
    var extra = '';
    if (REPORT_START) extra += '&rpt_start=' + encodeURIComponent(REPORT_START);
    if (REPORT_END) extra += '&rpt_end=' + encodeURIComponent(REPORT_END);
    return '/' + COMPANY + '/journal/voucher?batch=' + encodeURIComponent(batchId) + '&from=journal' + extra;
  }

  function amtDisplay(v) {
    var n = Number(v || 0);
    if (!n) return '';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  var jlList = FB.list.create({
    keysId: 'journal-lines',
    active: function () { return true; },
    tbody: 'jl-body',
    companyId: function () { return COMPANY; },
    canAdd: false,
    editable: function () { return false; },
    same: function () { return true; },
    validate: function () { return null; },
    // Flat list, never foldable — Line Items exists to browse individual
    // lines, so tree mode's parent/child fold affordance (even forced open)
    // is the wrong interaction model here. groupKey: 'batch_id' is fb-list.js's
    // flat-list group-atomicity feature (2026-08-30): a filter or column
    // sort can never split one batch's lines apart, or hide any of them —
    // the group is kept/moved as a whole if ANY of its rows matches, without
    // requiring a designated parent row. See fb-list.js's groupKey comment
    // for the mechanism.
    groupKey: 'batch_id',
    columns: [
      // Journal/Date/Doc No carry their real value on every row (see the
      // row-shaping comment above) — jlBlankRepeats() below blanks them on
      // screen, past a batch's first rendered row, without touching the
      // underlying data CSV/PDF export reads.
      { field: 'date', label: 'Date', type: 'text', filterType: 'date', sortable: true,
        display: function (v) { return v ? esc(v) : ''; } },
      { field: 'journal', label: 'Journal', type: 'text', filterType: 'text', sortable: true,
        display: function (v) { return v ? esc(v) : ''; } },
      { field: 'reference', label: 'Doc No', type: 'text', filterType: 'text', sortable: true,
        display: function (v, r) {
          if (!v) return '';
          return '<a class="doc-link" href="' + drillHref(r.batch_id) + '" target="_parent" onclick="event.stopPropagation()">' + esc(v) + '</a>';
        } },
      { field: 'account_code', label: 'Account', type: 'text', filterType: 'text', sortable: true },
      { field: 'account_name', label: 'Account Name', type: 'text', filterType: 'text', sortable: true,
        display: function (v) { return v ? esc(v) : '<span class="pe-ro">—</span>'; } },
      { field: 'debit', label: 'Debit', type: 'number', filterType: 'amount', sortable: true, align: 'right',
        display: amtDisplay },
      { field: 'credit', label: 'Credit', type: 'number', filterType: 'amount', sortable: true, align: 'right',
        display: amtDisplay },
      { field: 'description', label: 'Description', type: 'text', filterType: 'text', sortable: true,
        display: function (v) { return v ? esc(v) : '<span class="pe-ro">—</span>'; } },
    ],
    list: {
      fetch: function () { return Promise.resolve(JL_ROWS); },
      map: function (r) { return Object.assign({}, r, { _key: r._key }); }
    },
    // Screen-only: blanks Journal/Date/Doc No past a batch's first row in
    // CURRENT render order (works under any sort/filter, since groupKey
    // keeps a batch's rows contiguous but doesn't fix which one renders
    // first). Fires after every render — onChrome is fb-list.js's
    // per-render hook (see its own comment) — so it's re-applied on sort
    // and filter changes too, not just initial load.
    onChrome: function () { jlBlankRepeats(); }
  });

  var _jlBatchByKey = {};
  JL_ROWS.forEach(function (r) { _jlBatchByKey[String(r._key)] = r.batch_id; });

  function jlBlankRepeats() {
    var lastBatch = null;
    document.querySelectorAll('#jl-body tr[data-key]').forEach(function (tr) {
      var batch = _jlBatchByKey[tr.dataset.key];
      var repeat = batch !== undefined && batch === lastBatch;
      lastBatch = batch;
      if (repeat) {
        ['date', 'journal', 'reference'].forEach(function (f) {
          var td = tr.querySelector('td[data-field="' + f + '"]');
          if (td) td.innerHTML = '';
        });
      }
    });
  }

  jlList.load();
</script>
</body>
</html>`;
  return { tableHtml, rows: [] };
}

// ── Voucher Register ─────────────────────────────────────────────────────────
// Batch-grouped posted register (the former Journal sidebar page), now rendered
// as a report inside the Reports hub iframe. Surfaces the journal.reverse verb
// on each non-reversed voucher row, and shows reversal-chain badges
// (Reversed / Reversal) when applicable. Step 3 (2026-08-03).
async function buildVoucherRegister(query, company, start, end) {
  let companyName = company;
  try {
    const [co] = await query(`SELECT company_name FROM companies WHERE company_id = ?`, [company]);
    if (co) companyName = co.company_name;
  } catch (_) {}

  // Group journal_entries by batch_id, server-side. One row per posted batch.
  // reverses/reversed_by are per-row but constant within a batch (the reversal
  // action writes them uniformly), so MIN/MAX is a safe representative.
  // journal_code comes via LEFT JOIN on journal_id (may be NULL for legacy rows).
  const batches = await query(
    `SELECT b.*, j.code AS journal_code
     FROM (
       SELECT
         batch_id,
         MIN(date)                                   AS date,
         MIN(reference)                              AS reference,
         MIN(description)                            AS description,
         MIN(source)                                 AS source,
         MIN(journal_id)                             AS journal_id,
         SUM(debit)                                  AS total_debit,
         SUM(credit)                                 AS total_credit,
         COUNT(*)                                    AS line_count,
         MIN(reverses)                               AS reverses,
         MIN(reversed_by)                            AS reversed_by,
         MAX(bill_id)                                AS bill_id
       FROM journal_entries
       WHERE company_id = ?
         AND date >= ?
         AND date <= ?
       GROUP BY batch_id
     ) b
     LEFT JOIN journals j ON j.journal_id = b.journal_id
     ORDER BY b.date DESC, b.batch_id`,
    [company, start, end]
  );

  const rowsData = batches.map(b => ({
    batch_id: b.batch_id,
    date: String(b.date || '').slice(0, 10),
    journal: b.journal_code || '',
    reference: b.reference || '',
    description: b.description || '',
    total_debit: Number(b.total_debit || 0),
    total_credit: Number(b.total_credit || 0),
    line_count: b.line_count,
    reverses: b.reverses || null,
    reversed_by: b.reversed_by || null,
    bill_id: b.bill_id || null,
    status: b.reverses ? 'Reversal' : (b.reversed_by ? 'Reversed' : 'Posted'),
  }));

  const tableHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Transaction Register — freeBooks</title>
<link rel="stylesheet" href="/public/common.css?v=${_assetV('common.css')}">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', Arial, sans-serif; font-size: 10pt; color: #1a1a1a; background: #fff; }
  .page { max-width: min(94vw, 1600px); margin: 0; padding: 24px 32px; }
  .header { border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; margin-bottom: 18px; }
  /* On-screen this repeats page/tab chrome the app already shows (company,
     period) — hidden here, restored for print/PDF, since PDF export opens
     this exact standalone document raw (ia-restructure-3-spec.md §6.2). */
  .header { display: none; }
  @media print { .header { display: block; } }
  .company { font-size: 16pt; font-weight: 700; }
  .report-title { font-size: 13pt; color: #444; margin-top: 4px; }
  .period { font-size: 10pt; color: #666; margin-top: 2px; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th { text-align: left; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.05em; color: #555; border-bottom: 1px solid #ccc; padding: 6px 8px; }
  th.num { text-align: right; }
  td { padding: 5px 8px; border-bottom: 1px solid #f0f0f0; vertical-align: middle; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr:hover td { background: #fafafa; }
  tr[data-href] { cursor: pointer; }
  tr[data-href]:hover td { background: #f0f4ff; }
  .no-results { text-align: center; color: #888; padding: 20px; }
  .footer { margin-top: 28px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 9pt; color: #888; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 8.5pt; font-weight: 600; text-transform: uppercase; letter-spacing: .02em; }
  .b-posted   { background: #e8f5e9; color: #2e7d32; }
  .b-reversed { background: #ffebee; color: #c62828; }
  .b-reversal { background: #fff3e0; color: #e65100; }
  .rev-link { color: #e65100; text-decoration: underline; font-size: 9pt; }
  .pe-ro { color: #bbb; }
  /* FB.list keyboard-focus in the iframe */
  tr.nav-row-focus:not(.row-editing) > td {
    background: #18293f !important; color: #fff !important; outline: none;
  }
  tr.nav-row-focus:not(.row-editing) > td a { color: #fff !important; }
  /* FB.list column filter/sort UI */
  th.fb-th-filterable { position: relative; padding-right: 24px; }
  /* Right-aligned filterable column (Amount): td must match the th padding-right
     so values align with the header text, not the filter button. */
  td[data-field="total_debit"] { padding-right: 24px; }
  th .fb-filter-btn { position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
    cursor: pointer; opacity: 0.4; font-size: 14px; line-height: 1; }
  th:hover .fb-filter-btn { opacity: 1; color: #555; }
  th .fb-filter-btn.fb-filter-active { opacity: 1; color: #18293f; font-weight: 700; }
  th.fb-th-sortable { cursor: pointer; user-select: none; }
  .th-sort { font-size: 0.6875rem; color: #18293a; width: 12px; text-align: center; flex-shrink: 0; margin-left: 2px; }
  .th-sort:empty { display: none; }
  .fb-col-filter-dd { position: fixed; background: #fff; border: 1px solid #ccc; border-radius: 4px;
    box-shadow: 0 2px 12px rgba(0,0,0,.15); z-index: 9999; padding: 8px; min-width: 180px; }
  .fb-col-filter-dd .fb-cf-input, .fb-col-filter-dd .fb-cf-op {
    padding: 4px 6px; border: 1px solid #ddd; border-radius: 3px; font-size: 10pt; margin-bottom: 6px; }
  .fb-cf-list { max-height: 240px; overflow-y: auto; }
  .fb-cf-item { padding: 4px 8px; cursor: pointer; border-radius: 3px; font-size: 10pt; }
  .fb-cf-item:hover { background: #f2f4f7; }
  .fb-cf-clear { color: #6b7a95; font-style: italic; }
  .row-actions { white-space: nowrap; text-align: right; }
  td[data-field="date"] { white-space: nowrap; }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="company">${companyName}</div>
    <div class="report-title">Transaction Register</div>
    <div class="period">${start || ''} to ${end || ''}</div>
  </div>

  <div class="table-wrap">
    <table class="edit-table">
      <thead>
        <tr>
          <th data-field="date">Date</th>
          <th data-field="journal">Journal</th>
          <th data-field="reference">Doc No</th>
          <th data-field="description">Description</th>
          <th data-field="total_debit" class="num">Amount</th>
          <th data-field="status">Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="vr-body"></tbody>
    </table>
  </div>

  <div class="footer">Generated: ${new Date().toISOString().slice(0, 10)} · freeBooks · Transaction Register</div>
</div>

<script src="/public/fb-core.js?v=${_assetV('fb-core.js')}"></script>
<script src="/public/fb-list.js?v=${_assetV('fb-list.js')}"></script>
<script>
  var COMPANY = ${JSON.stringify(company)};
  var VR_ROWS = ${JSON.stringify(rowsData)};
  var REPORT_START = ${JSON.stringify(start || '')};
  var REPORT_END = ${JSON.stringify(end || '')};

  function drillHref(b) {
    var extra = '';
    if (REPORT_START) extra += '&rpt_start=' + encodeURIComponent(REPORT_START);
    if (REPORT_END) extra += '&rpt_end=' + encodeURIComponent(REPORT_END);
    if (b.bill_id) {
      return '/' + COMPANY + '/bill/' + encodeURIComponent(b.bill_id) + '?from=voucher-register' + extra;
    }
    return '/' + COMPANY + '/journal/voucher?batch=' + encodeURIComponent(b.batch_id) + '&from=voucher-register' + extra;
  }

  function statusDisplay(v, row) {
    if (row.reverses) {
      return '<span class="badge b-reversal">Reversal</span>'
        + ' <a class="rev-link" href="/' + COMPANY + '/journal/voucher?batch=' + encodeURIComponent(row.reverses) + '&from=voucher-register" target="_parent">of ' + esc(String(row.reverses).slice(0, 8)) + '</a>';
    }
    if (row.reversed_by) {
      return '<span class="badge b-reversed">Reversed</span>'
        + ' <a class="rev-link" href="/' + COMPANY + '/journal/voucher?batch=' + encodeURIComponent(row.reversed_by) + '&from=voucher-register" target="_parent">by ' + esc(String(row.reversed_by).slice(0, 8)) + '</a>';
    }
    return '<span class="badge b-posted">Posted</span>';
  }

  function amtDisplay(v) {
    var n = Number(v || 0);
    if (!n) return '';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  var vrList = FB.list.create({
    keysId: 'voucher-register',
    active: function () { return true; },
    tbody: 'vr-body',
    companyId: function () { return COMPANY; },
    canAdd: false,
    editable: function () { return false; },
    same: function () { return true; },
    validate: function () { return null; },
    columns: [
      { field: 'date', label: 'Date', type: 'text', filterType: 'date', sortable: true,
        display: function (v) { return v ? esc(v) : '<span class="pe-ro">—</span>'; } },
      { field: 'journal', label: 'Journal', type: 'text', filterType: 'text', sortable: true },
      { field: 'reference', label: 'Doc No', type: 'text', filterType: 'text', sortable: true },
      { field: 'description', label: 'Description', type: 'text', filterType: 'text', sortable: true,
        display: function (v) { return v ? esc(v) : '<span class="pe-ro">—</span>'; } },
      { field: 'total_debit', label: 'Amount', type: 'number', filterType: 'amount', sortable: true, align: 'right',
        display: amtDisplay },
      { field: 'status', label: 'Status', type: 'text', filterType: 'list', sortable: true,
        display: statusDisplay },
    ],
    list: {
      fetch: function () { return Promise.resolve(VR_ROWS); },
      map: function (r) { return Object.assign({}, r, { _key: r.batch_id }); }
    },
    onChrome: function () {}
  });

  // After load, wire drill-through data-href on each row + Enter key
  vrList.load().then(function () {
    var body = document.getElementById('vr-body');
    if (!body) return;

    body.querySelectorAll('tr[data-key]').forEach(function (tr) {
      var key = tr.getAttribute('data-key');
      var row = VR_ROWS.filter(function (r) { return r.batch_id === key; })[0];
      if (row) tr.setAttribute('data-href', drillHref(row));
    });

    // Enter on a focused row → drill through to parent frame
    body.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var tr = e.target.closest('tr[data-href]');
        if (tr) { e.preventDefault(); window.parent.location.href = tr.getAttribute('data-href'); }
      }
    });

    // Click on a row → drill through (mouse parity)
    body.addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-href]');
      if (!tr || e.target.closest('.fb-filter-btn') || e.target.closest('th')) return;
      if (e.target.tagName === 'A') return; // let rev-link anchors work
      e.preventDefault();
      window.parent.location.href = tr.getAttribute('data-href');
    });
  });
</script>
</body>
</html>`;
  return { tableHtml, rows: batches };
}

async function buildCF(query, company, start, end) {
  const rows = await query(`SELECT * FROM cf(?, ?, ?)`, [company, start, end]);
  let lastSection = null;
  let tableRows = '';
  for (const r of rows) {
    if (r.row_type === 'account' && r.section !== lastSection) {
      const sectionLabel = r.section === 'NonCash' ? 'Non-cash Activities (IAS 7.43)' : r.section;
      tableRows += `<tr class="section-header"><td colspan="3">${sectionLabel}</td></tr>`;
      lastSection = r.section;
    }
    const cls = r.row_type + (r.amount == 0 && r.row_type === 'account' ? ' zero' : '');
    const code = r.account_code || '';
    const name = r.row_type === 'total' ? `<strong>${r.account_name}</strong>` : r.account_name;
    const codeCell = code
      ? `<a href="/${company}/journal?t=gl&account=${encodeURIComponent(code)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}" target="_parent">${code}</a>`
      : code;
    tableRows += `<tr class="${cls}"><td>${codeCell}</td><td>${name}</td><td class="num">${fmt(r.amount)}</td></tr>`;
  }
  const tableHtml = `<table>
    <thead><tr><th>Code</th><th>Description</th><th class="num">Amount</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>`;
  return { tableHtml, rows };
}

async function buildSCE(query, company, start, end) {
  const rows = await query(`SELECT * FROM sce(?, ?, ?)`, [company, start, end]);
  let tableRows = rows.map(r => `<tr class="account">
    <td>${r.account_code ? `<a href="/${company}/journal?t=gl&account=${encodeURIComponent(r.account_code)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}" target="_parent">${r.account_code}</a>` : ''}</td><td>${r.account_name}</td>
    <td class="num">${fmt(r.opening_balance)}</td>
    <td class="num">${fmt(r.movements)}</td>
    <td class="num">${fmt(r.closing_balance)}</td>
  </tr>`).join('');
  const totOpen  = rows.reduce((s, r) => s + parseFloat(r.opening_balance || 0), 0);
  const totMvt   = rows.reduce((s, r) => s + parseFloat(r.movements       || 0), 0);
  const totClose = rows.reduce((s, r) => s + parseFloat(r.closing_balance || 0), 0);
  tableRows += `<tr class="total"><td></td><td><strong>TOTAL</strong></td>
    <td class="num">${fmt(totOpen)}</td>
    <td class="num">${fmt(totMvt)}</td>
    <td class="num">${fmt(totClose)}</td>
  </tr>`;
  const tableHtml = `<table>
    <thead><tr><th>Code</th><th>Account</th>
      <th class="num">Opening</th><th class="num">Movements</th><th class="num">Closing</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>`;
  return { tableHtml, rows };
}

async function buildIntegrity(query, company, start, end) {
  // P2-1: Resolve closing + RE accounts from jurisdiction pack, fallback to COA.
  let closingAccount = null;
  let reAccount = null;
  try {
    const coRows = await query(
      `SELECT jurisdiction FROM (SELECT *, ROW_NUMBER() OVER(PARTITION BY company_id ORDER BY created_at DESC) AS rn FROM companies WHERE company_id = ?) WHERE rn = 1`,
      [company]
    );
    if (coRows.length) {
      const { closingConfigFor } = require('../api/src/jurisdiction-packs');
      const cfg = closingConfigFor(coRows[0].jurisdiction);
      if (cfg) { closingAccount = cfg.closingAccount; reAccount = cfg.retainedEarningsAccount; }
    }
  } catch (e) { /* require may not resolve in all contexts — fallback below */ }
  // Fallback: discover closing account from COA
  if (!closingAccount) {
    const acctRows = await query(`SELECT account_code FROM accounts WHERE company_id = ? AND account_type = 'Closing' LIMIT 1`, [company]);
    if (acctRows.length) closingAccount = acctRows[0].account_code;
  }
  // Fallback: discover RE account from COA (Equity, not share capital)
  if (!reAccount) {
    const reRows2 = await query(`SELECT account_code FROM accounts WHERE company_id = ? AND account_type = 'Equity' AND account_subtype = 'Equity' AND account_name NOT LIKE '%Share Capital%' ORDER BY account_code LIMIT 1`, [company]);
    if (reRows2.length) reAccount = reRows2[0].account_code;
  }

  const rows1 = await query(`SELECT * FROM integrity(?, ?, ?)`, [company, start, end]);
  const rows2 = await query(`SELECT * FROM integrity_extended(?, ?, ?, ?)`, [company, start, end, closingAccount]);
  const allChecks = [...rows1, ...rows2];

  // Compute unallocated net income — same logic as buildBS
  const [niRow] = await query(
    `SELECT
       COALESCE((
         SELECT
           SUM(CASE WHEN a.account_type = 'Revenue' THEN je.credit_home - je.debit_home ELSE 0 END) -
           SUM(CASE WHEN a.account_type IN ('Expense','Cost of Sales') THEN je.debit_home - je.credit_home ELSE 0 END)
         FROM journal_entries je
         JOIN accounts a ON a.account_code = je.account_code AND a.company_id = je.company_id
         WHERE je.company_id = ? AND je.date <= ?
           AND a.account_type NOT IN ('Closing')
       ), 0) -
       COALESCE((
         SELECT SUM(je.debit_home - je.credit_home)
         FROM journal_entries je
         JOIN accounts a ON a.account_code = je.account_code AND a.company_id = je.company_id
         WHERE je.company_id = ? AND je.date <= ?
           AND a.account_type = 'Closing'
       ), 0) AS net_income`,
    [company, end, company, end]
  ).catch(() => [{ net_income: 0 }]);
  const netIncome = Number(niRow?.net_income || 0);

  // Adjust checks that are affected by unallocated net income
  for (const check of allChecks) {
    if (check.check_name === 'BS Balance' && check.status === 'FAIL' && netIncome !== 0) {
      const m = check.detail.match(/Assets: ([\d.]+) \| Liab\+Equity: ([\d.]+)/);
      if (m) {
        const assets = parseFloat(m[1]);
        const adjustedLiabEq = parseFloat(m[2]) + netIncome;
        if (Math.abs(adjustedLiabEq - assets) < 0.01) {
          check.status = 'OK';
          check.detail = `Assets: ${assets.toFixed(2)} | Liab+Equity: ${adjustedLiabEq.toFixed(2)} (incl. unallocated P&L: ${netIncome >= 0 ? '' : '-'}${Math.abs(netIncome).toFixed(2)})`;
        }
      }
    }
    if (check.check_name === 'P&L vs Closing Entry' && check.status === 'FAIL' && netIncome !== 0) {
      check.status = 'WARN';
      check.detail = check.detail + ' — unallocated, closing entry not yet posted';
    }
  }

  const statusColor = s => s === 'OK' ? '#2d8a2d' : s === 'WARN' ? '#cc7700' : '#cc2222';
  let tableRows = allChecks.map(r =>
    `<tr class="account">
      <td>${r.check_name}</td>
      <td style="color:${statusColor(r.status)};font-weight:700">${r.status}</td>
      <td>${r.detail}</td>
    </tr>`
  ).join('');

  const reRows = await query(`SELECT * FROM re_rollforward(?, ?, ?)`, [company, closingAccount, reAccount]);
  let reTable = '';
  if (reRows.length) {
    const dateStr = d => new Date(d).toISOString().slice(0, 10);
    const reHtml = reRows.map(r => {
      const contColor = r.pl_close_status === 'OK' ? '#2d8a2d' : '#cc2222';
      return `<tr class="account">
        <td>${r.period_name}</td>
        <td style="white-space:nowrap">${dateStr(r.start_date)} – ${dateStr(r.end_date)}</td>
        <td class="num">${fmt(r.opening_re)}</td>
        <td class="num">${fmt(r.pl_net)}</td>
        <td class="num">${fmt(r.closing_entry)}</td>
        <td class="num">${r.noncash_adj ? fmt(r.noncash_adj) : '—'}</td>
        <td class="num">${fmt(r.closing_re)}</td>
        <td style="color:${contColor};font-weight:700;text-align:center">${r.pl_close_status}</td>
      </tr>`;
    }).join('');
    reTable = `
      <h3 style="margin:24px 0 8px;font-size:11pt">Retained Earnings Roll-Forward</h3>
      <table>
        <thead><tr><th>Period</th><th>Dates</th>
          <th class="num">Opening RE</th><th class="num">P&amp;L Net</th>
          <th class="num">Closing Entry</th><th class="num">Non-cash Adj</th><th class="num">Closing RE</th>
          <th style="text-align:center">Status</th></tr></thead>
        <tbody>${reHtml}</tbody>
      </table>`;
  }

  const tableHtml = `
    <table>
      <thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
    ${reTable}`;

  return { tableHtml, rows: allChecks };
}

async function buildAPAging(query, company, _start, end) {
  let companyName = company;
  try {
    const [co] = await query(`SELECT company_name FROM companies WHERE company_id = ?`, [company]);
    if (co) companyName = co.company_name;
  } catch (_) {}

  const asOf = end;
  const tableHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AP Aging — freeBooks</title>
<link rel="stylesheet" href="/public/common.css?v=${_assetV('common.css')}">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', Arial, sans-serif; font-size: 10pt; color: #1a1a1a; background: #fff; }
  .page { max-width: min(94vw, 1600px); margin: 0; padding: 24px 32px; }
  .header { border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; margin-bottom: 24px; }
  /* On-screen this repeats page/tab chrome the app already shows (company,
     period) — hidden here, restored for print/PDF, since PDF export opens
     this exact standalone document raw (ia-restructure-3-spec.md §6.2). */
  .header { display: none; }
  @media print { .header { display: block; } }
  .company { font-size: 16pt; font-weight: 700; }
  .report-title { font-size: 13pt; color: #444; margin-top: 4px; }
  .period { font-size: 10pt; color: #666; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; margin-top: 4px; }
  th { text-align: right; font-size: 9pt; color: #555; text-transform: uppercase; border-bottom: 2px solid #ccc; padding: 6px 8px; }
  th:first-child { text-align: left; }
  td { padding: 6px 8px; border-bottom: 1px solid #f0f0f0; text-align: right; }
  td:first-child { text-align: left; }
  tr.total-row td { font-weight: 700; border-top: 2px solid #ccc; background: #f8f8f8; }
  .col-90plus { color: #cc2222; font-weight: 600; }
  /* Child rows: bill detail under a vendor */
  tr[data-child-of] td { font-size: 9pt; color: #555; background: #fafafa; padding: 4px 8px; }
  tr[data-child-of] td:first-child { padding-left: 24px; text-align: left; }
  tr[data-child-of][data-href] { cursor: pointer; }
  tr[data-child-of][data-href]:hover td { background: #f0f4ff; }
  tr[data-child-of] td.col-90plus { color: #cc2222; }
  /* FB.list keyboard-focus in the iframe */
  tr.nav-row-focus:not(.row-editing) > td {
    background: #18293f !important; color: #fff !important; outline: none;
  }
  tr.nav-row-focus:not(.row-editing) > td.col-90plus { color: #ff9999 !important; }
  /* FB.list fold caret */
  .fb-fold { display: inline-block; width: 14px; cursor: pointer; opacity: 0.6; font-size: 11px; }
  .fb-fold:hover { opacity: 1; }
  .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 9pt; color: #888; }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="company">${companyName}</div>
    <div class="report-title">AP Aging</div>
    <div class="period">As of ${asOf}</div>
  </div>
  <div class="table-wrap">
    <table class="edit-table">
      <thead>
        <tr>
          <th data-field="partner_name" style="text-align:left">Vendor</th>
          <th data-field="current" class="num">Current</th>
          <th data-field="1_30" class="num">1\u201330 days</th>
          <th data-field="31_60" class="num">31\u201360 days</th>
          <th data-field="61_90" class="num">61\u201390 days</th>
          <th data-field="90plus" class="num col-90plus">90+ days</th>
          <th data-field="total" class="num">Total</th>
        </tr>
      </thead>
      <tbody id="ap-body"></tbody>
      <tfoot id="ap-foot"></tfoot>
    </table>
  </div>
  <div class="footer">Generated: ${new Date().toISOString().slice(0, 10)} \u00b7 freeBooks</div>
</div>
<script src="/public/fb-core.js?v=${_assetV('fb-core.js')}"></script>
<script src="/public/fb-list.js?v=${_assetV('fb-list.js')}"></script>
<script>
  var COMPANY = ${JSON.stringify(company)};
  var AS_OF   = ${JSON.stringify(asOf)};

  function fmt(n) {
    if (!n || n === 0) return '';
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Group rows into vendor parents with bills as children.
  // Each vendor row carries computed bucket totals + _bills array.
  function groupByVendor(rows) {
    var vendors = {};
    var order = [];
    rows.forEach(function(r) {
      var name = r.partner_name || '(unknown)';
      if (!vendors[name]) {
        vendors[name] = {
          _key: name, _bills: [],
          partner_name: name,
          current: 0, '1_30': 0, '31_60': 0, '61_90': 0, '90plus': 0, total: 0
        };
        order.push(name);
      }
      var v = vendors[name];
      var bal = Number(r.balance_due || 0);
      v[r.bucket] = (v[r.bucket] || 0) + bal;
      v.total += bal;
      v._bills.push(r);
    });
    return order.sort().map(function(name) { return vendors[name]; });
  }

  // childRowHtml: one <td> per parent column, same order (7 columns).
  // Child rows get no fold caret (framework only prepends it to parent
  // rows). The first cell carries a padding-left nesting cue.
  function childRowHtml(parent, bill, idx) {
    var label = bill.vendor_ref || String(bill.date || '').slice(0, 10) || String(bill.bill_id || '').slice(0, 8);
    var bal = Number(bill.balance_due || 0);
    var html = '<td>' + esc(label) + '</td>';
    html += '<td>' + (bill.bucket === 'current' ? fmt(bal) : '') + '</td>';
    html += '<td>' + (bill.bucket === '1_30'    ? fmt(bal) : '') + '</td>';
    html += '<td>' + (bill.bucket === '31_60'   ? fmt(bal) : '') + '</td>';
    html += '<td>' + (bill.bucket === '61_90'   ? fmt(bal) : '') + '</td>';
    html += '<td' + (bill.bucket === '90plus' ? ' class="col-90plus"' : '') + '>' + (bill.bucket === '90plus' ? fmt(bal) : '') + '</td>';
    html += '<td>' + fmt(bal) + '</td>';
    return html;
  }

  var vendorRows = [];

  var agingList = FB.list.create({
    keysId: 'ap-aging',
    active: function () { return true; },
    tbody: 'ap-body',
    companyId: function () { return COMPANY; },
    canAdd: false,
    editable: function () { return false; },
    deletable: function () { return false; },
    same: function () { return true; },
    validate: function () { return null; },
    tree: true,
    children: function (vendorRow) { return vendorRow._bills; },
    foldKey: function (row) { return row._key; },
    columns: [
      { field: 'partner_name', label: 'Vendor', type: 'text', filterType: 'text', sortable: true,
        display: function (v) { return v ? esc(v) : ''; } },
      { field: 'current', label: 'Current', type: 'number', align: 'right', sortable: true,
        display: function (v) { return fmt(Number(v || 0)); } },
      { field: '1_30', label: '1\u201330 days', type: 'number', align: 'right', sortable: true,
        display: function (v) { return fmt(Number(v || 0)); } },
      { field: '31_60', label: '31\u201360 days', type: 'number', align: 'right', sortable: true,
        display: function (v) { return fmt(Number(v || 0)); } },
      { field: '61_90', label: '61\u201390 days', type: 'number', align: 'right', sortable: true,
        display: function (v) { return fmt(Number(v || 0)); } },
      { field: '90plus', label: '90+ days', type: 'number', align: 'right', sortable: true,
        display: function (v) { return fmt(Number(v || 0)); } },
      { field: 'total', label: 'Total', type: 'number', align: 'right', sortable: true,
        display: function (v) { return fmt(Number(v || 0)); } },
    ],
    childRowHtml: childRowHtml,
    list: {
      fetch: function () {
        return fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'bill.aging', companyId: COMPANY, asOfDate: AS_OF })
        }).then(function(r) { return r.json(); }).then(function(res) {
          var rows = res.data || res || [];
          if (!Array.isArray(rows)) rows = [];
          vendorRows = groupByVendor(rows);
          return vendorRows;
        });
      },
      map: function (r) { return Object.assign({}, r, { _key: r._key }); }
    },
    onChrome: function () {},
    // Override Enter on child rows: instead of the framework's fold-parent
    // behavior (openFocused → toggleFold for read-only tree rows), drill
    // through to the bill. extraBindings prepend to built-ins, so this
    // Enter wins when the focused row is a child (when-guard declines on
    // parent rows → built-in Enter fires → fold/unfold as expected).
    extraBindings: function (api) {
      return [
        { key: 'Enter', mode: 'NORMAL', hint: 'open bill', hintBar: true,
          when: function () {
            var d = api.focusedRow();
            return !!(d && d._childOf && d.bill_id);
          },
          run: function () {
            var d = api.focusedRow();
            if (!d || !d.bill_id) return;
            window.parent.location.href = '/' + COMPANY + '/bill/'
              + encodeURIComponent(d.bill_id)
              + '?from=ap-aging&asof=' + encodeURIComponent(AS_OF);
          }
        }
      ];
    }
  });

  agingList.load().then(function () {
    var body = document.getElementById('ap-body');
    if (!body) return;

    // Render totals row in tfoot
    var totals = { current: 0, '1_30': 0, '31_60': 0, '61_90': 0, '90plus': 0, total: 0 };
    vendorRows.forEach(function(v) {
      ['current','1_30','31_60','61_90','90plus','total'].forEach(function(k) {
        totals[k] += Number(v[k] || 0);
      });
    });
    var footHtml = '<tr class="total-row"><td>Total</td>'
      + '<td>' + fmt(totals.current) + '</td>'
      + '<td>' + fmt(totals['1_30']) + '</td>'
      + '<td>' + fmt(totals['31_60']) + '</td>'
      + '<td>' + fmt(totals['61_90']) + '</td>'
      + '<td class="col-90plus">' + fmt(totals['90plus']) + '</td>'
      + '<td>' + fmt(totals.total) + '</td></tr>';
    var foot = document.getElementById('ap-foot');
    if (foot) foot.innerHTML = footHtml;

    // Click on a child row → drill through (mouse parity for the Enter
    // binding above). Delegated on tbody so it survives re-renders. The
    // framework's own click handler sets focus (nav.set) before returning
    // for read-only child rows — no conflict. Fold-caret clicks are
    // stopPropagation'd by the framework, so they don't reach here.
    body.addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-child-of]');
      if (!tr) return;
      if (e.target.closest('.fb-fold')) return;
      var idx = +tr.getAttribute('data-idx');
      var billId = resolveChildBillId(idx);
      if (billId) {
        e.preventDefault();
        window.parent.location.href = '/' + COMPANY + '/bill/'
          + encodeURIComponent(billId)
          + '?from=ap-aging&asof=' + encodeURIComponent(AS_OF);
      }
    });
  }).catch(function(e) {
    var area = document.getElementById('ap-body');
    if (area) area.innerHTML = '<tr><td colspan="7" style="color:#cc2222">Error: ' + esc(e.message) + '</td></tr>';
  });

  // Resolve a child row's bill_id from its flat data-idx in the merged array.
  // The merged array is: parent[0], (children if unfolded), parent[1], ...
  // Walk vendorRows tracking the running index to find the child at flatIdx.
  function resolveChildBillId(flatIdx) {
    var idx = 0;
    for (var vi = 0; vi < vendorRows.length; vi++) {
      var v = vendorRows[vi];
      idx++; // parent row
      // Children only exist in the merged array if the vendor is unfolded.
      // We don't know fold state here, so we check if a child exists at
      // this idx position — if the querySelector matched a [data-child-of]
      // tr, the children ARE in the DOM (vendor is unfolded).
      for (var bi = 0; bi < v._bills.length; bi++) {
        if (idx === flatIdx) return v._bills[bi].bill_id;
        idx++;
      }
    }
    return null;
  }
</script>
</body>
</html>`;
  return { tableHtml, rows: [] };
}

// ── AP Control Reconciliation (P2-3) ────────────────────────────────────────
async function buildApControl(query, company, _start, end) {
  let companyName = company;
  try {
    const [co] = await query(`SELECT company_name FROM companies WHERE company_id = ?`, [company]);
    if (co) companyName = co.company_name;
  } catch (_) {}

  let rows = [];
  try {
    rows = await query(`SELECT * FROM ap_control(?, ?)`, [company, end]);
  } catch (_) {
    // macro not available — render zero state
  }

  // Zero rows stay permanent: render one row with all zeros and status OK
  if (!rows || rows.length === 0) {
    rows = [{
      ap_account: '',
      account_name: '',
      gl_balance: 0,
      subledger_balance: 0,
      difference: 0,
      status: 'OK',
      bill_count: 0,
      posted_total: 0,
      paid_total: 0,
    }];
  }

  const statusColor = { OK: '#2d8a2d', WARN: '#cc7700', FAIL: '#cc2222' };

  const tableRows = rows.map((r) => {
    const status = r.status || 'OK';
    const color = statusColor[status] || '#1a1a1a';
    return `<tr>
      <td>${r.ap_account || ''}</td>
      <td>${r.account_name || ''}</td>
      <td class="num">${fmt(Math.round(Number(r.gl_balance || 0)))}</td>
      <td class="num">${fmt(Math.round(Number(r.subledger_balance || 0)))}</td>
      <td class="num">${fmt(Math.round(Number(r.difference || 0)))}</td>
      <td style="color:${color};font-weight:600">${status}</td>
      <td class="num">${Number(r.bill_count || 0)}</td>
      <td class="num">${fmt(Math.round(Number(r.posted_total || 0)))}</td>
      <td class="num">${fmt(Math.round(Number(r.paid_total || 0)))}</td>
    </tr>`;
  }).join('');

  const tableHtml = `<table>
    <thead><tr>
      <th>AP Account</th><th>Account Name</th>
      <th class="num">GL Balance</th><th class="num">Subledger</th>
      <th class="num">Diff</th><th>Status</th>
      <th class="num">Bills</th><th class="num">Posted</th><th class="num">Paid</th>
    </tr></thead>
    <tbody>${tableRows}</tbody>
  </table>`;

  const html = htmlPage('AP Control Reconciliation', companyName, `As of ${end}`, tableHtml, { wide: true });
  return { tableHtml: html, rows };
}

// ── Report type dispatch ──────────────────────────────────────────────────────
const REPORT_TITLES = {
  pl: 'Profit & Loss',
  bs: 'Balance Sheet',
  tb: 'Trial Balance',
  gl: 'General Ledger',
  journal: 'Journal',
  'voucher-register': 'Voucher Register',
  cf: 'Cash Flow Statement',
  sce: 'Statement of Changes in Equity',
  integrity: 'Integrity Checks',
  'ap-control': 'AP Control Reconciliation',
};

async function buildReport(query, company, reportType, startDate, endDate, opts = {}) {
  switch (reportType) {
    case 'pl':        return buildPL(query, company, startDate, endDate);
    case 'bs':        return buildBS(query, company, startDate, endDate);
    case 'tb':        return buildTB(query, company, startDate, endDate);
    case 'gl':        return buildGL(query, company, startDate, endDate, opts.account);
    case 'journal':          return buildJournal(query, company, startDate, endDate);
    case 'voucher-register': return buildVoucherRegister(query, company, startDate, endDate);
    case 'cf':        return buildCF(query, company, startDate, endDate);
    case 'sce':       return buildSCE(query, company, startDate, endDate);
    case 'integrity': return buildIntegrity(query, company, startDate, endDate);
    case 'ap-aging':  return buildAPAging(query, company, startDate, endDate);
    case 'ap-control': return buildApControl(query, company, startDate, endDate);
    default:          throw new Error(`Unknown report type: ${reportType}`);
  }
}

// ── renderReport ──────────────────────────────────────────────────────────────
/**
 * Render a single-period report.
 *
 * @param {Function} query  async (sql, params[]) => rows[]
 * @param {string}   company
 * @param {string}   reportType  pl|bs|tb|gl|journal|cf|sce|integrity
 * @param {string}   startDate   YYYY-MM-DD
 * @param {string}   endDate     YYYY-MM-DD
 * @returns {{ html: string, csv: string, filename: string }}
 */
async function renderReport(query, company, reportType, startDate, endDate, opts = {}) {
  const title = REPORT_TITLES[reportType] || reportType;
  const { tableHtml, rows } = await buildReport(query, company, reportType, startDate, endDate, opts);

  // If builder returned a full self-contained page, use it directly (skip htmlPage wrapper)
  if (tableHtml && tableHtml.trimStart().startsWith('<!DOCTYPE')) {
    const csvOut = rows && rows.length ? toCSV(rows) : '';
    const filename = `${reportType}_${startDate}_${endDate}`;
    return { html: tableHtml, csv: csvOut, filename };
  }

  // Get company name
  let companyName = company;
  try {
    const [co] = await query(`SELECT company_name FROM companies WHERE company_id = ?`, [company]);
    if (co) companyName = co.company_name;
  } catch (_) {}

  const period = reportType === 'bs' ? `As at ${endDate}` : `${startDate} to ${endDate}`;
  // PL/BS/CF/SCE stay reading-width — a handful of narrow amount columns,
  // same convention as printed financial statements in other accounting
  // software (QBO/Xero keep these narrower even where their own transaction
  // lists/registers go full-width). TB, wider (6 columns incl. a long
  // Account-name one), also shares a tab strip with GL/Journal/Voucher
  // Register on the Journal hub page — all of which go wide below — so it
  // goes wide too, for a consistent width across that one tab group.
  const htmlOut = htmlPage(title, companyName, period, tableHtml, { wide: reportType === 'integrity' || reportType === 'tb' });
  const csvOut  = toCSV(rows);
  const filename = `${reportType}_${startDate}_${endDate}`;

  return { html: htmlOut, csv: csvOut, filename };
}

// ── Date range helpers ────────────────────────────────────────────────────────
/**
 * Generate periods between start and end, stepping by month or year.
 * @param {string} start YYYY-MM-DD
 * @param {string} end   YYYY-MM-DD
 * @param {string} step  'month' | 'year'
 * @returns {{ start: string, end: string, label: string }[]}
 */
function generatePeriods(start, end, step) {
  const periods = [];
  let cur = new Date(start + 'T00:00:00Z');
  const endD = new Date(end + 'T00:00:00Z');

  while (cur <= endD) {
    let periodEnd;
    if (step === 'month') {
      // End of this month
      periodEnd = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0));
      if (periodEnd > endD) periodEnd = endD;
    } else {
      // End of this year or the provided end
      periodEnd = new Date(Date.UTC(cur.getUTCFullYear(), 11, 31));
      if (periodEnd > endD) periodEnd = endD;
    }

    const pStart = cur.toISOString().slice(0, 10);
    const pEnd   = periodEnd.toISOString().slice(0, 10);
    const label  = step === 'month'
      ? cur.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
      : String(cur.getUTCFullYear());

    periods.push({ start: pStart, end: pEnd, label });

    // Advance cursor
    if (step === 'month') {
      cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    } else {
      cur = new Date(Date.UTC(cur.getUTCFullYear() + 1, 0, 1));
    }
  }

  return periods;
}

function generateYoYPeriods(start, end) {
  const startD = new Date(start + 'T00:00:00Z');
  const endD   = new Date(end   + 'T00:00:00Z');
  const diffDays = (endD - startD) / (864e5);
  if (diffDays < 364 || diffDays > 366) return null; // must be ~1 year

  const periods = [];
  // 5 columns: [current-4, current-3, current-2, current-1, current]
  for (let i = 4; i >= 0; i--) {
    const s = new Date(Date.UTC(startD.getUTCFullYear() - i, startD.getUTCMonth(), startD.getUTCDate()));
    const e = new Date(Date.UTC(endD.getUTCFullYear()   - i, endD.getUTCMonth(),   endD.getUTCDate()));
    periods.push({
      start: s.toISOString().slice(0, 10),
      end:   e.toISOString().slice(0, 10),
      label: 'FY' + e.getUTCFullYear(),
    });
  }
  return periods;
}

// ── renderComparative ─────────────────────────────────────────────────────────
/**
 * Render a multi-period (comparative) report.
 *
 * @param {Function} query
 * @param {string}   company
 * @param {string}   reportType
 * @param {{ start: string, end: string, label: string }[]} periods
 * @returns {{ html: string, csv: string, filename: string }}
 */
async function renderComparative(query, company, reportType, periods) {
  if (!periods || periods.length === 0) throw new Error('No periods provided for comparative report');

  const title = REPORT_TITLES[reportType] || reportType;
  let companyName = company;
  try {
    const [co] = await query(`SELECT company_name FROM companies WHERE company_id = ?`, [company]);
    if (co) companyName = co.company_name;
  } catch (_) {}

  // Only PL, BS, TB support sensible comparative pivots; others fall back to single period
  const PIVOT_SUPPORTED = ['pl', 'bs', 'cf'];

  if (!PIVOT_SUPPORTED.includes(reportType)) {
    // For GL, journal, cf, sce, integrity: just render the full range
    const startDate = periods[0].start;
    const endDate   = periods[periods.length - 1].end;
    return renderReport(query, company, reportType, startDate, endDate);
  }

  // Fetch data for each period
  const periodData = await Promise.all(periods.map(p => buildReport(query, company, reportType, p.start, p.end)));

  // Pivot: gather all unique row keys
  // Key = account_code + account_name (or section/row_type for summary rows)
  const valueField = reportType === 'tb' ? 'net_balance'
                   : reportType === 'bs' ? 'balance'
                   : 'amount'; // pl, cf, sce

  // Build a map of rowKey -> { meta, periodValues }
  const rowMap = new Map();

  for (let pi = 0; pi < periodData.length; pi++) {
    const { rows } = periodData[pi];
    for (const r of rows) {
      const key = `${r.row_type}||${r.account_code || ''}||${r.account_name || ''}`;
      if (!rowMap.has(key)) {
        rowMap.set(key, { meta: r, values: new Array(periods.length).fill(null) });
      }
      rowMap.get(key).values[pi] = r[valueField];
    }
  }

  // Render comparative HTML table
  const periodHeaders = periods.map(p => `<th class="num">${p.label}</th>`).join('');
  let tableRows = '';
  let lastSection = null;

  const entries = [...rowMap.entries()];
  if (reportType === 'pl' || reportType === 'cf') {
    entries.sort(([, a], [, b]) => {
      const s1 = (a.meta.sort1 ?? 99) - (b.meta.sort1 ?? 99);
      if (s1 !== 0) return s1;
      return (a.meta.sort2 ?? 99) - (b.meta.sort2 ?? 99);
    });
  }
  if (reportType === 'bs') {
    const typeOrder = { Asset: 0, Equity: 1, Liability: 2 };
    entries.sort(([, a], [, b]) => {
      const tA = typeOrder[a.meta.account_type] ?? 99;
      const tB = typeOrder[b.meta.account_type] ?? 99;
      if (tA !== tB) return tA - tB;
      const totA = a.meta.row_type === 'type_total' ? 1 : 0;
      const totB = b.meta.row_type === 'type_total' ? 1 : 0;
      if (totA !== totB) return totA - totB;
      const catA = a.meta.bs_category || '';
      const catB = b.meta.bs_category || '';
      if (catA < catB) return -1;
      if (catA > catB) return 1;
      const rtOrder = { account: 0, subtotal: 1 };
      return (rtOrder[a.meta.row_type] ?? 0) - (rtOrder[b.meta.row_type] ?? 0);
    });
  }

  for (const [, { meta: r, values }] of entries) {
    // Section header for PL
    if (reportType === 'pl' && r.row_type === 'account' && r.section !== lastSection) {
      tableRows += `<tr class="section-header"><td></td><td colspan="${1 + periods.length}">${r.section}</td></tr>`;
      lastSection = r.section;
    }
    if (reportType === 'bs' && r.row_type !== 'type_total' && r.account_type !== lastSection) {
      tableRows += `<tr class="section-header"><td></td><td colspan="${1 + periods.length}">${r.account_type}</td></tr>`;
      lastSection = r.account_type;
    }
    if (reportType === 'cf' && r.row_type === 'account' && r.section !== lastSection && !['Net Change','Cash'].includes(r.section)) {
      const cfSecLabel = r.section === 'NonCash' ? 'Non-cash Activities (IAS 7.43)' : r.section;
      tableRows += `<tr class="section-header"><td></td><td colspan="${1 + periods.length}">${cfSecLabel}</td></tr>`;
      lastSection = r.section;
    }

    const cls = r.row_type;
    const code = r.account_code || '';
    const name = (r.row_type === 'total' || r.row_type === 'subtotal' || r.row_type === 'type_total')
      ? `<strong>${r.account_name}</strong>`
      : r.account_name;

    const valCells = values.map(v => `<td class="num">${fmt(v)}</td>`).join('');
    tableRows += `<tr class="${cls}"><td>${code}</td><td>${name}</td>${valCells}</tr>`;
  }

  // BS: append TOTAL EQUITY + LIABILITIES footer row
  if (reportType === 'bs') {
    const eqLiabEntries = entries.filter(([, { meta: r }]) =>
      r.row_type === 'type_total' && /equity|liabilit/i.test(r.account_name));
    const footerCells = periods.map((_, pi) => {
      const sum = eqLiabEntries.reduce((s, [, { values }]) => s + parseFloat(values[pi] || 0), 0);
      return `<td class="num">${fmt(sum)}</td>`;
    }).join('');
    tableRows += `<tr class="total"><td></td><td><strong>TOTAL EQUITY + LIABILITIES</strong></td>${footerCells}</tr>`;
  }

  const tableHtml = `<table>
    <thead><tr><th>Code</th><th>Description</th>${periodHeaders}</tr></thead>
    <tbody>${tableRows}</tbody>
  </table>`;

  const periodLabel = `${periods[0].start} to ${periods[periods.length - 1].end}`;
  const html = htmlPage(title, companyName, periodLabel, tableHtml, { wide: true });

  // CSV: flatten with a Period column
  const csvRows = [];
  for (const [, { meta: r, values }] of rowMap) {
    for (let pi = 0; pi < periods.length; pi++) {
      csvRows.push({
        period: periods[pi].label,
        period_start: periods[pi].start,
        period_end: periods[pi].end,
        account_code: r.account_code || '',
        account_name: r.account_name || '',
        row_type: r.row_type,
        value: values[pi],
      });
    }
  }
  const csv = toCSV(csvRows);
  const filename = `${reportType}_${periods[0].start}_${periods[periods.length - 1].end}`;

  return { html, csv, filename };
}

async function generateFiscalPeriods(query, company) {
  const rows = await query(
    `SELECT period_name, start_date, end_date FROM periods WHERE company_id = ? ORDER BY start_date ASC`,
    [company]
  );
  const toYMD = d => { if (!d) return ''; const dt = (d instanceof Date) ? d : new Date(d); return dt.toISOString().slice(0, 10); };
  return rows.map(p => ({ start: toYMD(p.start_date), end: toYMD(p.end_date), label: p.period_name }));
}

module.exports = { renderReport, renderComparative, generatePeriods, generateYoYPeriods, generateFiscalPeriods, REPORT_TITLES, toCSV, htmlPage };
