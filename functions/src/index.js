/**
 * Skuld — Cloud Functions entry point
 *
 * Single HTTP endpoint that routes to action handlers.
 * Called by the Apps Script thin relay in Google Sheets.
 */

const { BigQuery } = require('@google-cloud/bigquery');
const { handleJournal } = require('./journal');
const { handleBank } = require('./bank');
const { handleBills } = require('./bills');
const { handleReports } = require('./reports');
const { handleVat } = require('./vat');
const { handleFx } = require('./fx');
const { handleSetup } = require('./setup');
const { handleBackup } = require('./backup');
const { checkPermission } = require('./auth');

// Shared BigQuery client — reused across invocations
const bq = new BigQuery();
const dataset = bq.dataset('finance');

// Action → required role mapping
const ACTION_ROLES = {
  // Journal
  'journal.post': 'data_entry',
  'journal.reverse': 'data_entry',
  'journal.list': 'viewer',
  'journal.import': 'data_entry',
  'journal.export': 'viewer',

  // Bank processing
  'bank.process': 'data_entry',
  'bank.approve': 'data_entry',

  // Bills (A/P)
  'bill.create': 'data_entry',
  'bill.post': 'data_entry',
  'bill.void': 'data_entry',
  'bill.list': 'viewer',

  // Reports
  'report.refresh_tb': 'viewer',
  'report.refresh_pl': 'viewer',
  'report.refresh_bs': 'viewer',
  'report.refresh_cf': 'viewer',
  'report.refresh_dashboard': 'viewer',
  'report.refresh_ap_aging': 'viewer',
  'report.refresh_vat_return': 'viewer',
  'report.refresh_sce': 'viewer',
  'report.refresh_integrity': 'viewer',

  // COA
  'coa.list': 'viewer',
  'coa.save': 'owner',

  // VAT
  'vat.codes.list': 'viewer',
  'vat.codes.save': 'owner',

  // FX
  'fx.fetch_rates': 'data_entry',
  'fx.revaluation_preview': 'owner',
  'fx.revaluation_post': 'owner',

  // Mappings
  'mapping.list': 'viewer',
  'mapping.save': 'data_entry',

  // Centers
  'center.list': 'viewer',
  'center.save': 'owner',

  // Settings
  'settings.get': 'viewer',
  'settings.save': 'owner',

  // Permissions
  'permissions.list': 'owner',
  'permissions.save': 'owner',

  // Backup
  'backup.export': 'owner',

  // Setup (initial deployment)
  'setup.init': 'owner',
  'setup.add_company': 'owner',
};

/**
 * Main HTTP handler.
 * Expects JSON body: { action, companyId, userEmail, ...params }
 */
async function handler(req, res) {
  // CORS
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body;
    const { action, companyId, userEmail } = body;

    if (!action) {
      res.status(400).json({ error: 'Missing action' });
      return;
    }

    // Setup actions don't require companyId
    if (!action.startsWith('setup.') && !companyId) {
      res.status(400).json({ error: 'Missing companyId' });
      return;
    }

    // Check permissions
    const requiredRole = ACTION_ROLES[action];
    if (!requiredRole) {
      res.status(400).json({ error: `Unknown action: ${action}` });
      return;
    }

    // Skip permission check for setup actions (no data exists yet)
    if (userEmail && !action.startsWith('setup.')) {
      const allowed = await checkPermission(dataset, userEmail, companyId, requiredRole);
      if (!allowed) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }
    }

    // Route to handler
    const ctx = { bq, dataset, body, companyId, userEmail };
    let result;

    const [module] = action.split('.');

    switch (module) {
      case 'journal':
        result = await handleJournal(ctx, action);
        break;
      case 'bank':
        result = await handleBank(ctx, action);
        break;
      case 'bill':
        result = await handleBills(ctx, action);
        break;
      case 'report':
        result = await handleReports(ctx, action);
        break;
      case 'vat':
        result = await handleVat(ctx, action);
        break;
      case 'fx':
        result = await handleFx(ctx, action);
        break;
      case 'coa':
        result = await handleCoa(ctx, action);
        break;
      case 'mapping':
        result = await handleMapping(ctx, action);
        break;
      case 'center':
        result = await handleCenter(ctx, action);
        break;
      case 'settings':
        result = await handleSettings(ctx, action);
        break;
      case 'permissions':
        result = await handlePermissions(ctx, action);
        break;
      case 'backup':
        result = await handleBackup(ctx, action);
        break;
      case 'setup':
        result = await handleSetup(ctx, action);
        break;
      default:
        res.status(400).json({ error: `Unknown module: ${module}` });
        return;
    }

    res.status(200).json({ ok: true, data: result });
  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({
      error: err.message || 'Internal error',
      code: err.code || 'INTERNAL',
    });
  }
}

// --- Simple CRUD handlers for COA, Mappings, Centers, Settings, Permissions ---

async function handleCoa(ctx, action) {
  const { dataset, companyId, body } = ctx;
  const table = dataset.table('accounts');

  if (action === 'coa.list') {
    const [rows] = await dataset.query({
      query: `SELECT * FROM finance.accounts WHERE company_id = @companyId ORDER BY account_code`,
      params: { companyId },
    });
    return rows;
  }

  if (action === 'coa.save') {
    let { accounts } = body; // array of account objects
    if (!accounts || !Array.isArray(accounts)) {
      throw Object.assign(new Error('accounts array required'), { code: 'INVALID_INPUT' });
    }

    // Filter out empty rows (blank account_code from trailing sheet rows)
    accounts = accounts.filter((a) => a.account_code && String(a.account_code).trim() !== '');

    if (accounts.length === 0) {
      throw Object.assign(new Error('No valid accounts found'), { code: 'INVALID_INPUT' });
    }

    // Validate no duplicate codes
    const codes = accounts.map((a) => String(a.account_code).trim());
    const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
    if (dupes.length > 0) {
      throw Object.assign(new Error(`Duplicate account codes: ${dupes.join(', ')}`), { code: 'DUPLICATE_CODE' });
    }

    // Check for accounts being removed that have journal entries
    const incomingCodes = new Set(codes);
    const [usedAccounts] = await dataset.query({
      query: `SELECT DISTINCT account_code FROM finance.journal_entries WHERE company_id = @companyId`,
      params: { companyId },
    });
    const blocked = usedAccounts
      .filter((a) => !incomingCodes.has(a.account_code))
      .map((a) => a.account_code);
    if (blocked.length > 0) {
      throw Object.assign(
        new Error(`Cannot remove accounts with existing transactions: ${blocked.join(', ')}`),
        { code: 'REFERENTIAL_INTEGRITY' }
      );
    }

    // Delete existing + re-insert (full replace for COA saves)
    await dataset.query({
      query: `DELETE FROM finance.accounts WHERE company_id = @companyId`,
      params: { companyId },
    });

    const rows = accounts.map((a) => ({
      company_id: companyId,
      account_code: a.account_code,
      account_name: a.account_name,
      account_type: a.account_type,
      account_subtype: a.account_subtype || null,
      pl_category: a.pl_category || null,
      bs_category: a.bs_category || null,
      cf_category: a.cf_category || null,
      is_active: a.is_active !== false,
      effective_from: a.effective_from,
      effective_to: a.effective_to || null,
      created_at: new Date().toISOString(),
    }));

    await table.insert(rows);
    return { saved: rows.length };
  }
}

async function handleMapping(ctx, action) {
  const { dataset, companyId, body } = ctx;

  if (action === 'mapping.list') {
    const [rows] = await dataset.query({
      query: `SELECT * FROM finance.bank_mappings WHERE company_id = @companyId ORDER BY priority`,
      params: { companyId },
    });
    return rows;
  }

  if (action === 'mapping.save') {
    const { mappings } = body;
    if (!mappings || !Array.isArray(mappings)) {
      throw Object.assign(new Error('mappings array required'), { code: 'INVALID_INPUT' });
    }

    await dataset.query({
      query: `DELETE FROM finance.bank_mappings WHERE company_id = @companyId`,
      params: { companyId },
    });

    const rows = mappings.map((m) => ({
      company_id: companyId,
      mapping_id: m.mapping_id || require('uuid').v4(),
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

    if (rows.length > 0) {
      await dataset.table('bank_mappings').insert(rows);
    }
    return { saved: rows.length };
  }
}

async function handleCenter(ctx, action) {
  const { dataset, companyId, body } = ctx;

  if (action === 'center.list') {
    const [rows] = await dataset.query({
      query: `SELECT * FROM finance.centers WHERE company_id = @companyId ORDER BY center_type, center_id`,
      params: { companyId },
    });
    return rows;
  }

  if (action === 'center.save') {
    const { centers } = body;
    if (!centers || !Array.isArray(centers)) {
      throw Object.assign(new Error('centers array required'), { code: 'INVALID_INPUT' });
    }

    await dataset.query({
      query: `DELETE FROM finance.centers WHERE company_id = @companyId`,
      params: { companyId },
    });

    const rows = centers.map((c) => ({
      company_id: companyId,
      center_id: c.center_id,
      center_type: c.center_type,
      name: c.name,
      is_active: c.is_active !== false,
    }));

    if (rows.length > 0) {
      await dataset.table('centers').insert(rows);
    }
    return { saved: rows.length };
  }
}

async function handleSettings(ctx, action) {
  const { dataset, companyId, body } = ctx;

  if (action === 'settings.get') {
    const [rows] = await dataset.query({
      query: `SELECT key, value FROM finance.settings WHERE company_id = @companyId`,
      params: { companyId },
    });
    const settings = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    // Also include company FY dates from companies table
    const [coRows] = await dataset.query({
      query: `SELECT company_name, fy_start, fy_end FROM finance.companies WHERE company_id = @companyId LIMIT 1`,
      params: { companyId },
    });
    if (coRows.length > 0) {
      settings.companyName = coRows[0].company_name;
      settings.fyStart = coRows[0].fy_start?.value || String(coRows[0].fy_start || '');
      settings.fyEnd = coRows[0].fy_end?.value || String(coRows[0].fy_end || '');
    }
    return settings;
  }

  if (action === 'settings.save') {
    const { settings } = body; // { key: value, ... }
    if (!settings || typeof settings !== 'object') {
      throw Object.assign(new Error('settings object required'), { code: 'INVALID_INPUT' });
    }

    const now = new Date().toISOString();
    for (const [key, value] of Object.entries(settings)) {
      // Upsert via DELETE + INSERT (BigQuery doesn't have native UPSERT)
      await dataset.query({
        query: `DELETE FROM finance.settings WHERE company_id = @companyId AND key = @key`,
        params: { companyId, key },
      });
      await dataset.table('settings').insert([{
        company_id: companyId,
        key,
        value: String(value),
        updated_at: now,
      }]);
    }
    return { saved: Object.keys(settings).length };
  }
}

async function handlePermissions(ctx, action) {
  const { dataset, companyId, body } = ctx;

  if (action === 'permissions.list') {
    const [rows] = await dataset.query({
      query: `SELECT * FROM finance.user_permissions WHERE company_id = @companyId OR company_id = '*' ORDER BY email`,
      params: { companyId },
    });
    return rows;
  }

  if (action === 'permissions.save') {
    const { permissions } = body;
    if (!permissions || !Array.isArray(permissions)) {
      throw Object.assign(new Error('permissions array required'), { code: 'INVALID_INPUT' });
    }

    await dataset.query({
      query: `DELETE FROM finance.user_permissions WHERE company_id = @companyId`,
      params: { companyId },
    });

    const now = new Date().toISOString();
    const rows = permissions.map((p) => ({
      email: p.email,
      company_id: companyId,
      role: p.role,
      granted_at: now,
      granted_by: ctx.userEmail,
    }));

    if (rows.length > 0) {
      await dataset.table('user_permissions').insert(rows);
    }
    return { saved: rows.length };
  }
}

// Export for Cloud Functions
module.exports = { handler };
