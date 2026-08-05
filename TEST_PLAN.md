# Test Plan: freeBooks UX & Regulatory Compliance Evaluation

**Role:** Senior Software Test Engineer & Legal Accountant  
**Target Application:** freeBooks (Double-Entry Accounting Software)  
**Date:** July 28, 2026  
**Status:** In Execution  

---

## 1. Executive Summary & Objective

The objective of this testing campaign is to evaluate `freeBooks` strictly from a **user/business perspective**, validating that the software meets real-world accounting standards, local regulatory requirements (Sweden & Singapore), and keyboard-first/mouse usability expectations without relying on internal developer specifications.

The evaluation covers 4 distinct business scenarios across 5 core modules, executed in two consecutive UX operational modes:
1. **Mouse Interaction Mode:** Complete navigation, data entry, modal interactions, and report viewing via mouse cursor clicks.
2. **Keyboard Interaction Mode:** Complete navigation and CRUD workflows executed **exclusively** via keyboard shortcuts (Vim modal keys `j/k/h/l`, `{/}`, `Enter`, `Esc`, `Tab`, etc.) without mouse input.

---

## 2. Test Scenarios (Company Profiles)

Each test iteration begins with a clean database reset (`node db/init.js`). After initial setup, all state changes must occur **exclusively through the freeBooks application UX**.

| ID | Country / Jurisdiction | Currency | Tax Status | Multi-Currency Status | Regulatory & Accounting Standard Focus |
|---|---|---|---|---|---|
| **A** | Sweden (`SE`) | `SEK` | Not VAT Registered | Single Currency (`off`) | Swedish K2/K3 standard. Gross expense recording (no input VAT deduction). |
| **B** | Singapore (`SG`) | `SGD` | Not GST Registered | Single Currency (`off`) | Singapore Financial Reporting Standards (SFRS). Non-GST expense recording. |
| **C** | Sweden (`SE`) | `SEK` | VAT Registered | Multi-Currency (`auto`) | Skatteverket VAT (Moms) compliance (25%/12%/6%), realized/unrealized FX gains/losses on foreign accounts/journals. |
| **D** | Singapore (`SG`) | `SGD` | GST Registered | Multi-Currency (`auto`) | IRAS GST compliance (9% standard rate, zero-rated, exempt), SFRS multi-currency translation rules. |

---

## 3. Test Scope

### 3.1 In-Scope Modules
1. **Settings (CRUD):** Company profile attributes (name, jurisdiction, currency, tax registration, multi-currency toggle, FX provider, tax tolerance, accounts), Periods (creation, date validation, locking), Chart of Accounts (COA creation, roles, type/subtype editing), Bank Mappings, Cost/Profit Centers.
2. **Bank (CRUD):** Bank Account creation/editing, Bank Statement/Transaction creation, matching/reconciliation, currency assignments, bank feed/mapping application.
3. **Journal Entry (CRUD):** Manual Journal Entry creation, line item addition/deletion, debit/credit balancing validation, tax code assignment, exchange rate overrides, posting, draft vs. posted behavior, reversal/deletion.
4. **Reports (Read Only):** Trial Balance, General Ledger, Profit & Loss, Balance Sheet, Tax/VAT/GST Summary report accuracy, currency presentation, and export/view rendering.
5. **Dashboard (Read Only):** Real-time summary card accuracy (bank balances, net income, key metrics), report navigation links, multi-currency presentation.

### 3.2 Out-of-Scope
* **Payables (AP):** Bills, vendor invoices, bill payments, vendor management workflows.

---

## 4. Test Strategy & Methodology

### 4.1 Test Automation & Execution Engine
* **Execution Framework:** Playwright (Chromium headless/headed runner) operating against the running freeBooks Express server (`http://localhost:3000`).
* **State Isolation:** Clean database setup prior to each scenario run using `node db/init.js`.
* **Zero Code/Database Tampering:** No application files (`api/`, `public/`, `db/`) are modified. Database tables are never directly manipulated via SQL after initialization; all CRUD operations occur via UI interactions.

### 4.2 UX & Usability Benchmarks
* **Keyboard Navigation Parity:** Every feature accessible via mouse MUST be fully operable via keyboard.
* **Vim-Modal Keybindings:** Standard freeBooks shortcuts tested:
  * `j` / `k`: Move selection cursor down / up in lists & grids.
  * `h` / `l`: Switch top-level navigation tabs left / right.
  * `{` / `}`: Switch sub-tab pages left / right.
  * `Enter`: Confirm selection, open editor, or save active form.
  * `Esc`: Cancel inline editing or close modals (MUST NOT persist uncommitted changes).
* **Feedback & Chrome:** Visible status notifications, modal overlays, sticky cursor behavior at list boundaries.

---

## 5. Regulatory & Accounting Compliance Rules

1. **Double-Entry Equilibrium:** Every posted journal entry MUST have $\sum \text{Debits} = \sum \text{Credits}$. Unbalanced entries must be rejected by the UX.
2. **Tax Accounting Compliance:**
   * *Non-Registered Companies (A & B):* Tax codes MUST NOT be required or applied to income/expense lines; taxes paid are treated as part of line cost.
   * *Registered Companies (C & D):* Output/Input VAT/GST must be accurately split to tax clearing/payable accounts and reflected on Tax Summary reports.
3. **Multi-Currency Compliance (IAS 21 / SFRS 21 / K3):**
   * Transactions in foreign currencies must record both foreign amount and base currency equivalent using historical exchange rates.
   * Realized FX gain/loss must be calculated upon bank settlement or ledger clearance.
4. **Period Lock Integrity:** Posted entries in locked accounting periods must be immutable.
