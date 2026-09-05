'use strict';
/**
 * freeBooks — Chat with AI (docs/chat-with-ai-spec.md)
 *
 * A turn is two LLM calls (category selection, then answer) with a possible
 * human-consent pause in between (§2). No company data reaches the LLM
 * endpoint until a human has cleared the category it came from (§2b) — the
 * fixed catalog below (§2a) is the only data this module will ever fetch on
 * the LLM's behalf; there is no path from an LLM response to arbitrary SQL.
 */

const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert } = require('./db');

// ── §2a: the category catalog ────────────────────────────────────────────
// Fixed and code-defined. The LLM only ever selects from these names in its
// Call-1 response (§2 step 2) — an unrecognized name is silently dropped,
// never fetched, never forwarded. Adding a category is a code change.
const CATEGORY_CATALOG = {
  coa: { label: 'Chart of accounts' },
  journal_entries: { label: 'Posted journal entries (filterable by account/date/description)' },
  bills: { label: 'Bills — vendor, amount, status, due date' },
  bank_unmatched: { label: 'Uncleared / unmatched bank lines' },
  pl_summary: { label: 'Profit & loss summary for a period' },
  bs_summary: { label: 'Balance sheet summary as of a date' },
  inbox_summary: { label: 'Count of items awaiting review in the Inbox' },
  agent_status: { label: 'Whether the agent loop / feed watcher is running' },
  ai_connection: { label: 'Whether the configured LLM endpoint is reachable' },
};

// §2a note: agent_status/ai_connection carry no company financial data —
// exempt from the §2b consent gate entirely.
const EXEMPT_CATEGORIES = new Set(['agent_status', 'ai_connection']);

// §3: categories whose rows carry a structured identifier (partner_name)
// eligible for the aliasing checkbox (§2c/§3.2). Free text (description,
// reference) is never aliased regardless — §0/§3.4, permanent non-goal.
const CATEGORY_ALIASABLE = new Set(['bills']);

const VALID_DECISIONS = new Set(['approve_once', 'allow_always', 'deny_once', 'deny_never']);

// §7.4: abandoned pending turns are swept on a short clock — nothing
// ledger-relevant is at stake, this is just working-state cleanup (mirrors
// the A4 attachment-GC boot+setInterval pattern, agent-readiness-spec §4.7).
const PENDING_TURN_TTL_MS = 2 * 60 * 60 * 1000; // 2h

async function handleChat(ctx, action) {
  switch (action) {
    case 'chat.send': return sendMessage(ctx);
    case 'chat.permission.decide': return decidePermission(ctx);
    case 'chat.permissions.list': return listPermissions(ctx);
    case 'chat.permissions.revoke': return revokePermission(ctx);
    case 'chat.history.list': return listHistory(ctx);
    default:
      throw Object.assign(new Error(`Unknown chat action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

// ── Settings (local copy — index.js's settingsMap is a closure, not exported) ──
async function settingsMap(companyId) {
  const rows = await query(`SELECT key, value FROM settings WHERE company_id = @companyId`, { companyId });
  const m = {};
  for (const r of rows) m[r.key] = r.value;
  return m;
}

function nowIso() { return new Date().toISOString(); }
function todayStr() { return nowIso().slice(0, 10); }

// ── LLM call (JSON-mode, matches agent-loop.js's tier4LLMReason exactly —
// §0 non-goal: no tool-calling protocol, plain chat completions only) ──────
async function llmCompletion(settings, systemPrompt, userPrompt) {
  const url = settings.llm_endpoint_url;
  if (!url) throw new Error('No LLM endpoint configured (Settings → AI)');
  const apiKey = settings.llm_api_key || '';
  const model = settings.llm_model || 'default';

  const response = await fetch(`${url.replace(/\/v1\/?$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: parseFloat(settings.llm_temperature || '0.1'),
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`LLM endpoint returned HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = await response.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('Empty response from LLM');
  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error('LLM returned invalid JSON');
  }
}

function buildCategorySelectionPrompt() {
  const lines = Object.entries(CATEGORY_CATALOG).map(([name, meta]) => `- ${name}: ${meta.label}`).join('\n');
  return `You are a bookkeeping assistant for a small company's accounting software (freeBooks). Given the user's message, decide which of the following data categories you need to answer it, or to draft a journal entry / bill if asked. Return ONLY a JSON object: {"categories": ["cat1", "cat2"]}. Use only exact names from this list:\n${lines}\n\nIf the user is asking to book/record/draft a transaction, always include "coa" — you need real account codes to draft anything.`;
}

function buildAnswerPrompt(dataByCategory, deniedCategories) {
  let ctx = '';
  for (const [cat, rows] of Object.entries(dataByCategory)) {
    ctx += `\n\n### ${cat}\n${JSON.stringify(rows)}`;
  }
  const deniedNote = deniedCategories.length
    ? `\n\nThe human has withheld access to: ${deniedCategories.join(', ')}. If you would need this to fully answer, say so plainly rather than guessing.`
    : '';
  return `You are a bookkeeping assistant for a small company using freeBooks. Answer the user's question using ONLY the data provided below — never invent figures. If the user asked you to record/book/draft a transaction and you have enough information (including a real account code from the coa data), include a "propose" object; otherwise propose is null.

Return ONLY a JSON object of this exact shape:
{"reply": "plain-text answer", "propose": null | {"type":"journal","lines":[{"account_code":"...","debit":0,"credit":0,"description":"..."}],"reference":"...","description":"..."} | {"type":"bill","bill":{"partner_name":"...","date":"YYYY-MM-DD","due_date":"YYYY-MM-DD","amount":0,"currency":"...","expense_account":"...","ap_account":"...","vat_code":null,"description":"..."}}}

For a journal propose, debits must equal credits across the lines. Only use account codes present in the coa data.${deniedNote}

Data:${ctx}`;
}

function formatStatusReply(statusData) {
  const parts = [];
  if (statusData.agent_status) {
    const s = statusData.agent_status;
    parts.push(`Agent: ${s.agent_running ? 'Running' : 'Stopped'}`);
    if (s.feed_watcher) parts.push(`Feed watcher: ${s.feed_watcher.running ? 'Running' : 'Stopped'}`);
  }
  if (statusData.ai_connection) {
    parts.push(`LLM: ${statusData.ai_connection.ok ? 'Reachable' : `Unreachable (${statusData.ai_connection.error || 'unknown error'})`}`);
  }
  return parts.join(' · ') || 'No status information available.';
}

// ── §2a: category fetchers — every one is a pre-written, company-scoped,
// parameterized read. `filters` (journal_entries only) is validated by
// shape/type before use, never string-interpolated into SQL (§2a). ────────
async function fetchCategoryData(category, companyId, filters) {
  filters = filters || {};
  switch (category) {
    case 'coa':
      return query(
        `SELECT account_code, account_name, account_type FROM accounts
         WHERE company_id = @companyId AND is_active = TRUE ORDER BY account_code`,
        { companyId }
      );

    case 'journal_entries': {
      const account = typeof filters.account === 'string' ? filters.account : null;
      const fromDate = typeof filters.from_date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(filters.from_date) ? filters.from_date : null;
      const toDate = typeof filters.to_date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(filters.to_date) ? filters.to_date : null;
      const descContains = typeof filters.description_contains === 'string' ? filters.description_contains : null;

      let where = ' WHERE je.company_id = @companyId';
      const params = { companyId };
      if (account) { where += ' AND je.account_code = @account'; params.account = account; }
      if (fromDate) { where += ' AND je.date >= @fromDate'; params.fromDate = fromDate; }
      if (toDate) { where += ' AND je.date <= @toDate'; params.toDate = toDate; }
      if (descContains) { where += ' AND je.description ILIKE @descContains'; params.descContains = `%${descContains}%`; }

      const CAP = 200;
      const countRow = await query(`SELECT COUNT(*) AS n FROM journal_entries je` + where, params);
      const total = Number(countRow[0].n);
      if (total > CAP) return { tooMany: true, total };

      return query(
        `SELECT je.batch_id, je.date, je.account_code, je.debit, je.credit, je.description, je.reference
         FROM journal_entries je${where} ORDER BY je.date DESC LIMIT ${CAP}`,
        params
      );
    }

    case 'bills':
      return query(
        `SELECT bill_id, partner_name, amount, currency, status, due_date
         FROM bills WHERE company_id = @companyId ORDER BY due_date DESC LIMIT 200`,
        { companyId }
      );

    case 'bank_unmatched':
      // Mirrors bank.js's listAllUncleared (not exported — re-implemented
      // read-only here rather than reaching into that module's internals).
      return query(
        `SELECT je.batch_id, je.date, je.reference, je.description, a.account_code, a.account_name,
                SUM(je.debit) AS debit, SUM(je.credit) AS credit
         FROM journal_entries je
         JOIN accounts a ON a.account_code = je.account_code AND a.company_id = je.company_id
         LEFT JOIN reconciliations r
           ON r.company_id = je.company_id AND r.batch_id = je.batch_id AND r.account_code = je.account_code
         WHERE je.company_id = @companyId AND a.cf_category = 'Cash' AND r.batch_id IS NULL
         GROUP BY je.batch_id, je.date, je.reference, je.description, a.account_code, a.account_name
         ORDER BY je.date DESC LIMIT 200`,
        { companyId }
      );

    case 'pl_summary': {
      const start = (typeof filters.from_date === 'string' && filters.from_date) || `${todayStr().slice(0, 4)}-01-01`;
      const end = (typeof filters.to_date === 'string' && filters.to_date) || todayStr();
      return query(`SELECT * FROM pl(?, ?, ?)`, [companyId, start, end]);
    }

    case 'bs_summary': {
      const asOf = (typeof filters.as_of === 'string' && filters.as_of) || todayStr();
      return query(`SELECT * FROM bs(?, ?)`, [companyId, asOf]);
    }

    case 'inbox_summary': {
      const { handleInbox } = require('./inbox');
      const res = await handleInbox({ companyId, body: { status: 'proposed', limit: 100 } }, 'inbox.list');
      const items = (res && res.items) || [];
      return { proposed_count: items.length };
    }

    case 'agent_status': {
      const { feedWatcher, agentLoop } = require('./boot-state');
      return {
        agent_running: (agentLoop && agentLoop.getStatus && agentLoop.getStatus().running) || false,
        feed_watcher: (feedWatcher && feedWatcher.getStatus && feedWatcher.getStatus()) || null,
      };
    }

    case 'ai_connection': {
      const settings = await settingsMap(companyId);
      const url = settings.llm_endpoint_url;
      if (!url) return { ok: false, error: 'No LLM endpoint URL configured' };
      const apiKey = settings.llm_api_key || '';
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      try {
        const resp = await fetch(`${url.replace(/\/v1\/?$/, '')}/v1/models`, {
          method: 'GET',
          headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          signal: ctrl.signal,
        });
        return resp.ok ? { ok: true } : { ok: false, error: `HTTP ${resp.status}` };
      } catch (e) {
        return { ok: false, error: e && e.name === 'AbortError' ? 'timed out' : (e && e.message) || String(e) };
      } finally {
        clearTimeout(timer);
      }
    }

    default:
      return null;
  }
}

// ── §3: structured-identifier aliasing (bills.partner_name only — §3.1) ────
async function getOrCreateAlias(companyId, entityType, realValue) {
  const existing = await query(
    `SELECT alias FROM chat_aliases WHERE company_id = @companyId AND entity_type = @entityType AND real_value = @realValue LIMIT 1`,
    { companyId, entityType, realValue }
  );
  if (existing.length) return existing[0].alias;

  const countRow = await query(
    `SELECT COUNT(*) AS n FROM chat_aliases WHERE company_id = @companyId AND entity_type = @entityType`,
    { companyId, entityType }
  );
  const n = Number(countRow[0].n) + 1;
  const alias = (entityType === 'company' ? 'Company_' : 'Vendor_') + n;
  await bulkInsert('chat_aliases', [{ company_id: companyId, real_value: realValue, alias, entity_type: entityType, created_at: nowIso() }]);
  return alias;
}

async function resolveAlias(companyId, alias) {
  const rows = await query(
    `SELECT real_value FROM chat_aliases WHERE company_id = @companyId AND alias = @alias LIMIT 1`,
    { companyId, alias }
  );
  return rows.length ? rows[0].real_value : null;
}

async function applyAliasing(companyId, category, rows) {
  if (!CATEGORY_ALIASABLE.has(category) || !Array.isArray(rows)) return rows;
  const out = [];
  for (const row of rows) {
    const r = { ...row };
    if (r.partner_name) r.partner_name = await getOrCreateAlias(companyId, 'partner', r.partner_name);
    out.push(r);
  }
  return out;
}

// ── chat.send ────────────────────────────────────────────────────────────
async function sendMessage(ctx) {
  const { companyId, userEmail, body } = ctx;
  const { message, turnId } = body;
  const settings = await settingsMap(companyId);

  let selection;
  try {
    selection = await llmCompletion(settings, buildCategorySelectionPrompt(), message);
  } catch (e) {
    return writeErrorTurn(companyId, userEmail, message, `Couldn't reach the configured LLM endpoint: ${e.message}`);
  }
  const requested = Array.isArray(selection.categories)
    ? [...new Set(selection.categories.filter((c) => CATEGORY_CATALOG[c]))]
    : [];

  // §2 step 2 short-circuit: only consent-exempt categories → answer from a
  // template, skip Call 2 entirely (no second LLM call for a boolean).
  if (requested.length > 0 && requested.every((c) => EXEMPT_CATEGORIES.has(c))) {
    const statusData = {};
    for (const c of requested) statusData[c] = await fetchCategoryData(c, companyId, {});
    const replyText = formatStatusReply(statusData);
    await bulkInsert('chat_messages', [
      { company_id: companyId, message_id: uuid(), role: 'user', content: message, proposal_ref: null, created_by: userEmail || 'user', created_at: nowIso() },
      { company_id: companyId, message_id: uuid(), role: 'assistant', content: replyText, proposal_ref: null, created_by: 'assistant', created_at: nowIso() },
    ]);
    return { reply: replyText, proposalRef: null };
  }

  const permRows = await query(`SELECT category, decision, aliased FROM chat_data_permissions WHERE company_id = @companyId`, { companyId });
  const permMap = {};
  for (const r of permRows) permMap[r.category] = r;

  const resolved = {};
  const pending = [];
  for (const cat of requested) {
    if (EXEMPT_CATEGORIES.has(cat)) { resolved[cat] = { decision: 'approve_once', aliased: false }; continue; }
    const p = permMap[cat];
    if (p && p.decision === 'allow_always') resolved[cat] = { decision: 'allow_always', aliased: !!p.aliased };
    else if (p && p.decision === 'deny_always') resolved[cat] = { decision: 'deny_never', aliased: false };
    else pending.push(cat);
  }

  if (pending.length === 0) {
    return completeTurn(ctx, { turn_id: turnId, user_message: message }, resolved);
  }

  // §2 step 3: fetch pending categories for LOCAL PREVIEW ONLY — this data
  // returns to the client in this response and is never persisted (§2b) or
  // sent to the LLM until a human approves it via chat.permission.decide.
  const previewPayload = [];
  for (const cat of pending) {
    const raw = await fetchCategoryData(cat, companyId, {});
    const aliasable = CATEGORY_ALIASABLE.has(cat);
    const dataAliased = aliasable ? await applyAliasing(companyId, cat, raw) : null;
    previewPayload.push({ category: cat, label: CATEGORY_CATALOG[cat].label, aliasable, data: raw, dataAliased });
  }

  await bulkInsert('chat_pending_turns', [{
    company_id: companyId,
    turn_id: turnId,
    user_message: message,
    pending_categories: JSON.stringify(pending),
    resolved_categories: JSON.stringify(resolved),
    created_at: nowIso(),
  }]);

  return { status: 'pending_permission', turnId, pending: previewPayload };
}

// ── chat.permission.decide ──────────────────────────────────────────────
async function decidePermission(ctx) {
  const { companyId, userEmail, body } = ctx;
  const { turnId, category, decision } = body;
  const aliased = !!body.aliased;

  if (!CATEGORY_CATALOG[category]) throw Object.assign(new Error('Unknown category'), { code: 'INVALID_INPUT' });
  if (!VALID_DECISIONS.has(decision)) throw Object.assign(new Error('Invalid decision'), { code: 'INVALID_INPUT' });

  const rows = await query(`SELECT * FROM chat_pending_turns WHERE company_id = @companyId AND turn_id = @turnId LIMIT 1`, { companyId, turnId });
  if (!rows.length) throw Object.assign(new Error('Pending turn not found — it may have expired'), { code: 'NOT_FOUND' });
  const turn = rows[0];

  const pendingCats = JSON.parse(turn.pending_categories || '[]');
  if (!pendingCats.includes(category)) throw Object.assign(new Error('Category is not pending for this turn'), { code: 'INVALID_INPUT' });

  // §2b: allow_always/deny_never persist; approve_once/deny_once affect only this turn.
  if (decision === 'allow_always' || decision === 'deny_never') {
    await exec(`DELETE FROM chat_data_permissions WHERE company_id = @companyId AND category = @category`, { companyId, category });
    await bulkInsert('chat_data_permissions', [{
      company_id: companyId, category,
      decision: decision === 'allow_always' ? 'allow_always' : 'deny_always',
      aliased, decided_by: userEmail || 'user', decided_at: nowIso(),
    }]);
  }

  const resolved = JSON.parse(turn.resolved_categories || '{}');
  resolved[category] = { decision, aliased };
  const remaining = pendingCats.filter((c) => !(c in resolved));

  if (remaining.length > 0) {
    await exec(
      `UPDATE chat_pending_turns SET resolved_categories = @rc WHERE company_id = @companyId AND turn_id = @turnId`,
      { companyId, turnId, rc: JSON.stringify(resolved) }
    );
    return { status: 'pending_permission', turnId, remaining };
  }

  return completeTurn(ctx, turn, resolved);
}

// ── Finish a turn: fetch approved data fresh, Call 2, propose (if any),
// write chat_messages, drop the pending-turn row (§2 steps 6-10). ─────────
async function completeTurn(ctx, turn, resolved) {
  const { companyId, userEmail } = ctx;
  const settings = await settingsMap(companyId);

  const deniedCategories = [];
  const dataByCategory = {};
  for (const [cat, info] of Object.entries(resolved)) {
    if (info.decision === 'deny_once' || info.decision === 'deny_never') { deniedCategories.push(cat); continue; }
    let rows = await fetchCategoryData(cat, companyId, {});
    if (info.aliased) rows = await applyAliasing(companyId, cat, rows);
    dataByCategory[cat] = rows;
  }

  let answer;
  try {
    answer = await llmCompletion(settings, buildAnswerPrompt(dataByCategory, deniedCategories), turn.user_message);
  } catch (e) {
    if (turn.turn_id) await exec(`DELETE FROM chat_pending_turns WHERE company_id = @companyId AND turn_id = @turnId`, { companyId, turnId: turn.turn_id });
    return writeErrorTurn(companyId, userEmail, turn.user_message, `Couldn't reach the configured LLM endpoint: ${e.message}`);
  }

  let proposalRef = null;
  let replyText = answer.reply || '';
  if (answer.propose) {
    try {
      const result = await executePropose(ctx, companyId, answer.propose);
      proposalRef = result.ref;
      replyText += result.note;
    } catch (e) {
      replyText += `\n\n(Tried to draft this, but it failed: ${e.message})`;
    }
  }

  await bulkInsert('chat_messages', [
    { company_id: companyId, message_id: uuid(), role: 'user', content: turn.user_message, proposal_ref: null, created_by: userEmail || 'user', created_at: nowIso() },
    { company_id: companyId, message_id: uuid(), role: 'assistant', content: replyText, proposal_ref: proposalRef, created_by: 'assistant', created_at: nowIso() },
  ]);
  if (turn.turn_id) await exec(`DELETE FROM chat_pending_turns WHERE company_id = @companyId AND turn_id = @turnId`, { companyId, turnId: turn.turn_id });

  return { reply: replyText, proposalRef };
}

// ── §2 step 7: draft into the EXISTING propose/approve queue, as the
// logged-in human — never a synthetic agent identity, never a direct post.
// Relies on chat.send's own role floor (data_entry, ≥ journal.propose's
// agent/1.5 floor) to satisfy the role check inside handleJournal/handleBills
// — those handlers are called in-process here, not through another /api
// round trip, so they do not re-check ACTION_ROLES for 'journal.propose'/
// 'bill.draft.save' themselves. If chat.send's role floor is ever lowered
// below data_entry, this call must be re-guarded explicitly. ──────────────
async function executePropose(ctx, companyId, propose) {
  if (propose.type === 'journal') {
    const proposeCtx = { ...ctx, body: { lines: propose.lines, reference: propose.reference, description: propose.description } };
    const { handleJournal } = require('./journal');
    const result = await handleJournal(proposeCtx, 'journal.propose');
    return { ref: result.proposalId, note: `\n\nDrafted a journal proposal — it's in your Inbox for approval.` };
  }
  if (propose.type === 'bill') {
    const bill = { ...propose.bill };
    // §3.3: de-alias before it ever reaches a real table — hard invariant,
    // not best-effort. An unresolvable alias-shaped value fails the propose
    // rather than silently writing the alias string into the ledger.
    if (bill.partner_name) {
      const real = await resolveAlias(companyId, bill.partner_name);
      if (real) {
        bill.partner_name = real;
      } else if (/^Vendor_\d+$/.test(bill.partner_name)) {
        throw Object.assign(new Error('Alias did not resolve to a real partner'), { code: 'INTERNAL' });
      }
    }
    const proposeCtx = { ...ctx, body: { bill } };
    const { handleBills } = require('./bills');
    const result = await handleBills(proposeCtx, 'bill.draft.save');
    return { ref: result.billId, note: `\n\nDrafted a bill for ${bill.partner_name || 'the vendor'} — it's in your Inbox for approval.` };
  }
  throw new Error(`Unknown propose type: ${propose.type}`);
}

// ── §2 step 9: LLM unreachable — visible in history, not a silent drop ────
async function writeErrorTurn(companyId, userEmail, message, errorText) {
  await bulkInsert('chat_messages', [
    { company_id: companyId, message_id: uuid(), role: 'user', content: message, proposal_ref: null, created_by: userEmail || 'user', created_at: nowIso() },
    { company_id: companyId, message_id: uuid(), role: 'assistant', content: errorText, proposal_ref: null, created_by: 'assistant', created_at: nowIso() },
  ]);
  return { reply: errorText, proposalRef: null, error: true };
}

// ── chat.permissions.list — the revoke/audit surface (§2b) ────────────────
async function listPermissions(ctx) {
  const { companyId } = ctx;
  const rows = await query(
    `SELECT category, decision, aliased, decided_by, decided_at FROM chat_data_permissions WHERE company_id = @companyId ORDER BY decided_at DESC`,
    { companyId }
  );
  return { permissions: rows };
}

// ── chat.permissions.revoke — deletes a standing decision so the category
// prompts again next time it's needed (§2b: "fixable without a database
// edit"). ───────────────────────────────────────────────────────────────
async function revokePermission(ctx) {
  const { companyId, body } = ctx;
  const { category } = body;
  if (!CATEGORY_CATALOG[category]) throw Object.assign(new Error('Unknown category'), { code: 'INVALID_INPUT' });
  await exec(`DELETE FROM chat_data_permissions WHERE company_id = @companyId AND category = @category`, { companyId, category });
  return { revoked: true, category };
}

// ── chat.history.list ───────────────────────────────────────────────────
async function listHistory(ctx) {
  const { companyId, body } = ctx;
  const rawLimit = Number(body.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 100;
  const rows = await query(
    `SELECT message_id, role, content, proposal_ref, created_by, created_at
     FROM chat_messages WHERE company_id = @companyId ORDER BY created_at ASC LIMIT @limit`,
    { companyId, limit }
  );
  return { messages: rows };
}

// ── §2b/§7.4: sweep abandoned pending turns (boot + setInterval, wired in
// index.js exactly like the A4 attachment GC). ────────────────────────────
async function gcPendingTurns() {
  const cutoff = new Date(Date.now() - PENDING_TURN_TTL_MS).toISOString();
  await exec(`DELETE FROM chat_pending_turns WHERE created_at < @cutoff`, { cutoff });
}

module.exports = {
  handleChat,
  gcPendingTurns,
  // exported for tests only — not part of the action surface
  _internal: { fetchCategoryData, CATEGORY_CATALOG, EXEMPT_CATEGORIES, CATEGORY_ALIASABLE, getOrCreateAlias, resolveAlias, applyAliasing },
};
