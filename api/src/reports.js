'use strict';
/**
 * freeBooks — Report HTTP routes (thin router)
 *
 * Page modules live in ./pages/*.js
 * This file handles API routes and wires everything together.
 */

const path = require('path');
const { getDb } = require('./db');
const { renderReport, renderComparative, generatePeriods, generateFiscalPeriods } = require(
  path.resolve(__dirname, '../../reports/render.js')
);

// Page modules
const { handleIndex } = require('./pages/index-page');
const { handleCompanyPage } = require('./pages/company');
const { handleSettingsPage } = require('./pages/settings');
const { handleJournalNewPage } = require('./pages/journal-new');
const { handleBankImportPage } = require('./pages/bank-import');
const { handleBillNewPage } = require('./pages/bill-new');
const { handleBankReconcilePage } = require('./pages/bank-reconcile');
const { handlePayablesPage } = require('./pages/payables');
const { handleApAgingPage } = require('./pages/ap-aging');
const { handleNewCompanyPage } = require('./pages/new-company');
const { handleAdminQuery } = require('./pages/admin');
const { handleOpeningBalancesPage } = require('./pages/opening-balances');
const { makeQuery } = require('./pages/common');

// ── Route: GET /api/:company/report ──────────────────────────────────────────
async function handleReport(req, res) {
  const { company } = req.params;
  const { type, start, end, format, step, account } = req.query;

  if (!type)  return res.status(400).json({ error: 'Missing ?type=' });
  if (!start) return res.status(400).json({ error: 'Missing ?start=' });
  if (!end)   return res.status(400).json({ error: 'Missing ?end=' });

  const query = makeQuery();

  try {
    let result;

    if (step === 'fy') {
      const fyPeriods = await generateFiscalPeriods(query, company);
      if (!fyPeriods.length) return res.status(400).json({ error: 'No fiscal periods defined for this company' });
      result = await renderComparative(query, company, type, fyPeriods);
    } else if (step === 'month' || step === 'year') {
      const periods = generatePeriods(start, end, step);
      result = await renderComparative(query, company, type, periods);
    } else {
      result = await renderReport(query, company, type, start, end, { account });
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
              cf_category, is_active
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
async function handleReports(ctx, action) {
  switch (action) {
    case 'report.refresh_ap_aging':   return refreshAPAging(ctx);
    case 'report.refresh_vat_return': return generateVatReturn(ctx);
    default:
      throw Object.assign(new Error(`Unknown report action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

async function refreshAPAging(ctx) {
  // TODO: implement AP aging refresh
  return { refreshed: true };
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
  app.get('/api/:company/periods', handlePeriods);
  app.get('/api/:company/accounts', handleAccounts);
  app.get('/api/:company/vat-codes', handleVatCodes);
  app.get('/:company/journal/new', handleJournalNewPage);
  app.get('/:company/bill/new', handleBillNewPage);
  app.get('/:company/payables', handlePayablesPage);
  app.get('/:company/payables/aging', handleApAgingPage);
  app.get('/:company/bank/import', handleBankImportPage);
  app.get('/:company/bank/reconcile', handleBankReconcilePage);
  app.get('/:company/opening-balances', handleOpeningBalancesPage);
  app.get('/:company/settings', handleSettingsPage);
  app.get('/:company', handleCompanyPage);
  app.post('/api/admin/query', (req, res, next) => { req.body = req.body || {}; next(); }, handleAdminQuery);
}

module.exports = { handleReports, mountReportRoutes };
