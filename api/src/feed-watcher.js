'use strict';
/**
 * In-process feed watcher (Phase B9).
 *
 * Polls company inbox folders on a setInterval, detects new files by content
 * hash dedup against the attachments table, and uploads them via the attachment
 * handler directly (in-process function call, no HTTP).
 *
 * Started at boot if install-level setting feed_watcher_enabled = 'true'.
 * One interval serves all companies — no per-company timers.
 *
 * Folder structure (multi-tenant):
 *   {inbox_path}/{company_id}/bank/     → entityType: bank_statement
 *   {inbox_path}/{company_id}/bills/    → entityType: bill
 *   {inbox_path}/{company_id}/receipts/ → entityType: journal_proposal
 *   {inbox_path}/{company_id}/journal/  → entityType: journal_proposal
 *
 * The company_id directory is validated against the companies table.
 * Unknown companies are skipped with a warning.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { query } = require('./db');
const { v4: uuid } = require('uuid');

const SUBFOLDERS = {
  bank:     { entityType: 'bank_statement',   exts: ['.csv', '.pdf'] },
  bills:    { entityType: 'bill',            exts: ['.pdf', '.jpg', '.jpeg', '.png'] },
  receipts: { entityType: 'journal_proposal', exts: ['.pdf', '.jpg', '.jpeg', '.png'] },
  journal:  { entityType: 'journal_proposal', exts: ['.pdf', '.jpg', '.jpeg', '.png'] },
};

const DEFAULT_INTERVAL_MS = 5000;
const INSTALL_COMPANY_ID = '__install__';

let _timer = null;
let _lastScan = null;
let _shuttingDown = false;

function ts() { return new Date().toISOString(); }
function log(...args) { console.log(`[${ts()}] [feed-watcher]`, ...args); }
function warn(...args) { console.warn(`[${ts()}] [feed-watcher] WARN`, ...args); }

/**
 * Read an install-level setting from the settings table.
 */
async function getInstallSetting(key) {
  const rows = await query(
    `SELECT value FROM settings WHERE company_id = @cid AND key = @key LIMIT 1`,
    { cid: INSTALL_COMPANY_ID, key }
  );
  return rows.length > 0 ? rows[0].value : null;
}

/**
 * Get all company IDs that exist in the companies table.
 */
async function getAllCompanies() {
  return query(`SELECT company_id FROM companies`);
}

/**
 * Get the inbox path for a company (from settings, or default).
 */
async function getCompanyInboxPath(companyId) {
  const rows = await query(
    `SELECT value FROM settings WHERE company_id = @cid AND key = 'agent_inbox_path' LIMIT 1`,
    { cid: companyId }
  );
  if (rows.length > 0 && rows[0].value) return rows[0].value;
  // Default: ~/freebooks-inbox
  return path.join(require('os').homedir(), 'freebooks-inbox');
}

/**
 * Check if a file's content hash already exists in the attachments table
 * for this company. Returns true if already uploaded (skip).
 */
async function isAlreadyUploaded(companyId, sha256) {
  const rows = await query(
    `SELECT 1 FROM attachments WHERE company_id = @cid AND sha256 = @sha LIMIT 1`,
    { cid: companyId, sha: sha256 }
  );
  return rows.length > 0;
}

/**
 * Compute sha256 of a file.
 */
function fileSha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Scan a single company's inbox folders for new files.
 * Calls the provided uploadFn(companyId, entityType, entityId, filename, buffer, contentType)
 * for each new file found.
 */
async function scanCompanyFolders(companyId, inboxPath, uploadFn) {
  for (const [subfolder, config] of Object.entries(SUBFOLDERS)) {
    const dir = path.join(inboxPath, companyId, subfolder);
    if (!fs.existsSync(dir)) continue;

    let files;
    try {
      files = fs.readdirSync(dir);
    } catch (e) {
      warn(`could not read ${dir}: ${e.message}`);
      continue;
    }

    for (const filename of files) {
      if (_shuttingDown) return;

      const ext = path.extname(filename).toLowerCase();
      if (!config.exts.includes(ext)) continue;

      const filePath = path.join(dir, filename);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (e) {
        continue; // file may have been moved/deleted between readdir and stat
      }
      if (!stat.isFile()) continue;

      // Content-hash dedup
      let hash;
      try {
        hash = fileSha256(filePath);
      } catch (e) {
        warn(`could not hash ${filePath}: ${e.message}`);
        continue;
      }

      if (await isAlreadyUploaded(companyId, hash)) continue;

      // Read and upload
      let buffer;
      try {
        buffer = fs.readFileSync(filePath);
      } catch (e) {
        warn(`could not read ${filePath}: ${e.message}`);
        continue;
      }

      const contentType = ext === '.csv' ? 'text/csv'
        : ext === '.pdf' ? 'application/pdf'
        : ext === '.png' ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : 'application/octet-stream';

      const entityId = uuid();
      const idempotencyKey = `feed-${hash}`;

      try {
        await uploadFn(companyId, config.entityType, entityId, filename, buffer, contentType, idempotencyKey);
        log(`uploaded ${companyId}/${subfolder}/${filename} (${config.entityType})`);
      } catch (e) {
        warn(`upload failed for ${companyId}/${subfolder}/${filename}: ${e.message}`);
      }
    }
  }
}

/**
 * Run one full scan cycle across all companies.
 * The uploadFn is injected so the watcher can be tested independently.
 */
async function scanOnce(uploadFn) {
  let companies;
  try {
    companies = await getAllCompanies();
  } catch (e) {
    warn(`could not list companies: ${e.message}`);
    return;
  }

  for (const { company_id: companyId } of companies) {
    if (_shuttingDown) return;
    const inboxPath = await getCompanyInboxPath(companyId);
    try {
      await scanCompanyFolders(companyId, inboxPath, uploadFn);
    } catch (e) {
      warn(`scan error for company ${companyId}: ${e.message}`);
    }
  }

  _lastScan = Date.now();
}

/**
 * Start the watcher. The uploadFn is injected by the caller (server.js)
 * to avoid a circular dependency on index.js.
 *
 * @param {function} uploadFn — async (companyId, entityType, entityId, filename, buffer, contentType, idempotencyKey) => void
 */
function startFeedWatcher(uploadFn) {
  if (_timer) {
    warn('already running');
    return;
  }
  _shuttingDown = false;

  // Run an immediate scan on startup (catches files dropped while server was down)
  scanOnce(uploadFn).catch((e) => warn(`startup scan failed: ${e.message}`));

  // Read interval from settings (checked once at start; restart to change)
  getInstallSetting('feed_watcher_interval_ms').then((val) => {
    const intervalMs = val && Number(val) > 0 ? Math.floor(Number(val)) : DEFAULT_INTERVAL_MS;

    _timer = setInterval(() => {
      scanOnce(uploadFn).catch((e) => warn(`scan cycle failed: ${e.message}`));
    }, intervalMs);
    _timer.unref(); // don't keep the event loop alive on its own

    log(`started (interval=${intervalMs}ms)`);
  }).catch((e) => {
    warn(`could not read feed_watcher_interval_ms, using default ${DEFAULT_INTERVAL_MS}ms: ${e.message}`);
    _timer = setInterval(() => {
      scanOnce(uploadFn).catch((e) => warn(`scan cycle failed: ${e.message}`));
    }, DEFAULT_INTERVAL_MS);
    _timer.unref();
    log(`started (interval=${DEFAULT_INTERVAL_MS}ms, default)`);
  });
}

function stopFeedWatcher() {
  _shuttingDown = true;
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  log('stopped');
}

function getStatus() {
  return {
    running: !!_timer,
    lastScan: _lastScan ? new Date(_lastScan).toISOString() : null,
  };
}

module.exports = {
  startFeedWatcher,
  stopFeedWatcher,
  getStatus,
  scanOnce, // exported for testing
};
