import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:4722/testco/bank', { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelectorAll('#rec-body tr').length > 0, { timeout: 8000 });
const state = () => page.evaluate(() => {
  const tr = document.querySelector('#rec-body tr');
  return {
    mode: window.FB && FB.mode ? FB.mode.get() : '?',
    focusRow: !!document.querySelector('#rec-body tr.nav-row-focus'),
    row0cls: tr.className || '(none)',
    row0cb: tr.querySelector('input[type=checkbox]').checked,
    row0cbDisabled: tr.querySelector('input[type=checkbox]').disabled,
    uncleared: (document.getElementById('sum-uncleared') || {}).textContent,
    active: (document.activeElement || {}).tagName
  };
});
const step = async (name, key) => { if (key) await page.keyboard.press(key); await page.waitForTimeout(250); console.log(name, JSON.stringify(await state())); };
await step('loaded');
await step('j', 'j');
await step('~ #1', '~');
await page.waitForTimeout(600); console.log('~ #1 +600ms', JSON.stringify(await state()));
await step('~ #2', '~');
await page.waitForTimeout(600); console.log('~ #2 +600ms', JSON.stringify(await state()));
await browser.close();
