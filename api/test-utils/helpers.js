'use strict';
/**
 * freeBooks — contract-test helpers (P1-2)
 *
 * Boots a throwaway API server (own DuckDB file, own port) for tests and
 * seeds a minimal company ENTIRELY through the public action API — the same
 * surface agents use. No direct DB access, no fixtures drift.
 *
 * Usage:
 *   const { startTestServer, api, seedCompany } = require('./helpers');
 *   const srv = await startTestServer();           // before hook
 *   await seedCompany(srv.baseUrl, 'T');           // per suite
 *   ... api(srv.baseUrl, 'bill.create', {...})
 *   await srv.cleanup();                           // after hook
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const API_DIR = path.join(REPO_ROOT, 'api');

let _portCounter = 3900 + (process.pid % 100);

function runInit(dbPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(REPO_ROOT, 'db/init.js')], {
      env: { ...process.env, FREEBOOKS_DB_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`db/init.js exited ${code}: ${err}`))));
  });
}

async function waitForHealth(baseUrl, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server at ${baseUrl} did not become healthy within ${timeoutMs}ms`);
}

async function startTestServer({ withAdminToken = true } = {}) {
  const port = _portCounter++;
  const dbPath = `/tmp/fb-contract-${process.pid}-${port}.duckdb`;
  for (const suffix of ['', '.wal']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* fresh */ }
  }
  await runInit(dbPath);

  const env = {
    ...process.env,
    FREEBOOKS_DB_PATH: dbPath,
    PORT: String(port),
  };
  if (withAdminToken) env.FREEBOOKS_ADMIN_TOKEN = 'contract-test-token';
  else delete env.FREEBOOKS_ADMIN_TOKEN;

  const child = spawn('node', [path.join(API_DIR, 'src/index.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);

  let cleaned = false;
  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (!child.killed) child.kill('SIGKILL');
    for (const suffix of ['', '.wal']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* already gone */ }
    }
  }

  return { baseUrl, port, dbPath, child, cleanup, adminToken: withAdminToken ? 'contract-test-token' : null };
}

/** Thin client for the action API. Returns { status, body }. */
async function api(baseUrl, action, payload = {}, headers = {}) {
  const r = await fetch(`${baseUrl}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ action, ...payload }),
  });
  let body = null;
  try { body = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body, headers: r.headers };
}

/** Arbitrary SQL via the (token-gated) admin endpoint. */
async function sql(baseUrl, adminToken, query, params = []) {
  const r = await fetch(`${baseUrl}/api/admin/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ sql: query, params }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`admin query failed ${r.status}: ${JSON.stringify(body)}`);
  return body.rows || [];
}

/**
 * Derive test dates from the PREVIOUS month so all transaction dates are
 * guaranteed in the past (the server rejects future posting dates).  Tests
 * import this and use the returned constants instead of hardcoded dates —
 * the suite is wall-clock independent (issue #111).
 */
function testDates() {
  const now = new Date();
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth(); // 0-indexed

  // Use the PREVIOUS month as the test month — all days are in the past.
  if (m === 0) { y -= 1; m = 11; } else { m -= 1; }

  const year = String(y);
  const periodId = `${y}-${String(m + 1).padStart(2, '0')}`;
  const monthStart = `${periodId}-01`;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const monthEnd = `${periodId}-${String(lastDay).padStart(2, '0')}`;
  const d = (day) => `${periodId}-${String(day).padStart(2, '0')}`;

  // Two months before the test month (for locked-period tests that need a
  // DIFFERENT period, also in the past).
  let prevY, prevM;
  if (m === 0) { prevY = y - 1; prevM = 11; } else { prevY = y; prevM = m - 1; }
  const prevPeriodId = `${prevY}-${String(prevM + 1).padStart(2, '0')}`;
  const prevMonthStart = `${prevPeriodId}-01`;
  const prevLastDay = new Date(Date.UTC(prevY, prevM + 1, 0)).getUTCDate();
  const prevMonthEnd = `${prevPeriodId}-${String(prevLastDay).padStart(2, '0')}`;
  const prevDay15 = `${prevPeriodId}-15`;

  // Month AFTER the test month (= the current month — for A2 period-transition
  // tests that need a non-test period; no transactions are posted to it).
  let nextY, nextM;
  if (m === 11) { nextY = y + 1; nextM = 0; } else { nextY = y; nextM = m + 1; }
  const nextMonthId = `${nextY}-${String(nextM + 1).padStart(2, '0')}`;
  const nextMonthStart = `${nextMonthId}-01`;
  const nextMonthLastDay = new Date(Date.UTC(nextY, nextM + 1, 0)).getUTCDate();
  const nextMonthEnd = `${nextMonthId}-${String(nextMonthLastDay).padStart(2, '0')}`;

  // SIE format dates (YYYYMMDD, no dashes).
  const sieDay = (day) => `${periodId.replace(/-/g, '')}${String(day).padStart(2, '0')}`;
  const sieFYStart = `${y}0101`;
  const sieFYEnd = `${y}1231`;

  return {
    year,
    periodId,
    startDate: monthStart,
    endDate: monthEnd,
    fyStart: `${y}-01-01`,
    fyEnd: `${y}-12-31`,
    day: d,
    day15: d(15), day16: d(16), day17: d(17), day18: d(18),
    day19: d(19), day20: d(20), day21: d(21), day22: d(22), day23: d(23),
    day25: d(25),
    prevPeriodId,
    prevMonthStart,
    prevMonthEnd,
    prevDay15,
    nextMonthId,
    nextMonthStart,
    nextMonthEnd,
    sieDay,
    sieDay15: sieDay(15),
    sieFYStart,
    sieFYEnd,
  };
}

/**
 * Seed a company through the action API: jurisdiction COA + VAT codes, one
 * unlocked period covering the previous month (all test dates are in the past;
 * void actions reverse with reversalDate = server "today" — seedVoidCoverPeriod
 * handles that separately), one vendor.
 * Returns handy account codes.
 */
async function seedCompany(baseUrl, companyId, { jurisdiction = 'SG', currency = 'SGD' } = {}) {
  const td = testDates();
  const c = await api(baseUrl, 'setup.add_company', {
    company: {
      company_id: companyId,
      company_name: `Test ${companyId}`,
      jurisdiction,
      currency,
      fy_start: td.fyStart,
      fy_end: td.fyEnd,
    },
  });
  if (c.status !== 200) throw new Error(`add_company failed: ${JSON.stringify(c.body)}`);

  const p = await api(baseUrl, 'period.upsert', {
    companyId,
    period: { period_id: td.periodId, start_date: td.startDate, end_date: td.endDate },
  });
  if (p.status !== 200) throw new Error(`period.upsert failed: ${JSON.stringify(p.body)}`);

  const v = await api(baseUrl, 'partner.upsert', {
    companyId,
    partner: { name: 'Acme Pte Ltd', default_currency: currency },
  });
  if (v.status !== 200) throw new Error(`partner.upsert failed: ${JSON.stringify(v.body)}`);

  const coa = await api(baseUrl, 'coa.list', { companyId });
  const accounts = coa.body.data || [];
  const ap = accounts.find((a) => a.account_type === 'Liability' && /payable/i.test(a.account_name || ''));
  const exp = accounts.find((a) => a.account_type === 'Expense');
  return { AP: ap && ap.account_code, EXP: exp && exp.account_code, accounts };
}

module.exports = { startTestServer, api, sql, seedCompany, testDates, runInit };
