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
  entry_id        VARCHAR          NOT NULL UNIQUE,
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
-- mapping_suggestions (bank-matching-spec §10.2)
-- Agent-proposed bank-mapping rules awaiting human approval. Same lifecycle as
-- journal_proposals: proposed → approved | rejected. "Approve" writes to
-- bank_mappings (human-attributed). The agent never writes to bank_mappings.
-- =============================================================================
CREATE TABLE IF NOT EXISTS mapping_suggestions (
  company_id           VARCHAR NOT NULL,
  suggestion_id       VARCHAR NOT NULL UNIQUE,
  bank_account        VARCHAR,
  description_pattern VARCHAR NOT NULL,
  suggested_account   VARCHAR NOT NULL,
  suggested_vat_code  VARCHAR,
  suggested_dimensions VARCHAR,   -- JSON
  evidence            VARCHAR,    -- JSON
  source_proposal_id  VARCHAR,
  status              VARCHAR NOT NULL DEFAULT 'proposed',
  created_by          VARCHAR NOT NULL,
  reviewed_by         VARCHAR,
  reviewed_at         TIMESTAMP,
  created_at          TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mapping_suggestions_company_status
  ON mapping_suggestions(company_id, status);

-- =============================================================================
-- matching_history (bank-matching-spec §10.3)
-- Learning store: every proposal's outcome (approved_unedited/approved_edited/
-- rejected) across all tiers. Never pruned (BFL 7 kap retention). Feeds
-- calibration counters (§6.2) and rule crystallization/retirement (§10.5).
-- =============================================================================
CREATE TABLE IF NOT EXISTS matching_history (
  id                   VARCHAR NOT NULL DEFAULT (uuid()),
  company_id           VARCHAR NOT NULL,
  bank_account         VARCHAR,
  description_pattern  VARCHAR,
  counterparty         VARCHAR,
  amount               DOUBLE,
  proposed_dimensions  VARCHAR,   -- JSON
  approved_dimensions  VARCHAR,   -- JSON
  source_type          VARCHAR NOT NULL,  -- learned_rule | open_item | master_data | llm_semantic
  confidence           VARCHAR,   -- JSON
  evidence             VARCHAR,   -- JSON
  outcome              VARCHAR NOT NULL,  -- approved_unedited | approved_edited | rejected
  created_at           TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_matching_history_company_pattern
  ON matching_history(company_id, description_pattern);

-- =============================================================================
-- input_rejections (bank-matching-spec §11.2)
-- Statement lines with missing critical data (missing date, missing amount,
-- missing description AND counterparty). One row per statement with rejected
-- lines — the agent creates it, the inbox aggregates it. Verbs: r (retry),
-- d (discard). Drill-through to individual rejected lines.
-- =============================================================================
CREATE TABLE IF NOT EXISTS input_rejections (
  rejection_id      VARCHAR NOT NULL DEFAULT (uuid()),
  company_id        VARCHAR NOT NULL,
  statement_id      VARCHAR NOT NULL,        -- the attachment/entity id of the statement
  statement_date    DATE,
  rejected_lines    VARCHAR NOT NULL,        -- JSON array of { line, reason, raw }
  status            VARCHAR NOT NULL DEFAULT 'open',  -- open | retried | discarded
  created_by        VARCHAR NOT NULL,        -- agent email
  created_at        TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_input_rejections_company_status
  ON input_rejections(company_id, status);

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
-- bills (Accounts Payable)
-- =============================================================================
CREATE TABLE IF NOT EXISTS bills (
  company_id      VARCHAR        NOT NULL,
  bill_id         VARCHAR        NOT NULL UNIQUE,
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
  amount_foreign DECIMAL(18,4),
  date       DATE           NOT NULL,
  method     VARCHAR        NOT NULL,
  reference  VARCHAR,
  voided_at  TIMESTAMP,
  voided_by  VARCHAR,
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

-- A1 (§2.4): actor attribution on every audit row. actor_type disambiguates
-- human vs agent (comes from the DB role, never asserted); request_id
-- correlates one agent run across calls (body.requestId or X-Request-Id).
-- changed_by stays the actor email (provenance continuity).
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_type VARCHAR DEFAULT 'human';
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS request_id VARCHAR;

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

-- =============================================================================
-- reconciliations
-- =============================================================================
CREATE TABLE IF NOT EXISTS reconciliations (
  company_id   VARCHAR   NOT NULL,
  batch_id     VARCHAR   NOT NULL,
  account_code VARCHAR   NOT NULL,
  cleared_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  cleared_by   VARCHAR,
  PRIMARY KEY (company_id, batch_id, account_code)
);

-- =============================================================================
-- vendors (master list for AP/AR)
-- =============================================================================
CREATE TABLE IF NOT EXISTS vendors (
  vendor_id          VARCHAR PRIMARY KEY DEFAULT (uuid()),
  company_id         VARCHAR NOT NULL,
  name               VARCHAR NOT NULL,
  default_currency   VARCHAR,
  payment_terms_days INTEGER DEFAULT 30,
  tax_id             VARCHAR,
  notes              VARCHAR,
  is_active          BOOLEAN DEFAULT TRUE,
  created_at         TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendors_company ON vendors(company_id);
CREATE INDEX IF NOT EXISTS idx_vendors_name ON vendors(name);

-- MIGRATION: add account_subtype, drop legacy bs_category and pl_category
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_subtype VARCHAR;
ALTER TABLE accounts DROP COLUMN IF EXISTS bs_category;
ALTER TABLE accounts DROP COLUMN IF EXISTS pl_category;

-- MIGRATION: account-level Default flag (settings-ux-spec §7 item 1).
-- Replaces the legacy default_ap_account / default_expense_account settings
-- keys: the Chart of Accounts now carries a default_role column on each
-- account (NULL = not a default; 'AP' = default AP account; 'Expense' =
-- default expense account). Single-holder is enforced server-side in the
-- coa.upsert write path (see api/src/index.js). Backfill below migrates
-- existing companies that still carry the legacy settings rows — backfill
-- only (WHERE default_role IS NULL) so accounts already flagged via the COA
-- UI are never clobbered on a re-run. Expense is applied first so that when
-- the same account is referenced by BOTH legacy keys, the AP UPDATE runs
-- last and wins (last-writer semantics).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS default_role VARCHAR;

UPDATE accounts
SET default_role = 'Expense'
WHERE default_role IS NULL
  AND (company_id, account_code) IN (
    SELECT s.company_id, s.value
    FROM settings s
    WHERE s.key = 'default_expense_account'
      AND s.value IS NOT NULL AND TRIM(s.value) <> ''
  );

UPDATE accounts
SET default_role = 'AP'
WHERE default_role IS NULL
  AND (company_id, account_code) IN (
    SELECT s.company_id, s.value
    FROM settings s
    WHERE s.key = 'default_ap_account'
      AND s.value IS NOT NULL AND TRIM(s.value) <> ''
  );

-- MIGRATION: vendor default expense and AP accounts
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS default_expense_account VARCHAR;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS default_ap_account VARCHAR;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS draft_lines TEXT DEFAULT NULL;

-- MIGRATION (P1-9): payment subledger extensions — manual payments carry an
-- optional reference; foreign-currency settlements record the foreign amount
-- for exact unwind; voids mark the row instead of deleting (append-only).
ALTER TABLE bill_payments ADD COLUMN IF NOT EXISTS amount_foreign DECIMAL(18,4);
ALTER TABLE bill_payments ADD COLUMN IF NOT EXISTS reference VARCHAR;
ALTER TABLE bill_payments ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP;
ALTER TABLE bill_payments ADD COLUMN IF NOT EXISTS voided_by VARCHAR;

-- MIGRATION: VAT tolerance settings
-- Seeded at company creation in api/src/setup.js. Backfill here for companies
-- created before this migration. vat_tolerance = flat amount in home currency
-- (default 0.50); vat_tolerance_pct = percentage of computed VAT (0.01 = 1%).
-- Override is accepted when |stated - computed| <= max(flat, pct * computed).
INSERT INTO settings (company_id, key, value, updated_at)
SELECT c.company_id, 'vat_tolerance', '0.50', NOW()
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM settings s WHERE s.company_id = c.company_id AND s.key = 'vat_tolerance');

INSERT INTO settings (company_id, key, value, updated_at)
SELECT c.company_id, 'vat_tolerance_pct', '0.01', NOW()
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM settings s WHERE s.company_id = c.company_id AND s.key = 'vat_tolerance_pct');

-- =============================================================================
-- attachments
-- =============================================================================
CREATE TABLE IF NOT EXISTS attachments (
  attachment_id  VARCHAR    NOT NULL,
  company_id     VARCHAR    NOT NULL,
  entity_type    VARCHAR    NOT NULL,
  entity_id      VARCHAR    NOT NULL,
  filename       VARCHAR    NOT NULL,
  content_type   VARCHAR    NOT NULL,
  file_size      INTEGER    NOT NULL,
  storage_path   VARCHAR    NOT NULL,
  uploaded_by    VARCHAR,
  uploaded_at    TIMESTAMP  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(company_id, entity_type, entity_id);

-- A4 (§4.7): sha256 dedupe per company. Identical hash within a company reuses
-- the stored blob path (skips the blob write) and inserts a new metadata row
-- only — the hash doubles as integrity evidence. Idempotent house-style
-- evolution (mirrors the audit_log.actor_type / accounts.default_role pattern
-- above): ADD COLUMN IF NOT EXISTS so fresh + existing DBs converge on boot.
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS sha256 VARCHAR;
CREATE INDEX IF NOT EXISTS idx_attachments_company_sha256 ON attachments(company_id, sha256);

-- =============================================================================
-- idempotency_keys (P0-1: safe retries for posting actions)
-- One row per client-supplied Idempotency-Key; stores the first response so
-- retries replay it instead of re-executing the posting action.
-- =============================================================================
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT PRIMARY KEY,
  action        TEXT NOT NULL,
  company_id    TEXT,
  http_status   INTEGER,
  response_json TEXT NOT NULL,
  created_at    TIMESTAMP DEFAULT now()
);

-- Per-year tax & governance attributes (jurisdiction-pack: the pack manifest's
-- taxAttributes/periodAttributes). JSON object keyed by attribute key.
ALTER TABLE periods ADD COLUMN IF NOT EXISTS tax_attrs VARCHAR;

-- =============================================================================
-- events (A2 — §3.1: append-only event stream)
-- Business facts at state transitions (journal posted, bill posted, payment
-- recorded/voided, attachment uploaded, period locked/unlocked). This is the
-- agent's input channel (poll via event.list) AND the audit narrative,
-- distinct from the per-invocation dispatch audit (audit_log, P0-4).
-- Append-only by construction: no UPDATE/DELETE path exists anywhere in the
-- codebase. emitEvent() omits event_seq/event_id so the defaults fire.
-- =============================================================================
CREATE SEQUENCE IF NOT EXISTS events_seq START 1;
CREATE TABLE IF NOT EXISTS events (
  event_seq   BIGINT    NOT NULL DEFAULT nextval('events_seq'),
  event_id    VARCHAR   NOT NULL DEFAULT (uuid()),
  company_id  VARCHAR   NOT NULL,
  event_type  VARCHAR   NOT NULL,    -- 'journal.posted', 'bill.payment.recorded', ...
  entity_type VARCHAR   NOT NULL,    -- 'journal' | 'bill' | 'payment' | 'attachment' | 'period'
  entity_id   VARCHAR   NOT NULL,
  actor_type  VARCHAR   NOT NULL DEFAULT 'human',
  actor_id    VARCHAR,               -- caller email (human or agent account)
  request_id  VARCHAR,
  payload     VARCHAR,               -- compact JSON snapshot, <= 4000 chars
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_company_seq ON events(company_id, event_seq);

-- =============================================================================
-- api_tokens (spec §2.6: per-actor API tokens)
-- Bearer-token authentication for the action API. The token string is shown
-- ONCE at creation; only its sha256 hex is stored. Identity is bound at
-- creation (email); role still resolves from user_permissions per call.
-- Boot-applied like every schema statement (IF NOT EXISTS — fresh + existing
-- DBs converge).
-- =============================================================================
CREATE TABLE IF NOT EXISTS api_tokens (
  token_id    VARCHAR   NOT NULL DEFAULT (uuid()) PRIMARY KEY,
  token_hash  VARCHAR   NOT NULL UNIQUE,
  label       VARCHAR   NOT NULL,
  email       VARCHAR   NOT NULL,
  created_at  TIMESTAMP DEFAULT now(),
  created_by  VARCHAR,
  revoked_at  TIMESTAMP,
  revoked_by  VARCHAR
);

-- =============================================================================
-- journal_proposals (A3j — §4.2: agent/human-proposed journal batches)
-- The prepare/approve flow: an actor (typically an agent) proposes a journal
-- batch; a human reviews and approves (which posts to journal_entries) or
-- rejects (terminal, kept for audit). A proposed batch can NEVER reach
-- journal_entries without a human approve (R5). `lines` stores the JSON array
-- of enriched lines (the exact journal.post row shape), validated at propose
-- time and re-validated at approve time. `batch_id` links the posted batch
-- back to the proposal on approve.
-- =============================================================================
CREATE TABLE IF NOT EXISTS journal_proposals (
  company_id   VARCHAR   NOT NULL,
  proposal_id  VARCHAR   NOT NULL UNIQUE,
  journal_id   VARCHAR,                -- optional series (journals table) → auto reference on post
  date         DATE      NOT NULL,     -- MIN(line dates) — list display + ordering
  reference    VARCHAR,
  description  VARCHAR,
  source       VARCHAR   NOT NULL DEFAULT 'agent',   -- 'agent' | 'human'
  lines        VARCHAR   NOT NULL,    -- JSON array of enriched lines (journal.post row shape)
  status       VARCHAR   NOT NULL DEFAULT 'proposed',   -- proposed | posted | rejected
  batch_id     VARCHAR,                -- set on approve (links to journal_entries.batch_id)
  created_by   VARCHAR   NOT NULL,
  request_id   VARCHAR,
  reviewed_by  VARCHAR,
  reviewed_at  TIMESTAMP,
  review_note  VARCHAR,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_journal_proposals_company_status ON journal_proposals(company_id, status);

-- MIGRATION: persist propose-time warnings (JSON array of warning strings).
-- Computed by buildProposeWarnings at propose/upsert time; flows through to
-- inbox.list for inline warning icons on the review surface.
ALTER TABLE journal_proposals ADD COLUMN IF NOT EXISTS warnings VARCHAR;

-- B4 (bank-matching-spec §1.1): bank transaction ID for dedup. A bank-provided
-- transaction ID (or content hash) checked before the cascade runs to prevent
-- duplicate proposals from feed redelivery.
ALTER TABLE journal_proposals ADD COLUMN IF NOT EXISTS source_transaction_id VARCHAR;

-- ─────────────────────────────────────────────────────────────────────────────
-- bank-mapping-suggestions-spec migrations
-- ─────────────────────────────────────────────────────────────────────────────

-- §1: persist match metadata from the agent loop so approve/reject can record
-- outcomes in matching_history and fire crystallization (§3.1).  JSON blob:
-- { tier, source_type, confidence, evidence, suggested_dimensions }
ALTER TABLE journal_proposals ADD COLUMN IF NOT EXISTS match_meta VARCHAR;

-- §5.2: amount direction condition on bank mapping rules.
-- Values: 'positive' | 'negative' | 'any' (default 'any', backward-compatible).
ALTER TABLE bank_mappings ADD COLUMN IF NOT EXISTS amount_sign VARCHAR DEFAULT 'any';

-- §5.2 + §4.3: amount direction + match type on mapping suggestions so the
-- approved rule inherits them.  suggested_match_type defaults to 'contains'
-- (matching the previous hardcoded behavior).
ALTER TABLE mapping_suggestions ADD COLUMN IF NOT EXISTS suggested_amount_sign VARCHAR DEFAULT 'any';
ALTER TABLE mapping_suggestions ADD COLUMN IF NOT EXISTS suggested_match_type VARCHAR DEFAULT 'contains';

-- =============================================================================
-- bill_lines (P2-3 — Bill Lines Subledger)
-- Expense line items for posted bills. Written alongside journal_entries in
-- createBill; never mutated. Drafts stay as JSON in bills.draft_lines.
-- =============================================================================
CREATE TABLE IF NOT EXISTS bill_lines (
  company_id      VARCHAR        NOT NULL,
  bill_id         VARCHAR        NOT NULL,
  line_number     INTEGER        NOT NULL,     -- 1-based ordinal within the bill
  expense_account VARCHAR        NOT NULL,
  amount          DECIMAL(18,4)  NOT NULL,     -- bill currency (tax-exclusive)
  amount_home     DECIMAL(18,4)  NOT NULL,     -- home currency (amount × fx_rate)
  vat_code        VARCHAR,
  description     VARCHAR,
  cost_center     VARCHAR,
  profit_center   VARCHAR,
  created_at      TIMESTAMP     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, bill_id, line_number)
);
CREATE INDEX IF NOT EXISTS idx_bill_lines_company_account
  ON bill_lines(company_id, expense_account);
CREATE INDEX IF NOT EXISTS idx_bill_lines_bill
  ON bill_lines(company_id, bill_id);

-- MIGRATION (P2-3): backfill bill_lines for existing posted/partial/paid/void
-- bills from journal entries. Uses the same filtering as the old getBillLines
-- (debit > 0, not AP account, not reversed). VAT/GST lines are included for
-- pre-migration bills (cosmetic — accepted per ratified decision §12.1).
-- Forward posts write clean expense-only rows.
INSERT INTO bill_lines (company_id, bill_id, line_number, expense_account, amount, amount_home, vat_code, description, cost_center, profit_center, created_at)
SELECT
  je.company_id,
  je.bill_id,
  ROW_NUMBER() OVER (PARTITION BY je.bill_id ORDER BY je.created_at) AS line_number,
  je.account_code,
  je.debit,
  je.debit_home,
  je.vat_code,
  je.description,
  je.cost_center,
  je.profit_center,
  je.created_at
FROM journal_entries je
WHERE je.bill_id IS NOT NULL
  AND je.debit > 0
  AND je.account_code NOT IN (
    SELECT b.ap_account FROM bills b WHERE b.company_id = je.company_id AND b.bill_id = je.bill_id
  )
  AND je.reversed_by IS NULL
  AND je.bill_id IN (SELECT bill_id FROM bills WHERE status IN ('posted', 'partial', 'paid', 'void'))
ON CONFLICT (company_id, bill_id, line_number) DO NOTHING;

