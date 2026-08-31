'use strict';

// ── Report registry (docs/reports-dashboard-spec.md §4) ─────────────────────
// THE single declarative list of reports. Consumed by:
//   - Statements hub + Books hub (pages/reports-hub.js, split 2026-08-27)
//   - Dashboard drill-through links (pages/company.js)
// Future consumers: command palette, export adapters (annual report package,
// authority filings — VAT return, ACRA XBRL, Bolagsverket).
// A new report = a registry entry, not a new page.
//
// 2026-08-27 IA restructure 2: REPORT_REGISTRY split into two page scopes:
//   - Statements (id group: pl, bs, cf, sce) — financial statement output
//   - Books (id group: voucher-register, tb, gl, journal, integrity) — ledger/audit
//   Removed: ap-aging, ap-control (→ Payables tabs), ar (→ Fiscal Filings only).
// REPORT_CATEGORIES is retained for backward compat but no longer drives optgroups
// — the page (Statements vs Books) is the category now.
// 2026-08-30 IA restructure 3: Books renamed Journal — page value 'books' →
//   'journal' for voucher-register/tb/gl/journal; labels relabeled (Transaction
//   Register → Transactions, Journal Line Listing → Line items). integrity's
//   page moves to 'accounting' (bespoke fetch-rendered tab there, not a
//   report-hub page — see docs/ia-restructure-3-spec.md §3.3) and its label
//   shortens to "Integrity". SIE export gate follows the page-key rename in
//   reports-hub.js (pageKey === 'journal').

const REPORT_CATEGORIES = {
  financial: 'Financial statements',
  audit:     'Audit',
  filings:   'Tax & filings',
};

// multiperiod — MoM/YoY comparison supported (hub enables the step buttons)
// needsStart  — report requires a start date (false = end-date/as-of only)
// page        — which hub page this report belongs to ('statements' | 'journal';
//               'accounting' for integrity — a bespoke tab there, not a report-hub page)
const REPORT_REGISTRY = [
  // ── Statements (financial statement output) ──
  { id: 'pl',        label: 'Profit & Loss',       category: 'financial', page: 'statements', multiperiod: true,  needsStart: true  },
  { id: 'bs',        label: 'Balance Sheet',       category: 'financial', page: 'statements', multiperiod: true,  needsStart: true  },
  { id: 'cf',        label: 'Cash Flow',           category: 'financial', page: 'statements', multiperiod: true,  needsStart: true  },
  { id: 'sce',       label: 'Statement of Equity', category: 'financial', page: 'statements', multiperiod: false, needsStart: true  },
  // ── Journal (ledger/transactional tooling, was Books) ──
  { id: 'voucher-register', label: 'Transactions',       category: 'audit', page: 'journal', multiperiod: false, needsStart: true  },
  { id: 'journal',   label: 'Line items',          category: 'audit', page: 'journal', multiperiod: false, needsStart: true  },
  { id: 'tb',        label: 'Trial Balance',       category: 'audit', page: 'journal', multiperiod: false, needsStart: true  },
  { id: 'gl',        label: 'General Ledger',      category: 'audit', page: 'journal', multiperiod: false, needsStart: true  },
  // Integrity: relocated to Accounting (a bespoke fetch-rendered tab, not a
  // report-hub page) — page value doesn't select a hub's dropdown/tabs, it's
  // read directly by id. See docs/ia-restructure-3-spec.md §3.3.
  { id: 'integrity', label: 'Integrity',           category: 'audit', page: 'accounting', multiperiod: false, needsStart: true  },
];

// Reports filtered by page scope — used by the Statements and Books hub pages.
function reportsByPage(page) {
  return REPORT_REGISTRY.filter(r => r.page === page);
}

// Ordered, non-empty groups: [{ category, label, reports: [...] }]
// Retained for backward compat (e.g. API endpoint /api/:company/reports/registry).
function reportsByCategory() {
  return Object.entries(REPORT_CATEGORIES)
    .map(([key, label]) => ({
      category: key,
      label,
      reports: REPORT_REGISTRY.filter(r => r.category === key),
    }))
    .filter(g => g.reports.length > 0);
}

module.exports = { REPORT_CATEGORIES, REPORT_REGISTRY, reportsByCategory, reportsByPage };
