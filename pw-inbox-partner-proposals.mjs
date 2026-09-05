// Inbox — partner-proposal review UI smoke (repo convention: checked-in
// pw-*.mjs Playwright smoke scripts, modeled on pw-phase-a4.mjs).
//
// Boots a throwaway fixture server (own DuckDB + port), grants a test user
// owner rights, proposes one vendor + one customer via partner.propose, then
// drives /:company/inbox to confirm:
//   - partner proposals do NOT show under the default 'proposed' filter
//     (they are a Class B filter section, like bills/orphans/reconciliation);
//   - cycling the 'f' filter five times reaches 'partners' and shows both
//     proposed rows, grouped under "Partner proposals" with the 🤝 glyph;
//   - approving one calls partner.proposal.approve and removes it from the
//     list; rejecting the other calls partner.proposal.reject and removes it.
// Run: node pw-inbox-partner-proposals.mjs
import { createRequire } from 'module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const { startTestServer, api, sql, seedCompany } = require('./api/test-utils/helpers');
const { chromium } = require('playwright-core');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL:', name, detail ? `— ${detail}` : ''); }
}

console.log('[boot] throwaway fixture server');
const srv = await startTestServer({ withAdminToken: true });
const BASE = srv.baseUrl;
const CO = 'PPCO';
try {
  await seedCompany(BASE, CO, { jurisdiction: 'SE', currency: 'SEK' });
  await sql(BASE, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('owner@ppco', '${CO}', 'owner', now(), 'test')`);

  const vendorName = 'Netflix International BV';
  const customerName = 'Contoso Customer AB';

  const pv = await api(BASE, 'partner.propose', {
    companyId: CO, userEmail: 'owner@ppco', name: vendorName, is_vendor: true,
    evidence: { type: 'bank_statement_line', description: vendorName },
  });
  if (pv.status !== 200 || !pv.body || !pv.body.ok) throw new Error(`partner.propose (vendor) failed: ${JSON.stringify(pv.body)}`);
  const vendorProposalId = pv.body.data.proposal_id;
  console.log('  proposed vendor:', vendorName, vendorProposalId);

  const pc = await api(BASE, 'partner.propose', {
    companyId: CO, userEmail: 'owner@ppco', name: customerName, is_vendor: false, is_customer: true,
    evidence: { type: 'bill_extraction', description: customerName },
  });
  if (pc.status !== 200 || !pc.body || !pc.body.ok) throw new Error(`partner.propose (customer) failed: ${JSON.stringify(pc.body)}`);
  const customerProposalId = pc.body.data.proposal_id;
  console.log('  proposed customer:', customerName, customerProposalId);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });

  console.log('\n[1] /:company/inbox — default queue does not show partner proposals');
  await page.goto(`${BASE}/${CO}/inbox`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  ok('default (proposed) view has no partner rows', await page.locator(`tr[data-key="partner:${vendorProposalId}"]`).count() === 0);

  console.log('\n[2] cycle f five times → partners filter');
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.cycleStatusFilter());
    await page.waitForTimeout(300);
  }
  await page.waitForFunction(() => window.statusState === 'partners');
  ok('statusState reaches "partners" after 5 cycles', await page.evaluate(() => window.statusState) === 'partners');

  await page.waitForFunction(pid => !!document.querySelector(`tr[data-key="partner:${pid}"]`), vendorProposalId, { timeout: 8000 });
  ok('vendor proposal row present', await page.locator(`tr[data-key="partner:${vendorProposalId}"]`).count() === 1);
  ok('customer proposal row present', await page.locator(`tr[data-key="partner:${customerProposalId}"]`).count() === 1);

  const groupHeaderText = await page.evaluate(() => {
    const tr = document.querySelector('tr[data-key="group:partner_proposal"]');
    return tr ? tr.textContent.trim() : null;
  });
  ok('group header reads "Partner proposals (2)"', /Partner proposals/.test(groupHeaderText || '') && /2/.test(groupHeaderText || ''), `got: ${groupHeaderText}`);

  const glyph = await page.evaluate(pid => {
    const tr = document.querySelector(`tr[data-key="partner:${pid}"]`);
    const g = tr && tr.querySelector('.inbx-type-glyph');
    return g ? g.textContent : null;
  }, vendorProposalId);
  ok('row carries the 🤝 type glyph', glyph === '\u{1F91D}', `got: ${JSON.stringify(glyph)}`);

  ok('no uncaught JS errors after load + cycling', errs.length === 0, errs[0] || '');

  console.log('\n[3] approve the vendor proposal (y)');
  await page.evaluate(pid => {
    const tr = document.querySelector(`tr[data-key="partner:${pid}"]`);
    const btn = tr.querySelector('[data-act="verb:y"]');
    if (btn) btn.click();
  }, vendorProposalId);
  await page.waitForSelector('.fb-modal-overlay', { timeout: 5000 });
  // No noteInput/typeConfirm on this modal → _armed() is true immediately
  // (fb-core.js), so a single click on the primary button fires onClick.
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.fb-modal-btns button')].filter(b => /^Approve\b/.test(b.textContent.trim()));
    if (btns[0]) btns[0].click();
  });
  await page.waitForFunction(pid => !document.querySelector(`tr[data-key="partner:${pid}"]`), vendorProposalId, { timeout: 8000 });
  ok('vendor row disappears from the queue after approve', await page.locator(`tr[data-key="partner:${vendorProposalId}"]`).count() === 0);

  const approveCheck = await api(BASE, 'partner.list', { companyId: CO });
  const created = (approveCheck.body.data || []).find(p => p.name === vendorName);
  ok('approved proposal created a real partner row', !!created, JSON.stringify(approveCheck.body));

  console.log('\n[4] reject the customer proposal (x)');
  await page.evaluate(pid => {
    const tr = document.querySelector(`tr[data-key="partner:${pid}"]`);
    tr.querySelector('[data-act="verb:x"]').click();
  }, customerProposalId);
  await page.waitForSelector('.fb-modal-overlay', { timeout: 5000 });
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.fb-modal-btns button')].filter(b => /^Reject\b/.test(b.textContent.trim()));
    if (btns[0]) btns[0].click();
  });
  await page.waitForFunction(pid => !document.querySelector(`tr[data-key="partner:${pid}"]`), customerProposalId, { timeout: 8000 });
  ok('customer row disappears from the queue after reject', await page.locator(`tr[data-key="partner:${customerProposalId}"]`).count() === 0);

  ok('no uncaught JS errors after approve/reject', errs.length === 0, errs[0] || '');

  await browser.close();
} finally {
  await srv.cleanup();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
