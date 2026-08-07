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

// ── Number formatting ─────────────────────────────────────────────────────────
function fmt(n) {
  if (n === null || n === undefined) return '';
  const num = parseFloat(n);
  if (isNaN(num)) return '';
  const abs = Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return num < 0 ? `(${abs})` : abs;
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
      ? `<a href="/${company}/reports?t=gl&account=${encodeURIComponent(code)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}" target="_parent">${code}</a>`
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
      ? `<a href="/${company}/reports?t=gl&account=${encodeURIComponent(code)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}" target="_parent">${code}</a>`
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
    <td><a href="/${company}/reports?t=gl&account=${encodeURIComponent(r.account_code)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}" target="_parent">${r.account_code}</a></td><td>${r.account_name}</td><td>${r.account_type}</td>
    <td class="num">${fmt(r.total_debit)}</td>
    <td class="num">${fmt(r.total_credit)}</td>
    <td class="num">${fmt(r.net_balance)}</td>
  </tr>`).join('');
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

async function buildGL(query, company, start, end, account) {
  let companyName = company;
  try {
    const [co] = await query(`SELECT company_name FROM companies WHERE company_id = ?`, [company]);
    if (co) companyName = co.company_name;
  } catch (_) {}

  let rows = await query(`SELECT * FROM gl(?, ?, ?)`, [company, start, end]);
  if (account) rows = rows.filter(r => r.account_code === account);
  const accountAttr = String(account || '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let lastAcct = null;
  let runBal = 0;
  let tableRows = '';
  for (const r of rows) {
    if (r.account_code !== lastAcct) {
      if (lastAcct !== null) {
        tableRows += `<tr class="subtotal" data-account="${lastAcct}"><td></td><td></td><td>Closing Balance</td><td class="num"></td><td class="num"></td><td class="num">${fmt(runBal)}</td></tr>
        <tr data-account="${lastAcct}"><td colspan="6" style="padding:4px 0"></td></tr>`;
      }
      runBal = 0;
      tableRows += `<tr class="section-header" data-account="${r.account_code}"><td colspan="6">${r.account_code} — ${r.account_name || ''}</td></tr>`;
      lastAcct = r.account_code;
    }
    if (r.batch_id === 'Opening Balance') {
      const obAmt = parseFloat(r.debit_home || r.debit || 0) - parseFloat(r.credit_home || r.credit || 0);
      runBal = obAmt;
      tableRows += `<tr class="subtotal" data-account="${r.account_code}">
        <td></td><td colspan="2" style="font-style:italic">Opening Balance</td>
        <td class="num"></td><td class="num"></td><td class="num">${fmt(runBal)}</td>
      </tr>`;
    } else {
      runBal += parseFloat(r.debit_home || r.debit || 0) - parseFloat(r.credit_home || r.credit || 0);
      const dateStr = new Date(r.date).toISOString().slice(0, 10);
      tableRows += `<tr class="account" data-account="${r.account_code}">
        <td>${dateStr}</td><td><a href="/${company}/journal/new?batch=${encodeURIComponent(r.batch_id)}&from=gl" target="_parent">${r.reference || r.batch_id}</a></td><td>${r.description || ''}</td>
        <td class="num">${fmt(r.debit_home || r.debit)}</td><td class="num">${fmt(r.credit_home || r.credit)}</td>
        <td class="num">${fmt(runBal)}</td>
      </tr>`;
    }
  }
  if (lastAcct !== null) {
    tableRows += `<tr class="subtotal" data-account="${lastAcct}"><td></td><td></td><td>Closing Balance</td><td class="num"></td><td class="num"></td><td class="num">${fmt(runBal)}</td></tr>`;
  }

  const tableHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>General Ledger — freeBooks</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', Arial, sans-serif; font-size: 10pt; color: #1a1a1a; background: #fff; }
  .page { max-width: 1200px; margin: 0; padding: 24px 32px; }
  .header { border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; margin-bottom: 24px; }
  .company { font-size: 16pt; font-weight: 700; }
  .report-title { font-size: 13pt; color: #444; margin-top: 4px; }
  .period { font-size: 10pt; color: #666; margin-top: 2px; }
  .filter-bar { background: #f8f8f8; border: 1px solid #eee; border-radius: 4px; padding: 14px 16px; margin-bottom: 18px; }
  .filter-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .filter-row label { font-size: 9pt; color: #555; font-weight: 600; }
  .filter-row input { padding: 6px 10px; border: 1px solid #ccc; border-radius: 3px; font-size: 10pt; }
  .filter-row button { padding: 6px 18px; background: #1a1a1a; color: #fff; border: none; border-radius: 3px; font-size: 10pt; font-weight: 600; cursor: pointer; }
  .filter-row button.clear { background: #888; }
  .filter-row button:hover { opacity: .85; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 9pt; text-transform: uppercase; letter-spacing: .05em; color: #555; border-bottom: 1px solid #ccc; padding: 6px 8px; }
  th.num { text-align: right; }
  td { padding: 5px 8px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.section-header td { font-weight: 700; font-size: 10pt; text-transform: uppercase; background: #f4f4f4; letter-spacing: .03em; padding: 8px; }
  tr.subtotal td { font-weight: 600; background: #fafafa; }
  tr.account:hover td { background: #fafafa; }
  .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 9pt; color: #888; }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="company">${companyName}</div>
    <div class="report-title">General Ledger</div>
    <div class="period">${start} to ${end}</div>
  </div>
  <div class="filter-bar">
    <div class="filter-row">
      <label>Account Code:</label>
      <input type="text" id="gl-account" placeholder="e.g. 101414" maxlength="20" style="width:130px" value="${accountAttr}">
      <button onclick="applyGLFilter()">Search</button>
      <button class="clear" onclick="clearGLFilter()">Clear</button>
    </div>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Date</th><th>Ref</th><th>Description</th>
        <th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th>
      </tr></thead>
      <tbody id="gl-body">${tableRows}</tbody>
    </table>
  </div>
  <div class="footer">Generated: ${new Date().toISOString().slice(0, 10)} · freeBooks</div>
</div>
<script>
  function applyGLFilter() {
    var code = document.getElementById('gl-account').value.trim().toUpperCase();
    document.querySelectorAll('#gl-body tr').forEach(function(tr) {
      if (!code) { tr.style.display = ''; return; }
      var acct = (tr.getAttribute('data-account') || '').toUpperCase();
      tr.style.display = (acct === code) ? '' : 'none';
    });
  }
  function clearGLFilter() {
    document.getElementById('gl-account').value = '';
    document.querySelectorAll('#gl-body tr').forEach(function(tr) { tr.style.display = ''; });
  }
  document.getElementById('gl-account').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') applyGLFilter();
  });
</script>
</body>
</html>`;
  return { tableHtml, rows };
}

async function buildJournal(query, company, start, end) {
  let companyName = company;
  try {
    const [co] = await query(`SELECT company_name FROM companies WHERE company_id = ?`, [company]);
    if (co) companyName = co.company_name;
  } catch (_) {}
  const tableHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Journal Report — freeBooks</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', Arial, sans-serif; font-size: 10pt; color: #1a1a1a; background: #fff; }
  .page { max-width: 1200px; margin: 0; padding: 24px 32px; }
  .header { border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; margin-bottom: 24px; }
  .company { font-size: 16pt; font-weight: 700; }
  .report-title { font-size: 13pt; color: #444; margin-top: 4px; }
  .period { font-size: 10pt; color: #666; margin-top: 2px; }
  .filter-bar { background: #f8f8f8; border: 1px solid #eee; border-radius: 4px; padding: 14px 16px; margin-bottom: 18px; }
  .filter-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
  .filter-row:last-child { margin-bottom: 0; }
  .filter-row label { font-size: 9pt; color: #555; font-weight: 600; min-width: 80px; }
  .filter-row input, .filter-row select { padding: 6px 10px; border: 1px solid #ccc; border-radius: 3px; font-size: 10pt; }
  .filter-row button { padding: 6px 18px; background: #1a1a1a; color: #fff; border: none; border-radius: 3px; font-size: 10pt; font-weight: 600; cursor: pointer; }
  .filter-row button:hover { background: #333; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { text-align: left; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.05em; color: #555; border-bottom: 1px solid #ccc; padding: 6px 8px; cursor: pointer; user-select: none; }
  th:hover { background: #f5f5f5; }
  th.sortable::after { content: ' ↕'; color: #aaa; font-size: 8pt; }
  th.sort-asc::after { content: ' ↑'; color: #1a1a1a; font-size: 8pt; font-weight: 700; }
  th.sort-desc::after { content: ' ↓'; color: #1a1a1a; font-size: 8pt; font-weight: 700; }
  th.num { text-align: right; }
  td { padding: 5px 8px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr:hover td { background: #fafafa; }
  .no-results { text-align: center; color: #888; padding: 20px; }
  .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 9pt; color: #888; }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="company">${companyName}</div>
    <div class="report-title">Journal Report</div>
    <div class="period">${start || ''} to ${end || ''}</div>
  </div>

  <div class="filter-bar">
    <div class="filter-row">
      <label>Journal Code:</label>
      <input type="text" id="f-journal" placeholder="e.g. BANK" maxlength="10" style="width: 120px;">
      <label style="margin-left: 20px;">Account Code:</label>
      <input type="text" id="f-account" placeholder="e.g. 401000" maxlength="20" style="width: 120px;">
      <button onclick="doSearch()" style="margin-left: 20px;">Search</button>
      <button onclick="clearFilters()" style="background: #888;">Clear</button>
    </div>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th class="sortable" onclick="setSort('date')">Date</th>
          <th class="sortable" onclick="setSort('reference')">Reference</th>
          <th class="sortable" onclick="setSort('account_code')">Account</th>
          <th style="width: 200px;">Account Name</th>
          <th style="width: 250px;">Description</th>
          <th class="num sortable" onclick="setSort('debit')">Debit</th>
          <th class="num sortable" onclick="setSort('credit')">Credit</th>
        </tr>
      </thead>
      <tbody id="table-body">
        <tr><td colspan="7" class="no-results">Loading…</td></tr>
      </tbody>
    </table>
  </div>

  <div class="footer">Generated: ${new Date().toISOString().slice(0, 10)} · freeBooks</div>
</div>

<script>
  var currentSort = { sortBy: 'date', sortDir: 'DESC' };
  var currentFilters = { dateFrom: '${start}', dateTo: '${end}' };
  var accountsMap = {};
  
  // Pre-fetch accounts, then load journal (ensures account names are ready)
  fetch('/api/${company}/accounts')
    .then(function(r) { return r.json(); })
    .then(function(rows) {
      if (Array.isArray(rows)) {
        rows.forEach(function(a) {
          if (a.account_code && a.account_name) {
            accountsMap[a.account_code] = a.account_name;
          }
        });
      }
      loadJournal();
    })
    .catch(function() { loadJournal(); });
  
  function doSearch() {
    currentFilters = {
      dateFrom: '${start}',
      dateTo:   '${end}',
      accountCode:  document.getElementById('f-account').value.trim(),
      journalCode:  document.getElementById('f-journal').value.trim()
    };
    loadJournal();
  }
  
  function clearFilters() {
    document.getElementById('f-journal').value = '';
    document.getElementById('f-account').value = '';
    currentFilters = { dateFrom: '${start}', dateTo: '${end}' };
    currentSort = { sortBy: 'date', sortDir: 'DESC' };
    loadJournal();
  }
  
  function setSort(column) {
    if (currentSort.sortBy === column) {
      currentSort.sortDir = currentSort.sortDir === 'ASC' ? 'DESC' : 'ASC';
    } else {
      currentSort.sortBy = column;
      currentSort.sortDir = 'DESC';
    }
    updateSortIndicators();
    loadJournal();
  }
  
  function updateSortIndicators() {
    document.querySelectorAll('th.sortable').forEach(function(th) {
      th.classList.remove('sort-asc', 'sort-desc');
    });
    var activeHeader = Array.from(document.querySelectorAll('th.sortable')).find(function(th) {
      var col = th.textContent.toLowerCase().trim();
      if (currentSort.sortBy === 'date' && col.includes('date')) return true;
      if (currentSort.sortBy === 'reference' && col.includes('reference')) return true;
      if (currentSort.sortBy === 'account_code' && col.includes('account')) return true;
      if (currentSort.sortBy === 'debit' && col.includes('debit')) return true;
      if (currentSort.sortBy === 'credit' && col.includes('credit')) return true;
      return false;
    });
    if (activeHeader) {
      activeHeader.classList.add(currentSort.sortDir === 'ASC' ? 'sort-asc' : 'sort-desc');
    }
  }
  
  function loadJournal() {
    var body = document.getElementById('table-body');
    body.innerHTML = '<tr><td colspan="7" class="no-results">Loading…</td></tr>';
    
    var payload = Object.assign({}, currentFilters, currentSort, { companyId: '${company}', action: 'journal.list', limit: 500 });
    
    fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      var rows = res.data || res || [];
      if (!Array.isArray(rows) || rows.length === 0) {
        body.innerHTML = '<tr><td colspan="7" class="no-results">No entries found.</td></tr>';
        return;
      }
      
      var html = '';
      rows.forEach(function(r) {
        var dateStr = r.date ? new Date(r.date).toISOString().slice(0, 10) : '';
        var debit = parseFloat(r.debit || 0).toFixed(2);
        var credit = parseFloat(r.credit || 0).toFixed(2);
        var desc = (r.description || '').substring(0, 80);
        html += '<tr>' +
          '<td>' + dateStr + '</td>' +
          '<td><a href="/${company}/journal/new?batch=' + encodeURIComponent(r.batch_id || '') + '&from=journal" target="_parent">' + (r.reference || r.batch_id || '') + '</a></td>' +
          '<td>' + (r.account_code || '') + '</td>' +
          '<td>' + (accountsMap[r.account_code] || '') + '</td>' +
          '<td>' + desc + '</td>' +
          '<td class="num">' + (debit !== '0.00' ? debit : '') + '</td>' +
          '<td class="num">' + (credit !== '0.00' ? credit : '') + '</td>' +
          '</tr>';
      });
      body.innerHTML = html;
    })
    .catch(function(e) {
      body.innerHTML = '<tr><td colspan="7" class="no-results">Error loading journal entries.</td></tr>';
      console.error(e);
    });
  }
  
  updateSortIndicators();
  // loadJournal() is triggered after accounts fetch completes (above)
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
  const batches = await query(
    `SELECT
       batch_id,
       MIN(date)                                   AS date,
       MIN(reference)                              AS reference,
       MIN(description)                            AS description,
       MIN(source)                                 AS source,
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
     ORDER BY MIN(date) DESC, batch_id`,
    [company, start, end]
  );

  const tableHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Transaction Register — freeBooks</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', Arial, sans-serif; font-size: 10pt; color: #1a1a1a; background: #fff; }
  .page { max-width: 1200px; margin: 0; padding: 24px 32px; }
  .header { border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; margin-bottom: 18px; }
  .company { font-size: 16pt; font-weight: 700; }
  .report-title { font-size: 13pt; color: #444; margin-top: 4px; }
  .period { font-size: 10pt; color: #666; margin-top: 2px; }
  .filter-bar { background: #f8f8f8; border: 1px solid #eee; border-radius: 4px; padding: 12px 16px; margin-bottom: 16px; }
  .filter-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .filter-row label { font-size: 9pt; color: #555; font-weight: 600; }
  .filter-row input { padding: 5px 8px; border: 1px solid #ccc; border-radius: 3px; font-size: 10pt; }
  .filter-row button { padding: 5px 16px; background: #1a1a1a; color: #fff; border: none; border-radius: 3px; font-size: 10pt; font-weight: 600; cursor: pointer; }
  .filter-row button:hover { background: #333; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th { text-align: left; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.05em; color: #555; border-bottom: 1px solid #ccc; padding: 6px 8px; }
  th.num { text-align: right; }
  td { padding: 5px 8px; border-bottom: 1px solid #f0f0f0; vertical-align: middle; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr:hover td { background: #fafafa; }
  .no-results { text-align: center; color: #888; padding: 20px; }
  .footer { margin-top: 28px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 9pt; color: #888; }
  tr[data-href] { cursor: pointer; }
  tr[data-href]:hover td { background: #f0f4ff; }
  tr[data-href]:focus { outline: 2px solid #3730a3; outline-offset: -2px; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 8.5pt; font-weight: 600; text-transform: uppercase; letter-spacing: .02em; }
  .b-posted   { background: #e8f5e9; color: #2e7d32; }
  .b-reversed { background: #ffebee; color: #c62828; }
  .b-reversal { background: #fff3e0; color: #e65100; }
  .rev-link { color: #e65100; text-decoration: underline; font-size: 9pt; }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="company">${companyName}</div>
    <div class="report-title">Transaction Register</div>
    <div class="period">${start || ''} to ${end || ''}</div>
  </div>

  <div class="filter-bar">
    <div class="filter-row">
      <label>From:</label>
      <input type="date" id="vr-start" value="${start || ''}">
      <label>To:</label>
      <input type="date" id="vr-end" value="${end || ''}">
      <button onclick="vrRequery()">Apply</button>
    </div>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Reference</th>
          <th>Description</th>
          <th class="num">Amount</th>
          <th>Source</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody id="vr-body"></tbody>
    </table>
  </div>

  <div class="footer">Generated: ${new Date().toISOString().slice(0, 10)} · freeBooks · Transaction Register</div>
</div>

<script>
  var COMPANY = ${JSON.stringify(company)};
  var VR_START = ${JSON.stringify(start || '')};
  var VR_END   = ${JSON.stringify(end || '')};
  var BATCHES  = ${JSON.stringify(batches.map(b => ({
    batch_id: b.batch_id,
    date: String(b.date || '').slice(0, 10),
    reference: b.reference || '',
    description: b.description || '',
    source: b.source || '',
    total_debit: Number(b.total_debit || 0),
    total_credit: Number(b.total_credit || 0),
    line_count: b.line_count,
    reverses: b.reverses || null,
    reversed_by: b.reversed_by || null,
    bill_id: b.bill_id || null,
  })))};

  function fmtAmt(v) {
    var n = Number(v || 0);
    if (!n) return '';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Source-aware drill link for a batch row (IA spec §10.2).
  function drillHref(b) {
    if (b.bill_id) {
      return '/' + COMPANY + '/payables/bill/' + encodeURIComponent(b.bill_id) + '?from=voucher-register';
    }
    return '/' + COMPANY + '/journal/new?batch=' + encodeURIComponent(b.batch_id) + '&from=voucher-register';
  }

  function statusCell(b) {
    if (b.reverses) {
      return '<span class="badge b-reversal">Reversal</span>'
        + ' <a class="rev-link" href="/' + COMPANY + '/journal/new?batch=' + encodeURIComponent(b.reverses) + '&from=voucher-register" target="_parent">of ' + esc(String(b.reverses).slice(0, 8)) + '</a>';
    }
    if (b.reversed_by) {
      return '<span class="badge b-reversed">Reversed</span>'
        + ' <a class="rev-link" href="/' + COMPANY + '/journal/new?batch=' + encodeURIComponent(b.reversed_by) + '&from=voucher-register" target="_parent">by ' + esc(String(b.reversed_by).slice(0, 8)) + '</a>';
    }
    return '<span class="badge b-posted">Posted</span>';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function rowHtml(b) {
    var href = drillHref(b);
    return '<tr data-batch="' + esc(b.batch_id) + '" tabindex="0" data-href="' + esc(href) + '">'
      + '<td>' + esc(b.date) + '</td>'
      + '<td><a href="' + esc(href) + '" target="_parent">' + esc(b.reference || b.batch_id) + '</a></td>'
      + '<td>' + esc(b.description || '') + '</td>'
      + '<td class="num">' + fmtAmt(b.total_debit) + '</td>'
      + '<td>' + esc(b.source) + '</td>'
      + '<td>' + statusCell(b) + '</td>'
      + '</tr>';
  }

  function renderRows() {
    var body = document.getElementById('vr-body');
    if (!BATCHES.length) {
      body.innerHTML = '<tr><td colspan="6" class="no-results">No posted transactions in this period.</td></tr>';
      return;
    }
    body.innerHTML = BATCHES.map(rowHtml).join('');
  }

  // Re-query via the report endpoint (date-range filter). Replaces the iframe
  // location so the Reports hub re-renders the report with new params.
  function vrRequery() {
    var s = document.getElementById('vr-start').value;
    var e = document.getElementById('vr-end').value;
    if (!s || !e) return;
    var url = '/api/' + COMPANY + '/report?type=voucher-register&start=' + encodeURIComponent(s) + '&end=' + encodeURIComponent(e);
    window.location.href = url;
  }

  // Keyboard: Enter on a focused row activates its drill link.
  document.getElementById('vr-body').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var tr = e.target.closest('tr[data-href]');
      if (tr) { window.parent.location.href = tr.getAttribute('data-href'); }
    }
  });

  renderRows();
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
    tableRows += `<tr class="${cls}"><td>${code}</td><td>${name}</td><td class="num">${fmt(r.amount)}</td></tr>`;
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
    <td>${r.account_code}</td><td>${r.account_name}</td>
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
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', Arial, sans-serif; font-size: 10pt; color: #1a1a1a; background: #fff; }
  .page { max-width: 1100px; margin: 0; padding: 24px 32px; }
  .header { border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; margin-bottom: 24px; }
  .company { font-size: 16pt; font-weight: 700; }
  .report-title { font-size: 13pt; color: #444; margin-top: 4px; }
  .period { font-size: 10pt; color: #666; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; margin-top: 4px; }
  th { text-align: right; font-size: 9pt; color: #555; text-transform: uppercase; border-bottom: 2px solid #ccc; padding: 6px 8px; }
  th:first-child { text-align: left; }
  td { padding: 6px 8px; border-bottom: 1px solid #f0f0f0; text-align: right; }
  td:first-child { text-align: left; }
  tr.vendor-row { cursor: pointer; }
  tr.vendor-row:hover td { background: #f5f5ff; }
  tr.vendor-row td:first-child { font-weight: 600; }
  tr.detail-row td { font-size: 9pt; color: #555; background: #fafafa; padding: 4px 8px 4px 24px; }
  tr.detail-row td:first-child { text-align: left; }
  tr.total-row td { font-weight: 700; border-top: 2px solid #ccc; background: #f8f8f8; }
  .col-90plus { color: #cc2222; font-weight: 600; }
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
  <div id="report-area"><p style="color:#888">Loading\u2026</p></div>
  <div class="footer">Generated: ${new Date().toISOString().slice(0, 10)} \u00b7 freeBooks</div>
</div>
<script>
  var COMPANY = '${company}';
  var AS_OF   = '${asOf}';

  fetch('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'bill.aging', companyId: COMPANY, asOfDate: AS_OF })
  })
  .then(function(r) { return r.json(); })
  .then(function(res) {
    var rows = res.data || res || [];
    if (!Array.isArray(rows)) rows = [];
    renderAging(rows);
  })
  .catch(function(e) {
    document.getElementById('report-area').innerHTML = '<p style="color:#cc2222">Error: ' + e.message + '</p>';
  });

  function fmt(n) {
    if (!n || n === 0) return '';
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function toggleDetail(row) {
    var next = row.nextElementSibling;
    if (!next) return;
    next.style.display = next.style.display === 'none' ? '' : 'none';
  }

  function renderAging(rows) {
    if (!rows.length) {
      document.getElementById('report-area').innerHTML = '<p style="color:#888">No outstanding payables as of ' + AS_OF + '.</p>';
      return;
    }
    var vendors = {};
    rows.forEach(function(r) { if (!vendors[r.vendor]) vendors[r.vendor] = []; vendors[r.vendor].push(r); });
    var totals = { current: 0, '1_30': 0, '31_60': 0, '61_90': 0, '90plus': 0, total: 0 };
    var html = '<table><thead><tr>'
      + '<th style="text-align:left">Vendor</th>'
      + '<th>Current</th><th>1\u201330 days</th><th>31\u201360 days</th><th>61\u201390 days</th>'
      + '<th class="col-90plus">90+ days</th><th>Total</th>'
      + '</tr></thead><tbody>';
    Object.keys(vendors).sort().forEach(function(vendor) {
      var bills = vendors[vendor];
      var vt = { current: 0, '1_30': 0, '31_60': 0, '61_90': 0, '90plus': 0, total: 0 };
      bills.forEach(function(b) {
        var bal = Number(b.balance_due || 0);
        vt[b.bucket] = (vt[b.bucket] || 0) + bal;
        vt.total += bal;
        totals[b.bucket] = (totals[b.bucket] || 0) + bal;
        totals.total += bal;
      });
      html += '<tr class="vendor-row" onclick="toggleDetail(this)">';
      html += '<td>\u25b6 ' + esc(vendor) + '</td>';
      html += '<td>' + fmt(vt.current) + '</td><td>' + fmt(vt['1_30']) + '</td>';
      html += '<td>' + fmt(vt['31_60']) + '</td><td>' + fmt(vt['61_90']) + '</td>';
      html += '<td' + (vt['90plus'] > 0 ? ' class="col-90plus"' : '') + '>' + fmt(vt['90plus']) + '</td>';
      html += '<td>' + fmt(vt.total) + '</td></tr>';
      html += '<tr class="detail-group" style="display:none"><td colspan="7" style="padding:0"><table style="width:100%;border-collapse:collapse">';
      bills.forEach(function(b) {
        var bal = Number(b.balance_due || 0);
        var label = b.vendor_ref || String(b.date || '').slice(0, 10) || String(b.bill_id || '').slice(0, 8);
        html += '<tr class="detail-row"><td style="padding-left:24px">' + esc(label) + '</td>';
        html += '<td>' + (b.bucket === 'current' ? fmt(bal) : '') + '</td>';
        html += '<td>' + (b.bucket === '1_30'    ? fmt(bal) : '') + '</td>';
        html += '<td>' + (b.bucket === '31_60'   ? fmt(bal) : '') + '</td>';
        html += '<td>' + (b.bucket === '61_90'   ? fmt(bal) : '') + '</td>';
        html += '<td' + (b.bucket === '90plus' ? ' class="col-90plus"' : '') + '>' + (b.bucket === '90plus' ? fmt(bal) : '') + '</td>';
        html += '<td>' + fmt(bal) + '</td></tr>';
      });
      html += '</table></td></tr>';
    });
    html += '<tr class="total-row"><td>Total</td>';
    html += '<td>' + fmt(totals.current) + '</td><td>' + fmt(totals['1_30']) + '</td>';
    html += '<td>' + fmt(totals['31_60']) + '</td><td>' + fmt(totals['61_90']) + '</td>';
    html += '<td class="col-90plus">' + fmt(totals['90plus']) + '</td><td>' + fmt(totals.total) + '</td></tr>';
    html += '</tbody></table>';
    document.getElementById('report-area').innerHTML = html;
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

  const html = htmlPage('AP Control Reconciliation', companyName, `As of ${end}`, tableHtml);
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
  const htmlOut = htmlPage(title, companyName, period, tableHtml, { wide: reportType === 'integrity' });
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
