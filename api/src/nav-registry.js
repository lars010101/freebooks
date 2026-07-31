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
//   4. command palette — api/public/fb-core.js FB.palette lists entries where
//                       palette:true as 'Go to {label}' rows.
//
// Entry shape:
//   {
//     key:       string   — stable section id (sidebar active-state match,
//                           usage-tracking section, palette dedupe id)
//     route:     string   — route template; ':company' is the company segment
//                           placeholder (e.g. '/:company/bank'). Absolute
//                           company-less routes set absolute:true.
//     label:     string   — human label (sidebar text + palette 'Go to …')
//     icon:      string|null — sidebar glyph (null for non-sidebar routes)
//     sidebar:   bool     — render in the sidebar nav?
//     gKey:      string|null — go-to-map letter (e.g. 'b' for bank) or null.
//                           'c' is RESERVED for the company switcher (not a
//                           route). Non-sidebar routes get null.
//     palette:   bool     — surface as a 'Go to …' palette row?
//     absolute:  bool     — company-less route (e.g. /setup/new-company)
//   }
//
// How to add a route:
//   1. Append an entry here (keep sidebar entries in sidebar display order).
//   2. If it belongs in the sidebar, set sidebar:true + icon; navBar renders
//      it automatically.
//   3. Sidebar routes default to palette:true ('Go to …' rows). Non-sidebar
//      routes: set palette:true ONLY when no action-catalog 'navigate' entry
//      covers the same target (journal/new, bank/import and new-company are
//      covered by the catalog, so they stay palette:false here;
//      opening-balances has no catalog entry, so it is palette:true). The
//      palette itself does no runtime dedupe — this table is the decision.
//   4. Assign a gKey letter only for ratified go-to destinations; 'c' is
//      reserved for the company switcher.
//
// g-key slate (ratified 2026-07-28; d/v added same day — magnus review;
// g j activated 2026-07-31 with the A3j Journal register page):
//   g d = Dashboard · g r = Reports · g b = Bank · g j = Journal · g p = Payables
//   g v = Receivables · g s = Settings · g i = Bank Import
//   g c = Company switcher (reserved, not a route)

const ROUTES = [
  // ── Sidebar entries (display order = array order) ──
  { key: 'dashboard',   route: '/:company',             label: 'Dashboard',       icon: '📊', sidebar: true,  gKey: 'd',  palette: true,  absolute: false },
  { key: 'bank',        route: '/:company/bank',         label: 'Bank',            icon: '🏦', sidebar: true,  gKey: 'b',  palette: true,  absolute: false },
  { key: 'journal',     route: '/:company/journal',      label: 'Journal',         icon: '📒', sidebar: true,  gKey: 'j',  palette: true,  absolute: false },
  { key: 'payables',    route: '/:company/payables',     label: 'Payables',        icon: '📋', sidebar: true,  gKey: 'p',  palette: true,  absolute: false },
  { key: 'receivables', route: '/:company/receivables',  label: 'Receivables',     icon: '📄', sidebar: true,  gKey: 'v',  palette: true,  absolute: false },
  { key: 'reports',     route: '/:company/reports',      label: 'Reports',         icon: '📈', sidebar: true,  gKey: 'r',  palette: true,  absolute: false },
  { key: 'settings',    route: '/:company/settings',     label: 'Settings',        icon: '⚙',  sidebar: true,  gKey: 's',  palette: true,  absolute: false },
  // ── Non-sidebar routes. journal-new / new-company keep palette:false — the
  // action catalog already navigates to them with action labels (dedupe =
  // registry decision, spec §4). bank-import now carries palette:true +
  // gKey:'i' — the registry emits the 'Go to Bank Import' row (the former
  // catalog navigate entry's description lacked 'import', making it
  // invisible to palette search). opening-balances has no catalog entry →
  // palette:true.
  { key: 'journal-new',     route: '/:company/journal/new',       label: 'Journal Entry',   icon: null, sidebar: false, gKey: null, palette: false, absolute: false },
  { key: 'bank-import',     route: '/:company/bank?tab=import',     label: 'Bank Import',     icon: null, sidebar: false, gKey: 'i',  palette: true,  absolute: false },
  { key: 'opening-balances', route: '/:company/settings?tab=opening-balances', label: 'Opening Balances', icon: null, sidebar: false, gKey: null, palette: true,  absolute: false },
  { key: 'new-company',     route: '/setup/new-company',          label: 'New Company',     icon: null, sidebar: false, gKey: null, palette: false, absolute: true  },
];

module.exports = { ROUTES };