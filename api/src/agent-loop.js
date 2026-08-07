'use strict';
/**
 * In-process agent orchestration loop (Phase B9).
 *
 * Ported from scripts/freebooks-agent-loop.js (B7). Runs inside the Express
 * server process, calls action handlers directly via the injected
 * dispatchAction function — no HTTP, no tokens, no external process.
 *
 * Multi-company: iterates all companies with agent_enabled = 'true'.
 * Sequential — one company at a time per poll tick.
 *
 * Config is read from the settings table (per-company):
 *   agent_enabled, agent_poll_interval_ms, agent_inbox_path,
 *   llm_endpoint_url, llm_api_key, llm_model, llm_temperature
 *
 * Cursor (agent_last_seq) is persisted to the settings table per-company.
 *
 * Started at boot if any company has agent_enabled = 'true'.
 * The dispatchAction function is injected by index.js to avoid circular deps.
 */

const { query, exec } = require('./db');
const { v4: uuid } = require('uuid');
const path = require('path');
const fs = require('fs');
const { normalizeDescription, detectMappingConflicts } = require('./mapping-utils');

// ── State ───────────────────────────────────────────────────────────────────

let _dispatchAction = null; // injected by index.js
let _fetchAttachmentFn = null; // injected by index.js
let _timer = null;
let _shuttingDown = false;
let _companyCursors = {}; // companyId → last event_seq (in-memory cache)

const DEFAULT_POLL_INTERVAL_MS = 30000;
const TIER4_SIZE_CAP = 18;

function ts() { return new Date().toISOString(); }
function log(...args) { console.log(`[${ts()}] [agent-loop]`, ...args); }
function warn(...args) { console.warn(`[${ts()}] [agent-loop] WARN`, ...args); }
function err(...args) { console.error(`[${ts()}] [agent-loop] ERROR`, ...args); }

// ── Settings helpers ────────────────────────────────────────────────────────

async function getCompanySettings(companyId) {
  const rows = await query(
    `SELECT key, value FROM settings WHERE company_id = @cid`, { cid: companyId }
  );
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return s;
}

async function getEnabledCompanies() {
  return query(
    `SELECT c.company_id, c.company_name
     FROM companies c
     JOIN settings s ON s.company_id = c.company_id
     WHERE s.key = 'agent_enabled' AND s.value = 'true'`
  );
}

async function getAgentAccount(companyId) {
  const rows = await query(
    `SELECT email FROM user_permissions
     WHERE company_id = @cid AND role = 'agent' LIMIT 1`,
    { cid: companyId }
  );
  return rows.length > 0 ? rows[0].email : null;
}

async function loadCursor(companyId) {
  if (_companyCursors[companyId] !== undefined) return _companyCursors[companyId];
  const rows = await query(
    `SELECT value FROM settings WHERE company_id = @cid AND key = 'agent_last_seq' LIMIT 1`,
    { cid: companyId }
  );
  const seq = rows.length > 0 && rows[0].value ? Number(rows[0].value) : 0;
  _companyCursors[companyId] = seq;
  return seq;
}

async function saveCursor(companyId, seq) {
  _companyCursors[companyId] = seq;
  const existing = await query(
    `SELECT key FROM settings WHERE company_id = @cid AND key = 'agent_last_seq' LIMIT 1`,
    { cid: companyId }
  );
  const now = new Date().toISOString();
  if (existing.length > 0) {
    await exec(
      `UPDATE settings SET value = @val, updated_at = @now WHERE company_id = @cid AND key = 'agent_last_seq'`,
      { cid: companyId, val: String(seq), now }
    );
  } else {
    const { bulkInsert } = require('./db');
    await bulkInsert('settings', [
      { company_id: companyId, key: 'agent_last_seq', value: String(seq), updated_at: now }
    ]);
  }
}

module.exports = { ts, log, warn, err, getCompanySettings, getEnabledCompanies, getAgentAccount };

// ── CSV parsing (ported from B7) ────────────────────────────────────────────

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') { continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function resolveColumns(rows, csvColumnsCfg) {
  const KNOWN = ['date', 'amount', 'description', 'counterparty', 'transaction_id', 'belopp', 'belop', 'datum', 'beskrivning', 'text', 'transaktion'];
  const lc = (s) => String(s || '').trim().toLowerCase();

  if (csvColumnsCfg) {
    const names = csvColumnsCfg.split(',').map((s) => s.trim()).filter(Boolean);
    const columns = {};
    names.forEach((n, i) => { columns[n] = i; });
    return { columns, headerRows: 0 };
  }

  if (rows.length === 0) return { columns: { date: 0, description: 1, amount: 2 }, headerRows: 0 };

  const first = rows[0].map(lc);
  const hits = first.filter((c) => KNOWN.includes(c));
  if (hits.length >= 2) {
    const columns = {};
    first.forEach((c, i) => {
      const norm = c === 'belopp' || c === 'belop' ? 'amount'
        : c === 'datum' ? 'date'
        : c === 'beskrivning' || c === 'text' || c === 'transaktion' ? 'description'
        : c;
      if (columns[norm] === undefined) columns[norm] = i;
    });
    return { columns, headerRows: 1 };
  }

  const defaultCols = { date: 0, description: 1, amount: 2 };
  if (rows[0].length >= 4) defaultCols.counterparty = 3;
  if (rows[0].length >= 5) defaultCols.transaction_id = 4;
  return { columns: defaultCols, headerRows: 0 };
}

function parseAmount(s) {
  if (s == null) return null;
  let t = String(s).trim();
  if (t === '') return null;
  t = t.replace(/\s+/g, '');
  const hasDot = t.includes('.');
  const hasComma = t.includes(',');
  if (hasDot && hasComma) {
    if (t.lastIndexOf(',') > t.lastIndexOf('.')) {
      t = t.replace(/\./g, '').replace(',', '.');
    } else {
      t = t.replace(/,/g, '');
    }
  } else if (hasComma) {
    const parts = t.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      t = parts[0] + '.' + parts[1];
    } else {
      t = t.replace(/,/g, '');
    }
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseBankStatementCsv(text, csvColumnsCfg) {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const { columns, headerRows } = resolveColumns(rows, csvColumnsCfg);
  const idx = (name, fallback) => columns[name] !== undefined ? columns[name] : fallback;
  const di = idx('date', 0), ai = idx('amount', 2), si = idx('description', 1);
  const ci = idx('counterparty', -1), ti = idx('transaction_id', -1);
  const out = [];
  for (let r = headerRows; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => String(c).trim() === '')) continue;
    const obj = {
      date: String(row[di] || '').trim(),
      amount: String(row[ai] || '').trim(),
      description: String(row[si] || '').trim(),
    };
    if (ci >= 0) obj.counterparty = String(row[ci] || '').trim();
    if (ti >= 0) obj.transaction_id = String(row[ti] || '').trim();
    out.push(obj);
  }
  return out;
}

function checkCriticalData(line) {
  if (!line.date) return { rejected: true, reason: 'missing date' };
  if (line.amount === '' || line.amount == null) return { rejected: true, reason: 'missing amount' };
  const amt = parseAmount(line.amount);
  if (amt === null) return { rejected: true, reason: 'missing amount' };
  if (!line.description && !line.counterparty) {
    return { rejected: true, reason: 'missing description and no counterparty' };
  }
  return { rejected: false };
}

module.exports.parseCsvRows = parseCsvRows;
module.exports.resolveColumns = resolveColumns;
module.exports.parseAmount = parseAmount;
module.exports.parseBankStatementCsv = parseBankStatementCsv;
module.exports.checkCriticalData = checkCriticalData;

// ── Tier 4 — LLM reasoning (OpenAI-compatible) ─────────────────────────────

function buildTier4Prompt(context) {
  const coa = (context.chartOfAccounts || [])
    .map((a) => `${a.account_code} ${a.account_name}`)
    .join('\n');
  return `You are a bookkeeping assistant for a Swedish company. Map each bank
statement line to journal entry lines using the chart of accounts below.
Return a JSON object with a "proposals" array — one object per input line.
Each proposal has: "lines" (array of {account_code, debit, credit, date,
description, vat_code?}), "source_transaction_id", "confidence" (0-1),
"evidence" (string), "reference" (optional).

Rules: debits must equal credits per proposal; use VAT codes from the chart;
if unsure, still propose with low confidence. Swedish: BANKGIRO, AUTOGIRO,
SHOPIFY are common descriptions.

Chart of accounts:
${coa}`;
}

async function tier4LLMReason(residualLines, context, companySettings) {
  const url = companySettings.llm_endpoint_url;
  if (!url) {
    warn('tier4: no llm_endpoint_url configured — residual lines skipped');
    return [];
  }

  const systemPrompt = buildTier4Prompt(context);
  const userPrompt = JSON.stringify(residualLines);
  const apiKey = companySettings.llm_api_key || '';
  const model = companySettings.llm_model || 'default';

  const response = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: parseFloat(companySettings.llm_temperature || '0.1'),
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`LLM endpoint returned HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    warn('tier4: empty response from LLM');
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    warn(`tier4: non-JSON response: ${content.slice(0, 200)}`);
    return [];
  }

  const proposals = Array.isArray(parsed.proposals) ? parsed.proposals
    : Array.isArray(parsed) ? parsed : [];

  // Validate count-in == count-out (spec §5.3)
  if (proposals.length !== residualLines.length) {
    warn(`tier4: count mismatch (in=${residualLines.length}, out=${proposals.length})`);
    // Not a hard failure — process what we got
  }

  return proposals;
}

module.exports.buildTier4Prompt = buildTier4Prompt;
module.exports.tier4LLMReason = tier4LLMReason;

// ── Bank statement processing ───────────────────────────────────────────────

async function fetchAttachment(attachmentId) {
  if (_fetchAttachmentFn) return _fetchAttachmentFn(attachmentId);
  throw new Error('fetchAttachment not initialized');
}

async function processBankStatement(ev, companyId, agentEmail, companySettings) {
  const attachmentId = ev.entity_id;
  let statementText;
  try {
    const att = await fetchAttachment(attachmentId);
    statementText = att.text;
  } catch (e) {
    err(`statement ${attachmentId}: fetch failed: ${e.message}`);
    return;
  }

  const csvColumnsCfg = companySettings.csv_columns || '';
  const lines = parseBankStatementCsv(statementText, csvColumnsCfg);
  if (lines.length === 0) {
    warn(`statement ${attachmentId}: no CSV lines parsed`);
    return;
  }
  log(`statement ${attachmentId}: ${lines.length} line(s) parsed`);

  const bankAccount = companySettings.default_bank_account || '';
  const matchedProposals = [];
  const residualLines = [];
  const rejectedLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    const cd = checkCriticalData(line);
    if (cd.rejected) {
      rejectedLines.push({ line: lineNo, reason: cd.reason,
        raw: `${line.date || ''},${line.description || ''},${line.amount || ''}` });
      continue;
    }

    let match;
    try {
      const params = { line };
      if (bankAccount) params.bankAccount = bankAccount;
      match = await _dispatchAction('bank.match', params, companyId, agentEmail);
    } catch (e) {
      err(`statement ${attachmentId} line ${lineNo}: bank.match failed: ${e.message}`);
      residualLines.push(line);
      continue;
    }

    if (match && match.matched) {
      const sourceTxId = line.transaction_id
        || `${line.date}|${line.amount}|${line.description}|${bankAccount}`;
      try {
        const proposal = await _dispatchAction('journal.propose', {
          lines: match.lines, reference: line.transaction_id || null,
          description: line.description, source_transaction_id: sourceTxId,
          _match_meta: { tier: match.tier, source_type: match.source_type,
            confidence: match.confidence, evidence: match.evidence,
            suggested_dimensions: match.suggested_dimensions },
        }, companyId, agentEmail);
        matchedProposals.push(proposal);
      } catch (e) {
        err(`statement ${attachmentId} line ${lineNo}: journal.propose failed: ${e.message}`);
        residualLines.push(line);
      }
    } else if (match && match.reason === 'duplicate') {
      log(`statement ${attachmentId} line ${lineNo}: duplicate (existing proposal ${match.existing_proposal_id})`);
    } else {
      residualLines.push(line);
    }
  }

  log(`statement ${attachmentId}: ${matchedProposals.length} matched, ${residualLines.length} residual, ${rejectedLines.length} rejected`);

  // Tier 4: one LLM call for the statement's residual
  if (residualLines.length > 0) {
    let batches;
    if (residualLines.length <= TIER4_SIZE_CAP) {
      batches = [residualLines];
    } else {
      batches = [];
      for (let i = 0; i < residualLines.length; i += TIER4_SIZE_CAP) {
        batches.push(residualLines.slice(i, i + TIER4_SIZE_CAP));
      }
      warn(`statement ${attachmentId}: residual ${residualLines.length} > cap ${TIER4_SIZE_CAP}, splitting into ${batches.length} batches`);
    }

    const context = await buildTier4Context(companyId, agentEmail);

    for (const batch of batches) {
      let proposals;
      try {
        proposals = await tier4LLMReason(batch, context, companySettings);
      } catch (e) {
        err(`statement ${attachmentId}: tier4 LLM call failed: ${e.message}`);
        continue;
      }
      if (!Array.isArray(proposals)) { warn(`statement ${attachmentId}: tier4 non-array`); continue; }
      for (const p of proposals) {
        if (!p || !Array.isArray(p.lines) || p.lines.length === 0) continue;
        try {
          await _dispatchAction('journal.propose', {
            lines: p.lines, reference: p.reference || null,
            description: p.description || null,
            source_transaction_id: p.source_transaction_id || null,
            _match_meta: { tier: 4, source_type: 'llm_semantic',
              confidence: p.confidence || null, evidence: p.evidence || null },
          }, companyId, agentEmail);
        } catch (e) {
          err(`statement ${attachmentId}: tier4 journal.propose failed: ${e.message}`);
        }
      }
    }
  }

  // Input rejections
  if (rejectedLines.length > 0) {
    const statementDate = lines.map((l) => l.date).filter(Boolean)[0]
      || new Date().toISOString().substring(0, 10);
    try {
      await _dispatchAction('input_rejection.create', {
        statement_id: attachmentId, statement_date: statementDate,
        rejected_lines: rejectedLines,
      }, companyId, agentEmail);
      log(`statement ${attachmentId}: input_rejection created for ${rejectedLines.length} line(s)`);
    } catch (e) {
      err(`statement ${attachmentId}: input_rejection.create failed: ${e.message}`);
    }
  }
}

async function buildTier4Context(companyId, agentEmail) {
  const ctx = { chartOfAccounts: [], businessProfile: null, matchingHistory: [] };
  try {
    ctx.chartOfAccounts = await _dispatchAction('freebooks_read', {
      action: 'account.list', params: {},
    }, companyId, agentEmail) || [];
  } catch (e) { warn(`tier4 context: account.list failed: ${e.message}`); }
  try {
    ctx.matchingHistory = await _dispatchAction('matching_history.query', {
      limit: 50,
    }, companyId, agentEmail) || [];
  } catch (e) { /* non-fatal */ }
  return ctx;
}

module.exports.processBankStatement = processBankStatement;
module.exports.buildTier4Context = buildTier4Context;
module.exports.fetchAttachment = fetchAttachment;

// ── Bill processing ─────────────────────────────────────────────────────────

function extractBillData(att, payload) {
  warn(`bill ${payload.filename || att.filename}: extraction not implemented — creating skeleton draft`);
  return {
    currency: null, lines: [],
    _source_attachment_id: payload.entityId || null,
    _source_filename: payload.filename || att.filename || null,
  };
}

async function processBill(ev, companyId, agentEmail, companySettings) {
  const attachmentId = ev.entity_id;
  let att;
  try {
    att = await fetchAttachment(attachmentId);
  } catch (e) {
    err(`bill ${attachmentId}: fetch failed: ${e.message}`);
    return;
  }
  const payload = { entityId: attachmentId, filename: att.filename, contentType: att.contentType };
  const bill = extractBillData(att, payload);
  if (!bill) {
    warn(`bill ${attachmentId}: extraction returned no data (skipped)`);
    return;
  }
  try {
    const result = await _dispatchAction('bill.create', { bill }, companyId, agentEmail);
    log(`bill ${attachmentId}: draft created (bill_id=${result && result.bill_id || '?'})`);
  } catch (e) {
    err(`bill ${attachmentId}: bill.create failed: ${e.message}`);
  }
}

module.exports.processBill = processBill;
module.exports.extractBillData = extractBillData;

// ── Event routing ────────────────────────────────────────────────────────────

async function processEvent(ev, companyId, agentEmail, companySettings) {
  let payload;
  try {
    payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
  } catch (e) {
    warn(`event ${ev.event_seq}: unparseable payload — skipped`);
    return;
  }
  if (!payload) { warn(`event ${ev.event_seq}: empty payload — skipped`); return; }

  const entityType = payload.entityType;
  log(`event ${ev.event_seq}: attachment.uploaded entityType=${entityType || '?'} filename=${payload.filename || '?'}`);

  switch (entityType) {
    case 'bank_statement':
      await processBankStatement(ev, companyId, agentEmail, companySettings);
      break;
    case 'bill':
      await processBill(ev, companyId, agentEmail, companySettings);
      break;
    case 'journal_proposal':
      log(`event ${ev.event_seq}: journal_proposal attachment — skipped`);
      break;
    default:
      log(`event ${ev.event_seq}: unknown entityType '${entityType}' — skipped`);
  }
}

// ── §3.2: Retrospective sweep ───────────────────────────────────────────────
// Throttled (at most once per 24h per company). Scans posted journal_proposals
// for recurring description patterns that lack a mapping rule, and calls
// mapping.suggest for each qualifying pattern. Agent-only capability — a
// journal handler sees one proposal at a time and cannot detect recurrence.
const SWEEP_INTERVAL_HOURS = 24;
const SWEEP_RECURRENCE_THRESHOLD = 3;

async function retrospectiveSweep(companyId, agentEmail, companySettings) {
  // Throttle check: skip if last sweep was less than 24h ago
  const sweepSettingRows = await query(
    `SELECT value FROM settings WHERE company_id = @cid AND key = 'last_sweep_at' LIMIT 1`,
    { cid: companyId }
  );
  if (sweepSettingRows.length > 0) {
    const lastSweep = new Date(sweepSettingRows[0].value);
    const elapsed = Date.now() - lastSweep.getTime();
    if (elapsed < SWEEP_INTERVAL_HOURS * 60 * 60 * 1000) return; // not yet
  }

  log(`company ${companyId}: starting retrospective sweep`);

  // Query posted proposals (all sources — bank import descriptions are the
  // primary target, but human-entered proposals with descriptions also benefit)
  const proposals = await query(
    `SELECT proposal_id, description, lines, date
     FROM journal_proposals
     WHERE company_id = @cid AND status = 'posted'`,
    { cid: companyId }
  );

  if (proposals.length === 0) {
    await updateSweepTimestamp(companyId);
    return;
  }

  // Normalize and group by description pattern
  const groups = {}; // pattern → [{ proposal_id, account, date }]
  for (const p of proposals) {
    if (!p.description) continue;
    const pattern = normalizeDescription(p.description);
    if (!pattern) continue;

    // Extract the posted account from the lines
    let account = null;
    try {
      const lines = JSON.parse(p.lines);
      const accounts = [...new Set(lines.map((l) => l.account_code).filter(Boolean))];
      account = accounts[0] || null;
    } catch { /* skip */ }

    if (!account) continue;

    if (!groups[pattern]) groups[pattern] = [];
    groups[pattern].push({ proposal_id: p.proposal_id, account, date: p.date });
  }

  // Filter to patterns that meet the recurrence threshold and lack a rule/suggestion
  const candidates = [];
  for (const [pattern, occurrences] of Object.entries(groups)) {
    if (occurrences.length < SWEEP_RECURRENCE_THRESHOLD) continue;

    // Check for existing active rule
    const existingRules = await query(
      `SELECT mapping_id FROM bank_mappings
       WHERE company_id = @cid AND is_active = true
         AND UPPER(pattern) = UPPER(@pattern)`,
      { cid: companyId, pattern }
    );
    if (existingRules.length > 0) continue;

    // Check for pending suggestion
    const existingSuggestions = await query(
      `SELECT suggestion_id FROM mapping_suggestions
       WHERE company_id = @cid AND status = 'proposed'
         AND UPPER(description_pattern) = UPPER(@pattern)`,
      { cid: companyId, pattern }
    );
    if (existingSuggestions.length > 0) continue;

    // Determine the modal account
    const accountCounts = {};
    for (const occ of occurrences) {
      accountCounts[occ.account] = (accountCounts[occ.account] || 0) + 1;
    }
    const sorted = Object.entries(accountCounts).sort((a, b) => b[1] - a[1]);
    const modalAccount = sorted[0][0];
    const modalCount = sorted[0][1];

    // Detect inconsistency: same pattern approved to different accounts
    const isInconsistent = sorted.length > 1;
    const inconsistencyDetail = isInconsistent
      ? sorted.map(([acct, cnt]) => `${acct} (${cnt}×)`).join(', ')
      : null;

    // Determine amount_sign from the majority direction
    // (all occurrences should have the same direction for a consistent pattern)
    const amountSign = 'any'; // let the human decide at approval

    candidates.push({
      pattern,
      modalAccount,
      modalCount,
      totalOccurrences: occurrences.length,
      isInconsistent,
      inconsistencyDetail,
      amountSign,
      sampleProposalIds: occurrences.slice(0, 5).map((o) => o.proposal_id),
      dateRange: {
        earliest: occurrences.map((o) => o.date).sort()[0],
        latest: occurrences.map((o) => o.date).sort().pop(),
      },
    });
  }

  // Create a mapping suggestion for each candidate
  let created = 0;
  for (const c of candidates) {
    const evidence = [{
      type: 'retrospective_sweep',
      description: `Based on ${c.totalOccurrences} approved transactions (${c.dateRange.earliest} to ${c.dateRange.latest})`,
      approval_count: c.modalCount,
      sample_proposal_ids: c.sampleProposalIds,
      ...(c.isInconsistent ? { inconsistency: `Approved to different accounts: ${c.inconsistencyDetail}` } : {}),
    }];

    try {
      await _dispatchAction('mapping.suggest', {
        description_pattern: c.pattern,
        suggested_account: c.modalAccount,
        suggested_amount_sign: c.amountSign,
        suggested_match_type: 'contains',
        evidence,
        source_proposal_id: c.sampleProposalIds[0],
      }, companyId, agentEmail);
      created++;
    } catch (e) {
      // CONFLICT (duplicate detected by the conflict checker) is expected if
      // a rule was created between our check and our suggest — log and skip.
      if (e.code === 'CONFLICT') {
        log(`sweep: pattern '${c.pattern}' conflict — skipped`);
      } else {
        warn(`sweep: mapping.suggest failed for '${c.pattern}': ${e.message}`);
      }
    }
  }

  await updateSweepTimestamp(companyId);
  log(`company ${companyId}: retrospective sweep done — ${created} suggestion(s) created from ${candidates.length} candidate(s)`);
}

async function updateSweepTimestamp(companyId) {
  const now = new Date().toISOString();
  const existing = await query(
    `SELECT key FROM settings WHERE company_id = @cid AND key = 'last_sweep_at' LIMIT 1`,
    { cid: companyId }
  );
  if (existing.length > 0) {
    await exec(
      `UPDATE settings SET value = @val, updated_at = @now WHERE company_id = @cid AND key = 'last_sweep_at'`,
      { cid: companyId, val: now, now }
    );
  } else {
    const { bulkInsert } = require('./db');
    await bulkInsert('settings', [
      { company_id: companyId, key: 'last_sweep_at', value: now, updated_at: now }
    ]);
  }
}

async function pollCompanyOnce(companyId, agentEmail, companySettings) {
  const lastSeq = await loadCursor(companyId);
  let events;
  try {
    events = await _dispatchAction('event.list', {
      after_seq: lastSeq, type: 'attachment.uploaded', limit: 100,
    }, companyId, agentEmail);
  } catch (e) {
    err(`company ${companyId}: event.list failed: ${e.message}`);
    return 0;
  }

  for (const ev of events) {
    if (Number(ev.event_seq) > (_companyCursors[companyId] || 0)) {
      _companyCursors[companyId] = Number(ev.event_seq);
    }
    try {
      await processEvent(ev, companyId, agentEmail, companySettings);
    } catch (e) {
      err(`event ${ev.event_seq}: unhandled error: ${e.message}`);
    }
    if (_shuttingDown) break;
  }

  await saveCursor(companyId, _companyCursors[companyId] || lastSeq);

  // ── §3.2: Retrospective sweep (throttled, at most once per 24h) ──────────
  // Scans posted journal_proposals for recurring patterns that lack a mapping
  // rule, and calls mapping.suggest for each. Agent-only capability — a
  // journal handler sees one proposal at a time and cannot detect recurrence.
  if (!_shuttingDown) {
    try {
      await retrospectiveSweep(companyId, agentEmail, companySettings);
    } catch (e) {
      err(`company ${companyId}: retrospective sweep failed: ${e.message}`);
    }
  }

  return events.length;
}

async function pollOnce() {
  let companies;
  try {
    companies = await getEnabledCompanies();
  } catch (e) {
    err(`could not list enabled companies: ${e.message}`);
    return;
  }
  if (companies.length === 0) return;

  for (const { company_id: companyId } of companies) {
    if (_shuttingDown) break;
    const agentEmail = await getAgentAccount(companyId);
    if (!agentEmail) {
      warn(`company ${companyId}: agent_enabled but no agent-role account — skipping`);
      continue;
    }
    const companySettings = await getCompanySettings(companyId);
    try {
      await pollCompanyOnce(companyId, agentEmail, companySettings);
    } catch (e) {
      err(`company ${companyId}: poll error: ${e.message}`);
    }
  }
}

// ── Start / stop ────────────────────────────────────────────────────────────

/**
 * Start the agent loop. dispatchAction and fetchAttachmentFn are injected
 * by index.js to avoid circular dependencies.
 *
 * @param {function} dispatchAction — async (action, params, companyId, agentEmail) => result
 * @param {function} fetchAttachmentFn — async (attachmentId) => { contentType, filename, text, buffer }
 */
function startAgentLoop(dispatchAction, fetchAttachmentFn) {
  if (_timer) { warn('already running'); return; }
  _dispatchAction = dispatchAction;
  _fetchAttachmentFn = fetchAttachmentFn;
  _shuttingDown = false;

  // Read poll interval from first enabled company, or default
  getEnabledCompanies().then(async (companies) => {
    let intervalMs = DEFAULT_POLL_INTERVAL_MS;
    if (companies.length > 0) {
      const s = await getCompanySettings(companies[0].company_id);
      const val = Number(s.agent_poll_interval_ms);
      if (val > 0) intervalMs = Math.floor(val);
    }

    // Run an immediate poll on startup
    pollOnce().catch((e) => err(`startup poll failed: ${e.message}`));

    _timer = setInterval(() => {
      pollOnce().catch((e) => err(`poll cycle failed: ${e.message}`));
    }, intervalMs);
    _timer.unref();

    log(`started (interval=${intervalMs}ms, companies=${companies.length})`);
  }).catch((e) => {
    err(`could not start agent loop: ${e.message}`);
  });
}

function stopAgentLoop() {
  _shuttingDown = true;
  if (_timer) { clearInterval(_timer); _timer = null; }
  log('stopped');
}

function getStatus() {
  return { running: !!_timer, cursors: { ..._companyCursors } };
}

module.exports.startAgentLoop = startAgentLoop;
module.exports.stopAgentLoop = stopAgentLoop;
module.exports.getStatus = getStatus;
module.exports.pollOnce = pollOnce;
module.exports.processEvent = processEvent;
module.exports.pollCompanyOnce = pollCompanyOnce;
module.exports.retrospectiveSweep = retrospectiveSweep;
