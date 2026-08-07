# Bank Page Dissolution — Spec

**Status:** PROPOSED 2026-08-05
**Context:** Phase B (B1–B8) shipped the agent-first bank-matching pipeline. The Bank page's three tabs (Import, Mappings, Transactions) are now superseded. This spec dissolves the Bank sidebar item and relocates the one surviving feature (reconciliation).

## What shipped in Phase B that replaces the Bank page

| Bank page tab | Old manual path | Phase B replacement |
|---------------|-----------------|----------------------|
| Import | `bank.process` — human uploads CSV, server matches | B5 drop-folder watcher (`scripts/freebooks-feed-watch.sh`) uploads to `entityType: bank_statement` → B7 agent loop parses CSV → `bank.match` per line → `journal.propose` |
| Mappings | Manual CRUD on `bank_mappings` table | B2 `mapping.suggest` (agent) → inbox `mapping_suggestion` Class B item → human `y`/`x` approve/reject |
| Transactions | `bank.uncleared.list` — uncleared journal entries on bank accounts, with reconcile/clear toggle | **No direct replacement yet** — this is the one surviving feature (see §2) |

## 1. Sidebar removal

### Nav-registry change

Remove the `bank` entry from the sidebar in `api/src/nav-registry.js`:

```diff
-  { key: 'bank',        route: '/:company/bank',         label: 'Bank',            icon: '🏦', sidebar: true,  gKey: 'b',  palette: true,  absolute: false },
```

**gKey `b` is freed.** No immediate reassignment — same pattern as `g d` (Dashboard dropped) and `g v` (Receivables dropped): the letter stays free until a new sidebar item earns it. Do NOT speculatively reassign.

**Route stays.** The `bank` route (`/:company/bank`) is NOT deleted — it stays in the registry with `sidebar: false, palette: false`. Anyone who has a bookmark or types the URL can still reach the page. The underlying actions (`bank.process`, `bank.reconcile.*`, `bank.uncleared.list`, `bank.match`) stay in the code and catalog. The page is just not surfaced in the sidebar or palette — it's orphaned-by-design, same as the old Journal queue route was when it moved to the inbox.

**bank-import palette entry.** The `bank-import` entry (`/:company/bank?tab=import`, `palette: true`) is set to `palette: false`. The import path is now the drop-folder watcher; the manual import wizard is a fallback for operators who want it, reachable by URL but not surfaced.

### What the user sees

The sidebar goes from:
```
📥 Inbox
🏦 Bank        ← removed
📋 Payables
📈 Reports
📅 Periods
⚙ Settings
```
to:
```
📥 Inbox
📋 Payables
📈 Reports
📅 Periods
⚙ Settings
```

The empty state on the Bank page referenced "click ⬆ Import statement" — that page is now orphaned, so no user-visible empty state needs updating. The Inbox's empty state should mention the drop-folder path ("Drop bank statements in ~/freebooks-inbox/bank/ and the agent will process them") — but that's an Inbox page change, not a Bank page change.

## 2. Reconciliation — relocate to a report

### What reconciliation does

`bank.uncleared.list` returns journal entries on bank accounts (accounts with `cf_category='Cash'`) that have no matching row in the `reconciliations` table. `bank.reconcile.clear` marks an entry cleared (INSERT into `reconciliations`); un-clearing DELETEs the row. The Bank page rendered these as a filtered FB.list with a cleared/uncleared checkbox toggle and a statement-closing-balance input.

This is a human review task that doesn't go away with agent-first — it answers "do my ledger entries match what the bank says?" The agent proposes journal entries from bank statements; reconciliation confirms those entries (and any manual ones) against the bank's closing balance.

### New report: Bank Reconciliation

Add a `reconciliation` report to the report registry (`api/src/report-registry.js`):

```js
{ id: 'reconciliation', label: 'Bank Reconciliation', category: 'audit', multiperiod: false, needsStart: false },
```

Category: `audit` — it's a review/verification report, same category as the GL and Trial Balance.

The report renders as a filtered GL view for bank accounts (accounts with `cf_category='Cash'`), with:
- A **cleared/uncleared toggle** per row (the existing `bank.reconcile.clear` / un-clear action, same checkbox UX)
- A **statement closing balance input** at the top (for the human to enter the bank's closing balance)
- A **reconciled difference** line at the bottom (sum of uncleared entries vs. statement closing balance — should be zero when reconciled)
- An **account selector** (if multiple bank accounts exist — same `?account=` drill-through as the GL report)

### Why a report, not an inbox item

Reconciliation is not an action item — it's a periodic review task. The inbox is for items that need a decision (approve/reject/retry/discard). Reconciliation is "review this list and check off what matches the bank statement." That's a report with interactive toggles, not a queue item.

The existing report hub (`/:company/reports`) already has the infrastructure: report-type dropdown, date range, account filter, iframe render. Adding `reconciliation` as a report type means:
- It's reachable via `g r` (Reports) — one keypress
- It uses the same drill-through, filter, and export infrastructure as the GL
- It doesn't add a sidebar item or a new page

### What the report calls

The report backend calls the existing actions:
- `bank.uncleared.list` (or `journal.list` filtered to Cash accounts) — for the entry list
- `bank.reconcile.clear` / un-clear — for the toggle action (called from the report's inline JS, same as the Bank page did)

No new actions. The report is a presentation layer over existing server-side logic.

### Implementation

The report hub (`api/src/pages/reports-hub.js`) and report backend (`api/src/reports.js` / `api/src/report-composite.js`) need:
1. The `reconciliation` entry in `report-registry.js` (one line)
2. A report builder function (`buildReconciliation` in the report rendering pipeline) that queries Cash-account journal entries with their cleared state, computes the uncleared total, and renders the same FB.list-with-checkboxes UX the Bank page had
3. The report hub forwards `?account=` to filter by a specific bank account (same drill-through contract as the GL report)

The Bank page's reconciliation JS (the checkbox toggle, the statement-balance input, the cleared/uncleared filter) moves into the report's render output. The server-side actions (`bank.reconcile.list`, `bank.reconcile.clear`, `bank.uncleared.list`) are unchanged — the report calls them directly.

## 3. What stays in the code

| Asset | Disposition |
|-------|-------------|
| `api/src/bank.js` — all handlers | **Stays.** `bank.match` (B4) is new and active. `bank.process`, `bank.approve`, `bank.reconcile.*`, `bank.uncleared.list` stay as the server-side backing for the report and the orphaned page. No code deletion. |
| `api/src/pages/bank.js` — the page module | **Stays, orphaned.** The route exists with `sidebar: false, palette: false`. Anyone who navigates to `/:company/bank` still gets the page. It's not deleted — it's just not surfaced. Future cleanup can remove it if confirmed unused. |
| `api/src/pages/bank-import.js` — import wizard | **Stays, orphaned.** Same disposition. The drop-folder watcher (B5) is the primary path; the manual wizard is a fallback. |
| `bank_mappings` table | **Stays.** Still the source of truth for tier-1 learned rules. The Mappings tab's manual CRUD is replaced by the inbox suggest/approve flow (B2), but the table itself is unchanged. |
| `reconciliations` table | **Stays.** Backs the new reconciliation report. |
| `bank.process` action | **Stays** in the catalog and handler. Orphaned from the UI but callable via API/palette. |
| `bank-import` palette entry | **Set `palette: false`.** Not surfaced. Route stays. |

## 4. g-key slate after this change

```
g i = Inbox (root route)
g d = (free — Dashboard dropped)
g r = Reports
g b = (free — Bank dropped, this spec)
g p = Periods
g v = (free — Receivables dropped)
g s = Settings
g j = (free — Journal dissolved into Reports)
g c = Company switcher (reserved)
```

Four free letters: `d`, `b`, `v`, `j`. No speculative reassignment.

## 5. Sequencing

1. Add `reconciliation` report to the report registry + report builder (the relocation)
2. Verify the report works (renders the uncleared list, toggle works, closing-balance input works)
3. Remove `bank` from sidebar (nav-registry: `sidebar: false, palette: false`)
4. Set `bank-import` to `palette: false`
5. Update docs (ia-spec nav-registry section, this spec)

Each step is a commit; steps 1–2 are one PR (the report), steps 3–4 are a second PR (the sidebar removal, which depends on the report being available so no user is stranded). Step 5 rides along with step 3–4.

## 6. Inbox empty-state update (non-blocking)

The Inbox page's empty state (when there are zero pending items) should mention the drop-folder path for bank statements and bills:

> "Drop bank statements in `~/freebooks-inbox/bank/` or supplier invoices in `~/freebooks-inbox/bills/`. The agent will process them and proposals will appear here."

This is a page-level text change in `api/src/pages/inbox.js`, not a structural change. Can ship in the same PR as the sidebar removal or independently.

## 7. What this spec does NOT do

- Does not delete `api/src/pages/bank.js` or `api/src/pages/bank-import.js` — they're orphaned, not removed. Deletion is a future cleanup after confirming no user reaches them.
- Does not change `bank.process` or `bank.approve` — they stay in the catalog. An operator who wants the old manual import path can still use it via URL.
- Does not remove the Mappings tab from the Bank page — the page is orphaned; whatever it renders is irrelevant. The active mapping path is the inbox suggest/approve flow (B2).
- Does not spec a reconciliation **alert** (e.g. "you have N uncleared entries older than 30 days" as an inbox item). That's a future enhancement — the report is sufficient for v1.
