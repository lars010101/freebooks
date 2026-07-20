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
 * Seed a company through the action API: jurisdiction COA + VAT codes, one
 * unlocked period covering 2026-07, one vendor. Returns handy account codes.
 */
async function seedCompany(baseUrl, companyId, { jurisdiction = 'SG', currency = 'SGD' } = {}) {
  const c = await api(baseUrl, 'setup.add_company', {
    company: {
      company_id: companyId,
      company_name: `Test ${companyId}`,
      jurisdiction,
      currency,
      fy_start: '2026-01-01',
      fy_end: '2026-12-31',
    },
  });
  if (c.status !== 200) throw new Error(`add_company failed: ${JSON.stringify(c.body)}`);

  const p = await api(baseUrl, 'period.upsert', {
    companyId,
    period: { period_id: '2026-07', start_date: '2026-07-01', end_date: '2026-07-31' },
  });
  if (p.status !== 200) throw new Error(`period.upsert failed: ${JSON.stringify(p.body)}`);

  const v = await api(baseUrl, 'vendor.upsert', {
    companyId,
    vendor: { name: 'Acme Pte Ltd', default_currency: currency },
  });
  if (v.status !== 200) throw new Error(`vendor.upsert failed: ${JSON.stringify(v.body)}`);

  const coa = await api(baseUrl, 'coa.list', { companyId });
  const accounts = coa.body.data || [];
  const ap = accounts.find((a) => a.account_type === 'Liability' && /payable/i.test(a.account_name || ''));
  const exp = accounts.find((a) => a.account_type === 'Expense');
  return { AP: ap && ap.account_code, EXP: exp && exp.account_code, accounts };
}

module.exports = { startTestServer, api, sql, seedCompany };
