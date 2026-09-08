// tests/documents-orphans-ux.mjs — Documents orphaned-file UX regression (2026-09-08).
//
// Orphaned-file resolution moved from Inbox to Documents (calendar-reminders-
// documents-spec.md §5.5) — resolving an unlinked file on disk is file-registry
// housekeeping, not a review-queue approval. Covers the real, browser-facing
// path:
//   1. Inbox never surfaces orphans anywhere (no filter state, no group).
//   2. Documents lists an orphan row (type ORPHAN, named by filename, no
//      period/source) with a working Open link and a Delete action that
//      removes both the file and the row.
//
// The server is booted IN-PROCESS (mirrors tests/reversal.mjs, issue #112),
// with FREEBOOKS_ATTACHMENTS_ROOT isolated to a throwaway dir (test-server.mjs,
// 2026-09-08) so this test's seeded file never touches the developer's real
// ~/.freebooks/attachments. Playwright/chromium is imported dynamically; if
// it is not installed the test SKIPS (exit 0) so `npm test` stays green.
//   Run: node tests/documents-orphans-ux.mjs

import { startServer, apiPost } from './lib/test-server.mjs';
import fs from 'node:fs';
import path from 'node:path';

const CO = 'doctest';
let BASE = '';
let ADMIN_TOKEN = '';
let ATTACHMENTS_ROOT = '';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL:', name, detail ? `— ${detail}` : ''); }
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
      company_id: CO, company_name: 'Documents Orphan Test Co',
      jurisdiction: 'SE', currency: 'SEK', reporting_standard: 'K2',
      vat_registered: false, fy_start: '2026-01-01', fy_end: '2026-12-31',
    },
  }, 'doc-setup').catch((e) => { if (!/already exists|DUPLICATE/.test(String(e.message))) throw e; });
}

async function run(chromium) {
  // ── Seed a real orphaned file under the ISOLATED attachments root ───────
  const relPath = `${CO}/orphan-test/dummy.txt`;
  const fullPath = path.join(ATTACHMENTS_ROOT, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, 'dummy test file for documents-orphans-ux.mjs');
  ok('seed file written under the isolated ATTACHMENTS_ROOT', fs.existsSync(fullPath), fullPath);

  await sql(
    `INSERT INTO orphaned_files (orphan_id, company_id, path, discovered_at) VALUES (?, ?, ?, now())`,
    ['doctest-orphan-1', CO, relPath]);

  // ── Browser: Inbox never mentions orphans ────────────────────────────────
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));

  await page.goto(`${BASE}/${CO}`, { waitUntil: 'networkidle' });
  ok('Inbox loads with zero JS errors', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 200));

  const seenNotes = [];
  for (let i = 0; i < 5; i++) {
    seenNotes.push(await page.locator('#queue-note').textContent());
    await page.keyboard.press('f');
    await page.waitForTimeout(250);
  }
  ok('Inbox filter cycle (5 states) never surfaces an orphans view',
    seenNotes.every((n) => !/orphan/i.test(n || '')), JSON.stringify(seenNotes));

  // ── Documents: the orphan row renders correctly ──────────────────────────
  jsErrors.length = 0;
  await page.goto(`${BASE}/${CO}/documents`, { waitUntil: 'networkidle' });
  ok('Documents loads with zero JS errors', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 200));

  const row = page.locator('#documents-body tr', { hasText: 'dummy.txt' });
  ok('orphan row renders on Documents (named by filename)', await row.count() === 1);
  const rowText = await row.innerText();
  ok('row shows the ORPHAN type badge', /ORPHAN/i.test(rowText), rowText);
  ok('row has no period (no DB row to derive one from)', /—/.test(rowText), rowText);

  const openHref = await row.locator('a', { hasText: 'Open' }).getAttribute('href');
  ok('Open links to the dedicated orphaned-file route', openHref === '/api/orphaned-file/doctest-orphan-1', openHref);
  const goToSourceCount = await row.locator('a', { hasText: 'Go to source' }).count();
  ok('no "Go to source" link (an orphan has no owning record)', goToSourceCount === 0);

  // ── Delete removes both the row and the file ─────────────────────────────
  await row.locator('a', { hasText: 'Delete' }).click();
  await page.waitForTimeout(300);
  const modalText = await page.locator('.fb-modal, [class*=modal]').first().innerText().catch(() => '');
  ok('delete confirmation explains it is permanent, no quarantine', /Permanently delete/i.test(modalText), modalText);
  await page.locator('button, a').filter({ hasText: 'Delete' }).last().click();
  await page.waitForTimeout(700);

  const stillThere = await page.locator('#documents-body tr', { hasText: 'dummy.txt' }).count();
  ok('orphan row disappears from Documents after delete', stillThere === 0);
  ok('the app itself removed the file off disk', !fs.existsSync(fullPath));

  const dbRows = await sql(`SELECT resolved_at FROM orphaned_files WHERE orphan_id = ?`, ['doctest-orphan-1']);
  ok('orphaned_files row marked resolved', dbRows.length === 1 && !!dbRows[0].resolved_at, JSON.stringify(dbRows));

  await browser.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('DOCUMENTS ORPHANS UX REGRESSION: FAIL'); process.exitCode = 1; return; }
  console.log('DOCUMENTS ORPHANS UX REGRESSION: PASS');
}

// ── Bootstrapping: skip if Playwright absent, boot in-process server, run ──────
(async () => {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    console.log('=== Documents Orphans UX regression — SKIP ===');
    console.log('playwright-core is not installed. Install it (and run `npx playwright install chromium`)');
    console.log('to exercise the browser flow. Skipping (exit 0).');
    process.exit(0);
  }

  const srv = await startServer();
  BASE = srv.baseUrl;
  ADMIN_TOKEN = srv.adminToken;
  ATTACHMENTS_ROOT = srv.attachmentsRoot;
  try {
    console.log('=== Documents Orphans UX regression ===');
    console.log(`In-process server: ${BASE}`);
    await seedCompany();
    await run(chromium);
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('Executable doesn\'t exist') || msg.includes('browserType.launch')) {
      console.log('=== Documents Orphans UX regression — SKIP ===');
      console.log('Playwright browser binary not installed. Run: npx playwright install chromium');
      console.log('Skipping (exit 0).');
    } else {
      console.error('Documents Orphans UX test error:', e);
      process.exitCode = 1;
    }
  } finally {
    await srv.cleanup();
  }
})();
