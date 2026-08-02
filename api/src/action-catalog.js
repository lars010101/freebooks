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
    // excluded. 'journal.propose' is then added to AGENT_ALLOWED so the
    // whitelist guard admits it. This is the spec's intent (§4.3 + §2.3).
    role: 'agent', mutating: true, idempotent: true,
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

  // ── Bills (AP) ───────────────────────────────────────────────────────────
  'bill.create': {
    role: 'data_entry', mutating: true, idempotent: true,
    description: 'Create + post a bill in one step (server computes VAT, FX, journals).',
    params: { bill: { type: 'object', required: true }, _replaceDraftId: { type: 'string' }, payment_batch_id: { type: 'string' } },
  },
  'bill.void': {
    role: 'data_entry', mutating: true, idempotent: true,
    description: 'Void a posted bill (auto-reverses its journals). Paid/partial bills refuse.',
    params: { billId: { type: 'string', required: true } },
  },
  'bill.list': {
    role: 'viewer', mutating: false,
    description: 'List bills with filters (status, vendor, date range).',
    params: { status: { type: 'string' }, vendor: { type: 'string' }, description: { type: 'string' }, dateFrom: { type: 'date' }, dateTo: { type: 'date' }, limit: { type: 'number' }, offset: { type: 'number' } },
  },
  'bill.match': {
    role: 'viewer', mutating: false,
    description: 'Find open bills matching an amount/currency (payment matching).',
    params: { amount: { type: 'number', required: true }, currency: { type: 'string', required: true }, vendor: { type: 'string' }, date: { type: 'date' } },
  },
  'bill.lines': {
    role: 'viewer', mutating: false,
    description: 'Line items of a bill (draft_lines JSON for drafts, journal lines for posted).',
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

  // ── Read models (P1-8) ───────────────────────────────────────────────────
  'view.bills': {
    role: 'viewer', mutating: false,
    description: 'Read model: Payables Bills tab in one call — vendors + bills with embedded lines (draft JSON parsed, posted journal lines). Same filters as bill.list.',
    params: { status: { type: 'string' }, vendor: { type: 'string' }, description: { type: 'string' }, dateFrom: { type: 'date' }, dateTo: { type: 'date' }, limit: { type: 'number' }, offset: { type: 'number' } },
  },
  'view.bank': {
    role: 'viewer', mutating: false,
    description: 'Read model: Bank tab in one call — cash accounts + journals + (when accountCode) reconciliation rows and opening balance.',
    params: { accountCode: { type: 'string' }, dateFrom: { type: 'date' }, dateTo: { type: 'date' } },
  },

  // ── Reports / VAT ────────────────────────────────────────────────────────
  'report.refresh_vat_return': {
    role: 'viewer', mutating: true,
    description: 'Recompute + store the VAT return for a period range.',
    params: { periodFrom: { type: 'date', required: true }, periodTo: { type: 'date', required: true } },
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
    description: 'Insert or update one account. account.default_role (optional, null|\'AP\'|\'Expense\') sets the company default AP/Expense account; single-holder enforced server-side in the same write (setting a new holder clears the previous one).',
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

  // ── Mappings / centers / journals / vendors ──────────────────────────────
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
  'center.list': { role: 'viewer', mutating: false, description: 'List cost/profit centers.' },
  'center.save': {
    role: 'owner', mutating: true,
    description: 'Replace cost/profit centers (bulk).',
    params: { centers: { type: 'array', required: true } },
  },
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
  'vendor.list': { role: 'viewer', mutating: false, description: 'List vendors.' },
  'vendor.save': {
    role: 'owner', mutating: true,
    description: 'Replace vendors (bulk).',
    params: { vendors: { type: 'array', required: true } },
  },
  'vendor.delete': {
    role: 'owner', mutating: true,
    description: 'Delete a vendor.',
    params: { vendorId: { type: 'string', required: true } },
  },
  'vendor.upsert': {
    role: 'owner', mutating: true,
    description: 'Insert or update one vendor.',
    params: { vendor: { type: 'object', required: true } },
  },

  // ── Settings / company / periods / permissions ───────────────────────────
  'settings.get': { role: 'viewer', mutating: false, description: 'Get company settings.' },
  'settings.save': {
    role: 'owner', mutating: true,
    description: 'Save company settings (incl. vat_tolerance, vat_tolerance_pct).',
    params: { settings: { type: 'object', required: true } },
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
    description: 'Write ONE company attribute (server-authoritative validation). key ∈ company_name|currency|jurisdiction|tax_id|reporting_standard|vat_registered|multi_currency|fx_provider|fx_provider_api_key|vat_tolerance|vat_tolerance_pct|fx_gain_loss_account|contact_<pack-declared contact attribute>.',
    params: { key: { type: 'string', required: true }, value: { required: true } },
  },
  'period.list': { role: 'viewer', mutating: false, description: 'List accounting periods.' },
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
    // the §2.3 whitelist guard). In AGENT_ALLOWED, so agents may upload.
    role: 'agent', mutating: true, idempotent: true,
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
const PALETTE = {
  // Execute directly
  'fx.fetch_rates':         { palette: 'execute' },
  // Navigate to form
  'journal.post':           { palette: 'navigate', route: '/journal/new' },
  'journal.import':         { palette: 'navigate', route: '/journal/new' },
  'bill.create':            { palette: 'navigate', route: '/bill/edit' },
  'bill.draft.save':        { palette: 'navigate', route: '/bill/edit' },
  // K3e: bank.process removed from palette — the nav-registry bank-import
  // route (/:company/bank?tab=import, gKey 'i', palette:true) now emits a
  // 'Go to Bank Import' row that surfaces on 'bank import'/'import' queries.
  // The catalog entry used the technical action description as its label,
  // which didn't contain 'import', making it invisible in palette search.
  'coa.save':               { palette: 'navigate', route: '/settings?tab=coa' },
  'coa.update':             { palette: 'navigate', route: '/settings?tab=coa' },
  'coa.upsert':             { palette: 'navigate', route: '/settings?tab=coa' },
  'vat.codes.upsert':       { palette: 'navigate', route: '/settings?tab=vat' },
  'vendor.save':            { palette: 'navigate', route: '/payables?tab=vendors' },
  'vendor.upsert':          { palette: 'navigate', route: '/payables?tab=vendors' },
  'period.save':            { palette: 'navigate', route: '/settings?tab=periods' },
  'period.upsert':          { palette: 'navigate', route: '/settings?tab=periods' },
  'journals.save':          { palette: 'navigate', route: '/settings?tab=journals' },
  'mapping.save':           { palette: 'navigate', route: '/bank?tab=mappings' },
  'mapping.upsert':         { palette: 'navigate', route: '/bank?tab=mappings' },
  'center.save':            { palette: 'navigate', route: '/settings' },
  'fx.rates.save':          { palette: 'navigate', route: '/settings?tab=fxrates' },
  'fx.provider.save':       { palette: 'navigate', route: '/settings?tab=fxrates' },
  'fx.revaluation_post':    { palette: 'navigate', route: '/settings?tab=fxrates' },
  'settings.save':          { palette: 'navigate', route: '/settings' },
  'company.save':           { palette: 'navigate', route: '/settings' },
  'permissions.save':       { palette: 'navigate', route: '/settings' },
  'report.refresh_vat_return': { palette: 'navigate', route: '/reports' },
  'setup.add_company':      { palette: 'navigate', route: '/setup/new-company', absolute: true },
};
for (const [n, p] of Object.entries(PALETTE)) {
  if (ACTIONS[n]) Object.assign(ACTIONS[n], p);
}

module.exports = { ACTIONS };
