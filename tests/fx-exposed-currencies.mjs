#!/usr/bin/env node
'use strict';

// tests/fx-exposed-currencies.mjs — fx-tracked-currency-scoping-spec test.
//
// Verifies the spec's key invariants at the source level (no running server
// needed — same approach as fx-reval.mjs):
//
//   1. getExposedCurrencies exists and is exported from fx.js
//   2. The query nets per (currency, account_code), not per currency alone
//      — the subquery groups by both columns before HAVING
//   3. Equity is excluded (monetary items only — IAS 21)
//   4. fx.exposed_currencies action is registered in the catalog
//   5. revaluationPreview sources its currency set from getExposedCurrencies
//   6. fx-scanner.js imports and calls getExposedCurrencies
//   7. exchange-rates.js calls fx.exposed_currencies (not partner.list)
//   8. The empty-state message matches the spec (no "configured" language)
//   9. schema.sql has the journal_entries index
//  10. The query uses a subquery + SELECT DISTINCT (not bare GROUP BY currency)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let failures = 0;
const fail = (msg) => { failures++; console.error(`FAIL ${msg}`); };

function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ── 1. getExposedCurrencies exists and is exported ─────────────────────────

const fxSource = readSrc('api/src/fx.js');

if (!fxSource.includes('async function getExposedCurrencies(')) {
  fail('fx.js does not define getExposedCurrencies');
}

const exportMatch = fxSource.match(/module\.exports\s*=\s*\{([^}]+)\}/);
if (!exportMatch || !exportMatch[1].includes('getExposedCurrencies')) {
  fail('fx.js does not export getExposedCurrencies');
}

// ── 2. Query nets per (currency, account_code) — the critical netting fix ──

// Extract the getExposedCurrencies function body
const funcMatch = fxSource.match(/async function getExposedCurrencies[\s\S]*?\n\}/);
if (!funcMatch) {
  fail('Could not extract getExposedCurrencies function body');
} else {
  const funcBody = funcMatch[0];

  // Must contain a subquery (SELECT DISTINCT ... FROM (...))
  if (!funcBody.includes('SELECT DISTINCT currency FROM (')) {
    fail('getExposedCurrencies does not use SELECT DISTINCT currency FROM subquery');
  }

  // Inner query must GROUP BY currency AND account_code (not just currency)
  if (!funcBody.includes('GROUP BY je.currency, je.account_code')) {
    fail('getExposedCurrencies inner query does not GROUP BY (currency, account_code) — netting bug');
  }

  // HAVING must be in the inner query, not the outer
  if (!funcBody.includes('HAVING SUM(je.debit - je.credit) != 0')) {
    fail('getExposedCurrencies missing HAVING SUM(debit - credit) != 0');
  }
}

// ── 3. Equity is excluded ──────────────────────────────────────────────────

// getExposedCurrencies should use fxRevaluationConfigFor, not hardcode Equity
const exposedFunc = funcMatch ? funcMatch[0] : '';
if (!exposedFunc.includes('fxRevaluationConfigFor')) {
  fail('getExposedCurrencies does not call fxRevaluationConfigFor — pack config not wired');
}
// Must NOT hardcode 'Equity' in the IN clause
if (exposedFunc.includes("'Equity'") && exposedFunc.includes('account_type IN')) {
  const inMatch = exposedFunc.match(/account_type IN \(([^)]+)\)/);
  if (inMatch && inMatch[1].includes('Equity')) {
    fail('getExposedCurrencies hardcodes Equity in account_type IN clause');
  }
}

// ── 4. fx.exposed_currencies action registered in catalog ──────────────────

const catalogSource = readSrc('api/src/action-catalog.js');

if (!catalogSource.includes("'fx.exposed_currencies'")) {
  fail('action-catalog.js does not register fx.exposed_currencies');
}

// Check the entry has role: 'viewer', mutating: false
const catalogEntry = catalogSource.match(/'fx\.exposed_currencies'[\s\S]*?\}/);
if (catalogEntry) {
  if (!catalogEntry[0].includes("role: 'viewer'")) {
    fail('fx.exposed_currencies catalog entry is not role viewer');
  }
  if (!catalogEntry[0].includes('mutating: false')) {
    fail('fx.exposed_currencies catalog entry is not non-mutating');
  }
} else {
  fail('Could not extract fx.exposed_currencies catalog entry');
}

// ── 4b. fx.exposed_currencies handler in fx.js ─────────────────────────────

if (!fxSource.includes("case 'fx.exposed_currencies'")) {
  fail('fx.js handleFx switch does not route fx.exposed_currencies');
}

if (!fxSource.includes('async function exposedCurrenciesAction(')) {
  fail('fx.js does not define exposedCurrenciesAction handler');
}

// ── 5. revaluationPreview calls getExposedCurrencies ───────────────────────

const previewMatch = fxSource.match(/async function revaluationPreview[\s\S]*?\n\}/);
if (!previewMatch) {
  fail('Could not extract revaluationPreview function body');
} else {
  if (!previewMatch[0].includes('getExposedCurrencies(')) {
    fail('revaluationPreview does not call getExposedCurrencies');
  }
}

// ── 6. fx-scanner.js imports and uses getExposedCurrencies ──────────────────

const scannerSource = readSrc('api/src/fx-scanner.js');

if (!scannerSource.includes('getExposedCurrencies')) {
  fail('fx-scanner.js does not import or use getExposedCurrencies');
}

// Must import from fx
if (!scannerSource.includes("require('./fx')") || !scannerSource.includes('getExposedCurrencies')) {
  fail('fx-scanner.js does not import getExposedCurrencies from fx.js');
}

// Must filter rows before insert
if (!scannerSource.includes('rowsToInsert') || !scannerSource.includes('exposedSet')) {
  fail('fx-scanner.js does not filter coverage rows by exposure before insert');
}

// ── 7. exchange-rates.js calls fx.exposed_currencies ──────────────────────
// (was master-data.js — IA restructure 2 moved Exchange Rates to its own page)

const exchangeRatesSource = readSrc('api/src/pages/exchange-rates.js');

if (!exchangeRatesSource.includes("'fx.exposed_currencies'")) {
  fail('exchange-rates.js does not call fx.exposed_currencies action');
}

// Must NOT use partner.list for currency tracking anymore
const loadTrackedMatch = exchangeRatesSource.match(/function loadTrackedForeignCurrencies[\s\S]*?\n\}/);
if (loadTrackedMatch) {
  if (loadTrackedMatch[0].includes('partner.list')) {
    fail('loadTrackedForeignCurrencies still uses partner.list — should use fx.exposed_currencies');
  }
  if (loadTrackedMatch[0].includes('default_currency')) {
    fail('loadTrackedForeignCurrencies still scans default_currency — should use fx.exposed_currencies');
  }
} else {
  fail('Could not extract loadTrackedForeignCurrencies from exchange-rates.js');
}

// ── 8. Empty-state message updated ─────────────────────────────────────────

if (!exchangeRatesSource.includes('No foreign-currency balances yet. This list populates once a bill or journal entry creates one.')) {
  fail('exchange-rates.js empty-state message not updated to spec text');
}

// Must NOT contain the old message
if (exchangeRatesSource.includes('No currencies configured for tracking. Add one on the Company attribute grid.')) {
  fail('exchange-rates.js still has old empty-state message referencing Company attribute grid');
}

// ── 9. schema.sql has the journal_entries index ────────────────────────────

const schemaSource = readSrc('db/schema.sql');

if (!schemaSource.includes('idx_journal_entries_company_currency_date')) {
  fail('schema.sql does not create idx_journal_entries_company_currency_date index');
}

// ── 10. Netting test case documented in spec ───────────────────────────────

const specSource = readSrc('docs/fx-tracked-currency-scoping-spec.md');
if (!specSource.includes('EUR receivable at +1,000 and a EUR payable')) {
  fail('Spec does not document the netting test case (§8.2)');
}

// ── Summary ────────────────────────────────────────────────────────────────

if (failures) {
  console.error(`\n${failures} FX exposed-currencies test failure(s).`);
  process.exit(1);
}
console.log('All FX exposed-currencies tests passed.');
