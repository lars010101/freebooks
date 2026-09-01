'use strict';
/**
 * freeBooks — Bank statement processing
 * Ported from BigQuery Cloud Function to DuckDB/Express.
 */

const { query, exec } = require('./db');
const { amountSignMatches, normalizeDescription } = require('./mapping-utils');
const { buildAllocationLines } = require('./settlement');

async function handleBank(ctx, action) {
  switch (action) {
    case 'bank.reconcile.list':  return listReconcile(ctx);
    case 'bank.reconcile.clear': return clearReconcile(ctx);
    case 'bank.uncleared.list':  return listAllUncleared(ctx);
    case 'bank.match':           return matchLine(ctx);
    case 'bank.match.toggleSettlement': return toggleSettlement(ctx);
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
// bank-matching-spec.md §4.3: corroborate via vendor_ref (word-boundary
// regex, strong signal) or vendor name (bidirectional substring). Real bank
// descriptions are usually truncated/abbreviated versions of a vendor's
// registered name ("NORTHSTAR" vs "NorthStar Pte Ltd") — checking only
// "description contains vendor name" misses that common case, so both
// directions are checked. Returns 'ref' | 'name' | null; ref is the
// stronger of the two and is returned in preference to name when both hit.
function corroborate(desc, partner, ref) {
  if (ref) {
    const token = new RegExp('(^|[^A-Z0-9])' + ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Z0-9]|$)');
    if (token.test(desc)) return 'ref';
  }
  if (partner && (desc.includes(partner) || partner.includes(desc))) return 'name';
  if (ref && desc.includes(ref)) return 'ref';
  return null;
}

/**
 * buildFxSettlementLines — the proper booking-rate/FX-gain-loss entry for
 * settling a foreign-currency bill via bank-match, for an EXPLICIT mode
 * ('full' | 'partial'). Shared by matchLine's initial (default) proposal
 * and the bank.match.toggleSettlement action (human override). Returns
 * {blocked:true, blockedReason} when the entry can't be safely built —
 * never falls back to an imprecise/unbalanced entry (bank-match-bill-
 * settlement-spec.md: approval must be refused, not silently degraded).
 *
 * @param {string} companyId
 * @param {object} bill        - needs ap_account, fx_rate, currency, amount, amount_paid
 * @param {number} bankAmount  - the observed bank-side amount (home currency, positive)
 * @param {'full'|'partial'} mode
 * @param {string} homeCurrency
 * @returns {Promise<{blocked:boolean, blockedReason?:string, apLine?, fxLine?, bankShare?, settledForeign?}>}
 */
async function buildFxSettlementLines(companyId, bill, bankAmount, mode, homeCurrency) {
  const bookingRate = Number(bill.fx_rate) || 0;
  if (!(bookingRate > 0)) {
    return { blocked: true, blockedReason: `Bill ${bill.bill_id} has no valid booking FX rate — cannot settle via bank-match. Check the bill's stored FX rate.` };
  }
  const outstandingForeign = Number(bill.amount) - Number(bill.amount_paid);
  let settledForeign, bankRate;
  if (mode === 'full') {
    // Closing payment — settle the FULL remaining foreign balance. The
    // booking-rate method clears AP at the ORIGINAL booking rate regardless
    // of what actually happened; back out the implied actual rate from what
    // the bank paid so the FX gain/loss line absorbs exactly the difference.
    settledForeign = outstandingForeign;
    bankRate = settledForeign > 0 ? (bankAmount / settledForeign) : bookingRate;
  } else {
    // partial: one bank-side number can't independently separate "how much
    // was paid" from "what rate applied" — assume the booking rate (no FX
    // difference on a still-open bill), producing a clean 2-line entry.
    settledForeign = bankAmount / bookingRate;
    bankRate = bookingRate;
  }
  const fxRows = await query(
    `SELECT account_code FROM accounts WHERE company_id = @companyId AND default_role = 'FX Gain/Loss' AND is_active = true LIMIT 1`,
    { companyId }
  );
  const fxAccount = fxRows[0]?.account_code || null;
  const alloc = buildAllocationLines({ bill, allocAmount: settledForeign, bankRate, fxAccount, homeCurrency });
  if (!alloc.fxLine && Math.abs(alloc.fxDiff) > 0.005) {
    // Real drift, no FX Gain/Loss account to absorb it. Posting AP at the
    // booking rate against the bank line at the bank rate would be an
    // UNBALANCED entry; posting AP at the bank rate instead (settleBillPayment's
    // own manual-payment fallback) would break approve-time settlement's
    // assumption that the AP line's debit IS the booking-rate amount.
    // Refuse rather than guess.
    return { blocked: true, blockedReason: 'FX Gain/Loss account not configured — add one in Settings → Company (mark an account’s Default Role as ‘FX Gain/Loss’) before approving this foreign-currency settlement.' };
  }
  return { blocked: false, apLine: alloc.apLine, fxLine: alloc.fxLine, bankShare: alloc.bankShare, settledForeign };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

// Human-reviewer override of the §4.4 band-classification default. Flips a
// still-proposed proposal's tagged AP/FX lines between 'full' and 'partial'
// settlement of the foreign bill. The bank-side line is never touched: for
// both modes in buildFxSettlementLines, bankShare is algebraically identical
// to the bank amount actually observed on the statement line, so the
// currently-tagged lines are always enough to recover it exactly.
//
// This bypasses journal.propose's upsert path deliberately — that path is
// actor-restricted to the original proposer (created_by = @proposer), so a
// human reviewer toggling settlement (a different actor) could not use it.
async function toggleSettlement(ctx) {
  const { companyId, body } = ctx;
  const { proposalId, billId } = body;
  if (!proposalId || !billId) throw Object.assign(new Error('proposalId and billId required'), { code: 'INVALID_INPUT' });

  const rows = await query(
    `SELECT lines, match_meta, status FROM journal_proposals WHERE company_id=@companyId AND proposal_id=@proposalId LIMIT 1`,
    { companyId, proposalId }
  );
  if (!rows.length) throw Object.assign(new Error('Proposal not found'), { code: 'NOT_FOUND' });
  if (rows[0].status !== 'proposed') throw Object.assign(new Error(`Cannot change settlement on a proposal in status '${rows[0].status}'`), { code: 'INVALID_STATUS' });

  let lines;
  try { lines = JSON.parse(rows[0].lines || '[]'); } catch (e) { throw Object.assign(new Error('Proposal lines are not valid JSON'), { code: 'CONFLICT' }); }
  let matchMeta = {};
  try { matchMeta = rows[0].match_meta ? JSON.parse(rows[0].match_meta) : {}; } catch (e) { matchMeta = {}; }

  const taggedLines = lines.filter((l) => l.bill_id === billId);
  if (!taggedLines.length) throw Object.assign(new Error('No lines in this proposal are tagged to that bill'), { code: 'INVALID_INPUT' });
  const otherLines = lines.filter((l) => l.bill_id !== billId);
  const bankAmount = round4(taggedLines.reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0));
  const sampleLine = taggedLines[0];

  const billRows = await query(
    `SELECT bill_id, ap_account, fx_rate, currency, amount, amount_paid FROM bills WHERE company_id=@companyId AND bill_id=@billId LIMIT 1`,
    { companyId, billId }
  );
  if (!billRows.length) throw Object.assign(new Error('Bill not found'), { code: 'NOT_FOUND' });
  const bill = billRows[0];

  const companyRows = await query(`SELECT currency FROM companies WHERE company_id=@companyId LIMIT 1`, { companyId });
  const homeCurrency = companyRows[0]?.currency || 'USD';

  const currentMode = (matchMeta.settlement && matchMeta.settlement.mode) || 'full';
  const newMode = currentMode === 'full' ? 'partial' : 'full';

  const fx = await buildFxSettlementLines(companyId, bill, bankAmount, newMode, homeCurrency);
  if (fx.blocked) {
    throw Object.assign(new Error(fx.blockedReason), { code: 'VALIDATION' });
  }
  // §2.1's tagged AP/FX lines are stored fully ENRICHED (currency, fx_rate,
  // debit_home/credit_home, vat_* — postJournalBatch reads these straight off
  // the stored proposal at approve time, it does not re-derive them). Handing
  // buildAllocationLines' bare {account_code, debit, credit} straight to the
  // stored lines array would leave those columns NULL and fail postJournalBatch's
  // NOT NULL constraints. Re-run the same enrichAndValidate pipeline
  // proposeEntry uses so the toggled lines end up enriched identically —
  // otherLines pass through unchanged (already enriched; recomputing off their
  // own currency/vat_code is idempotent).
  const { enrichAndValidate } = require('./journal');
  const rawApLine = { account_code: fx.apLine.account_code, date: sampleLine.date, description: sampleLine.description, debit: fx.apLine.debit, credit: fx.apLine.credit, bill_id: billId };
  const rawLines = otherLines.concat([rawApLine]);
  if (fx.fxLine) rawLines.push({ account_code: fx.fxLine.account_code, date: sampleLine.date, description: fx.fxLine.description || sampleLine.description, debit: fx.fxLine.debit, credit: fx.fxLine.credit, bill_id: billId });

  const { enrichedLines, validation } = await enrichAndValidate(companyId, rawLines);
  if (!validation.valid) {
    throw Object.assign(new Error((validation.errors || []).join('; ')), { code: 'VALIDATION', details: { errors: validation.errors, warnings: validation.warnings } });
  }

  matchMeta.settlement = { billId, mode: newMode, blocked: false };

  await exec(
    `UPDATE journal_proposals SET lines=@lines, match_meta=@matchMeta, updated_at=@now WHERE company_id=@companyId AND proposal_id=@proposalId AND status='proposed'`,
    { lines: JSON.stringify(enrichedLines), matchMeta: JSON.stringify(matchMeta), now: new Date().toISOString(), companyId, proposalId }
  );

  return { proposalId, billId, mode: newMode };
}

function matchOpenItem(openBills, amount, description, homeCurrency, lineDate, fxBandPct) {
  if (!Array.isArray(openBills) || openBills.length === 0) return null;
  const desc = (description || '').toUpperCase();
  const absAmount = Math.abs(amount);
  const isForeign = (b) => !!(b.currency && b.currency !== homeCurrency);

  // 1) Exact amount match (within 0.01) — prefer partner/ref corroboration.
  // Foreign bills never reach this (§4.4): amount_home is booked at the
  // invoice-date rate, settlement happens later at a different rate, so a
  // bit-exact match against a genuinely foreign bill essentially never
  // occurs — treating it as an exact-match candidate at all is misleading.
  for (const bill of openBills) {
    if (isForeign(bill)) continue;
    const outstanding = Number(bill.outstanding);
    if (Math.abs(outstanding - absAmount) < 0.01) {
      const partner = (bill.partner_name || '').toUpperCase();
      const ref = (bill.vendor_ref || '').toUpperCase();
      const corrType = corroborate(desc, partner, ref);
      return {
        bill,
        discrepancy_type: 'open_item_exact',
        delta: 0,
        confidence: corrType ? 1.0 : 0.95,
      };
    }
  }

  // 2) Tolerance matches — classify the discrepancy (§4.1). Home-currency
  // bills only — foreign bills are handled separately in step 2b (§4.4),
  // which needs a currency-consistent band, not this generic tolerance math.
  for (const bill of openBills) {
    if (isForeign(bill)) continue;
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
    } else if (absAmount < outstanding) {
      discrepancy_type = 'partial_payment';
      confidence = 0.50;
    }
    if (!discrepancy_type) continue;

    // Partner/ref corroboration promotes the match (same logic as exact path).
    const partner = (bill.partner_name || '').toUpperCase();
    const ref = (bill.vendor_ref || '').toUpperCase();
    const corrType = corroborate(desc, partner, ref);
    if (corrType) confidence = Math.min(1.0, confidence + 0.10);

    return { bill, discrepancy_type, delta, confidence };
  }

  // 2b) Foreign-currency bills — bounded band anchored on the bill's own
  // booking rate (bank-matching-spec §4.4), not the generic tolerance math
  // above and not matchLine's amount_home-based `outstanding` column (that
  // mixes a home-currency amount_home with a foreign-currency amount_paid
  // for any previously-partially-paid foreign bill — bank-match-bill-
  // settlement-spec.md §8). Corroboration GATES a candidate here rather
  // than just boosting confidence — the band is wide enough that amount
  // alone isn't sufficient evidence a same-amount coincidence is this bill.
  if (fxBandPct != null) {
    const candidates = [];
    for (const bill of openBills) {
      if (!isForeign(bill)) continue;
      const outstandingForeign = Number(bill.amount) - Number(bill.amount_paid);
      const rate = Number(bill.fx_rate);
      if (!(outstandingForeign > 0) || !(rate > 0)) continue;
      const expectedHome = outstandingForeign * rate;
      const expectedMax = expectedHome * (1 + fxBandPct);
      if (absAmount > expectedMax) continue; // outside the band even with the FX allowance
      const partner = (bill.partner_name || '').toUpperCase();
      const ref = (bill.vendor_ref || '').toUpperCase();
      const corrType = corroborate(desc, partner, ref);
      if (!corrType) continue; // gate: no corroboration → not a candidate at all
      // Below half the expected amount even with the FX allowance looks
      // more like a deliberate partial payment than rate drift.
      const discrepancy_type = absAmount >= expectedHome * 0.5 ? 'fx_rounding' : 'partial_payment';
      candidates.push({ bill, discrepancy_type, corrType, expectedHome });
    }
    if (candidates.length === 1) {
      const { bill, discrepancy_type, corrType, expectedHome } = candidates[0];
      let confidence = discrepancy_type === 'fx_rounding'
        ? (corrType === 'ref' ? 0.75 : 0.65)
        : (corrType === 'ref' ? 0.55 : 0.45);
      // Due-date proximity (§4.4) — a confidence modifier, not a gate: real
      // payments cluster near their due date; one far off either side is
      // weaker evidence even with amount + corroboration already in hand.
      if (lineDate && bill.due_date) {
        const days = Math.round((new Date(lineDate) - new Date(bill.due_date)) / 86400000);
        if (Math.abs(days) <= 7) confidence = Math.min(1.0, confidence + 0.05);
        else if (days > 60) confidence = Math.max(0, confidence - 0.10);
      }
      return { bill, discrepancy_type, delta: expectedHome - absAmount, confidence };
    }
    // 0 candidates (nothing both in-band and corroborated) or >1 (more than
    // one foreign bill both fits the band and corroborates — genuinely
    // ambiguous which one this is) — fall through to tier 4 rather than
    // guess. This is the same candidate-cardinality discipline §4.2 already
    // applies to N:M, just reachable here from a single bank line too.
  }

  // 3) 1:N — one transaction settles 2-8 open bills from the same partner
  // (bank-matching-spec §4.1). Brute-force with cap N ≤ 8. Home-currency
  // only — a foreign bill's `outstanding` here is the same currency-mixing
  // column step 2b avoids; summing it into a combo would inherit the bug.
  const byVendor = new Map();
  for (const bill of openBills) {
    if (isForeign(bill)) continue;
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
  // bank-matching-spec.md §4.4: fx_match_band_pct (Settings → Extensions,
  // same convention as vat_tolerance_pct — stored as a fraction, e.g. 0.15
  // for 15%). Falls back to 0.15 for companies that predate the setting.
  const fxBandRows = await query(
    `SELECT value FROM settings WHERE company_id = @companyId AND key = 'fx_match_band_pct'`,
    { companyId }
  );
  const fxBandParsed = fxBandRows.length ? parseFloat(fxBandRows[0].value) : NaN;
  const fxBandPct = isNaN(fxBandParsed) ? 0.15 : fxBandParsed;

  if (accountingMethod !== 'cash') {
    const openBills = await query(
      `SELECT bill_id, partner_name, vendor_ref, amount, amount_home, amount_paid,
              fx_rate, ap_account, currency, (amount_home - amount_paid) AS outstanding, due_date
       FROM bills
       WHERE company_id = @companyId AND status IN ('posted', 'partial')
       ORDER BY due_date`,
      { companyId }
    );
    const m = matchOpenItem(openBills, line.amount, line.description, homeCurrency, line.date, fxBandPct);
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

      // bank-match-bill-settlement-spec.md §2.1/§2.3: tag the AP-side line
      // with bill_id so approval can settle the bill. A foreign bill gets
      // the proper booking-rate/FX-gain-loss entry (buildFxSettlementLines)
      // rather than a naive 2-line entry at the raw bank amount. The
      // DEFAULT mode mirrors the matcher's own classification (full for
      // fx_rounding, partial for partial_payment, per user direction) — the
      // human can override via bank.match.toggleSettlement (~ in Inbox)
      // before approving; journal.approve refuses to post at all if the
      // settlement is `blocked` (missing FX rate/account), regardless of
      // which mode. Multi-bill (m.bills) still needs the §2.2 N-lines
      // restructuring and an inflow against a bill (isInflow — a
      // credit/refund, not a normal payment) isn't modeled by the
      // settlement machinery — both still post untagged, human-reviewed.
      const apLineIsDebit = debitAccount === apAccount;
      const isForeignBill = !!(bill.currency && bill.currency !== homeCurrency);
      const singleBillPayDown = !m.bills && !isInflow && apLineIsDebit;
      const isFxSettleable = singleBillPayDown && isForeignBill
        && (m.discrepancy_type === 'fx_rounding' || m.discrepancy_type === 'partial_payment');

      let apLine, bankLine, fxLine = null;
      let fxSettled = false;
      let settlementInfo = null;
      if (isFxSettleable) {
        const settlementMode = m.discrepancy_type === 'fx_rounding' ? 'full' : 'partial';
        const fx = await buildFxSettlementLines(companyId, bill, amount, settlementMode, homeCurrency);
        if (fx.blocked) {
          settlementInfo = { billId: bill.bill_id, mode: settlementMode, blocked: true, blockedReason: fx.blockedReason };
        } else {
          apLine = { ...fx.apLine, date: line.date, description: line.description, bill_id: bill.bill_id };
          if (fx.fxLine) fxLine = { ...fx.fxLine, date: line.date, description: line.description, bill_id: bill.bill_id };
          bankLine = { account_code: bankAccount, date: line.date, description: line.description, debit: 0, credit: fx.bankShare };
          fxSettled = true;
          settlementInfo = { billId: bill.bill_id, mode: settlementMode, blocked: false };
        }
      }
      if (!fxSettled) {
        apLine = { account_code: apAccount, date: line.date, description: line.description };
        if (apLineIsDebit) { apLine.debit = amount; apLine.credit = 0; }
        else { apLine.debit = 0; apLine.credit = amount; }
        if (singleBillPayDown && !isForeignBill) apLine.bill_id = bill.bill_id;
        bankLine = {
          account_code: bankAccount, date: line.date, description: line.description,
          debit: apLineIsDebit ? 0 : amount, credit: apLineIsDebit ? amount : 0,
        };
      }

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
        lines: fxLine
          ? [apLine, fxLine, bankLine]
          : (apLineIsDebit ? [apLine, bankLine] : [bankLine, apLine]),
        settlement: settlementInfo,
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
