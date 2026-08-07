'use strict';
/**
 * freeBooks — jurisdiction pack loader.
 *
 * Reads `db/jurisdictions/<code>/jurisdiction.json` (path relative to the
 * repository root — resolved from this module's `__dirname/../..`) and caches
 * the parsed descriptor in a Map keyed by jurisdiction code. Returns `null`
 * when the pack file is missing or unparseable so callers can treat an
 * unknown jurisdiction as "no pack" without a thrown exception.
 *
 * Generic by design: a sibling workstream reuses this loader for non-contact
 * pack fields (tax attributes, reporting standards, …), so it exposes the
 * whole pack object plus the thin `contactAttributesFor(code)` helper used by
 * the Company settings registry and the SRU generator.
 */

const path = require('path');
const fs = require('fs');

const PACKS_DIR = path.resolve(__dirname, '../../db/jurisdictions');

const cache = new Map();

/**
 * Load (and cache) the jurisdiction pack descriptor for `code`.
 * @param {string} code Jurisdiction code, e.g. 'SE' / 'SG'.
 * @returns {object|null} The parsed pack, or null when the file is missing or
 *   fails to parse.
 */
function getJurisdictionPack(code) {
  if (!code) return null;
  const key = String(code);
  if (cache.has(key)) return cache.get(key);
  let pack = null;
  try {
    const filePath = path.join(PACKS_DIR, key, 'jurisdiction.json');
    const raw = fs.readFileSync(filePath, 'utf8');
    pack = JSON.parse(raw);
  } catch (e) {
    pack = null;
  }
  cache.set(key, pack);
  return pack;
}

/**
 * Contact attributes declared by the pack (adresses/postnr/postort/contact_*
 * for SE). Returns `[]` when the pack is missing or declares none.
 * @param {string} code Jurisdiction code.
 * @returns {Array<{key:string,label:string,format?:string,required?:boolean}>}
 */
function contactAttributesFor(code) {
  const pack = getJurisdictionPack(code);
  return (pack && Array.isArray(pack.contactAttributes)) ? pack.contactAttributes : [];
}

/**
 * Integration declared by the pack (`integrations.<name>`), e.g.
 * `packIntegration('SE', 'sie')` → `{ export: true, import: true }`.
 * Returns `null` when the pack is missing or declares no such integration —
 * callers treat null as "not available for this jurisdiction".
 * @param {string} code Jurisdiction code.
 * @param {string} name Integration name (e.g. 'sie').
 * @returns {object|null}
 */
function packIntegration(code, name) {
  const pack = getJurisdictionPack(code);
  const integ = pack && pack.integrations && pack.integrations[name];
  return integ || null;
}

/**
 * Closing configuration declared by the pack (`closing.required`,
 * `closing.retainedEarningsAccount`, `closing.closingAccount`).
 * Returns `null` when the pack is missing or declares no closing block.
 * @param {string} code Jurisdiction code.
 * @returns {{required:boolean, retainedEarningsAccount:string, closingAccount:string}|null}
 */
function closingConfigFor(code) {
  const pack = getJurisdictionPack(code);
  if (!pack || !pack.closing) return null;
  return pack.closing;
}

/**
 * FX revaluation configuration declared by the pack (`fxRevaluation.monetaryTypes`,
 * `fxRevaluation.gainLossAccount`). Returns `null` when the pack is missing or
 * declares no fxRevaluation block — callers fall back to a safe default
 * (['Asset', 'Liability'] — no Equity, per IAS 21).
 * @param {string} code Jurisdiction code.
 * @returns {{monetaryTypes:string[], gainLossAccount:string}|null}
 */
function fxRevaluationConfigFor(code) {
  const pack = getJurisdictionPack(code);
  if (!pack || !pack.fxRevaluation) return null;
  return pack.fxRevaluation;
}

module.exports = { getJurisdictionPack, contactAttributesFor, packIntegration, closingConfigFor, fxRevaluationConfigFor };
