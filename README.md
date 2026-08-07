# freeBooks

Open-source, self-hosted double-entry accounting for small companies. Your data stays on your machine in a single DuckDB file — no cloud dependency, no subscription.

**Stack:** Node.js · Express · DuckDB (`@duckdb/node-api`)
**License:** AGPL-3.0
**Repo:** https://github.com/lars010101/freebooks

---

## Key Features

- **Full double-entry bookkeeping** — journal batches, account autocomplete, reversal workflow, auto-generated references (`CODE/YYYY/NNNNN`, e.g. `MISC/2026/00001`, `AP/2026/00003`)
- **Financial statements** — Profit & Loss, Balance Sheet, Cash Flow (indirect, IAS 7), Statement of Changes in Equity. Year-end net income closes to retained earnings via a manual closing journal entry (automated close is P2-1, not yet shipped); the balance sheet injects an unallocated-net-income row live until the close is posted.
- **Audit & listing reports** — Trial Balance, General Ledger, Journal, Integrity Check (with RE roll-forward)
- **Multi-period comparative reports** — month-over-month and year-over-year for P&L, BS, and CF, driven by company-defined fiscal periods
- **Multi-currency (IAS 21)** — transaction-currency and home-currency columns on every journal line; FX gain/loss on settlement computed via the booking-rate method; period-end FX revaluation (preview + post)
- **VAT / GST engine** — tax-exclusive entry, reverse-charge support, supplier-stated VAT override with configurable tolerance, and VAT return generation grouped by report box
- **Accounts Payable** — vendor master with defaults, multi-line bill entry (auto-generates DR Expense / CR AP journal), draft bills, void with auto-reversal, payment matching, and AP Aging report
- **Accounts Receivable** — invoicing and AR aging are **dropped/deferred** from the current cycle; nav and page scaffolding remain in place but inactive.
- **Bank statement processing** — CSV import with manual bill allocation linking import rows to open bills (multi-currency aware) and cleared/uncleared reconciliation tracking, backed by a **four-tier matching cascade** (spec: `docs/bank-matching-spec.md`):
  - **Tier 1** — learned rules (`bank_mappings`): pattern → offset account/VAT code, with `amount_sign` direction filtering and longest-match-wins specificity scoring.
  - **Tier 2** — open-item matching against unpaid bills and vendor balances (amount-tolerance, 1:1/1:N/N:1 cardinality, counterparty evidence).
  - **Tier 3** — trigram master-data match against chart of accounts and vendors.
  - **Tier 3.5** — historical outcome match against `matching_history` (`approved_unedited` outcomes) — "how was this same description posted last time?"
  - **Tier 4** — LLM reasoning for residual unmatched lines.
- **Self-contained in-process agent pipeline (B9)** — folder watcher + agent loop run inside the Express server (no external scripts, no HTTP self-calls). Watches `inbox/{company_id}/{type}/`, calls `bank.match` → `journal.propose` → tier-4 LLM directly via `dispatchAction`. Legacy external scripts are retained in `scripts/` as a fallback. See `docs/b9-self-contained-agent-spec.md`.
- **Mapping-suggestions learning loop (PR #90)** — approved/rejected proposals record outcomes in `matching_history`; tier 3.5 consults prior outcomes; unedited tier-4 approvals crystallize into `mapping_suggestions`; a throttled retrospective sweep finds recurring unruled patterns and suggests rules; `detectMappingConflicts` checks duplicate/contradiction/shadowing at suggest and approve time. Spec: `docs/bank-mapping-suggestions-spec.md`.
- **Agent-first operating model (Phase A)** — agents prepare, humans approve (spec: `docs/agent-readiness-spec.md`):
  - **Journal proposals** — agent calls `journal.propose` → human reviews/approves/rejects in the unified Inbox queue (`y`/`x`); approve posts the journal; reject rolls back.
  - **Inbox review queue** — dedicated `g i` Inbox page aggregates all action items (Class A pre-ledger approvals on `journal_proposals`, Class B operational items: bills due, unmatched bank lines, mapping suggestions, input rejections).
  - **Append-only event stream** — `events` table + monotonic `event_seq`; `event.list` is the agent input channel; idempotent replay never double-emits.
  - **A4 underlag/attachment binding** — source documents bind to proposals via the client-minted `proposalId`: `attachment.upload` with `entityType='journal_proposal'` first, then `journal.propose` with the same id. Missing underlag warns, never blocks (BFL 5 kap permits egen verifikation).
- **MCP server** — a stdio Model Context Protocol process exposing the whitelisted agent surface (`event_list`, `journal_propose`, `attachment_upload`, `freebooks_read`, `matching_history_record`, `mapping_suggest`, `bill_create`) over the action catalog. See the MCP server section below.
- **SIE 4 import/export** — `report?type=sie` exports PC8/CP437 SIE 4 (IB/UB/RES/VER, balanced vouchers); `sie.import` accepts SIE types 1–4 with `dryRun` default true. Sweden-exclusive (gated by the SE jurisdiction pack integration declaration).
- **SRU / INK2 export (Skatteverket)** — `GET /api/:company/sru/ink2?year=&loss_cf=` (+`&check=1` dry-run) and `/sru/info` generate the official 2025P4 field spec; a golden test reproduces a filed `blanketter.sru` byte-for-byte. Driven by `filings/ink2.json` descriptors + `emitters/sruLines.js`.
- **K2 årsredovisning composite report** — `report?type=ar` (registry-driven, print-ready HTML + JSON + CSV; SE K2 + SG SFRS descriptors). Frozen as a read-only K2 statement viewer after the SE annual-report scope moved to Gredor (SIE 4 export is the maintained integration contract).
- **Jurisdiction packs architecture** — country packs as data under `db/jurisdictions/<CC>/` (manifest, jurisdiction.json, COA + VAT code templates, `filings/` descriptors, contact attributes, integration declarations). Directory-scanned, pack linter as a CI gate. See `docs/jurisdiction-pack.md`.
- **Per-actor API tokens (Bearer auth)** — `auth.token.create`/`auth.token.revoke` mint one-time tokens (sha256 stored); valid token overrides `userEmail`, invalid/revoked → 401. Required for non-loopback clients under `FREEBOOKS_AUTH_MODE=token-remote` (two-server deployment).
- **Period locking** — locked periods reject all postings; enforced server-side in the validation engine
- **File attachments** — attach PDFs, images, and documents to bills, journals, and proposals; stored on the local filesystem (sha256 dedupe, pdf/jpg/png whitelist, 15 MB cap for proposal underlag)
- **Multi-company** — isolated books per company, each with its own chart of accounts, tax codes, periods, and settings
- **Pluggable FX providers** — ECB and OpenExchangeRates shipped; add a provider by dropping a file into `api/src/fxProviders/`
- **Two-server deployment** — `FREEBOOKS_BIND` selects the listen interface (default `127.0.0.1` loopback-only); set to a LAN/Tailscale IP, always paired with `FREEBOOKS_AUTH_MODE=token-remote`.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 20 |
| HTTP server | Express 4 |
| Database | DuckDB (single embedded file via `@duckdb/node-api`) |
| Report queries | DuckDB SQL macros (`db/macros.sql`) |
| File uploads | Multer |
| Auth | Email + role-based permissions (`user_permissions` table); per-actor Bearer tokens (`api_tokens`, `FREEBOOKS_AUTH_MODE=token-remote`, `auth.token.create`/`revoke`); `agent` role at level 1.5 with a default-deny whitelist |
| Container | Dockerfile (Wolfi/distrobox base) |

All dependencies live in [`api/package.json`](api/package.json): `express`, `@duckdb/node-api`, `cors`, `dotenv`, `multer`, `uuid`.

---

## Getting Started

### From scratch

```bash
git clone https://github.com/lars010101/freebooks ~/freebooks
cd ~/freebooks
npm install --prefix api          # install API dependencies
node db/init.js                   # create ~/.freebooks/freebooks.duckdb + load macros; seeds journals
node db/import.js <data-dir>      # optional: import historical CSV data (COA, journal, mappings)
node api/src/index.js             # start server on http://localhost:3000
```

Open <http://localhost:3000> — the first run redirects to the new-company wizard.

### Updating

```bash
# code only
cd ~/freebooks && git pull && node api/src/index.js

# code + schema/macro changes (stop the server first)
cd ~/freebooks && git pull && node db/init.js && node api/src/index.js
```

> `node db/init.js` must run with the server stopped (DuckDB holds an exclusive file lock). If the server is already running, use `node db/init.js --via-server` to apply migrations through the live connection.

The server handles `SIGINT`/`SIGTERM` gracefully and checkpoints DuckDB before exit to prevent stale WAL files.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `FREEBOOKS_DB_PATH` | Override the database location (default `~/.freebooks/freebooks.duckdb`). Useful for tests and throwaway instances. |
| `FREEBOOKS_ADMIN_TOKEN` | Bearer token for `POST /api/admin/query` (arbitrary SQL). **If unset, the endpoint is disabled (403).** Set it only for local admin/debug use: `FREEBOOKS_ADMIN_TOKEN=$(openssl rand -hex 32) node api/src/index.js`, then send `Authorization: Bearer *** |
| `FREEBOOKS_BIND` | Bind address (default `127.0.0.1` — loopback only). Set to a LAN/Tailscale interface IP for the two-server deployment, always paired with `FREEBOOKS_AUTH_MODE=token-remote`. Never bind a public interface in `trust` mode. |
| `FREEBOOKS_AUTH_MODE` | `trust` (default) keeps install-level self-asserted identity. `token-remote` requires a valid `Authorization: *** API token from every **non-loopback** client — set this when the API is reachable over a network (two-server deployment). Mint/revoke tokens via the `auth.token.create` / `auth.token.revoke` actions (owner role; spec `docs/agent-readiness-spec.md` §2.5). |
| `PORT` | HTTP port (default 3000). |

### MCP server (agent access)

**Operator guides: [`docs/agent-setup-guide.md`](docs/agent-setup-guide.md) (secure setup — same-host, two-server, and cloud-LLM paste-bridge scenarios) · [`docs/agent-data-feeding-guide.md`](docs/agent-data-feeding-guide.md) (getting documents/statements in, event contract, approval loop).**

Agents drive freebooks through the MCP server (spec: `docs/agent-readiness-spec.md` §5) — a stdio Model Context Protocol process exposing the whitelisted agent surface (`event_list`, `journal_propose`, `attachment_upload`, `freebooks_read`, `matching_history_record`, `mapping_suggest`, `bill_create`):

```bash
npm install --prefix mcp
FREEBOOKS_API_URL=http://127.0.0.1:3000 FREEBOOKS_USER=agent@example.com FREEBOOKS_COMPANY=mycompany node mcp/server.js
```

Proposals SHOULD carry their source documents via the §4.7 upload-first binding convention — `attachment_upload` with `entityType='journal_proposal'` + the client-minted `proposalId`, then `journal_propose` with the same id (see `docs/agent-readiness-spec.md` §4.7).

`FREEBOOKS_REQUEST_ID` optionally overrides the per-session correlation id (one MCP session = one `X-Request-Id` run in `audit_log`/`events`). The server talks HTTP to the action API only — never the DB file. The account named by `FREEBOOKS_USER` should hold the `agent` role (reads + proposals only; everything else is default-deny).

**Running the MCP server on a different host than the API:** start the API with `FREEBOOKS_AUTH_MODE=token-remote` (non-loopback clients must authenticate), mint a token for the agent account once on the API host —

```bash
curl -X POST http://127.0.0.1:3000/api -H 'Content-Type: application/json' \
  -d '{"action":"auth.token.create","companyId":"mycompany","userEmail":"owner@example.com","email":"agent@example.com","label":"hermes-agent"}'
# → data.token is shown ONCE; only its sha256 is stored
```

— then add `FREEBOOKS_API_TOKEN=fbt_...` to the MCP server's environment. Revoke with `auth.token.revoke`. Note the loopback semantics: an SSH tunnel (`ssh -L`) presents as loopback on the API host and needs no token; Tailscale/direct binds present as remote and do.

---

## Project Structure

```
freebooks/
├── api/
│   ├── package.json            # dependencies + start/dev scripts
│   ├── public/                 # static assets served at /public
│   │   ├── common.js           # shared page nav/helpers
│   │   ├── fb-core.js          # FB.keys core: scope stack, teardown, resetPage
│   │   ├── fb-list.js          # FB.list shared list/table framework (vim-modal)
│   │   ├── fb-form.js          # FB.form shared form framework (zones, cursor)
│   │   └── fb-attachments.js    # shared attachment helper module
│   └── src/
│       ├── index.js            # Express entry point, action routing, auth gate, action catalog
│       ├── db.js               # DuckDB connection + query/exec/bulkInsert helpers
│       ├── auth.js             # permission checking (user_permissions table)
│       ├── tokens.js           # Bearer API token create/verify/revoke (api_tokens)
│       ├── action-catalog.js   # action → module/role registry (GET /api/actions)
│       ├── agent-loop.js       # B9 in-process agent loop: poll events, bank.match, journal.propose, retrospective sweep
│       ├── feed-watcher.js     # B9 in-process folder watcher (setInterval + readdir)
│       ├── mapping-utils.js    # normalizeDescription, detectMappingConflicts (mapping-suggestions spec)
│       ├── events.js           # append-only events table emission (valid-JSON truncation)
│       ├── journal.js          # journal posting, reversal, search, reference sequencing, proposal approve/reject
│       ├── bills.js            # Accounts Payable: create, void, list, match, drafts, aging
│       ├── vendors.js          # vendor master CRUD
│       ├── bank.js             # bank statement processing, approval, reconciliation, tier 1-3.5 matching
│       ├── vat.js              # VAT/GST split, reverse charge, VAT return
│       ├── fx.js               # FX rate lookup, manual entry, revaluation, provider config
│       ├── fxProviders/        # pluggable rate providers (ecb.js, openexchangerates.js)
│       ├── setup.js            # company creation, COA + VAT template loading
│       ├── validation.js       # period lock + balance + COA + FX rate checks
│       ├── attachments.js      # file upload/download/delete, A4 underlag binding
│       ├── audit.js            # audit log helpers
│       ├── filings.js          # filing descriptors + SRU contact validation/load
│       ├── emitters/           # filing emitters (sruLines.js)
│       ├── jurisdiction-packs.js  # cached jurisdiction-pack loader + integration gating
│       ├── report-registry.js  # report-type registry (pl, bs, cf, …, ar, sie)
│       ├── report-composite.js # K2 årsredovisning composite report (type=ar)
│       ├── nav-registry.js     # sidebar nav registry (g-prefix page navigation)
│       ├── inbox.js            # unified inbox.list aggregator (Class A + Class B items)
│       ├── sie-export.js       # SIE 4 export (PC8/CP437)
│       ├── sie-import.js       # SIE 4 import (types 1-4, dryRun default true)
│       ├── reports.js          # mounts HTML report routes + page modules
│       ├── views.js            # shared view helpers
│       ├── boot-state.js       # startup state / agent-loop boot check
│       ├── settlement.js       # settlement helpers
│       ├── periods-page-service.js  # periods grid page service
│       └── pages/              # one module per UI page (dashboard, bank, payables, settings, inbox, …)
├── mcp/
│   ├── package.json
│   └── server.js               # stdio MCP server over the action catalog
├── db/
│   ├── schema.sql              # table definitions + migrations
│   ├── macros.sql              # DuckDB macros: pl(), bs(), cf(), sce(), tb(), gl(), journal(), integrity()
│   ├── init.js                 # loads schema + macros, seeds default journals (MISC, BANK, ADJ, AP)
│   ├── import.js               # one-time CSV import (COA, journal, mappings)
│   ├── currencies.json         # ISO 4217 currency codes (autocomplete datalist)
│   └── jurisdictions/          # jurisdiction packs (per pack: jurisdiction.json, coa.json, vat_codes.json, filings/ descriptors, contact attrs, integration declarations)
│       ├── SE/                 # Sweden — K2/K3, BAS, SIE + SRU integrations, ink2/annual-report/vat-return filings
│       ├── SG/                 # Singapore — SFRS, SFRS-SE
│       └── _template/          # starting point for adding new jurisdictions
├── scripts/                    # demoted fallback scripts (B9 in-process loop is primary)
│   ├── freebooks-feed-watch.sh # fallback folder watcher (inotifywait)
│   └── freebooks-agent-loop.js # fallback agent loop (HTTP self-call)
├── reports/
│   ├── render.js               # shared report HTML rendering (P&L, BS, CF, SCE, TB, GL, …)
│   ├── generate.js             # CLI report generator
│   └── sources/                # report source data
├── docs/                       # specs + guides (see below)
│   ├── agent-readiness-spec.md
│   ├── agent-setup-guide.md
│   ├── agent-data-feeding-guide.md
│   ├── bank-matching-spec.md
│   ├── bank-mapping-suggestions-spec.md
│   ├── b9-self-contained-agent-spec.md
│   ├── keyboard-ux-spec.md
│   ├── fb-list-ux-spec.md
│   ├── reports-dashboard-spec.md
│   ├── jurisdiction-pack.md
│   ├── fx-automation-spec.md
│   ├── ia-spec.md
│   ├── settings-ux-spec.md
│   ├── payables-ux-spec.md
│   └── UI.md
├── .github/workflows/build.yml # CI
└── Dockerfile                  # container image (Wolfi/distrobox)
```

---

## Database Overview

All data lives in a single DuckDB file (default `~/.freebooks/freebooks.duckdb`). Tables are defined in [`db/schema.sql`](db/schema.sql); every table is partitioned by `company_id` for multi-company isolation.

| Table | Purpose |
|---|---|
| `companies` | Company master: name, jurisdiction, currency, reporting standard, fiscal year |
| `accounts` | Chart of accounts: code, name, type, subtype, cash-flow category, effective dates |
| `journal_entries` | All posted journal lines (debit/credit + `*_home` home-currency columns, FX rate, VAT, bill link) |
| `journals` | Journal types per company (MISC, BANK, ADJ, AP, …) |
| `journal_sequences` | Per-journal, per-year auto-incrementing reference counters |
| `journal_proposals` | Agent-proposed journals awaiting human review (`proposed`/`approved`/`rejected`); carries `_match_meta` JSON |
| `bills` | Accounts Payable bills (vendor, amounts, currency, FX rate, status, `amount_paid`) |
| `bill_payments` | Payment allocations linking bills to settlement journal batches |
| `vendors` | Vendor master with default currency, payment terms, and default expense/AP accounts |
| `vat_codes` | VAT/GST codes: rate, input/output accounts, report box, reverse-charge flag |
| `bank_mappings` | Rule-based bank import matching (pattern → offset account, VAT code), with `amount_sign` direction column |
| `mapping_suggestions` | Agent-suggested mapping rules pending human approval (with conflict detection) |
| `matching_history` | Per-line matching outcomes (approved_unedited / approved_edited / rejected) — tier 3.5 historical input |
| `input_rejections` | Bank-import lines rejected for missing critical data (inbox Class B) |
| `reconciliations` | Cleared-status tracking per batch/account for bank reconciliation |
| `fx_rates` | Exchange rates (date, pair, rate, source) — manual or provider-fetched |
| `periods` | Fiscal periods with `locked` boolean + `tax_attrs` JSON (e.g. `loss_cf`, `audited`, `consultant`) |
| `settings` | Key/value company settings (FX provider, VAT tolerance, default accounts, AI endpoint, agent_enabled, …) |
| `user_permissions` | Email → company → role grants |
| `api_tokens` | Bearer API tokens (bound email, label, sha256 hash, shown once) |
| `idempotency_keys` | Per-company idempotency-key store for safe agent retries (company-scoped) |
| `centers` | Cost/profit centers |
| `attachments` | File attachment metadata (entity type/id, filename, storage path, sha256) |
| `events` | Append-only business-event stream (monotonic `event_seq`) — the agent input channel |
| `audit_log` | Field-level change history (gains `actor_type` + `request_id`) |

Schema also defines reporting views (`v_trial_balance`, `v_pl`, `v_bs`, `v_gl`) and migrations are appended inline to `schema.sql` and applied on every `node db/init.js` run.

---

## API Overview

freeBooks uses a single **action-based API**. All mutations and reads go through one endpoint:

```
POST /api/action        (also POST /api)
Body: { "action": "<module>.<verb>", "companyId": "...", "userEmail": "...", ... }
Response: { "ok": true, "data": ... }   (or { "error": "..." })
```

The `action` string is split on `.` to dispatch to a module handler (`journal.*`, `bill.*`, `bank.*`, `vat.*`, `fx.*`, `coa.*`, `vendor.*`, `mapping.*`, `period.*`, `settings.*`, `company.*`, `journals.*`, `center.*`, `permissions.*`, `attachment.*`, `setup.*`, `diag.*`, `report.*`, `sie.*`, `auth.*`, `event.*`, `inbox.*`, `matching_history.*`, `calibration.*`).

The full action catalog (action → module → min role) is introspectable at `GET /api/actions`. Mutating actions accept an `Idempotency-Key` (per-company scoped) for safe agent retries. Errors use a single envelope `{ "error": "..." }`.

### Permission levels

Every action maps to a required role in `ACTION_ROLES` (`api/src/index.js`). When `userEmail` is present, the `user_permissions` table is checked before dispatch. A valid Bearer token overrides `userEmail`.

| Role | Can do |
|---|---|
| `viewer` | Read/list actions (reports, lists, lookups) |
| `data_entry` | Post entries, create/void bills, process bank, save FX rates, save mappings, approve/reject mapping suggestions |
| `owner` | Manage company, COA, VAT codes, journals, periods, vendors, settings, FX provider, permissions, auth tokens |
| `agent` (level 1.5) | Default-deny whitelist — reads + `journal.propose` + `bill.create` (draft) + `attachment.upload` + `mapping.suggest` + `matching_history.record`. Everything else is denied. |

A few representative actions:

| Action | Min. role |
|---|---|
| `journal.post`, `journal.reverse` | `data_entry` |
| `journal.propose`, `bank.match` | `agent` |
| `bill.create` (draft) | `agent` |
| `bill.void`, `bill.draft.*` | `data_entry` |
| `bank.process`, `bank.approve` | `data_entry` |
| `attachment.upload` | `agent` |
| `mapping.suggest`, `matching_history.record` | `agent` |
| `auth.token.create`, `auth.token.revoke` | `owner` |
| `fx.rates.save`, `fx.fetch_rates` | `data_entry` |
| `coa.save`, `coa.upsert`, `vat.codes.save` | `owner` |
| `period.save`, `company.save`, `settings.save` | `owner` |
| `setup.add_company`, `permissions.save` | `owner` |
| `*.list`, `journal.search`, `bill.match`, `settings.get`, `event.list` | `viewer` |

The agent-callable surface (`AGENT_ALLOWED`, the default-deny whitelist) covers: `event.list`, `journal.propose`, `bank.match`, `mapping.suggest`, `matching_history.record`, `bill.create`, `attachment.upload`, plus the read actions. The MCP server exposes the same set as tools.

HTML report pages are served via `GET` routes (`/`, `/:company`, `/:company/reports`, `GET /api/:company/report?type=<type>&start=…&end=…`). File uploads use `POST /api/upload` (multipart) and `GET /api/attachments/:id`.

---

## Reports

All report types render through `reports/render.js` (or `report-composite.js` for `ar`/`sie`) and are available in the Reports hub (`/:company/reports`) or via the report endpoint:

| `type=` | Report | Multiperiod |
|---|---|---|
| `pl` | Profit & Loss | MoM + YoY |
| `bs` | Balance Sheet | MoM + YoY |
| `cf` | Cash Flow (indirect, IAS 7) | MoM + YoY |
| `sce` | Statement of Changes in Equity | — |
| `tb` | Trial Balance | — |
| `gl` | General Ledger | — |
| `journal` | Journal listing | — |
| `integrity` | Integrity checks + RE roll-forward | — |
| `ap-aging` | AP Aging (as-of end date) | — |
| `ar` | K2 annual report composite (resultaträkning + balansräkning + noter; registry-driven, SE K2 / SG SFRS) | — |
| `sie` | SIE 4 export (PC8/CP437, IB/UB/RES/VER) — SE-only | — |

MoM/YoY apply only to `pl`, `bs`, and `cf`. YoY uses the company's defined fiscal periods. Report logic lives in DuckDB macros (`db/macros.sql`) — changes require re-running `node db/init.js` to reload them.

**SRU / INK2 export (Skatteverket)** is served by dedicated endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /api/:company/sru/ink2?year=&loss_cf=` | Generate INK2 blanketter (`blanketter.sru`); `&check=1` is a dry-run with warnings |
| `GET /api/:company/sru/info` | Generate INFO.SRU (`#IDENTITET`/`#MEDIELEV`/`#KONTAKT`); gated on required contact attributes |

Driven by `db/jurisdictions/<CC>/filings/ink2.json` descriptors + `api/src/emitters/sruLines.js`. Sweden-only (gated by the jurisdiction pack).

---

## Supported Jurisdictions

New companies load a jurisdiction pack from `db/jurisdictions/<code>/`. A `_template/` directory is provided as a starting point for adding new jurisdictions.

| Code | Country | Currency | Reporting standards | VAT name | Tax authority | COA standard |
|---|---|---|---|---|---|---|
| `SG` | Singapore | SGD | SFRS, SFRS-SE | GST | IRAS | SFRS |
| `SE` | Sweden | SEK | K2, K3 | Moms | Skatteverket | BAS |

Each jurisdiction directory contains:

- `jurisdiction.json` — pack metadata: reporting standards, tax-id format, per-year `taxAttributes` (e.g. `loss_cf`, `audited`, `consultant`), `contactAttributes` (address, postnr, postort, contact), `integrations` declarations (e.g. SE declares `sie.export`/`sie.import`), and the `closeChecklist`.
- `coa.json` — chart of accounts template.
- `vat_codes.json` — VAT/GST code templates.
- `filings/` — filing descriptors (`ink2.json`, `annual-report.json`, `vat-return.json`) that drive emitters.

`setup.init` auto-discovers packs by directory scan; a pack linter (`tests/jurisdiction-packs.mjs`) is a CI gate. Add a new jurisdiction by creating a directory with these files. Integration capabilities (SIE export/import, SRU) are gated by the pack's `integrations` declarations.

---

## License

AGPL-3.0. See the project repository for details.
