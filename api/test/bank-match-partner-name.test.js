'use strict';
/**
 * #305 — one partner-name matcher for bank matching (mapping-utils
 * partnerNameMatch), used by tier-2 corroboration and tier 3.
 *
 * Also pins the tier-3 crash fixed alongside it: a partner-name hit
 * referenced an undefined `bestVendor` (left over from the vendors →
 * partners rename) and threw on every tier-3 match.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { partnerNameMatch } = require('../src/mapping-utils');
const { startTestServer, api, seedCompany, testDates } = require('../test-utils/helpers');

test('partnerNameMatch: whole name, truncation, abbreviation; no false hits', () => {
  const cases = [
    ['KORTKÖP NORTHSTAR 2026-10-03', 'NorthStar Pte Ltd', 'name'],
    ['BG NORTH STAR 0412',           'NorthStar Pte Ltd', 'name'],
    ['ICA SUPERMARKET',              'Ica AB',            'name'],
    ['VOLVO CARS',                   'AB Volvo',          'name'],
    ['NORTHST',                      'NorthStar Pte Ltd', 'prefix'],
    ['TELIA SVERIGE',                'Telia Company AB',  'prefix'],
    ['NORTHSTARPTE',                 'NorthStar Pte Ltd', 'prefix'],
    ['NSTAR 123456',                 'NorthStar Pte Ltd', 'abbrev'],
    ['NETS 99',                      'Netflix Services AB', null], // too short to be its abbreviation
    ['MUSICAL STORE',                'Ica AB',            null],  // never inside a word
    ['ICAROS',                       'Ica AB',            null],  // short names need a whole word
    ['SWISH 0701234567',             'Telia AB',          null],
    ['AB',                           'AB Volvo',          null],
    ['BETALNING ABC',                'Acme AB',           null],
  ];
  for (const [desc, name, want] of cases) {
    assert.equal(partnerNameMatch(desc, name), want, `${desc} vs ${name}`);
  }
});

let srv, baseUrl, BANK, EXP, AP, partnerId;
const CO = 'pnm_co';
const TD = testDates();

before(async () => {
  srv = await startTestServer();
  baseUrl = srv.baseUrl;
  ({ AP, EXP } = await seedCompany(baseUrl, CO, { jurisdiction: 'SE', currency: 'SEK' }));
  const coa = await api(baseUrl, 'coa.list', { companyId: CO });
  const accts = coa.body.data || [];
  BANK = (accts.find(a => a.default_role === 'Cash') || accts.find(a => a.account_code === '1930')
    || accts.find(a => a.cf_category === 'Cash')).account_code;
  AP = AP || (accts.find(a => a.default_role === 'AP') || accts.find(a => a.account_code === '2440')).account_code;
  const p = await api(baseUrl, 'partner.upsert', { companyId: CO,
    partner: { name: 'NorthStar Pte Ltd', default_currency: 'SEK', default_expense_account: EXP } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const list = await api(baseUrl, 'partner.list', { companyId: CO });
  partnerId = (list.body.data || []).find(x => x.name === 'NorthStar Pte Ltd').partner_id;
});
after(async () => { if (srv) await srv.cleanup(); });

function match(amount, description) {
  return api(baseUrl, 'bank.match', { companyId: CO, bankAccount: BANK,
    line: { date: TD.day21, amount: -amount, description } });
}

test('tier 3: an abbreviated partner name matches (and no longer crashes)', async () => {
  const m = await match(250, 'KORTKÖP NSTAR 0412');
  assert.equal(m.status, 200, JSON.stringify(m.body));
  const d = m.body.data;
  assert.equal(d.tier, 3);
  assert.equal(d.confidence.counterparty.value, partnerId);
  assert.match(d.evidence[0].description, /\(abbrev\)/);
  assert.equal(d.suggested_dimensions.counterparty, partnerId);
});

test('tier 2: an abbreviated partner name corroborates an open-bill match', async () => {
  const b = await api(baseUrl, 'bill.create', { companyId: CO, bill: {
    partner_name: 'NorthStar Pte Ltd', vendor_ref: 'NS-305', date: TD.day20, due_date: TD.day25,
    currency: 'SEK', ap_account: AP,
    lines: [{ description: 'Goods', expense_account: EXP, amount: 1000 }] } });
  assert.equal(b.status, 200, JSON.stringify(b.body));

  const plain = await match(990, 'BETALNING');          // 1% short: early-payment discount
  const named = await match(990, 'BETALNING NSTAR');
  assert.equal(plain.body.data.tier, 2, JSON.stringify(plain.body));
  assert.equal(named.body.data.tier, 2, JSON.stringify(named.body));
  const c0 = plain.body.data.confidence.account.confidence;
  const c1 = named.body.data.confidence.account.confidence;
  assert.ok(Math.abs((c1 - c0) - 0.10) < 1e-9, `corroboration adds 0.10 (got ${c0} → ${c1})`);
});
