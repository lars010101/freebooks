-- freeBooks — DuckDB Macros
-- Parameterized table macros for formatted financial reports.
-- Usage: SELECT * FROM pl('example_sg', '2025-02-01', '2026-01-31');

-- =============================================================================
-- P&L — Profit & Loss
-- Returns: row_type, section, account_code, account_name, amount
-- row_type: 'account' | 'subtotal' | 'total'
-- =============================================================================
CREATE OR REPLACE MACRO pl(cid, start_date, end_date) AS TABLE
WITH base AS (
  SELECT
    a.account_type,
    COALESCE(a.pl_category, a.account_type) AS section,
    je.account_code,
    a.account_name,
    CASE
      WHEN a.account_type = 'Revenue' THEN SUM(je.credit) - SUM(je.debit)
      ELSE SUM(je.debit) - SUM(je.credit)
    END AS amount
  FROM journal_entries je
  LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
  WHERE je.company_id = cid
    AND je.date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
    AND a.account_type IN ('Revenue', 'Expense')
  GROUP BY a.account_type, section, je.account_code, a.account_name
),
subtotals AS (
  SELECT
    account_type,
    section,
    NULL AS account_code,
    'Total ' || section AS account_name,
    SUM(amount) AS amount
  FROM base
  GROUP BY account_type, section
),
net AS (
  SELECT
    'ZZZ' AS account_type,
    'Net' AS section,
    NULL AS account_code,
    CASE WHEN SUM(CASE WHEN account_type='Revenue' THEN amount ELSE -amount END) >= 0
      THEN 'NET PROFIT' ELSE 'NET LOSS' END AS account_name,
    SUM(CASE WHEN account_type='Revenue' THEN amount ELSE -amount END) AS amount
  FROM base
)
SELECT 'account'  AS row_type, account_type, section, account_code, account_name, amount,
  CASE account_type WHEN 'Revenue' THEN 1 WHEN 'Expense' THEN 2 ELSE 3 END AS sort1,
  1 AS sort2 FROM base
UNION ALL
SELECT 'subtotal' AS row_type, account_type, section, account_code, account_name, amount,
  CASE account_type WHEN 'Revenue' THEN 1 WHEN 'Expense' THEN 2 ELSE 3 END AS sort1,
  2 AS sort2 FROM subtotals
UNION ALL
SELECT 'total'    AS row_type, account_type, section, account_code, account_name, amount,
  3 AS sort1, 3 AS sort2 FROM net
ORDER BY sort1, section, sort2, account_code NULLS LAST;

-- =============================================================================
-- BS — Balance Sheet
-- Returns: row_type, account_type, bs_category, account_code, account_name, balance
-- =============================================================================
CREATE OR REPLACE MACRO bs(cid, as_of_date) AS TABLE
WITH base AS (
  SELECT
    a.account_type,
    COALESCE(a.bs_category, a.account_type) AS bs_category,
    je.account_code,
    a.account_name,
    CASE
      WHEN a.account_type = 'Asset' THEN SUM(je.debit) - SUM(je.credit)
      ELSE SUM(je.credit) - SUM(je.debit)
    END AS balance
  FROM journal_entries je
  LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
  WHERE je.company_id = cid
    AND je.date <= CAST(as_of_date AS DATE)
    AND a.account_type IN ('Asset', 'Liability', 'Equity')
  GROUP BY a.account_type, bs_category, je.account_code, a.account_name
),
subtotals AS (
  SELECT account_type, bs_category,
    NULL AS account_code,
    'Total ' || bs_category AS account_name,
    SUM(balance) AS balance
  FROM base
  GROUP BY account_type, bs_category
),
type_totals AS (
  SELECT account_type, account_type AS bs_category,
    NULL AS account_code,
    'TOTAL ' || UPPER(account_type) AS account_name,
    SUM(balance) AS balance
  FROM base
  GROUP BY account_type
)
SELECT 'account'    AS row_type, account_type, bs_category, account_code, account_name, balance FROM base
UNION ALL
SELECT 'subtotal'   AS row_type, account_type, bs_category, account_code, account_name, balance FROM subtotals
UNION ALL
SELECT 'type_total' AS row_type, account_type, bs_category, account_code, account_name, balance FROM type_totals
ORDER BY account_type, bs_category, row_type, account_code NULLS LAST;

-- =============================================================================
-- TB — Trial Balance
-- =============================================================================
CREATE OR REPLACE MACRO tb(cid, start_date, end_date) AS TABLE
SELECT
  je.account_code,
  a.account_name,
  a.account_type,
  SUM(je.debit)  AS total_debit,
  SUM(je.credit) AS total_credit,
  SUM(je.debit) - SUM(je.credit) AS net_balance
FROM journal_entries je
LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
WHERE je.company_id = cid
  AND je.date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
GROUP BY je.account_code, a.account_name, a.account_type
ORDER BY a.account_type, je.account_code;

-- =============================================================================
-- JOURNAL — Journal Entries (grouped by batch)
-- =============================================================================
CREATE OR REPLACE MACRO journal(cid, start_date, end_date) AS TABLE
SELECT
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
LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
WHERE je.company_id = cid
  AND je.date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
ORDER BY je.date, je.batch_id, je.account_code;

-- =============================================================================
-- GL — General Ledger
-- =============================================================================
CREATE OR REPLACE MACRO gl(cid, start_date, end_date) AS TABLE
SELECT
  je.date,
  je.batch_id,
  je.account_code,
  a.account_name,
  je.description,
  je.reference,
  je.debit,
  je.credit,
  je.currency
FROM journal_entries je
LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
WHERE je.company_id = cid
  AND je.date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
ORDER BY je.account_code, je.date, je.batch_id;
