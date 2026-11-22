#!/bin/bash
# freeBooks startup banner — runs on every login-shell entry into the
# distrobox dev container via /etc/profile.d/freebooks.sh.
#
# It deliberately does NOT touch the database. It used to run db/init.js on
# ~/.freebooks/freebooks.duckdb on every shell entry, which applied whatever
# migration code was in the working tree to the real database whenever any
# command entered the container (2026-11-22, during #307). The server applies
# pending migrations on start (after a backup), and `node db/init.js` does
# the same on demand.

# Prefer container's node/npm over host-injected versions
export PATH="/usr/bin:/usr/sbin:$PATH"

DB_PATH="${FREEBOOKS_DB_PATH:-${HOME}/.freebooks/freebooks.duckdb}"

echo ""
echo "📒 freeBooks"
echo "────────────────────────────────"
if [ -f "$DB_PATH" ]; then
  echo "Database: $DB_PATH (migrations run when the server starts)"
else
  echo "No database yet at $DB_PATH — the server creates it on first start."
fi
echo "────────────────────────────────"
echo ""
