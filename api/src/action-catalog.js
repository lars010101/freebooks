'use strict';
/**
 * freeBooks — Action catalog (P1-1)
 *
 * Single source of truth for the action API. Replaces the scattered
 * ACTION_ROLES map, the IDEMPOTENT_ACTIONS set, and the READONLY_ACTION_RE
 * regex — all are derived from this table in index.js.
 *
 * Served at GET /api/actions for agent self-discovery and used for
 * dispatch-level required-parameter validation (400 INVALID_INPUT naming the
 * missing fields, before the handler runs).
 *
 * Entry shape:
 *   role        'viewer' | 'data_entry' | 'owner'  (permission required)
 *   mutating    false for reads — mutating actions are audited (P0-4)
 *   idempotent  true → dispatch honors Idempotency-Key (P0-1)
 *   audit       false → skip audit logging even though mutating (noisy ops)
 *   agentWritable  true → mutating action an agent actor may call (the §2.3
 *                whitelist guard's allowlist is derived from this flag in
 *                dispatch; the A1 guard-matrix test derives its exclusion set
 *                from the same flag — single source of truth, no drift)
 *   description human/agent summary
 *   params      { name: { type, required } } — dispatch enforces presence of
 *               required fields AND declared types ('string'|'number'|'boolean'|
 *               'object'|'array'|'date'), 400 INVALID_INPUT naming the offender.
 *               Numeric strings pass 'number' (form-encoded callers); 'date'
 *               requires a YYYY-MM-DD-prefixed string.
 */

const ACTIONS = {
  // ── Journal ──────────────────────────────────────────────────────────────
  'journal.post': {
    role: 'data_entry', mutating: true, idempotent: true,
    description: 'Post a balanced manual journal entry (DR=CR per line dates). A sequential {CODE}/{YYYY}/{NNNNN} reference is always minted — journalId omitted defaults to the MISC journal (warning returned).',
    params: {
      lines: { type: 'array', required: true },
      journalId: { type: 'string' },
    },
  },
  'journal.reverse': {
    role: 'data_entry', mutating: true, idempotent: true,
    description: 'Reverse a posted journal batch (creates a reversal batch).',
    params: { batchId: { type: 'string', required: true }, reversalDate: { type: 'date' } },
  },
  'journal.list': {
    role: 'viewer', mutating: false,
    description: 'List/search journal entries with filters.',
    params: { dateFrom: { type: 'date' }, dateTo: { type: 'date' }, accountCode: { type: 'string' }, source: { type: 'string' }, journalCode: { type: 'string' }, billId: { type: 'string' }, sortBy: { type: 'string' }, sortDir: { type: 'string' }, limit: { type: 'number' } },
  },
  'journal.import': {
    role: 'data_entry', mutating: true, idempotent: true,
    description: 'Bulk-import journal entries (all-or-nothing). Entries carrying a reference keep it (source-system voucher identity preserved); entries without any reference get a sequential one minted (entry.journalId, else MISC).',
    params: { entries: { type: 'array', required: true } },
  },
  'sie.import': {
    role: 'data_entry', mutating: true, idempotent: true,
    description: 'Import SIE file (types 1-4): chart of accounts, opening balances, vouchers. dryRun default true.',
    params: { contentBase64: { type: 'string' }, content: { type: 'string' }, dryRun: { type: 'boolean' }, importOpeningBalances: { type: 'boolean' }, fileName: { type: 'string' } },
  },
  'journal.search': {
    role: 'viewer', mutating: false,
    description: 'Full-text search over journal entries.',
    params: { q: { type: 'string', required: true } },
  },
  'journal.get': {
    role: 'viewer', mutating: false,
    description: 'Get one journal batch with its lines.',
    params: { batchId: { type: 'string', required: true } },
  },
  'journal.account_lines': {
    role: 'viewer', mutating: false,
    description: 'All journal lines for one account (date, debit, credit).',
    params: { account_code: { type: 'string', required: true } },
  },
  'journal.account_balance': {
    role: 'viewer', mutating: false,
    description: 'Net balance (SUM debit − SUM credit) for one account.',
    params: { account_code: { type: 'string', required: true } },
  },
  'journal.entry.update': {
    role: 'data_entry', mutating: true,
    description: 'Edit description/account/vat_code on a posted entry. Refuses bill-owned, reversed, and locked-period entries (P0-3).',
    params: { entryId: { type: 'string', required: true }, description: { type: 'string' }, account_code: { type: 'string' }, vat_code: { type: 'string' } },
  },

  // ── Journal proposals (A3j — §4.3: prepare/approve flow) ───────────────────
  // An agent (or human) proposes a journal batch; a human reviews and approves
  // (which posts to journal_entries) or rejects (terminal). A proposed batch
  // can never reach journal_entries without a human approve (R5).
  'journal.propose': {
    // Catalog role is 'agent' (level 1.5), NOT 'data_entry': dispatch runs the
    // numeric role check BEFORE the §2.3 whitelist guard, so a data_entry entry
    // would reject agents (1.5 < 2) before the whitelist ever sees it. 'agent'
    // lets agents (1.5≥1.5), data_entry (2), owner (3) pass; viewers (1) are
    // excluded. 'journal.propose' carries agentWritable:true so dispatch's
    // AGENT_ALLOWED set (derived from this flag) admits it. This is the spec's
    // intent (§4.3 + §2.3).
    role: 'agent', mutating: true, idempotent: true, agentWritable: true,
    description: 'Propose a journal batch (enriched + validated server-side; nothing reaches journal_entries until a human approves). With proposalId: upsert a still-proposed row owned by the same caller.',
    params: {
      lines: { type: 'array', required: true },
      journalId: { type: 'string' },
      reference: { type: 'string' },
      description: { type: 'string' },
      proposalId: { type: 'string' },
    },
  },
  'journal.approve': {
    role: 'data_entry', mutating: true, idempotent: true,
    description: 'Approve a proposed journal batch → posts to journal_entries (re-validates first; created_by = approving human). Stamps reviewer triple + batch_id.',
    params: { proposalId: { type: 'string', required: true }, note: { type: 'string' } },
  },
  'journal.reject': {
    role: 'data_entry', mutating: true, idempotent: true,
    description: 'Reject a proposed journal batch (terminal). note is required — the agent reads the reason via event.list and re-proposes corrected.',
    params: { proposalId: { type: 'string', required: true }, note: { type: 'string', required: true } },
  },
  'journal.proposal.list': {
    role: 'viewer', mutating: false,
    description: 'List journal proposals (queue data) for the company, ordered by date DESC then created_at DESC.',
    params: { status: { type: 'string' }, limit: { type: 'number' } },
  },
  'journal.proposal.get': {
    role: 'viewer', mutating: false,
    description: 'Get one journal proposal incl. parsed enriched lines, proposer, request_id, and review triple.',
    params: { proposalId: { type: 'string', required: true } },
  },

  // ── Period close (P2-1) ────────────────────────────────────────────────────
  'period.close': {
    role: 'owner', mutating: true, idempotent: true, audit: true,
    description: 'Post year-end closing entry: move P&L net result to retained earnings (jurisdiction-pack driven).',
    params: { periodId: { type: 'string', required: true } },
  },

  // ── Inbox (A5 §10) ───────────────────────────────────────────────────────
  // Unified action inbox — read-only aggregator over pending-approval items
  // across modules. v1 fans out to journal_proposals only (Class A; Class B
  // types append per module as they land, §10.7). Viewer role, non-mutating:
  // agents read it naturally (mutating:false passes the §2.3 whitelist), so it
  // is intentionally NOT added to AGENT_ALLOWED.
  'inbox.list': {
    role: 'viewer', mutating: false,
    description: 'List inbox action items (A5 §10) — normalized pending-approval items across modules; v1: journal proposals only.',
    params: { status: { type: 'string' }, limit: { type: 'number' } },
  },

  // ── Bank ─────────────────────────────────────────────────────────────────
  'bank.process': {
    role: 'data_entry', mutating: true, idempotent: true,
    description: 'Match pre-parsed bank rows against ledger (rules + suggestions).',
    params: { rows: { type: 'array', required: true }, bankAccount: { type: 'string' } },
  },
  'bank.approve': {
    role: 'data_entry', mutating: true,
    description: 'Post approved bank-match entries to the ledger.',
    params: { entries: { type: 'array', required: true }, newMappings: { type: 'array' }, journalId: { type: 'string' } },
  },
  'bank.reconcile.list': {
    role: 'viewer', mutating: false,
    description: 'List reconciliation batches for an account.',
    params: { accountCode: { type: 'string', required: true }, dateFrom: { type: 'date' }, dateTo: { type: 'date' } },
  },
  'bank.reconcile.clear': {
    role: 'data_entry', mutating: true,
    description: 'Mark/unmark a journal batch as cleared in reconciliation.',
    params: { batchId: { type: 'string', required: true }, accountCode: { type: 'string', required: true }, cleared: { type: 'boolean' } },
  },
  'bank.uncleared.list': {
    role: 'viewer', mutating: false,
    description: 'List uncleared ledger lines for an account.',
    params: { accountCode: { type: 'string', required: true }, dateFrom: { type: 'date' }, dateTo: { type: 'date' } },
  },
  // B4 (bank-matching-spec §8.2): deterministic single-line matcher. role is
  // 'agent' (1.5), NOT 'data_entry' (2) — dispatch's numeric role check runs
  // before the §2.3 whitelist guard, so data_entry (2) would reject an agent
  // (1.5 < 2) before the whitelist ever sees it. 'agent' lets agents (1.5),
  // data_entry (2), and owner (3) pass; viewers (1) are excluded. The action
  // is non-mutating (mutating:false) so it passes the §2.3 guard naturally and
  // is intentionally NOT added to AGENT_ALLOWED — it reads data and returns
  // structured match results only (never writes).
  'bank.match': {
    role: 'agent', mutating: false,
    description: 'Match a single bank statement line through tiers 1-3 (learned rules, open items, master data). Returns structured match results with per-dimension confidence and evidence. Does not propose — returns results only (bank-matching-spec §8.2).',
    params: {
      line: { type: 'object', required: true },
      bankAccount: { type: 'string' },
    },
  },

  // ── Bills (AP) ───────────────────────────────────────────────────────────
  'bill.create': {
    // Catalog role: agent (1.5) — same dispatch-ordering fix as journal.propose
    // (Phase B, agent-readiness-spec §2.3). The numeric role check runs BEFORE
    // the §2.3 whitelist guard, so a data_entry entry (2) would reject agents
    // (1.5 < 2) before AGENT_ALLOWED ever sees the action. 'agent' lets agents,
    // data_entry, and owner pass; viewers (1) are excluded. bill.create carries
    // agentWritable:true so dispatch's AGENT_ALLOWED set (derived from this
    // flag) admits it. The handler detects agent
    // actors and saves a DRAFT (no journal entries); humans still create+post.
    role: 'agent', mutating: true, idempotent: true, agentWritable: true,
    description: 'Create + post a bill in one step (server computes VAT, FX, journals). Agent actors save a draft instead (human posts via bill.draft.post).',
    params: { bill: { type: 'object', required: true }, _replaceDraftId: { type: 'string' }, payment_batch_id: { type: 'string' } },
  },
  'bill.void': {
    role: 'data_entry', mutating: true, idempotent: true,
    description: 'Void a posted bill (auto-reverses its journals). Paid/partial bills refuse.',
    params: { billId: { type: 'string', required: true } },
  },
  'bill.list': {
    role: 'viewer', mutating: false,
    description: 'List bills with filters (status, partner_name, date range).',
    params: { status: { type: 'string' }, partner_name: { type: 'string' }, description: { type: 'string' }, dateFrom: { type: 'date' }, dateTo: { type: 'date' }, limit: { type: 'number' }, offset: { type: 'number' } },
  },
  'bill.match': {
    role: 'viewer', mutating: false,
    description: 'Find open bills matching an amount/currency (payment matching).',
    params: { amount: { type: 'number', required: true }, currency: { type: 'string', required: true }, partner_name: { type: 'string' }, date: { type: 'date' } },
  },
  'bill.lines': {
    role: 'viewer', mutating: false,
    description: 'Line items of a bill (draft_lines JSON for drafts, bill_lines subledger for posted).',
    params: { billId: { type: 'string', required: true } },
  },
  'bill.aging': {
    role: 'viewer', mutating: false,
    description: 'AP aging report (current / 1-30 / 31-60 / 61-90 / 90+).',
    params: { asOfDate: { type: 'date' }, currency: { type: 'string' } },
  },
  'bill.get': {
    role: 'viewer', mutating: false,
    description: 'Get one bill by id (404 when missing).',
    params: { billId: { type: 'string', required: true } },
  },
  'bill.update': {
    role: 'data_entry', mutating: true,
    description: 'Update bill header fields (vendor_ref, due_date, description).',
    params: { billId: { type: 'string', required: true }, vendor_ref: { type: 'string' }, due_date: { type: 'date' }, description: { type: 'string' } },
  },
  'bill.draft.save': {
    role: 'data_entry', mutating: true,
    description: 'Save a draft bill (no journal entries). Re-save is UPDATE-in-place keyed on bill.bill_id INSIDE the bill object.',
    params: { bill: { type: 'object', required: true } },
  },
  'bill.draft.post': {
    role: 'data_entry', mutating: true, idempotent: true,
    description: 'Post a saved draft (same validation as bill.create).',
    params: { billId: { type: 'string', required: true }, bill: { type: 'object' } },
  },
  'bill.draft.delete': {
    role: 'data_entry', mutating: true,
    description: 'Hard-delete a draft bill (drafts only, never posted).',
    params: { billId: { type: 'string', required: true } },
  },
  'bill.payment.record': {
    role: 'data_entry', mutating: true, idempotent: true,
    description: 'Record a manual payment against a posted/partial bill (shared settlement core; FX split via booking-rate method). amount is in bill currency.',
    params: { billId: { type: 'string', required: true }, date: { type: 'date', required: true }, bankAccount: { type: 'string', required: true }, amount: { type: 'number', required: true }, reference: { type: 'string' }, fxRate: { type: 'number' } },
  },
  'bill.payments': {
    role: 'viewer', mutating: false,
    description: 'Payment history for a bill (amounts, method, reference, voided state).',
    params: { billId: { type: 'string', required: true } },
  },
  'bill.payment.void': {
    role: 'data_entry', mutating: true, idempotent: true,
    description: 'Void a bill payment — reverses the settlement journal, decrements amount_paid, restores bill status.',
    params: { paymentId: { type: 'string', required: true } },
  },

  // ── Matching history (bank-matching cascade learning store) ──────────────
  // Phase B (bank-matching-spec §10.3): every proposal's review outcome across
  // all tiers, never pruned. matching_history.record is the agent-only write
  // (in AGENT_ALLOWED); query/get are viewer reads that pass the §2.3 guard
  // naturally (mutating:false). Feeds calibration (§6) and rule
  // crystallization/retirement (§10.5).
  'matching_history.record': {
    role: 'agent', mutating: true, agentWritable: true,
    description: 'Record a bank-matching proposal outcome (approved_unedited/approved_edited/rejected). Feeds calibration (§6) and rule crystallization/retirement (§10). Agent-only write to learning store.',
    params: {
      bank_account: { type: 'string' },
      description_pattern: { type: 'string', required: true },
      counterparty: { type: 'string' },
      amount: { type: 'number' },
      proposed_dimensions: { type: 'object' },
      approved_dimensions: { type: 'object' },
      source_type: { type: 'string', required: true },
      confidence: { type: 'object' },
      evidence: { type: 'object' },
      outcome: { type: 'string', required: true },
    },
  },
  'matching_history.query': {
    role: 'viewer', mutating: false,
    description: 'Query prior match outcomes for a given line signal (description pattern, counterparty, amount). The learned-rule store (bank-matching-spec §10).',
    params: {
      description_pattern: { type: 'string' },
      counterparty: { type: 'string' },
      bank_account: { type: 'string' },
      limit: { type: 'number' },
    },
  },
  'calibration.get': {
    role: 'viewer', mutating: false,
    description: 'Get calibration counters per (source_type, confidence_band). Plain running counter with N=10 floor (bank-matching-spec §6.2).',
    params: {},
  },

  // ── Input rejections (bank-matching-spec §11.2) ───────────────────────────
  'input_rejection.create': {
    role: 'agent', mutating: true, idempotent: true, agentWritable: true,
    description: 'Create an input rejection item for a statement with lines that have missing critical data (bank-matching-spec §11.2). Agent-only; one item per statement.',
    params: {
      statement_id: { type: 'string', required: true },
      statement_date: { type: 'date' },
      rejected_lines: { type: 'array', required: true },
    },
  },
  'input_rejection.list': {
    role: 'viewer', mutating: false,
    description: 'List input rejection items (filter by status: open/retried/discarded).',
    params: { status: { type: 'string' }, limit: { type: 'number' } },
  },
  'input_rejection.get': {
    role: 'viewer', mutating: false,
    description: 'Get one input rejection item by id (with rejected lines detail).',
    params: { rejectionId: { type: 'string', required: true } },
  },
  'input_rejection.discard': {
    role: 'data_entry', mutating: true,
    description: 'Discard an input rejection — the human decides the lines are spurious (bank header, duplicate, test). Terminal.',
    params: { rejectionId: { type: 'string', required: true } },
  },

  // ── Read models (P1-8) ───────────────────────────────────────────────────
  'view.bills': {
    role: 'viewer', mutating: false,
    description: 'Read model: Payables Bills tab in one call — partners + bills with embedded lines (draft JSON parsed, posted journal lines). Same filters as bill.list.',
    params: { status: { type: 'string' }, partner_name: { type: 'string' }, description: { type: 'string' }, dateFrom: { type: 'date' }, dateTo: { type: 'date' }, limit: { type: 'number' }, offset: { type: 'number' } },
  },
  'view.bank': {
    role: 'viewer', mutating: false,
    description: 'Read model: cash accounts + journals + (when accountCode) reconciliation rows and opening balance. Formerly served the Bank tab UI; now used by the reconciliation report and action RPC callers.',
    params: { accountCode: { type: 'string' }, dateFrom: { type: 'date' }, dateTo: { type: 'date' } },
  },

  // ── Reports / VAT ────────────────────────────────────────────────────────
  'report.refresh_vat_return': {
    role: 'viewer', mutating: true,
    description: 'Recompute + store the VAT return for a period range.',
    params: { periodFrom: { type: 'date', required: true }, periodTo: { type: 'date', required: true } },
  },

  // ── Filings (IA-spec step 4, §5.10) ──────────────────────────────────────
  // Filing instances = jurisdiction-pack descriptor × reporting interval, with
  // due dates (descriptor rules + deadline_overrides), filed state
  // (periods.tax_attrs.filings), and artifact endpoint links. Read-only
  // viewer; filed-state writes flow through period.upsert tax_attrs.
  'filing.list': {
    role: 'viewer', mutating: false,
    description: 'List filing instances per period (descriptor × interval) with due dates, draft/filed state, and artifact links.',
    params: { periodId: { type: 'string' } },
  },

  // ── Chart of accounts ────────────────────────────────────────────────────
  'coa.list': { role: 'viewer', mutating: false, description: 'List accounts (latest revision per code).' },
  'coa.save': {
    role: 'owner', mutating: true,
    description: 'Replace the full COA (accounts in use cannot be removed).',
    params: { accounts: { type: 'array', required: true } },
  },
  'coa.update': {
    role: 'owner', mutating: true,
    description: 'Update name/subtype/cf_category/active on existing accounts.',
    params: { accounts: { type: 'array', required: true } },
  },
  'coa.upsert': {
    role: 'owner', mutating: true,
    description: 'Insert or update one account. account.default_role (optional, null|\'AP\'|\'Expense\'|\'FX Gain/Loss\') sets the company default AP/Expense/FX Gain/Loss account; single-holder enforced server-side in the same write (setting a new holder clears the previous one).',
    params: { account: { type: 'object', required: true } },
  },
  'coa.delete': {
    role: 'owner', mutating: true,
    description: 'Delete an account (blocked when it has transactions).',
    params: { accountCode: { type: 'string', required: true } },
  },

  // ── VAT codes ────────────────────────────────────────────────────────────
  'vat.codes.list': { role: 'viewer', mutating: false, description: 'List VAT/GST codes.' },
  'vat.codes.upsert': {
    role: 'owner', mutating: true,
    description: 'Insert or update one VAT code.',
    params: { vatCode: { type: 'object', required: true } },
  },
  'vat.codes.delete': {
    role: 'owner', mutating: true,
    description: 'Delete one VAT code.',
    params: { vatCode: { type: 'string', required: true } },
  },
  'vat.codes.view': {
    role: 'viewer', mutating: false,
    description: 'View tax codes settings page.',
  },
  'journals.view': {
    role: 'viewer', mutating: false,
    description: 'View journals (books) settings page.',
  },
  'ai.view': {
    role: 'viewer', mutating: false,
    description: 'View AI settings page.',
  },

  // ── FX ───────────────────────────────────────────────────────────────────
  'fx.fetch_rates': {
    role: 'data_entry', mutating: true, audit: false,
    description: 'Fetch rates from the configured provider and store them.',
  },
  'fx.revaluation_preview': {
    role: 'owner', mutating: false,
    description: 'Preview IAS 21 period-end FX revaluation (dry run).',
    params: { revalDate: { type: 'date', required: true } },
  },
  'fx.revaluation_post': {
    role: 'owner', mutating: true, idempotent: true,
    description: 'Post FX revaluation adjustments (FXREVAL- batches).',
    params: { revalDate: { type: 'date', required: true }, fxGainLossAccount: { type: 'string' }, adjustments: { type: 'array', required: true } },
  },
  'fx.rates.list': { role: 'viewer', mutating: false, description: 'List stored FX rates.' },
  'fx.rates.save': {
    role: 'data_entry', mutating: true,
    description: 'Add/update FX rates manually.',
    params: { rates: { type: 'array', required: true } },
  },
  'fx.rates.delete': {
    role: 'data_entry', mutating: true,
    description: 'Delete an FX rate row.',
    params: { date: { type: 'date', required: true }, from_currency: { type: 'string', required: true }, to_currency: { type: 'string', required: true }, source: { type: 'string' } },
  },
  'fx.rates.get': {
    role: 'viewer', mutating: false,
    description: 'Resolve the exact-date rate for a currency pair.',
    params: { fromCurrency: { type: 'string', required: true }, toCurrency: { type: 'string', required: true }, date: { type: 'date', required: true } },
  },
  'fx.providers.list': { role: 'viewer', mutating: false, description: 'List FX providers.' },
  'fx.provider.get': { role: 'viewer', mutating: false, description: 'Get provider config.' },
  'fx.provider.save': {
    role: 'owner', mutating: true,
    description: 'Configure an FX provider (incl. API key).',
    params: { provider: { type: 'string', required: true }, apiKey: { type: 'string' } },
  },
  'fx.coverage': {
    role: 'viewer', mutating: false,
    description: 'Compute FX rate coverage for a date range (stored days vs provider publication days).',
    params: { startDate: { type: 'date', required: true }, endDate: { type: 'date', required: true } },
  },

  // ── Notifications (fx-automation-spec §7) ────────────────────────────────
  'notifications.list': {
    role: 'viewer', mutating: false,
    description: 'List notifications (unread first). Pass all=true to include read.',
  },
  'notifications.mark_read': {
    role: 'data_entry', mutating: true, audit: false,
    description: 'Mark notifications as read (by ids array or all=true).',
    params: { ids: { type: 'array' }, all: { type: 'boolean' } },
  },

  // ── Mappings / centers / journals / partners ──────────────────────────────
  'mapping.list': { role: 'viewer', mutating: false, description: 'List bank-import mapping rules.' },
  'mapping.save': {
    role: 'data_entry', mutating: true,
    description: 'Replace bank-import mapping rules (bulk).',
    params: { mappings: { type: 'array', required: true } },
  },
  'mapping.upsert': {
    role: 'data_entry', mutating: true,
    description: 'Insert or update one mapping rule.',
    params: { mapping: { type: 'object', required: true } },
  },
  'mapping.delete': {
    role: 'data_entry', mutating: true,
    description: 'Delete one mapping rule.',
    params: { mappingId: { type: 'string', required: true } },
  },
  // ── Mapping suggestions (Phase B, bank-matching-spec §10.2/§10.4) ─────────
  // Agent proposes a candidate bank-mapping rule to mapping_suggestions
  // (NEVER to bank_mappings itself). Human reviews via approve/reject; "approve"
  // writes the rule into bank_mappings (human-attributed) — the same
  // "approve is the post" pattern as journal.approve (agent-readiness-spec §4.1).
  // mapping.suggest is the agent-only write (in AGENT_ALLOWED); the suggestion
  // approve/reject are data_entry (human finalizers); list/get are viewer reads.
  'mapping.suggest': {
    role: 'agent', mutating: true, idempotent: true, agentWritable: true,
    description: 'Propose a candidate bank-mapping rule to mapping_suggestions (never to mappings itself). Agent-only; human approves via mapping.suggestion.approve/reject (bank-matching-spec §10.2/§10.4). Runs conflict detection at creation (§4.5).',
    params: {
      suggestionId: { type: 'string' },
      bank_account: { type: 'string' },
      description_pattern: { type: 'string', required: true },
      suggested_account: { type: 'string', required: true },
      suggested_vat_code: { type: 'string' },
      suggested_dimensions: { type: 'object' },
      suggested_amount_sign: { type: 'string' },
      suggested_match_type: { type: 'string' },
      evidence: { type: 'object' },
      source_proposal_id: { type: 'string' },
    },
  },
  'mapping.suggestion.approve': {
    role: 'data_entry', mutating: true,
    description: 'Approve a mapping suggestion — writes the rule into bank_mappings (human-attributed). Same "approve is the post" pattern as journal.approve (agent-readiness-spec §4.1).',
    params: { suggestionId: { type: 'string', required: true } },
  },
  'mapping.suggestion.reject': {
    role: 'data_entry', mutating: true,
    description: 'Reject a mapping suggestion (no note required — lighter than journal reject). Terminal.',
    params: { suggestionId: { type: 'string', required: true } },
  },
  'mapping.suggestion.list': {
    role: 'viewer', mutating: false,
    description: 'List mapping suggestions (filter by status: proposed/approved/rejected).',
    params: { status: { type: 'string' }, limit: { type: 'number' } },
  },
  'mapping.suggestion.get': {
    role: 'viewer', mutating: false,
    description: 'Get one mapping suggestion by id.',
    params: { suggestionId: { type: 'string', required: true } },
  },
  'center.list': { role: 'viewer', mutating: false, description: 'List cost/profit centers.' },
  'center.save': {
    role: 'owner', mutating: true,
    description: 'Replace cost/profit centers (bulk).',
    params: { centers: { type: 'array', required: true } },
  },
  'center.upsert': { role: 'owner', mutating: true, description: 'Insert or update a cost/profit center.', params: { center: { type: 'object', required: true } } },
  'center.delete': { role: 'owner', mutating: true, description: 'Delete a cost/profit center.', params: { centerId: { type: 'string', required: true } } },
  'journals.list': { role: 'viewer', mutating: false, description: 'List journals (reference sequences).' },
  'journals.save': {
    role: 'owner', mutating: true,
    description: 'Insert or update a journal.',
    params: { journal: { type: 'object', required: true } },
  },
  'journals.delete': {
    role: 'owner', mutating: true,
    description: 'Delete a journal.',
    params: { journalId: { type: 'string', required: true } },
  },
  'partner.list': {
    role: 'viewer', mutating: false,
    description: 'List partners (vendors and/or customers). Optional partner_type filter: vendor or customer.',
    params: { partner_type: { type: 'string' } },
  },
  'partner.save': {
    role: 'owner', mutating: true,
    description: 'Replace partners (bulk).',
    params: { partners: { type: 'array', required: true } },
  },
  'partner.delete': {
    role: 'owner', mutating: true,
    description: 'Delete a partner.',
    params: { partnerId: { type: 'string', required: true } },
  },
  'partner.upsert': {
    role: 'owner', mutating: true,
    description: 'Insert or update one partner (vendor or customer).',
    params: { partner: { type: 'object', required: true } },
  },

  // ── Partner proposals (partner-proposal-spec §4.2) ───────────────────────
  'partner.propose': {
    role: 'agent', mutating: true, idempotent: true, agentWritable: true,
    description: 'Agent proposes a new partner for human approval. Writes to partner_proposals, never to partners.',
    params: { name: { type: 'string', required: true }, evidence: { type: 'object', required: true } },
  },
  'partner.proposal.approve': {
    role: 'data_entry', mutating: true,
    description: 'Approve a partner proposal — inserts into partners (human-attributed), auto-learns mapping if applicable.',
    params: { proposalId: { type: 'string', required: true } },
  },
  'partner.proposal.reject': {
    role: 'data_entry', mutating: true,
    description: 'Reject a partner proposal (terminal). No note required.',
    params: { proposalId: { type: 'string', required: true } },
  },
  'partner.proposal.list': {
    role: 'viewer', mutating: false,
    description: 'List partner proposals (filter by status: proposed/approved/rejected).',
  },
  'partner.proposal.get': {
    role: 'viewer', mutating: false,
    description: 'Get one partner proposal by id.',
    params: { proposalId: { type: 'string', required: true } },
  },

  // ── Settings / company / periods / permissions ───────────────────────────
  'settings.get': { role: 'viewer', mutating: false, description: 'Get company settings.' },
  'settings.save': {
    role: 'owner', mutating: true,
    description: 'Save company settings (incl. vat_tolerance, vat_tolerance_pct, AI/agent config).',
    params: { settings: { type: 'object', required: true } },
  },
  'settings.ai.test': {
    role: 'data_entry', mutating: false,
    description: 'Test LLM endpoint connectivity. Sends a minimal prompt to the configured endpoint.',
    params: {
      endpoint_url: { type: 'string', required: true },
      api_key: { type: 'string' },
      model: { type: 'string' },
    },
  },
  'agent.status': {
    role: 'viewer', mutating: false,
    description: 'Get agent pipeline status (running/stopped, feed watcher state).',
  },
  'company.list': { role: 'viewer', mutating: false, description: 'List companies.' },
  'company.save': {
    role: 'owner', mutating: true,
    description: 'Update company master data (bulk).',
    params: { companies: { type: 'array', required: true } },
  },
  'company.delete': {
    role: 'owner', mutating: true,
    description: 'Delete the current company (danger zone). Refused when it is the last remaining company or has posted journal entries; cascades setup-only residue otherwise.',
  },
  'company.attr.list': {
    role: 'viewer', mutating: false,
    description: 'List the current company\'s attribute rows for the Company settings grid (server-side registry: labels, display strings, per-row editor shapes).',
  },
  'company.attr.save': {
    role: 'owner', mutating: true,
    description: 'Write ONE company attribute (server-authoritative validation). key ∈ company_name|currency|jurisdiction|tax_id|reporting_standard|vat_registered|contact_<pack-declared contact attribute>.',
    params: { key: { type: 'string', required: true }, value: { required: true } },
  },
  'posting_rules.attr.list': {
    role: 'viewer', mutating: false,
    description: 'List posting-rules attribute rows for the Posting Rules settings grid (Multi-Currency, FX Provider, FX API Key, VAT Tolerance flat/%). Server-side registry: labels, display strings, per-row editor shapes.',
  },
  'posting_rules.attr.save': {
    role: 'owner', mutating: true,
    description: 'Write ONE posting-rules attribute (server-authoritative validation). key ∈ multi_currency|fx_provider|fx_provider_api_key|vat_tolerance|vat_tolerance_pct.',
    params: { key: { type: 'string', required: true }, value: { required: true } },
  },
  'ai.attr.list': {
    role: 'viewer', mutating: false,
    description: 'List AI/agent attribute rows for the AI settings grid (server-side registry: labels, display strings, per-row editor shapes).',
  },
  'ai.attr.save': {
    role: 'owner', mutating: true,
    description: 'Write ONE AI/agent attribute (server-authoritative validation). key ∈ agent_enabled|agent_poll_interval_ms|agent_inbox_path|llm_endpoint_url|llm_api_key|llm_model|llm_temperature|llm_vision_endpoint_url|llm_vision_model|llm_vision_api_key.',
    params: { key: { type: 'string', required: true }, value: { required: true } },
  },
  'period.list': { role: 'viewer', mutating: false, description: 'List accounting periods.' },
  'period.close_check': {
    role: 'viewer', mutating: false,
    description: 'Live close checklist for a period (IA-spec §5.10): engine items + jurisdiction-pack closeChecklist ops with pass/fail + detail. Advisory — never blocks locking.',
    params: { periodId: { type: 'string', required: true } },
  },
  'period.save': {
    role: 'owner', mutating: true,
    description: 'Replace periods (bulk; period_id + start/end required per row).',
    params: { periods: { type: 'array', required: true } },
  },
  'period.upsert': {
    role: 'owner', mutating: true,
    description: 'Insert or update one period (period_id, start_date, end_date).',
    params: { period: { type: 'object', required: true } },
  },
  'period.delete': {
    role: 'owner', mutating: true,
    description: 'Delete a period.',
    params: { periodId: { type: 'string', required: true } },
  },
  'permissions.list': { role: 'owner', mutating: false, description: 'List user permissions.' },
  'permissions.save': {
    role: 'owner', mutating: true,
    description: 'Replace user permissions (bulk).',
    params: { permissions: { type: 'array', required: true } },
  },

  // ── API tokens (spec §2.6): owner-only management. Agents are excluded by
  // the role check (create/revoke are mutating and also outside AGENT_ALLOWED;
  // list is mutating:false but role 'owner' blocks agent accounts at
  // checkPermission before the whitelist guard runs).
  'auth.token.create': {
    role: 'owner', mutating: true,
    description: 'Mint a per-actor API token (returned once; sha256 stored).',
    params: { email: { type: 'string', required: true }, label: { type: 'string', required: true } },
  },
  'auth.token.list': { role: 'owner', mutating: false, description: 'List API tokens (never hashes).' },
  'auth.token.revoke': {
    role: 'owner', mutating: true, idempotent: true,
    description: 'Revoke an API token (handler-level idempotent).',
    params: { tokenId: { type: 'string', required: true } },
  },

  // ── Setup / diag / attachments ───────────────────────────────────────────
  'diag.account': { role: 'owner', mutating: false, description: 'Diagnostic dump for an account.' },
  'setup.init': { role: 'owner', mutating: false, description: 'Verify schema and list jurisdictions.' },
  'setup.add_company': {
    role: 'owner', mutating: true,
    description: 'Create a company; seeds COA + VAT codes from its jurisdiction.',
    params: { company: { type: 'object', required: true }, coaTemplate: { type: 'array' }, vatCodesTemplate: { type: 'array' } },
  },
  'attachment.list': {
    role: 'viewer', mutating: false,
    description: 'List attachments for an entity.',
    params: { entityType: { type: 'string', required: true }, entityId: { type: 'string', required: true } },
  },
  'attachment.upload': {
    // Role 'agent' (1.5) admits agents/data_entry/owner and excludes viewers —
    // same pattern as journal.propose (dispatch's numeric role check runs before
    // the §2.3 whitelist guard). Carries agentWritable:true so dispatch's
    // AGENT_ALLOWED set (derived from this flag) admits it; agents may upload.
    role: 'agent', mutating: true, idempotent: true, agentWritable: true,
    description: 'Upload an attachment (base64 content). The browser multipart route POST /api/upload shares the same storage core and enforcement.',
    params: {
      entityType: { type: 'string', required: true },
      entityId: { type: 'string', required: true },
      filename: { type: 'string', required: true },
      contentBase64: { type: 'string', required: true },
      contentType: { type: 'string' },
    },
  },
  'attachment.delete': {
    role: 'data_entry', mutating: true,
    description: 'Delete an attachment.',
    params: { attachmentId: { type: 'string', required: true } },
  },

  // ── Events (A2 §3.3) ─────────────────────────────────────────────────────
  // event.list is the agent's input channel: an append-only stream of business
  // facts (journal posted, bill posted, payment recorded/voided, attachment
  // uploaded, period locked/unlocked). Viewer role, non-mutating. Polling:
  // caller keeps the highest event_seq seen and passes it as after_seq.
  'event.list': {
    role: 'viewer', mutating: false,
    description: 'List events (append-only stream) ordered by event_seq ASC.',
    params: { after_seq: { type: 'number' }, type: { type: 'string' }, limit: { type: 'number' } },
  },
};

// ── P1-10 command-palette dispositions ─────────────────────────────────────
// Small, explicit, next to the catalog (spec: payables-ux-spec.md §P1-10):
//   'execute'  — parameterless beyond companyId; palette executes via
//                POST /api/action with Idempotency-Key (standing rule 3).
//   'navigate' — needs input; palette routes to the owning form (+ route).
//   (absent)   — excluded: reads (data viewers) and actions needing context
//                the palette cannot supply (ids, lines, amounts) — those are
//                covered by page verbs in context (x on a row, p on a bill).
// New actions default to nothing shown until given an explicit disposition —
// adding a route here is what makes the palette grow with the API.
//   create: true — entry is a "create new X" shortcut; bare : palette
//                  collapses these into one "New…" row (show-command-spec §2.1)
const PALETTE = {
  // Execute directly
  'fx.fetch_rates':         { palette: 'execute', label: 'Fetch exchange rates' },
  // Navigate to form — create actions use &new=1 to auto-activate add-entry
  'journal.post':           { palette: 'navigate', route: '/journal/new', label: 'New journal entry', create: true },
  'journal.import':         { palette: 'navigate', route: '/journal/new', label: 'New journal entry', create: true },
  'bill.create':            { palette: 'navigate', route: '/bill/edit', label: 'New bill', create: true },
  'bill.draft.save':        { palette: 'navigate', route: '/bill/edit', label: 'New bill', create: true },
  'coa.save':               { palette: 'navigate', route: '/master-data?tab=coa&new=1', label: 'New account', create: true },
  'coa.update':             { palette: 'navigate', route: '/master-data?tab=coa', label: 'Chart of accounts' },
  'coa.upsert':             { palette: 'navigate', route: '/master-data?tab=coa', label: 'Chart of accounts' },
  'vat.codes.upsert':       { palette: 'navigate', route: '/master-data?tab=vat&new=1', label: 'New VAT code', create: true },
  'vat.codes.view':         { palette: 'navigate', route: '/master-data?tab=vat', label: 'Tax Codes' },
  'journals.view':          { palette: 'navigate', route: '/master-data?tab=journals', label: 'Journals' },
  'partner.save':            { palette: 'navigate', route: '/master-data?tab=partners&new=1', label: 'New partner', create: true },
  'partner.upsert':          { palette: 'navigate', route: '/master-data?tab=partners', label: 'Partners' },
  'period.save':            { palette: 'navigate', route: '/periods?new=1', label: 'New period', create: true },
  'period.upsert':          { palette: 'navigate', route: '/periods', label: 'Periods' },
  'period.close':           { palette: 'navigate', route: '/periods', label: 'Close period' },
  'journals.save':          { palette: 'navigate', route: '/master-data?tab=journals&new=1', label: 'New journal (book)', create: true },
  // mapping.save/mapping.upsert palette entries removed 2026-08-09 (issue #137):
  // Bank page (which hosted the Mappings tab) deleted. Actions remain available
  // via action RPC; no UI surface for mappings management until rehomed.
  'center.upsert':          { palette: 'navigate', route: '/master-data?tab=centers&new=1', label: 'New cost center', create: true },
  'center.save':            { palette: 'navigate', route: '/master-data?tab=centers', label: 'Cost/Profit Centers' },
  'fx.rates.save':          { palette: 'navigate', route: '/master-data?tab=fxrates&new=1', label: 'New exchange rate', create: true },
  'fx.provider.save':       { palette: 'navigate', route: '/master-data?tab=fxrates', label: 'Exchange rates' },
  'fx.revaluation_post':    { palette: 'navigate', route: '/master-data?tab=fxrates', label: 'Exchange rates' },
  'settings.save':          { palette: 'navigate', route: '/settings?tab=company', label: 'Company' },
  'company.save':           { palette: 'navigate', route: '/settings?tab=company', label: 'Company' },
  'permissions.save':       { palette: 'navigate', route: '/settings?tab=company', label: 'Company' },
  'posting_rules.attr.list': { palette: 'navigate', route: '/settings?tab=postrules', label: 'Posting Rules' },
  'ai.view':                { palette: 'navigate', route: '/settings?tab=ai', label: 'AI' },
  'report.refresh_vat_return': { palette: 'navigate', route: '/reports', label: 'Refresh VAT return' },
  'setup.add_company':      { palette: 'navigate', route: '/setup/new-company', absolute: true, label: 'Add company' },
  // Top-level section navigate entries (no backing action — pure navigation)
  'company.list':           { palette: 'navigate', route: '/admin', label: 'Admin' },
};
for (const [n, p] of Object.entries(PALETTE)) {
  if (ACTIONS[n]) Object.assign(ACTIONS[n], p);
}

module.exports = { ACTIONS };
