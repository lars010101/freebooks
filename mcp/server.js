'use strict';
/**
 * freebooks MCP server — stdio transport (Phase A, spec §5).
 *
 * Exposes the agent-ready freebooks action surface as seven MCP tools:
 *   - event_list              → action `event.list`            (work-discovery)
 *   - journal_propose         → action `journal.propose`       (ledger write path)
 *   - attachment_upload       → action `attachment.upload`     (base64 — agent never touches disk)
 *   - freebooks_read          → any catalog action with mutating:false (generic read)
 *   - matching_history_record → action `matching_history.record` (learning-store write)
 *   - mapping_suggest         → action `mapping.suggest`       (propose bank-mapping rules)
 *   - bill_create             → action `bill.create`           (agent saves a draft; human posts)
 *
 * Identity / correlation (spec §5.1):
 *   - FREEBOOKS_API_URL  (default http://127.0.0.1:3000)
 *   - FREEBOOKS_USER     (agent-role account email — install-level trust, self-asserted)
 *   - FREEBOOKS_COMPANY   (company id)
 *   - FREEBOOKS_REQUEST_ID (optional override; else one uuid minted at server start,
 *     sent as X-Request-Id on EVERY api call — one MCP session = one correlated run)
 *   - FREEBOOKS_API_TOKEN (optional per-actor API token — sent as
 *     Authorization: Bearer on every API call; REQUIRED when the API runs
 *     FREEBOOKS_AUTH_MODE=token-remote and the MCP server is on another host)
 *   - Every mutating tool call sends Idempotency-Key (uuid per logical call; the
 *     caller may supply `idempotency_key` for cross-retry identity).
 *
 * R1 preserved: the server talks HTTP to the action API only. No DB path, no
 * filesystem access beyond its own code. File bytes for attachment_upload come
 * from the base64 `contentBase64` param — NEVER from disk.
 */

const { Server } = require('@modelcontextprotocol/sdk/server');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const API_URL = (process.env.FREEBOOKS_API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const FREEBOOKS_USER = process.env.FREEBOOKS_USER || '';
const FREEBOOKS_COMPANY = process.env.FREEBOOKS_COMPANY || '';
const REQUEST_ID = process.env.FREEBOOKS_REQUEST_ID || crypto.randomUUID();
const API_TOKEN = process.env.FREEBOOKS_API_TOKEN || '';

// One MCP session = one correlated run. X-Request-Id rides every API call so
// audit_log + events share a single request_id (R3).
const SESSION_HEADERS = {
  'X-Request-Id': REQUEST_ID,
  ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
};

// ── static fallback read allowlist (spec §5.2 freebooks_read) ──────────────
// Used only if GET /api/actions is unreachable at startup. The server-side
// §2.3 default-deny whitelist remains the enforcement either way.
const FALLBACK_READ_ACTIONS = new Set([
  'journal.list',
  'journal.get',
  'journal.search',
  'event.list',
  'journal.proposal.list',
  'journal.proposal.get',
]);

let READ_ALLOWLIST = null; // Set<string> of non-mutating catalog actions, or null

// The seven tools this server advertises (spec §5.2). The manifest is
// self-documenting: there is deliberately NO approve/reject/post/void/master-data
// tool — an agent account is denied those server-side anyway (§2.3), and their
// absence keeps the tool surface honest. The three Phase B write tools
// (matching_history_record, mapping_suggest, bill_create) do NOT change this
// principle: matching_history_record writes only to the learning store (never
// the ledger), mapping_suggest proposes to mapping_suggestions (a human
// approves into bank_mappings — the "approve is the post" pattern), and
// bill_create saves a DRAFT when called by an agent (the human posts it via
// bill.draft.post). No tool lets an agent finalize or mutate master data.
const TOOLS = [
  {
    name: 'event_list',
    description:
      "List freebooks business events (append-only stream, §3.3) — the agent's work-discovery channel. Ordered by event_seq ASC. Maps to action `event.list`.",
    inputSchema: {
      type: 'object',
      properties: {
        after_seq: { type: 'number', description: 'Return events with event_seq > after_seq (polling cursor; default 0).' },
        type: { type: 'string', description: 'Optional event_type filter (e.g. journal.posted, attachment.uploaded).' },
        limit: { type: 'number', description: 'Max rows (server caps at 500; default 100).' },
      },
    },
  },
  {
    name: 'journal_propose',
    description:
      'Propose a balanced journal batch (enriched + validated server-side; nothing reaches journal_entries until a human approves — R5). The ONLY write path to the ledger. Maps to action `journal.propose`.',
    inputSchema: {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          description: 'Journal lines (journal.post row shape): account_code, debit, credit, date, description, vat_code, etc.',
          items: { type: 'object' },
        },
        journalId: { type: 'string', description: 'Optional journal series id (auto reference on post).' },
        reference: { type: 'string' },
        description: { type: 'string' },
        proposalId: { type: 'string', description: 'With proposalId: upsert a still-proposed row owned by the same caller (extraction fixes, retries).' },
        idempotency_key: { type: 'string', description: 'Caller-supplied Idempotency-Key for cross-retry identity. If omitted, a fresh uuid is minted for this logical call.' },
      },
      required: ['lines'],
    },
  },
  {
    name: 'attachment_upload',
    description:
      'Upload a file attachment. The file bytes come from the base64 `contentBase64` param — NEVER from disk (R1). Maps to action `attachment.upload`. Emits attachment.uploaded (the feed-extraction trigger).',
    inputSchema: {
      type: 'object',
      properties: {
        entityType: { type: 'string', description: 'Entity kind the file attaches to (e.g. bill, journal, vendor).' },
        entityId: { type: 'string', description: 'The id of the entity to attach to.' },
        filename: { type: 'string', description: 'Original filename (stored sanitized).' },
        contentBase64: { type: 'string', description: 'File contents, base64-encoded.' },
        contentType: { type: 'string', description: 'Optional MIME type (e.g. text/plain, application/pdf).' },
        idempotency_key: { type: 'string', description: 'Caller-supplied Idempotency-Key for cross-retry identity. If omitted, a fresh uuid is minted for this logical call.' },
      },
      required: ['entityType', 'entityId', 'filename', 'contentBase64'],
    },
  },
  {
    name: 'freebooks_read',
    description:
      'Generic read gateway for any freebooks catalog action with mutating===false (journal.list/get/search, account balances, views, reports, journal.proposal.*, etc.). A mutating action is refused client-side with a friendly rule; the server-side §2.3 whitelist remains the enforcement.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Catalog action name (e.g. journal.list).' },
        params: { type: 'object', description: 'Action parameters (companyId is injected from FREEBOOKS_COMPANY).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'matching_history_record',
    description: 'Record a bank-matching proposal review outcome (approved_unedited/approved_edited/rejected). Feeds calibration and rule crystallization/retirement (bank-matching-spec §6/§10). Maps to action matching_history.record.',
    inputSchema: {
      type: 'object',
      properties: {
        description_pattern: { type: 'string', description: 'Normalized statement-line description pattern.' },
        source_type: { type: 'string', description: 'learned_rule | open_item | master_data | llm_semantic' },
        outcome: { type: 'string', description: 'approved_unedited | approved_edited | rejected' },
        bank_account: { type: 'string' },
        counterparty: { type: 'string' },
        amount: { type: 'number' },
        proposed_dimensions: { type: 'object' },
        approved_dimensions: { type: 'object' },
        confidence: { type: 'object' },
        evidence: { type: 'object' },
        idempotency_key: { type: 'string', description: 'Caller-supplied Idempotency-Key for cross-retry identity.' },
      },
      required: ['description_pattern', 'source_type', 'outcome'],
    },
  },
  {
    name: 'mapping_suggest',
    description: 'Propose a candidate bank-mapping rule to mapping_suggestions (never to mappings itself — human approves via inbox). Maps to action mapping.suggest (bank-matching-spec §10.2/§10.4).',
    inputSchema: {
      type: 'object',
      properties: {
        description_pattern: { type: 'string', description: 'Statement description pattern to match.' },
        suggested_account: { type: 'string', description: 'Account code for the suggested rule.' },
        suggestionId: { type: 'string', description: 'With suggestionId: upsert a still-proposed row owned by the same caller.' },
        bank_account: { type: 'string' },
        suggested_vat_code: { type: 'string' },
        suggested_dimensions: { type: 'object' },
        evidence: { type: 'object' },
        source_proposal_id: { type: 'string' },
        idempotency_key: { type: 'string', description: 'Caller-supplied Idempotency-Key.' },
      },
      required: ['description_pattern', 'suggested_account'],
    },
  },
  {
    name: 'bill_create',
    description: 'Create a bill DRAFT from an extracted supplier invoice (agent-data-feeding-guide §4.5b). The draft enters the inbox as a Class A item; a human posts it via bill.post. Maps to action bill.create. No bill_post tool exists — the human approval IS the post (agent-readiness-spec §4.1).',
    inputSchema: {
      type: 'object',
      properties: {
        bill: { type: 'object', description: 'Bill object (vendor, amount, due date, line items, currency). Same shape as bill.create action.' },
        _replaceDraftId: { type: 'string' },
        payment_batch_id: { type: 'string' },
        idempotency_key: { type: 'string', description: 'Caller-supplied Idempotency-Key.' },
      },
      required: ['bill'],
    },
  },
];

// ── helpers ────────────────────────────────────────────────────────────────

function newIdempotencyKey() {
  return crypto.randomUUID();
}

// POST /api with the action envelope. Returns { ok, status, data, error }.
async function callAction(action, params, { idempotencyKey } = {}) {
  const headers = { 'Content-Type': 'application/json', ...SESSION_HEADERS };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const body = {
    action,
    companyId: FREEBOOKS_COMPANY,
    userEmail: FREEBOOKS_USER,
    requestId: REQUEST_ID,
    ...params,
  };
  const r = await fetch(`${API_URL}/api`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-json */ }
  if (json && json.ok === true) {
    return { ok: true, status: r.status, data: json.data };
  }
  const err = (json && json.error) || { code: 'HTTP_' + r.status, message: `HTTP ${r.status}` };
  return { ok: false, status: r.status, error: err };
}

// Fetch the catalog at startup and build the non-mutating read allowlist.
// On failure, fall back to FALLBACK_READ_ACTIONS and warn to stderr.
async function buildReadAllowlist() {
  try {
    const r = await fetch(`${API_URL}/api/actions`, { headers: SESSION_HEADERS });
    if (!r.ok) throw new Error(`GET /api/actions → HTTP ${r.status}`);
    const j = await r.json();
    const actions = (j && j.actions) || {};
    const allow = new Set();
    for (const [name, meta] of Object.entries(actions)) {
      if (meta && meta.mutating === false) allow.add(name);
    }
    if (allow.size === 0) throw new Error('catalog returned no non-mutating actions');
    READ_ALLOWLIST = allow;
  } catch (err) {
    READ_ALLOWLIST = new Set(FALLBACK_READ_ACTIONS);
    console.error(`[freebooks-mcp] WARNING: GET /api/actions failed (${err.message}); falling back to static read allowlist (${[...FALLBACK_READ_ACTIONS].join(', ')}).`);
  }
}

// ── tool result builders (spec §5: JSON text content; structured isError) ──

function okResult(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
  };
}

function errorResult(code, message) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }],
  };
}

function fromApiResult(res) {
  return res.ok ? okResult(res.data) : errorResult(res.error.code, res.error.message);
}

// ── the MCP server (low-level Server: stdio JSON-RPC 2.0) ───────────────────

const server = new Server(
  { name: 'freebooks-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    switch (name) {
      case 'event_list': {
        const params = {};
        if (args.after_seq != null) params.after_seq = args.after_seq;
        if (args.type != null) params.type = args.type;
        if (args.limit != null) params.limit = args.limit;
        const res = await callAction('event.list', params);
        return fromApiResult(res);
      }

      case 'journal_propose': {
        if (!Array.isArray(args.lines) || args.lines.length === 0) {
          return errorResult('INVALID_INPUT', 'journal_propose requires a non-empty `lines` array');
        }
        const params = { lines: args.lines };
        if (args.journalId != null) params.journalId = args.journalId;
        if (args.reference != null) params.reference = args.reference;
        if (args.description != null) params.description = args.description;
        if (args.proposalId != null) params.proposalId = args.proposalId;
        // Idempotency-Key per logical call; caller may supply one for cross-retry identity.
        const idempotencyKey = args.idempotency_key || newIdempotencyKey();
        const res = await callAction('journal.propose', params, { idempotencyKey });
        return fromApiResult(res);
      }

      case 'attachment_upload': {
        if (!args.entityType || !args.entityId || !args.filename || !args.contentBase64) {
          return errorResult('INVALID_INPUT', 'attachment_upload requires entityType, entityId, filename, contentBase64');
        }
        // Phase A hardening: travel via the `attachment.upload` action (not the
        // multipart route) so the call gets the catalog role check, idempotency,
        // and dispatch-level audit. contentType is passed only when supplied,
        // matching how the other optional params are handled.
        const params = {
          entityType: args.entityType,
          entityId: args.entityId,
          filename: args.filename,
          contentBase64: args.contentBase64,
        };
        if (args.contentType != null) params.contentType = args.contentType;
        const idempotencyKey = args.idempotency_key || newIdempotencyKey();
        const res = await callAction('attachment.upload', params, { idempotencyKey });
        return fromApiResult(res);
      }

      case 'freebooks_read': {
        const action = args.action;
        if (!action || typeof action !== 'string') {
          return errorResult('INVALID_INPUT', 'freebooks_read requires an `action` string');
        }
        if (!READ_ALLOWLIST || !READ_ALLOWLIST.has(action)) {
          return errorResult(
            'FORBIDDEN',
            `freebooks_read admits only non-mutating catalog actions; '${action}' is not on the read allowlist. ` +
              `Use journal_propose for writes, attachment_upload for files, or event_list for the event stream. ` +
              `The server-side §2.3 whitelist remains the enforcement.`
          );
        }
        const params = (args.params && typeof args.params === 'object') ? args.params : {};
        const res = await callAction(action, params);
        return fromApiResult(res);
      }

      case 'matching_history_record': {
        const params = {};
        if (args.description_pattern != null) params.description_pattern = args.description_pattern;
        if (args.source_type != null) params.source_type = args.source_type;
        if (args.outcome != null) params.outcome = args.outcome;
        if (args.bank_account != null) params.bank_account = args.bank_account;
        if (args.counterparty != null) params.counterparty = args.counterparty;
        if (args.amount != null) params.amount = args.amount;
        if (args.proposed_dimensions != null) params.proposed_dimensions = args.proposed_dimensions;
        if (args.approved_dimensions != null) params.approved_dimensions = args.approved_dimensions;
        if (args.confidence != null) params.confidence = args.confidence;
        if (args.evidence != null) params.evidence = args.evidence;
        const idempotencyKey = args.idempotency_key || newIdempotencyKey();
        const res = await callAction('matching_history.record', params, { idempotencyKey });
        return fromApiResult(res);
      }

      case 'mapping_suggest': {
        if (!args.description_pattern || !args.suggested_account) {
          return errorResult('INVALID_INPUT', 'mapping_suggest requires `description_pattern` and `suggested_account`');
        }
        const params = {
          description_pattern: args.description_pattern,
          suggested_account: args.suggested_account,
        };
        if (args.suggestionId != null) params.suggestionId = args.suggestionId;
        if (args.bank_account != null) params.bank_account = args.bank_account;
        if (args.suggested_vat_code != null) params.suggested_vat_code = args.suggested_vat_code;
        if (args.suggested_dimensions != null) params.suggested_dimensions = args.suggested_dimensions;
        if (args.evidence != null) params.evidence = args.evidence;
        if (args.source_proposal_id != null) params.source_proposal_id = args.source_proposal_id;
        const idempotencyKey = args.idempotency_key || newIdempotencyKey();
        const res = await callAction('mapping.suggest', params, { idempotencyKey });
        return fromApiResult(res);
      }

      case 'bill_create': {
        if (!args.bill || typeof args.bill !== 'object') {
          return errorResult('INVALID_INPUT', 'bill_create requires a `bill` object');
        }
        const params = { bill: args.bill };
        if (args._replaceDraftId != null) params._replaceDraftId = args._replaceDraftId;
        if (args.payment_batch_id != null) params.payment_batch_id = args.payment_batch_id;
        const idempotencyKey = args.idempotency_key || newIdempotencyKey();
        const res = await callAction('bill.create', params, { idempotencyKey });
        return fromApiResult(res);
      }

      default:
        return errorResult('UNKNOWN_TOOL', `Unknown tool: ${name}`);
    }
  } catch (err) {
    return errorResult(err.code || 'INTERNAL', err.message || 'Internal error');
  }
});

// ── boot ───────────────────────────────────────────────────────────────────

async function main() {
  if (!FREEBOOKS_USER || !FREEBOOKS_COMPANY) {
    console.error('[freebooks-mcp] FATAL: FREEBOOKS_USER and FREEBOOKS_COMPANY must be set (the agent account email and company id).');
    process.exit(1);
  }
  // Build the read allowlist before connecting so tools/list is unaffected and
  // freebooks_read refuses cleanly even if the catalog is down at first call.
  await buildReadAllowlist();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio transport keeps the process alive; log the correlated run id once.
  console.error(`[freebooks-mcp] ready — api=${API_URL} company=${FREEBOOKS_COMPANY} user=${FREEBOOKS_USER} request_id=${REQUEST_ID}`);
}

main().catch((err) => {
  console.error('[freebooks-mcp] boot failed:', err && err.stack || err);
  process.exit(1);
});
