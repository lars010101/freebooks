'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// fb-command.js is a browser IIFE that sets window.FB.command.
// We simulate a minimal browser env to load and test it.
// In browsers, `window.FB = ...` also creates global `FB`. To replicate
// that in Node, we alias window → global so property writes land on the
// global object and bare `FB` references resolve.
global.window = global;
global.document = { createElement: function() { return { style: {}, classList: { add: function(){}, remove: function(){} } }; } };

// :show command reads from window.FB_ROUTES (nav-registry) and window.FB_REPORT_IDS
// (report-registry) at parse time. Set these before eval'ing fb-command.js.
global.window.FB_ROUTES = [
  { key: 'inbox', route: '/:company', tabs: [] },
  { key: 'bank', route: '/:company/bank', tabs: [] },
  { key: 'payables', route: '/:company/payables', tabs: [
    { id: 'bills', label: 'Bills' },
    { id: 'partners', label: 'Partners' }
  ]},
  { key: 'reports', route: '/:company/reports', tabs: [] },
  { key: 'periods', route: '/:company/periods', tabs: [] },
  { key: 'settings', route: '/:company/settings', tabs: [
    { id: 'company', label: 'Company' },
    { id: 'coa', label: 'Chart of Accounts', aliases: ['accounts'] },
    { id: 'vat', label: 'Tax Codes' },
    { id: 'journals', label: 'Journals', aliases: ['books'] },
    { id: 'fxrates', label: 'Exchange Rates', aliases: ['rates'] },
    { id: 'ai', label: 'AI' },
    { id: 'opening-balances', label: 'Opening Balances', aliases: ['ob'] }
  ]}
];
global.window.FB_REPORT_IDS = ['pl','bs','cf','sce','voucher-register','tb','gl','journal','integrity','ap-aging','ap-control','ar'];

// Load the IIFE
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'fb-command.js'), 'utf8');
eval(src);

const cmd = global.window.FB.command;

test('tokenize: basic whitespace split', () => {
  const r = cmd.tokenize('post 500 supplies');
  assert.deepStrictEqual(r.tokens, ['post', '500', 'supplies']);
  assert.strictEqual(r.bang, false);
});

test('tokenize: quoted multi-word entity', () => {
  const r = cmd.tokenize('bill "Nordic Freight AB" 1200');
  assert.deepStrictEqual(r.tokens, ['bill', 'Nordic Freight AB', '1200']);
});

test('tokenize: trailing bang', () => {
  const r = cmd.tokenize('post 500 supplies from cash !');
  assert.deepStrictEqual(r.tokens, ['post', '500', 'supplies', 'from', 'cash']);
  assert.strictEqual(r.bang, true);
});

test('parseDate: today', () => {
  const d = cmd.parseDate('today');
  assert.strictEqual(d, new Date().toISOString().slice(0, 10));
});

test('parseDate: +30d', () => {
  const d = cmd.parseDate('+30d');
  const exp = new Date();
  exp.setDate(exp.getDate() + 30);
  assert.strictEqual(d, exp.toISOString().slice(0, 10));
});

test('parseDate: sep15', () => {
  const d = cmd.parseDate('sep15');
  assert.strictEqual(d, new Date().getFullYear() + '-09-15');
});

test('parseDate: 2026-09-15', () => {
  assert.strictEqual(cmd.parseDate('2026-09-15'), '2026-09-15');
});

test('parseDate: invalid', () => {
  assert.strictEqual(cmd.parseDate('xyz'), null);
});

test('parse: :post 500 supplies from cash', () => {
  const r = cmd.parse(':post 500 supplies from cash');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.alias, 'post');
  assert.strictEqual(r.parsed.commitMode, 'form');
  assert.strictEqual(r.parsed.prefill.amount, 500);
  assert.strictEqual(r.parsed.prefill.account, 'supplies');
  assert.strictEqual(r.parsed.prefill.fromAccount, 'cash');
});

test('parse: :post! 500 supplies from cash', () => {
  const r = cmd.parse(':post 500 supplies from cash !');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.alias, 'post');
  assert.strictEqual(r.parsed.commitMode, 'direct');
  assert.strictEqual(r.parsed.params.amount, 500);
});

test('parse: :bill acme 1200 due sep15', () => {
  const r = cmd.parse(':bill acme 1200 due sep15');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.alias, 'bill');
  assert.strictEqual(r.parsed.action, 'bill.draft.save');
  assert.strictEqual(r.parsed.params.partner, 'acme');
  assert.strictEqual(r.parsed.params.amount, 1200);
  assert.ok(r.parsed.params.date);
});

test('parse: :bill acme 1200 vat 240', () => {
  const r = cmd.parse(':bill acme 1200 vat 240');
  assert.strictEqual(r.type, 'alias');
  assert.ok(r.parsed.params.lines);
  assert.strictEqual(r.parsed.params.lines[0].vat_amount, 240);
});

test('parse: :bill acme 1200 net 960', () => {
  const r = cmd.parse(':bill acme 1200 net 960');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.parsed.params.lines[0].amount, 960);
  assert.strictEqual(r.parsed.params.lines[0].vat_amount, 240);
});

test('parse: :bill acme 1200 rc', () => {
  const r = cmd.parse(':bill acme 1200 rc');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.parsed.params.lines[0].vat_code, 'RC');
  assert.ok(r.parsed.warnings.length > 0);
});

test('parse: :bill "Nordic Freight AB" 1200', () => {
  const r = cmd.parse(':bill "Nordic Freight AB" 1200');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.parsed.params.partner, 'Nordic Freight AB');
});

test('parse: :je', () => {
  const r = cmd.parse(':je');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.parsed.route, '/journal/new');
});

test('parse: :show settings', () => {
  const r = cmd.parse(':show settings');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.alias, 'show');
  assert.strictEqual(r.parsed.route, '/settings');
  assert.strictEqual(r.parsed.commitMode, 'navigate');
});

test('parse: :show coa', () => {
  const r = cmd.parse(':show coa');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.parsed.route, '/settings?tab=coa');
  assert.strictEqual(r.parsed.commitMode, 'navigate');
});

test('parse: :show ob (alias → opening-balances)', () => {
  const r = cmd.parse(':show ob');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.parsed.route, '/settings?tab=opening-balances');
});

test('parse: :show bills', () => {
  const r = cmd.parse(':show bills');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.parsed.route, '/payables?tab=bills');
});

test('parse: :show pl (report id)', () => {
  const r = cmd.parse(':show pl');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.parsed.route, '/reports?t=pl');
  assert.strictEqual(r.parsed.commitMode, 'navigate');
});

test('parse: :show pl q2 (report + period)', () => {
  const r = cmd.parse(':show pl q2');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.parsed.route, '/reports?t=pl&period=q2');
});

test('parse: :show coa q2 (screen tab doesn\'t take period)', () => {
  const r = cmd.parse(':show coa q2');
  assert.strictEqual(r.type, 'unknown');
  assert.ok(r.error.indexOf("doesn't take a period") !== -1);
});

test('parse: :show frobnicate (unknown target)', () => {
  const r = cmd.parse(':show frobnicate');
  assert.strictEqual(r.type, 'unknown');
  assert.ok(r.error.indexOf('unknown target') !== -1);
  assert.ok(r.error.indexOf('Valid:') !== -1);
});

test('parse: :show! pl (bang not supported)', () => {
  const r = cmd.parse(':show! pl');
  assert.strictEqual(r.type, 'unknown');
  assert.ok(r.error.indexOf('does not support !') !== -1);
});

test('parse: :report pl (renamed hint)', () => {
  const r = cmd.parse(':report pl');
  assert.strictEqual(r.type, 'unknown');
  assert.ok(r.error.indexOf('is now :show') !== -1);
});

test('grammarFor: show returns usage string', () => {
  const g = cmd.grammarFor('show');
  assert.ok(g && g.indexOf('<screen|tab|report>') !== -1);
});

test('parse: :show (no args)', () => {
  const r = cmd.parse(':show');
  assert.strictEqual(r.type, 'unknown');
  assert.ok(r.error.indexOf('usage') !== -1);
});

test('parse: :rate eur 1.09', () => {
  const r = cmd.parse(':rate eur 1.09');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.parsed.params.currency, 'EUR');
  assert.strictEqual(r.parsed.params.rate, 1.09);
});

test('parse: :partner add "Acme Corp" net30', () => {
  const r = cmd.parse(':partner add "Acme Corp" net30');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.parsed.params.name, 'Acme Corp');
  assert.strictEqual(r.parsed.params.paymentTermsDays, 30);
});

test('parse: :token create agent-hermes', () => {
  const r = cmd.parse(':token create agent-hermes');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.parsed.action, 'auth.token.create');
  assert.strictEqual(r.parsed.params.name, 'agent-hermes');
});

test('parse: :lock aug', () => {
  const r = cmd.parse(':lock aug');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.parsed.params.period, 'aug');
  assert.strictEqual(r.parsed.params.locked, true);
});

test('parse: :unlock aug', () => {
  const r = cmd.parse(':unlock aug');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.parsed.params.locked, false);
});

test('parse: raw catalog action', () => {
  const r = cmd.parse(':journal.propose companyId=abc');
  assert.strictEqual(r.type, 'raw');
  assert.strictEqual(r.action, 'journal.propose');
});

test('parse: unknown command', () => {
  const r = cmd.parse(':frobnicate');
  assert.strictEqual(r.type, 'unknown');
  assert.ok(r.error);
});

test('parse: empty', () => {
  const r = cmd.parse(':');
  assert.strictEqual(r.type, 'empty');
});

test('parse: bang on non-bang alias rejected', () => {
  const r = cmd.parse(':bill acme 1200 !');
  assert.strictEqual(r.type, 'unknown');
  assert.ok(r.error.indexOf('does not support !') !== -1);
});

test('parse: missing args', () => {
  const r = cmd.parse(':post');
  assert.strictEqual(r.type, 'unknown');
  assert.ok(r.error.indexOf('usage') !== -1);
});

test('parseSearchScope: /p:acme', () => {
  const r = cmd.parseSearchScope('/p:acme');
  assert.strictEqual(r.scope, 'partner');
  assert.strictEqual(r.query, 'acme');
});

test('parseSearchScope: /a:cash', () => {
  const r = cmd.parseSearchScope('/a:cash');
  assert.strictEqual(r.scope, 'account');
  assert.strictEqual(r.query, 'cash');
});

test('parseSearchScope: /j:1023', () => {
  const r = cmd.parseSearchScope('/j:1023');
  assert.strictEqual(r.scope, 'journal');
  assert.strictEqual(r.query, '1023');
});

test('parseSearchScope: /b:', () => {
  const r = cmd.parseSearchScope('/b:');
  assert.strictEqual(r.scope, 'bill');
  assert.strictEqual(r.query, '');
});

test('parseSearchScope: unscoped', () => {
  const r = cmd.parseSearchScope('/acme');
  assert.strictEqual(r.scope, null);
  assert.strictEqual(r.query, 'acme');
});

test('grammarFor: returns grammar string for known alias', () => {
  const g = cmd.grammarFor('bill');
  assert.ok(g && g.indexOf('<partner>') !== -1);
});

test('grammarFor: null for unknown alias', () => {
  assert.strictEqual(cmd.grammarFor('frobnicate'), null);
});
