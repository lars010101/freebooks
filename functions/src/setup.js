/**
 * Skuld — Setup service
 *
 * Handles initial BigQuery schema creation and company provisioning.
 */

const { v4: uuid } = require('uuid');

/**
 * Route setup actions.
 */
async function handleSetup(ctx, action) {
  switch (action) {
    case 'setup.init':
      return initSchema(ctx);
    case 'setup.add_company':
      return addCompany(ctx);
    default:
      throw Object.assign(new Error(`Unknown setup action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

/**
 * Initialize the BigQuery dataset and tables.
 * Idempotent — safe to call multiple times.
 */
async function initSchema(ctx) {
  const { bq, dataset } = ctx;

  // Create dataset if not exists
  try {
    await dataset.create();
  } catch (err) {
    if (err.code !== 409) throw err; // 409 = already exists
  }

  // Table definitions (simplified — BigQuery auto-detects schema from first insert,
  // but we create explicitly for correctness)
  const tables = [
    {
      id: 'companies',
      schema: [
        { name: 'company_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'company_name', type: 'STRING', mode: 'REQUIRED' },
        { name: 'jurisdiction', type: 'STRING', mode: 'REQUIRED' },
        { name: 'currency', type: 'STRING', mode: 'REQUIRED' },
        { name: 'reporting_standard', type: 'STRING', mode: 'REQUIRED' },
        { name: 'accounting_method', type: 'STRING', mode: 'REQUIRED' },
        { name: 'vat_registered', type: 'BOOL', mode: 'REQUIRED' },
        { name: 'tax_id', type: 'STRING' },
        { name: 'fy_start', type: 'DATE', mode: 'REQUIRED' },
        { name: 'fy_end', type: 'DATE', mode: 'REQUIRED' },
        { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
      ],
    },
    {
      id: 'accounts',
      schema: [
        { name: 'company_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'account_code', type: 'STRING', mode: 'REQUIRED' },
        { name: 'account_name', type: 'STRING', mode: 'REQUIRED' },
        { name: 'account_type', type: 'STRING', mode: 'REQUIRED' },
        { name: 'account_subtype', type: 'STRING' },
        { name: 'pl_category', type: 'STRING' },
        { name: 'bs_category', type: 'STRING' },
        { name: 'cf_category', type: 'STRING' },
        { name: 'is_active', type: 'BOOL', mode: 'REQUIRED' },
        { name: 'effective_from', type: 'DATE', mode: 'REQUIRED' },
        { name: 'effective_to', type: 'DATE' },
        { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
      ],
    },
    {
      id: 'journal_entries',
      schema: [
        { name: 'company_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'entry_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'batch_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'date', type: 'DATE', mode: 'REQUIRED' },
        { name: 'account_code', type: 'STRING', mode: 'REQUIRED' },
        { name: 'debit', type: 'NUMERIC', mode: 'REQUIRED' },
        { name: 'credit', type: 'NUMERIC', mode: 'REQUIRED' },
        { name: 'currency', type: 'STRING', mode: 'REQUIRED' },
        { name: 'fx_rate', type: 'NUMERIC', mode: 'REQUIRED' },
        { name: 'debit_home', type: 'NUMERIC', mode: 'REQUIRED' },
        { name: 'credit_home', type: 'NUMERIC', mode: 'REQUIRED' },
        { name: 'vat_code', type: 'STRING' },
        { name: 'vat_amount', type: 'NUMERIC' },
        { name: 'vat_amount_home', type: 'NUMERIC' },
        { name: 'net_amount', type: 'NUMERIC' },
        { name: 'net_amount_home', type: 'NUMERIC' },
        { name: 'description', type: 'STRING' },
        { name: 'reference', type: 'STRING' },
        { name: 'source', type: 'STRING', mode: 'REQUIRED' },
        { name: 'cost_center', type: 'STRING' },
        { name: 'profit_center', type: 'STRING' },
        { name: 'reverses', type: 'STRING' },
        { name: 'reversed_by', type: 'STRING' },
        { name: 'bill_id', type: 'STRING' },
        { name: 'created_by', type: 'STRING' },
        { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
      ],
    },
    {
      id: 'vat_codes',
      schema: [
        { name: 'company_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'vat_code', type: 'STRING', mode: 'REQUIRED' },
        { name: 'description', type: 'STRING', mode: 'REQUIRED' },
        { name: 'rate', type: 'NUMERIC', mode: 'REQUIRED' },
        { name: 'vat_account_input', type: 'STRING' },
        { name: 'vat_account_output', type: 'STRING' },
        { name: 'report_box', type: 'STRING' },
        { name: 'is_reverse_charge', type: 'BOOL', mode: 'REQUIRED' },
        { name: 'is_active', type: 'BOOL', mode: 'REQUIRED' },
        { name: 'effective_from', type: 'DATE', mode: 'REQUIRED' },
        { name: 'effective_to', type: 'DATE' },
      ],
    },
    {
      id: 'bank_mappings',
      schema: [
        { name: 'company_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'mapping_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'pattern', type: 'STRING', mode: 'REQUIRED' },
        { name: 'match_type', type: 'STRING', mode: 'REQUIRED' },
        { name: 'debit_account', type: 'STRING', mode: 'REQUIRED' },
        { name: 'credit_account', type: 'STRING', mode: 'REQUIRED' },
        { name: 'description_override', type: 'STRING' },
        { name: 'vat_code', type: 'STRING' },
        { name: 'cost_center', type: 'STRING' },
        { name: 'profit_center', type: 'STRING' },
        { name: 'priority', type: 'INT64', mode: 'REQUIRED' },
        { name: 'is_active', type: 'BOOL', mode: 'REQUIRED' },
      ],
    },
    {
      id: 'settings',
      schema: [
        { name: 'company_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'key', type: 'STRING', mode: 'REQUIRED' },
        { name: 'value', type: 'STRING' },
        { name: 'updated_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
      ],
    },
    {
      id: 'user_permissions',
      schema: [
        { name: 'email', type: 'STRING', mode: 'REQUIRED' },
        { name: 'company_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'role', type: 'STRING', mode: 'REQUIRED' },
        { name: 'granted_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
        { name: 'granted_by', type: 'STRING' },
      ],
    },
    {
      id: 'report_runs',
      schema: [
        { name: 'company_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'run_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'report_type', type: 'STRING', mode: 'REQUIRED' },
        { name: 'fy_year', type: 'INT64' },
        { name: 'period', type: 'STRING' },
        { name: 'generated_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
        { name: 'generated_by', type: 'STRING' },
        { name: 'document_url', type: 'STRING' },
        { name: 'ai_model', type: 'STRING' },
        { name: 'ai_tokens_used', type: 'INT64' },
      ],
    },
    {
      id: 'bills',
      schema: [
        { name: 'company_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'bill_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'vendor', type: 'STRING', mode: 'REQUIRED' },
        { name: 'vendor_ref', type: 'STRING' },
        { name: 'date', type: 'DATE', mode: 'REQUIRED' },
        { name: 'due_date', type: 'DATE', mode: 'REQUIRED' },
        { name: 'amount', type: 'NUMERIC', mode: 'REQUIRED' },
        { name: 'currency', type: 'STRING', mode: 'REQUIRED' },
        { name: 'fx_rate', type: 'NUMERIC', mode: 'REQUIRED' },
        { name: 'amount_home', type: 'NUMERIC', mode: 'REQUIRED' },
        { name: 'expense_account', type: 'STRING', mode: 'REQUIRED' },
        { name: 'ap_account', type: 'STRING', mode: 'REQUIRED' },
        { name: 'vat_code', type: 'STRING' },
        { name: 'vat_amount', type: 'NUMERIC' },
        { name: 'net_amount', type: 'NUMERIC' },
        { name: 'cost_center', type: 'STRING' },
        { name: 'profit_center', type: 'STRING' },
        { name: 'status', type: 'STRING', mode: 'REQUIRED' },
        { name: 'amount_paid', type: 'NUMERIC', mode: 'REQUIRED' },
        { name: 'description', type: 'STRING' },
        { name: 'created_by', type: 'STRING' },
        { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
      ],
    },
    {
      id: 'bill_payments',
      schema: [
        { name: 'company_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'payment_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'bill_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'batch_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'amount', type: 'NUMERIC', mode: 'REQUIRED' },
        { name: 'date', type: 'DATE', mode: 'REQUIRED' },
        { name: 'method', type: 'STRING', mode: 'REQUIRED' },
        { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
      ],
    },
    {
      id: 'fx_rates',
      schema: [
        { name: 'date', type: 'DATE', mode: 'REQUIRED' },
        { name: 'from_currency', type: 'STRING', mode: 'REQUIRED' },
        { name: 'to_currency', type: 'STRING', mode: 'REQUIRED' },
        { name: 'rate', type: 'NUMERIC', mode: 'REQUIRED' },
        { name: 'source', type: 'STRING', mode: 'REQUIRED' },
        { name: 'fetched_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
      ],
    },
    {
      id: 'centers',
      schema: [
        { name: 'company_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'center_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'center_type', type: 'STRING', mode: 'REQUIRED' },
        { name: 'name', type: 'STRING', mode: 'REQUIRED' },
        { name: 'is_active', type: 'BOOL', mode: 'REQUIRED' },
      ],
    },
    {
      id: 'audit_log',
      schema: [
        { name: 'company_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'log_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'table_name', type: 'STRING', mode: 'REQUIRED' },
        { name: 'record_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'action', type: 'STRING', mode: 'REQUIRED' },
        { name: 'field_name', type: 'STRING' },
        { name: 'old_value', type: 'STRING' },
        { name: 'new_value', type: 'STRING' },
        { name: 'changed_by', type: 'STRING', mode: 'REQUIRED' },
        { name: 'changed_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
      ],
    },
  ];

  const created = [];
  const existing = [];

  for (const tableDef of tables) {
    try {
      await dataset.createTable(tableDef.id, { schema: { fields: tableDef.schema } });
      created.push(tableDef.id);
    } catch (err) {
      if (err.code === 409) {
        existing.push(tableDef.id);
      } else {
        throw err;
      }
    }
  }

  return {
    dataset: 'finance',
    tablesCreated: created,
    tablesExisting: existing,
    totalTables: tables.length,
  };
}

/**
 * Add a new company with jurisdiction defaults.
 *
 * Input body: { company (object), jurisdiction data loaded from jurisdiction pack }
 */
async function addCompany(ctx) {
  const { dataset, userEmail, body } = ctx;
  const { company, coaTemplate, vatCodesTemplate } = body;

  if (!company || !company.company_id || !company.company_name) {
    throw Object.assign(new Error('company object with company_id and company_name required'), { code: 'INVALID_INPUT' });
  }

  const now = new Date().toISOString();

  // Check company doesn't already exist
  const [existing] = await dataset.query({
    query: `SELECT company_id FROM finance.companies WHERE company_id = @companyId`,
    params: { companyId: company.company_id },
  });
  if (existing.length > 0) {
    throw Object.assign(new Error(`Company ${company.company_id} already exists`), { code: 'DUPLICATE' });
  }

  // Insert company
  await dataset.table('companies').insert([{
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

  // Insert owner permission
  if (userEmail) {
    await dataset.table('user_permissions').insert([{
      email: userEmail,
      company_id: company.company_id,
      role: 'owner',
      granted_at: now,
      granted_by: userEmail,
    }]);
  }

  // Insert COA from template (if provided)
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
    await dataset.table('accounts').insert(accounts);
    accountsInserted = accounts.length;
  }

  // Insert VAT codes from template (if provided and VAT registered)
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
    await dataset.table('vat_codes').insert(vatCodes);
    vatCodesInserted = vatCodes.length;
  }

  // Insert default settings
  const defaultSettings = [
    { key: 'locked_periods', value: '[]' },
    { key: 'backup_destination', value: 'none' },
    { key: 'fx_auto_fetch', value: 'false' },
  ];

  await dataset.table('settings').insert(
    defaultSettings.map((s) => ({
      company_id: company.company_id,
      key: s.key,
      value: s.value,
      updated_at: now,
    }))
  );

  return {
    created: true,
    companyId: company.company_id,
    accountsInserted,
    vatCodesInserted,
  };
}

module.exports = { handleSetup };
