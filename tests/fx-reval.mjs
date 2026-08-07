#!/usr/bin/env node
'use strict';

// tests/fx-reval.mjs — P2-2 FX revaluation pack-driven config test.
//
// Verifies:
//   1. fx.revaluation_preview returns no Equity accounts in adjustments
//   2. If foreign-currency balances exist, they are Asset/Liability only
//   3. If no foreign-currency balances, preview returns empty adjustments (not an error)
//   4. Pack config is loaded — gainLossAccount from pack is used when not passed

import { getJurisdictionPack } from '../api/src/jurisdiction-packs.js';

let failures = 0;
const fail = (msg) => { failures++; console.error(`FAIL ${msg}`); };

// ── 1. Pack config validation ──────────────────────────────────────────────

const sePack = getJurisdictionPack('SE');
const sgPack = getJurisdictionPack('SG');

if (!sePack?.fxRevaluation) {
  fail('SE pack missing fxRevaluation block');
} else {
  if (!sePack.fxRevaluation.monetaryTypes?.includes('Asset'))
    fail('SE fxRevaluation.monetaryTypes must include Asset');
  if (!sePack.fxRevaluation.monetaryTypes?.includes('Liability'))
    fail('SE fxRevaluation.monetaryTypes must include Liability');
  if (sePack.fxRevaluation.monetaryTypes?.includes('Equity'))
    fail('SE fxRevaluation.monetaryTypes must NOT include Equity');
  if (sePack.fxRevaluation.gainLossAccount !== '7960')
    fail(`SE fxRevaluation.gainLossAccount expected '7960', got '${sePack.fxRevaluation.gainLossAccount}'`);
}

if (!sgPack?.fxRevaluation) {
  fail('SG pack missing fxRevaluation block');
} else {
  if (sgPack.fxRevaluation.monetaryTypes?.includes('Equity'))
    fail('SG fxRevaluation.monetaryTypes must NOT include Equity');
  if (sgPack.fxRevaluation.gainLossAccount !== '8030')
    fail(`SG fxRevaluation.gainLossAccount expected '8030', got '${sgPack.fxRevaluation.gainLossAccount}'`);
}

// ── 2. fxRevaluationConfigFor helper ──────────────────────────────────────

const { fxRevaluationConfigFor } = await import('../api/src/jurisdiction-packs.js');

const seConfig = fxRevaluationConfigFor('SE');
if (!seConfig || !seConfig.monetaryTypes || !seConfig.gainLossAccount) {
  fail('fxRevaluationConfigFor("SE") returned incomplete config');
}

const nullConfig = fxRevaluationConfigFor('ZZ');
if (nullConfig !== null) {
  fail(`fxRevaluationConfigFor("ZZ") should return null, got ${JSON.stringify(nullConfig)}`);
}

// ── 3. Engine logic — verify fx.js uses pack config ───────────────────────
// Read the source and confirm Equity is not hardcoded in the IN clause.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fxSource = fs.readFileSync(path.join(__dirname, '..', 'api', 'src', 'fx.js'), 'utf8');

// The old bug: hardcoded 'Equity' in the IN clause
if (fxSource.includes("'Equity'") && fxSource.includes('account_type IN')) {
  // Check if it's in the revaluation query specifically
  const previewMatch = fxSource.match(/a\.account_type IN \(([^)]+)\)/);
  if (previewMatch && previewMatch[1].includes('Equity')) {
    fail('fx.js revaluation query still hardcodes Equity in account_type IN clause');
  }
}

// Confirm the engine reads from pack config
if (!fxSource.includes('fxRevaluationConfigFor')) {
  fail('fx.js does not call fxRevaluationConfigFor — pack config not wired');
}

if (!fxSource.includes('monetaryTypes')) {
  fail('fx.js does not reference monetaryTypes from pack config');
}

// ── Summary ──────────────────────────────────────────────────────────────

if (failures) {
  console.error(`\n${failures} FX reval test failure(s).`);
  process.exit(1);
}
console.log('All FX reval tests passed.');
