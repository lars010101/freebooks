'use strict';
/**
 * freeBooks — Bank statement processing
 * Ported from BigQuery Cloud Function to DuckDB/Express.
 */

const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert } = require('./db');
const { expandVatLines } = require('./vat');
const { getNextReference, getNextReferenceBatch } = require('./journal');
const { settleBillPayment } = require('./settlement');
const { amountSignMatches, normalizeDescription } = require('./mapping-utils');

async function handleBank(ctx, action) {
  switch (action) {
    case 'bank.process':         return processBankStatement(ctx);
    case 'bank.approve':         return approveBankEntries(ctx);
    case 'bank.reconcile.list':  return listReconcile(ctx);
    case 'bank.reconcile.clear': return clearReconcile(ctx);
    case 'bank.uncleared.list':  return listAllUncleared(ctx);
    case 'bank.match':           return matchLine(ctx);
    default:
      throw Object.assign(new Error(`Unknown bank action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

async function processBankStatement(ctx) {
  const { companyId, body } = ctx;
  const { rows: bankRows, bankAccount: bodyBankAccount } = body;

  if (!bankRows || !Array.isArray(bankRows) || bankRows.length === 0) {
    throw Object.assign(new Error('rows array required'), { code: 'INVALID_INPUT' });
  }

  const companies = await query(
    `SELECT currency, accounting_method, vat_registered FROM companies WHERE company_id = @companyId LIMIT 1`,
    { companyId }
  );
  if (companies.length === 0) throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });
  const company = companies[0];

  const mappings = await query(
    `SELECT * FROM bank_mappings WHERE company_id = @companyId AND is_active = TRUE ORDER BY priority ASC`,
    { companyId }
  );

  let openBills = [];
  if (company.accounting_method !== 'cash') {
    openBills = await query(
      `SELECT bill_id, partner_name, vendor_ref, amount_home, amount_paid, ap_account,
              (amount_home - amount_paid) AS outstanding, due_date
       FROM bills
       WHERE company_id = @companyId AND status IN ('posted', 'partial')
       ORDER BY due_date`,
      { companyId }
    );
  }

  const settingsRows = await query(
    `SELECT value FROM settings WHERE company_id = @companyId AND key = 'default_bank_account'`,
    { companyId }
  );
  const bankAccount = settingsRows.length > 0 ? settingsRows[0].value : (bodyBankAccount || null);

  // P1-9 dual path: unvoided manual payments with their bank (credit) leg —
  // an import row matching one must NOT re-post (would double-count the bank side)
  let manualPayments = [];
  if (bankAccount) {
    manualPayments = await query(
      `SELECT bp.payment_id, bp.batch_id, bp.bill_id, bp.date, je.account_code, je.credit
       FROM bill_payments bp
       JOIN journal_entries je ON je.batch_id = bp.batch_id AND je.company_id = bp.company_id
       WHERE bp.company_id = @companyId AND bp.method = 'manual' AND bp.voided_at IS NULL AND je.credit > 0`,
      { companyId }
    );
  }

  const processed = [];
  for (const row of bankRows) {
    const result = {
      original: row,
      matchType: null,
      matchConfidence: null,
      debitAccount: null,
      creditAccount: null,
      vatCode: null,
      costCenter: null,
      profitCenter: null,
      description: row.description,
      billId: null,
    };

    const amount = Math.abs(row.amount);
    const isInflow = row.amount > 0;

    // P1-9: row evidences an already-recorded manual payment (exact date + amount
    // + this bank account) → tag for clearing on approve, never re-post.
    if (bankAccount && !isInflow) {
      const mp = manualPayments.find((p) =>
        p.account_code === bankAccount &&
        Math.abs(Number(p.credit) - amount) < 0.01 &&
        String(p.date).substring(0, 10) === String(row.date).substring(0, 10)
      );
      if (mp) {
        result.matchType = 'recorded_payment';
        result.matchConfidence = 'high';
        result.paymentId = mp.payment_id;
        result.paymentBatchId = mp.batch_id;
        result.billId = mp.bill_id;
        result.bankAccount = bankAccount;
        result.description = `Already recorded: ${row.description}`;
        processed.push(result);
        continue;
      }
    }

    const mapping = matchMapping(mappings, row.description);
    if (mapping) {
      result.matchType = 'rule';
      result.matchConfidence = 'high';
      // offset_account (stored in debit_account) is the non-bank side.
      // Bank side is determined by amount sign.
      const offsetAccount = mapping.debit_account;
      const hasExplicitCredit = mapping.credit_account && mapping.credit_account !== mapping.debit_account;
      if (hasExplicitCredit) {
        // Legacy explicit DR/CR mapping
        result.debitAccount = mapping.debit_account;
        result.creditAccount = mapping.credit_account;
      } else {
        // Auto-assign bank side based on amount sign
        result.debitAccount = isInflow ? bankAccount : offsetAccount;
        result.creditAccount = isInflow ? offsetAccount : bankAccount;
      }
      result.vatCode = mapping.vat_code;
      result.costCenter = mapping.cost_center;
      result.profitCenter = mapping.profit_center;
      if (mapping.description_override) result.description = mapping.description_override;
    }

    if (!result.matchType && openBills.length > 0) {
      const m = matchBillRow(openBills, row.description, amount);
      if (m) {
        // P1-9 import hardening: amount-only matches become confirm-required
        // suggestions ('bill_suggest'), never silent auto-links.
        result.matchType = m.tier === 'suggest' ? 'bill_suggest' : 'bill';
        result.matchConfidence = m.tier;
        result.billId = m.bill.bill_id;
        result.description = `Payment: ${m.bill.partner_name} ${m.bill.vendor_ref || ''}`.trim();
        result.debitAccount = isInflow ? bankAccount : (m.bill.ap_account || null);
        result.creditAccount = isInflow ? (m.bill.ap_account || null) : bankAccount;
      }
    }

    if (!result.matchType) {
      if (isInflow) result.debitAccount = bankAccount;
      else result.creditAccount = bankAccount;
    }

    processed.push(result);
  }

  return {
    processed,
    summary: {
      total: processed.length,
      ruleMatched: processed.filter((p) => p.matchType === 'rule').length,
      billMatched: processed.filter((p) => p.matchType === 'bill').length,
      billSuggest: processed.filter((p) => p.matchType === 'bill_suggest').length,
      recordedPayment: processed.filter((p) => p.matchType === 'recorded_payment').length,
      unmatched: processed.filter((p) => !p.matchType).length,
    },
  };
}

// ── §6: specificity scoring (longest-match-wins) + §5.3 amount_sign filter ─
// Collect ALL matching rules, sort by pattern length descending (most specific
// first), then by priority ASC as tiebreaker. Return the first match whose
// amount_sign is compatible with the line's direction (§6.4).
function matchMapping(mappings, description, amount) {
  if (!description) return null;
  const desc = description.toUpperCase();
  const matches = [];
  for (const m of mappings) {
    const pattern = m.pattern.toUpperCase();
    let matched = false;
    switch (m.match_type) {
      case 'exact':        matched = (desc === pattern); break;
      case 'starts_with':  matched = desc.startsWith(pattern.replace(/\*$/, '')); break;
      case 'contains':     matched = desc.includes(pattern.replace(/\*/g, '')); break;
      case 'regex':
        try { matched = new RegExp(m.pattern, 'i').test(description); } catch { /* invalid regex */ }
        break;
    }
    if (matched) matches.push(m);
  }
  if (matches.length === 0) return null;
  // Sort by pattern length descending (most specific first), then priority ASC.
  matches.sort((a, b) => {
    const lenDiff = (b.pattern || '').length - (a.pattern || '').length;
    if (lenDiff !== 0) return lenDiff;
    return (a.priority || 100) - (b.priority || 100);
  });
  // §6.4: iterate sorted matches, return first with compatible amount_sign.
  if (amount !== undefined && amount !== null) {
    for (const m of matches) {
      if (amountSignMatches(m.amount_sign, amount)) return m;
    }
    // Pattern matched but no amount_sign-compatible rule → no match
    return null;
  }
  return matches[0];
}

function matchBillRow(openBills, description, amount) {
  if (!description) return null;
  const desc = description.toUpperCase();
  for (const bill of openBills) {
    const outstanding = Number(bill.outstanding);
    if (Math.abs(outstanding - amount) < 0.01) {
      const vendor = (bill.partner_name || '').toUpperCase();
      const ref = (bill.vendor_ref || '').toUpperCase();
      // vendor_ref as a WHOLE TOKEN in the narrative promotes the match to high
      if (ref) {
        const token = new RegExp('(^|[^A-Z0-9])' + ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Z0-9]|$)');
        if (token.test(desc)) return { bill, tier: 'high' };
      }
      if ((vendor && desc.includes(vendor)) || (ref && desc.includes(ref))) return { bill, tier: 'medium' };
    }
  }
  // Amount-only fallback: returned as a suggestion tier — confirm-required (P1-9)
  for (const bill of openBills) {
    if (Math.abs(Number(bill.outstanding) - amount) < 0.01) return { bill, tier: 'suggest' };
  }
  return null;
}

/**
 * B4 (bank-matching-spec §4.1) — richer open-item amount matcher with
 * discrepancy classification. Reused by matchLine (tier 2) so the per-line API
 * returns the structured { bill, discrepancy_type, delta, confidence } shape
 * the agent expects, rather than matchBillRow's flat tier strings.
 *
 * Discrepancy types (§4.1):
 *   open_item_exact            — |delta| < 0.01                  conf 1.00
 *   early_payment_discount    — 1-2% below invoice               conf 0.85
 *   bank_fee_netted           — small fixed delta 5..50          conf 0.70
 *   fx_rounding               — cross-currency (bill≠bank)       conf 0.65
 *   partial_payment           — amount < invoice (>2% below)     conf 0.50
 *
 * Vendor name / vendor_ref corroboration (mirrors matchBillRow) promotes
 * lower-confidence tolerance matches to 'high'.
 * Returns null if no open bill is a plausible amount match.
 */
function matchOpenItem(openBills, amount, description) {
  if (!Array.isArray(openBills) || openBills.length === 0) return null;
  const desc = (description || '').toUpperCase();
  const absAmount = Math.abs(amount);

  // 1) Exact amount match (within 0.01) — prefer vendor/ref corroboration.
  for (const bill of openBills) {
    const outstanding = Number(bill.outstanding);
    if (Math.abs(outstanding - absAmount) < 0.01) {
      const vendor = (bill.partner_name || '').toUpperCase();
      const ref = (bill.vendor_ref || '').toUpperCase();
      let corroborated = false;
      if (ref) {
        const token = new RegExp('(^|[^A-Z0-9])' + ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Z0-9]|$)');
        if (token.test(desc)) corroborated = true;
      }
      if (!corroborated && vendor && desc.includes(vendor)) corroborated = true;
      if (!corroborated && ref && desc.includes(ref)) corroborated = true;
      return {
        bill,
        discrepancy_type: 'open_item_exact',
        delta: 0,
        confidence: corroborated ? 1.0 : 0.95,
      };
    }
  }

  // 2) Tolerance matches — classify the discrepancy (§4.1).
  for (const bill of openBills) {
    const outstanding = Number(bill.outstanding);
    if (!outstanding || outstanding <= 0) continue;
    const delta = outstanding - absAmount; // positive ⇒ bank paid less than invoice
    const absDelta = Math.abs(delta);
    if (absDelta < 0.01) continue; // already handled as exact above
    // Only consider "amount ≤ invoice" tolerance paths (delta >= 0); overpayment
    // is left to tier 4 (LLM) — v1 deterministic core is conservative.
    if (delta < 0) continue;

    const pct = delta / outstanding;
    let discrepancy_type = null;
    let confidence = 0.70;
    if (pct >= 0.01 && pct <= 0.02) {
      discrepancy_type = 'early_payment_discount';
      confidence = 0.85;
    } else if (absDelta >= 5 && absDelta <= 50) {
      discrepancy_type = 'bank_fee_netted';
      confidence = 0.70;
    } else if (bill.currency && bill.currency !== 'USD' /* home */) {
      discrepancy_type = 'fx_rounding';
      confidence = 0.65;
    } else if (absAmount < outstanding) {
      discrepancy_type = 'partial_payment';
      confidence = 0.50;
    }
    if (!discrepancy_type) continue;

    // Vendor/ref corroboration promotes the match (same logic as exact path).
    const vendor = (bill.partner_name || '').toUpperCase();
    const ref = (bill.vendor_ref || '').toUpperCase();
    let corroborated = false;
    if (ref) {
      const token = new RegExp('(^|[^A-Z0-9])' + ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Z0-9]|$)');
      if (token.test(desc)) corroborated = true;
    }
    if (!corroborated && vendor && desc.includes(vendor)) corroborated = true;
    if (!corroborated && ref && desc.includes(ref)) corroborated = true;
    if (corroborated) confidence = Math.min(1.0, confidence + 0.10);

    return { bill, discrepancy_type, delta, confidence };
  }

  // 3) 1:N — one transaction settles 2-8 open bills from the same vendor
  // (bank-matching-spec §4.1). Brute-force with cap N ≤ 8.
  const byVendor = new Map();
  for (const bill of openBills) {
    const v = (bill.partner_name || '').toUpperCase();
    if (!v) continue;
    if (!byVendor.has(v)) byVendor.set(v, []);
    byVendor.get(v).push(bill);
  }
  for (const [, bills] of byVendor) {
    if (bills.length < 2) continue;
    // Cap N at 8; iterate subset sizes 2..8.
    for (let n = 2; n <= Math.min(8, bills.length); n++) {
      const combos = combinations(bills, n);
      for (const combo of combos) {
        const sum = combo.reduce((s, b) => s + Number(b.outstanding), 0);
        if (Math.abs(sum - absAmount) < 0.01) {
          return {
            bill: combo[0],          // primary bill (first by due_date ordering)
            bills: combo,            // full set for the agent's evidence
            discrepancy_type: 'open_item_exact',
            delta: 0,
            confidence: 0.90,         // multi-invoice exact sum, slightly below single exact
          };
        }
      }
    }
  }

  return null;
}

// k-combinations of an array (order preserved by index, not by value).
function combinations(arr, k) {
  const out = [];
  const n = arr.length;
  if (k > n) return out;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    out.push(idx.map((i) => arr[i]));
    // find rightmost index that can advance
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return out;
}

/**
 * B4 (bank-matching-spec §8.2) — bank.match handler.
 *
 * Runs the deterministic tiers 1-3 against a single statement line and returns
 * structured match results with per-dimension confidence + evidence. The agent
 * (or human UI) then decides what to do — this action does NOT write to the
 * database (catalog mutating:false); it never proposes. Tier 4 (LLM) is the
 * caller's responsibility when this returns { matched: false, reason: 'no_match' }.
 *
 * Input line: { date, amount, description, counterparty?, transaction_id? }
 * Pre-cascade (§1.1): idempotency dedup against journal_proposals.source_transaction_id.
 *
 * Output (matched): { matched:true, tier, source_type, confidence, evidence,
 *   suggested_dimensions, lines }
 * Output (no match): { matched:false, reason:'no_match' }
 * Output (duplicate): { matched:false, reason:'duplicate', existing_proposal_id }
 */
async function matchLine(ctx) {
  const { companyId, body } = ctx;
  const line = body && body.line;
  const bankAccountParam = body && body.bankAccount;

  if (!line || typeof line !== 'object') {
    throw Object.assign(new Error('line object required'), { code: 'INVALID_INPUT' });
  }
  if (line.amount == null || line.description == null || line.date == null) {
    throw Object.assign(new Error('line requires date, amount, description'), { code: 'INVALID_INPUT' });
  }

  // Resolve bank account: explicit param → settings default.
  let bankAccount = bankAccountParam || null;
  if (!bankAccount) {
    const settingsRows = await query(
      `SELECT value FROM settings WHERE company_id = @companyId AND key = 'default_bank_account'`,
      { companyId }
    );
    bankAccount = settingsRows.length > 0 ? settingsRows[0].value : null;
  }

  // ── Pre-cascade idempotency dedup (§1.1) ──────────────────────────────────
  // If we already have a journal_proposal for this transaction (bank-provided
  // id, or a content hash we synthesized), don't re-match — return duplicate.
  const sourceTransactionId = line.transaction_id ||
    `${line.date}|${line.amount}|${line.description}|${bankAccount || ''}`;
  const dupRows = await query(
    `SELECT proposal_id FROM journal_proposals
     WHERE company_id = @companyId AND source_transaction_id = @sourceTransactionId
     LIMIT 1`,
    { companyId, sourceTransactionId }
  );
  if (dupRows.length > 0) {
    return { matched: false, reason: 'duplicate', existing_proposal_id: dupRows[0].proposal_id };
  }

  // ── Tier 1 — learned rules (§1, source_type 'learned_rule') ───────────────
  const mappings = await query(
    `SELECT * FROM bank_mappings
     WHERE company_id = @companyId AND is_active = TRUE
     ORDER BY priority ASC`,
    { companyId }
  );
  const mapping = matchMapping(mappings, line.description, line.amount);
  if (mapping) {
    const isInflow = Number(line.amount) > 0;
    const offsetAccount = mapping.debit_account;
    const hasExplicitCredit = mapping.credit_account && mapping.credit_account !== mapping.debit_account;
    const debitAccount = hasExplicitCredit
      ? mapping.debit_account
      : (isInflow ? bankAccount : offsetAccount);
    const creditAccount = hasExplicitCredit
      ? mapping.credit_account
      : (isInflow ? offsetAccount : bankAccount);
    const amount = Math.abs(Number(line.amount));

    return {
      matched: true,
      tier: 1,
      source_type: 'learned_rule',
      confidence: {
        account:      { value: mapping.debit_account, confidence: 0.95, derived_from: [] },
        vat_code:      { value: mapping.vat_code || null, confidence: 0.60, derived_from: ['account'] },
        counterparty:  { value: null, confidence: 0, derived_from: [] },
      },
      evidence: [{
        type: 'rule_match',
        description: `Pattern '${mapping.pattern}' → account ${mapping.debit_account}`,
        mapping_id: mapping.mapping_id,
      }],
      suggested_dimensions: {
        account: mapping.debit_account,
        vat_code: mapping.vat_code || null,
        counterparty: null,
        cost_center: mapping.cost_center || null,
        profit_center: mapping.profit_center || null,
      },
      lines: [
        { account_code: debitAccount,  debit: amount,  credit: 0,        date: line.date, description: line.description, vat_code: mapping.vat_code || null },
        { account_code: creditAccount, debit: 0,       credit: amount,   date: line.date, description: line.description },
      ],
    };
  }

  // ── Tier 2 — open items (§4, source_type 'open_item') ─────────────────────
  const companies = await query(
    `SELECT accounting_method FROM companies WHERE company_id = @companyId LIMIT 1`,
    { companyId }
  );
  const accountingMethod = companies[0]?.accounting_method;

  if (accountingMethod !== 'cash') {
    const openBills = await query(
      `SELECT bill_id, partner_name, vendor_ref, amount_home, amount_paid, ap_account,
              currency, (amount_home - amount_paid) AS outstanding, due_date
       FROM bills
       WHERE company_id = @companyId AND status IN ('posted', 'partial')
       ORDER BY due_date`,
      { companyId }
    );
    const m = matchOpenItem(openBills, line.amount, line.description);
    if (m) {
      const isInflow = Number(line.amount) > 0;
      const amount = Math.abs(Number(line.amount));
      const bill = m.bill;
      const apAccount = bill.ap_account || null;
      const debitAccount = isInflow ? bankAccount : apAccount;
      const creditAccount = isInflow ? apAccount : bankAccount;
      const evidenceType = m.discrepancy_type === 'open_item_exact' ? 'open_item_exact' : 'open_item_tolerance';
      const ev = {
        type: evidenceType,
        description: m.discrepancy_type === 'open_item_exact'
          ? `Exact amount match: ${bill.partner_name} ${bill.vendor_ref || ''}`
          : `${m.discrepancy_type} (delta ${m.delta.toFixed(2)}): ${bill.partner_name} ${bill.vendor_ref || ''}`,
        bill_id: bill.bill_id,
        discrepancy_type: m.discrepancy_type,
        delta: m.delta,
      };
      if (m.bills) ev.bills = m.bills.map((b) => b.bill_id);

      return {
        matched: true,
        tier: 2,
        source_type: 'open_item',
        confidence: {
          account:      { value: apAccount,    confidence: m.confidence, derived_from: ['bill'] },
          vat_code:      { value: null,         confidence: 0,           derived_from: [] },
          counterparty:  { value: bill.partner_name, confidence: m.confidence, derived_from: ['bill'] },
        },
        evidence: [ev],
        suggested_dimensions: {
          account: apAccount,
          vat_code: null,
          counterparty: bill.partner_name,
          cost_center: null,
          profit_center: null,
        },
        lines: [
          { account_code: debitAccount,  debit: amount, credit: 0,      date: line.date, description: line.description },
          { account_code: creditAccount, debit: 0,      credit: amount,  date: line.date, description: line.description },
        ],
      };
    }
  }

  // ── Tier 3 — master data / vendors (§1, source_type 'master_data') ────────
  // v1: case-insensitive substring of vendor name in the description. The spec
  // mentions trigram similarity but says it's simplified for small companies.
  const vendors = await query(
    `SELECT partner_id, name, default_expense_account AS expense_account FROM partners WHERE company_id = @companyId AND is_vendor = TRUE`,
    { companyId }
  );
  if (vendors.length > 0) {
    const descLc = (line.description || '').toLowerCase();
    let bestVendor = null;
    for (const v of vendors) {
      const nameLc = (v.name || '').toLowerCase();
      if (nameLc && descLc.includes(nameLc)) {
        // Prefer the longest matching name (most specific).
        if (!bestVendor || (v.name || '').length > (bestVendor.name || '').length) {
          bestVendor = v;
        }
      }
    }
    if (bestVendor) {
      const isInflow = Number(line.amount) > 0;
      const amount = Math.abs(Number(line.amount));
      const expenseAccount = bestVendor.expense_account || null;
      const offsetAccount = expenseAccount;
      const debitAccount = isInflow ? bankAccount : offsetAccount;
      const creditAccount = isInflow ? offsetAccount : bankAccount;
      const lines = expenseAccount
        ? [
            { account_code: debitAccount,  debit: amount, credit: 0,     date: line.date, description: line.description },
            { account_code: creditAccount, debit: 0,      credit: amount, date: line.date, description: line.description },
          ]
        : [];

      return {
        matched: true,
        tier: 3,
        source_type: 'master_data',
        confidence: {
          account:      { value: expenseAccount,           confidence: 0.50, derived_from: [] },
          vat_code:      { value: null,                    confidence: 0,    derived_from: [] },
          counterparty:  { value: bestVendor.partner_id,    confidence: 0.70, derived_from: [] },
        },
        evidence: [{
          type: 'counterparty_name_fuzzy',
          description: `Description '${line.description}' matches vendor '${bestVendor.name}'`,
          partner_id: bestVendor.partner_id,
        }],
        suggested_dimensions: {
          account: expenseAccount,
          vat_code: null,
          counterparty: bestVendor.partner_id,
          cost_center: null,
          profit_center: null,
        },
        lines,
      };
    }
  }

  // ── Tier 3.5 — Historical outcome match (§2) ──────────────────────────────
  // If tiers 1–3 didn't match, check whether this exact description was
  // approved before. Only learns from clean (approved_unedited) outcomes.
  // Uses the same normalization as matching_history.record (§3.3).
  if (line.description) {
    const normalized = normalizeDescription(line.description);
    if (normalized) {
      const historyRows = await query(
        `SELECT approved_dimensions, source_type, confidence, evidence, amount, created_at
         FROM matching_history
         WHERE company_id = @companyId
           AND description_pattern = @pattern
           AND outcome = 'approved_unedited'
         ORDER BY created_at DESC
         LIMIT 50`,
        { companyId, pattern: normalized }
      );
      if (historyRows.length > 0) {
        // Determine the modal account — most frequently approved.
        const accountCounts = {};
        for (const h of historyRows) {
          let acct = null;
          try {
            const dims = h.approved_dimensions ? JSON.parse(h.approved_dimensions) : null;
            acct = dims && dims.account ? dims.account : null;
          } catch { /* skip unparseable */ }
          if (acct) accountCounts[acct] = (accountCounts[acct] || 0) + 1;
        }
        const modalAccount = Object.entries(accountCounts).sort((a, b) => b[1] - a[1])[0];
        if (modalAccount) {
          const account = modalAccount[0];
          const approvalCount = modalAccount[1];
          const isInflow = Number(line.amount) > 0;
          const amount = Math.abs(Number(line.amount));
          const offsetAccount = account;
          const debitAccount = isInflow ? bankAccount : offsetAccount;
          const creditAccount = isInflow ? offsetAccount : bankAccount;

          // Confidence calibration (§2.3)
          let confidence;
          if (approvalCount >= 3)      confidence = 0.88;
          else if (approvalCount === 2) confidence = 0.82;
          else                          confidence = 0.75;

          // Build evidence citing the prior approvals
          const recentDates = historyRows.slice(0, 5).map((h) => {
            try { return h.created_at ? new Date(h.created_at).toISOString().substring(0, 10) : '?'; }
            catch { return '?'; }
          });

          return {
            matched: true,
            tier: 3.5,
            source_type: 'historical_match',
            confidence: {
              account:      { value: account, confidence, derived_from: ['matching_history'] },
              vat_code:     { value: null,    confidence: 0,    derived_from: [] },
              counterparty: { value: null,    confidence: 0,    derived_from: [] },
            },
            evidence: [{
              type: 'historical_outcome',
              description: `Previously approved to account ${account} ${approvalCount} time(s)`,
              approval_count: approvalCount,
              prior_dates: recentDates,
            }],
            suggested_dimensions: {
              account,
              vat_code: null,
              counterparty: null,
              cost_center: null,
              profit_center: null,
            },
            lines: [
              { account_code: debitAccount,  debit: amount,  credit: 0,       date: line.date, description: line.description },
              { account_code: creditAccount, debit: 0,       credit: amount,  date: line.date, description: line.description },
            ],
          };
        }
      }
    }
  }

  // ── No match — caller routes to tier 4 (LLM) ──────────────────────────────
  return { matched: false, reason: 'no_match' };
}

async function approveBankEntries(ctx) {
  const { companyId, userEmail, body } = ctx;
  const { entries, newMappings = [], journalId: requestedJournalId } = body;

  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    throw Object.assign(new Error('entries array required'), { code: 'INVALID_INPUT' });
  }

  const companies = await query(
    `SELECT currency FROM companies WHERE company_id = @companyId LIMIT 1`,
    { companyId }
  );
  const homeCurrency = companies[0]?.currency || 'USD';

  // CHANGE 3: Validate all accounts before posting any entries
  const accountCodes = new Set();
  for (const entry of entries) {
    if (entry.debitAccount) accountCodes.add(entry.debitAccount);
    if (entry.creditAccount) accountCodes.add(entry.creditAccount);
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

  // Pre-fetch once for all entries
  let bankJournalId = requestedJournalId || null;
  if (!bankJournalId) {
    const bankJournals = await query(
      `SELECT journal_id FROM journals WHERE company_id = @companyId AND code = 'BANK' AND active = true LIMIT 1`,
      { companyId }
    );
    bankJournalId = bankJournals.length > 0 ? bankJournals[0].journal_id : null;
  }

  // Pre-allocate references grouped by year — 3 DB calls per year instead of 3 per entry
  const entriesByYear = {};
  for (const entry of entries) {
    if (entry.recordedPayment) continue; // clearing-only entries post nothing — no reference needed
    const yr = parseInt(String(entry.date).substring(0, 4), 10);
    if (!entriesByYear[yr]) entriesByYear[yr] = [];
    entriesByYear[yr].push(entry);
  }
  const referenceMap = new Map(); // entry index → reference string
  if (bankJournalId) {
    for (const [yr, yearEntries] of Object.entries(entriesByYear)) {
      const refs = await getNextReferenceBatch(companyId, bankJournalId, parseInt(yr, 10), yearEntries.length);
      yearEntries.forEach((entry, idx) => {
        const globalIdx = entries.indexOf(entry);
        referenceMap.set(globalIdx, refs[idx]);
      });
    }
  }

  const results = [];
  const errors = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const amount = Math.abs(entry.amount);
    const batchId = uuid();
    const now = new Date().toISOString();

    try {
      // P1-9: row matched an already-recorded manual payment — clear the payment's
      // bank leg in reconciliations, never re-post the journal.
      if (entry.recordedPayment && entry.paymentBatchId) {
        await exec(
          `INSERT INTO reconciliations (company_id, batch_id, account_code, cleared_at, cleared_by)
           VALUES (@companyId, @batchId, @accountCode, NOW(), @clearedBy)
           ON CONFLICT DO NOTHING`,
          { companyId, batchId: entry.paymentBatchId, accountCode: entry.bankAccount, clearedBy: userEmail || 'user' }
        );
        results.push({ index: i, cleared: true, recordedPayment: true });
        continue;
      }

      const reference = referenceMap.get(i) || null;

      // Bill settlements go through the shared settlement core (P1-9) — no generic pre-post
      if (entry.billId && !entry.recordedPayment) {
        const s = await settleBillPayment({
          ctx,
          companyId, userEmail, billId: entry.billId,
          bankAccount: entry.creditAccount,
          homeCurrency,
          bankAmount: amount,
          date: entry.date,
          reference,
          description: entry.description,
          settledForeign: entry.settledForeign != null ? Number(entry.settledForeign) : null,
          billPayRate: entry.billPayRate ? Number(entry.billPayRate) : null,
          method: 'bank_match',
          source: 'bank_import',
          journalId: bankJournalId,
          currency: entry.currency || homeCurrency,
          fxRate: entry.fxRate || 1.0,
        });
        if (s.warning) {
          results.push({ index: i, batchId: s.batchId, posted: true, warning: s.warning });
        }
        if (s.fxDiff !== undefined) {
          results.push({ index: i, batchId: s.batchId, posted: true, fxDiff: s.fxDiff, settledForeign: s.settledForeign, settledBooked: s.settledBooked });
        } else {
          results.push({ index: i, batchId: s.batchId, posted: true });
        }
        continue;
      }

      let lines = [
        { account_code: entry.debitAccount, debit: amount, credit: 0, date: entry.date, description: entry.description, vat_code: entry.vatCode || null, cost_center: entry.costCenter || null, profit_center: entry.profitCenter || null },
        { account_code: entry.creditAccount, debit: 0, credit: amount, date: entry.date, description: entry.description },
      ];

      if (entry.vatCode) {
        // P2-4a: bank import is tax-INCLUSIVE — the bank amount IS settled gross cash.
        // expandVatLines → computeVatSplitGross back-calculates net from gross. This is correct
        // for bank imports (unlike journal entries which are now tax-exclusive). Do NOT unify.
        const expandedDebit = await expandVatLines(companyId, lines[0]);
        lines = [...expandedDebit, lines[1]];
        const totalDebit = lines.slice(0, -1).reduce((s, l) => s + (l.debit || 0), 0);
        lines[lines.length - 1].credit = totalDebit;
      }

      const journalRows = lines.map((line) => ({
        company_id: companyId,
        entry_id: uuid(),
        batch_id: batchId,
        date: line.date,
        account_code: line.account_code,
        debit: line.debit || 0,
        credit: line.credit || 0,
        currency: entry.currency || homeCurrency,
        fx_rate: entry.fxRate || 1.0,
        debit_home: (line.debit || 0) * (entry.fxRate || 1.0),
        credit_home: (line.credit || 0) * (entry.fxRate || 1.0),
        vat_code: line.vat_code || null,
        vat_amount: line.vat_amount || 0,
        vat_amount_home: (line.vat_amount || 0) * (entry.fxRate || 1.0),
        net_amount: line.net_amount || 0,
        net_amount_home: (line.net_amount || 0) * (entry.fxRate || 1.0),
        description: line.description || entry.description,
        reference,
        source: 'bank_import',
        cost_center: line.cost_center || null,
        profit_center: line.profit_center || null,
        reverses: null,
        reversed_by: null,
        bill_id: entry.billId || null,
        created_by: userEmail,
        created_at: now,
      }));

      // Post the normal 2-line journal first
      await bulkInsert('journal_entries', journalRows);

      results.push({ index: i, batchId, posted: true });
    } catch (err) {
      errors.push({ index: i, error: err.message });
    }
  }

  if (newMappings.length > 0) {
    const mappingRows = newMappings.map((m) => ({
      company_id: companyId,
      mapping_id: uuid(),
      pattern: m.pattern,
      match_type: m.match_type || 'contains',
      debit_account: m.debit_account,
      credit_account: m.credit_account,
      description_override: m.description_override || null,
      vat_code: m.vat_code || null,
      cost_center: m.cost_center || null,
      profit_center: m.profit_center || null,
      priority: m.priority || 100,
      is_active: true,
    }));
    await bulkInsert('bank_mappings', mappingRows);
  }

  return { posted: results.length, failed: errors.length, newMappings: newMappings.length, results, errors };
}

async function listReconcile(ctx) {
  const { companyId, body } = ctx;
  const { accountCode, dateFrom, dateTo } = body;
  if (!accountCode) throw Object.assign(new Error('accountCode required'), { code: 'INVALID_INPUT' });

  // Fetch opening balance (all activity before dateFrom)
  let openingBalance = 0;
  if (dateFrom) {
    const ob = await query(
      `SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS balance
       FROM journal_entries
       WHERE company_id = @companyId AND account_code = @accountCode AND date < @dateFrom`,
      { companyId, accountCode, dateFrom }
    );
    openingBalance = ob.length > 0 ? parseFloat(ob[0].balance || 0) : 0;
  }

  const rows = await query(
    `SELECT je.batch_id, je.date, je.reference, je.description,
            SUM(je.debit) AS debit, SUM(je.credit) AS credit,
            MAX(r.cleared_at) AS cleared_at
     FROM journal_entries je
     LEFT JOIN reconciliations r ON r.company_id = je.company_id AND r.batch_id = je.batch_id AND r.account_code = je.account_code
     WHERE je.company_id = @companyId AND je.account_code = @accountCode
       ${dateFrom ? 'AND je.date >= @dateFrom' : ''}
       ${dateTo   ? 'AND je.date <= @dateTo'   : ''}
     GROUP BY je.batch_id, je.date, je.reference, je.description
     ORDER BY je.date, je.batch_id`,
    { companyId, accountCode, ...(dateFrom && { dateFrom }), ...(dateTo && { dateTo }) }
  );
  return { rows: rows.map(r => ({ ...r, cleared: !!r.cleared_at })), openingBalance };
}

async function clearReconcile(ctx) {
  const { companyId, userEmail, body } = ctx;
  const { batchId, accountCode, cleared } = body;
  if (!batchId || !accountCode) throw Object.assign(new Error('batchId and accountCode required'), { code: 'INVALID_INPUT' });
  if (cleared) {
    await exec(
      `INSERT INTO reconciliations (company_id, batch_id, account_code, cleared_at, cleared_by)
       VALUES (@companyId, @batchId, @accountCode, NOW(), @clearedBy)
       ON CONFLICT DO NOTHING`,
      { companyId, batchId, accountCode, clearedBy: userEmail || 'user' }
    );
  } else {
    await exec(
      `DELETE FROM reconciliations WHERE company_id = @companyId AND batch_id = @batchId AND account_code = @accountCode`,
      { companyId, batchId, accountCode }
    );
  }
  return { ok: true };
}

async function listAllUncleared(ctx) {
  const { companyId } = ctx;
  const rows = await query(
    `SELECT je.batch_id, je.date, je.reference, je.description,
            a.account_code, a.account_name,
            SUM(je.debit) AS debit, SUM(je.credit) AS credit
     FROM journal_entries je
     JOIN accounts a ON a.account_code = je.account_code AND a.company_id = je.company_id
     LEFT JOIN reconciliations r
       ON r.company_id = je.company_id
       AND r.batch_id = je.batch_id
       AND r.account_code = je.account_code
     WHERE je.company_id = @companyId AND a.cf_category = 'Cash' AND r.batch_id IS NULL
     GROUP BY je.batch_id, je.date, je.reference, je.description, a.account_code, a.account_name
     ORDER BY je.date, je.batch_id`,
    { companyId }
  );
  return { rows: rows.map(r => ({ ...r, cleared: false })) };
}

module.exports = { handleBank, listReconcile };
