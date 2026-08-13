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

test('parse: :post 500 supplies on sep15 uses "on" date slot', () => {
  const r = cmd.parse(':post 500 supplies on sep15');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.alias, 'post');
  assert.strictEqual(r.parsed.commitMode, 'form');
  assert.ok(r.parsed.prefill.date);
});

test('parse: :post 500 supplies due sep15 ignores "due" (bill-only keyword)', () => {
  const r = cmd.parse(':post 500 supplies due sep15');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.alias, 'post');
  assert.strictEqual(r.parsed.prefill.date, null);
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

test('parse: :je is now unknown (alias removed, v7)', () => {
  const r = cmd.parse(':je');
  assert.strictEqual(r.type, 'unknown');
});

test('grammarFor: :je returns null (alias removed, v7)', () => {
  assert.strictEqual(cmd.grammarFor('je'), null);
});

test('parse: :show has no structured flag (v6 — generalized mechanism)', () => {
  const a = cmd.ALIASES['show'];
  assert.ok(a, ':show is in ALIASES');
  assert.strictEqual(a.structured, undefined);
  assert.strictEqual(a.parse, undefined);
});

test('parse: :show something returns unknown with browse hint', () => {
  const r = cmd.parse(':show something');
  assert.strictEqual(r.type, 'unknown');
  assert.ok(r.error.indexOf('browse command') !== -1);
});

test('parse: :show with bang returns unknown (bang not supported)', () => {
  const r = cmd.parse(':show something !');
  assert.strictEqual(r.type, 'unknown');
  assert.ok(r.error.indexOf('does not support !') !== -1);
});

test('grammarFor: show returns <target>', () => {
  const g = cmd.grammarFor('show');
  assert.ok(g && g.indexOf('<target>') !== -1);
});

// ── :new alias (v7) ────────────────────────────────────────────────────────

test('parse: :new is in ALIASES with no parse function', () => {
  const a = cmd.ALIASES['new'];
  assert.ok(a, ':new is in ALIASES');
  assert.strictEqual(a.structured, undefined);
  assert.strictEqual(a.parse, undefined);
});

test('grammarFor: new returns <target>', () => {
  const g = cmd.grammarFor('new');
  assert.ok(g && g.indexOf('<target>') !== -1);
});

// ── :report alias (v6 — show-command-spec §5) ─────────────────────────────

test('parse: :report pl', () => {
  const r = cmd.parse(':report pl');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.alias, 'report');
  assert.strictEqual(r.parsed.route, '/reports?t=pl');
});

test('parse: :report pl q2', () => {
  const r = cmd.parse(':report pl q2');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.parsed.route, '/reports?t=pl&period=q2');
});

test('parse: :report voucher-register', () => {
  const r = cmd.parse(':report voucher-register');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.parsed.route, '/reports?t=voucher-register');
});

test('parse: :report with no args → error', () => {
  const r = cmd.parse(':report');
  assert.strictEqual(r.type, 'unknown');
  assert.ok(r.error.indexOf('usage') !== -1);
});

test('grammarFor: report returns <type> [period]', () => {
  const g = cmd.grammarFor('report');
  assert.ok(g && g.indexOf('<type>') !== -1);
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

// ── :rate with optional date (2026-08-09) ──────────────────────────────────

test('parse: :rate eur 1.09 (no date — date null)', () => {
  const r = cmd.parse(':rate eur 1.09');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.parsed.params.currency, 'EUR');
  assert.strictEqual(r.parsed.params.rate, 1.09);
  assert.strictEqual(r.parsed.params.date, null);
});

test('parse: :rate eur 1.09 on 2026-01-15', () => {
  const r = cmd.parse(':rate eur 1.09 on 2026-01-15');
  assert.strictEqual(r.type, 'alias');
  assert.strictEqual(r.parsed.params.currency, 'EUR');
  assert.strictEqual(r.parsed.params.rate, 1.09);
  assert.strictEqual(r.parsed.params.date, '2026-01-15');
});

test('parse: :rate eur 1.09 on today', () => {
  const r = cmd.parse(':rate eur 1.09 on today');
  assert.strictEqual(r.type, 'alias');
  assert.ok(r.parsed.params.date && /^\d{4}-\d{2}-\d{2}$/.test(r.parsed.params.date));
});

test('parse: :rate eur 1.09 on baddate → error', () => {
  const r = cmd.parse(':rate eur 1.09 on baddate');
  assert.strictEqual(r.type, 'unknown');
  assert.ok(r.error.indexOf('invalid date') !== -1);
});

// ── :new alias removed (2026-08-09) — replaced by PALETTE navigate entries ──

test('parse: :new is now unknown (alias removed)', () => {
  const r = cmd.parse(':new');
  assert.strictEqual(r.type, 'unknown');
});

test('grammarFor: :new returns <target> (v7 — :new is now a real alias)', () => {
  const g = cmd.grammarFor('new');
  assert.ok(g !== null);
});
