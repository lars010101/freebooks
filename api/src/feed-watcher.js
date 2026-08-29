'use strict';
/**
 * In-process feed watcher (Phase B9).
 *
 * Uses fs.watch() (inotify on Linux) for instant file detection — zero polling,
 * zero idle CPU. Falls back to interval-based readdir polling if fs.watch()
 * fails (NFS, unsupported filesystem, or environments without inotify).
 *
 * Started at boot when any company has agent_enabled = 'true' (consolidated
 * gate — previously required a separate feed_watcher_enabled install-level
 * setting, which had no UI and caused silent failures).
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

const DEFAULT_FALLBACK_INTERVAL_MS = 30000; // polling fallback only
const DEBOUNCE_MS = 300; // coalesce rapid rename/write bursts
const INSTALL_COMPANY_ID = '__install__';

let _watchers = [];       // fs.watch() handles, one per subfolder per company
let _fallbackTimer = null; // setInterval handle for polling fallback
let _lastScan = null;
let _shuttingDown = false;
let _uploadFn = null;

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
 * Process a single file: hash dedup, read, upload.
 */
async function processFile(companyId, subfolder, filePath, filename, config) {
  if (_shuttingDown) return;

  const ext = path.extname(filename).toLowerCase();
  if (!config.exts.includes(ext)) return;

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    return; // file may have been moved/deleted between event and processing
  }
  if (!stat.isFile()) return;

  // Content-hash dedup
  let hash;
  try {
    hash = fileSha256(filePath);
  } catch (e) {
    warn(`could not hash ${filePath}: ${e.message}`);
    return;
  }

  if (await isAlreadyUploaded(companyId, hash)) return;

  // Read and upload
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (e) {
    warn(`could not read ${filePath}: ${e.message}`);
    return;
  }

  const contentType = ext === '.csv' ? 'text/csv'
    : ext === '.pdf' ? 'application/pdf'
    : ext === '.png' ? 'image/png'
    : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : 'application/octet-stream';

  const entityId = uuid();
  const idempotencyKey = `feed-${hash}`;

  try {
    await _uploadFn(companyId, config.entityType, entityId, filename, buffer, contentType, idempotencyKey);
    log(`uploaded ${companyId}/${subfolder}/${filename} (${config.entityType})`);
  } catch (e) {
    warn(`upload failed for ${companyId}/${subfolder}/${filename}: ${e.message}`);
    return; // leave the file in place — a failed upload should be retried on the next scan
  }

  // The upload above already copied the bytes into the durable attachments
  // store (ATTACHMENTS_ROOT) — the inbox-folder copy is now redundant, not
  // archival. Remove it so it can't be re-swept and re-processed by a future
  // boot (nothing here ever moved/deleted it before, so every restart kept
  // re-examining every file ever dropped — harmless only when the sha256
  // dedup check catches it, and silently NOT harmless whenever the same
  // logical file's bytes differ slightly between drops, e.g. a re-exported
  // bank statement with the same name).
  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    warn(`could not remove ${filePath} after upload: ${e.message}`);
  }
}

/**
 * Scan a single company's inbox folders for new files.
 * Used for startup sweep and polling fallback.
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
      const filePath = path.join(dir, filename);
      await processFile(companyId, subfolder, filePath, filename, config);
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
 * Set up fs.watch() on a single company's subfolder.
 * Returns the watcher handle, or null if watch failed (caller should fall back to polling).
 */
function watchCompanySubfolder(companyId, subfolder, dir, config) {
  let watcher;
  // Keyed per filename, not one shared timer per watcher — a single shared
  // timer meant a second file dropped within DEBOUNCE_MS of a first would
  // clearTimeout() the first file's pending run and silently drop it, never
  // processed at all (found while fixing the file-not-removed issue above).
  const debounceTimers = new Map();
  try {
    watcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
      if (!filename || _shuttingDown) return;

      const filePath = path.join(dir, filename);
      const ext = path.extname(filename).toLowerCase();
      if (!config.exts.includes(ext)) return;

      // Debounce: fs.watch can fire multiple events for one logical
      // operation (rename + change, or multiple writes during copy).
      // Wait DEBOUNCE_MS then process this file once.
      if (debounceTimers.has(filename)) clearTimeout(debounceTimers.get(filename));
      debounceTimers.set(filename, setTimeout(() => {
        debounceTimers.delete(filename);
        if (_shuttingDown) return;
        // Verify file still exists (rename events fire for both src and dst)
        if (!fs.existsSync(filePath)) return;
        processFile(companyId, subfolder, filePath, filename, config).catch((e) => {
          warn(`error processing ${filePath}: ${e.message}`);
        });
      }, DEBOUNCE_MS));
    });
    watcher._debounceTimers = debounceTimers;
  } catch (e) {
    warn(`fs.watch failed on ${dir}: ${e.message} — will use polling fallback`);
    return null;
  }

  // fs.watch can emit 'error' events (e.g. watched directory deleted)
  watcher.on('error', (e) => {
    warn(`watch error on ${dir}: ${e.message || e}`);
  });

  return watcher;
}

/**
 * Start the watcher. The uploadFn is injected by the caller (server.js / index.js)
 * to avoid a circular dependency on index.js.
 *
 * Strategy:
 * 1. Run an immediate full scan (catches files dropped while server was down)
 * 2. Set up fs.watch() on each company's subfolders (instant detection)
 * 3. If fs.watch() fails on all folders, fall back to interval-based polling
 *
 * @param {function} uploadFn — async (companyId, entityType, entityId, filename, buffer, contentType, idempotencyKey) => void
 */
function startFeedWatcher(uploadFn) {
  if (_watchers.length > 0 || _fallbackTimer) {
    warn('already running');
    return;
  }
  _shuttingDown = false;
  _uploadFn = uploadFn;

  // 1. Immediate startup scan — catches files dropped while server was down.
  //    fs.watch only sees events after it starts, so anything already in the
  //    folder would be missed without this.
  scanOnce(uploadFn).then(async () => {
    if (_shuttingDown) return;

    // 2. Set up fs.watch() on each company's subfolders
    let companies;
    try {
      companies = await getAllCompanies();
    } catch (e) {
      warn(`could not list companies for watch setup: ${e.message}`);
      return;
    }

    let watchCount = 0;
    let fallbackNeeded = false;

    for (const { company_id: companyId } of companies) {
      if (_shuttingDown) return;
      const inboxPath = await getCompanyInboxPath(companyId);

      for (const [subfolder, config] of Object.entries(SUBFOLDERS)) {
        if (_shuttingDown) return;
        const dir = path.join(inboxPath, companyId, subfolder);
        if (!fs.existsSync(dir)) continue;

        // Ensure directory exists — create it so the user can drop files
        // without having to pre-create the structure
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch { /* may already exist */ }

        const watcher = watchCompanySubfolder(companyId, subfolder, dir, config);
        if (watcher) {
          _watchers.push(watcher);
          watchCount++;
        } else {
          fallbackNeeded = true;
        }
      }
    }

    // 3. If any watch setup failed, or no folders exist to watch, use polling fallback
    if (fallbackNeeded || watchCount === 0) {
      const intervalMs = await getFallbackInterval();
      _fallbackTimer = setInterval(() => {
        scanOnce(uploadFn).catch((e) => warn(`fallback scan failed: ${e.message}`));
      }, intervalMs);
      _fallbackTimer.unref();
      log(`started (inotify on ${watchCount} folder(s), polling fallback every ${intervalMs}ms)`);
    } else {
      log(`started (inotify on ${watchCount} folder(s))`);
    }
  }).catch((e) => warn(`startup scan failed: ${e.message}`));
}

async function getFallbackInterval() {
  try {
    const val = await getInstallSetting('feed_watcher_interval_ms');
    return val && Number(val) > 0 ? Math.floor(Number(val)) : DEFAULT_FALLBACK_INTERVAL_MS;
  } catch {
    return DEFAULT_FALLBACK_INTERVAL_MS;
  }
}

function stopFeedWatcher() {
  _shuttingDown = true;
  for (const w of _watchers) {
    if (w._debounceTimers) for (const t of w._debounceTimers.values()) clearTimeout(t);
    w.close();
  }
  _watchers = [];
  if (_fallbackTimer) {
    clearInterval(_fallbackTimer);
    _fallbackTimer = null;
  }
  _uploadFn = null;
  log('stopped');
}

function getStatus() {
  return {
    running: _watchers.length > 0 || !!_fallbackTimer,
    lastScan: _lastScan ? new Date(_lastScan).toISOString() : null,
    watchers: _watchers.length,
    fallback: !!_fallbackTimer,
  };
}

module.exports = {
  startFeedWatcher,
  stopFeedWatcher,
  getStatus,
  scanOnce, // exported for testing
};
