'use strict';
/**
 * ESM helper that boots a throwaway in-process freeBooks API server for the
 * standalone integration scripts in tests/ (sru-golden, reversal).
 *
 * This mirrors the pattern used by api/test/contract.test.js via the CJS
 * `startTestServer` helper: it spawns `node api/src/index.js` against a fresh
 * throwaway DuckDB file on an ephemeral port, waits for /health, and returns a
 * `baseUrl` + `cleanup()`. No externally-started server is required, so the
 * scripts never hit ECONNREFUSED (issue #112).
 *
 * Usage (ESM):
 *   import { startServer, apiPost, apiGetText, apiGetJson } from '../lib/test-server.mjs';
 *   const srv = await startServer();
 *   try { ... await apiPost(srv.baseUrl, 'journal.post', co, {...}); }
 *   finally { await srv.cleanup(); }
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const API_INDEX = path.join(REPO_ROOT, 'api/src/index.js');
const DB_INIT = path.join(REPO_ROOT, 'db/init.js');

let _portCounter = 4700 + (process.pid % 50);

function runInit(dbPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [DB_INIT], {
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

/**
 * Boot a throwaway server. Returns { baseUrl, port, dbPath, cleanup }.
 * @param {{adminToken?: boolean}} [opts]
 */
export async function startServer({ adminToken = true } = {}) {
  const port = _portCounter++;
  const dbPath = `/tmp/fb-script-${process.pid}-${port}.duckdb`;
  for (const suffix of ['', '.wal']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* fresh */ }
  }
  await runInit(dbPath);

  const env = { ...process.env, FREEBOOKS_DB_PATH: dbPath, PORT: String(port) };
  if (adminToken) env.FREEBOOKS_ADMIN_TOKEN = 'script-test-token';
  else delete env.FREEBOOKS_ADMIN_TOKEN;

  const child = spawn('node', [API_INDEX], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => { process.stderr.write(`[server] ${d}`); });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);

  let cleaned = false;
  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 400));
    if (!child.killed) { try { child.kill('SIGKILL'); } catch { /* */ } }
    for (const suffix of ['', '.wal']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* already gone */ }
    }
  }

  return { baseUrl, port, dbPath, child, cleanup, adminToken: adminToken ? 'script-test-token' : null };
}

// ── HTTP helpers (operate against the booted baseUrl) ────────────────────────

/** POST /api with an action envelope. Returns `data` on ok, throws on error. */
export async function apiPost(baseUrl, action, companyId, body, idempotencyKey) {
  const payload = { action, companyId, ...(body || {}) };
  if (idempotencyKey) payload.idempotencyKey = idempotencyKey;
  const headers = { 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`${baseUrl}/api`, { method: 'POST', headers, body: JSON.stringify(payload) });
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`API ${action} failed: ${JSON.stringify(json.error)}`);
  }
  return json.data;
}

export async function apiGetText(baseUrl, url) {
  const res = await fetch(url.startsWith('http') ? url : `${baseUrl}${url}`);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}: ${await res.text()}`);
  return res.text();
}

export async function apiGetJson(baseUrl, url) {
  const res = await fetch(url.startsWith('http') ? url : `${baseUrl}${url}`);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}: ${await res.text()}`);
  return res.json();
}
