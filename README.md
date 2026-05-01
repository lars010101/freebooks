# freeBooks

Open-source double-entry accounting for small companies.

**Stack:** Node.js · Express · DuckDB  
**License:** AGPL-3.0  
**Repo:** https://github.com/lars010101/freebooks

---

## What it is

A self-hosted web application for bookkeeping and financial reporting. You run it locally; your data stays on your machine in a single DuckDB file. No cloud dependency, no subscription.

Core capabilities:
- Full double-entry bookkeeping (journal entries, account autocomplete, reversal UI)
- Auto-generated journal references: `MISC/2026/00001`, `BANK/2026/00003` etc.
- Financial statements: P&L, Balance Sheet, Cash Flow (indirect, IAS 7), SCE
- Audit reports: Trial Balance, General Ledger, Journal, Integrity Check
- Multi-period comparative reports (MoM, YoY by fiscal period)
- Bank statement CSV import with rule-based auto-matching
- Bank reconciliation with cleared/uncleared tracking
- CSV import (COA + journal entries via CSV)
- Multi-company support
- Period lock enforcement
- VAT/GST tracking with jurisdiction-aware tax codes (SG, SE templates)

---

## Architecture

```
Browser
  ↓ HTTP (port 3000)
Express API  —  api/src/index.js
  ↓
DuckDB  —  ~/.freebooks/freebooks.duckdb
  ↓
SQL Macros  —  db/macros.sql
```

Key source files:

| Path | Purpose |
|---|---|
| `api/src/index.js` | Express entry point, action routing, auth |
| `api/src/reports.js` | Thin router — mounts all GET routes, delegates to page modules |
| `api/src/pages/` | **Page modules** — one file per UI page (see below) |
| `api/src/journal.js` | Journal entry posting, reversal, search, reference generation |
| `api/src/bank.js` | Bank statement processing, approval, reconciliation |
| `api/src/bills.js` | Accounts Payable — bill creation, void, list, match |
| `api/src/vendors.js` | Vendor master CRUD |
| `api/src/vat.js` | VAT/GST computation, VAT return |
| `api/src/fx.js` | FX rate fetching, revaluation preview/posting |
| `api/src/setup.js` | Company creation, COA + VAT template loading |
| `api/src/validation.js` | Period lock + balance checks before posting |
| `reports/render.js` | Report HTML generation (PL, BS, CF, SCE, TB, GL, etc.) |
| `db/schema.sql` | DuckDB table definitions + migration statements |
| `db/macros.sql` | DuckDB macros: `pl()`, `bs()`, `cf()`, `sce()`, `tb()`, `gl()`, `journal()`, `integrity()`, `re_rollforward()` |
| `db/init.js` | Loads schema + macros into DuckDB; seeds default journals per company |
| `db/import.js` | One-time CSV import (COA.csv, JOURNAL.csv, MAPPING.csv) |
| `db/jurisdictions/` | COA + VAT code templates per jurisdiction (SG, SE) |

### Page Modules (`api/src/pages/`)

Each UI page is a self-contained module that exports one handler function. The handler receives `(req, res)` and sends server-rendered HTML.

| Module | Page | Route |
|---|---|---|
| `common.js` | Shared CSS (`commonStyle`) + `makeQuery` helper | — |
| `index-page.js` | Company list | `GET /` |
| `company.js` | Report selector | `GET /:company` |
| `settings.js` | Settings (7 tabs: Periods, Company, COA, Tax Codes, Journals, Bank Mappings, Vendors) | `GET /:company/settings` |
| `journal-new.js` | Journal entry form (with reversal mode) | `GET /:company/journal/new` |
| `bank-import.js` | Bank statement CSV import | `GET /:company/bank/import` |
| `bank-reconcile.js` | Bank reconciliation | `GET /:company/bank/reconcile` |
| `new-company.js` | New company wizard | `GET /setup/new-company` |
| `admin.js` | Debug SQL endpoint | `POST /api/admin/query` |

**Rules for new pages:**
- Create a new file in `api/src/pages/` — never add page HTML back into `reports.js`.
- Import `commonStyle` and/or `makeQuery` from `./common`.
- Export the handler, then add one `require` + one `app.get()` line in `reports.js`.
- Keep each module under ~500 lines. If a page grows beyond that, split its client-side JS into a separate file or break the page into sub-modules.

---

## Install & Run

### From scratch

```bash
git clone https://github.com/lars010101/freebooks /opt/freebooks
cd /opt/freebooks
npm install --prefix api
node db/init.js          # creates ~/.freebooks/freebooks.duckdb, seeds journals
node db/import.js <data-dir>   # import historical CSV data (optional)
node api/src/index.js    # start server on port 3000
```

Open http://localhost:3000

### Updating (code only)

```bash
cd /opt/freebooks && sudo git pull && node api/src/index.js
```

### Updating (includes schema changes)

```bash
cd /opt/freebooks && sudo git pull && node db/init.js && node api/src/index.js
```

`node db/init.js` is idempotent — safe to always run on update.

### Owner's deployment

- Host: Fedora Atomic laptop, wolfi distrobox
- Path: `/opt/freebooks`

---

## Web UI Pages

| URL | Description |
|---|---|
| `/` | Company list + New Company button |
| `/:company` | Report selector |
| `/:company/settings` | Settings (6 tabs: Periods, Company, COA, Tax Codes, Journals, Bank Mappings) |
| `/:company/journal/new` | New journal entry form (with reversal mode) |
| `/:company/bank/import` | Bank statement CSV import |
| `/:company/bank/reconcile` | Bank reconciliation |
| `/:company/report?type=...` | Rendered report |
| `/setup/new-company` | New company wizard |
| `/api/admin/query` | Debug SQL endpoint (POST) |

---

## API Actions (POST /api/action)

All actions use `{ action, companyId, ...body }` request format. Response: `{ ok: true, data: ... }`.

| Action | Description |
|---|---|
| `journal.post` | Post a journal entry batch (accepts `journalId` for auto-reference) |
| `journal.reverse` | Reverse a posted batch |
| `journal.list` | List journal entries |
| `journal.import` | Bulk import journal lines |
| `journal.search` | Search batches by reference or description |
| `journal.get` | Get all lines for a batch |
| `journals.list` | List journals for a company |
| `journals.save` | Upsert a journal |
| `bank.process` | Apply mapping rules to bank rows, return matched/unmatched |
| `bank.approve` | Post approved bank entries as journal entries |
| `bank.reconcile.list` | Get journal entries for an account with cleared status + opening balance |
| `bank.reconcile.clear` | Toggle cleared status for a batch |
| `vat.codes.list` | List VAT/GST codes |
| `vat.codes.save` | Replace all VAT/GST codes |
| `vat.return` | Generate VAT return |
| `company.list` | List companies |
| `company.save` | Save/update company |
| `period.list` | List fiscal periods |
| `period.save` | Replace all fiscal periods (DELETE + INSERT) |
| `coa.save` | Update chart of accounts |
| `coa.update` | Update individual accounts |
| `mapping.list` | List bank mapping rules |
| `mapping.save` | Replace all bank mapping rules |
| `setup.add_company` | Create company with COA + VAT template |
| `settings.get` | Get company settings |
| `settings.save` | Save company settings |

---

## Report Types

| type= | Report | Multiperiod |
|---|---|---|
| `pl` | Profit & Loss | MoM + YoY |
| `bs` | Balance Sheet | MoM + YoY |
| `cf` | Cash Flow (indirect) | MoM + YoY |
| `sce` | Statement of Changes in Equity | No |
| `tb` | Trial Balance | No |
| `gl` | General Ledger | No |
| `journal` | Journal | No |
| `integrity` | Integrity Checks + RE roll-forward | No |

YoY uses the company's defined fiscal periods (not calendar years).

---

## Key Design Decisions

### Closing Model
P&L accounts accumulate forever; date filtering isolates periods. Closing entry: `DR 999999 / CR 203070` transfers net income to Retained Earnings. Account 999999 has `account_type = 'Closing'` and is excluded from all reports.

### CF — NonCash Category (IAS 7.43)
Non-cash financing activities (e.g. RE capitalisation) use `cf_category = 'NonCash'`. The CF macro includes them in net_change computation (they cancel with the corresponding Financing entry) and displays them in a separate "Non-cash Activities" section.

Tag the RE account after import:
```sql
UPDATE accounts SET cf_category = 'NonCash'
WHERE company_id = 'YOUR_COMPANY' AND account_code = '203070';
```

### Account Subtype
`account_subtype` is the single field for section grouping in both BS and P&L reports (replaces the old `bs_category` / `pl_category` split). The macros use `COALESCE(a.account_subtype, a.account_type)` for section headers.

### Journal Sequencing
References auto-generated as `{CODE}/{YYYY}/{NNNNN}` (5-digit, per journal per year). Stored in `journals` and `journal_sequences` tables. Default journals seeded by `db/init.js`: MISC, BANK, ADJ. The JV form and bank import both let users select the journal; the server generates the next sequence number atomically.

### Bank Mappings
Each mapping rule stores one *offset account* (the non-bank side). At import time, the user provides the bank account code. Amount sign determines the entry:
- Outflow (negative): DR offset / CR bank  
- Inflow (positive): DR bank / CR offset

Legacy rules with both debit_account and credit_account set explicitly are still honoured.

### Bank Reconciliation
Cleared entries stored in `reconciliations` table (company_id, batch_id, account_code, cleared_at). The reconcile page shows: Opening Balance (pre-period) + Period Net = Closing Book Balance, compared against the user-entered Statement Closing Balance.

### Period Locks
The `periods.locked` boolean is enforced in `validation.js` on every journal entry post. Locked periods cannot be written to. `period.save` is a full DELETE + INSERT (no row accumulation).

### DuckDB File Lock
DuckDB holds an exclusive file lock while the server runs. Use `duckdb -readonly <file>` for read-only CLI access, or use `POST /api/admin/query` for ad-hoc queries without stopping the server.

---

## cf_category Values

| Value | Use |
|---|---|
| `Cash` | Bank/cash accounts (used for CF opening/closing balance) |
| `Op-WC` | Operating working capital movements |
| `Operating` | Direct operating items |
| `Tax` | Tax payable movements |
| `Investing` | Investment purchases/disposals |
| `Financing` | Borrowings, equity issuance, dividends |
| `NonCash` | Non-cash equity entries — IAS 7.43 disclosure |
| `Excluded` | Excluded from all CF sections |
| `NULL` | Revenue/Expense accounts (captured via account_type in net income CTE) |

---

## Companies (Owner's instance)

| company_id | Name | Currency |
|---|---|---|
| `example_sg` | Example Company SG | SGD |
| `example_se` | Example Company SE | SEK |
| `test_co` | Test Trading Co. | SGD |

---

## Remaining Work / Backlog

### Settings & Admin
- [ ] Cost/profit centers management tab in settings
- [ ] Period lock warning in JV form before submit
- [ ] Simple auth (single password or token) for LAN/VPN exposure

### Reports
- [ ] P&L with budget vs actual column
- [ ] Swedish årsredovisning (K2/K3 formatted annual report)
- [ ] Bolagsverket / Skatteverket filing exports (SE)

### Journal Entry Form
- [ ] Template entries (recurring journal presets)

### Infrastructure
- [ ] Automatic `node db/init.js` on server start (detect schema changes)
- [ ] Opening balance wizard for new companies
- [ ] Backup / export to CSV/SQLite

### Known Issues
- [ ] example_se CF categories: accounts 1942, 1941 → Investing; 2990 → Op-WC (not yet confirmed fixed)
- [ ] MISC/2024/0013 (example_sg) — bad phantom bank entry, may need reversal
