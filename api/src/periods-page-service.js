'use strict';
/**
 * freeBooks — Periods section service (calendar-reminders-documents-spec §4)
 *
 * Actions behind the Calendar page's Reminders tab and the Close Checklist:
 *   reminder.list      — reminder rows = jurisdiction-pack descriptor × reporting
 *                        interval (system-imported, seeded once into `reminders`
 *                        on first discovery) unioned with user-added rows from
 *                        the same table. Params: none.
 *   reminder.create    — add a free-standing user reminder.
 *   reminder.set_done  — toggle a reminder's done/not-done status.
 *   reminder.set_due   — edit a reminder's due date.
 *   reminder.delete    — remove a user-added reminder (system-imported rows
 *                        cannot be deleted, only marked done).
 *   period.close_check — live close checklist for one period: engine items
 *                        (every company) + pack items (jurisdiction.json
 *                        closeChecklist[], closed op vocabulary). Params: { periodId }.
 *
 * Supersedes the filing.* write surface from fiscal-filings-lifecycle-spec.md
 * (submission-tracking, due-date overrides, tax-attribute carryforward) — see
 * calendar-reminders-documents-spec.md §4.2 for what was dropped and why.
 */

const { v4: uuid } = require('uuid');
const path = require('path');
const fs = require('fs');
const { query, exec, bulkInsert } = require('./db');
const { getJurisdictionPack } = require('./jurisdiction-packs');

const PACKS_DIR = path.resolve(__dirname, '../../db/jurisdictions');

async function handlePeriodsService(ctx, action) {
  switch (action) {
    case 'reminder.list': return listReminders(ctx);
    case 'reminder.create': return createReminder(ctx);
    case 'reminder.set_done': return setReminderDone(ctx);
    case 'reminder.set_due': return setReminderDue(ctx);
    case 'reminder.delete': return deleteReminder(ctx);
    case 'period.close_check': return closeCheck(ctx);
    default:
      throw Object.assign(new Error(`Unknown periods action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

// ── Pack filings loader ───────────────────────────────────────────────────────
// Every filings/*.json in the company's jurisdiction pack is a reminder source.
// period_kind declares the interval: fiscal_year (default) | vat_period.
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
// extension seam (period_kind: vat_period).
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
// Rules live in pack descriptors (data, per jurisdiction). Only used to seed a
// system reminder's INITIAL due date (§4.3) — after that it's a plain editable
// field on the row, no separate override layer.
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

// ── reminder.list ─────────────────────────────────────────────────────────────
// Computes the jurisdiction pack's due instances fresh every call (cheap: JSON
// files + period rows), then seeds any instance not yet present in `reminders`
// (idempotent insert-if-not-exists, keyed on the collision-free reminder_id —
// same shape as the superseded spec's filingKey: `${descriptor.id}@${interval.start}`
// for VAT, `${descriptor.id}@${period.period_name}` for fiscal-year kinds).
// Once seeded, a row's due_date/done are plain persisted state — the pack is
// never consulted again for that row, so editing or marking it done never
// gets silently recomputed away.
async function listReminders(ctx) {
  const { companyId } = ctx;
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
  const vatFrequency = settings.vat_frequency || 'annual';

  const periodRows = await query(
    `SELECT period_name, start_date, end_date FROM (
       SELECT *, ROW_NUMBER() OVER(PARTITION BY period_name ORDER BY created_at DESC) AS rn
       FROM periods WHERE company_id = @companyId
     ) WHERE rn = 1 ORDER BY start_date DESC`, { companyId });

  // Computed instances from the pack — the seed source, and the source of
  // artifact links (SRU/SIE downloads), which stay read-only convenience
  // actions unrelated to done/not-done status.
  const instances = [];
  for (const period of periodRows) {
    const fyStart = String(period.start_date).slice(0, 10);
    const fyEnd = String(period.end_date).slice(0, 10);
    for (const d of descriptors) {
      if (d.period_kind === 'vat_period') {
        if (!(company.vat_registered === true || String(company.vat_registered || '').toUpperCase() === 'TRUE')) continue;
        for (const iv of vatIntervalsFor(period, vatFrequency)) {
          instances.push({
            reminder_id: `${d.id}@${iv.start}`, filing_id: d.id, label: d.name, authority: d.authority || '',
            due_date: computeDueDate(d, period, iv), period_id: period.period_name,
            interval_start: iv.start, interval_end: iv.end, period_kind: 'vat_period',
          });
        }
      } else {
        instances.push({
          reminder_id: `${d.id}@${period.period_name}`, filing_id: d.id, label: d.name, authority: d.authority || '',
          due_date: computeDueDate(d, period, null), period_id: period.period_name,
          interval_start: fyStart, interval_end: fyEnd, period_kind: 'fiscal_year',
        });
      }
    }
  }
  const instanceById = {};
  for (const inst of instances) instanceById[inst.reminder_id] = inst;

  const existingRows = await query(
    `SELECT reminder_id, source, label, authority, due_date, period_id, done
     FROM reminders WHERE company_id = @companyId`, { companyId });
  const existingById = {};
  for (const r of existingRows) existingById[r.reminder_id] = r;

  const now = new Date().toISOString();
  const toSeed = instances
    .filter((inst) => !existingById[inst.reminder_id])
    .map((inst) => ({
      reminder_id: inst.reminder_id, company_id: companyId, source: 'system',
      label: inst.label, authority: inst.authority, due_date: inst.due_date,
      period_id: inst.period_id, done: false, created_at: now,
    }));
  if (toSeed.length) {
    await bulkInsert('reminders', toSeed);
    for (const row of toSeed) existingById[row.reminder_id] = row;
  }

  const reminders = [];
  for (const row of Object.values(existingById)) {
    if (row.source !== 'system') {
      reminders.push({
        reminder_id: row.reminder_id, source: 'user', label: row.label, authority: null,
        due_date: row.due_date, period_id: row.period_id, done: !!row.done, artifacts: [],
      });
      continue;
    }
    const inst = instanceById[row.reminder_id];
    if (!inst) continue; // stale system row (descriptor removed from the pack since seeding) — kept, not shown
    const artifacts = [];
    const d = descriptors.find((x) => x.id === inst.filing_id);
    if (d && d.route) {
      const year = inst.period_id.replace(/^FY/, '');
      artifacts.push({ kind: 'download', label: 'blanketter.sru', href: `/api/${companyId}/sru/ink2?year=${year}` });
      artifacts.push({ kind: 'download', label: 'INFO.SRU', href: `/api/${companyId}/sru/info?year=${year}` });
    } else if (d && d.id === 'annual-report') {
      const pack = getJurisdictionPack(jurisdiction);
      if (pack && pack.integrations && pack.integrations.sie && pack.integrations.sie.export) {
        artifacts.push({ kind: 'download', label: 'SIE 4 export',
          href: `/api/${companyId}/report?type=sie&start=${inst.interval_start}&end=${inst.interval_end}` });
      }
    } else if (d && d.period_kind === 'vat_period') {
      artifacts.push({ kind: 'view', label: 'View VAT return',
        href: `/api/${companyId}/report?type=vat-return&start=${inst.interval_start}&end=${inst.interval_end}` });
    }
    reminders.push({
      reminder_id: row.reminder_id, source: 'system', label: row.label, authority: row.authority,
      due_date: row.due_date, period_id: row.period_id, done: !!row.done, artifacts,
    });
  }
  reminders.sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
  return { reminders };
}

// ── reminder.create ───────────────────────────────────────────────────────────
async function createReminder(ctx) {
  const { companyId, body } = ctx;
  const { label, dueDate, periodId } = body;
  if (!label || !dueDate) throw Object.assign(new Error('label and dueDate required'), { code: 'INVALID_INPUT' });
  const reminderId = uuid();
  await bulkInsert('reminders', [{
    reminder_id: reminderId, company_id: companyId, source: 'user',
    label, authority: null, due_date: String(dueDate).slice(0, 10),
    period_id: periodId || null, done: false, created_at: new Date().toISOString(),
  }]);
  return { reminder_id: reminderId };
}

// ── reminder.set_done ─────────────────────────────────────────────────────────
async function setReminderDone(ctx) {
  const { companyId, body } = ctx;
  const { reminderId, done } = body;
  if (!reminderId) throw Object.assign(new Error('reminderId required'), { code: 'INVALID_INPUT' });
  await exec(`UPDATE reminders SET done = @done WHERE company_id = @companyId AND reminder_id = @reminderId`,
    { companyId, reminderId, done: !!done });
  return { reminder_id: reminderId, done: !!done };
}

// ── reminder.set_due ──────────────────────────────────────────────────────────
async function setReminderDue(ctx) {
  const { companyId, body } = ctx;
  const { reminderId, dueDate } = body;
  if (!reminderId || !dueDate) throw Object.assign(new Error('reminderId and dueDate required'), { code: 'INVALID_INPUT' });
  const due = String(dueDate).slice(0, 10);
  await exec(`UPDATE reminders SET due_date = @dueDate WHERE company_id = @companyId AND reminder_id = @reminderId`,
    { companyId, reminderId, dueDate: due });
  return { reminder_id: reminderId, due_date: due };
}

// ── reminder.delete ───────────────────────────────────────────────────────────
// System-imported reminders can't be deleted outright (§9 open question,
// resolved conservatively for the build: they'd just reseed on the next
// list load anyway, since the descriptor is still in the pack) — only marked
// done. User-added rows can be removed freely.
async function deleteReminder(ctx) {
  const { companyId, body } = ctx;
  const { reminderId } = body;
  if (!reminderId) throw Object.assign(new Error('reminderId required'), { code: 'INVALID_INPUT' });
  const rows = await query(
    `SELECT source FROM reminders WHERE company_id = @companyId AND reminder_id = @reminderId LIMIT 1`,
    { companyId, reminderId });
  if (!rows.length) throw Object.assign(new Error('Reminder not found'), { code: 'NOT_FOUND' });
  if (rows[0].source !== 'user') {
    throw Object.assign(new Error('System-imported reminders cannot be deleted — mark done instead.'), { code: 'FORBIDDEN' });
  }
  await exec(`DELETE FROM reminders WHERE company_id = @companyId AND reminder_id = @reminderId`, { companyId, reminderId });
  return { deleted: true, reminder_id: reminderId };
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

module.exports = { handlePeriodsService, listReminders };
