// pw-k3d.mjs — K3d verification: ArrowDown/ArrowUp select parity, iframe
// key-forwarding, bank import discoverability + empty state.
//
// Run against fixture :4722 company PW (exists, FY2026 periods seeded).
// Usage: node pw-k3d.mjs   (server must be running on :4722)
import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:4722';
const CO = 'PW';
let pass = 0, fail = 0;
const results = [];
function ok(name, cond) {
  if (cond) { pass++; results.push(`  ✓ ${name}`); }
  else { fail++; results.push(`  ✗ FAIL: ${name}`); }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const logs = [];
page.on('console', m => logs.push(m.text()));
page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message));

// ── helpers ──
async function cursorId() {
  return await page.evaluate(() => {
    const el = document.querySelector('.fb-form-cursor');
    return el ? (el.id || el.tagName) : null;
  });
}
async function getMode() {
  return await page.evaluate(() => window.FB && FB.mode ? FB.mode.get() : 'NORMAL');
}

// ════════════════════════════════════════════════════════════════════════
// [1] NORMAL ArrowDown/ArrowUp on an attachable select (rpt-type) → FULL
// overlay list (FB.dropdown; magnus 2026-07-28 — no blind value-stepping)
// ════════════════════════════════════════════════════════════════════════
console.log('\n[1] ArrowDown/ArrowUp on select (rpt-type) → full overlay list');
await page.goto(`${BASE}/${CO}/reports`, { waitUntil: 'networkidle' });
await page.waitForFunction(
  () => document.getElementById('rpt-type') && document.getElementById('rpt-type').options.length > 1,
  { timeout: 5000 }
);
await page.waitForFunction(() => document.getElementById('rpt-start').value, { timeout: 3000 });

// Cursor should start on rpt-type (first cell of the header-only form)
ok('cursor starts on rpt-type', (await cursorId()) === 'rpt-type');

const ddOpen = () => page.evaluate(() => FB.dropdown.isOpen());
const ddCount = () => page.evaluate(() => document.querySelectorAll('.fb-dd-item, [class*="fb-dd"][class*="item"]').length);

// ── ArrowDown opens the full overlay ──
ok('mode is NORMAL before ArrowDown', (await getMode()) === 'NORMAL');
const typeBefore = await page.evaluate(() => document.getElementById('rpt-type').value);
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(300);
ok('ArrowDown opens the full list overlay', await ddOpen());
ok('overlay lists options (>1)', (await ddCount()) > 1);
ok('mode INSERT while overlay owns keys', (await getMode()) === 'INSERT');
ok('value UNCHANGED while overlay browses (no blind stepping)',
   (await page.evaluate(() => document.getElementById('rpt-type').value)) === typeBefore);
ok('select NOT DOM-focused (no dual selector)',
   await page.evaluate(() => document.activeElement.id !== 'rpt-type'));

// ── Esc closes, back to NORMAL, no change fired ──
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
ok('Esc closes overlay', !(await ddOpen()));
ok('Esc returns to NORMAL', (await getMode()) === 'NORMAL');
ok('value still unchanged after Esc',
   (await page.evaluate(() => document.getElementById('rpt-type').value)) === typeBefore);

// ── ArrowUp also opens; arrows move; Enter picks + change + NORMAL ──
await page.keyboard.press('ArrowUp');
await page.waitForTimeout(250);
ok('ArrowUp opens the overlay too', await ddOpen());
await page.keyboard.press('ArrowDown'); // move active to first item
await page.waitForTimeout(150);
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
ok('Enter picks → overlay closed', !(await ddOpen()));
ok('pick committed a value (change fired → non-empty type)',
   !!(await page.evaluate(() => document.getElementById('rpt-type').value)));
ok('mode NORMAL after pick', (await getMode()) === 'NORMAL');

// ── Explicit edit path still works: Enter → INSERT stepping, Esc reverts ──
await page.keyboard.press('Enter'); // edit() → INSERT stepping (select cell)
await page.waitForTimeout(200);
ok('Enter on select cell → INSERT', (await getMode()) === 'INSERT');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
ok('Esc exits INSERT → NORMAL', (await getMode()) === 'NORMAL');
console.log('\n[2] Iframe key-forwarding — parent keys survive iframe focus');

// Select the first available report type to trigger fbLoadReport
const firstRptValue = await page.evaluate(() => {
  const sel = document.getElementById('rpt-type');
  for (let i = 0; i < sel.options.length; i++) {
    if (sel.options[i].value && !sel.options[i].disabled) return sel.options[i].value;
  }
  return null;
});
ok('found a report type to select', !!firstRptValue);

if (firstRptValue) {
  // Selecting triggers fbOnTypeChange → fbLoadReport → iframe src set
  await page.selectOption('#rpt-type', firstRptValue);

  // Wait for the iframe to load real content (not about:blank)
  await page.waitForFunction(
    () => {
      const f = document.getElementById('report-frame');
      return f && f.src && !f.src.endsWith('about:blank') && f.contentDocument;
    },
    { timeout: 10000 }
  );
  await page.waitForTimeout(600); // let the load listener run (theme + forwardIframeKeys)

  // Verify the forwarding marker was set on the iframe document
  const forwarded = await page.evaluate(() => {
    const f = document.getElementById('report-frame');
    return !!(f && f.contentDocument && f.contentDocument._fbKeysForwarded);
  });
  ok('forwardIframeKeys marker set on iframe document', forwarded);

  // Find the iframe's content frame
  const frame = page.frames().find(f => f !== page.mainFrame() && f.url().includes('/report'));
  ok('iframe content frame found', !!frame);

  if (frame) {
    // Simulate clicking into the iframe body (move focus inside the frame)
    await frame.evaluate(() => document.body.focus());

    // Ensure cursor is on rpt-type before the forwarding test.
    // The selectOption call may have moved the cursor; press h to go back.
    while ((await cursorId()) !== 'rpt-type') {
      await page.keyboard.press('h');
      await page.waitForTimeout(30);
    }
    ok('cursor on rpt-type before iframe forwarding test', (await cursorId()) === 'rpt-type');

    // Dispatch a keydown inside the iframe document — the forwarding
    // listener should re-dispatch on the parent document, so the FB.keys
    // capture-phase dispatcher receives it and moves the cursor.
    await frame.evaluate(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', bubbles: true, cancelable: true })
      );
    });
    await page.waitForTimeout(100);
    ok('l via iframe forwarding → cursor moves to rpt-period', (await cursorId()) === 'rpt-period');

    await frame.evaluate(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'h', code: 'KeyH', bubbles: true, cancelable: true })
      );
    });
    await page.waitForTimeout(100);
    ok('h via iframe forwarding → cursor back to rpt-type', (await cursorId()) === 'rpt-type');
  }
}

// ════════════════════════════════════════════════════════════════════════
// [3] Bank page — Import statement anchor + empty-state text
// ════════════════════════════════════════════════════════════════════════
console.log('\n[3] Bank page — Import statement anchor + empty state');
await page.goto(`${BASE}/${CO}/bank`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.getElementById('bank-panel-txn'), { timeout: 5000 });
await page.waitForTimeout(1000); // let auto-load (setTimeout 150ms) + fetch complete

// ── Import tab (magnus 2026-07-28: Import Statement is a Bank tab) ──
const importTab = await page.evaluate(() => {
  const tabs = Array.from(document.querySelectorAll('.tabs .tab')).map(t => ({ id: t.id, text: t.textContent.trim() }));
  return tabs;
});
const tabOrder = importTab.map(t => t.text).join('|');
ok('Import tab exists between Transactions and Mappings', tabOrder === 'Transactions|Import|Mappings');
// click it → panel shows + lazy init runs (fbInitBankImport defined)
await page.click('#bank-tab-import');
await page.waitForTimeout(600);
ok('Import panel visible after tab click', await page.evaluate(() => document.getElementById('bank-panel-import').style.display !== 'none'));
ok('import wizard initialized (form set active)', await page.evaluate(() => window.__fbImportInited === true));
// back to Transactions for the subsequent txn-panel assertions
await page.click('#bank-tab-txn');
await page.waitForTimeout(400);

// ── Empty-state div ──
const emptyState = await page.evaluate(() => {
  const el = document.getElementById('bank-empty-state');
  if (!el) return null;
  const cs = window.getComputedStyle(el);
  return {
    display: el.style.display,
    visible: el.offsetParent !== null && cs.display !== 'none',
    text: el.textContent.replace(/\s+/g, ' ').trim()
  };
});
ok('empty-state div exists', !!emptyState);

if (emptyState) {
  // Check text content covers both purposes
  ok('empty-state mentions review/categorize', /review|categorize/i.test(emptyState.text));
  ok('empty-state mentions mapping rules', /mapping/i.test(emptyState.text));
  ok('empty-state mentions Import statement', /import statement/i.test(emptyState.text));
  ok('empty-state mentions palette / Bank Import', /palette|Bank Import/i.test(emptyState.text));

  // Visibility depends on whether there are transactions
  const txnCount = await page.evaluate(() => document.querySelectorAll('#rec-body tr').length);
  if (txnCount === 0) {
    ok('empty-state visible when zero transactions', emptyState.visible);
  } else {
    ok('empty-state hidden when transactions exist', !emptyState.visible);
    console.log(`  (note: PW has ${txnCount} txn rows — empty-state hidden as expected)`);
  }
}

// ════════════════════════════════════════════════════════════════════════
// [4] No JS errors
// ════════════════════════════════════════════════════════════════════════
console.log('\n[4] Console errors');
const errors = logs.filter(l => l.includes('PAGEERROR') || l.includes('Uncaught'));
ok('no uncaught JS errors', errors.length === 0);
if (errors.length) console.log('  ERRORS:', errors);

// ── Summary ──
console.log('\n' + results.join('\n'));
console.log(`\n=== ${pass} passed, ${fail} failed ===`);

await browser.close();
process.exit(fail > 0 ? 1 : 0);
