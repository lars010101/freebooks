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
-- CF — Cash Flow Statement (indirect method)
-- Returns: row_type, section, account_code, account_name, amount, sort1, sort2
-- =============================================================================
CREATE OR REPLACE MACRO cf(cid, start_date, end_date) AS TABLE
WITH
-- Net Income from P&L accounts
net_income AS (
  SELECT
    'Operating' AS section,
    NULL AS account_code,
    'Net Income' AS account_name,
    -- Net Income = Revenue - Expenses. Use credit-debit for all P&L:
    -- Revenue (credit-normal): credit-debit = positive income
    -- Expense (debit-normal): credit-debit = negative (expense reduces income)
    SUM(je.credit - je.debit) AS amount
  FROM journal_entries je
  LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
  WHERE je.company_id = cid
    AND je.date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
    AND a.account_type IN ('Revenue', 'Expense')
),
-- Working Capital movements (credit - debit: positive = cash inflow)
op_wc AS (
  SELECT
    'Operating' AS section,
    je.account_code,
    a.account_name,
    SUM(je.credit) - SUM(je.debit) AS amount
  FROM journal_entries je
  LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
  WHERE je.company_id = cid
    AND je.date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
    AND a.cf_category = 'Op-WC'
  GROUP BY je.account_code, a.account_name
),
-- Tax
op_tax AS (
  SELECT
    'Operating' AS section,
    je.account_code,
    a.account_name,
    SUM(je.credit) - SUM(je.debit) AS amount
  FROM journal_entries je
  LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
  WHERE je.company_id = cid
    AND je.date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
    AND a.cf_category = 'Tax'
  GROUP BY je.account_code, a.account_name
),
-- Investing (credit-debit: positive = cash inflow from asset disposal)
investing AS (
  SELECT
    'Investing' AS section,
    je.account_code,
    a.account_name,
    SUM(je.credit) - SUM(je.debit) AS amount
  FROM journal_entries je
  LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
  WHERE je.company_id = cid
    AND je.date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
    AND a.cf_category = 'Investing'
  GROUP BY je.account_code, a.account_name
),
-- Financing (credit-debit: positive = cash inflow from new borrowings/equity)
financing AS (
  SELECT
    'Financing' AS section,
    je.account_code,
    a.account_name,
    SUM(je.credit) - SUM(je.debit) AS amount
  FROM journal_entries je
  LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
  WHERE je.company_id = cid
    AND je.date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
    AND a.cf_category = 'Financing'
  GROUP BY je.account_code, a.account_name
),
-- Non-cash activities (IAS 7.43 — disclosed separately)
-- Tag the RE/equity contra account as 'NonCash'. Both sides of a non-cash
-- financing entry are then visible: the Financing side (e.g. 203080 Share Capital)
-- shows a credit, and the NonCash side (e.g. 203070 RE) shows a debit.
-- Both are included in net_change so they cancel exactly to zero.
non_cash AS (
  SELECT
    'NonCash' AS section,
    je.account_code,
    a.account_name,
    SUM(je.credit) - SUM(je.debit) AS amount
  FROM journal_entries je
  LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
  WHERE je.company_id = cid
    AND je.date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
    AND a.cf_category = 'NonCash'
  GROUP BY je.account_code, a.account_name
),
-- Opening cash balance (before period)
opening_cash AS (
  SELECT
    'Cash' AS section,
    NULL AS account_code,
    'Cash at Beginning of Period' AS account_name,
    SUM(je.debit) - SUM(je.credit) AS amount
  FROM journal_entries je
  LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
  WHERE je.company_id = cid
    AND je.date < CAST(start_date AS DATE)
    AND a.cf_category = 'Cash'
),
-- All account lines
all_lines AS (
  SELECT 'Net Income'  AS subsection, section, account_code, account_name, amount FROM net_income
  UNION ALL
  SELECT 'Op-WC'       AS subsection, section, account_code, account_name, amount FROM op_wc
  UNION ALL
  SELECT 'Tax'         AS subsection, section, account_code, account_name, amount FROM op_tax
  UNION ALL
  SELECT 'Investing'   AS subsection, section, account_code, account_name, amount FROM investing
  UNION ALL
  SELECT 'Financing'   AS subsection, section, account_code, account_name, amount FROM financing
  UNION ALL
  SELECT 'NonCash'     AS subsection, section, account_code, account_name, amount FROM non_cash
),
-- Subtotals per section
section_totals AS (
  SELECT section, NULL AS account_code,
    'Total ' || section AS account_name,
    SUM(amount) AS amount
  FROM all_lines
  GROUP BY section
),
-- Grand total
net_change AS (
  SELECT NULL AS account_code, 'Net Change in Cash' AS account_name, SUM(amount) AS amount
  FROM section_totals
)
SELECT
  'account'  AS row_type,
  section,
  account_code,
  account_name,
  amount,
  CASE section WHEN 'Operating' THEN 1 WHEN 'Investing' THEN 2 WHEN 'Financing' THEN 3 WHEN 'NonCash' THEN 7 ELSE 4 END AS sort1,
  1 AS sort2
FROM all_lines
UNION ALL
SELECT
  'subtotal' AS row_type,
  section,
  NULL AS account_code,
  account_name,
  amount,
  CASE section WHEN 'Operating' THEN 1 WHEN 'Investing' THEN 2 WHEN 'Financing' THEN 3 WHEN 'NonCash' THEN 7 ELSE 4 END AS sort1,
  2 AS sort2
FROM section_totals
UNION ALL
SELECT
  'total'       AS row_type,
  'Net Change'  AS section,
  NULL          AS account_code,
  account_name,
  amount,
  5             AS sort1,
  3             AS sort2
FROM net_change
UNION ALL
SELECT
  'total'       AS row_type,
  'Cash'        AS section,
  NULL          AS account_code,
  account_name,
  amount,
  6             AS sort1,
  1             AS sort2
FROM opening_cash
UNION ALL
SELECT
  'total'       AS row_type,
  'Cash'        AS section,
  NULL          AS account_code,
  'Cash at End of Period' AS account_name,
  (SELECT SUM(je2.debit) - SUM(je2.credit)
   FROM journal_entries je2
   LEFT JOIN accounts a2 ON a2.company_id = je2.company_id AND a2.account_code = je2.account_code
   WHERE je2.company_id = cid AND je2.date <= CAST(end_date AS DATE) AND a2.cf_category = 'Cash') AS amount,
  6             AS sort1,
  2             AS sort2
ORDER BY sort1, sort2, account_code NULLS LAST;

-- =============================================================================
-- SCE — Statement of Changes in Equity
-- Returns: account_code, account_name, opening_balance, movements, closing_balance
-- =============================================================================
CREATE OR REPLACE MACRO sce(cid, start_date, end_date) AS TABLE
WITH
opening AS (
  SELECT
    je.account_code,
    a.account_name,
    SUM(je.credit) - SUM(je.debit) AS opening_balance
  FROM journal_entries je
  LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
  WHERE je.company_id = cid
    AND je.date < CAST(start_date AS DATE)
    AND a.account_type = 'Equity'
  GROUP BY je.account_code, a.account_name
),
period_mvt AS (
  SELECT
    je.account_code,
    a.account_name,
    SUM(je.credit) - SUM(je.debit) AS movements
  FROM journal_entries je
  LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
  WHERE je.company_id = cid
    AND je.date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
    AND a.account_type = 'Equity'
  GROUP BY je.account_code, a.account_name
),
all_codes AS (
  SELECT account_code, account_name FROM opening
  UNION
  SELECT account_code, account_name FROM period_mvt
)
SELECT
  ac.account_code,
  ac.account_name,
  COALESCE(o.opening_balance, 0) AS opening_balance,
  COALESCE(m.movements, 0)       AS movements,
  COALESCE(o.opening_balance, 0) + COALESCE(m.movements, 0) AS closing_balance
FROM all_codes ac
LEFT JOIN opening    o ON o.account_code = ac.account_code
LEFT JOIN period_mvt m ON m.account_code = ac.account_code
ORDER BY ac.account_code;

-- =============================================================================
-- INTEGRITY — Integrity Checks
-- Returns: check_name, status (OK/FAIL), detail
-- =============================================================================
CREATE OR REPLACE MACRO integrity(cid, start_date, end_date) AS TABLE
WITH
-- BS Balance check
bs_check AS (
  SELECT
    'BS Balance' AS check_name,
    CASE WHEN ABS(
      SUM(CASE WHEN account_type = 'Asset'     THEN debit - credit ELSE 0 END) -
      SUM(CASE WHEN account_type = 'Liability' THEN credit - debit ELSE 0 END) -
      SUM(CASE WHEN account_type = 'Equity'    THEN credit - debit ELSE 0 END)
    ) <= 0.01 THEN 'OK' ELSE 'FAIL' END AS status,
    'Assets: ' || ROUND(SUM(CASE WHEN account_type='Asset' THEN debit-credit ELSE 0 END), 2)
    || ' | Liab+Equity: ' || ROUND(
      SUM(CASE WHEN account_type='Liability' THEN credit-debit ELSE 0 END) +
      SUM(CASE WHEN account_type='Equity'    THEN credit-debit ELSE 0 END), 2
    ) AS detail
  FROM (
    SELECT a.account_type, je.debit, je.credit
    FROM journal_entries je
    LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
    WHERE je.company_id = cid
      AND je.date <= CAST(end_date AS DATE)
      AND a.account_type IN ('Asset', 'Liability', 'Equity')
  ) t
),
-- Journal Balance: unbalanced batches
batch_check AS (
  SELECT
    'Journal Balance' AS check_name,
    CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'FAIL' END AS status,
    CASE WHEN COUNT(*) = 0 THEN 'All batches balance'
      ELSE 'Unbalanced batches: ' || STRING_AGG(batch_id || ' (diff=' || ROUND(diff,2) || ')', ', ')
    END AS detail
  FROM (
    SELECT batch_id, SUM(debit) - SUM(credit) AS diff
    FROM journal_entries
    WHERE company_id = cid
      AND date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
    GROUP BY batch_id
    HAVING ABS(SUM(debit) - SUM(credit)) > 0.01
  ) unbalanced
),
-- Orphan accounts
orphan_check AS (
  SELECT
    'Orphan Accounts' AS check_name,
    CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'FAIL' END AS status,
    CASE WHEN COUNT(*) = 0 THEN 'No orphan accounts'
      ELSE COUNT(DISTINCT je.account_code) || ' orphan code(s): ' || STRING_AGG(DISTINCT je.account_code, ', ')
    END AS detail
  FROM journal_entries je
  WHERE je.company_id = cid
    AND je.date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
    AND NOT EXISTS (
      SELECT 1 FROM accounts a
      WHERE a.company_id = je.company_id AND a.account_code = je.account_code
    )
),
-- Zero lines
zero_check AS (
  SELECT
    'Zero Lines' AS check_name,
    CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'FAIL' END AS status,
    CASE WHEN COUNT(*) = 0 THEN 'No zero lines'
      ELSE COUNT(*) || ' zero-line(s) found'
    END AS detail
  FROM journal_entries
  WHERE company_id = cid
    AND date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
    AND debit = 0 AND credit = 0
)
SELECT * FROM bs_check
UNION ALL
SELECT * FROM batch_check
UNION ALL
SELECT * FROM orphan_check
UNION ALL
SELECT * FROM zero_check;

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

-- =============================================================================
-- RE_ROLLFORWARD — Retained Earnings Roll-Forward (all periods)
-- Returns one row per period defined in the periods table
-- =============================================================================
CREATE OR REPLACE MACRO re_rollforward(cid) AS TABLE
WITH
-- Closing account: DR 999999 / CR 203070 (Retained Earnings)
-- We identify closing entries as movements on account 203070 from MISC journals
periods_data AS (
  SELECT
    p.period_name,
    p.start_date,
    p.end_date,
    -- P&L net income for the period (credit - debit for all P&L accounts)
    COALESCE((
      SELECT SUM(je.credit - je.debit)
      FROM journal_entries je
      LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
      WHERE je.company_id = cid
        AND je.date BETWEEN p.start_date AND p.end_date
        AND a.account_type IN ('Revenue', 'Expense')
    ), 0) AS pl_net,
    -- Closing entry: movement on 203070 in batches that also involve 999999
    COALESCE((
      SELECT SUM(je.credit - je.debit)
      FROM journal_entries je
      WHERE je.company_id = cid
        AND je.date BETWEEN p.start_date AND p.end_date
        AND je.account_code = '203070'
        AND je.batch_id IN (
          SELECT DISTINCT batch_id FROM journal_entries
          WHERE company_id = cid AND account_code = '999999'
        )
    ), 0) AS closing_entry,
    -- Non-cash equity adjustments (e.g. RE capitalisation, IAS 7.43)
    COALESCE((
      SELECT SUM(je.credit - je.debit)
      FROM journal_entries je
      LEFT JOIN accounts a ON a.company_id = je.company_id AND a.account_code = je.account_code
      WHERE je.company_id = cid
        AND je.date BETWEEN p.start_date AND p.end_date
        AND a.cf_category = 'NonCash'
    ), 0) AS noncash_adj,
    -- Opening RE: cumulative credit-debit on 203070 before period start
    COALESCE((
      SELECT SUM(je.credit - je.debit)
      FROM journal_entries je
      WHERE je.company_id = cid
        AND je.date < p.start_date
        AND je.account_code = '203070'
    ), 0) AS opening_re
  FROM periods p
  WHERE p.company_id = cid
)
SELECT
  period_name,
  start_date,
  end_date,
  opening_re,
  pl_net,
  closing_entry,
  noncash_adj,
  opening_re + closing_entry + noncash_adj AS closing_re,
  ROUND(ABS(pl_net - closing_entry), 4) AS diff,
  CASE WHEN ROUND(ABS(pl_net - closing_entry), 4) <= 0.01 THEN 'OK' ELSE 'FAIL' END AS pl_close_status
FROM periods_data
ORDER BY start_date;

-- =============================================================================
-- INTEGRITY_EXTENDED — Additional integrity checks
-- Returns: check_name, status, detail
-- =============================================================================
CREATE OR REPLACE MACRO integrity_extended(cid, start_date, end_date) AS TABLE
WITH
-- Trial Balance check (debits = credits)
tb_check AS (
  SELECT
    'Trial Balance' AS check_name,
    CASE WHEN ROUND(ABS(SUM(debit) - SUM(credit)), 4) <= 0.01 THEN 'OK' ELSE 'FAIL' END AS status,
    'Debits: ' || ROUND(SUM(debit), 2) || ' | Credits: ' || ROUND(SUM(credit), 2)
      || ' | Diff: ' || ROUND(SUM(debit) - SUM(credit), 4) AS detail
  FROM journal_entries
  WHERE company_id = cid
    AND date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
),
-- Uncategorised CF accounts (BS accounts with NULL cf_category, excluding P&L)
cf_uncat AS (
  SELECT
    'Uncategorised CF Accounts' AS check_name,
    CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'WARN' END AS status,
    CASE WHEN COUNT(*) = 0 THEN 'All BS accounts have CF category'
      ELSE COUNT(*) || ' account(s) missing CF category: '
        || STRING_AGG(account_code || ' ' || account_name, ', ')
    END AS detail
  FROM accounts
  WHERE company_id = cid
    AND account_type IN ('Asset', 'Liability', 'Equity')
    AND cf_category IS NULL
    AND is_active = TRUE
),
-- P&L vs Closing Entry for the specified period
pl_close AS (
  SELECT
    'P&L vs Closing Entry' AS check_name,
    CASE WHEN ROUND(ABS(
      COALESCE((SELECT SUM(credit-debit) FROM journal_entries je
        LEFT JOIN accounts a ON a.company_id=je.company_id AND a.account_code=je.account_code
        WHERE je.company_id=cid AND je.date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
        AND a.account_type IN ('Revenue','Expense')), 0)
      -
      COALESCE((SELECT SUM(credit-debit) FROM journal_entries
        WHERE company_id=cid AND date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
        AND account_code='203070' AND batch_id LIKE 'MISC%'), 0)
    ), 4) <= 0.01 THEN 'OK' ELSE 'FAIL' END AS status,
    'P&L net: ' || ROUND(
      COALESCE((SELECT SUM(credit-debit) FROM journal_entries je
        LEFT JOIN accounts a ON a.company_id=je.company_id AND a.account_code=je.account_code
        WHERE je.company_id=cid AND je.date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
        AND a.account_type IN ('Revenue','Expense')), 0), 2)
    || ' | Closing entry: ' || ROUND(
      COALESCE((SELECT SUM(credit-debit) FROM journal_entries
        WHERE company_id=cid AND date BETWEEN CAST(start_date AS DATE) AND CAST(end_date AS DATE)
        AND account_code='203070' AND batch_id LIKE 'MISC%'), 0), 2) AS detail
)
SELECT * FROM tb_check
UNION ALL
SELECT * FROM cf_uncat
UNION ALL
SELECT * FROM pl_close;
