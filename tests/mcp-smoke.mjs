// tests/mcp-smoke.mjs — MCP server smoke test (Phase A, spec §5.3).
//
// Spawns the freebooks MCP server (mcp/server.js) against a throwaway fixture
// API server and drives it over stdio JSON-RPC 2.0:
//   initialize → notifications/initialized → tools/list (assert the §5.2
//   manifest — exactly the four tools, no mutating action) → tools/call
//   event_list round-trip → freebooks_read {journal.list} ok → freebooks_read
//   {journal.post} client-side refusal → journal_propose a balanced batch
//   inside an open period (assert proposalId) → verify via the action API that
//   the proposal landed with source 'agent' and request_id == the MCP session's
//   X-Request-Id → attachment_upload a tiny text file via contentBase64 (assert
//   attachment_id) → cleanup with attachment.delete.
//
// Mirrors tests/reversal.mjs conventions: a plain node script, exits non-zero
// on any failure, logs ✓/✗ per assertion. Run: node tests/mcp-smoke.mjs

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { startTestServer, api, sql, seedCompany } = require('../api/test-utils/helpers.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_JS = path.join(REPO_ROOT, 'mcp', 'server.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL:', name, detail ? `— ${detail}` : ''); }
}
function eq(name, actual, expected) {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  ok(name, match, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── MCP stdio JSON-RPC 2.0 client ────────────────────────────────────────────
class McpClient {
  constructor(child) { this.child = child; this._buf = ''; this._queue = []; this._waiting = null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      this._buf += d;
      let nl;
      while ((nl = this._buf.indexOf('\n')) !== -1) {
        const line = this._buf.slice(0, nl).replace(/\r$/, '');
        this._buf = this._buf.slice(nl + 1);
        if (line.trim() === '') continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (this._waiting && msg.id === this._waiting.id) {
          const w = this._waiting; this._waiting = null; w.resolve(msg);
        }
      }
    });
  }
  send(msg) { this.child.stdin.write(JSON.stringify(msg) + '\n'); }
  notify(method, params = {}) { this.send({ jsonrpc: '2.0', method, params }); }
  async call(method, params, id) {
    const req = { jsonrpc: '2.0', method, params, id };
    const p = new Promise((resolve) => { this._waiting = { id, resolve }; });
    this.send(req);
    return p;
  }
}

// ── boot the fixture API server + seed company CT + users ─────────────────────
const srv = await startTestServer({ withAdminToken: true });
const baseUrl = srv.baseUrl;
const CO = 'CT';
const seeded = await seedCompany(baseUrl, CO);
const AP = seeded.AP, EXP = seeded.EXP;
ok('seedCompany yields AP + EXP accounts', !!(AP && EXP), `AP=${AP} EXP=${EXP}`);

// Exact INSERTs from api/test/contract.test.js (lines ~24-35): owner@ct + agent@ct.
await sql(baseUrl, srv.adminToken,
  `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
   VALUES ('owner@ct', 'CT', 'owner', now(), 'test')`);
await sql(baseUrl, srv.adminToken,
  `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
   VALUES ('agent@ct', 'CT', 'agent', now(), 'test')`);
ok('seeded owner@ct + agent@ct via admin SQL', true);

// seedCompany already opened period 2026-07 (period.upsert) — reuse for the
// proposal batch date. Confirm it is present and unlocked.
const periods = await sql(baseUrl, srv.adminToken,
  `SELECT period_name, locked FROM periods WHERE company_id='CT' AND period_name='2026-07'`);
ok('open period 2026-07 seeded', periods.length === 1 && !periods[0].locked, JSON.stringify(periods));

// ── spawn the MCP server ──────────────────────────────────────────────────────
const REQUEST_ID = randomUUID();
const child = spawn('node', [SERVER_JS], {
  env: {
    ...process.env,
    FREEBOOKS_API_URL: baseUrl,
    FREEBOOKS_USER: 'agent@ct',
    FREEBOOKS_COMPANY: CO,
    FREEBOOKS_REQUEST_ID: REQUEST_ID,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderrBuf = '';
child.stderr.on('data', (d) => { stderrBuf += d.toString(); process.stderr.write(d); });
child.on('error', (e) => { console.error('MCP child error:', e); });

// Wait for the server's ready line on stderr (allowlist built, transport connected).
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('MCP server did not signal ready')), 15000);
  const iv = setInterval(() => {
    if (stderrBuf.includes('[freebooks-mcp] ready')) { clearTimeout(t); clearInterval(iv); resolve(); }
  }, 100);
});
ok('MCP server booted (ready on stderr)', true);

const mcp = new McpClient(child);

// ── initialize ───────────────────────────────────────────────────────────────
const init = await mcp.call('initialize', {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'mcp-smoke', version: '1.0.0' },
}, 1);
ok('initialize returns result', !!(init && init.result), JSON.stringify(init && init.error));
ok('initialize advertises tools capability', !!(init.result && init.result.capabilities && init.result.capabilities.tools));
ok('initialize serverInfo.name = freebooks-mcp', init.result && init.result.serverInfo && init.result.serverInfo.name === 'freebooks-mcp');
mcp.notify('notifications/initialized');

// ── tools/list — assert the §5.2 manifest exactly ────────────────────────────
const tl = await mcp.call('tools/list', {}, 2);
const tools = (tl.result && tl.result.tools) || [];
const names = tools.map((t) => t.name).sort();
eq('tools/list returns exactly the 4 §5.2 tools', names,
  ['attachment_upload', 'event_list', 'freebooks_read', 'journal_propose'].sort());
ok('no approve/reject/post/void/master-data tool in manifest',
  !names.some((n) => /approve|reject|void|post|master|setup\.|period\.|settings\.|permissions\.|vendor\.upsert|coa\./.test(n)),
  names.join(','));
ok('every tool has a name + inputSchema', tools.every((t) => typeof t.name === 'string' && t.inputSchema && typeof t.inputSchema === 'object'));

// ── tools/call event_list — round-trip ok ────────────────────────────────────
const el = await mcp.call('tools/call', { name: 'event_list', arguments: { limit: 10 } }, 3);
ok('event_list round-trip ok (no isError)', !!(el.result && el.result.isError !== true), JSON.stringify(el.result));
ok('event_list returns JSON text content', !!(el.result && Array.isArray(el.result.content) && el.result.content[0] && el.result.content[0].type === 'text'));

// ── tools/call freebooks_read {journal.list} — ok ────────────────────────────
const rj = await mcp.call('tools/call', { name: 'freebooks_read', arguments: { action: 'journal.list' } }, 4);
ok('freebooks_read journal.list ok (no isError)', !!(rj.result && rj.result.isError !== true), JSON.stringify(rj.result));

// ── tools/call freebooks_read {journal.post} — client-side refusal ────────────
const rjp = await mcp.call('tools/call', { name: 'freebooks_read', arguments: { action: 'journal.post' } }, 5);
ok('freebooks_read journal.post → isError (client-side refusal)', !!(rjp.result && rjp.result.isError === true), JSON.stringify(rjp.result));
{
  let refused = false;
  try {
    const body = JSON.parse(rjp.result.content[0].text);
    refused = body.error && body.error.code === 'FORBIDDEN' && /non-mutating|allowlist|read allowlist/i.test(body.error.message);
  } catch {}
  ok('refusal error is FORBIDDEN with the read-allowlist rule', refused, rjp.result && rjp.result.content && rjp.result.content[0] && rjp.result.content[0].text);
}

// ── tools/call journal_propose — a valid 2-line balanced batch (open period) ─
const PROPOSAL_DATE = '2026-07-20';
const propose = await mcp.call('tools/call', {
  name: 'journal_propose',
  arguments: {
    lines: [
      { account_code: EXP, debit: 50, date: PROPOSAL_DATE, description: 'mcp-smoke expense' },
      { account_code: AP, credit: 50, date: PROPOSAL_DATE, description: 'mcp-smoke expense' },
    ],
    description: 'mcp-smoke balanced batch',
    idempotency_key: 'mcp-smoke-' + REQUEST_ID,
  },
}, 6);
let proposalId = null;
{
  const res = propose.result;
  const isOk = !!(res && res.isError !== true && Array.isArray(res.content));
  ok('journal_propose returns ok (no isError)', isOk, JSON.stringify(res));
  let data = null;
  try { data = JSON.parse(res.content[0].text); } catch {}
  proposalId = data && data.proposalId;
  ok('journal_propose returns a proposalId', !!(proposalId && typeof proposalId === 'string'), JSON.stringify(data));
  ok('journal_propose returns warnings array', !!(data && Array.isArray(data.warnings)), JSON.stringify(data));
}

// ── verify the proposal landed with source 'agent' + request_id correlation ──
{
  const list = await api(baseUrl, 'journal.proposal.list', { companyId: CO, userEmail: 'owner@ct', status: 'proposed', limit: 100 });
  ok('journal.proposal.list as owner@ct ok', list.status === 200 && list.body && list.body.ok === true, JSON.stringify(list.body));
  const rows = (list.body && list.body.data) || [];
  const found = rows.find((r) => r.proposal_id === proposalId);
  ok('proposal appears in journal.proposal.list', !!found, `looking for ${proposalId} in ${rows.length} rows`);
  if (found) {
    eq('proposal source = agent', String(found.source), 'agent');
    eq('proposal created_by = agent@ct', String(found.created_by), 'agent@ct');
    eq('proposal request_id = MCP session X-Request-Id', String(found.request_id), REQUEST_ID);
  }
}

// ── tools/call attachment_upload — tiny text file via contentBase64 ──────────
let attachmentId = null;
const ATTACH_IDEM_KEY = 'mcp-smoke-attach-' + REQUEST_ID;
{
  const text = 'mcp-smoke attachment content\n';
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const up = await mcp.call('tools/call', {
    name: 'attachment_upload',
    arguments: {
      entityType: 'journal',
      entityId: proposalId,
      filename: 'mcp-smoke.txt',
      contentBase64: b64,
      contentType: 'text/plain',
      idempotency_key: ATTACH_IDEM_KEY,
    },
  }, 7);
  const res = up.result;
  ok('attachment_upload ok (no isError)', !!(res && res.isError !== true), JSON.stringify(res));
  let data = null;
  try { data = JSON.parse(res.content[0].text); } catch {}
  attachmentId = data && data.attachment_id;
  ok('attachment_upload returns attachment_id', !!(attachmentId && typeof attachmentId === 'string'), JSON.stringify(data));
}

// ── tools/call attachment_upload idempotent replay (Phase A hardening) ───────
// Same idempotency_key + identical payload → the action API replays the stored
// response: SAME attachment_id, no second file/row written.
{
  const text = 'mcp-smoke attachment content\n';
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const replay = await mcp.call('tools/call', {
    name: 'attachment_upload',
    arguments: {
      entityType: 'journal',
      entityId: proposalId,
      filename: 'mcp-smoke.txt',
      contentBase64: b64,
      contentType: 'text/plain',
      idempotency_key: ATTACH_IDEM_KEY,
    },
  }, 8);
  const res = replay.result;
  ok('attachment_upload replay ok (no isError)', !!(res && res.isError !== true), JSON.stringify(res));
  let data = null;
  try { data = JSON.parse(res.content[0].text); } catch {}
  const replayId = data && data.attachment_id;
  ok('attachment_upload replay returns the SAME attachment_id (idempotent)', replayId === attachmentId, `first=${attachmentId} replay=${replayId}`);
}

// ── cleanup: attachment.delete as owner@ct ────────────────────────────────────
if (attachmentId) {
  const del = await api(baseUrl, 'attachment.delete', { companyId: CO, userEmail: 'owner@ct', attachmentId });
  ok('attachment.delete as owner@ct ok', del.status === 200 && del.body && del.body.ok === true, JSON.stringify(del.body));
}

// ── teardown ──────────────────────────────────────────────────────────────────
child.kill('SIGTERM');
await new Promise((r) => child.once('exit', () => r()));
await srv.cleanup();

console.log(`\nmcp-smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
