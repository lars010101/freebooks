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
const { query, exec, bulkInsert, queryPositional } = require('./db');
const { getJurisdictionPack } = require('./jurisdiction-packs');
const { emitEvent } = require('./events');
const {
  computeFiling, validateSruContact, loadDescriptor, loadEmitter,
  loadContact, isPeriodLocked,
} = require('./filings');
const { storeAttachment } = require('./attachments');

const PACKS_DIR = path.resolve(__dirname, '../../db/jurisdictions');

async function handlePeriodsService(ctx, action) {
  switch (action) {
    case 'filing.list': return listFilings(ctx);
    case 'filing.mark_submitted': return markSubmitted(ctx);
    case 'filing.unmark_submitted': return unmarkSubmitted(ctx);
    case 'filing.set_due_override': return setDueOverride(ctx);
    case 'filing.save_period_attrs': return savePeriodAttrs(ctx);
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
            key,
            methods: d.methods || null,
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
            submitted_attachments: [],
          });
        }
      } else {
        const key = `${d.id}@${period.period_name}`;
        const artifacts = [];
        if (d.route) {
          artifacts.push({ kind: 'download', label: 'blanketter.sru', href: `/api/${companyId}/sru/ink2?year=${year}` });
          artifacts.push({ kind: 'download', label: 'INFO.SRU', href: `/api/${companyId}/sru/info?year=${year}` });
        } else if (d.id === 'annual-report') {
          // SIE 4 export — the Gredor handoff artifact (2026-07-30 descope).
          // §8: the in-app AR view link is removed (Gredor produces the filed
          // PDF; freeBooks uploads + tracks submission status only).
          const sieInteg = getJurisdictionPack(jurisdiction);
          if (sieInteg && sieInteg.integrations && sieInteg.integrations.sie && sieInteg.integrations.sie.export) {
            artifacts.push({ kind: 'download', label: 'SIE 4 export',
              href: `/api/${companyId}/report?type=sie&start=${fyStart}&end=${fyEnd}` });
          }
        }
        const fState = filedStates[key];
        let submittedAttachments = [];
        if (fState && fState.attachment_ids && fState.attachment_ids.length) {
          const posRows = await queryPositional(
            `SELECT attachment_id, filename FROM attachments
             WHERE company_id = ? AND attachment_id IN (${fState.attachment_ids.map(() => '?').join(',')})
             ORDER BY uploaded_at DESC`,
            [companyId, ...fState.attachment_ids]
          ).catch(() => []);
          submittedAttachments = (posRows || []).map(r => ({ attachment_id: r.attachment_id, filename: r.filename }));
        }
        filings.push({
          filing_id: d.id, name: d.name, authority: d.authority || '',
          key,
          methods: d.methods || null,
          period_id: period.period_name, period_kind: 'fiscal_year',
          interval_start: fyStart, interval_end: fyEnd,
          due_date: overrides[key] || computeDueDate(d, period, null),
          due_overridden: !!overrides[key],
          state: fState && fState.filed_at ? 'filed' : 'draft',
          filed_at: fState ? fState.filed_at || null : null,
          artifacts,
          submitted_attachments: submittedAttachments || [],
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

// ── Shared atomic write helpers (§3 — Fiscal/Filings Lifecycle spec) ──────────
// Both helpers do a fresh SELECT → JSON.parse → patchFn(mutate in place) →
// UPDATE/INSERT back. This avoids the whole-column-clobber hazard of the
// client-side round-trip pattern (§1.7): each write touches only the sub-key
// being patched, not the entire tax_attrs / deadline_overrides blob.

async function patchPeriodTaxAttrs(companyId, periodId, patchFn) {
  const rows = await query(
    `SELECT tax_attrs FROM (
       SELECT *, ROW_NUMBER() OVER(PARTITION BY period_name ORDER BY created_at DESC) AS rn
       FROM periods WHERE company_id = @companyId AND period_name = @pid
     ) WHERE rn = 1`,
    { companyId, pid: periodId }
  );
  let taxAttrs = {};
  try { if (rows.length && rows[0].tax_attrs) taxAttrs = JSON.parse(rows[0].tax_attrs); } catch (e) { taxAttrs = {}; }
  patchFn(taxAttrs);
  const now = new Date().toISOString();
  await exec(
    `UPDATE periods SET tax_attrs = @json, updated_at = @now
     WHERE company_id = @companyId AND period_name = @pid
       AND created_at = (SELECT MAX(created_at) FROM periods WHERE company_id = @companyId AND period_name = @pid)`,
    { json: JSON.stringify(taxAttrs), now, companyId, pid: periodId }
  );
  return taxAttrs;
}

async function patchDeadlineOverrides(companyId, patchFn) {
  const rows = await query(
    `SELECT value FROM settings WHERE company_id = @companyId AND key = 'deadline_overrides' LIMIT 1`,
    { companyId }
  );
  let overrides = {};
  try { if (rows.length && rows[0].value) overrides = JSON.parse(rows[0].value); } catch (e) { overrides = {}; }
  patchFn(overrides);
  const now = new Date().toISOString();
  const json = JSON.stringify(overrides);
  if (rows.length) {
    await exec(
      `UPDATE settings SET value = @json, updated_at = @now WHERE company_id = @companyId AND key = 'deadline_overrides'`,
      { json, now, companyId }
    );
  } else {
    await bulkInsert('settings', [{ company_id: companyId, key: 'deadline_overrides', value: json, updated_at: now }]);
  }
  return overrides;
}

// ── filing.mark_submitted (§5/§6/§7) ──────────────────────────────────────────
async function markSubmitted(ctx) {
  const { companyId, body, userEmail, actor, requestId } = ctx;
  const { periodId, key, method, attachmentId } = body;
  if (!periodId || !key) throw Object.assign(new Error('periodId and key required'), { code: 'INVALID_INPUT' });

  // Load the period row to check lock status and determine period_kind.
  const periodRows = await query(
    `SELECT period_name, locked FROM (
       SELECT *, ROW_NUMBER() OVER(PARTITION BY period_name ORDER BY created_at DESC) AS rn
       FROM periods WHERE company_id = @companyId AND period_name = @pid
     ) WHERE rn = 1`,
    { companyId, pid: periodId }
  );
  if (!periodRows.length) throw Object.assign(new Error(`Period '${periodId}' not found`), { code: 'NOT_FOUND' });

  // Determine period_kind from the key format: vat_period keys contain a
  // date after @ (YYYY-MM-DD), fiscal_year keys contain FY+year.
  const isVatPeriod = key.includes('@') && /^\d{4}-\d{2}-\d{2}$/.test(key.split('@')[1]);

  // §6: fiscal_year-kind filings require a locked period; vat_period does not.
  if (!isVatPeriod && !periodRows[0].locked) {
    throw Object.assign(
      new Error('Period must be locked before submitting this filing. Lock the period in Settings → Periods.'),
      { code: 'PERIOD_NOT_LOCKED' }
    );
  }

  let attachmentIds = [];
  let computedResult = null;

  if (method === 'sru') {
    // §5: SRU snapshot — call computeFiling directly (no HTTP round-trip).
    // Produces byte-identical output to handleSruInk2/handleSruInfo.
    const year = parseInt(periodId.replace(/^FY/, ''), 10);
    if (!Number.isFinite(year)) throw Object.assign(new Error('Cannot derive year from periodId: ' + periodId), { code: 'INVALID_INPUT' });

    // Load company for contact validation (same as handleSruInk2).
    const coRows = await queryPositional(
      `SELECT company_id, company_name, tax_id, jurisdiction FROM companies
       WHERE company_id = ? ORDER BY created_at DESC LIMIT 1`,
      [companyId]
    );
    if (!coRows.length) throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });
    const co = coRows[0];
    const contact = await loadContact(queryPositional, companyId);
    const problems = validateSruContact(co, contact);
    if (problems.length) throw Object.assign(new Error(problems.join(' | ') + ' — set them under Settings → Company'), { code: 'INVALID_INPUT' });

    computedResult = await computeFiling(queryPositional, companyId, year, {});
    const sruText = computedResult.emitter.emitSru(computedResult, computedResult.descriptor, year);
    const infoText = computedResult.emitter.emitInfo(co, {}, contact);

    // Store both SRU files as attachments (entityType:'filing', entityId:key).
    const sruAtt = await storeAttachment({
      companyId, entityType: 'filing', entityId: key,
      filename: 'blanketter.sru', contentType: 'text/plain; charset=utf-8',
      buffer: Buffer.from(sruText, 'utf8'),
      uploadedBy: userEmail, actor, requestId,
    });
    const infoAtt = await storeAttachment({
      companyId, entityType: 'filing', entityId: key,
      filename: 'INFO.SRU', contentType: 'text/plain; charset=utf-8',
      buffer: Buffer.from(infoText, 'utf8'),
      uploadedBy: userEmail, actor, requestId,
    });
    attachmentIds = [sruAtt.attachment_id, infoAtt.attachment_id];

    // §7: Loss carryforward — only for ink2@... keys.
    if (key.startsWith('ink2@')) {
      const descFields = computedResult.descriptor.fields || {};
      let closingLoss = 0;
      for (const [code, spec] of Object.entries(descFields)) {
        if (spec.op !== 'loss_closing') continue;
        const b = spec.blankett;
        closingLoss = computedResult.fields[b][code] || 0;
        break;
      }
      // Carry forward into next year's period if it exists (never auto-create).
      const nextYear = year + 1;
      const nextPeriodName = 'FY' + nextYear;
      const nextRows = await query(
        `SELECT period_name FROM periods WHERE company_id = @companyId AND period_name = @pn LIMIT 1`,
        { companyId, pn: nextPeriodName }
      );
      if (nextRows.length) {
        await patchPeriodTaxAttrs(companyId, nextPeriodName, function(ta) {
          ta.loss_cf = closingLoss;
        });
      }
    }
  } else if (method === 'pdf') {
    // §5: PDF — verify the attachment exists and belongs to this company + entity.
    if (!attachmentId) throw Object.assign(new Error('attachmentId required for method "pdf"'), { code: 'INVALID_INPUT' });
    const aRows = await queryPositional(
      `SELECT attachment_id FROM attachments WHERE company_id = ? AND attachment_id = ? AND entity_type = 'filing' AND entity_id = ? LIMIT 1`,
      [companyId, attachmentId, key]
    );
    if (!aRows.length) throw Object.assign(new Error('Attachment not found or not owned by this filing entity'), { code: 'NOT_FOUND' });
    attachmentIds = [attachmentId];
  } else if (method === null || method === undefined) {
    // vat-return: no file artifact, just record filed_at.
  } else {
    throw Object.assign(new Error('method must be "sru", "pdf", or null'), { code: 'INVALID_INPUT' });
  }

  const filedAt = new Date().toISOString();
  await patchPeriodTaxAttrs(companyId, periodId, function(ta) {
    ta.filings = ta.filings || {};
    ta.filings[key] = { filed_at: filedAt, method: method || null, attachment_ids: attachmentIds };
  });

  await emitEvent(ctx, 'filing.submitted', 'filing', key, { periodId, method: method || null, attachmentIds });
  return { filed: true, key, filed_at: filedAt, method: method || null, attachment_ids: attachmentIds };
}

// ── filing.unmark_submitted (§4) ─────────────────────────────────────────────
async function unmarkSubmitted(ctx) {
  const { companyId, body } = ctx;
  const { periodId, key } = body;
  if (!periodId || !key) throw Object.assign(new Error('periodId and key required'), { code: 'INVALID_INPUT' });

  await patchPeriodTaxAttrs(companyId, periodId, function(ta) {
    ta.filings = ta.filings || {};
    delete ta.filings[key];
  });

  await emitEvent(ctx, 'filing.unsubmitted', 'filing', key, { periodId });
  return { unfiled: true, key };
}

// ── filing.set_due_override (§4) ─────────────────────────────────────────────
async function setDueOverride(ctx) {
  const { companyId, body } = ctx;
  const { key, dueDate } = body;
  if (!key) throw Object.assign(new Error('key required'), { code: 'INVALID_INPUT' });

  await patchDeadlineOverrides(companyId, function(overrides) {
    if (dueDate === null || dueDate === undefined || dueDate === '') {
      delete overrides[key];
    } else {
      overrides[key] = String(dueDate).slice(0, 10);
    }
  });

  return { key, due_date: dueDate || null };
}

// ── filing.save_period_attrs (§4) ────────────────────────────────────────────
async function savePeriodAttrs(ctx) {
  const { companyId, body } = ctx;
  const { periodId, patch } = body;
  if (!periodId || !patch) throw Object.assign(new Error('periodId and patch required'), { code: 'INVALID_INPUT' });

  const taxAttrs = await patchPeriodTaxAttrs(companyId, periodId, function(ta) {
    if (patch.loss_cf !== undefined) ta.loss_cf = patch.loss_cf;
    if (patch.periodiseringsfond !== undefined) ta.periodiseringsfond = patch.periodiseringsfond;
    if (patch.ar_facts !== undefined && typeof patch.ar_facts === 'object') {
      ta.ar_facts = ta.ar_facts || {};
      for (const [k, v] of Object.entries(patch.ar_facts)) ta.ar_facts[k] = v;
    }
  });

  return { saved: true, periodId };
}

module.exports = { handlePeriodsService, loadFilingDescriptors, computeDueDate, vatIntervalsFor, patchPeriodTaxAttrs, patchDeadlineOverrides };
