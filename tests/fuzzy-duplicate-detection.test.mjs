'use strict';/**
 * Fuzzy duplicate detection for partner proposals — issue #130, tuned #226.
 *
 * Covers:
 *   1. trigramSimilarity() unit tests (mapping-utils.js)
 *   2. partner.propose server-side fuzzy duplicate detection against an
 *      EXISTING partner (partners.js proposePartner phase 2)
 *   3. partner.propose fuzzy duplicate detection against a PENDING proposal
 *
 * Two-phase detection (issue #130): a fast SQL exact case-insensitive match
 * (phase 1, still a hard block — unambiguous) is followed by a trigram
 * fuzzy match (phase 2) over the in-scope rows, catching near-duplicates
 * that differ by punctuation, abbreviation, or formatting.
 *
 * issue #226: two changes from the original #130 implementation.
 *   (a) The similarity metric is Sørensen–Dice (2·|A∩B| / (|A|+|B|)), not
 *       Jaccard (|A∩B| / |A∪B|). Jaccard's union denominator gets diluted by
 *       an abbreviation/expansion pair's longer name, driving scores below
 *       any reasonable threshold — e.g. "Netflix Inc" vs "Netflix
 *       International BV" scored 0.35 Jaccard, comfortably hiding a real
 *       duplicate. The same pair scores 0.52 Dice.
 *   (b) The fuzzy phase no longer blocks proposal creation (CONFLICT). An
 *       agent proposing a partner has no one to answer a blocking
 *       confirmation, so a false positive used to silently kill a
 *       legitimate proposal with no human ever seeing it. The fuzzy match
 *       is now carried on the proposal as `duplicate_warning` for the human
 *       reviewer (Inbox partner_proposal item) to see and decide — approve
 *       or reject. The exact-match phase keeps blocking (still unambiguous,
 *       and no reviewer benefits from seeing an identical name flagged).
 *
 * Run: node --test tests/fuzzy-duplicate-detection.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, apiPost } from './lib/test-server.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { trigramSimilarity, findFuzzyMatch } = require('../api/src/mapping-utils.js');

const CO = 'fztest';
const AGENT = 'agent@fz.test'; // seeded with role 'agent' so partner.propose runs

// ── 1. Trigram similarity unit tests ───────────────────────────────────────

test('trigramSimilarity: identical strings score 1.0', () => {
  assert.equal(trigramSimilarity('Netflix Inc', 'Netflix Inc'), 1.0);
});

test('trigramSimilarity: abbreviation/expansion pair clears the fuzzy-match threshold (issue #226)', () => {
  // "Netflix Inc" vs "Netflix International BV" → Dice 0.516 (was Jaccard
  // 0.35, which sat below the old 0.65 threshold and hid this exact
  // motivating case from issue #226).
  const s = trigramSimilarity('Netflix Inc', 'Netflix International BV');
  assert.ok(s > 0.5, `expected > 0.5, got ${s}`);
});

test('trigramSimilarity: "Acme Corp" vs "Acme Corporation" clears the fuzzy-match threshold (issue #226)', () => {
  // Dice 0.667 (was Jaccard 0.50, also below the old 0.65 threshold).
  const s = trigramSimilarity('Acme Corp', 'Acme Corporation');
  assert.ok(s > 0.6, `expected > 0.6, got ${s}`);
});

test('trigramSimilarity: unrelated names score near zero (< 0.2)', () => {
  const s = trigramSimilarity('Netflix Inc', 'Amazon Web Services');
  assert.ok(s < 0.2, `expected < 0.2, got ${s}`);
  assert.equal(s, 0.0); // no shared trigrams at all
});

test('trigramSimilarity: short strings use exact-match semantics', () => {
  assert.equal(trigramSimilarity('AB', 'AB'), 1.0);
  assert.equal(trigramSimilarity('AB', 'CD'), 0.0);
});

test('trigramSimilarity: normalization is case/space-insensitive', () => {
  assert.equal(trigramSimilarity('Netflix   Inc', 'netflix inc'), 1.0);
  assert.equal(trigramSimilarity('  NETFLIX  INC ', 'netflix inc'), 1.0);
});

test('findFuzzyMatch: returns best candidate above threshold, else null', () => {
  const candidates = [
    { name: 'Acme Corp', id: 1 },
    { name: 'Totally Different Inc', id: 2 },
  ];
  // "Acme Corp." vs "Acme Corp" → 0.875 (above 0.65)
  const m1 = findFuzzyMatch('Acme Corp.', candidates, 0.65);
  assert.ok(m1, 'expected a fuzzy match');
  assert.equal(m1.candidate.name, 'Acme Corp');
  assert.ok(m1.similarity > 0.65);

  // Unrelated name → null
  const m2 = findFuzzyMatch('Unrelated Name', candidates, 0.65);
  assert.equal(m2, null);

  // Lowering the threshold lets the unrelated name still miss (no shared
  // trigrams), and empty input / empty candidates are handled.
  assert.equal(findFuzzyMatch('', candidates), null);
  assert.equal(findFuzzyMatch('Acme Corp.', []), null);
});

// ── 2 & 3. API-level fuzzy duplicate detection ─────────────────────────────
// These boot an in-process throwaway server (issue #112 pattern) and exercise
// the full partner.propose handler end-to-end.

async function seedCompany(baseUrl) {
  const company = {
    company_id: CO,
    company_name: 'Fuzzy Test Co',
    jurisdiction: 'SE',
    currency: 'SEK',
    reporting_standard: 'K2',
    vat_registered: false,
    fy_start: '2026-01-01',
    fy_end: '2026-12-31',
  };
  try {
    await apiPost(baseUrl, 'setup.add_company', 'x', { company }, 'fz-setup');
  } catch (e) {
    if (!/already exists|DUPLICATE/.test(String(e.message))) throw e;
  }
  // Seed an owner first: setup.add_company only auto-grants ownership when a
  // userEmail is passed on that call (it wasn't, above), so fztest starts
  // with zero owner rows. permissions.upsert's assertNotLastOwner guard
  // (access-tab-spec.md §2.3) refuses any non-owner grant while that's true,
  // regardless of the granted email's own prior state — a real owner has to
  // exist first, same as it would for any real company.
  await apiPost(baseUrl, 'permissions.upsert', CO, {
    email: 'owner@' + CO, role: 'owner',
  }, 'fz-owner');
  // Grant an agent role so partner.propose (role 'agent') can run with a
  // populated created_by. The permission gate itself is still skipped when
  // no userEmail is asserted on the request — this grant just needs to not
  // trip the last-owner guard above.
  await apiPost(baseUrl, 'permissions.upsert', CO, {
    email: AGENT, role: 'agent',
  }, 'fz-perms');
}

// Call partner.propose and return the raw error envelope (or null on success),
// so tests can inspect code + message without the apiPost helper throwing.
async function proposeRaw(baseUrl, body) {
  const payload = { action: 'partner.propose', companyId: CO, userEmail: AGENT, ...body };
  const res = await fetch(`${baseUrl}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (json.ok) return { ok: true, data: json.data };
  return { ok: false, error: json.error };
}

test('partner.propose: fuzzy duplicate against an existing partner succeeds with a warning (issue #226)', async (t) => {
  const srv = await startServer();
  t.after(async () => { await srv.cleanup(); });
  await seedCompany(srv.baseUrl);

  // Create an existing partner "Acme Corp" directly in the partners table.
  await apiPost(srv.baseUrl, 'partner.upsert', CO, {
    partner: { name: 'Acme Corp', is_vendor: true, is_customer: false },
  }, 'fz-upsert-acme');

  // Proposing "Acme Corp." (trailing period) — not an exact case-insensitive
  // match, but Dice 0.933 clears the fuzzy threshold. issue #226: this no
  // longer blocks the proposal — it succeeds, carrying a non-blocking
  // duplicate_warning for the human reviewer.
  const dup = await proposeRaw(srv.baseUrl, {
    name: 'Acme Corp.',
    evidence: { type: 'test', description: 'should be flagged, not blocked' },
  });
  assert.ok(dup.ok, `fuzzy duplicate proposal should still succeed; got ${JSON.stringify(dup)}`);
  assert.equal(dup.data.status, 'proposed');
  assert.ok(dup.data.duplicate_warning, 'expected a duplicate_warning on the response');
  assert.equal(dup.data.duplicate_warning.name, 'Acme Corp');
  assert.equal(dup.data.duplicate_warning.kind, 'partner');
  assert.ok(dup.data.duplicate_warning.similarity > 0.5);

  // A genuinely different name must succeed with no warning.
  const fresh = await proposeRaw(srv.baseUrl, {
    name: 'Totally Different Inc',
    evidence: { type: 'test', description: 'should succeed' },
  });
  assert.ok(fresh.ok, `unrelated proposal should succeed; got ${JSON.stringify(fresh)}`);
  assert.equal(fresh.data.status, 'proposed');
  assert.equal(fresh.data.duplicate_warning, null);
});

test('partner.propose: fuzzy duplicate against a pending proposal succeeds with a warning (issue #226)', async (t) => {
  const srv = await startServer();
  t.after(async () => { await srv.cleanup(); });
  await seedCompany(srv.baseUrl);

  // First proposal succeeds.
  const first = await proposeRaw(srv.baseUrl, {
    name: 'Beta Industries Ltd',
    evidence: { type: 'test', description: 'first proposal' },
  });
  assert.ok(first.ok, `first proposal should succeed; got ${JSON.stringify(first)}`);

  // Second proposal "Beta Industries Limited" clears the fuzzy threshold
  // against the pending proposal. issue #226: succeeds with a warning
  // instead of being rejected.
  const dup = await proposeRaw(srv.baseUrl, {
    name: 'Beta Industries Limited',
    evidence: { type: 'test', description: 'should be flagged, not blocked' },
  });
  assert.ok(dup.ok, `fuzzy duplicate of a pending proposal should still succeed; got ${JSON.stringify(dup)}`);
  assert.equal(dup.data.status, 'proposed');
  assert.ok(dup.data.duplicate_warning, 'expected a duplicate_warning on the response');
  assert.equal(dup.data.duplicate_warning.name, 'Beta Industries Ltd');
  assert.equal(dup.data.duplicate_warning.kind, 'proposal');
});

test('partner.propose: exact case-insensitive duplicate still rejected (phase 1 fast path)', async (t) => {
  const srv = await startServer();
  t.after(async () => { await srv.cleanup(); });
  await seedCompany(srv.baseUrl);

  await apiPost(srv.baseUrl, 'partner.upsert', CO, {
    partner: { name: 'Gamma Holdings', is_vendor: true, is_customer: false },
  }, 'fz-upsert-gamma');

  // Different case, same name → exact match fast path (phase 1), not fuzzy.
  const dup = await proposeRaw(srv.baseUrl, {
    name: 'gamma holdings',
    evidence: { type: 'test', description: 'exact case-insensitive duplicate' },
  });
  assert.equal(dup.ok, false);
  assert.equal(dup.error.code, 'CONFLICT');
  assert.match(dup.error.message, /already exists/);
});
