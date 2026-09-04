'use strict';
/**
 * freeBooks — Inbox service (A5 §10)
 *
 * Unified action inbox: one read-only aggregator that fans out per item
 * type and normalizes rows to one item shape. The inbox UNIFIES
 * PRESENTATION ONLY (R8) — every item's source of truth remains its
 * owning module's table; no staging entity, no copied state. The human's
 * review surface (the complement of `event.list`, the agent's input
 * channel).
 *
 * v1 fans out to journal_proposals (Class A — pre-ledger approvals; §10.2).
 * v2 adds Class B bill-due items: posted/partial bills with outstanding
 * balance, due or overdue for payment (§10.2, §10.7 item 4). Each module
 * stays the source of truth; the verbs are the existing actions
 * (journal.approve, journal.reject, …) called against `payload_ref`.
 * No new write surface — R2/R6 enforcement is unchanged.
 */

const { queryProposals } = require('./journal');
const { query } = require('./db');
const { closingConfigFor } = require('./jurisdiction-packs');

async function handleInbox(ctx, action) {
  switch (action) {
    case 'inbox.list': return listInbox(ctx);
    default:
      throw Object.assign(new Error(`Unknown inbox action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

/**
 * inbox.list — normalized action items awaiting a human decision.
 * Viewer, non-mutating. Params: status (default 'proposed'; 'rejected'
 * is the other meaningful value in v1), limit (default 100, cap 1000) —
 * mirrors journal.proposal.list semantics. Returns { items: [...] }.
 *
 * Item shape (§10.3): { type, source, counterparty, amount, date,
 * proposed_at, summary, verbs[], payload_ref, status, reference,
 * description, created_by, request_id, review_note, attachment_count }.
 */
async function listInbox(ctx) {
  const { companyId, body } = ctx;
  const status = body.status && String(body.status).trim() !== '' ? String(body.status).trim() : 'proposed';
  const rawLimit = Number(body.limit);
  const limit = (Number.isFinite(rawLimit) && rawLimit > 0) ? Math.min(Math.floor(rawLimit), 1000) : 100;

  // Class B — bills due/overdue (§10.7 item 4). status='bills' is a filter
  // view, not the default (§10.2: "Class B is a filter/section, not the
  // default — payment and matching work must not drown approvals").
  if (status === 'bills') {
    return { items: await queryBillsDue(companyId, limit) };
  }

  // Class B — mapping_suggestions proposed by the agent (bank-matching-spec
  // §10.2). status='suggestions' is a filter view of proposed mapping rules
  // awaiting human approve/reject. The mapping_suggestions table is the
  // source of truth (R8); verbs are mapping.suggestion.approve/reject called
  // against payload_ref (= suggestion_id).
  if (status === 'suggestions') {
    return { items: await queryMappingSuggestions(companyId, limit) };
  }

  // Class A — bill drafts (§10.2). status='drafts' is a filter view of
  // agent-created bill drafts (B1's bill.create agent→draft delegation),
  // awaiting human post/discard. The bills table IS the source of truth
  // (R8); verbs are bill.draft.post (y) and bill.draft.delete (x) called
  // against payload_ref (= bill_id).
  if (status === 'drafts') {
    return { items: await queryBillDrafts(companyId, limit) };
  }

  // Class B — input rejections (bank-matching-spec §11.2). status='rejections'
  // is a filter view of statement lines with missing critical data flagged by
  // the agent. The input_rejections table IS the source of truth (R8); verbs
  // are r (retry) and d (discard) called against payload_ref (= rejection_id).
  if (status === 'rejections') {
    return { items: await queryInputRejections(companyId, limit) };
  }

  // P2-1: status='unclosed' is a filter view of periods past their end date
  // that have not yet been closed. Returns ONLY unclosed period items.
  if (status === 'unclosed') {
    return { items: await queryPeriodUnclosed(companyId, limit) };
  }

  // Class B — reconciliation alerts (#138): cash accounts with entries
  // uncleared for more than 30 days. status='reconciliation' is a filter
  // view, same shape as 'bills'/'orphans' (§10.2: Class B is a filter, not
  // the default). journal_entries/reconciliations ARE the source of truth
  // (R8) — nothing persisted for the alert itself, recomputed live.
  if (status === 'reconciliation') {
    return { items: await queryReconciliationAlerts(companyId, limit) };
  }

  // Class B — orphaned files (calendar-reminders-documents-spec.md §5.5):
  // files found under ATTACHMENTS_ROOT with no matching attachments row,
  // raised by attachment-integrity-scanner.js. The orphaned_files table IS
  // the source of truth (R8); verbs are orphan.delete called against
  // payload_ref (= orphan_id), plus a plain view/download link.
  if (status === 'orphans') {
    return { items: await queryOrphanedFiles(companyId, limit) };
  }

  // Class B — partner_proposals proposed by the agent (partner-proposal-spec §5).
  // status='partners' is a filter view of proposed partner proposals awaiting
  // human approve/reject. The partner_proposals table IS the source of truth (R8);
  // verbs are partner.proposal.approve/reject called against payload_ref (= proposal_id).
  if (status === 'partners') {
    return { items: await queryPartnerProposals(companyId, limit) };
  }

  // Class A — journal_proposals (§10.3). `includeLines` so we can compute
  // the item `amount` as the sum of line debits parsed from the lines JSON.
  const rows = await queryProposals(companyId, { status, limit, includeLines: true });

  const items = rows.map(function (row) {
    // amount = total of line debits parsed from the lines JSON column
    // (sum of Number(line.debit||0)). Malformed JSON → amount stays 0.
    var amount = 0;
    try {
      var parsed = JSON.parse(row.lines || '[]');
      if (Array.isArray(parsed)) {
        for (var i = 0; i < parsed.length; i++) {
          amount += Number(parsed[i].debit || 0);
        }
      }
    } catch (e) { /* malformed lines → amount stays 0 */ }

    // settlement (bank-match-bill-settlement-spec §4.4): present only on
    // journal_proposals that tag a foreign-currency bill for bank-match
    // settlement. `blocked` means required FX setup is missing and approval
    // must be refused; `mode` ('full'|'partial') is the human-toggleable
    // decision (bank.match.toggleSettlement) of how much of the bill to mark paid.
    var settlement = null;
    try {
      var meta = row.match_meta ? JSON.parse(row.match_meta) : null;
      if (meta && meta.settlement) settlement = meta.settlement;
    } catch (e) { /* malformed match_meta → no settlement info */ }

    return {
      type: 'journal_proposal',
      source: row.source,
      counterparty: null, // reserved (Class B items may carry a counterparty)
      amount: amount,
      date: row.date,
      proposed_at: row.created_at,
      summary: row.description || row.reference || '',
      verbs: ['approve', 'reject', 'open'],
      payload_ref: row.proposal_id,
      status: row.status,
      reference: row.reference,
      description: row.description,
      created_by: row.created_by,
      request_id: row.request_id,
      review_note: row.review_note,
      attachment_count: row.attachment_count,
      settlement: settlement,
      warnings: (function () {
        try { var w = JSON.parse(row.warnings || '[]'); return Array.isArray(w) ? w : []; } catch (e) { return []; }
      })(),
    };
  });

  // P2-1: append period_unclosed items to the default (proposed) view (Class B).
  // Not appended to 'rejected' or other filter views.
  if (status === 'proposed') {
    const unclosedItems = await queryPeriodUnclosed(companyId, limit);
    return { items: items.concat(unclosedItems) };
  }

  return { items: items };
}

/**
 * queryOrphanedFiles — Class B orphaned-file items (calendar-reminders-
 * documents-spec.md §5.5). Files found under ATTACHMENTS_ROOT with no
 * matching attachments row, oldest-discovered first. The orphaned_files
 * table IS the source of truth (R8) — no staging.
 *
 * Item shape: { type:'orphan_file', source:'system', amount:null,
 * date:discovered_at, summary:path, verbs:['view','delete'],
 * payload_ref:orphan_id, status:'orphaned', reference:path, description }.
 */
async function queryOrphanedFiles(companyId, limit) {
  const rows = await query(
    `SELECT orphan_id, path, discovered_at FROM orphaned_files
     WHERE company_id = @companyId AND resolved_at IS NULL
     ORDER BY discovered_at ASC LIMIT @lim`,
    { companyId, lim: limit }
  );
  return rows.map(function (row) {
    return {
      type: 'orphan_file',
      source: 'system',
      counterparty: '',
      amount: null,
      date: row.discovered_at,
      proposed_at: row.discovered_at,
      summary: row.path,
      verbs: ['view', 'delete'],
      payload_ref: row.orphan_id,
      status: 'orphaned',
      reference: row.path,
      description: 'File found on disk with no matching document record',
      created_by: '',
    };
  });
}

/**
 * queryReconciliationAlerts — Class B reconciliation-alert items (#138).
 * One item per Cash-category account holding uncleared batches whose date
 * is more than 30 days old — reuses bank.js's listAllUncleared join shape
 * (journal_entries LEFT JOIN reconciliations, Cash accounts, no cleared_at)
 * with an age filter, grouped by account: the alert is "go reconcile this
 * account," not one row per stale line. Sorted oldest-first.
 *
 * Item shape: { type:'reconciliation_alert', source:'system', amount:null,
 * date:oldest uncleared date, summary:'N uncleared entries in <code> — <name>
 * older than 30 days', verbs:['open'], payload_ref:account_code,
 * status:'stale', reference:account_code, description, created_by:'system' }.
 */
async function queryReconciliationAlerts(companyId, limit) {
  const rows = await query(
    `SELECT a.account_code, a.account_name,
            COUNT(DISTINCT je.batch_id) AS stale_count,
            MIN(je.date) AS oldest_date
     FROM journal_entries je
     JOIN accounts a ON a.account_code = je.account_code AND a.company_id = je.company_id
     LEFT JOIN reconciliations r
       ON r.company_id = je.company_id AND r.batch_id = je.batch_id AND r.account_code = je.account_code
     WHERE je.company_id = @companyId AND a.cf_category = 'Cash' AND r.batch_id IS NULL
       AND CAST(je.date AS DATE) < CAST(CURRENT_DATE AS DATE) - INTERVAL '30 days'
     GROUP BY a.account_code, a.account_name
     ORDER BY oldest_date ASC
     LIMIT @lim`,
    { companyId, lim: limit }
  );

  const today = new Date().toISOString().slice(0, 10);
  return rows.map(function (row) {
    const oldestStr = String(row.oldest_date).slice(0, 10);
    const daysPast = Math.floor((new Date(today) - new Date(oldestStr)) / (1000 * 60 * 60 * 24));
    const count = Number(row.stale_count);
    return {
      type: 'reconciliation_alert',
      source: 'system',
      counterparty: null,
      amount: null,
      date: row.oldest_date,
      proposed_at: null,
      summary: count + ' uncleared entr' + (count === 1 ? 'y' : 'ies') + ' in ' + row.account_code + ' — ' + (row.account_name || '') + ' older than 30 days',
      verbs: ['open'],
      payload_ref: row.account_code,
      status: 'stale',
      reference: row.account_code,
      description: 'Oldest uncleared: ' + oldestStr + ' (' + daysPast + ' days)',
      created_by: 'system',
    };
  });
}

/**
 * queryBillsDue — Class B bill-due items (§10.7 item 4). Posted/partial
 * bills with outstanding balance (amount_paid < amount), sorted by
 * due_date ASC (oldest/most-overdue first). Normalized to the inbox item
 * shape. The bill's own row IS the source of truth (R8); no staging.
 *
 * Item shape: { type:'bill_due', source:'system', counterparty:partner_name,
 * amount:outstanding, date:due_date, proposed_at:created_at, summary,
 * verbs:['open'], payload_ref:bill_id, status:'overdue'|'due',
 * reference:vendor_ref, description, created_by, currency }.
 *
 * `status` is 'overdue' when due_date < today, 'due' otherwise.
 */
async function queryBillsDue(companyId, limit) {
  var rows = await query(
    `SELECT bill_id, partner_name, vendor_ref, date, due_date, amount,
            amount_paid, currency, status, description, created_by, created_at
     FROM bills
     WHERE company_id = @companyId
       AND status IN ('posted', 'partial')
       AND amount_paid < amount
     ORDER BY due_date ASC, created_at ASC
     LIMIT @lim`,
    { companyId: companyId, lim: limit }
  );

  var today = new Date().toISOString().substring(0, 10);

  return rows.map(function (row) {
    var outstanding = Number(row.amount) - Number(row.amount_paid || 0);
    var overdue = String(row.due_date).substring(0, 10) < today;
    return {
      type: 'bill_due',
      source: 'system',
      counterparty: row.partner_name,
      amount: outstanding,
      date: row.due_date,
      proposed_at: row.created_at,
      summary: row.partner_name + (row.vendor_ref ? ' ' + row.vendor_ref : ''),
      verbs: ['open'],
      payload_ref: row.bill_id,
      status: overdue ? 'overdue' : 'due',
      reference: row.vendor_ref || '',
      description: row.description || '',
      created_by: row.created_by || '',
      currency: row.currency || '',
    };
  });
}

/**
 * queryMappingSuggestions — Class B mapping-suggestion items
 * (bank-matching-spec §10.2). Proposed bank-mapping rules from the agent,
 * awaiting human approve/reject. Normalized to the inbox item shape. The
 * mapping_suggestions table IS the source of truth (R8); no staging.
 *
 * Item shape: { type:'mapping_suggestion', source:'agent', counterparty:null,
 * amount:null, date:created_at, proposed_at:created_at, summary,
 * verbs:['approve','reject','open'], payload_ref:suggestion_id,
 * status, reference, description, created_by }.
 */
async function queryMappingSuggestions(companyId, limit) {
  var rows = await query(
    `SELECT suggestion_id, bank_account, description_pattern, suggested_account,
            suggested_vat_code, source_proposal_id, status, created_by, created_at
     FROM mapping_suggestions
     WHERE company_id = @companyId
       AND status = 'proposed'
     ORDER BY created_at DESC
     LIMIT @lim`,
    { companyId: companyId, lim: limit }
  );

  return rows.map(function (row) {
    return {
      type: 'mapping_suggestion',
      source: 'agent',
      counterparty: null,
      amount: null,
      date: row.created_at,
      proposed_at: row.created_at,
      summary: 'New rule suggested: ' + row.description_pattern + ' → account ' + row.suggested_account,
      verbs: ['approve', 'reject', 'open'],
      payload_ref: row.suggestion_id,
      status: row.status,
      reference: row.description_pattern,
      description: row.description_pattern,
      created_by: row.created_by,
    };
  });
}

/**
 * queryBillDrafts — Class A bill-draft items (§10.2). Agent-created bill
 * drafts (B1's bill.create agent→draft delegation) with status='draft',
 * awaiting human post (bill.draft.post) or discard (bill.draft.delete).
 * Sorted by created_at DESC (newest first). Normalized to the inbox item
 * shape. The bills table row IS the source of truth (R8); no staging.
 *
 * Item shape: { type:'bill_draft', source:'agent', counterparty:partner_name,
 * amount, date, proposed_at:created_at, summary,
 * verbs:['y','x'], payload_ref:bill_id, status:'draft',
 * reference:vendor_ref, description, created_by, currency }.
 */
async function queryBillDrafts(companyId, limit) {
  var rows = await query(
    `SELECT bill_id, partner_name, vendor_ref, date, amount, currency, description, created_by, created_at
     FROM bills
     WHERE company_id = @companyId AND status = 'draft'
     ORDER BY created_at DESC
     LIMIT @lim`,
    { companyId: companyId, lim: limit }
  );

  return rows.map(function (row) {
    return {
      type: 'bill_draft',
      source: (row.created_by && row.created_by !== 'agent') ? 'human' : 'agent',
      counterparty: row.partner_name,
      amount: Number(row.amount) || 0,
      date: row.date,
      proposed_at: row.created_at,
      summary: row.partner_name + (row.vendor_ref ? ' ' + row.vendor_ref : ''),
      verbs: ['y', 'x'],
      payload_ref: row.bill_id,
      status: 'draft',
      reference: row.vendor_ref || '',
      description: row.description || '',
      created_by: row.created_by || '',
      currency: row.currency || '',
      warning: null, // TODO: factor VAT-tolerance check into shared helper (spec §9)
    };
  });
}

async function queryInputRejections(companyId, limit) {
  var rows = await query(
    `SELECT rejection_id, statement_id, statement_date, rejected_lines, status, created_by, created_at
     FROM input_rejections
     WHERE company_id = @companyId AND status = 'open'
     ORDER BY created_at DESC
     LIMIT @lim`,
    { companyId: companyId, lim: limit }
  );
  return rows.map(function (row) {
    var lines = [];
    try { lines = JSON.parse(row.rejected_lines || '[]'); } catch (e) { /* malformed */ }
    return {
      type: 'input_rejection',
      source: 'agent',
      counterparty: null,
      amount: null,
      date: row.statement_date || row.created_at,
      proposed_at: row.created_at,
      summary: lines.length + ' line' + (lines.length !== 1 ? 's' : '') + ' need attention',
      verbs: ['r', 'd'],
      payload_ref: row.rejection_id,
      status: row.status,
      reference: row.statement_id,
      description: '',
      created_by: row.created_by,
    };
  });
}

/**
 * queryPeriodUnclosed — P2-1 Class B item. Surfaces periods whose end_date
 * has passed (within the last 90 days) but have no posted close batch.
 * Jurisdiction-pack driven: returns [] when closing is not required.
 * Sorted by end_date ascending (oldest first).
 */
async function queryPeriodUnclosed(companyId, limit) {
  // 1. Load jurisdiction + closing config
  const coRows = await query(
    `SELECT jurisdiction FROM (SELECT *, ROW_NUMBER() OVER(PARTITION BY company_id ORDER BY created_at DESC) AS rn FROM companies WHERE company_id = @companyId) WHERE rn = 1`,
    { companyId }
  );
  if (!coRows.length) return [];
  const jurisdiction = coRows[0].jurisdiction || 'SE';
  const closing = closingConfigFor(jurisdiction);
  if (!closing || closing.required !== true) return [];
  const closingAccount = closing.closingAccount;
  if (!closingAccount) return [];

  // 2. Query periods where end_date < TODAY and end_date >= TODAY - 90 days
  //    (latest version per period_name)
  const periodRows = await query(
    `SELECT period_name, start_date, end_date FROM (
       SELECT *, ROW_NUMBER() OVER(PARTITION BY period_name ORDER BY created_at DESC) AS rn
       FROM periods WHERE company_id = @companyId
     ) WHERE rn = 1
       AND CAST(end_date AS DATE) < CAST(CURRENT_DATE AS DATE)
       AND CAST(end_date AS DATE) >= CAST(CURRENT_DATE AS DATE) - INTERVAL '90 days'
     ORDER BY end_date ASC`,
    { companyId }
  );

  const today = new Date().toISOString().slice(0, 10);
  const items = [];
  for (const period of periodRows) {
    const endDateStr = String(period.end_date).slice(0, 10);
    // 3. Check if a close batch exists (same guard as period.close)
    const existing = await query(
      `SELECT DISTINCT batch_id FROM journal_entries
       WHERE company_id = @companyId
         AND date = @endDate
         AND account_code = @closingAcct
         AND reversed_by IS NULL`,
      { companyId, endDate: endDateStr, closingAcct: closingAccount }
    );
    if (existing.length > 0) continue; // already closed

    const daysPast = Math.floor((new Date(today) - new Date(endDateStr)) / (1000 * 60 * 60 * 24));
    items.push({
      type: 'period_unclosed',
      source: 'system',
      counterparty: null,
      amount: null,
      date: period.end_date,
      proposed_at: null,
      summary: 'Period ' + period.period_name + ' ended ' + endDateStr + ' — not yet closed',
      verbs: ['close'],
      payload_ref: period.period_name,
      status: 'proposed',
      reference: period.period_name,
      description: daysPast + ' days since period end',
      created_by: 'system',
    });
  }

  return items;
}

/**
 * partnerProposalSummary — builds the inbox summary text for a partner
 * proposal, reflecting the proposed type (vendor, customer, or both) so a
 * reviewer can approve/reject with full information without opening the
 * detail view (partner-flags-ui-fix-spec §4.2).
 */
function partnerProposalSummary(row) {
  if (row.is_vendor !== false && row.is_customer === true) return 'New partner suggested (vendor + customer): ' + row.name;
  if (row.is_customer === true) return 'New customer suggested: ' + row.name;
  return 'New vendor suggested: ' + row.name;
}

/**
 * queryPartnerProposals — Class B partner-proposal items
 * (partner-proposal-spec §5.1). Proposed partners from the agent, awaiting
 * human approve/reject. Normalized to the inbox item shape. The
 * partner_proposals table IS the source of truth (R8); no staging.
 *
 * Item shape: { type:'partner_proposal', source:'agent', counterparty:name,
 * amount:null, date:created_at, proposed_at:created_at, summary,
 * verbs:['approve','reject','open'], payload_ref:proposal_id,
 * status, reference:name, description:name, created_by }.
 */
async function queryPartnerProposals(companyId, limit) {
  var rows = await query(
    `SELECT proposal_id, name, is_vendor, is_customer, status, created_by, created_at
     FROM partner_proposals
     WHERE company_id = @companyId
       AND status = 'proposed'
     ORDER BY created_at DESC
     LIMIT @lim`,
    { companyId: companyId, lim: limit }
  );

  return rows.map(function (row) {
    return {
      type: 'partner_proposal',
      source: 'agent',
      counterparty: row.name,
      amount: null,
      date: row.created_at,
      proposed_at: row.created_at,
      summary: partnerProposalSummary(row),
      verbs: ['approve', 'reject', 'open'],
      payload_ref: row.proposal_id,
      status: row.status,
      reference: row.name,
      description: row.name,
      created_by: row.created_by,
    };
  });
}

module.exports = { handleInbox };
