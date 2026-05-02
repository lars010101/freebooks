'use strict';
/**
 * freeBooks — Setup service
 * Ported from BigQuery Cloud Function to DuckDB/Express.
 *
 * setup.init validates the schema and lists available jurisdictions.
 * setup.add_company creates a new company, loading COA + VAT codes
 * from db/jurisdictions/<jurisdiction>/ if coaTemplate is not supplied.
 */

const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert } = require('./db');

const JURISDICTIONS_DIR = path.resolve(__dirname, '../../db/jurisdictions');

async function handleSetup(ctx, action) {
  switch (action) {
    case 'setup.init':        return initSchema(ctx);
    case 'setup.add_company': return addCompany(ctx);
    default:
      throw Object.assign(new Error(`Unknown setup action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

/**
 * Verify schema and list available jurisdictions.
 */
async function initSchema(ctx) {
  const tables = await query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'`
  );
  const names = tables.map((t) => t.table_name);
  const expected = ['companies','accounts','journal_entries','vat_codes','bank_mappings','settings','periods','user_permissions','report_runs','bills','bill_payments','fx_rates','centers','audit_log'];
  const present = expected.filter((t) => names.includes(t));
  const missing = expected.filter((t) => !names.includes(t));

  // List available jurisdictions
  let jurisdictions = [];
  try {
    jurisdictions = fs.readdirSync(JURISDICTIONS_DIR)
      .filter(d => !d.startsWith('_') && fs.statSync(path.join(JURISDICTIONS_DIR, d)).isDirectory())
      .map(d => {
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(JURISDICTIONS_DIR, d, 'manifest.json'), 'utf8'));
          return { code: d, ...manifest };
        } catch { return { code: d }; }
      });
  } catch {}

  return {
    tablesPresent: present,
    tablesMissing: missing,
    ready: missing.length === 0,
    note: missing.length > 0 ? 'Run `node db/init.js` to create missing tables' : 'Schema OK',
    jurisdictions,
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

  // Load COA from jurisdiction files if not supplied directly
  let resolvedCoa = coaTemplate;
  let resolvedVatCodes = vatCodesTemplate;
  if (!resolvedCoa) {
    const jurisdiction = company.jurisdiction || 'SE';
    const coaPath = path.join(JURISDICTIONS_DIR, jurisdiction, 'coa.json');
    if (fs.existsSync(coaPath)) {
      resolvedCoa = JSON.parse(fs.readFileSync(coaPath, 'utf8'));
    }
  }
  if (!resolvedVatCodes) {
    const jurisdiction = company.jurisdiction || 'SE';
    const vatPath = path.join(JURISDICTIONS_DIR, jurisdiction, 'vat_codes.json');
    if (fs.existsSync(vatPath)) {
      resolvedVatCodes = JSON.parse(fs.readFileSync(vatPath, 'utf8'));
    }
  }

  let accountsInserted = 0;
  if (resolvedCoa && Array.isArray(resolvedCoa) && resolvedCoa.length > 0) {
    const accounts = resolvedCoa.map((a) => ({
      company_id: company.company_id,
      account_code: a.account_code,
      account_name: a.account_name,
      account_type: a.account_type,
      account_subtype: a.account_subtype || a.bs_category || a.pl_category || null,
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
  if (company.vat_registered && resolvedVatCodes && Array.isArray(resolvedVatCodes)) {
    const vatCodes = resolvedVatCodes.map((vc) => ({
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

  // Seed default journals
  const DEFAULT_JOURNALS = [
    { code: 'MISC', name: 'Miscellaneous' },
    { code: 'BANK', name: 'Bank' },
    { code: 'ADJ',  name: 'Adjustments' },
    { code: 'AP',   name: 'Accounts Payable' },
  ];
  await bulkInsert('journals', DEFAULT_JOURNALS.map(j => ({
    journal_id: `${company.company_id}_${j.code.toLowerCase()}`,
    company_id: company.company_id,
    code: j.code,
    name: j.name,
    active: true,
  })));

  return { created: true, companyId: company.company_id, accountsInserted, vatCodesInserted, journalsInserted: DEFAULT_JOURNALS.length };
}

module.exports = { handleSetup };
