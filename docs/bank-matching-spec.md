# Bank Statement Processing — Confidence/Evidence Cascade

**Status:** Draft (design ratified in discussion 2026-08-05, not yet implemented).
**Amended 2026-08-05 (rescoped for company size):** Calibration (§6), rule retirement (§10.5), N:M cardinality handling (§4.2), and tier-4 batching (§5) simplified. The original resolutions assumed transaction volume that supports statistical learning (Beta-Binomial shrinkage, cross-tenant priors, content-based clustering); the actual target is small companies with limited monthly transaction counts, where that volume never really arrives. See §0.1.
**Amended 2026-08-05 (mappings stay human-only — R2 resolution):** Rule crystallization (§10.4) no longer writes to `mappings` via an agent-attributed call — that would violate agent-readiness-spec R2 (agents may never mutate master data, `mappings` named explicitly). Decision: keep `mappings` human-only; the agent proposes, a human approves, via a new lightweight `mapping_suggestions` flow (§10.1, §10.2) that mirrors the existing journal-proposal pattern. Rule retirement (§10.5) is resolved differently — no new approval surface, since it can piggyback on human-attributed actions that already exist (§10.5).
**Depends on:** agent-readiness spec (R1, R7, R8, §4 single-gateway rule, §10 inbox taxonomy), payables-ux spec (settlement.js, bill_payments), keyboard-ux spec (K1–K5).
**Amended 2026-08-05 (bills routing — Option C ratified):** `bill.create` (agent, draft) added to the §8.2 action table and to `AGENT_ALLOWED` notes — the agent creates a bill draft, a human posts it via the inbox (`bill.post`), and the posted bill becomes an open payable that tier 2 (§4) matches against. The bill draft enters the inbox as a Class A item (`bill_draft`, agent-readiness-spec §10.2); see §10.4 for the inbox-type note. `bill.create` uses catalog role `agent` (1.5), not `data_entry` (2), for the same dispatch-ordering reason as `bank.match` and `journal.propose`. `bill.post` stays `data_entry` and is not agent-whitelisted — the human's approval is the post (agent-readiness-spec §4.1).

---

## 0. Context and scope

Bank statement processing today is a human-operated CSV wizard (`/bank?tab=import`) with user-maintained pattern→account mapping rules (`mapping.list`/`mapping.upsert`/`mapping.delete`). The wizard runs `bank.process` then `bank.approve` — both `data_entry` actions, explicitly outside the agent whitelist (agent-data-feeding-guide §4.5).

Under agent-first (agent-readiness spec §0), bank-feed transactions arrive as `journal.propose` calls — the journal is the single ledger gateway, and the freebooks-side artifact is always a journal proposal (§4.6). This spec defines the matching pipeline that produces those proposals: a four-tier confidence/evidence cascade where deterministic, cheap, auditable layers handle the majority of lines and the LLM handles only the residual novel cases.

**What this spec covers:**
- The four-tier cascade (§1).
- Per-dimension confidence with dependency edges (§2).
- Evidence taxonomy (§3).
- Tier 2 open-item matching — amount tolerance, cardinality, counterparty evidence split (§4).
- Tier 4 batching — one batch per statement, within-batch groupthink, output validation (§5).
- Calibration — realized accuracy per source_type × confidence band (§6).
- Review posture — no auto-posting, risk-scaled friction, batch-approve (§7).
- Architecture — server-side deterministic tiers, agent-side LLM tier (§8).
- Write-permission boundary on counterparty bank-account data (§9).
- Learning store — human-approved mapping suggestions, matching_history (§10).
- Input rejections — intake failure vs. semantic rejection, inbox integration (§11).

**What this spec does NOT cover:**
- Bank feed ingestion itself (P3 — the adapter that fetches transactions from a bank API or file). This spec assumes lines are already extracted into a normalized shape.
- The CSV import wizard's removal timeline (it stays until feeds land; this spec defines the target architecture).
- Receivables matching (module unbuilt; type reserved in the inbox taxonomy).

### 0.1 Scale assumptions — why this spec stays simple where it could be sophisticated

**Amended 2026-08-05.** The target deployment is a small AB — tens of bank-statement lines per month, most of which resolve at tiers 1–3 (cheap, deterministic, no LLM). The tier-4 residual — the only place learning or calibration applies — is realistically single digits to low tens of lines per month, per company. That volume does not support statistical machinery that needs dozens-to-hundreds of outcomes per rule or confidence band before it earns its complexity over a simple threshold.

Several mechanisms in earlier drafts of this spec were designed for a higher-volume, many-tenant assumption — a Beta-Binomial posterior with credible intervals, a cross-tenant prior to solve cold start, content-based clustering for tier-4 batching, and a bounded subset-sum heuristic for N:M open-item matching. At the volume this product actually serves, the difference between that machinery and a plain counter with a conservative fixed floor rarely matters in practice, and the machinery is real code to build, test, and explain to a reviewer who just wants to know "should I trust this."

**What's simplified as a result:** calibration (§6) — plain running counters with a fixed minimum-sample floor, not Bayesian shrinkage; rule retirement (§10.5) — the same plain counters, no cross-tenant prior; N:M cardinality (§4.2) — falls through to tier 4 as an ordinary residual rather than a dedicated detection layer; tier-4 batching (§5) — one call per statement rather than a content-based clustering algorithm.

**What's unaffected:** the four-tier cascade itself, per-dimension confidence with dependency edges (§2), the evidence taxonomy (§3), amount-tolerance discrepancy types and the counterparty evidence split (§4.1, §4.3), and the no-auto-post review posture (§7). None of those depend on volume to be correct — they're right-sized regardless of how many transactions a company processes.

If this product later serves a genuinely high-volume, multi-tenant platform — enough shared volume that a cross-tenant prior would carry real signal — the calibration and retirement logic can be revisited then. This spec deliberately does not build for that scenario ahead of it existing.

---

## 1. The four-tier cascade

Every bank statement line is processed through four tiers, cheapest and most certain first. A line stops descending at the first tier that produces a match above threshold.

| Tier | Source type | What it does | Cost | LLM? |
|------|------------|--------------|------|------|
| 1 | `learned_rule` | Exact match against agent-maintained mapping/learned rules (pattern → account, scoped to bank account) | Instant, zero-token | No |
| 2 | `open_item` | Match against open payables/receivables — amount + counterparty + date window, with tolerance and cardinality | Near-instant, zero-token | No |
| 3 | `master_data` | Fuzzy match against vendor/customer master data (name similarity, bank-account-number match) | Fast, zero-token | No |
| 4 | `llm_semantic` | LLM reasoning over description + context + chart of accounts + business profile, for genuinely novel cases | Slow, token-costed | Yes |

**Cascade rule:** a line that matches at tier 1 never reaches tier 2. A line that matches at tier 2 never reaches tier 3. Only lines that exhaust tiers 1–3 without a confident match fall through to tier 4. The majority of lines on a typical statement resolve at tiers 1–2.

**Per-line output:** each tier, when it produces a match, emits:

```
{
  source_type: 'learned_rule' | 'open_item' | 'master_data' | 'llm_semantic',
  confidence: {                                    // per-dimension, see §2
    account:   { value: '2440', confidence: 0.95, derived_from: [] },
    vat_code:  { value: 'U3',   confidence: 0.60, derived_from: ['account'] },
    counterparty: { value: 'vendor-42', confidence: 0.90, derived_from: [] },
    ...
  },
  evidence: [ ... ],                               // see §3
  suggested_dimensions: { account, vat_code, counterparty, cost_center, ... },
  lines: [                                          // one or more journal lines
    {
      account_code, debit, credit, date, description,
      vat_code?, currency?, counterparty?
    }
  ]
}
```

**Multi-line proposals.** `lines` is an array, not a single object. Most matches produce one line (the debit/credit pair is the journal entry's two sides, not two proposals). But two cases in §4 structurally require multiple lines:

- **FX settlement (`fx_rounding` discrepancy, §4.1):** the bank amount differs from the invoice amount due to FX rounding. The journal entry needs the main settlement lines (DR AP / CR bank at realized rate) **plus** a separate realized FX gain/loss line (DR/CR 7980/7990). The `lines` array carries all three lines; the evidence explains the FX split.
- **1:N batch-payment match (§4.2):** one bank transaction settles multiple invoices. The `lines` array carries one AP-debit line per invoice, all crediting the same bank account. The evidence explains the grouping.

The existing `settlement.js` core (payables-ux spec §4.6) already handles the FX split — the `lines` array maps to the same journal structure `bill.payment.record` produces. The cascade feeds into `settlement.js`, it does not reimplement FX booking.

A line that produces no match at any tier becomes an `input_rejection` (§11) if critical data is missing, or a low-confidence tier-4 proposal if the LLM attempted but couldn't reach threshold.

### 1.1 Idempotency — bank transaction ID dedup

Before the cascade runs, each statement line is checked against a bank-provided transaction ID (if the feed supplies one) or a content hash (date + amount + description + bank account) for dedup. If a `journal_proposals` row already exists for the same transaction ID / content hash, the line is skipped — no duplicate proposal is created. This guards against feed redelivery producing duplicate `journal.propose` calls.

The transaction ID (or content hash) is stored on the `journal_proposals` row as `source_transaction_id` — a new nullable column. The dedup check is a server-side precondition in `bank.match` (or the agent's pre-cascade step), not an after-the-fact cleanup. Full dedup mechanics (collision handling, retroactive merges) are deferred to the P3 feed adapter spec.

---

## 2. Per-dimension confidence with dependency edges

### 2.1 Why per-dimension

A flat single confidence number for the whole proposal hides the information a reviewer needs: the account is basically certain, the VAT code is a guess — go check that one field. Each dimension carries its own confidence.

### 2.2 Dependency graph

Dimensions are not independent. VAT treatment is often *derived from* the account/transaction type, not independently inferred. If the account-code guess is wrong, the VAT code guess is very likely wrong too. Storing per-dimension confidence as if each were an independent coin flip produces misleading proposals ("account: 0.95, VAT: 0.60" when the VAT confidence should collapse toward 0 if the account is corrected).

The dependency graph below is the **v1 default** — a fixed approximation. In reality, the graph varies by tenant: some charts of accounts have specific expense accounts coupled to specific cost centers by construction, making `cost_center` derived from `account` for those tenants. A hardcoded graph will under-invalidate for tenants where the coupling doesn't hold. V1 ships the fixed graph; a future version derives the dependency edges from the tenant's actual COA structure. Flagged as a known simplification, not a settled model.

| Dimension | Typically derived from | Independent? |
|-----------|----------------------|-------------|
| `account` | — | Yes (inferred from transaction signals) |
| `vat_code` | `account`, transaction type | No — collapses if account changes |
| `counterparty` | — | Yes (matched from statement data) |
| `cost_center` / `project` | — | Yes |
| `currency` | — | Yes (on the bank line, not inferred) |

### 2.3 Recompute on edit

When the human edits a dimension during inbox review, confidence on **dependent dimensions recomputes** — it is not frozen at proposal time. Editing the account code collapses the VAT code confidence toward 0 (the old VAT inference no longer applies). Editing the cost center does not touch VAT confidence (independent subtree).

The UI recomputes only the affected subtree, using the `derived_from` edges to determine which dimensions to invalidate. The original proposal's evidence is preserved as a snapshot; the recomputed confidence is displayed alongside the original for transparency.

---

## 3. Evidence taxonomy

Every proposal carries an `evidence[]` array — the basis for the match, inspectable by the human reviewer. Evidence types are distinct and carry different epistemic weight.

### 3.1 Evidence types

| Type | Source tier | Epistemic weight | Example |
|------|------------|-----------------|---------|
| `rule_match` | 1 | Deterministic, track record | "Pattern 'NETFLIX*' → account 5030, approved 14/14 times" |
| `open_item_exact` | 2 | Near-certain | "Amount 4,800 SEK exactly matches open bill B-024 from Vendor X" |
| `open_item_tolerance` | 2 | High, with discrepancy type | "Amount 4,728 SEK matches bill B-024 (4,800) within 1.5% — early-payment discount" |
| `counterparty_account_number` | 2/3 | Strong — fraud-relevant | "Bank account SE45 5000… matches vendor master data for Vendor X" |
| `counterparty_name_fuzzy` | 3 | Weak — probabilistic | "Description 'NETFLIX INTL' fuzzy-matches vendor 'Netflix' (similarity 0.89)" |
| `master_data_match` | 3 | Moderate | "Vendor name extracted from description matches vendor-42" |
| `llm_inference` | 4 | Model estimate — uncalibrated by default | "LLM reasoned: 'likely a software subscription based on description + recurring monthly amount'" |
| `within_batch_pattern` | 4 | Weak — sibling-similarity, not ground truth | "Line resembles 11 other lines in this batch that were classified as subscriptions" |
| `sibling_rejected` | 4 (propagated) | Risk signal | "A sibling line from the same batch was rejected by the human reviewer" |

### 3.2 `source_type` and `confidence` are visually distinct

A tier-1 `learned_rule` "confidence" is a frequency ("approved 14/14 times"), not a model estimate. A tier-4 `llm_semantic` confidence is the model's self-reported estimate, which may be uncalibrated (§6). Displaying both on the same 0–1 scale misleads the human.

UI convention:
- Rule-sourced match: **"Rule match — confirmed 14/14"** (track record, not a probability)
- Open-item match: **"Open-item match — exact amount, counterparty verified"** (deterministic evidence summary)
- LLM-sourced match: **"AI estimate: 0.72"** (model estimate, explicitly labeled as such)

The `source_type` field drives the display format; the numeric confidence is secondary context, not the primary signal.

---

## 4. Tier 2 — Open-item matching

### 4.1 Amount tolerance — discrepancy types, not boolean

Exact amount matches are rarer than they look. Early-payment discounts, bank fees netted out, FX rounding on cross-currency invoices, and partial payments all produce bank amounts that differ from invoice amounts. The matcher uses a tolerance window with the **discrepancy type** in the evidence, not a boolean equals check.

| Discrepancy type | Tolerance | Confidence on amount | Evidence text |
|-----------------|-----------|---------------------|---------------|
| `exact` | 0 | 1.0 | "Amount matches exactly" |
| `early_payment_discount` | 1–2% below invoice | ~0.90 | "Delta of 1.5% consistent with standard discount terms" |
| `bank_fee_netted` | Small fixed delta (5–50 SEK) | ~0.85 | "Delta of 35 SEK consistent with domestic transfer fee" |
| `fx_rounding` | Cross-currency, within rounding band | ~0.80 | "Cross-currency delta within rounding band (rate: 0.0893)" |
| `partial_payment` | Amount < invoice, no clear explanation | ~0.50 | "Partial payment — no matching discount or fee pattern" |

A near-match on amount is a **different evidence type** than an exact match and is weighted accordingly. It never silently normalizes to "amount matches."

### 4.2 Cardinality — 1:1, 1:N deterministic; N:M falls through to tier 4 as an ordinary residual

- **1:1** (one transaction ↔ one invoice): deterministic at tier 2.
- **1:N** (one transaction settles multiple invoices — batch payment run): deterministic at tier 2, with the grouping in the evidence ("Transaction of 14,400 SEK matches invoices B-024 + B-025 + B-027, sum 14,400").
- **N:1** (multiple transactions settle one invoice — installments): deterministic at tier 2.
- **N:M** (multiple transactions ↔ multiple invoices): at small-company volume this is genuinely rare — realistically a handful of cases a year, not a routine pattern. It doesn't justify a dedicated detection layer (§0.1). Rather than building bounded candidate-pooling and a shared-counterparty search to identify N:M groups before they reach tier 4, unmatched transactions and unmatched open items simply fall through to tier 4 together. Tier 2 attaches whatever open items share a counterparty with an unmatched transaction (via the strong `counterparty_account_number` signal, §4.3) as context, but doesn't run a dedicated grouping pass to find them — it's the same "unmatched, here's what's nearby" residual handling every other unresolved line gets. The LLM proposes the grouping and narrates it, same as before; the only change is that tier 2 doesn't pre-identify the N:M case as special, it just doesn't force a false 1:1/1:N/N:1 match onto lines that don't fit one.

A wrong N:M match is still the highest-risk failure mode in the cascade (multiple invoices silently mislinked) — that's exactly why it stays a tier-4, narrated, individually-reviewed proposal (§7.2's risk-scaling already puts anything this unusual into individual review regardless of confidence).

**Deterministic cap:** 1:N and N:1 are brute-forced with a cap (N ≤ 8) — this stays, since batch payment runs and installment plans are a genuinely common small-business pattern (rent, batch supplier runs) and the brute-force is cheap. Above the cap, the line escalates to tier 4 with whatever candidate open items remain.

### 4.3 Counterparty evidence — two types, not one

| Evidence type | Signal | Strength | Fraud-relevant? |
|-------------|--------|----------|-----------------|
| `counterparty_account_number` | Bank account number on the statement matches the bank account number stored in vendor/customer master data | Strong — effectively deterministic | Yes — this is the payment-diversion / BEC fraud-control signal |
| `counterparty_name_fuzzy` | Extracted name from description fuzzy-matches a vendor/customer name | Weak — "similar-looking name", not "same entity" | No |

Collapsing both into one "counterparty match: yes/no" field loses the distinction that matters most for fraud control. They are separate evidence entries with different epistemic weight.

---

## 5. Tier 4 — LLM batching

### 5.1 Tiers 1–3 run first, per-line, no LLM

Tiers 1–3 are deterministic lookups (rule match, open-item match, master-data fuzzy match). They run per-line across the entire statement in one cheap server-side pass with no LLM involvement. This pass **is** the grouping step: any line that hits a learned rule or matches master data is already grouped by virtue of sharing that rule.

The batching decision applies **only to tier 4** — the residual lines that exhausted tiers 1–3 without a confident match.

### 5.2 One batch per statement, not content-based clustering

**Amended 2026-08-05 (§0.1).** At small-company volume, the tier-4 residual for a single statement is typically small — a handful of lines, occasionally up to a dozen or two on a messy month. Building a clustering algorithm (exact-normalized-description grouping, then a near-duplicate secondary pass, plus a `cluster_method` evidence-weighting distinction) to split that residual into sub-batches is real machinery for a case — a single statement producing a large, heterogeneous residual — that rarely comes up at this volume.

**Simplified approach:** all residual lines from one statement go into a single tier-4 call, up to the size cap (§5.3). If a statement's residual exceeds the cap — uncommon, an unusually large or messy statement — split sequentially (oldest-first) rather than by content-based clustering.

**What this keeps from the original reasoning:** the arguments for batching over per-line calls (context amortization: chart of accounts, business profile, and learned patterns are sent once per statement, not once per line) and against one call over an unbounded set (blast radius, harder output validation) both still hold — they just don't require a clustering algorithm to act on. A size cap alone is enough at this volume.

**What this drops:** the exact-normalized-description clustering pass, the near-duplicate secondary pass, and the `cluster_method` evidence-weighting distinction (§13 #3, superseded). If usage grows to where single statements routinely produce large, heterogeneous residuals, revisit content-based clustering then — it isn't needed to ship v1.

### 5.3 Batch constraints

- **Size cap: 15–20 lines**, primarily a safety ceiling for an unusually messy statement — most statements' residuals will be well under this at small-company volume.
- **Count-in equals count-out:** the model must return exactly one structured proposal object per line it was given. Validation rejects the batch if counts differ — silent drops or merges are the error class that's invisible until an accountant notices a missing line weeks later.
- **Retry on count mismatch: retry once, then fall back to individual per-line calls.** Given batches are typically small at this volume, a simple fallback is sufficient: retry the whole batch once, and if it still fails, process its lines one at a time. This drops the recursive-bisection strategy from the original design — bisection earns its keep isolating a bad line cheaply inside a large batch; at these batch sizes, falling back to individual retries costs a handful of extra calls at most, not a meaningful amount.

### 5.4 Within-batch groupthink — tagged separately

A statement's residual sent as one tier-4 call can still contain lines that happen to look alike (several similar recurring charges, say). The model can become falsely confident about a subset of the batch *because those lines look alike in context*, not because any individual line has strong independent evidence. This is a different, weaker evidence type than a tier-1 rule match or a tier-3 master-data hit.

**Tag:** `within_batch_pattern` — "reasoned by similarity to siblings in this prompt," not "matched against ground truth." Stored with lower epistemic weight than `independent_match` evidence. Prevents batch-level overconfidence from masquerading as verified evidence.

### 5.5 Sibling rejection

When one line in a batch is rejected on review, sibling proposals from the same batch are flagged:

- Confidence drops by a fixed penalty (-0.15).
- Evidence gains `sibling_rejected: { batch_id, rejected_line }`.
- The human sees the flag and can reject individually.
- **No automatic re-run** — relies on human attention, cheapest option.
- If the human approves the flagged sibling anyway, that's a calibration data point ("sibling-rejected proposals in this pattern were still approved X% of the time"). If the human rejects it too, the batch's reasoning was wrong — the learned rule (if it crystallizes into one, §10) gets penalized.

---

## 6. Calibration

### 6.1 The problem

A tier-4 LLM confidence score is the model's self-reported estimate — no guarantee it's calibrated. Models tend to be overconfident on things adjacent to what they got right (the VAT-code-piggybacking problem from §2). A tier-1 `learned_rule` "confidence" is a frequency ("approved 14/14 times"), not a model estimate. Both displayed on the same 0–1 scale are incomparable.

### 6.2 Plain realized-accuracy counter, not a statistical model

**Amended 2026-08-05 (§0.1).** At small-company volume, a confidence band or an individual rule will rarely accumulate more than single digits to low tens of outcomes per month. A Beta-Binomial posterior, a credible-interval lower bound, and a cross-tenant prior to solve cold start are all designed to extract a stable estimate from sparse data faster and more precisely than a raw ratio would — but at these volumes there usually isn't enough data for the difference between a well-shrunk posterior and a plain ratio with a conservative floor to matter, and the statistical machinery is harder to build, test, and explain to a reviewer than a running counter.

**Specified: a plain running counter per `(source_type, confidence_band)`, computed over full history:**

| source_type | confidence_band | proposed | approved_unedited | approved_edited | rejected | realized_accuracy |
|------------|----------------|----------|-------------------|-----------------|----------|------------------|
| learned_rule | 0.90–1.00 | 14 | 13 | 0 | 1 | 0.93 |
| llm_semantic | 0.70–0.90 | 8 | 5 | 2 | 1 | 0.63 |

`realized_accuracy = approved_unedited / proposed`, computed over **all history to date** for that tenant — not a rolling window. At this volume there's no meaningful distinction between "last N" and "all of it," and using full history gives the counter more data to work with, not less.

**Minimum-N floor, no shrinkage math.** Below a fixed minimum sample size (default **N=10**), the realized-accuracy number is simply not trusted — the proposal is treated as if it were in the lowest confidence band regardless of what the raw ratio says, full stop. No posterior, no credible interval, just "not enough evidence yet, play it safe." Once N≥10, the plain ratio is used directly for display and thresholding. This is a deliberately blunter tool than a Bayesian shrinkage estimate, and that's the point — it's auditable in one sentence ("10 or more outcomes and an X% approval rate") rather than requiring a reviewer, or a future engineer, to understand a statistical update rule to know why a number is what it is.

**Calibrate per source_type, not globally.** Tier-1 rules and tier-4 estimates are tracked as separate rows even at the same nominal confidence — a tier-4 estimate's realized accuracy will typically run well below a tier-1 rule's at the same starting confidence, and thresholds should reflect each source's own track record, not a blended one.

**No cross-tenant prior.** An earlier draft of this spec considered seeding new tenants' calibration from an anonymized cross-tenant aggregate, to soften the cold-start period before a tenant has its own N=10. This is dropped: it adds real complexity (an anonymization method, a cross-tenant-isolation guarantee, and an unresolved question of whether small businesses with different charts of accounts and counterparties even share meaningful signal) to solve a problem — "confidence numbers aren't trustworthy in month one" — that an honestly-conservative default already solves adequately. A new tenant simply starts with everything in individual review until its own N=10 floor is crossed, rule by rule, band by band. Slower to "warm up" than a cross-tenant prior, but correct, simple, and doesn't require an unresolved privacy/isolation design to ship v1. Revisit only if this becomes a genuinely high-volume, multi-tenant platform where shared signal would actually be meaningful.

### 6.3 Retention is unaffected by the counter change

`matching_history` rows are **never pruned or overwritten** based on age — they are permanent audit-trail records (BFL 7 kap retention, §7.1). Computing the accuracy counter over full history rather than a rolling window makes any tension with retention moot in practice — there's no window to reconcile against retention — but the underlying rule stands regardless: the table only grows, for the full retention period (~8 years for a calendar FY).

### 6.4 UI display

The UI displays the realized-accuracy ratio once N≥10 ("AI estimate: 0.90 — 13/14 approved"), or an explicit "not enough history yet" state below that — never a raw model estimate presented as if it were already reliable. The `source_type` label (§3.2) remains the primary signal; the realized-accuracy ratio is secondary context.

### 6.5 Why this counter is band-level, not per-rule

**Amended 2026-08-05 (§0.1).** §6.2's counter is aggregated per `(source_type, confidence_band)` across *all* of a tenant's tier-4 proposals in that band — not per individual rule. That aggregation level matters: a tenant might see a few dozen tier-4 lines a month across many different patterns, so the band-level counter can realistically cross N=10 within a few months. A single mapping *rule*, tied to one specific recurring vendor, sees far fewer outcomes — often about one a month — so a per-rule version of the same counter would take the better part of a year to reach N=10. That's why §10.5 dropped the per-rule accuracy-floor retirement trigger: the mechanism is sound, the volume to feed it per-rule usually isn't there at this scale. The band-level counter here doesn't have that problem and stays as specified.

---

## 7. Review posture

### 7.1 No auto-posting

**No proposal ever bypasses the inbox.** Even at very high confidence, the human reviews before the ledger is touched. Rationale:

- **BFL 5 kap:** every verifikation must be based on an underlying handling, and the approval *is* the human's attestation that they've verified the underlag. Auto-posting means no human attestation — a compliance gap in Swedish K2.
- **Audit trail:** "no human ever saw this before it posted" removes the approval trail that makes the system auditable.

### 7.2 Friction scales with risk, not just confidence

The review posture scales with risk factors, not just the confidence number. **All confidence thresholds in this section use the realized-accuracy ratio from §6 (once a rule or band has crossed the N=10 floor), not the raw model estimate.** Below that floor, or using raw scores, genuinely poor tier-4 proposals could reach the batch-approve-eligible pool before there's any evidence to justify it.

| Risk factor | Higher friction |
|------------|----------------|
| Amount magnitude | Large amounts get individual review, never batch-approve |
| Counterparty novelty | First-time counterparty — always individual review |
| Account-number change | Counterparty's bank account changed since last match — fraud risk, always individual review |
| Low per-dimension confidence | Any dimension below 0.60 — always individual review, show alternatives |

### 7.3 Batch-approve for high-confidence review groups

For high-confidence proposals that don't trigger a risk factor, the lever is **reduced friction, not reduced visibility**: batch one-keystroke approval for a **review group** of high-confidence proposals, still logged as individually reviewed. The human sees every line; they just say "yes to all 40" in one action rather than 40 separate `y` presses.

**"Review group" ≠ "batch" (§5.2).** A batch is a tier-4 LLM call for one statement's residual lines. A review group is an inbox-side grouping for batch-approve — it spans across source_types (a tier-1 rule match and a tier-2 open-item match can sit in the same review group). The terms are distinct; the groupings are independent.

### 7.4 Low-confidence proposals

Low-confidence proposals are flagged in the inbox with the agent's top-2 alternative interpretations shown, so the human can pick rather than construct from scratch. The alternatives are part of the proposal's evidence/payload.

---

## 8. Architecture — server-side deterministic, agent-side LLM

### 8.1 Tiers 1–3: server-side API actions

Tiers 1–3 are deterministic lookups — they run as **server-side API actions**, not agent reasoning. The agent calls them as tools and handles only the tier-4 residual.

Rationale:
- **Auditable controls:** deterministic matching logic should be server-side, testable, and auditable — not in a prompt.
- **Cost discipline:** tiers 1–3 are zero-token API calls; tier 4 is the only LLM cost.
- **R1 preserved:** the agent talks API only (never touches DB, never touches filesystem).

### 8.2 New API actions

| Action | Role | Purpose |
|--------|------|---------|
| `bank.match` | `agent` | Takes a statement line, runs tiers 1–3, returns matches with evidence + per-dimension confidence. Does not propose — just returns structured match results. |
| `matching_history.query` | `agent` | Returns prior match outcomes for a given line's signals (description pattern, counterparty, amount) — the learned-rule store (§10). |
| `matching_history.record` | `agent` | Records a proposal outcome (approved/rejected, with edits) — feeds calibration (§6) and learning (§10). |
| `calibration.get` | `agent` | Returns realized-accuracy table for the tenant — used to calibrate confidence display. |
| `mapping.suggest` | `agent` | **Added 2026-08-05 (§10.1, §10.4).** Writes a candidate rule to `mapping_suggestions` — never to `mappings` itself. Params mirror a mapping row (`bankAccount`, `descriptionPattern`, `suggestedAccount`, `suggestedVatCode?`, `suggestedDimensions?`, `evidence`, `sourceProposalId`). With a caller-supplied `suggestionId`: upserts a still-`proposed` row created by the same caller (same idempotent-retry convention as `journal.propose`, §4.3). |
| `mapping.suggestion.approve` | `data_entry` | **Added 2026-08-05.** `proposed → approved`. Validates and writes the row into `mappings` (`is_active=true`) in the same transaction — the "approve is the post" pattern (agent-readiness-spec §4.1), applied to mapping rules instead of journal batches. **Not** in `AGENT_ALLOWED` — human-only by the same default-deny mechanism that excludes `journal.approve`/`journal.reject` (agent-readiness-spec §2.3). |
| `mapping.suggestion.reject` | `data_entry` | **Added 2026-08-05.** `proposed → rejected`, terminal. No note required (lighter-weight than `journal.reject` — a discarded suggestion isn't a rejected accounting entry). Not agent-whitelisted, same as approve. |
| `mapping.suggestion.list` / `.get` | `viewer` | **Added 2026-08-05.** Read-only, for the inbox item and its unfold view. |
| `bill.create` | `agent` | **Added 2026-08-05 (bills routing — Option C ratified).** Creates a **draft** bill (not posted) from an extracted supplier invoice — params mirror the existing `bill.create` action (vendor, amount, due date, line items, currency), with the bill landing in `status='draft'`. Does not post — no journal entries are created; the bill is not yet an open payable. The draft appears in the inbox as a Class A item (`type: 'bill_draft'`, agent-readiness-spec §10.2); a human's `y` approval triggers `bill.post` (which creates journal entries and opens the payable — the open payable tier 2 then matches against). `x` discards the draft. Same proposal-stage category as `journal.propose` (writes to a draft/proposal state, not to `journal_entries`). **Catalog role:** `agent` (1.5), **not** `data_entry` (2) — same dispatch-ordering fix as `bank.match` and `journal.propose` (the numeric role check runs before the §2.3 whitelist guard; `data_entry` would reject an agent actor 1.5 < 2). Added to `AGENT_ALLOWED` (agent-readiness-spec §2.3). |

**Catalog role fix (2026-08-05):** `bank.match` must use catalog role `agent` (1.5), **not** `data_entry` (2) — an earlier draft specified `data_entry` "same role as today's `bank.process`," but agent-readiness-spec §4.3 documents that dispatch runs the numeric role check *before* the §2.3 whitelist guard, so a `data_entry`-role action rejects an agent actor (1.5 < 2) regardless of whitelisting. This is the exact fix already applied to `journal.propose` for the same reason (agent-readiness-spec §4.3). With role `agent`: `data_entry` (2) and `owner` (3) humans still pass (2≥1.5, 3≥1.5, so the existing UI/wizard call sites are unaffected), `viewer` (1) is still excluded, and the agent (1.5) now passes too.

`mapping.suggestion.approve`/`.reject` deliberately use role `data_entry`, not `agent` — unlike `bank.match`, these must **not** be callable by the agent; `data_entry` (2) rejects an agent actor (1.5) at the same numeric check, which is exactly the point here (the inverse of the `bank.match` fix — same mechanism, opposite intent).

All actions here are non-mutating reads except `matching_history.record`, `mapping.suggest`, `mapping.suggestion.approve`, `mapping.suggestion.reject`, and `bill.create` (writes). `bank.match`, `matching_history.query`, `calibration.get`, and `mapping.suggestion.list`/`.get`, being non-mutating, are reachable through the existing `freebooks_read` MCP tool (agent-readiness-spec §5.2) without any new tool. `matching_history.record`, `mapping.suggest`, and `bill.create` are agent-callable writes, so each needs (a) an explicit entry in `AGENT_ALLOWED` (agent-readiness-spec §2.3) and (b) a dedicated MCP tool, the same way `journal_propose` and `attachment_upload` each got one — `freebooks_read` only proxies non-mutating actions by design. `mapping.suggestion.approve`/`.reject` and `bill.post` need neither: they're human-only by the role fix above (`data_entry`, not agent-whitelisted), so the agent can never call them regardless of whitelisting, and no MCP tool for them should exist (mirroring why no `journal_approve`/`journal_reject` tool exists, agent-readiness-spec §5.2). `bill.post` is the same case — the human's inbox approval of a `bill_draft` IS the post, exactly as `journal.approve` is the post for a `journal_proposal` (agent-readiness-spec §4.1). All of this belongs in agent-readiness-spec alongside its existing whitelist and manifest, not only here.

### 8.3 Agent orchestration

The agent's role:
1. Receive the statement (from the feed adapter, P3).
2. Call `bank.match` per line (or batched server-side) — gets tier 1–3 results.
3. Lines with confident matches → `journal.propose` with the match's suggested dimensions + evidence.
4. Lines without confident matches → one tier-4 LLM call for the statement's residual, `journal.propose` the results.
5. Lines with missing critical data → `input_rejection` inbox item (§11).
6. After inbox review, call `matching_history.record` with the outcome; if the outcome was a tier-4 approval-unedited for a not-yet-ruled pattern, also call `mapping.suggest` (§10.4) — never a direct write to `mappings`.

The agent never edits counterparty bank-account data (§9), and never writes to `mappings` directly (§10.1).

---

## 9. Write-permission boundary — counterparty bank-account data

Counterparty bank-account numbers are **human-only, permanently** — the agent can *read* them for matching but can never *create or modify* them. This is the BEC fraud-control boundary (agent-readiness spec §5.2: "Vendor bank-detail handling: no such fields exist today; when they arrive, they are human-only permanently (BEC fraud vector)").

The `counterparty_account_number` evidence type (§4.3) is a *read* against vendor/customer master data. The agent uses it as evidence; it never writes to the bank-account fields on a vendor record. If the agent detects that a counterparty's bank account number has changed, that's a risk signal (§7.2), not an automatic update.

---

## 10. Learning store

### 10.1 The mapping table stays human-only; the agent suggests, a human approves

**Amended 2026-08-05.** An earlier draft of this spec had the agent write directly to the `mappings` table — "agent-maintained," no user-facing screen at all. That's dropped: agent-readiness-spec R2 states plainly that agents may never mutate master data, and names `mappings` in that list explicitly. An agent-attributed write to `mappings` — whether framed as "maintenance" or not — is exactly the mutation R2 forbids, regardless of how the call is packaged.

**Resolution: `mappings` stays human-only, permanently, no exception for learned rules.** Instead, rule creation goes through a small, new proposal/approval pair — the same shape as `journal_proposals`, reused rather than invented:

- The agent calls **`mapping.suggest`** (§8.2) — a write, but to a new `mapping_suggestions` table, not to `mappings` itself. Exactly analogous to how `journal.propose` writes to `journal_proposals`, never to `journal_entries`.
- A human reviews the suggestion as a lightweight inbox item (§10.4) and approves or rejects it.
- **Only the human's approval action writes to `mappings`.** The mutation of master data is always attributed to the human who approved it — R2 is satisfied because the actor making the master-data write is never the agent, not because the write is hidden inside another action's handler.

**What this changes from the original design:** the manual mapping-CRUD screen still dissolves — no one hand-types patterns into a form anymore. What replaces it isn't "invisible, agent-maintained infrastructure" though; it's a lightweight review surface: the human still says yes or no to each new rule, just as a one-glance approval in the inbox rather than as a screen they proactively maintain. This is a smaller, cheaper decision than the old manual screen (a glance and a keypress vs. typing out a pattern), but it is a decision the human makes, every time — which is the actual point of the amendment.

### 10.2 `mapping_suggestions` table

```sql
CREATE TABLE IF NOT EXISTS mapping_suggestions (
  company_id           VARCHAR NOT NULL,
  suggestion_id        VARCHAR NOT NULL UNIQUE,
  bank_account         VARCHAR,
  description_pattern  VARCHAR NOT NULL,
  suggested_account    VARCHAR NOT NULL,
  suggested_vat_code   VARCHAR,
  suggested_dimensions JSON,
  evidence             JSON,      -- why the agent is suggesting this — the approved proposal it crystallized from
  source_proposal_id   VARCHAR,   -- the journal_proposals row whose approval triggered this suggestion
  status               VARCHAR NOT NULL DEFAULT 'proposed',  -- proposed | approved | rejected
  created_by           VARCHAR NOT NULL,
  reviewed_by          VARCHAR,
  reviewed_at          TIMESTAMP,
  created_at           TIMESTAMP NOT NULL DEFAULT NOW()
);
```

Same shape and lifecycle as `journal_proposals` (§4.2, agent-readiness-spec §4.2) deliberately — `proposed → approved | rejected`, `approved` is the write (§8.2's `mapping.suggestion.approve` both validates and inserts/updates the `mappings` row, same "approve is the post" pattern as `journal.approve`, agent-readiness-spec §4.1). No separate staging entity beyond this one table — it *is* the owning table for this item type, consistent with R8 (agent-readiness-spec §1).

### 10.3 `matching_history` table

Richer learning — tier 2/3 outcomes, confidence adjustments, rejected proposals and corrections — persists in a new `matching_history` table:

```
matching_history (
  id              UUID PRIMARY KEY,
  company_id      TEXT NOT NULL,
  bank_account    TEXT,              -- scope: which bank account
  description_pattern TEXT,          -- normalized description
  counterparty    TEXT,              -- matched counterparty, if any
  amount          DECIMAL(12,2),
  proposed_dimensions JSON,          -- {account, vat_code, counterparty, ...}
  approved_dimensions  JSON,         -- what the human actually approved (may differ)
  source_type     TEXT,              -- learned_rule | open_item | master_data | llm_semantic
  confidence      JSON,             -- per-dimension at proposal time
  evidence        JSON,             -- evidence array at proposal time
  outcome         TEXT,              -- approved_unedited | approved_edited | rejected
  created_at      TIMESTAMPTZ
)
```

The agent queries this on each new statement line (via `matching_history.query`) before falling through to tier 4. On any inbox approval/rejection, the agent calls `matching_history.record`.

### 10.4 Crystallization — expensive reasoning becomes a proposed rule, not a written one

When a tier-4 LLM proposal is approved unedited, and the matched pattern doesn't already have a tier-1 rule, the outcome is a **candidate** for crystallizing into one — but the agent doesn't write it. The agent calls `mapping.suggest` (§8.2, §10.1), which inserts a row into `mapping_suggestions` (§10.2), carrying the pattern, the suggested dimensions, and the evidence (the approved proposal it came from). This is the same "propose, not post" shape as `journal.propose`, applied one level up: the agent's write target is a proposal table, never the master-data table it's proposing changes to.

The suggestion surfaces in the inbox as a Class B item (agent-readiness-spec §10.2), summarized simply — e.g. "New rule suggested: 'NETFLIX*' → account 5030, based on 1 approved match." `y` approves (`mapping.suggestion.approve` — writes the row into `mappings`, attributed to the human who approved it); `x` rejects (discards the suggestion; no note required — this is a lighter-weight decision than rejecting a journal proposal). Next time the same pattern appears *after approval*, it resolves at tier 1 — no LLM call.

**Crystallization still triggers on N=1 — the human-approval step doesn't change that.** The agent still proposes a new rule after a single clean success, not after accumulated statistical confidence (§6.2/§10.5 need volume; this doesn't). What changes is who writes to `mappings`: never the agent, always the human, via one extra glance-and-keypress in the inbox rather than a silent background write. At small-company volume this is genuinely lightweight — crystallization events are infrequent (most recurring vendors resolve at tiers 2–3 before ever reaching tier 4; only the tier-4-only residual generates suggestions at all), so this is a handful of extra approvals a year, not an added review burden.

This is the cascade's self-populating-downward property: expensive reasoning at the top, cheap rules at the bottom, learning pushes everything toward the bottom over time — now with an explicit human decision at the one point where the system's autonomous surface actually grows.

### 10.4a Bill drafts as a Class A inbox type (Option C ratified)

**Amended 2026-08-05 (bills routing — Option C ratified).** The inbox taxonomy (agent-readiness-spec §10.2) gains a new Class A type: **`bill_draft`**. Where mapping suggestions (§10.4 above) are Class B — a master-data decision, not a ledger approval — a bill draft is Class A: approving it posts journal entries (`bill.post` creates them), the same pre-ledger-approval category as `journal_proposal`. The flow:

1. Agent extracts a supplier invoice from a dropped PDF (agent-data-feeding-guide §4.5b) and calls `bill.create` (§8.2) — creates a **draft** bill, no journal entries yet.
2. `inbox.list` (agent-readiness-spec §10.3) fans out to the `bills` table for `status='draft'` rows in addition to `journal_proposals`, normalizing each to `{ type:'bill_draft', source:'agent', counterparty:<vendor>, amount, date, verbs:['y','x'], payload_ref:{bill_id} }`.
3. Human reviews in the inbox default (Class A) view: `y` triggers `bill.post` (journal entries created, bill becomes an open payable); `x` discards the draft.
4. The now-open payable is what tier 2 (§4) matches bank transactions against — amount + counterparty + date window, with the discrepancy types and counterparty-evidence split §4.1/§4.3 already specify.

This is the composition point between bill routing and the cascade: the cascade doesn't know or care how the payable entered the system. A bill that entered via the human UI (the existing `bill.create`/`bill.post` path, `data_entry` role) and a bill that entered via the agent draft → human-approve path produce the same open payable; tier 2 matches against both identically. The agent's `bill.create` is a proposal-stage write (to draft state), the same category as `journal.propose` — it never reaches `journal_entries`, and the post is always human-attributed (agent-readiness-spec §4.1, "approve is the post").

### 10.5 Penalty on rejection — immediate friction, retirement via existing human actions

**Amended 2026-08-05 (§0.1, §10.1).** When a match is rejected, two things happen independently:

**Immediate friction bump (first rejection):** The rule's display changes immediately — it drops out of the batch-approve-eligible bucket (§7.3), even though it remains active. Every proposal from this rule now requires individual inbox review, regardless of its nominal confidence. Rationale: §7.2's premise is friction-scales-with-risk, and "this rule was just wrong once" is a risk signal that should bump friction *immediately*, not after a lag. This is a display-state change, not a write to `mappings` — no R2 concern here, nothing about the rule's row in the table changes yet.

**Retirement — two triggers, both resolved as side effects of actions a human is already calling, not a new agent write:**

1. **Consecutive rejections:** after a configurable number of consecutive rejections (default: 3), the rule is retired — deactivated (`is_active = false`) in `mappings`, stops firing at tier 1. Unlike the original design, this write is not made by the agent: it happens *inside the human's own `journal.reject` call* (agent-readiness-spec §4.3) — when a human rejects a proposal that came from a tier-1 rule, the handler checks the consecutive-rejection count for that rule's pattern and deactivates it in the same transaction if the threshold is crossed. The mutation is attributed to the human who called reject, exactly as `journal.approve` already posts attributed to the human who approved (agent-readiness-spec §4.1's "approve is the post" pattern) — this reuses that precedent rather than inventing a new one. No new approval surface needed: the human already acted (they rejected the proposal); retirement is a consequence of that action, not a separate decision.
2. **Bank-account-change (security event):** if a rule's originating evidence included `counterparty_account_number` (§4.3) and that stored account number subsequently changes, the rule is retired immediately and unconditionally. This, too, is a side effect of a human-attributed call — whatever future action lets a human edit a vendor/customer's bank account details (agent-readiness-spec §7 notes no such fields exist yet; when they land, their edit handler must check for and deactivate any tier-1 rules whose evidence depended on the old account number, in the same transaction, and return a warning naming what it retired). This is a security event, not a statistical judgment: the fraud-control property §9 protects collapses if a rule trusted specifically *because* the bank account matched keeps firing after that account changes. A human already caused this change (they're the one editing the vendor record); the retirement warning surfaces to them as part of that same action's response, not as a separate notification channel.

**Dropped: the per-rule accuracy-floor trigger.** An earlier draft added a third trigger — retire a rule once it accumulates N=10 outcomes and its realized accuracy drops below a floor, to catch slow drift (a rule wrong 1-in-4, spread out, that never triggers "3 in a row"). This is dropped for small-company volume: a rule tied to one recurring monthly vendor sees roughly one outcome a month, so reaching N=10 *on that specific rule* takes the better part of a year — by the time the trigger could fire, it's provided close to no protection on any realistic timescale. Two things cover the gap instead: the immediate friction bump means every rejected rule already gets individual review going forward, not a statistical wait; and the visible "confirmed N/M" badge (§3.2) puts the raw count in front of the reviewer on every proposal from that rule, so a small-business reviewer — who is looking at every line anyway, unlike a high-volume operation relying on automation to catch what no one has time to review — has the information to notice a rule that's wrong sometimes well before any automated floor could. If this ever serves high-frequency rules (a rule firing many times a month, where N=10 arrives in weeks not months), this trigger is worth reintroducing — see §0.1.

If the rejected match came from tier 4 (not a learned rule), no rule is created — the rejection is recorded in `matching_history` so the agent doesn't repeat the same inference.

**Re-promotion:** A retired rule can be re-promoted, but per §10.1's resolution this goes through the same `mapping.suggest`/approval path as any new rule — the agent suggests it again (re-derived, with corrected dimensions) once the underlying pattern is approved unedited again; a human approves it as a fresh suggestion. No separate re-promotion mechanism is needed — it's an ordinary new suggestion that happens to reuse a previously-seen pattern. The re-derived rule's track record starts from zero regardless; it does not inherit the retired rule's history.

---

## 11. Input rejections

### 11.1 Two failure modes

| Failure mode | What happened | Where it surfaces | Human action |
|--------------|--------------|-------------------|-------------|
| **Intake failure** | Input is structurally broken — malformed CSV, missing headers, unparseable PDF, wrong file type | Immediate rejection to the submission channel (non-zero exit, error response). Logged to `event.list` (agent's channel). **Not in the inbox.** | Fix the submission source, re-submit |
| **Semantic rejection** | Input parsed, but critical data is missing/ambiguous on specific lines (missing date, blank amount, unparseable description) | **Inbox** — Class B item (§11.2) | `r` retry (correct + re-run) or `d` discard |

### 11.2 Inbox integration — Class B (broadened)

The inbox taxonomy (agent-readiness spec §10.2) is broadened: **Class B = operational items requiring human action that are not ledger approvals**. The "post-ledger" qualifier is dropped — Class B now includes pre-ledger input failures. The `type` field discriminates within the class.

New Class B type:

```
{
  type: 'input_rejection',
  source: 'agent',
  summary: 'Statement 2026-08-05: 3 lines rejected — missing required field',
  verbs: ['r', 'd'],
  payload_ref: { statement_id, rejected_lines: [...] },
  evidence: [
    { line: 47,  reason: 'missing date',           raw: 'NETFLIX*,4900,2026-08-...' },
    { line: 183, reason: 'missing amount',         raw: '2026-08-04,NETFLIX*,' },
    { line: 199, reason: 'unparseable description', raw: '2026-08-04,,4900' }
  ]
}
```

- **One item per statement** with rejections, not one per line — "Statement X: 3 lines need attention" with drill-through to individual lines. Keeps the inbox scannable.
- **Verbs differ from Class A's `y`/`x`:**
  - `r` (retry) — the human corrects the missing data (edits the line, or provides the value) and the agent re-runs the cascade on just those lines. If it now resolves, it becomes a normal proposal.
  - `d` (discard) — the human decides the line is spurious (bank header row, duplicate, test transaction). Marked discarded, logged, never proposed.

### 11.3 What counts as "critical data"

A line is rejected (not proposed) when it lacks a field required for *any* tier to attempt a match:
- **Missing date** — no tier can run (all need a date for the journal entry).
- **Missing amount** — no tier can run (tiers 2 and 4 need the amount).
- **Missing description AND no counterparty** — tiers 3 and 4 have no signal to reason over. A line with an amount and date but no description can still match at tier 2 (open-item match by amount + counterparty from the bank's counterparty field, if present).

Lines with partial data that still allows a tier to attempt — e.g., amount + date but vague description — are **not rejected**. They proceed through the cascade and may produce a low-confidence tier-4 proposal, which the human reviews with alternatives (§7.4).

---

## 12. What dissolves

| Today | Under this spec |
|-------|----------------|
| Bank Mappings screen (user-maintained pattern rules) | Manual CRUD screen dissolves — replaced by a lightweight suggestion-review item in the inbox (§10.1, §10.4); the human still approves every new rule, just as a glance-and-keypress instead of hand-typing a pattern |
| Bank Import wizard (`/bank?tab=import`, CSV upload) | Stays until P3 feeds land; then superseded by the feed adapter + cascade |
| `bank.process` / `bank.approve` (human/data_entry) | Replaced by `bank.match` (tiers 1–3) + agent `journal.propose` + inbox review |
| `bank-import` gKey (`g i` dropped per §10) | Already done (A5); bank reachable via `g b` + palette |
| Bank sidebar item | Transactions + Mappings tabs remain; Import tab dissolves when feeds land. The sidebar entry stays (§0: Bank remains a sidebar item). |

---

## 13. Open questions

1. **Feed adapter — resolved.** Bank statements arrive via the drop-folder watcher (`~/freebooks-inbox/bank/`), uploaded with `entityType: "bank_statement"`. The folder structure is the classification; an optional operator-managed preprocessor can route files to subfolders before the watcher sees them. No bank API integration for v1. See `docs/agent-data-feeding-guide.md` §4.3 (subfolder-aware watcher) and §4.5 (bank statement agent processing).
2. **Fuzzy match algorithm (tier 3): trigram similarity, not embeddings.** Given §8.1's rationale (deterministic, testable, auditable), embeddings are the wrong mechanism for tier 3 — a cosine-distance float is a worse audit answer than a trigram overlap score, and embeddings introduce model-version drift (re-embedding needed when the model changes, silently shifting match behavior for old vs. new records).

   **Specified: trigram similarity over normalized strings.**
   - Normalization: strip legal suffixes (AB, Inc, Ltd, GmbH), strip bank-feed noise (trailing `*`, embedded reference numbers, dates, amounts), uppercase-fold.
   - Similarity: `pg_trgm` trigram overlap (DuckDB equivalent if pg_trgm unavailable — the mechanism is trigram, not the specific implementation).
   - Alias table: curated known reformattings (`NETFLIX` → `Netflix International BV`), seeded from approved matches over time. Human-approved via the same suggest/approve flow as mapping rules (§10.1, §10.4) — no separate carve-out for alias entries; they're master-data-adjacent for the same reason `mappings` is.
   - Threshold: configurable; v1 default 0.7 trigram similarity.
   - **Scope discipline:** tier 3 catches lexical closeness only. Cases that are lexically distant but semantically the same (abbreviation, translated name) fall through to tier 4, where the LLM's narrated evidence is more auditable than a raw similarity score would be. Don't reach for embeddings to close that gap in the middle — the honest allocation is trigram at tier 3 for lexical closeness, LLM at tier 4 for semantic inference.
3. **Cluster algorithm (tier 4 batching) — superseded 2026-08-05: dropped in favor of one batch per statement (§0.1, §5.2).** The original resolution specified exact-normalized-description clustering with a near-duplicate secondary pass and a `cluster_method` evidence-weighting distinction. At small-company volume, the tier-4 residual per statement is typically small enough that this content-based splitting rarely has anything to act on — most statements produce one batch. Rescoped: all residual lines from a statement go into a single tier-4 call (capped as a safety ceiling, not a clustering target); if the cap is exceeded, split sequentially, not by content. If usage grows to where single statements routinely produce large, heterogeneous residuals, revisit content-based clustering then — it isn't needed to ship v1.
4. **Calibration window — superseded 2026-08-05: plain counter with a fixed N=10 floor, no Beta-Binomial (§0.1, §6.2).** The original resolution specified Beta-Binomial shrinkage with a credible-interval lower bound, specifically to avoid a hard-cutoff discontinuity and to support a cross-tenant prior. At small-company volume, a rule or band rarely accumulates enough outcomes for the gap between a shrunk posterior and a plain ratio to matter in practice, and the plain version is far easier to build, test, and explain. Rescoped: `realized_accuracy = approved_unedited/proposed` over full history; below N=10 the number isn't trusted at all (treated as lowest-band, no partial credit); above N=10 the plain ratio is used directly. See §6.2 for the current text.
5. **Mapping retirement: two distinct triggers, demote-not-delete, both resolved as human-attributed actions. Amended 2026-08-05: dropped the accuracy-floor trigger, and re-routed both remaining triggers through actions a human is already calling, rather than an agent write to `mappings` (§10.1's R2 resolution).**

   §10.5's "3 consecutive rejections" is a fast-acting trigger for acute change, but not the whole picture — the bank-account-change trigger catches a different, security-relevant failure mode. A third trigger (accuracy floor via a per-rule outcome counter) was specified in earlier drafts to catch slow drift, but is dropped: a rule tied to one recurring monthly vendor accumulates outcomes too slowly (roughly one a month) to reach a meaningful sample size within a useful timeframe — see §10.5 and §6.5 for the reasoning, which applies regardless of whether the counter is a plain ratio or a Beta-Binomial posterior. The two remaining triggers:

   1. **Consecutive rejections (existing, §10.5):** catches acute breaks — vendor changed practice, description format changed. Default: 3 consecutive → retire. Fires fast regardless of overall volume. Implemented inside the human's own `journal.reject` call, not a separate agent write — the deactivation is attributed to whoever rejected the proposal.
   2. **Bank-account-change (security event — different in kind):** if a rule's originating evidence included `counterparty_account_number` (§4.3) and that stored account number subsequently changes, retire the rule *immediately and unconditionally* — not via accumulated rejections. This is a security event, not a statistical judgment: the fraud-control property §9 protects collapses if a rule trusted specifically *because* the bank account matched keeps firing after that account changes. Implemented inside whatever future action lets a human edit a vendor/customer's bank details; the retirement warning surfaces as part of that action's own response, since the human causing the change is already looking at that screen.

   **"Retire" = demote to inactive, not delete.** The rule and its full history stay in `matching_history` for audit purposes (§7.1). The rule stops firing at tier 1; it is not removed from the table.
6. **Cold-start calibration — cross-tenant prior — dropped 2026-08-05 (§0.1).** The original resolution proposed seeding new tenants' calibration from an anonymized cross-tenant aggregate, made natural by the Beta-Binomial mechanism. With calibration simplified to a plain counter (§6.2), cold start is instead handled by defaulting to individual review until a tenant/rule crosses its own N=10 floor — slower to warm up than a cross-tenant prior, but it avoids an unresolved privacy/isolation design (anonymization method, cross-tenant leakage, and whether small businesses with different COAs and counterparty populations even share meaningful signal) that isn't needed to ship v1. Revisit only if this becomes a genuinely high-volume, multi-tenant platform where shared signal would carry real weight.
7. **Dependency graph derivation (§2.2).** V1 ships a fixed dependency graph. A future version derives the `derived_from` edges from the tenant's actual COA structure. Needs a mechanism (COA metadata? inferred from historical co-occurrence?).
