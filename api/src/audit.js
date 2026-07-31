'use strict';
/**
 * freeBooks — Audit logging (with A1 actor attribution)
 *
 * `auditLog` (field-level old/new history) and `auditCall` (P0-4 dispatch
 * invocation audit) both gain an optional trailing `actor` param:
 *   actor = { actorType: 'human' | 'agent', requestId: string|null }
 * defaulting to `{ actorType: 'human', requestId: null }` so existing call
 * sites are unaffected. The `actor_type` and `request_id` columns (added by
 * the §2.4 schema migration) are stamped on every insert; `changed_by`
 * stays the actor email for provenance continuity.
 */

const { v4: uuid } = require('uuid');
const { bulkInsert } = require('./db');

const DEFAULT_ACTOR = { actorType: 'human', requestId: null };

function actorFields(actor) {
  const a = actor || DEFAULT_ACTOR;
  return {
    actor_type: a.actorType || 'human',
    request_id: a.requestId != null ? String(a.requestId) : null,
  };
}

async function auditLog(companyId, tableName, recordId, action, changedBy, changes, actor) {
  const now = new Date().toISOString();
  const stamp = actorFields(actor);
  const rows = [];

  if (action === 'update' && changes) {
    for (const [fieldName, { old: oldVal, new: newVal }] of Object.entries(changes)) {
      rows.push({
        company_id: companyId,
        log_id: uuid(),
        table_name: tableName,
        record_id: recordId,
        action,
        field_name: fieldName,
        old_value: oldVal != null ? String(oldVal) : null,
        new_value: newVal != null ? String(newVal) : null,
        changed_by: changedBy,
        changed_at: now,
        ...stamp,
      });
    }
  } else {
    rows.push({
      company_id: companyId,
      log_id: uuid(),
      table_name: tableName,
      record_id: recordId,
      action,
      field_name: null,
      old_value: null,
      new_value: null,
      changed_by: changedBy,
      changed_at: now,
      ...stamp,
    });
  }

  if (rows.length > 0) await bulkInsert('audit_log', rows);
}

/**
 * P0-4: dispatch-level invocation audit. One row per mutating API action:
 * table_name='api', record_id=<action name>, action='invoke', and the full
 * request payload (truncated) in new_value. Entity-level auditLog() calls
 * (journal imports, entry updates) remain for field-level old/new history;
 * this is the complete-coverage safety net for every other mutation
 * (bills, settings, COA, permissions, company, VAT codes, FX, bank...).
 *
 * A1: stamps `actor_type` + `request_id` from the optional `actor` arg.
 */
async function auditCall(companyId, action, changedBy, payload, actor) {
  let json;
  try { json = JSON.stringify(payload ?? {}); } catch { json = '"<unserializable>"'; }
  if (json.length > 8000) json = json.slice(0, 8000) + '…[truncated]';
  const stamp = actorFields(actor);
  await bulkInsert('audit_log', [{
    company_id: companyId || null,
    log_id: uuid(),
    table_name: 'api',
    record_id: action,
    action: 'invoke',
    field_name: null,
    old_value: null,
    new_value: json,
    changed_by: changedBy,
    changed_at: new Date().toISOString(),
    ...stamp,
  }]);
}

module.exports = { auditLog, auditCall };
