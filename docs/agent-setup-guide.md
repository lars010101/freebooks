# Secure agentic MCP — operator setup guide

How to connect an AI agent to freebooks safely. Read the security model first —
it is short, and it is the reason every scenario below is safe by construction.

Spec references: `docs/agent-readiness-spec.md` (§2.5 tokens, §2.3 default-deny,
§5 MCP) · `docs/review-roadmap.md` §0w.

---

## 0. The security model in one minute

| What the agent CAN do | What the agent can NEVER do |
|---|---|
| Read anything a `viewer` can (journals, balances, reports, proposals, events) | Post, approve, reject, void, or reverse anything |
| `journal.propose` — put a *proposal* in your review queue | Touch the ledger (`journal_entries`) — only a human approve writes there |
| `attachment.upload` — deliver source documents (underlag) | Manage API tokens, permissions, settings, master data |

Enforcement is server-side and **default-deny**: any mutating action added in
the future is automatically forbidden to agents unless explicitly whitelisted.
Every call is audit-stamped (`actor_type`, `request_id`). Even a fully
compromised or confused agent can only *prepare* work for your review — the
human approve in the journal queue is the only door to the ledger.

Your job as operator is therefore narrow:

1. **Authenticate the agent** when it is not on the same machine (API tokens).
2. **Protect the network path** between agent and API (loopback / SSH / VPN).
3. **Keep the token out of places it shouldn't be** (dotfiles with 600 perms,
   never in chat messages, never in cloud LLM prompts).

---

## 1. Prerequisites (all scenarios)

On the freebooks host:

```bash
node --version          # >= 20 required
cd /path/to/freebooks
npm install --prefix api
npm install --prefix mcp   # the MCP server is its OWN npm package — forgetting
                           # this is the #1 setup failure (MODULE_NOT_FOUND)
node api/src/index.js      # boots on http://127.0.0.1:3000 (loopback only)
```

On the Hermes host (scenarios 1–2):

```bash
pip install mcp            # Hermes MCP client SDK — silently disabled without it
```

## 2. Step 0 for every scenario: create the agent account

The agent needs a dedicated email with the **`agent` role** on your company.
Grant it once, on the API host, via the admin SQL endpoint (requires
`FREEBOOKS_ADMIN_TOKEN` set on the API process — see README):

```bash
curl -X POST http://127.0.0.1:3000/api/admin/query \
  -H "Authorization: Bearer $FREEBOOKS_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"sql":"INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by) VALUES ('"'"'agent@example.com'"'"', '"'"'mycompany'"'"', '"'"'agent'"'"', now(), '"'"'you@example.com'"'"')"}'
```

⚠ **Grant BEFORE the agent's first call.** Permission denials are cached for
60s — if the agent already called and was denied, restart the API (or wait a
minute) after granting.

Convention used below: agent account `agent@example.com`, company `mycompany`.
Substitute your own.

---

## 3. Scenario 1 — freebooks + MCP + Hermes on the same Linux server

Everything on one box. The API listens on loopback only, so **no token and no
`FREEBOOKS_AUTH_MODE` are needed** — the default `trust` mode is the designed
posture here. (If the machine is multi-user and you don't trust every local
user, that is a different threat model — use scenario 2's token setup even on
one host.)

Add to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  freebooks:
    command: "node"
    args: ["/absolute/path/to/freebooks/mcp/server.js"]
    env:
      FREEBOOKS_API_URL: "http://127.0.0.1:3000"
      FREEBOOKS_USER: "agent@example.com"
      FREEBOOKS_COMPANY: "mycompany"
```

Hermes passes only whitelisted env vars to subprocesses — the `env:` block is
mandatory, exporting variables in your shell is not enough.

Restart Hermes. Verify:

1. Hermes startup logs show the freebooks server connected; tools appear as
   `mcp_freebooks_event_list`, `mcp_freebooks_journal_propose`,
   `mcp_freebooks_attachment_upload`, `mcp_freebooks_freebooks_read`.
2. Ask the agent: "list freebooks events" — you should get JSON (empty is fine).
3. API stderr shows one line per MCP session:
   `[freebooks-mcp] ready — api=… company=… user=… request_id=…`

---

## 4. Scenario 2 — freebooks + MCP on server 1, Hermes on server 2 (VPS)

The API binds loopback by default, which forces a deliberate choice of
transport. Pick **one**:

### 4a. SSH tunnel (simplest, strongest — recommended for ad-hoc use)

No freebooks config change at all. On server 2:

```bash
# persistent tunnel (autossh recommended for daemons)
autossh -M 0 -N -L 3000:127.0.0.1:3000 user@server1
```

Then configure Hermes exactly as scenario 1 (`FREEBOOKS_API_URL:
http://127.0.0.1:3000`). SSH provides authentication and encryption; traffic
arrives at the API as loopback, so no token is required. This is the
zero-surface option: the API port is never visible to any network.

### 4b. Tailscale/WireGuard + API token (recommended for a permanent two-server setup)

On server 1:

```bash
FREEBOOKS_BIND=100.x.y.z \
FREEBOOKS_AUTH_MODE=token-remote \
node api/src/index.js
```

- `FREEBOOKS_BIND` (default `127.0.0.1`) — the *Tailscale interface IP* of
  server 1. Never a public IP.
- `token-remote` — every non-loopback client must present a valid Bearer token
  (401 otherwise). Loopback clients (your local browser, SSH tunnels) are
  unaffected.

Mint the agent's token **once**, on server 1 (loopback, so no chicken-and-egg):

```bash
curl -X POST http://127.0.0.1:3000/api -H 'Content-Type: application/json' \
  -d '{"action":"auth.token.create","companyId":"mycompany","userEmail":"you@example.com","email":"agent@example.com","label":"hermes-vps"}'
# → data.token  (fbt_…  — shown ONCE; only the sha256 is stored)
```

Hermes config on server 2:

```yaml
mcp_servers:
  freebooks:
    command: "node"
    args: ["/absolute/path/to/freebooks/mcp/server.js"]
    env:
      FREEBOOKS_API_URL: "http://100.x.y.z:3000"
      FREEBOOKS_USER: "agent@example.com"
      FREEBOOKS_COMPANY: "mycompany"
      FREEBOOKS_API_TOKEN: "fbt_…"
```

Verify from server 2 **before** starting Hermes:

```bash
curl -X POST http://100.x.y.z:3000/api -H 'Content-Type: application/json' \
  -d '{"action":"event.list","companyId":"mycompany","userEmail":"agent@example.com"}'
# → 401 UNAUTHENTICATED (no token — remote callers are denied)

curl -X POST http://100.x.y.z:3000/api -H 'Content-Type: application/json' \
  -H "Authorization: Bearer fbt_…" \
  -d '{"action":"event.list","companyId":"mycompany","userEmail":"agent@example.com"}'
# → 200 {"ok":true,"data":[…]}
```

### 4c. TLS reverse proxy on server 1 (only if you need browser access remotely too)

nginx/Caddy listens on the LAN/WAN interface, terminates TLS, proxies to
`127.0.0.1:3000`. **Critical caveat (spec §2.5):** proxied traffic arrives at
the API as loopback, so `token-remote` does NOT fire behind a same-host proxy —
authentication must happen **at the proxy** (TLS client certs, proxy-level
Bearer check, or IP allowlist). Do not rely on freebooks tokens behind a
same-host proxy.

### What NOT to do

- ❌ `FREEBOOKS_BIND=0.0.0.0` on a machine with a public interface, in `trust`
  mode. Anyone who reaches the port can assert any identity, including owner.
  This is the one configuration that is genuinely dangerous.
- ❌ Sending the token over plain HTTP outside a VPN/tunnel (it is a bearer
  credential — TLS or tunnel only).

---

## 5. Scenario 3 — freebooks + MCP on a server, driving a cloud LLM web interface

No Hermes. You paste instructions into claude.ai / ChatGPT / Gemini and use the
LLM's reading ability (invoices, receipts) to prepare bookings. The cloud LLM
must **never** hold your API token or reach your server — instead **you are the
transport**, and freebooks' propose-don't-post design makes this structurally
safe: even if the LLM hallucinates or is prompt-injected by a malicious
invoice, the worst it can produce is a *proposal* that sits in your queue until
you approve it.

Setup: nothing beyond scenario 1's freebooks install. Save this bridge script
on the server as `~/propose-bridge.sh` (`chmod +x`):

```bash
#!/usr/bin/env bash
# Post a cloud-LLM-produced journal proposal to freebooks.
# Input: a file containing ONLY the lines JSON array (from the LLM).
set -euo pipefail
API="${FREEBOOKS_API_URL:-http://127.0.0.1:3000}"
FILE="${1:?usage: propose-bridge.sh lines.json [description]}"
DESC="${2:-LLM-prepared proposal}"
curl -sS -X POST "$API/api" -H 'Content-Type: application/json' \
  ${FREEBOOKS_API_TOKEN:+-H "Authorization: Bearer $FREEBOOKS_API_TOKEN"} \
  -d "$(jq -n --argjson lines "$(cat "$FILE")" \
        --arg co "${FREEBOOKS_COMPANY:?set FREEBOOKS_COMPANY}" \
        --arg user "${FREEBOOKS_USER:?set FREEBOOKS_USER}" \
        --arg desc "$DESC" \
        '{action:"journal.propose", companyId:$co, userEmail:$user, lines:$lines, description:$desc}')"
```

Workflow:

1. **Attach the source document in freebooks first** (UI upload, or the
   drop-folder watcher in the data-feeding guide) so the proposal has underlag.
2. In the LLM chat, upload the invoice/receipt image or paste its text, with
   this prompt:

   > You are preparing a bookkeeping proposal for review. Output ONLY a JSON
   > array of journal lines, no prose. Each line:
   > `{"account_code": "NNNN", "debit": 0, "credit": 0, "date": "YYYY-MM-DD", "description": "…"}`
   > plus optional `"vat_code"` and `"currency"`. Rules: debits must equal
   > credits in total; use the company's chart of accounts I give you; VAT/GST
   > goes on the line's `vat_code`, never as a guessed amount; if unsure of an
   > account, still propose and say so in the description.
   >
   > Chart of accounts: [paste `coa.list` output or the relevant subset]

3. Paste the returned JSON into a file and run
   `FREEBOOKS_COMPANY=mycompany FREEBOOKS_USER=agent@example.com ~/propose-bridge.sh lines.json "Invoice 1234, Office AB"`.
4. Review and approve in freebooks: **/:company/journal** — proposed batches
   pin above posted ones; `y` approves (posts with *you* as poster), `x`
   rejects. The underlag badge shows whether source documents are attached;
   unfold the row to preview them.

Note: a direct connection (cloud LLM → your MCP server over HTTPS) requires an
HTTP transport for the MCP server, which freebooks does not ship yet. The
paste-bridge is the supported pattern today — and its human-in-the-loop
property is a feature, not a limitation, for financial data.

---

## 6. Token lifecycle

| Task | How |
|---|---|
| Mint | `auth.token.create` (owner) — token shown **once** |
| List (no hashes, ever) | `auth.token.list` |
| Revoke | `auth.token.revoke` `{tokenId}` — idempotent |
| Rotate | mint new → update the agent's env → revoke old |
| Storage | env var in `~/.hermes/config.yaml` (chmod 600), never in shell history, chat, or LLM prompts |

Role changes to the bound email take effect within 60s (permission cache);
revoking a token is immediate.

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Cannot find module …` when MCP starts | `npm install --prefix mcp` was not run (separate package) |
| 401 `UNAUTHENTICATED` from a remote host | `token-remote` is on and the token is missing/invalid/revoked — re-check §4b |
| 403 `FORBIDDEN` right after granting the role | 60s permission cache — restart the API or wait |
| Agent gets 403 on everything mutating | By design — agents only propose/upload; approval is yours |
| Agent calls succeed as the wrong user | A Bearer token overrides body `userEmail` — check which token is in env (`auth.token.list`) |
| `Conflicting lock` on the DuckDB file | Two API processes on one DB file — kill the stale one (`ss -tlnp \| grep 3000`) |
| Browser UI broken after enabling `token-remote` | You're browsing from another machine — browse via the API host, an SSH tunnel, or §4c with proxy-level auth |

Next: **`docs/agent-data-feeding-guide.md`** — how to get documents, statements,
and events flowing so the agent has work to do.
