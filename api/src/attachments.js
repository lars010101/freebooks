'use strict';
/**
 * freeBooks — File Attachments
 * Handles upload, download, list, and delete of file attachments
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const multer = require('multer');
const { query, exec, bulkInsert, queryPositional } = require('./db');
const { emitEvent } = require('./events');
const { resolveActor, checkPermission } = require('./auth');
const { auditCall } = require('./audit');

const ATTACHMENTS_ROOT = path.join(os.homedir(), '.freebooks', 'attachments');

// A4 (§4.7) Disk controls — scoped to journal_proposal uploads only. All other
// entity types keep the status quo (32MB action cap, no type whitelist). The
// 15MB cap and the whitelist are enforced inside storeAttachment so both the
// `attachment.upload` action and the multipart POST /api/upload route share the
// single enforcement point. The GC + sha256 dedupe below are global.
const JOURNAL_PROPOSAL_MAX_BYTES = 15 * 1024 * 1024;
const JOURNAL_PROPOSAL_ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const GC_GRACE_DAYS = 30;

// Ensure attachments directory exists
function ensureAttachmentsDir() {
  if (!fs.existsSync(ATTACHMENTS_ROOT)) {
    fs.mkdirSync(ATTACHMENTS_ROOT, { recursive: true });
  }
}

async function handleAttachments(ctx, action) {
  switch (action) {
    case 'attachment.list':
      return listAttachments(ctx);
    case 'attachment.upload':
      return uploadAttachment(ctx);
    case 'attachment.delete':
      return deleteAttachment(ctx);
    default:
      throw Object.assign(new Error(`Unknown attachment action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

async function listAttachments(ctx) {
  const { companyId, body } = ctx;
  const { entityType, entityId } = body;

  if (entityType || entityId) {
    if (!entityType || !entityId) {
      throw Object.assign(new Error('entityType and entityId required together'), { code: 'INVALID_INPUT' });
    }
    const rows = await query(
      `SELECT attachment_id, filename, content_type, file_size, uploaded_by, uploaded_at
       FROM attachments
       WHERE company_id = @companyId AND entity_type = @entityType AND entity_id = @entityId
       ORDER BY uploaded_at DESC`,
      { companyId, entityType, entityId }
    );
    return rows;
  }

  // calendar-reminders-documents-spec.md §5.3: Documents page — company-wide
  // listing, both entityType and entityId omitted. entity_type/entity_id are
  // exposed (unlike the per-entity branch above) so the client can render
  // Type and resolve "go to source"; Period is derived here, not stored,
  // per §5.2's "auto-derived from the underlying transaction" rule.
  return listAllAttachmentsWithPeriod(companyId);
}

// Per-entity-type date lookup for period derivation — the entity types that
// actually produce attachments today (grep-verified against pages/*.js).
// 'document' (standalone uploads) already carries its own period_id column,
// set at upload time; 'filing' is a historical entity_type with no live
// source page left to resolve a date from (calendar-reminders-documents-spec
// dropped filing-tagged attachments going forward) — its rows just show no
// derived period, same as any entity_type not listed here.
const PERIOD_SOURCE_QUERIES = {
  bill: { idCol: 'bill_id', table: 'bills' },
  journal: { idCol: 'batch_id', table: 'journal_entries' },
  journal_proposal: { idCol: 'proposal_id', table: 'journal_proposals' },
};

async function listAllAttachmentsWithPeriod(companyId) {
  const rows = await query(
    `SELECT attachment_id, entity_type, entity_id, filename, content_type, file_size,
            uploaded_by, uploaded_at, doc_type, period_id, missing_since
     FROM attachments WHERE company_id = @companyId
     ORDER BY uploaded_at DESC`,
    { companyId }
  );
  if (!rows.length) return rows;

  // Group ids needing a date lookup by entity_type.
  const idsByType = {};
  for (const r of rows) {
    if (PERIOD_SOURCE_QUERIES[r.entity_type] && !idsByType[r.entity_type]) idsByType[r.entity_type] = new Set();
    if (PERIOD_SOURCE_QUERIES[r.entity_type]) idsByType[r.entity_type].add(r.entity_id);
  }
  const dateById = {}; // `${entity_type}:${entity_id}` -> 'YYYY-MM-DD'
  for (const [entityType, ids] of Object.entries(idsByType)) {
    const { idCol, table } = PERIOD_SOURCE_QUERIES[entityType];
    const idList = Array.from(ids);
    const placeholders = idList.map(() => '?').join(',');
    const dateRows = await queryPositional(
      `SELECT ${idCol} AS id, MIN(date) AS date FROM ${table}
       WHERE company_id = ? AND ${idCol} IN (${placeholders}) GROUP BY ${idCol}`,
      [companyId, ...idList]
    );
    for (const dr of dateRows) dateById[`${entityType}:${dr.id}`] = String(dr.date).slice(0, 10);
  }

  // Periods for this company (latest revision per period_name) — resolve
  // each derived date into the period whose range contains it.
  const periodRows = await query(
    `SELECT period_name, start_date, end_date FROM (
       SELECT *, ROW_NUMBER() OVER(PARTITION BY period_name ORDER BY created_at DESC) AS rn
       FROM periods WHERE company_id = @companyId
     ) WHERE rn = 1`,
    { companyId }
  );
  function periodFor(date) {
    if (!date) return null;
    const p = periodRows.find((pr) => String(pr.start_date).slice(0, 10) <= date && date <= String(pr.end_date).slice(0, 10));
    return p ? p.period_name : null;
  }

  return rows.map((r) => {
    if (r.entity_type === 'document') return r; // already carries its own period_id
    const date = dateById[`${r.entity_type}:${r.entity_id}`];
    return Object.assign({}, r, { period_id: periodFor(date) });
  });
}

async function deleteAttachment(ctx) {
  const { companyId, body } = ctx;
  const { attachmentId } = body;

  if (!attachmentId) {
    throw Object.assign(new Error('attachmentId required'), { code: 'INVALID_INPUT' });
  }

  const rows = await query(
    `SELECT storage_path FROM attachments WHERE attachment_id = @id AND company_id = @companyId LIMIT 1`,
    { id: attachmentId, companyId }
  );

  if (rows.length === 0) {
    throw Object.assign(new Error('Attachment not found'), { code: 'NOT_FOUND' });
  }

  const storagePath = rows[0].storage_path;
  const fullPath = path.join(ATTACHMENTS_ROOT, storagePath);

  // Delete file from disk
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }

  // Delete database record
  await exec(
    `DELETE FROM attachments WHERE attachment_id = @id AND company_id = @companyId`,
    { id: attachmentId, companyId }
  );

  return { deleted: true };
}

// ── Phase A hardening: shared storage core ─────────────────────────────────
// storeAttachment holds the single write path (sanitize, mkdir, write, row
// insert, emit attachment.uploaded). Both the multipart route (handleUpload)
// and the new `attachment.upload` action funnel through here so they share the
// same enforcement and event shape. Returns { attachment_id, filename, sha256 }.
async function storeAttachment({ companyId, entityType, entityId, filename, contentType, buffer, uploadedBy, actor, requestId, docType, periodId }) {
  // A4 (§4.7) Disk controls — scoped to journal_proposal uploads only. All
  // other entity types keep the status quo (32MB action cap, no whitelist).
  if (entityType === 'journal_proposal') {
    if (buffer.length > JOURNAL_PROPOSAL_MAX_BYTES) {
      throw Object.assign(
        new Error(`journal_proposal attachment exceeds the 15MB cap (${buffer.length} bytes)`),
        { code: 'INVALID_INPUT' }
      );
    }
    // Use the caller-supplied contentType; default only when trivial/absent.
    const ct = contentType && String(contentType).trim() !== ''
      ? String(contentType).trim()
      : 'application/octet-stream';
    if (!JOURNAL_PROPOSAL_ALLOWED_TYPES.includes(ct)) {
      throw Object.assign(
        new Error(`journal_proposal attachments must be one of: ${JOURNAL_PROPOSAL_ALLOWED_TYPES.join(', ')} (got: ${ct})`),
        { code: 'INVALID_INPUT' }
      );
    }
  }

  // A4 (§4.7): sha256 dedupe per company. Compute the hash of the decoded
  // buffer; if the same company already has an attachment row with the same
  // sha256, REUSE that row's storage_path (skip the blob write) and insert
  // only the new metadata row. The hash doubles as integrity evidence and is
  // carried on the row + event.
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  const attachmentId = uuid();
  const sanitized = String(filename)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 100);

  // Dedupe lookup: an existing row in this company with the same sha256 lets us
  // reuse its storage_path (one blob on disk for identical uploads).
  const existing = await query(
    `SELECT storage_path FROM attachments
     WHERE company_id = @companyId AND sha256 = @sha256
     LIMIT 1`,
    { companyId, sha256 }
  );

  let storagePath;
  if (existing.length > 0) {
    storagePath = existing[0].storage_path;
  } else {
    storagePath = `${companyId}/${entityType}/${entityId}/${uuid()}-${sanitized}`;
    const fullPath = path.join(ATTACHMENTS_ROOT, storagePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, buffer);
  }

  // Insert database record (always a fresh metadata row — even on dedupe, so
  // each upload remains independently addressable; only the blob is shared).
  const now = new Date().toISOString();
  await bulkInsert('attachments', [{
    attachment_id: attachmentId,
    company_id: companyId,
    entity_type: entityType,
    entity_id: entityId,
    filename,
    content_type: contentType,
    file_size: buffer.length,
    storage_path: storagePath,
    sha256,
    uploaded_by: uploadedBy || null,
    uploaded_at: now,
    doc_type: docType || null,
    period_id: periodId || null,
  }]);

  // A2 (§3.2): emit attachment.uploaded — the feed-extraction trigger (an
  // agent watching event.list fetches the file to extract → journal.propose).
  // A1/R3: actor comes from the DB role via resolveActor so an agent upload
  // stamps actor_type 'agent', never misattributed as human.
  await emitEvent({ companyId, userEmail: uploadedBy || null, actor, requestId }, 'attachment.uploaded', 'attachment', attachmentId, {
    entityType, entityId,
    filename,
    contentType,
    fileSize: buffer.length,
    sha256,
  });

  return { attachment_id: attachmentId, filename, sha256, storage_path: storagePath };
}

// Phase A hardening: `attachment.upload` action handler (base64 content).
// dispatch's catalog validation already requires the four strings; the
// decoded-size checks here are a defensive second line (the multipart route
// keeps its own multer 50MB cap, independent of this 32MB action limit).
async function uploadAttachment(ctx) {
  const { companyId, body, userEmail, actor, requestId } = ctx;
  const { entityType, entityId, filename, contentBase64, contentType, docType, periodId } = body;
  // Defensive double-check (dispatch already validated required strings).
  if (!entityType || !entityId || !filename) {
    throw Object.assign(new Error('entityType, entityId, filename required'), { code: 'INVALID_INPUT' });
  }
  const buffer = Buffer.from(String(contentBase64 || ''), 'base64');
  if (buffer.length === 0) {
    throw Object.assign(new Error('contentBase64 decodes to zero bytes'), { code: 'INVALID_INPUT' });
  }
  if (buffer.length > 32 * 1024 * 1024) {
    throw Object.assign(new Error('attachment exceeds the 32MB action limit (use the multipart route for larger files)'), { code: 'INVALID_INPUT' });
  }
  return storeAttachment({
    companyId, entityType, entityId,
    filename,
    contentType: contentType || 'application/octet-stream',
    buffer,
    uploadedBy: userEmail,
    actor,
    requestId,
    // calendar-reminders-documents-spec.md §5.3: standalone Documents uploads
    // (entityType:'document') carry these; every other entity type ignores
    // them (undefined → stored as null).
    docType, periodId,
  });
}

// Multer configuration for single file upload
const storage = multer.memoryStorage();
const uploadMiddleware = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
}).single('file');

async function handleUpload(req, res) {
  try {
    ensureAttachmentsDir();

    const { companyId, entityType, entityId } = req.body;
    const file = req.file;

    if (!companyId || !entityType || !entityId) {
      return res.status(400).json({ error: 'companyId, entityType, entityId required' });
    }

    if (!file) {
      return res.status(400).json({ error: 'file required' });
    }

    // A1 (§2.2/§2.3): resolve the actor class from the DB role (an agent
    // account's upload must stamp actor_type 'agent', never misattributed as
    // human). request_id from body or X-Request-Id header. Reused by both the
    // event emission (inside storeAttachment) and the audit row below.
    const actor = await resolveActor(req.body.uploadedBy, companyId);
    const requestId = req.body.requestId || req.get('X-Request-Id') || null;

    // Phase A hardening: permission gate BEFORE storing. The route bypasses
    // dispatch (no catalog role check there today), so enforce the same role
    // check here. Callers that send NO uploadedBy skip the gate — install-level
    // trust, unchanged legacy behavior (the browser UI sends no uploadedBy).
    if (req.body.uploadedBy) {
      const allowed = await checkPermission(req.body.uploadedBy, companyId, 'agent');
      if (!allowed) {
        return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } });
      }
    }

    const stored = await storeAttachment({
      companyId, entityType, entityId,
      filename: file.originalname,
      contentType: file.mimetype,
      buffer: file.buffer,
      uploadedBy: req.body.uploadedBy || null,
      actor,
      requestId,
    });

    // Phase A hardening: audit row AFTER a successful store. The route bypasses
    // dispatch so auditCall never fires for uploads today; write the equivalent
    // invocation audit row so uploads are attributable in audit_log (mirrors the
    // dispatch-level P0-4 audit for every other mutating action).
    try {
      await auditCall(companyId, 'attachment.upload', req.body.uploadedBy || 'anonymous', {
        entityType, entityId, filename: file.originalname, fileSize: file.size,
      }, { actorType: actor.actorType, requestId });
    } catch (e) {
      console.error('Audit log failed for attachment.upload:', e.message);
    }

    res.json({ ok: true, data: { attachment_id: stored.attachment_id, filename: stored.filename } });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
}

async function serveAttachment(req, res) {
  try {
    const { attachmentId } = req.params;

    const rows = await query(
      `SELECT storage_path, content_type, filename FROM attachments WHERE attachment_id = @id LIMIT 1`,
      { id: attachmentId }
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const { storage_path, content_type, filename } = rows[0];
    const fullPath = path.join(ATTACHMENTS_ROOT, storage_path);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.setHeader('Content-Type', content_type);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    const stream = fs.createReadStream(fullPath);
    stream.pipe(res);
  } catch (err) {
    console.error('Serve attachment error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── A4 (§4.7) GC: reject/expire purge ──────────────────────────────────────
// Purges journal_proposal-bound attachment rows past the 30-day grace. HARD
// INVARIANT: never touch entity_type='journal' rows (those are bound to a
// posted voucher under BFL 7 kap retention). Two purge classes:
//   (a) crash-orphans — entity_type='journal_proposal' rows whose entity_id no
//       longer exists in journal_proposals (proposal never created, or deleted),
//       older than GC_GRACE_DAYS by attachments.uploaded_at;
//   (b) rejected-proposal rows — entity_id exists in journal_proposals with
//       status='rejected' AND reviewed_at older than GC_GRACE_DAYS. ('posted'
//       proposals have had their attachments re-pointed to entity_type='journal'
//       at approve time, so they are not journal_proposal-bound here; there is
//       no 'expired' status in journal.js — only proposed|posted|rejected.)
// Logs purges to stderr. Returns { purged, examined }.
async function runAttachmentGC() {
  // Select candidate rows in one pass. The cutoff is a constant SQL literal
  // (no user input) so inlining is safe; the query has no @params.
  const rows = await query(
    `SELECT attachment_id, storage_path
     FROM attachments
     WHERE entity_type = 'journal_proposal'
       AND uploaded_at < NOW() - INTERVAL '${GC_GRACE_DAYS} days'
       AND (
         NOT EXISTS (
           SELECT 1 FROM journal_proposals jp
           WHERE jp.proposal_id = attachments.entity_id
         )
         OR EXISTS (
           SELECT 1 FROM journal_proposals jp
           WHERE jp.proposal_id = attachments.entity_id
             AND jp.status = 'rejected'
             AND jp.reviewed_at IS NOT NULL
             AND jp.reviewed_at < NOW() - INTERVAL '${GC_GRACE_DAYS} days'
         )
       )`,
    {}
  );

  let purged = 0;
  for (const r of rows) {
    // Only unlink the blob if no OTHER attachment row still references the same
    // storage_path (dedupe: multiple metadata rows may share one blob — the
    // shared blob must survive as long as any row references it).
    const still = await query(
      `SELECT COUNT(*) AS c FROM attachments
       WHERE storage_path = @sp AND attachment_id <> @id`,
      { sp: r.storage_path, id: r.attachment_id }
    );
    if (Number(still[0]?.c) === 0 && r.storage_path) {
      const fullPath = path.join(ATTACHMENTS_ROOT, r.storage_path);
      try {
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      } catch (e) {
        console.error(`Attachment GC: failed to unlink ${r.storage_path}: ${e.message}`);
      }
    }
    // HARD INVARIANT: the DELETE is scoped to entity_type='journal_proposal' —
    // a 'journal' row can never be matched here even if the selector leaked.
    await exec(
      `DELETE FROM attachments WHERE attachment_id = @id AND entity_type = 'journal_proposal'`,
      { id: r.attachment_id }
    );
    purged++;
  }

  if (purged > 0) {
    console.error(`Attachment GC: purged ${purged} expired journal_proposal attachment row(s).`);
  }
  return { purged, examined: rows.length };
}

// A4: token-gated admin trigger for runAttachmentGC — mirrors /api/admin/query.
// Lets contract tests (and operators) invoke the real GC against the live
// child-process DB deterministically, without waiting for the 24h interval or
// restarting the server. GC also runs at boot + on a 24h setInterval (index.js).
async function handleAdminGC(req, res) {
  const adminToken = process.env.FREEBOOKS_ADMIN_TOKEN || '';
  if (!adminToken) {
    return res.status(403).json({ error: 'Admin GC is disabled (set FREEBOOKS_ADMIN_TOKEN to enable)' });
  }
  if ((req.get('authorization') || '') !== `Bearer ${adminToken}`) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const result = await runAttachmentGC();
    res.json(result);
  } catch (err) {
    console.error('Admin GC failed:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { handleAttachments, uploadMiddleware, handleUpload, serveAttachment, runAttachmentGC, handleAdminGC, storeAttachment, ATTACHMENTS_ROOT };
