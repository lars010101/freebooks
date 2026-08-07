import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('CONSOLE:', m.type(), m.text()); });
await page.goto('http://127.0.0.1:4722/testco/bank/reconcile', { waitUntil: 'networkidle' });
const diag = await page.evaluate(() => {
  const out = { hasFB: !!window.FB, hasForm: !!(window.FB && FB.form), hasKeys: !!(window.FB && FB.keys) };
  if (out.hasKeys) {
    out.keysApi = Object.keys(FB.keys);
    try { out.hasActive = FB.keys.hasActive ? FB.keys.hasActive() : 'n/a'; } catch (e) { out.hasActive = 'ERR ' + e.message; }
  }
  out.recFormType = typeof recForm;
  out.filterRowExists = !!document.querySelector('.rec-filter-row');
  out.filterRowCells = document.querySelector('.rec-filter-row')
    ? document.querySelector('.rec-filter-row').querySelectorAll('input,select,textarea').length : -1;
  out.sbHints = !!document.getElementById('sb-hints');
  return out;
});
console.log(JSON.stringify(diag, null, 1));
await browser.close();
