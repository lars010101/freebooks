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
- Accounts Payable: vendor master, multi-line bill entry (auto-generates DR Expense / CR AP journal)
- Payables screen: list all open bills with filters (vendor, status, period, description, amount, currency); click to view bill detail
- AP Aging report: outstanding payables bucketed by days overdue (Current / 1–30 / 31–60 / 61–90 / 90+); click row to open bill detail
- Bank import: manual bill allocation — link any import row to an open bill
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
| `api/src/reports.js` | Thin router — mounts page modules from `api/src/pages/` |
| `api/src/bills.js` | Accounts Payable: bill creation (multi-line), void, list, match |
| `api/src/vendors.js` | Vendor master CRUD |
| `api/src/pages/` | Page modules (one file per UI page; new pages go here, never back into reports.js) |
| `api/src/journal.js` | Journal entry posting, reversal, search, reference generation |
| `api/src/bank.js` | Bank statement processing, approval, reconciliation |
| `api/src/vat.js` | VAT/GST computation, VAT return |
| `api/src/setup.js` | Company creation, COA + VAT template loading |
| `api/src/validation.js` | Period lock + balance checks before posting |
| `reports/render.js` | Report HTML generation (PL, BS, CF, SCE, TB, GL, etc.) |
| `db/schema.sql` | DuckDB table definitions + migration statements |
| `db/macros.sql` | DuckDB macros: `pl()`, `bs()`, `cf()`, `sce()`, `tb()`, `gl()`, `journal()`, `integrity()`, `re_rollforward()` |
| `db/init.js` | Loads schema + macros into DuckDB; seeds default journals per company |
| `db/import.js` | One-time CSV import (COA.csv, JOURNAL.csv, MAPPING.csv) |
| `db/jurisdictions/` | COA + VAT code templates per jurisdiction (SG, SE) |

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

Note: `node db/init.js` must be run with the server stopped. If the server is running, use `node db/init.js --via-server` instead (applies migrations through the server's existing DB connection, avoids WAL conflict).

The server handles SIGINT/SIGTERM (Ctrl+C) gracefully — checkpoints DuckDB before exit to prevent stale WAL files.

### Owner's deployment

- Host: Fedora Atomic laptop, wolfi distrobox
- Path: `/opt/freebooks`

---

## Web UI Pages

| URL | Description |
|---|---|
| `/` | Company list + New Company button |
| `/:company` | Report selector |
| `/:company/settings` | Settings (7 tabs: Periods, Company, COA, Tax Codes, Journals, Bank Mappings, Vendors) |
| `/:company/journal/new` | New journal entry form (with reversal mode) |
| `/:company/bill/new` | Enter Bill form — vendor autocomplete, multi-line expenses, auto-generates AP journal entry |
| `/:company/payables` | Payables screen — bill list with filters + bill detail modal |
| `/:company/payables/aging` | AP Aging report — outstanding payables by aging bucket |
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
| `bill.create` | Create bill + post journal (DR Expense lines / CR AP); accepts `lines[]` array for multi-line |
| `bill.void` | Void bill + auto-reverse journal |
| `bill.list` | List bills with filters (status, vendor, date range) |
| `bill.match` | Find open bills matching amount/vendor/date for bank import allocation |
| `bill.lines` | Get expense lines for a bill (for bill detail modal) |
| `bill.aging` | AP Aging report data — outstanding bills with bucket classification |
| `vendor.list` | List vendors with defaults (currency, terms, expense account, AP account) |
| `vendor.save` | Replace all vendors for company |
| `vendor.delete` | Delete a single vendor |
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
| `payables/aging` | AP Aging (separate page, not a /report?type= URL) | No |

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

## Vendor Master

Stored in the `vendors` table. Fields: name, default currency, payment terms (days), default expense account, default AP account.

Accessible via Settings → Vendors tab. Defaults auto-fill the Enter Bill form when a vendor is selected:
- Currency → bill currency field
- Terms(d) → due date = bill date + terms
- Default Expense Account → first expense line
- Default AP Account → AP account field

## Enter Bill (`/:company/bill/new`)

Form for creating vendor bills. Generates a balanced journal entry on submit:
- DR line per expense line (expense account, net amount)
- DR line per expense line with VAT code (input tax account, GST amount) — one per line, tax-exclusive
- CR line for AP account (total including VAT)

Amounts entered are **net ex-VAT** (tax-exclusive). VAT is computed as `lineAmount × rate` and added on top. The GST sub-row appears automatically in the form when a VAT code is selected — account and amount are editable before submitting.

AP journal reference auto-generated: `AP/YYYY/NNNNN`.

Supports multi-line bills. Vendor autocomplete fills in currency, payment terms (→ due date), default expense account, and default AP account.

Bill status on creation: `posted`. Status transitions:
- `posted` → `partial` → `paid` (via payment matching, not yet implemented)
- `posted` / `partial` → `void` (via bill.void — auto-reverses the journal)

### Payables Screen (`/:company/payables`)
List of all bills for the company with filter controls: vendor (dropdown), description (text search), status (Open/Partial/Paid/Void), fiscal period (dropdown). Collapsible "More filters" for amount (≥/=/≤) and currency. Click any row to open a read-only bill detail modal with all header fields and expense lines (fetched via `bill.lines`).

### AP Aging Report (`/:company/payables/aging`)
Outstanding payables (status `posted` or `partial`) as of a selected date, bucketed by days overdue:
- **Current** — due_date ≥ as_of_date (not yet due)
- **1–30** — 1 to 30 days past due
- **31–60** — 31 to 60 days past due
- **61–90** — 61 to 90 days past due
- **90+** — more than 90 days past due; shown in red

Vendor-grouped summary table; click vendor row to expand individual bills. Click any bill row to open the full bill detail modal. Balance = `amount - amount_paid`.

### New Company Journal Seeding
`setup.add_company` seeds 4 default journals on creation: MISC, BANK, ADJ, AP. Bills post through the AP journal (`AP/YYYY/NNNNN` references). `db/init.js` seeds MISC, BANK, ADJ for existing companies.

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

### Accounts Payable
- [ ] Payment matching: mark bill Paid via bank import (link import row → open bill during import)
- [ ] Partial payment tracking and allocation
- [ ] Bill edit workflow (non-financial fields editable; financial fields require Reverse & Re-enter)

### Known Issues
- [ ] example_se CF categories: accounts 1942, 1941 → Investing; 2990 → Op-WC (not yet confirmed fixed)
- [ ] MISC/2024/0013 (example_sg) — bad phantom bank entry, may need reversal
