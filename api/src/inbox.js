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
 * v1 fans out to journal_proposals ONLY (Class A — pre-ledger approvals;
 * §10.2). Class B types (bills due, bank-import lines, …) append per
 * module as their modules land (§10.7). Each module stays the source of
 * truth; the verbs are the existing actions (journal.approve,
 * journal.reject, …) called against `payload_ref`. No new write surface
 * — R2/R6 enforcement is unchanged.
 */

const { queryProposals } = require('./journal');

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

  // v1 (§10.3): Class A only — journal_proposals. Class B types come
  // later as their modules land. `includeLines` so we can compute the
  // item `amount` as the sum of line debits parsed from the lines JSON.
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
    };
  });

  return { items: items };
}

module.exports = { handleInbox };
