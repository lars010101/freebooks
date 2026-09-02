'use strict';
/**
 * freeBooks — Orphaned-file resolution (calendar-reminders-documents-spec.md §5.5)
 *
 * Write actions for the Inbox's orphan_file item kind (inbox.js's
 * queryOrphanedFiles is the read side; orphaned_files IS the source of
 * truth, R8 — no staging). Two resolutions:
 *   - View   → GET /api/orphaned-file/:orphanId (this file's serveOrphanFile,
 *              mirroring attachments.js's serveAttachment: no company scoping
 *              beyond the row lookup itself — same posture as every other
 *              download route in this single-user-install app).
 *   - Delete → delete the file directly off disk (no attachments row exists
 *              to delete). The operator downloads a copy via View first if
 *              one is wanted — no app-managed quarantine/restore path.
 */

const fs = require('fs');
const path = require('path');
const { query, exec } = require('./db');
const { ATTACHMENTS_ROOT } = require('./attachments');

async function handleOrphanedFiles(ctx, action) {
  switch (action) {
    case 'orphan.delete': return deleteOrphan(ctx);
    default:
      throw Object.assign(new Error(`Unknown orphan action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

async function loadOrphan(companyId, orphanId) {
  const rows = await query(
    `SELECT orphan_id, path FROM orphaned_files WHERE company_id = @companyId AND orphan_id = @id AND resolved_at IS NULL LIMIT 1`,
    { companyId, id: orphanId }
  );
  if (!rows.length) throw Object.assign(new Error('Orphaned file not found (or already resolved)'), { code: 'NOT_FOUND' });
  return rows[0];
}

async function deleteOrphan(ctx) {
  const { companyId, body } = ctx;
  const { orphanId } = body;
  if (!orphanId) throw Object.assign(new Error('orphanId required'), { code: 'INVALID_INPUT' });
  const row = await loadOrphan(companyId, orphanId);
  const fullPath = path.join(ATTACHMENTS_ROOT, row.path);
  try { fs.unlinkSync(fullPath); } catch (e) { /* already gone — fine, still mark resolved */ }
  await exec(`UPDATE orphaned_files SET resolved_at = @now WHERE orphan_id = @id`,
    { now: new Date().toISOString(), id: orphanId });
  return { deleted: true, orphan_id: orphanId };
}

async function serveOrphanFile(req, res) {
  try {
    const { orphanId } = req.params;
    const rows = await query(`SELECT path FROM orphaned_files WHERE orphan_id = @id LIMIT 1`, { id: orphanId });
    if (!rows.length) return res.status(404).json({ error: 'Orphaned file not found' });
    const fullPath = path.join(ATTACHMENTS_ROOT, rows[0].path);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(rows[0].path)}"`);
    fs.createReadStream(fullPath).pipe(res);
  } catch (err) {
    console.error('Serve orphaned file error:', err);
    res.status(500).json({ error: 'Failed to serve file' });
  }
}

module.exports = { handleOrphanedFiles, serveOrphanFile };
