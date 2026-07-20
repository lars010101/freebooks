# freeBooks

Open-source, self-hosted double-entry accounting for small companies. Your data stays on your machine in a single DuckDB file — no cloud dependency, no subscription.

**Stack:** Node.js · Express · DuckDB (`@duckdb/node-api`)
**License:** AGPL-3.0
**Repo:** https://github.com/lars010101/freebooks

---

## Key Features

- **Full double-entry bookkeeping** — journal batches, account autocomplete, reversal workflow, auto-generated references (`CODE/YYYY/NNNNN`, e.g. `MISC/2026/00001`, `AP/2026/00003`)
- **Financial statements** — Profit & Loss, Balance Sheet (with live unallocated net income), Cash Flow (indirect, IAS 7), Statement of Changes in Equity
- **Audit & listing reports** — Trial Balance, General Ledger, Journal, Integrity Check (with RE roll-forward)
- **Multi-period comparative reports** — month-over-month and year-over-year for P&L, BS, and CF, driven by company-defined fiscal periods
- **Multi-currency (IAS 21)** — transaction-currency and home-currency columns on every journal line; FX gain/loss on settlement computed via the booking-rate method; period-end FX revaluation (preview + post)
- **VAT / GST engine** — tax-exclusive entry, reverse-charge support, supplier-stated VAT override with configurable tolerance, and VAT return generation grouped by report box
- **Accounts Payable** — vendor master with defaults, multi-line bill entry (auto-generates DR Expense / CR AP journal), draft bills, void with auto-reversal, payment matching, and AP Aging report
- **Accounts Receivable** — invoicing and AR aging (planned; nav and page scaffolding in place)
- **Bank statement processing** — CSV import with rule-based auto-matching, manual bill allocation linking import rows to open bills (multi-currency aware), and cleared/uncleared reconciliation tracking
- **Period locking** — locked periods reject all postings; enforced server-side in the validation engine
- **File attachments** — attach PDFs, images, and documents to bills and journal entries; stored on the local filesystem
- **Multi-company** — isolated books per company, each with its own chart of accounts, tax codes, periods, and settings
- **Pluggable FX providers** — ECB and OpenExchangeRates shipped; add a provider by dropping a file into `api/src/fxProviders/`

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 20 |
| HTTP server | Express 4 |
| Database | DuckDB (single embedded file via `@duckdb/node-api`) |
| Report queries | DuckDB SQL macros (`db/macros.sql`) |
| File uploads | Multer |
| Auth | Email + role-based permissions (`user_permissions` table) |
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
| `FREEBOOKS_ADMIN_TOKEN` | Bearer token for `POST /api/admin/query` (arbitrary SQL). **If unset, the endpoint is disabled (403).** Set it only for local admin/debug use: `FREEBOOKS_ADMIN_TOKEN=$(openssl rand -hex 32) node api/src/index.js`, then send `Authorization: Bearer <token>`. |
| `PORT` | HTTP port (default 3000). |

---

## Project Structure

```
freebooks/
├── api/
│   ├── package.json            # dependencies + start/dev scripts
│   ├── public/                 # static assets served at /public
│   └── src/
│       ├── index.js            # Express entry point, action routing, auth gate
│       ├── db.js               # DuckDB connection + query/exec/bulkInsert helpers
│       ├── auth.js             # permission checking (user_permissions table)
│       ├── journal.js          # journal posting, reversal, search, reference sequencing
│       ├── bills.js            # Accounts Payable: create, void, list, match, drafts, aging
│       ├── vendors.js          # vendor master CRUD
│       ├── bank.js             # bank statement processing, approval, reconciliation
│       ├── vat.js              # VAT/GST split, reverse charge, VAT return
│       ├── fx.js               # FX rate lookup, manual entry, revaluation, provider config
│       ├── fxProviders/        # pluggable rate providers (ecb.js, openexchangerates.js)
│       ├── setup.js            # company creation, COA + VAT template loading
│       ├── validation.js       # period lock + balance + COA + FX rate checks
│       ├── attachments.js      # file upload/download/delete
│       ├── audit.js            # audit log helpers
│       ├── reports.js          # mounts HTML report routes + page modules
│       └── pages/              # one module per UI page (dashboard, bank, payables, settings, …)
├── db/
│   ├── schema.sql              # table definitions + migrations
│   ├── macros.sql              # DuckDB macros: pl(), bs(), cf(), sce(), tb(), gl(), journal(), integrity()
│   ├── init.js                 # loads schema + macros, seeds default journals (MISC, BANK, ADJ, AP)
│   ├── import.js               # one-time CSV import (COA, journal, mappings)
│   ├── currencies.json         # ISO 4217 currency codes (autocomplete datalist)
│   └── jurisdictions/          # COA + VAT code templates per jurisdiction (SG, SE, _template)
├── reports/
│   ├── render.js               # shared report HTML rendering (P&L, BS, CF, SCE, TB, GL, …)
│   ├── generate.js             # CLI report generator
│   └── sources/                # report source data
├── docs/
│   ├── UI.md                   # UI/UX philosophy: typography, theming, accessibility
│   └── payables-ux-spec.md     # Payables tree-table keyboard + mouse UX spec
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
| `bills` | Accounts Payable bills (vendor, amounts, currency, FX rate, status, `amount_paid`) |
| `bill_payments` | Payment allocations linking bills to settlement journal batches |
| `vendors` | Vendor master with default currency, payment terms, and default expense/AP accounts |
| `vat_codes` | VAT/GST codes: rate, input/output accounts, report box, reverse-charge flag |
| `bank_mappings` | Rule-based bank import matching (pattern → offset account, VAT code) |
| `reconciliations` | Cleared-status tracking per batch/account for bank reconciliation |
| `fx_rates` | Exchange rates (date, pair, rate, source) — manual or provider-fetched |
| `periods` | Fiscal periods with `locked` boolean |
| `settings` | Key/value company settings (FX provider, VAT tolerance, default accounts, …) |
| `user_permissions` | Email → company → role grants |
| `centers` | Cost/profit centers |
| `attachments` | File attachment metadata (entity type/id, filename, storage path) |
| `audit_log` | Field-level change history |

Schema also defines reporting views (`v_trial_balance`, `v_pl`, `v_bs`, `v_gl`) and migrations are appended inline to `schema.sql` and applied on every `node db/init.js` run.

---

## API Overview

freeBooks uses a single **action-based API**. All mutations and reads go through one endpoint:

```
POST /api/action        (also POST /api)
Body: { "action": "<module>.<verb>", "companyId": "...", "userEmail": "...", ... }
Response: { "ok": true, "data": ... }   (or { "error": "..." })
```

The `action` string is split on `.` to dispatch to a module handler (`journal.*`, `bill.*`, `bank.*`, `vat.*`, `fx.*`, `coa.*`, `vendor.*`, `mapping.*`, `period.*`, `settings.*`, `company.*`, `journals.*`, `center.*`, `permissions.*`, `attachment.*`, `setup.*`, `diag.*`, `report.*`).

### Permission levels

Every action maps to a required role in `ACTION_ROLES` (`api/src/index.js`). When `userEmail` is present, the `user_permissions` table is checked before dispatch.

| Role | Can do |
|---|---|
| `viewer` | Read/list actions (reports, lists, lookups) |
| `data_entry` | Post entries, create/void bills, process bank, save FX rates, save mappings |
| `owner` | Manage company, COA, VAT codes, journals, periods, vendors, settings, FX provider, permissions |

A few representative actions:

| Action | Min. role |
|---|---|
| `journal.post`, `journal.reverse` | `data_entry` |
| `bill.create`, `bill.void`, `bill.draft.*` | `data_entry` |
| `bank.process`, `bank.approve` | `data_entry` |
| `fx.rates.save`, `fx.fetch_rates` | `data_entry` |
| `coa.save`, `coa.upsert`, `vat.codes.save` | `owner` |
| `period.save`, `company.save`, `settings.save` | `owner` |
| `setup.add_company`, `permissions.save` | `owner` |
| `*.list`, `journal.search`, `bill.match`, `settings.get` | `viewer` |

HTML report pages are served via `GET` routes (`/`, `/:company`, `/:company/reports`, `GET /api/:company/report?type=<type>&start=…&end=…`). File uploads use `POST /api/upload` (multipart) and `GET /api/attachments/:id`.

---

## Reports

All report types render through `reports/render.js` and are available in the Reports hub (`/:company/reports`) or via the report endpoint:

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

MoM/YoY apply only to `pl`, `bs`, and `cf`. YoY uses the company's defined fiscal periods. Report logic lives in DuckDB macros (`db/macros.sql`) — changes require re-running `node db/init.js` to reload them.

---

## Supported Jurisdictions

New companies load a Chart of Accounts and VAT/GST code template from `db/jurisdictions/<code>/`. A `_template/` directory is provided as a starting point for adding new jurisdictions.

| Code | Country | Currency | Reporting standards | VAT name | Tax authority | COA standard |
|---|---|---|---|---|---|---|
| `SG` | Singapore | SGD | SFRS, SFRS-SE | GST | IRAS | SFRS |
| `SE` | Sweden | SEK | K2, K3 | Moms | Skatteverket | BAS |

Each jurisdiction directory contains a `manifest.json`, `coa.json`, and `vat_codes.json`. Add a new jurisdiction by creating a directory with these three files — `setup.init` auto-discovers it.

---

## License

AGPL-3.0. See the project repository for details.
