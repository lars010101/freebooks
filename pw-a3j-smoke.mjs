
import { chromium } from 'playwright-core';
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.goto('http://127.0.0.1:4722/testco/journal', { waitUntil: 'networkidle' });
await p.waitForTimeout(1200);
const state = await p.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('#page-main tr')).map(tr => tr.textContent);
  const badge = document.querySelector('.sb-badge');
  return {
    proposed: rows.filter(t => /AGT-SMOKE-1|proposed/i.test(t)).length,
    badgeText: badge ? badge.textContent.trim() : null,
    hintLen: (document.getElementById('sb-hints') || {}).textContent?.length || 0
  };
});
console.log(JSON.stringify({ errs, ...state }));
await b.close();
