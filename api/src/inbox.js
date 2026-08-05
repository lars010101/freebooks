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
      warnings: (function () {
        try { var w = JSON.parse(row.warnings || '[]'); return Array.isArray(w) ? w : []; } catch (e) { return []; }
      })(),
    };
  });

  return { items: items };
}

/**
 * queryBillsDue — Class B bill-due items (§10.7 item 4). Posted/partial
 * bills with outstanding balance (amount_paid < amount), sorted by
 * due_date ASC (oldest/most-overdue first). Normalized to the inbox item
 * shape. The bill's own row IS the source of truth (R8); no staging.
 *
 * Item shape: { type:'bill_due', source:'system', counterparty:vendor,
 * amount:outstanding, date:due_date, proposed_at:created_at, summary,
 * verbs:['open'], payload_ref:bill_id, status:'overdue'|'due',
 * reference:vendor_ref, description, created_by, currency }.
 *
 * `status` is 'overdue' when due_date < today, 'due' otherwise.
 */
async function queryBillsDue(companyId, limit) {
  var rows = await query(
    `SELECT bill_id, vendor, vendor_ref, date, due_date, amount,
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
      counterparty: row.vendor,
      amount: outstanding,
      date: row.due_date,
      proposed_at: row.created_at,
      summary: row.vendor + (row.vendor_ref ? ' ' + row.vendor_ref : ''),
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
 * Item shape: { type:'bill_draft', source:'agent', counterparty:vendor,
 * amount, date, proposed_at:created_at, summary,
 * verbs:['y','x'], payload_ref:bill_id, status:'draft',
 * reference:vendor_ref, description, created_by, currency }.
 */
async function queryBillDrafts(companyId, limit) {
  var rows = await query(
    `SELECT bill_id, vendor, vendor_ref, date, amount, currency, description, created_by, created_at
     FROM bills
     WHERE company_id = @companyId AND status = 'draft'
     ORDER BY created_at DESC
     LIMIT @lim`,
    { companyId: companyId, lim: limit }
  );

  return rows.map(function (row) {
    return {
      type: 'bill_draft',
      source: 'agent',
      counterparty: row.vendor,
      amount: Number(row.amount) || 0,
      date: row.date,
      proposed_at: row.created_at,
      summary: row.vendor + (row.vendor_ref ? ' ' + row.vendor_ref : ''),
      verbs: ['y', 'x'],
      payload_ref: row.bill_id,
      status: 'draft',
      reference: row.vendor_ref || '',
      description: row.description || '',
      created_by: row.created_by || '',
      currency: row.currency || '',
    };
  });
}

module.exports = { handleInbox };
