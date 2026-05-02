'use strict';
/**
 * freeBooks — Express API entry point
 *
 * Single POST endpoint that routes to action handlers.
 * Same route signatures as the original Cloud Function.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { v4: uuid } = require('uuid');

const { checkPermission } = require('./auth');
const { handleJournal } = require('./journal');
const { handleBank } = require('./bank');
const { handleBills } = require('./bills');
const { handleVendors } = require('./vendors');
const { handleReports, mountReportRoutes } = require('./reports');
const { handleVat } = require('./vat');
const { handleFx } = require('./fx');
const { handleSetup } = require('./setup');
const { getDb, ensureDb, query, exec, bulkInsert } = require('./db');

const PORT = process.env.PORT || 3000;

const ACTION_ROLES = {
  'journal.post': 'data_entry',
  'journal.reverse': 'data_entry',
  'journal.list': 'viewer',
  'journal.import': 'data_entry',
  'journal.search': 'viewer',
  'journal.get': 'viewer',
  'bank.process': 'data_entry',
  'bank.approve': 'data_entry',
  'bank.reconcile.list': 'viewer',
  'bank.reconcile.clear': 'data_entry',
  'bill.create': 'data_entry',
  'bill.void': 'data_entry',
  'bill.list': 'viewer',
  'bill.match': 'viewer',
  'bill.lines': 'viewer',
  'bill.aging': 'viewer',
  'report.refresh_ap_aging': 'viewer',
  'report.refresh_vat_return': 'viewer',
  'coa.list': 'viewer',
  'coa.save': 'owner',
  'coa.update': 'owner',
  'vat.codes.list': 'viewer',
  'vat.codes.save': 'owner',
  'fx.fetch_rates': 'data_entry',
  'fx.revaluation_preview': 'owner',
  'fx.revaluation_post': 'owner',
  'mapping.list': 'viewer',
  'mapping.save': 'data_entry',
  'center.list': 'viewer',
  'center.save': 'owner',
  'journals.list': 'viewer',
  'journals.save': 'owner',
  'vendor.list': 'viewer',
  'vendor.save': 'owner',
  'vendor.delete': 'owner',
  'settings.get': 'viewer',
  'settings.save': 'owner',
  'company.list': 'viewer',
  'company.save': 'owner',
  'period.list': 'viewer',
  'period.save': 'owner',
  'permissions.list': 'owner',
  'permissions.save': 'owner',
  'diag.account': 'owner',
  'setup.init': 'owner',
  'setup.add_company': 'owner',
};

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, service: 'freebooks-api' }));

// Mount HTML report routes (GET /  /:company  /api/:company/report  etc.)
mountReportRoutes(app);

async function handleApiRequest(req, res) {
  try {
    const body = req.body;
    const { action, companyId, userEmail } = body;

    if (!action) return res.status(400).json({ error: 'Missing action' });
    if (!action.startsWith('setup.') && !companyId) return res.status(400).json({ error: 'Missing companyId' });

    const requiredRole = ACTION_ROLES[action];
    if (!requiredRole) return res.status(400).json({ error: `Unknown action: ${action}` });

    if (userEmail && !action.startsWith('setup.')) {
      const allowed = await checkPermission(userEmail, companyId, requiredRole);
      if (!allowed) return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const ctx = { body, companyId, userEmail };
    let result;
    const [module] = action.split('.');

    switch (module) {
      case 'journal':     result = await handleJournal(ctx, action); break;
      case 'bank':        result = await handleBank(ctx, action); break; // bank.process, bank.approve, bank.reconcile.*
      case 'bill':        result = await handleBills(ctx, action); break;
      case 'vendor':      result = await handleVendors(ctx, action); break;
      case 'report':      result = await handleReports(ctx, action); break;
      case 'vat':         result = await handleVat(ctx, action); break;
      case 'fx':          result = await handleFx(ctx, action); break;
      case 'coa':         result = await handleCoa(ctx, action); break;
      case 'mapping':     result = await handleMapping(ctx, action); break;
      case 'center':      result = await handleCenter(ctx, action); break;
      case 'journals':   result = await handleJournals(ctx, action); break;
      case 'settings':
      case 'company':
      case 'period':      result = await handleSettings(ctx, action); break;
      case 'permissions': result = await handlePermissions(ctx, action); break;
      case 'setup':       result = await handleSetup(ctx, action); break;
      case 'diag':        result = await handleDiag(ctx, action); break;
      default:
        return res.status(400).json({ error: `Unknown module: ${module}` });
    }

    res.json({ ok: true, data: result });
  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: err.message || 'Internal error', code: err.code || 'INTERNAL' });
  }
}

app.post('/api', handleApiRequest);
app.post('/api/action', handleApiRequest);

// --- COA ---

async function handleCoa(ctx, action) {
  const { companyId, body } = ctx;

  if (action === 'coa.list') {
    return query(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER(PARTITION BY account_code ORDER BY created_at DESC) AS rn
         FROM accounts WHERE company_id = @companyId
       ) t WHERE rn = 1 ORDER BY account_code`,
      { companyId }
    );
  }

  if (action === 'coa.save') {
    let { accounts } = body;
    if (!accounts || !Array.isArray(accounts)) throw Object.assign(new Error('accounts array required'), { code: 'INVALID_INPUT' });

    accounts = accounts.filter((a) => a.account_code && String(a.account_code).trim() !== '');
    if (accounts.length === 0) throw Object.assign(new Error('No valid accounts found'), { code: 'INVALID_INPUT' });

    const codes = accounts.map((a) => String(a.account_code).trim());
    const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
    if (dupes.length > 0) throw Object.assign(new Error(`Duplicate account codes: ${dupes.join(', ')}`), { code: 'DUPLICATE_CODE' });

    // Check accounts in use can't be removed
    const usedAccounts = await query(
      `SELECT DISTINCT account_code FROM journal_entries WHERE company_id = @companyId`,
      { companyId }
    );
    const incomingCodes = new Set(codes);
    const blocked = usedAccounts.filter((a) => !incomingCodes.has(a.account_code)).map((a) => a.account_code);
    if (blocked.length > 0) throw Object.assign(new Error(`Cannot remove accounts with transactions: ${blocked.join(', ')}`), { code: 'REFERENTIAL_INTEGRITY' });

    const now = new Date().toISOString();

    // DuckDB: delete removed accounts, then upsert
    const inCodes = codes.map((c) => `'${c.replace(/'/g, "''")}'`).join(',');
    await exec(`DELETE FROM accounts WHERE company_id = @companyId AND account_code NOT IN (${inCodes})`, { companyId });

    for (const a of accounts) {
      const existing = await query(
        `SELECT account_code FROM accounts WHERE company_id = @companyId AND account_code = @code LIMIT 1`,
        { companyId, code: a.account_code }
      );
      if (existing.length > 0) {
        await exec(
          `UPDATE accounts SET account_name = @name, account_type = @type, account_subtype = @subtype,
           cf_category = @cf, is_active = @active,
           effective_from = @from, effective_to = @to, created_at = @now
           WHERE company_id = @companyId AND account_code = @code`,
          { companyId, code: a.account_code, name: a.account_name, type: a.account_type, subtype: a.account_subtype || null, cf: a.cf_category || null, active: a.is_active !== false, from: a.effective_from, to: a.effective_to || null, now }
        );
      } else {
        await bulkInsert('accounts', [{
          company_id: companyId,
          account_code: a.account_code,
          account_name: a.account_name,
          account_type: a.account_type,
          account_subtype: a.account_subtype || null,
          cf_category: a.cf_category || null,
          is_active: a.is_active !== false,
          effective_from: a.effective_from,
          effective_to: a.effective_to || null,
          created_at: now,
        }]);
      }
    }

    return { saved: accounts.length };
  }

  if (action === 'coa.update') {
    const { accounts } = body;
    if (!accounts || !Array.isArray(accounts)) throw Object.assign(new Error('accounts array required'), { code: 'INVALID_INPUT' });
    for (const a of accounts) {
      if (!a.account_code) continue;
      await exec(
        `UPDATE accounts SET account_name = @name, account_subtype = @subtype, cf_category = @cf, is_active = @active WHERE company_id = @companyId AND account_code = @code`,
        { companyId, code: a.account_code, name: a.account_name, subtype: a.account_subtype || null, cf: a.cf_category || null, active: a.is_active !== false }
      );
    }
    return { saved: accounts.length };
  }
}

// --- Bank Mappings ---

async function handleMapping(ctx, action) {
  const { companyId, body } = ctx;

  if (action === 'mapping.list') {
    return query(`SELECT * FROM bank_mappings WHERE company_id = @companyId ORDER BY priority`, { companyId });
  }

  if (action === 'mapping.save') {
    const { mappings } = body;
    if (!mappings || !Array.isArray(mappings)) throw Object.assign(new Error('mappings array required'), { code: 'INVALID_INPUT' });

    await exec(`DELETE FROM bank_mappings WHERE company_id = @companyId`, { companyId });

    const rows = mappings.map((m) => ({
      company_id: companyId,
      mapping_id: m.mapping_id || uuid(),
      pattern: m.pattern,
      match_type: m.match_type || 'contains',
      debit_account: m.debit_account,
      credit_account: m.credit_account,
      description_override: m.description_override || null,
      vat_code: m.vat_code || null,
      cost_center: m.cost_center || null,
      profit_center: m.profit_center || null,
      priority: m.priority || 100,
      is_active: m.is_active !== false,
    }));

    if (rows.length > 0) await bulkInsert('bank_mappings', rows);
    return { saved: rows.length };
  }
}

// --- Centers ---

async function handleCenter(ctx, action) {
  const { companyId, body } = ctx;

  if (action === 'center.list') {
    return query(`SELECT * FROM centers WHERE company_id = @companyId ORDER BY center_type, center_id`, { companyId });
  }

  if (action === 'center.save') {
    const { centers } = body;
    if (!centers || !Array.isArray(centers)) throw Object.assign(new Error('centers array required'), { code: 'INVALID_INPUT' });
    await exec(`DELETE FROM centers WHERE company_id = @companyId`, { companyId });
    const rows = centers.map((c) => ({ company_id: companyId, center_id: c.center_id, center_type: c.center_type, name: c.name, is_active: c.is_active !== false }));
    if (rows.length > 0) await bulkInsert('centers', rows);
    return { saved: rows.length };
  }
}

// --- Journals ---

async function handleJournals(ctx, action) {
  const { companyId, body } = ctx;

  if (action === 'journals.list') {
    return query(
      `SELECT * FROM journals WHERE company_id = @companyId AND active = true ORDER BY code`,
      { companyId }
    );
  }

  if (action === 'journals.save') {
    const { journal } = body;
    if (!journal || !journal.code || !journal.name) throw Object.assign(new Error('journal.code and journal.name required'), { code: 'INVALID_INPUT' });
    const journalId = journal.journal_id || `${companyId}_${journal.code.toLowerCase()}`;
    await exec(
      `INSERT INTO journals (journal_id, company_id, code, name, active)
       VALUES (@journalId, @companyId, @code, @name, @active)
       ON CONFLICT (journal_id) DO UPDATE SET name = @name, active = @active`,
      { journalId, companyId, code: journal.code, name: journal.name, active: journal.active !== false }
    );
    return { saved: true, journalId };
  }
}

// --- Settings / Company / Periods ---

async function handleSettings(ctx, action) {
  const { companyId, body } = ctx;

  if (action === 'company.list') {
    const rows = await query(
      `SELECT company_id, company_name, jurisdiction, currency, reporting_standard, accounting_method, vat_registered, tax_id
       FROM (SELECT *, ROW_NUMBER() OVER(PARTITION BY company_id ORDER BY created_at DESC) AS rn FROM companies) t
       WHERE rn = 1 ORDER BY company_id`
    );
    return rows.map((r) => ({ ...r, base_currency: r.currency, vat_registered: !!r.vat_registered, tax_id: r.tax_id || '' }));
  }

  if (action === 'company.save') {
    const { companies } = body;
    if (!companies || !Array.isArray(companies) || companies.length === 0) throw Object.assign(new Error('companies array required'), { code: 'INVALID_INPUT' });
    const now = new Date().toISOString();
    const rows = companies.filter((c) => c.company_id && c.company_name).map((c) => ({
      company_id: String(c.company_id).trim(),
      company_name: String(c.company_name).trim(),
      jurisdiction: String(c.jurisdiction || 'SG').trim(),
      currency: String(c.base_currency || c.currency || 'SGD').trim(),
      reporting_standard: String(c.reporting_standard || 'IFRS').trim(),
      accounting_method: String(c.accounting_method || 'accrual').trim(),
      vat_registered: c.vat_registered === true || String(c.vat_registered || '').toUpperCase() === 'TRUE',
      tax_id: String(c.tax_id || '').trim() || null,
      fy_start: c.fy_start || '2025-01-01',
      fy_end: c.fy_end || '2025-12-31',
      created_at: now,
    }));
    if (rows.length > 0) await bulkInsert('companies', rows);
    return { saved: rows.length };
  }

  if (action === 'period.list') {
    const rows = await query(
      `SELECT period_name, start_date, end_date, locked
       FROM (
         SELECT *, ROW_NUMBER() OVER(PARTITION BY period_name ORDER BY created_at DESC) AS rn
         FROM periods WHERE company_id = @companyId
       ) WHERE rn = 1
       ORDER BY start_date DESC`,
      { companyId }
    );
    return rows.map((r) => ({ company_id: companyId, period_id: r.period_name || '', start_date: r.start_date || '', end_date: r.end_date || '', locked: !!r.locked }));
  }

  if (action === 'period.save') {
    const { periods } = body;
    if (!periods || !Array.isArray(periods) || periods.length === 0) throw Object.assign(new Error('periods array required'), { code: 'INVALID_INPUT' });
    const validPeriods = periods.filter((p) => p.period_id && p.start_date && p.end_date);
    if (validPeriods.length === 0) return { saved: 0 };
    const now = new Date().toISOString();
    const rows = validPeriods.map((p) => ({ company_id: companyId, period_name: p.period_id, start_date: p.start_date, end_date: p.end_date, locked: !!p.locked, created_at: now, updated_at: now }));
    // DELETE + INSERT: clean replace (no row accumulation)
    await exec(`DELETE FROM periods WHERE company_id = @companyId`, { companyId });
    await bulkInsert('periods', rows);
    return { saved: rows.length };
  }

  if (action === 'settings.get') {
    const rows = await query(`SELECT key, value FROM settings WHERE company_id = @companyId`, { companyId });
    const settings = {};
    for (const row of rows) settings[row.key] = row.value;
    const coRows = await query(
      `SELECT company_name, fy_start, fy_end FROM companies WHERE company_id = @companyId ORDER BY created_at DESC LIMIT 1`,
      { companyId }
    );
    if (coRows.length > 0) {
      settings.companyName = coRows[0].company_name;
      settings.fyStart = String(coRows[0].fy_start || '');
      settings.fyEnd = String(coRows[0].fy_end || '');
    }
    return settings;
  }

  if (action === 'settings.save') {
    const { settings } = body;
    if (!settings || typeof settings !== 'object') throw Object.assign(new Error('settings object required'), { code: 'INVALID_INPUT' });
    const now = new Date().toISOString();
    for (const [key, value] of Object.entries(settings)) {
      const existing = await query(`SELECT key FROM settings WHERE company_id = @companyId AND key = @key LIMIT 1`, { companyId, key });
      if (existing.length > 0) {
        await exec(`UPDATE settings SET value = @value, updated_at = @now WHERE company_id = @companyId AND key = @key`, { companyId, key, value: String(value), now });
      } else {
        await bulkInsert('settings', [{ company_id: companyId, key, value: String(value), updated_at: now }]);
      }
    }
    return { saved: Object.keys(settings).length };
  }
}

// --- Permissions ---

async function handlePermissions(ctx, action) {
  const { companyId, body, userEmail } = ctx;

  if (action === 'permissions.list') {
    return query(`SELECT * FROM user_permissions WHERE company_id = @companyId OR company_id = '*' ORDER BY email`, { companyId });
  }

  if (action === 'permissions.save') {
    const { permissions } = body;
    if (!permissions || !Array.isArray(permissions)) throw Object.assign(new Error('permissions array required'), { code: 'INVALID_INPUT' });
    await exec(`DELETE FROM user_permissions WHERE company_id = @companyId`, { companyId });
    const now = new Date().toISOString();
    const rows = permissions.map((p) => ({ email: p.email, company_id: companyId, role: p.role, granted_at: now, granted_by: userEmail }));
    if (rows.length > 0) await bulkInsert('user_permissions', rows);
    return { saved: rows.length };
  }
}

// --- Diagnostics ---

async function handleDiag(ctx, action) {
  const { companyId, body } = ctx;

  if (action === 'diag.account') {
    const accountCode = body.accountCode || '';
    if (!accountCode) throw Object.assign(new Error('accountCode required'), { code: 'INVALID_INPUT' });

    const lines = await query(
      `SELECT entry_id, batch_id, date, account_code, debit, credit,
              debit - credit AS net, description, reference, source, created_at
       FROM journal_entries
       WHERE company_id = @companyId AND account_code = @accountCode
       ORDER BY date, created_at`,
      { companyId, accountCode }
    );

    const totals = await query(
      `SELECT COUNT(*) AS line_count, SUM(debit) AS total_debit, SUM(credit) AS total_credit,
              SUM(debit - credit) AS net_balance
       FROM journal_entries
       WHERE company_id = @companyId AND account_code = @accountCode`,
      { companyId, accountCode }
    );

    const byCum = await query(
      `SELECT p.period_name, p.end_date,
              COALESCE(SUM(j.debit - j.credit), 0) AS cumulative_balance
       FROM periods p
       LEFT JOIN journal_entries j
         ON j.company_id = @companyId AND j.account_code = @accountCode AND j.date <= p.end_date
       WHERE p.company_id = @companyId
       GROUP BY p.period_name, p.end_date
       ORDER BY p.end_date`,
      { companyId, accountCode }
    );

    return { accountCode, summary: totals[0] || {}, periodBalances: byCum, lines };
  }
}

// Ensure DB is open (with WAL recovery) before accepting requests
ensureDb().then(() => {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`freeBooks API listening on port ${PORT}`);
  });
}).catch(err => {
  console.error('Fatal: could not open database:', err.message);
  process.exit(1);
});

// Graceful shutdown — flush WAL before exit
function shutdown(signal) {
  console.log(`\nShutting down… (${signal})`);
  try {
    const db = getDb();
    // Flush WAL before close to prevent replay issues on next open
    db.exec('CHECKPOINT;', () => {
      db.close(() => {
        console.log('Database closed.');
        process.exit(0);
      });
    });
    // Fallback if close hangs
    setTimeout(() => { console.warn('Close timed out, forcing exit.'); process.exit(1); }, 5000);
  } catch (_) {
    process.exit(0);
  }
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
