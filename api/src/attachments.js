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

    const attachmentId = uuid();
    const sanitized = file.originalname
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
    fs.writeFileSync(fullPath, file.buffer);

    // Insert database record
    const now = new Date().toISOString();
    await bulkInsert('attachments', [{
      attachment_id: attachmentId,
      company_id: companyId,
      entity_type: entityType,
      entity_id: entityId,
      filename: file.originalname,
      content_type: file.mimetype,
      file_size: file.size,
      storage_path: storagePath,
      uploaded_by: req.body.uploadedBy || null,
      uploaded_at: now,
    }]);

    res.json({ ok: true, data: { attachment_id: attachmentId, filename: file.originalname } });
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
