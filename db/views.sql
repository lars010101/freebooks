-- =============================================================================
-- freeBooks — views
-- =============================================================================
-- Re-applied on every boot by db/migrate.js (after migrations), so a view
-- change takes effect on the next restart. Every statement must be
-- CREATE OR REPLACE VIEW. A failing statement aborts boot.
-- =============================================================================

-- Current company row. companies is append-versioned (api/src/index.js
-- mergeCompanyRow: a settings edit INSERTs a fresh row, never UPDATEs in
-- place), so any company whose settings have ever been edited has 2+ rows —
-- reading the table directly returns whichever row the engine happens to
-- pick, not necessarily the current one (found 2026-09-15 chasing an AP
-- Control report that silently crashed on a bare, undeduplicated scalar
-- subquery, then a batch of callers that showed a stale company name/
-- currency, then callers that double-processed a company per scan cycle).
-- Every caller that wants "this company's current settings" — not the full
-- history — should read this view, not the companies table directly.
-- Usage: SELECT * FROM v_companies_latest WHERE company_id = 'example_sg';
CREATE OR REPLACE VIEW v_companies_latest AS
SELECT company_id, company_name, jurisdiction, currency, reporting_standard,
       accounting_method, vat_registered, tax_id, fy_start, fy_end, created_at
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY created_at DESC) AS rn
  FROM companies
) t
WHERE rn = 1;

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
