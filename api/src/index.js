'use strict';
/**
 * freeBooks — Express API entry point
 *
 * Single POST endpoint that routes to action handlers.
 * Same route signatures as the original Cloud Function.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { v4: uuid } = require('uuid');

const { checkPermission, resolveActor, resolveToken, remoteTokenRequired, ROLE_HIERARCHY } = require('./auth');
const { handleJournal } = require('./journal');
const { handleInbox } = require('./inbox');
const { handleBank } = require('./bank');
const { handleBills } = require('./bills');
const { handlePartners } = require('./partners');
const { handleViews } = require('./views');
const { handleReports, mountReportRoutes } = require('./reports');
const { handleVat } = require('./vat');
const { handleWht } = require('./wht');
const { handleFx, providerExists, listProviderIds, MANUAL_PROVIDER, backfillPeriod } = require('./fx');
const { handleSetup } = require('./setup');
const { handleAttachments } = require('./attachments');
const { handleEvents, emitEvent } = require('./events');
const { handleTokens } = require('./tokens');
const { handleSie } = require('./sie-import');
const { handlePeriodsService } = require('./periods-page-service');
const { handleNotifications } = require('./notifications');
const { contactAttributesFor } = require('./jurisdiction-packs');
const { getDb, ensureDb, query, exec, bulkInsert } = require('./db');
const { auditCall } = require('./audit');
const { detectMappingConflicts } = require('./mapping-utils');
const { deriveProfitCenter, isDerivationEnabled } = require('./centers');
const PORT = process.env.PORT || 3000;
// Bind address: loopback-only by default (the safe posture). Set
// FREEBOOKS_BIND to a LAN/Tailscale interface IP for the two-server
// deployment (pair with FREEBOOKS_AUTH_MODE=token-remote — never bind a
// public interface without it; spec §2.5).
const HOST = process.env.FREEBOOKS_BIND || '127.0.0.1';

// Auth mode: 'trust' (default, install-level) | 'token-remote' (non-loopback
// clients must present a valid Bearer token — the two-server deployment mode).
const AUTH_MODE = String(process.env.FREEBOOKS_AUTH_MODE || 'trust').trim();

// P1-1: action metadata is the single source of truth — roles, idempotency,
// mutability/audit behavior, and param schemas all live in action-catalog.js
// and are served to agents at GET /api/actions.
const { ACTIONS } = require('./action-catalog');

const ACTION_ROLES = Object.fromEntries(
  Object.entries(ACTIONS).map(([name, meta]) => [name, meta.role])
);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // base64 attachment uploads travel the action API (attachment.upload); the default 100kb limit would 413 legitimate files

// ── P0-2: Unified error envelope ─────────────────────────────────────────────
// All failure paths in the /api dispatch flow return:
//   { ok: false, error: { code, message, details? } }
// with an HTTP status derived from the error code.
const ERROR_STATUS = {
  INVALID_INPUT: 400,
  VALIDATION: 400,
  INVALID_ACCOUNT: 400,
  INVALID_PARTNER_TYPE: 400,
  UNKNOWN_ACTION: 400,
  PERIOD_UNDEFINED: 400,
  INVALID_STATE: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  UNAUTHENTICATED: 401,
  DUPLICATE: 409,
  CONFLICT: 409,
  INVALID_STATUS: 409,
  ALREADY_REVERSED: 409,
  REFERENTIAL_INTEGRITY: 409,
  DUPLICATE_CODE: 409,
  PERIOD_LOCKED: 409,
  SIE_PARSE: 400,
  IDEMPOTENCY_KEY_REUSED: 409,
};

function statusForCode(code) {
  return ERROR_STATUS[code] || 500;
}

function fail(res, code, message, details) {
  const error = { code: code || 'INTERNAL', message: message || 'Internal error' };
  if (details !== undefined) error.details = details;
  return res.status(statusForCode(error.code)).json({ ok: false, error });
}

// ── P0-4: audit coverage ─────────────────────────────────────────────────────
// Derived from the catalog: mutating actions are audited unless audit:false.
function isAuditableAction(action) {
  const meta = ACTIONS[action];
  return !!meta && meta.mutating === true && meta.audit !== false;
}

// ── P0-1: Idempotency ────────────────────────────────────────────────────────
// Posting actions that must be safe to retry. When the client supplies an
// Idempotency-Key (header, or body.idempotencyKey fallback), the first
// response is persisted in idempotency_keys and identical retries replay it
// instead of re-executing the posting action.
const IDEMPOTENT_ACTIONS = new Set(
  Object.keys(ACTIONS).filter((name) => ACTIONS[name].idempotent === true)
);

/**
 * Wrap res.status / res.json / res.end so the final status + payload of a
 * first-time (MISS) idempotent request is captured and written to
 * idempotency_keys BEFORE the response is sent. Responses with status >= 500
 * are never stored (they are safe to retry). Generic at the dispatch level:
 * covers both the res.end(JSON-string) success path and the
 * res.status(...).json(...) error path used by handleApiRequest.
 */
function wrapIdempotentResponse(res, key, action, companyId) {
  let capturedStatus = 200;
  let persistStarted = false; // res.json → res.send → this.end: persist exactly once
  const origStatus = res.status.bind(res);
  const origJson = res.json.bind(res);
  const origEnd = res.end.bind(res);

  res.status = function (code) {
    capturedStatus = code;
    return origStatus(code);
  };

  async function persist(rawJson) {
    if (persistStarted) return;
    persistStarted = true;
    // Only persist 2xx successes. 4xx failures are deterministic and free to
    // re-execute — storing them would replay a stale error after the client
    // fixes the payload and retries with the same key. >=500 stays retryable.
    if (capturedStatus >= 300) return;
    try {
      await exec(
        `INSERT INTO idempotency_keys (key, action, company_id, http_status, response_json)
         VALUES (@key, @action, @companyId, @status, @json)`,
        { key, action, companyId: companyId || null, status: capturedStatus, json: rawJson }
      );
    } catch (err) {
      // Concurrent same-key race or DB hiccup — log; the response is still sent.
      console.error(`Idempotency persist failed for key '${key}' (${action}):`, err.message);
    }
  }

  res.json = function (payload) {
    let raw = null;
    try { raw = JSON.stringify(payload); } catch { raw = null; }
    const send = () => origJson(payload);
    return raw === null ? send() : persist(raw).then(send, send);
  };

  res.end = function (chunk, encoding) {
    const raw = typeof chunk === 'string' ? chunk
      : (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : null);
    const send = () => origEnd(chunk, encoding);
    return raw === null ? send() : persist(raw).then(send, send);
  };
}

// Serve static files from db directory (e.g., currencies.json)
const path = require('path');
app.use('/db', express.static(path.join(__dirname, '../../db')));
app.use('/public', express.static(path.join(__dirname, '../public'), {
  // maxAge 0 + etag: browser revalidates every load (304 when unchanged) —
  // JS/CSS can never drift out of sync with the server-rendered HTML that
  // references it. Long maxAge here caused stale-fb-core.js bugs in dev.
  maxAge: 0,
  etag: true,
}));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'freebooks-api' }));

// P1-1: machine-readable action catalog — agent self-discovery.
app.get('/api/actions', (_req, res) => res.json({ ok: true, actions: ACTIONS }));

// Mount HTML report routes (GET /  /:company  /api/:company/report  etc.)
mountReportRoutes(app);

async function handleApiRequest(req, res) {
  try {
    const body = req.body;
    let { action, companyId } = body;
    let userEmail = body.userEmail;

    if (!action) return fail(res, 'INVALID_INPUT', 'Missing action');
    if (!action.startsWith('setup.') && !companyId) return fail(res, 'INVALID_INPUT', 'Missing companyId');

    const requiredRole = ACTION_ROLES[action];
    if (!requiredRole) return fail(res, 'INVALID_INPUT', `Unknown action: ${action}`);

    // ── Per-actor API tokens (spec §2.6): a Bearer token authenticates the
    // caller. Valid token → identity comes from the token (body userEmail is
    // IGNORED — no mixed-identity requests). Invalid/revoked token → 401 and
    // NEVER a fall-back to self-asserted identity (downgrade hole). No token
    // → legacy install-level trust, unless FREEBOOKS_AUTH_MODE='token-remote'
    // and the client is non-loopback (the two-server deployment mode).
    const authz = req.get('Authorization') || '';
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(authz);
    let tokenAuth = null;
    if (bearerMatch) {
      tokenAuth = await resolveToken(bearerMatch[1].trim());
      if (!tokenAuth) return fail(res, 'UNAUTHENTICATED', 'Invalid or revoked API token');
      userEmail = tokenAuth.email;
    } else if (remoteTokenRequired(AUTH_MODE, req)) {
      return fail(res, 'UNAUTHENTICATED', 'API token required for remote clients (FREEBOOKS_AUTH_MODE=token-remote)');
    }

    if (userEmail && !action.startsWith('setup.')) {
      const allowed = await checkPermission(userEmail, companyId, requiredRole);
      if (!allowed) return fail(res, 'FORBIDDEN', 'Insufficient permissions');
    }

    // ── A1 (§2.2/§2.3): actor resolution + default-deny whitelist guard ──
    // The actor class comes from the DB role, never from the request (an
    // agent cannot self-assert 'human'). Agents may read + propose only;
    // setup.* is unconditionally forbidden to agents (those actions skip
    // the role check today and must stay human-only), and any mutating
    // action outside AGENT_ALLOWED is FORBIDDEN. This runs BEFORE the
    // idempotency check so a rejected request never persists a response.
    // v1 whitelist: non-mutating actions pass naturally (mutating:false);
    // attachment.upload is admitted here; A3j (§4.3) adds journal.propose so
    // agents can prepare journal batches (never post — that's the human approve).
    // Phase B (agent-readiness-spec §2.3) admits six agent-writable actions:
    //   - attachment.upload   (feed intake — agent never touches disk)
    //   - journal.propose     (prepare batches — human approves to post)
    //   - matching_history.record (learning-store write — proposal outcomes)
    //   - mapping.suggest     (propose bank-mapping rules — human approves)
    //   - bill.create          (agent path saves a DRAFT; human posts via bill.post)
    //   - input_rejection.create (flag statement lines with missing critical data — human retries/discards)
    // Derived from the action catalog's agentWritable flag (single source of
    // truth — the A1 guard-matrix test derives its exclusion set from the same
    // flag, so the two cannot drift). See api/src/action-catalog.js.
    const AGENT_ALLOWED = new Set(Object.entries(ACTIONS).filter(([, m]) => m.agentWritable).map(([name]) => name));
    const actor = userEmail ? await resolveActor(userEmail, companyId) : { role: null, actorType: 'human' };
    const requestId = body.requestId || req.get('X-Request-Id') || null;
    if (actor.actorType === 'agent') {
      if (action.startsWith('setup.')) {
        return fail(res, 'FORBIDDEN', 'Agents may not run setup actions');
      }
      const meta = ACTIONS[action];
      const mutating = !!(meta && meta.mutating === true);
      if (mutating && !AGENT_ALLOWED.has(action)) {
        return fail(res, 'FORBIDDEN', 'Agents may not finalize or mutate master data');
      }
    }

    // P1-1: dispatch-level required-parameter validation from the catalog.
    // Fails fast with every missing field named — before the handler runs.
    const meta = ACTIONS[action];
    if (meta && meta.params) {
      const missing = Object.entries(meta.params)
        .filter(([name, p]) => p.required && (body[name] === undefined || body[name] === null))
        .map(([name]) => name);
      if (missing.length > 0) {
        return fail(res, 'INVALID_INPUT', `Missing required parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`, { missing });
      }
      // P1-1 (strict): declared types are enforced, not advisory. Numeric
      // strings are accepted for 'number' (form-encoded callers) and coerced.
      const TYPE_CHECK = {
        string: (v) => typeof v === 'string',
        number: (v) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))),
        boolean: (v) => typeof v === 'boolean' || v === 'true' || v === 'false',
        object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
        array: (v) => Array.isArray(v),
        date: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v),
      };
      const badType = Object.entries(meta.params)
        .filter(([name, p]) => body[name] !== undefined && body[name] !== null && p.type && TYPE_CHECK[p.type] && !TYPE_CHECK[p.type](body[name]))
        .map(([name, p]) => `${name} (expected ${p.type}, got ${Array.isArray(body[name]) ? 'array' : typeof body[name]})`);
      if (badType.length > 0) {
        return fail(res, 'INVALID_INPUT', `Parameter type mismatch: ${badType.join(', ')}`, { typeMismatch: badType });
      }
    }

    // ── P0-1: idempotency check (dispatch-level, before handler execution) ──
    // Key from `Idempotency-Key` header, fallback body.idempotencyKey. No key
    // → normal execution (legacy behavior unchanged).
    const idemKeyRaw = req.get('Idempotency-Key') || body.idempotencyKey;
    const idemKey = idemKeyRaw != null && String(idemKeyRaw).trim() !== '' ? String(idemKeyRaw) : null;
    // Keys are namespaced per company (stored as 'company|key'): the table's PK
    // is on `key` alone, so scoping must live inside the stored value — a
    // company-scoped WHERE without this replays another company's response
    // (golden test 2026-07-29) and the unscoped INSERT then violates the PK.
    const scopedKey = idemKey && companyId ? `${companyId}|${idemKey}` : idemKey;
    if (scopedKey && IDEMPOTENT_ACTIONS.has(action)) {
      const existing = await query(
        `SELECT action, http_status, response_json FROM idempotency_keys WHERE key = @key`,
        { key: scopedKey }
      );
      if (existing.length > 0) {
        const row = existing[0];
        if (row.action !== action) {
          // Same key reused for a DIFFERENT action → hard conflict.
          return fail(res, 'IDEMPOTENCY_KEY_REUSED', `Idempotency key '${idemKey}' was already used for action '${row.action}'`);
        }
        // HIT → replay the stored response instead of re-executing.
        return res.status(row.http_status || 200).set('Idempotent-Replay', 'true').json(JSON.parse(row.response_json));
      }
      // MISS → capture + persist the first response before it is sent.
      wrapIdempotentResponse(res, scopedKey, action, companyId);
    }

    const ctx = { body, companyId, userEmail, actor, requestId, tokenAuth };
    let result;
    const [module] = action.split('.');

    switch (module) {
      case 'journal':     result = await handleJournal(ctx, action); break;
      case 'inbox':       result = await handleInbox(ctx, action); break;
      case 'bank':        result = await handleBank(ctx, action); break; // bank.process, bank.approve, bank.reconcile.*
      case 'bill':        result = await handleBills(ctx, action); break;
      case 'partner':    result = await handlePartners(ctx, action); break;
      case 'view':        result = await handleViews(ctx, action); break; // P1-8 read models
      case 'report':      result = await handleReports(ctx, action); break;
      case 'vat':         result = await handleVat(ctx, action); break;
      case 'wht':         result = await handleWht(ctx, action); break;
      case 'fx':          result = await handleFx(ctx, action); break;
      case 'coa':         result = await handleCoa(ctx, action); break;
      case 'mapping':     result = await handleMapping(ctx, action); break;
      case 'matching_history': result = await handleMatchingHistory(ctx, action); break;
      case 'input_rejection':  result = await handleInputRejection(ctx, action); break;
      case 'calibration':      result = await handleCalibration(ctx, action); break;
      case 'center':      result = await handleCenter(ctx, action); break;
      case 'journals':   result = await handleJournals(ctx, action); break;
      case 'settings':
      case 'company':
      case 'period':
      case 'posting_rules':
      case 'ai':          result = await handleSettings(ctx, action); break;
      case 'filing':      result = await handlePeriodsService(ctx, action); break;
      case 'permissions': result = await handlePermissions(ctx, action); break;
      case 'setup':       result = await handleSetup(ctx, action); break;
      case 'diag':        result = await handleDiag(ctx, action); break;
      case 'attachment':  result = await handleAttachments(ctx, action); break;
      case 'event':       result = await handleEvents(ctx, action); break;
      case 'auth':        result = await handleTokens(ctx, action); break;
      case 'sie':         result = await handleSie(ctx, action); break;
      case 'notification': result = await handleNotifications(ctx, action); break;
      case 'agent':       result = await handleAgent(ctx, action); break;
      default:
        return fail(res, 'INVALID_INPUT', `Unknown module: ${module}`);
    }

    // P0-4: audit every mutating action after successful execution. Audit
    // failure is logged loudly but must not fail the business request.
    if (isAuditableAction(action)) {
      try {
        // setup.* actions run without a companyId by design (dispatch exempts
        // them). audit_log.company_id is NOT NULL, so the row was silently
        // dropped for every setup action — including setup.add_company, the
        // most audit-worthy event in the system (who created which company,
        // when, with what jurisdiction/currency). Derive the company being
        // created from the payload so the creation event is audited under it.
        // setup.init (schema bootstrap, no company anywhere) stays NULL and
        // remains intentionally unaudited.
        const auditCompanyId = companyId
          || (body && body.company && body.company.company_id)
          || null;
        await auditCall(auditCompanyId, action, userEmail || 'anonymous', body, { actorType: actor.actorType, requestId });
      } catch (auditErr) {
        console.error(`Audit log failed for action ${action}:`, auditErr.message);
      }
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, data: result }, (_key, val) =>
      typeof val === 'bigint' ? Number(val) : val
    ));
  } catch (err) {
    console.error('Handler error:', err);
    fail(res, err.code || 'INTERNAL', err.message || 'Internal error', err.details);
  }
}

app.post('/api', handleApiRequest);
app.post('/api/action', handleApiRequest);

// Attachment routes
const { uploadMiddleware, handleUpload, serveAttachment, runAttachmentGC, handleAdminGC } = require('./attachments');
app.post('/api/upload', uploadMiddleware, handleUpload);
app.get('/api/attachments/:attachmentId', serveAttachment);
// A4 (§4.7): token-gated admin trigger for the attachment GC (mirrors
// /api/admin/query). GC also runs at boot + on a 24h setInterval below.
app.post('/api/admin/gc-attachments', handleAdminGC);

// --- COA ---

async function handleCoa(ctx, action) {
  const { companyId, body } = ctx;

  if (action === 'coa.list') {
    return query(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER(PARTITION BY account_code ORDER BY created_at DESC) AS rn
         FROM accounts WHERE company_id = @companyId
       ) t WHERE rn = 1 ORDER BY account_code`,
      { companyId }
    );
  }
  // NOTE: the COA list also carries default_role via GET /api/:company/accounts
  // (reports.js handleAccounts), which is the payload the settings.js FB.list
  // grid actually consumes.

  if (action === 'coa.save') {
    let { accounts } = body;
    if (!accounts || !Array.isArray(accounts)) throw Object.assign(new Error('accounts array required'), { code: 'INVALID_INPUT' });

    accounts = accounts.filter((a) => a.account_code && String(a.account_code).trim() !== '');
    if (accounts.length === 0) throw Object.assign(new Error('No valid accounts found'), { code: 'INVALID_INPUT' });

    const codes = accounts.map((a) => String(a.account_code).trim());
    const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
    if (dupes.length > 0) throw Object.assign(new Error(`Duplicate account codes: ${dupes.join(', ')}`), { code: 'DUPLICATE_CODE' });

    // Check accounts in use can't be removed
    const usedAccounts = await query(
      `SELECT DISTINCT account_code FROM journal_entries WHERE company_id = @companyId`,
      { companyId }
    );
    const incomingCodes = new Set(codes);
    const blocked = usedAccounts.filter((a) => !incomingCodes.has(a.account_code)).map((a) => a.account_code);
    if (blocked.length > 0) throw Object.assign(new Error(`Cannot remove accounts with transactions: ${blocked.join(', ')}`), { code: 'REFERENTIAL_INTEGRITY' });

    const now = new Date().toISOString();

    // DuckDB: delete removed accounts, then upsert
    const inCodes = codes.map((c) => `'${c.replace(/'/g, "''")}'`).join(',');
    await exec(`DELETE FROM accounts WHERE company_id = @companyId AND account_code NOT IN (${inCodes})`, { companyId });

    for (const a of accounts) {
      const existing = await query(
        `SELECT account_code FROM accounts WHERE company_id = @companyId AND account_code = @code LIMIT 1`,
        { companyId, code: a.account_code }
      );
      if (existing.length > 0) {
        await exec(
          `UPDATE accounts SET account_name = @name, account_type = @type, account_subtype = @subtype,
           cf_category = @cf, is_active = @active,
           effective_from = @from, effective_to = @to, created_at = @now
           WHERE company_id = @companyId AND account_code = @code`,
          { companyId, code: a.account_code, name: a.account_name, type: a.account_type, subtype: a.account_subtype || null, cf: a.cf_category || null, active: a.is_active !== false, from: a.effective_from, to: a.effective_to || null, now }
        );
      } else {
        await bulkInsert('accounts', [{
          company_id: companyId,
          account_code: a.account_code,
          account_name: a.account_name,
          account_type: a.account_type,
          account_subtype: a.account_subtype || null,
          cf_category: a.cf_category || null,
          is_active: a.is_active !== false,
          effective_from: a.effective_from,
          effective_to: a.effective_to || null,
          created_at: now,
        }]);
      }
    }

    return { saved: accounts.length };
  }

  if (action === 'coa.update') {
    const { accounts } = body;
    if (!accounts || !Array.isArray(accounts)) throw Object.assign(new Error('accounts array required'), { code: 'INVALID_INPUT' });
    for (const a of accounts) {
      if (!a.account_code) continue;
      await exec(
        `UPDATE accounts SET account_name = @name, account_subtype = @subtype, cf_category = @cf, is_active = @active WHERE company_id = @companyId AND account_code = @code`,
        { companyId, code: a.account_code, name: a.account_name, subtype: a.account_subtype || null, cf: a.cf_category || null, active: a.is_active !== false }
      );
    }
    return { saved: accounts.length };
  }

  if (action === 'coa.upsert') {
    const { account } = body;
    if (!account || !account.account_code || !account.account_name || !account.account_type) throw Object.assign(new Error('account_code, account_name, account_type required'), { code: 'INVALID_INPUT' });

    // default_role: NULL | 'AP' | 'Expense'. Invalid value -> INVALID_INPUT.
    // Single-holder is enforced here in the SAME write: setting a new holder
    // clears default_role from the company's other accounts that previously
    // held that role (settings-ux-spec §7 item 1, second bullet).
    const ALLOWED_ROLES = new Set([null, '', 'AP', 'Expense', 'FX Gain/Loss']);
    let role = (account.default_role === undefined ? null : account.default_role);
    if (role === '') role = null;
    if (!ALLOWED_ROLES.has(role)) {
      throw Object.assign(new Error(`default_role must be null, 'AP', 'Expense', or 'FX Gain/Loss' (got: ${JSON.stringify(account.default_role)})`), { code: 'INVALID_INPUT' });
    }
    const roleValue = role; // null | 'AP' | 'Expense'

    const now = new Date().toISOString();
    const existing = await query(`SELECT account_code FROM accounts WHERE company_id = @companyId AND account_code = @code`, { companyId, code: account.account_code });

    // Single-holder enforcement + upsert in one transaction. DuckDB
    // connection runs statements sequentially; we clear the previous holder
    // for the chosen role (if any) BEFORE setting the new one so the final
    // state always has at most one account per role per company.
    if (roleValue !== null) {
      await exec(
        `UPDATE accounts SET default_role = NULL
         WHERE company_id = @companyId AND default_role = @role
           AND account_code <> @code`,
        { companyId, role: roleValue, code: account.account_code }
      );
    }

    if (existing.length > 0) {
      await exec(`UPDATE accounts SET account_name=@name, account_type=@type, account_subtype=@subtype, cf_category=@cf, is_active=@active, default_role=@role, effective_from=COALESCE(@effFrom, effective_from) WHERE company_id=@companyId AND account_code=@code`,
        { companyId, code: account.account_code, name: account.account_name, type: account.account_type, subtype: account.account_subtype || null, cf: account.cf_category || null, active: account.is_active !== false, role: roleValue, effFrom: account.effective_from || null });
    } else {
      await bulkInsert('accounts', [{ company_id: companyId, account_code: account.account_code, account_name: account.account_name, account_type: account.account_type, account_subtype: account.account_subtype || null, cf_category: account.cf_category || null, is_active: account.is_active !== false, default_role: roleValue, effective_from: account.effective_from || now, effective_to: null, created_at: now }]);
    }
    return { saved: true, default_role: roleValue };
  }

  if (action === 'coa.delete') {
    const { accountCode } = body;
    if (!accountCode) throw Object.assign(new Error('accountCode required'), { code: 'INVALID_INPUT' });
    const inUse = await query(`SELECT COUNT(*) AS cnt FROM journal_entries WHERE company_id = @companyId AND account_code = @code`, { companyId, code: accountCode });
    if (Number(inUse[0]?.cnt) > 0) throw Object.assign(new Error('Account has transactions and cannot be deleted'), { code: 'REFERENTIAL_INTEGRITY' });
    await exec(`DELETE FROM accounts WHERE company_id = @companyId AND account_code = @code`, { companyId, code: accountCode });
    return { deleted: true };
  }
}

// --- Bank Mappings ---

async function handleMapping(ctx, action) {
  const { companyId, body } = ctx;

  if (action === 'mapping.list') {
    return query(`SELECT * FROM bank_mappings WHERE company_id = @companyId ORDER BY priority`, { companyId });
  }

  if (action === 'mapping.save') {
    const { mappings } = body;
    if (!mappings || !Array.isArray(mappings)) throw Object.assign(new Error('mappings array required'), { code: 'INVALID_INPUT' });

    await exec(`DELETE FROM bank_mappings WHERE company_id = @companyId`, { companyId });

    const rows = mappings.map((m) => ({
      company_id: companyId,
      mapping_id: m.mapping_id || uuid(),
      pattern: m.pattern,
      match_type: m.match_type || 'contains',
      debit_account: m.debit_account,
      credit_account: m.credit_account,
      description_override: m.description_override || null,
      vat_code: m.vat_code || null,
      cost_center: m.cost_center || null,
      profit_center: m.profit_center || null,
      priority: m.priority || 100,
      is_active: m.is_active !== false,
    }));

    if (rows.length > 0) await bulkInsert('bank_mappings', rows);
    return { saved: rows.length };
  }

  if (action === 'mapping.upsert') {
    const { mapping } = body;
    if (!mapping || !mapping.pattern || !mapping.debit_account) throw Object.assign(new Error('pattern and debit_account required'), { code: 'INVALID_INPUT' });
    const mappingId = mapping.mapping_id || uuid();
    const existing = await query(`SELECT mapping_id FROM bank_mappings WHERE company_id = @companyId AND mapping_id = @mappingId`, { companyId, mappingId });
    const row = { company_id: companyId, mapping_id: mappingId, pattern: mapping.pattern, match_type: mapping.match_type || 'contains', debit_account: mapping.debit_account, credit_account: mapping.credit_account || '', description_override: mapping.description_override || null, vat_code: null, cost_center: null, profit_center: null, priority: mapping.priority || 100, is_active: mapping.is_active !== false, amount_sign: mapping.amount_sign || 'any' };
    if (existing.length > 0) {
      await exec(`UPDATE bank_mappings SET pattern=@pattern, match_type=@match_type, debit_account=@debit_account, description_override=@description_override, priority=@priority, is_active=@is_active, amount_sign=@amount_sign WHERE company_id=@companyId AND mapping_id=@mapping_id`,
        { companyId, mapping_id: mappingId, pattern: row.pattern, match_type: row.match_type, debit_account: row.debit_account, description_override: row.description_override, priority: row.priority, is_active: row.is_active, amount_sign: row.amount_sign });
    } else {
      await bulkInsert('bank_mappings', [row]);
    }
    return { saved: true, mappingId };
  }

  if (action === 'mapping.delete') {
    const { mappingId } = body;
    if (!mappingId) throw Object.assign(new Error('mappingId required'), { code: 'INVALID_INPUT' });
    await exec(`DELETE FROM bank_mappings WHERE company_id = @companyId AND mapping_id = @mappingId`, { companyId, mappingId });
    return { deleted: true };
  }

  // --- mapping_suggestions (bank-matching-spec §10.2/§10.4) ---
  // Agent proposes candidate rules to mapping_suggestions (never to
  // bank_mappings); human approves/rejects. "Approve" writes the rule into
  // bank_mappings (human-attributed) — the same "approve is the post" pattern
  // as journal.approve (agent-readiness-spec §4.1).

  if (action === 'mapping.suggest') {
    const { suggestionId, bank_account, description_pattern, suggested_account,
           suggested_vat_code, suggested_dimensions, evidence, source_proposal_id,
           suggested_amount_sign, suggested_match_type } = body;
    if (!description_pattern) throw Object.assign(new Error('description_pattern required'), { code: 'INVALID_INPUT' });
    if (!suggested_account) throw Object.assign(new Error('suggested_account required'), { code: 'INVALID_INPUT' });

    const now = new Date().toISOString();
    const dimsJson = suggested_dimensions != null ? JSON.stringify(suggested_dimensions) : null;
    const amountSign = suggested_amount_sign || 'any';
    const matchType = suggested_match_type || 'contains';

    // ── §4.5: Conflict check at suggestion creation ──────────────────────────
    const conflicts = await detectMappingConflicts(
      companyId, description_pattern, matchType, suggested_account, amountSign, null
    );

    // Exact contradiction with active rule → don't create (§4.5)
    const activeContradictions = conflicts.contradictions.filter((c) => c.source === 'bank_mapping');
    if (activeContradictions.length > 0) {
      const c = activeContradictions[0];
      throw Object.assign(
        new Error(`A rule for pattern '${description_pattern}' already exists mapping to account ${c.account}. Edit the existing rule instead.`),
        { code: 'CONFLICT' }
      );
    }
    // Exact contradiction with pending suggestion → don't create (§4.5)
    const pendingContradictions = conflicts.contradictions.filter((c) => c.source === 'mapping_suggestion');
    if (pendingContradictions.length > 0) {
      const c = pendingContradictions[0];
      throw Object.assign(
        new Error(`A pending suggestion for pattern '${description_pattern}' already exists mapping to account ${c.account}.`),
        { code: 'CONFLICT' }
      );
    }

    // Attach conflict warnings + historical conflicts to evidence (§4.5)
    let enrichedEvidence = evidence;
    if (conflicts.hasWarning) {
      const warnings = [];
      if (conflicts.overlaps.length > 0) {
        warnings.push({ type: 'overlap_warning', conflicts: conflicts.overlaps });
      }
      if (conflicts.historicalConflicts.length > 0) {
        warnings.push({ type: 'historical_conflict', conflicts: conflicts.historicalConflicts });
      }
      if (conflicts.exactDuplicates.length > 0) {
        warnings.push({ type: 'duplicate_warning', conflicts: conflicts.exactDuplicates });
      }
      enrichedEvidence = Array.isArray(evidence) ? [...evidence, ...warnings] : warnings;
    }
    const evidenceJson = enrichedEvidence != null ? JSON.stringify(enrichedEvidence) : null;

    // Upsert: if suggestionId is provided AND a matching proposed row owned by
    // this caller exists, UPDATE it (same pattern as journal.propose's
    // proposalId upsert). Otherwise INSERT a new row.
    if (suggestionId) {
      const existing = await query(
        `SELECT suggestion_id, status, created_by FROM mapping_suggestions
         WHERE company_id = @companyId AND suggestion_id = @suggestionId`,
        { companyId, suggestionId }
      );
      if (existing.length > 0) {
        const row = existing[0];
        if (String(row.status) !== 'proposed') {
          throw Object.assign(new Error(`Cannot upsert a suggestion in status '${row.status}' (only 'proposed' is editable)`), { code: 'INVALID_STATUS' });
        }
        if (String(row.created_by) !== String(ctx.userEmail)) {
          throw Object.assign(new Error('Cannot upsert a suggestion owned by another actor'), { code: 'FORBIDDEN' });
        }
        await exec(
          `UPDATE mapping_suggestions
             SET bank_account = @bank_account,
                 description_pattern = @description_pattern,
                 suggested_account = @suggested_account,
                 suggested_vat_code = @suggested_vat_code,
                 suggested_dimensions = @suggested_dimensions,
                 suggested_amount_sign = @suggested_amount_sign,
                 suggested_match_type = @suggested_match_type,
                 evidence = @evidence,
                 source_proposal_id = @source_proposal_id
           WHERE company_id = @companyId AND suggestion_id = @suggestionId`,
          { bank_account: bank_account || null, description_pattern, suggested_account,
            suggested_vat_code: suggested_vat_code || null,
            suggested_dimensions: dimsJson,
            suggested_amount_sign: amountSign,
            suggested_match_type: matchType,
            evidence: evidenceJson,
            source_proposal_id: source_proposal_id || null,
            companyId, suggestionId }
        );
        await emitEvent(ctx, 'mapping.suggested', 'mapping_suggestion', suggestionId,
          { description_pattern, suggested_account, source_proposal_id: source_proposal_id || null });
        return { suggestion_id: suggestionId, status: 'proposed', conflicts: { has_warning: conflicts.hasWarning } };
      }
      // suggestionId supplied but no existing row → first creation with a
      // caller-chosen id (same as journal.propose).
    }

    const newId = suggestionId || uuid();
    await bulkInsert('mapping_suggestions', [{
      company_id: companyId,
      suggestion_id: newId,
      bank_account: bank_account || null,
      description_pattern,
      suggested_account,
      suggested_vat_code: suggested_vat_code || null,
      suggested_dimensions: dimsJson,
      suggested_amount_sign: amountSign,
      suggested_match_type: matchType,
      evidence: evidenceJson,
      source_proposal_id: source_proposal_id || null,
      status: 'proposed',
      created_by: ctx.userEmail,
      reviewed_by: null,
      reviewed_at: null,
      created_at: now,
    }]);
    await emitEvent(ctx, 'mapping.suggested', 'mapping_suggestion', newId,
      { description_pattern, suggested_account, source_proposal_id: source_proposal_id || null });
    return { suggestion_id: newId, status: 'proposed', conflicts: { has_warning: conflicts.hasWarning } };
  }

  if (action === 'mapping.suggestion.approve') {
    const { suggestionId } = body;
    if (!suggestionId) throw Object.assign(new Error('suggestionId required'), { code: 'INVALID_INPUT' });

    const rows = await query(
      `SELECT suggestion_id, bank_account, description_pattern, suggested_account,
              suggested_vat_code, suggested_dimensions, source_proposal_id, status, created_by,
              suggested_amount_sign, suggested_match_type
       FROM mapping_suggestions
       WHERE company_id = @companyId AND suggestion_id = @suggestionId`,
      { companyId, suggestionId }
    );
    if (rows.length === 0) throw Object.assign(new Error('Mapping suggestion not found'), { code: 'NOT_FOUND' });
    const sug = rows[0];
    if (String(sug.status) !== 'proposed') {
      throw Object.assign(new Error(`Cannot approve a suggestion in status '${sug.status}' (only 'proposed' can be approved)`), { code: 'INVALID_STATUS' });
    }

    // ── §4.5: Conflict check at suggestion approval ──────────────────────────
    // Re-run the conflict check against active rules + OTHER pending suggestions
    // (excluding self). Historical regression is re-run too — history may have
    // changed since the suggestion was created.
    const amountSign = sug.suggested_amount_sign || 'any';
    const matchType = sug.suggested_match_type || 'contains';
    const conflicts = await detectMappingConflicts(
      companyId, sug.description_pattern, matchType, sug.suggested_account, amountSign, suggestionId
    );

    // Exact contradiction with active rule → BLOCK (§4.5)
    const activeContradictions = conflicts.contradictions.filter((c) => c.source === 'bank_mapping');
    if (activeContradictions.length > 0) {
      const c = activeContradictions[0];
      throw Object.assign(
        new Error(`A rule for pattern '${sug.description_pattern}' already exists mapping to account ${c.account}. Edit the existing rule instead.`),
        { code: 'CONFLICT' }
      );
    }

    // Write the rule into bank_mappings (human-attributed). The approving
    // human is the author of the mapping row, regardless of who proposed it.
    // §5: inherit amount_sign + match_type from the suggestion.
    const mappingId = uuid();
    await bulkInsert('bank_mappings', [{
      company_id: companyId,
      mapping_id: mappingId,
      pattern: sug.description_pattern,
      match_type: matchType,
      debit_account: sug.suggested_account,
      credit_account: sug.suggested_account,
      description_override: null,
      vat_code: sug.suggested_vat_code || null,
      cost_center: null,
      profit_center: null,
      priority: 100,
      is_active: true,
      amount_sign: amountSign,
    }]);

    const now = new Date().toISOString();
    await exec(
      `UPDATE mapping_suggestions
          SET status = 'approved', reviewed_by = @reviewed_by, reviewed_at = @reviewed_at
        WHERE company_id = @companyId AND suggestion_id = @suggestionId`,
      { reviewed_by: ctx.userEmail, reviewed_at: now, companyId, suggestionId }
    );

    await emitEvent(ctx, 'mapping.suggestion.approved', 'mapping_suggestion', suggestionId,
      { mapping_id: mappingId, description_pattern: sug.description_pattern, suggested_account: sug.suggested_account });

    // Return warnings (overlap, historical conflicts) but don't block
    const warnings = [];
    if (conflicts.overlaps.length > 0) {
      warnings.push({ type: 'overlap_warning', message: 'Approved rule overlaps with existing rules/suggestions', conflicts: conflicts.overlaps });
    }
    if (conflicts.historicalConflicts.length > 0) {
      warnings.push({ type: 'historical_conflict', message: 'Pattern matches historical transactions posted to different accounts', count: conflicts.historicalConflicts.length });
    }
    return { approved: true, mapping_id: mappingId, ...(warnings.length > 0 ? { warnings } : {}) };
  }

  if (action === 'mapping.suggestion.reject') {
    const { suggestionId } = body;
    if (!suggestionId) throw Object.assign(new Error('suggestionId required'), { code: 'INVALID_INPUT' });

    const rows = await query(
      `SELECT suggestion_id, status FROM mapping_suggestions
       WHERE company_id = @companyId AND suggestion_id = @suggestionId`,
      { companyId, suggestionId }
    );
    if (rows.length === 0) throw Object.assign(new Error('Mapping suggestion not found'), { code: 'NOT_FOUND' });
    const sug = rows[0];
    if (String(sug.status) !== 'proposed') {
      throw Object.assign(new Error(`Cannot reject a suggestion in status '${sug.status}' (only 'proposed' can be rejected)`), { code: 'INVALID_STATUS' });
    }

    const now = new Date().toISOString();
    await exec(
      `UPDATE mapping_suggestions
          SET status = 'rejected', reviewed_by = @reviewed_by, reviewed_at = @reviewed_at
        WHERE company_id = @companyId AND suggestion_id = @suggestionId`,
      { reviewed_by: ctx.userEmail, reviewed_at: now, companyId, suggestionId }
    );

    await emitEvent(ctx, 'mapping.suggestion.rejected', 'mapping_suggestion', suggestionId, {});
    return { rejected: true };
  }

  if (action === 'mapping.suggestion.list') {
    const status = body.status && String(body.status).trim() !== '' ? String(body.status).trim() : null;
    const rawLimit = Number(body.limit);
    const limit = (Number.isFinite(rawLimit) && rawLimit > 0) ? Math.min(Math.floor(rawLimit), 1000) : 100;
    if (status) {
      return query(
        `SELECT * FROM mapping_suggestions
         WHERE company_id = @companyId AND status = @status
         ORDER BY created_at DESC
         LIMIT @lim`,
        { companyId, status, lim: limit }
      );
    }
    return query(
      `SELECT * FROM mapping_suggestions
       WHERE company_id = @companyId
       ORDER BY created_at DESC
       LIMIT @lim`,
      { companyId, lim: limit }
    );
  }

  if (action === 'mapping.suggestion.get') {
    const { suggestionId } = body;
    if (!suggestionId) throw Object.assign(new Error('suggestionId required'), { code: 'INVALID_INPUT' });
    const rows = await query(
      `SELECT * FROM mapping_suggestions
       WHERE company_id = @companyId AND suggestion_id = @suggestionId`,
      { companyId, suggestionId }
    );
    if (rows.length === 0) throw Object.assign(new Error('Mapping suggestion not found'), { code: 'NOT_FOUND' });
    return rows[0];
  }
}

// --- Matching History (bank-matching-spec §10.3) ---
// Learning store: every proposal's review outcome across all tiers.
// matching_history.record is agent-only (in AGENT_ALLOWED); query/get are
// viewer reads. Feeds calibration (§6) and rule crystallization/retirement
// (§10.5).

const MATCHING_HISTORY_OUTCOMES = ['approved_unedited', 'approved_edited', 'rejected'];
const MATCHING_HISTORY_SOURCE_TYPES = ['learned_rule', 'open_item', 'master_data', 'llm_semantic'];

async function handleMatchingHistory(ctx, action) {
  const { companyId, body } = ctx;

  if (action === 'matching_history.record') {
    const {
      bank_account, description_pattern, counterparty, amount,
      proposed_dimensions, approved_dimensions, source_type,
      confidence, evidence, outcome,
    } = body;

    // Validate required non-empty strings.
    if (!description_pattern || typeof description_pattern !== 'string')
      throw Object.assign(new Error('description_pattern required'), { code: 'INVALID_INPUT' });
    if (!source_type || typeof source_type !== 'string')
      throw Object.assign(new Error('source_type required'), { code: 'INVALID_INPUT' });
    if (!outcome || typeof outcome !== 'string')
      throw Object.assign(new Error('outcome required'), { code: 'INVALID_INPUT' });
    if (!MATCHING_HISTORY_SOURCE_TYPES.includes(source_type))
      throw Object.assign(new Error(`source_type must be one of: ${MATCHING_HISTORY_SOURCE_TYPES.join(', ')}`), { code: 'INVALID_INPUT' });
    if (!MATCHING_HISTORY_OUTCOMES.includes(outcome))
      throw Object.assign(new Error(`outcome must be one of: ${MATCHING_HISTORY_OUTCOMES.join(', ')}`), { code: 'INVALID_INPUT' });

    // amount is a number or null.
    const amountVal = (typeof amount === 'number') ? amount : null;

    // JSON columns are VARCHAR — JSON.stringify before storing.
    const proposedDimsJson = proposed_dimensions != null ? JSON.stringify(proposed_dimensions) : null;
    const approvedDimsJson = approved_dimensions != null ? JSON.stringify(approved_dimensions) : null;
    const confidenceJson = confidence != null ? JSON.stringify(confidence) : null;
    const evidenceJson = evidence != null ? JSON.stringify(evidence) : null;

    const id = uuid();
    await exec(
      `INSERT INTO matching_history
         (id, company_id, bank_account, description_pattern, counterparty, amount,
          proposed_dimensions, approved_dimensions, source_type, confidence, evidence, outcome)
       VALUES
         (@id, @companyId, @bank_account, @description_pattern, @counterparty, @amount,
          @proposed_dimensions, @approved_dimensions, @source_type, @confidence, @evidence, @outcome)`,
      {
        id, companyId,
        bank_account: bank_account || null,
        description_pattern,
        counterparty: counterparty || null,
        amount: amountVal,
        proposed_dimensions: proposedDimsJson,
        approved_dimensions: approvedDimsJson,
        source_type,
        confidence: confidenceJson,
        evidence: evidenceJson,
        outcome,
      }
    );
    return { recorded: true, id };
  }

  if (action === 'matching_history.query') {
    const { description_pattern, counterparty, bank_account } = body;
    let limit = Number(body.limit);
    if (!Number.isFinite(limit) || limit <= 0) limit = 100;
    if (limit > 1000) limit = 1000;

    const where = [`company_id = @companyId`];
    const params = { companyId };
    if (description_pattern) { where.push(`description_pattern = @description_pattern`); params.description_pattern = description_pattern; }
    if (counterparty) { where.push(`counterparty = @counterparty`); params.counterparty = counterparty; }
    if (bank_account) { where.push(`bank_account = @bank_account`); params.bank_account = bank_account; }

    const sql = `SELECT * FROM matching_history WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${limit}`;
    return query(sql, params);
  }

  throw Object.assign(new Error(`Unknown matching_history action: ${action}`), { code: 'INVALID_INPUT' });
}

// --- Input rejections (bank-matching-spec §11.2) ---
// Statement lines with missing critical data (missing date, missing amount,
// missing description AND counterparty). The agent creates a rejection item
// (one per statement) via input_rejection.create; the inbox aggregates it as
// a Class B item with verbs r (retry) / d (discard). The input_rejections
// table IS the source of truth (R8). input_rejection.create is agent-only (in
// AGENT_ALLOWED); list/get are viewer reads; discard is data_entry (human).

async function handleInputRejection(ctx, action) {
  const { companyId, body, userEmail } = ctx;

  // input_rejection.create (agent-only): insert a new open rejection item.
  if (action === 'input_rejection.create') {
    const { statement_id, statement_date, rejected_lines } = body;

    if (!statement_id || typeof statement_id !== 'string')
      throw Object.assign(new Error('statement_id required'), { code: 'INVALID_INPUT' });
    if (!Array.isArray(rejected_lines) || rejected_lines.length === 0)
      throw Object.assign(new Error('rejected_lines must be a non-empty array'), { code: 'INVALID_INPUT' });

    const rejectionId = uuid();
    const linesJson = JSON.stringify(rejected_lines);
    const dateVal = statement_date || null;

    await exec(
      `INSERT INTO input_rejections
         (rejection_id, company_id, statement_id, statement_date, rejected_lines, status, created_by)
       VALUES
         (@rejectionId, @companyId, @statement_id, @statement_date, @rejected_lines, 'open', @created_by)`,
      {
        rejectionId, companyId,
        statement_id,
        statement_date: dateVal,
        rejected_lines: linesJson,
        created_by: userEmail || 'agent',
      }
    );

    await emitEvent(ctx, 'input_rejection.created', 'input_rejection', rejectionId,
      { statement_id, line_count: rejected_lines.length });

    return { rejection_id: rejectionId, status: 'open' };
  }

  // input_rejection.list (viewer): list items, optional status filter.
  if (action === 'input_rejection.list') {
    const { status } = body;
    let limit = Number(body.limit);
    if (!Number.isFinite(limit) || limit <= 0) limit = 100;
    if (limit > 1000) limit = 1000;

    const where = [`company_id = @companyId`];
    const params = { companyId };
    if (status && typeof status === 'string') {
      where.push(`status = @status`);
      params.status = status;
    }

    const sql = `SELECT rejection_id, statement_id, statement_date, rejected_lines,
                        status, created_by, created_at
                 FROM input_rejections
                 WHERE ${where.join(' AND ')}
                 ORDER BY created_at DESC
                 LIMIT ${limit}`;
    return query(sql, params);
  }

  // input_rejection.get (viewer): fetch one item; parse rejected_lines JSON.
  if (action === 'input_rejection.get') {
    const { rejectionId } = body;
    if (!rejectionId)
      throw Object.assign(new Error('rejectionId required'), { code: 'INVALID_INPUT' });

    const rows = await query(
      `SELECT rejection_id, statement_id, statement_date, rejected_lines,
              status, created_by, created_at
       FROM input_rejections
       WHERE company_id = @companyId AND rejection_id = @rejectionId`,
      { companyId, rejectionId }
    );
    if (rows.length === 0) {
      throw Object.assign(new Error('Input rejection not found'), { code: 'NOT_FOUND' });
    }
    const row = rows[0];
    let lines = [];
    try { lines = JSON.parse(row.rejected_lines || '[]'); } catch (e) { /* malformed */ }
    return {
      rejection_id: row.rejection_id,
      statement_id: row.statement_id,
      statement_date: row.statement_date,
      rejected_lines: lines,
      status: row.status,
      created_by: row.created_by,
      created_at: row.created_at,
    };
  }

  // input_rejection.discard (data_entry, human-only): terminal discard.
  if (action === 'input_rejection.discard') {
    const { rejectionId } = body;
    if (!rejectionId)
      throw Object.assign(new Error('rejectionId required'), { code: 'INVALID_INPUT' });

    const rows = await query(
      `SELECT rejection_id, status FROM input_rejections
       WHERE company_id = @companyId AND rejection_id = @rejectionId`,
      { companyId, rejectionId }
    );
    if (rows.length === 0) {
      throw Object.assign(new Error('Input rejection not found'), { code: 'NOT_FOUND' });
    }
    if (rows[0].status !== 'open') {
      throw Object.assign(new Error('Input rejection is not open (status=' + rows[0].status + ')'), { code: 'INVALID_STATUS' });
    }

    await exec(
      `UPDATE input_rejections SET status = 'discarded'
       WHERE company_id = @companyId AND rejection_id = @rejectionId`,
      { companyId, rejectionId }
    );

    await emitEvent(ctx, 'input_rejection.discarded', 'input_rejection', rejectionId, {});
    return { discarded: true };
  }

  throw Object.assign(new Error(`Unknown input_rejection action: ${action}`), { code: 'INVALID_INPUT' });
}

// --- Calibration (bank-matching-spec §6.2) ---
// Plain running counter per (source_type, confidence_band), computed over
// full history. realized_accuracy = approved_unedited / proposed; below N=10
// the number is not trusted (null). confidence is stored as JSON VARCHAR, so
// we aggregate in JS after fetching all rows.

async function handleCalibration(ctx, action) {
  const { companyId } = ctx;

  if (action === 'calibration.get') {
    const rows = await query(
      `SELECT source_type, confidence, outcome FROM matching_history WHERE company_id = @companyId`,
      { companyId }
    );

    // Aggregate in JS by (source_type, confidence_band). The confidence
    // column is a JSON VARCHAR; parse it to extract the `band` field.
    const groups = new Map();
    for (const row of rows) {
      let band = 'unknown';
      if (row.confidence) {
        try {
          const parsed = JSON.parse(row.confidence);
          if (parsed && typeof parsed.band === 'string') band = parsed.band;
        } catch (_e) {
          // Malformed JSON — fall through to 'unknown' band.
        }
      }
      const key = `${row.source_type || 'unknown'}|${band}`;
      let g = groups.get(key);
      if (!g) {
        g = { source_type: row.source_type || 'unknown', confidence_band: band,
              proposed: 0, approved_unedited: 0, approved_edited: 0, rejected: 0 };
        groups.set(key, g);
      }
      g.proposed += 1;
      if (row.outcome === 'approved_unedited') g.approved_unedited += 1;
      else if (row.outcome === 'approved_edited') g.approved_edited += 1;
      else if (row.outcome === 'rejected') g.rejected += 1;
    }

    const calibration = Array.from(groups.values()).map((g) => {
      // N=10 floor: below it, realized_accuracy is not trusted.
      const realized_accuracy = g.proposed >= 10
        ? (g.proposed > 0 ? g.approved_unedited / g.proposed : 0)
        : null;
      return { ...g, realized_accuracy };
    });

    return { calibration };
  }

  throw Object.assign(new Error(`Unknown calibration action: ${action}`), { code: 'INVALID_INPUT' });
}

// --- Centers ---

async function handleCenter(ctx, action) {
  const { companyId, body } = ctx;

  if (action === 'center.list') {
    return query(
      `SELECT c.company_id, c.center_id, c.center_type, c.name, c.is_active,
              c.profit_center_id, pc.name AS profit_center_name
       FROM centers c
       LEFT JOIN centers pc
         ON pc.company_id = c.company_id AND pc.center_id = c.profit_center_id
       WHERE c.company_id = @companyId
       ORDER BY c.center_type, c.center_id`,
      { companyId }
    );
  }

  if (action === 'center.save') {
    const { centers } = body;
    if (!centers || !Array.isArray(centers)) throw Object.assign(new Error('centers array required'), { code: 'INVALID_INPUT' });

    // Validate each center before the DELETE+INSERT so an invalid row
    // doesn't wipe the table and leave nothing.
    const derivationEnabled = await isDerivationEnabled(companyId);
    // Build a set of Profit center_ids from the incoming batch so a Cost
    // center can reference a Profit center being saved in the same batch.
    const batchProfitIds = new Set(
      centers.filter(c => c.center_type === 'Profit').map(c => c.center_id)
    );
    for (const c of centers) {
      if (!['Cost', 'Profit'].includes(c.center_type)) {
        throw Object.assign(new Error(`center_type must be 'Cost' or 'Profit' (got '${c.center_type}' for ${c.center_id})`), { code: 'INVALID_INPUT' });
      }
      if (c.center_type === 'Cost') {
        if (c.profit_center_id) {
          // Check the incoming batch first, then the DB.
          if (!batchProfitIds.has(c.profit_center_id)) {
            const [target] = await query(
              `SELECT center_type FROM centers WHERE company_id = @companyId AND center_id = @profitCenterId`,
              { companyId, profitCenterId: c.profit_center_id }
            );
            if (!target || target.center_type !== 'Profit') {
              throw Object.assign(new Error(`${c.profit_center_id} is not a valid profit center`), { code: 'INVALID_INPUT' });
            }
          }
        } else if (derivationEnabled) {
          throw Object.assign(new Error(`Cost center ${c.center_id} requires a profit_center_id`), { code: 'INVALID_INPUT' });
        }
      } else if (c.profit_center_id) {
        throw Object.assign(new Error(`Profit centers must not set profit_center_id`), { code: 'INVALID_INPUT' });
      }
    }

    await exec(`DELETE FROM centers WHERE company_id = @companyId`, { companyId });
    const rows = centers.map((c) => ({
      company_id: companyId,
      center_id: c.center_id,
      center_type: c.center_type,
      name: c.name,
      profit_center_id: c.profit_center_id || null,
      is_active: c.is_active !== false
    }));
    if (rows.length > 0) await bulkInsert('centers', rows);
    return { saved: rows.length };
  }

  if (action === 'center.upsert') {
    const { center } = body;
    if (!center || !center.center_id) throw Object.assign(new Error('center_id required'), { code: 'INVALID_INPUT' });

    const centerType = center.center_type || 'Cost';
    if (!['Cost', 'Profit'].includes(centerType)) {
      throw Object.assign(new Error(`center_type must be 'Cost' or 'Profit'`), { code: 'INVALID_INPUT' });
    }

    // Validate profit_center_id constraints (spec §6a).
    if (centerType === 'Cost') {
      if (center.profit_center_id) {
        const [target] = await query(
          `SELECT center_type FROM centers WHERE company_id = @companyId AND center_id = @profitCenterId`,
          { companyId, profitCenterId: center.profit_center_id }
        );
        if (!target || target.center_type !== 'Profit') {
          throw Object.assign(new Error(`${center.profit_center_id} is not a valid profit center`), { code: 'INVALID_INPUT' });
        }
      } else if (await isDerivationEnabled(companyId)) {
        throw Object.assign(new Error(`Cost center ${center.center_id} requires a profit_center_id`), { code: 'INVALID_INPUT' });
      }
    } else if (center.profit_center_id) {
      throw Object.assign(new Error(`Profit centers must not set profit_center_id`), { code: 'INVALID_INPUT' });
    }

    const row = {
      company_id: companyId,
      center_id: center.center_id,
      center_type: centerType,
      name: center.name || '',
      profit_center_id: center.profit_center_id || null,
      is_active: center.is_active !== false
    };
    const existing = await query(`SELECT 1 FROM centers WHERE company_id = @companyId AND center_id = @center_id`, { companyId, center_id: center.center_id });
    if (existing.length > 0) {
      await exec(`UPDATE centers SET center_type = @center_type, name = @name, profit_center_id = @profit_center_id, is_active = @is_active WHERE company_id = @companyId AND center_id = @center_id`, row);
    } else {
      await exec(`INSERT INTO centers (company_id, center_id, center_type, name, profit_center_id, is_active) VALUES (@company_id, @center_id, @center_type, @name, @profit_center_id, @is_active)`, row);
    }
    return { saved: 1 };
  }

  if (action === 'center.delete') {
    const { centerId } = body;
    if (!centerId) throw Object.assign(new Error('centerId required'), { code: 'INVALID_INPUT' });
    await exec(`DELETE FROM centers WHERE company_id = @companyId AND center_id = @centerId`, { companyId, centerId });
    return { deleted: 1 };
  }
}

// --- Journals ---

async function handleJournals(ctx, action) {
  const { companyId, body } = ctx;

  if (action === 'journals.list') {
    return query(
      `SELECT * FROM journals WHERE company_id = @companyId AND active = true ORDER BY code`,
      { companyId }
    );
  }

  if (action === 'journals.save') {
    const { journal } = body;
    if (!journal || !journal.code || !journal.name) throw Object.assign(new Error('journal.code and journal.name required'), { code: 'INVALID_INPUT' });
    const journalId = journal.journal_id || `${companyId}_${journal.code.toLowerCase()}`;
    await exec(
      `INSERT INTO journals (journal_id, company_id, code, name, active)
       VALUES (@journalId, @companyId, @code, @name, @active)
       ON CONFLICT (journal_id) DO UPDATE SET name = @name, active = @active`,
      { journalId, companyId, code: journal.code, name: journal.name, active: journal.active !== false }
    );
    return { saved: true, journalId };
  }

  if (action === 'journals.delete') {
    const { journalId } = body;
    if (!journalId) throw Object.assign(new Error('journalId required'), { code: 'INVALID_INPUT' });
    await exec(`UPDATE journals SET active = false WHERE company_id = @companyId AND journal_id = @journalId`, { companyId, journalId });
    return { deleted: true };
  }
}

// --- Settings / Company / Periods ---

async function handleSettings(ctx, action) {
  const { companyId, body } = ctx;

  // IA-spec step 4 (§5.10): the period.close_check action lives in the
  // Periods section service (read-only live checklist). Routed here because
  // the dispatcher keys on the 'period' module prefix.
  if (action === 'period.close') {
    const { handleClose } = require('./period-close');
    return handleClose(ctx);
  }
  if (action === 'period.close_check') {
    const { handlePeriodsService } = require('./periods-page-service');
    return handlePeriodsService(ctx, action);
  }

  if (action === 'company.list') {
    const rows = await query(
      `SELECT company_id, company_name, jurisdiction, currency, reporting_standard, accounting_method, vat_registered, tax_id
       FROM (SELECT *, ROW_NUMBER() OVER(PARTITION BY company_id ORDER BY created_at DESC) AS rn FROM companies) t
       WHERE rn = 1 ORDER BY company_id`
    );
    return rows.map((r) => ({ ...r, base_currency: r.currency, vat_registered: !!r.vat_registered, tax_id: r.tax_id || '' }));
  }

  if (action === 'company.save') {
    const { companies } = body;
    if (!companies || !Array.isArray(companies) || companies.length === 0) throw Object.assign(new Error('companies array required'), { code: 'INVALID_INPUT' });
    const now = new Date().toISOString();
    const rows = companies.filter((c) => c.company_id && c.company_name).map((c) => ({
      company_id: String(c.company_id).trim(),
      company_name: String(c.company_name).trim(),
      jurisdiction: String(c.jurisdiction || 'SG').trim(),
      currency: String(c.base_currency || c.currency || 'SGD').trim(),
      reporting_standard: String(c.reporting_standard || 'IFRS').trim(),
      accounting_method: String(c.accounting_method || 'accrual').trim(),
      vat_registered: c.vat_registered === true || String(c.vat_registered || '').toUpperCase() === 'TRUE',
      tax_id: String(c.tax_id || '').trim() || null,
      fy_start: c.fy_start || '2025-01-01',
      fy_end: c.fy_end || '2025-12-31',
      created_at: now,
    }));
    if (rows.length > 0) await bulkInsert('companies', rows);
    return { saved: rows.length };
  }

  // ── Company attribute grid (settings-ux-spec §7 item 1 rev. 3) ──────────
  // The Company tab is an FB.list attribute/value register: fixed rows, one
  // row per setting. The attribute REGISTRY lives here server-side — the
  // client renders what it is given (labels, display strings, editor shapes)
  // and every write is validated server-authoritatively (Magnus: these are
  // highly sensitive settings — front-end validation is advisory only).
  //
  // Storage split: company-master attributes (name/currency/jurisdiction/
  // tax_id/reporting_standard/vat_registered) live on the append-versioned
  // companies row; everything else is a per-company settings key.
  async function latestCompanyRow(cid) {
    const rows = await query(
      `SELECT * FROM (SELECT *, ROW_NUMBER() OVER(PARTITION BY company_id ORDER BY created_at DESC) AS rn FROM companies) t
       WHERE company_id = @cid AND rn = 1`,
      { cid }
    );
    return rows[0] || null;
  }
  async function settingsMap(cid) {
    const rows = await query(`SELECT key, value FROM settings WHERE company_id = @cid`, { cid });
    const m = {};
    for (const r of rows) m[r.key] = r.value;
    return m;
  }
  async function putSetting(cid, key, value) {
    const now = new Date().toISOString();
    await exec(`DELETE FROM settings WHERE company_id = @cid AND key = @key`, { cid, key });
    await bulkInsert('settings', [{ company_id: cid, key, value: String(value), updated_at: now }]);
  }
  // Merge one field into the company's master record (append-versioned:
  // read latest, override, insert a fresh row — never UPDATE in place).
  async function mergeCompanyRow(cid, patch) {
    const co = await latestCompanyRow(cid);
    if (!co) throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });
    const now = new Date().toISOString();
    await bulkInsert('companies', [{
      company_id: co.company_id,
      company_name: patch.company_name !== undefined ? patch.company_name : co.company_name,
      jurisdiction: patch.jurisdiction !== undefined ? patch.jurisdiction : co.jurisdiction,
      currency: patch.currency !== undefined ? patch.currency : co.currency,
      reporting_standard: patch.reporting_standard !== undefined ? patch.reporting_standard : co.reporting_standard,
      accounting_method: co.accounting_method || 'accrual',
      vat_registered: patch.vat_registered !== undefined ? patch.vat_registered : (co.vat_registered === true || co.vat_registered === 1),
      tax_id: patch.tax_id !== undefined ? patch.tax_id : (co.tax_id || null),
      fy_start: co.fy_start,
      fy_end: co.fy_end,
      created_at: now,
    }]);
  }

  if (action === 'company.attr.list') {
    const co = await latestCompanyRow(companyId);
    if (!co) throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });
    const s = await settingsMap(companyId);
    const dash = '—';
    const attrs = [
      { key: 'company_id', label: 'Company ID', type: 'String', value: co.company_id, display: co.company_id, editor: { type: 'text' }, readonly: true },
      { key: 'company_name', label: 'Company Name', type: 'String', value: co.company_name || '', display: co.company_name || dash, editor: { type: 'text' } },
      { key: 'currency', label: 'Base Currency', type: 'String', value: co.currency || '', display: co.currency || dash, editor: { type: 'text', uppercase: true } },
      { key: 'jurisdiction', label: 'Jurisdiction', type: 'Choice', value: co.jurisdiction || 'SG', display: co.jurisdiction || dash,
        editor: { type: 'select', options: [{ value: 'SG', label: 'SG — Singapore' }, { value: 'SE', label: 'SE — Sweden' }] } },
      { key: 'tax_id', label: 'Tax ID', type: 'String', value: co.tax_id || '', display: co.tax_id || dash, editor: { type: 'text' } },
      { key: 'reporting_standard', label: 'Reporting Standard', type: 'Choice', value: co.reporting_standard || 'IFRS', display: co.reporting_standard || dash,
        editor: { type: 'select', options: ['IFRS', 'SFRS', 'K2', 'K3'] } },
      { key: 'vat_registered', label: 'VAT/GST Registered', type: 'Boolean', value: co.vat_registered === true || co.vat_registered === 1, display: (co.vat_registered === true || co.vat_registered === 1) ? 'Yes' : 'No', editor: { type: 'checkbox' } },
    ];
    // Pack-declared contact attributes (SRU MEDIELEV #ADRESS/#POSTNR/#POSTORT
    // and contact person/email/phone). One registry row per pack attribute;
    // the Settings Company tab renders them generically like the rows above.
    for (const attr of contactAttributesFor(co.jurisdiction)) {
      const k = 'contact_' + attr.key;
      const row = {
        key: k,
        label: attr.label,
        type: 'String',
        value: s[k] || '',
        display: s[k] || dash,
        editor: { type: 'text' },
      };
      if (attr.required) row.note = 'Required for SRU filing';
      attrs.push(row);
    }
    return attrs;
  }

  if (action === 'company.attr.save') {
    const { key, value } = body;
    if (!key) throw Object.assign(new Error('key required'), { code: 'INVALID_INPUT' });
    const invalid = (m) => Object.assign(new Error(m), { code: 'INVALID_INPUT' });
    switch (key) {
      case 'company_name': {
        const v = String(value || '').trim();
        if (!v) throw invalid('Company name required');
        await mergeCompanyRow(companyId, { company_name: v });
        break;
      }
      case 'currency': {
        const v = String(value || '').trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(v)) throw invalid('Currency must be a 3-letter ISO code');
        await mergeCompanyRow(companyId, { currency: v });
        break;
      }
      case 'jurisdiction': {
        if (!['SG', 'SE'].includes(value)) throw invalid('Jurisdiction must be SG or SE');
        await mergeCompanyRow(companyId, { jurisdiction: value });
        break;
      }
      case 'tax_id':
        await mergeCompanyRow(companyId, { tax_id: String(value || '').trim() || null });
        break;
      case 'reporting_standard': {
        if (!['IFRS', 'SFRS', 'K2', 'K3'].includes(value)) throw invalid('Unknown reporting standard');
        await mergeCompanyRow(companyId, { reporting_standard: value });
        break;
      }
      case 'vat_registered':
        await mergeCompanyRow(companyId, { vat_registered: value === true || value === 'true' });
        break;
      default: {
        // Pack-declared contact attributes (contact_<attr.key>). Validated
        // server-side against the jurisdiction pack: unknown keys reject
        // with the same 'Unknown company attribute' INVALID_INPUT as above;
        // format-bearing attributes (e.g. SE postnr) are regex-validated.
        if (String(key).startsWith('contact_')) {
          const attrKey = String(key).slice('contact_'.length);
          const co = await latestCompanyRow(companyId);
          if (!co) throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });
          const attr = contactAttributesFor(co.jurisdiction).find((a) => a.key === attrKey);
          if (!attr) throw invalid(`Unknown company attribute: ${key}`);
          const v = String(value == null ? '' : value).trim();
          if (attr.format && v && !new RegExp(attr.format).test(v)) {
            throw invalid(`${attr.label} must be a valid Swedish zip code (5 digits)`);
          }
          await putSetting(companyId, key, v);
          break;
        }
        throw Object.assign(new Error(`Unknown company attribute: ${key}`), { code: 'INVALID_INPUT' });
      }
    }
    return { saved: true, key };
  }

  if (action === 'posting_rules.attr.list') {
    const s = await settingsMap(companyId);
    const providerIds = listProviderIds();
    const curProvider = s.fx_provider || MANUAL_PROVIDER;
    const providerNames = { [MANUAL_PROVIDER]: 'Manual (no auto-download)' };
    for (const id of providerIds) {
      try { providerNames[id] = require(`./fxProviders/${id}.js`).name || id; } catch (e) { providerNames[id] = id; }
    }
    const pctFraction = parseFloat(s.vat_tolerance_pct);
    const pctDisplay = isNaN(pctFraction) ? 1 : Math.round(pctFraction * 100 * 100) / 100;
    const flatNum = parseFloat(s.vat_tolerance);
    const dash = '—';
    const attrs = [
      { key: 'multi_currency', label: 'Multi-Currency', type: 'Boolean', value: s.fx_tracking === 'true', display: s.fx_tracking === 'true' ? 'Yes' : 'No', editor: { type: 'checkbox' } },
      { key: 'fx_provider', label: 'FX Provider', type: 'Choice', value: curProvider, display: providerNames[curProvider] || curProvider,
        editor: { type: 'select', options: [{ value: MANUAL_PROVIDER, label: providerNames[MANUAL_PROVIDER] }].concat(providerIds.map((id) => ({ value: id, label: providerNames[id] }))) } },
      { key: 'fx_provider_api_key', label: 'FX API Key', type: 'String', value: '', display: s.fx_provider_api_key ? '••••' + String(s.fx_provider_api_key).slice(-4) : dash,
        editor: { type: 'text' }, note: 'Blank keeps the stored key' },
      { key: 'vat_tolerance', label: 'VAT Tolerance (flat)', type: 'Number', value: isNaN(flatNum) ? 0.5 : flatNum, display: (isNaN(flatNum) ? 0.5 : flatNum).toFixed(2), editor: { type: 'number', step: '0.01' } },
      { key: 'vat_tolerance_pct', label: 'VAT Tolerance (%)', type: 'Number', value: pctDisplay, display: pctDisplay.toFixed(2) + '%', editor: { type: 'number', step: '0.1' } },
    ];
    return attrs;
  }

  if (action === 'ai.attr.list') {
    const s = await settingsMap(companyId);
    const dash = '—';
    const aiAttrs = [
      { key: 'agent_enabled', label: 'Enable agent pipeline', type: 'Boolean',
        value: s.agent_enabled === 'true', display: s.agent_enabled === 'true' ? 'Yes' : 'No',
        editor: { type: 'checkbox' } },
      { key: 'agent_poll_interval_ms', label: 'Poll interval (ms)', type: 'Number',
        value: Number(s.agent_poll_interval_ms || '30000'), display: s.agent_poll_interval_ms || '30000',
        editor: { type: 'number' } },
      { key: 'agent_inbox_path', label: 'Inbox path', type: 'String',
        value: s.agent_inbox_path || '', display: s.agent_inbox_path || dash,
        editor: { type: 'text' } },
      { key: 'llm_endpoint_url', label: 'LLM endpoint URL', type: 'String',
        value: s.llm_endpoint_url || '', display: s.llm_endpoint_url || dash,
        editor: { type: 'text' } },
      { key: 'llm_api_key', label: 'LLM API key', type: 'String',
        value: '', display: s.llm_api_key ? '••••' + String(s.llm_api_key).slice(-4) : dash,
        editor: { type: 'text' }, note: 'Blank keeps the stored key' },
      { key: 'llm_model', label: 'LLM model', type: 'String',
        value: s.llm_model || '', display: s.llm_model || dash,
        editor: { type: 'text' } },
      { key: 'llm_temperature', label: 'LLM temperature', type: 'Number',
        value: Number(s.llm_temperature || '0.1'), display: s.llm_temperature || '0.1',
        editor: { type: 'number', step: '0.1' } },
      { key: 'llm_vision_endpoint_url', label: 'Vision endpoint URL', type: 'String',
        value: s.llm_vision_endpoint_url || '', display: s.llm_vision_endpoint_url || dash,
        editor: { type: 'text' } },
      { key: 'llm_vision_model', label: 'Vision model', type: 'String',
        value: s.llm_vision_model || '', display: s.llm_vision_model || dash,
        editor: { type: 'text' } },
      { key: 'llm_vision_api_key', label: 'Vision API key', type: 'String',
        value: '', display: s.llm_vision_api_key ? '••••' + String(s.llm_vision_api_key).slice(-4) : dash,
        editor: { type: 'text' }, note: 'Blank keeps the stored key' },
      { key: 'test_connection', label: 'Test LLM connection', type: 'Action',
        value: '', display: '', editor: { type: 'action', action: 'ai.test_connection' }, readonly: true },
    ];
    return aiAttrs;
  }

  if (action === 'posting_rules.attr.save') {
    const { key, value } = body;
    if (!key) throw Object.assign(new Error('key required'), { code: 'INVALID_INPUT' });
    const invalid = (m) => Object.assign(new Error(m), { code: 'INVALID_INPUT' });
    let triggerFxScan = false; // fire-and-forget after the switch
    switch (key) {
      case 'multi_currency':
        await putSetting(companyId, 'fx_tracking', (value === true || value === 'true') ? 'true' : 'false');
        triggerFxScan = (value === true || value === 'true');
        break;
      case 'fx_provider': {
        if (value !== MANUAL_PROVIDER && !providerExists(value)) throw invalid(`Unknown FX provider: ${value}`);
        await putSetting(companyId, 'fx_provider', value);
        triggerFxScan = value !== MANUAL_PROVIDER;
        break;
      }
      case 'fx_provider_api_key': {
        const v = String(value || '').trim();
        if (v) await putSetting(companyId, 'fx_provider_api_key', v);
        break;
      }
      case 'vat_tolerance': {
        const n = Number(value);
        if (!isFinite(n) || n < 0) throw invalid('Flat tolerance must be a non-negative number');
        await putSetting(companyId, 'vat_tolerance', String(n));
        break;
      }
      case 'vat_tolerance_pct': {
        const n = Number(value);
        if (!isFinite(n) || n < 0) throw invalid('Tolerance % must be a non-negative number');
        await putSetting(companyId, 'vat_tolerance_pct', String(n / 100));
        break;
      }
      default:
        throw Object.assign(new Error(`Unknown posting rules attribute: ${key}`), { code: 'INVALID_INPUT' });
    }
    // When multi-currency is enabled or a real provider is set,
    // run an immediate FX scan for this company. Await it so the
    // response includes the result — the frontend shows status.
    let fxScanResult = null;
    if (triggerFxScan) {
      const { scanCompany } = require('./fx-scanner');
      try {
        const rows = await query('SELECT currency FROM (SELECT *, ROW_NUMBER() OVER(PARTITION BY company_id ORDER BY created_at DESC) AS rn FROM companies) t WHERE company_id = @cid AND rn = 1', { cid: String(companyId) });
        if (rows.length > 0 && rows[0].currency) {
          fxScanResult = await scanCompany(String(companyId), String(rows[0].currency));
        }
      } catch (e) {
        console.error('Triggered FX scan failed:', e.message);
        fxScanResult = { error: e.message };
      }
    }
    return { saved: true, key, fxScanResult };
  }

  if (action === 'ai.attr.save') {
    const { key, value } = body;
    if (!key) throw Object.assign(new Error('key required'), { code: 'INVALID_INPUT' });
    const validAiKeys = [
      'agent_enabled', 'agent_poll_interval_ms', 'agent_inbox_path',
      'llm_endpoint_url', 'llm_api_key', 'llm_model', 'llm_temperature',
      'llm_vision_endpoint_url', 'llm_vision_model', 'llm_vision_api_key',
    ];
    if (!validAiKeys.includes(key)) {
      throw Object.assign(new Error(`Unknown AI attribute: ${key}`), { code: 'INVALID_INPUT' });
    }
    // API keys: blank keeps the stored key (same convention as FX API key)
    if ((key === 'llm_api_key' || key === 'llm_vision_api_key') && !value) {
      return { saved: true, key };
    }
    if (key === 'agent_enabled') {
      await putSetting(companyId, key, value === true || value === 'true' ? 'true' : 'false');
    } else {
      await putSetting(companyId, key, String(value));
    }
    return { saved: true, key };
  }

  // ai.test_connection (settings-ai-flattened-spec.md, issue #179): read-only
  // health check against the configured LLM endpoint. Mirrors the request
  // shape used by tier4LLMReason (agent-loop.js): GET {url}/v1/models with an
  // Authorization Bearer header when an API key is set. 10s timeout so the UI
  // never hangs waiting on an unresponsive endpoint.
  if (action === 'ai.test_connection') {
    const s = await settingsMap(companyId);
    const url = s.llm_endpoint_url;
    if (!url) return { ok: false, error: 'No LLM endpoint URL configured' };
    const apiKey = s.llm_api_key || '';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const resp = await fetch(`${url.replace(/\/v1\/?$/, '')}/v1/models`, {
        method: 'GET',
        headers: { ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}) },
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        return { ok: false, error: `LLM connection failed (HTTP ${resp.status})` };
      }
      const data = await resp.json().catch(() => ({}));
      const models = Array.isArray(data?.data) ? data.data.map((m) => m.id).filter(Boolean)
        : Array.isArray(data?.models) ? data.models
        : [];
      return { ok: true, models };
    } catch (err) {
      if (err && err.name === 'AbortError') return { ok: false, error: 'Connection timed out (10s)' };
      return { ok: false, error: `Connection failed: ${(err && err.message) || String(err)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  // settings-ux-spec §7 item 1 (rev 2026-07-27): danger-zone delete of the
  // CURRENT company (ctx.companyId is the target). Guards, in order:
  //   (1) cannot delete the LAST remaining company;
  //   (2) cannot delete a company that has journal entries — books are not
  //       droppable by one modal; only setup-only companies can be removed.
  // On success the client redirects to a surviving company.
  if (action === 'company.delete') {
    const all = await query(`SELECT DISTINCT company_id FROM companies ORDER BY company_id`);
    if (all.length <= 1) {
      throw Object.assign(new Error('Cannot delete the last remaining company.'), { code: 'INVALID_STATE' });
    }
    const cnt = await query(`SELECT COUNT(*) AS n FROM journal_entries WHERE company_id = @companyId`, { companyId });
    const n = Number((cnt[0] && cnt[0].n) || 0);
    if (n > 0) {
      throw Object.assign(new Error(`Cannot delete company "${companyId}": it has ${n} journal entries. Only companies without posted books can be deleted.`), { code: 'INVALID_STATE' });
    }
    // Cascade the setup-only residue (children before the companies row).
    // fx_rates is intentionally untouched — the rate table is installation-global.
    const TABLES = ['bill_payments', 'bills', 'attachments', 'reconciliations', 'bank_mappings',
      'centers', 'vat_codes', 'periods', 'journal_sequences', 'journals', 'accounts',
      'settings', 'user_permissions', 'idempotency_keys', 'partners', 'audit_log', 'companies'];
    for (const t of TABLES) {
      await exec(`DELETE FROM ${t} WHERE company_id = @companyId`, { companyId });
    }
    return { deleted: companyId, remaining: all.filter((c) => c.company_id !== companyId).map((c) => c.company_id) };
  }

  if (action === 'period.list') {
    const rows = await query(
      `SELECT period_name, start_date, end_date, locked, tax_attrs
       FROM (
         SELECT *, ROW_NUMBER() OVER(PARTITION BY period_name ORDER BY created_at DESC) AS rn
         FROM periods WHERE company_id = @companyId
       ) WHERE rn = 1
       ORDER BY start_date DESC`,
      { companyId }
    );
    return rows.map((r) => ({ company_id: companyId, period_id: r.period_name || '', start_date: r.start_date || '', end_date: r.end_date || '', locked: !!r.locked }));
  }

  if (action === 'period.save') {
    const { periods } = body;
    if (!periods || !Array.isArray(periods) || periods.length === 0) throw Object.assign(new Error('periods array required'), { code: 'INVALID_INPUT' });
    const validPeriods = periods.filter((p) => p.period_id && p.start_date && p.end_date);
    if (validPeriods.length === 0) return { saved: 0 };
    const now = new Date().toISOString();
    const rows = validPeriods.map((p) => ({ company_id: companyId, period_name: p.period_id, start_date: p.start_date, end_date: p.end_date, locked: !!p.locked, created_at: now, updated_at: now }));
    // DELETE + INSERT: clean replace (no row accumulation)
    await exec(`DELETE FROM periods WHERE company_id = @companyId`, { companyId });
    await bulkInsert('periods', rows);
    return { saved: rows.length };
  }

  if (action === 'period.upsert') {
    const { period } = body;
    if (!period || !period.period_id || !period.start_date || !period.end_date) throw Object.assign(new Error('period_id, start_date, end_date required'), { code: 'INVALID_INPUT' });
    const now = new Date().toISOString();

    const existing = await query(`SELECT period_name, locked FROM periods WHERE company_id = @companyId AND period_name = @name`, { companyId, name: period.period_id });
    const taxAttrs = period.tax_attrs != null ? JSON.stringify(period.tax_attrs) : null;
    if (existing.length > 0) {
      const oldLocked = !!existing[0].locked;
      const newLocked = !!period.locked;
      await exec(`UPDATE periods SET start_date=@start, end_date=@end, locked=@locked, tax_attrs=COALESCE(@taxAttrs, tax_attrs), updated_at=@now WHERE company_id=@companyId AND period_name=@name`,
        { companyId, name: period.period_id, start: period.start_date, end: period.end_date, locked: newLocked, taxAttrs, now });
      // A2 (§3.2): emit period.locked / period.unlocked on actual transitions.
      // A new period born locked is a creation, not a transition — skipped.
      if (!oldLocked && newLocked) {
        await emitEvent(ctx, 'period.locked', 'period', period.period_id, { period_id: period.period_id, start_date: period.start_date, end_date: period.end_date });
      } else if (oldLocked && !newLocked) {
        await emitEvent(ctx, 'period.unlocked', 'period', period.period_id, { period_id: period.period_id, start_date: period.start_date, end_date: period.end_date });
      }
    } else {
      await bulkInsert('periods', [{ company_id: companyId, period_name: period.period_id, start_date: period.start_date, end_date: period.end_date, locked: !!period.locked, tax_attrs: taxAttrs, created_at: now, updated_at: now }]);
      // fx-automation-spec §4: fire-and-forget backfill on new period creation.
      // Never awaited — the upsert response returns immediately.
      backfillPeriod(companyId, String(period.start_date).slice(0, 10), String(period.end_date).slice(0, 10));
    }
    return { saved: true };
  }

  if (action === 'period.delete') {
    const { periodId } = body;
    if (!periodId) throw Object.assign(new Error('periodId required'), { code: 'INVALID_INPUT' });
    // Referenced-check (docs/settings-ux-spec.md §5): periods relate to journal
    // entries by date-range containment — refuse to delete a period whose range
    // contains entries, or the period-lock structure is orphaned.
    const prow = await query(
      `SELECT start_date, end_date FROM periods WHERE company_id = @companyId AND period_name = @periodId ORDER BY created_at DESC LIMIT 1`,
      { companyId, periodId }
    );
    if (prow.length > 0) {
      const cnt = await query(
        `SELECT CAST(COUNT(*) AS INTEGER) AS n FROM journal_entries WHERE company_id = @companyId AND date BETWEEN @start AND @end`,
        { companyId, start: prow[0].start_date, end: prow[0].end_date }
      );
      const n = cnt.length > 0 ? Number(cnt[0].n) : 0;
      if (n > 0) {
        throw Object.assign(
          new Error(`Cannot delete period "${periodId}": ${n} journal entries fall within its date range.`),
          { code: 'INVALID_STATE' }
        );
      }
    }
    await exec(`DELETE FROM periods WHERE company_id = @companyId AND period_name = @periodId`, { companyId, periodId });
    return { deleted: true };
  }

  if (action === 'settings.get') {
    const rows = await query(`SELECT key, value FROM settings WHERE company_id = @companyId`, { companyId });
    const settings = {};
    for (const row of rows) settings[row.key] = row.value;
    const coRows = await query(
      `SELECT company_name, fy_start, fy_end FROM companies WHERE company_id = @companyId ORDER BY created_at DESC LIMIT 1`,
      { companyId }
    );
    if (coRows.length > 0) {
      settings.companyName = coRows[0].company_name;
      settings.fyStart = String(coRows[0].fy_start || '');
      settings.fyEnd = String(coRows[0].fy_end || '');
    }
    return settings;
  }

  if (action === 'settings.save') {
    const { settings } = body;
    if (!settings || typeof settings !== 'object') throw Object.assign(new Error('settings object required'), { code: 'INVALID_INPUT' });
    const now = new Date().toISOString();
    for (const [key, value] of Object.entries(settings)) {
      const existing = await query(`SELECT key FROM settings WHERE company_id = @companyId AND key = @key LIMIT 1`, { companyId, key });
      if (existing.length > 0) {
        await exec(`UPDATE settings SET value = @value, updated_at = @now WHERE company_id = @companyId AND key = @key`, { companyId, key, value: String(value), now });
      } else {
        await bulkInsert('settings', [{ company_id: companyId, key, value: String(value), updated_at: now }]);
      }
    }
    return { saved: Object.keys(settings).length };
  }

  if (action === 'settings.ai.test') {
    const { endpoint_url, api_key, model } = body;
    if (!endpoint_url) throw Object.assign(new Error('endpoint_url required'), { code: 'INVALID_INPUT' });
    const url = String(endpoint_url).replace(/\/v1\/?$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (api_key) headers['Authorization'] = `Bearer ${api_key}`;
    const t0 = Date.now();
    let r;
    try {
      r = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST', headers,
        body: JSON.stringify({
          model: model || 'default',
          messages: [{ role: 'user', content: 'Respond with: ok' }],
          max_tokens: 5,
        }),
      });
    } catch (fetchErr) {
      const latency_ms = Date.now() - t0;
      return { ok: false, error: `Connection failed: ${fetchErr.message}`, latency_ms };
    }
    const latency_ms = Date.now() - t0;
    if (r.ok) return { ok: true, latency_ms };
    const text = await r.text().catch(() => '');
    return { ok: false, error: `LLM connection failed (HTTP ${r.status})`, latency_ms };
  }
}

// --- Permissions ---

async function assertNotLastOwner(companyId, { excludeEmail, newRole }) {
  if (newRole === 'owner') return; // still an owner after the write, trivially fine
  const rows = await query(
    `SELECT 1 FROM user_permissions
     WHERE (company_id = @companyId OR company_id = '*') AND role = 'owner' AND email != @excludeEmail
     LIMIT 1`,
    { companyId, excludeEmail }
  );
  if (rows.length === 0) {
    throw Object.assign(new Error(`Cannot remove the last owner of "${companyId}". Grant another owner first.`), { code: 'INVALID_STATE' });
  }
}

async function handlePermissions(ctx, action) {
  const { companyId, body, userEmail } = ctx;

  if (action === 'permissions.list') {
    return query(`SELECT * FROM user_permissions WHERE company_id = @companyId OR company_id = '*' ORDER BY email`, { companyId });
  }

  if (action === 'permissions.save') {
    const { permissions } = body;
    if (!permissions || !Array.isArray(permissions)) throw Object.assign(new Error('permissions array required'), { code: 'INVALID_INPUT' });
    await exec(`DELETE FROM user_permissions WHERE company_id = @companyId`, { companyId });
    const now = new Date().toISOString();
    const rows = permissions.map((p) => ({ email: p.email, company_id: companyId, role: p.role, granted_at: now, granted_by: userEmail }));
    if (rows.length > 0) await bulkInsert('user_permissions', rows);
    return { saved: rows.length };
  }

  if (action === 'permissions.upsert') {
    let { email, role } = body;
    if (!email) throw Object.assign(new Error('email required'), { code: 'INVALID_INPUT' });
    const ROLES = Object.keys(ROLE_HIERARCHY);
    if (!ROLES.includes(role)) throw Object.assign(new Error(`role must be one of ${ROLES.join(', ')}`), { code: 'INVALID_INPUT' });
    email = email.toLowerCase(); // normalize BEFORE the DELETE match — DuckDB string comparison
                                  // is case-sensitive; without this, upserting "Agent@x.com" then
                                  // "agent@x.com" misses the existing row and creates a silent
                                  // duplicate instead of updating it (see §2.4a)

    await assertNotLastOwner(companyId, { excludeEmail: email, newRole: role }); // §2.3

    const now = new Date().toISOString();
    await exec(`DELETE FROM user_permissions WHERE company_id = @companyId AND email = @email`, { companyId, email });
    await bulkInsert('user_permissions', [{ email, company_id: companyId, role, granted_at: now, granted_by: userEmail || null }]);
    return { saved: 1 };
  }

  if (action === 'permissions.delete') {
    let { email } = body;
    if (!email) throw Object.assign(new Error('email required'), { code: 'INVALID_INPUT' });
    email = email.toLowerCase(); // same normalization, same reason — an exact-match delete on
                                  // mismatched casing would silently no-op and leave the row behind
    await assertNotLastOwner(companyId, { excludeEmail: email, newRole: null }); // §2.3
    await exec(`DELETE FROM user_permissions WHERE company_id = @companyId AND email = @email`, { companyId, email });
    return { deleted: 1 };
  }
}

// --- Agent (B9) ---

async function handleAgent(ctx, action) {
  if (action === 'agent.status') {
    const { feedWatcher, agentLoop } = require('./boot-state');
    return {
      running: agentLoop?.getStatus()?.running || false,
      feedWatcher: feedWatcher?.getStatus() || null,
    };
  }
  throw Object.assign(new Error(`Unknown agent action: ${action}`), { code: 'UNKNOWN_ACTION' });
}

// --- Diagnostics ---

async function handleDiag(ctx, action) {
  const { companyId, body } = ctx;

  if (action === 'diag.account') {
    const accountCode = body.accountCode || '';
    if (!accountCode) throw Object.assign(new Error('accountCode required'), { code: 'INVALID_INPUT' });

    const lines = await query(
      `SELECT entry_id, batch_id, date, account_code, debit, credit,
              debit - credit AS net, description, reference, source, created_at
       FROM journal_entries
       WHERE company_id = @companyId AND account_code = @accountCode
       ORDER BY date, created_at`,
      { companyId, accountCode }
    );

    const totals = await query(
      `SELECT COUNT(*) AS line_count, SUM(debit) AS total_debit, SUM(credit) AS total_credit,
              SUM(debit - credit) AS net_balance
       FROM journal_entries
       WHERE company_id = @companyId AND account_code = @accountCode`,
      { companyId, accountCode }
    );

    const byCum = await query(
      `SELECT p.period_name, p.end_date,
              COALESCE(SUM(j.debit - j.credit), 0) AS cumulative_balance
       FROM periods p
       LEFT JOIN journal_entries j
         ON j.company_id = @companyId AND j.account_code = @accountCode AND j.date <= p.end_date
       WHERE p.company_id = @companyId
       GROUP BY p.period_name, p.end_date
       ORDER BY p.end_date`,
      { companyId, accountCode }
    );

    return { accountCode, summary: totals[0] || {}, periodBalances: byCum, lines };
  }
}

// Ensure DB is open (with WAL recovery) before accepting requests
ensureDb().then(async () => {
  // A4 (§4.7): run attachment GC at boot, then every 24h (unref'd so the timer
  // never keeps the event loop alive on its own). GC purges expired
  // journal_proposal-bound attachments past the 30-day grace; it never touches
  // entity_type='journal' rows (BFL 7 kap retention). Failures are logged, not
  // fatal — a GC miss just defers cleanup to the next tick.
  try { await runAttachmentGC(); } catch (e) { console.error('Boot attachment GC failed:', e.message); }
  const gcTimer = setInterval(() => {
    runAttachmentGC().catch((e) => console.error('Scheduled attachment GC failed:', e.message));
  }, 24 * 60 * 60 * 1000);
  gcTimer.unref();

  // ── fx-automation-spec §6: FX gap scanner ──────────────────────────────
  // On startup + every 6h (FREEBOOKS_FX_SCAN_MS). Short-circuits if no company
  // has fx_tracking='true' with a real provider. Timer is unref'd.
  const { startFxScanner } = require('./fx-scanner');
  startFxScanner();

  // ── B9: in-process agent pipeline boot ─────────────────────────────────
  // Build a dispatchAction function that replicates the HTTP dispatch logic
  // but calls handlers directly in-process (no HTTP, no tokens). The agent
  // loop uses this to call bank.match, journal.propose, event.list, etc.
  const { ACTIONS } = require('./action-catalog');
  const { resolveActor } = require('./auth');
  const { handleEvents } = require('./events');
  // Derived from the catalog's agentWritable flag (same source as HTTP
  // dispatch above) — keeps the in-process agent pipeline in sync.
  const AGENT_ALLOWED = new Set(Object.entries(ACTIONS).filter(([, m]) => m.agentWritable).map(([name]) => name));

  async function dispatchAction(action, params, companyId, agentEmail) {
    const body = { action, companyId, userEmail: agentEmail, ...params };
    const requiredRole = ACTION_ROLES[action];
    if (!requiredRole) throw Object.assign(new Error(`Unknown action: ${action}`), { code: 'UNKNOWN_ACTION' });

    const actor = await resolveActor(agentEmail, companyId);
    if (actor.actorType === 'agent') {
      const meta = ACTIONS[action];
      const mutating = !!(meta && meta.mutating === true);
      if (mutating && !AGENT_ALLOWED.has(action)) {
        throw Object.assign(new Error('Agents may not finalize or mutate master data'), { code: 'FORBIDDEN' });
      }
    }

    const ctx = { body, companyId, userEmail: agentEmail, actor, requestId: null, tokenAuth: null };
    const [module] = action.split('.');

    // Reuse the same dispatch switch — delegate to handleApiRequest's handlers
    // by calling them directly. Each handler takes (ctx, action).
    const handlers = {
      journal: () => require('./journal').handleJournal(ctx, action),
      inbox: () => require('./inbox').handleInbox(ctx, action),
      bank: () => require('./bank').handleBank(ctx, action),
      bill: () => require('./bills').handleBills(ctx, action),
      partner: () => require('./partners').handlePartners(ctx, action),
      view: () => require('./views').handleViews(ctx, action),
      report: () => require('./reports').handleReports(ctx, action),
      vat: () => require('./vat').handleVat(ctx, action),
      wht: () => require('./wht').handleWht(ctx, action),
      fx: () => require('./fx').handleFx(ctx, action),
      coa: () => require('./index').handleCoa(ctx, action),
      mapping: () => require('./index').handleMapping(ctx, action),
      matching_history: () => require('./index').handleMatchingHistory(ctx, action),
      input_rejection: () => require('./index').handleInputRejection(ctx, action),
      calibration: () => require('./index').handleCalibration(ctx, action),
      center: () => require('./index').handleCenter(ctx, action),
      journals: () => require('./index').handleJournals(ctx, action),
      settings: () => require('./index').handleSettings(ctx, action),
      company: () => require('./index').handleSettings(ctx, action),
      period: () => require('./index').handleSettings(ctx, action),
      posting_rules: () => require('./index').handleSettings(ctx, action),
      ai: () => require('./index').handleSettings(ctx, action),
      filing: () => require('./index').handlePeriodsService(ctx, action),
      permissions: () => require('./index').handlePermissions(ctx, action),
      setup: () => { throw Object.assign(new Error('Agents may not run setup actions'), { code: 'FORBIDDEN' }); },
      diag: () => require('./index').handleDiag(ctx, action),
      attachment: () => require('./attachments').handleAttachments(ctx, action),
      event: () => handleEvents(ctx, action),
      auth: () => require('./tokens').handleTokens(ctx, action),
      sie: () => require('./sie-import').handleSie(ctx, action),
      notification: () => require('./notifications').handleNotifications(ctx, action),
      agent: () => require('./index').handleAgent(ctx, action),
    };

    const handler = handlers[module];
    if (!handler) throw Object.assign(new Error(`Unknown module: ${module}`), { code: 'INVALID_INPUT' });

    // freebooks_read is a passthrough that dispatches a sub-action
    if (action === 'freebooks_read') {
      const subAction = body.action;
      const subModule = subAction.split('.')[0];
      const subHandler = handlers[subModule];
      if (!subHandler) throw Object.assign(new Error(`Unknown sub-module: ${subModule}`), { code: 'INVALID_INPUT' });
      return subHandler();
    }

    return handler();
  }

  // Fetch attachment content for the agent loop (reads from disk, not HTTP)
  const path = require('path');
  const fs = require('fs');
  const { ATTACHMENTS_ROOT } = require('./attachments');
  async function fetchAttachmentFn(attachmentId) {
    const rows = await query(
      `SELECT storage_path, content_type, filename FROM attachments WHERE attachment_id = @id LIMIT 1`,
      { id: attachmentId }
    );
    if (rows.length === 0) throw new Error('Attachment not found');
    const { storage_path, content_type, filename } = rows[0];
    const fullPath = path.join(ATTACHMENTS_ROOT, storage_path);
    const buffer = fs.readFileSync(fullPath);
    return {
      contentType: content_type,
      filename,
      buffer,
      text: buffer.toString('utf8'),
    };
  }

  // Feed watcher upload function — calls storeAttachment directly
  const { storeAttachment } = require('./attachments');
  const { resolveActor: resolveActorAuth } = require('./auth');
  async function feedWatcherUpload(companyId, entityType, entityId, filename, buffer, contentType, idempotencyKey) {
    const actor = await resolveActorAuth('agent@freebooks.local', companyId);
    return storeAttachment({
      companyId, entityType, entityId, filename,
      contentType, buffer, uploadedBy: 'agent@freebooks.local',
      actor, requestId: null,
    });
  }

  // Start feed watcher if enabled (install-level setting)
  const { query: q } = require('./db');
  const feedWatcher = require('./feed-watcher');
  const agentLoop = require('./agent-loop');
  const bootState = require('./boot-state');
  bootState.setFeedWatcher(feedWatcher);
  bootState.setAgentLoop(agentLoop);

  // Check if feed watcher is enabled at install level
  let fwEnabled = false;
  try {
    const rows = await q(`SELECT value FROM settings WHERE company_id = '__install__' AND key = 'feed_watcher_enabled' LIMIT 1`);
    fwEnabled = rows.length > 0 && rows[0].value === 'true';
  } catch (e) { /* settings table may not exist yet — non-fatal */ }

  // Check if any company has agent_enabled
  let anyAgentEnabled = false;
  try {
    const rows = await q(`SELECT 1 FROM settings WHERE key = 'agent_enabled' AND value = 'true' LIMIT 1`);
    anyAgentEnabled = rows.length > 0;
  } catch (e) { /* non-fatal */ }

  if (fwEnabled) {
    feedWatcher.startFeedWatcher(feedWatcherUpload);
  }
  if (anyAgentEnabled) {
    agentLoop.startAgentLoop(dispatchAction, fetchAttachmentFn);
  }

  app.listen(PORT, HOST, () => {
    console.log(`freeBooks API listening on ${HOST}:${PORT}`);
  });
}).catch(err => {
  console.error('Fatal: could not open database:', err.message);
  process.exit(1);
});

// Graceful shutdown — flush WAL before exit
async function shutdown(signal) {
  console.log(`\nShutting down… (${signal})`);
  const timer = setTimeout(() => {
    console.warn('Shutdown timed out, forcing exit.');
    process.exit(1);
  }, 5000);
  try {
    await exec('CHECKPOINT;');
    console.log('Database checkpointed.');
  } catch (err) {
    console.warn('Checkpoint failed:', err.message);
  } finally {
    clearTimeout(timer);
    process.exit(0);
  }
}

process.on('SIGINT',  () => shutdown('SIGINT').catch(() => process.exit(1)));
process.on('SIGTERM', () => shutdown('SIGTERM').catch(() => process.exit(1)));

module.exports = app;
