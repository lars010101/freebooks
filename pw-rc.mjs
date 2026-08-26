// Reverse-charge (RC) balance regression — journal-voucher live preview.
//
// Boots a throwaway fixture server (own DuckDB + port) via the contract-test
// helpers, seeds an SE company (so the SERC reverse-charge VAT code exists),
// then drives the Journal Voucher page through a real RC entry:
//   - debit an expense 1,000 net with the SERC code (25% RC), and
//   - credit an offset 1,000 with no VAT.
// The live balance preview must show diff 0.00 (balanced) and the Post button
// must be enabled — mirroring the backend's expandJournalVatLines RC branch
// (journal.js) which emits a self-balancing DR-input + CR-output VAT pair.
// Finally the entry is posted and the success status asserted.
//
// Run: node pw-rc.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { startTestServer, api, seedCompany, testDates } = require('./api/test-utils/helpers');
const { chromium } = require('playwright-core');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  \u2713', name); }
  else { fail++; console.log('  \u2717 FAIL:', name, detail ? `\u2014 ${detail}` : ''); }
}

// ── Boot a throwaway fixture ────────────────────────────────────────────────
console.log('[boot] throwaway fixture server (SE jurisdiction)');
const srv = await startTestServer({ withAdminToken: false });
const BASE = srv.baseUrl;
const CO = 'RCCO';
const td = testDates();
try {
  // seedCompany's setup.add_company defaults vat_registered=false, which would
  // skip VAT-code insertion AND turn off VAT_ON in the JV page. Create the
  // company ourselves with vat_registered=true so the full SE VAT pack
  // (incl. the SERC reverse-charge code) is seeded, then add a period.
  const co = await api(BASE, 'setup.add_company', {
    company: {
      company_id: CO,
      company_name: `Test ${CO}`,
      jurisdiction: 'SE',
      currency: 'SEK',
      vat_registered: true,
      fy_start: td.fyStart,
      fy_end: td.fyEnd,
    },
  });
  if (co.status !== 200) throw new Error(`add_company failed: ${JSON.stringify(co.body)}`);

  const p = await api(BASE, 'period.upsert', {
    companyId: CO,
    period: { period_id: td.periodId, start_date: td.startDate, end_date: td.endDate },
  });
  if (p.status !== 200) throw new Error(`period.upsert failed: ${JSON.stringify(p.body)}`);

  const coaRes = await api(BASE, 'coa.list', { companyId: CO });
  const accounts = (coaRes.body && (coaRes.body.data || coaRes.body)) || [];
  if (!accounts.length) throw new Error('seed did not yield a COA');

  // Pick a debit (Expense) and a credit offset (Asset / cash-like).
  const expAcct = accounts.find(a => a.account_type === 'Expense')
    || accounts.find(a => /^[45]/.test(a.account_code));
  const offsetAcct = accounts.find(a => a.account_type === 'Asset')
    || accounts[0];
  if (!expAcct || !offsetAcct) throw new Error('could not pick debit/credit accounts');
  const expCode = expAcct.account_code;
  const offCode = offsetAcct.account_code;
  console.log('  expense (DR):', expCode, '\u00b7 offset (CR):', offCode);

  // Confirm the SERC reverse-charge code is seeded and flagged RC.
  const vatRes = await api(BASE, 'vat.codes.list', { companyId: CO });
  const vatCodes = (vatRes.body && (vatRes.body.data || vatRes.body)) || [];
  const serc = vatCodes.find(v => v.vat_code === 'SERC');
  ok('SERC vat code seeded with is_reverse_charge=true', !!(serc && serc.is_reverse_charge), JSON.stringify(serc));
  if (!serc || !serc.is_reverse_charge) throw new Error('SERC RC code missing \u2014 cannot run RC test');

  // ── Browser: Journal Voucher page ──────────────────────────────────────────
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const logs = [];
  page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message));

  console.log('\n[1] navigate to journal voucher');
  await page.goto(`${BASE}/${CO}/journal/voucher`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);

  // The page defaults entry-date to today; the only seeded period is the
  // previous month, so set the entry date into that period to keep
  // journal.post's period validation happy.
  await page.fill('#entry-date', td.day15);

  // Wait for the journal dropdown to populate and auto-select MISC (the page
  // does this itself at line 244-245).  We just confirm it's selected.
  await page.waitForFunction(() => {
    const sel = document.getElementById('entry-journal');
    if (!sel) return false;
    const opts = Array.from(sel.options);
    return opts.some(o => o.text.startsWith('MISC')) && sel.value !== '';
  }, { timeout: 8000 });
  ok('journal MISC auto-selected', true);

  // Wait for the tax-select on the first line to be populated with SERC.
  await page.waitForFunction(() => {
    const sel = document.querySelector('#lines-body tr .tax-select');
    return !!sel && Array.from(sel.options).some(o => o.value === 'SERC');
  }, { timeout: 8000 });
  ok('tax-select populated (SERC option present)', true);

  // Two blank lines are created on load. Line 0 = debit expense + SERC,
  // line 1 = credit offset + no VAT. Set accounts via the page's accountsMap
  // (a window global from the inline script), then amounts + tax via UI.
  console.log('\n[2] fill RC entry (DR 1,000 net + SERC / CR 1,000 offset)');
  await page.evaluate(({ expCode, offCode }) => {
    const rows = document.querySelectorAll('#lines-body tr');
    const setAcct = (tr, code) => {
      const inp = tr.querySelector('.acct-input');
      inp.value = code + ' \u2014 ' + (window.accountsMap[code] || '');
      inp.dataset.code = code;
    };
    setAcct(rows[0], expCode);
    setAcct(rows[1], offCode);
  }, { expCode, offCode });

  await page.fill('#lines-body tr:nth-child(1) .debit-input', '1000');
  await page.selectOption('#lines-body tr:nth-child(1) .tax-select', 'SERC');
  await page.fill('#lines-body tr:nth-child(2) .credit-input', '1000');
  // tax-select on line 1 stays at "" (none)
  await page.waitForTimeout(250); // updateTotals is synchronous on input

  // ── Assertions: balance + post button ─────────────────────────────────────
  console.log('\n[3] balance preview (RC self-balancing)');
  const diff = await page.textContent('#total-diff');
  const postDisabled = await page.evaluate(() => document.getElementById('btn-post').disabled);
  const lineVat = await page.textContent('#lines-body tr:nth-child(1) .vat-display');
  ok('line VAT readout = 250.00 (1000 \u00d7 25%)', lineVat === '250.00', `got ${lineVat}`);
  ok('diff = 0.00 (RC nets to zero)', diff === '0.00', `got ${diff}`);
  ok('btn-post enabled (balanced)', postDisabled === false, `disabled=${postDisabled}`);

  // ── Post + verify success ──────────────────────────────────────────────────
  console.log('\n[4] post entry');
  await page.click('#btn-post');
  await page.waitForFunction(() => {
    const el = document.getElementById('status-msg');
    return !!el && el.textContent.trim().length > 0;
  }, { timeout: 10000 });
  const status = await page.textContent('#status-msg');
  const statusColor = await page.evaluate(() => getComputedStyle(document.getElementById('status-msg')).color);
  ok('post succeeded (status shows Posted)', /^Posted/.test(status), `got "${status}"`);
  ok('status not red (no error)', statusColor !== 'rgb(204, 34, 34)', `color=${statusColor}`);

  const errs = logs.filter(l => l.startsWith('PAGEERROR'));
  ok('no uncaught JS errors', errs.length === 0, errs.join('; '));
  if (errs.length) console.log(errs.join('\n'));

  await browser.close();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
} finally {
  await srv.cleanup();
}
process.exit(fail ? 1 : 0);