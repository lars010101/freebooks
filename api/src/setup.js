'use strict';
/**
 * freeBooks — Setup service
 * Ported from BigQuery Cloud Function to DuckDB/Express.
 *
 * DuckDB note: schema is created via db/migrate.js.
 * setup.init here just validates the connection.
 */

const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert } = require('./db');

async function handleSetup(ctx, action) {
  switch (action) {
    case 'setup.init':        return initSchema(ctx);
    case 'setup.add_company': return addCompany(ctx);
    default:
      throw Object.assign(new Error(`Unknown setup action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

/**
 * Verify schema is in place. Run db/migrate.js first.
 */
async function initSchema(ctx) {
  const tables = await query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'`
  );
  const names = tables.map((t) => t.table_name);
  const expected = ['companies','accounts','journal_entries','vat_codes','bank_mappings','settings','periods','user_permissions','report_runs','bills','bill_payments','fx_rates','centers','audit_log'];
  const present = expected.filter((t) => names.includes(t));
  const missing = expected.filter((t) => !names.includes(t));

  return {
    tablesPresent: present,
    tablesMissing: missing,
    ready: missing.length === 0,
    note: missing.length > 0 ? 'Run `node db/migrate.js` to create missing tables' : 'Schema OK',
  };
}

async function addCompany(ctx) {
  const { userEmail, body } = ctx;
  const { company, coaTemplate, vatCodesTemplate } = body;

  if (!company || !company.company_id || !company.company_name) {
    throw Object.assign(new Error('company object with company_id and company_name required'), { code: 'INVALID_INPUT' });
  }

  const existing = await query(
    `SELECT company_id FROM companies WHERE company_id = @companyId LIMIT 1`,
    { companyId: company.company_id }
  );
  if (existing.length > 0) {
    throw Object.assign(new Error(`Company ${company.company_id} already exists`), { code: 'DUPLICATE' });
  }

  const now = new Date().toISOString();

  await bulkInsert('companies', [{
    company_id: company.company_id,
    company_name: company.company_name,
    jurisdiction: company.jurisdiction || 'SE',
    currency: company.currency || 'SEK',
    reporting_standard: company.reporting_standard || 'K2',
    accounting_method: company.accounting_method || 'accrual',
    vat_registered: company.vat_registered || false,
    tax_id: company.tax_id || null,
    fy_start: company.fy_start,
    fy_end: company.fy_end,
    created_at: now,
  }]);

  if (userEmail) {
    await bulkInsert('user_permissions', [{
      email: userEmail,
      company_id: company.company_id,
      role: 'owner',
      granted_at: now,
      granted_by: userEmail,
    }]);
  }

  let accountsInserted = 0;
  if (coaTemplate && Array.isArray(coaTemplate) && coaTemplate.length > 0) {
    const accounts = coaTemplate.map((a) => ({
      company_id: company.company_id,
      account_code: a.account_code,
      account_name: a.account_name,
      account_type: a.account_type,
      account_subtype: a.account_subtype || null,
      pl_category: a.pl_category || null,
      bs_category: a.bs_category || null,
      cf_category: a.cf_category || null,
      is_active: true,
      effective_from: company.fy_start,
      effective_to: null,
      created_at: now,
    }));
    await bulkInsert('accounts', accounts);
    accountsInserted = accounts.length;
  }

  let vatCodesInserted = 0;
  if (company.vat_registered && vatCodesTemplate && Array.isArray(vatCodesTemplate)) {
    const vatCodes = vatCodesTemplate.map((vc) => ({
      company_id: company.company_id,
      vat_code: vc.vat_code,
      description: vc.description,
      rate: vc.rate,
      vat_account_input: vc.vat_account_input || null,
      vat_account_output: vc.vat_account_output || null,
      report_box: vc.report_box || null,
      is_reverse_charge: vc.is_reverse_charge || false,
      is_active: true,
      effective_from: company.fy_start,
      effective_to: null,
    }));
    await bulkInsert('vat_codes', vatCodes);
    vatCodesInserted = vatCodes.length;
  }

  await bulkInsert('settings', [
    { company_id: company.company_id, key: 'fx_auto_fetch', value: 'false', updated_at: now },
    { company_id: company.company_id, key: 'backup_destination', value: 'none', updated_at: now },
  ]);

  return { created: true, companyId: company.company_id, accountsInserted, vatCodesInserted };
}

module.exports = { handleSetup };
