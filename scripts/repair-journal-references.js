#!/usr/bin/env node
'use strict';
/**
 * repair-journal-references.js — one-time data repair for the 2026-08-02
 * reference doctrine (ratified by magnus; see docs/agent-readiness-spec.md
 * §4.3 "Reference doctrine").
 *
 * Historical batches posted WITHOUT a journalId carry free text in
 * `reference` (e.g. "Bankkostnader", "Arets resultat") and NULL `description`.
 * This script renumbers those batches into sequential references
 * ({CODE}/{YYYY}/{NNNNN}, default journal code MISC) in chronological order
 * and moves the old free text into each line's empty `description`.
 *
 * SKIP rules (a batch is left untouched when ANY line's reference matches):
 *   ^[A-Z]+/\d{4}/\d{4,5}$   already-sequential (AP/2026/00001, MISC/2026/00001)
 *   ^REV-                    reversal batches (reference derives from the original)
 *   ^SIE(\s|$)               SIE import namespace ("SIE A 12", "SIE OB")
 *   ^[A-Z]{1,5}\d+$          legacy verifikat style (Visma "D1", "J6")
 *   ^\d+$                    pure-numeric legacy (QuickBooks-style voucher no)
 *
 * Numbering continues after max(journal_sequences.last_seq, highest existing
 * {CODE}/{YYYY}/% suffix) so repaired numbers never collide with live posting.
 * journal_sequences is upserted to the highest assigned number per year.
 *
 * Usage:
 *   node scripts/repair-journal-references.js --db /path/to/freebooks.duckdb [--company mdu_ab] [--code MISC] [--write]
 *
 * Default is DRY-RUN (prints the full mapping, writes nothing). Pass --write
 * to apply. STOP THE SERVER FIRST (DuckDB single-writer lock). Always take a
 * file copy backup before --write (cp freebooks.duckdb freebooks.duckdb.bak).
 * Idempotent: a re-run after --write finds no candidates and changes nothing.
 */

const path = require('path');
const { DuckDBInstance } = require(path.join(__dirname, '..', 'api', 'node_modules', '@duckdb', 'node-api'));

// ── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const DB_PATH = argValue('--db') || process.env.FREEBOOKS_DB_PATH;
const COMPANY = argValue('--company'); // null = all companies
const JOURNAL_CODE = (argValue('--code') || 'MISC').toUpperCase();
const WRITE = args.includes('--write');

if (!DB_PATH) {
  console.error('ERROR: pass --db <path> or set FREEBOOKS_DB_PATH');
  process.exit(2);
}

// ── Minimal named-param helpers (same $name binding style as api/src/db.js) ──
let _conn = null;
function bind(sql, params = {}) {
  const named = {};
  const finalSql = sql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
    if (!(name in params)) throw new Error(`Missing query parameter: ${name}`);
    named[name] = params[name];
    return `$${name}`;
  });
  return { finalSql, named };
}
function norm(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object' && typeof v.toJSON === 'function') {
    const j = v.toJSON();
    if (j instanceof Date) return j.toISOString().slice(0, 10);
    if (typeof j !== 'object') return j;
  }
  return v;
}
async function q(sql, params = {}) {
  const { finalSql, named } = bind(sql, params);
  const r = Object.keys(named).length ? await _conn.runAndReadAll(finalSql, named) : await _conn.runAndReadAll(finalSql);
  return r.getRowObjects().map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, norm(v)])));
}
async function x(sql, params = {}) {
  const { finalSql, named } = bind(sql, params);
  if (Object.keys(named).length) await _conn.run(finalSql, named);
  else await _conn.run(finalSql);
}

// ── Skip rules ───────────────────────────────────────────────────────────────
const SKIP_RULES = [
  { name: 'already-sequential', re: /^[A-Z]+\/\d{4}\/\d{4,5}$/ },
  { name: 'reversal (REV-)', re: /^REV-/ },
  { name: 'SIE namespace', re: /^SIE(\s|$)/ },
  { name: 'legacy verifikat (Visma-style)', re: /^[A-Z]{1,5}\d+$/ },
  { name: 'pure-numeric legacy', re: /^\d+$/ },
];
function skipReason(ref) {
  if (ref === null || ref === undefined || ref === '') return null;
  for (const r of SKIP_RULES) if (r.re.test(ref)) return r.name;
  return null;
}

async function main() {
  console.log(`DB:      ${DB_PATH}`);
  console.log(`Company: ${COMPANY || '(all)'}`);
  console.log(`Journal: ${JOURNAL_CODE}`);
  console.log(`Mode:    ${WRITE ? 'WRITE' : 'DRY-RUN (pass --write to apply)'}`);

  const inst = await DuckDBInstance.create(DB_PATH);
  _conn = await inst.connect();

  const companies = COMPANY
    ? [{ company_id: COMPANY }]
    : await q(`SELECT company_id FROM companies ORDER BY created_at`);

  let totalBatches = 0, totalLines = 0;

  for (const { company_id: companyId } of companies) {
    // MISC (or --code) journal for this company
    const jrows = await q(
      `SELECT journal_id FROM journals WHERE company_id = @c AND code = @code AND active = true LIMIT 1`,
      { c: companyId, code: JOURNAL_CODE }
    );
    if (jrows.length === 0) {
      console.log(`\n[${companyId}] SKIP — no active ${JOURNAL_CODE} journal`);
      continue;
    }
    const journalId = jrows[0].journal_id;

    // All batches with their line-level references
    const lines = await q(
      `SELECT batch_id, entry_id, date, reference, description
       FROM journal_entries WHERE company_id = @c ORDER BY date, batch_id, entry_id`,
      { c: companyId }
    );
    const byBatch = new Map();
    for (const l of lines) {
      if (!byBatch.has(l.batch_id)) byBatch.set(l.batch_id, []);
      byBatch.get(l.batch_id).push(l);
    }

    const candidates = [];
    const skipped = {};
    for (const [batchId, ls] of byBatch) {
      let reason = null;
      for (const l of ls) {
        reason = skipReason(l.reference);
        if (reason) break;
      }
      if (reason) { skipped[reason] = (skipped[reason] || 0) + 1; continue; }
      const hasAnyRef = ls.some((l) => l.reference && l.reference !== '');
      const allNullDesc = ls.every((l) => !l.description || l.description === '');
      candidates.push({
        batchId,
        date: String(ls[0].date).slice(0, 10),
        year: parseInt(String(ls[0].date).slice(0, 4), 10),
        oldRef: hasAnyRef ? (ls.find((l) => l.reference && l.reference !== '') || {}).reference : null,
        lineCount: ls.length,
        moveText: hasAnyRef && allNullDesc,
      });
    }
    candidates.sort((a, b) => a.date.localeCompare(b.date) || String(a.oldRef || '').localeCompare(String(b.oldRef || '')) || a.batchId.localeCompare(b.batchId));

    console.log(`\n[${companyId}] ${byBatch.size} batches total · ${candidates.length} candidates · skipped: ${Object.entries(skipped).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
    if (candidates.length === 0) continue;

    // Starting sequence per year: max(journal_sequences.last_seq, max existing suffix)
    const years = [...new Set(candidates.map((c) => c.year))];
    const seqByYear = {};
    for (const year of years) {
      const s = await q(
        `SELECT last_seq FROM journal_sequences WHERE company_id=@c AND journal_id=@j AND year=@y`,
        { c: companyId, j: journalId, y: year }
      );
      const existing = await q(
        `SELECT MAX(CAST(substr(reference, length(@pfx) + 1) AS INTEGER)) AS max_suffix
         FROM journal_entries WHERE company_id=@c AND reference LIKE @pfxlike`,
        { c: companyId, pfx: `${JOURNAL_CODE}/${year}/`, pfxlike: `${JOURNAL_CODE}/${year}/%` }
      );
      seqByYear[year] = Math.max(s.length ? Number(s[0].last_seq) : 0, Number(existing[0].max_suffix) || 0);
    }

    // Plan
    const plan = candidates.map((c) => {
      const seq = ++seqByYear[c.year];
      return { ...c, newRef: `${JOURNAL_CODE}/${c.year}/${String(seq).padStart(5, '0')}`, seq };
    });
    for (const p of plan) {
      console.log(`  ${p.date}  ${String(p.oldRef || '(null)').padEnd(45)} → ${p.newRef}  (${p.lineCount} lines${p.moveText ? ', text→description' : ''})`);
    }

    if (WRITE) {
      await x(`BEGIN TRANSACTION`);
      try {
        for (const p of plan) {
          await x(
            `UPDATE journal_entries
             SET reference = @newRef,
                 description = CASE WHEN (description IS NULL OR description = '') AND reference IS NOT NULL AND reference <> ''
                                    THEN reference ELSE description END
             WHERE company_id = @c AND batch_id = @b`,
            { newRef: p.newRef, c: companyId, b: p.batchId }
          );
        }
        for (const year of years) {
          await x(
            `INSERT INTO journal_sequences (company_id, journal_id, year, last_seq) VALUES (@c, @j, @y, 0) ON CONFLICT DO NOTHING`,
            { c: companyId, j: journalId, y: year }
          );
          await x(
            `UPDATE journal_sequences SET last_seq = GREATEST(last_seq, @seq) WHERE company_id=@c AND journal_id=@j AND year=@y`,
            { c: companyId, j: journalId, y: year, seq: seqByYear[year] }
          );
        }
        await x(`COMMIT`);
      } catch (e) {
        await x(`ROLLBACK`).catch(() => {});
        throw e;
      }
      totalBatches += plan.length;
      totalLines += plan.reduce((s, p) => s + p.lineCount, 0);
    }
  }

  console.log(`\n${WRITE ? `APPLIED: ${totalBatches} batches renumbered (${totalLines} lines updated).` : 'DRY-RUN complete — no changes written. Re-run with --write to apply.'}`);
  process.exit(0);
}

main().catch((e) => {
  if (/lock/i.test(e.message)) {
    console.error('ERROR: database is locked — stop the freebooks server first (DuckDB single-writer).');
  } else {
    console.error('ERROR:', e.message);
  }
  process.exit(1);
});
