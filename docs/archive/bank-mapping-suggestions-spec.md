# Bank Mapping Suggestions — Wiring & Conflict Detection

**Status:** Implemented (2026-08-06). All six sections wired — §1 (matching_history.record), §2 (tier 3.5), §3 (crystallization + retrospective sweep), §4 (conflict detection), §5 (amount_sign), §6 (specificity scoring). Contract tests: 15/15 passing.
**Amends:** bank-matching-spec §10 (learning store), §10.4 (crystallization), §10.5 (retirement).
**Depends on:** bank-matching-spec (cascade tiers 1–4, §8.2), agent-readiness-spec (R2, AGENT_ALLOWED, §10 inbox taxonomy), B9 self-contained agent (agent-loop.js, in-process pipeline).

---

## 0. Context and scope

This spec addresses three gaps discovered in the B9 agent-loop implementation:

1. **No historical-transaction tier.** The cascade runs tiers 1 (learned rules), 2 (open items), 3 (master data), then jumps to tier 4 (LLM). There is no tier that checks "how was this same description posted last time?" The `matching_history` table and `matching_history.query` action exist but are unused — `matching_history.record` is in `AGENT_ALLOWED` but never called by anyone, so the table is always empty.

2. **Crystallization not wired.** The spec (§10.4) calls for the agent to call `mapping.suggest` when a tier-4 proposal is approved unedited, but the agent loop never calls it. The `mapping.suggest` action and `mapping_suggestions` table exist, the inbox can surface suggestions (`status='suggestions'`), and `mapping.suggestion.approve`/`.reject` are built — but nothing populates the suggestions table.

3. **No conflict detection.** `mapping.suggestion.approve` writes to `bank_mappings` without checking for conflicts against existing rules or other pending suggestions. Two overlapping patterns can coexist silently, producing first-match-wins ambiguity at match time.

**What this spec covers:**
- Wiring `matching_history.record` into `journal.approve`/`journal.reject` (§1).
- A historical-transaction lookup tier between tier 3 and tier 4 (§2).
- Two triggers for `mapping.suggest`: on-approval crystallization and retrospective sweep (§3).
- Conflict detection against active rules AND pending suggestions, with historical regression testing (§4).
- Amount conditions on mapping rules — `amount_sign` (§5).
- Specificity scoring in `matchMapping` — longest-match-wins (§6).

**What this spec does NOT cover:**
- Bank feed ingestion (assumes lines are already extracted).
- The CSV import wizard removal timeline.
- Receivables matching (module unbuilt).

### 0.1 Scale assumptions

Same as bank-matching-spec §0.1 — small AB, tens of lines per month. The retrospective sweep scans `journal_proposals` (hundreds to low thousands of rows for a small company), which is a trivial in-memory operation. No indexing or optimization needed at this volume.

---

## 1. Wiring `matching_history.record`

### 1.1 The gap

`matching_history.record` is in `AGENT_ALLOWED` and fully implemented (index.js §778), but nothing calls it. The `matching_history` table is always empty. The agent loop's `buildTier4Context` queries it (last 50 records) and passes results to the LLM prompt — but always gets an empty array.

### 1.2 The fix: record outcomes inside `journal.approve` / `journal.reject`

When a human approves or rejects a journal proposal, record the outcome in `matching_history` as a side effect of the same transaction. This follows the same pattern as the spec's retirement-on-reject (§10.5): a learning-store write attributed to the human who acted, not a separate agent action.

**In `approveProposal` (journal.js), after the atomic claim succeeds and before returning:**

Extract from the proposal:
- `description_pattern` — the bank line description (stored on the proposal's `description` field, or from `_match_meta` if carried)
- `source_type` — from `_match_meta.source_type` (learned_rule, open_item, master_data, llm_semantic)
- `proposed_dimensions` — the account/vat/counterparty the agent proposed (from the stored `lines` JSON)
- `approved_dimensions` — what the human actually approved (same as proposed if unedited; differs if edited)
- `outcome` — `approved_unedited` if no edits, `approved_edited` if lines changed
- `confidence` — from `_match_meta.confidence`
- `evidence` — from `_match_meta.evidence`
- `amount` — from the proposal's lines (sum of debit or credit)
- `bank_account` — from `_match_meta` or the proposal's journal_id context

Call `matching_history.record` with these fields. This is a dispatchAction call to the existing handler — no new code in the journal module beyond the assembly and dispatch.

**In `rejectProposal` (journal.js), after the atomic claim succeeds:**

Same extraction, with `outcome = 'rejected'` and `approved_dimensions = null`.

### 1.3 Why inside the journal handler, not the agent loop

The journal handler sees the outcome immediately — the human just acted. The agent loop would discover it on the next poll tick via `event.list`, introducing latency and requiring the agent to re-read the proposal to extract `_match_meta`. Recording inside the handler keeps the data immediate and avoids a round-trip.

This is a learning-store write, not a ledger mutation — same category distinction R2 already draws for `journal.propose` and `attachment.upload`. It does not violate the single-gateway rule.

### 1.4 What this enables

With `matching_history` populated:
- §2 (historical-transaction tier) has data to query.
- The tier-4 LLM context (`buildTier4Context`) receives real matching history instead of an empty array — the LLM can see "this pattern was approved to account X last month" and propose the same.
- Calibration (§6.2) has outcomes to count.
- The retrospective sweep (§3.2) has data to scan for recurrence patterns.

---

## 2. Historical-transaction tier (tier 3.5)

### 2.1 The gap

When tiers 1–3 fail to match a bank line, the line becomes "residual" and is sent to the LLM (tier 4). But if the same description pattern was approved last month — same merchant, same account — the LLM is called unnecessarily. There is no tier that checks "has this exact description been seen and approved before, and to which account?"

This is the most common source of wasted LLM calls: recurring transactions that don't have a formal mapping rule and don't match a vendor name, but have been approved identically in prior statements.

### 2.2 The tier

Insert a new tier between tier 3 (master data) and tier 4 (LLM) in `matchLine` (bank.js), before the `no_match` return:

**Tier 3.5 — Historical outcome match.**

1. Normalize the bank line description (uppercase, trimmed — same normalization `matchMapping` uses).
2. Query `matching_history` for rows matching:
   - `company_id`
   - `description_pattern = <normalized description>` (exact match on the stored pattern)
   - `outcome = 'approved_unedited'` (only learn from clean approvals)
3. If matches exist:
   - Determine the modal account — the account most frequently approved across the matching history rows.
   - Return a match with:
     - `tier: 3.5`
     - `source_type: 'historical_match'`
     - `confidence`: derived from approval count and recency (e.g., 0.80 for 1 prior approval, 0.90 for 3+, capped — not 0.95 like tier 1, since this is inferred, not rule-based)
     - `evidence`: citing the prior approved proposal(s) — "Previously approved to account X on [dates]"
     - `lines`: the standard two-line journal entry (bank account + modal offset account)
4. If no matches, fall through to tier 4 (LLM).

### 2.3 Confidence calibration

Historical match confidence is lower than tier 1 (0.95) because it's inferred from past behavior, not an explicit rule. Proposed defaults:

| Prior approvals | Confidence |
|---|---|
| 1 | 0.75 |
| 2 | 0.82 |
| 3+ | 0.88 |

These are deliberately below the tier-1 threshold so that a historical match still appears in the inbox for human review, but with a "previously approved" evidence note that makes approval fast. The confidence does not auto-post.

### 2.4 Why exact match, not fuzzy

Tier 3.5 uses exact `description_pattern` match, not trigram similarity. Rationale:
- The `description_pattern` stored in `matching_history` is the raw bank line description — it's already the exact text the bank sent.
- Two statements from the same bank for the same merchant produce identical descriptions (same format, same field positions).
- Fuzzy matching at this tier introduces false positives — a description that's *similar* but not *the same* may map to a different account.
- Lexical closeness is already handled at tier 3 (trigram on vendor names). Tier 3.5 is for exact recurrence, not similarity.

### 2.5 Interaction with the LLM context

`buildTier4Context` already queries `matching_history` (last 50 records) and passes it to the LLM. With §1 wired, this context is now populated. The LLM sees prior approvals for similar patterns and can propose consistent accounts. This is a complementary benefit — even when a line reaches tier 4 (no exact historical match), the LLM has context to reason from.

---

## 3. Two triggers for `mapping.suggest`

### 3.1 Trigger A — Crystallization on approval

**When:** A human approves a tier-4 proposal unedited (no changes to the proposed lines).

**Where:** Inside `approveProposal` (journal.js), after the atomic claim succeeds, as a side effect.

**Logic:**
1. Check the proposal's `_match_meta.tier === 4` and `_match_meta.source_type === 'llm_semantic'`.
2. Check whether the approval was unedited (proposed lines == approved lines).
3. Normalize the bank line description to extract a reusable pattern (see §3.3).
4. Check whether an active rule already exists in `bank_mappings` for this pattern. If yes — skip. The rule exists; nothing to suggest.
5. Check whether a pending suggestion already exists in `mapping_suggestions` for this pattern. If yes — skip. Don't create duplicates.
6. Run the conflict check (§4) against active rules and pending suggestions.
7. Call `mapping.suggest` with:
   - `description_pattern` — the normalized pattern
   - `suggested_account` — the approved account
   - `suggested_vat_code` — if present in the approved lines
   - `evidence` — citing the approved proposal ID, the tier-4 source, and the conflict-check results
   - `source_proposal_id` — the proposal that triggered it

**Why inside the journal handler:** The human just acted; the suggestion is a consequence of that action, not a separate decision. Same pattern as retirement-on-reject (§10.5). The suggestion surfaces in the inbox as a Class B item; the human decides later.

### 3.2 Trigger B — Retrospective sweep

**When:** The agent loop, on a throttled cycle (at most once per day per company, tracked via `last_sweep_at` setting).

**Where:** A new function `retrospectiveSweep(companyId, agentEmail, companySettings)` called from `pollCompanyOnce`, throttled by a timestamp check.

**Logic:**
1. Check `last_sweep_at` setting; skip if less than 24 hours ago.
2. Query `journal_proposals` for the company where `status = 'posted'` and source indicates bank import. Extract the bank line description from each.
3. Normalize and group by description pattern (see §3.3).
4. Filter to patterns that:
   - Appear ≥ N times (default threshold: 3 — tunable via setting)
   - Have no existing active rule in `bank_mappings` for this pattern
   - Have no pending suggestion in `mapping_suggestions` for this pattern
5. For each surviving pattern:
   - Determine the modal account — the account most frequently approved.
   - Check for inconsistency: if the same pattern was approved to different accounts across transactions, flag it. The pattern may be too broad (needs `amount_sign` disambiguation or a more specific pattern), or the human has been inconsistent. Still create the suggestion, but attach the inconsistency as evidence — the human sees "approved to 5030 three times, 5430 once" and can decide.
6. Run the conflict check (§4) against active rules and pending suggestions.
7. Call `mapping.suggest` for each qualifying pattern, with evidence citing the specific proposals ("Based on 5 approved transactions, 2026-01 through 2026-06").

**Why agent-only:** A journal-approval handler sees one proposal at a time. It cannot count recurrence across proposals, cannot detect "this pattern has appeared 7 times and never had a rule," and cannot group and rank. The retrospective sweep requires scanning full proposal history and recognizing aggregate patterns — that's an agent capability.

**Throttling:** The sweep scans `journal_proposals` (hundreds to low thousands of rows). At small-company volume this is sub-second, but it's still wasteful to run every 30 seconds. A daily throttle via `last_sweep_at` is sufficient — new suggestions appear within 24 hours of a pattern crossing the recurrence threshold.

### 3.3 Pattern normalization

The pattern stored in `mapping_suggestions` (and `bank_mappings` after approval) must be a reusable merchant-level pattern, not the raw bank line text. Raw bank descriptions include transaction-specific noise:

- `"NETFLIX.COM 1234567890 AMSTERDAM"` → pattern: `"NETFLIX"`
- `"STRIPE*STRIPE PAYMENT 2026-08-04"` → pattern: `"STRIPE"`
- `"AUTOGIRO KLARNA 20260804 999123"` → pattern: `"AUTOGIRO KLARNA"` or `"KLARNA"`

Normalization steps:
1. Uppercase, trim.
2. Strip dates (ISO format, `YYYY-MM-DD`, `YYYYMMDD`).
3. Strip reference numbers (long digit sequences ≥ 6 chars).
4. Strip currency and amount fragments.
5. Strip trailing location/country codes.
6. Collapse multiple spaces.

The exact normalization rules are a tuning concern, not a structural one. The key structural requirement: the same normalization is used consistently in `matching_history.record` (§1), the historical tier (§2), the crystallization trigger (§3.1), the retrospective sweep (§3.2), and `matchMapping` at match time. One normalization function, used everywhere.

---

## 4. Conflict detection

### 4.1 The gap

`mapping.suggestion.approve` (index.js §656–701) writes to `bank_mappings` with no conflict check. It inserts a row with `match_type: 'contains'`, `priority: 100`, `is_active: true` and returns. Three conflict classes are possible:

**Type 1 — Duplicate (same pattern, same account):** Harmless redundancy. A dead rule that fires on the same descriptions and produces the same result.

**Type 2 — Contradiction (same pattern, different account):** Two rules with the same pattern map to different accounts. `matchMapping` iterates `ORDER BY priority ASC` and returns whichever has the lower priority number — or, at equal priority, whichever was inserted first (DuckDB row order). The outcome is insertion-order-dependent: a silent, non-deterministic failure.

**Type 3 — Shadowing (overlapping patterns):** A broader pattern (e.g., `"PAYPAL"`) and a narrower pattern (e.g., `"PAYPAL * FEE"`) both match descriptions containing the narrower pattern. First-match-wins by priority makes the outcome dependent on priority tuning rather than specificity. The narrower rule may never fire.

### 4.2 The conflict surface

Conflict detection must check **two** tables, not one:

```
bank_mappings WHERE is_active = true           -- existing active rules
mapping_suggestions WHERE status = 'proposed'    -- pending suggestions not yet decided
```

Both sets are checked because two pending suggestions with overlapping patterns can coexist in the inbox simultaneously. If the check only reads `bank_mappings`, neither suggestion sees the other — approving both in sequence produces the exact contradiction or shadowing the mechanism exists to prevent.

### 4.3 Conflict detection function

A single function called from both `mapping.suggest` (creation) and `mapping.suggestion.approve` (approval):

```
detectMappingConflicts(companyId, pattern, match_type, account, amount_sign, excludeSuggestionId)
```

**Parameters:**
- `pattern`, `match_type`, `account`, `amount_sign` — the proposed rule's dimensions
- `excludeSuggestionId` — when called from approve, exclude the suggestion being approved from the pending-suggestions check (it would conflict with itself)

**Returns:**
```
{
  exactDuplicates: [        // same pattern, same account — harmless but redundant
    { source: 'bank_mapping'|'mapping_suggestion', pattern, account, id }
  ],
  contradictions: [         // same pattern, different account — hard block
    { source, pattern, account, id }
  ],
  overlaps: [               // one pattern is a substring of the other — warning
    { source, pattern, account, id, direction: 'broader'|'narrower' }
  ],
  historicalConflicts: [    // proposed rule matches historical transactions posted to a different account
    { proposal_id, description, posted_account, date }
  ]
}
```

### 4.4 Historical regression test

In addition to checking against existing rules and pending suggestions, run the proposed rule's pattern matcher against `journal_proposals` for the company — empirical conflict detection against ground truth.

**Logic:**
1. Query `journal_proposals` where `company_id = @cid` and `status IN ('posted', 'rejected')` and source indicates bank import.
2. Run `matchMapping` (the proposed pattern + match_type) against each proposal's stored description.
3. For each hit, compare the account the rule would assign (`suggested_account`) with the account the transaction was actually posted to (from the approved `lines` JSON).
4. Classify:
   - **No hits** — the rule matches no historical transactions. Either genuinely new, or the pattern is too narrow. Low risk.
   - **Hits, all same account** — consistent with all historical postings. No conflict. High confidence.
   - **Hits, some different account** — **conflict**. The rule would have matched transactions posted to a different account. This is the strongest possible signal that the pattern is too broad or the account is wrong.
   - **Hits on rejected proposals** — the rule matches transactions the human previously rejected. Surface the rejection reason.

**Why this catches what pattern analysis can't:**

A rule for pattern `"BANKGIRO"` → account 7300. Static pattern analysis flags this as overlapping with any existing `"BANKGIRO"` rule — but it might be a genuinely new rule with no existing conflict. Run it against history: `"BANKGIRO"` appears in 30 transactions across 8 vendors — it's a payment method, not a merchant. The rule would match all 30, posted to 12 different accounts. Clear "do not approve" signal that pattern analysis alone would miss.

Conversely, `"NETFLIX"` → 5030 run against 5 historical transactions, all posted to 5030 — high confidence, approve with no friction.

**Cost:** A scan of `journal_proposals` for the company, running a JavaScript pattern match in memory. For a small AB: hundreds to low thousands of rows — sub-second. No indexing needed.

### 4.5 When checks run

| Check point | What it checks | Action on conflict |
|---|---|---|
| **Suggestion creation** (`mapping.suggest`) | Active rules + pending suggestions + historical regression | **Exact contradiction with active rule:** don't create; log warning that the existing rule may be wrong. **Exact contradiction with pending suggestion:** don't create; log that a suggestion for this pattern already exists. **Overlap:** create, but attach `conflict_warning` with details. **Historical conflicts:** attach to evidence. |
| **Suggestion approval** (`mapping.suggestion.approve`) | Active rules + *other* pending suggestions (excluding self) + historical regression (re-run, in case history changed) | **Exact contradiction with active rule:** block with `CONFLICT` — "A rule for this pattern already exists mapping to account X. Edit the existing rule instead." **Overlap with active rule or pending suggestion:** warn but allow — the human decides, but the risk is visible. **Historical conflicts:** warn but allow. |

### 4.6 Cross-suggestion staleness

When suggestion A is approved and written to `bank_mappings`, any *other* pending suggestion that overlapped with A should be re-evaluated — its conflict evidence was generated when A was pending, but A is now an active rule.

**Resolution: lazy re-check at approval time (Option 1).** When approving suggestion B, the check scans both `bank_mappings` and `mapping_suggestions WHERE status='proposed' AND suggestion_id != B`. This naturally picks up A whether A is still pending or has been promoted to `bank_mappings`. Simple, no background work.

The only downside: the inbox display for suggestion B may show stale conflict information (reflecting A-as-pending when A is now a rule). If display accuracy matters, the suggestion's `evidence` field can be refreshed at inbox read time (read-time re-evaluation) rather than on every approval event. This is a UI concern, not a data-integrity concern — the approval gate catches the real conflict regardless.

---

## 5. Amount conditions on mapping rules

### 5.1 The gap

The `bank_mappings` schema has no amount field:

```sql
CREATE TABLE bank_mappings (
  company_id, mapping_id, pattern, match_type,
  debit_account, credit_account, description_override,
  vat_code, cost_center, profit_center, priority, is_active
)
```

`matchMapping` (bank.js §174–189) tests `description` against `pattern` only — it never looks at `amount`. Direction (inflow vs. outflow) is inferred from the sign of the bank line amount *after* the match succeeds, in `matchLine` (§415–424):

```javascript
const isInflow = Number(line.amount) > 0;
const hasExplicitCredit = mapping.credit_account
  && mapping.credit_account !== mapping.debit_account;
const debitAccount  = hasExplicitCredit
  ? mapping.debit_account
  : (isInflow ? bankAccount : offsetAccount);
```

One rule handles both directions: if `debit_account == credit_account` (single-account rule), the offset is always that account, and the bank account is the other side.

**The problem:** The same description text can appear on both inflows and outflows for genuinely different economic events. Stripe customer payments (inflow, revenue) and Stripe fees (outflow, bank charges) share the description text `"STRIPE"`. The current schema **cannot express** `"STRIPE AND amount > 0 → 7300, STRIPE AND amount < 0 → 5430"`. Two rules with the same pattern and different accounts would be a Type 2 contradiction (§4.1), but it's not a real conflict — it's two legitimate rules disambiguated by direction.

### 5.2 The fix: `amount_sign`

Add an optional `amount_sign` column to `bank_mappings`:

```sql
ALTER TABLE bank_mappings ADD COLUMN amount_sign VARCHAR DEFAULT 'any';
-- values: 'positive' | 'negative' | 'any'
```

And to `mapping_suggestions`:

```sql
ALTER TABLE mapping_suggestions ADD COLUMN suggested_amount_sign VARCHAR DEFAULT 'any';
```

### 5.3 Matching logic

In `matchMapping` (bank.js), after the pattern matches, check `amount_sign`:

- If `amount_sign = 'any'` (or null) — match regardless of amount direction (current behavior, backward-compatible).
- If `amount_sign = 'positive'` — only match when `Number(line.amount) > 0`.
- If `amount_sign = 'negative'` — only match when `Number(line.amount) < 0`.

If the pattern matches but the sign doesn't, the rule does not match — continue to the next rule. This means two rules with the same pattern but different `amount_sign` values are **not in conflict** — they're disambiguated by direction. The conflict checker (§4) must treat same-pattern rules with different `amount_sign` as non-conflicting.

### 5.4 Why `amount_sign`, not `min_amount` / `max_amount`

`amount_sign` covers 95% of real disambiguation cases with minimal schema change. The inflow/outflow split is the dominant pattern: the same merchant appears on both sides of the bank statement for different reasons.

Threshold-based splits (e.g., "purchases < 500 SEK → small office supplies 5430, ≥ 500 SEK → equipment 5420") are rarer and harder to get right — the threshold is arbitrary and changes with inflation. If this need arises, `min_amount` and `max_amount` can be added later without breaking `amount_sign`. But for v1, `amount_sign` is the right scope.

### 5.5 Impact on the conflict checker

`detectMappingConflicts` (§4.3) receives `amount_sign` as a parameter. Two rules with the same pattern:
- Same `amount_sign` → potential conflict (contradiction if different account, duplicate if same).
- Different `amount_sign` (and neither is `'any'`) → **not a conflict**. They cover different transaction directions.
- One is `'any'` and the other is `'positive'` or `'negative'` → **overlap warning**, not a block. The `'any'` rule is broader; the directional rule is narrower. Specificity scoring (§6) handles this at match time.

---

## 6. Specificity scoring in `matchMapping`

### 6.1 The gap

`matchMapping` (bank.js §174–189) is a first-match-wins loop ordered by `priority ASC`:

```javascript
function matchMapping(mappings, description) {
  const desc = description.toUpperCase();
  for (const m of mappings) {               // ordered by priority ASC
    const pattern = m.pattern.toUpperCase();
    switch (m.match_type) {
      case 'contains': if (desc.includes(pattern.replace(/\*/g, ''))) return m; break;
      // ...
    }
  }
  return null;
}
```

There is no specificity scoring. A `contains` match on `"PAYPAL"` (6 chars) and a `contains` match on `"PAYPAL * FEE"` (13 chars) are treated as equal — whichever comes first in the priority-ordered list wins. If both are priority 100, insertion order decides. This makes the outcome dependent on an implementation detail, not on rule semantics.

### 6.2 The fix: longest-match-wins

Change `matchMapping` from "return first match" to "collect all matches, return the longest pattern match":

```javascript
function matchMapping(mappings, description) {
  const desc = description.toUpperCase();
  const matches = [];
  for (const m of mappings) {
    const pattern = m.pattern.toUpperCase();
    let matched = false;
    switch (m.match_type) {
      case 'exact':      matched = (desc === pattern); break;
      case 'starts_with': matched = desc.startsWith(pattern.replace(/\*$/, '')); break;
      case 'contains':   matched = desc.includes(pattern.replace(/\*/g, '')); break;
      case 'regex':       try { matched = new RegExp(m.pattern, 'i').test(description); } catch {}; break;
    }
    if (matched) matches.push(m);
  }
  if (matches.length === 0) return null;
  // Sort by pattern length descending (most specific first),
  // then by priority ASC (lower number = higher priority as tiebreaker).
  matches.sort((a, b) => {
    const lenDiff = b.pattern.length - a.pattern.length;
    if (lenDiff !== 0) return lenDiff;
    return (a.priority || 100) - (b.priority || 100);
  });
  // Apply amount_sign filter on the top candidate (§5.3).
  return matches[0];
}
```

### 6.3 Why this is better than priority tuning

- **Self-organizing:** The user doesn't need to manage priority numbers to prevent shadowing. A more specific pattern naturally takes precedence.
- **Predictable:** The outcome depends on pattern content, not insertion order. Two rules with the same pattern length fall back to priority — but only as a tiebreaker, not the primary sort.
- **Industry-standard:** QBO and Xero both use longest-match-wins for bank rules. Users familiar with those products expect this behavior.

### 6.4 Interaction with `amount_sign`

When multiple rules match the same description, specificity scoring selects the most specific pattern. But if that rule's `amount_sign` doesn't match the transaction's direction, the match should fail and fall through to the next candidate.

Updated logic: after sorting by specificity, iterate the sorted matches and return the first one whose `amount_sign` is compatible with the line's amount direction:

```javascript
matches.sort(/* specificity then priority */);
for (const m of matches) {
  if (amountSignMatches(m.amount_sign, line.amount)) return m;
}
return null;  // pattern matched but no amount_sign-compatible rule
```

This handles the case where a specific pattern has a directional rule that doesn't apply, but a broader pattern with `'any'` direction does.

---

## 7. Implementation summary

| Change | File(s) | Effort | Section |
|---|---|---|---|
| Wire `matching_history.record` into approve/reject | `journal.js` (`approveProposal`, `rejectProposal`) | Small | §1 |
| Historical-transaction tier 3.5 | `bank.js` (`matchLine`) | Medium | §2 |
| Crystallization on approval (trigger A) | `journal.js` (`approveProposal`) | Small | §3.1 |
| Retrospective sweep (trigger B) | `agent-loop.js` (new function in `pollCompanyOnce`) | Medium | §3.2 |
| Pattern normalization function | New utility (shared by all callers) | Small | §3.3 |
| Conflict detection function | New utility, called from `index.js` | Medium | §4.3 |
| Historical regression test | Inside conflict detection function | Medium | §4.4 |
| Wire conflict check into `mapping.suggest` | `index.js` (`mapping.suggest` handler) | Small | §4.5 |
| Wire conflict check into `mapping.suggestion.approve` | `index.js` (`mapping.suggestion.approve` handler) | Small | §4.5 |
| `amount_sign` column | `db/schema.sql`, migration | Small | §5 |
| `amount_sign` in matching logic | `bank.js` (`matchMapping`) | Small | §5.3 |
| Specificity scoring | `bank.js` (`matchMapping`) | Small | §6 |
| Inbox UI for mapping suggestions | `pages/inbox.js` — render `status='suggestions'` items | Small | (already built, needs UI) |

### 7.1 Dependencies

The changes have a natural order:

1. **§1** (record outcomes) — no dependencies. Enables §2 and §3.
2. **§5** (amount_sign schema) — no dependencies. Can ship independently.
3. **§6** (specificity scoring) — no dependencies. Can ship independently.
4. **§3.3** (normalization) — no dependencies, but must be finalized before §2, §3.
5. **§2** (historical tier) — depends on §1 (needs data in `matching_history`) and §3.3 (normalization).
6. **§4** (conflict detection) — depends on §5 (amount_sign for non-conflict logic) and §6 (specificity for overlap direction).
7. **§3** (suggestion triggers) — depends on §3.3 (normalization) and §4 (conflict check at creation).

### 7.2 What this achieves

After all changes are wired:

1. **First occurrence** of a new description → no rules, no history → tier 4 LLM → proposal in inbox → human approves → `matching_history.record` + `mapping.suggest` (if unedited tier-4).
2. **Second occurrence** (before human approves the mapping suggestion) → tier 3.5 historical match finds the prior approval → proposes the same account → no LLM call.
3. **After human approves the mapping suggestion** → tier 1 rule exists → matched immediately on all future occurrences → no LLM call, no inbox friction.
4. **Retrospective sweep** finds patterns that recurred across multiple proposals (even tier 2/3 matches) and proactively suggests rules — the agent notices what the human wouldn't.
5. **Conflict detection** prevents contradictory or shadowing rules from entering `bank_mappings` — both at suggestion creation and at approval — checked against active rules, pending suggestions, and historical transactions.
6. **Amount conditions** eliminate false contradictions for same-pattern inflow/outflow disambiguation.
7. **Specificity scoring** makes match outcomes deterministic regardless of insertion order.

The cascade becomes self-populating downward: expensive LLM reasoning at the top, cheap deterministic rules at the bottom, learning pushes everything toward tier 1 over time — with a human decision at the one point where the system's autonomous surface grows, and conflict detection ensuring that growth doesn't create ambiguity.

---

## 8. Open questions

1. **Normalization tuning.** The pattern normalization rules (§3.3) are structurally specified but the exact striping rules (which digit sequences are reference numbers vs. meaningful identifiers, which suffixes are noise) need tuning against real Swedish bank data. Should be tested against Magnus's actual bank statements from MDU AB.

2. **`amount_sign` on retrospective sweep.** When the retrospective sweep (§3.2) finds a pattern approved to different accounts, should it create two suggestions (one per direction, with `amount_sign` set) or one suggestion with an inconsistency warning? Two suggestions is cleaner if the directions are consistent within each group; one is simpler but pushes the disambiguation decision to the human.

3. **Historical regression scope.** Should the regression test (§4.4) scan all `journal_proposals` or only those from bank import? Manually entered proposals may not carry the same description patterns. Recommend: bank-import-only for v1, expand if needed.

4. **Inbox display refresh.** Should the mapping-suggestion inbox items re-evaluate conflicts at read time (§4.6)? This adds a query per inbox load but keeps conflict info fresh. Low priority for v1 — the approval gate is sufficient.
