# Test Specifications: freeBooks UX & Regulatory Compliance (Exhaustive)

**Document Version:** 2.0 (Verbs & State Machine Detailed Specification)  
**Target System:** freeBooks  
**Scenarios Covered:** Scenario A (SE non-VAT), Scenario B (SG non-GST), Scenario C (SE VAT multi-currency), Scenario D (SG GST multi-currency)  

---

## 1. Vim Modal Keybindings & State Machine Specification

`freeBooks` uses a strict two-mode Vim modal architecture (`NORMAL` and `INSERT`) managed centrally by `FB.mode` and `FB.keys`.

### 1.1 State Transitions & Esc Doctrine
* **Clean State:** Row rendered as immutable plain text.
* **`i` / `Enter` / Click Cell:** Enters `INSERT` mode on the focused row (turns inputs active).
* **`Esc` (In Edit Mode):** Exits `INSERT` mode to `NORMAL` mode. **`Esc` NEVER writes or persists data.** Unsaved edits remain in the in-memory dirty buffer.
* **`w` (Write):** **The only save trigger.** Commits dirty buffer to DB via `/api/action`.
* **`u` (Undo/Revert):** Reverts dirty buffer back to saved row values.
* **`x` (Delete/Discard):** On a saved row, prompts/deletes the record. On a dirty-new row, discards the uncommitted row and returns focus to the Add row.
* **`G` / `gg`:** Jumps cursor to the bottom Add row (`G`) or top row (`gg`).
* **`h` / `l` & `{` / `}`:** Switches active top-level tabs (`h`/`l`) or sidebar sections (`{`/`}`).
* **`?` (Shift+?):** Triggers the interactive keyboard shortcut overlay showing live bindings.

---

## 2. Test Execution Suites Across Scenarios A–D

### Suite TS-01: Settings & COA
* **TC-SET-01 (Company Attribute Editing):** Test editing Company Name, Jurisdiction (`SE`/`SG`), Base Currency (`SEK`/`SGD`), Tax Registration, and Multi-Currency toggle using `i`, field inputs, and `w`.
* **TC-SET-02 (COA Vim State Machine):**
  1. Press `G` to navigate to bottom Add row.
  2. Press `i` to transform Add row into live edit row.
  3. Enter new account code and name.
  4. Press `Esc` — verify changes are **not saved** and buffer enters dirty state.
  5. Press `u` — verify dirty buffer reverts.
  6. Press `i` $\rightarrow$ type account $\rightarrow$ press `w` — verify persistence.

### Suite TS-02: Bank Module
* **TC-BNK-01 (Bank Account Creation):** Create native currency bank accounts (`SEK`/`SGD`) and foreign currency accounts (`EUR`/`USD` for Scenarios C & D).
* **TC-BNK-02 (Transaction Posting & Reconciliation):** Create deposits/withdrawals using `i` and `w`. Verify cleared/uncleared status toggle (`Space` or click).

### Suite TS-03: Manual Journal Entries
* **TC-JRN-01 (Double-Entry Equilibrium Rule):** Attempt to save an entry where $\sum \text{Debits} \neq \sum \text{Credits}$. Assert UX validation blocks posting and displays imbalance error.
* **TC-JRN-02 (Tax Code Auto-Computation - Scenarios C & D):** Apply `SE-25` (25% Swedish Moms) or `SG-9` (9% Singapore GST) on expense lines. Verify automatic line calculation and tax summary account splitting.
* **TC-JRN-03 (Multi-Currency Rate Overrides - Scenarios C & D):** Enter foreign currency transaction (`EUR`/`USD`). Override exchange rate. Verify base currency equivalent computation on GL impact.

### Suite TS-04: Reports & Dashboard
* **TC-RPT-01 (Financial Statement Consistency):** Verify Trial Balance, General Ledger, Profit & Loss, and Balance Sheet reflect exact double-entry postings.
* **TC-DSH-01 (Dashboard KPI Precision):** Assert live sync of Bank Balances and Net Income cards on Dashboard after posting journals.
