# Feeding data to agents — operator guide

How documents, statements, and events flow into freebooks so an agent can pick
them up and prepare bookings. Covers the pipeline contract, every inbound path,
and the approval loop. Setup first: `docs/agent-setup-guide.md`.

---

## 1. The pipeline

```
 invoice PDF ─┐
 receipt jpg ─┼─► attachment.upload ─► attachment.uploaded event ─► agent extracts
 bank CSV ────┤        (underlag)          (event.list poll)      │  (OCR/VLM,
 email ───────┘                                                        │   LLM)
                                                                      ▼
 you approve in /:company/journal ◄── review queue ◄── journal.propose
        y (approve)                                          (+ underlag badge)
        ▼
 journal.posted ─► ledger, reports, filings
```

The design rules that make this safe (agent-readiness-spec §4):

- **Propose, never post.** The agent's only write to accounting data is
  `journal.propose`. A batch reaches `journal_entries` only when a human
  approves it — and the posted rows carry *your* name as poster.
- **Underlag by convention (A4).** Every proposal should carry its source
  documents. Missing underlag never blocks (BFL 5 kap allows egen
  verifikation) but is flagged — you see a "no underlag" marker in the queue.
- **The event stream is the work queue.** Agents don't watch folders or
  inboxes — they poll `event.list` and react.

---

## 2. Work discovery: the event contract

Agents poll one action:

```
event.list { after_seq: <last seen>, type?: <filter>, limit?: ≤500 }
→ rows ordered by event_seq ASC
```

The caller stores the highest `event_seq` seen and passes it as `after_seq`
next time — monotonic, gap-safe, replay-safe. Via MCP this is the
`event_list` tool (same params).

Event types and what an agent should do with them:

| Event | Meaning | Agent action |
|---|---|---|
| `attachment.uploaded` | New source document landed | **The feed trigger.** Fetch it (entity refs on the event), extract, `journal.propose` with the same proposalId |
| `journal.proposed` | A proposal entered the queue | Informational (your own or another agent's work) |
| `journal.approved` | Human approved a proposal | Audit trail; learn from accepted patterns |
| `journal.rejected` | Human rejected (with note) | Read the note; fix and re-propose with the same `proposalId` (upsert) |
| `journal.posted` | A batch posted (any path) | Ledger changed — refresh any cached balances |
| `bill.posted` | AP bill posted | Informational |
| `bill.payment.recorded` / `.voided` | Settlement / settlement reversal | Informational |
| `period.locked` / `.unlocked` | Close calendar moved | Never propose into a locked period |

Payloads are capped at 4000 chars. Oversized payloads arrive as
`{"_truncated": true, "original_chars": N, "preview": "…"}` — always valid
JSON; when you see `_truncated`, re-fetch the full entity
(`entity_type`/`entity_id` on the row) instead of parsing the preview.

---

## 3. The underlag binding (A4) — how documents attach to proposals

The convention (no API changes, spec §4.7):

1. **Mint the `proposalId` client-side** (any uuid).
2. **Upload first:** `attachment.upload` with `entityType: "journal_proposal"`,
   `entityId: <proposalId>`, the file base64 in `contentBase64`.
3. **Then propose:** `journal.propose` with `proposalId: <same id>`.

What you get for it:

- `journal.propose` returns `attachment_count`; 0 → `warnings: ["no_underlag"]`
  (warn, never block).
- The review queue shows the count per row; unfolding previews the documents.
- On approve, the attachments re-bind to the posted journal batch in the same
  transaction (they become voucher underlag — BFL 7 kap retention applies;
  they are never GC'd after that).
- On reject/expire, orphaned proposal attachments are garbage-collected after
  a 30-day grace period.

Limits for `journal_proposal` uploads: **15 MB per file, pdf/jpg/png only**,
sha256 dedupe per company (identical file re-uses the stored blob). Other
entity types keep the legacy 32 MB cap. All base64 transport inflates size
~33%; the JSON body limit is 50 MB.

---

## 4. Inbound paths (getting data IN)

### 4.1 Browser upload (human-driven)

Attach files directly on the bill/journal screens — they land as
`attachment.uploaded` events like any other path. Good for one-offs.

### 4.2 curl / script upload (automation)

```bash
PID=$(uuidgen)
curl -X POST "$API/api" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: feed-$(sha256sum invoice.pdf | cut -d' ' -f1)" \
  ${FREEBOOKS_API_TOKEN:+-H "Authorization: Bearer $FREEBOOKS_API_TOKEN"} \
  -d "$(jq -n --arg co "$FREEBOOKS_COMPANY" --arg user "$FREEBOOKS_USER" \
        --arg pid "$PID" --arg fn "invoice.pdf" \
        --arg b64 "$(base64 -w0 invoice.pdf)" \
        '{action:"attachment.upload", companyId:$co, userEmail:$user,
          entityType:"journal_proposal", entityId:$pid, filename:$fn,
          contentBase64:$b64, contentType:"application/pdf"}')"
```

**Idempotency for feeds:** use `Idempotency-Key: feed-<sha256 of file>` as a
natural key — re-dropping the same file replays the first response instead of
creating a duplicate (the sha256 blob dedupe then covers cross-key repeats).

### 4.3 Drop-folder watcher (scans, phone photos, synced folders)

Point your scanner/phone sync at `~/freebooks-inbox`, run this under
systemd/tmux (`apt install inotify-tools`):

```bash
#!/usr/bin/env bash
# freebooks-feed-watch.sh — upload every file dropped in the inbox as
# proposal-bound underlag (§3), one client-minted proposalId per file.
set -euo pipefail
DIR="${1:-$HOME/freebooks-inbox}"
API="${FREEBOOKS_API_URL:-http://127.0.0.1:3000}"
inotifywait -m -e close_write --format '%f' "$DIR" | while read -r f; do
  case "$f" in *.pdf|*.PDF|*.jpg|*.jpeg|*.png) ;; *) echo "skip $f"; continue;; esac
  pid=$(uuidgen); path="$DIR/$f"
  key=$(sha256sum "$path" | cut -d' ' -f1)
  curl -sS -X POST "$API/api" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: feed-$key" \
    ${FREEBOOKS_API_TOKEN:+-H "Authorization: Bearer $FREEBOOKS_API_TOKEN"} \
    -d "$(jq -n --arg co "$FREEBOOKS_COMPANY" --arg user "$FREEBOOKS_USER" \
          --arg pid "$pid" --arg fn "$f" --arg b64 "$(base64 -w0 "$path")" \
          '{action:"attachment.upload", companyId:$co, userEmail:$user,
            entityType:"journal_proposal", entityId:$pid, filename:$fn,
            contentBase64:$b64}')" \
    && echo "$(date -Is) uploaded $f (proposal $pid)"
done
```

### 4.4 Email-in

Fetch invoices from a mailbox with any IMAP tool (e.g. himalaya, fetchmail),
save attachments to the inbox dir above — the watcher does the rest. Keep the
IMAP credentials in the mail tool's own config; the freebooks token only needs
to live in the watcher's environment.

### 4.5 Bank statements

Bank import is **human / data_entry automation**, not agent: `bank.process` /
`bank.approve` are data_entry actions and stay outside the agent whitelist by
design. Import via **/bank?tab=import** (CSV wizard) or a data_entry cron
calling `bank.process {rows, bankAccount}`. After import, posted batches appear
as `journal.posted` events — the agent reads them and can propose adjustments
or reclassifications, which you approve as usual.

### 4.6 Migration data (SIE)

`sie.import` (SE jurisdiction only) takes the whole SIE file
(`contentBase64`, types 1–4, CP437/UTF-8 auto-detect) with `dryRun` **default
true** — preview first, commit explicit. Also human/data_entry, not
agent-whitelisted.

---

## 5. What good agent output looks like

A proposal the human can approve in one glance:

- **Balanced lines** (`account_code`, `debit`, `credit`, `date`,
  `description`; optional `vat_code`, `currency`) — the server enriches and
  validates (VAT split from the code, FX rate, period window, balance); a
  validation failure comes back as an error, nothing is queued.
- **VAT by code, never by guessed amount** — lines carry the VAT code;
  amounts are computed server-side. Supplier-stated totals that disagree with
  the computation surface as tolerance warnings on the proposal, not silent
  overrides.
- **Underlag attached** (§3) — the queue badge shows the count.
- **Idempotent retries** — extraction retries reuse the same `proposalId`
  (upserts the still-proposed row) and the same `idempotency_key`.
- **Unknown account?** propose anyway with a clear description — unknown codes
  fail validation *before* queueing, so bad proposals never reach you.

## 6. The approval loop (your side)

**/:company/journal** — the review queue:

- Proposed batches pin above posted ones; sidebar badge shows pending count.
- `y` approve → posts with *you* as `created_by` (the agent origin stays on
  the proposal row + audit trail). `x` reject → terminal, with an optional
  note the agent can read (`journal.rejected` event).
- `f` filters by status; unfolding a proposal previews lines and underlag.
- Approve is claim-first atomic: double-approving is impossible
  (`INVALID_STATUS` on the second), and a post failure rolls the proposal back
  to `proposed`, nothing half-posted.

## 7. Security notes for feeds

- Feed scripts should use the **agent account + agent-role token** — a leaked
  feed credential can read books and upload/propose, but can never post,
  approve, or change master data.
- Keep pdf/jpg/png discipline at the source (the watcher above filters);
  executables in the inbox are skipped, not uploaded.
- Disk safety: 15 MB cap + per-company sha256 dedupe + 30-day GC for
  rejected/orphaned proposal attachments. The attachments directory is in DB
  backup scope — include it in host backups.
