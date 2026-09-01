# Reports & Dashboard Spec

**Status:** Direction ratified 2026-07-27 (chat with Magnus). Spec-first — no code changed yet.

## 1. Decision

Keep both sections, sharply delineated:

- **Dashboard** (`/:company`) — operational status page. KPI cards and alerts only, with drill-through links. **No embedded report viewer.**
- **Reports** (`/:company/reports`) — the single report viewer and report engine. All parameterized statements, exports, and all future statutory/authority outputs.

**Precedent:** QBO and Xero both maintain exactly this split — dashboard = glanceable operational widgets answering "how is the business doing right now, what needs my attention"; reports = authoritative, parameterized, printable/exportable outputs answering "what happened in period X per accounting standards". Neither merges the two.

## 2. Dashboard contract

- Content: KPI cards + alerts. Current cards: unlocked periods, uncleared bank transactions, bank balance, current-period P&L.
- Every card drills through to the relevant screen, or to a pre-parameterized report in the hub.
- No report parameter controls and no report rendering on the Dashboard.
- **Single computation path:** cards MUST consume `db/macros.sql` (`pl()`, `bs()`, …) or shared query modules — never bespoke SQL duplicating report logic. The bespoke bank-balance/revenue/expense SQL in `company.js` is a known divergence to eliminate (two computation paths can disagree with Reports).
- Future cards: overdue AR (after Receivables ships), VAT due, cash trend.

## 3. Reports hub contract

- The ONE report viewer: report type + period/custom dates + comparison (MoM/YoY) + export (Print/PDF, CSV).
- Report categories: **Financial statements** (PL, BS, CF, SCE) · **Audit** (TB, GL, Journal, Integrity) · **Tax & filings** (VAT return, AP/AR aging, future statutory outputs).
- Keyboard-first per standing doctrine (mouse parity dropped 2026-07-31, roadmap §0q); migrates onto fb-core/FB.list machinery per `review-roadmap.md`.

## 4. Report registry (architectural foundation)

A single declarative registry drives all report surfaces:

```
{ id, label, category, parameters, multiperiod: mom/yoy/none, exportFormats: [pdf, csv, …] }
```

- Consumed by: hub dropdown, Dashboard drill-through links. (The `:` command palette named here at design time no longer exists — see `global-search-spec.md`.)
- New statutory formats become **registry entries, not new pages**.

## 5. Annual financial reports

- A **composite report type** (BS + P&L + SCE + notes) rendered by the same engine, exported to PDF. — Shipped as `report?type=ar` (SE K2); **frozen 2026-07-30**: read-only viewer only, no further development. Gredor owns SE årsredovisning production/submission via the SIE 4 export (roadmap §0p).
- Respects `companies.reporting_standard` (K2/K3/IFRS) — the engine already knows which GAAP it renders for.

## 6. Digital authority submissions

- Per-jurisdiction **export adapters** hanging off registry entries — each filing is an export format, not a page.
- Existing seeds: `vat_codes.report_box` (maps tax codes to authority form boxes) and `report.refresh_vat_return` (already a `report.*` action). The VAT return is the first member of the **Tax & filings** category.
- Target examples: ACRA XBRL + IRAS GST (SG); ~~Bolagsverket annual report (SE)~~ — **removed 2026-07-30**: Gredor owns SE årsredovisning production/submission, fed by the SIE 4 export (`report?type=sie`, shipped). SE authority outputs in freebooks scope: SIE 4 + SRU/INK2 (both shipped). Submission-status tracking comes later, on top of the registry.

## 7. Migration backlog (when picked up)

1. Remove the embedded report viewer from the Dashboard (`company.js`); replace with drill-through links.
2. Rewire Dashboard cards onto `db/macros.sql` (kill bespoke SQL).
3. Migrate Dashboard to fb-core typography/UI core (flagged in `review-roadmap.md` as old form-style with pt violations).
4. Introduce the report registry; move hub dropdown + palette entries onto it.

**Status 2026-07-27 (items 1–4 shipped):** Dashboard viewer removed → grouped drill-through links per registry category; cards re-wired onto `pl()`/`bs()` — also fixes the old card SQL's mixed-transaction-currency sums (macros use `debit_home`/`credit_home`); Dashboard typography now rem/CSS-vars per `UI.md`; `api/src/report-registry.js` introduced — hub dropdown (categorized optgroups), MoM/YoY enablement and start-date requirements all derive from it. Palette has no per-report surface to migrate (reports aren't actions; the VAT return stays a `report.*` action). Hub fix bundled: `?t=` drill-through now reflects in the dropdown and auto-loads the report (plain visits still load manually).
