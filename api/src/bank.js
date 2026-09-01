'use strict';
/**
 * freeBooks — Bank statement processing
 * Ported from BigQuery Cloud Function to DuckDB/Express.
 */

const { query, exec } = require('./db');
const { amountSignMatches, normalizeDescription } = require('./mapping-utils');

async function handleBank(ctx, action) {
  switch (action) {
    case 'bank.reconcile.list':  return listReconcile(ctx);
    case 'bank.reconcile.clear': return clearReconcile(ctx);
    case 'bank.uncleared.list':  return listAllUncleared(ctx);
    case 'bank.match':           return matchLine(ctx);
    default:
      throw Object.assign(new Error(`Unknown bank action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
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
 * Partner name / vendor_ref corroboration (mirrors matchBillRow) promotes
 * lower-confidence tolerance matches to 'high'.
 * Returns null if no open bill is a plausible amount match.
 */
function matchOpenItem(openBills, amount, description, homeCurrency) {
  if (!Array.isArray(openBills) || openBills.length === 0) return null;
  const desc = (description || '').toUpperCase();
  const absAmount = Math.abs(amount);

  // 1) Exact amount match (within 0.01) — prefer partner/ref corroboration.
  for (const bill of openBills) {
    const outstanding = Number(bill.outstanding);
    if (Math.abs(outstanding - absAmount) < 0.01) {
      const partner = (bill.partner_name || '').toUpperCase();
      const ref = (bill.vendor_ref || '').toUpperCase();
      let corroborated = false;
      if (ref) {
        const token = new RegExp('(^|[^A-Z0-9])' + ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Z0-9]|$)');
        if (token.test(desc)) corroborated = true;
      }
      if (!corroborated && partner && desc.includes(partner)) corroborated = true;
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
    } else if (bill.currency && bill.currency !== homeCurrency) {
      discrepancy_type = 'fx_rounding';
      confidence = 0.65;
    } else if (absAmount < outstanding) {
      discrepancy_type = 'partial_payment';
      confidence = 0.50;
    }
    if (!discrepancy_type) continue;

    // Partner/ref corroboration promotes the match (same logic as exact path).
    const partner = (bill.partner_name || '').toUpperCase();
    const ref = (bill.vendor_ref || '').toUpperCase();
    let corroborated = false;
    if (ref) {
      const token = new RegExp('(^|[^A-Z0-9])' + ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Z0-9]|$)');
      if (token.test(desc)) corroborated = true;
    }
    if (!corroborated && partner && desc.includes(partner)) corroborated = true;
    if (!corroborated && ref && desc.includes(ref)) corroborated = true;
    if (corroborated) confidence = Math.min(1.0, confidence + 0.10);

    return { bill, discrepancy_type, delta, confidence };
  }

  // 3) 1:N — one transaction settles 2-8 open bills from the same partner
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
    `SELECT accounting_method, currency FROM companies WHERE company_id = @companyId LIMIT 1`,
    { companyId }
  );
  const accountingMethod = companies[0]?.accounting_method;
  const homeCurrency = companies[0]?.currency || 'USD';

  if (accountingMethod !== 'cash') {
    const openBills = await query(
      `SELECT bill_id, partner_name, vendor_ref, amount_home, amount_paid, ap_account,
              currency, (amount_home - amount_paid) AS outstanding, due_date
       FROM bills
       WHERE company_id = @companyId AND status IN ('posted', 'partial')
       ORDER BY due_date`,
      { companyId }
    );
    const m = matchOpenItem(openBills, line.amount, line.description, homeCurrency);
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

      // bank-match-bill-settlement-spec.md §2.1: tag the AP-side line with
      // bill_id so approval can settle the bill. Scoped to the single-bill,
      // home-currency case for now — multi-bill (m.bills) needs the §2.2
      // N-lines restructuring (today's code only ever posts against
      // combo[0], silently dropping the other matched bills from the
      // journal), and a foreign-currency bill needs the §2.3 FX allocation
      // this pass does not add. Neither is safe to auto-settle yet: tagging
      // bill_id here without those would let a home-currency-amount journal
      // line silently corrupt a foreign-currency-tracked amount_paid, or
      // settle only one of several matched bills while showing them all as
      // paid. Both cases post exactly as before — untagged, human-reviewed,
      // not auto-settled.
      const apLineIsDebit = debitAccount === apAccount;
      const singleBillHomeCurrency = !m.bills && (!bill.currency || bill.currency === homeCurrency);
      const apLine = { account_code: apAccount, date: line.date, description: line.description };
      if (apLineIsDebit) { apLine.debit = amount; apLine.credit = 0; }
      else { apLine.debit = 0; apLine.credit = amount; }
      if (singleBillHomeCurrency) apLine.bill_id = bill.bill_id;
      const bankLine = {
        account_code: bankAccount, date: line.date, description: line.description,
        debit: apLineIsDebit ? 0 : amount, credit: apLineIsDebit ? amount : 0,
      };

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
        lines: apLineIsDebit ? [apLine, bankLine] : [bankLine, apLine],
      };
    }
  }

  // ── Tier 3 — master data / partners (§1, source_type 'master_data') ────────
  // v1: case-insensitive substring of partner name in the description. The spec
  // mentions trigram similarity but says it's simplified for small companies.
  const partners = await query(
    `SELECT partner_id, name, default_expense_account AS expense_account FROM partners WHERE company_id = @companyId AND is_vendor = TRUE`,
    { companyId }
  );
  if (partners.length > 0) {
    const descLc = (line.description || '').toLowerCase();
    let bestPartner = null;
    for (const v of partners) {
      const nameLc = (v.name || '').toLowerCase();
      if (nameLc && descLc.includes(nameLc)) {
        // Prefer the longest matching name (most specific).
        if (!bestPartner || (v.name || '').length > (bestPartner.name || '').length) {
          bestPartner = v;
        }
      }
    }
    if (bestPartner) {
      const isInflow = Number(line.amount) > 0;
      const amount = Math.abs(Number(line.amount));
      const expenseAccount = bestPartner.expense_account || null;
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
          description: `Description '${line.description}' matches partner '${bestPartner.name}'`,
          partner_id: bestPartner.partner_id,
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
