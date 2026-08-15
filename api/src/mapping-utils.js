'use strict';
/**
 * bank-mapping-suggestions-spec — shared utilities.
 *
 * - normalizeDescription: §3.3 pattern normalization (strip dates, refs,
 *   amounts, collapse spaces → reusable merchant-level pattern).
 * - detectMappingConflicts: §4.3 conflict detection against active rules,
 *   pending suggestions, and historical transactions (§4.4 regression test).
 * - amountSignMatches: §5.3 helper used by matchMapping and conflict detection.
 */

const { query } = require('./db');

// ── §3.3 Pattern normalization ──────────────────────────────────────────────

/**
 * Normalize a bank-line description into a reusable merchant-level pattern.
 *
 * Steps (spec §3.3):
 * 1. Uppercase, trim.
 * 2. Strip ISO dates (YYYY-MM-DD, YYYYMMDD).
 * 3. Strip reference numbers (digit sequences ≥ 6 chars).
 * 4. Strip currency / amount fragments (e.g. "SEK 1,234.56", "1.234,56").
 * 5. Strip trailing country codes (2 uppercase letters at end after comma/space).
 * 6. Collapse multiple spaces.
 *
 * The same normalization is used in:
 *   - matching_history.record (§1)
 *   - tier 3.5 historical lookup (§2)
 *   - crystallization trigger (§3.1)
 *   - retrospective sweep (§3.2)
 *   - matchMapping at match time (via the stored pattern)
 */
function normalizeDescription(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.toUpperCase().trim();

  // Strip ISO dates: YYYY-MM-DD, YYYYMMDD, YYYY/MM/DD
  s = s.replace(/\b\d{4}[-/]?\d{2}[-/]?\d{2}\b/g, '');

  // Strip long digit sequences (≥ 6 chars) — reference / transaction numbers
  s = s.replace(/\b\d{6,}\b/g, '');

  // Strip currency amounts: "SEK 1,234.56", "1.234,56 SEK", "1,234.56"
  s = s.replace(/\b(USD|EUR|SEK|GBP|NOK|DKK|CHF|JPY|CAD|AUD)?\s?\d{1,3}([.,]\d{3})*([.,]\d{2})?\s?(USD|EUR|SEK|GBP|NOK|DKK|CHF|JPY|CAD|AUD)?\b/g, (match) => {
    // Only strip if it contains a currency code or has thousands/decimal separators
    if (/(USD|EUR|SEK|GBP|NOK|DKK|CHF|JPY|CAD|AUD)/.test(match) || /[.,]\d/.test(match)) {
      return '';
    }
    return match; // keep short standalone numbers (could be meaningful)
  });

  // Strip trailing country code: ", AMSTERDAM NL" → "AMSTERDAM" handled by step below
  // Strip ", XX" at end where XX is 2 uppercase letters
  s = s.replace(/,\s*[A-Z]{2}\s*$/g, '');

  // Collapse multiple spaces
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

// ── §5.3 amount_sign helper ─────────────────────────────────────────────────

/**
 * Check if a mapping's amount_sign is compatible with a transaction amount.
 * - 'positive' → only matches when amount > 0 (inflow)
 * - 'negative' → only matches when amount < 0 (outflow)
 * - 'any' / null / undefined → matches regardless (backward-compatible)
 */
function amountSignMatches(amountSign, amount) {
  const sign = amountSign || 'any';
  if (sign === 'any') return true;
  const amt = Number(amount);
  if (sign === 'positive') return amt > 0;
  if (sign === 'negative') return amt < 0;
  return true; // unknown sign value → permissive (backward-compatible)
}

// ── §4.3 Conflict detection ─────────────────────────────────────────────────

/**
 * Detect conflicts for a proposed mapping rule.
 *
 * Checks against:
 * 1. Active rules in bank_mappings (WHERE is_active = true)
 * 2. Pending suggestions in mapping_suggestions (WHERE status = 'proposed',
 *    excluding excludeSuggestionId)
 * 3. Historical transactions (§4.4 regression test against journal_proposals)
 *
 * @param {string} companyId
 * @param {string} pattern     — the normalized description pattern
 * @param {string} matchType   — 'contains' | 'exact' | 'starts_with' | 'regex'
 * @param {string} account     — the target account code
 * @param {string} amountSign  — 'positive' | 'negative' | 'any'
 * @param {string|null} excludeSuggestionId — exclude this suggestion from the
 *        pending-suggestions check (used when called from approve)
 * @returns {Promise<object>} { exactDuplicates, contradictions, overlaps,
 *          historicalConflicts, hasHardBlock, hasWarning }
 */
async function detectMappingConflicts(companyId, pattern, matchType, account, amountSign, excludeSuggestionId) {
  const sign = amountSign || 'any';
  const exactDuplicates = [];
  const contradictions = [];
  const overlaps = [];
  const historicalConflicts = [];

  // ── Check active rules ────────────────────────────────────────────────────
  const activeRules = await query(
    `SELECT mapping_id, pattern, match_type, debit_account, credit_account, amount_sign, priority
     FROM bank_mappings
     WHERE company_id = @companyId AND is_active = true`,
    { companyId }
  );

  for (const rule of activeRules) {
    const conflict = analyzeConflict(pattern, matchType, account, sign, rule.pattern, rule.match_type,
      rule.debit_account, rule.amount_sign || 'any');
    if (!conflict) continue;
    conflict.source = 'bank_mapping';
    conflict.id = rule.mapping_id;

    if (conflict.type === 'duplicate') exactDuplicates.push(conflict);
    else if (conflict.type === 'contradiction') contradictions.push(conflict);
    else if (conflict.type === 'overlap') overlaps.push(conflict);
  }

  // ── Check pending suggestions ─────────────────────────────────────────────
  let suggestionQuery = `SELECT suggestion_id, description_pattern, suggested_account,
                                suggested_amount_sign, suggested_match_type, status
                         FROM mapping_suggestions
                         WHERE company_id = @companyId AND status = 'proposed'`;
  const params = { companyId };
  if (excludeSuggestionId) {
    suggestionQuery += ` AND suggestion_id != @excludeId`;
    params.excludeId = excludeSuggestionId;
  }
  const pendingSuggestions = await query(suggestionQuery, params);

  for (const sug of pendingSuggestions) {
    const conflict = analyzeConflict(pattern, matchType, account, sign,
      sug.description_pattern, sug.suggested_match_type || 'contains',
      sug.suggested_account, sug.suggested_amount_sign || 'any');
    if (!conflict) continue;
    conflict.source = 'mapping_suggestion';
    conflict.id = sug.suggestion_id;

    if (conflict.type === 'duplicate') exactDuplicates.push(conflict);
    else if (conflict.type === 'contradiction') contradictions.push(conflict);
    else if (conflict.type === 'overlap') overlaps.push(conflict);
  }

  // ── §4.4 Historical regression test ──────────────────────────────────────
  // Run the proposed pattern matcher against journal_proposals for the company
  // to find transactions it would have matched that were posted to a different
  // account.
  const proposals = await query(
    `SELECT proposal_id, description, lines, status, date
     FROM journal_proposals
     WHERE company_id = @companyId AND status IN ('posted', 'rejected')`,
    { companyId }
  );

  for (const prop of proposals) {
    if (!prop.description) continue;
    const desc = prop.description.toUpperCase();
    if (!patternMatchesDescription(pattern, matchType, desc)) continue;

    // Parse the posted lines to find the account
    let postedAccount = null;
    try {
      const lines = JSON.parse(prop.lines);
      // Find the non-bank account (the offset account, not the bank account)
      // For a standard 2-line entry, pick the line with the smaller debit or
      // the credit side. Simpler: collect all unique account_codes except the
      // bank account.
      const accounts = [...new Set(lines.map((l) => l.account_code).filter(Boolean))];
      postedAccount = accounts.find((a) => a !== account) || accounts[0] || null;
    } catch { /* unparseable lines — skip */ }

    if (postedAccount && postedAccount !== account) {
      historicalConflicts.push({
        proposal_id: prop.proposal_id,
        description: prop.description,
        posted_account: postedAccount,
        date: prop.date,
        status: prop.status,
      });
    }
  }

  const hasHardBlock = contradictions.length > 0;
  const hasWarning = overlaps.length > 0 || historicalConflicts.length > 0 || exactDuplicates.length > 0;

  return { exactDuplicates, contradictions, overlaps, historicalConflicts, hasHardBlock, hasWarning };
}

/**
 * Analyze whether two mapping rules conflict.
 * Returns null if no conflict, or an object describing the conflict type.
 *
 * Conflict types (§4.1):
 * - duplicate: same pattern (case-insensitive), same account, same amount_sign → harmless redundancy
 * - contradiction: same pattern, different account → hard block
 * - overlap: one pattern is a substring of the other → warning (shadowing risk)
 *
 * Amount sign logic (§5.5):
 * - Same pattern + different amount_sign (neither is 'any') → NOT a conflict
 * - Same pattern + one 'any', other directional → overlap (broader vs narrower)
 */
function analyzeConflict(pattern1, matchType1, account1, sign1, pattern2, matchType2, account2, sign2) {
  const p1 = (pattern1 || '').toUpperCase();
  const p2 = (pattern2 || '').toUpperCase();
  const a1 = (account1 || '').toUpperCase();
  const a2 = (account2 || '').toUpperCase();

  // Same pattern?
  if (p1 === p2) {
    // Different amount_sign (neither 'any') → not a conflict, different directions
    if (sign1 !== 'any' && sign2 !== 'any' && sign1 !== sign2) {
      return null;
    }

    // Same account → duplicate (or same-sign subset)
    if (a1 === a2) {
      // If one is 'any' and the other is directional, it's an overlap (broader/narrower)
      if ((sign1 === 'any') !== (sign2 === 'any')) {
        return { type: 'overlap', direction: sign1 === 'any' ? 'broader' : 'narrower',
          pattern: p1, account: a1 };
      }
      return { type: 'duplicate', pattern: p1, account: a1 };
    }

    // Different account → contradiction
    return { type: 'contradiction', pattern: p1, account: a2 };
  }

  // Overlapping patterns (one is a substring of the other)?
  // Only check for 'contains' match type — exact/starts_with/regex don't shadow
  // the same way.
  if (matchType1 === 'contains' && matchType2 === 'contains') {
    if (p1.includes(p2) || p2.includes(p1)) {
      const direction = p1.length > p2.length ? 'narrower' : 'broader';
      return { type: 'overlap', direction,
        pattern: p1.length > p2.length ? p2 : p1, // the broader (shorter) pattern
        account: a2 };
    }
  }

  return null;
}

/**
 * Test whether a pattern matches a description (uppercase).
 * Used by the historical regression test (§4.4).
 */
function patternMatchesDescription(pattern, matchType, descUpper) {
  if (!pattern || !descUpper) return false;
  const pat = pattern.toUpperCase();
  switch (matchType) {
    case 'exact':        return descUpper === pat;
    case 'starts_with':  return descUpper.startsWith(pat.replace(/\*$/, ''));
    case 'contains':     return descUpper.includes(pat.replace(/\*/g, ''));
    case 'regex':
      try { return new RegExp(pattern, 'i').test(descUpper); } catch { return false; }
    default:             return descUpper.includes(pat.replace(/\*/g, ''));
  }
}

// ── Trigram similarity (issue #130) ──────────────────────────────────────────

/**
 * Normalize a string for trigram comparison: lowercase, trim, collapse spaces.
 */
function _normalizeForTrigram(s) {
  if (!s || typeof s !== 'string') return '';
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Build the set of overlapping character-level trigrams for a normalized string.
 * For strings shorter than 3 chars, returns a single-element set containing the
 * whole string (used by the short-string edge case in trigramSimilarity).
 */
function _trigramSet(s) {
  const set = new Set();
  if (s.length < 3) {
    set.add(s);
    return set;
  }
  for (let i = 0; i <= s.length - 3; i++) {
    set.add(s.slice(i, i + 3));
  }
  return set;
}

/**
 * Trigram (Jaccard) similarity between two strings, range 0–1.
 *
 * Normalizes both inputs (lowercase, trim, collapse spaces), then computes
 * Jaccard similarity = |intersection| / |union| over the character-level
 * overlapping-trigram sets.
 *
 * Edge case: when either normalized string is shorter than 3 chars, exact match
 * semantics are used (1.0 if equal, 0 otherwise) — trigrams over <3 chars are
 * degenerate and not meaningful.
 *
 * Used by partner proposal duplicate detection (issue #130).
 */
function trigramSimilarity(a, b) {
  const na = _normalizeForTrigram(a);
  const nb = _normalizeForTrigram(b);
  if (na.length < 3 || nb.length < 3) {
    return na === nb ? 1.0 : 0.0;
  }
  const sa = _trigramSet(na);
  const sb = _trigramSet(nb);
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  const union = sa.size + sb.size - inter;
  if (union === 0) return 1.0; // both empty
  return inter / union;
}

/**
 * Find the best fuzzy match for `name` among an array of candidate objects.
 *
 * @param {string} name            — the name to match
 * @param {Array<{name: string, ...}>} candidates — candidate objects (uses the
 *        `name` field of each)
 * @param {number} [threshold=0.65] — minimum trigramSimilarity to consider a
 *        candidate a match
 * @returns {{candidate: object, similarity: number}|null} best match above
 *          threshold, or null
 */
function findFuzzyMatch(name, candidates, threshold = 0.65) {
  if (!name || !Array.isArray(candidates) || candidates.length === 0) return null;
  let best = null;
  let bestScore = threshold;
  for (const c of candidates) {
    if (!c || !c.name) continue;
    const score = trigramSimilarity(name, c.name);
    if (score > bestScore) {
      bestScore = score;
      best = { candidate: c, similarity: score };
    }
  }
  return best;
}

module.exports = {
  normalizeDescription,
  amountSignMatches,
  detectMappingConflicts,
  analyzeConflict,
  patternMatchesDescription,
  trigramSimilarity,
  findFuzzyMatch,
};
