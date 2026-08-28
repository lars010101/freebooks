// tests/reversal.mjs — JV reversal UX regression (magnus 2026-07-28; updated
// 2026-08-28 when reversal moved off a draft-compose search flow onto the
// posted-batch view — see docs/keyboard-ux-spec.md).
//
// Covers the ratified reversal behaviors:
//   A0 — reversal is unreachable on a fresh/draft entry: the button stays
//        hidden and `u` is a silent no-op (status message only).
//   A1 — entering reversal from a loaded posted batch (?batch=) renders the
//        ORIGINAL (un-swapped) lines as grayed, read-only rows ABOVE the
//        swapped reversal rows (.jv-orig-line), excluded from the editable
//        `lines` zone and from post.
//   A2 — after entering reversal, the FB.form cursor lands on the header
//        DATE cell (zone 1, NORMAL).
//   A3 — NORMAL `Escape` cancels reversal and returns to the read-only
//        posted view.
// Also seeds a dedicated dated batch and asserts the server-side posting-date
// search (CAST(date AS TEXT) ILIKE q) finds it — journal.search still backs
// other callers (e.g. the `:post` command palette) even though the JV page
// itself no longer searches for a reversal target.
//
// The server is booted IN-PROCESS (issue #112) — no separately-started server
// required. Playwright/chromium is imported dynamically; if it is not
// installed the test SKIPS (exit 0) so `npm test` stays green.
//   Run: node tests/reversal.mjs
//   Exits 0 only when every assertion passes (or when chromium is absent).

import { startServer, apiPost } from './lib/test-server.mjs';

const CO = 'testco';
let BASE = '';

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

// Seed the company + accounts + open period the regression needs. With the
// in-process server using a fresh throwaway DB, nothing is pre-seeded, so the
// script is fully self-contained (no dev-fixture dependency).
async function seedCompany() {
  // SE jurisdiction loads the BAS COA template (includes 1010).
  await apiPost(BASE, 'setup.add_company', 'x', {
    company: {
      company_id: CO,
      company_name: 'Test Co',
      jurisdiction: 'SE',
      currency: 'SEK',
      reporting_standard: 'K2',
      vat_registered: false,
      fy_start: '2026-01-01',
      fy_end: '2026-12-31',
    },
  }, 'rev-setup').catch((e) => {
    // Idempotent rerun within the same throwaway DB is not expected, but
    // tolerate a duplicate just in case.
    if (!/already exists|DUPLICATE/.test(String(e.message))) throw e;
  });

  // 1020 is not in the SE template — upsert it as a second Asset account so
  // the seed batch (1010 DR / 1020 CR) posts cleanly.
  await apiPost(BASE, 'coa.upsert', CO, {
    account: {
      account_code: '1020', account_name: 'Kassa', account_type: 'Asset',
      account_subtype: 'Current Assets', is_active: true, effective_from: '2026-01-01',
    },
  }, 'rev-coa-1020');

  // Open fiscal period covering the seed date (2026-07-12).
  await apiPost(BASE, 'period.upsert', CO, {
    period: { period_id: 'FY2026', start_date: '2026-01-01', end_date: '2026-12-31', locked: false },
  }, 'rev-period-2026');
}

async function run(chromium) {
  // ── 0. Seed a dedicated, uniquely-dated, balanced batch via journal.post ─────
  // A distinctive date (2026-07-12) + marker description, so the batch is
  // deterministically identifiable independent of other seeds.
  const MARK = 'REVTEST marker 3f9a';
  const seed = await act('journal.post', {
    journalId: undefined,
    source: 'manual',
    lines: [
      { account_code: '1010', debit: 42, credit: 0, date: '2026-07-12', description: MARK, source: 'manual' },
      { account_code: '1020', debit: 0, credit: 42, date: '2026-07-12', description: MARK, source: 'manual' },
    ]
  });
  ok('seed journal.post returns batch id', !!(seed && (seed.batch_id || seed.batchId)), JSON.stringify(seed).slice(0, 120));
  const SEED_BATCH = seed.batch_id || seed.batchId;

  // Server-side posting-date search (still backs other callers, e.g. the
  // `:post` command palette, even though the JV page no longer uses it).
  const byDate = await act('journal.search', { q: '2026-07-12' });
  ok('journal.search matches by posting date', Array.isArray(byDate) && byDate.some(r => r.batch_id === SEED_BATCH),
    JSON.stringify(byDate).slice(0, 160));
  const byDesc = await act('journal.search', { q: '3f9a' });
  ok('journal.search matches by description marker', Array.isArray(byDesc) && byDesc.some(r => r.batch_id === SEED_BATCH));

  // ── Browser flow ─────────────────────────────────────────────────────────────
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(String(e)));

  // ── A0: reversal is unreachable on a fresh/draft entry ───────────────────────
  await page.goto(`${BASE}/${CO}/journal/voucher`, { waitUntil: 'networkidle' });
  ok('fresh page loads with zero JS errors', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 200));

  const boot = await page.evaluate(() => ({ has: !!window.__jn, mode: window.__jn && window.__jn.mode(), rev: window.__jn && window.__jn.reversal() }));
  ok('__jn handle present, NORMAL, not reversing', boot.has && boot.mode === 'NORMAL' && boot.rev === false, JSON.stringify(boot));

  const a0Before = await page.evaluate(() => {
    const btn = document.getElementById('btn-reversal-mode');
    return { btnHidden: !btn.offsetParent };
  });
  ok('A0: reversal button hidden on a fresh entry', a0Before.btnHidden, JSON.stringify(a0Before));

  await page.keyboard.press('u');
  await page.waitForTimeout(150);
  const a0After = await page.evaluate(() => ({ rev: window.__jn.reversal(), mode: window.__jn.mode() }));
  ok('A0: u is a no-op on a fresh entry (still NORMAL, not reversing)', a0After.rev === false && a0After.mode === 'NORMAL', JSON.stringify(a0After));

  // ── Load the posted batch (?batch=) ──────────────────────────────────────────
  await page.goto(`${BASE}/${CO}/journal/voucher?batch=${encodeURIComponent(SEED_BATCH)}`, { waitUntil: 'networkidle' });
  // Wait for renderViewMode() specifically (not just __jn existing, which is
  // synchronous and would race the async journal.get fetch it depends on) —
  // the reversal button is only revealed once that fetch resolves and renders.
  await page.waitForFunction(() => {
    var btn = document.getElementById('btn-reversal-mode');
    return !!(window.__jn && btn && btn.offsetParent);
  }, { timeout: 4000 }).catch(() => {});
  ok('view page loads with zero JS errors', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 200));

  const viewBoot = await page.evaluate(() => {
    const btn = document.getElementById('btn-reversal-mode');
    return { rev: window.__jn.reversal(), btnVisible: !!btn.offsetParent };
  });
  ok('view mode: not reversing yet, reversal button visible', viewBoot.rev === false && viewBoot.btnVisible, JSON.stringify(viewBoot));

  // ── u enters reversal mode, applying the batch's lines directly (no search) ──
  await page.keyboard.press('u');
  await page.waitForFunction(() => window.__jn && window.__jn.reversal() === true, { timeout: 3000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelectorAll('#lines-body tr.jv-orig-line').length > 0, { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(150);

  const afterU = await page.evaluate(() => window.__jn.reversal());
  ok('u enters reversal mode', afterU === true, `rev=${afterU}`);

  // A1: original rows present, grayed/read-only, above the editable rows.
  const a1 = await page.evaluate(() => {
    const body = document.getElementById('lines-body');
    const rows = Array.from(body.querySelectorAll('tr'));
    const origRows = rows.filter(tr => tr.classList.contains('jv-orig-line'));
    const hdr = body.querySelector('tr.jv-orig-hdr');
    const firstOrigIdx = rows.findIndex(tr => tr.classList.contains('jv-orig-hdr'));
    const firstEditIdx = rows.findIndex(tr => !tr.classList.contains('jv-orig-line') && !tr.classList.contains('jv-orig-hdr'));
    // read-only: original rows must contain NO inputs
    const origHasInputs = origRows.some(tr => tr.querySelector('input,select,textarea'));
    // original credit/debit: the seed was 1010 DR 42 / 1020 CR 42 → original row 1 shows debit 42
    return {
      origCount: origRows.length,
      hasHdr: !!hdr,
      hdrAboveEdits: firstOrigIdx >= 0 && firstEditIdx > firstOrigIdx,
      origHasInputs,
      firstOrigDebit: origRows[0] ? origRows[0].children[1].textContent.trim() : null,
    };
  });
  ok('A1: original read-only rows render (≥2)', a1.origCount >= 2, JSON.stringify(a1));
  ok('A1: header row present above editable rows', a1.hasHdr && a1.hdrAboveEdits, JSON.stringify(a1));
  ok('A1: original rows carry no inputs (read-only)', a1.origHasInputs === false, JSON.stringify(a1));
  ok('A1: original row shows ORIGINAL debit (42.00)', a1.firstOrigDebit === '42.00', `got ${a1.firstOrigDebit}`);

  // A1b: editable (swapped) rows hold the REVERSAL amounts (1010 now CR, 1020 now DR).
  const a1b = await page.evaluate(() => {
    const editRows = Array.from(document.querySelectorAll('#lines-body tr:not(.jv-orig-line):not(.jv-orig-hdr)'));
    return editRows.map(tr => ({
      // §3. account input now holds "CODE — Name" combined; parse the code
      code: tr.querySelector('.acct-input') && (tr.querySelector('.acct-input').dataset.code
        || tr.querySelector('.acct-input').value.trim().split(' — ')[0]),
      dr: tr.querySelector('.debit-input') && tr.querySelector('.debit-input').value,
      cr: tr.querySelector('.credit-input') && tr.querySelector('.credit-input').value,
    }));
  });
  const r1010 = a1b.find(r => r.code === '1010');
  const r1020 = a1b.find(r => r.code === '1020');
  ok('A1: editable rows are the SWAPPED reversal (1010 → credit 42)', !!(r1010 && parseFloat(r1010.cr) === 42 && !parseFloat(r1010.dr)), JSON.stringify(a1b));
  ok('A1: editable rows are the SWAPPED reversal (1020 → debit 42)', !!(r1020 && parseFloat(r1020.dr) === 42 && !parseFloat(r1020.cr)), JSON.stringify(a1b));

  // A2: cursor lands on the header DATE cell (zone 1), NORMAL.
  const a2 = await page.evaluate(() => ({ cur: window.__jn.cur(), mode: window.__jn.mode() }));
  ok('A2: cursor on header zone (z=1) after entering reversal', a2.cur && a2.cur.z === 1, JSON.stringify(a2.cur));
  ok('A2: date cell is first cell (c=0)', a2.cur && a2.cur.c === 0, JSON.stringify(a2.cur));
  ok('A2: mode NORMAL', a2.mode === 'NORMAL', JSON.stringify(a2));

  // A2b: j from the date cell walks down (into the line grid), not stuck.
  await page.keyboard.press('j');
  await page.waitForTimeout(120);
  const a2b = await page.evaluate(() => window.__jn.cur());
  ok('A2: j from date moves cursor down (not stranded)', !!(a2b && (a2b.z > 1 || a2b.r > 0)), JSON.stringify(a2b));

  // ── A3: NORMAL Escape cancels reversal, back to the read-only posted view ────
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const afterEsc = await page.evaluate(() => ({
    rev: window.__jn.reversal(),
    dateDisabled: document.getElementById('entry-date').disabled,
  }));
  ok('A3: Escape cancels the reversal', afterEsc.rev === false, JSON.stringify(afterEsc));
  ok('A3: back to read-only posted view (date field disabled again)', afterEsc.dateDisabled === true, JSON.stringify(afterEsc));

  ok('no JS errors accumulated during flow', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 200));

  await browser.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('REVERSAL REGRESSION: FAIL'); process.exitCode = 1; return; }
  console.log('REVERSAL REGRESSION: PASS');
}

// ── Bootstrapping: skip if Playwright absent, boot in-process server, run ──────
(async () => {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    console.log('=== Reversal UX regression — SKIP ===');
    console.log('playwright-core is not installed. Install it (and run `npx playwright install chromium`)');
    console.log('to exercise the browser flow. Skipping (exit 0).');
    process.exit(0);
  }

  const srv = await startServer();
  BASE = srv.baseUrl;
  try {
    console.log('=== Reversal UX regression ===');
    console.log(`In-process server: ${BASE}`);
    await seedCompany();
    await run(chromium);
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('Executable doesn\'t exist') || msg.includes('browserType.launch')) {
      console.log('=== Reversal UX regression — SKIP ===');
      console.log('Playwright browser binary not installed. Run: npx playwright install chromium');
      console.log('Skipping (exit 0).');
    } else {
      console.error('Reversal test error:', e);
      process.exitCode = 1;
    }
  } finally {
    await srv.cleanup();
  }
})();
