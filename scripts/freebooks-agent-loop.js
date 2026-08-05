#!/usr/bin/env node
'use strict';
/**
 * freebooks Agent Orchestration Loop (Phase B, bank-matching-spec §8.3)
 *
 * Polls the freebooks event stream for attachment.uploaded events, processes
 * each attachment through the bank-matching cascade (tiers 1-3 via bank.match,
 * tier 4 via LLM reasoning), and proposes journal entries via journal.propose.
 *
 * Also handles bills routing: attachment.uploaded with entityType='bill' →
 * extract → bill.create (draft).
 *
 * Runs as an agent process outside of freebooks. Operator infrastructure —
 * run under systemd/tmux. The LLM tier-4 reasoning is performed by the agent
 * itself (this script is the pipeline skeleton; the tier-4 hook is a
 * placeholder for the agent's own LLM call).
 *
 * Env vars:
 *   FREEBOOKS_API_URL  (default http://127.0.0.1:3000)
 *   FREEBOOKS_USER     (agent-role account email)
 *   FREEBOOKS_COMPANY   (company id)
 *   FREEBOOKS_API_TOKEN (optional bearer token)
 *   FREEBOOKS_POLL_INTERVAL_MS (default 30000 — 30s)
 *   FREEBOOKS_CURSOR_FILE (optional — persist event_seq cursor to this file)
 *   FREEBOOKS_BANK_ACCOUNT (optional — bank account code passed to bank.match;
 *     when unset, the server falls back to the company default_bank_account
 *     setting)
 *   FREEBOOKS_CSV_COLUMNS (optional — comma-separated column name list for
 *     CSV parsing, e.g. "date,description,amount,counterparty". Default
 *     auto-detects between "date,description,amount[,counterparty[,transaction_id]]"
 *     and "date,amount,description[,counterparty]")
 *
 * Usage:
 *   node scripts/freebooks-agent-loop.js             # long-running poll loop
 *   node scripts/freebooks-agent-loop.js --once      # one poll cycle, then exit
 *
 * Exit codes:
 *   0 — clean shutdown (SIGINT/SIGTERM) or --once completed
 *   1 — fatal config error (missing FREEBOOKS_USER / FREEBOOKS_COMPANY)
 *   2 — unhandled error in --once mode (the loop mode logs and continues)
 */

// ── Config ─────────────────────────────────────────────────────────────────

const API_URL = (process.env.FREEBOOKS_API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const FREEBOOKS_USER = process.env.FREEBOOKS_USER || '';
const FREEBOOKS_COMPANY = process.env.FREEBOOKS_COMPANY || '';
const API_TOKEN = process.env.FREEBOOKS_API_TOKEN || '';
const POLL_INTERVAL_MS = Number(process.env.FREEBOOKS_POLL_INTERVAL_MS) > 0
  ? Math.floor(Number(process.env.FREEBOOKS_POLL_INTERVAL_MS))
  : 30000;
const CURSOR_FILE = process.env.FREEBOOKS_CURSOR_FILE || '';
const BANK_ACCOUNT = process.env.FREEBOOKS_BANK_ACCOUNT || '';
const CSV_COLUMNS_CFG = process.env.FREEBOOKS_CSV_COLUMNS || '';

const ONCE = process.argv.includes('--once');

// ── Runtime state ───────────────────────────────────────────────────────────

let shuttingDown = false;
let lastSeq = 0;

// ── Logging ─────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString();
}
function log(...args) {
  console.log(`[${ts()}]`, ...args);
}
function warn(...args) {
  console.warn(`[${ts()}] WARN`, ...args);
}
function err(...args) {
  console.error(`[${ts()}] ERROR`, ...args);
}

// ── Cursor persistence ──────────────────────────────────────────────────────

function loadCursor() {
  if (!CURSOR_FILE) return;
  try {
    const fs = require('fs');
    const raw = fs.readFileSync(CURSOR_FILE, 'utf8').trim();
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      lastSeq = Math.floor(n);
      log(`cursor: resumed from event_seq=${lastSeq} (${CURSOR_FILE})`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') warn(`cursor: could not read ${CURSOR_FILE}: ${e.message}`);
  }
}

function saveCursor() {
  if (!CURSOR_FILE) return;
  try {
    const fs = require('fs');
    fs.writeFileSync(CURSOR_FILE, String(lastSeq) + '\n');
  } catch (e) {
    warn(`cursor: could not write ${CURSOR_FILE}: ${e.message}`);
  }
}

// ── API call helper ──────────────────────────────────────────────────────────

/**
 * Call a freebooks catalog action via POST /api.
 * @param {string} action - catalog action name (e.g. 'event.list', 'journal.propose')
 * @param {object} params - action params (merged into the envelope body)
 * @returns {Promise<any>} the action's `data` field on success
 */
async function callApi(action, params) {
  const headers = { 'Content-Type': 'application/json' };
  if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;
  const body = {
    action,
    companyId: FREEBOOKS_COMPANY,
    userEmail: FREEBOOKS_USER,
    ...params,
  };
  const r = await fetch(`${API_URL}/api`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  let json;
  try {
    json = await r.json();
  } catch (parseErr) {
    throw Object.assign(new Error(`non-JSON API response (HTTP ${r.status})`), {
      code: 'HTTP_' + r.status,
      action,
    });
  }
  if (!json.ok) {
    throw Object.assign(new Error(json.error?.message || 'API error'), {
      code: json.error?.code,
      action,
    });
  }
  return json.data;
}

/**
 * Fetch raw attachment bytes via GET /api/attachments/:attachmentId.
 * @param {string} attachmentId
 * @returns {Promise<{contentType:string, filename:string, text:string, buffer:Buffer}>}
 */
async function fetchAttachment(attachmentId) {
  const headers = {};
  if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;
  const r = await fetch(`${API_URL}/api/attachments/${encodeURIComponent(attachmentId)}`, { headers });
  if (!r.ok) {
    throw Object.assign(new Error(`attachment fetch failed: HTTP ${r.status}`), {
      code: 'HTTP_' + r.status,
      attachmentId,
    });
  }
  const contentType = r.headers.get('content-type') || 'application/octet-stream';
  const disposition = r.headers.get('content-disposition') || '';
  const m = /filename="?([^";]+)"?/.exec(disposition);
  const filename = m ? m[1] : attachmentId;
  const buffer = Buffer.from(await r.arrayBuffer());
  return { contentType, filename, buffer, text: buffer.toString('utf8') };
}

// ── CSV parsing ─────────────────────────────────────────────────────────────

/**
 * Parse a CSV string into rows of string cells. Handles quoted fields and
 * embedded commas/newlines (RFC 4180 minimal subset). No external deps.
 * @param {string} text
 * @returns {string[][]} rows of cells
 */
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  // Normalize CRLF / CR to LF, but quoted fields may contain embedded newlines
  // handled by the state machine below.
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
    if (c === '\r') { continue; } // treat CR as line sep precursor to LF
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  // flush trailing field/row if any non-empty content remains
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Resolve the column-name → index map for a statement's CSV header row.
 * Supports an explicit FREEBOOKS_CSV_COLUMNS override; otherwise auto-detects
 * the common Swedish bank orderings:
 *   - date,description,amount[,counterparty[,transaction_id]]
 *   - date,amount,description[,counterparty]
 * Any header row whose cells match known column names case-insensitively is
 * used; otherwise the first data row is assumed columnless and the default
 * (date,description,amount) ordering applies.
 *
 * @param {string[][]} rows
 * @returns {{columns: Record<string, number>, headerRows: number}} column index
 *   map + how many leading rows to skip (0 or 1)
 */
function resolveColumns(rows) {
  const KNOWN = ['date', 'amount', 'description', 'counterparty', 'transaction_id', 'belopp', 'belop', 'datum', 'beskrivning', 'text', 'transaktion'];
  const lc = (s) => String(s || '').trim().toLowerCase();

  // Explicit override
  if (CSV_COLUMNS_CFG) {
    const names = CSV_COLUMNS_CFG.split(',').map((s) => s.trim()).filter(Boolean);
    const columns = {};
    names.forEach((n, i) => { columns[n] = i; });
    return { columns, headerRows: 0 };
  }

  if (rows.length === 0) return { columns: { date: 0, description: 1, amount: 2 }, headerRows: 0 };

  // Detect header: if ≥2 cells of row 0 are known column names
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

  // No header row — assume default ordering date,description,amount[,...]
  const defaultCols = { date: 0, description: 1, amount: 2 };
  // If the row has ≥4 cols, treat col 3 as counterparty and col 4 as transaction_id
  if (rows[0].length >= 4) defaultCols.counterparty = 3;
  if (rows[0].length >= 5) defaultCols.transaction_id = 4;
  return { columns: defaultCols, headerRows: 0 };
}

/**
 * Parse a CSV bank statement text into statement-line objects.
 * @param {string} text
 * @returns {{date:string, amount:string, description:string, counterparty?:string, transaction_id?:string}[]}
 */
function parseBankStatementCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const { columns, headerRows } = resolveColumns(rows);
  const idx = (name, fallback) => columns[name] !== undefined ? columns[name] : fallback;
  const di = idx('date', 0);
  const ai = idx('amount', 2);
  const si = idx('description', 1);
  const ci = idx('counterparty', -1);
  const ti = idx('transaction_id', -1);

  const out = [];
  for (let r = headerRows; r < rows.length; r++) {
    const row = rows[r];
    // skip blank rows
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

// ── Critical-data check (§11.3) ──────────────────────────────────────────────

/**
 * Per bank-matching-spec §11.3, a line is rejected (not proposed) when it
 * lacks a field required for ANY tier to attempt a match:
 *   - missing date
 *   - missing amount
 *   - missing description AND no counterparty
 * Lines with partial data that still allows a tier to attempt (e.g. amount +
 * date but vague description, with a counterparty) are NOT rejected.
 *
 * @param {object} line
 * @returns {{rejected:boolean, reason?:string}}
 */
function checkCriticalData(line) {
  if (!line.date) return { rejected: true, reason: 'missing date' };
  if (line.amount === '' || line.amount == null) return { rejected: true, reason: 'missing amount' };
  // amount must parse as a number; a non-numeric amount is a missing amount
  const amt = parseAmount(line.amount);
  if (amt === null) return { rejected: true, reason: 'missing amount' };
  if (!line.description && !line.counterparty) {
    return { rejected: true, reason: 'missing description and no counterparty' };
  }
  return { rejected: false };
}

/**
 * Parse a Swedish/European amount string into a number, or null if unparseable.
 * Handles "1.234,56" (SE/EU), "1,234.56" (US), "-4900", "4 900,00" (spaces).
 * Bank CSVs typically use comma decimals; negative = outflow.
 * @param {string} s
 * @returns {number|null}
 */
function parseAmount(s) {
  if (s == null) return null;
  let t = String(s).trim();
  if (t === '') return null;
  // Strip spaces used as thousand separators (e.g. "4 900,00")
  t = t.replace(/\s+/g, '');
  // Replace Swedish decimal comma with a dot if there's no dot already and there
  // is exactly one comma near the end. Handle "1.234,56" → "1234.56".
  const hasDot = t.includes('.');
  const hasComma = t.includes(',');
  if (hasDot && hasComma) {
    // last separator is the decimal; the other is thousands
    if (t.lastIndexOf(',') > t.lastIndexOf('.')) {
      // comma decimal → remove dots, comma → dot
      t = t.replace(/\./g, '').replace(',', '.');
    } else {
      // dot decimal → remove commas
      t = t.replace(/,/g, '');
    }
  } else if (hasComma) {
    // only commas: assume comma decimal (one comma) — but multiple commas
    // are thousands separators. Heuristic: if there's exactly one comma and
    // ≤2 digits after it, treat as decimal; otherwise treat as thousands.
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

// ── Tier 4 — LLM reasoning hook (PLACEHOLDER) ───────────────────────────────

/**
 * Tier 4 — LLM reasoning for residual lines (bank-matching-spec §5).
 *
 * This is a PLACEHOLDER. The actual LLM call is the agent's own reasoning —
 * the operator replaces this function with their LLM integration (OpenAI,
 * Anthropic, local model, etc.). The function receives the residual lines
 * and the company context, and returns proposed journal lines.
 *
 * Per §5.2 the residual for ONE statement goes into a single tier-4 call (up
 * to the §5.3 size cap of ~15-20 lines; larger residuals split sequentially
 * oldest-first). Per §5.3 the model must return exactly one structured
 * proposal per input line (count-in == count-out); the operator's
 * implementation should validate this and retry-once-then-per-line on
 * mismatch.
 *
 * @param {Array<object>} residualLines - statement lines that exhausted tiers 1-3
 * @param {object} context - { chartOfAccounts, businessProfile, matchingHistory }
 * @returns {Promise<Array<{lines: object[], source_transaction_id?: string, evidence?: object}>>}
 *   one proposal object per residual line; empty array = no proposals.
 */
async function tier4LLMReason(residualLines, context) {
  console.warn(
    '[tier4] LLM reasoning not implemented — residual lines skipped. ' +
    'Provide an implementation of tier4LLMReason() to enable tier-4 matching.'
  );
  if (residualLines && residualLines.length) {
    warn(`[tier4] ${residualLines.length} residual line(s) left unmatched (no LLM implementation).`);
  }
  return []; // no proposals — lines remain unmatched
}

// ── Bank statement processing ────────────────────────────────────────────────

/**
 * Process a single bank-statement attachment through the full cascade.
 * @param {object} ev - the attachment.uploaded event row
 * @param {object} payload - parsed event payload { entityType, entityId, filename, contentType, ... }
 */
async function processBankStatement(ev, payload) {
  const attachmentId = ev.entity_id; // the attachment's own id (event.entity_id)
  let statementText;
  try {
    const att = await fetchAttachment(attachmentId);
    statementText = att.text;
  } catch (e) {
    err(`statement ${attachmentId}: fetch failed: ${e.message}`);
    return;
  }

  const lines = parseBankStatementCsv(statementText);
  if (lines.length === 0) {
    warn(`statement ${attachmentId}: no CSV lines parsed (filename=${payload.filename || '?'})`);
    return;
  }
  log(`statement ${attachmentId}: ${lines.length} line(s) parsed`);

  const matchedProposals = [];
  const residualLines = [];
  const rejectedLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // §11.3 critical-data check
    const cd = checkCriticalData(line);
    if (cd.rejected) {
      rejectedLines.push({
        line: lineNo,
        reason: cd.reason,
        raw: `${line.date || ''},${line.description || ''},${line.amount || ''}`,
      });
      continue;
    }

    // bank.match — tiers 1-3 deterministic (non-mutating read)
    let match;
    try {
      const params = { line };
      if (BANK_ACCOUNT) params.bankAccount = BANK_ACCOUNT;
      match = await callApi('bank.match', params);
    } catch (e) {
      err(`statement ${attachmentId} line ${lineNo}: bank.match failed: ${e.message}`);
      // Treat a bank.match error as a residual — the operator can re-run.
      residualLines.push(line);
      continue;
    }

    if (match && match.matched) {
      // Confident tier 1-3 match → propose
      const sourceTransactionId =
        line.transaction_id ||
        `${line.date}|${line.amount}|${line.description}|${BANK_ACCOUNT || ''}`;
      try {
        const proposal = await callApi('journal.propose', {
          lines: match.lines,
          reference: line.transaction_id || null,
          description: line.description,
          source_transaction_id: sourceTransactionId,
          // stamp provenance so review surface can show source_type/evidence
          _match_meta: {
            tier: match.tier,
            source_type: match.source_type,
            confidence: match.confidence,
            evidence: match.evidence,
            suggested_dimensions: match.suggested_dimensions,
          },
        });
        matchedProposals.push(proposal);
      } catch (e) {
        err(`statement ${attachmentId} line ${lineNo}: journal.propose failed: ${e.message}`);
        residualLines.push(line);
      }
    } else if (match && match.reason === 'duplicate') {
      // §1.1 idempotency dedup — already proposed; skip silently
      log(`statement ${attachmentId} line ${lineNo}: duplicate (existing proposal ${match.existing_proposal_id})`);
    } else {
      // no tier 1-3 match → residual for tier-4 LLM batch (one call per statement)
      residualLines.push(line);
    }
  }

  log(`statement ${attachmentId}: ${matchedProposals.length} matched, ${residualLines.length} residual, ${rejectedLines.length} rejected`);

  // §5.2: one tier-4 LLM call for the statement's residual (size cap §5.3: ~15-20 lines,
  // split sequentially oldest-first if exceeded).
  if (residualLines.length > 0) {
    const SIZE_CAP = 18;
    let batches;
    if (residualLines.length <= SIZE_CAP) {
      batches = [residualLines];
    } else {
      batches = [];
      for (let i = 0; i < residualLines.length; i += SIZE_CAP) {
        batches.push(residualLines.slice(i, i + SIZE_CAP));
      }
      warn(`statement ${attachmentId}: residual ${residualLines.length} > cap ${SIZE_CAP}, splitting into ${batches.length} sequential batch(es)`);
    }

    const context = await buildTier4Context();

    for (const batch of batches) {
      let proposals;
      try {
        proposals = await tier4LLMReason(batch, context);
      } catch (e) {
        err(`statement ${attachmentId}: tier4 LLM call failed: ${e.message}`);
        continue;
      }
      if (!Array.isArray(proposals)) {
        warn(`statement ${attachmentId}: tier4 returned non-array (skipped)`);
        continue;
      }
      for (const p of proposals) {
        if (!p || !Array.isArray(p.lines) || p.lines.length === 0) continue;
        try {
          await callApi('journal.propose', {
            lines: p.lines,
            reference: p.reference || null,
            description: p.description || null,
            source_transaction_id: p.source_transaction_id || null,
            _match_meta: {
              tier: 4,
              source_type: 'llm_semantic',
              confidence: p.confidence || null,
              evidence: p.evidence || null,
            },
          });
        } catch (e) {
          err(`statement ${attachmentId}: tier4 journal.propose failed: ${e.message}`);
        }
      }
    }
  }

  // §11: one input_rejection item per statement with rejections
  if (rejectedLines.length > 0) {
    const statementId = attachmentId;
    // statement_date = first parseable date in the accepted lines, else today
    const statementDate = lines
      .map((l) => l.date)
      .filter(Boolean)[0] || new Date().toISOString().substring(0, 10);
    try {
      await callApi('input_rejection.create', {
        statement_id: statementId,
        statement_date: statementDate,
        rejected_lines: rejectedLines,
      });
      log(`statement ${attachmentId}: input_rejection created for ${rejectedLines.length} rejected line(s)`);
    } catch (e) {
      err(`statement ${attachmentId}: input_rejection.create failed: ${e.message}`);
    }
  }
}

/**
 * Build the context object passed to tier4LLMReason: chart of accounts,
 * the company's business profile, and prior matching_history.
 * All fetched via non-mutating reads (freebooks_read gateway).
 * @returns {Promise<object>}
 */
async function buildTier4Context() {
  const ctx = { chartOfAccounts: [], businessProfile: null, matchingHistory: [] };
  try {
    ctx.chartOfAccounts = await callApi('freebooks_read', {
      action: 'account.list',
      params: {},
    }) || [];
  } catch (e) {
    warn(`tier4 context: account.list failed: ${e.message}`);
  }
  try {
    const settings = await callApi('freebooks_read', {
      action: 'settings.list',
      params: {},
    });
    ctx.businessProfile = settings || null;
  } catch (e) {
    // settings.list may not exist as a distinct action; non-fatal
  }
  try {
    ctx.matchingHistory = await callApi('matching_history.query', {
      // no specific signals → recent history for context
      limit: 50,
    }) || [];
  } catch (e) {
    // matching_history.query may not be wired yet in v1; non-fatal
  }
  return ctx;
}

// ── Bill processing ──────────────────────────────────────────────────────────

/**
 * Process a bill attachment: extract supplier-invoice data, create a draft bill
 * (agent-data-feeding-guide §4.5b / bank-matching-spec §10.4a). The extraction
 * step is a PLACEHOLDER — the operator wires in OCR/PDF parsing.
 * @param {object} ev
 * @param {object} payload
 */
async function processBill(ev, payload) {
  const attachmentId = ev.entity_id;
  let att;
  try {
    att = await fetchAttachment(attachmentId);
  } catch (e) {
    err(`bill ${attachmentId}: fetch failed: ${e.message}`);
    return;
  }

  // PLACEHOLDER: extract bill data (vendor, amount, due date, line items, currency).
  // The operator wires in OCR/PDF extraction here. Until then we create a
  // skeleton draft so the inbox surfaces the document for human entry.
  const bill = extractBillData(att, payload);
  if (!bill) {
    warn(`bill ${attachmentId}: extraction returned no data (skipped)`);
    return;
  }

  try {
    const result = await callApi('bill.create', { bill });
    log(`bill ${attachmentId}: draft created (bill_id=${result && result.bill_id || '?'})`);
  } catch (e) {
    err(`bill ${attachmentId}: bill.create failed: ${e.message}`);
  }
}

/**
 * PLACEHOLDER bill extraction. Returns a skeleton draft bill object so the
 * document surfaces in the inbox for human completion. Replace with OCR/PDF
 * parsing (pymupdf, marker-pdf, a vendor API, etc.) to populate vendor,
 * amount, due_date, and line items automatically.
 *
 * The bill object shape mirrors bill.create: { vendor?, date?, due_date?,
 * lines?, currency?, ... }. vendor/date are optional for draft creation
 * (saveDraftBill allows skeleton drafts).
 *
 * @param {{contentType:string, filename:string, buffer:Buffer, text:string}} att
 * @param {object} payload - event payload (has filename, contentType)
 * @returns {object|null} bill object, or null to skip
 */
function extractBillData(att, payload) {
  // Skeleton draft: no vendor/amount yet — the human fills these in the inbox
  // editor. The attachment is already linked via the event's entity_id, so the
  // reviewer can open the PDF from the bill draft.
  warn(`bill ${payload.filename || att.filename}: extraction not implemented — creating skeleton draft (human completes in inbox).`);
  return {
    // date / due_date intentionally absent → skeleton; saveDraftBill allows it.
    currency: null,
    lines: [],
    _source_attachment_id: payload.entityId || null,
    _source_filename: payload.filename || att.filename || null,
  };
}

// ── Event routing ────────────────────────────────────────────────────────────

/**
 * Route one attachment.uploaded event by its payload entityType.
 * @param {object} ev - event row { event_seq, event_type, entity_type, entity_id, payload, ... }
 */
async function processEvent(ev) {
  let payload;
  try {
    payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
  } catch (e) {
    warn(`event ${ev.event_seq}: unparseable payload — skipped`);
    return;
  }
  if (!payload) {
    warn(`event ${ev.event_seq}: empty payload — skipped`);
    return;
  }

  const entityType = payload.entityType;
  log(`event ${ev.event_seq}: attachment.uploaded entityType=${entityType || '?'} filename=${payload.filename || '?'}`);

  switch (entityType) {
    case 'bank_statement':
      await processBankStatement(ev, payload);
      break;
    case 'bill':
      await processBill(ev, payload);
      break;
    case 'journal_proposal':
      // already a proposal, not a statement — skip
      log(`event ${ev.event_seq}: journal_proposal attachment — skipped (not a statement)`);
      break;
    default:
      log(`event ${ev.event_seq}: unknown entityType '${entityType}' — skipped`);
  }
}

// ── Poll cycle ───────────────────────────────────────────────────────────────

/**
 * Run one poll cycle: fetch new attachment.uploaded events after the last
 * seen event_seq, process each, and persist the cursor.
 * @returns {Promise<number>} number of events processed this cycle
 */
async function pollOnce() {
  let events;
  try {
    events = await callApi('event.list', {
      after_seq: lastSeq,
      type: 'attachment.uploaded',
      limit: 100,
    });
  } catch (e) {
    err(`event.list failed: ${e.message}`);
    return 0;
  }
  if (!Array.isArray(events) || events.length === 0) return 0;

  for (const ev of events) {
    // advance cursor BEFORE processing so a crash mid-event doesn't reprocess
    // (at-most-once-ish; the event_seq is monotonic). The trade-off: a failed
    // event is not retried on the next cycle. The operator can reset the cursor
    // file to re-run. This matches the spec's polling contract (§3.3).
    if (Number(ev.event_seq) > lastSeq) lastSeq = Number(ev.event_seq);
    try {
      await processEvent(ev);
    } catch (e) {
      // processEvent should catch its own errors; this is a safety net so one
      // bad event never crashes the loop.
      err(`event ${ev.event_seq}: unhandled error: ${e.message}`);
    }
    if (shuttingDown) break;
  }

  saveCursor();
  return events.length;
}

// ── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  // Config validation
  if (!FREEBOOKS_USER) {
    err('FREEBOOKS_USER is required (agent-role account email)');
    process.exit(1);
  }
  if (!FREEBOOKS_COMPANY) {
    err('FREEBOOKS_COMPANY is required (company id)');
    process.exit(1);
  }

  loadCursor();

  if (ONCE) {
    log(`--once: polling ${API_URL} (after_seq=${lastSeq})`);
    const n = await pollOnce();
    log(`--once: processed ${n} event(s), cursor at ${lastSeq}`);
    return;
  }

  log(`agent loop started: ${API_URL} company=${FREEBOOKS_COMPANY} user=${FREEBOOKS_USER} interval=${POLL_INTERVAL_MS}ms cursor=${lastSeq}`);

  // Graceful shutdown
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${sig}, shutting down after current event…`);
    // give the current processEvent a moment to finish; the loop checks
    // shuttingDown between events.
    saveCursor();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Long-running poll loop
  while (!shuttingDown) {
    try {
      await pollOnce();
    } catch (e) {
      // pollOnce catches its own errors, but guard the loop anyway.
      err(`poll cycle error: ${e.message}`);
    }
    if (shuttingDown) break;
    // sleep POLL_INTERVAL_MS, but wake early on signal (shuttingDown set)
    await sleep(POLL_INTERVAL_MS);
  }
  log('agent loop stopped');
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // allow the timer to keep the process from exiting prematurely; cleared on resolve
    t.unref?.();
  });
}

main().catch((e) => {
  err(`fatal: ${e.stack || e.message}`);
  process.exit(ONCE ? 2 : 1);
});