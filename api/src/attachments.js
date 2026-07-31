'use strict';
/**
 * freeBooks — File Attachments
 * Handles upload, download, list, and delete of file attachments
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuid } = require('uuid');
const multer = require('multer');
const { query, exec, bulkInsert } = require('./db');
const { emitEvent } = require('./events');
const { resolveActor, checkPermission } = require('./auth');
const { auditCall } = require('./audit');

const ATTACHMENTS_ROOT = path.join(os.homedir(), '.freebooks', 'attachments');

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

  if (!entityType || !entityId) {
    throw Object.assign(new Error('entityType and entityId required'), { code: 'INVALID_INPUT' });
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
// same enforcement and event shape. Returns { attachment_id, filename }.
async function storeAttachment({ companyId, entityType, entityId, filename, contentType, buffer, uploadedBy, actor, requestId }) {
  const attachmentId = uuid();
  const sanitized = String(filename)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 100);
  const storagePath = `${companyId}/${entityType}/${entityId}/${uuid()}-${sanitized}`;
  const fullPath = path.join(ATTACHMENTS_ROOT, storagePath);

  // Ensure directory exists
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write file
  fs.writeFileSync(fullPath, buffer);

  // Insert database record
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
    uploaded_by: uploadedBy || null,
    uploaded_at: now,
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
  });

  return { attachment_id: attachmentId, filename };
}

// Phase A hardening: `attachment.upload` action handler (base64 content).
// dispatch's catalog validation already requires the four strings; the
// decoded-size checks here are a defensive second line (the multipart route
// keeps its own multer 50MB cap, independent of this 32MB action limit).
async function uploadAttachment(ctx) {
  const { companyId, body, userEmail, actor, requestId } = ctx;
  const { entityType, entityId, filename, contentBase64, contentType } = body;
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

module.exports = { handleAttachments, uploadMiddleware, handleUpload, serveAttachment };
