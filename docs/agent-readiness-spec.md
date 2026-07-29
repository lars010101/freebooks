# freebooks — Agent-Readiness Spec (Phase A)

**Date:** 2026-07-29 · **Status:** PROPOSED — awaiting ratification · **Context:** agent-driven operating model (Slack design thread, 2026-07-29)

---

## 0. Purpose

The operating model agreed in discussion: **agents prepare, humans approve.** The agent reaches freebooks only through the action RPC (`POST /api`) — never the DB file, never the filesystem. The human's job becomes review and extraction: a queue of agent-prepared proposals, period open/close, reports.

This tranche makes that model enforceable and observable inside freebooks, in three steps:

- **A1 — Actor attribution.** The system knows whether each call came from a human or an agent, and agent-class actors are *technically unable* to finalize anything. One guard, at the one choke point (dispatch).
- **A2 — Event emission.** Business facts (proposal created, bill approved, payment recorded, period locked…) are published to an append-only event stream. This is the agent's *input channel* (poll for new work) and the audit narrative, distinct from the invocation audit (P0-4).
- **A3 — Proposal state (bills).** The first prepare/approve flow: agent proposes a bill → human reviews in the Bills list → approve or reject. A proposed bill can never reach the journal without a human transition.

**Sequencing:** after Receivables (core completeness under any future), before the P2 deep-dive. A1/A2 are prerequisites for P2-5 (MCP server) and P3 (feeds); far cheaper now than after more surfaces bake in.

**Corrections this makes to the 2026-07-29 sketch:** (a) the review queue is *integrated into the existing Bills FB.list* (dissolve-into-existing-surfaces rule), not a dedicated page — so `Enter` keeps its open/unfold meaning and approve/reject get their own verbs; (b) enforcement is *default-deny whitelist*, not per-action flags the agent could outmaneuver.

---

## 1. Invariants

| # | Rule |
|---|------|
| R1 | The API is the only writer. The agent never opens the DB file. (Deployment property — service-user file ownership — stated here because everything else assumes it.) |
| R2 | Agent-class actors may **read** and **propose** only. They can never finalize (post, void, settle, lock/unlock periods) and never mutate master data (COA, vendors, mappings, VAT codes, settings, permissions, company). Enforced at dispatch, default-deny, before the handler runs. |
| R3 | Every write is attributable: actor email, actor class (human/agent), and a caller-supplied request id grouping one agent run's calls. |
| R4 | Events are business facts, append-only, emitted exactly once — an idempotent-key replay must never double-emit. |
| R5 | Human review is an explicit state transition, not a convention. No agent-created row reaches `journal_entries` without a human approve + post. |
| R6 | All enforcement is server-side. The client renders state and offers verbs; it never decides eligibility. |

---

## 2. A1 — Actor attribution

### 2.1 The `agent` role

`user_permissions.role` gains a fourth value: **`agent`**. Role levels (`auth.js`):

```
owner 3 · data_entry 2 · agent 1.5 · viewer 1
```

`agent` sits above `viewer` (agents read everything a viewer can) and below `data_entry` (every existing `data_entry` action rejects agents at the numeric check, unchanged). `checkPermission`'s comparison is untouched — 1.5 composes with the existing levels.

An agent account is just an email row with role `agent` (granted by an owner via the existing permissions surface — the role select gains the `agent` option).

### 2.2 Actor class is derived, never asserted

`auth.js` gains `resolveActor(email, companyId) → { role, actorType }` (same 60s TTL cache as `checkPermission`; `actorType = role === 'agent' ? 'agent' : 'human'`). Dispatch resolves the actor once and puts it on `ctx.actor`. **The class comes from the database role, not from anything in the request** — an agent cannot self-assert its way to `human`. This is the meaningful control given today's install-level trust model (self-asserted `userEmail`); per-actor API tokens remain later hardening (P2-5 era), noted as out of scope.

### 2.3 The dispatch guard (default-deny)

Catalog entries keep their existing `role`. The guard is a whitelist, evaluated in `handleApiRequest` immediately after the role check:

```
if (ctx.actor.actorType === 'agent' && actionIsMutating && action ∉ AGENT_ALLOWED)
    → fail FORBIDDEN 'Agents may not finalize or mutate master data'
```

`AGENT_ALLOWED` (v1, exhaustive): all non-mutating (viewer) actions · `bill.propose` (§4.2) · `attachment.upload`. `setup.*` actions (which skip the role check today) are rejected for agent actors unconditionally. Everything else mutating — posting, voiding, settlement, reconciliation, periods, settings, COA, vendors, mappings, VAT codes, permissions, company — is human-only **by default, including any action added in future** (a new mutating action is denied to agents until explicitly whitelisted — fail-closed).

### 2.4 Schema migration (idempotent, house style)

```sql
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_type VARCHAR DEFAULT 'human';
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS request_id  VARCHAR;
```

`changed_by` stays the actor email (provenance continuity — an agent's writes show its account email). `actor_type` disambiguates class; `request_id` correlates one agent run across calls. Source: `body.requestId` or `X-Request-Id` header, else NULL.

`auditCall` (P0-4 dispatch audit) and `auditLog` (field-level) both accept the actor and stamp all three columns; `auditLog`'s signature gains an optional actor param, defaulting to `{ actorType: 'human', requestId: null }` so existing call sites are unaffected.

`journal_entries.created_by` / `bills.created_by` are unchanged — when a human approves and posts an agent's proposal, the journal shows the human poster; the agent origin lives on the `bills` row (`created_by`), the audit trail, and the event stream (§3). The ledger stays clean.

---

## 3. A2 — Event emission

### 3.1 Table

```sql
CREATE SEQUENCE IF NOT EXISTS events_seq START 1;
CREATE TABLE IF NOT EXISTS events (
  event_seq   BIGINT    NOT NULL DEFAULT nextval('events_seq'),
  event_id    VARCHAR   NOT NULL DEFAULT (uuid()),
  company_id  VARCHAR   NOT NULL,
  event_type  VARCHAR   NOT NULL,    -- 'bill.proposed', 'bill.posted', ...
  entity_type VARCHAR   NOT NULL,    -- 'bill' | 'payment' | 'journal' | 'attachment' | 'period'
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
| `bill.proposed` / `bill.approved` / `bill.rejected` | A3 transitions (§4) |
| `bill.posted` | bill post (draft→posted) |
| `bill.payment.recorded` / `bill.payment.voided` | settlement paths |
| `journal.posted` | journal post |
| `attachment.uploaded` | attachment upload (the feed-extraction trigger) |
| `period.locked` / `period.unlocked` | period transitions |

Payload: compact snapshot (for a bill: vendor, date, due_date, amount, currency, status). Generic per-action invocation data stays in `audit_log` (P0-4) — the event stream does not duplicate it.

**Replay rule (R4):** the idempotency short-circuit returns the stored response *before the handler runs*, so emission inside handlers cannot double-fire on a replay. Correct by construction, asserted by a contract test.

### 3.3 `event.list` — the agent's input channel

New catalog action: `event.list` — viewer role, non-mutating. Params: `after_seq` (number, default 0), `type` (optional filter), `limit` (≤ 500, default 100). Returns rows ordered by `event_seq` ascending.

Polling contract: the caller keeps the highest `event_seq` seen and passes it as `after_seq` on the next poll. Monotonic, gap-safe, replay-safe. This is what an agent watches for work — e.g. `attachment.uploaded` → fetch the file → extract → `bill.propose`. (Outbound delivery/webhooks: out of scope v1.)

---

## 4. A3 — Proposal state (bills)

### 4.1 Lifecycle

```
                 bill.propose (agent)
                        │
                        ▼
                   proposed ────── bill.reject (human) ──▶ rejected  [terminal,
                        │                                   kept for audit,
              bill.approve (human)                          never posts]
                        ▼
                      draft ──▶ posted ──▶ partial ──▶ paid
                        └──────────▶ void
```

`proposed` rows are draft-shaped (`draft_lines` JSON, no journal entries) and are blocked from the existing post path for free — `bill.post`'s `WHERE status='draft'` guard already rejects them. `rejected` is terminal and auditable, never deleted.

### 4.2 Actions

| Action | Role | Mutating | Idempotent | Notes |
|---|---|---|---|---|
| `bill.propose` | `agent` (also data_entry/owner) | ✓ | ✓ | Creates `status='proposed'`. Params mirror the draft-save shape (vendor, dates, currency, lines, VAT code per line). Totals and VAT computed **server-side, exactly as the draft/post path** — the agent proposes lines + codes, never amounts' authority. With `billId`: upserts a still-`proposed` row **created by the same caller** (extraction fixes, idempotent retries); cannot touch another actor's proposal. Returns `warnings` like the post path. |
| `bill.approve` | data_entry | ✓ | ✓ | `proposed → draft`. Optional `note`. Stamps `reviewed_by/at/note`. From then on it's an ordinary draft: edit, post, void — existing machinery unchanged. |
| `bill.reject` | data_entry | ✓ | ✓ | `proposed → rejected`. `note` **required** (the agent reads the reason via `event.list` and re-proposes corrected). |

Guards: approve/reject only from `status='proposed'` (`INVALID_STATUS` otherwise, existing guard style). Agents are excluded from approve/reject by the §2.3 whitelist, not by any check inside the handlers.

```sql
ALTER TABLE bills ADD COLUMN IF NOT EXISTS reviewed_by  VARCHAR;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS reviewed_at  TIMESTAMP;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS review_note  VARCHAR;
```

### 4.3 The review queue — integrated into the Bills list

No new page, no new route. The Payables Bills FB.list **is** the queue:

- `view.bills` includes `proposed` rows (Status column shows `PROPOSED`); `rejected` rows appear only under an explicit status filter (default view keeps them out of the way with `void`).
- **Row verbs on a focused `proposed` row** (per-row verb predicates in FB.list — framework contract addition, documented in `fb-list-ux-spec.md` in the same commit as the behavior):
  - `y` — **approve**. Confirm modal (optional note; `Enter` confirms; `Esc`/backdrop cancels — Esc never writes). On confirm: status → `draft` in place, badge refreshes.
  - `x` — **reject**. FB.modal with a **required** note input (`Enter` submits when non-empty; `Esc` cancels). Consistent with `x` = discard/delete doctrine.
  - `Enter` — open bill detail (read-only review: header, lines, attachments, proposer + request id). Detail page carries the same `y`/`x` verbs. **No in-place editing of proposed rows** — review is accept-or-reject; the proposer owns pre-approval edits (§4.2 upsert). A human who wants changes approves first, then edits the draft. One writer per state.
- **Nav badge:** the Payables sidebar item shows the pending-proposal count (from `view.bills` summary / a `bill.proposed_count` viewer action), refreshed on soft-nav and after queue verbs. This is the monitoring surface — the human sees *there is work* without opening anything.
- **Empty state:** "Nothing to review — agent-proposed bills will appear here" + how bills normally arrive (pages self-explanatory rule).

**This is the queue idiom, specified once here and reused verbatim** by future queues (AR invoice proposals, feed-import review): status-filtered FB.list + `y`/`x` row verbs + note-on-reject + nav badge. Keyboard-program conventions apply throughout (K1–K5); the `keys-coverage` gate covers the new verbs via the existing page set.

### 4.4 Why `y`/`x` and not `Enter`/`a`

`Enter` on FB.list rows is open/unfold (tree doctrine) — overloading it as approve would make the list the one place Enter destroys context. `a`/`A` are taken (`a` = add child line on the Bills tree; `A` = attach, K4 universal). `y` (yes) / `x` (no) is the review pair, new as a *universal* verb only in the queue context, ratified here.

---

## 5. What this unlocks (the operating model, mapped)

| Operating-model piece (2026-07-29 discussion) | Delivered by |
|---|---|
| Agent has no DB/file access; API only | Deployment (R1) + §2.2 derived actor class |
| Agent can never finalize or corrupt | §2.3 default-deny whitelist (R2) |
| Attribution on every row | §2.4 audit actor columns + `request_id` (R3) |
| Transaction input to the agent | §3.3 `event.list` polling + attachments (P3 feeds build on this) |
| Agent posts | `bill.propose` — proposals, never postings (R5) |
| Human reviews, approves | §4.3 queue + approve/reject |
| Human opens/closes periods | Unchanged — period actions are human-only by the whitelist, permanently |
| Reports | Existing (unchanged) |
| WORM backups / teardown-retention | Infrastructure, app-independent — unchanged |

Sequencing after this tranche: **P2-5 (MCP server)** consumes the actor model; **P3 (feeds)** is a feed adapter calling `bill.propose` + an agent loop on `event.list`; **Receivables** ships `invoice.propose` on the same pattern when AR lands.

---

## 6. Out of scope (v1)

- Per-actor API tokens / auth hardening beyond role-derived actor class (P2-5 era).
- Outbound event delivery (webhooks), event retention/compaction policy.
- Bank feeds themselves (P3); OCR/VLM extraction loop (agent-side, not freebooks).
- AR invoice proposals (pattern reuse when Receivables lands).
- Agent-proposed *master data* (new vendors/accounts): stays human-only until a proposal pattern for master data is designed — a proposal referencing an unknown vendor carries the raw name string (`bills.vendor` is a name, not an FK), so this blocks nothing in v1.
- Vendor bank-detail handling: no such fields exist today; when they arrive, they are human-only permanently (BEC fraud vector).

---

## 7. Verification

**Contract tests** (tracked, `tests/`, extending the P1-2 harness):

1. Guard matrix: agent actor × every mutating action → only the §2.3 whitelist passes; `setup.*` rejected; a *hypothetical new* mutating action is denied (fail-closed proof).
2. `bill.propose` → approve → post happy path; journal lines carry the human poster; bill carries agent `created_by` + reviewer triple.
3. Reject is terminal: post/approve/re-approve on `rejected` all `INVALID_STATUS`.
4. Propose-upsert: same-caller edit of own `proposed` row ✓; other actor's row ✗; non-`proposed` row ✗.
5. Idempotent replay of `bill.propose` (same key) → one bill, one `bill.proposed` event (R4).
6. `event.list`: ordering, `after_seq` polling, type filter, limit cap.
7. Audit rows carry `actor_type` + `request_id` for both dispatch and field-level entries.

**Playwright** (`pw-phase-a.mjs`, untracked per convention): queue verbs end-to-end — propose via API → row appears with `PROPOSED` → `y` modal Esc cancels → `y` Enter approves → row becomes draft → badge decrements; `x` empty-note disabled → note → rejected row filtered out. `keys-coverage` gate stays green.

---

## 8. Build order

1. **A1** — `agent` role, `resolveActor`, dispatch whitelist guard, audit columns + `request_id`, permissions-UI role option. *(Small: auth.js, dispatch, audit.js, schema, one settings surface.)*
2. **A2** — `events` table + sequence, `emitEvent`, the §3.2 call sites, `event.list`. *(Small-medium.)*
3. **A3** — statuses + columns, `bill.propose/approve/reject`, `view.bills` inclusion, FB.list row-verb predicates, queue UI + badge, detail-page review bar. *(Medium — the bulk is UI.)*

Each lands as its own PR with the spec updated in the same commit (standing rule 5).
