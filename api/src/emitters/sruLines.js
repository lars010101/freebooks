'use strict';
/**
 * freeBooks — SRU (Skatteverket) `#UPPGIFT` line emitter.
 *
 * Format emitter for the INK2 / INK2R / INK2S blanket blocks. Shared across
 * every jurisdiction pack whose filing descriptor sets `"emitter": "sruLines"`.
 * Descriptors are data; emitters are code. See docs/jurisdiction-pack.md §3/§5.
 *
 * Exported:
 *   emitSru(computed, descriptor, year) → blanketter.sru text
 *   emitInfo(company, params)            → INFO.SRU text
 *   ymd, roundHalfUp                       (shared helpers)
 *   ORDERS                                 (per-blankett #UPPGIFT order tables)
 */

const path = require('path');
const fs = require('fs');

// Standard half-up rounding of the absolute value, per spec.
function roundHalfUp(x) {
  return Math.round(Math.abs(x));
}

// Pad a 2-digit month/day.
function pad2(n) { return String(n).padStart(2, '0'); }

// YYYYMMDD from a date-ish value (handles 'YYYY-MM-DD' and Date).
function ymd(dateVal) {
  const s = String(dateVal);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + m[2] + m[3];
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
  return s.replace(/-/g, '');
}

// "YYYYMMDD HHMMSS" timestamp token for #IDENTITET / #SKAPAD.
function timestampToken(d) {
  d = d || new Date();
  return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) +
    ' ' + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds());
}

// Strip non-digits from a tax_id ("556880-6854" → "5568806854") and prefix "16".
function orgnrKey(taxId) {
  const digits = String(taxId || '').replace(/\D+/g, '');
  return '16' + digits;
}

function packageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
    return pkg.version || '1.0.0';
  } catch (e) {
    return '1.0.0';
  }
}

// ── Blanket block emitter ───────────────────────────────────────────────────
// Order of #UPPGIFT codes within each blanket (spec field order).
const INK2_ORDER = ['7011', '7012', '7104', '7114'];
const INK2R_ORDER = ['7011', '7012', '7251', '7261', '7281', '7301', '7302', '7365', '7368', '7513', '7417', '7450', '7550'];
const INK2S_ORDER = ['7011', '7012', '7650', '7750', '7754', '7763', '7670', '7770', '8041', '8045'];

const ORDERS = { INK2: INK2_ORDER, INK2R: INK2R_ORDER, INK2S: INK2S_ORDER };

function emitBlanket(version, identity, name, fields, order) {
  const lines = [];
  lines.push(`#BLANKETT ${version}`);
  lines.push(`#IDENTITET ${identity}`);
  lines.push(`#NAMN ${name}`);
  for (const code of order) {
    if (fields[code] !== undefined && fields[code] !== null) {
      lines.push(`#UPPGIFT ${code} ${fields[code]}`);
    }
  }
  lines.push(`#BLANKETTSLUT`);
  return lines.join('\n');
}

// buildSruText reworked: emitSru(computed, descriptor, year).
// Blanket version token = `<BLANKETT>-` + descriptor.version with {year} replaced
// (e.g. INK2-2024P4). Blocks joined with '\n' + '\n#FIL_SLUT\n'.
function emitSru(computed, descriptor, year) {
  const { fields, company } = computed;
  const identity = orgnrKey(company.tax_id) + ' ' + timestampToken();
  const name = company.company_name;
  const yr = year;
  const versionToken = descriptor.version.replace('{year}', String(yr));
  const blocks = (descriptor.blanketts || []).map((b) => {
    const version = `${b}-${versionToken}`;
    return emitBlanket(version, identity, name, fields[b], ORDERS[b]);
  });
  return blocks.join('\n') + '\n#FIL_SLUT\n';
}

// ── INFO.SRU ────────────────────────────────────────────────────────────────
// `contact` = company's stored contact_* settings keyed by pack attribute
// (contact_address stripped → address). Query params win over stored attrs
// for the person fields; #ADRESS/#POSTNR/#POSTORT come from stored attrs only
// (Skatteverket rejects blank #POSTNR/#POSTORT — see validateSruContact gate
// in filings.js, which runs before this emitter is reached).
function emitInfo(company, params, contact = {}) {
  const ts = timestampToken();
  const ver = packageVersion();
  const orgnr = orgnrKey(company.tax_id);
  const lines = [
    `#DATABESKRIVNING_START`,
    `#PRODUKT SRU`,
    `#SKAPAD ${ts}`,
    `#PROGRAM freebooks ${ver}`,
    `#FILNAMN BLANKETTER.SRU`,
    `#DATABESKRIVNING_SLUT`,
    `#MEDIELEV_START`,
    `#ORGNR ${orgnr}`,
    `#NAMN ${company.company_name}`,
    `#ADRESS ${contact.address || ''}`,
    // Skatteverket wants the zip as 5 bare digits — strip any stored
    // whitespace ("114 51" → "11451"); magnus 2026-08-02.
    `#POSTNR ${String(contact.postnr || '').replace(/\s+/g, '')}`,
    `#POSTORT ${contact.postort || ''}`,
    `#AVDELNING `,
    `#KONTAKT ${params.kontakt || contact.contact_name || ''}`,
    `#EMAIL ${params.email || contact.contact_email || ''}`,
    `#TELEFON ${params.telefon || contact.contact_phone || ''}`,
    `#FAX `,
    `#MEDIELEV_SLUT`,
  ];
  return lines.join('\n') + '\n';
}

module.exports = { emitSru, emitInfo, ymd, roundHalfUp, ORDERS };
