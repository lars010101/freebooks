'use strict';
/**
 * freeBooks — shared Periods grid (IA-spec step 4, §5.10)
 *
 * The periods FB.list config lived inline in settings.js until 2026-08-04.
 * Step 4 promoted Periods to a top-level section; the grid config lifts out
 * into this module so the section page owns it and no copy survives in
 * Settings (Magnus's no-duplication doctrine). The contract is byte-for-byte
 * the former Settings tab: Esc never saves, w writes via period.upsert,
 * u reverts, period names immutable on saved rows.
 *
 * calendar-reminders-documents-spec.md §3: the FX status column (and its
 * client-side fx.coverage polling) was dropped — it duplicated a signal the
 * notification bell already carries via the server-side fx-scanner.js, which
 * runs regardless of whether this grid is ever opened.
 *
 * The returned object is a template-literal client script fragment: pages
 * interpolate it into their <script> block and call initPeriodsGrid(opts).
 *
 * opts: { keysId, activeExpr, onChromeBody, tree } — page-specific chrome hooks.
 *   activeExpr:   JS expression string evaluated client-side for FB.list `active`
 *   onChromeBody: JS function body called with (dirty) for page chrome (tab dots)
 *   tree:         true on the Periods section page (row expansion → filings +
 *                 checklist child rows; the page defines periodsChildren +
 *                 periodsChildRowHtml). Omitted/false → plain flat grid.
 */

function periodsGridClientJS(opts) {
  const activeExpr = opts.activeExpr || 'true';
  return `
// ========== PERIODS GRID — shared config (pages/periods-grid.js) ==========
// Esc never saves: it exits edit mode leaving a dirty buffer; w writes,
// u reverts. Period names are immutable on saved rows (server upsert keys on
// period_name — rename needs delete+create; a deliberate feature later).
var periodsList = FB.list.create({
  keysId: '${opts.keysId || 'periods'}',
  active: function() { return ${activeExpr}; },
  tbody: 'periods-body',
  companyId: function() { return COMPANY; },${opts.tree ? '\n  tree: true,' : ''}
  columns: [
    { field: 'period_name', type: 'text', width: 110, ro: 'saved' },
    { field: 'start_date', type: 'date', width: null, filterType: 'date',
      display: function(v) { return v ? esc(FB.util.fmtDate(v)) : '<span class="pe-ro">—</span>'; } },
    { field: 'end_date', type: 'date', width: null, filterType: 'date',
      display: function(v) { return v ? esc(FB.util.fmtDate(v)) : '<span class="pe-ro">—</span>'; } },
    { field: 'locked', type: 'checkbox', align: 'center',
      display: function(v) { return '<input type="checkbox" disabled' + (v ? ' checked' : '') + '>'; } }
  ],
  blank: function() { return { period_name: '', start_date: '', end_date: '', locked: false }; },
  isBlank: function(b) { return !b.period_name && !b.start_date && !b.end_date && !b.locked; },
  same: function(b, s) {
    return b.start_date === s.start_date && b.end_date === s.end_date && b.locked === !!s.locked;
  },
  validate: function(d) {
    if (!d.period_name || !d.start_date || !d.end_date) return 'Name, start and end required';
    if (d.start_date > d.end_date) return 'Start date must be on or before end date';
    return null;
  },
  firstField: function(isNew) { return isNew ? 'period_name' : 'start_date'; },
  track: 'period',
  list: { action: 'period.list',
    map: function(p) { return { period_id: p.period_id, period_name: p.period_id, start_date: String(p.start_date || '').slice(0, 10), end_date: String(p.end_date || '').slice(0, 10), locked: !!p.locked, _key: p.period_id }; } },
  save: { action: 'period.upsert',
    body: function(d) { return { period: { period_id: d._isNew ? d.period_name : d._key, period_name: d.period_name, start_date: d.start_date, end_date: d.end_date, locked: !!d.locked } }; },
    focusKey: function(d) { return d._isNew ? d.period_name : d._key; } },
  del: { action: 'period.delete',
    body: function(d) { return { periodId: d._key }; },
    confirm: function(d) { return 'Delete period "' + d.period_name + '"?'; } },${opts.tree ? `
  children: periodsChildren,
  childRowHtml: periodsChildRowHtml,` : ''}
  onChrome: function(dirty) { ${opts.onChromeBody || ''} }
});

function loadPeriods(focusKey) { periodsList.load(focusKey); }
`;
}

module.exports = { periodsGridClientJS };
