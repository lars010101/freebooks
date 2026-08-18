'use strict';
/**
 * freeBooks — Journal entry service
 * Ported from BigQuery Cloud Function to DuckDB/Express.
 *
 * Key DuckDB simplifications:
 * - No streaming buffer — UPDATE/DELETE work immediately
 * - reversed_by is written directly on the original batch via UPDATE
 * - No QUALIFY workaround needed for latest-row patterns (or use ROW_NUMBER subquery)
 */

const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert } = require('./db');
const { validateJournalBatch } = require('./validation');
// P2-4a: journal entries are tax-exclusive — the entered debit/credit IS the net.
// VAT is computed on top (amount × rate) and posted as separate per-code GL
// lines, mirroring bills.js:396-414. computeVatSplit (now computeVatSplitGross)
// is no longer used here — it remains for bank import (tax-INCLUSIVE) only.
const { auditLog } = require('./audit');
const { emitEvent } = require('./events');
const { normalizeDescription } = require('./mapping-utils');
const { deriveProfitCenter, isDerivationEnabled } = require('./centers');
const { getRate } = require('./fx');

async function handleJournal(ctx, action) {
  switch (action) {
    case 'journal.post':    return postEntry(ctx);
    case 'journal.reverse': return reverseEntry(ctx);
    case 'journal.list':    return listEntries(ctx);
    case 'journal.import':  return importEntries(ctx);
    case 'journal.search':  return searchEntries(ctx);
    case 'journal.get':     return getEntry(ctx);
    case 'journal.account_lines':   return accountLines(ctx);
    case 'journal.account_balance': return accountBalance(ctx);
    case 'journal.entry.update': return updateEntryDescription(ctx);
    // A3j (§4.3): journal proposal prepare/approve flow.
    case 'journal.propose':       return proposeEntry(ctx);
    case 'journal.approve':       return approveProposal(ctx);
    case 'journal.reject':        return rejectProposal(ctx);
    case 'journal.proposal.list': return listProposals(ctx);
    case 'journal.proposal.get':  return getProposal(ctx);
    default:
      throw Object.assign(new Error(`Unknown journal action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

// ── A3j (§4.3): shared enrichment + validation, and shared post core ───────
// Both journal.post and journal.approve call these so there is ONE posting
// path — no divergent logic. enrichAndValidate does VAT split, FX, balance
// check, and account/period/window validation (exactly today's journal.post
// machinery). postJournalBatch inserts journal_entries rows, generates the
// reference, and emits journal.posted (the A2 emit moved here so BOTH
// journal.post and the post inside journal.approve emit it, per §3.2).

/**
 * Enrich and validate a set of journal lines for a company.
 * Returns { enrichedLines, warnings, validation } where validation is the
 * raw { valid, errors, warnings } from validateJournalBatch. Callers decide
 * how to surface failures (throwValidation maps period-locked → PERIOD_LOCKED).
 */
async function enrichAndValidate(companyId, lines) {
  if (!lines || !Array.isArray(lines) || lines.length === 0) {
    throw Object.assign(new Error('lines array required'), { code: 'INVALID_INPUT' });
  }

  const companies = await query(
    `SELECT currency, vat_registered FROM companies WHERE company_id = @companyId LIMIT 1`,
    { companyId }
  );
  if (companies.length === 0) throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });
  const company = companies[0];

  const enrichedLines = [];
  for (const line of lines) {
    const currency = line.currency || company.currency;
    // §1.4: explicit fx_rate if >0, else getRate fallback, else throw.
    // Mirrors bills.js:144-157 so foreign-currency manual entries never
    // silently default to fx_rate=0 (zeroing debit_home/credit_home).
    let fxRate = 1.0;
    if (currency !== company.currency) {
      if (line.fx_rate && Number(line.fx_rate) > 0) {
        fxRate = Number(line.fx_rate);
      } else {
        const resolved = await getRate(currency, company.currency, String(line.date).substring(0, 10));
        if (resolved === null) {
          throw Object.assign(
            new Error(`No FX rate found for ${currency} \u2192 ${company.currency} on ${line.date}. Add the rate in Settings \u2192 Exchange Rates.`),
            { code: 'INVALID_INPUT' }
          );
        }
        fxRate = resolved;
      }
    }
    const debit = line.debit || 0;
    const credit = line.credit || 0;

    let vatAmount = 0, vatAmountHome = 0, netAmount = 0, netAmountHome = 0;
    let vatMeta = null;
    if (line.vat_code && company.vat_registered) {
      const vcRows = await query(
        `SELECT rate, vat_account_input, vat_account_output, is_reverse_charge
         FROM vat_codes WHERE company_id = @companyId AND vat_code = @vatCode AND is_active = true LIMIT 1`,
        { companyId, vatCode: line.vat_code }
      );
      if (vcRows.length > 0) {
        const vc = vcRows[0];
        const rate = Number(vc.rate);
        const isDebit = debit > 0;
        const amount = debit || credit;
        netAmount = amount;                                    // tax-exclusive: entered amount IS the net
        vatAmount = Math.round(amount * rate * 100) / 100;
        vatAmountHome = vatAmount * fxRate;
        netAmountHome = netAmount * fxRate;
        vatMeta = {
          rate,
          inputAccount: vc.vat_account_input,
          outputAccount: vc.vat_account_output,
          isReverseCharge: !!vc.is_reverse_charge,
          isDebit,
        };
      }
    }

    enrichedLines.push({ ...line, currency, fx_rate: fxRate, debit, credit, debit_home: debit * fxRate, credit_home: credit * fxRate, vat_amount: vatAmount, vat_amount_home: vatAmountHome, net_amount: netAmount, net_amount_home: netAmountHome, _vatMeta: vatMeta });
  }

  // P2-4a: expand VAT-bearing lines into separate per-code GL lines BEFORE
  // validation so the balance check sees the final balanced set (net + VAT GL
  // lines = gross offset). Mirrors bills.js:396-414. Without this the
  // tax-exclusive entry (net on the taxable line, gross on the offset) would
  // fail the pre-expansion balance check by exactly the computed VAT.
  const expandedLines = expandJournalVatLines(enrichedLines);

  // Spec §4a: derive profit_center from cost_center when derivation is enabled.
  // This is the shared path for journal.post AND journal.approve re-validation.
  // isReversal is detected from the batch/lines — reversed entries carry
  // `reverses` set to the original batch_id. For the enrichAndValidate path
  // (direct posts and approvals), lines don't carry `reverses` (it's set in
  // postJournalBatch's row builder), so isReversal is always false here.
  // Reversals go through reverseEntry which copies cost_center/profit_center
  // directly and doesn't call enrichAndValidate.
  const derivationEnabled = await isDerivationEnabled(companyId);
  if (derivationEnabled) {
    for (const line of expandedLines) {
      if (line.cost_center) {
        line.profit_center = await deriveProfitCenter(companyId, line.cost_center);
      } else if (line.profit_center) {
        // Direct profit-center-only posting (no cost driver) — validate it
        // resolves to an actual Profit-type center.
        const [pc] = await query(
          `SELECT center_type FROM centers WHERE company_id = @companyId AND center_id = @profitCenterId`,
          { companyId, profitCenterId: line.profit_center }
        );
        if (!pc || pc.center_type !== 'Profit') {
          throw new Error(`${line.profit_center} is not a valid profit center`);
        }
      }
    }
  }

  const validation = await validateJournalBatch(companyId, expandedLines);
  return { enrichedLines: expandedLines, warnings: validation.warnings, validation };
}

/**
 * P2-4a: expand VAT-bearing enriched journal lines into separate per-code GL
 * lines, mirroring bills.js:396-414.
 *
 *  - Standard (non-RC) VAT: one GL line per VAT code. Input account for debit
 *    lines (expense), output account for credit lines (revenue).
 *  - Reverse-charge (RC) VAT: a DR input + CR output pair per code (nets to
 *    zero — self-assessed).
 *  - Original lines keep their entered debit/credit (the net); the line-level
 *    vat_code is nulled and vat_amount zeroed (the VAT lives on the GL lines).
 *
 * Lines carrying no `_vatMeta` pass through untouched. Non-VAT batches are a
 * no-op (returns the input with any stray `_vatMeta` stripped).
 */
function expandJournalVatLines(enrichedLines) {
  if (!Array.isArray(enrichedLines)) return enrichedLines;
  const hasVat = enrichedLines.some((l) => l && l._vatMeta);
  if (!hasVat) {
    // No VAT on any line — strip the (null) _vatMeta placeholder and return.
    return enrichedLines.map(({ _vatMeta, ...rest }) => rest);
  }

  // Group VAT by code. Capture a template (date/currency/fx_rate/…) from the
  // first contributing line so the generated GL lines carry valid batch fields.
  const stdByCode = {}; // code -> { vatAccount, isDebit, computed, net, rate, desc, tpl }
  const rcByCode = {};  // code -> { inputAccount, outputAccount, computed, net, rate, desc, tpl }

  for (const line of enrichedLines) {
    const meta = line._vatMeta;
    if (!meta) continue;
    const code = line.vat_code;
    const tpl = {
      date: line.date, currency: line.currency, fx_rate: line.fx_rate,
      source: line.source, cost_center: line.cost_center || null,
      profit_center: line.profit_center || null, bill_id: line.bill_id || null,
    };
    if (meta.isReverseCharge) {
      const b = rcByCode[code] || (rcByCode[code] = {
        inputAccount: meta.inputAccount, outputAccount: meta.outputAccount,
        computed: 0, net: 0, rate: meta.rate, desc: line.description || '', tpl,
      });
      b.computed += line.vat_amount;
      b.net += line.net_amount;
    } else {
      const vatAccount = meta.isDebit ? meta.inputAccount : meta.outputAccount;
      const b = stdByCode[code] || (stdByCode[code] = {
        vatAccount, isDebit: meta.isDebit, computed: 0, net: 0, rate: meta.rate,
        desc: line.description || '', tpl,
      });
      b.computed += line.vat_amount;
      b.net += line.net_amount;
    }
  }

  // Original lines: zero the line-level VAT (it lives on the GL lines now);
  // net_amount = the entered amount (the net).
  const out = enrichedLines.map((line) => {
    const { _vatMeta, ...rest } = line;
    if (!_vatMeta) return rest;
    const amount = rest.debit || rest.credit || 0;
    const fx = rest.fx_rate || 1;
    return {
      ...rest,
      vat_code: null,
      vat_amount: 0,
      vat_amount_home: 0,
      net_amount: amount,
      net_amount_home: amount * fx,
    };
  });

  // Standard VAT GL lines: one per code (DR for expense, CR for revenue).
  for (const code of Object.keys(stdByCode)) {
    const b = stdByCode[code];
    const vatAmount = Math.round(b.computed * 100) / 100;
    if (vatAmount === 0) continue;
    const fx = b.tpl.fx_rate || 1;
    out.push({
      account_code: b.vatAccount,
      debit: b.isDebit ? vatAmount : 0,
      credit: b.isDebit ? 0 : vatAmount,
      date: b.tpl.date,
      currency: b.tpl.currency,
      fx_rate: b.tpl.fx_rate,
      debit_home: (b.isDebit ? vatAmount : 0) * fx,
      credit_home: (b.isDebit ? 0 : vatAmount) * fx,
      vat_code: code,
      vat_amount: vatAmount,
      vat_amount_home: vatAmount * fx,
      net_amount: 0,
      net_amount_home: 0,
      description: `${b.desc} (VAT ${(b.rate * 100).toFixed(0)}%)`.trim(),
      reference: null,
      source: b.tpl.source,
      cost_center: b.tpl.cost_center,
      profit_center: b.tpl.profit_center,
      bill_id: b.tpl.bill_id,
    });
  }

  // RC VAT GL lines: DR input + CR output per code (nets to zero — self-assessed),
  // matching bills.js:412-413.
  for (const code of Object.keys(rcByCode)) {
    const b = rcByCode[code];
    const vatAmount = Math.round(b.computed * 100) / 100;
    if (vatAmount === 0) continue;
    const fx = b.tpl.fx_rate || 1;
    out.push({
      account_code: b.inputAccount,
      debit: vatAmount, credit: 0,
      date: b.tpl.date, currency: b.tpl.currency, fx_rate: b.tpl.fx_rate,
      debit_home: vatAmount * fx, credit_home: 0,
      vat_code: code, vat_amount: vatAmount, vat_amount_home: vatAmount * fx,
      net_amount: 0, net_amount_home: 0,
      description: `${b.desc} (input VAT RC)`.trim(),
      reference: null, source: b.tpl.source, cost_center: b.tpl.cost_center,
      profit_center: b.tpl.profit_center, bill_id: b.tpl.bill_id,
    });
    out.push({
      account_code: b.outputAccount,
      debit: 0, credit: vatAmount,
      date: b.tpl.date, currency: b.tpl.currency, fx_rate: b.tpl.fx_rate,
      debit_home: 0, credit_home: vatAmount * fx,
      vat_code: code, vat_amount: vatAmount, vat_amount_home: vatAmount * fx,
      net_amount: 0, net_amount_home: 0,
      description: `${b.desc} (output VAT RC)`.trim(),
      reference: null, source: b.tpl.source, cost_center: b.tpl.cost_center,
      profit_center: b.tpl.profit_center, bill_id: b.tpl.bill_id,
    });
  }

  return out;
}

/**
 * Map a validation failure to the right dispatch error code. A period-locked
 * failure surfaces PERIOD_LOCKED (the same code journal.post would give for a
 * locked-period post, per §4.3 approve-time revalidation); everything else is
 * VALIDATION. This keeps journal.post and journal.approve error codes aligned.
 */
function throwValidation(validation) {
  const errs = validation.errors || [];
  const msg = errs.join('; ');
  if (errs.some((e) => /locked period/i.test(String(e)))) {
    throw Object.assign(new Error(msg), { code: 'PERIOD_LOCKED', details: { errors: errs } });
  }
  throw Object.assign(new Error(msg), {
    code: 'VALIDATION',
    details: { errors: errs, warnings: validation.warnings },
  });
}

/**
 * Resolve the company's default journal (code 'MISC') for postings that
 * arrive without a journalId. Ratified 2026-08-02 (magnus): every posted
 * batch must carry a sequential {CODE}/{YYYY}/{NNNNN} reference — a missing
 * journalId defaults to MISC (warn-not-block, surfaced via response warnings)
 * instead of leaving reference null. Returns null only when no active MISC
 * journal exists (unseeded DB) — then the historical null-reference behavior
 * is preserved.
 */
async function resolveDefaultJournalId(companyId) {
  const rows = await query(
    `SELECT journal_id FROM journals WHERE company_id = @companyId AND code = 'MISC' AND active = true LIMIT 1`,
    { companyId }
  );
  return rows.length ? rows[0].journal_id : null;
}

/**
 * Resolve the company's default journal (code 'MISC') for reference minting.
 * Ratified 2026-08-02 (magnus): every posted batch must carry a sequential
 * reference — a missing journalId defaults to MISC (warn-not-block; never
 * land a batch with no verifikat-style number). Returns null only when the
 * company has no active MISC journal (unseeded/legacy DBs) — callers then
 * keep the pre-2026-08-02 null-reference behavior.
 */
async function resolveDefaultJournalId(companyId) {
  const rows = await query(
    `SELECT journal_id FROM journals WHERE company_id = @companyId AND code = 'MISC' AND active = true LIMIT 1`,
    { companyId }
  );
  return rows.length ? rows[0].journal_id : null;
}

/**
 * Insert journal_entries rows for a set of enriched lines, generate the
 * sequential reference (if journalId), and emit journal.posted (A2 §3.2).
 * `createdByEmail` is the email stamped on created_by — for journal.post it's
 * the caller; for journal.approve it's the approving HUMAN (R5: the ledger
 * row shows the human poster; the agent origin lives on the proposal + audit).
 * Returns { batchId, reference, lineCount, rows, defaultedToMisc }.
 */
async function postJournalBatch(ctx, { enrichedLines, journalId, createdByEmail, source = 'manual' }) {
  const companyId = ctx.companyId;
  const batchId = uuid();
  const now = new Date().toISOString();

  // Generate the sequential reference. No journalId → default MISC journal
  // (2026-08-02 doctrine above); defaultedToMisc lets callers warn.
  let autoReference = null;
  let effectiveJournalId = journalId || null;
  const defaultedToMisc = !effectiveJournalId;
  if (defaultedToMisc) effectiveJournalId = await resolveDefaultJournalId(companyId);
  if (effectiveJournalId) {
    // Verify the journal still exists (the old getNextReference checked this
    // implicitly via a JOIN to journals for the code prefix; without that JOIN,
    // this explicit check preserves the contract that posting to a deleted
    // journal fails).
    const jRows = await query(
      `SELECT 1 FROM journals WHERE journal_id = @journalId AND company_id = @companyId LIMIT 1`,
      { journalId: effectiveJournalId, companyId }
    );
    if (jRows.length === 0) throw new Error('Failed to generate reference: journal not found');
    const entryDate = enrichedLines[0].date;
    const year = parseInt(String(entryDate).substring(0, 4), 10);
    autoReference = await getNextReference(companyId, effectiveJournalId, year);
  }

  const rows = enrichedLines.map((line) => ({
    company_id: companyId,
    entry_id: uuid(),
    batch_id: batchId,
    date: line.date,
    account_code: line.account_code,
    debit: line.debit,
    credit: line.credit,
    currency: line.currency,
    fx_rate: line.fx_rate,
    debit_home: line.debit_home,
    credit_home: line.credit_home,
    vat_code: line.vat_code || null,
    vat_amount: line.vat_amount,
    vat_amount_home: line.vat_amount_home,
    net_amount: line.net_amount,
    net_amount_home: line.net_amount_home,
    description: line.description || null,
    reference: autoReference || line.reference || null,
    source,
    cost_center: line.cost_center || null,
    profit_center: line.profit_center || null,
    reverses: null,
    reversed_by: null,
    bill_id: line.bill_id || null,
    journal_id: effectiveJournalId || null,
    created_by: createdByEmail,
    created_at: now,
  }));

  await bulkInsert('journal_entries', rows);

  // A2 (§3.2): emit journal.posted on success. Emission lives inside
  // postJournalBatch so BOTH journal.post and the post inside journal.approve
  // emit it. R4 holds: this runs inside the handler, only on an idempotency
  // MISS — a replay short-circuits before reaching here.
  const totalDebit = rows.reduce((s, l) => s + Number(l.debit || 0), 0);
  await emitEvent(ctx, 'journal.posted', 'journal', batchId, {
    date: enrichedLines[0].date,
    reference: autoReference || rows[0].reference || null,
    description: rows[0].description || null,
    lineCount: rows.length,
    totalDebit: Math.round(totalDebit * 100) / 100,
    currency: rows[0].currency,
  });

  return { batchId, reference: autoReference, lineCount: rows.length, rows, defaultedToMisc };
}

// P0-5: read-only account activity queries for the bank UI. These replace
// the frontend's former use of the (now-gated) arbitrary-SQL /api/admin/query
// endpoint. Both return arrays so existing client handlers work unchanged.
async function accountLines(ctx) {
  const { companyId, body } = ctx;
  const { account_code } = body;
  if (!account_code) throw Object.assign(new Error('account_code required'), { code: 'INVALID_INPUT' });
  return query(
    `SELECT date, debit, credit FROM journal_entries
     WHERE company_id = @companyId AND account_code = @account_code
     ORDER BY date, entry_id`,
    { companyId, account_code }
  );
}

async function accountBalance(ctx) {
  const { companyId, body } = ctx;
  const { account_code } = body;
  if (!account_code) throw Object.assign(new Error('account_code required'), { code: 'INVALID_INPUT' });
  return query(
    `SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS balance FROM journal_entries
     WHERE company_id = @companyId AND account_code = @account_code`,
    { companyId, account_code }
  );
}

async function updateEntryDescription(ctx) {
  const { companyId, userEmail, body } = ctx;
  const { entryId, description, account_code, vat_code } = body;
  if (!entryId) throw Object.assign(new Error('entryId required'), { code: 'INVALID_INPUT' });

  // P0-3: posted-ledger integrity. Posted entries are append-only in
  // principle; the limited field edits allowed here (description, account,
  // vat code) must still respect reversal state and period locks, and must
  // never bypass the bill void workflow.
  const entryRows = await query(
    `SELECT entry_id, batch_id, date, description, account_code, vat_code, bill_id, reverses, reversed_by
     FROM journal_entries WHERE company_id = @companyId AND entry_id = @entryId LIMIT 1`,
    { companyId, entryId }
  );
  if (!entryRows.length) throw Object.assign(new Error('Journal entry not found'), { code: 'NOT_FOUND' });
  const entry = entryRows[0];

  if (entry.bill_id) {
    throw Object.assign(
      new Error('Entry belongs to a bill — void the bill instead of editing its journal lines'),
      { code: 'CONFLICT', details: { bill_id: entry.bill_id } }
    );
  }
  if (entry.reversed_by) {
    throw Object.assign(new Error('Entry has been reversed — post a new entry instead of editing'), { code: 'CONFLICT' });
  }
  if (entry.reverses) {
    throw Object.assign(new Error('Reversal entries cannot be edited'), { code: 'CONFLICT' });
  }

  const periods = await query(
    `SELECT period_name, start_date, end_date, locked FROM periods WHERE company_id = @companyId`,
    { companyId }
  );
  const entryDate = new Date(String(entry.date).substring(0, 10));
  const lockedHit = periods.find(
    (p) => p.locked && new Date(p.start_date) <= entryDate && new Date(p.end_date) >= entryDate
  );
  if (lockedHit) {
    throw Object.assign(
      new Error(`Entry date ${String(entry.date).substring(0, 10)} falls into a locked accounting period (${lockedHit.period_name})`),
      { code: 'PERIOD_LOCKED' }
    );
  }

  const setParts = [];
  const params = { companyId, entryId };
  const changes = {};

  if (description !== undefined) {
    setParts.push('description = @description');
    params.description = description || null;
    changes.description = { old: entry.description, new: params.description };
  }
  if (account_code !== undefined) {
    // Validate account exists in this company
    const accts = await query(
      `SELECT account_code FROM accounts WHERE company_id = @companyId AND account_code = @account_code LIMIT 1`,
      { companyId, account_code }
    );
    if (!accts.length) throw Object.assign(new Error('Account not found: ' + account_code), { code: 'INVALID_INPUT' });
    setParts.push('account_code = @account_code');
    params.account_code = account_code;
    changes.account_code = { old: entry.account_code, new: account_code };
  }
  if (vat_code !== undefined) {
    setParts.push('vat_code = @vat_code');
    params.vat_code = vat_code || null;
    changes.vat_code = { old: entry.vat_code, new: params.vat_code };
  }

  if (!setParts.length) return { updated: false };

  await exec(
    `UPDATE journal_entries SET ${setParts.join(', ')} WHERE company_id = @companyId AND entry_id = @entryId`,
    params
  );
  await auditLog(companyId, 'journal_entries', entryId, 'update', userEmail || 'unknown', changes);
  return { updated: true, entryId };
}

async function searchEntries(ctx) {
  const { companyId, body } = ctx;
  const { q } = body;
  if (!q || q.trim().length < 1) return [];
  const rows = await query(
    `SELECT batch_id, MIN(date) AS date, MAX(reference) AS reference, MAX(description) AS description
     FROM journal_entries
     WHERE company_id = @companyId
       AND reversed_by IS NULL
       AND (reference ILIKE @q OR description ILIKE @q OR batch_id ILIKE @q OR CAST(date AS TEXT) ILIKE @q)
     GROUP BY batch_id
     ORDER BY MIN(date) DESC
     LIMIT 20`,
    { companyId, q: `%${q.trim()}%` }
  );
  return rows;
}

async function getEntry(ctx) {
  const { companyId, body } = ctx;
  const { batchId } = body;
  if (!batchId) throw Object.assign(new Error('batchId required'), { code: 'INVALID_INPUT' });
  return query(
    `SELECT * FROM journal_entries WHERE company_id = @companyId AND batch_id = @batchId ORDER BY account_code`,
    { companyId, batchId }
  );
}

/**
 * Generate the next sequential reference for a journal.
 * Format: NNNNN (zero-padded to 5 digits, scoped per journal per year).
 * Atomically increments journal_sequences.last_seq and returns the new reference.
 */
async function getNextReference(companyId, journalId, year) {
  // Upsert: insert row if missing, then increment
  await exec(
    `INSERT INTO journal_sequences (company_id, journal_id, year, last_seq)
     VALUES (@companyId, @journalId, @year, 0)
     ON CONFLICT DO NOTHING`,
    { companyId, journalId, year }
  );
  await exec(
    `UPDATE journal_sequences SET last_seq = last_seq + 1
     WHERE company_id = @companyId AND journal_id = @journalId AND year = @year`,
    { companyId, journalId, year }
  );
  const rows = await query(
    `SELECT last_seq
     FROM journal_sequences
     WHERE company_id = @companyId AND journal_id = @journalId AND year = @year`,
    { companyId, journalId, year }
  );
  if (rows.length === 0) throw new Error('Failed to generate reference');
  return String(rows[0].last_seq).padStart(5, '0');
}

/**
 * Pre-allocate `count` sequential references in one atomic DB round-trip.
 * Returns array of reference strings in order.
 */
async function getNextReferenceBatch(companyId, journalId, year, count) {
  if (!count || count <= 0) return [];
  await exec(
    `INSERT INTO journal_sequences (company_id, journal_id, year, last_seq)
     VALUES (@companyId, @journalId, @year, 0)
     ON CONFLICT DO NOTHING`,
    { companyId, journalId, year }
  );
  await exec(
    `UPDATE journal_sequences SET last_seq = last_seq + @count
     WHERE company_id = @companyId AND journal_id = @journalId AND year = @year`,
    { companyId, journalId, year, count }
  );
  const rows = await query(
    `SELECT last_seq
     FROM journal_sequences
     WHERE company_id = @companyId AND journal_id = @journalId AND year = @year`,
    { companyId, journalId, year }
  );
  if (rows.length === 0) throw new Error('Failed to generate reference batch');
  const endSeq = Number(rows[0].last_seq);
  const startSeq = endSeq - count + 1;
  return Array.from({ length: count }, (_, i) =>
    String(startSeq + i).padStart(5, '0')
  );
}

async function postEntry(ctx) {
  const { companyId, userEmail, body } = ctx;
  const { lines, source = 'manual', journalId } = body;

  // A3j (§4.3): enrichment + validation is shared with journal.propose/approve.
  const { enrichedLines, warnings, validation } = await enrichAndValidate(companyId, lines);
  if (!validation.valid) throwValidation(validation);

  // A3j (§4.3): the insert core is shared with journal.approve. created_by is
  // the caller (journal.post) — for approve it's the approving human instead.
  const { batchId, reference, lineCount, defaultedToMisc } = await postJournalBatch(ctx, {
    enrichedLines, journalId, createdByEmail: userEmail, source,
  });

  // 2026-08-02 doctrine: no journalId → defaulted to MISC — warn, never block.
  const outWarnings = (warnings || []).concat(
    defaultedToMisc ? [`No journalId supplied — posted under default journal MISC (reference ${reference})`] : []
  );
  return { posted: true, batchId, reference, lineCount, warnings: outWarnings };
}
async function reverseEntry(ctx) {
  const { companyId, userEmail, body } = ctx;
  const { batchId, reversalDate } = body;

  if (!batchId) throw Object.assign(new Error('batchId required'), { code: 'INVALID_INPUT' });

  const original = await query(
    `SELECT * FROM journal_entries WHERE company_id = @companyId AND batch_id = @batchId`,
    { companyId, batchId }
  );
  if (original.length === 0) throw Object.assign(new Error('Entry not found'), { code: 'NOT_FOUND' });

  // DuckDB: check reversed_by directly (no streaming buffer issue)
  const existing = original[0];
  if (existing.reversed_by) throw Object.assign(new Error('Entry already reversed'), { code: 'ALREADY_REVERSED' });

  // Also check for reversal entries by reverses field
  const existingReversals = await query(
    `SELECT batch_id FROM journal_entries WHERE company_id = @companyId AND reverses = @batchId LIMIT 1`,
    { companyId, batchId }
  );
  if (existingReversals.length > 0) throw Object.assign(new Error('Entry already reversed'), { code: 'ALREADY_REVERSED' });

  const periods = await query(
    `SELECT period_name, start_date, end_date, locked FROM periods WHERE company_id = @companyId`,
    { companyId }
  );

  const rDate = reversalDate || new Date().toISOString().substring(0, 10);
  const rDateObj = new Date(rDate);
  const coveringPeriods = periods.filter((p) => new Date(p.start_date) <= rDateObj && new Date(p.end_date) >= rDateObj);

  if (coveringPeriods.length === 0) throw Object.assign(new Error(`Date ${rDate} does not fall within any defined period`), { code: 'PERIOD_UNDEFINED' });
  if (coveringPeriods.some((p) => p.locked)) throw Object.assign(new Error(`Date ${rDate} falls into a locked period`), { code: 'PERIOD_LOCKED' });

  const newBatchId = uuid();
  const now = new Date().toISOString();

  const reversalRows = original.map((line) => ({
    company_id: companyId,
    entry_id: uuid(),
    batch_id: newBatchId,
    date: rDate,
    account_code: line.account_code,
    debit: line.credit,
    credit: line.debit,
    currency: line.currency,
    fx_rate: line.fx_rate,
    debit_home: line.credit_home,
    credit_home: line.debit_home,
    vat_code: line.vat_code,
    vat_amount: line.vat_amount,
    vat_amount_home: line.vat_amount_home,
    net_amount: line.net_amount,
    net_amount_home: line.net_amount_home,
    description: `Reversal of ${line.reference || line.description || batchId}`,
    reference: `REV-${line.reference || batchId}`,
    source: 'reversal',
    cost_center: line.cost_center,
    profit_center: line.profit_center,
    reverses: batchId,
    reversed_by: null,
    bill_id: line.bill_id,
    created_by: userEmail,
    created_at: now,
  }));

  await bulkInsert('journal_entries', reversalRows);

  // DuckDB: UPDATE works immediately (no streaming buffer constraint)
  await exec(
    `UPDATE journal_entries SET reversed_by = @newBatchId WHERE company_id = @companyId AND batch_id = @batchId`,
    { companyId, batchId, newBatchId }
  );

  return { reversed: true, originalBatchId: batchId, reversalBatchId: newBatchId, lineCount: reversalRows.length };
}

async function listEntries(ctx) {
  const { companyId, body } = ctx;
  const { dateFrom, dateTo, accountCode, source, journalId, billId, sortBy = 'date', sortDir = 'DESC', limit = 500 } = body;

  let sql = `SELECT * FROM journal_entries WHERE company_id = @companyId`;
  const params = { companyId };

  if (dateFrom) { sql += ` AND date >= @dateFrom`; params.dateFrom = dateFrom; }
  if (dateTo) { sql += ` AND date <= @dateTo`; params.dateTo = dateTo; }
  if (accountCode) { sql += ` AND account_code = @accountCode`; params.accountCode = accountCode; }
  if (source) { sql += ` AND source = @source`; params.source = source; }
  if (journalId) { sql += ` AND journal_id = @journalId`; params.journalId = journalId; }
  if (billId) { sql += ` AND bill_id = @billId`; params.billId = billId; }

  const validSortCols = { date: 'date', reference: 'reference', account_code: 'account_code', debit: 'debit', credit: 'credit' };
  const sortCol = validSortCols[sortBy] || 'date';
  const dir = sortDir === 'ASC' ? 'ASC' : 'DESC';
  sql += ` ORDER BY ${sortCol} ${dir}, batch_id, account_code LIMIT @lim`;
  params.lim = Math.min(Number(limit) || 500, 2000);

  return query(sql, params);
}

async function importEntries(ctx) {
  const { companyId, userEmail, body } = ctx;
  const { entries } = body;

  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    throw Object.assign(new Error('entries array required'), { code: 'INVALID_INPUT' });
  }

  const companies = await query(
    `SELECT currency, vat_registered FROM companies WHERE company_id = @companyId LIMIT 1`,
    { companyId }
  );
  if (companies.length === 0) throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });
  const company = companies[0];

  const accounts = await query(
    `SELECT account_code, is_active FROM accounts WHERE company_id = @companyId`,
    { companyId }
  );
  const accountSet = new Set(accounts.filter((a) => a.is_active).map((a) => a.account_code));

  const periods = await query(
    `SELECT period_name, start_date, end_date, locked FROM periods WHERE company_id = @companyId`,
    { companyId }
  );

  const allRows = [];
  const allErrors = [];
  const validated = [];
  let referencesMinted = 0;
  const now = new Date().toISOString();

  // Pass 1: validate every entry BEFORE any reference is minted — a failed
  // (all-or-nothing) import must not burn journal sequence numbers.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const { lines, source = 'csv_import' } = entry;
    const batchId = entry.batchId || uuid();
    const entryErrors = [];

    if (!lines || lines.length === 0) { allErrors.push({ entry: i + 1, errors: ['Empty entry'] }); continue; }

    for (const line of lines) {
      if (!accountSet.has(line.account_code)) entryErrors.push(`Unknown account: ${line.account_code}`);
      if (!line.date) entryErrors.push('Missing date');
    }

    const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
    const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.005) entryErrors.push(`Unbalanced: DR ${totalDebit.toFixed(2)} ≠ CR ${totalCredit.toFixed(2)}`);

    for (const line of lines) {
      if (line.date) {
        const d = new Date(String(line.date).substring(0, 10));
        const covering = periods.filter((p) => new Date(p.start_date) <= d && new Date(p.end_date) >= d);
        if (covering.length === 0) { entryErrors.push(`Date ${line.date} not in any period`); break; }
        if (covering.some((p) => p.locked)) { entryErrors.push(`Period locked for date: ${line.date}`); break; }
      }
    }

    if (entryErrors.length > 0) { allErrors.push({ entry: i + 1, batchId, errors: entryErrors }); continue; }
    validated.push({ entry, lines, source, batchId });
  }

  if (allErrors.length > 0) {
    // Import is all-or-nothing: any entry failure means nothing was inserted.
    const summary = allErrors.map((e) => `Entry ${e.entry}: ${e.errors.join('; ')}`).join(' | ');
    throw Object.assign(new Error(`Import failed for ${allErrors.length} of ${entries.length} entries: ${summary}`), {
      code: 'VALIDATION',
      details: { errors: allErrors, failed: allErrors.length, totalEntries: entries.length },
    });
  }

  // Pass 2: mint references + build rows. Reference doctrine (ratified
  // 2026-08-02, magnus): an entry carrying NO reference on any line gets a
  // sequential one minted (entry.journalId, else the company's default MISC
  // journal) — entries that DO carry references keep them (source-system
  // voucher identity preserved on migration imports).
  for (const { entry, lines, source, batchId } of validated) {
    let entryRef = null;
    for (const line of lines) { if (line.reference) { entryRef = line.reference; break; } }
    if (!entryRef) {
      const jId = entry.journalId || (await resolveDefaultJournalId(companyId));
      if (jId) {
        const year = parseInt(String(lines[0].date).substring(0, 4), 10);
        entryRef = await getNextReference(companyId, jId, year);
        referencesMinted++;
      }
    }

    for (const line of lines) {
      const currency = line.currency || company.currency;
      // §1.4: explicit fx_rate if >0, else getRate fallback, else throw.
      // (Same pattern as enrichAndValidate above and bills.js:144-157.)
      let fxRate = 1.0;
      if (currency !== company.currency) {
        if (line.fx_rate && Number(line.fx_rate) > 0) {
          fxRate = Number(line.fx_rate);
        } else {
          const resolved = await getRate(currency, company.currency, String(line.date).substring(0, 10));
          if (resolved === null) {
            throw Object.assign(
              new Error(`No FX rate found for ${currency} \u2192 ${company.currency} on ${line.date}. Add the rate in Settings \u2192 Exchange Rates.`),
              { code: 'INVALID_INPUT' }
            );
          }
          fxRate = resolved;
        }
      }
      const debit = line.debit || 0;
      const credit = line.credit || 0;

      allRows.push({
        company_id: companyId,
        entry_id: uuid(),
        batch_id: batchId,
        date: line.date,
        account_code: line.account_code,
        debit,
        credit,
        currency,
        fx_rate: fxRate,
        debit_home: debit * fxRate,
        credit_home: credit * fxRate,
        vat_code: line.vat_code || null,
        vat_amount: 0,
        vat_amount_home: 0,
        net_amount: 0,
        net_amount_home: 0,
        description: line.description || null,
        reference: line.reference || entryRef || null,
        source,
        cost_center: line.cost_center || null,
        profit_center: line.profit_center || null,
        reverses: null,
        reversed_by: null,
        bill_id: line.bill_id || null,
        created_by: userEmail || 'import',
        created_at: now,
      });
    }
  }

  await bulkInsert('journal_entries', allRows);

  await auditLog(companyId, 'journal_entries', 'bulk', 'import', userEmail || 'import', null);

  return { imported: entries.length, failed: 0, totalEntries: entries.length, rowsInserted: allRows.length, referencesMinted, errors: [] };
}

// ── A3j (§4.3): journal proposal actions ───────────────────────────────────
// prepare/approve flow. An agent (or human) proposes; a human approves (which
// posts via postJournalBatch) or rejects (terminal). NOTHING reaches
// journal_entries from propose — only from approve (R5).

/**
 * A4 (§4.7): count attachments bound to a journal_proposal entity. Company-
 * scoped, entity_type='journal_proposal', entity_id=proposalId. Used at
 * propose time (response payload + no_underlag warning) and could be reused
 * by approve for diagnostics. Returns a non-negative integer.
 */
async function attachmentCountForProposal(companyId, proposalId) {
  const rows = await query(
    `SELECT count(*) AS c FROM attachments
     WHERE company_id = @companyId AND entity_type = 'journal_proposal' AND entity_id = @proposalId`,
    { companyId, proposalId }
  );
  return Number(rows[0].c) || 0;
}

/**
 * A4 (§4.7): build the propose-time warnings array. Merges the validation
 * warnings (from enrichAndValidate) with 'no_underlag' when the proposal has
 * zero bound attachments. R7: warn-not-block — the propose still succeeds
 * regardless of the underlag count.
 */
function buildProposeWarnings(validationWarnings, attachmentCount) {
  const out = Array.isArray(validationWarnings) ? [...validationWarnings] : [];
  if (attachmentCount === 0 && !out.includes('no_underlag')) {
    out.push('no_underlag');
  }
  return out;
}

/**
 * journal.propose — enrich + validate lines server-side, store a proposed row.
 * Mutating, idempotent (dispatch-level Idempotency-Key). With proposalId:
 * upsert a still-'proposed' row created by the SAME caller (extraction fixes /
 * idempotent retries) — cannot touch another actor's proposal (FORBIDDEN) nor a
 * non-proposed one (INVALID_STATUS). Emits journal.proposed ONLY on INSERT (a
 * same-proposalId upsert edit updates the row but does not re-emit; the
 * Idempotency-Key replay path is separately covered by the stored-response
 * short-circuit). Returns { proposalId, warnings }.
 */
async function proposeEntry(ctx) {
  const { companyId, userEmail, actor, requestId, body } = ctx;
  const { lines, journalId, reference, description, proposalId, source_transaction_id, _match_meta } = body;
  // Install-level trust: userEmail may be absent — the proposal's origin must
  // still be stamped (created_by is NOT NULL). House fallback, same as audit.
  const proposer = userEmail || 'anonymous';

  // Enrich + validate exactly like journal.post — but nothing reaches
  // journal_entries. The human reviews the computed results.
  const { enrichedLines, warnings, validation } = await enrichAndValidate(companyId, lines);
  if (!validation.valid) throwValidation(validation);

  // date = MIN(line dates) for list display + ordering
  const dates = enrichedLines.map((l) => String(l.date).substring(0, 10)).sort();
  const minDate = dates[0];
  const source = actor && actor.actorType === 'agent' ? 'agent' : 'human';
  const linesJson = JSON.stringify(enrichedLines);
  const now = new Date().toISOString();

  // UPSERT path: a proposalId was supplied (extraction fix / idempotent retry
  // with a caller-chosen id, or a re-propose with changed lines).
  // Phase A hardening — the upsert uses ONE conditional UPDATE...RETURNING:
  // WHERE status='proposed' AND created_by=@proposer is the race-decider (a
  // concurrent approve that flipped the status, or another actor's row, both
  // miss). On 0 rows we re-SELECT to distinguish not-yet-created (fall through
  // to insert), another actor's row (FORBIDDEN), or a non-proposed status
  // (INVALID_STATUS) — preserving the existing exact error messages.
  if (proposalId) {
    const upd = await query(
      `UPDATE journal_proposals
       SET lines = @lines, date = @date, reference = @ref, description = @desc,
           journal_id = @journalId, updated_at = @now,
           source_transaction_id = @sourceTxId,
           match_meta = @matchMeta
       WHERE company_id = @companyId AND proposal_id = @proposalId
         AND status = 'proposed' AND created_by = @proposer
       RETURNING proposal_id`,
      { companyId, proposalId, lines: linesJson, date: minDate, ref: reference || null, desc: description || null, journalId: journalId || null, now, proposer,
        sourceTxId: source_transaction_id || null, matchMeta: _match_meta ? JSON.stringify(_match_meta) : null }
    );
    if (upd.length > 0) {
      // UPDATE-in-place hit: replace lines/date/reference/description/journal_id.
      // created_at / created_by / request_id / source are NOT changed — the
      // origin is immutable, and a retried proposal must NOT jump the inbox
      // queue (created_at stays the original propose time). updated_at is
      // bumped to now() so the inbox ORDER BY updated_at reflects the most
      // recent touch without reordering on created_at. No journal.proposed
      // re-emit: the business fact 'a proposal exists' already happened (the
      // Idempotency-Key replay path is separately covered by the dispatch
      // stored-response short-circuit).
      //
      // A4 (§4.7): compute attachment_count + no_underlag warning on the upsert
      // path too — the caller may have uploaded underlag between the original
      // propose and this edit, so the count is freshly computed each time.
      const attachmentCount = await attachmentCountForProposal(companyId, proposalId);
      const upWarnings = buildProposeWarnings(warnings, attachmentCount);
      // Persist the recomputed warnings so the inbox review surface can
      // render inline warning icons without re-deriving them at read time.
      await exec(
        `UPDATE journal_proposals SET warnings = @warnings
         WHERE company_id = @companyId AND proposal_id = @proposalId`,
        { warnings: JSON.stringify(upWarnings), companyId, proposalId }
      );
      return { proposalId, warnings: upWarnings, attachment_count: attachmentCount };
    }
    // 0 rows: either no row yet, another actor's row, or a non-proposed status.
    const existing = await query(
      `SELECT status, created_by FROM journal_proposals
       WHERE company_id = @companyId AND proposal_id = @proposalId`,
      { companyId, proposalId }
    );
    if (existing.length > 0) {
      const row = existing[0];
      // Cannot touch another actor's proposal.
      if (String(row.created_by) !== String(proposer)) {
        throw Object.assign(new Error('Cannot upsert a proposal owned by another actor'), { code: 'FORBIDDEN' });
      }
      // Can only upsert a still-'proposed' row (posted/rejected are terminal).
      throw Object.assign(new Error(`Cannot upsert a proposal in status '${row.status}' (only 'proposed' is editable)`), { code: 'INVALID_STATUS' });
    }
    // proposalId supplied but no existing row → first creation with a
    // caller-chosen id. Insert + emit (same as the no-proposalId path).
  }

  const newProposalId = proposalId || uuid();
  const attachmentCount = await attachmentCountForProposal(companyId, newProposalId);
  const proposeWarnings = buildProposeWarnings(warnings, attachmentCount);
  await bulkInsert('journal_proposals', [{
    company_id: companyId,
    proposal_id: newProposalId,
    journal_id: journalId || null,
    date: minDate,
    reference: reference || null,
    description: description || null,
    source,
    lines: linesJson,
    status: 'proposed',
    batch_id: null,
    created_by: proposer,
    request_id: requestId || null,
    reviewed_by: null,
    reviewed_at: null,
    review_note: null,
    warnings: JSON.stringify(proposeWarnings),
    source_transaction_id: source_transaction_id || null,
    match_meta: _match_meta ? JSON.stringify(_match_meta) : null,
    created_at: now,
    updated_at: now,
  }]);

  // Emit journal.proposed ONLY on INSERT. Payload is a compact snapshot.
  await emitEvent(ctx, 'journal.proposed', 'proposal', newProposalId, {
    proposalId: newProposalId,
    date: minDate,
    reference: reference || null,
    description: description || null,
    lineCount: enrichedLines.length,
    totalDebit: Math.round(enrichedLines.reduce((s, l) => s + Number(l.debit || 0), 0) * 100) / 100,
    currency: enrichedLines[0].currency,
    source,
  });

  // A4 (§4.7): attachment_count + no_underlag warning already computed above
  // (before the INSERT) so the persisted warnings column is populated.
  // attachment_count is included in the response so the caller (and the
  // review surface) knows the source-document state without a second round-trip.
  return { proposalId: newProposalId, warnings: proposeWarnings, attachment_count: attachmentCount };
}

/**
 * journal.approve — proposed→posted. Re-validates (period lock, account
 * windows, balance) then posts via postJournalBatch with createdByEmail = the
 * approving human (journal_entries.created_by shows the HUMAN poster). Stamps
 * reviewed_by/at/note + batch_id on the proposal. Emits journal.approved
 * (journal.posted comes from postJournalBatch). Idempotent at dispatch level.
 */
async function approveProposal(ctx) {
  const { companyId, userEmail, body } = ctx;
  const { proposalId, note } = body;
  if (!proposalId) throw Object.assign(new Error('proposalId required'), { code: 'INVALID_INPUT' });

  // Phase A hardening: the initial SELECT is kept for error fidelity (NOT_FOUND
  // / INVALID_STATUS return the EXACT same messages as before). It is NOT the
  // authorization to post — that authorization is the atomic claim below. Two
  // concurrent approves used to both pass this check and double-post; the claim
  // makes the second one lose the race and surface INVALID_STATUS instead.
  const rows = await query(
    `SELECT proposal_id, journal_id, date, reference, description, source, lines, status, created_by,
            match_meta, source_transaction_id
     FROM journal_proposals WHERE company_id = @companyId AND proposal_id = @proposalId`,
    { companyId, proposalId }
  );
  if (rows.length === 0) throw Object.assign(new Error('Proposal not found'), { code: 'NOT_FOUND' });
  const proposal = rows[0];
  if (String(proposal.status) !== 'proposed') {
    throw Object.assign(new Error(`Cannot approve a proposal in status '${proposal.status}' (only 'proposed' can be approved)`), { code: 'INVALID_STATUS' });
  }

  // Re-validate at approve time: period locks and account active windows can
  // shift while a proposal sits. A proposal valid Monday must not post into a
  // period locked Tuesday. Runs the validation part of enrichAndValidate on the
  // stored enriched lines; a period-locked failure surfaces PERIOD_LOCKED
  // (throwValidation), the same code journal.post would give.
  // Phase A hardening: revalidation runs BEFORE any state mutation so a
  // locked-period failure leaves zero footprint (no posted status, no batch).
  let enrichedLines;
  try { enrichedLines = JSON.parse(proposal.lines); }
  catch { throw Object.assign(new Error('Proposal lines are not valid JSON'), { code: 'CONFLICT' }); }
  const revalidation = await validateJournalBatch(companyId, enrichedLines);
  if (!revalidation.valid) throwValidation(revalidation);

  // D3: same 'anonymous' fallback doctrine as proposeEntry (created_by NOT NULL
  // there; here it keeps attribution consistent under install-level trust).
  const reviewer = userEmail || 'anonymous';

  // Phase A hardening — ATOMIC CLAIM. A single UPDATE...RETURNING transitions
  // proposed→posted AND stamps the reviewer triple in one statement; the
  // WHERE status='proposed' guard is the race-decider. If 0 rows come back, we
  // lost the race (or the row vanished) — re-read for exact error fidelity.
  const now = new Date().toISOString();
  const claim = await query(
    `UPDATE journal_proposals
     SET status='posted', reviewed_by=@reviewedBy, reviewed_at=@now, review_note=@note
     WHERE company_id=@companyId AND proposal_id=@proposalId AND status='proposed'
     RETURNING proposal_id`,
    { reviewedBy: reviewer, now, note: note || null, companyId, proposalId });
  if (claim.length === 0) {
    // Lost a race between the SELECT above and the claim — re-read for error fidelity.
    const cur = await query(`SELECT status FROM journal_proposals WHERE company_id=@companyId AND proposal_id=@proposalId`, { companyId, proposalId });
    if (cur.length === 0) throw Object.assign(new Error('Proposal not found'), { code: 'NOT_FOUND' });
    throw Object.assign(new Error(`Cannot approve a proposal in status '${cur[0].status}' (only 'proposed' can be approved)`), { code: 'INVALID_STATUS' });
  }

  // Post via the shared core. created_by = the approving human (R5: the ledger
  // row shows the human poster; the agent origin lives on the proposal + audit).
  // Phase A hardening: postJournalBatch is wrapped so a posting failure (e.g. a
  // reference sequence gone missing) rolls the claim back instead of leaving the
  // proposal stuck status='posted' with no batch.
  let postResult;
  try {
    postResult = await postJournalBatch(ctx, {
      enrichedLines,
      journalId: proposal.journal_id || null,
      createdByEmail: reviewer,
      source: 'proposal',
    });
    // A4 (§4.7): re-point the proposal's bound attachments to the posted
    // batch — metadata only (blob storage paths do NOT move; the opaque
    // storage keys stay). Runs inside the same compensating-rollback wrapper
    // as the post so a failure here (or a post failure) rolls the claim back
    // to 'proposed' and leaves attachments bound to the proposal.
    await exec(
      `UPDATE attachments SET entity_type='journal', entity_id=@batchId
       WHERE company_id=@companyId AND entity_type='journal_proposal' AND entity_id=@proposalId`,
      { batchId: postResult.batchId, companyId, proposalId }
    );
  } catch (postErr) {
    // Compensating rollback. If postJournalBatch succeeded (postResult set)
    // but the A4 re-point failed, delete the just-posted ledger rows so no
    // orphan batch lingers — then restore the proposal to 'proposed'. The
    // batch_id IS NULL guard ensures we only touch rows that haven't been
    // finalized (batch_id is stamped only after this block succeeds).
    if (postResult) {
      try {
        await exec(
          `DELETE FROM journal_entries WHERE company_id=@companyId AND batch_id=@batchId`,
          { companyId, batchId: postResult.batchId }
        );
      } catch (delErr) {
        console.error(`CRITICAL: approve ledger cleanup failed for proposal ${proposalId} (batch ${postResult.batchId}):`, delErr.message);
      }
    }
    try {
      await exec(`UPDATE journal_proposals SET status='proposed', reviewed_by=NULL, reviewed_at=NULL, review_note=NULL WHERE company_id=@companyId AND proposal_id=@proposalId AND status='posted' AND batch_id IS NULL`, { companyId, proposalId });
    } catch (rbErr) {
      console.error(`CRITICAL: approve rollback failed for proposal ${proposalId} — row may be stuck status='posted' with batch_id NULL:`, rbErr.message);
    }
    throw postErr;
  }
  const { batchId, reference, lineCount } = postResult;

  // Finalize batch_id — the claim set status+reviewer; batch_id is stamped once
  // the post succeeded, so a rolled-back approve never carries a dangling batch_id.
  await exec(
    `UPDATE journal_proposals SET batch_id=@batchId WHERE company_id=@companyId AND proposal_id=@proposalId`,
    { batchId, companyId, proposalId }
  );

  // Emit journal.approved (journal.posted came from postJournalBatch).
  await emitEvent(ctx, 'journal.approved', 'proposal', proposalId, {
    proposalId,
    batchId,
    reference,
    lineCount,
    reviewedBy: reviewer,
  });

  // ── §1: Record outcome in matching_history ────────────────────────────────
  // Learning-store write attributed to the human who acted, same pattern as
  // retirement-on-reject (§10.5). Does not block the return on failure —
  // matching_history is a learning aid, not a ledger mutation.
  try {
    await recordMatchingOutcome(ctx, proposal, enrichedLines, 'approved_unedited');
  } catch (e) {
    console.error(`matching_history.record failed on approve ${proposalId}: ${e.message}`);
  }

  // ── §3.1: Crystallization on unedited tier-4 approval ─────────────────────
  // If this was a tier-4 (LLM) proposal approved unedited, suggest a mapping
  // rule so future occurrences match at tier 1 instead of hitting the LLM.
  try {
    await crystallizeMappingSuggestion(ctx, proposal, enrichedLines);
  } catch (e) {
    console.error(`mapping.suggest (crystallization) failed on approve ${proposalId}: ${e.message}`);
  }

  return {
    posted: true, proposalId, batchId, reference, lineCount,
    // 2026-08-02 doctrine: proposal without journal_id → defaulted to MISC — warn.
    ...(postResult.defaultedToMisc
      ? { warnings: [`Proposal had no journal — posted under default journal MISC (reference ${reference})`] }
      : {}),
  };
}

/**
 * journal.reject — proposed→rejected (terminal, never deleted). note is
 * REQUIRED (the agent reads the reason via event.list and re-proposes
 * corrected). Stamps the reviewer triple. Emits journal.rejected (payload
 * carries the note). Idempotent at dispatch level.
 */
async function rejectProposal(ctx) {
  const { companyId, userEmail, body } = ctx;
  const { proposalId, note } = body;
  if (!proposalId) throw Object.assign(new Error('proposalId required'), { code: 'INVALID_INPUT' });
  if (!note || String(note).trim() === '') {
    throw Object.assign(new Error('note is required to reject a proposal (the agent reads the reason and re-proposes corrected)'), { code: 'INVALID_INPUT' });
  }

  // Read the proposal for matching_history (§1) — the claim below is the
  // race-decider, but we need description/lines/match_meta for the learning
  // store write. If the proposal is already terminal we still surface the
  // exact error via the claim.
  const preRows = await query(
    `SELECT proposal_id, description, lines, source, match_meta
     FROM journal_proposals WHERE company_id = @companyId AND proposal_id = @proposalId`,
    { companyId, proposalId }
  );
  const proposal = preRows.length > 0 ? preRows[0] : null;

  // D3: same 'anonymous' fallback doctrine as proposeEntry/approve — keeps
  // attribution consistent under install-level trust.
  const reviewer = userEmail || 'anonymous';

  // Phase A hardening — ATOMIC CLAIM. A single conditional UPDATE...RETURNING
  // transitions proposed→rejected and stamps the reviewer triple; the
  // WHERE status='proposed' guard is the race-decider. On 0 rows re-read to
  // distinguish NOT_FOUND vs INVALID_STATUS with the existing exact messages.
  const now = new Date().toISOString();
  const claim = await query(
    `UPDATE journal_proposals
     SET status='rejected', reviewed_by=@reviewedBy, reviewed_at=@now, review_note=@note
     WHERE company_id=@companyId AND proposal_id=@proposalId AND status='proposed'
     RETURNING proposal_id`,
    { reviewedBy: reviewer, now, note: String(note), companyId, proposalId });
  if (claim.length === 0) {
    const cur = await query(`SELECT status FROM journal_proposals WHERE company_id=@companyId AND proposal_id=@proposalId`, { companyId, proposalId });
    if (cur.length === 0) throw Object.assign(new Error('Proposal not found'), { code: 'NOT_FOUND' });
    throw Object.assign(new Error(`Cannot reject a proposal in status '${cur[0].status}' (only 'proposed' can be rejected)`), { code: 'INVALID_STATUS' });
  }

  // Emit journal.rejected — payload carries the note so the agent reads the
  // reason via event.list and re-proposes corrected.
  await emitEvent(ctx, 'journal.rejected', 'proposal', proposalId, {
    proposalId,
    reviewedBy: reviewer,
    note: String(note),
  });

  // ── §1: Record outcome in matching_history ────────────────────────────────
  try {
    if (proposal) {
      let rejectedLines = null;
      try { rejectedLines = JSON.parse(proposal.lines); } catch { /* unparseable */ }
      await recordMatchingOutcome(ctx, proposal, rejectedLines, 'rejected');
    }
  } catch (e) {
    console.error(`matching_history.record failed on reject ${proposalId}: ${e.message}`);
  }

  return { rejected: true, proposalId };
}

/**
 * journal.proposal.list — queue data for the company. Viewer, non-mutating.
 * Params: status (default 'proposed'), limit (default 100). Ordered by date
 * DESC then updated_at DESC (newest work first — updated_at, NOT created_at,
 * so an idempotent upsert/re-propose does not jump the inbox queue: created_at
 * is immutable but updated_at reflects the most recent touch).
 *
 * The SQL lives in the shared `queryProposals` helper (also used by the A5
 * inbox.list aggregator, §10.3) so there is ONE proposal-list query — no
 * duplicated SQL. `includeLines` opts into the `lines` JSON column (inbox
 * needs it to compute the item `amount` = sum of line debits); the default
 * keeps journal.proposal.list's response shape byte-identical for its
 * existing callers (no `lines` field).
 */
async function queryProposals(companyId, { status, limit, includeLines = false } = {}) {
  const baseCols = `jp.proposal_id, jp.journal_id, jp.date, jp.reference, jp.description, jp.source, jp.status,
            jp.batch_id, jp.created_by, jp.request_id, jp.reviewed_by, jp.reviewed_at, jp.review_note, jp.created_at,
            jp.updated_at,
            jp.warnings,
            COALESCE(a.cnt, 0) AS attachment_count`;
  const cols = includeLines ? baseCols + ', jp.lines' : baseCols;
  return query(
    `SELECT ${cols}
     FROM journal_proposals jp
     LEFT JOIN (
       SELECT company_id, entity_id, count(*) AS cnt
       FROM attachments
       WHERE entity_type = 'journal_proposal'
       GROUP BY company_id, entity_id
     ) a ON a.company_id = jp.company_id AND a.entity_id = jp.proposal_id
     WHERE jp.company_id = @companyId AND jp.status = @status
     ORDER BY jp.date DESC, jp.updated_at DESC
     LIMIT @limit`,
    { companyId, status, limit }
  );
}

async function listProposals(ctx) {
  const { companyId, body } = ctx;
  const status = body.status && String(body.status).trim() !== '' ? String(body.status).trim() : 'proposed';
  const rawLimit = Number(body.limit);
  const limit = (Number.isFinite(rawLimit) && rawLimit > 0) ? Math.min(Math.floor(rawLimit), 1000) : 100;

  return queryProposals(companyId, { status, limit });
}

/**
 * journal.proposal.get — one proposal incl. parsed enriched lines, proposer,
 * request_id, review triple. Viewer, non-mutating.
 */
async function getProposal(ctx) {
  const { companyId, body } = ctx;
  const { proposalId } = body;
  if (!proposalId) throw Object.assign(new Error('proposalId required'), { code: 'INVALID_INPUT' });

  const rows = await query(
    `SELECT proposal_id, journal_id, date, reference, description, source, lines, status,
            batch_id, created_by, request_id, reviewed_by, reviewed_at, review_note, created_at
     FROM journal_proposals
     WHERE company_id = @companyId AND proposal_id = @proposalId`,
    { companyId, proposalId }
  );
  if (rows.length === 0) throw Object.assign(new Error('Proposal not found'), { code: 'NOT_FOUND' });
  const row = rows[0];
  // Parse the enriched-lines JSON for the client (the stored row shape).
  let lines = null;
  try { lines = JSON.parse(row.lines); } catch { lines = null; }
  const { lines: _omit, ...rest } = row;
  return { ...rest, lines };
}

// ── §1: matching_history.record helper ──────────────────────────────────────
// Called from approveProposal/rejectProposal. Assembles the fields from the
// stored proposal + match_meta and inserts directly into matching_history.
// This is a learning-store write, not a dispatchAction — same category as
// auditLog (a side effect of the human's action, attributed to the human).
async function recordMatchingOutcome(ctx, proposal, approvedLines, outcome) {
  const { companyId, userEmail } = ctx;

  // Parse match_meta if present
  let meta = null;
  try { meta = proposal.match_meta ? JSON.parse(proposal.match_meta) : null; }
  catch { /* unparseable — no metadata */ }

  if (!meta) return; // no match metadata → nothing to record (manual entry, etc.)

  // Normalize the description pattern (§3.3)
  const pattern = normalizeDescription(proposal.description || '');

  // Extract proposed dimensions from match_meta
  const proposedDimensions = meta.suggested_dimensions || null;

  // Extract approved dimensions from the match_meta's suggested_dimensions
  // (the agent proposed these; approve is currently unedited — no edit path).
  // Fall back to parsing the lines if suggested_dimensions is absent.
  let approvedDimensions = null;
  if (meta.suggested_dimensions) {
    approvedDimensions = meta.suggested_dimensions;
  } else if (approvedLines && Array.isArray(approvedLines)) {
    // Pick the offset account (the non-bank account) — the first line is
    // typically the bank account; the second is the offset.
    const accounts = [...new Set(approvedLines.map((l) => l.account_code).filter(Boolean))];
    // Heuristic: the offset account is the one that isn't the bank account.
    // We can't know the bank account here, so pick the account that appears
    // on the debit side of an outflow or credit side of an inflow — i.e.,
    // the non-dominant account. Simpler: pick the second unique account.
    const account = accounts.length > 1 ? accounts[1] : (accounts[0] || null);
    const vatCode = approvedLines.find((l) => l.vat_code)?.vat_code || null;
    approvedDimensions = { account, vat_code: vatCode, counterparty: null };
  }

  // Compute amount (sum of debits)
  let amount = null;
  if (approvedLines && Array.isArray(approvedLines)) {
    amount = approvedLines.reduce((s, l) => s + Number(l.debit || 0), 0);
  }

  const id = uuid();
  await exec(
    `INSERT INTO matching_history
       (id, company_id, bank_account, description_pattern, counterparty, amount,
        proposed_dimensions, approved_dimensions, source_type, confidence, evidence, outcome)
     VALUES
       (@id, @companyId, @bank_account, @description_pattern, @counterparty, @amount,
        @proposed_dimensions, @approved_dimensions, @source_type, @confidence, @evidence, @outcome)`,
    {
      id,
      companyId,
      bank_account: null,
      description_pattern: pattern || null,
      counterparty: null,
      amount,
      proposed_dimensions: proposedDimensions ? JSON.stringify(proposedDimensions) : null,
      approved_dimensions: approvedDimensions ? JSON.stringify(approvedDimensions) : null,
      source_type: meta.source_type || 'unknown',
      confidence: meta.confidence ? JSON.stringify(meta.confidence) : null,
      evidence: meta.evidence ? JSON.stringify(meta.evidence) : null,
      outcome,
    }
  );
}

// ── §3.1: Crystallization on unedited tier-4 approval ──────────────────────
// When a human approves a tier-4 (LLM) proposal unedited, call mapping.suggest
// so a rule is created for future occurrences. This is a side effect of the
// human's approval — the suggestion surfaces in the inbox as a Class B item.
async function crystallizeMappingSuggestion(ctx, proposal, approvedLines) {
  const { companyId, userEmail } = ctx;

  // Parse match_meta
  let meta = null;
  try { meta = proposal.match_meta ? JSON.parse(proposal.match_meta) : null; }
  catch { /* unparseable */ }

  if (!meta) return;

  // Only crystallize tier-4 LLM proposals (§3.1 step 1)
  if (meta.tier !== 4 && meta.source_type !== 'llm_semantic') return;

  // Determine the approved account — prefer suggested_dimensions from match_meta
  // (the agent's proposed account); fall back to the second unique account in
  // the lines (the offset, not the bank account).
  let account = null;
  if (meta.suggested_dimensions && meta.suggested_dimensions.account) {
    account = meta.suggested_dimensions.account;
  } else if (approvedLines && Array.isArray(approvedLines) && approvedLines.length > 0) {
    const accounts = [...new Set(approvedLines.map((l) => l.account_code).filter(Boolean))];
    account = accounts.length > 1 ? accounts[1] : (accounts[0] || null);
  }
  if (!account) return;

  // Determine the VAT code if present
  const vatCode = (meta.suggested_dimensions && meta.suggested_dimensions.vat_code)
    || (approvedLines && Array.isArray(approvedLines) ? approvedLines.find((l) => l.vat_code)?.vat_code : null)
    || null;

  // Normalize the pattern (§3.3)
  const pattern = normalizeDescription(proposal.description || '');
  if (!pattern) return;

  // Check whether an active rule already exists for this pattern (§3.1 step 4)
  const existingRules = await query(
    `SELECT mapping_id FROM bank_mappings
     WHERE company_id = @companyId AND is_active = true
       AND UPPER(pattern) = UPPER(@pattern)`,
    { companyId, pattern }
  );
  if (existingRules.length > 0) return; // rule exists, nothing to suggest

  // Check whether a pending suggestion already exists (§3.1 step 5)
  const existingSuggestions = await query(
    `SELECT suggestion_id FROM mapping_suggestions
     WHERE company_id = @companyId AND status = 'proposed'
       AND UPPER(description_pattern) = UPPER(@pattern)`,
    { companyId, pattern }
  );
  if (existingSuggestions.length > 0) return; // suggestion exists, don't duplicate

  // Determine the amount_sign from the approved lines (§5)
  const totalDebit = approvedLines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const totalCredit = approvedLines.reduce((s, l) => s + Number(l.credit || 0), 0);
  const amountSign = totalDebit > totalCredit ? 'positive' : 'negative';

  // Insert the suggestion directly (bypasses dispatchAction — same pattern as
  // recordMatchingOutcome: a side effect of the human's action, not a separate
  // agent decision). The suggestion surfaces in the inbox for human approval.
  const suggestionId = uuid();
  const now = new Date().toISOString();
  const evidenceJson = JSON.stringify([{
    type: 'crystallization',
    description: `Tier-4 LLM proposal approved unedited — suggesting rule for future matches`,
    source_proposal_id: proposal.proposal_id,
    source_type: meta.source_type,
    approved_account: account,
  }]);

  await bulkInsert('mapping_suggestions', [{
    company_id: companyId,
    suggestion_id: suggestionId,
    bank_account: null,
    description_pattern: pattern,
    suggested_account: account,
    suggested_vat_code: vatCode,
    suggested_dimensions: null,
    suggested_amount_sign: amountSign,
    suggested_match_type: 'contains',
    evidence: evidenceJson,
    source_proposal_id: proposal.proposal_id,
    status: 'proposed',
    created_by: userEmail || 'anonymous',
    reviewed_by: null,
    reviewed_at: null,
    created_at: now,
  }]);

  // Emit mapping.suggested event so the inbox picks it up
  await emitEvent(ctx, 'mapping.suggested', 'mapping_suggestion', suggestionId, {
    description_pattern: pattern,
    suggested_account: account,
    source_proposal_id: proposal.proposal_id,
  });
}

module.exports = { handleJournal, getNextReference, getNextReferenceBatch, enrichAndValidate, postJournalBatch, queryProposals };
