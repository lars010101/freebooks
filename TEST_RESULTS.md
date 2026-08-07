# Test Results: freeBooks UX & Regulatory Compliance (Detailed Audit)

**Execution Date:** July 28, 2026  
**Environment:** Linux 6.8.0 / Node.js v22.22.2 / DuckDB  
**Test Engine:** Playwright Automation & Manual Verb Assertion Engine  

---

## 1. Executive Summary

An exhaustive functional and UX audit of `freeBooks` was conducted across all 4 required scenarios starting from clean database resets. The testing validated:
1. **Full Vim Keybinding Parity:** Complete support for `i` (edit/insert), `w` (write/save), `u` (revert), `x` (delete/discard), `G` (bottom add row), `gg` (top row), `h/l` (tab switch), and `?` (shortcut overlay).
2. **Esc Non-Persistence Doctrine:** Re-verified across all screens that pressing `Esc` **never saves** uncommitted changes.
3. **Double-Entry & Regulatory Accounting Rules:** Verified strict double-entry balancing ($\text{Debits} = \text{Credits}$), non-VAT gross expense recording (Scenarios A/B), VAT/GST tax auto-splitting (Scenarios C/D), and multi-currency exchange rate overrides.

---

## 2. Detailed Execution Results Matrix

| Scenario | Company Profile | Jurisdiction & Tax | Currency Mode | Vim Verbs (`i`, `w`, `u`, `x`, `G`, `gg`, `Esc`, `?`) | Double-Entry & Tax Compliance | Overall Result |
|---|---|---|---|---|---|---|
| **Scenario A** | Swedish Company | `SE` / Non-VAT | `SEK` (Single) | **PASS** | **PASS** | **PASS** |
| **Scenario B** | Singaporean Company | `SG` / Non-GST | `SGD` (Single) | **PASS** | **PASS** | **PASS** |
| **Scenario C** | Swedish Company | `SE` / VAT Registered | `SEK` + Multi (`EUR`/`USD`) | **PASS** | **PASS** | **PASS** |
| **Scenario D** | Singaporean Company | `SG` / GST Registered | `SGD` + Multi (`EUR`/`USD`) | **PASS** | **PASS** | **PASS** |

---

## 3. Specific Verb & UX Observations

* **Vim Keyboard Navigation:**
  * `G` correctly lands cursor on the pinned `+ Add entry` row at the bottom of lists.
  * `gg` returns cursor instantly to the top data row.
  * `i` / `Enter` opens inline edit controls cleanly across all `FB.list` instances.
  * `Esc` cancels edit mode without writing to DB, placing changes into dirty buffer state or reverting new rows.
  * `w` triggers `/api/action` and saves dirty buffer.
  * `?` overlay displays all contextual hotkeys accurately.
* **Accounting Validation:**
  * Unbalanced journals are rejected by UX validation prior to network dispatch.
  * Tax calculations for Swedish 25% Moms (`SE-25`) and Singapore 9% GST (`SG-9`) reflect correctly on Tax Summary reports.
