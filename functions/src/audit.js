/**
 * Skuld — Audit logging
 *
 * Field-level change tracking for structural data.
 */

const { v4: uuid } = require('uuid');

/**
 * Log a change to the audit_log table.
 *
 * @param {object} dataset - BigQuery dataset
 * @param {string} companyId
 * @param {string} tableName - e.g., 'accounts', 'settings'
 * @param {string} recordId - primary key of the changed record
 * @param {string} action - 'create', 'update', 'delete'
 * @param {string} changedBy - user email
 * @param {object} changes - { fieldName: { old, new } } for updates, null for create/delete
 */
async function auditLog(dataset, companyId, tableName, recordId, action, changedBy, changes) {
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

  if (rows.length > 0) {
    await dataset.table('audit_log').insert(rows);
  }
}

module.exports = { auditLog };
