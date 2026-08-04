'use strict';
/**
 * freeBooks — Periods section service (IA-spec step 4, §5.10, ratified 2026-08-04)
 *
 * Read-only actions behind the Periods page (/:company/periods):
 *   filing.list        — filing instances = pack descriptor × reporting interval,
 *                        with computed due dates (descriptor rules + settings
 *                        overrides), filed state (periods.tax_attrs.filings), and
 *                        artifact endpoint links. Params: { periodId? }.
 *   period.close_check — live close checklist for one period: engine items
 *                        (every company) + pack items (jurisdiction.json
 *                        closeChecklist[], closed op vocabulary). Params: { periodId }.
 *
 * Writes never live here: filed-state toggles and manual checklist attestations
 * flow through period.upsert tax_attrs (§5.10 — no new write surface).
 */

const path = require('path');
const fs = require('fs');
const { query } = require('./db');
const { getJurisdictionPack } = require('./jurisdiction-packs');

const PACKS_DIR = path.resolve(__dirname, '../../db/jurisdictions');

async function handlePeriodsService(ctx, action) {
  switch (action) {
    case 'filing.list': return listFilings(ctx);
    case 'period.close_check': return closeCheck(ctx);
    default:
      throw Object.assign(new Error(`Unknown periods action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

// ── Pack filings loader ───────────────────────────────────────────────────────
// Every filings/*.json in the company's jurisdiction pack is a filing source.
// Descriptors with an emitter/route (ink2) render file artifacts; the rest
// (annual-report, vat-return) link to report views. period_kind declares the
// interval: fiscal_year (default) | vat_period | month (v1: FY + vat_period).
function loadFilingDescriptors(jurisdiction) {
  const dir = path.join(PACKS_DIR, jurisdiction || 'SE', 'filings');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (e) { return []; }
  const out = [];
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      d.period_kind = d.period_kind || 'fiscal_year';
      out.push(d);
    } catch (e) { /* the pack linter (tests/jurisdiction-packs.mjs) owns parse failures */ }
  }
  return out;
}

// ── VAT intervals ─────────────────────────────────────────────────────────────
// v1: annual — one VAT interval per fiscal year (mdu_ab is annual). monthly /
// quarterly slot in here when a company needs them; the interval shape is the
// extension seam (spec §5.10: period_kind: vat_period).
function vatIntervalsFor(period, vatFrequency) {
  const freq = vatFrequency || 'annual';
  const s = String(period.start_date).slice(0, 10);
  const e = String(period.end_date).slice(0, 10);
  if (freq === 'monthly' || freq === 'quarterly') {
    const months = freq === 'monthly' ? 1 : 3;
    const out = [];
    let cur = s;
    while (cur <= e) {
      const end = addDays(addMonths(cur, months), -1);
      out.push({ start: cur, end: end > e ? e : end });
      const next = addDays(end, 1);
      if (next > e) break;
      cur = next;
    }
    return out;
  }
  return [{ start: s, end: e }];
}

function addMonths(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  // Clamp to the target month's last day: JS Date rolls overflow days into
  // the next month (Aug 31 + 6mo → Mar 3), which would land a statutory due
  // date days late. Period ends are month-ends by construction; the due date
  // must be too (INK2P4: 2026-08-31 + 6mo → 2027-02-28, not 2027-03-03).
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}
function addDays(ymd, n) {
  const dt = new Date(ymd + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// ── Due-date computation ──────────────────────────────────────────────────────
// Rules live in pack descriptors (data, per jurisdiction); manual overrides
// live in the settings key deadline_overrides (JSON: { "<instanceKey>": "YYYY-MM-DD" }).
// v1 rules: fy_end_plus_months (period end + N months) · nth_day_after_period_end
// (interval end + N days; month-end counting is a v2 refinement).
function computeDueDate(descriptor, period, interval) {
  const due = descriptor.due;
  if (!due || !due.rule) return null;
  const end = interval ? interval.end : String(period.end_date).slice(0, 10);
  if (due.rule === 'fy_end_plus_months') return addMonths(end, Number(due.months || 0));
  if (due.rule === 'nth_day_after_period_end') return addDays(end, Number(due.day || 0));
  return null;
}

// ── filing.list ───────────────────────────────────────────────────────────────
async function listFilings(ctx) {
  const { companyId, body } = ctx;
  const coRows = await query(
    `SELECT company_id, jurisdiction, vat_registered FROM companies
     WHERE company_id = @companyId ORDER BY created_at DESC LIMIT 1`, { companyId });
  if (!coRows.length) throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });
  const company = coRows[0];
  const jurisdiction = company.jurisdiction || 'SE';
  const descriptors = loadFilingDescriptors(jurisdiction);

  const settingsRows = await query(`SELECT key, value FROM settings WHERE company_id = @companyId`, { companyId });
  const settings = {};
  for (const r of settingsRows) settings[r.key] = r.value;
  let overrides = {};
  try { overrides = JSON.parse(settings.deadline_overrides || '{}'); } catch (e) { overrides = {}; }
  const vatFrequency = settings.vat_frequency || 'annual';

  let periodRows = await query(
    `SELECT period_name, start_date, end_date, locked, tax_attrs FROM (
       SELECT *, ROW_NUMBER() OVER(PARTITION BY period_name ORDER BY created_at DESC) AS rn
       FROM periods WHERE company_id = @companyId
     ) WHERE rn = 1 ORDER BY start_date DESC`, { companyId });
  if (body.periodId) periodRows = periodRows.filter((p) => p.period_name === body.periodId);

  const filings = [];
  for (const period of periodRows) {
    let taxAttrs = {};
    try { if (period.tax_attrs) taxAttrs = JSON.parse(period.tax_attrs); } catch (e) { taxAttrs = {}; }
    const filedStates = (taxAttrs && taxAttrs.filings) || {};
    const fyStart = String(period.start_date).slice(0, 10);
    const fyEnd = String(period.end_date).slice(0, 10);
    const year = fyStart.slice(0, 4);

    for (const d of descriptors) {
      if (d.period_kind === 'vat_period') {
        // Relevance-flag parity with Settings/Tax Codes: no VAT registration,
        // no VAT filing instances.
        if (!(company.vat_registered === true || String(company.vat_registered || '').toUpperCase() === 'TRUE')) continue;
        for (const iv of vatIntervalsFor(period, vatFrequency)) {
          const key = `${d.id}@${iv.start}`;
          filings.push({
            filing_id: d.id, name: d.name, authority: d.authority || '',
            period_id: period.period_name, period_kind: 'vat_period',
            interval_start: iv.start, interval_end: iv.end,
            due_date: overrides[key] || computeDueDate(d, period, iv),
            due_overridden: !!overrides[key],
            state: filedStates[key] && filedStates[key].filed_at ? 'filed' : 'draft',
            filed_at: filedStates[key] ? filedStates[key].filed_at || null : null,
            artifacts: [
              { kind: 'view', label: 'View VAT return',
                href: `/api/${companyId}/report?type=vat-return&start=${iv.start}&end=${iv.end}` },
            ],
          });
        }
      } else {
        const key = d.id;
        const artifacts = [];
        if (d.route) {
          artifacts.push({ kind: 'download', label: 'blanketter.sru', href: `/api/${companyId}/sru/ink2?year=${year}` });
          artifacts.push({ kind: 'download', label: 'INFO.SRU', href: `/api/${companyId}/sru/info?year=${year}` });
        } else if (d.id === 'annual-report') {
          artifacts.push({ kind: 'view', label: 'View annual report',
            href: `/api/${companyId}/report?type=ar&start=${fyStart}&end=${fyEnd}` });
          // SIE 4 export — the Gredor handoff artifact (2026-07-30 descope).
          const sieInteg = getJurisdictionPack(jurisdiction);
          if (sieInteg && sieInteg.integrations && sieInteg.integrations.sie && sieInteg.integrations.sie.export) {
            artifacts.push({ kind: 'download', label: 'SIE 4 export',
              href: `/api/${companyId}/report?type=sie&start=${fyStart}&end=${fyEnd}` });
          }
        }
        filings.push({
          filing_id: d.id, name: d.name, authority: d.authority || '',
          period_id: period.period_name, period_kind: 'fiscal_year',
          interval_start: fyStart, interval_end: fyEnd,
          due_date: overrides[key] || computeDueDate(d, period, null),
          due_overridden: !!overrides[key],
          state: filedStates[key] && filedStates[key].filed_at ? 'filed' : 'draft',
          filed_at: filedStates[key] ? filedStates[key].filed_at || null : null,
          artifacts,
        });
      }
    }
  }
  return { filings };
}

// ── period.close_check ────────────────────────────────────────────────────────
// Engine items (every company) + pack items (closed op vocabulary, validated
// by the pack linter). Every item: { id, label, kind, pass, detail, auto }.
async function closeCheck(ctx) {
  const { companyId, body } = ctx;
  if (!body.periodId) throw Object.assign(new Error('periodId required'), { code: 'INVALID_INPUT' });

  const coRows = await query(
    `SELECT company_id, jurisdiction, vat_registered FROM companies
     WHERE company_id = @companyId ORDER BY created_at DESC LIMIT 1`, { companyId });
  if (!coRows.length) throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });
  const company = coRows[0];
  const jurisdiction = company.jurisdiction || 'SE';

  const periodRows = await query(
    `SELECT period_name, start_date, end_date, tax_attrs FROM (
       SELECT *, ROW_NUMBER() OVER(PARTITION BY period_name ORDER BY created_at DESC) AS rn
       FROM periods WHERE company_id = @companyId AND period_name = @pid
     ) WHERE rn = 1`, { companyId, pid: body.periodId });
  if (!periodRows.length) throw Object.assign(new Error(`Period '${body.periodId}' not found`), { code: 'NOT_FOUND' });
  const period = periodRows[0];
  const s = String(period.start_date).slice(0, 10);
  const e = String(period.end_date).slice(0, 10);

  let taxAttrs = {};
  try { if (period.tax_attrs) taxAttrs = JSON.parse(period.tax_attrs); } catch (e) { taxAttrs = {}; }
  const manualState = (taxAttrs && taxAttrs.checklist) || {};

  const items = [];

  // Engine: inbox queue empty (A5 — agents never lock, but the human closing
  // the books needs the review queue drained first).
  const q = await query(
    `SELECT COUNT(*) AS n FROM journal_proposals WHERE company_id = @companyId AND status = 'proposed'`,
    { companyId });
  const open = Number(q[0].n) || 0;
  items.push({ id: 'inbox_empty', label: 'Inbox queue empty (no proposals awaiting review)',
    kind: 'engine', auto: true, pass: open === 0,
    detail: open === 0 ? 'No open proposals' : `${open} proposal(s) awaiting review` });

  // Pack items (jurisdiction.json closeChecklist[]).
  const pack = getJurisdictionPack(jurisdiction);
  for (const item of (pack && pack.closeChecklist) || []) {
    if (item.op === 'vat_return_done') {
      if (!(company.vat_registered === true || String(company.vat_registered || '').toUpperCase() === 'TRUE')) continue;
      const rows = await query(
        `SELECT COUNT(*) AS n FROM journal_entries
         WHERE company_id = @companyId AND date >= @s AND date <= @e AND vat_code IS NOT NULL`,
        { companyId, s, e });
      const n = Number(rows[0].n) || 0;
      items.push({ id: item.id, label: item.label, kind: item.kind || 'engine', auto: true,
        pass: n > 0, detail: n > 0 ? `${n} VAT-coded line(s) in period` : 'No VAT-coded activity in period' });
    } else if (item.op === 'contact_attrs_complete') {
      const settingsRows = await query(`SELECT key, value FROM settings WHERE company_id = @companyId`, { companyId });
      const contact = {};
      for (const r of settingsRows) {
        if (String(r.key).startsWith('contact_')) contact[String(r.key).slice(8)] = r.value;
      }
      const missing = [];
      for (const attr of (pack.contactAttributes || [])) {
        if (!attr.required) continue;
        const v = contact[attr.key];
        if (!v || !String(v).trim()) missing.push(attr.label || attr.key);
        else if (attr.format && !new RegExp(attr.format).test(String(v).trim())) missing.push(`${attr.label || attr.key} (format)`);
      }
      items.push({ id: item.id, label: item.label, kind: item.kind || 'engine', auto: true,
        pass: missing.length === 0,
        detail: missing.length === 0 ? 'All required contact attributes set' : `Missing: ${missing.join(', ')}` });
    } else if (item.op === 'tax_attr_set') {
      const v = taxAttrs ? taxAttrs[item.attr] : null;
      const set = v != null && String(v) !== '';
      items.push({ id: item.id, label: item.label, kind: item.kind || 'engine', auto: true,
        pass: set, detail: set ? `${item.attr} = ${v}` : `${item.attr} not set on the period` });
    } else if (item.op === 'manual') {
      const done = manualState[item.id] === true;
      items.push({ id: item.id, label: item.label, kind: 'manual', auto: false,
        pass: done, detail: done ? 'Attested' : 'Not attested (w toggles)' });
    }
  }

  return { period_id: body.periodId, items };
}

module.exports = { handlePeriodsService, loadFilingDescriptors, computeDueDate, vatIntervalsFor };
