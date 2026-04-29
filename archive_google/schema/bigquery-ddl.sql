-- Skuld — BigQuery Schema
-- Dataset: finance
-- All tables use company_id for multi-company isolation within a single dataset.

-- =============================================================================
-- 3.1 companies
-- =============================================================================
CREATE TABLE IF NOT EXISTS finance.companies (
  company_id        STRING    NOT NULL,
  company_name      STRING    NOT NULL,
  jurisdiction      STRING    NOT NULL,   -- ISO country: SE, SG, UK, etc.
  currency          STRING    NOT NULL,   -- ISO 4217: SEK, SGD, USD
  reporting_standard STRING   NOT NULL,   -- K2, K3, SFRS, FRS102, IFRS
  accounting_method STRING    NOT NULL DEFAULT 'accrual',  -- accrual, cash, hybrid
  vat_registered    BOOL      NOT NULL DEFAULT FALSE,
  tax_id            STRING,
  fy_start          DATE      NOT NULL,
  fy_end            DATE      NOT NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- =============================================================================
-- 3.2 accounts (Chart of Accounts)
-- =============================================================================
CREATE TABLE IF NOT EXISTS finance.accounts (
  company_id      STRING    NOT NULL,
  account_code    STRING    NOT NULL,
  account_name    STRING    NOT NULL,
  account_type    STRING    NOT NULL,   -- Asset, Liability, Equity, Revenue, Expense
  account_subtype STRING,
  pl_category     STRING,               -- PL line mapping (NULL for BS-only)
  bs_category     STRING,               -- BS section mapping
  cf_category     STRING,               -- Operating, Op-WC, Investing, Financing, Tax, Excluded
  is_active       BOOL      NOT NULL DEFAULT TRUE,
  effective_from  DATE      NOT NULL,
  effective_to    DATE,                  -- NULL = still active
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- =============================================================================
-- 3.3 journal_entries
-- =============================================================================
CREATE TABLE IF NOT EXISTS finance.journal_entries (
  company_id      STRING    NOT NULL,
  entry_id        STRING    NOT NULL,
  batch_id        STRING    NOT NULL,   -- groups lines of one balanced entry
  date            DATE      NOT NULL,
  account_code    STRING    NOT NULL,
  debit           NUMERIC   NOT NULL DEFAULT 0,
  credit          NUMERIC   NOT NULL DEFAULT 0,
  currency        STRING    NOT NULL,   -- transaction currency
  fx_rate         NUMERIC   NOT NULL DEFAULT 1.0,
  debit_home      NUMERIC   NOT NULL DEFAULT 0,
  credit_home     NUMERIC   NOT NULL DEFAULT 0,
  vat_code        STRING,
  vat_amount      NUMERIC   DEFAULT 0,
  vat_amount_home NUMERIC   DEFAULT 0,
  net_amount      NUMERIC   DEFAULT 0,
  net_amount_home NUMERIC   DEFAULT 0,
  description     STRING,
  reference       STRING,
  source          STRING    NOT NULL,   -- manual, bank_import, csv_import, opening_balance, fx_revaluation, reversal
  cost_center     STRING,
  profit_center   STRING,
  reverses        STRING,               -- batch_id of reversed entry
  reversed_by     STRING,               -- batch_id of reversing entry
  bill_id         STRING,
  created_by      STRING,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- =============================================================================
-- 3.4 vat_codes
-- =============================================================================
CREATE TABLE IF NOT EXISTS finance.vat_codes (
  company_id          STRING    NOT NULL,
  vat_code            STRING    NOT NULL,
  description         STRING    NOT NULL,
  rate                NUMERIC   NOT NULL,  -- e.g. 0.25
  vat_account_input   STRING,              -- FK → accounts (input/purchase VAT)
  vat_account_output  STRING,              -- FK → accounts (output/sales VAT)
  report_box          STRING,              -- box on VAT/GST return
  is_reverse_charge   BOOL      NOT NULL DEFAULT FALSE,
  is_active           BOOL      NOT NULL DEFAULT TRUE,
  effective_from      DATE      NOT NULL,
  effective_to        DATE                 -- NULL = current
);

-- =============================================================================
-- 3.5 bank_mappings
-- =============================================================================
CREATE TABLE IF NOT EXISTS finance.bank_mappings (
  company_id          STRING    NOT NULL,
  mapping_id          STRING    NOT NULL,
  pattern             STRING    NOT NULL,
  match_type          STRING    NOT NULL,   -- exact, starts_with, contains, regex
  debit_account       STRING    NOT NULL,
  credit_account      STRING    NOT NULL,
  description_override STRING,
  vat_code            STRING,
  cost_center         STRING,
  profit_center       STRING,
  priority            INT64     NOT NULL DEFAULT 100,
  is_active           BOOL      NOT NULL DEFAULT TRUE
);

-- =============================================================================
-- 3.6 settings
-- =============================================================================
CREATE TABLE IF NOT EXISTS finance.settings (
  company_id  STRING    NOT NULL,
  key         STRING    NOT NULL,
  value       STRING,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- =============================================================================
-- 3.7 user_permissions
-- =============================================================================
CREATE TABLE IF NOT EXISTS finance.user_permissions (
  email       STRING    NOT NULL,
  company_id  STRING    NOT NULL,   -- '*' = all companies
  role        STRING    NOT NULL,   -- owner, data_entry, viewer
  granted_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  granted_by  STRING
);

-- =============================================================================
-- 3.8 report_runs
-- =============================================================================
CREATE TABLE IF NOT EXISTS finance.report_runs (
  company_id    STRING    NOT NULL,
  run_id        STRING    NOT NULL,
  report_type   STRING    NOT NULL,
  fy_year       INT64,
  period        STRING,
  generated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  generated_by  STRING,
  document_url  STRING,
  ai_model      STRING,
  ai_tokens_used INT64
);

-- =============================================================================
-- 3.9 bills (Accounts Payable)
-- =============================================================================
CREATE TABLE IF NOT EXISTS finance.bills (
  company_id      STRING    NOT NULL,
  bill_id         STRING    NOT NULL,
  vendor          STRING    NOT NULL,
  vendor_ref      STRING,
  date            DATE      NOT NULL,
  due_date        DATE      NOT NULL,
  amount          NUMERIC   NOT NULL,   -- gross
  currency        STRING    NOT NULL,
  fx_rate         NUMERIC   NOT NULL DEFAULT 1.0,
  amount_home     NUMERIC   NOT NULL,
  expense_account STRING    NOT NULL,
  ap_account      STRING    NOT NULL,
  vat_code        STRING,
  vat_amount      NUMERIC   DEFAULT 0,
  net_amount      NUMERIC   DEFAULT 0,
  cost_center     STRING,
  profit_center   STRING,
  status          STRING    NOT NULL DEFAULT 'draft',  -- draft, posted, partial, paid, void
  amount_paid     NUMERIC   NOT NULL DEFAULT 0,
  description     STRING,
  created_by      STRING,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- =============================================================================
-- 3.10 bill_payments
-- =============================================================================
CREATE TABLE IF NOT EXISTS finance.bill_payments (
  company_id  STRING    NOT NULL,
  payment_id  STRING    NOT NULL,
  bill_id     STRING    NOT NULL,
  batch_id    STRING    NOT NULL,   -- FK → journal_entries
  amount      NUMERIC   NOT NULL,
  date        DATE      NOT NULL,
  method      STRING    NOT NULL,   -- bank_match, manual
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- =============================================================================
-- 3.11 fx_rates
-- =============================================================================
CREATE TABLE IF NOT EXISTS finance.fx_rates (
  date          DATE      NOT NULL,
  from_currency STRING    NOT NULL,
  to_currency   STRING    NOT NULL,
  rate          NUMERIC   NOT NULL,
  source        STRING    NOT NULL,   -- ecb, manual, bank
  fetched_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- =============================================================================
-- 3.12 centers (Profit Centers / Cost Centers)
-- =============================================================================
CREATE TABLE IF NOT EXISTS finance.centers (
  company_id  STRING  NOT NULL,
  center_id   STRING  NOT NULL,
  center_type STRING  NOT NULL,   -- cost_center, profit_center
  name        STRING  NOT NULL,
  is_active   BOOL    NOT NULL DEFAULT TRUE
);

-- =============================================================================
-- 3.13 audit_log
-- =============================================================================
CREATE TABLE IF NOT EXISTS finance.audit_log (
  company_id  STRING    NOT NULL,
  log_id      STRING    NOT NULL,
  table_name  STRING    NOT NULL,
  record_id   STRING    NOT NULL,
  action      STRING    NOT NULL,   -- create, update, delete
  field_name  STRING,
  old_value   STRING,
  new_value   STRING,
  changed_by  STRING    NOT NULL,
  changed_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

CREATE TABLE IF NOT EXISTS finance.periods (
  company_id  STRING    NOT NULL,
  period_name STRING    NOT NULL,
  start_date  DATE      NOT NULL,
  end_date    DATE      NOT NULL,
  locked      BOOL      DEFAULT FALSE,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
);
