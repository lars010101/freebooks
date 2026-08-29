# Phase B9 — Self-Contained Agent Pipeline + LLM Provider Abstraction

**Status:** RATIFIED 2026-08-06 (both open questions resolved: manual agent account flow, sequential processing)
**Context:** Phase B (B1–B8) shipped the agent-first pipeline as external processes (B5 bash watcher + B7 node script). This spec moves both inside the Express server, adds multi-tenant folder routing, and introduces the Settings/AI tab for LLM provider configuration. MCP is unchanged — it remains the external-agent interface.

## What changes

| Component | Before (B5 + B7) | After (B9) |
|---|---|---|
| Folder watcher | External bash script (`freebooks-feed-watch.sh`), `inotifywait` | In-process Node module, `setInterval` + `readdir` |
| Agent loop | External script (`freebooks-agent-loop.js`), HTTP self-call | In-process module, direct handler calls *(legacy script subsequently deleted — see §7)* |
| LLM config | Env vars, hardcoded tier-4 placeholder | `settings` table keys, Settings/AI tab |
| Multi-company | Single `FREEBOOKS_COMPANY` env var | Folder structure `inbox/{company_id}/{type}/` |
| MCP | External agent transport (Hermes) | **Unchanged** — stays as-is |
| External scripts | Primary pipeline | **In-process is sole path** — `freebooks-agent-loop.js` deleted (placeholders never implemented); `freebooks-feed-watch.sh` retained as fallback |

## 1. Multi-tenant folder structure

### Inbox layout

```
~/freebooks-inbox/
  {company_id}/
    bank/          → entityType: bank_statement
    bills/         → entityType: bill
    receipts/      → entityType: journal_proposal
    journal/       → entityType: journal_proposal
```

Company ID is the top-level directory. The watcher validates each `company_id` against the `companies` table before uploading. Unknown company directories are skipped with a warning log — no upload, no event.

### Company-level settings keys (new)

Stored in the existing `settings` table (key-value, per-company):

| Key | Type | Default | Description |
|---|---|---|---|
| `agent_enabled` | `'true'`/`'false'` | `'false'` | Master switch for the in-process agent loop |
| `agent_poll_interval_ms` | string (int) | `'30000'` | Event stream poll interval |
| `agent_inbox_path` | string | `~/freebooks-inbox` | Root path for this company's drop folders |
| `llm_endpoint_url` | string | (empty) | OpenAI-compatible endpoint URL |
| `llm_api_key` | string | (empty) | Bearer token (empty for local) |
| `llm_model` | string | (empty) | Model name (e.g. `qwen2.5-7b-instruct`) |
| `llm_temperature` | string | `'0.1'` | Inference temperature |

These are per-company — each company can have a different LLM endpoint, poll interval, and inbox path. The `settings.get` / `settings.save` actions (already implemented) handle CRUD. No new API actions needed.

### Install-level settings (not per-company)

One key stored with a synthetic `company_id = '__install__'`:

| Key | Description |
|---|---|
| `feed_watcher_interval_ms` | readdir poll interval (default `'5000'`) |

> **Note:** `feed_watcher_enabled` was previously a separate install-level master switch. It has been consolidated into `agent_enabled` — the feed watcher now starts automatically when any company has `agent_enabled = 'true'`. The separate gate had no UI and caused silent failures (agent loop running with nothing feeding it). Existing `feed_watcher_enabled` rows in settings are inert and harmless.

## 2. In-process folder watcher (`api/src/feed-watcher.js`)

### Design

```js
// Started once at boot when any company has agent_enabled = 'true'
// Uses fs.watch() (inotify on Linux) for instant detection, with a polling
// fallback for unsupported filesystems (NFS, etc.)
//
// 1. Immediate startup scan — catches files dropped while server was down
// 2. fs.watch() on each company subfolder — instant, zero idle CPU
// 3. If fs.watch() fails, falls back to setInterval(readdir)
for (const company of companies) {
  for (const subfolder of ['bank','bills','receipts','journal']) {
    fs.watch(inboxPath/company/subfolder, (eventType, filename) => {
      processFile(company, subfolder, filename);
    });
  }
}
```

### file processing logic

1. `fs.watch()` fires on file creation/rename into the watched directory
2. Debounce 300ms, keyed per filename — coalesces rapid rename+change bursts from one logical write without dropping a second, different file dropped in the same window (§12.1: an early version keyed the debounce timer per watcher instead, so a second file within 300ms of a first silently cancelled the first's pending run)
3. Verify extension matches the subfolder's accepted types
4. Content-hash dedup (sha256 vs `attachments` table)
5. Read file, base64-encode
6. Call `attachment.upload` handler directly (in-process function call)
7. Pass `Idempotency-Key: feed-<sha256>` for dedup
8. **Remove the file from the watched folder** on a successful upload (§12.1) — the attachments-store copy is now the durable one, leaving the source behind only causes it to be re-swept and re-examined on every future boot. Left in place on a failed upload so the next scan retries it.
9. Log result

### Startup scan

On boot, a one-time `readdir` sweep of all folders — catches files dropped while the server was down (`fs.watch` only sees events after it starts). This is the same scan used for the polling fallback.

### Polling fallback

If `fs.watch()` fails on a folder (NFS, unsupported filesystem, or environments without inotify), the watcher falls back to `setInterval(readdir, 30000)` for those folders. The fallback interval is configurable via `feed_watcher_interval_ms` (install-level setting).

### Dedup strategy

Content hash (sha256) checked against `attachments.sha256` for the company. A re-dropped file is a no-op — the existing attachment is reused. Same as the B5 script's `Idempotency-Key: feed-<sha256>` approach, but via direct DB check instead of idempotency-key retry.

This is the *only* safety net against reprocessing, which is exactly why leaving the source file in the watched folder forever (fixed §12.1) was a real gap rather than a cosmetic one: dedup only catches a re-drop whose bytes are byte-identical to something already uploaded. A file that looks the same to a person — same name, same logical statement — but differs by even one byte (a re-export, a re-save with different embedded metadata) sails past it and creates a new attachment row every time a boot re-sweeps the folder.

## 3. In-process agent loop (`api/src/agent-loop.js`)

### What moves inside

The B7 script (`scripts/freebooks-agent-loop.js`, 794 lines) was ported into a server module. The pipeline logic stayed — event polling, bank statement parsing, cascade routing, tier-4 LLM, journal.propose, bill.create, input_rejection. What changed was the I/O boundary. The legacy script has since been deleted (issue #108) because its bill extraction and tier-4 LLM were placeholder-only and the in-process loop is the sole path:

| B7 (external script) | B9 (in-process module) |
|---|---|
| `fetch('http://127.0.0.1:3000/api', { ... })` | Direct handler call: `dispatchAction('bank.match', params, agentContext)` |
| `callApi('journal.propose', { ... })` | `dispatchAction('journal.propose', params, agentContext)` |
| Env var config | `settings` table, read at poll time |
| Single company (`FREEBOOKS_COMPANY`) | Iterates all companies with `agent_enabled = 'true'` |
| External process lifecycle (systemd) | Server lifecycle (starts/stops with Express) |

### Agent context

The in-process loop constructs an agent actor context per company, same as the MCP server does:

```js
const agentContext = {
  actor_type: 'agent',
  email: 'agent@freebooks.local',  // the agent account for this company
  company_id: company.company_id,
  role: 'agent',
};
```

Every `dispatchAction` call passes this context. The existing role checks (AGENT_ALLOWED whitelist, §2.3 default-deny) apply identically — the agent module is just another caller of the same dispatch function. No new auth surface.

### Per-company iteration

```js
setInterval(async () => {
  const enabledCompanies = await query(
    `SELECT c.company_id, c.company_name
     FROM companies c
     JOIN settings s ON s.company_id = c.company_id
     WHERE s.key = 'agent_enabled' AND s.value = 'true'`,
  );
  for (const company of enabledCompanies) {
    await processCompanyEvents(company);
  }
}, pollInterval);
```

Each company is processed sequentially in the same tick. The poll interval is read from `agent_poll_interval_ms` (default 30s). One interval serves all companies — no per-company timers.

### Tier-4 LLM call

The `tier4LLMReason()` function replaces the placeholder with a real HTTP call to the configured endpoint:

```js
async function tier4LLMReason(residualLines, context, companySettings) {
  const url = companySettings.llm_endpoint_url;
  if (!url) {
    warn('tier4: no llm_endpoint_url configured — residual lines skipped');
    return [];
  }

  const systemPrompt = buildTier4Prompt(context);
  const userPrompt = JSON.stringify(residualLines);

  const response = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(companySettings.llm_api_key
        ? { 'Authorization': `Bearer ${companySettings.llm_api_key}` }
        : {}),
    },
    body: JSON.stringify({
      model: companySettings.llm_model || 'default',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: parseFloat(companySettings.llm_temperature || '0.1'),
      response_format: { type: 'json_object' },
    }),
  });

  const data = await response.json();
  // Parse choices[0].message.content as JSON, validate count-in == count-out
  return validateTier4Response(data, residualLines.length);
}
```

### What stays from B7

The following functions ported directly from `scripts/freebooks-agent-loop.js` to `api/src/agent-loop.js` with minimal changes (just replacing `callApi` with `dispatchAction`). The legacy script has since been deleted (issue #108) — the in-process module is the sole implementation:

- `parseBankStatementCsv()` — CSV parser
- `parseCsvRows()` — row parser
- `parseAmount()` — Swedish number parsing
- `checkCriticalData()` — §11.3 critical-data validation
- `resolveColumns()` — CSV header detection
- `processBankStatement()` — cascade orchestration (per-line)
- `processBill()` — bill extraction → bill.create
- `buildTier4Context()` — assembles chart of accounts + business profile + matching history
- `extractBillData()` — placeholder bill extraction (stays as placeholder)

### Boot lifecycle

```js
// In server.js, after schema and routes are ready:
// Feed watcher + agent loop both start when any company has agent_enabled = 'true'.
if (anyAgentEnabled) {
  startFeedWatcher();
  startAgentLoop();
}
```

On shutdown (SIGINT/SIGTERM): the interval is cleared, any in-flight `processCompanyEvents` call finishes, then the server exits. The event_seq cursor is persisted to the `settings` table (`agent_last_seq` key per company) so the next boot resumes without replay.

## 4. Settings/AI tab

### New tab in settings page

The settings page (`api/src/pages/settings.js`) currently has tabs: `company`, `coa`, `vat`, `journals`, `fxrates`, `opening-balances`. Add `ai` as a new tab:

```
Company | Chart of Accounts | VAT | Journals | FX Rates | AI | Opening Balances
```

Tab order: AI sits before Opening Balances (it's a configuration section, not a data-entry section).

### Tab content

Two sections:

**4.1 Agent pipeline**

| Field | Input type | Setting key | Notes |
|---|---|---|---|
| Enable agent pipeline | Toggle (on/off) | `agent_enabled` | Master switch |
| Poll interval (ms) | Number input | `agent_poll_interval_ms` | Default 30000 |
| Inbox path | Text input | `agent_inbox_path` | Default `~/freebooks-inbox` |
| Agent status | Read-only | (computed) | Shows "Running" / "Stopped" + last poll time |

Status is computed server-side (is the interval active? when did it last fire?), not stored.

**4.2 LLM provider**

| Field | Input type | Setting key | Notes |
|---|---|---|---|
| Endpoint URL | Text input | `llm_endpoint_url` | e.g. `http://127.0.0.1:8080` or `https://api.openai.com` |
| API key | Password input | `llm_api_key` | Optional (empty for local). Stored as plaintext in settings table — same security boundary as `fx_provider_api_key` |
| Model | Text input | `llm_model` | e.g. `qwen2.5-7b-instruct`, `gpt-4o-mini` |
| Temperature | Number input | `llm_temperature` | Default 0.1 |
| Test connection | Button | (action) | Sends a minimal test request, shows success/failure |

### Test connection action

New API action `settings.ai.test` (role `data_entry`, not agent-whitelisted):

```
POST /api
{ action: "settings.ai.test", companyId, userEmail,
  endpoint_url, api_key, model }
```

Sends a minimal prompt (`"Respond with: ok"`) to the configured endpoint and returns `{ ok: true, latency_ms }` or `{ ok: false, error: "..." }`. Does not save settings — it tests the provided values.

### Install-level settings

> Consolidated into `agent_enabled` — the feed watcher starts automatically when any company has `agent_enabled = 'true'`. No separate install-level toggle. The poll interval (`feed_watcher_interval_ms`) remains if you need to tune it (default 5s), also at `company_id = '__install__'`.

### No provider dropdown

The settings page does not present a dropdown of providers (OpenAI, Modal, RunPod, local). The user enters a URL, a key, and a model name. The endpoint speaks the OpenAI-compatible API — freebooks doesn't know or care which provider is behind it.

### API key storage

The `llm_api_key` is stored in the `settings` table as plaintext, same as `fx_provider_api_key`. This is the same security boundary: a local single-user app where the DB file is on the same host as the API. If multi-tenant cloud deployment arrives, this becomes a secret-management problem to solve then — not now.

## 5. Cursor persistence

The B7 script persisted the event_seq cursor to a file (`FREEBOOKS_CURSOR_FILE`). In-process, the cursor lives in the `settings` table:

| Key | Company scope | Value |
|---|---|---|
| `agent_last_seq` | per-company | Last processed `event_seq` |

On boot, the agent loop reads `agent_last_seq` for each enabled company and starts polling from that point. On each successful poll cycle, it updates the value. On crash/restart, it resumes from the last persisted seq — no replay, no skipped events.

This replaces the file-based cursor. No filesystem state outside the DB.

## 6. MCP — unchanged

MCP is not modified by this spec. The MCP server (`mcp/server.js`) remains the interface for external agents (Hermes, cloud LLMs). It exposes the same whitelisted tools (`event_list`, `journal_propose`, `attachment_upload`, `freebooks_read`, `bill_create`, etc.) over stdio, same as before.

The in-process agent loop and MCP serve different use cases:

| Path | What it does | Transport | Needs MCP? |
|---|---|---|---|
| **In-process agent loop** (B9) | Background pipeline: file → cascade → proposal → inbox | Direct function calls | No |
| **MCP** (existing) | Interactive external agent: Hermes queries books, proposes ad-hoc | MCP protocol over stdio | Yes |

Both can run simultaneously. The MCP server is started by the external agent (Hermes spawns it), independent of whether the in-process loop is enabled.

## 7. External scripts — feed-watch retained, agent-loop deleted

| Script | Status after B9 |
|---|---|
| `scripts/freebooks-feed-watch.sh` | **Retained as fallback.** Kept in the repo. Operators who prefer the external watcher (e.g. running on a separate machine) can still use it. The bug in line 44 (`local` outside function) is fixed. |
| `scripts/freebooks-agent-loop.js` | **Deleted (issue #108).** The legacy script had placeholder-only bill extraction and tier-4 LLM implementations that were never completed. The in-process `api/src/agent-loop.js` is the sole agent path — if it fails, the legacy script would fail too (same dependencies, same LLM config). Keeping it created a false sense of fallback capability. |

The in-process modules (`api/src/feed-watcher.js`, `api/src/agent-loop.js`) are the sole agent path. `freebooks-feed-watch.sh` remains as a fallback folder watcher only.

## 8. Files changed

| File | Change |
|---|---|
| `api/src/feed-watcher.js` | **New.** In-process folder watcher module. |
| `api/src/agent-loop.js` | **New.** In-process agent loop module. Ported from `scripts/freebooks-agent-loop.js`. |
| `api/src/pages/settings.js` | **Modified.** Add `ai` tab with agent pipeline + LLM provider fields. |
| `api/src/index.js` | **Modified.** Add `settings.ai.test` action handler. Add boot calls to start feed watcher + agent loop. |
| `api/src/server.js` | **Modified.** Wire feed-watcher + agent-loop start on boot. |
| `scripts/freebooks-feed-watch.sh` | **Fixed.** Line 44 `local` bug. Otherwise unchanged. |
| `scripts/freebooks-agent-loop.js` | **Deleted (issue #108).** Placeholder bill extraction and tier-4 LLM never implemented; in-process loop is sole path. |
| `db/schema.sql` | **No changes.** No new tables — all config goes in existing `settings` table. |
| `api/src/nav-registry.js` | **No changes.** No new sidebar items. Settings tab already exists. |

## 9. Sequencing

One PR, four commits:

1. `feed-watcher.js` + `agent-loop.js` (new modules)
2. Settings/AI tab (settings page + `settings.ai.test` action)
3. Boot wiring (server.js + index.js)
4. External script bug fix (feed-watch.sh line 44)

No dependencies on other PRs. Can merge independently of PR #87/#88 (Phase B specs/code).

## 10. What this spec does NOT do

- **No chat interface.** Per direction (2026-08-06): "forget the chat function."
- **No provider dropdown.** The Settings/AI tab has three text fields (URL, key, model). No hardcoded provider list.
- **No instance lifecycle management.** Starting/stopping a RunPod VPS on demand is operator infrastructure, not part of freebooks. The agent loop calls the configured endpoint URL — if it's down, lines stay unmatched and surface in the inbox.
- **No new schema tables.** All config uses the existing `settings` key-value table.
- **No changes to MCP.** The MCP server, tool manifest, and external-agent scenarios are unchanged.
- **No multi-tenant auth.** Multi-company folder routing is addressed. User authentication, per-tenant isolation enforcement, and access control are not — that's a separate spec if/when needed.

## 11. Resolved decisions

1. **Agent account per company** — keep current flow. Operator creates the agent account manually via admin SQL (agent-setup-guide §2). The Settings/AI tab shows a warning if `agent_enabled = 'true'` but no agent-role account exists for the company. No auto-provisioning.

2. **Concurrency** — sequential. One company at a time per poll tick. No parallelism cap, no worker pool. Correct for the volume (small ABs, tens of lines/month). Complexity not justified.

## 12. Update 2026-08-29 — ingestion lifecycle fixes + Inbox upload

### 12.1 Two bugs found investigating a duplicate-attachment report

A user saw the same bank-statement filename appear three times under three different attachment ids. Investigation (`api/src/feed-watcher.js`) found two independent, compounding bugs, both now fixed:

- **`processFile()` never removed a file from the watched folder after successfully uploading it.** Every server boot re-runs a full startup sweep of every watched folder ("`fs.watch` only sees events after it starts" — §2's own note on why the sweep exists), so a file that's already been ingested keeps being re-examined forever, relying entirely on sha256 dedup (§2, "Dedup strategy") to stay a no-op. Any drop whose bytes differ even slightly between occurrences — a bank export re-run, a re-save — bypasses that dedup silently and produces a new attachment row each time. Fixed: the source file is deleted after a successful upload (the attachments-store copy is the durable one) and left in place on a failed upload, so the next scan retries it.
- **The debounce timer in `watchCompanySubfolder()` was stored once per watcher (per company + subfolder), not per filename.** Dropping a second, different file within the 300ms debounce window of a first cleared the first file's pending timer and replaced it with the second's — the first file was silently never processed at all, not merely delayed. Fixed: debounce timers are now keyed per filename (`Map<filename, timer>`).

Both verified directly against an isolated throwaway folder + DB, not just read from the diff.

### 12.2 New: upload feature in Inbox

Until now the only way to feed the agent's extraction/matching pipeline was the filesystem folder-drop this section describes — no in-app equivalent existed. Investigating it surfaced that the pipeline was already upload-source-agnostic and didn't need one built: `agent-loop.js`'s main loop polls `event.list` for `attachment.uploaded` events (§3) and dispatches on the event payload's `entityType`, and that event fires from exactly one place — `storeAttachment()` in `attachments.js` — for every caller alike, whether that's `processFile()`'s `_uploadFn`, the bill-detail "Upload PDF" button, or the generic `attachment.upload` action. Nothing about that dispatch path is feed-watcher-specific.

So the Inbox page (`api/src/pages/inbox.js`) now has a "+ Upload document" control — a type picker (Bank Statement / Bill / Receipt, matching §1's `bank`/`bills`/`receipts`+`journal` subfolder → entityType mapping) plus a file input, calling the existing `attachment.upload` action with a client-generated id. No new backend action, no filesystem write, no change to §2 or §3 — this is a second front door into the identical pipeline the folder-drop already feeds, not a second pipeline. The uploaded file doesn't itself become a reviewable Inbox row; that happens once the agent has turned it into a proposal, draft, or rejection, exactly as it does for a folder-dropped file today.
