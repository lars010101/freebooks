// A4 stage 3 — underlag review-queue UI smoke (untracked, repo convention).
//
// Boots a throwaway fixture server (own DuckDB + port) via the contract-test
// helpers, seeds a company, then exercises the full A4 §4.7 review UX in the
// Journal list:
//   1. mint a proposalId client-side, upload an underlag attachment bound to
//      (journal_proposal, proposalId), then journal.propose with that id;
//   2. propose a second bare proposal (no underlag → no_underlag);
//   3. open /:company/journal and assert:
//        - the folded first row shows the 📎 count badge (📎 1),
//        - the folded second row shows the visible "no underlag" warning marker,
//        - unfolding the first row renders the bound underlag rows via the
//          shared fb-attachments markup, each linking to GET /api/attachments/:id.
//
// No new keys/verbs/server routes are exercised — Enter unfolds via the
// existing tree mechanism; the y/x flow is untouched. Run: node pw-phase-a4.mjs
import { createRequire } from 'module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const { startTestServer, api, seedCompany } = require('./api/test-utils/helpers');
const { chromium } = require('playwright-core');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  \u2713', name); }
  else { fail++; console.log('  \u2717 FAIL:', name, detail ? `\u2014 ${detail}` : ''); }
}

// ── Boot a throwaway fixture ────────────────────────────────────────────────
console.log('[boot] throwaway fixture server');
const srv = await startTestServer({ withAdminToken: false });
const BASE = srv.baseUrl;
const CO = 'A4CO';
try {
  const seeded = await seedCompany(BASE, CO, { jurisdiction: 'SE', currency: 'SEK' });
  const accounts = seeded.accounts || [];
  // seedCompany returns AP/EXP as account-code STRINGS; accounts is the full
  // COA. Pick a debit (Asset) and a credit (Expense, falling back to Revenue).
  const cashCode = (accounts.find(a => a.account_type === 'Asset') || accounts[0]).account_code;
  const expCode = seeded.EXP
    || (accounts.find(a => a.account_type === 'Expense') || {}).account_code
    || (accounts.find(a => a.account_type === 'Revenue') || {}).account_code;
  if (!cashCode || !expCode) throw new Error('seed did not yield two usable account codes');
  console.log('  company', CO, '\u2014 cash', cashCode, '· offset', expCode);

  const DATE = '2026-07-15'; // period 2026-07 is seeded by seedCompany
  const lines = [
    { date: DATE, account_code: cashCode, debit: 200, credit: 0, description: 'A4 underlag smoke DR' },
    { date: DATE, account_code: expCode, debit: 0, credit: 200, description: 'A4 underlag smoke CR' },
  ];

  // ── 1. Proposal WITH underlag: mint id → upload → propose ──────────────────
  const p1 = randomUUID();
  const pdf = Buffer.from('%PDF-1.4\nA4 stage-3 underlag smoke\n%%EOF').toString('base64');
  const up = await api(BASE, 'attachment.upload', {
    companyId: CO, entityType: 'journal_proposal', entityId: p1,
    filename: 'a4-underlag.pdf', contentBase64: pdf, contentType: 'application/pdf',
  });
  if (up.status !== 200 || !up.body || !up.body.ok) throw new Error(`attachment.upload failed: ${JSON.stringify(up.body)}`);
  const a1id = up.body.data && up.body.data.attachment_id;
  console.log('  underlag uploaded:', a1id);

  const pr1 = await api(BASE, 'journal.propose', {
    companyId: CO, proposalId: p1, reference: 'A4-WITH-UL',
    description: 'proposal with underlag', lines,
  });
  if (pr1.status !== 200 || !pr1.body || !pr1.body.ok) throw new Error(`journal.propose (with-ul) failed: ${JSON.stringify(pr1.body)}`);
  ok('propose (with underlag) succeeded + attachment_count>=1', (pr1.body.data && pr1.body.data.attachment_count) >= 1, JSON.stringify(pr1.body.data));

  // ── 2. Bare proposal (no underlag) ─────────────────────────────────────────
  const p2 = randomUUID();
  const pr2 = await api(BASE, 'journal.propose', {
    companyId: CO, proposalId: p2, reference: 'A4-NO-UL',
    description: 'bare proposal (no underlag)', lines,
  });
  if (pr2.status !== 200 || !pr2.body || !pr2.body.ok) throw new Error(`journal.propose (no-ul) failed: ${JSON.stringify(pr2.body)}`);
  ok('propose (no underlag) succeeded (warn-not-block, R7)', pr2.body.data && pr2.body.data.attachment_count === 0, JSON.stringify(pr2.body.data));

  // ── 3. Browser: Journal review queue ────────────────────────────────────────
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });

  console.log('\n[1] /:company/journal \u2014 folded underlag badge + no-underlag marker');
  await page.goto(`${BASE}/${CO}/journal`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  // The two proposals are the only PROPOSED rows in a fresh DB; both pinned on
  // top. Locate each by its row key so ordering doesn't matter.
  ok('proposal row (with underlag) present', await page.locator(`tr[data-key="prop:${p1}"]`).count() === 1);
  ok('proposal row (no underlag) present', await page.locator(`tr[data-key="prop:${p2}"]`).count() === 1);

  // Wait for the proposals list to settle and the badge to render (fixed
  // timeouts race list.load()).
  await page.waitForFunction(pid => {
    const tr = document.querySelector(`tr[data-key="prop:${pid}"]`);
    const b = tr && tr.querySelector('.ul-badge');
    return !!(b && b.textContent.trim().length > 0);
  }, p1, { timeout: 8000 }).catch(() => {});
  const badgeText = await page.evaluate(pid => {
    const tr = document.querySelector(`tr[data-key="prop:${pid}"]`);
    const b = tr && tr.querySelector('.ul-badge');
    return b ? b.textContent.trim() : null;
  }, p1);
  ok('folded row shows underlag count badge (\uD83D\uDCCE 1)', badgeText && /\uD83D\uDCCE\s*1/.test(badgeText), `got: ${badgeText}`);

  const warnText = await page.evaluate(pid => {
    const tr = document.querySelector(`tr[data-key="prop:${pid}"]`);
    const w = tr && tr.querySelector('.ul-warn');
    return w ? w.textContent.trim() : null;
  }, p2);
  ok('folded row shows "no underlag" warning marker', warnText === 'no underlag', `got: ${warnText}`);

  ok('no uncaught JS errors on load', errs.length === 0, errs[0] || '');

  console.log('\n[2] unfold the with-underlag proposal \u2014 attachment.list preview');
  // Unfold via the existing tree caret (mouse parity for Space/Enter).
  await page.evaluate(pid => {
    const tr = document.querySelector(`tr[data-key="prop:${pid}"]`);
    const caret = tr && tr.querySelector('.fb-fold');
    if (caret) caret.click();
  }, p1);
  // attachment.list is fetched lazily on first unfold; wait for the row.
  await page.waitForFunction(pid => {
    const tr = document.querySelector(`tr[data-key="prop:${pid}"]`);
    if (!tr) return false;
    const row = tr.parentNode.querySelector(`tr[data-child-of="prop:${pid}"] .fb-attach-row`);
    return !!row;
  }, p1, { timeout: 8000 });
  ok('unfold renders a .fb-attach-row under the proposal', await page.evaluate(pid =>
    !!document.querySelector(`tr[data-child-of="prop:${pid}"] .fb-attach-row`), p1));

  const linkHref = await page.evaluate(pid => {
    const a = document.querySelector(`tr[data-child-of="prop:${pid}"] .fb-att-link`);
    return a ? a.getAttribute('href') : null;
  }, p1);
  ok('attachment row links to GET /api/attachments/:id (target _blank)', /^\/api\/attachments\/.+/.test(linkHref || ''), `got: ${linkHref}`);
  const linkTarget = await page.evaluate(pid => {
    const a = document.querySelector(`tr[data-child-of="prop:${pid}"] .fb-att-link`);
    return a ? a.getAttribute('target') : null;
  }, p1);
  ok('attachment link opens in a new tab (target=_blank)', linkTarget === '_blank', `got: ${linkTarget}`);

  console.log('\n[3] unfold the bare proposal \u2014 empty-state "No underlag attached"');
  await page.evaluate(pid => {
    const tr = document.querySelector(`tr[data-key="prop:${pid}"]`);
    const caret = tr && tr.querySelector('.fb-fold');
    if (caret) caret.click();
  }, p2);
  // querySelector returns the FIRST child row (the "Proposed by" detail row) —
  // test across all child rows so we hit the underlag panel row.
  await page.waitForFunction(pid =>
    [...document.querySelectorAll(`tr[data-child-of="prop:${pid}"]`)]
      .some(r => /No underlag attached/.test(r.textContent)), p2, { timeout: 8000 });
  ok('bare proposal unfold shows "No underlag attached" empty state', await page.evaluate(pid =>
    [...document.querySelectorAll(`tr[data-child-of="prop:${pid}"]`)]
      .some(r => /No underlag attached/.test(r.textContent)), p2));

  ok('no uncaught JS errors after unfolds', errs.length === 0, errs[0] || '');

  await browser.close();
} finally {
  await srv.cleanup();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
