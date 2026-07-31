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

const { checkPermission, resolveActor } = require('./auth');
const { handleJournal } = require('./journal');
const { handleBank } = require('./bank');
const { handleBills } = require('./bills');
const { handleVendors } = require('./vendors');
const { handleViews } = require('./views');
const { handleReports, mountReportRoutes } = require('./reports');
const { handleVat } = require('./vat');
const { handleFx, providerExists, listProviderIds, MANUAL_PROVIDER } = require('./fx');
const { handleSetup } = require('./setup');
const { handleAttachments } = require('./attachments');
const { handleEvents, emitEvent } = require('./events');
const { getDb, ensureDb, query, exec, bulkInsert } = require('./db');
const { auditCall } = require('./audit');
const PORT = process.env.PORT || 3000;

// P1-1: action metadata is the single source of truth — roles, idempotency,
// mutability/audit behavior, and param schemas all live in action-catalog.js
// and are served to agents at GET /api/actions.
const { ACTIONS } = require('./action-catalog');

const ACTION_ROLES = Object.fromEntries(
  Object.entries(ACTIONS).map(([name, meta]) => [name, meta.role])
);

const app = express();
app.use(cors());
app.use(express.json());

// ── P0-2: Unified error envelope ─────────────────────────────────────────────
// All failure paths in the /api dispatch flow return:
//   { ok: false, error: { code, message, details? } }
// with an HTTP status derived from the error code.
const ERROR_STATUS = {
  INVALID_INPUT: 400,
  VALIDATION: 400,
  INVALID_ACCOUNT: 400,
  UNKNOWN_ACTION: 400,
  PERIOD_UNDEFINED: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  DUPLICATE: 409,
  CONFLICT: 409,
  INVALID_STATUS: 409,
  ALREADY_REVERSED: 409,
  REFERENTIAL_INTEGRITY: 409,
  DUPLICATE_CODE: 409,
  PERIOD_LOCKED: 409,
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
    const { action, companyId, userEmail } = body;

    if (!action) return fail(res, 'INVALID_INPUT', 'Missing action');
    if (!action.startsWith('setup.') && !companyId) return fail(res, 'INVALID_INPUT', 'Missing companyId');

    const requiredRole = ACTION_ROLES[action];
    if (!requiredRole) return fail(res, 'INVALID_INPUT', `Unknown action: ${action}`);

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
    const AGENT_ALLOWED = new Set(['attachment.upload', 'journal.propose']);
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

    const ctx = { body, companyId, userEmail, actor, requestId };
    let result;
    const [module] = action.split('.');

    switch (module) {
      case 'journal':     result = await handleJournal(ctx, action); break;
      case 'bank':        result = await handleBank(ctx, action); break; // bank.process, bank.approve, bank.reconcile.*
      case 'bill':        result = await handleBills(ctx, action); break;
      case 'vendor':      result = await handleVendors(ctx, action); break;
      case 'view':        result = await handleViews(ctx, action); break; // P1-8 read models
      case 'report':      result = await handleReports(ctx, action); break;
      case 'vat':         result = await handleVat(ctx, action); break;
      case 'fx':          result = await handleFx(ctx, action); break;
      case 'coa':         result = await handleCoa(ctx, action); break;
      case 'mapping':     result = await handleMapping(ctx, action); break;
      case 'center':      result = await handleCenter(ctx, action); break;
      case 'journals':   result = await handleJournals(ctx, action); break;
      case 'settings':
      case 'company':
      case 'period':      result = await handleSettings(ctx, action); break;
      case 'permissions': result = await handlePermissions(ctx, action); break;
      case 'setup':       result = await handleSetup(ctx, action); break;
      case 'diag':        result = await handleDiag(ctx, action); break;
      case 'attachment':  result = await handleAttachments(ctx, action); break;
      case 'event':       result = await handleEvents(ctx, action); break;
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
const { uploadMiddleware, handleUpload, serveAttachment } = require('./attachments');
app.post('/api/upload', uploadMiddleware, handleUpload);
app.get('/api/attachments/:attachmentId', serveAttachment);

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
    const ALLOWED_ROLES = new Set([null, '', 'AP', 'Expense']);
    let role = (account.default_role === undefined ? null : account.default_role);
    if (role === '') role = null;
    if (!ALLOWED_ROLES.has(role)) {
      throw Object.assign(new Error(`default_role must be null, 'AP', or 'Expense' (got: ${JSON.stringify(account.default_role)})`), { code: 'INVALID_INPUT' });
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
    const row = { company_id: companyId, mapping_id: mappingId, pattern: mapping.pattern, match_type: mapping.match_type || 'contains', debit_account: mapping.debit_account, credit_account: mapping.credit_account || '', description_override: mapping.description_override || null, vat_code: null, cost_center: null, profit_center: null, priority: mapping.priority || 100, is_active: mapping.is_active !== false };
    if (existing.length > 0) {
      await exec(`UPDATE bank_mappings SET pattern=@pattern, match_type=@match_type, debit_account=@debit_account, description_override=@description_override, priority=@priority, is_active=@is_active WHERE company_id=@companyId AND mapping_id=@mapping_id`,
        { companyId, mapping_id: mappingId, pattern: row.pattern, match_type: row.match_type, debit_account: row.debit_account, description_override: row.description_override, priority: row.priority, is_active: row.is_active });
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
}

// --- Centers ---

async function handleCenter(ctx, action) {
  const { companyId, body } = ctx;

  if (action === 'center.list') {
    return query(`SELECT * FROM centers WHERE company_id = @companyId ORDER BY center_type, center_id`, { companyId });
  }

  if (action === 'center.save') {
    const { centers } = body;
    if (!centers || !Array.isArray(centers)) throw Object.assign(new Error('centers array required'), { code: 'INVALID_INPUT' });
    await exec(`DELETE FROM centers WHERE company_id = @companyId`, { companyId });
    const rows = centers.map((c) => ({ company_id: companyId, center_id: c.center_id, center_type: c.center_type, name: c.name, is_active: c.is_active !== false }));
    if (rows.length > 0) await bulkInsert('centers', rows);
    return { saved: rows.length };
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
    const providerIds = listProviderIds();
    const curProvider = s.fx_provider || MANUAL_PROVIDER;
    const providerNames = { [MANUAL_PROVIDER]: 'Manual (no auto-download)' };
    for (const id of providerIds) {
      try { providerNames[id] = require(`./fxProviders/${id}.js`).name || id; } catch (e) { providerNames[id] = id; }
    }
    const pctFraction = parseFloat(s.vat_tolerance_pct);
    const pctDisplay = isNaN(pctFraction) ? 1 : Math.round(pctFraction * 100 * 100) / 100; // storage fraction → percent
    const flatNum = parseFloat(s.vat_tolerance);
    const dash = '—';
    return [
      { key: 'company_id', label: 'Company ID', type: 'String', value: co.company_id, display: co.company_id, editor: { type: 'text' }, readonly: true },
      { key: 'company_name', label: 'Company Name', type: 'String', value: co.company_name || '', display: co.company_name || dash, editor: { type: 'text' } },
      { key: 'currency', label: 'Base Currency', type: 'String', value: co.currency || '', display: co.currency || dash, editor: { type: 'text', uppercase: true } },
      { key: 'jurisdiction', label: 'Jurisdiction', type: 'Choice', value: co.jurisdiction || 'SG', display: co.jurisdiction || dash,
        editor: { type: 'select', options: [{ value: 'SG', label: 'SG — Singapore' }, { value: 'SE', label: 'SE — Sweden' }] } },
      { key: 'tax_id', label: 'Tax ID', type: 'String', value: co.tax_id || '', display: co.tax_id || dash, editor: { type: 'text' } },
      { key: 'reporting_standard', label: 'Reporting Standard', type: 'Choice', value: co.reporting_standard || 'IFRS', display: co.reporting_standard || dash,
        editor: { type: 'select', options: ['IFRS', 'SFRS', 'K2', 'K3'] } },
      { key: 'vat_registered', label: 'VAT/GST Registered', type: 'Boolean', value: co.vat_registered === true || co.vat_registered === 1, display: (co.vat_registered === true || co.vat_registered === 1) ? 'Yes' : 'No', editor: { type: 'checkbox' } },
      { key: 'multi_currency', label: 'Multi-Currency', type: 'Boolean', value: s.fx_tracking !== 'off', display: s.fx_tracking !== 'off' ? 'Yes' : 'No', editor: { type: 'checkbox' } },
      { key: 'fx_provider', label: 'FX Provider', type: 'Choice', value: curProvider, display: providerNames[curProvider] || curProvider,
        editor: { type: 'select', options: [{ value: MANUAL_PROVIDER, label: providerNames[MANUAL_PROVIDER] }].concat(providerIds.map((id) => ({ value: id, label: providerNames[id] }))) } },
      { key: 'fx_provider_api_key', label: 'FX API Key', type: 'String', value: '', display: s.fx_provider_api_key ? '••••' + String(s.fx_provider_api_key).slice(-4) : dash,
        editor: { type: 'text' }, note: 'Blank keeps the stored key' },
      { key: 'vat_tolerance', label: 'VAT Tolerance (flat)', type: 'Number', value: isNaN(flatNum) ? 0.5 : flatNum, display: (isNaN(flatNum) ? 0.5 : flatNum).toFixed(2), editor: { type: 'number', step: '0.01' } },
      { key: 'vat_tolerance_pct', label: 'VAT Tolerance (%)', type: 'Number', value: pctDisplay, display: pctDisplay.toFixed(2) + '%', editor: { type: 'number', step: '0.1' } },
      { key: 'fx_gain_loss_account', label: 'FX Gain/Loss Account', type: 'String', value: s.fx_gain_loss_account || '', display: s.fx_gain_loss_account || dash, editor: { type: 'text' } },
    ];
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
      case 'multi_currency':
        await putSetting(companyId, 'fx_tracking', (value === true || value === 'true') ? 'auto' : 'off');
        break;
      case 'fx_provider': {
        if (value !== MANUAL_PROVIDER && !providerExists(value)) throw invalid(`Unknown FX provider: ${value}`);
        await putSetting(companyId, 'fx_provider', value);
        break;
      }
      case 'fx_provider_api_key': {
        const v = String(value || '').trim();
        if (v) await putSetting(companyId, 'fx_provider_api_key', v); // blank keeps the stored key
        break;
      }
      case 'vat_tolerance': {
        const n = Number(value);
        if (!isFinite(n) || n < 0) throw invalid('Flat tolerance must be a non-negative number');
        await putSetting(companyId, 'vat_tolerance', String(n));
        break;
      }
      case 'vat_tolerance_pct': {
        const n = Number(value); // wire format is a PERCENT (1 = 1%); storage is a fraction
        if (!isFinite(n) || n < 0) throw invalid('Tolerance % must be a non-negative number');
        await putSetting(companyId, 'vat_tolerance_pct', String(n / 100));
        break;
      }
      case 'fx_gain_loss_account': {
        const v = String(value || '').trim();
        if (v) {
          const acct = await query(
            `SELECT account_code FROM accounts WHERE company_id = @companyId AND account_code = @v LIMIT 1`,
            { companyId, v }
          );
          if (acct.length === 0) throw invalid(`Account "${v}" not found in the chart of accounts`);
        }
        await putSetting(companyId, 'fx_gain_loss_account', v);
        break;
      }
      default:
        throw Object.assign(new Error(`Unknown company attribute: ${key}`), { code: 'INVALID_INPUT' });
    }
    return { saved: true, key };
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
      'settings', 'user_permissions', 'idempotency_keys', 'vendors', 'audit_log', 'companies'];
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
}

// --- Permissions ---

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
ensureDb().then(() => {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`freeBooks API listening on port ${PORT}`);
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
