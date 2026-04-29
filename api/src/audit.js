'use strict';
/**
 * freeBooks — Audit logging
 */

const { v4: uuid } = require('uuid');
const { bulkInsert } = require('./db');

async function auditLog(companyId, tableName, recordId, action, changedBy, changes) {
  const now = new Date().toISOString();
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
    });
  }

  if (rows.length > 0) await bulkInsert('audit_log', rows);
}

module.exports = { auditLog };
