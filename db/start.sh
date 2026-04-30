#!/bin/bash
# freeBooks startup — runs on every shell entry via /etc/profile.d/freebooks.sh

# Prefer container's node/npm over host-injected versions
export PATH="/usr/bin:/usr/sbin:$PATH"

DB_PATH="${HOME}/.freebooks/freebooks.duckdb"

echo ""
echo "📒 freeBooks"
echo "────────────────────────────────"

# DB check
echo -n "Checking for existing database... "
if [ -f "$DB_PATH" ]; then
  echo "Found"
  echo -n "Verifying schema... "
  node /opt/freebooks/db/init.js > /dev/null 2>&1
  echo "OK"
else
  echo "Not found"
  echo -n "Initializing $DB_PATH... "
  mkdir -p "$(dirname "$DB_PATH")"
  node /opt/freebooks/db/init.js > /dev/null 2>&1
  echo "Done"
fi

echo "DB ready ✓"
echo "────────────────────────────────"
echo ""
