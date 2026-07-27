'use strict';

// ── Report registry (docs/reports-dashboard-spec.md §4) ─────────────────────
// THE single declarative list of reports. Consumed by:
//   - Reports hub dropdown + comparison/parameter behavior (pages/reports-hub.js)
//   - Dashboard drill-through links (pages/company.js)
// Future consumers: command palette, export adapters (annual report package,
// authority filings — VAT return, ACRA XBRL, Bolagsverket).
// A new report = a registry entry, not a new page.

const REPORT_CATEGORIES = {
  financial: 'Financial statements',
  audit:     'Audit',
  filings:   'Tax & filings',
};

// multiperiod — MoM/YoY comparison supported (hub enables the step buttons)
// needsStart  — report requires a start date (false = end-date/as-of only)
const REPORT_REGISTRY = [
  { id: 'pl',        label: 'Profit & Loss',       category: 'financial', multiperiod: true,  needsStart: true  },
  { id: 'bs',        label: 'Balance Sheet',       category: 'financial', multiperiod: true,  needsStart: true  },
  { id: 'cf',        label: 'Cash Flow',           category: 'financial', multiperiod: true,  needsStart: true  },
  { id: 'sce',       label: 'Statement of Equity', category: 'financial', multiperiod: false, needsStart: true  },
  { id: 'tb',        label: 'Trial Balance',       category: 'audit',     multiperiod: false, needsStart: true  },
  { id: 'gl',        label: 'General Ledger',      category: 'audit',     multiperiod: false, needsStart: true  },
  { id: 'journal',   label: 'Journal Listing',     category: 'audit',     multiperiod: false, needsStart: true  },
  { id: 'integrity', label: 'Integrity Check',     category: 'audit',     multiperiod: false, needsStart: true  },
  { id: 'ap-aging',  label: 'AP Aging',            category: 'filings',   multiperiod: false, needsStart: false },
];

// Ordered, non-empty groups: [{ category, label, reports: [...] }]
function reportsByCategory() {
  return Object.entries(REPORT_CATEGORIES)
    .map(([key, label]) => ({
      category: key,
      label,
      reports: REPORT_REGISTRY.filter(r => r.category === key),
    }))
    .filter(g => g.reports.length > 0);
}

module.exports = { REPORT_CATEGORIES, REPORT_REGISTRY, reportsByCategory };
