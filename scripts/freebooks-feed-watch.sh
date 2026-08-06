#!/usr/bin/env bash
# freebooks-feed-watch.sh — upload files dropped in the inbox subfolders.
# Subfolder determines entityType and accepted file types.
set -euo pipefail
INBOX="${1:-$HOME/freebooks-inbox}"
API="${FREEBOOKS_API_URL:-http://127.0.0.1:3000}"

# Subfolder → entityType + accepted extensions
declare -A ENTITY_TYPE=(
  [bank]="bank_statement"  [bills]="bill"
  [receipts]="journal_proposal"  [journal]="journal_proposal"
)
declare -A EXT_FILTER=(
  [bank]="*.csv *.CSV *.pdf *.PDF"
  [bills]="*.pdf *.PDF *.jpg *.jpeg *.png"
  [receipts]="*.pdf *.PDF *.jpg *.jpeg *.png"
  [journal]="*.pdf *.PDF *.jpg *.jpeg *.png"
)

upload() {  # $1=subfolder $2=filename
  local sub="$1" f="$2" etype pid path key
  etype="${ENTITY_TYPE[$sub]:-journal_proposal}"
  pid=$(uuidgen); path="$INBOX/$sub/$f"
  key=$(sha256sum "$path" | cut -d' ' -f1)
  curl -sS -X POST "$API/api" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: feed-$key" \
    ${FREEBOOKS_API_TOKEN:+-H "Authorization: Bearer ***"} \
    -d "$(jq -n --arg co "$FREEBOOKS_COMPANY" --arg user "$FREEBOOKS_USER" \
          --arg et "$etype" --arg pid "$pid" --arg fn "$f" \
          --arg b64 "$(base64 -w0 "$path")" \
          '{action:"attachment.upload", companyId:$co, userEmail:$user,
            entityType:$et, entityId:$pid, filename:$fn,
            contentBase64:$b64}')" \
    && echo "$(date -Is) uploaded $sub/$f ($etype, id $pid)"
}

# Watch each subfolder + the root (legacy default)
for sub in bank bills receipts journal ""; do
  dir="$INBOX/$sub"
  [[ -d "$dir" ]] || mkdir -p "$dir"
  exts="${EXT_FILTER[${sub:-root}]:-*.pdf *.PDF *.jpg *.jpeg *.png}"
  (
    inotifywait -m -e close_write --format '%f' "$dir" | while read -r f; do
      matched=0
      for pat in $exts; do case "$f" in $pat) matched=1; break;; esac; done
      [[ "$matched" -eq 1 ]] || { echo "skip $sub/$f (wrong type)"; continue; }
      upload "${sub:-root}" "$f"
    done
  ) &
done
wait
