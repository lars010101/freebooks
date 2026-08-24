# Feeding data to agents — operator guide

How documents, statements, and events flow into freebooks so an agent can pick
them up and prepare bookings. Covers the pipeline contract, every inbound path,
and the approval loop. Setup first: `docs/agent-setup-guide.md`.

---

## 1. The pipeline

```
 bank CSV ───► ~/freebooks-inbox/bank/  ─┐
 invoice PDF ─► ~/freebooks-inbox/bills/ ┼─► attachment.upload (entityType from folder)
 receipt jpg ─► ~/freebooks-inbox/receipts/─┘        │
                                                    ▼
                                       attachment.uploaded event
                                       (agent polls event.list)
                                                    │
                                       ┌────────────┼────────────┐
                                       ▼            ▼            ▼
                                  bank_statement    bill    journal_proposal
                                       │            │            │
                                  parse lines    extract       extract
                                  run cascade    vendor/amt    amount/date
                                       │            │            │
                                  journal.propose  bill.create   journal.propose
                                  (per line)       (§4.5b)      (one proposal)
                                       │            │            │
                                       └────────────┴────────────┘
                                                    ▼
                              you approve in /:company/inbox
                                     y (approve) / x (reject)
                                                    ▼
                              journal.posted → ledger, reports, filings
```

**Folder structure is the classification** — the subfolder a file lands in
determines its `entityType` and the agent's processing path (§4.3). An optional
preprocessor (operator-managed, not part of freebooks) can read incoming files
and route them to the right subfolder before the watcher sees them.

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
| `attachment.uploaded` | New source document landed | **The feed trigger.** Fetch it (entity refs on the event), classify by `entityType` (set by folder structure at upload time — `bank_statement`, `bill`, `journal_proposal`), then process: bank statements → cascade (`bank.match` + LLM) → `journal.propose` per line; bills → extract → `bill.create` (§4.5b — Option C ratified: agent creates a draft, human posts); receipts/journal → extract → `journal.propose`. All with the same `proposalId` for underlag binding. |
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

**Folder structure is the classification.** Subfolders under the inbox
determine the document type and the `entityType` the file is uploaded as.
The watcher maps each subfolder to a processing path:

| Subfolder | `entityType` | Agent processing path | File types |
|-----------|-------------|----------------------|------------|
| `bank/` | `bank_statement` | Parse → cascade (bank-matching-spec) → `journal.propose` per line/group | `.csv`, `.pdf` |
| `bills/` | `bill` | Extract → `bill.create` (agent creates draft; human posts via inbox — §4.5b) | `.pdf`, `.jpg`, `.png` |
| `receipts/` | `journal_proposal` | Extract → `journal.propose` | `.pdf`, `.jpg`, `.png` |
| `journal/` | `journal_proposal` | Extract → `journal.propose` | `.pdf`, `.jpg`, `.png` |
| *(root, no subfolder)* | `journal_proposal` | Legacy default — current behavior unchanged | `.pdf`, `.jpg`, `.png` |

**Preprocessor (optional, separable).** A separate routine runs *before* the
watcher — it reads files from an incoming location and moves them to the
right subfolder. V1 is a shell script with file-extension rules (`.csv` →
`bank/`, `.pdf` → root for manual sorting). A more sophisticated version can
read the first page (OCR/VLM) and route by content. The watcher doesn't know
or care — it just watches the subfolders. The preprocessor is not part of
freebooks; it's operator infrastructure, same as the IMAP fetcher in §4.4.

**Bank statements need `bank_statement` as a new `entityType` on the
`attachments` table.** Unlike receipts (one file → one proposal), a bank
statement produces N proposals. The statement is uploaded and bound to itself
(`entityType: "bank_statement"`, `entityId` = a statement UUID). The agent
fetches it via `attachment.list(entityType: "bank_statement")` when it sees
the `attachment.uploaded` event, parses the lines, runs the cascade, and mints
N proposalIds. Per-proposal underlag binding: the agent re-uploads the
statement (sha256 dedupe — one blob on disk, N metadata rows) with
`entityType: "journal_proposal"`, `entityId: <proposalId>` for each proposal
the cascade produces. This preserves the per-proposal underlag trail BFL 5 kap
requires.

```bash
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
    ${FREEBOOKS_API_TOKEN:+-H "Authorization: Bearer $FREEB...OKEN"} \
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
      local matched=0
      for pat in $exts; do case "$f" in $pat) matched=1; break;; esac; done
      [[ "$matched" -eq 1 ]] || { echo "skip $sub/$f (wrong type)"; continue; }
      upload "${sub:-root}" "$f"
    done
  ) &
done
wait
```

### 4.4 Email-in

Fetch invoices from a mailbox with any IMAP tool (e.g. himalaya, fetchmail),
save attachments to the inbox dir above — the watcher does the rest. Keep the
IMAP credentials in the mail tool's own config; the freebooks token only needs
to live in the watcher's environment.

### 4.5 Bank statements (agent-processed via cascade)

Bank statements flow through the same `attachment.upload → event → agent → journal.propose` pipeline as other documents. The agent runs the confidence/evidence cascade defined in `docs/bank-matching-spec.md` and proposes journal entries for each statement line.

**Inbound:** drop the statement (CSV or PDF) into `~/freebooks-inbox/bank/`. The watcher (§4.3) uploads it with `entityType: "bank_statement"` and fires `attachment.uploaded`. Bank API integration is out of scope for v1 — manual download + drop-folder is the supported path.

**Agent processing:**
1. Agent polls `event.list`, sees `attachment.uploaded` with `entityType: "bank_statement"`.
2. Agent fetches the statement via `attachment.list(entityType: "bank_statement")`.
3. Agent parses the statement into normalized lines (date, amount, description, counterparty if present).
4. Idempotency check: each line is deduped by bank transaction ID or content hash (bank-matching-spec §1.1) before the cascade runs.
5. Agent runs the cascade (tiers 1–3 via `bank.match`, tier 4 via LLM — bank-matching-spec §1, §8).
6. For each matched line, agent mints a `proposalId`, re-uploads the statement as underlag (`entityType: "journal_proposal"`, sha256 dedupe — one blob, N metadata rows), and calls `journal.propose`.
7. Unmatched lines with missing critical data become `input_rejection` inbox items (bank-matching-spec §11).

**Approve as usual** in `/:company/inbox` — `y` approves, `x` rejects. After review, the agent calls `matching_history.record` with the outcome to feed calibration and learning (bank-matching-spec §6, §10).

The manual CSV wizard (`bank.process`/`bank.approve`, `/bank?tab=import`) has been removed (issue #260) — the cascade above is the only import path.

### 4.5b Bills — agent creates a draft, human posts (Option C ratified)

**Amended 2026-08-05 (bills routing — Option C ratified).** The open routing
question in earlier drafts is resolved: bills go through `bill.create`, not
`journal.propose`. The agent extracts the supplier invoice and calls
`bill.create` to create a **draft** bill (not posted). The bill appears in the
inbox as a Class A item (`type: 'bill_draft'`, verbs `y`/`x`) alongside journal
proposals. The human's approval (`y`) triggers `bill.post` — journal entries are
created, the bill becomes an open payable, and tier 2 bank-statement matching
(bank-matching-spec §4) works against it. `x` discards the draft.

**Why `bill.create` and not `journal.propose`.** A bill is not just a journal
entry — it carries payables-specific structure (due date, vendor subledger
linkage, payment matching, settlement lifecycle via `bill_payments`). Routing
bills through `journal.propose` would preserve the single-gateway principle but
lose that structure, and the bill's journal entries are posted by `bill.post`,
not `journal.approve`. The two approval gates (bill-post, then later
journal-approve for the payment) are not redundant: the first admits a payable
into the ledger; the second (when the payment lands and tier 2 matches it)
clears it. This is the same two-step shape settlement already has.

**Catalog role and whitelisting.**
- `bill.create` uses catalog role `agent` (1.5), **not** `data_entry` (2) — the
  same fix already applied to `journal.propose` and `bank.match`. Dispatch runs
  the numeric role check before the agent-readiness-spec §2.3 whitelist guard;
  a `data_entry` entry would reject an agent actor (1.5 < 2) before the
  whitelist ever sees it. With role `agent`: the agent (1.5), `data_entry` (2),
  and `owner` (3) humans all pass; `viewer` (1) is excluded. The existing
  UI/`data_entry` call sites are unaffected (2≥1.5).
- `bill.create` is added to `AGENT_ALLOWED` (agent-readiness-spec §2.3). It's a
  draft creation (proposal-stage write to the `bills` table's draft state), not
  a post — same category as `journal.propose` (writes to `journal_proposals`,
  not `journal_entries`) and `mapping.suggest` (writes to `mapping_suggestions`,
  not `mappings`).
- `bill.post` (the approval action) stays `data_entry` and is **not**
  agent-whitelisted — the human's approval IS the post, the same doctrine as
  `journal.approve` (agent-readiness-spec §4.1). The agent can create a draft;
  only a human can move it to posted.

**Inbox integration.** `inbox.list` (agent-readiness-spec §10.3) fans out to
the `bills` table for drafts in addition to `journal_proposals`. A bill draft
is a Class A item (agent-readiness-spec §10.2): `type: 'bill_draft'`,
`source: 'agent'`, `counterparty: <vendor>`, `amount`, `date`,
`verbs: ['y','x']`, `payload_ref: { bill_id }`. `y` calls `bill.post` (creates
journal entries, bill becomes open payable); `x` discards the draft. The same
`y`/`x`/Enter-unfold queue idiom (§4.4) applies verbatim — the bill draft is a
pre-ledger approval, not an operational item, so it sits in the Class A default
view with journal proposals, not in the Class B bills-due section.

**MCP tool.** A dedicated `bill_create` MCP tool is added to the manifest
(agent-readiness-spec §5.2), same pattern as `journal_propose` — a dedicated
tool for an agent-callable write. `freebooks_read` only proxies non-mutating
actions by design, so `bill.create` (a write) needs its own tool.

**Bank-statement matching connection.** Once a bill draft is approved (posted),
it is an open payable. Tier 2 open-item matching (bank-matching-spec §4) matches
bank transactions against it by amount + counterparty + date window. The bill
routing and the cascade are independent designs that compose at this point —
the cascade doesn't know or care how the payable entered the system.

**New vendor problem — open, orthogonal.** If the vendor doesn't exist in master
data, the bill draft can't be created (R2: agents never mutate master data,
`vendors` named explicitly). Two paths, neither resolved here: (a) the human
creates the vendor first, then re-drops the invoice (the agent retries
`bill.create`); (b) a future vendor-proposal pattern — same shape as
`mapping.suggest` (agent proposes a vendor to a `vendor_suggestions` table,
human approves) — handles it without the agent ever writing to `vendors`.
Flagged as an open question, not part of this ratification. The `bills/`
subfolder path can ship for vendors that already exist; the new-vendor case is
a known gap until the vendor-proposal pattern lands.

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

**/:company/inbox** — the unified review queue (A5, agent-readiness spec §10):

- Proposed batches appear grouped by type; sidebar badge shows pending count.
- `y` approve → posts with *you* as `created_by` (the agent origin stays on
  the proposal row + audit trail). `x` reject → terminal, with an optional
  note the agent can read (`journal.rejected` event).
- `f` cycles type filters (proposed → rejected → bills → …); unfolding a
  proposal previews lines and underlag.
- Approve is claim-first atomic: double-approving is impossible
  (`INVALID_STATUS` on the second), and a post failure rolls the proposal back
  to `proposed`, nothing half-posted.
- Bank-statement proposals: the inbox groups them by statement; batch-approve
  (§7.3 bank-matching-spec) lets you approve high-confidence matches in one
  keystroke, still individually logged as reviewed.

## 7. Security notes for feeds

- Feed scripts should use the **agent account + agent-role token** — a leaked
  feed credential can read books and upload/propose, but can never post,
  approve, or change master data.
- Keep pdf/jpg/png discipline at the source (the watcher above filters);
  executables in the inbox are skipped, not uploaded.
- Disk safety: 15 MB cap + per-company sha256 dedupe + 30-day GC for
  rejected/orphaned proposal attachments. The attachments directory is in DB
  backup scope — include it in host backups.
