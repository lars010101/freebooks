'use strict';
/**
 * freeBooks — SRU MEDIELEV contact attributes (Skatteverket rejection fix)
 *
 * Skatteverket rejected the produced SRU files at submission: #POSTNR and
 * #POSTORT in INFO.SRU's #MEDIELEV block are mandatory but were emitted
 * blank. Contact attributes are declared per jurisdiction pack
 * (jurisdiction.json contactAttributes), surfaced on the Company settings
 * registry (company.attr.list/save), and validated before SRU generation.
 *
 * Run: npm test  (in api/)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, seedCompany } = require('../test-utils/helpers');

let srv;
let baseUrl;
const SE = 'SRUC_SE';
const SG = 'SRUC_SG';

before(async () => {
  srv = await startTestServer({ withAdminToken: true });
  baseUrl = srv.baseUrl;
  await seedCompany(baseUrl, SE, { jurisdiction: 'SE', currency: 'SEK' });
  await seedCompany(baseUrl, SG, { jurisdiction: 'SG', currency: 'SGD' });
});

after(async () => { await srv.cleanup(); });

// ── 1. Pack-driven registry rows ─────────────────────────────────────────────

test('company.attr.list: SE shows required postnr/postort rows; SG shows its own pack rows', async () => {
  const se = await api(baseUrl, 'company.attr.list', { companyId: SE });
  assert.equal(se.status, 200, JSON.stringify(se.body));
  const seKeys = se.body.data.map((r) => r.key);
  assert.ok(seKeys.includes('contact_postnr'), 'SE has contact_postnr');
  assert.ok(seKeys.includes('contact_postort'), 'SE has contact_postort');
  const postnr = se.body.data.find((r) => r.key === 'contact_postnr');
  assert.equal(postnr.note, 'Required for SRU filing', 'required attr carries the note');

  const sg = await api(baseUrl, 'company.attr.list', { companyId: SG });
  assert.equal(sg.status, 200, JSON.stringify(sg.body));
  const sgKeys = sg.body.data.map((r) => r.key);
  assert.ok(sgKeys.includes('contact_postal_code'), 'SG has its own contact_postal_code');
  assert.ok(!sgKeys.includes('contact_postnr'), 'SG has no SE postnr row');
});

// ── 2. Server-side format validation ─────────────────────────────────────────

test('company.attr.save: postnr format validated (5 digits, space optional)', async () => {
  const bad = await api(baseUrl, 'company.attr.save', { companyId: SE, key: 'contact_postnr', value: '1234' });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.match(bad.body.error.message, /5 digits/);

  const bad2 = await api(baseUrl, 'company.attr.save', { companyId: SE, key: 'contact_postnr', value: 'abcdef' });
  assert.equal(bad2.status, 400);

  const ok1 = await api(baseUrl, 'company.attr.save', { companyId: SE, key: 'contact_postnr', value: '114 51' });
  assert.equal(ok1.status, 200, JSON.stringify(ok1.body));
  const ok2 = await api(baseUrl, 'company.attr.save', { companyId: SE, key: 'contact_postnr', value: '11451' });
  assert.equal(ok2.status, 200);
  // Reset to blank (blank is allowed at save time; generation is the gate).
  const clr = await api(baseUrl, 'company.attr.save', { companyId: SE, key: 'contact_postnr', value: '' });
  assert.equal(clr.status, 200);
});

test('company.attr.save: undeclared contact key rejected', async () => {
  const r = await api(baseUrl, 'company.attr.save', { companyId: SE, key: 'contact_postal_code', value: 'x' });
  assert.equal(r.status, 400, 'SE pack declares no postal_code');
});

// ── 3. Generation gate (blank state) ─────────────────────────────────────────

test('SRU generation blocked with 400 when required contact attrs are blank', async () => {
  const info = await fetch(`${baseUrl}/api/${SE}/sru/info?year=2025`);
  assert.equal(info.status, 400);
  const infoBody = await info.json();
  assert.match(infoBody.error, /Postal code/);
  assert.match(infoBody.error, /City/);
  assert.match(infoBody.error, /Settings/);

  const ink2 = await fetch(`${baseUrl}/api/${SE}/sru/ink2?year=2025`);
  assert.equal(ink2.status, 400, 'short-circuits before compute on empty books');
  const ink2Body = await ink2.json();
  assert.match(ink2Body.error, /Postal code/);
});

// ── 4. Populated MEDIELEV + contact fallback ─────────────────────────────────

test('INFO.SRU carries #POSTNR/#POSTORT; contact params override stored attrs', async () => {
  await api(baseUrl, 'company.attr.save', { companyId: SE, key: 'contact_postnr', value: '114 51' });
  await api(baseUrl, 'company.attr.save', { companyId: SE, key: 'contact_postort', value: 'Stockholm' });
  // Registry keys are `contact_` + pack attribute key — the pack's contact-person
  // keys already start with contact_, hence contact_contact_name.
  const cn = await api(baseUrl, 'company.attr.save', { companyId: SE, key: 'contact_contact_name', value: 'Lars' });
  assert.equal(cn.status, 200, JSON.stringify(cn.body));

  const info = await fetch(`${baseUrl}/api/${SE}/sru/info?year=2025`);
  assert.equal(info.status, 200);
  const text = await info.text();
  assert.ok(text.includes('#POSTNR 11451'), 'postnr populated, whitespace stripped (Skatteverket format)');
  assert.ok(text.includes('#POSTORT Stockholm'), 'postort populated');
  assert.ok(text.includes('#KONTAKT Lars'), 'stored contact_name used as fallback');

  const over = await fetch(`${baseUrl}/api/${SE}/sru/info?year=2025&kontakt=Anna`);
  const overText = await over.text();
  assert.ok(overText.includes('#KONTAKT Anna'), 'query param wins over stored attr');
});

// ── 5. check=1 warns instead of blocking ─────────────────────────────────────

test('ink2 ?check=1 appends contact problems to warnings, never blocks', async () => {
  // SE2: nothing set → problems exist, but the check flow must stay usable.
  const SE2 = 'SRUC_SE2';
  await seedCompany(baseUrl, SE2, { jurisdiction: 'SE', currency: 'SEK' });
  // computeSru needs a defined period for the requested year.
  const p = await api(baseUrl, 'period.upsert', {
    companyId: SE2,
    period: { period_id: '2025', start_date: '2025-01-01', end_date: '2025-12-31' },
  });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const r = await fetch(`${baseUrl}/api/${SE2}/sru/ink2?year=2025&check=1`);
  assert.equal(r.status, 200, 'check flow never blocked');
  const body = await r.json();
  const joined = (body.warnings || []).join(' | ');
  assert.match(joined, /Postal code is required/);
  assert.match(joined, /City is required/);
});
