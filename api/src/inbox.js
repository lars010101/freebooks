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
 * Each module stays the source of truth; the verbs are the existing actions
 * (journal.approve, journal.reject, …) called against `payload_ref`.
 * No new write surface — R2/R6 enforcement is unchanged.
 *
 * bill-due and reconciliation-alert items (formerly Class B statuses
 * 'bills'/'reconciliation' here) moved OUT to bills-due-scanner.js /
 * reconciliation-scanner.js → the notifications bell. Neither carried an
 * in-place decision — their only verb navigated away — so they belong with
 * the bell's other "go look at this" alerts (fx-gap, reminders), not in a
 * decide-here approval queue.
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

  // Class B — mapping_suggestions proposed by the agent (bank-matching-spec
  // §10.2). status='suggestions' is a filter view of proposed mapping rules
  // awaiting human approve/reject. The mapping_suggestions table is the
  // source of truth (R8); verbs are mapping.suggestion.approve/reject called
  // against payload_ref (= suggestion_id).
  if (status === 'suggestions') {
    return { items: await queryMappingSuggestions(companyId, limit) };
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

  // P2-1 + Option C (agent-readiness-spec.md §10.2): append period_unclosed
  // and bill_draft items to the default (proposed) view. bill_draft is Class
  // A — its journal entries post via bill.post, not journal.approve, but it
  // converges on the same approve/reject/Enter-unfold queue idiom as
  // journal_proposal, so it belongs in the default view too.
  if (status === 'proposed') {
    const unclosedItems = await queryPeriodUnclosed(companyId, limit);
    const draftItems = await queryBillDrafts(companyId, limit, 'draft');
    return { items: items.concat(unclosedItems, draftItems) };
  }

  // Inbox rebuild (2026-09-09): rejected bills (bill.draft.reject, terminal,
  // status='rejected') surface in the rejected view the same way rejected
  // journal proposals already do — the Transactions tab shows both kinds
  // unified, so both need to be in this branch, not just journal_proposals.
  if (status === 'rejected') {
    const rejectedBills = await queryBillDrafts(companyId, limit, 'rejected');
    return { items: items.concat(rejectedBills) };
  }

  return { items: items };
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
 * drafts (B1's bill.create agent→draft delegation) with status='draft' by
 * default, awaiting human post (bill.draft.post) or reject
 * (bill.draft.reject) — or, when called with status='rejected', the
 * terminal rejected bills themselves (Inbox rebuild, 2026-09-09; mirrors
 * queryProposals' status param). Sorted by created_at DESC (newest
 * first). Normalized to the inbox item shape. The bills table row IS the
 * source of truth (R8); no staging.
 *
 * Item shape: { type:'bill_draft', source:'agent', counterparty:partner_name,
 * amount, date, proposed_at:created_at, summary,
 * verbs:['y','x'], payload_ref:bill_id, status,
 * reference:vendor_ref, description, created_by, currency,
 * attachment_count, review_note, expense_account, ap_account }.
 */
async function queryBillDrafts(companyId, limit, status) {
  var rows = await query(
    `SELECT b.bill_id, b.partner_name, b.vendor_ref, b.date, b.amount, b.currency, b.description,
            b.created_by, b.created_at, b.status, b.review_note, b.expense_account, b.ap_account,
            COALESCE(a.cnt, 0) AS attachment_count
     FROM bills b
     LEFT JOIN (
       SELECT company_id, entity_id, count(*) AS cnt
       FROM attachments
       WHERE entity_type = 'bill'
       GROUP BY company_id, entity_id
     ) a ON a.company_id = b.company_id AND a.entity_id = b.bill_id
     WHERE b.company_id = @companyId AND b.status = @status
     ORDER BY b.created_at DESC
     LIMIT @lim`,
    { companyId: companyId, status: status || 'draft', lim: limit }
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
      status: row.status,
      reference: row.vendor_ref || '',
      description: row.description || '',
      created_by: row.created_by || '',
      currency: row.currency || '',
      attachment_count: row.attachment_count,
      review_note: row.review_note || '',
      expense_account: row.expense_account || '',
      ap_account: row.ap_account || '',
      warning: null, // TODO: factor VAT-tolerance check into shared helper (spec §9)
    };
  });
}

/**
 * queryInputRejections — Class B input-rejection items (bank-matching-spec
 * §11.2). Statement lines the agent could not turn into a proposal because
 * of missing critical data. The input_rejections table IS the source of
 * truth (R8); no staging.
 *
 * Item shape: { type:'input_rejection', source:'agent', amount:null,
 * date, proposed_at:created_at, summary, verbs:['r','d'],
 * payload_ref:rejection_id, status, reference:statement_id, description:'',
 * created_by, rejected_lines:[{line,raw,reason}], statement_id }.
 */
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
      // Inbox rebuild (2026-09-09): the parsed detail was computed above
      // only to build `summary` — never actually exposed on the item, so
      // the unfold had nothing real to show beyond a "Flagged by" meta
      // line. statement_id is also exposed separately from `reference`
      // (same value, but reference is a display fallback — the unfold's
      // attachment.list lookup wants the raw id, not the display string).
      rejected_lines: lines,
      statement_id: row.statement_id,
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
 * status, reference:name, description:name, created_by,
 * duplicate_warning:{name,similarity,kind}|null, is_vendor, is_customer,
 * default_expense_account, default_ap_account, suggested_vat_code, tax_id,
 * default_currency, payment_terms_days, evidence,
 * source_proposal_id, source_bill_id }.
 *
 * duplicate_warning (issue #226): a fuzzy trigram match found at propose
 * time, non-blocking (warn-not-block) — the reviewer sees it here and
 * decides whether to approve or reject.
 *
 * Everything from default_expense_account onward used to be silently
 * dropped here even though partner_proposals carries all of it — a
 * reviewer approved a new partner with no visibility into which account/
 * VAT code the agent picked, whether it was proposed as vendor or
 * customer (is_vendor/is_customer were fetched by the SQL and then never
 * put on the returned object), or which bill/journal proposal triggered
 * it. Now exposed so the Inbox can show and let a reviewer correct these
 * before approving, instead of approving blind.
 */
async function queryPartnerProposals(companyId, limit) {
  var rows = await query(
    `SELECT proposal_id, name, is_vendor, is_customer, tax_id, default_currency,
            payment_terms_days, default_expense_account, default_ap_account,
            suggested_vat_code, evidence, source_proposal_id, source_bill_id,
            status, created_by, created_at, duplicate_warning
     FROM partner_proposals
     WHERE company_id = @companyId
       AND status = 'proposed'
     ORDER BY created_at DESC
     LIMIT @lim`,
    { companyId: companyId, lim: limit }
  );

  return rows.map(function (row) {
    var duplicateWarning = null;
    try { duplicateWarning = row.duplicate_warning ? JSON.parse(row.duplicate_warning) : null; } catch (e) { /* malformed → no warning */ }
    var evidence = null;
    try { evidence = row.evidence ? JSON.parse(row.evidence) : null; } catch (e) { /* malformed → no evidence */ }
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
      duplicate_warning: duplicateWarning,
      is_vendor: row.is_vendor !== false,
      is_customer: row.is_customer === true,
      tax_id: row.tax_id || '',
      default_currency: row.default_currency || '',
      payment_terms_days: row.payment_terms_days,
      default_expense_account: row.default_expense_account || '',
      default_ap_account: row.default_ap_account || '',
      suggested_vat_code: row.suggested_vat_code || '',
      evidence: evidence,
      source_proposal_id: row.source_proposal_id || null,
      source_bill_id: row.source_bill_id || null,
    };
  });
}

module.exports = { handleInbox };
