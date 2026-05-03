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
  .page { max-width: 900px; margin: 0 auto; padding: 32px 40px; }
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
    tableRows += `<tr class="${cls}"><td>${code}</td><td>${name}</td><td class="num">${fmt(r.amount)}</td></tr>`;
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
       COALESCE(SUM(CASE WHEN a.account_type = 'Revenue' THEN je.credit_home - je.debit_home ELSE 0 END), 0) -
       COALESCE(SUM(CASE WHEN a.account_type IN ('Expense','Cost of Sales') THEN je.debit_home - je.credit_home ELSE 0 END), 0)
       AS net_income
     FROM journal_entries je
     JOIN accounts a ON a.account_code = je.account_code AND a.company_id = je.company_id
     WHERE je.company_id = ? AND je.date >= ? AND je.date <= ?
       AND a.account_type NOT IN ('Closing')`,
    [company, start, end]
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
    tableRows += `<tr class="${cls}"><td>${code}</td><td>${name}</td><td class="num">${fmt(r.balance)}</td></tr>`;
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
    <td>${r.account_code}</td><td>${r.account_name}</td><td>${r.account_type}</td>
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
  let rows = await query(`SELECT * FROM gl(?, ?, ?)`, [company, start, end]);
  if (account) rows = rows.filter(r => r.account_code === account);
  let lastAcct = null;
  let runBal = 0;
  let tableRows = '';
  for (const r of rows) {
    if (r.account_code !== lastAcct) {
      if (lastAcct !== null) {
        tableRows += `<tr class="subtotal"><td></td><td></td><td>Closing Balance</td><td class="num"></td><td class="num"></td><td class="num">${fmt(runBal)}</td></tr>
        <tr><td colspan="6" style="padding:8px 0"></td></tr>`;
      }
      runBal = 0;
      tableRows += `<tr class="section-header"><td colspan="6">${r.account_code} — ${r.account_name || ''}</td></tr>`;
      lastAcct = r.account_code;
    }
    if (r.batch_id === 'Opening Balance') {
      const obAmt = parseFloat(r.debit_home || r.debit || 0) - parseFloat(r.credit_home || r.credit || 0);
      runBal = obAmt;
      tableRows += `<tr class="subtotal">
        <td></td><td colspan="2" style="font-style:italic">Opening Balance</td>
        <td class="num"></td><td class="num"></td><td class="num">${fmt(runBal)}</td>
      </tr>`;
    } else {
      runBal += parseFloat(r.debit_home || r.debit || 0) - parseFloat(r.credit_home || r.credit || 0);
      const dateStr = new Date(r.date).toISOString().slice(0, 10);
      const ccyTag = r.currency && r.currency !== 'SGD' ? ` <span style="font-size:8pt;color:#888">${r.currency}</span>` : '';
      tableRows += `<tr class="account">
        <td>${dateStr}</td><td>${r.reference || r.batch_id}</td><td>${r.description || ''}${ccyTag}</td>
        <td class="num">${fmt(r.debit_home || r.debit)}</td><td class="num">${fmt(r.credit_home || r.credit)}</td>
        <td class="num">${fmt(runBal)}</td>
      </tr>`;
    }
  }
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

async function buildJournal(query, company, start, end) {
  const rows = await query(`SELECT * FROM journal(?, ?, ?)`, [company, start, end]);
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
      const ref = r.reference || r.batch_id;
      tableRows += `<tr class="section-header"><td>${dateStr}</td><td colspan="4">${ref}${r.description ? ' — ' + r.description : ''}</td></tr>`;
      lastBatch = r.batch_id;
    }
    batchDebit  += parseFloat(r.debit_home  || r.debit  || 0);
    batchCredit += parseFloat(r.credit_home || r.credit || 0);
    const jCcyTag = r.currency && r.currency !== 'SGD' ? ` <span style="font-size:8pt;color:#888">${r.currency}</span>` : '';
    tableRows += `<tr class="account">
      <td></td><td>${r.account_code}</td><td>${r.account_name || ''}${jCcyTag}</td>
      <td class="num">${fmt(r.debit_home || r.debit)}</td><td class="num">${fmt(r.credit_home || r.credit)}</td>
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
  const rows1 = await query(`SELECT * FROM integrity(?, ?, ?)`, [company, start, end]);
  const rows2 = await query(`SELECT * FROM integrity_extended(?, ?, ?)`, [company, start, end]);
  const allChecks = [...rows1, ...rows2];

  // Compute unallocated net income — same logic as buildBS
  const [niRow] = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN a.account_type = 'Revenue' THEN je.credit_home - je.debit_home ELSE 0 END), 0) -
       COALESCE(SUM(CASE WHEN a.account_type IN ('Expense','Cost of Sales') THEN je.debit_home - je.credit_home ELSE 0 END), 0)
       AS net_income
     FROM journal_entries je
     JOIN accounts a ON a.account_code = je.account_code AND a.company_id = je.company_id
     WHERE je.company_id = ? AND je.date >= ? AND je.date <= ?
       AND a.account_type NOT IN ('Closing')`,
    [company, start, end]
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

  const reRows = await query(`SELECT * FROM re_rollforward(?)`, [company]);
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

// ── Report type dispatch ──────────────────────────────────────────────────────
const REPORT_TITLES = {
  pl: 'Profit & Loss',
  bs: 'Balance Sheet',
  tb: 'Trial Balance',
  gl: 'General Ledger',
  journal: 'Journal',
  cf: 'Cash Flow Statement',
  sce: 'Statement of Changes in Equity',
  integrity: 'Integrity Checks',
};

async function buildReport(query, company, reportType, startDate, endDate, opts = {}) {
  switch (reportType) {
    case 'pl':        return buildPL(query, company, startDate, endDate);
    case 'bs':        return buildBS(query, company, startDate, endDate);
    case 'tb':        return buildTB(query, company, startDate, endDate);
    case 'gl':        return buildGL(query, company, startDate, endDate, opts.account);
    case 'journal':   return buildJournal(query, company, startDate, endDate);
    case 'cf':        return buildCF(query, company, startDate, endDate);
    case 'sce':       return buildSCE(query, company, startDate, endDate);
    case 'integrity': return buildIntegrity(query, company, startDate, endDate);
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

module.exports = { renderReport, renderComparative, generatePeriods, generateFiscalPeriods, REPORT_TITLES, toCSV, htmlPage };
