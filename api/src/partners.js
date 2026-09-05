'use strict';
/**
 * freeBooks — Partner Master (partner-proposal-spec)
 *
 * Unified AP/AR partner table (renamed from vendors). CRUD for the partners
 * table + partner proposal flow: agent proposes a partner, human approves
 * (inserts into partners) or rejects (terminal). Follows the exact pattern of
 * mapping.suggest / mapping.suggestion.approve / .reject in index.js.
 */

const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert } = require('./db');
const { emitEvent } = require('./events');
const { normalizeDescription, findFuzzyMatch } = require('./mapping-utils');

async function handlePartners(ctx, action) {
  switch (action) {
    case 'partner.list':              return listPartners(ctx);
    case 'partner.save':              return savePartners(ctx);
    case 'partner.delete':            return deletePartner(ctx);
    case 'partner.upsert':            return upsertPartner(ctx);
    case 'partner.propose':           return proposePartner(ctx);
    case 'partner.proposal.approve':  return approvePartnerProposal(ctx);
    case 'partner.proposal.reject':   return rejectPartnerProposal(ctx);
    case 'partner.proposal.list':     return listPartnerProposals(ctx);
    case 'partner.proposal.get':      return getPartnerProposal(ctx);
    default:
      throw Object.assign(new Error(`Unknown partner action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

// ── CRUD (renamed from vendor.* → partner.*) ──────────────────────────────

async function listPartners(ctx) {
  const { companyId, body } = ctx;
  const partnerType = body && body.partner_type;

  // Filter by partner_type: 'vendor' → is_vendor=TRUE, 'customer' → is_customer=TRUE
  if (partnerType === 'vendor') {
    return query(
      `SELECT partner_id, name, default_currency, payment_terms_days, tax_id, notes,
              default_expense_account, default_ap_account, default_revenue_account,
              default_ar_account, is_vendor, is_customer, is_active
       FROM partners
       WHERE company_id = @companyId AND is_vendor = TRUE
       ORDER BY name`,
      { companyId }
    );
  }
  if (partnerType === 'customer') {
    return query(
      `SELECT partner_id, name, default_currency, payment_terms_days, tax_id, notes,
              default_expense_account, default_ap_account, default_revenue_account,
              default_ar_account, is_vendor, is_customer, is_active
       FROM partners
       WHERE company_id = @companyId AND is_customer = TRUE
       ORDER BY name`,
      { companyId }
    );
  }

  return query(
    `SELECT partner_id, name, default_currency, payment_terms_days, tax_id, notes,
            default_expense_account, default_ap_account, default_revenue_account,
            default_ar_account, is_vendor, is_customer, is_active
     FROM partners
     WHERE company_id = @companyId
     ORDER BY name`,
    { companyId }
  );
}

async function savePartners(ctx) {
  const { companyId, body } = ctx;
  const { partners } = body;
  if (!Array.isArray(partners)) throw Object.assign(new Error('partners array required'), { code: 'INVALID_INPUT' });

  // Validate default account codes before saving
  const accountCodes = new Set();
  for (const p of partners) {
    if (p.default_expense_account) accountCodes.add(p.default_expense_account);
    if (p.default_ap_account) accountCodes.add(p.default_ap_account);
  }

  if (accountCodes.size > 0) {
    const placeholders = Array.from(accountCodes).map((_, i) => `@acct${i}`).join(',');
    const params = { companyId };
    Array.from(accountCodes).forEach((code, i) => {
      params[`acct${i}`] = code;
    });

    const validAccounts = await query(
      `SELECT account_code FROM accounts WHERE company_id = @companyId AND account_code IN (${placeholders}) AND is_active = true`,
      params
    );

    const validCodes = new Set(validAccounts.map(a => a.account_code));
    const invalidCodes = Array.from(accountCodes).filter(code => !validCodes.has(code));

    if (invalidCodes.length > 0) {
      throw Object.assign(
        new Error(`Invalid or inactive account codes: ${invalidCodes.join(', ')}`),
        { code: 'INVALID_ACCOUNT' }
      );
    }
  }

  // Replace all for the company (simple replace pattern like periods or mappings)
  await exec(`DELETE FROM partners WHERE company_id = @companyId`, { companyId });

  if (partners.length === 0) return { saved: true, count: 0 };

  const rows = partners.map(p => ({
    partner_id: p.partner_id || uuid(),
    company_id: companyId,
    name: p.name,
    default_currency: p.default_currency || null,
    payment_terms_days: p.payment_terms_days || 30,
    tax_id: p.tax_id || null,
    notes: p.notes || null,
    default_expense_account: p.default_expense_account || null,
    default_ap_account: p.default_ap_account || null,
    is_vendor: p.is_vendor !== false,
    is_customer: p.is_customer === true,
    is_active: p.is_active !== false
  }));

  await bulkInsert('partners', rows);
  return { saved: true, count: rows.length };
}

async function deletePartner(ctx) {
  const { companyId, body } = ctx;
  const { partnerId } = body;
  if (!partnerId) throw Object.assign(new Error('partnerId required'), { code: 'INVALID_INPUT' });

  await exec(
    `DELETE FROM partners WHERE company_id = @companyId AND partner_id = @partnerId`,
    { companyId, partnerId }
  );
  return { deleted: true, partnerId };
}

async function upsertPartner(ctx) {
  const { companyId, body } = ctx;
  const { partner } = body;
  if (!partner || !partner.name) throw Object.assign(new Error('partner.name required'), { code: 'INVALID_INPUT' });

  const partnerId = partner.partner_id || uuid();

  const existing = await query(
    `SELECT partner_id FROM partners WHERE company_id = @companyId AND partner_id = @partnerId`,
    { companyId, partnerId }
  );

  if (existing.length > 0) {
    await exec(
      `UPDATE partners SET name=@name, default_currency=@currency, payment_terms_days=@terms,
       default_expense_account=@expAcct, default_ap_account=@apAcct,
       is_vendor=@isVendor, is_customer=@isCustomer, is_active=@active
       WHERE company_id=@companyId AND partner_id=@partnerId`,
      { companyId, partnerId, name: partner.name,
        currency: partner.default_currency || null,
        terms: partner.payment_terms_days || 30,
        expAcct: partner.default_expense_account || null,
        apAcct: partner.default_ap_account || null,
        isVendor: partner.is_vendor !== false,
        isCustomer: partner.is_customer === true,
        active: partner.is_active !== false }
    );
  } else {
    await bulkInsert('partners', [{
      partner_id: partnerId,
      company_id: companyId,
      name: partner.name,
      default_currency: partner.default_currency || null,
      payment_terms_days: partner.payment_terms_days || 30,
      tax_id: partner.tax_id || null,
      notes: partner.notes || null,
      default_expense_account: partner.default_expense_account || null,
      default_ap_account: partner.default_ap_account || null,
      is_vendor: partner.is_vendor !== false,
      is_customer: partner.is_customer === true,
      is_active: partner.is_active !== false
    }]);
  }
  return { saved: true, partnerId };
}

// ── Partner proposal flow (partner-proposal-spec §2, §4) ───────────────────

/**
 * partner.propose — agent proposes a new partner. Writes to partner_proposals,
 * never to partners. Runs duplicate detection (existing partner, pending proposal).
 * Idempotent upsert via proposalId (same-caller only). Emits partner.proposed.
 */
async function proposePartner(ctx) {
  const { companyId, body, userEmail } = ctx;
  const {
    proposalId, name, tax_id, default_currency, payment_terms_days,
    default_expense_account, default_ap_account, suggested_vat_code,
    is_vendor, is_customer, evidence,
    source_proposal_id, source_bill_id, source_description,
  } = body;

  if (!name || typeof name !== 'string') {
    throw Object.assign(new Error('name required'), { code: 'INVALID_INPUT' });
  }
  if (!evidence) {
    throw Object.assign(new Error('evidence required'), { code: 'INVALID_INPUT' });
  }

  // ── §2.4: Duplicate detection (server-side, same as mapping.suggest) ──────
  // Two-phase: (1) fast SQL exact case-insensitive match, then (2) trigram
  // fuzzy match against all in-scope rows (issue #130) to catch near-duplicates
  // like "Netflix Inc" vs "Netflix Inc." that differ only by formatting.

  // 1. Check for existing partner by name (case-insensitive, exact fast path)
  const existingPartner = await query(
    `SELECT partner_id FROM partners
     WHERE company_id = @companyId AND LOWER(name) = LOWER(@name)
       AND is_vendor = TRUE
     LIMIT 1`,
    { companyId, name }
  );
  if (existingPartner.length > 0) {
    throw Object.assign(
      new Error(`A partner with name '${name}' already exists`),
      { code: 'CONFLICT' }
    );
  }
  // 1b. Fuzzy match against existing vendor partners (issue #130, threshold 0.65)
  const allVendorPartners = await query(
    `SELECT name FROM partners
     WHERE company_id = @companyId AND is_vendor = TRUE`,
    { companyId }
  );
  const fuzzyPartner = findFuzzyMatch(name, allVendorPartners, 0.65);
  if (fuzzyPartner) {
    throw Object.assign(
      new Error(`A partner with a similar name already exists: '${fuzzyPartner.candidate.name}' (similarity: ${fuzzyPartner.similarity.toFixed(2)})`),
      { code: 'CONFLICT' }
    );
  }

  // 2. Check for pending proposal by name (case-insensitive, exact fast path)
  const existingProposal = await query(
    `SELECT proposal_id FROM partner_proposals
     WHERE company_id = @companyId AND LOWER(name) = LOWER(@name)
       AND status = 'proposed'
     LIMIT 1`,
    { companyId, name }
  );
  if (existingProposal.length > 0) {
    throw Object.assign(
      new Error(`A pending partner proposal for '${name}' already exists`),
      { code: 'CONFLICT' }
    );
  }
  // 2b. Fuzzy match against pending proposals (issue #130, threshold 0.65)
  const allPendingProposals = await query(
    `SELECT name FROM partner_proposals
     WHERE company_id = @companyId AND status = 'proposed'`,
    { companyId }
  );
  const fuzzyProposal = findFuzzyMatch(name, allPendingProposals, 0.65);
  if (fuzzyProposal) {
    throw Object.assign(
      new Error(`A pending partner proposal with a similar name already exists: '${fuzzyProposal.candidate.name}' (similarity: ${fuzzyProposal.similarity.toFixed(2)})`),
      { code: 'CONFLICT' }
    );
  }

  const now = new Date().toISOString();
  const evidenceJson = evidence != null ? JSON.stringify(evidence) : null;

  // Validate account codes if provided
  const accountCodes = new Set();
  if (default_expense_account) accountCodes.add(default_expense_account);
  if (default_ap_account) accountCodes.add(default_ap_account);
  if (accountCodes.size > 0) {
    const placeholders = Array.from(accountCodes).map((_, i) => `@acct${i}`).join(',');
    const params = { companyId };
    Array.from(accountCodes).forEach((code, i) => { params[`acct${i}`] = code; });
    const validAccounts = await query(
      `SELECT account_code FROM accounts WHERE company_id = @companyId AND account_code IN (${placeholders}) AND is_active = true`,
      params
    );
    const validCodes = new Set(validAccounts.map(a => a.account_code));
    const invalidCodes = Array.from(accountCodes).filter(code => !validCodes.has(code));
    if (invalidCodes.length > 0) {
      throw Object.assign(
        new Error(`Invalid or inactive account codes: ${invalidCodes.join(', ')}`),
        { code: 'INVALID_ACCOUNT' }
      );
    }
  }

  // Upsert: if proposalId is provided AND a matching proposed row owned by this
  // caller exists, UPDATE it (same pattern as journal.propose / mapping.suggest).
  if (proposalId) {
    const existing = await query(
      `SELECT proposal_id, status, created_by FROM partner_proposals
       WHERE company_id = @companyId AND proposal_id = @proposalId`,
      { companyId, proposalId }
    );
    if (existing.length > 0) {
      const row = existing[0];
      if (String(row.status) !== 'proposed') {
        throw Object.assign(new Error(`Cannot upsert a proposal in status '${row.status}' (only 'proposed' is editable)`), { code: 'INVALID_STATUS' });
      }
      if (String(row.created_by) !== String(userEmail)) {
        throw Object.assign(new Error('Cannot upsert a proposal owned by another actor'), { code: 'FORBIDDEN' });
      }
      await exec(
        `UPDATE partner_proposals
           SET name = @name, tax_id = @tax_id, default_currency = @default_currency,
               payment_terms_days = @payment_terms_days,
               default_expense_account = @default_expense_account,
               default_ap_account = @default_ap_account,
               suggested_vat_code = @suggested_vat_code,
               is_vendor = @is_vendor, is_customer = @is_customer,
               evidence = @evidence,
               source_proposal_id = @source_proposal_id,
               source_bill_id = @source_bill_id,
               source_description = @source_description
         WHERE company_id = @companyId AND proposal_id = @proposalId`,
        { companyId, proposalId, name, tax_id: tax_id || null,
          default_currency: default_currency || null,
          payment_terms_days: payment_terms_days || 30,
          default_expense_account: default_expense_account || null,
          default_ap_account: default_ap_account || null,
          suggested_vat_code: suggested_vat_code || null,
          is_vendor: is_vendor !== false,
          is_customer: is_customer === true,
          evidence: evidenceJson,
          source_proposal_id: source_proposal_id || null,
          source_bill_id: source_bill_id || null,
          source_description: source_description || null }
      );
      await emitEvent(ctx, 'partner.proposed', 'partner_proposal', proposalId,
        { name, source_proposal_id: source_proposal_id || null });
      return { proposal_id: proposalId, status: 'proposed' };
    }
    // proposalId supplied but no existing row → first creation with caller-chosen id
  }

  const newId = proposalId || uuid();
  await bulkInsert('partner_proposals', [{
    company_id: companyId,
    proposal_id: newId,
    name,
    tax_id: tax_id || null,
    default_currency: default_currency || null,
    payment_terms_days: payment_terms_days || 30,
    default_expense_account: default_expense_account || null,
    default_ap_account: default_ap_account || null,
    suggested_vat_code: suggested_vat_code || null,
    is_vendor: is_vendor !== false,
    is_customer: is_customer === true,
    evidence: evidenceJson,
    source_proposal_id: source_proposal_id || null,
    source_bill_id: source_bill_id || null,
    source_description: source_description || null,
    status: 'proposed',
    created_by: userEmail,
    reviewed_by: null,
    reviewed_at: null,
    created_at: now,
  }]);
  await emitEvent(ctx, 'partner.proposed', 'partner_proposal', newId,
    { name, source_proposal_id: source_proposal_id || null });
  return { proposal_id: newId, status: 'proposed' };
}

/**
 * partner.proposal.approve — proposed → approved. Validates account codes,
 * inserts into partners (human-attributed, is_active=TRUE), runs auto-learning
 * (mapping.suggest if source_proposal_id + description pattern exist).
 * Emits partner.proposal.approved.
 */
async function approvePartnerProposal(ctx) {
  const { companyId, body, userEmail } = ctx;
  const { proposalId } = body;
  if (!proposalId) throw Object.assign(new Error('proposalId required'), { code: 'INVALID_INPUT' });

  const rows = await query(
    `SELECT * FROM partner_proposals
     WHERE company_id = @companyId AND proposal_id = @proposalId`,
    { companyId, proposalId }
  );
  if (rows.length === 0) throw Object.assign(new Error('Partner proposal not found'), { code: 'NOT_FOUND' });
  const prop = rows[0];
  if (String(prop.status) !== 'proposed') {
    throw Object.assign(new Error(`Cannot approve a proposal in status '${prop.status}' (only 'proposed' can be approved)`), { code: 'INVALID_STATUS' });
  }

  // Validate account codes exist in COA
  const accountCodes = new Set();
  if (prop.default_expense_account) accountCodes.add(prop.default_expense_account);
  if (prop.default_ap_account) accountCodes.add(prop.default_ap_account);
  if (accountCodes.size > 0) {
    const placeholders = Array.from(accountCodes).map((_, i) => `@acct${i}`).join(',');
    const params = { companyId };
    Array.from(accountCodes).forEach((code, i) => { params[`acct${i}`] = code; });
    const validAccounts = await query(
      `SELECT account_code FROM accounts WHERE company_id = @companyId AND account_code IN (${placeholders}) AND is_active = true`,
      params
    );
    const validCodes = new Set(validAccounts.map(a => a.account_code));
    const invalidCodes = Array.from(accountCodes).filter(code => !validCodes.has(code));
    if (invalidCodes.length > 0) {
      throw Object.assign(
        new Error(`Invalid or inactive account codes: ${invalidCodes.join(', ')}`),
        { code: 'INVALID_ACCOUNT' }
      );
    }
  }

  // Insert into partners (human-attributed, is_active=TRUE)
  const partnerId = uuid();
  await bulkInsert('partners', [{
    partner_id: partnerId,
    company_id: companyId,
    name: prop.name,
    default_currency: prop.default_currency || null,
    payment_terms_days: prop.payment_terms_days || 30,
    tax_id: prop.tax_id || null,
    notes: null,
    default_expense_account: prop.default_expense_account || null,
    default_ap_account: prop.default_ap_account || null,
    is_vendor: prop.is_vendor !== false,
    is_customer: prop.is_customer === true,
    is_active: true,
  }]);

  // Update proposal status. Same 'anonymous' fallback doctrine as journal.js's
  // journal.approve (D3) — the browser's review UI never sends userEmail
  // (install-level trust, no login), and binding a raw JS `undefined` to
  // @duckdb/node-api throws "Cannot create values of type ANY" (unlike
  // bulkInsert, exec's bindParams does not coalesce undefined to null).
  const reviewer = userEmail || 'anonymous';
  const now = new Date().toISOString();
  await exec(
    `UPDATE partner_proposals
        SET status = 'approved', reviewed_by = @reviewed_by, reviewed_at = @reviewed_at
      WHERE company_id = @companyId AND proposal_id = @proposalId`,
    { reviewed_by: reviewer, reviewed_at: now, companyId, proposalId }
  );

  await emitEvent(ctx, 'partner.proposal.approved', 'partner_proposal', proposalId,
    { partner_id: partnerId, name: prop.name });

  // ── §2.5: Auto-learning — create mapping suggestion if source data exists ──
  if (prop.source_proposal_id) {
    try {
      // Fetch the originating journal proposal's description
      const jpRows = await query(
        `SELECT description FROM journal_proposals
         WHERE company_id = @companyId AND proposal_id = @proposalId
         LIMIT 1`,
        { companyId, proposalId: prop.source_proposal_id }
      );
      const rawDesc = (jpRows.length > 0 && jpRows[0].description) || prop.source_description || null;
      if (rawDesc) {
        const pattern = normalizeDescription(rawDesc);
        if (pattern) {
          // Check for existing active mapping rule
          const existingRule = await query(
            `SELECT mapping_id FROM bank_mappings
             WHERE company_id = @companyId AND is_active = true
               AND UPPER(pattern) = UPPER(@pattern)`,
            { companyId, pattern }
          );
          // Check for pending mapping suggestion
          const existingSuggestion = await query(
            `SELECT suggestion_id FROM mapping_suggestions
             WHERE company_id = @companyId AND status = 'proposed'
               AND UPPER(description_pattern) = UPPER(@pattern)`,
            { companyId, pattern }
          );
          // If neither exists, create a mapping suggestion (auto-learning)
          if (existingRule.length === 0 && existingSuggestion.length === 0) {
            const suggestionId = uuid();
            const learningEvidence = [{
              type: 'partner_approval_auto_learn',
              description: `Auto-created from partner proposal approval for '${prop.name}'`,
              partner_proposal_id: proposalId,
              source_proposal_id: prop.source_proposal_id,
            }];
            await bulkInsert('mapping_suggestions', [{
              company_id: companyId,
              suggestion_id: suggestionId,
              bank_account: null,
              description_pattern: pattern,
              suggested_account: prop.default_expense_account || null,
              suggested_vat_code: prop.suggested_vat_code || null,
              suggested_dimensions: null,
              suggested_amount_sign: 'any',
              suggested_match_type: 'contains',
              evidence: JSON.stringify(learningEvidence),
              source_proposal_id: prop.source_proposal_id || null,
              status: 'proposed',
              created_by: userEmail,
              reviewed_by: null,
              reviewed_at: null,
              created_at: now,
            }]);
            await emitEvent(ctx, 'mapping.suggested', 'mapping_suggestion', suggestionId,
              { description_pattern: pattern, suggested_account: prop.default_expense_account || null,
                source_proposal_id: prop.source_proposal_id || null });
          }
        }
      }
    } catch (learnErr) {
      // Auto-learning failure is non-fatal — the partner was still created.
      console.warn(`partner.proposal.approve: auto-learning failed: ${learnErr.message}`);
    }
  }

  return { approved: true, partner_id: partnerId, proposal_id: proposalId };
}

/**
 * partner.proposal.reject — proposed → rejected (terminal). No note required.
 * Emits partner.proposal.rejected.
 */
async function rejectPartnerProposal(ctx) {
  const { companyId, body, userEmail } = ctx;
  const { proposalId } = body;
  if (!proposalId) throw Object.assign(new Error('proposalId required'), { code: 'INVALID_INPUT' });

  const rows = await query(
    `SELECT proposal_id, status FROM partner_proposals
     WHERE company_id = @companyId AND proposal_id = @proposalId`,
    { companyId, proposalId }
  );
  if (rows.length === 0) throw Object.assign(new Error('Partner proposal not found'), { code: 'NOT_FOUND' });
  const prop = rows[0];
  if (String(prop.status) !== 'proposed') {
    throw Object.assign(new Error(`Cannot reject a proposal in status '${prop.status}' (only 'proposed' can be rejected)`), { code: 'INVALID_STATUS' });
  }

  // Same 'anonymous' fallback as approvePartnerProposal above — userEmail is
  // routinely undefined from the browser's review UI, and exec's bindParams
  // does not coalesce undefined to null the way bulkInsert does.
  const reviewer = userEmail || 'anonymous';
  const now = new Date().toISOString();
  await exec(
    `UPDATE partner_proposals
        SET status = 'rejected', reviewed_by = @reviewed_by, reviewed_at = @reviewed_at
      WHERE company_id = @companyId AND proposal_id = @proposalId`,
    { reviewed_by: reviewer, reviewed_at: now, companyId, proposalId }
  );

  await emitEvent(ctx, 'partner.proposal.rejected', 'partner_proposal', proposalId, {});
  return { rejected: true };
}

/**
 * partner.proposal.list — list proposals, filter by status.
 */
async function listPartnerProposals(ctx) {
  const { companyId, body } = ctx;
  const status = body && body.status && String(body.status).trim() !== '' ? String(body.status).trim() : null;
  const rawLimit = Number(body && body.limit);
  const limit = (Number.isFinite(rawLimit) && rawLimit > 0) ? Math.min(Math.floor(rawLimit), 1000) : 100;

  if (status) {
    return query(
      `SELECT * FROM partner_proposals
       WHERE company_id = @companyId AND status = @status
       ORDER BY created_at DESC
       LIMIT @lim`,
      { companyId, status, lim: limit }
    );
  }
  return query(
    `SELECT * FROM partner_proposals
     WHERE company_id = @companyId
     ORDER BY created_at DESC
     LIMIT @lim`,
    { companyId, lim: limit }
  );
}

/**
 * partner.proposal.get — get one proposal by id.
 */
async function getPartnerProposal(ctx) {
  const { companyId, body } = ctx;
  const { proposalId } = body;
  if (!proposalId) throw Object.assign(new Error('proposalId required'), { code: 'INVALID_INPUT' });
  const rows = await query(
    `SELECT * FROM partner_proposals
     WHERE company_id = @companyId AND proposal_id = @proposalId`,
    { companyId, proposalId }
  );
  if (rows.length === 0) throw Object.assign(new Error('Partner proposal not found'), { code: 'NOT_FOUND' });
  return rows[0];
}

module.exports = { handlePartners, listPartners };
