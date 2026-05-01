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
-- journals
-- =============================================================================
CREATE TABLE IF NOT EXISTS journals (
  journal_id VARCHAR NOT NULL,
  company_id VARCHAR NOT NULL,
  code       VARCHAR NOT NULL,
  name       VARCHAR NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (journal_id),
  UNIQUE (company_id, code)
);

-- =============================================================================
-- journal_sequences
-- =============================================================================
CREATE TABLE IF NOT EXISTS journal_sequences (
  company_id VARCHAR NOT NULL,
  journal_id VARCHAR NOT NULL,
  year       INTEGER NOT NULL,
  last_seq   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, journal_id, year)
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

-- =============================================================================
-- VIEWS
-- =============================================================================

-- Trial Balance
-- Usage: SELECT * FROM v_trial_balance WHERE company_id = 'example_sg' AND date BETWEEN '2025-02-01' AND '2026-01-31';
CREATE OR REPLACE VIEW v_trial_balance AS
SELECT
  je.company_id,
  je.date,
  a.account_code,
  a.account_name,
  a.account_type,
  a.account_subtype,
  SUM(je.debit)  AS total_debit,
  SUM(je.credit) AS total_credit,
  SUM(je.debit) - SUM(je.credit) AS net_balance
FROM journal_entries je
LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
GROUP BY je.company_id, je.date, a.account_code, a.account_name, a.account_type, a.account_subtype;

-- Profit & Loss
-- Usage: SELECT * FROM v_pl WHERE company_id = 'example_sg' AND date BETWEEN '2025-02-01' AND '2026-01-31';
CREATE OR REPLACE VIEW v_pl AS
SELECT
  je.company_id,
  je.date,
  a.account_code,
  a.account_name,
  a.account_type,
  a.account_subtype,
  -- Revenue: credit-normal (positive = credit balance)
  -- Expense: debit-normal (positive = debit balance)
  CASE
    WHEN a.account_type = 'Revenue' THEN SUM(je.credit) - SUM(je.debit)
    ELSE SUM(je.debit) - SUM(je.credit)
  END AS amount
FROM journal_entries je
LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
WHERE a.account_type IN ('Revenue', 'Expense')
GROUP BY je.company_id, je.date, a.account_code, a.account_name, a.account_type, a.account_subtype;

-- Balance Sheet
-- Usage: SELECT * FROM v_bs WHERE company_id = 'example_sg' AND date <= '2026-01-31';
CREATE OR REPLACE VIEW v_bs AS
SELECT
  je.company_id,
  je.date,
  a.account_code,
  a.account_name,
  a.account_type,
  a.account_subtype,
  -- Assets: debit-normal. Liabilities/Equity: credit-normal
  CASE
    WHEN a.account_type = 'Asset' THEN SUM(je.debit) - SUM(je.credit)
    ELSE SUM(je.credit) - SUM(je.debit)
  END AS balance
FROM journal_entries je
LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
WHERE a.account_type IN ('Asset', 'Liability', 'Equity')
GROUP BY je.company_id, je.date, a.account_code, a.account_name, a.account_type, a.account_subtype;

-- General Ledger
-- Usage: SELECT * FROM v_gl WHERE company_id = 'example_sg' AND date BETWEEN '2025-02-01' AND '2026-01-31' ORDER BY account_code, date;
CREATE OR REPLACE VIEW v_gl AS
SELECT
  je.company_id,
  je.date,
  je.batch_id,
  je.account_code,
  a.account_name,
  je.description,
  je.reference,
  je.debit,
  je.credit,
  je.currency,
  je.source
FROM journal_entries je
LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code;

-- MIGRATION: add account_subtype, drop legacy bs_category and pl_category
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_subtype VARCHAR;
ALTER TABLE accounts DROP COLUMN IF EXISTS bs_category;
ALTER TABLE accounts DROP COLUMN IF EXISTS pl_category;
