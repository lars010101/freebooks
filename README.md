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
| `api/src/fx.js` | FX rate management and provider integration |
| `api/src/fxProviders/` | Pluggable FX rate providers (ecb.js, openexchangerates.js, etc.) |
| `api/src/setup.js` | Company creation, COA + VAT template loading |
| `api/src/validation.js` | Period lock + balance checks before posting |
| `reports/render.js` | Report HTML generation (PL, BS, CF, SCE, TB, GL, etc.) |
| `db/schema.sql` | DuckDB table definitions + migration statements |
| `db/currencies.json` | ISO 4217 currency codes (190 currencies) with `<datalist>` autocomplete |
| `db/macros.sql` | DuckDB macros: `pl()`, `bs()`, `cf()`, `sce()`, `tb()`, `gl()`, `journal()`, `integrity()`, `re_rollforward()` |
| `db/init.js` | Loads schema + macros into DuckDB; seeds default journals per company; **Note:** after `git pull` with macro changes, must re-run `node db/init.js` to reload macros into DuckDB |
| `db/import.js` | One-time CSV import (COA.csv, JOURNAL.csv, MAPPING.csv) |
| `db/jurisdictions/` | COA + VAT code templates per jurisdiction (SG, SE) |

#### Performance

- **Persistent DuckDB connection**: `makeQuery()` in `common.js` reuses a single module-level DuckDB connection (`_conn`) across all page renders instead of opening/closing per query. Reconnects automatically on error.
- **Dashboard cache**: the 4-aggregate CTE query on the Dashboard is cached in memory with a 30-second TTL per company.

---

## Install & Run

### From scratch

```bash
git clone https://github.com/lars010101/freebooks ~/freebooks
cd ~/freebooks
npm install --prefix api
node db/init.js          # creates ~/.freebooks/freebooks.duckdb, seeds journals
node db/import.js <data-dir>   # import historical CSV data (optional)
node api/src/index.js    # start server on port 3000
```

Open http://localhost:3000

### Updating (code only)

```bash
cd ~/freebooks && git pull && node api/src/index.js
```

### Updating (includes schema changes)

```bash
cd ~/freebooks && git pull && node db/init.js && node api/src/index.js
```

Note: `node db/init.js` must be run with the server stopped. If the server is running, use `node db/init.js --via-server` instead (applies migrations through the server's existing DB connection, avoids WAL conflict).

The server handles SIGINT/SIGTERM (Ctrl+C) gracefully — checkpoints DuckDB before exit to prevent stale WAL files.

### Owner's deployment

- Host: Fedora Atomic laptop, wolfi distrobox
- Path: `~/freebooks`

---

## Web UI Pages

| URL | Description |
|---|---|
| `/` | Onboarding: redirects to `/setup/new-company` if no companies exist; otherwise client-side redirect to active company (from localStorage) |
| `/setup/new-company` | New company wizard |
| `/:company` | **Dashboard** — 4 summary cards (UNLOCKED YR, UNCLEARED TX, Bank Balance, P&L) + report selector |
| `/:company/settings` | Settings (8 tabs: Periods, Company, COA, Tax Codes, Journals, Bank Mappings, Exchange Rates, Vendors) |
| `/:company/journal/new` | New JV form (with reversal mode) |
| `/:company/bill/new` | Enter Bill form — vendor autocomplete, multi-line expenses, auto-generates AP journal entry |
| `/:company/payables` | Payables screen — bill list with filters + bill detail modal |
| `/:company/payables/aging` | AP Aging report — outstanding payables by aging bucket |
| `/:company/bank` | **Bank** — uncleared transactions list + collapsible CSV import ("Import Statement"). Supports `?mode=uncleared` to auto-load all uncleared transactions across all cash accounts. Step 2: Link Bill panel shows open bills with outstanding amounts and multi-currency support. |
| `/:company/opening-balances` | Opening balances (setup step; accessible from new company wizard) |
| `/api/admin/query` | Debug SQL endpoint (POST) |

Note: `/:company/bank/import` and `/:company/bank/reconcile` both 301-redirect to `/:company/bank`.

### Navigation

All pages share a persistent 5-item top nav bar rendered by `navBar(company, activeKey)` in `api/src/pages/common.js`:

```
📊 Dashboard  |  🏦 Bank  |  ✏ New JV  |  📋 Payables  |  ⚙ Settings
```

Active item highlighted with bold + bottom border. Opening Balances is not in the persistent nav — it surfaces contextually in the new company wizard.

### Company switching

The active company is stored in `localStorage` (`freebooks_company` key). Switching company is done via Settings → Company tab → "Manage Companies" section. The root `/` route redirects to the stored active company on return visits.

### Dashboard cards

The dashboard shows 4 clickable summary cards before the report selector:

| Card | Color logic | Links to |
|---|---|---|
| **UNLOCKED YR** | Green (0–1 unlocked), Orange (2), Red (3+) | Settings → Periods tab |
| **UNCLEARED TX** | Green (0), Red (>0) | Bank page (uncleared mode) |
| **Bank Balance** | Neutral | Bank page |
| **P&L** | Green (profit), Red (loss) | Dashboard |

Card data is cached in memory for 30 seconds per company (`_dashCache` in `company.js`)

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
| `journal.entry.update` | Update description on a single journal entry (non-financial fields only) |
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
| `bank.approve` | Post approved bank entries as journal entries; validates account codes; handles FX gain/loss on bill settlement |
| `bank.reconcile.list` | Get journal entries for an account with cleared status + opening balance |
| `bank.reconcile.clear` | Toggle cleared status for a batch |
| `bank.uncleared.list` | Return all uncleared transactions across all Cash accounts (no date filter) |
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
| `mapping.save` | Replace all bank mapping rules; validates account codes against COA |
| `setup.add_company` | Create company with COA + VAT template |
| `settings.get` | Get company settings |
| `settings.save` | Save company settings |
| `fx.rates.list` | List FX rates for a base currency (all dates) |
| `fx.rates.save` | Save/upsert manual FX rates |
| `fx.rates.delete` | Delete a specific FX rate |
| `fx.rates.get` | Get effective rate for a currency pair on a date (check DB, fall back to provider) |
| `fx.providers.list` | List available FX provider plugins |
| `fx.provider.get` | Get current provider setting and masked API key |
| `fx.provider.save` | Save provider selection and API key |
| `attachment.list` | List attachments for an entity (entity_type, entity_id) |
| `attachment.delete` | Delete an attachment |

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

### Multi-Currency — Booking Rate Method for FX Gain/Loss
When a foreign-currency bill (e.g. USD) is paid in home currency (SGD):
- Bill stores the **original booking rate** (`fx_rate`): e.g. USD 100 @ SGD 1.25
- User specifies the foreign amount being settled (defaults to full outstanding)
- AP is cleared at the **original booking rate**: `settledBooked = settledForeign × bill.fx_rate`
- FX gain/loss absorbs the remainder: `fxDiff = bankAmount − settledBooked`
- Journal entry: DR AP (settledBooked) / DR|CR FX G/L (fxDiff) / CR Bank (bankAmount)
- Bill's `amount_paid` is incremented in **foreign currency** (correct for partial payments and multi-currency tracking)
- Bank spread and rate differences are absorbed into FX G/L
- **No payment-date rate needed**; this follows IAS 21 standard practice

### Multi-Currency Reports
All DuckDB macros (pl, bs, cf, tb, sce, gl, journal, integrity, re_rollforward) use `debit_home`/`credit_home` amounts for financial statement calculations (home currency totals). The `debit`/`credit` columns retain transaction currency amounts for reference. Macros are stored in DuckDB as inline macros — changes require `node db/init.js` to reload them.

### Bank Mappings & COA Validation
Each mapping rule stores one *offset account* (the non-bank side). At import time, the user provides the bank account code. Amount sign determines the entry:
- Outflow (negative): DR offset / CR bank  
- Inflow (positive): DR bank / CR offset

Legacy rules with both debit_account and credit_account set explicitly are still honoured.

Bank account code validated against COA before processing; red error if not found. "Post to Journal" button blocked if any row has invalid/missing DR or CR account.

### Bank Reconciliation
Cleared entries stored in `reconciliations` table (company_id, batch_id, account_code, cleared_at). The reconcile page shows: Opening Balance (pre-period) + Period Net = Closing Book Balance, compared against the user-entered Statement Closing Balance.

### Bank Import with FX Gain/Loss Handling
When linking a foreign-currency bill (e.g. USD 100 @ 1.25) to a home-currency bank row (e.g. SGD 127.62):
- UI shows "Settle: [___] USD" input, defaults to full outstanding foreign amount
- Live preview: `≈ {homeAmount} {homeCurrency} cleared | FX loss: {fxDiff} {homeCurrency}`
- On post: 3-line journal entry:
  - DR AP: `settledForeign × bill.fx_rate` (clears AP at booking rate)
  - DR|CR FX G/L: `bankAmount − (settledForeign × bill.fx_rate)` (absorbs bank spread and rate differences)
  - CR Bank: `bankAmount` (actual cash out)
- Bill's `amount_paid` incremented in **foreign currency** (correct for partial payments)
- Requires `fx_gain_loss_account` configured in Settings → Company; warns if not set
- Implements IAS 21 standard: realised gains/losses on payment absorbed into FX G/L; no payment-date rate needed

### Balance Sheet — Unallocated Net Income

The BS report includes a computed *"Unallocated net income / (loss)"* row in the Equity section, representing P&L not yet closed to Retained Earnings. Computed live from Revenue/Expense accounts for the report period. Once the annual closing entry is posted (`DR 999999 / CR RE account`), the P&L clears and this row disappears.

TOTAL EQUITY and TOTAL EQUITY + LIABILITIES are both adjusted to include this amount, ensuring the balance sheet balances during open periods.

### Integrity Report — Unallocated P&L Handling

The `buildIntegrity` function post-processes DuckDB macro results to account for unallocated net income:
- **BS Balance check**: if the imbalance equals the unallocated P&L exactly, status is upgraded to OK with a note
- **P&L vs Closing Entry check**: downgraded from FAIL to WARN when P&L is non-zero but no closing entry has been posted ("unallocated, closing entry not yet posted")

## Vendor Master

Stored in the `vendors` table. Fields: name, default currency, payment terms (days), default expense account, default AP account.

Accessible via Settings → Vendors tab. Defaults auto-fill the Enter Bill form when a vendor is selected:
- Currency → bill currency field
- Terms(d) → due date = bill date + terms
- Default Expense Account → first expense line
- Default AP Account → AP account field

Default expense and AP account fields validated on blur and on `vendor.save` against the company's COA.

## Enter Bill (`/:company/bill/new`)

Form for creating vendor bills. Generates a balanced journal entry on submit:
- DR line per expense line (expense account, net amount in home currency)
- DR line per expense line with VAT code (input tax account, GST amount) — one per line, tax-exclusive
- CR line for AP account (total including VAT in home currency)

Amounts entered are **net ex-VAT** (tax-exclusive). VAT is computed as `lineAmount × rate` and added on top. The GST sub-row appears automatically in the form when a VAT code is selected — account and amount are editable before submitting.

AP journal reference auto-generated: `AP/YYYY/NNNNN`.

Supports multi-line bills and **multi-currency**: vendor autocomplete fills in currency (defaults to company home currency). Currency field has datalist autocomplete from `db/currencies.json` (190 ISO 4217 codes). When currency differs from home currency:
- FX Rate field appears with "Get Rate" button: auto-fetches from `fx_rates` table on currency change; falls back to ECB API if not in DB
- Line amounts entered in **foreign currency**; home currency equivalents computed using `fx_rate`
- Journal lines posted with `debit_home` and `credit_home` amounts
- Display shows: `≈ {homeCurrency} {homeAmount} @ {rate}` right-aligned below total
- Bill's `fx_rate` sent to `bill.create` payload

Vendor autocomplete also fills in currency, payment terms (→ due date), default expense account, and default AP account.

Bill status on creation: `posted`. Status transitions:
- `posted` → `partial` → `paid` (via payment matching)
- `posted` / `partial` → `void` (via `bill.void` — voids bill, auto-reverses journal, closes modal)

### Payables Screen (`/:company/payables`)
List of all bills for the company with filter controls: vendor (dropdown), description (text search), status (Open/Partial/Paid/Void), fiscal period (dropdown). Collapsible "More filters" for amount (≥/=/≤) and currency. Click any row to open a bill detail modal with all header fields and expense lines (fetched via `bill.lines`). Modal shows: header (date, vendor, ref, status, amount, currency, fx_rate), expense lines with inline-editable descriptions (fires `journal.entry.update` on change), attachment widget (view/download uploaded files), and action buttons (void, close modal).

### AP Aging Report (`/:company/payables/aging`)
Outstanding payables (status `posted` or `partial`) as of a selected date, bucketed by days overdue:
- **Current** — due_date ≥ as_of_date (not yet due)
- **1–30** — 1 to 30 days past due
- **31–60** — 31 to 60 days past due
- **61–90** — 61 to 90 days past due
- **90+** — more than 90 days past due; shown in red

Vendor-grouped summary table; click vendor row to expand individual bills. Click any bill row to open the full bill detail modal. For multi-currency bills, home currency equivalent shown. Balance = `amount - amount_paid` in **foreign currency** (correctly handles partial payments).

### New Company Journal Seeding
`setup.add_company` seeds 4 default journals on creation: MISC, BANK, ADJ, AP. Bills post through the AP journal (`AP/YYYY/NNNNN` references). `db/init.js` seeds MISC, BANK, ADJ for existing companies.

### File Attachments
Bills and journal entries can have file attachments (PDF, images, etc.). Stored in `attachments` table with file stored in `~/.freebooks/attachments/{company_id}/{entity_type}/{entity_id}/`. Attachment widget appears on bill detail modal and Enter Bill success state. Accessed via:
- `POST /api/upload` — multipart form (field `file`, body: `companyId`, `entityType`, `entityId`)
- `GET /api/attachments/:attachmentId?companyId=xxx` — stream file
- `attachment.list` action — list attachments for an entity
- `attachment.delete` action — delete an attachment

Requires `npm install --prefix api multer` on setup.

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

## Remaining Work / Backlog

### Settings & Admin
- [ ] Cost/profit centers management tab in settings
- [ ] Period lock warning in JV form before submit
- [ ] Simple auth (single password or token) for LAN/VPN exposure

### Reports
- [ ] P&L with budget vs actual column
- [ ] Annual report filing exports
- [ ] Filing/compliance outputs

### Journal Entry Form
- [ ] Template entries (recurring journal presets)

### Infrastructure
- [ ] Automatic `node db/init.js` on server start (detect schema changes)
- [x] Opening balance wizard for new companies
- [ ] Backup / export to CSV/SQLite

### Accounts Receivable
- [ ] Customer master (name, currency, payment terms, default income account, AR account)
- [ ] Invoice creation: multi-line, VAT-aware, auto-generates DR AR / CR Revenue journal (AR/YYYY/NNNNN reference)
- [ ] Invoice list / Receivables screen with filters (customer, status, period, amount)
- [ ] AR Aging report — outstanding receivables bucketed by days overdue
- [ ] Send invoice by email (PDF export + mailto or SMTP)
- [ ] Payment matching: mark invoice Paid via bank import (link import row → open invoice)
- [ ] Partial receipt tracking and allocation

### Accounts Payable
- [x] Payment matching: mark bill Paid via bank import (link import row → open bill during import)
- [x] Partial payment tracking and allocation (via foreign currency amount_paid tracking)
- [x] Bill edit workflow (non-financial fields editable; financial fields require Reverse & Re-enter via `bill.void`)

### Multi-Currency
- [x] FX rate table (manual entry) — Settings → Exchange Rates tab
- [x] FX provider plugin system (`api/src/fxProviders/` with ECB and OpenExchangeRates shipped)
- [x] Realised gain/loss on settlement — implemented in bank import Step 2 via booking rate method
- [ ] FX revaluation at period-end: revalue open AR/AP balances to closing rate, post unrealised gain/loss journal

### Documents & Attachments
- [x] Attach files (PDF, image) to bills
- [x] View/download attachments from bill detail modal
- [x] Storage: local filesystem (`~/.freebooks/attachments/{company_id}/{entity_type}/{entity_id}/`)
- [ ] Attachments on journal entries and invoices

### UX / Navigation
- [ ] Delete old `bank-import.js` and `bank-reconcile.js` page modules (pending stability confirmation)
- [ ] Period-end checklist per jurisdiction — template-driven, stored on period row
- [ ] Period-end notes field on the period row (visible in Periods tab)
- [ ] `Filings` / `Compliance` nav section for statutory output (VAT return, annual report formats)
- [ ] Static JS extraction to files with Cache-Control headers (further perf improvement)

### Known Issues
- [ ] example_se CF categories: accounts 1942, 1941 → Investing; 2990 → Op-WC (not yet confirmed fixed)
- [ ] MISC/2024/0013 (example_sg) — bad phantom bank entry, may need reversal
