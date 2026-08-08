'use strict';
/**
 * freeBooks — Notifications service (fx-automation-spec §7)
 *
 * Minimal notifications subsystem: table + list + mark_read.
 * The topbar bell gets a backend. Built once, reusable for future alerts
 * (locked-period posts, failed imports, etc.) — same table, same actions.
 *
 * Dedupe: one open notification per issue_key (e.g. 'fx-gap:<company>:<period>').
 * Re-raise only after the previous one was read AND the issue persists on
 * the next scan.
 */

const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert } = require('./db');

async function handleNotifications(ctx, action) {
  switch (action) {
    case 'notifications.list':    return listNotifications(ctx);
    case 'notifications.mark_read': return markRead(ctx);
    default:
      throw Object.assign(new Error(`Unknown notifications action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

/**
 * List notifications for the current company, unread first.
 * Optional body.all = true returns read notifications too.
 */
async function listNotifications(ctx) {
  const { companyId, body } = ctx;
  const all = body && body.all === true;
  let sql = `SELECT id, company_id, created_at, kind, message, issue_key, read_at
             FROM notifications WHERE company_id = @companyId`;
  const params = { companyId };
  if (!all) {
    sql += ` AND read_at IS NULL`;
  }
  sql += ` ORDER BY read_at IS NULL DESC, created_at DESC LIMIT 100`;
  const rows = await query(sql, params);
  return {
    notifications: rows.map(r => ({
      id: r.id,
      kind: r.kind,
      message: r.message,
      issue_key: r.issue_key,
      created_at: r.created_at,
      read_at: r.read_at,
    })),
    unread_count: rows.filter(r => !r.read_at).length,
  };
}

/**
 * Mark notifications as read.
 * body.ids = array of IDs to mark read, or body.all = true to mark all read.
 */
async function markRead(ctx) {
  const { companyId, body } = ctx;
  const { ids, all } = body;

  if (all === true) {
    await exec(
      `UPDATE notifications SET read_at = NOW() WHERE company_id = @companyId AND read_at IS NULL`,
      { companyId }
    );
    return { marked: true, all: true };
  }

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    throw Object.assign(new Error('ids array or all=true required'), { code: 'INVALID_INPUT' });
  }

  for (const id of ids) {
    await exec(
      `UPDATE notifications SET read_at = NOW() WHERE id = @id AND company_id = @companyId AND read_at IS NULL`,
      { id, companyId }
    );
  }
  return { marked: true, count: ids.length };
}

/**
 * Raise a notification (internal — called by the scanner).
 * Dedupe: if an unread notification with the same issue_key exists, skip.
 */
async function raiseNotification(companyId, kind, message, issueKey) {
  if (issueKey) {
    const existing = await query(
      `SELECT id FROM notifications WHERE company_id = @companyId AND issue_key = @issueKey AND read_at IS NULL LIMIT 1`,
      { companyId, issueKey }
    );
    if (existing.length > 0) return false; // already raised, unread
  }

  await bulkInsert('notifications', [{
    id: uuid(),
    company_id: companyId,
    kind,
    message,
    issue_key: issueKey || null,
    read_at: null,
  }]);
  return true;
}

module.exports = { handleNotifications, listNotifications, markRead, raiseNotification };
