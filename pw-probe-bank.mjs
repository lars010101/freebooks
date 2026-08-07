import { chromium } from 'playwright-core';
const b = await chromium.launch();
const p = await (await b.newContext()).newPage();
p.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300)); });
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 500)));
await p.goto('http://localhost:4722/testco/bank', { waitUntil: 'networkidle' });
p.on('response', async r => {
  if (r.url().includes('/api/action')) {
    const pd = r.request().postData() || '';
    if (pd.includes('reconcile.list')) console.log('[reconcile.list →]', r.status(), (await r.text()).slice(0, 200));
  }
});
await p.selectOption('#rec-account', '1090').catch(e => console.log('[select fail]', String(e).slice(0, 200)));
await p.waitForTimeout(2500);
console.log('rows:', await p.locator('#rec-body tr').count());
console.log('status text:', await p.evaluate(() => { const el = document.getElementById('rec-status'); return el ? el.textContent : '(none)'; }));
await b.close();
