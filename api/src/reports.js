'use strict';
/**
 * freeBooks — Report HTTP routes (thin router)
 *
 * Page modules live in ./pages/*.js
 * This file handles API routes and wires everything together.
 */

const path = require('path');
const { getDb } = require('./db');
const { packIntegration } = require('./jurisdiction-packs');
const { renderReport, renderComparative, generatePeriods, generateYoYPeriods, generateFiscalPeriods } = require(
  path.resolve(__dirname, '../../reports/render.js')
);

// Page modules
const { handleIndex } = require('./pages/index-page');
const { handleCompanyPage } = require('./pages/company');
const { handleSettingsPage } = require('./pages/settings');
const { handleJournalVoucherPage } = require('./pages/journal-voucher');
const { handleJournalPage } = require('./pages/journal');
const { handleInboxPage } = require('./pages/inbox');
const { handleBillEditPage } = require('./pages/bill-edit');
const { handleBillDetailPage } = require('./pages/bill-detail');
const { handleBankReconcilePage } = require('./pages/bank-reconcile');
const { handlePayablesPage, handleBillsPage } = require('./pages/payables');
const { handleMasterDataPage } = require('./pages/master-data');
const { handleAdminPage } = require('./pages/admin-page');
const { handleApAgingPage } = require('./pages/ap-aging');
const { handleNewCompanyPage } = require('./pages/new-company');
const { handleAdminQuery } = require('./pages/admin');
const { makeQuery } = require('./pages/common');
const { handleReportsHubPage } = require('./pages/reports-hub');
const { handlePeriodsPage } = require('./pages/periods');
const { handleSruInk2, handleSruInfo } = require('./filings');
const { handleSearch } = require('./search');

// ── Route: GET /api/:company/report ──────────────────────────────────────────
async function handleReport(req, res) {
  const { company } = req.params;
  const { type, start, end, format, step, account } = req.query;

  if (!type)  return res.status(400).json({ error: 'Missing ?type=' });
  if (!start && type !== 'ap-aging' && type !== 'ap-control') return res.status(400).json({ error: 'Missing ?start=' });
  if (!end)   return res.status(400).json({ error: 'Missing ?end=' });

  const query = makeQuery();

  try {
    let result;

    if (step === 'fy') {
      const fyPeriods = await generateFiscalPeriods(query, company);
      if (!fyPeriods.length) return res.status(400).json({ error: 'No fiscal periods defined for this company' });
      result = await renderComparative(query, company, type, fyPeriods);
    } else if (step === 'mom') {
      const periods = generatePeriods(start, end, 'month');
      result = await renderComparative(query, company, type, periods);
    } else if (step === 'yoy') {
      const periods = generateYoYPeriods(start, end);
      if (!periods) return res.status(400).json({ error: 'YoY comparison requires a period of exactly 1 year.' });
      result = await renderComparative(query, company, type, periods);
    } else {
      if (type === 'ar') {
        const { renderAnnualReport } = require('./report-composite');
        if (format === 'json') {
          const data = await renderAnnualReport(query, company, start, end, { format: 'json' });
          return res.json(data);
        }
        result = await renderAnnualReport(query, company, start, end);
      } else if (type === 'sie') {
        // SIE is a Swedish statutory format — gated on the jurisdiction pack's
        // integrations.sie.export declaration (hidden in the UI as well).
        const jurRows = await query(
          `SELECT jurisdiction FROM companies WHERE company_id = ? ORDER BY created_at DESC LIMIT 1`, [company]);
        const jur = jurRows.length ? jurRows[0].jurisdiction : null;
        const sieInteg = packIntegration(jur, 'sie');
        if (!sieInteg || !sieInteg.export) {
          return res.status(400).json({ error: `SIE export not available for jurisdiction ${jur || 'unknown'}` });
        }
        const { renderSie } = require('./sie-export');
        const sie = await renderSie(query, company, start, end);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${sie.filename}"`);
        return res.send(sie.buffer);
      } else if (type === 'vat-return') {
        // VAT return (Momsdeklaration) — the artifact view linked from the
        // Periods page filing entries (IA-spec §5.10). Renders the same boxes
        // the report.refresh_vat_return action computes.
        const { generateVatReturn } = require('./vat');
        const data = await generateVatReturn({ companyId: company, body: { periodFrom: start, periodTo: end } });
        const rows = [];
        let totNet = 0, totVat = 0;
        for (const b of data.boxes) {
          for (const it of b.items) {
            rows.push({ box: b.box, description: it.description, vatCode: it.vatCode, rate: it.rate, net: it.net, vat: it.vat });
            totNet += it.net; totVat += it.vat;
          }
        }
        const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const fmt = (n) => Number(n || 0).toFixed(2);
        const body = rows.length
          ? rows.map((r) => `<tr><td>${esc(r.box)}</td><td>${esc(r.description)}</td><td>${esc(r.vatCode)}</td><td style="text-align:right">${fmt(r.rate * 100)}%</td><td style="text-align:right">${fmt(r.net)}</td><td style="text-align:right">${fmt(r.vat)}</td></tr>`).join('')
            + `<tr style="font-weight:700;border-top:2px solid #1a1a1a"><td colspan="4">Total</td><td style="text-align:right">${fmt(totNet)}</td><td style="text-align:right">${fmt(totVat)}</td></tr>`
          : '<tr><td colspan="6" style="color:#888">No VAT-coded activity in this interval.</td></tr>';
        result = {
          html: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>VAT Return ${esc(start)} → ${esc(end)}</title>
<style>body{font-family:system-ui,sans-serif;margin:32px;color:#1a1a1a}h1{font-size:14pt}p.meta{color:#555;font-size:10pt}table{border-collapse:collapse;font-size:10pt;margin-top:16px}th{text-align:left;font-size:9pt;text-transform:uppercase;color:#555;border-bottom:1px solid #ccc;padding:6px 8px}td{padding:5px 8px;border-bottom:1px solid #f0f0f0}</style>
</head><body><h1>VAT Return (Momsdeklaration)</h1><p class="meta">Period ${esc(start)} → ${esc(end)} · computed live from VAT-coded journal lines</p>
<table><thead><tr><th>Box</th><th>Description</th><th>Code</th><th style="text-align:right">Rate</th><th style="text-align:right">Net</th><th style="text-align:right">VAT</th></tr></thead><tbody>${body}</tbody></table></body></html>`,
          csv: 'box,description,vat_code,rate,net,vat\n' + rows.map((r) => `${r.box},"${String(r.description || '').replace(/"/g, '""')}",${r.vatCode},${r.rate},${r.net.toFixed(2)},${r.vat.toFixed(2)}`).join('\n'),
          filename: `vat-return_${company}_${start}_${end}`,
        };
      } else {
        result = await renderReport(query, company, type, start, end, { account });
      }
    }

    const isCsv = format === 'csv';

    if (isCsv) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}.csv"`);
      return res.send(result.csv);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(result.html);
  } catch (err) {
    console.error('Report error:', err);
    res.status(500).json({ error: err.message || 'Report generation failed' });
  }
}

// ── Route: GET /api/:company/periods ─────────────────────────────────────────
async function handlePeriods(req, res) {
  const { company } = req.params;
  const query = makeQuery();
  try {
    const rows = await query(
      `SELECT period_name, start_date, end_date, locked
       FROM periods WHERE company_id = ?
       ORDER BY start_date DESC`,
      [company]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Route: GET /api/:company/accounts ────────────────────────────────────────
async function handleAccounts(req, res) {
  const { company } = req.params;
  const query = makeQuery();
  try {
    const rows = await query(
      `SELECT account_code, account_name, account_type, account_subtype,
              cf_category, is_active, default_role, effective_from
       FROM accounts WHERE company_id = ?
       ORDER BY account_code`,
      [company]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Route: GET /api/:company/vat-codes ───────────────────────────────────────
async function handleVatCodes(req, res) {
  const { company } = req.params;
  const q = makeQuery();
  try {
    const rows = await q(`SELECT * FROM vat_codes WHERE company_id = ? ORDER BY vat_code`, [company]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Action handler for report.* actions ──────────────────────────────────────
function handleReports(ctx, action) {
  switch (action) {
    case 'report.refresh_vat_return': return generateVatReturn(ctx);
    default:
      throw Object.assign(new Error(`Unknown report action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

async function generateVatReturn(ctx) {
  // Delegate to vat module
  const { handleVat } = require('./vat');
  return handleVat(ctx, 'vat.return');
}

// ── Mount on Express app ──────────────────────────────────────────────────────
function mountReportRoutes(app) {
  app.get('/', handleIndex);
  app.get('/setup/new-company', handleNewCompanyPage);
  app.get('/api/:company/report', handleReport);
  app.get('/api/:company/reports/registry', function(req, res) {
    const { REPORT_REGISTRY } = require('./report-registry');
    res.json(REPORT_REGISTRY.map(r => ({ id: r.id, label: r.label })));
  });
  // v7: returns the period_id of the most recent posted transaction.
  // Never returns a future-dated period (start_date must be <= today).
  app.get('/api/:company/reports/default-period', async function(req, res) {
    const { company } = req.params;
    const query = makeQuery();
    try {
      // Find the latest journal entry date, then the period containing it.
      const today = new Date().toISOString().slice(0, 10);
      const latest = await query(
        `SELECT p.period_id, p.start_date, p.end_date
         FROM periods p
         WHERE p.company_id = ?
           AND p.start_date <= ?
           AND EXISTS (
             SELECT 1 FROM journal_entries je
             WHERE je.company_id = p.company_id
               AND je.date >= p.start_date
               AND je.date <= p.end_date
           )
         ORDER BY p.start_date DESC
         LIMIT 1`,
        [company, today]
      );
      if (latest.length) res.json({ period_id: latest[0].period_id, start_date: latest[0].start_date, end_date: latest[0].end_date });
      else res.json({ period_id: null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get('/api/:company/periods', handlePeriods);
  app.get('/api/:company/accounts', handleAccounts);
  app.get('/api/:company/vat-codes', handleVatCodes);
  // SRU (Skatteverket INK2) export — blanketter.sru + INFO.SRU.
  app.get('/api/:company/sru/ink2', handleSruInk2);
  app.get('/api/:company/sru/info', handleSruInfo);
  // Global search — command-bar `/` mode (command-bar-ux-spec.md §4).
  app.get('/api/:company/search', handleSearch);
  // 2026-08-03: Dashboard dropped; Inbox is now the root route (/:company).
  // Old /:company/inbox bookmarks 302-redirect to the root.
  app.get('/:company/inbox', function(req, res) { res.redirect(302, '/' + req.params.company); });
  app.get('/:company/journal', function(req, res) {
    // 2026-08-03: Journal page dissolved into the Reports hub as the
    // "Voucher Register" report (Step 3). The register is now a report type
    // inside Reports; the reverse verb is surfaced on each voucher row.
    res.redirect(302, '/' + req.params.company + '/reports?t=voucher-register');
  });
  app.get('/:company/journal/voucher', handleJournalVoucherPage);
  app.get('/:company/bill/edit', handleBillEditPage);
  app.get('/:company/bill/:id', handleBillDetailPage);
  app.get('/:company/bills', handleBillsPage);
  // 2026-08-11 IA restructure: Payables renamed to Bills. Old URL redirects.
  app.get('/:company/payables', function(req, res) {
    if (req.query && req.query.tab === 'partners') {
      return res.redirect(302, '/' + req.params.company + '/master-data?tab=partners');
    }
    res.redirect(302, '/' + req.params.company + '/bills');
  });
  app.get('/:company/payables/aging', function(req, res) {
    res.redirect(302, '/' + req.params.company + '/reports?t=ap-aging');
  });
  // /bank/reconcile + /bank/import routes REMOVED 2026-07-31 (agent-first UI
  // doctrine, roadmap §0q): both were 301 stubs; import is the Bank ?tab=import tab.
  // 2026-08-09 (issue #137): Bank page dissolved — pages/bank.js + pages/bank-import.js
  // deleted. Old /:company/bank URL 302-redirects to the Reports hub (bank
  // reconciliation is being moved to a report). api/src/bank.js server handlers
  // (bank.match, bank.reconcile.*) are kept for the agent feed-watcher + reconcile actions.
  app.get('/:company/bank', function(req, res) {
    res.redirect(302, '/' + req.params.company + '/reports');
  });
  // Opening Balances relocated to a Settings tab 2026-07-28 (magnus) —
  // old URL 302-redirects to the Settings → Opening Balances tab.
  app.get('/:company/opening-balances', function(req, res) {
    res.redirect(302, '/' + req.params.company + '/settings');
  });
  // 2026-08-11 IA restructure: Settings tab deep-links redirect to Master Data.
  app.get('/:company/settings', function(req, res, next) {
    var tab = req.query && req.query.tab;
    if (tab === 'coa' || tab === 'vat' || tab === 'journals' || tab === 'fxrates') {
      return res.redirect(302, '/' + req.params.company + '/master-data?tab=' + tab);
    }
    return handleSettingsPage(req, res, next);
  });
  app.get('/:company/master-data', handleMasterDataPage);
  app.get('/:company/admin', handleAdminPage);
  app.get('/:company/periods', handlePeriodsPage);
  app.get('/:company/reports', handleReportsHubPage);
  app.get('/:company', handleInboxPage);
  app.post('/api/admin/query', (req, res, next) => { req.body = req.body || {}; next(); }, handleAdminQuery);
}

module.exports = { handleReports, mountReportRoutes };
