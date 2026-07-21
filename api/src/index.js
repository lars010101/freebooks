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

const { checkPermission } = require('./auth');
const { handleJournal } = require('./journal');
const { handleBank } = require('./bank');
const { handleBills } = require('./bills');
const { handleVendors } = require('./vendors');
const { handleReports, mountReportRoutes } = require('./reports');
const { handleVat } = require('./vat');
const { handleFx } = require('./fx');
const { handleSetup } = require('./setup');
const { handleAttachments } = require('./attachments');
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
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  DUPLICATE: 409,
  CONFLICT: 409,
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
    }

    // ── P0-1: idempotency check (dispatch-level, before handler execution) ──
    // Key from `Idempotency-Key` header, fallback body.idempotencyKey. No key
    // → normal execution (legacy behavior unchanged).
    const idemKeyRaw = req.get('Idempotency-Key') || body.idempotencyKey;
    const idemKey = idemKeyRaw != null && String(idemKeyRaw).trim() !== '' ? String(idemKeyRaw) : null;
    if (idemKey && IDEMPOTENT_ACTIONS.has(action)) {
      const existing = await query(
        `SELECT action, http_status, response_json FROM idempotency_keys WHERE key = @key`,
        { key: idemKey }
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
      wrapIdempotentResponse(res, idemKey, action, companyId);
    }

    const ctx = { body, companyId, userEmail };
    let result;
    const [module] = action.split('.');

    switch (module) {
      case 'journal':     result = await handleJournal(ctx, action); break;
      case 'bank':        result = await handleBank(ctx, action); break; // bank.process, bank.approve, bank.reconcile.*
      case 'bill':        result = await handleBills(ctx, action); break;
      case 'vendor':      result = await handleVendors(ctx, action); break;
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
      default:
        return fail(res, 'INVALID_INPUT', `Unknown module: ${module}`);
    }

    // P0-4: audit every mutating action after successful execution. Audit
    // failure is logged loudly but must not fail the business request.
    if (isAuditableAction(action)) {
      try {
        await auditCall(companyId || null, action, userEmail || 'anonymous', body);
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
    const now = new Date().toISOString();
    const existing = await query(`SELECT account_code FROM accounts WHERE company_id = @companyId AND account_code = @code`, { companyId, code: account.account_code });
    if (existing.length > 0) {
      await exec(`UPDATE accounts SET account_name=@name, account_subtype=@subtype, cf_category=@cf, is_active=@active WHERE company_id=@companyId AND account_code=@code`,
        { companyId, code: account.account_code, name: account.account_name, subtype: account.account_subtype || null, cf: account.cf_category || null, active: account.is_active !== false });
    } else {
      await bulkInsert('accounts', [{ company_id: companyId, account_code: account.account_code, account_name: account.account_name, account_type: account.account_type, account_subtype: account.account_subtype || null, cf_category: account.cf_category || null, is_active: account.is_active !== false, effective_from: now, effective_to: null, created_at: now }]);
    }
    return { saved: true };
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
    const row = { company_id: companyId, mapping_id: mappingId, pattern: mapping.pattern, match_type: mapping.match_type || 'contains', debit_account: mapping.debit_account, credit_account: null, description_override: mapping.description_override || null, vat_code: null, cost_center: null, profit_center: null, priority: mapping.priority || 100, is_active: mapping.is_active !== false };
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

  if (action === 'period.list') {
    const rows = await query(
      `SELECT period_name, start_date, end_date, locked
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
    const existing = await query(`SELECT period_name FROM periods WHERE company_id = @companyId AND period_name = @name`, { companyId, name: period.period_id });
    if (existing.length > 0) {
      await exec(`UPDATE periods SET start_date=@start, end_date=@end, locked=@locked, updated_at=@now WHERE company_id=@companyId AND period_name=@name`,
        { companyId, name: period.period_id, start: period.start_date, end: period.end_date, locked: !!period.locked, now });
    } else {
      await bulkInsert('periods', [{ company_id: companyId, period_name: period.period_id, start_date: period.start_date, end_date: period.end_date, locked: !!period.locked, created_at: now, updated_at: now }]);
    }
    return { saved: true };
  }

  if (action === 'period.delete') {
    const { periodId } = body;
    if (!periodId) throw Object.assign(new Error('periodId required'), { code: 'INVALID_INPUT' });
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
