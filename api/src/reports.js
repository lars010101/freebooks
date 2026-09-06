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
const { handleSettingsPage } = require('./pages/settings');
const { handleJournalVoucherPage } = require('./pages/journal-voucher');
const { handleInboxPage } = require('./pages/inbox');
const { handleBillPage } = require('./pages/bill-edit');
const { handlePaymentNewPage } = require('./pages/payment-new');
const { handlePayablesPage, handleBillsPage } = require('./pages/payables');
const { handleBankPage } = require('./pages/bank');
const { handleChatPage } = require('./pages/chat');
const { handleAccountingPage } = require('./pages/accounting');
const { handleExchangeRatesPage } = require('./pages/exchange-rates');
const { handleNewCompanyPage } = require('./pages/new-company');
const { handleAdminQuery } = require('./pages/admin');
const { makeQuery } = require('./pages/common');
const { handleStatementsHubPage, handleJournalHubPage, isSieExportEnabled } = require('./pages/reports-hub');
const { handleCalendarPage } = require('./pages/calendar');
const { handleDocumentsPage } = require('./pages/documents');
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
      `SELECT period_name, period_name AS period_id, start_date, end_date, locked
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

// ── Route: GET /api/:company/wht-codes ───────────────────────────────────────
async function handleWhtCodes(req, res) {
  const { company } = req.params;
  const q = makeQuery();
  try {
    const rows = await q(`SELECT * FROM wht_codes WHERE company_id = ? ORDER BY wht_code`, [company]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Action handler for report.* actions ──────────────────────────────────────
// No report.* actions exist today — report.refresh_vat_return was removed
// (issue #272): it called a vat.js switch case that was never implemented
// (permanent crash), was unreachable from any UI once the `:` command
// palette was deleted (2026-09-03), and its "recompute + store" premise is
// out of scope per the Documents-page snapshot principle (the app provides
// live data; the user owns filing/snapshotting outside the app). The VAT
// return report itself is unaffected — it's served live by the GET
// /api/:company/report?type=vat-return route below, unchanged.
function handleReports(ctx, action) {
  throw Object.assign(new Error(`Unknown report action: ${action}`), { code: 'UNKNOWN_ACTION' });
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
        `SELECT p.period_name AS period_id, p.start_date, p.end_date
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
  app.get('/api/:company/wht-codes', handleWhtCodes);
  // SRU (Skatteverket INK2) export — blanketter.sru + INFO.SRU.
  app.get('/api/:company/sru/ink2', handleSruInk2);
  app.get('/api/:company/sru/info', handleSruInfo);
  // Global search — command-bar `/` mode (command-bar-ux-spec.md §4).
  app.get('/api/:company/search', handleSearch);
  // Unified topbar download icon (ia-restructure-3-spec.md §6.3) needs to
  // know, on every page (not just Journal/Statements), whether SIE export is
  // available for this company's jurisdiction — reuses the same check the
  // Journal hub already made server-side, exposed as a tiny endpoint since
  // the topbar itself is built synchronously (navBar()) on every page and
  // isn't worth making async everywhere just for this one flag.
  app.get('/api/:company/sie-status', async function (req, res) {
    try {
      res.json({ enabled: await isSieExportEnabled(req.params.company) });
    } catch (err) {
      res.json({ enabled: false });
    }
  });
  // 2026-08-03: Dashboard dropped; Inbox is now the root route (/:company).
  // Old /:company/inbox bookmarks 302-redirect to the root.
  app.get('/:company/inbox', function(req, res) { res.redirect(302, '/' + req.params.company); });
  // ── 2026-08-27 IA restructure 2 / 2026-08-30 IA restructure 3: clean cutover, no compatibility redirects ──
  app.get('/:company/journal/voucher', handleJournalVoucherPage);
  // bill-edit/bill-detail merge (2026-09-06, Stages 0-4): /bill/edit is
  // retired — /bill/new creates, /bill/:id both edits (draft) and views
  // (posted/partial/paid/void, read-only + journal trail + void), decided
  // by handleBillPage itself from the loaded bill's status. bill-detail.js
  // is deleted; its old nav model (flat moveBillNav) is fully superseded by
  // FB.form's zone system, which bill-edit.js already ran on.
  app.get('/:company/bill/new', handleBillPage);
  app.get('/:company/payment/new', handlePaymentNewPage);
  app.get('/:company/bill/:id', handleBillPage);
  // Payables (was Bills) — re-expanded to Bills · Vendors · Aging · Control
  app.get('/:company/payables', handlePayablesPage);
  // /bank/reconcile + /bank/import routes REMOVED 2026-07-31 (agent-first UI
  // doctrine, roadmap §0q): both were 301 stubs; import is the Bank ?tab=import tab.
  // 2026-08-09 (issue #137): Bank page dissolved — pages/bank.js + pages/bank-import.js
  // deleted. api/src/bank.js server handlers kept for the agent feed-watcher +
  // reconcile actions. The old /:company/bank redirect stub (→ /books, itself
  // never built into a report) and its only live referrer — the unrouted dead
  // Dashboard page (pages/company.js, orphaned since Dashboard was dropped
  // 2026-08-03) — are deleted outright, not repointed: no reachable code links
  // to /bank today. (docs/ia-restructure-3-spec.md §2.2)
  // Bank revived (two-way-payments-prep): Payments + Reconciliation tabs — a
  // different scope than the old page (no import wizard; imports stay
  // agent/Inbox-only, per the note above). New pages/bank.js, no relation to
  // the deleted pages/bank.js this comment describes.
  app.get('/:company/bank', handleBankPage);
  app.get('/:company/chat', handleChatPage);
  // Opening Balances feature removed 2026-08-18 (magnus): users post opening
  // balances via a simple journal voucher instead. Old URL redirects.
  app.get('/:company/opening-balances', function(req, res) {
    res.redirect(302, '/' + req.params.company + '/journal/voucher');
  });
  // 2026-08-27 IA restructure 2: Settings slimmed — Company · Access · Extensions.
  // Old redirect handlers for ?tab=periods and ?tab={coa,vat,journals,fxrates} deleted
  // (those routes no longer exist — clean cutover, §2.3).
  app.get('/:company/settings', handleSettingsPage);
  // 2026-08-27 IA restructure 2 routes; Books renamed Journal 2026-08-30 (IA
  // restructure 3, §2.1 — this replaces the old /:company/journal redirect
  // stub that pointed at /books?t=voucher-register; that stub is deleted, not
  // left alongside this handler).
  app.get('/:company/statements', handleStatementsHubPage);
  app.get('/:company/journal', handleJournalHubPage);
  app.get('/:company/calendar', handleCalendarPage);
  app.get('/:company/documents', handleDocumentsPage);
  app.get('/:company/accounting', handleAccountingPage);
  app.get('/:company/exchange-rates', handleExchangeRatesPage);
  // 2026-08-27 IA restructure 2 / 2026-08-30 IA restructure 3: old routes
  // deleted (no redirects, §2.3): /:company/bills, /:company/master-data,
  // /:company/admin, /:company/periods, /:company/reports, /:company/books.
  // /:company/bank was in this list too — revived above (two-way-payments-prep).
  app.get('/:company', handleInboxPage);
  app.post('/api/admin/query', (req, res, next) => { req.body = req.body || {}; next(); }, handleAdminQuery);
}

module.exports = { handleReports, mountReportRoutes };
