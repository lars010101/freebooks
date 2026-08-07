// Verify COA grid: header present for effective_from, no row wrap in NORMAL mode.
import { chromium } from 'playwright-core';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1280, height: 800 } });
await pg.goto('http://localhost:4722/mdu_ab/settings?tab=coa', { waitUntil: 'networkidle' });
await pg.waitForTimeout(800);

const res = await pg.evaluate(() => {
  const t = document.querySelector('#coa-table');
  if (!t) return { err: 'no #coa-table' };
  const ths = [...t.querySelectorAll('thead th')].map(th => th.textContent.trim());
  const rows = [...t.querySelectorAll('tbody tr')];
  // wrap detector: any row taller than 1.5x the median row height
  const hs = rows.map(r => r.getBoundingClientRect().height).filter(h => h > 0).sort((a, b) => a - b);
  const med = hs[Math.floor(hs.length / 2)] || 0;
  const wrapped = rows.filter(r => r.getBoundingClientRect().height > med * 1.5).length;
  const overflow = t.scrollWidth > t.clientWidth + 1;
  return { ths, rowCount: rows.length, medianH: med, wrapped, overflow,
           tableW: t.scrollWidth, clientW: t.clientWidth };
});
console.log(JSON.stringify(res, null, 1));
await b.close();
