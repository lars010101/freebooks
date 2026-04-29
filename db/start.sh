#!/bin/bash
# freeBooks startup — runs on every shell entry via .bashrc

DB_PATH="${HOME}/.freebooks/freebooks.duckdb"

echo ""
echo "📒 freeBooks"
echo "────────────────────────────────"
echo -n "Checking for existing database... "

if [ -f "$DB_PATH" ]; then
  echo "Found ($DB_PATH)"
  echo -n "Verifying schema... "
  node /home/user/freebooks/db/init.js > /dev/null 2>&1
  echo "OK"
else
  echo "Not found"
  echo -n "Initializing $DB_PATH... "
  mkdir -p "$(dirname "$DB_PATH")"
  node /home/user/freebooks/db/init.js > /dev/null 2>&1
  echo "Done"
fi

echo "DB ready ✓"
echo "────────────────────────────────"
echo ""
