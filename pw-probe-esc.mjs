import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:4722/PW/reports', { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.getElementById('rpt-period').options.length > 1);
await page.evaluate(() => {
  window._probe = [];
  window.addEventListener('keydown', e => window._probe.push(e.key), true);
});
// Case A: plain programmatic focus, NO showPicker attempt
await page.evaluate(() => document.getElementById('rpt-type').focus());
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
// Case B: after a showPicker attempt (expected to throw headless)
await page.evaluate(() => {
  const el = document.getElementById('rpt-type');
  try { el.showPicker(); } catch (e) { window._spErr = e.name + ': ' + e.message; }
  el.focus();
});
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
// Case C: j on the focused select (control — should fire)
await page.keyboard.press('j');
await page.waitForTimeout(150);
console.log('showPicker error:', await page.evaluate(() => window._spErr || 'none'));
console.log('probe:', JSON.stringify(await page.evaluate(() => window._probe)));
await browser.close();
