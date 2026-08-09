'use strict';
// ── Route registry — the single source of truth for app navigation ──────────
// K1 (keyboard-nav program). Every app route lives here once. Five consumers
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
//   5. :show command  — api/public/fb-command.js parseShow reads window.FB_ROUTES
//                       (injected by navBar) and resolves screen/tab targets
//                       from the key + tabs arrays (e.g. :show coa → /settings?tab=coa).
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
//     tabs:      array    — optional sub-tab targets for :show navigation.
//                           Shape: [{ id, label, aliases? }] where id matches
//                           the showTab/showPayTab calls in the page JS.
//                           aliases are alternate names (e.g. 'accounts' → 'coa').
//   }
//
// How to add a route:
//   1. Append an entry here (keep sidebar entries in sidebar display order).
//   2. If it belongs in the sidebar, set sidebar:true + icon; navBar renders
//      it automatically.
//   3. Sidebar routes are visible in the ? help overlay's NAV section
//      (g-key destinations). Non-sidebar routes without a gKey (e.g.
//      opening-balances) are sidebar/palette-reachable only; they do not
//      appear in ? NAV. The : palette no longer lists routes (#149).
//   4. Assign a gKey letter only for ratified go-to destinations; 'c' is
//      reserved for the company switcher.
//
// g-key slate (ratified 2026-07-28; d/v added same day — magnus review):
//   g d = (free — Dashboard dropped 2026-08-03) · g r = Reports ·
//   g b = (free — Bank page dissolved 2026-08-09, page modules deleted;
//             api/src/bank.js server handlers kept) ·
//   g p = Periods (reassigned from Payables 2026-08-04, IA-spec step 4) ·
//   g v = (free — Receivables dropped 2026-08-05) · g s = Settings
//   g i = Inbox (now the root route /:company; was /:company/inbox)
//   g j = (free — Journal dissolved into Reports as Voucher Register, 2026-08-03)
//   g c = Company switcher (reserved, not a route)
// Payables lost its gKey 'p' 2026-08-04 (step 4): 'p' now opens Periods.
//   Payables stays sidebar+palette (reachable via sidebar click + palette search).
// Receivables dropped 2026-08-05: sidebar entry + gKey 'v' removed; route + page handler deleted.
// Bank page dropped 2026-08-09 (issue #137): sidebar entry + gKey 'b' removed; page modules
//   (pages/bank.js, pages/bank-import.js) deleted. api/src/bank.js server handlers kept
//   (bank.match, bank.reconcile.*). Old /:company/bank URL 302-redirects to /:company/reports.

const ROUTES = [
  // ── Sidebar entries (display order = array order) ──
  // A5 §10: Inbox is the human's review queue (sidebar first, 📥, g i). The
  // Journal-list queue half moved here; the Journal list is the pure register.
  // 2026-08-03: Dashboard dropped; Inbox is now the root route (/:company).
  { key: 'inbox',       route: '/:company',             label: 'Inbox',           icon: '📥', sidebar: true,  gKey: 'i',  palette: true,  absolute: false },
  { key: 'payables',    route: '/:company/payables',     label: 'Payables',        icon: '📋', sidebar: true,  gKey: null, palette: true,  absolute: false,
    tabs: [
      { id: 'bills',    label: 'Bills' },
      { id: 'partners', label: 'Partners' }
    ] },
  { key: 'reports',     route: '/:company/reports',      label: 'Reports',         icon: '📈', sidebar: true,  gKey: 'r',  palette: true,  absolute: false },
  // 2026-08-04 (IA-spec step 4): Periods promoted to a top-level sidebar route.
  //   g p was reassigned from Payables (kept sidebar+palette, gKey nulled) to
  //   Periods. The Settings Periods tab was removed and now 302-redirects here.
  //   The grid config is lifted into api/src/pages/periods-grid.js (shared
  //   module) so this page and Settings don't drift.
  { key: 'periods',     route: '/:company/periods',      label: 'Periods',         icon: '📅', sidebar: true,  gKey: 'p',  palette: true,  absolute: false },
  { key: 'settings',    route: '/:company/settings',     label: 'Settings',        icon: '⚙',  sidebar: true,  gKey: 's',  palette: true,  absolute: false,
    tabs: [
      { id: 'company',          label: 'Company' },
      { id: 'coa',              label: 'Chart of Accounts', aliases: ['accounts'] },
      { id: 'vat',              label: 'Tax Codes' },
      { id: 'journals',         label: 'Journals',          aliases: ['books'] },
      { id: 'fxrates',          label: 'Exchange Rates',    aliases: ['rates'] },
      { id: 'ai',               label: 'AI' },
      { id: 'opening-balances', label: 'Opening Balances',  aliases: ['ob'] }
    ] },
  // ── Non-sidebar routes. journal-new / new-company keep palette:false — the
  // action catalog already navigates to them with action labels (dedupe =
  // registry decision, spec §4). opening-balances has no catalog entry →
  // palette:true.
  { key: 'journal-new',     route: '/:company/journal/new',       label: 'Journal Entry',   icon: null, sidebar: false, gKey: null, palette: false, absolute: false },
  { key: 'opening-balances', route: '/:company/settings?tab=opening-balances', label: 'Opening Balances', icon: null, sidebar: false, gKey: null, palette: true,  absolute: false },
  { key: 'new-company',     route: '/setup/new-company',          label: 'New Company',     icon: null, sidebar: false, gKey: null, palette: false, absolute: true  },
];

module.exports = { ROUTES };
