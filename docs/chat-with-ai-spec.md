# Chat with AI — Spec

**Status:** Draft — design agreed in principle (session with magnus, 2026-09-04), not yet built.
**Scope:** A new page (`/:company/chat`) reachable from the topbar 💬 icon (`api/src/pages/common.js:157`, currently a disabled "coming soon" stub), a new `chat.*` action group, a consent-gated data-exposure model, and a status readout that closes issue #180 (agent status has no UI home).
**Reverses:** `docs/b9-self-contained-agent-spec.md` §10's "No chat interface. Per direction (2026-08-06): 'forget the chat function.'" That decision's own reasoning was that an LLM outage should surface *indirectly* — "if it's down, lines stay unmatched and surface in the inbox." Reversed this session: indirect surfacing doesn't answer "is anything broken right now" without a human manually cross-referencing Inbox staleness, and a chat surface both closes that gap and gives a natural home for ad-hoc bookkeeping questions. Ratified by magnus, 2026-09-04.
**Depends on:** `docs/agent-readiness-spec.md` (R5 single-gateway rule — chat's propose path is bound by it, same as the automated agent). `docs/settings-ai-flattened-spec.md` (LLM endpoint config, already shipped). `docs/b9-self-contained-agent-spec.md` (`agent.status`, `ai.test_connection`, `tier4LLMReason`'s JSON-mode call shape — all already shipped and reused here, not rebuilt).

---

## 0. Scope

**In:**
- Read Q&A — answer questions about the books (balances, why a bank line is unmatched, report figures) and about pipeline health (agent running? LLM reachable?), drawing on real ledger detail (journal entries, bills, bank lines) — not just report summaries.
- Propose — on request, draft a journal batch or bill into the **existing** propose/approve queue (`journal_proposals` / `bills` draft state), exactly the entities the automated agent and the Inbox already work with. Never posts directly.
- Status — agent-loop / feed-watcher / LLM-connection health, both inline in chat replies and as a persistent readout on the page (closes #180).
- **Human-gated data exposure** — a fixed, code-defined catalog of fetchable data categories (§2a), each requiring an explicit one-time human decision (§2b) before its data is ever sent to the configured LLM endpoint. The catalog can be extended over time (a developer adds a new category), but which categories actually get *used* on a given install is entirely human-decided, incrementally, the first time chat tries to use each one.
- **Structured-identifier aliasing** — company name/address and partner (vendor/customer) names can be sent to the LLM as opaque aliases instead of real values, decided per-category alongside the allow/deny consent (§3).

**Out (explicit, mirrors the b9 spec's own house style):**
- No approve/reject/post/void from chat. Same ceiling as the automated agent (R5) — chat drafts, a human still approves in Inbox.
- No settings changes from chat.
- No streaming responses — one request, one reply per completed turn (a turn may still involve a pause for a permission decision — see §2), matching the existing non-streaming `fetch` pattern already used by `tier4LLMReason`/`ai.test_connection`.
- No file/image upload inside chat — the Inbox upload panel already covers document intake; don't duplicate it.
- No tool-calling protocol. JSON-mode prompting only (`response_format: {type:'json_object'}`), matching the one LLM-interaction pattern already proven against the configured endpoint (`agent-loop.js`'s `tier4LLMReason`). Most local OpenAI-compatible servers (llama.cpp, etc.) don't reliably support function-calling; JSON-mode is what's already shipped and working. The category-request/response exchange in §2 is two ordinary JSON-mode completions, not the OpenAI tools API.
- **No free-text masking or scrubbing.** Bill/journal descriptions, reference fields, and any other free-text content are sent to the LLM exactly as stored whenever their owning category is approved — never redacted, never scrubbed, never passed through an anonymizer. Reliably stripping identifying content out of arbitrary prose is not a solved problem, and a scrubber that looks like it works but silently misses things is worse than no scrubber — it gives false confidence. This is an explicit, permanent non-goal, not a v1-only gap: the chat UI must say so plainly (§3.3), and no future revision of this spec should attempt free-text scrubbing without first amending this line.

---

## 1. Where it lives

- Topbar 💬 icon: enabled, `title` changes from "Chat with AI (coming soon)" to "Chat with AI", navigates to `/:company/chat`.
- `nav-registry.js`: new route entry, `sidebar: false` (utility surface, reached via the icon + palette, not sidebar clutter — same reasoning already applied to other icon-only surfaces in this app).
- The icon itself carries a small status dot (see §4) so pipeline trouble is visible without opening the page.

## 2. Message flow

A turn is **two LLM calls**, with a possible human-consent pause between them. No data is fetched for the LLM's benefit until the human has cleared it; data fetched purely to render a consent preview to the human is a normal company-scoped read and is never itself sent onward until approved.

1. User types a message on `/:company/chat` → `chat.send` (`message`, `turnId` — client-minted, same idemKey convention used elsewhere in the app).
2. **Call 1 (category selection).** Server sends the LLM the user's message plus the *names* of every category in the catalog (§2a) — not data. Expected output: `{ "categories": ["journal_entries", "coa", ...] }`.
   - **Short-circuit:** if the only categories selected are the consent-exempt `agent_status`/`ai_connection` (§2a note), skip Call 2 entirely — answer directly from a template built off the local data ("Agent: Running · LLM: Reachable") rather than spending a second LLM call restating a boolean in prose. Note this does **not** make status questions resilient to a fully unreachable LLM endpoint — Call 1 itself still needs the endpoint up to interpret the free-text question in the first place. A true LLM-outage fallback for status questions (e.g. a cheap keyword check before Call 1 ever fires) is a separate idea, not a side effect of this short-circuit, and isn't in scope here.
3. Server partitions the requested categories against `chat_data_permissions` (§2b):
   - **Already decided `allow_always`** → fetch now, mark ready.
   - **Already decided `deny_always`** → excluded, never fetched for the LLM; noted internally so the eventual reply can say "I don't have permission to see X."
   - **Undecided** → fetch now *for local preview only*, and return a `pending_permission` response to the client — `{ turnId, pending: [{category, previewData}] }` — instead of completing the turn. The preview data travels to the client in this response and is **not** persisted server-side (see §2b's storage note); the client holds it until the user decides. `chat.send` does not block on human input — a turn with pending categories is parked (`chat_pending_turns`, §2b, metadata only) and resumed by a separate call once decided.
4. Client renders one inline consent card per pending category, showing the actual preview data it already received (§2c) — never just the category name.
5. User decides, per category, via `chat.permission.decide` (`turnId`, `category`, `decision` ∈ `approve_once | allow_always | deny_once | deny_never`, `aliased: boolean` — §3.2). `allow_always`/`deny_never` write a row to `chat_data_permissions` (persists for future turns); `approve_once`/`deny_once` affect only this turn. On an `approve_*` decision the server **re-fetches the category fresh** (cheap, an ordinary company-scoped read) rather than trusting the client-held preview as the data that gets sent — the preview was for display only.
6. Once every pending category for the turn is resolved, the server proceeds automatically: assembles the approved categories' data (real values or aliases per §3.2), and fires **Call 2** — original question + the granted data — against the same LLM endpoint. Expected output: `{ "reply": string, "propose": null | { "type": "journal"|"bill", ...fields } }`.
7. If `propose` is present, the server **de-aliases** any aliased identifiers back to real values (§3.2) and calls the existing `journal.propose` (`lines`, `reference`, `description`) or `bill.create` (draft) action **as the logged-in human**, not a synthetic agent identity — `ctx.actor` is whoever is chatting. This clears `journal.propose`'s role floor (catalog role `agent`/1.5; a human `data_entry`(2) or `owner`(3) actor satisfies it same as today) and the proposal is attributed to that human (`source: 'human'`, `created_by: <their email>`) — same attribution a person gets today typing directly into journal-voucher, not tagged as agent-authored. It lands in the same Inbox queue, same `y`/`x` review, nothing about the approval path changes.
8. The chat reply always echoes what it drafted ("Drafted a journal proposal: DR 6570 Bank fees 45.00 / CR 1930 SEB 45.00 — it's in your Inbox for approval") so the user isn't left guessing whether the propose step actually fired. On a `journal.propose`/`bill.create` failure, the reply surfaces the error text directly.
9. **LLM unreachable (Call 1 or Call 2).** Not a completed turn, but not a silent drop either: the user's message is written to `chat_messages` alongside a synthetic assistant reply containing the error text ("Couldn't reach the configured LLM endpoint: <error>") — same visible-in-history treatment as a `propose` failure in step 8, just one step earlier in the flow. No separate status/failed column on `chat_messages` — the error becomes the assistant's message content.
10. Both the user's message and the final assistant reply (success or error, per step 9) are written to `chat_messages` (§4) once the turn completes — the only case that writes nothing to `chat_messages` is a turn still parked on an unresolved permission decision, which lives solely in `chat_pending_turns` until the human acts.

### 2a. The category catalog

A short, fixed list of named, pre-written, company-scoped read queries — not generated, not parameterizable by the LLM beyond what each entry explicitly accepts. Starter list:

| Category | Data | Notes |
|---|---|---|
| `coa` | Chart of accounts (code, name, type) | No balances — near-zero sensitivity. Practically required for `propose` to work at all (the model needs real account codes). |
| `journal_entries` | Posted journal lines, filterable by account/date range/description substring | Real ledger detail — this is the "just a worse UI" gap named in the design discussion; without it chat can't actually answer ledger questions. Filter shape and validation: see below. |
| `bills` | Bill list — vendor, amount, status, due date | Mirrors what Payables already shows a viewer. |
| `bank_unmatched` | Uncleared/unmatched bank lines | Mirrors the Reconciliation tab / Inbox reconciliation alerts (#138). |
| `pl_summary` / `bs_summary` | Report totals for a period, via the existing `pl()`/`bs()` macros | Aggregate only — same numbers Reports already renders. |
| `inbox_summary` | Counts + summaries of pending Inbox items | No line-level detail beyond what Inbox itself shows. |
| `agent_status` | `agent.status` output | Already covered by §4 regardless of consent (see note below). |

Adding a category later is a code change (one query + one catalog entry), reviewed like any other change — the LLM never expands this list itself, it only ever selects from what's already there.

**`journal_entries` filter shape (resolves the former open question #7.4):** the LLM's Call-1 response, when requesting this category, includes a filter object of exactly this shape — `{ account: string|null, from_date: ISO-date|null, to_date: ISO-date|null, description_contains: string|null }`. Every field is optional (all `null` = unfiltered, subject to the cap below); anything outside these four keys is ignored, not passed through. Server-side, each field is validated by type (a bad `from_date` is dropped, not coerced) and bound as an ordinary parameterized query argument (`@fromDate`, `@accountCode`, …, matching every other query in this codebase — never string-interpolated into SQL). `account`, if present, is checked against the company's actual COA before use. Row cap: same `threshold`/`tooMany` pattern already used by `bill.list`/`payment.list` — a query matching more than the cap returns `{tooMany: true, total}` instead of rows, and the reply says so ("that's 940 entries — narrow the date range or account") rather than dumping an unbounded result into the next LLM call.

**Note on `agent_status`/`ai_connection`:** these two are exempt from the consent gate — they contain no company financial data (loop-running booleans, timestamps, reachability), so gating them would just add friction for zero privacy benefit. Every other category goes through §2b.

### 2b. Permission model

New table `chat_data_permissions`: `company_id, category, decision ('allow_always'|'deny_always'), aliased (boolean, only meaningful when decision='allow_always' and the category has structured identifiers), decided_by, decided_at`. One row per category per company; a fresh company starts with no rows (everything undecided → first use always prompts). `aliased` is what makes an `allow_always` decision keep applying the checkbox's choice on every future turn without re-showing the card — see §3.2.

New table `chat_pending_turns`: `company_id, turn_id, user_message, pending_categories (JSON array of category names), resolved_categories (JSON — category → {decision, aliased}), created_at`. **Metadata only — no fetched data.** Per §2 step 3/5, preview data travels to the client inline in the `chat.send` response and gets re-fetched fresh at approval time; it is never written into this table, so the size concern a large `journal_entries` result could otherwise create doesn't apply here at all — the row stays small regardless of how much data a category preview contained. Deleted once the turn resolves and Call 2 completes (or once step 9's error path writes its `chat_messages` row); this is working state, not conversation history.

- **Abandoned turns are swept, not left indefinitely.** A turn can sit unresolved if the user walks away mid-decision. A TTL sweep (mirroring the existing A4 attachment-GC pattern — boot-time + a periodic `setInterval`, `docs/agent-readiness-spec.md` §4.7's as-built) deletes `chat_pending_turns` rows older than a short window (hours, not the 30-day attachment-GC grace — an abandoned chat turn blocks nothing about the ledger, it's just clutter). Exact window is a build-time choice; the mechanism is the point, not the number.
- **Revocable, not a one-way ratchet.** `chat.permissions.list` (viewer of the current grants) and re-deciding a category via `chat.permission.decide` (a later `allow_always`/`deny_never` overwrites the stored row) are both in v1 — an accidental "always allow" click must be fixable without a database edit. Surfaced as a small table on the chat page itself (not a new Settings tab) since it's chat-specific state, not general configuration.
- **Per-company, matching everything else in this table's design** (§4) — a decision made under one company does not carry to another, consistent with `company_id` scoping everywhere else in the schema.
- **First-turn friction is expected, not a bug.** The first message that needs any real data will pause on at least `coa` (for propose) and whatever else it asks for; this is the intended informed-consent moment, not a defect to engineer around.

### 2c. Consent UX

Rendered inline in the chat thread as a system-style card, one per pending category, at the point in the conversation where it was requested — not a modal, so it stays part of the visible turn history (a user scrolling back can see what was asked and what they decided). The card shows:
- The category name and a one-line description (from §2a's catalog, not LLM-generated).
- **For categories with structured identifiers only** (§3): a "Send names as aliases (e.g. 'Vendor_7') instead of real names" checkbox, checked by default. This is the *only* place aliasing appears in the UI — a single orthogonal toggle, not a doubled set of decision buttons (see §3.2 for why the earlier per-button design was wrong).
- **The actual data that would be sent** — the real fetched rows, re-rendered live as the checkbox is toggled so the preview always matches what the buttons below would actually send.
- Four buttons, unchanged regardless of the checkbox's state: Approve once · Always allow · Deny once · Never allow.

Showing only the category name without the data would not be informed consent — the preview is the point.

## 3. Aliasing for structured identifiers

Distinguishes cleanly from the free-text non-goal in §0: this covers only *structured* fields where a straightforward, complete, table-driven substitution is possible — company name, company address, and partner (vendor/customer) `name`. It explicitly does **not** cover descriptions, references, or any other free-text field, which are sent as-is per §0's non-goal whenever their category is approved at all.

### 3.1 Mechanism

New table `chat_aliases`: `company_id, real_value, alias, entity_type ('company'|'partner'), created_at`. Aliases are assigned lazily — the first time a given partner or the company itself would be included in data sent under an approved category, and only if aliasing was chosen for that category (see 3.2). Once assigned, an alias is stable for the life of the company (the same vendor is always "Vendor_7" in every future turn, so the model's reasoning about "the same vendor across multiple bills" still holds).

### 3.2 Where it plugs into the consent flow

Aliasing is a **checkbox on the consent card (§2c), orthogonal to the four decision buttons** — not a doubled set of buttons. Earlier drafts of this spec had "Always allow (aliased)" as a separate button variant per category; that conflated two independent axes (how long does this decision last vs. real-or-aliased data) into more buttons, pushing a single card toward six choices. The checkbox fix keeps the card at four buttons plus one optional checkbox regardless of how many categories carry structured identifiers.

The checkbox's state at the moment a button is pressed is what gets recorded: `approve_once`/`deny_once` apply the checkbox's state to this turn only; `allow_always` persists it into `chat_data_permissions.aliased` (§2b) so every future silent auto-approval of that category uses the same real-or-aliased choice without asking again; `deny_never` makes the checkbox moot (nothing is sent either way).

### 3.3 De-aliasing on the way back in

If Call 2's `propose` output references an alias (e.g. a drafted bill for `"Vendor_7"`), the server resolves it back to the real partner via `chat_aliases` **before** calling `journal.propose`/`bill.create` — an alias must never reach `journal_entries`, `bills`, or any other real table. This is a hard invariant, not a best-effort step: if an alias in a `propose` payload doesn't resolve (shouldn't happen, since the server assigned every alias itself), the propose is rejected with an error rather than silently writing the alias string into the ledger.

### 3.4 What's explicitly not covered

Free-text fields (`description`, `reference`, and similarly on any future category) are never aliased or masked, regardless of the category's consent decision — restated from §0 because it's the detail most likely to be assumed otherwise. The chat page carries a permanent, visible note near the input box: *"Bill and journal descriptions are sent to the LLM exactly as written when needed to answer — avoid putting sensitive personal details in them if using a cloud LLM endpoint."* This is a disclosure, not a control — the control is the per-category consent gate in §2b, which at least lets a human keep an entire category (including its free text) out of the conversation altogether.

## 4. Status readout (closes #180)

Two places, same two data sources — no new health-check machinery, both actions already exist and ship today, and both are exempt from the §2b consent gate (§2a note):

- **`agent.status`** (`index.js:1934`, unchanged) → `{ running, cursors, feedWatcher: {running, lastScan, watchers, fallback} }`.
- **`ai.test_connection`** (`index.js:1663`, unchanged) → on-demand LLM reachability check.

**On the chat page:** a small status strip above the message thread — "Agent: Running (last poll 12s ago) · Feed watcher: Running · LLM: Reachable" — built by calling both actions on page load. Clicking it re-runs both (manual refresh, not polling).

**On the topbar icon:** a color dot — green (agent running AND LLM reachable), amber (agent running, LLM unreachable — the exact split #180's original research called out as the case worth distinguishing), grey (agent stopped). Computed once per app-shell load and re-checked every 5 minutes while the tab stays open (not on every page navigation — avoids hammering `agent.status`/`ai.test_connection` on every soft-nav). **Implementation note:** checked `fb-core.js` — there is no existing polling/heartbeat primitive in the app shell today (no `setInterval` there at all). This 5-minute refresh is a genuinely new pattern in the shell layer, not a hook into something that already exists — worth knowing going in, since it's the one piece of this spec that isn't just reusing already-shipped machinery.

## 5. Persistence — full table list

- `chat_messages` — `company_id, message_id, role ('user'|'assistant'), content, proposal_ref (nullable), created_by, created_at`. Written for a completed turn, success or LLM-error alike (§2 steps 9–10); never written for a turn still parked on a pending permission decision.
- `chat_pending_turns` — working state for an in-flight, permission-paused turn (§2b). Ephemeral, deleted on turn completion.
- `chat_data_permissions` — durable per-category consent decisions (§2b).
- `chat_aliases` — durable real-value↔alias map for structured identifiers (§3.1).

**`chat_messages` scoped per-company, not per-user** — one shared conversation thread per company, matching this app's existing single-operator assumption (`agent-readiness-spec.md` §10.6: "No snooze/assignment — single-operator product") and the Inbox's own company-wide (not per-user) framing. Flagged as the one point worth a second look if this ever becomes a multi-operator install — see §7.

## 6. New action-catalog entries

- `chat.send` — role `data_entry`. params: `message: {type:'string', required:true}`, `turnId: {type:'string', required:true}`.
- `chat.permission.decide` — role `data_entry`. params: `turnId: {type:'string', required:true}`, `category: {type:'string', required:true}`, `decision: {type:'string', required:true}` (`approve_once|allow_always|deny_once|deny_never`), `aliased: {type:'boolean'}` (the consent-card checkbox state, §3.2 — ignored for categories with no structured identifiers).
- `chat.permissions.list` — role `data_entry`. Lists current `chat_data_permissions` rows for the company (the revoke/audit surface, §2b). No params.
- `chat.history.list` — role `data_entry`. params: `limit: {type:'number'}`.

None of these are added to `AGENT_ALLOWED` — this is a human-facing surface; the automated agent loop has its own separate tier-4 path and does not use chat.

## 7. Open questions (defaults chosen, flagging in case they're wrong)

1. **Per-company shared thread vs. per-user thread** — defaulted to shared (§5). If multiple humans use the same company account and want private scratch conversations, this would need a `created_by`-scoped read filter instead — trivial to add later since the column already exists, just unused for filtering in v1.
2. **`chat.send` role floor** — defaulted to `data_entry`. If a viewer should get Q&A-only access with the propose branch silently disabled instead of being locked out entirely, that's a bigger change (role-conditional behavior inside one action) — flag if wanted.
3. **Status-dot refresh interval** — defaulted to 5 minutes. Adjustable; no reason it's exactly 5 beyond "not too chatty, not too stale."
4. **`chat_pending_turns` TTL window** — defaulted to "hours, not days" (§2b), mirroring the GC-sweep mechanism from A4 but on a much shorter clock since nothing ledger-relevant is at stake in an abandoned turn. Exact number (e.g. 2h vs 24h) not pinned — flag if you have a preference.
