'use strict';/**
 * Fuzzy duplicate detection for partner proposals — issue #130.
 *
 * Covers:
 *   1. trigramSimilarity() unit tests (mapping-utils.js)
 *   2. partner.propose server-side fuzzy duplicate detection against an
 *      EXISTING partner (partners.js proposePartner phase 2)
 *   3. partner.propose fuzzy duplicate detection against a PENDING proposal
 *
 * Two-phase detection (issue #130): a fast SQL exact case-insensitive match
 * (phase 1) is followed by a trigram Jaccard fuzzy match (phase 2, threshold
 * 0.65) over the in-scope rows. The fuzzy phase catches near-duplicates that
 * differ by punctuation/formatting and would slip past the exact match.
 *
 * NOTE on test pair selection: the trigram metric is Jaccard over character
 * trigrams (|A∩B| / |A∪B|), so similarity drops sharply when the candidate is
 * much longer than the query. Some intuitively "similar" pairs score below the
 * 0.65 threshold — e.g. "Acme Corp" vs "Acme Corporation" = 0.50, "Netflix Inc"
 * vs "Netflix International BV" = 0.35. The API tests below use pairs whose
 * Jaccard similarity actually exceeds 0.65 (computed and noted inline) so the
 * conflict path is genuinely exercised. The threshold (0.65) is the value
 * mandated by the issue; it can be tuned later if duplicate proposals become
 * noisy at scale.
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

test('trigramSimilarity: near-duplicate shares many trigrams (> 0.3)', () => {
  // "Netflix Inc" vs "Netflix International BV" → Jaccard 0.3478. The longer
  // name dilutes the union, but the shared "netflix i..." prefix still yields a
  // meaningful score far above unrelated names.
  const s = trigramSimilarity('Netflix Inc', 'Netflix International BV');
  assert.ok(s > 0.3, `expected > 0.3, got ${s}`);
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
  // Grant an agent role so partner.propose (role 'agent') can run with a
  // populated created_by. permissions.save requires role 'owner', but the
  // permission gate is skipped when no userEmail is asserted on the request.
  await apiPost(baseUrl, 'permissions.save', CO, {
    permissions: [{ email: AGENT, role: 'agent' }],
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

test('partner.propose: fuzzy duplicate against an existing partner is rejected', async (t) => {
  const srv = await startServer();
  t.after(async () => { await srv.cleanup(); });
  await seedCompany(srv.baseUrl);

  // Create an existing partner "Acme Corp" directly in the partners table.
  await apiPost(srv.baseUrl, 'partner.upsert', CO, {
    partner: { name: 'Acme Corp', is_vendor: true, is_customer: false },
  }, 'fz-upsert-acme');

  // Proposing "Acme Corp." (trailing period) — not an exact case-insensitive
  // match, but Jaccard 0.875 > 0.65 → must be rejected as a fuzzy duplicate.
  const dup = await proposeRaw(srv.baseUrl, {
    name: 'Acme Corp.',
    evidence: { type: 'test', description: 'should be a fuzzy duplicate' },
  });
  assert.equal(dup.ok, false, 'fuzzy duplicate proposal should be rejected');
  assert.equal(dup.error.code, 'CONFLICT');
  assert.match(dup.error.message, /similar name already exists/);
  assert.match(dup.error.message, /Acme Corp/);
  assert.match(dup.error.message, /similarity: \d+\.\d{2}/);

  // A genuinely different name must succeed.
  const fresh = await proposeRaw(srv.baseUrl, {
    name: 'Totally Different Inc',
    evidence: { type: 'test', description: 'should succeed' },
  });
  assert.ok(fresh.ok, `unrelated proposal should succeed; got ${JSON.stringify(fresh)}`);
  assert.equal(fresh.data.status, 'proposed');
});

test('partner.propose: fuzzy duplicate against a pending proposal is rejected', async (t) => {
  const srv = await startServer();
  t.after(async () => { await srv.cleanup(); });
  await seedCompany(srv.baseUrl);

  // First proposal succeeds.
  const first = await proposeRaw(srv.baseUrl, {
    name: 'Beta Industries Ltd',
    evidence: { type: 'test', description: 'first proposal' },
  });
  assert.ok(first.ok, `first proposal should succeed; got ${JSON.stringify(first)}`);

  // Second proposal "Beta Industries Limited" — Jaccard 0.6522 > 0.65 → must be
  // rejected as a fuzzy duplicate of the pending proposal.
  const dup = await proposeRaw(srv.baseUrl, {
    name: 'Beta Industries Limited',
    evidence: { type: 'test', description: 'should be a fuzzy duplicate' },
  });
  assert.equal(dup.ok, false, 'fuzzy duplicate of a pending proposal should be rejected');
  assert.equal(dup.error.code, 'CONFLICT');
  assert.match(dup.error.message, /similar name already exists/);
  assert.match(dup.error.message, /Beta Industries Ltd/);
  assert.match(dup.error.message, /similarity: \d+\.\d{2}/);
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
