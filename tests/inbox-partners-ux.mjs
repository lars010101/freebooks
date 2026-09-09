// tests/inbox-partners-ux.mjs — Inbox Partners tab (full inline-edit) and
// New Rule tab (real columns) UX regression (2026-09-09 follow-up).
//
// Covers the second phase of the Inbox rebuild:
//   1. Partners tab: Name/Vendor/Customer/Exp account/AP account/Tax code/
//      Source/Duplicate/Actions — every field editable directly on the
//      row, no unfold. The account/tax inputs are wired to a real
//      FB.dropdown (search by code or name), same code-only-value + name
//      tooltip convention payables-bills.js's own dropdown cells already
//      use. Editing a field and approving sends the edited value through
//      partner.proposal.approve's new override params, not the originally
//      agent-proposed one.
//   2. New Rule tab: real columns (Date/Pattern/Suggested account/Tax
//      code/Source) — the mockup never actually designed this tab (always
//      its own empty state there), so these are the fields
//      mapping_suggestions actually has, previously fetched server-side
//      and silently dropped before reaching the item.
//
// The server is booted IN-PROCESS (mirrors tests/reversal.mjs, issue #112).
// Playwright/chromium is imported dynamically; if it is not installed the
// test SKIPS (exit 0) so `npm test` stays green.
//   Run: node tests/inbox-partners-ux.mjs

import { startServer, apiPost } from './lib/test-server.mjs';

const CO = 'inbptest';
let BASE = '';
let ADMIN_TOKEN = '';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL:', name, detail ? `— ${detail}` : ''); }
}

async function act(action, body = {}) {
  const r = await fetch(`${BASE}/api/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ companyId: CO, action, ...body })
  });
  const j = await r.json();
  if (j.error) throw new Error(`${action}: ${JSON.stringify(j.error)}`);
  return j.data !== undefined ? j.data : j;
}

async function sql(query, params = []) {
  const r = await fetch(`${BASE}/api/admin/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ sql: query, params }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`admin query failed ${r.status}: ${JSON.stringify(body)}`);
  return body.rows || [];
}

async function seedCompany() {
  await apiPost(BASE, 'setup.add_company', 'x', {
    company: {
      company_id: CO, company_name: 'Inbox Partners Test Co',
      jurisdiction: 'SE', currency: 'SEK', reporting_standard: 'K2',
      vat_registered: true, fy_start: '2026-01-01', fy_end: '2026-12-31',
    },
  }, 'ipt-setup').catch((e) => { if (!/already exists|DUPLICATE/.test(String(e.message))) throw e; });

  await apiPost(BASE, 'coa.upsert', CO, {
    account: { account_code: '6000', account_name: 'Office Supplies Expense', account_type: 'Expense',
      account_subtype: 'Operating', is_active: true, effective_from: '2026-01-01' },
  }, 'ipt-coa-6000');
  await apiPost(BASE, 'coa.upsert', CO, {
    account: { account_code: '2100', account_name: 'Accounts Payable', account_type: 'Liability',
      account_subtype: 'Current Liabilities', is_active: true, effective_from: '2026-01-01' },
  }, 'ipt-coa-2100');

  await sql(`INSERT INTO vat_codes (company_id, vat_code, description, rate, is_active, effective_from) VALUES (?, 'SE25', 'Standard rate 25%', 0.25, true, '2026-01-01')`, [CO]);
  await sql(`INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by) VALUES (?, ?, 'agent', now(), 'test')`, ['agent@ipt', CO]);
  await sql(`INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by) VALUES (?, ?, 'owner', now(), 'test')`, ['owner@ipt', CO]);
}

async function run(chromium) {
  const partnerProposal = await act('partner.propose', {
    userEmail: 'agent@ipt',
    name: 'IPT Nordwind Logistics AB', evidence: { source: 'test' },
    is_vendor: true, is_customer: false,
    default_expense_account: '6000', default_ap_account: '2100', suggested_vat_code: 'SE25',
  });
  ok('seed partner.propose returns proposal_id', !!partnerProposal.proposal_id, JSON.stringify(partnerProposal).slice(0, 150));

  const suggestion = await act('mapping.suggest', {
    userEmail: 'agent@ipt',
    description_pattern: 'IPT SPOTIFY', suggested_account: '6000', suggested_vat_code: 'SE25',
  });
  ok('seed mapping.suggest returns suggestion_id', !!suggestion.suggestion_id, JSON.stringify(suggestion).slice(0, 150));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));

  await page.goto(`${BASE}/${CO}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  ok('Inbox loads with zero JS errors', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 200));

  // ── Partners tab ──────────────────────────────────────────────────────
  await page.locator('.tabs .tab', { hasText: 'Partners' }).click();
  await page.waitForTimeout(500);
  const headers = await page.locator('#tab-partners thead th').allTextContents();
  const headerText = headers.join('|');
  ok('Partners headers match the mockup (Name/Vendor/Customer/Exp/AP/Tax/Source/Duplicate)',
    /Name/.test(headerText) && /Vendor/.test(headerText) && /Customer/.test(headerText) &&
    /Exp account/.test(headerText) && /AP account/.test(headerText) && /Tax code/.test(headerText) &&
    /Source/.test(headerText) && /Duplicate/.test(headerText), headerText);

  const row = page.locator('#partners-tbody tr', { hasText: 'IPT Nordwind Logistics AB' });
  ok('Vendor checkbox reflects the proposed value (checked)', await row.locator('.pf-vendor').isChecked());
  ok('Customer checkbox reflects the proposed value (unchecked)', !(await row.locator('.pf-customer').isChecked()));
  const expInput = row.locator('.pf-exp');
  ok('Exp account input pre-fills the proposed code', (await expInput.inputValue()) === '6000');
  ok('Exp account tooltip shows the resolved account name', (await expInput.getAttribute('title') || '').includes('Office Supplies Expense'));

  // Live autocomplete
  await expInput.click();
  await expInput.fill('');
  await expInput.type('60', { delay: 20 });
  await page.waitForTimeout(300);
  const ddText = await page.locator('body').innerText();
  ok('typing into Exp account opens a real FB.dropdown with the matching account', ddText.includes('Office Supplies Expense'));
  await page.keyboard.press('Escape').catch(() => {});

  // Edit fields, then approve — the edited values must be what gets sent.
  await expInput.fill('6000');
  await row.locator('.pf-customer').check();
  await row.locator('a[data-act="verb:y"]').click();
  await page.waitForTimeout(300);
  await page.locator('button, a').filter({ hasText: 'Approve' }).last().click();
  await page.waitForTimeout(1000);

  const afterApprove = await page.locator('#tab-partners').innerText();
  ok('partner row leaves Partners after approve', !afterApprove.includes('IPT Nordwind Logistics AB'));

  const created = await sql(`SELECT is_vendor, is_customer, default_expense_account FROM partners WHERE company_id = ? AND name = ?`,
    [CO, 'IPT Nordwind Logistics AB']);
  ok('approved partner exists with is_vendor=true', created.length === 1 && created[0].is_vendor === true, JSON.stringify(created));
  ok('the Customer checkbox toggle (edited before approve) landed as is_customer=true', created.length === 1 && created[0].is_customer === true, JSON.stringify(created));

  // ── New Rule tab ─────────────────────────────────────────────────────
  await page.locator('.tabs .tab', { hasText: 'New Rule' }).click();
  await page.waitForTimeout(500);
  const nrHeaders = (await page.locator('#tab-newrule thead th').allTextContents()).join('|');
  ok('New Rule headers are the real mapping-suggestion fields (Date/Pattern/Suggested account/Tax code/Source)',
    /Date/.test(nrHeaders) && /Pattern/.test(nrHeaders) && /Suggested account/.test(nrHeaders) && /Tax code/.test(nrHeaders) && /Source/.test(nrHeaders), nrHeaders);
  const nrText = await page.locator('#tab-newrule').innerText();
  ok('New Rule shows the real pattern', nrText.includes('IPT SPOTIFY'));
  ok('New Rule shows the real suggested account', nrText.includes('6000'));
  ok('New Rule shows the real tax code', nrText.includes('SE25'));

  await browser.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('INBOX PARTNERS UX REGRESSION: FAIL'); process.exitCode = 1; return; }
  console.log('INBOX PARTNERS UX REGRESSION: PASS');
}

// ── Bootstrapping: skip if Playwright absent, boot in-process server, run ──────
(async () => {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    console.log('=== Inbox Partners UX regression — SKIP ===');
    console.log('playwright-core is not installed. Install it (and run `npx playwright install chromium`)');
    console.log('to exercise the browser flow. Skipping (exit 0).');
    process.exit(0);
  }

  const srv = await startServer();
  BASE = srv.baseUrl;
  ADMIN_TOKEN = srv.adminToken;
  try {
    console.log('=== Inbox Partners UX regression ===');
    console.log(`In-process server: ${BASE}`);
    await seedCompany();
    await run(chromium);
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('Executable doesn\'t exist') || msg.includes('browserType.launch')) {
      console.log('=== Inbox Partners UX regression — SKIP ===');
      console.log('Playwright browser binary not installed. Run: npx playwright install chromium');
      console.log('Skipping (exit 0).');
    } else {
      console.error('Inbox Partners UX test error:', e);
      process.exitCode = 1;
    }
  } finally {
    await srv.cleanup();
  }
})();
