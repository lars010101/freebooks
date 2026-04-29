-- freeBooks — DuckDB Schema
-- Ported from BigQuery (finance dataset)
-- All tables use company_id for multi-company isolation

-- =============================================================================
-- companies
-- =============================================================================
CREATE TABLE IF NOT EXISTS companies (
  company_id         VARCHAR   NOT NULL,
  company_name       VARCHAR   NOT NULL,
  jurisdiction       VARCHAR   NOT NULL,
  currency           VARCHAR   NOT NULL,
  reporting_standard VARCHAR   NOT NULL,
  accounting_method  VARCHAR   NOT NULL DEFAULT 'accrual',
  vat_registered     BOOLEAN   NOT NULL DEFAULT FALSE,
  tax_id             VARCHAR,
  fy_start           DATE      NOT NULL,
  fy_end             DATE      NOT NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- accounts (Chart of Accounts)
-- =============================================================================
CREATE TABLE IF NOT EXISTS accounts (
  company_id      VARCHAR   NOT NULL,
  account_code    VARCHAR   NOT NULL,
  account_name    VARCHAR   NOT NULL,
  account_type    VARCHAR   NOT NULL,
  account_subtype VARCHAR,
  pl_category     VARCHAR,
  bs_category     VARCHAR,
  cf_category     VARCHAR,
  is_active       BOOLEAN   NOT NULL DEFAULT TRUE,
  effective_from  DATE      NOT NULL,
  effective_to    DATE,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- journal_entries
-- =============================================================================
CREATE TABLE IF NOT EXISTS journal_entries (
  company_id      VARCHAR          NOT NULL,
  entry_id        VARCHAR          NOT NULL,
  batch_id        VARCHAR          NOT NULL,
  date            DATE             NOT NULL,
  account_code    VARCHAR          NOT NULL,
  debit           DECIMAL(18,4)    NOT NULL DEFAULT 0,
  credit          DECIMAL(18,4)    NOT NULL DEFAULT 0,
  currency        VARCHAR          NOT NULL,
  fx_rate         DECIMAL(18,6)    NOT NULL DEFAULT 1.0,
  debit_home      DECIMAL(18,4)    NOT NULL DEFAULT 0,
  credit_home     DECIMAL(18,4)    NOT NULL DEFAULT 0,
  vat_code        VARCHAR,
  vat_amount      DECIMAL(18,4)    DEFAULT 0,
  vat_amount_home DECIMAL(18,4)    DEFAULT 0,
  net_amount      DECIMAL(18,4)    DEFAULT 0,
  net_amount_home DECIMAL(18,4)    DEFAULT 0,
  description     VARCHAR,
  reference       VARCHAR,
  source          VARCHAR          NOT NULL,
  cost_center     VARCHAR,
  profit_center   VARCHAR,
  reverses        VARCHAR,
  reversed_by     VARCHAR,
  bill_id         VARCHAR,
  created_by      VARCHAR,
  created_at      TIMESTAMP        NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- vat_codes
-- =============================================================================
CREATE TABLE IF NOT EXISTS vat_codes (
  company_id         VARCHAR        NOT NULL,
  vat_code           VARCHAR        NOT NULL,
  description        VARCHAR        NOT NULL,
  rate               DECIMAL(8,4)   NOT NULL,
  vat_account_input  VARCHAR,
  vat_account_output VARCHAR,
  report_box         VARCHAR,
  is_reverse_charge  BOOLEAN        NOT NULL DEFAULT FALSE,
  is_active          BOOLEAN        NOT NULL DEFAULT TRUE,
  effective_from     DATE           NOT NULL,
  effective_to       DATE
);

-- =============================================================================
-- bank_mappings
-- =============================================================================
CREATE TABLE IF NOT EXISTS bank_mappings (
  company_id           VARCHAR  NOT NULL,
  mapping_id           VARCHAR  NOT NULL,
  pattern              VARCHAR  NOT NULL,
  match_type           VARCHAR  NOT NULL,
  debit_account        VARCHAR  NOT NULL,
  credit_account       VARCHAR  NOT NULL,
  description_override VARCHAR,
  vat_code             VARCHAR,
  cost_center          VARCHAR,
  profit_center        VARCHAR,
  priority             INTEGER  NOT NULL DEFAULT 100,
  is_active            BOOLEAN  NOT NULL DEFAULT TRUE
);

-- =============================================================================
-- settings
-- =============================================================================
CREATE TABLE IF NOT EXISTS settings (
  company_id VARCHAR   NOT NULL,
  key        VARCHAR   NOT NULL,
  value      VARCHAR,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- user_permissions
-- =============================================================================
CREATE TABLE IF NOT EXISTS user_permissions (
  email      VARCHAR   NOT NULL,
  company_id VARCHAR   NOT NULL,
  role       VARCHAR   NOT NULL,
  granted_at TIMESTAMP NOT NULL DEFAULT NOW(),
  granted_by VARCHAR
);

-- =============================================================================
-- report_runs
-- =============================================================================
CREATE TABLE IF NOT EXISTS report_runs (
  company_id     VARCHAR   NOT NULL,
  run_id         VARCHAR   NOT NULL,
  report_type    VARCHAR   NOT NULL,
  fy_year        INTEGER,
  period         VARCHAR,
  generated_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  generated_by   VARCHAR,
  document_url   VARCHAR,
  ai_model       VARCHAR,
  ai_tokens_used INTEGER
);

-- =============================================================================
-- bills (Accounts Payable)
-- =============================================================================
CREATE TABLE IF NOT EXISTS bills (
  company_id      VARCHAR        NOT NULL,
  bill_id         VARCHAR        NOT NULL,
  vendor          VARCHAR        NOT NULL,
  vendor_ref      VARCHAR,
  date            DATE           NOT NULL,
  due_date        DATE           NOT NULL,
  amount          DECIMAL(18,4)  NOT NULL,
  currency        VARCHAR        NOT NULL,
  fx_rate         DECIMAL(18,6)  NOT NULL DEFAULT 1.0,
  amount_home     DECIMAL(18,4)  NOT NULL,
  expense_account VARCHAR        NOT NULL,
  ap_account      VARCHAR        NOT NULL,
  vat_code        VARCHAR,
  vat_amount      DECIMAL(18,4)  DEFAULT 0,
  net_amount      DECIMAL(18,4)  DEFAULT 0,
  cost_center     VARCHAR,
  profit_center   VARCHAR,
  status          VARCHAR        NOT NULL DEFAULT 'draft',
  amount_paid     DECIMAL(18,4)  NOT NULL DEFAULT 0,
  description     VARCHAR,
  created_by      VARCHAR,
  created_at      TIMESTAMP      NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- bill_payments
-- =============================================================================
CREATE TABLE IF NOT EXISTS bill_payments (
  company_id VARCHAR        NOT NULL,
  payment_id VARCHAR        NOT NULL,
  bill_id    VARCHAR        NOT NULL,
  batch_id   VARCHAR        NOT NULL,
  amount     DECIMAL(18,4)  NOT NULL,
  date       DATE           NOT NULL,
  method     VARCHAR        NOT NULL,
  created_at TIMESTAMP      NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- fx_rates
-- =============================================================================
CREATE TABLE IF NOT EXISTS fx_rates (
  date          DATE           NOT NULL,
  from_currency VARCHAR        NOT NULL,
  to_currency   VARCHAR        NOT NULL,
  rate          DECIMAL(18,6)  NOT NULL,
  source        VARCHAR        NOT NULL,
  fetched_at    TIMESTAMP      NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- centers (Cost/Profit Centers)
-- =============================================================================
CREATE TABLE IF NOT EXISTS centers (
  company_id  VARCHAR  NOT NULL,
  center_id   VARCHAR  NOT NULL,
  center_type VARCHAR  NOT NULL,
  name        VARCHAR  NOT NULL,
  is_active   BOOLEAN  NOT NULL DEFAULT TRUE
);

-- =============================================================================
-- audit_log
-- =============================================================================
CREATE TABLE IF NOT EXISTS audit_log (
  company_id  VARCHAR   NOT NULL,
  log_id      VARCHAR   NOT NULL,
  table_name  VARCHAR   NOT NULL,
  record_id   VARCHAR   NOT NULL,
  action      VARCHAR   NOT NULL,
  field_name  VARCHAR,
  old_value   VARCHAR,
  new_value   VARCHAR,
  changed_by  VARCHAR   NOT NULL,
  changed_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- periods
-- =============================================================================
CREATE TABLE IF NOT EXISTS periods (
  company_id  VARCHAR   NOT NULL,
  period_name VARCHAR   NOT NULL,
  start_date  DATE      NOT NULL,
  end_date    DATE      NOT NULL,
  locked      BOOLEAN   DEFAULT FALSE,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
