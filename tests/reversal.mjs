// tests/reversal.mjs — JV reversal UX regression (magnus 2026-07-28).
//
// Covers the three ratified reversal behaviors (keyboard-ux-spec §5):
//   A1 — picking a source entry renders the ORIGINAL (un-swapped) lines as
//        grayed, read-only rows ABOVE the swapped reversal rows (.jv-orig-line),
//        excluded from the editable `lines` zone and from post.
//   A2 — after the pick, the FB.form cursor lands on the header DATE cell
//        (zone 1, NORMAL) — never stranded in the search input.
//   A3 — Esc contract: INSERT-Esc from the search ONLY exits edit → NORMAL
//        (reversal stays active); NORMAL-Esc cancels the reversal.
// Also seeds a dedicated dated batch and asserts the new server-side
// posting-date search (CAST(date AS TEXT) ILIKE q) finds it.
//
// Run: node tests/reversal.mjs   (fixture server on :4722, company testco)
// Exits 0 only when every assertion passes.

import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:4722';
const CO = 'testco';

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

// ── 0. Seed a dedicated, uniquely-dated, balanced batch via journal.post ─────
// A distinctive date (2026-07-12) + marker description so the date search and
// the picker target THIS batch deterministically, independent of other seeds.
// (Date must be inside an open fiscal period — 2026-07 is open on the fixture.)
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

// Server-side posting-date search (3a): the date string must surface the batch.
const byDate = await act('journal.search', { q: '2026-07-12' });
ok('journal.search matches by posting date', Array.isArray(byDate) && byDate.some(r => r.batch_id === SEED_BATCH),
  JSON.stringify(byDate).slice(0, 160));
// And the marker description finds it too (existing behavior, sanity).
const byDesc = await act('journal.search', { q: '3f9a' });
ok('journal.search matches by description marker', Array.isArray(byDesc) && byDesc.some(r => r.batch_id === SEED_BATCH));

// ── Browser flow ─────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const page = await browser.newPage();
const jsErrors = [];
page.on('pageerror', e => jsErrors.push(String(e)));

await page.goto(`${BASE}/${CO}/journal/new`, { waitUntil: 'networkidle' });
ok('page loads with zero JS errors', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 200));

// Sanity: introspection handle present, starts NORMAL, not reversing.
const boot = await page.evaluate(() => ({ has: !!window.__jn, mode: window.__jn && window.__jn.mode(), rev: window.__jn && window.__jn.reversal() }));
ok('__jn handle present, NORMAL, not reversing', boot.has && boot.mode === 'NORMAL' && boot.rev === false, JSON.stringify(boot));

// ── R enters reversal mode ───────────────────────────────────────────────────
// `R` is uppercase (ratified binding) — Playwright needs Shift+R for 'R'.
async function pressR() { await page.keyboard.down('Shift'); await page.keyboard.press('R'); await page.keyboard.up('Shift'); }
await pressR();
// R focuses the search asynchronously — wait for it before asserting.
await page.waitForFunction(() => window.__jn && window.__jn.reversal() === true, { timeout: 3000 }).catch(() => {});
await page.waitForFunction(() => document.activeElement === document.getElementById('reversal-search'), { timeout: 3000 }).catch(() => {});
const afterR = await page.evaluate(() => ({
  rev: window.__jn.reversal(),
  panelVisible: (document.getElementById('reversal-panel').style.display !== 'none'),
  searchFocused: document.activeElement === document.getElementById('reversal-search'),
  mode: window.__jn.mode()
}));
ok('R enters reversal mode + shows panel + focuses search', afterR.rev === true && afterR.panelVisible && afterR.searchFocused, JSON.stringify(afterR));

// ── Type the marker → results render ─────────────────────────────────────────
await page.keyboard.type('3f9a', { delay: 10 });
await page.waitForFunction(() => {
  const res = document.getElementById('reversal-results');
  return res && res.style.display !== 'none' && res.children.length > 0 && !/No matching/.test(res.textContent);
}, { timeout: 4000 }).catch(() => {});
const resultCount = await page.evaluate(() => document.getElementById('reversal-results').children.length);
ok('search renders ≥1 result row', resultCount > 0, `count=${resultCount}`);

// ── Enter picks the highlighted result ───────────────────────────────────────
await page.keyboard.press('Enter');
// loadReversalEntry is async (journal.get) — wait for original rows + cursor.
await page.waitForFunction(() => document.querySelectorAll('#lines-body tr.jv-orig-line').length > 0, { timeout: 4000 }).catch(() => {});
await page.waitForTimeout(150);

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
  // original credit/debit: the seed was 1090 DR 42 / 1930 CR 42 → original row 1 shows debit 42
  return {
    origCount: origRows.length,
    hasHdr: !!hdr,
    hdrAboveEdits: firstOrigIdx >= 0 && firstEditIdx > firstOrigIdx,
    origHasInputs,
    firstOrigDebit: origRows[0] ? origRows[0].children[2].textContent.trim() : null,
  };
});
ok('A1: original read-only rows render (≥2)', a1.origCount >= 2, JSON.stringify(a1));
ok('A1: header row present above editable rows', a1.hasHdr && a1.hdrAboveEdits, JSON.stringify(a1));
ok('A1: original rows carry no inputs (read-only)', a1.origHasInputs === false, JSON.stringify(a1));
ok('A1: original row shows ORIGINAL debit (42.00)', a1.firstOrigDebit === '42.00', `got ${a1.firstOrigDebit}`);

// A1b: editable (swapped) rows hold the REVERSAL amounts (1090 now CR, 1930 now DR).
const a1b = await page.evaluate(() => {
  const editRows = Array.from(document.querySelectorAll('#lines-body tr:not(.jv-orig-line):not(.jv-orig-hdr)'));
  return editRows.map(tr => ({
    code: tr.querySelector('.acct-input') && tr.querySelector('.acct-input').value,
    dr: tr.querySelector('.debit-input') && tr.querySelector('.debit-input').value,
    cr: tr.querySelector('.credit-input') && tr.querySelector('.credit-input').value,
  }));
});
const r1010 = a1b.find(r => r.code === '1010');
const r1020 = a1b.find(r => r.code === '1020');
ok('A1: editable rows are the SWAPPED reversal (1010 → credit 42)', !!(r1010 && parseFloat(r1010.cr) === 42 && !parseFloat(r1010.dr)), JSON.stringify(a1b));
ok('A1: editable rows are the SWAPPED reversal (1020 → debit 42)', !!(r1020 && parseFloat(r1020.dr) === 42 && !parseFloat(r1020.cr)), JSON.stringify(a1b));

// A2: cursor lands on the header DATE cell (zone 1), NORMAL, search not focused.
const a2 = await page.evaluate(() => ({
  cur: window.__jn.cur(),
  mode: window.__jn.mode(),
  searchFocused: document.activeElement === document.getElementById('reversal-search'),
  resultsHidden: document.getElementById('reversal-results').style.display === 'none',
}));
ok('A2: cursor on header zone (z=1) after pick', a2.cur && a2.cur.z === 1, JSON.stringify(a2.cur));
ok('A2: date cell is first cell (c=0)', a2.cur && a2.cur.c === 0, JSON.stringify(a2.cur));
ok('A2: mode NORMAL + search blurred + results collapsed', a2.mode === 'NORMAL' && !a2.searchFocused && a2.resultsHidden, JSON.stringify(a2));

// A2b: j from the date cell walks down (into the line grid), not stuck.
await page.keyboard.press('j');
await page.waitForTimeout(120);
const a2b = await page.evaluate(() => window.__jn.cur());
ok('A2: j from date moves cursor down (not stranded)', !!(a2b && (a2b.z > 1 || a2b.r > 0)), JSON.stringify(a2b));

// ── A3: Esc contract — re-enter reversal to test INSERT-then-NORMAL Esc ──────
// Currently NOT reversing (a pick already consumed it? reversal stays active).
// Reset to a clean reversal: cancel via NORMAL Esc first if still active.
const stillRev = await page.evaluate(() => window.__jn.reversal());
if (stillRev) { await page.keyboard.press('Escape'); await page.waitForTimeout(120); }
const revOff = await page.evaluate(() => window.__jn.reversal());
ok('A3 setup: reversal cancelled before Esc test', revOff === false, `rev=${revOff}`);

// Enter reversal again, focus search, type, go INSERT.
await pressR();
await page.waitForFunction(() => window.__jn && window.__jn.reversal() === true, { timeout: 3000 }).catch(() => {});
await page.waitForFunction(() => document.activeElement === document.getElementById('reversal-search'), { timeout: 3000 }).catch(() => {});
await page.keyboard.type('3f9a', { delay: 10 });
await page.waitForTimeout(400);
const insMode = await page.evaluate(() => ({ mode: window.__jn.mode(), rev: window.__jn.reversal(), focused: document.activeElement === document.getElementById('reversal-search') }));
ok('A3: search INSERT + reversing before INSERT-Esc', insMode.mode === 'INSERT' && insMode.rev === true && insMode.focused, JSON.stringify(insMode));

// INSERT-Esc: must ONLY exit to NORMAL — reversal stays ACTIVE.
await page.keyboard.press('Escape');
await page.waitForTimeout(120);
const afterInsEsc = await page.evaluate(() => ({ mode: window.__jn.mode(), rev: window.__jn.reversal(), panelVisible: document.getElementById('reversal-panel').style.display !== 'none' }));
ok('A3: INSERT-Esc → NORMAL but reversal STAYS active', afterInsEsc.mode === 'NORMAL' && afterInsEsc.rev === true && afterInsEsc.panelVisible, JSON.stringify(afterInsEsc));

// NORMAL-Esc: NOW cancels the reversal.
await page.keyboard.press('Escape');
await page.waitForTimeout(120);
const afterNormEsc = await page.evaluate(() => ({ rev: window.__jn.reversal(), panelVisible: document.getElementById('reversal-panel').style.display !== 'none' }));
ok('A3: NORMAL-Esc cancels the reversal', afterNormEsc.rev === false && !afterNormEsc.panelVisible, JSON.stringify(afterNormEsc));

ok('no JS errors accumulated during flow', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 200));

await browser.close();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('REVERSAL REGRESSION: FAIL'); process.exit(1); }
console.log('REVERSAL REGRESSION: PASS');
