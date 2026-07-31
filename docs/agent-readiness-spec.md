# freebooks — Agent-Readiness Spec (Phase A)

**Date:** 2026-07-29 · **Status:** RATIFIED 2026-07-30 (magnus go-ahead) · **Context:** agent-driven operating model (Slack design thread, 2026-07-29)
**Amended 2026-07-30 (roadmap §0m rescope):** A3 retargeted from bill proposals to **A3j — journal/bank-transaction proposals** (bill proposals dropped with the payables extras); **P2-5 MCP server pulled forward** into this tranche as component 4. Section status: §2 A1, §3 A2, §4 A3j, §5 MCP — each ships as its own PR (§9).

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

`auth.js` gains `resolveActor(email, companyId) → { role, actorType }` (same 60s TTL cache as `checkPermission`; `actorType = role === 'agent' ? 'agent' : 'human'`). Dispatch resolves the actor once and puts it on `ctx.actor`. **The class comes from the database role, not from anything in the request** — an agent cannot self-assert its way to `human`. This is the meaningful control given today's install-level trust model (self-asserted `userEmail`); per-actor API tokens remain later hardening, noted as out of scope.

### 2.3 The dispatch guard (default-deny)

Catalog entries keep their existing `role`. The guard is a whitelist, evaluated in `handleApiRequest` immediately after the role check:

```
if (ctx.actor.actorType === 'agent' && actionIsMutating && action ∉ AGENT_ALLOWED)
    → fail FORBIDDEN 'Agents may not finalize or mutate master data'
```

`AGENT_ALLOWED` (v1, exhaustive): all non-mutating (viewer) actions · `journal.propose` (§4.2) · `attachment.upload`. `setup.*` actions (which skip the role check today) are rejected for agent actors unconditionally. Everything else mutating — posting, approving/rejecting, voiding, settlement, reconciliation, periods, settings, COA, vendors, mappings, VAT codes, permissions, company — is human-only **by default, including any action added in future** (a new mutating action is denied to agents until explicitly whitelisted — fail-closed).

### 2.4 Schema migration (idempotent, house style)

```sql
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_type VARCHAR DEFAULT 'human';
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS request_id  VARCHAR;
```

`changed_by` stays the actor email (provenance continuity — an agent's writes show its account email). `actor_type` disambiguates class; `request_id` correlates one agent run across calls. Source: `body.requestId` or `X-Request-Id` header, else NULL.

`auditCall` (P0-4 dispatch audit) and `auditLog` (field-level) both accept the actor and stamp all three columns; `auditLog`'s signature gains an optional actor param, defaulting to `{ actorType: 'human', requestId: null }` so existing call sites are unaffected.

`journal_entries.created_by` is unchanged in meaning — when a human approves an agent's proposal, the journal rows show the human poster; the agent origin lives on the `journal_proposals` row (`created_by`), the audit trail, and the event stream (§3). The ledger stays clean.

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
| `journal.propose` | `data_entry` (agents admitted by the §2.3 whitelist) | ✓ | ✓ | Params mirror `journal.post` (`lines`, `journalId?`, `reference?`, `description?`). Lines are enriched and validated **server-side by the same code path as `journal.post`** (shared `enrichAndValidate` helper — VAT split, FX, balance, account windows) but nothing reaches `journal_entries`. With `proposalId`: upserts a still-`proposed` row **created by the same caller** (extraction fixes, idempotent retries); cannot touch another actor's proposal. Returns `proposalId` + `warnings`. |
| `journal.approve` | `data_entry` | ✓ | ✓ | `proposed → posted`. Re-validates (period lock, account windows, balance), then posts via the **shared `postJournalBatch` helper** with `created_by` = the approving human. Stamps `reviewed_by/at/note` (note optional) and `batch_id`. Emits `journal.approved` + `journal.posted`. |
| `journal.reject` | `data_entry` | ✓ | ✓ | `proposed → rejected`. `note` **required** (the agent reads the reason via `event.list` and re-proposes corrected). |
| `journal.proposal.list` | `viewer` | – | – | Params: `status` (default `proposed`), `limit`. Queue data for the Journal list + badge. |
| `journal.proposal.get` | `viewer` | – | – | One proposal incl. enriched lines, proposer, `request_id`, review triple. |

Refactor (same PR): extract `postEntry`'s enrichment/validation into `enrichAndValidate(companyId, lines)` and its insert core into `postJournalBatch(ctx, { lines, source, journalId, createdByEmail })`; `journal.post` and `journal.approve` both call them. One posting path, no divergent logic.

Guards: approve/reject only from `status='proposed'` (`INVALID_STATUS` otherwise, existing guard style). Agents are excluded from approve/reject by the §2.3 whitelist, not by any check inside the handlers.

### 4.4 The review queue — integrated into the Journal list

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

### 5.2 Tools (v1)

| Tool | Maps to | Notes |
|---|---|---|
| `event_list(after_seq?, type?, limit?)` | `event.list` | The agent's work-discovery channel (§3.3). |
| `journal_propose(lines, journalId?, reference?, description?, proposalId?)` | `journal.propose` | The only write path to the ledger — proposals, never postings (R5). |
| `attachment_upload(...)` | `attachment.upload` | Params mirror the action. |
| `freebooks_read(action, params?)` | any catalog action with `mutating: false` | Generic read gateway (journal/list/get/search, account balances, views, reports, `journal.proposal.*`). Client-side allowlist for friendly errors; **the server-side §2.3 whitelist remains the enforcement.** |

No approve/reject/post/void/master-data tools exist — the agent account couldn't use them anyway (default-deny), and their absence keeps the tool manifest self-documenting.

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

- Per-actor API tokens / auth hardening beyond role-derived actor class.
- Outbound event delivery (webhooks), event retention/compaction policy.
- Bank feeds themselves (P3); OCR/VLM extraction loop (agent-side, not freebooks).
- Bill proposals (dropped with the payables extras) and AR invoice proposals (Receivables dropped) — both reuse this pattern if those tracks return.
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

**Playwright** (`pw-phase-a.mjs`, untracked per convention): queue verbs end-to-end — propose via API → row appears with `PROPOSED` → `y` modal Esc cancels → `y` Enter approves → row becomes posted batch → badge decrements; `x` empty-note disabled → note → rejected row filtered out. `keys-coverage` gate stays green.

---

## 9. Build order

1. **A1** — `agent` role, `resolveActor`, dispatch whitelist guard, audit columns + `request_id`, permissions-UI role option. *(Small: auth.js, dispatch, audit.js, schema, one settings surface.)*
2. **A2** — `events` table + sequence, `emitEvent`, the §3.2 call sites, `event.list`. *(Small-medium.)*
3. **A3j** — `journal_proposals` table, `enrichAndValidate`/`postJournalBatch` refactor, `journal.propose/approve/reject` + `journal.proposal.list/get`, Journal-list queue UI + badge + detail unfold. *(Medium — the bulk is UI.)*
4. **MCP (P2-5)** — `mcp/` server per §5. *(Small; consumes 1–3.)*

Each lands as its own PR with the spec updated in the same commit (standing rule 5).
