'use strict';
/**
 * freeBooks — Attachment integrity scanner (calendar-reminders-documents-spec.md §5.5)
 *
 * Documents is strictly DB-driven and never built by scanning the attachments
 * folder — but the DB and the filesystem can still drift apart. This job
 * checks both directions, same family as fx-scanner.js/reminder-scanner.js
 * (boot + interval, raiseNotification on findings):
 *
 *   - DB row, no file  → attachments.missing_since set/cleared, notified on
 *                        the transition into "missing".
 *   - File, no DB row  → a row in orphaned_files, notified once; resolved_at
 *                        is set automatically once the file is gone (Delete
 *                        in Inbox acts on the filesystem directly, so the
 *                        next scan just notices the path no longer exists).
 *
 * Runs once daily like the reminder scanner — file drift doesn't happen fast.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert } = require('./db');
const { ATTACHMENTS_ROOT } = require('./attachments');
const { raiseNotification } = require('./notifications');

const SCAN_MS = parseInt(process.env.FREEBOOKS_ATTACHMENT_INTEGRITY_SCAN_MS || (24 * 60 * 60 * 1000), 10);

async function runAttachmentIntegrityScan() {
  try {
    const missing = await scanMissingFiles();
    const orphaned = await scanOrphanedFiles();
    return { missing, orphaned };
  } catch (e) {
    console.error('Attachment integrity scan failed:', e.message);
    return { error: e.message };
  }
}

// ── DB row, no file ───────────────────────────────────────────────────────────
async function scanMissingFiles() {
  const rows = await query(
    `SELECT attachment_id, company_id, storage_path, missing_since FROM attachments`
  );
  let notified = 0;
  for (const r of rows) {
    const fullPath = path.join(ATTACHMENTS_ROOT, r.storage_path);
    const exists = fs.existsSync(fullPath);
    if (!exists && !r.missing_since) {
      const now = new Date().toISOString();
      await exec(`UPDATE attachments SET missing_since = @now WHERE attachment_id = @id`, { now, id: r.attachment_id });
      const issueKey = `attachment-missing:${r.company_id}:${r.attachment_id}`;
      const msg = `Document file missing from storage: ${r.storage_path}`;
      const raised = await raiseNotification(r.company_id, 'attachment-missing', msg, issueKey);
      if (raised) notified++;
    } else if (exists && r.missing_since) {
      await exec(`UPDATE attachments SET missing_since = NULL WHERE attachment_id = @id`, { id: r.attachment_id });
    }
  }
  return notified;
}

// ── File, no DB row ───────────────────────────────────────────────────────────
async function scanOrphanedFiles() {
  const known = new Set((await query(`SELECT storage_path FROM attachments`)).map((r) => r.storage_path));
  const onDisk = walkFiles(ATTACHMENTS_ROOT);
  const orphanPaths = onDisk.filter((p) => !known.has(p));

  const existingRows = await query(`SELECT orphan_id, path, resolved_at FROM orphaned_files`);
  const existingByPath = {};
  for (const r of existingRows) existingByPath[r.path] = r;

  let notified = 0;
  const orphanSet = new Set(orphanPaths);
  for (const p of orphanPaths) {
    const row = existingByPath[p];
    if (row && !row.resolved_at) continue; // already flagged and still unresolved
    if (row && row.resolved_at) {
      // Reappeared after being marked resolved (e.g. restored by hand) — re-raise.
      await exec(`UPDATE orphaned_files SET resolved_at = NULL, discovered_at = @now WHERE orphan_id = @id`,
        { now: new Date().toISOString(), id: row.orphan_id });
    } else {
      const companyId = inferCompanyId(p);
      await bulkInsert('orphaned_files', [{
        orphan_id: uuid(), company_id: companyId, path: p,
        discovered_at: new Date().toISOString(), resolved_at: null,
      }]);
    }
    const issueKey = `orphaned-file:${p}`;
    const raised = await raiseNotification(inferCompanyId(p), 'orphaned-file', `Orphaned file found: ${p}`, issueKey);
    if (raised) notified++;
  }

  // Auto-resolve rows whose file is gone (deleted via Inbox, or by hand).
  for (const r of existingRows) {
    if (!r.resolved_at && !orphanSet.has(r.path)) {
      await exec(`UPDATE orphaned_files SET resolved_at = @now WHERE orphan_id = @id`,
        { now: new Date().toISOString(), id: r.orphan_id });
    }
  }
  return notified;
}

// storeAttachment always writes `${companyId}/${entityType}/${entityId}/...`
// (attachments.js) — the path's leading segment is the company id whenever a
// file follows that convention. A file placed under ATTACHMENTS_ROOT by hand,
// outside it, has no company to attribute to (§9 open question).
function inferCompanyId(relPath) {
  const first = relPath.split(path.sep)[0];
  return first || null;
}

function walkFiles(dir, base) {
  base = base || dir;
  let out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(walkFiles(full, base));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

function startAttachmentIntegrityScanner() {
  runAttachmentIntegrityScan().catch((e) => console.error('Boot attachment integrity scan failed:', e.message));

  const timer = setInterval(() => {
    runAttachmentIntegrityScan().catch((e) => console.error('Scheduled attachment integrity scan failed:', e.message));
  }, SCAN_MS);
  timer.unref();

  return { scanIntervalMs: SCAN_MS };
}

module.exports = { runAttachmentIntegrityScan, startAttachmentIntegrityScanner };
