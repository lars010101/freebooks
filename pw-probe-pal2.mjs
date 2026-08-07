import { chromium } from 'playwright-core';
const b = await chromium.launch();
const p = await (await b.newContext()).newPage();
await p.goto('http://127.0.0.1:4722/testco', { waitUntil: 'networkidle' });
await p.waitForTimeout(400);
await p.keyboard.press(':');
await p.waitForTimeout(500);
await p.keyboard.type('vat code', { delay: 15 });
await p.waitForTimeout(400);
const rows = await p.evaluate(() => Array.from(document.querySelectorAll('.fb-palette-row')).map(r => ({
  label: (r.querySelector('.fb-palette-label') || {}).textContent,
  scope: (r.querySelector('.fb-palette-scope') || {}).textContent
})));
console.log('rows:', JSON.stringify(rows, null, 1));
// click the first api-scope row and watch the URL
const before = p.url();
await p.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('.fb-palette-row'));
  const api = rows.find(r => (r.querySelector('.fb-palette-scope') || {}).textContent === 'api');
  if (api) api.click();
});
await p.waitForTimeout(1200);
console.log('url before:', before, '→ after:', p.url());
await b.close();
