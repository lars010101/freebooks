-- =============================================================================
-- freeBooks — baseline schema (migration 001)
-- =============================================================================
-- Creates a FRESH database at schema version 1. Applied once, by
-- db/migrate.js, only when the database has no tables yet; db/migrations/
-- then runs on top, exactly as it does for existing databases.
--
-- FROZEN: do not edit. Every schema change is a numbered file in
-- db/migrations/ (see README "Database migrations"). For the current schema,
-- inspect a freshly initialised database.
-- Views live in db/views.sql and macros in db/macros.sql; both are re-applied
-- on every boot.
--
-- Generated 2026-11-22 from the pre-migration schema, which is kept with its
-- per-table history notes in db/legacy/pre-baseline.sql.
-- =============================================================================

CREATE TABLE IF NOT EXISTS companies (
  company_id VARCHAR NOT NULL,
  company_name VARCHAR NOT NULL,
  jurisdiction VARCHAR NOT NULL,
  currency VARCHAR NOT NULL,
  reporting_standard VARCHAR NOT NULL,
  accounting_method VARCHAR DEFAULT('accrual') NOT NULL,
  vat_registered BOOLEAN DEFAULT(false) NOT NULL,
  tax_id VARCHAR,
  fy_start DATE NOT NULL,
  fy_end DATE NOT NULL,
  created_at TIMESTAMP DEFAULT(now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  company_id VARCHAR NOT NULL,
  account_code VARCHAR NOT NULL,
  account_name VARCHAR NOT NULL,
  account_type VARCHAR NOT NULL,
  account_subtype VARCHAR,
  cf_category VARCHAR,
  is_active BOOLEAN DEFAULT(true) NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_at TIMESTAMP DEFAULT(now()) NOT NULL,
  default_role VARCHAR
);

CREATE TABLE IF NOT EXISTS journal_entries (
  company_id VARCHAR NOT NULL,
  entry_id VARCHAR NOT NULL UNIQUE,
  batch_id VARCHAR NOT NULL,
  date DATE NOT NULL,
  account_code VARCHAR NOT NULL,
  debit DECIMAL(18,4) DEFAULT(0) NOT NULL,
  credit DECIMAL(18,4) DEFAULT(0) NOT NULL,
  currency VARCHAR NOT NULL,
  fx_rate DECIMAL(18,6) DEFAULT(1.0) NOT NULL,
  debit_home DECIMAL(18,4) DEFAULT(0) NOT NULL,
  credit_home DECIMAL(18,4) DEFAULT(0) NOT NULL,
  vat_code VARCHAR,
  vat_amount DECIMAL(18,4) DEFAULT(0),
  vat_amount_home DECIMAL(18,4) DEFAULT(0),
  net_amount DECIMAL(18,4) DEFAULT(0),
  net_amount_home DECIMAL(18,4) DEFAULT(0),
  description VARCHAR,
  reference VARCHAR,
  "source" VARCHAR NOT NULL,
  cost_center VARCHAR,
  profit_center VARCHAR,
  reverses VARCHAR,
  reversed_by VARCHAR,
  bill_id VARCHAR,
  created_by VARCHAR,
  created_at TIMESTAMP DEFAULT(now()) NOT NULL,
  journal_id VARCHAR,
  wht_code VARCHAR,
  wht_amount DECIMAL(18,4) DEFAULT(0),
  wht_amount_home DECIMAL(18,4) DEFAULT(0)
);
CREATE INDEX IF NOT EXISTS idx_journal_entries_company_currency_date ON journal_entries(company_id, currency, date);

CREATE TABLE IF NOT EXISTS vat_codes (
  company_id VARCHAR NOT NULL,
  vat_code VARCHAR NOT NULL,
  description VARCHAR NOT NULL,
  rate DECIMAL(8,4) NOT NULL,
  vat_account_input VARCHAR,
  vat_account_output VARCHAR,
  report_box VARCHAR,
  is_reverse_charge BOOLEAN DEFAULT(false) NOT NULL,
  is_active BOOLEAN DEFAULT(true) NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE
);

CREATE TABLE IF NOT EXISTS bank_mappings (
  company_id VARCHAR NOT NULL,
  mapping_id VARCHAR NOT NULL,
  pattern VARCHAR NOT NULL,
  match_type VARCHAR NOT NULL,
  debit_account VARCHAR NOT NULL,
  credit_account VARCHAR NOT NULL,
  description_override VARCHAR,
  vat_code VARCHAR,
  cost_center VARCHAR,
  profit_center VARCHAR,
  priority INTEGER DEFAULT(100) NOT NULL,
  is_active BOOLEAN DEFAULT(true) NOT NULL,
  amount_sign VARCHAR DEFAULT('any')
);

CREATE TABLE IF NOT EXISTS mapping_suggestions (
  company_id VARCHAR NOT NULL,
  suggestion_id VARCHAR NOT NULL UNIQUE,
  bank_account VARCHAR,
  description_pattern VARCHAR NOT NULL,
  suggested_account VARCHAR NOT NULL,
  suggested_vat_code VARCHAR,
  suggested_dimensions VARCHAR,
  evidence VARCHAR,
  source_proposal_id VARCHAR,
  status VARCHAR DEFAULT('proposed') NOT NULL,
  created_by VARCHAR NOT NULL,
  reviewed_by VARCHAR,
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT(now()) NOT NULL,
  suggested_amount_sign VARCHAR DEFAULT('any'),
  suggested_match_type VARCHAR DEFAULT('contains')
);
CREATE INDEX IF NOT EXISTS idx_mapping_suggestions_company_status ON mapping_suggestions(company_id, status);

CREATE TABLE IF NOT EXISTS matching_history (
  id VARCHAR DEFAULT(uuid()) NOT NULL,
  company_id VARCHAR NOT NULL,
  bank_account VARCHAR,
  description_pattern VARCHAR,
  counterparty VARCHAR,
  amount DOUBLE,
  proposed_dimensions VARCHAR,
  approved_dimensions VARCHAR,
  source_type VARCHAR NOT NULL,
  confidence VARCHAR,
  evidence VARCHAR,
  outcome VARCHAR NOT NULL,
  created_at TIMESTAMP DEFAULT(now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matching_history_company_pattern ON matching_history(company_id, description_pattern);

CREATE TABLE IF NOT EXISTS input_rejections (
  rejection_id VARCHAR DEFAULT(uuid()) NOT NULL,
  company_id VARCHAR NOT NULL,
  statement_id VARCHAR NOT NULL,
  statement_date DATE,
  rejected_lines VARCHAR NOT NULL,
  status VARCHAR DEFAULT('open') NOT NULL,
  created_by VARCHAR NOT NULL,
  created_at TIMESTAMP DEFAULT(now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_input_rejections_company_status ON input_rejections(company_id, status);

CREATE TABLE IF NOT EXISTS settings (
  company_id VARCHAR NOT NULL,
  "key" VARCHAR NOT NULL,
  "value" VARCHAR,
  updated_at TIMESTAMP DEFAULT(now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS user_permissions (
  email VARCHAR NOT NULL,
  company_id VARCHAR NOT NULL,
  "role" VARCHAR NOT NULL,
  granted_at TIMESTAMP DEFAULT(now()) NOT NULL,
  granted_by VARCHAR
);

CREATE TABLE IF NOT EXISTS bills (
  company_id VARCHAR NOT NULL,
  bill_id VARCHAR NOT NULL UNIQUE,
  partner_name VARCHAR NOT NULL,
  vendor_ref VARCHAR,
  date DATE NOT NULL,
  due_date DATE NOT NULL,
  amount DECIMAL(18,4) NOT NULL,
  currency VARCHAR NOT NULL,
  fx_rate DECIMAL(18,6) DEFAULT(1.0) NOT NULL,
  amount_home DECIMAL(18,4) NOT NULL,
  expense_account VARCHAR NOT NULL,
  ap_account VARCHAR NOT NULL,
  vat_code VARCHAR,
  vat_amount DECIMAL(18,4) DEFAULT(0),
  net_amount DECIMAL(18,4) DEFAULT(0),
  cost_center VARCHAR,
  profit_center VARCHAR,
  status VARCHAR DEFAULT('draft') NOT NULL,
  amount_paid DECIMAL(18,4) DEFAULT(0) NOT NULL,
  description VARCHAR,
  created_by VARCHAR,
  created_at TIMESTAMP DEFAULT(now()) NOT NULL,
  draft_lines VARCHAR DEFAULT(NULL),
  reviewed_by VARCHAR,
  reviewed_at TIMESTAMP,
  review_note VARCHAR,
  partner_id VARCHAR,
  wht_code VARCHAR,
  wht_amount DECIMAL(18,4) DEFAULT(0)
);
CREATE INDEX IF NOT EXISTS idx_bills_company_date ON bills(company_id, date);
CREATE INDEX IF NOT EXISTS idx_bills_partner_id ON bills(partner_id);

CREATE TABLE IF NOT EXISTS payments (
  company_id VARCHAR NOT NULL,
  payment_id VARCHAR NOT NULL,
  direction VARCHAR DEFAULT('out') NOT NULL,
  bill_id VARCHAR,
  invoice_id VARCHAR,
  batch_id VARCHAR NOT NULL,
  amount DECIMAL(18,4) NOT NULL,
  amount_foreign DECIMAL(18,4),
  date DATE NOT NULL,
  "method" VARCHAR NOT NULL,
  reference VARCHAR,
  voided_at TIMESTAMP,
  voided_by VARCHAR,
  created_at TIMESTAMP DEFAULT(now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS fx_rates (
  date DATE NOT NULL,
  from_currency VARCHAR NOT NULL,
  to_currency VARCHAR NOT NULL,
  rate DECIMAL(18,6) NOT NULL,
  "source" VARCHAR NOT NULL,
  fetched_at TIMESTAMP DEFAULT(now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fx_rates_from_date ON fx_rates(from_currency, date);
CREATE INDEX IF NOT EXISTS idx_fx_rates_to_date ON fx_rates(to_currency, date);

CREATE TABLE IF NOT EXISTS centers (
  company_id VARCHAR NOT NULL,
  center_id VARCHAR NOT NULL,
  center_type VARCHAR NOT NULL,
  "name" VARCHAR NOT NULL,
  is_active BOOLEAN DEFAULT(true) NOT NULL,
  profit_center_id VARCHAR
);
CREATE INDEX IF NOT EXISTS idx_centers_company_type ON centers(company_id, center_type);

CREATE TABLE IF NOT EXISTS audit_log (
  company_id VARCHAR NOT NULL,
  log_id VARCHAR NOT NULL,
  table_name VARCHAR NOT NULL,
  record_id VARCHAR NOT NULL,
  "action" VARCHAR NOT NULL,
  field_name VARCHAR,
  old_value VARCHAR,
  new_value VARCHAR,
  changed_by VARCHAR NOT NULL,
  changed_at TIMESTAMP DEFAULT(now()) NOT NULL,
  actor_type VARCHAR DEFAULT('human'),
  request_id VARCHAR
);

CREATE TABLE IF NOT EXISTS journals (
  journal_id VARCHAR,
  company_id VARCHAR NOT NULL,
  code VARCHAR NOT NULL,
  "name" VARCHAR NOT NULL,
  active BOOLEAN DEFAULT(true) NOT NULL,
  PRIMARY KEY(journal_id),
  UNIQUE(company_id, code)
);

CREATE TABLE IF NOT EXISTS journal_sequences (
  company_id VARCHAR,
  journal_id VARCHAR,
  "year" INTEGER,
  last_seq INTEGER DEFAULT(0) NOT NULL,
  PRIMARY KEY(company_id, journal_id, "year")
);

CREATE TABLE IF NOT EXISTS periods (
  company_id VARCHAR NOT NULL,
  period_name VARCHAR NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  "locked" BOOLEAN DEFAULT(false),
  created_at TIMESTAMP DEFAULT(now()) NOT NULL,
  updated_at TIMESTAMP DEFAULT(now()) NOT NULL,
  tax_attrs VARCHAR
);

CREATE TABLE IF NOT EXISTS reconciliations (
  company_id VARCHAR,
  batch_id VARCHAR,
  account_code VARCHAR,
  cleared_at TIMESTAMP DEFAULT(now()) NOT NULL,
  cleared_by VARCHAR,
  PRIMARY KEY(company_id, batch_id, account_code)
);

CREATE TABLE IF NOT EXISTS partners (
  partner_id VARCHAR DEFAULT(uuid()) PRIMARY KEY,
  company_id VARCHAR NOT NULL,
  "name" VARCHAR NOT NULL,
  default_currency VARCHAR,
  payment_terms_days INTEGER DEFAULT(30),
  tax_id VARCHAR,
  notes VARCHAR,
  is_active BOOLEAN DEFAULT(true),
  default_expense_account VARCHAR,
  default_ap_account VARCHAR,
  is_vendor BOOLEAN DEFAULT(true),
  is_customer BOOLEAN DEFAULT(false),
  default_revenue_account VARCHAR,
  default_ar_account VARCHAR,
  created_at TIMESTAMP DEFAULT(now())
);
CREATE INDEX IF NOT EXISTS idx_partners_company ON partners(company_id);
CREATE INDEX IF NOT EXISTS idx_partners_customer ON partners(company_id, is_customer);
CREATE INDEX IF NOT EXISTS idx_partners_name ON partners("name");
CREATE INDEX IF NOT EXISTS idx_partners_vendor ON partners(company_id, is_vendor);

CREATE TABLE IF NOT EXISTS attachments (
  attachment_id VARCHAR NOT NULL,
  company_id VARCHAR NOT NULL,
  entity_type VARCHAR NOT NULL,
  entity_id VARCHAR NOT NULL,
  filename VARCHAR NOT NULL,
  content_type VARCHAR NOT NULL,
  file_size INTEGER NOT NULL,
  storage_path VARCHAR NOT NULL,
  uploaded_by VARCHAR,
  uploaded_at TIMESTAMP DEFAULT(now()) NOT NULL,
  sha256 VARCHAR,
  doc_type VARCHAR,
  period_id VARCHAR,
  missing_since TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_attachments_company_sha256 ON attachments(company_id, sha256);
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(company_id, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS reminders (
  reminder_id VARCHAR NOT NULL,
  company_id VARCHAR NOT NULL,
  "source" VARCHAR NOT NULL,
  "label" VARCHAR NOT NULL,
  authority VARCHAR,
  due_date DATE,
  period_id VARCHAR,
  done BOOLEAN DEFAULT(false) NOT NULL,
  created_at TIMESTAMP DEFAULT(now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_company ON reminders(company_id);

CREATE TABLE IF NOT EXISTS orphaned_files (
  orphan_id VARCHAR NOT NULL,
  company_id VARCHAR,
  path VARCHAR NOT NULL,
  discovered_at TIMESTAMP DEFAULT(now()) NOT NULL,
  resolved_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_orphaned_files_company ON orphaned_files(company_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  "key" VARCHAR PRIMARY KEY,
  "action" VARCHAR NOT NULL,
  company_id VARCHAR,
  http_status INTEGER,
  response_json VARCHAR NOT NULL,
  created_at TIMESTAMP DEFAULT(now())
);

CREATE SEQUENCE IF NOT EXISTS events_seq START 1;

CREATE TABLE IF NOT EXISTS events (
  event_seq BIGINT DEFAULT(nextval('events_seq')) NOT NULL,
  event_id VARCHAR DEFAULT(uuid()) NOT NULL,
  company_id VARCHAR NOT NULL,
  event_type VARCHAR NOT NULL,
  entity_type VARCHAR NOT NULL,
  entity_id VARCHAR NOT NULL,
  actor_type VARCHAR DEFAULT('human') NOT NULL,
  actor_id VARCHAR,
  request_id VARCHAR,
  payload VARCHAR,
  created_at TIMESTAMP DEFAULT(now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_company_seq ON events(company_id, event_seq);

CREATE TABLE IF NOT EXISTS api_tokens (
  token_id VARCHAR DEFAULT(uuid()) PRIMARY KEY,
  token_hash VARCHAR NOT NULL UNIQUE,
  "label" VARCHAR NOT NULL,
  email VARCHAR NOT NULL,
  created_at TIMESTAMP DEFAULT(now()),
  created_by VARCHAR,
  revoked_at TIMESTAMP,
  revoked_by VARCHAR
);

CREATE TABLE IF NOT EXISTS journal_proposals (
  company_id VARCHAR NOT NULL,
  proposal_id VARCHAR NOT NULL UNIQUE,
  journal_id VARCHAR,
  date DATE NOT NULL,
  reference VARCHAR,
  description VARCHAR,
  "source" VARCHAR DEFAULT('agent') NOT NULL,
  lines VARCHAR NOT NULL,
  status VARCHAR DEFAULT('proposed') NOT NULL,
  batch_id VARCHAR,
  created_by VARCHAR NOT NULL,
  request_id VARCHAR,
  reviewed_by VARCHAR,
  reviewed_at TIMESTAMP,
  review_note VARCHAR,
  created_at TIMESTAMP DEFAULT(now()) NOT NULL,
  warnings VARCHAR,
  source_transaction_id VARCHAR,
  match_meta VARCHAR,
  updated_at TIMESTAMP,
  corrected_by_batch_id VARCHAR
);
CREATE INDEX IF NOT EXISTS idx_journal_proposals_company_status ON journal_proposals(company_id, status);

CREATE TABLE IF NOT EXISTS bill_lines (
  company_id VARCHAR,
  bill_id VARCHAR,
  line_number INTEGER,
  expense_account VARCHAR NOT NULL,
  amount DECIMAL(18,4) NOT NULL,
  amount_home DECIMAL(18,4) NOT NULL,
  vat_code VARCHAR,
  description VARCHAR,
  cost_center VARCHAR,
  profit_center VARCHAR,
  created_at TIMESTAMP DEFAULT(now()) NOT NULL,
  wht_code VARCHAR,
  PRIMARY KEY(company_id, bill_id, line_number)
);
CREATE INDEX IF NOT EXISTS idx_bill_lines_bill ON bill_lines(company_id, bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_lines_company_account ON bill_lines(company_id, expense_account);

CREATE TABLE IF NOT EXISTS notifications (
  id VARCHAR DEFAULT(uuid()) PRIMARY KEY,
  company_id VARCHAR NOT NULL,
  created_at TIMESTAMP DEFAULT(now()) NOT NULL,
  kind VARCHAR NOT NULL,
  message VARCHAR NOT NULL,
  issue_key VARCHAR,
  read_at TIMESTAMP,
  link_url VARCHAR
);
CREATE INDEX IF NOT EXISTS idx_notifications_company_unread ON notifications(company_id, read_at);

CREATE TABLE IF NOT EXISTS partner_proposals (
  company_id VARCHAR NOT NULL,
  proposal_id VARCHAR NOT NULL UNIQUE,
  "name" VARCHAR NOT NULL,
  tax_id VARCHAR,
  default_currency VARCHAR,
  payment_terms_days INTEGER DEFAULT(30),
  default_expense_account VARCHAR,
  default_ap_account VARCHAR,
  suggested_vat_code VARCHAR,
  is_vendor BOOLEAN DEFAULT(true),
  is_customer BOOLEAN DEFAULT(false),
  evidence JSON,
  source_proposal_id VARCHAR,
  source_bill_id VARCHAR,
  source_description VARCHAR,
  status VARCHAR DEFAULT('proposed') NOT NULL,
  created_by VARCHAR NOT NULL,
  reviewed_by VARCHAR,
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT(now()) NOT NULL,
  duplicate_warning JSON,
  aliased_to_partner_id VARCHAR
);
CREATE INDEX IF NOT EXISTS idx_partner_proposals_company_status ON partner_proposals(company_id, status);
CREATE INDEX IF NOT EXISTS idx_partner_proposals_name ON partner_proposals(company_id, "name");

CREATE TABLE IF NOT EXISTS wht_codes (
  company_id VARCHAR NOT NULL,
  wht_code VARCHAR NOT NULL,
  description VARCHAR NOT NULL,
  rate DECIMAL(8,4) NOT NULL,
  wht_account VARCHAR,
  report_box VARCHAR,
  is_active BOOLEAN DEFAULT(true) NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE
);

CREATE TABLE IF NOT EXISTS bill_extraction_meta (
  bill_id VARCHAR NOT NULL,
  company_id VARCHAR NOT NULL,
  model VARCHAR,
  confidence VARCHAR,
  flags VARCHAR,
  raw_model_output VARCHAR,
  prompt_snapshot VARCHAR,
  pending_vendor_proposal_id VARCHAR,
  created_at TIMESTAMP DEFAULT(now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bill_extraction_meta_bill ON bill_extraction_meta(bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_extraction_meta_company ON bill_extraction_meta(company_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  company_id VARCHAR NOT NULL,
  message_id VARCHAR NOT NULL UNIQUE,
  "role" VARCHAR NOT NULL,
  "content" VARCHAR NOT NULL,
  proposal_ref VARCHAR,
  created_by VARCHAR,
  created_at TIMESTAMP DEFAULT(now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_company ON chat_messages(company_id, created_at);

CREATE TABLE IF NOT EXISTS chat_pending_turns (
  company_id VARCHAR NOT NULL,
  turn_id VARCHAR NOT NULL UNIQUE,
  user_message VARCHAR NOT NULL,
  pending_categories VARCHAR NOT NULL,
  resolved_categories VARCHAR DEFAULT('{}') NOT NULL,
  created_at TIMESTAMP DEFAULT(now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_pending_turns_company ON chat_pending_turns(company_id, created_at);

CREATE TABLE IF NOT EXISTS chat_data_permissions (
  company_id VARCHAR,
  category VARCHAR,
  decision VARCHAR NOT NULL,
  aliased BOOLEAN DEFAULT(false) NOT NULL,
  decided_by VARCHAR,
  decided_at TIMESTAMP DEFAULT(now()) NOT NULL,
  PRIMARY KEY(company_id, category)
);

CREATE TABLE IF NOT EXISTS chat_aliases (
  company_id VARCHAR,
  real_value VARCHAR,
  alias VARCHAR NOT NULL,
  entity_type VARCHAR,
  created_at TIMESTAMP DEFAULT(now()) NOT NULL,
  PRIMARY KEY(company_id, entity_type, real_value)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_chat_aliases_alias ON chat_aliases(company_id, alias);
