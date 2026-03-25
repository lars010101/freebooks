/**
 * Skuld — Backup / Export service
 *
 * Vendor-neutral export of all company data in JSON + CSV format.
 */

/**
 * Route backup actions.
 */
async function handleBackup(ctx, action) {
  switch (action) {
    case 'backup.export':
      return exportAll(ctx);
    default:
      throw Object.assign(new Error(`Unknown backup action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

/**
 * Export all data for a company as structured JSON.
 *
 * Returns the data directly. The caller (Apps Script or Cloud Scheduler)
 * is responsible for writing to the chosen destination.
 */
async function exportAll(ctx) {
  const { dataset, companyId } = ctx;

  const tables = [
    'companies',
    'accounts',
    'journal_entries',
    'vat_codes',
    'bank_mappings',
    'settings',
    'user_permissions',
    'bills',
    'bill_payments',
    'fx_rates',
    'centers',
    'report_runs',
    'audit_log',
  ];

  const exportData = {};

  for (const table of tables) {
    const [rows] = await dataset.query({
      query: `SELECT * FROM finance.${table} WHERE company_id = @companyId`,
      params: { companyId },
    });
    exportData[table] = rows;
  }

  // fx_rates doesn't have company_id — export all
  const [fxRows] = await dataset.query({
    query: `SELECT * FROM finance.fx_rates ORDER BY date DESC LIMIT 10000`,
  });
  exportData.fx_rates = fxRows;

  return {
    companyId,
    exportedAt: new Date().toISOString(),
    schemaVersion: '1.0.0',
    tables: Object.fromEntries(
      Object.entries(exportData).map(([table, rows]) => [table, {
        rowCount: rows.length,
        data: rows,
      }])
    ),
  };
}

module.exports = { handleBackup };
