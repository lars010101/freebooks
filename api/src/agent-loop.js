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
const { normalizeDescription, detectMappingConflicts, findFuzzyMatch, trigramSimilarity } = require('./mapping-utils');

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
  const s = await getCompanySettings(companyId);
  if (s.agent_pipeline_email) {
    const [row] = await query(
      `SELECT 1 FROM user_permissions
       WHERE (company_id = @cid OR company_id = '*') AND role = 'agent' AND email = @email LIMIT 1`,
      { cid: companyId, email: s.agent_pipeline_email }
    );
    if (row) return s.agent_pipeline_email;
    warn(`company ${companyId}: configured agent_pipeline_email (${s.agent_pipeline_email}) no longer has the agent role`);
    return null; // fail closed, don't fall back to guessing among the rest
  }
  // Not configured: the common zero-setup case is exactly one agent-role account —
  // keep that working with no config needed. 0 or 2+ candidates without an explicit
  // choice is refused rather than guessed at.
  const candidates = await query(
    `SELECT DISTINCT email FROM user_permissions
     WHERE (company_id = @cid OR company_id = '*') AND role = 'agent'`, { cid: companyId }
  );
  if (candidates.length === 1) return candidates[0].email;
  if (candidates.length > 1) warn(`company ${companyId}: ${candidates.length} agent-role accounts and no agent_pipeline_email configured — set one in Settings → AI`);
  return null;
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
  // Auto-detect delimiter: Swedish/European Excel exports use semicolons,
  // English exports use commas. Count which is more common in the first
  // non-empty line and use that as the delimiter for the whole file.
  const sampleLine = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const semiCount = (sampleLine.match(/;/g) || []).length;
  const commaCount = (sampleLine.match(/,/g) || []).length;
  const delimiter = semiCount > commaCount ? ';' : ',';

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
    if (c === delimiter) { row.push(field); field = ''; continue; }
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

/**
 * Detect Swedish bank-statement metadata rows that are not transactions:
 * the company-name header row, opening balance ("Ingående saldo …"), and
 * closing balance ("Utgående saldo …"). These land in the parsed line set
 * when the CSV has no header row (resolveColumns returns headerRows=0) and
 * would otherwise fail checkCriticalData and become rejected lines, which
 * then breaks input_rejection.create (the company name ends up as the date).
 *
 * A row is metadata when its date column is not a valid YYYY-MM-DD date AND
 * either the description contains "saldo" or the date column holds a
 * company-name-like value (contains letters rather than being empty/numeric).
 */
function isMetadataRow(line) {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (dateRe.test(line.date || '')) return false;
  const desc = (line.description || '').toLowerCase();
  if (desc.includes('saldo')) return true;
  // Date column holds a company name (letters) instead of a date.
  if ((line.date || '').trim() && /[a-zåäö]/i.test(line.date)) return true;
  return false;
}

module.exports.parseCsvRows = parseCsvRows;
module.exports.resolveColumns = resolveColumns;
module.exports.parseAmount = parseAmount;
module.exports.parseBankStatementCsv = parseBankStatementCsv;
module.exports.checkCriticalData = checkCriticalData;
module.exports.isMetadataRow = isMetadataRow;

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

  const response = await fetch(`${url.replace(/\/v1\/?$/, '')}/v1/chat/completions`, {
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

/**
 * Partner-proposal-spec §6: shared helper for both trigger points (tier-4
 * residual + bill.create). Checks for existing partner + pending proposal,
 * and if neither exists, calls partner.propose. Best-effort — all failures
 * are caught and logged, never propagated.
 */
async function _maybeProposePartner({ companyId, agentEmail, name, default_expense_account,
  suggested_vat_code, source_proposal_id, source_bill_id, source_description, evidence }) {
  if (!name || !name.trim()) return; // no counterparty name to propose
  name = name.trim();

  // Check 1: existing partner by name (case-insensitive, is_vendor=TRUE)
  const existingPartner = await query(
    `SELECT partner_id FROM partners
     WHERE company_id = @cid AND LOWER(name) = LOWER(@name) AND is_vendor = TRUE
     LIMIT 1`,
    { cid: companyId, name }
  );
  if (existingPartner.length > 0) return; // partner already exists
  // Check 1b: fuzzy match against existing vendor partners (issue #130)
  const allVendorPartners = await query(
    `SELECT name FROM partners
     WHERE company_id = @cid AND is_vendor = TRUE`,
    { cid: companyId }
  );
  const fuzzyPartner = findFuzzyMatch(name, allVendorPartners, 0.65);
  if (fuzzyPartner) {
    warn(`_maybeProposePartner: skipping '${name}' — similar existing partner '${fuzzyPartner.candidate.name}' (similarity: ${fuzzyPartner.similarity.toFixed(2)})`);
    return;
  }

  // Check 2: pending proposal by name
  const existingProposal = await query(
    `SELECT proposal_id FROM partner_proposals
     WHERE company_id = @cid AND LOWER(name) = LOWER(@name) AND status = 'proposed'
     LIMIT 1`,
    { cid: companyId, name }
  );
  if (existingProposal.length > 0) return; // pending proposal already exists
  // Check 2b: fuzzy match against pending proposals (issue #130)
  const allPendingProposals = await query(
    `SELECT name FROM partner_proposals
     WHERE company_id = @cid AND status = 'proposed'`,
    { cid: companyId }
  );
  const fuzzyProposal = findFuzzyMatch(name, allPendingProposals, 0.65);
  if (fuzzyProposal) {
    warn(`_maybeProposePartner: skipping '${name}' — similar pending proposal '${fuzzyProposal.candidate.name}' (similarity: ${fuzzyProposal.similarity.toFixed(2)})`);
    return;
  }

  // Get company default AP account
  let defaultApAccount = null;
  try {
    const apRows = await query(
      `SELECT account_code FROM accounts
       WHERE company_id = @cid AND default_role = 'AP' AND is_active = true
       LIMIT 1`,
      { cid: companyId }
    );
    if (apRows.length > 0) defaultApAccount = apRows[0].account_code;
  } catch (e) { /* non-fatal */ }

  const params = {
    name,
    evidence: evidence || [{ type: 'agent_loop', description: 'Auto-proposed from agent loop' }],
  };
  if (default_expense_account) params.default_expense_account = default_expense_account;
  if (defaultApAccount) params.default_ap_account = defaultApAccount;
  if (suggested_vat_code) params.suggested_vat_code = suggested_vat_code;
  if (source_proposal_id) params.source_proposal_id = source_proposal_id;
  if (source_bill_id) params.source_bill_id = source_bill_id;
  if (source_description) params.source_description = source_description;

  await _dispatchAction('partner.propose', params, companyId, agentEmail);
  log(`partner.propose: proposed new partner '${name}'`);
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

    // Skip Swedish bank-statement metadata rows (company-name header,
    // "Ingående saldo", "Utgående saldo") — they are not transactions and
    // would otherwise become rejected lines (and corrupt statementDate).
    if (isMetadataRow(line)) {
      log(`statement ${attachmentId} line ${lineNo}: skipping metadata row`);
      continue;
    }

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
        let journalProposalId = null;
        try {
          const jpRes = await _dispatchAction('journal.propose', {
            lines: p.lines, reference: p.reference || null,
            description: p.description || null,
            source_transaction_id: p.source_transaction_id || null,
            _match_meta: { tier: 4, source_type: 'llm_semantic',
              confidence: p.confidence || null, evidence: p.evidence || null },
          }, companyId, agentEmail);
          journalProposalId = jpRes && jpRes.proposal_id;
        } catch (e) {
          err(`statement ${attachmentId}: tier4 journal.propose failed: ${e.message}`);
        }

        // ── Partner-proposal-spec §6.1: Trigger A — partner.propose after tier-4 ──
        // Best-effort: extract counterparty name, check for existing partner /
        // pending proposal, and if neither exists, propose a new partner.
        try {
          await _maybeProposePartner({
            companyId, agentEmail,
            name: (p.suggested_dimensions && p.suggested_dimensions.counterparty) || p.description || null,
            default_expense_account: (p.lines && p.lines[0] && p.lines[0].account_code) || null,
            suggested_vat_code: (p.lines && p.lines[0] && p.lines[0].vat_code) || null,
            source_proposal_id: journalProposalId,
            source_description: p.description || null,
            evidence: [{ type: 'tier4_llm', description: p.description || '', confidence: p.confidence || null }],
          });
        } catch (partnerErr) {
          warn(`statement ${attachmentId}: partner.propose trigger failed: ${partnerErr.message}`);
        }
      }
    }
  }

  // Input rejections
  if (rejectedLines.length > 0) {
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const statementDate = lines.map((l) => l.date).filter((d) => d && dateRe.test(d))[0]
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
    ctx.chartOfAccounts = await _dispatchAction('coa.list', {}, companyId, agentEmail) || [];
  } catch (e) { warn(`tier4 context: coa.list failed: ${e.message}`); }
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

// ── Bill processing (bill-extraction-spec v2, ratified 2026-08-24) ───────────

// Vendor match thresholds (spec §3.3) — code constants, not settings.
const VENDOR_MATCH_CLEAR = 0.90;
const VENDOR_MATCH_AMBIGUOUS = 0.70;

// Per-page text extraction threshold (spec §2.1). Below this → treat page as
// scanned and fall through to the image path.
const PDF_TEXT_PAGE_THRESHOLD = 40;

/**
 * Build the company financial context for bill extraction (spec §2.2).
 * Loads vendor master (partners where is_vendor=true), expense-type accounts,
 * VAT codes, and company currency + jurisdiction. Modeled on buildTier4Context.
 */
async function buildBillExtractionContext(companyId, agentEmail) {
  const ctx = { vendors: [], expenseAccounts: [], vatCodes: [], currency: null, jurisdiction: null };

  // Vendor master: id, name, default currency, default expense account
  try {
    ctx.vendors = await query(
      `SELECT partner_id, name, default_currency, default_expense_account
       FROM partners
       WHERE company_id = @cid AND is_vendor = TRUE AND is_active = TRUE
       ORDER BY name`,
      { cid: companyId }
    ) || [];
  } catch (e) { warn(`bill context: vendors query failed: ${e.message}`); }

  // Chart of accounts: expense-type accounts only (spec §2.2)
  try {
    ctx.expenseAccounts = await query(
      `SELECT account_code, account_name, account_type
       FROM (
         SELECT *, ROW_NUMBER() OVER(PARTITION BY account_code ORDER BY created_at DESC) AS rn
         FROM accounts WHERE company_id = @cid
       ) t WHERE rn = 1 AND account_type = 'Expense' AND is_active = TRUE
       ORDER BY account_code`,
      { cid: companyId }
    ) || [];
  } catch (e) { warn(`bill context: expense accounts query failed: ${e.message}`); }

  // VAT/GST codes: code, rate, reverse-charge flag
  try {
    if (_dispatchAction) {
      ctx.vatCodes = await _dispatchAction('vat.codes.list', {}, companyId, agentEmail) || [];
    }
  } catch (e) { warn(`bill context: vat.codes.list failed: ${e.message}`); }

  // Company currency + jurisdiction
  try {
    const coRows = await query(
      `SELECT currency, jurisdiction FROM (
         SELECT *, ROW_NUMBER() OVER(PARTITION BY company_id ORDER BY created_at DESC) AS rn
         FROM companies WHERE company_id = @cid
       ) t WHERE rn = 1`,
      { cid: companyId }
    );
    if (coRows.length > 0) {
      ctx.currency = coRows[0].currency;
      ctx.jurisdiction = coRows[0].jurisdiction;
    }
  } catch (e) { warn(`bill context: company query failed: ${e.message}`); }

  return ctx;
}

/**
 * Build the system prompt for bill extraction (spec §3.1). Instructs the model
 * on the extraction schema, vendor matching, VAT handling, reverse-charge
 * recognition, and expense-account defaults.
 */
function buildBillExtractionPrompt(context) {
  const ctx = context || {};
  const vendorLines = (ctx.vendors || [])
    .map((v) => `${v.partner_id} | ${v.name}${v.default_expense_account ? ' | expense: ' + v.default_expense_account : ''}`)
    .join('\n');
  const coaLines = (ctx.expenseAccounts || [])
    .map((a) => `${a.account_code} ${a.account_name}`)
    .join('\n');
  const vatLines = (ctx.vatCodes || [])
    .map((v) => `${v.vat_code} ${(Number(v.rate) * 100).toFixed(0)}%${v.is_reverse_charge ? ' (reverse charge)' : ''}`)
    .join('\n');
  const currency = ctx.currency || '(unknown)';
  const jurisdiction = ctx.jurisdiction || '(unknown)';

  return `You are a bookkeeping assistant. Extract bill/invoice data from the document below.
Return a JSON object with exactly these fields:

  vendor_name_raw     — supplier name as printed on the document (string)
  vendor_id           — the partner_id from the vendor list below if you are confident this is that vendor, otherwise null (string | null)
  currency            — ISO 4217 currency code as printed (string, e.g. "SEK", "EUR")
  invoice_number      — supplier's invoice/reference number if visible (string | null)
  invoice_date        — invoice date, ISO YYYY-MM-DD (string)
  due_date            — payment due date, ISO YYYY-MM-DD if printed (string | null)
  total_stated        — total bill amount as printed, tax-inclusive (number)
  vat_amount_stated   — stated total VAT/tax amount if printed (number | null)
  lines               — array of line items, each:
    {
      description,      — line description as printed (string)
      amount,           — line total amount as printed, including tax (number)
      expense_account,  — best-guess account code from the chart of accounts below (string | null)
      vat_code,         — VAT code from the list below if a rate is printed (string | null)
      reverse_charge    — true if this line carries reverse-charge language (boolean)
    }

Rules:
- Match vendor name against the vendor list below. If confident, set vendor_id; otherwise null.
- Only assign a vat_code if a rate is actually printed on the document. Never guess a tax treatment.
- If the document contains reverse-charge language (e.g. "Reverse charge", "Omvänd betalningsskyldighet"), set reverse_charge: true on the relevant lines and leave vat_code null.
- Never invent a due_date if none is printed — leave null.
- Report line items and total_stated as printed. Do NOT do arithmetic — the engine checks totals deterministically.
- Default each line's expense_account to the vendor's default_expense_account (from the vendor list) if the vendor is matched. Only override when the document clearly indicates a different account.
- Amounts are numbers, not strings. Do not omit lines.

Company currency: ${currency}
Jurisdiction: ${jurisdiction}

Vendor list (partner_id | name | default expense account):
${vendorLines || '(none)'}

Chart of expense accounts (code name):
${coaLines || '(none)'}

VAT codes (code rate):
${vatLines || '(none)'}`;
}

/**
 * Deterministic validation of the LLM-parsed output (spec §3.3).
 * Returns an ExtractionResult object. The model's own confidence self-report
 * (if any) is discarded — every flag and the final confidence bucket are
 * computed here.
 */
function _validateExtraction(parsed, context, companySettings) {
  const flags = [];
  const ctx = context || {};
  companySettings = companySettings || {};

  // ── Hard-failure checks (§5.1): these return ok:false ──

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'extraction_failed', detail: 'LLM returned non-object', raw_model_output: parsed };
  }

  const totalStated = Number(parsed.total_stated);
  if (!isFinite(totalStated) || totalStated == null) {
    return { ok: false, reason: 'missing_critical_data', detail: 'No extractable total', raw_model_output: parsed };
  }

  const currency = parsed.currency;
  if (!currency || typeof currency !== 'string') {
    return { ok: false, reason: 'missing_critical_data', detail: 'No extractable currency', raw_model_output: parsed };
  }

  const invoiceDate = parsed.invoice_date;
  if (!invoiceDate || !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) {
    return { ok: false, reason: 'missing_critical_data', detail: 'No extractable invoice date', raw_model_output: parsed };
  }

  // Lines: must be non-empty array (§3.3)
  const rawLines = Array.isArray(parsed.lines) ? parsed.lines : [];
  if (rawLines.length === 0) {
    return { ok: false, reason: 'missing_critical_data', detail: 'Zero valid line items', raw_model_output: parsed };
  }

  // ── Line-level checks (§3.3) ──
  const validLines = [];
  for (const l of rawLines) {
    const amt = Number(l && l.amount);
    if (!isFinite(amt) || amt == null || amt <= 0) {
      // Non-numeric/null/negative line amount — hard-fail that line
      return { ok: false, reason: 'missing_critical_data', detail: `Line amount invalid: ${l && l.amount}`, raw_model_output: parsed };
    }
    validLines.push({
      description: String((l && l.description) || '').trim(),
      amount: amt,
      expense_account: (l && l.expense_account) || null,
      vat_code: (l && l.vat_code) || null,
      reverse_charge: !!(l && l.reverse_charge),
      needs_review: false,
    });
  }

  // Duplicate line descriptions with different amounts (§3.3)
  const descMap = {};
  for (const l of validLines) {
    if (!l.description) continue;
    if (descMap[l.description] !== undefined && descMap[l.description] !== l.amount) {
      flags.push('duplicate_line_description');
      l.needs_review = true;
    }
    descMap[l.description] = l.amount;
  }

  // ── Vendor match — deterministic, not LLM-judged (§3.3) ──
  const vendorNameRaw = String(parsed.vendor_name_raw || '').trim();
  let vendorId = parsed.vendor_id || null;
  let needsNewVendor = false;

  // If the model proposed a vendor_id, validate it against the vendor list
  if (vendorId) {
    const vendor = (ctx.vendors || []).find((v) => v.partner_id === vendorId);
    if (!vendor) {
      // Proposed vendor_id doesn't exist in this company — treat as no match
      vendorId = null;
    } else if (vendorNameRaw) {
      const sim = trigramSimilarity(vendorNameRaw, vendor.name);
      if (sim < VENDOR_MATCH_AMBIGUOUS) {
        // Below threshold — treat as no match
        vendorId = null;
      } else if (sim < VENDOR_MATCH_CLEAR) {
        // Ambiguous — keep vendor_id but flag
        flags.push('ambiguous_vendor');
      }
      // ≥ CLEAR: accept silently
    }
  }

  // If no vendor_id matched, try matching vendor_name_raw against the list
  if (!vendorId && vendorNameRaw) {
    const candidates = (ctx.vendors || []).map((v) => ({ name: v.name, partner_id: v.partner_id }));
    const fuzzy = findFuzzyMatch(vendorNameRaw, candidates, VENDOR_MATCH_AMBIGUOUS);
    if (fuzzy && fuzzy.similarity >= VENDOR_MATCH_CLEAR) {
      vendorId = fuzzy.candidate.partner_id;
    } else if (fuzzy && fuzzy.similarity >= VENDOR_MATCH_AMBIGUOUS) {
      vendorId = fuzzy.candidate.partner_id;
      flags.push('ambiguous_vendor');
    } else {
      // No match at all — needs new vendor
      needsNewVendor = true;
    }
  }

  if (!vendorId && !vendorNameRaw) {
    needsNewVendor = true;
  }

  // Default expense_account to vendor's default if matched (§3.1)
  if (vendorId) {
    const vendor = (ctx.vendors || []).find((v) => v.partner_id === vendorId);
    if (vendor && vendor.default_expense_account) {
      for (const l of validLines) {
        if (!l.expense_account) {
          l.expense_account = vendor.default_expense_account;
        }
      }
    }
  }

  // ── Totals: sum(lines) vs total_stated (§3.3) ──
  const totalComputed = validLines.reduce((s, l) => s + l.amount, 0);
  const tolerance = parseFloat(companySettings.bill_extraction_tolerance || '0.50');
  if (Math.abs(totalComputed - totalStated) > tolerance) {
    flags.push('total_mismatch');
    validLines.forEach((l) => { l.needs_review = true; });
  }

  // ── VAT code validation (§3.3) ──
  const validVatCodes = new Set((ctx.vatCodes || []).map((v) => v.vat_code));
  let reverseChargeDetected = false;
  for (const l of validLines) {
    if (l.reverse_charge) {
      reverseChargeDetected = true;
      l.vat_code = null; // RC lines never carry a vat_code
      l.needs_review = true;
    } else if (l.vat_code && !validVatCodes.has(l.vat_code)) {
      // Proposed vat_code doesn't exist — leave unset and flag
      l.vat_code = null;
      l.needs_review = true;
    }
  }
  if (reverseChargeDetected) {
    flags.push('reverse_charge_detected');
  } else {
    // Check if any line is missing a vat_code and no RC was detected
    const missingVat = validLines.some((l) => !l.vat_code && !l.reverse_charge);
    if (missingVat) {
      flags.push('no_vat_code_detected');
    }
  }

  // ── Confidence derivation (§3.3): flag count, not self-reported ──
  const confidence = flags.length === 0 ? 'high' : flags.length === 1 ? 'medium' : 'low';

  return {
    ok: true,
    confidence,
    data: {
      vendor_id: vendorId,
      vendor_name_raw: vendorNameRaw || '(unknown)',
      needs_new_vendor: needsNewVendor,
      currency: String(currency),
      invoice_number: parsed.invoice_number || null,
      invoice_date: invoiceDate,
      due_date: parsed.due_date || null,
      lines: validLines,
      total_stated: totalStated,
      total_computed: Math.round(totalComputed * 100) / 100,
      vat_amount_stated: parsed.vat_amount_stated != null ? Number(parsed.vat_amount_stated) : null,
    },
    flags,
    raw_model_output: parsed,
  };
}

/**
 * Check for an existing non-voided bill matching (vendor_id, invoice_number,
 * total_stated) for this company (spec §6). When vendor_id is null, falls
 * back to (vendor_name_raw, invoice_number, total_stated). Returns the
 * existing bill_id if a duplicate is found, or null.
 */
async function _checkDuplicate(companyId, result) {
  const d = result.data;
  if (!d) return null;
  const total = d.total_stated;
  const invNum = d.invoice_number;
  if (!invNum) return null; // can't check duplicates without an invoice number

  try {
    if (d.vendor_id) {
      const rows = await query(
        `SELECT bill_id FROM bills
         WHERE company_id = @cid AND partner_id = @vid
           AND vendor_ref = @invNum AND amount = @total
           AND status != 'void'
         LIMIT 1`,
        { cid: companyId, vid: d.vendor_id, invNum, total }
      );
      if (rows.length > 0) return rows[0].bill_id;
    } else {
      // vendor_id null — fall back to vendor_name_raw (spec §6)
      const rows = await query(
        `SELECT bill_id FROM bills
         WHERE company_id = @cid AND partner_name = @vname
           AND vendor_ref = @invNum AND amount = @total
           AND status != 'void'
         LIMIT 1`,
        { cid: companyId, vname: d.vendor_name_raw, invNum, total }
      );
      if (rows.length > 0) return rows[0].bill_id;
    }
  } catch (e) {
    warn(`bill dedup check failed: ${e.message}`);
  }
  return null;
}

/**
 * Extract structured bill data from a single attachment (spec §1-§5).
 *
 * Pipeline:
 *   1. Read document (PDF text extraction per-page, or image base64)
 *   2. Build company financial context
 *   3. Build system prompt
 *   4. Call LLM (same endpoint for text and image)
 *   5. Deterministic validation (§3.3)
 *
 * Returns an ExtractionResult (§4.1). Hard failures return ok:false with a
 * reason for input_rejections. Never throws to processBill.
 */
async function extractBillData(att, payload, companySettings, companyId, agentEmail) {
  const filename = payload.filename || att.filename || '(unknown)';
  const ct = (att.contentType || '').toLowerCase();
  const isPdf = ct === 'application/pdf' || /\.pdf$/i.test(filename);
  const isImage = ct === 'image/jpeg' || ct === 'image/png'
    || /\.(jpe?g|png)$/i.test(filename);
  companySettings = companySettings || {};

  // ── Hard failure: no LLM configured (§5.1) ──
  if (!companySettings.llm_endpoint_url) {
    warn(`bill ${filename}: no llm_endpoint_url configured`);
    return { ok: false, reason: 'no_llm_configured', detail: 'No LLM endpoint configured',
             raw_model_output: null };
  }

  // ── Build context (§2.2) ──
  const context = await buildBillExtractionContext(companyId, agentEmail);
  const systemPrompt = buildBillExtractionPrompt(context);
  const temperature = parseFloat(companySettings.llm_temperature || '0.1');
  const url = companySettings.llm_endpoint_url;
  const apiKey = companySettings.llm_api_key || '';
  const model = companySettings.llm_model || 'default';

  // ── Document read: determine text vs image path (§2.1) ──
  let useImage = isImage; // images always go image path
  let extractedText = '';

  if (isPdf) {
    try {
      const pdfParse = require('pdf-parse');
      const parsedPdf = await pdfParse(att.buffer);
      // Per-page check (spec §2.1): if any page is below threshold, treat
      // the entire document as image-based.
      const numPages = parsedPdf.numpages || 1;
      // pdf-parse returns all text as a single string; approximate per-page
      // by splitting on form-feed characters (\f). If the total text is below
      // the threshold scaled by page count, treat as scanned.
      const fullText = (parsedPdf.text || '').trim();
      const perPageAvg = fullText.length / Math.max(1, numPages);
      if (perPageAvg < PDF_TEXT_PAGE_THRESHOLD) {
        useImage = true;
        warn(`bill ${filename}: PDF text per-page avg ${perPageAvg.toFixed(0)} < ${PDF_TEXT_PAGE_THRESHOLD} — treating as scanned`);
      } else {
        extractedText = fullText;
        useImage = false;
      }
    } catch (e) {
      warn(`bill ${filename}: pdf-parse failed: ${e.message} — trying image path`);
      useImage = true;
    }
  }

  // ── LLM call (§3.2): same endpoint for text and image ──
  const promptSnapshot = {
    system_prompt: systemPrompt,
    context: {
      vendor_count: (context.vendors || []).length,
      expense_account_count: (context.expenseAccounts || []).length,
      vat_code_count: (context.vatCodes || []).length,
      currency: context.currency,
      jurisdiction: context.jurisdiction,
    },
    model,
    temperature,
    content_type: useImage ? 'image' : 'text',
  };

  let response;
  try {
    if (useImage && att.buffer) {
      // Image path: base64-encode and send as image_url content block
      const b64 = att.buffer.toString('base64');
      const mimeType = att.contentType || 'application/octet-stream';
      const dataUrl = `data:${mimeType};base64,${b64}`;
      response = await fetch(`${url.replace(/\/v1\/?$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: [
              { type: 'text', text: 'Extract the bill data from this document.' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ] },
          ],
          temperature,
          response_format: { type: 'json_object' },
        }),
      });
    } else if (extractedText) {
      // Text path: send extracted text as plain string
      response = await fetch(`${url.replace(/\/v1\/?$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: extractedText },
          ],
          temperature,
          response_format: { type: 'json_object' },
        }),
      });
    } else {
      // No text extracted and not an image with buffer — can't proceed
      warn(`bill ${filename}: no extractable content (not text, not image with buffer)`);
      return { ok: false, reason: 'extraction_failed', detail: 'No extractable content',
               raw_model_output: null, prompt_snapshot: promptSnapshot };
    }
  } catch (e) {
    // LLM call error (§5.1): timeout, network, etc.
    warn(`bill ${filename}: LLM call failed: ${e.message}`);
    return { ok: false, reason: 'extraction_failed', detail: e.message,
             raw_model_output: null, prompt_snapshot: promptSnapshot };
  }

  // ── Parse LLM response ──
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    warn(`bill ${filename}: LLM HTTP ${response.status}: ${body.slice(0, 200)}`);
    return { ok: false, reason: 'extraction_failed', detail: `LLM HTTP ${response.status}`,
             raw_model_output: { http_status: response.status, body: body.slice(0, 500) },
             prompt_snapshot: promptSnapshot };
  }

  let llmData;
  try {
    llmData = await response.json();
  } catch (e) {
    warn(`bill ${filename}: LLM returned non-JSON envelope: ${e.message}`);
    return { ok: false, reason: 'extraction_failed', detail: 'Non-JSON response envelope',
             raw_model_output: null, prompt_snapshot: promptSnapshot };
  }

  const content = llmData?.choices?.[0]?.message?.content;
  if (!content) {
    warn(`bill ${filename}: empty LLM response`);
    return { ok: false, reason: 'extraction_failed', detail: 'Empty LLM response',
             raw_model_output: llmData, prompt_snapshot: promptSnapshot };
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    warn(`bill ${filename}: non-JSON content: ${content.slice(0, 200)}`);
    return { ok: false, reason: 'extraction_failed', detail: 'Non-JSON content from LLM',
             raw_model_output: { raw_content: content.slice(0, 1000) },
             prompt_snapshot: promptSnapshot };
  }

  // ── Deterministic validation (§3.3) ──
  const result = _validateExtraction(parsed, context, companySettings);
  result.prompt_snapshot = promptSnapshot;
  return result;
}

/**
 * Process a bill attachment event (spec §1, §4.2, §5, §6).
 * Called from processEvent when entityType='bill'. Maps the ExtractionResult
 * to bill.create (status='draft') or input_rejections. Never throws.
 */
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

  const result = await extractBillData(att, payload, companySettings, companyId, agentEmail);

  // ── Hard failure → input_rejections (§5.1) ──
  if (!result.ok) {
    const reason = result.reason || 'extraction_failed';
    const detail = result.detail || 'Unknown extraction failure';
    warn(`bill ${attachmentId}: hard failure — ${reason}: ${detail}`);
    try {
      await _dispatchAction('input_rejection.create', {
        statement_id: attachmentId,
        statement_date: new Date().toISOString().substring(0, 10),
        rejected_lines: [{ reason: `${reason}: ${detail}`, raw: JSON.stringify(result.raw_model_output || {}).slice(0, 500) }],
      }, companyId, agentEmail);
      log(`bill ${attachmentId}: input_rejection created (${reason})`);
    } catch (e) {
      err(`bill ${attachmentId}: input_rejection.create failed: ${e.message}`);
    }
    return;
  }

  // ── Duplicate detection (§6) ──
  const dupBillId = await _checkDuplicate(companyId, result);
  if (dupBillId) {
    if (!result.flags.includes('possible_duplicate')) {
      result.flags.push('possible_duplicate');
    }
    log(`bill ${attachmentId}: possible duplicate of bill ${dupBillId} — flagging`);
    // Still create the draft; the flag surfaces it for review.
  }

  // ── Map ExtractionResult.data → bill.create draft (§4.2) ──
  const d = result.data;
  const firstLine = (d.lines && d.lines[0]) || {};
  const bill = {
    partner_id: d.vendor_id || null,
    partner_name: d.vendor_name_raw || null,
    vendor_ref: d.invoice_number || null,
    date: d.invoice_date,
    due_date: d.due_date || d.invoice_date, // default due to invoice date if not printed
    currency: d.currency,
    amount: d.total_stated,
    expense_account: d.lines.length === 1 ? firstLine.expense_account : null,
    ap_account: null, // server default (applyCompanyDefaults) fills it
    vat_code: d.lines.length === 1 ? firstLine.vat_code : null,
    vat_amount: d.vat_amount_stated || 0,
    description: null,
    lines: d.lines.map((l) => ({
      description: l.description,
      amount: l.amount,
      expense_account: l.expense_account,
      vat_code: l.vat_code,
      needs_review: l.needs_review,
    })),
    _source_attachment_id: payload.entityId || null,
    _source_filename: payload.filename || att.filename || null,
    _extraction_meta: {
      model: companySettings.llm_model || 'default',
      confidence: result.confidence,
      flags: result.flags,
      raw_model_output: result.raw_model_output,
      prompt_snapshot: result.prompt_snapshot,
      total_computed: d.total_computed,
      pending_vendor_proposal_id: d.needs_new_vendor ? null : undefined,
    },
  };

  let billResult = null;
  try {
    billResult = await _dispatchAction('bill.create', { bill }, companyId, agentEmail);
    log(`bill ${attachmentId}: draft created (bill_id=${billResult && billResult.bill_id || '?'}, confidence=${result.confidence}, flags=[${result.flags.join(',') || 'none'}])`);
  } catch (e) {
    err(`bill ${attachmentId}: bill.create failed: ${e.message}`);
    return;
  }

  // ── Write _extraction_meta to side table (§4.2) ──
  if (billResult && billResult.bill_id) {
    try {
      const meta = bill._extraction_meta;
      await exec(
        `INSERT INTO bill_extraction_meta
           (bill_id, company_id, model, confidence, flags, raw_model_output, prompt_snapshot, pending_vendor_proposal_id, created_at)
         VALUES
           (@billId, @companyId, @model, @confidence, @flags, @rawOutput, @promptSnapshot, @pendingVendorProposal, @now)`,
        {
          billId: billResult.bill_id,
          companyId,
          model: meta.model,
          confidence: meta.confidence,
          flags: JSON.stringify(meta.flags || []),
          rawOutput: JSON.stringify(meta.raw_model_output || {}),
          promptSnapshot: JSON.stringify(meta.prompt_snapshot || {}),
          pendingVendorProposal: meta.pending_vendor_proposal_id || null,
          now: new Date().toISOString(),
        }
      );
    } catch (e) {
      warn(`bill ${attachmentId}: bill_extraction_meta insert failed: ${e.message}`);
    }
  }

  // ── Partner-proposal-spec §6.2: Trigger B — partner.propose after bill.create ──
  // When needs_new_vendor is true, the existing partner proposal flow handles
  // surfacing the new-vendor decision via the unified Inbox. This is the
  // existing mechanism — the spec's vendor_proposals (§11.1) maps onto the
  // already-shipped partner_proposals table + partner.propose action.
  if (billResult && d.needs_new_vendor && d.vendor_name_raw) {
    try {
      await _maybeProposePartner({
        companyId, agentEmail,
        name: d.vendor_name_raw,
        default_expense_account: d.lines.length === 1 ? firstLine.expense_account : null,
        source_bill_id: billResult.bill_id,
        source_description: null,
        evidence: [{ type: 'bill_extraction', bill_id: billResult.bill_id, filename: att.filename }],
      });
    } catch (partnerErr) {
      warn(`bill ${attachmentId}: partner.propose trigger failed: ${partnerErr.message}`);
    }
  }
}

// Test-only injection of dispatchAction / fetchAttachment (no production use;
// production wiring is via startAgentLoop, which sets both). Used by the
// bill-extraction contract tests so they don't need a live DB / timer.
function _setLoopDeps({ dispatchAction, fetchAttachmentFn } = {}) {
  if (dispatchAction !== undefined) _dispatchAction = dispatchAction;
  if (fetchAttachmentFn !== undefined) _fetchAttachmentFn = fetchAttachmentFn;
}

module.exports.processBill = processBill;
module.exports.extractBillData = extractBillData;
module.exports.buildBillExtractionPrompt = buildBillExtractionPrompt;
module.exports.buildBillExtractionContext = buildBillExtractionContext;
module.exports._validateExtraction = _validateExtraction;
module.exports._checkDuplicate = _checkDuplicate;
module.exports._setLoopDeps = _setLoopDeps;

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
