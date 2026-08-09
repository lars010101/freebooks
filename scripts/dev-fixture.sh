#!/usr/bin/env bash
# freeBooks — dev fixture script
# One command → running, seeded dev instance on :4722 (default).
# Idempotent: deletes and recreates its throwaway DB every run.
# NEVER touches ~/.freebooks/freebooks.duckdb (user's real dev data).
#
# Override:
#   FREEBOOKS_DB_PATH=/tmp/other.duckdb PORT=4888 scripts/dev-fixture.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DB_PATH="${FREEBOOKS_DB_PATH:-/tmp/fb-fixture.duckdb}"
PORT="${PORT:-4722}"

# ── 1. Wipe + recreate the throwaway DB ──────────────────────────────────────
echo "▸ DB: $DB_PATH"
rm -f "$DB_PATH" "$DB_PATH.wal"
FREEBOOKS_DB_PATH="$DB_PATH" node db/init.js
echo "▸ DB initialized."

# ── 2. Start the API server in the background ────────────────────────────────
FREEBOOKS_DB_PATH="$DB_PATH" PORT="$PORT" node api/src/index.js &
SERVER_PID=$!
SEED_DIR="$(mktemp -d)"
# Kill the server + remove temp dir on exit (normal end, Ctrl+C, error).
_cleanup () {
  kill $SERVER_PID 2>/dev/null || true
  rm -rf "$SEED_DIR"
}
trap '_cleanup' EXIT INT TERM

BASE="http://localhost:$PORT"

# ── 3. Poll /health until the server is ready (max ~10s) ─────────────────────
echo "▸ Waiting for server on :$PORT ..."
ready=0
for _ in $(seq 1 50); do
  if curl -sf "$BASE/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.2
done
if [ "$ready" -ne 1 ]; then
  echo "✗ Server did not become healthy within 10s." >&2
  exit 1
fi
echo "▸ Server ready."

# ── 4. Seed via POST /api/action (top-level JSON params) ─────────────────────
post () {  # post <json-file-path>
  local body
  body="$(cat "$1")"
  local resp
  resp="$(curl -sS -X POST "$BASE/api/action" \
    -H 'Content-Type: application/json' \
    -d "$body")"
  if ! printf '%s' "$resp" | grep -q '"ok":true'; then
    echo "✗ Seed step failed ($1):" >&2
    printf '%s\n' "$resp" >&2
    exit 1
  fi
  echo "  ✓ $1"
}

cat > "$SEED_DIR/01-company.json" <<'JSON'
{"action":"setup.add_company","company":{"company_id":"verify","company_name":"Verify Co","jurisdiction":"SE","currency":"USD","fy_start":"2026-01-01","fy_end":"2026-12-31"}}
JSON

cat > "$SEED_DIR/02-partner.json" <<'JSON'
{"action":"partner.upsert","companyId":"verify","partner":{"partner_id":"v1","name":"future","default_currency":"USD"}}
JSON

cat > "$SEED_DIR/03-bill-b1.json" <<'JSON'
{"action":"bill.draft.save","companyId":"verify","bill":{"bill_id":"b1","partner_name":"future","date":"2026-01-01","issue_date":"2026-01-01","due_date":"2026-02-01","reference":"reference1","currency":"USD","lines":[{"description":"line one","expense_account":"5000","amount":100}]}}
JSON

cat > "$SEED_DIR/04-bill-b2.json" <<'JSON'
{"action":"bill.draft.save","companyId":"verify","bill":{"bill_id":"b2","partner_name":"future","date":"2026-01-01","issue_date":"2026-01-01","due_date":"2026-02-01","reference":"hhhhh","currency":"USD","lines":[{"description":"line two","expense_account":"5000","amount":50}]}}
JSON

echo "▸ Seeding:"
post "$SEED_DIR/01-company.json"
post "$SEED_DIR/02-partner.json"
post "$SEED_DIR/03-bill-b1.json"
post "$SEED_DIR/04-bill-b2.json"

# ── 5. Summary ───────────────────────────────────────────────────────────────
cat <<EOF

═══════════════════════════════════════════════════════════════════════════════
 freeBooks dev fixture — ready
═══════════════════════════════════════════════════════════════════════════════
  URL            : $BASE/verify/payables
  Company id     : verify  (Verify Co, SE, USD)
  Partner        : future  (v1)
  Draft bills    : b1 (reference1, 100.00 USD)  ·  b2 (hhhhh, 50.00 USD)
  DB             : $DB_PATH  (throwaway — safe to delete)

  Stop the server : Ctrl+C  (or: kill $SERVER_PID)
═══════════════════════════════════════════════════════════════════════════════

EOF

# ── 6. Keep the server in the foreground so Ctrl+C kills everything ──────────
wait $SERVER_PID
