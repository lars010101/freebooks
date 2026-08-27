'use strict';
// ── Route registry — the single source of truth for app navigation ──────────
// K1 (keyboard-nav program). Every app route lives here once. Four consumers
// share this table so they can never drift:
//   1. sidebar        — api/src/pages/common.js navBar() renders the sidebar
//                       anchors from the entries where sidebar:true.
//   2. {/} cycling    — common.js reads the rendered .sb-nav anchors (which
//                       come from this registry) for prev/next page nav.
//   3. g-prefix map   — api/public/fb-core.js reads window.FB_ROUTES (injected
//                       by navBar) and maps gKey letters → routes.
//   4. ? help overlay  — api/public/fb-core.js help.open() reads
//                       window.FB_ROUTES and renders g-key destinations
//                       as NAV rows (#149; relocated from : palette).
//
// Entry shape:
//   {
//     key:          string   — stable section id (sidebar active-state match,
//                              usage-tracking section, palette dedupe id)
//     route:        string   — route template; ':company' is the company segment
//                              placeholder (e.g. '/:company/bank'). Absolute
//                              company-less routes set absolute:true.
//     label:        string   — human label (sidebar text + palette 'Go to …')
//     icon:         string|null — sidebar glyph (null for non-sidebar routes)
//     sidebar:      bool     — render in the sidebar nav?
//     gKey:         string|null — go-to-map letter (e.g. 'b' for bank) or null.
//                              'c' is RESERVED for the company switcher (not a
//                              route). Non-sidebar routes get null.
//     palette:      bool     — surface as a 'Go to …' palette row?
//     absolute:     bool     — company-less route (e.g. /setup/new-company)
//     dateRelevance: 'range'|'asOf'|'none' — stub for the follow-up chrome
//                              spec's global Period Selector (§9 of
//                              ia-restructure-2-spec.md). Consumed by nothing
//                              yet; declared now so pages aren't touched twice.
//   }
//
// How to add a route:
//   1. Append an entry here (keep sidebar entries in sidebar display order).
//   2. If it belongs in the sidebar, set sidebar:true + icon; navBar renders
//      it automatically.
//   3. Sidebar routes are visible in the ? help overlay's NAV section
//      (g-key destinations). Non-sidebar routes without a gKey are
//      sidebar/palette-reachable only; they do not appear in ? NAV. The :
//      palette no longer lists routes (#149).
//   4. Assign a gKey letter only for ratified go-to destinations; 'c' is
//      reserved for the company switcher.
//
// g-key slate (ratified 2026-08-27 IA restructure 2):
//   g i = Inbox              · g b = Books (was Reports, trimmed)
//   g p = Payables (was Bills)   · g f = Fiscal (was Periods/Filings)
//   g t = Statements (new)   · g s = Settings
//   g a = Accounting (new — reuses Admin's freed key)
//   g x = Exchange Rates (new)
//   g c = Company switcher (reserved, not a route — unchanged)
//   g r = reserved for future Receivables (freed from Reports moving to `b`)
//   g m = FREE (Master Data dissolved) · g v = FREE · g d / g j = still free
// 2026-08-27 IA restructure 2: Bills → Payables (gKey `p`); Reports split into
//   Statements (gKey `t`) + Books (gKey `b`); Periods → Fiscal (gKey `f`);
//   Settings slimmed (Company · Access · Extensions); Accounting new (gKey `a`,
//   reuses Admin's freed key — COA · Tax Codes · Journals · Cost/Profit Centers);
//   Exchange Rates promoted standalone (gKey `x`); Master Data dissolved;
//   Admin dissolved (Companies → switcher, Access → Settings, Operations dropped).
//   No compatibility redirects — single-user install, clean cutover.
// Receivables dropped 2026-08-05: sidebar entry + gKey 'v' removed; route + page handler deleted.
// Bank page dropped 2026-08-09 (issue #137): sidebar entry + gKey 'b' removed; page modules
//   (pages/bank.js, pages/bank-import.js) deleted. api/src/bank.js server handlers kept
//   (bank.match, bank.reconcile.*).

const ROUTES = [
  // ── Sidebar entries (display order = array order) ──
  // A5 §10: Inbox is the human's review queue (sidebar first, 📥, g i). The
  // Journal-list queue half moved here; the Journal list is the pure register.
  // 2026-08-03: Dashboard dropped; Inbox is now the root route (/:company).
  { key: 'inbox',          route: '/:company',             label: 'Inbox',           icon: '📥', sidebar: true,  gKey: 'i',  palette: true,  absolute: false, dateRelevance: 'none' },
  // 2026-08-27 IA restructure 2: Bills renamed Payables (gKey `p`, freed by Fiscal
  //   moving off it). Re-expanded to four tabs: Bills · Vendors · Aging · Control.
  { key: 'payables',       route: '/:company/payables',    label: 'Payables',        icon: '📋', sidebar: true,  gKey: 'p',  palette: true,  absolute: false, dateRelevance: 'range' },
  // 2026-08-27 IA restructure 2: Reports split into Statements + Books. Statements
  //   (gKey `t`) — P&L · Balance Sheet · Cash Flow · Statement of Equity.
  //   dateRelevance is per-report (REPORT_REGISTRY's multiperiod/needsStart), not
  //   a page-level flag — 'none' here is a placeholder, the chrome spec reads the
  //   registry directly.
  { key: 'statements',     route: '/:company/statements',  label: 'Statements',      icon: '📊', sidebar: true,  gKey: 't',  palette: true,  absolute: false, dateRelevance: 'none' },
  // 2026-08-27 IA restructure 2: Reports trimmed and renamed Books (gKey `b`, freed
  //   by Payables moving off it). Ledger/audit tooling: Transaction Register ·
  //   Trial Balance · General Ledger · Journal Line Listing · Integrity Check.
  { key: 'books',          route: '/:company/books',       label: 'Books',           icon: '📈', sidebar: true,  gKey: 'b',  palette: true,  absolute: false, dateRelevance: 'none' },
  // 2026-08-27 IA restructure 2: Periods renamed Fiscal (gKey `f`). Fully flattened
  //   — Periods · Filings · Close Checklist, no tree expansion.
  { key: 'fiscal',         route: '/:company/fiscal',      label: 'Fiscal',          icon: '📅', sidebar: true,  gKey: 'f',  palette: true,  absolute: false, dateRelevance: 'none' },
  // 2026-08-27 IA restructure 2: Settings slimmed — Company · Access · Extensions.
  { key: 'settings',       route: '/:company/settings',    label: 'Settings',        icon: '⚙',  sidebar: true,  gKey: 's',  palette: true,  absolute: false, dateRelevance: 'none' },
  // 2026-08-27 IA restructure 2: Accounting (gKey `a`, reuses Admin's freed key) —
  //   Chart of Accounts · Tax Codes (VAT+WHT merged) · Journals · Cost/Profit Centers.
  { key: 'accounting',     route: '/:company/accounting',  label: 'Accounting',      icon: '🗂', sidebar: true,  gKey: 'a',  palette: true,  absolute: false, dateRelevance: 'none' },
  // 2026-08-27 IA restructure 2: Exchange Rates promoted standalone (gKey `x`) —
  //   no tabs, single page (was the sole tenant of dissolved Master Data).
  { key: 'exchange-rates', route: '/:company/exchange-rates', label: 'Exchange Rates', icon: '💱', sidebar: true,  gKey: 'x',  palette: true,  absolute: false, dateRelevance: 'range' },
  // ── Non-sidebar routes. journal-voucher / new-company keep palette:false — the
  // action catalog already navigates to them with action labels (dedupe =\n
  // registry decision, spec §4).
  { key: 'journal-voucher', route: '/:company/journal/voucher',   label: 'Journal Entry',   icon: null, sidebar: false, gKey: null, palette: false, absolute: false, dateRelevance: 'none' },
  { key: 'new-company',     route: '/setup/new-company',          label: 'New Company',     icon: null, sidebar: false, gKey: null, palette: false, absolute: true,  dateRelevance: 'none' },
];

module.exports = { ROUTES };
