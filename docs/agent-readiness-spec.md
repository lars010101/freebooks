# freebooks — Agent-Readiness Spec (Phase A)

**Date:** 2026-07-29 · **Status:** RATIFIED 2026-07-30 (magnus go-ahead) · **Context:** agent-driven operating model (Slack design thread, 2026-07-29)
**Amended 2026-07-30 (roadmap §0m rescope):** A3 retargeted from bill proposals to **A3j — journal/bank-transaction proposals** (bill proposals dropped with the payables extras); **P2-5 MCP server pulled forward** into this tranche as component 4. Section status: §2 A1, §3 A2, §4 A3j — **shipped** (PR #71, main `390f4e5`); §5 MCP — **shipped** (phase-mcp-server PR; `tests/mcp-smoke.mjs` 26/26).
**Amended 2026-08-01 (Slack thread):** **A4 — proposal underlag** added (§4.7, R7): source-document binding for agent proposals; warn-not-block per BFL 5 kap egen verifikation. §4.7 A4 — **shipped** (phase-a4-underlag PR, `f3c8a91`).
**Amended 2026-08-05 (bank-matching-spec dependency):** Four amendments landing bank-matching-spec's assumptions back into the canonical spec: (1) `matching_history.record` added to `AGENT_ALLOWED` (§2.3) and to the MCP tool manifest (§5.2) — the agent-maintained learning loop in bank-matching-spec §10 needs a write path for recording each proposal's review outcome, which no existing whitelisted action or tool covers; (2) Class B taxonomy (§10.2) broadened from "post-ledger" to "not a ledger approval," per bank-matching-spec §11.2, which had already assumed this broadening without it being written back here; (3) `attachment.rejected` event type added (§3.2) for intake failures, which bank-matching-spec §11.1 assumed was logged to `event.list` without a corresponding event type existing; (4) **R2/mappings resolved:** `mappings` stays master-data, human-only, no exception — R2 (§1) is unchanged. bank-matching-spec's original design had the agent write learned rules directly to `mappings`, which R2 forbids explicitly. Resolution: `mapping.suggest` added to `AGENT_ALLOWED` (§2.3) and to the MCP manifest (§5.2) — the agent proposes a candidate rule to a new `mapping_suggestions` table (bank-matching-spec §10.2), never to `mappings` itself; a human approves or rejects via `mapping.suggestion.approve`/`.reject` (`data_entry` role, deliberately **not** whitelisted for agents — the write to `mappings` is always human-attributed). Same shape as the existing `journal_proposals` propose/approve/reject pattern (§4), reused rather than invented. **Not yet built** for any of the four; all land before bank-matching-spec implementation begins.
**Amended 2026-08-05 (bills routing — Option C ratified):** `bill.create` added to `AGENT_ALLOWED` (§2.3) and `bill_create` added to the MCP tool manifest (§5.2) — the agent creates a bill **draft** from an extracted supplier invoice (agent-data-feeding-guide §4.5b); a human posts it via the inbox (`bill.post`), which creates journal entries and opens the payable that tier 2 bank-statement matching (bank-matching-spec §4) then matches against. `bill.create` uses catalog role `agent` (1.5), not `data_entry` (2) — same dispatch-ordering fix as `journal.propose` and `bank.match`; it's a proposal-stage write (to draft state), the same category as `journal.propose`. `bill.post` stays `data_entry` and is **not** agent-whitelisted — the human's inbox approval IS the post (§4.1 "approve is the post"). The bill draft enters the inbox as a new Class A type, `bill_draft` (§10.2); `inbox.list` (§10.3) fans out to the `bills` table for drafts in addition to `journal_proposals`. **Not yet built.**

---

## 0. Purpose

The operating model agreed in discussion: **agents prepare, humans approve.** The agent reaches freebooks only through the action RPC (`POST /api`) — never the DB file, never the filesystem. The human's job becomes review and extraction: a queue of agent-prepared proposals, period open/close, reports.

This tranche makes that model enforceable and observable inside freebooks, in four steps:

- **A1 — Actor attribution.** The system knows whether each call came from a human or an agent, and agent-class actors are *technically unable* to finalize anything. One guard, at the one choke point (dispatch).
- **A2 — Event emission.** Business facts (proposal created, journal posted, payment recorded, period locked…) are published to an append-only event stream. This is the agent's *input channel* (poll for new work) and the audit narrative, distinct from the invocation audit (P0-4).
- **A3j — Proposal state (journal batches).** The first prepare/approve flow: agent proposes a journal batch → human reviews in the Journal list → approve (which posts) or reject. A proposed batch can never reach `journal_entries` without a human transition.
- **MCP (P2-5) — MCP server.** A stdio MCP server that authenticates as an agent account and exposes the whitelisted surface (reads + `journal.propose` + `attachment.upload` + `event.list`) as MCP tools. Consumes A1 (actor model) and A2 (event stream).

**Sequencing:** first item on the post-filings backlog (roadmap §0p), before the SRU engine refactor and P2. A1/A2 are prerequisites for the MCP server and P3 (feeds); far cheaper now than after more surfaces bake in.

**Corrections this makes to the 2026-07-29 sketch:** (a) the review queue is *integrated into the existing Journal FB.list* (dissolve-into-existing-surfaces rule), not a dedicated page — so `Enter` keeps its open/unfold meaning and approve/reject get their own verbs; (b) enforcement is *default-deny whitelist*, not per-action flags the agent could outmaneuver; (c) the proposal target is journal batches, not bills — the journal is the single ledger gateway, and bank-feed transactions (P3) arrive as journal proposals too.

---

## 1. Invariants

| # | Rule |
|---|------|
| R1 | The API is the only writer. The agent never opens the DB file. (Deployment property — service-user file ownership — stated here because everything else assumes it.) |
| R2 | Agent-class actors may **read** and **propose** only. They can never finalize (post, void, settle, lock/unlock periods) and never mutate master data (COA, vendors, mappings, VAT codes, settings, permissions, company). Enforced at dispatch, default-deny, before the handler runs. |
| R3 | Every write is attributable: actor email, actor class (human/agent), and a caller-supplied request id grouping one agent run's calls. |
| R4 | Events are business facts, append-only, emitted exactly once — an idempotent-key replay must never double-emit. |
| R5 | Human review is an explicit state transition, not a convention. No agent-created row reaches `journal_entries` without a human approve (which *is* the post — §4.1). |
| R6 | All enforcement is server-side. The client renders state and offers verbs; it never decides eligibility. |
| R7 | An agent proposal is never rejected for lacking attachments — BFL 5 kap permits egen verifikation. The review surface must *warn* on missing underlag; it must never block. |
| R8 | The inbox unifies presentation only. Every action item's source of truth remains its owning module's table — no staging entity, no copied state. (A5, §10.3) |

---

## 2. A1 — Actor attribution

### 2.1 The `agent` role

`user_permissions.role` gains a fourth value: **`agent`**. Role levels (`auth.js`):

```
owner 3 · data_entry 2 · agent 1.5 · viewer 1
```

`agent` sits above `viewer` (agents read everything a viewer can) and below `data_entry` (every existing `data_entry` action rejects agents at the numeric check, unchanged). `checkPermission`'s comparison is untouched — 1.5 composes with the existing levels.

An agent account is just an email row with role `agent`, granted by an owner. **Note (2026-07-30):** no Users/permissions UI surface exists today — the `permissions.*` actions are backend-only — so the grant is made via the `permissions.save` action or SQL; when a Users surface lands, its role select gains the `agent` option.

### 2.2 Actor class is derived, never asserted

`auth.js` gains `resolveActor(email, companyId) → { role, actorType }` (same 60s TTL cache as `checkPermission`; `actorType = role === 'agent' ? 'agent' : 'human'`). Dispatch resolves the actor once and puts it on `ctx.actor`. **The class comes from the database role, not from anything in the request** — an agent cannot self-assert its way to `human`. This is the meaningful control given the default install-level trust model (self-asserted `userEmail`); per-actor API tokens shipped 2026-08-02 (§2.5) for deployments where the API is reachable over a network.

### 2.3 The dispatch guard (default-deny)

Catalog entries keep their existing `role`. The guard is a whitelist, evaluated in `handleApiRequest` immediately after the role check:

```
if (ctx.actor.actorType === 'agent' && actionIsMutating && action ∉ AGENT_ALLOWED)
    → fail FORBIDDEN 'Agents may not finalize or mutate master data'
```

`AGENT_ALLOWED` (v1, exhaustive): all non-mutating (viewer) actions · `journal.propose` (§4.2) · `attachment.upload` · **`matching_history.record`** (added 2026-08-05 — records a bank-matching-cascade proposal's review outcome, bank-matching-spec §10; a write, but a learning-store write, not a ledger mutation and not master data — the same category distinction R2 already draws for `journal.propose`/`attachment.upload`) · **`mapping.suggest`** (added 2026-08-05 — writes a candidate rule to `mapping_suggestions`, bank-matching-spec §10.2/§10.4; never to `mappings` itself, which stays master-data and human-only — `mapping.suggestion.approve`/`.reject` are deliberately excluded from this list, so the actual write to `mappings` can only ever be human-attributed) · **`bill.create`** (added 2026-08-05 — creates a bill **draft** from an extracted supplier invoice, agent-data-feeding-guide §4.5b; a human posts it via the inbox (`bill.post`). Same proposal-stage category as `journal.propose` — writes to the `bills` table's draft state, not to `journal_entries`; the post (`bill.post`) is `data_entry`, deliberately **not** whitelisted, so the write that creates journal entries is always human-attributed — "approve is the post," §4.1, same doctrine as `journal.approve`/`mapping.suggestion.approve`). `setup.*` actions (which skip the role check today) are rejected for agent actors unconditionally. Everything else mutating — posting, approving/rejecting, voiding, settlement, reconciliation, periods, settings, COA, vendors, mappings, VAT codes, permissions, company — is human-only **by default, including any action added in future** (a new mutating action is denied to agents until explicitly whitelisted — fail-closed).

As built (hardening 2026-07-31): `attachment.upload` is a real catalog action (base64 content, role agent, idempotent, 32MB decoded cap); the browser multipart route POST /api/upload shares the same storage core and now evaluates the same role check and writes the equivalent audit row. The §2.3 whitelist entry is live.

### 2.4 Schema migration (idempotent, house style)

```sql
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_type VARCHAR DEFAULT 'human';
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS request_id  VARCHAR;
```

`changed_by` stays the actor email (provenance continuity — an agent's writes show its account email). `actor_type` disambiguates class; `request_id` correlates one agent run across calls. Source: `body.requestId` or `X-Request-Id` header, else NULL.

`auditCall` (P0-4 dispatch audit) and `auditLog` (field-level) both accept the actor and stamp all three columns; `auditLog`'s signature gains an optional actor param, defaulting to `{ actorType: 'human', requestId: null }` so existing call sites are unaffected.

`journal_entries.created_by` is unchanged in meaning — when a human approves an agent's proposal, the journal rows show the human poster; the agent origin lives on the `journal_proposals` row (`created_by`), the audit trail, and the event stream (§3). The ledger stays clean.

### 2.5 Per-actor API tokens (as built 2026-08-02)

Bearer-token authentication for the action API, closing the hole §2.2 leaves open: over a network, a self-asserted `userEmail` is forgeable by anyone who can reach the port. A token authenticates the caller; the **role still resolves from `user_permissions` on every call** — a token is an identity, not a capability grant, so revoking a permission row takes effect within the existing 60s cache window, and revoking the token kills access immediately.

- **Format:** `fbt_` + 24 random bytes hex. Only the sha256 hex is stored (`api_tokens` table, boot-applied schema); the token string is returned ONCE by `auth.token.create`. `auth.token.list` never selects the hash.
- **Dispatch semantics (before the role check):** a valid Bearer token makes the call's identity the token's bound email — body `userEmail` is IGNORED (no mixed-identity requests). An invalid/revoked token is 401 `UNAUTHENTICATED` and NEVER falls back to self-asserted identity (that would be a downgrade hole). No token → legacy install-level trust, unchanged.
- **Enforcement mode:** `FREEBOOKS_AUTH_MODE=token-remote` makes non-loopback clients require a valid token (401 otherwise); loopback keeps install-level trust, so the local browser UI and SSH-tunnelled clients keep working unchanged. Default `trust` = the pre-existing behavior. **Same-host reverse-proxy caveat:** a proxy on the API host makes remote traffic arrive as loopback — terminate TLS on a different host, or don't rely on `token-remote` behind a same-host proxy.
- **Management actions (owner role; agents excluded by both the role check and the §2.3 whitelist):** `auth.token.create` `{email, label}` → `{tokenId, token, email, label}`; `auth.token.list`; `auth.token.revoke` `{tokenId}` (handler-level idempotent: re-revoke → `alreadyRevoked:true`, unknown id → 404).
- **MCP:** `FREEBOOKS_API_TOKEN` on the MCP server sends the token as `Authorization: Bearer` on every API call.
- **Scope decisions (v1):** tokens are install-global (bound to an email, not a company — per-company access stays with `user_permissions`); no `last_used_at` (keeps writes off the hot path); audit rows carry the resolved identity (token label not persisted to audit_log); the Bearer block covers the action API only (`/api`, `/api/action`) — the multipart upload route, attachment GETs, and report routes are unchanged.

---

## 3. A2 — Event emission

### 3.1 Table

```sql
CREATE SEQUENCE IF NOT EXISTS events_seq START 1;
CREATE TABLE IF NOT EXISTS events (
  event_seq   BIGINT    NOT NULL DEFAULT nextval('events_seq'),
  event_id    VARCHAR   NOT NULL DEFAULT (uuid()),
  company_id  VARCHAR   NOT NULL,
  event_type  VARCHAR   NOT NULL,    -- 'journal.proposed', 'journal.posted', ...
  entity_type VARCHAR   NOT NULL,    -- 'journal' | 'proposal' | 'bill' | 'payment' | 'attachment' | 'period'
  entity_id   VARCHAR   NOT NULL,
  actor_type  VARCHAR   NOT NULL DEFAULT 'human',
  actor_id    VARCHAR,               -- caller email (human or agent account)
  request_id  VARCHAR,
  payload     VARCHAR,               -- compact JSON snapshot, ≤ 4000 chars
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_company_seq ON events(company_id, event_seq);
```

Append-only: no update or delete path exists anywhere. The emit helper omits `event_seq`/`event_id` so the defaults fire.

### 3.2 What emits (v1)

Events are **business facts at state transitions**, emitted inside the handlers that own the transition (they know the entity ids), via one helper `emitEvent(ctx, type, entityType, entityId, payload)`:

| Event | Emitted at |
|---|---|
| `journal.proposed` / `journal.approved` / `journal.rejected` | A3j transitions (§4) |
| `journal.posted` | journal post — both direct `journal.post` and the post inside `journal.approve` |
| `bill.posted` | bill post (draft→posted) |
| `bill.payment.recorded` / `bill.payment.voided` | settlement paths |
| `attachment.uploaded` | attachment upload (the feed-extraction trigger) |
| `attachment.rejected` | attachment processing found the file structurally invalid — malformed CSV, missing headers, unparseable PDF, wrong file type (bank-matching-spec §11.1's "intake failure"). Logged for the agent's own channel only; **never surfaces in the inbox** — there's no human decision to make on a file that can't be parsed at all, the fix is re-submission at the source. |
| `mapping.suggested` / `mapping.suggestion.approved` / `mapping.suggestion.rejected` | `mapping.suggest` / `.approve` / `.reject` transitions (bank-matching-spec §10.4) — lets the agent know whether its suggested rule was adopted, so it doesn't keep re-suggesting an already-rejected pattern. |
| `period.locked` / `period.unlocked` | period transitions |

Payload: compact snapshot (for a journal batch: date, reference, description, line count, total debit, currency). Generic per-action invocation data stays in `audit_log` (P0-4) — the event stream does not duplicate it.

**Replay rule (R4):** the idempotency short-circuit returns the stored response *before the handler runs*, so emission inside handlers cannot double-fire on a replay. Correct by construction, asserted by a contract test.

### 3.3 `event.list` — the agent's input channel

New catalog action: `event.list` — viewer role, non-mutating. Params: `after_seq` (number, default 0), `type` (optional filter), `limit` (≤ 500, default 100). Returns rows ordered by `event_seq` ascending.

Polling contract: the caller keeps the highest `event_seq` seen and passes it as `after_seq` on the next poll. Monotonic, gap-safe, replay-safe. This is what an agent watches for work — e.g. `attachment.uploaded` → fetch the file → extract → `journal.propose`. (Outbound delivery/webhooks: out of scope v1.)

---

## 4. A3j — Proposal state (journal batches)

### 4.1 Lifecycle

```
                journal.propose (agent)
                        │
                        ▼
                   proposed ────── journal.reject (human) ──▶ rejected  [terminal,
                        │              note required           kept for audit,
              journal.approve (human)                          never posts]
                        ▼
                     posted  ──▶ journal_entries rows (ordinary posted batch,
                                batch_id linked back to the proposal)
```

**Approve is the post.** Journals have no draft state today — `journal.post` is atomic, and introducing draft journal rows would touch every report query. So the human's approve transition validates and posts in one step (R5). Two consequences:

- The agent's lines are enriched and validated **at propose time** (server-computed VAT, balance check, account existence — exactly the `journal.post` machinery), and the human reviews those computed results.
- `journal.approve` **re-validates at approve time**: period locks and account active windows can shift while a proposal sits; a proposal that was valid on Monday must not post into a period locked on Tuesday.

`rejected` is terminal and auditable, never deleted.

### 4.2 Table

```sql
CREATE TABLE IF NOT EXISTS journal_proposals (
  company_id   VARCHAR   NOT NULL,
  proposal_id  VARCHAR   NOT NULL UNIQUE,
  journal_id   VARCHAR,                -- optional series (journals table) → auto reference on post
  date         DATE      NOT NULL,     -- MIN(line dates); list display + ordering
  reference    VARCHAR,
  description  VARCHAR,
  source       VARCHAR   NOT NULL DEFAULT 'agent',
  lines        VARCHAR   NOT NULL,     -- JSON array of enriched lines (journal.post row shape)
  status       VARCHAR   NOT NULL DEFAULT 'proposed',   -- proposed | posted | rejected
  batch_id     VARCHAR,                -- set on approve
  created_by   VARCHAR   NOT NULL,
  request_id   VARCHAR,
  reviewed_by  VARCHAR,
  reviewed_at  TIMESTAMP,
  review_note  VARCHAR,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_journal_proposals_company_status ON journal_proposals(company_id, status);
```

### 4.3 Actions

| Action | Role | Mutating | Idempotent | Notes |
|---|---|---|---|---|
| `journal.propose` | `data_entry` (agents admitted by the §2.3 whitelist) | ✓ | ✓ | Params mirror `journal.post` (`lines`, `journalId?`, `reference?`, `description?`). Lines are enriched and validated **server-side by the same code path as `journal.post`** (shared `enrichAndValidate` helper — VAT split, FX, balance, account windows) but nothing reaches `journal_entries`. With `proposalId`: upserts a still-`proposed` row **created by the same caller** (extraction fixes, idempotent retries); cannot touch another actor's proposal. Returns `proposalId` + `warnings`. **Catalog role note:** the catalog stores role `agent` (level 1.5), not `data_entry`, because dispatch runs the numeric role check BEFORE the §2.3 whitelist guard — a `data_entry` entry would reject agents (1.5 < 2) before the whitelist ever sees it. `agent` admits agents (1.5≥1.5), data_entry (2), owner (3); viewers (1) are excluded. `journal.propose` is then added to `AGENT_ALLOWED` so the whitelist guard admits it. This is the spec's intent. |
| `journal.approve` | `data_entry` | ✓ | ✓ | `proposed → posted`. Re-validates (period lock, account windows, balance), then posts via the **shared `postJournalBatch` helper** with `created_by` = the approving human. Stamps `reviewed_by/at/note` (note optional) and `batch_id`. Emits `journal.approved` + `journal.posted`. |
| `journal.reject` | `data_entry` | ✓ | ✓ | `proposed → rejected`. `note` **required** (the agent reads the reason via `event.list` and re-proposes corrected). |
| `journal.proposal.list` | `viewer` | – | – | Params: `status` (default `proposed`), `limit`. Queue data for the Journal list + badge. |
| `journal.proposal.get` | `viewer` | – | – | One proposal incl. enriched lines, proposer, `request_id`, review triple. |

Refactor (same PR): extract `postEntry`'s enrichment/validation into `enrichAndValidate(companyId, lines)` and its insert core into `postJournalBatch(ctx, { lines, source, journalId, createdByEmail })`; `journal.post` and `journal.approve` both call them. One posting path, no divergent logic.

**Reference doctrine (ratified 2026-08-02, magnus):** every posted batch carries a sequential `{CODE}/{YYYY}/{NNNNN}` reference. A missing `journalId` in `journal.post`/`journal.approve` defaults to the company's **MISC** journal (warn-not-block — the response carries a `warnings` entry naming the default); only a company with no active MISC journal keeps the legacy null-reference behavior. `journal.import` follows the same rule per entry: an entry carrying any reference keeps it (source-system voucher identity preserved on migration imports); an entry with no reference on any line gets one minted (`entry.journalId`, else MISC) — validation runs before minting so a failed all-or-nothing import never burns sequence numbers. Historical batches that predate this doctrine are repaired by `scripts/repair-journal-references.js` (dry-run default).

Guards: approve/reject only from `status='proposed'` (`INVALID_STATUS` otherwise, existing guard style). Agents are excluded from approve/reject by the §2.3 whitelist, not by any check inside the handlers.

As built (hardening 2026-07-31): approve/reject/upsert transitions are atomic claim-first UPDATE...RETURNING guarded on status='proposed' (a concurrent second transition loses with INVALID_STATUS); approve posts inside a compensating-rollback wrapper (a post failure restores 'proposed'); reviewer/created_by fall back to 'anonymous' under install-level trust, matching propose.

### 4.4 The review queue — integrated into the Journal list

> **Superseded 2026-08-03 by §10 (A5).** The queue moves to the unified Inbox; the Journal list becomes the pure posted register, and the sidebar badge + `f` status filter move with the queue. The queue idiom specified below (status-filtered list + `y`/`x` row verbs + note-on-reject + badge) is unchanged — it is reused verbatim as the inbox's per-type rendering (§10.4).

No new page, no new route. The Journal FB.list **is** the queue:

- Pending `proposed` rows render in the Journal list with status `PROPOSED` (pinned above posted batches, then by date desc); `rejected` rows appear only under an explicit status filter (default view keeps them out of the way, same doctrine as `void`).
- **Row verbs on a focused `proposed` row** (per-row verb predicates in FB.list — framework contract addition, documented in `fb-list-ux-spec.md` in the same commit as the behavior):
  - `y` — **approve**. Confirm modal showing date, line count, total debit, optional note (`Enter` confirms; `Esc`/backdrop cancels — Esc never writes). On confirm: row becomes a posted batch in place, badge decrements.
  - `x` — **reject**. FB.modal with a **required** note input (`Enter` submits when non-empty; `Esc` cancels). Consistent with `x` = discard/delete doctrine.
  - `Enter` — unfold the proposal's lines read-only (same tree idiom as posted batches) with proposer + request id in the detail header. **No in-place editing of proposed rows** — review is accept-or-reject; the proposer owns pre-approval edits (§4.3 upsert). A human who wants changes rejects with a note (or approves then edits via existing posted-entry machinery). One writer per state.
- **Nav badge:** the Journal sidebar item shows the pending-proposal count (from `journal.proposal.list`), refreshed on soft-nav and after queue verbs. This is the monitoring surface — the human sees *there is work* without opening anything.
- **Empty state:** "Nothing to review — agent-proposed journal batches will appear here" (pages self-explanatory rule).

**This is the queue idiom, specified once here and reused verbatim** by future queues (bill proposals if payables returns, feed-import review): status-filtered FB.list + `y`/`x` row verbs + note-on-reject + nav badge. Keyboard-program conventions apply throughout (K1–K5); the `keys-coverage` gate covers the new verbs via the existing page set.

### 4.5 Why `y`/`x` and not `Enter`/`a`

`Enter` on FB.list rows is open/unfold (tree doctrine) — overloading it as approve would make the list the one place Enter destroys context. `a`/`A` are taken (`A` = attach, K4 universal). `y` (yes) / `x` (no) is the review pair, new as a *universal* verb only in the queue context, ratified here.

### 4.6 Bank transactions

No `bank_transactions` table exists today (feeds are P3). When feeds land, a bank-feed adapter is an agent-side loop that turns transactions into `journal.propose` calls — the freebooks-side artifact is always a journal proposal, so this tranche needs no bank-specific machinery.

### 4.7 A4 — Proposal underlag (source-document binding)

**Regulatory basis.** Bokföringslagen (1999:1078) 5 kap requires every verifikation to reference the handlingar / räkenskapsinformation it rests on; 7 kap requires räkenskapsinformation to be retained and readable for 7 years after the calendar year the financial year ends (~8 years effective for a calendar FY; medium-neutral since the 2022 amendments). BFN practice accepts **egen verifikation** — a self-documenting voucher for corrections, accruals, and like cases where no external source document exists. Therefore a missing underlag is a **warning, never a block** (R7): the proposal still proposes; the human reviewer sees the gap and decides.

**Binding convention (client-side; no API/schema change).** The 4-tool MCP manifest and the action catalog stay frozen — A4 is a *convention*, documented here, not a new surface. The agent pipeline is upload-first (the document exists before the proposal does), so the order is:

1. Agent **mints the `proposalId` client-side** (uuid; `journal.propose` already supports a caller-supplied `proposalId` for upsert — §4.3).
2. Agent **uploads each source document** via `attachment.upload` with `entityType='journal_proposal'` and `entityId=` that same `proposalId`.
3. Agent **calls `journal.propose`** with the same `proposalId`.

The shared `attachments` table (PR #73) already keys on `(entity_type, entity_id)`; `journal_proposal` is just another entity type to it. No new column on `journal_proposals` — the join is computed. Cross-ref §5.2 (`attachment_upload`).

**Propose-time count + warning.** `journal.propose` computes `attachment_count` via `SELECT count(*) FROM attachments WHERE entity_type='journal_proposal' AND entity_id=$proposalId` and returns it in the response alongside `warnings`; when the count is 0 the response carries `warnings:['no_underlag']` (R7 warn-not-block — the propose still succeeds). `journal.proposal.list` joins `attachments` to carry `attachment_count` per row so the queue badge renders without a second round-trip.

**Review UX (unfold preview + folded badge).** Unfolding a `PROPOSED` row in `/:company/journal` fetches `attachment.list(entityType='journal_proposal', entityId=proposalId)` and renders the shared `fb-attachments` rows (§0k K4) with inline preview via the existing `GET /api/attachments/:id` route — no new preview path. The folded row shows an **underlag-count badge**; zero attachments renders a visible **"no underlag" warning marker** so the reviewer cannot miss the gap. This reuses the queue idiom from §4.4 (status-filtered FB.list + row verbs); no new page.

**Approve-time re-point (atomic).** On `journal.approve`, the **same transaction that posts the batch** re-points the bound attachment rows from `entity_type='journal_proposal'` / `entity_id=proposalId` to `entity_type='journal'` / `entity_id=batchId`, inside the compensating-rollback wrapper established in PR #73 (§4.3 as-built): a post failure rolls the proposal back to `proposed` and leaves the attachments bound to the proposal. **Blob storage paths do not move** — only the metadata rows' entity pointers change; the opaque storage keys stay. After re-point, the journal-new attachment panel (which queries `'journal'`/`batchId`) shows them in place, as if they had been attached to the posted batch directly.

**Reject / expire + GC.** On reject or expire, attachments stay bound to the dead `proposalId` (no voucher posted → no BFL 7 kap retention duty yet). A GC pass purges them after a **30-day grace period** from the terminal transition. **GC hard invariant:** purge *only* `entity_type='journal_proposal'` rows whose `proposalId` no longer exists in `journal_proposals`; **never** touch rows re-pointed to `entity_type='journal'` (those are now bound to a posted voucher and fall under 7 kap retention).

**Disk controls.** The existing 32 MB per-file cap (PR #73) is **tightened to 15 MB** for `journal_proposal` uploads. Content-type whitelist: `application/pdf`, `image/jpeg`, `image/png`. **sha256 dedupe per company:** identical hash within a company reuses the stored blob path and writes a new metadata row only — the hash doubles as integrity evidence. Blob storage stays on the filesystem with metadata in DuckDB (status quo, PR #73); the **attachments directory is in DB backup scope**. Realistic footprint for a small AB: ~0.5–15 GB over the 8-year retention window.

**As built (2026-08-01):** shipped on `phase-a4-underlag` (`f3c8a91`), spec pre-landed on main (`6b5d81d`) per standing rule 5 — code + tests follow in the same PR. Deltas vs the §4.7 text above: (1) GC runs at API boot **and** a 24h unref'd `setInterval`, and is operator/test-triggerable via a new endpoint `POST /api/admin/gc-attachments` — bearer-token gated exactly like `/api/admin/query` (403 unless `FREEBOOKS_ADMIN_TOKEN` is set). (2) The sha256 dedupe required an idempotent schema evolution — `ALTER TABLE attachments ADD COLUMN IF NOT EXISTS sha256` + index `idx_attachments_company_sha256` — but the §4.7 binding convention itself stays schema-free (the join is computed, no new column on `journal_proposals`). (3) The 15 MB cap + pdf/jpg/png whitelist apply **only** to `entity_type='journal_proposal'` uploads; other entity types keep the 32 MB status quo. (4) Dedupe is **global across entity types**; a shared blob is unlinked from disk only when no metadata row references the path. (5) The review UI lives in the existing `/:company/journal` queue: folded `PROPOSED` rows show a 📎 N badge (`attachment_count`>0) or a red "no underlag" marker; unfold lazily fetches `attachment.list` and renders shared `FB.attachments.rowHtml` rows linking to `GET /api/attachments/:id` (`target _blank`) — no new keys, verbs, or pages. **Verification on the branch:** contract suite 62 tests / 60 pass / 2 fail — the 2 failures (test 12 "draft flow: save → re-save keeps bill_id → post → void reverses journals" and test 26 "bill.payment.void") are pre-existing on main and wall-clock fragile (hardcoded dates fell outside seeded periods as of 2026-08-01 — "Date 2026-08-01 does not fall within any defined period"). New A4 contract tests: propose-count round-trip, R7 warn-not-block, proposal.list join, approve re-point, 15 MB cap, type whitelist, scoping proof, sha256 dedupe, GC invariant. `tests/mcp-smoke.mjs` 28/28. keys gate (`npm run test:keys`) 26/26, 0 triage. Playwright `pw-phase-a4.mjs` 12/12 (untracked per repo convention).

---

## 5. P2-5 — MCP server

A Model Context Protocol server that lets an MCP-capable agent (Claude, Hermes, etc.) drive the whitelisted API surface as native tools, without hand-rolling HTTP.

### 5.1 Shape

- **Location:** `mcp/` in-repo — its own `package.json`, its own process (stdio transport, MCP standard). Not required by `api/`; the API server has no dependency on it.
- **Implementation:** `@modelcontextprotocol/sdk` if the registry is reachable at build time; otherwise a minimal vendored stdio JSON-RPC 2.0 implementation (`initialize`, `tools/list`, `tools/call`) — the protocol surface used here is small.
- **Identity (env):** `FREEBOOKS_API_URL` (default `http://127.0.0.1:3000`), `FREEBOOKS_USER` (an **agent-role account email**), `FREEBOOKS_COMPANY` (company id). v1 keeps the install-level trust model (self-asserted email, same as the API today); per-actor tokens are later hardening (§7).
- **Request correlation (R3):** one `request_id` (uuid) minted at server start — override `FREEBOOKS_REQUEST_ID` — sent as `X-Request-Id` on every API call, so one MCP session = one correlated run in `audit_log` and `events`.
- **Idempotency:** every mutating tool call sends an `Idempotency-Key` (uuid per logical call; caller may supply one for cross-retry identity).
- **R1 preserved:** the server talks HTTP to the action API only. It never receives a DB path; it never touches the filesystem beyond its own code.

**As built (2026-07-31):** SDK `@modelcontextprotocol/sdk` low-level `Server` + `StdioServerTransport` (explicit manifest, plain JSON-Schema input schemas). `attachment_upload` takes file bytes as `contentBase64` — never a disk path (R1 holds for the agent too). `freebooks_read` builds its read allowlist **dynamically from `GET /api/actions`** at startup (admits only `mutating: false`), falling back to a static list + stderr warning if the catalog is unreachable. Verified by `tests/mcp-smoke.mjs` (26 assertions).

As built (hardening 2026-07-31): `attachment_upload` travels via the `attachment.upload` action (not the multipart route) and sends an `Idempotency-Key` like `journal_propose`; the key is caller-suppliable on both mutating tools. The action API's JSON body limit is 50mb for base64 payloads.

### 5.2 Tools (v1)

| Tool | Maps to | Notes |
|---|---|---|
| `event_list(after_seq?, type?, limit?)` | `event.list` | The agent's work-discovery channel (§3.3). |
| `journal_propose(lines, journalId?, reference?, description?, proposalId?)` | `journal.propose` | The only write path to the ledger — proposals, never postings (R5). |
| `attachment_upload(...)` | `attachment.upload` | Params mirror the action (base64 `contentBase64`); sends an `Idempotency-Key` (caller-suppliable) like `journal_propose`. Maps to the action (not the multipart route) as of hardening 2026-07-31. For proposal underlag binding (entityType='journal_proposal'), see §4.7. |
| `freebooks_read(action, params?)` | any catalog action with `mutating: false` | Generic read gateway (journal/list/get/search, account balances, views, reports, `journal.proposal.*`). Client-side allowlist for friendly errors; **the server-side §2.3 whitelist remains the enforcement.** |
| `matching_history_record(...)` | `matching_history.record` | **Added 2026-08-05, not yet built.** Records a bank-matching-cascade proposal's review outcome (approved_unedited / approved_edited / rejected) — bank-matching-spec §6 (calibration) and §10 (rule crystallization/retirement). `freebooks_read` cannot cover this: it's a write, and the generic read gateway excludes mutating actions by design. This is the one tool exposing a write outside the ledger/document-upload path, mirroring how `journal_propose` and `attachment_upload` each got a dedicated tool rather than a generic mutating gateway. |
| `mapping_suggest(...)` | `mapping.suggest` | **Added 2026-08-05, not yet built.** Proposes a candidate mapping rule to `mapping_suggestions` (bank-matching-spec §10.2) — never a write to `mappings` itself. Params mirror a mapping row plus evidence and a source proposal id. Same reasoning as `matching_history_record`: a write, so `freebooks_read` can't cover it, and it needs its own tool. No corresponding `mapping_suggestion_approve`/`_reject` tool exists or should exist — those actions are human-only (`data_entry` role, not agent-whitelisted), mirroring why no `journal_approve`/`journal_reject` tool exists in this manifest. |
| `bill_create(...)` | `bill.create` | **Added 2026-08-05 (bills routing — Option C ratified), not yet built.** Creates a bill **draft** from an extracted supplier invoice (agent-data-feeding-guide §4.5b) — params mirror the `bill.create` action (vendor, amount, due date, line items, currency); the bill lands in `status='draft'`, no journal entries created. A human then posts it via the inbox (`bill.post`), which creates journal entries and opens the payable that tier 2 bank-statement matching (bank-matching-spec §4) matches against. Same reasoning as `journal_propose`: a write (draft creation), so `freebooks_read` can't cover it, and it gets its own dedicated tool. No `bill_post` tool exists or should exist — `bill.post` is `data_entry`, not agent-whitelisted (the human's inbox approval IS the post, §4.1), mirroring why no `journal_approve` tool exists. |

No approve/reject/post/void/master-data tools exist — the agent account couldn't use them anyway (default-deny), and their absence keeps the tool manifest self-documenting. `matching_history_record`, `mapping_suggest`, and `bill_create` don't change this: the first writes to the learning-store table (`matching_history`), the second to a proposal table (`mapping_suggestions`), the third to the `bills` table's draft state — none is `journal_entries` or any master-data table, and none has a corresponding approve/reject/post tool (`bill_post` is absent for the same reason `journal_approve` is).

### 5.3 Verification

`tests/mcp-smoke.mjs` (tracked): spawn the server against the fixture API, `initialize` → `tools/list` (assert the §5.2 manifest) → `tools/call event_list` round-trip → assert an agent-role account is **denied** a mutating non-whitelisted action through `freebooks_read` misuse (still non-mutating by construction) and that no mutating tool exists in the manifest.

---

## 6. What this unlocks (the operating model, mapped)

| Operating-model piece (2026-07-29 discussion) | Delivered by |
|---|---|
| Agent has no DB/file access; API only | Deployment (R1) + §2.2 derived actor class + §5.1 MCP shape |
| Agent can never finalize or corrupt | §2.3 default-deny whitelist (R2) |
| Attribution on every row | §2.4 audit actor columns + `request_id` (R3) |
| Transaction input to the agent | §3.3 `event.list` polling + attachments (P3 feeds build on this) |
| Agent posts | `journal.propose` — proposals, never postings (R5) |
| Human reviews, approves | §4.4 queue + approve/reject |
| Human opens/closes periods | Unchanged — period actions are human-only by the whitelist, permanently |
| Reports | Existing (unchanged) — agent reads them via `freebooks_read` |
| WORM backups / teardown-retention | Infrastructure, app-independent — unchanged |

Sequencing after this tranche: **SRU engine refactor** (SRU-only), then **P2 accounting completeness**; **P3 (feeds)** is a feed adapter calling `journal.propose` + an agent loop on `event.list`; **bill/invoice proposals** ship on the §4 pattern if payables/receivables return to scope.

---

## 7. Out of scope (v1)

- ~~Per-actor API tokens~~ — **SHIPPED 2026-08-02 (§2.5).** Remaining hardening: per-company token scoping, role ceilings, `last_used_at`, audit-log token provenance.
- Outbound event delivery (webhooks), event retention/compaction policy.
- Bank feeds themselves (P3); OCR/VLM extraction loop (agent-side, not freebooks).
- ~~Bill proposals~~ — **Partially returned 2026-08-05 (Option C ratified):** agent-created bill *drafts* are now in scope (`bill.create` → inbox Class A `bill_draft` → human `bill.post`, §2.3/§10.2/§5.2; agent-data-feeding-guide §4.5b). Full bill-proposal lifecycle (payment matching, settlement) remains on the existing payables path. AR invoice proposals (Receivables) stay dropped — reuse this pattern if that track returns.
- Agent-proposed *master data* (new vendors/accounts): stays human-only until a proposal pattern for master data is designed. Journal proposals reference accounts by code — an unknown code fails validation at propose time, so this blocks nothing in v1.
- Vendor bank-detail handling: no such fields exist today; when they arrive, they are human-only permanently (BEC fraud vector).

---

## 8. Verification

**Contract tests** (tracked, extending the P1-2 harness):

1. Guard matrix: agent actor × every mutating action → only the §2.3 whitelist passes; `setup.*` rejected; a *hypothetical new* mutating action is denied (fail-closed proof).
2. `journal.propose` → approve happy path: `journal_entries` rows carry the human poster; the proposal carries agent `created_by` + reviewer triple + `batch_id` link; `journal.approved` + `journal.posted` events emitted once.
3. Reject is terminal: approve/reject/re-propose-touch on `rejected` all `INVALID_STATUS`.
4. Propose-upsert: same-caller edit of own `proposed` row ✓; other actor's row ✗; non-`proposed` row ✗.
5. Idempotent replay of `journal.propose` (same key) → one proposal, one `journal.proposed` event (R4).
6. `event.list`: ordering, `after_seq` polling, type filter, limit cap.
7. Audit rows carry `actor_type` + `request_id` for both dispatch and field-level entries.
8. Approve-time re-validation: propose valid → lock the period → approve fails `PERIOD_LOCKED` → unlock → approve succeeds.
9. MCP smoke per §5.3.
10. A4 propose-with-attachments: `attachment.upload` (entityType='journal_proposal', entityId=proposalId) before `journal.propose` → propose response carries `attachment_count` ≥ 1 and no `no_underlag` warning; `journal.proposal.list` carries the same `attachment_count` for the badge.
11. A4 unfold preview (Playwright, `pw-phase-a.mjs` untracked per convention): unfolding a `PROPOSED` row renders the bound underlag rows via `attachment.list` + inline `GET /api/attachments/:id` preview; the folded row shows the count badge.
12. A4 approve re-point: approve posts the batch and re-points attachment rows to `entity_type='journal'` / `entity_id=batchId` **in one transaction**; a post failure rolls both the proposal status and the re-point back (attachments stay on the proposal).
13. A4 warn-not-block proof (R7): `journal.propose` with **zero** attachments succeeds and returns `warnings:['no_underlag']`; the proposal is not rejected.
14. A4 GC invariant: GC purges only `entity_type='journal_proposal'` rows whose `proposalId` no longer exists in `journal_proposals` past the 30-day grace; rows re-pointed to `entity_type='journal'` are never touched.
15. A4 sha256 dedupe: two identical uploads (same sha256, same company) store one blob on disk with two metadata rows.

**Playwright** (`pw-phase-a.mjs`, untracked per convention): queue verbs end-to-end — propose via API → row appears with `PROPOSED` → `y` modal Esc cancels → `y` Enter approves → row becomes posted batch → badge decrements; `x` empty-note disabled → note → rejected row filtered out. `keys-coverage` gate stays green.

---

## 9. Build order

1. **A1** — `agent` role, `resolveActor`, dispatch whitelist guard, audit columns + `request_id`, permissions-UI role option. *(Small: auth.js, dispatch, audit.js, schema, one settings surface.)*
2. **A2** — `events` table + sequence, `emitEvent`, the §3.2 call sites, `event.list`. *(Small-medium.)*
3. **A3j** — `journal_proposals` table, `enrichAndValidate`/`postJournalBatch` refactor, `journal.propose/approve/reject` + `journal.proposal.list/get`, Journal-list queue UI + badge + detail unfold. *(Medium — the bulk is UI.)*
4. **MCP (P2-5)** — `mcp/` server per §5. *(Small; consumes 1–3.)*
5. **A4** — proposal underlag per §4.7: propose-time count/warning, queue unfold preview, approve re-point, GC, dedupe. *(Small-medium; no API/schema additions — one binding convention + UI surface.)*
6. **A5** — unified action inbox per §10: nav-registry remap, `inbox.list` aggregator, inbox page, Journal list slimmed to the register. *(Small-medium; consumes 3.)*

Each lands as its own PR with the spec updated in the same commit (standing rule 5).

---

## 10. A5 — Unified action inbox (ratified 2026-08-03)

**Why.** §4.4 dissolved the review queue into the Journal list when journal proposals were the only action item. That rule does not scale: one badge per sidebar item means the human polls N surfaces to find work, and the merged queue+register conflates two different objects — an ephemeral work queue and the permanent ledger register (observed in practice: the queue's `f` status filter reads as meaningless when both halves share one list, since POSTED rows never filter out). Under the operating model of §0 the queue **is** the primary human surface; A5 makes it one surface.

**Ratified decisions (2026-08-03).**

1. **Replace.** The queue half of the Journal view moves to a dedicated Inbox page. The Journal list becomes the pure posted register; its sidebar badge and `f` queue filter move with the queue.
2. **`g i` = Inbox.** The letter is reclaimed from bank-import (nav-registry: `bank-import.gKey` dropped; route and palette entry unchanged, reachable via `g b`). Justification: bank imports are an inbox item type (§10.2) — the destination dissolves into the inbox.
3. **Hold.** Module-native pending views (e.g., drafts inside Payables) stay as-is until the inbox proves out on journals; they fold in per §10.7 as their modules land.

### 10.1 What the inbox is / is not

One FB.list page (`/:company/inbox`, sidebar first, 📥) listing **action items** — work awaiting a human decision. It is the human's input channel, the complement of `event.list` (§3.3 — the agent's). It is not a notification center, not a log viewer, and not an editor: review stays accept-or-reject per §4.4 (one writer per state); anything beyond the verbs opens the item's native surface.

### 10.2 Item taxonomy — two action classes

**Class A — pre-ledger approvals** (the queue proper; the default view). Everything that will hit the ledger arrives as a `journal_proposals` row — the single-gateway rule is unchanged (§0 correction (c), §4.6): journal batches, bill proposals, and bank-feed matches all converge on the one pre-ledger entity with the one approve/reject path and A4 underlag.

**Amended 2026-08-05 (bills routing — Option C ratified):** Class A gains a second owning-table source. A bill draft — created by the agent via `bill.create` (§2.3, agent-data-feeding-guide §4.5b) — is a Class A item whose source of truth is the `bills` table (draft state), not `journal_proposals`. It enters the inbox as `type: 'bill_draft'`, `source: 'agent'`, `counterparty: <vendor>`, `amount`, `date`, `verbs: ['y','x']`, `payload_ref: { bill_id }`. `y` triggers `bill.post` (creates journal entries, bill becomes an open payable — which tier 2 bank-statement matching, bank-matching-spec §4, then matches against); `x` discards the draft. This is the one Class A type that does not converge on `journal_proposals` — the bill's journal entries are posted by `bill.post`, not `journal.approve`, because a bill carries payables-specific structure (due date, vendor subledger linkage, settlement lifecycle) that a journal proposal does not. The single-gateway principle is preserved at the approval layer: both `journal.approve` and `bill.post` are `data_entry`, human-only, "approve is the post" (§4.1) — the agent never posts either. `inbox.list` (§10.3) fans out to the `bills` table for `status='draft'` rows in addition to `journal_proposals`, normalizing both to the standard item shape. The `y`/`x`/Enter-unfold queue idiom (§4.4) applies verbatim — a bill draft is a pre-ledger approval, not the Class B bills-due operational item.

**Class B — operational items requiring human action that are not ledger approvals** (the "post-ledger" qualifier from the original 2026-08-03 ratification is dropped — amended 2026-08-05 per bank-matching-spec §11.2: Class B now also covers pre-ledger input failures, since some operational work needs a human decision before a proposal can even be formed. The `type` field discriminates within the class):

- Bills due/overdue for payment (posted payables awaiting settlement — **not** drafts; bill drafts are Class A above, per the Option C amendment)
- Bank-import statement lines awaiting match/accept/exclude (P3 feeds)
- Input rejections (pre-ledger): statement or document lines that parsed but have missing/ambiguous critical data — `type: 'input_rejection'`, verbs `r`/`d`, bank-matching-spec §11.2. Not to be confused with intake failures (structurally broken files), which never reach the inbox at all — see §3.2's `attachment.rejected` event.
- Mapping rule suggestions: agent-proposed bank-matching rules awaiting approval — `type: 'mapping_suggestion'`, verbs `y`/`x`, bank-matching-spec §10.1/§10.4. The one place a human directly maintains the mapping table, now as a one-glance approval rather than manual CRUD.
- Receivables (unbuilt — type reserved): unsent invoices, overdue collection items, unmatched incoming payments
- Attestation items (later): VAT sign-off, period-close review
- Agent-raised exceptions (later): stated-vs-computed VAT mismatches, duplicates, FX revaluation proposals

Class B is a filter/section, not the default — payment and matching work must not drown approvals.

### 10.3 Data layer — aggregate, never stage (R8)

No new table, no staging entity (A4 already rejected an attachment-inbox staging entity; the same reasoning applies to items). A new read-only action **`inbox.list`** fans out per type — `journal_proposals` and `bills` (draft state) for Class A, the owning module's tables for each Class B type — and normalizes rows to one item shape:

`{ type, source (agent|human|import|system), counterparty, amount, date, proposed_at, summary, verbs[], payload_ref }`

Each module stays the source of truth for its items; the verbs are the existing actions (`journal.approve`, `journal.reject`, …) called against `payload_ref`. No new write surface — R2/R6 enforcement is unchanged and the agent whitelist needs no amendment (`event.list` remains the agent's channel; `inbox.list` is read-only and may be granted later if an operator agent wants it).

### 10.4 Presentation

- One FB.list, grouped by type with collapsible group headers; `j`/`k` move across groups. Default view: Class A pending, oldest-first within type. A type-filter key cycles types; the rejected graveyard is a filter view (void doctrine carried over from §4.4 — rejected stays out of the default view).
- Row verbs are type-specific, driven by the item's `verbs[]`: Class A journal proposals keep `y` / `x` / Enter-unfold **verbatim** — the §4.4 queue idiom, reused as §4.4 prescribes for future queues. Class B verbs as their modules define them.
- Sidebar badge on the Inbox item = total Class A pending count (the monitoring surface, moved from Journal; refreshed on soft-nav and on `fb:queue-changed`). The Journal sidebar badge is removed with the queue.
- `g i` go-to + palette entry. Keyboard-program conventions (K1–K5) throughout; the `keys-coverage` gate covers the new page.

### 10.5 What changes in existing surfaces

- §4.4 queue leaves the Journal list (supersession note there) — Journal becomes the posted register only.
- nav-registry: inbox entry added (sidebar first, `gKey:'i'`); `bank-import` `gKey:'i'` dropped (route + palette unchanged).
- `fb:queue-changed` now targets the inbox badge.

### 10.6 Non-goals (v1)

No editing in the inbox (§4.4 one-writer-per-state). No Class B types until their modules exist (bank-import staging first, with P3 feeds). No snooze/assignment — single-operator product. No push notifications; the badge is the notification.

### 10.7 Build order

1. nav-registry: inbox route + sidebar entry + `g i` remap (bank-import gKey dropped). *(Trivial.)*
2. `inbox.list` aggregator over `journal_proposals` only (Class A, one type). *(Small.)*
3. Inbox page on FB.list reusing the §4.4 idiom; Journal list slimmed to the register; badge moved. *(Medium — the bulk is UI.)*
4. Class B types appended per module as they land.

**As built (2026-08-03).** Items 1–3 shipped. `inbox.list` (api/src/inbox.js) shares one SQL query with `journal.proposal.list` via `queryProposals(companyId, { status, limit, includeLines })` exported from api/src/journal.js — `includeLines` lets the inbox compute `amount` from the lines JSON without changing `journal.proposal.list`'s response shape. The inbox page (api/src/pages/inbox.js) groups items under a collapsible header per `type` (generic; v1 renders the single `journal_proposal` group "Journal proposals") and reuses the §4.4 idiom verbatim — `y` confirm-modal approve, `x` required-note reject, Enter unfold with `journal.proposal.get` merged via `Object.assign` (attachment_count survives), A4 underlag badge/preview, `f` cycles proposed↔rejected↔bills. Journal page is the pure posted register. Badge: `sb-inbox-badge` on the sidebar Inbox item, fed by `_refreshInboxBadge()` (boot + `fb:queue-changed`), `99+` cap. Request envelope note: action params spread at body top level (`{action, companyId, status, limit}`), not nested under `params`.

**As built (2026-08-03, item 4 — Class B bills).** `inbox.list` with `status='bills'` fans out to `queryBillsDue(companyId, limit)` — posted/partial bills with `amount_paid < amount`, sorted `due_date ASC`. Items normalized to the standard shape (`type:'bill_due'`, `source:'system'`, `counterparty:vendor`, `amount:outstanding`, `status:'overdue'|'due'`). The `f` filter cycles three states: proposed → rejected → bills → proposed (§10.2: Class B is a filter, not the default). Bill rows render with a per-row type glyph (📋 in the Date column; 📒 for journal proposals — §10.4), a Due/Overdue badge (red/amber), and an `o` verb to open the bill in Payables. No enrichment fetch for bill items (all data is inline from the aggregator). The "Proposed by" column became "Created by" (generic for both classes). Group header label: "Bills due for payment".
