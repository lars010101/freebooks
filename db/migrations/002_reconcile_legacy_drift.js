'use strict';
// 002 — drop the dead report_runs table, which older databases still carry
// (no code references it). Skipped with a log line if it has rows; a no-op on
// fresh databases.
//
// Found 2026-11-22 by diffing an upgraded production copy against a fresh
// database. Remaining differences on older databases are deliberately left
// alone, because they don't change behaviour and DuckDB can't ALTER a table
// that has indexes inside a transaction:
//   - bills.ap_account and payments.direction are nullable (NOT NULL on fresh
//     databases); every write path sets both and production has no NULLs;
//   - bills.bill_id / journal_entries.entry_id uniqueness is a unique index
//     rather than an inline UNIQUE constraint (same enforcement);
//   - column order in bills and payments differs (ALTER ADD COLUMN appends).

exports.up = async ({ run, all }) => {
  const rr = await all(`SELECT 1 FROM duckdb_tables() WHERE schema_name = 'main' AND table_name = 'report_runs'`);
  if (rr.length === 0) return;
  const n = await all('SELECT count(*) AS n FROM report_runs');
  if (Number(n[0].n) === 0) await run('DROP TABLE report_runs');
  else console.warn(`002: report_runs kept: it has ${n[0].n} rows`);
};
