'use strict';
/**
 * freeBooks — Periods page (IA-spec step 4, §5.10, ratified 2026-08-04)
 *
 * The human's only recurring finalize surface. One section absorbs what other
 * packages split across tax centers and year-end modules: every filing relates
 * to a reporting interval, every interval lives under a period. All content is
 * jurisdiction-pack-driven — no filing row, checklist item, or due date is
 * hardcoded.
 *
 * Tabs: Periods · Deadlines (h/l switch; tab-strip precedence per §2).
 *
 * Periods tab: the shared periods grid (pages/periods-grid.js — the former
 * Settings tab config, lifted) with tree row expansion (bills-tree machinery):
 *   children of a period row = filing entries (filing.list: descriptor ×
 *   interval, due dates from descriptor rules + deadline_overrides, filed
 *   state from periods.tax_attrs.filings, artifact endpoint links) + close
 *   checklist items (period.close_check: engine + pack closeChecklist[] ops).
 *   w on a filing child toggles draft → filed (filed_at = today, once);
 *   w on a manual checklist child attests. Both write through period.upsert
 *   tax_attrs — no new write surface (§5.10).
 *
 * Deadlines tab: flat computed calendar (filing × interval across all
 * periods), read-only v1. Override editing via w is v2 (settings key
 * deadline_overrides already consumed by filing.list).
 *
 * Advisory, not blocking: the checklist never blocks locking. Lock/unlock
 * stays human-only (R2 — agents can never lock).
 */

const { commonStyle, navBar, layoutEnd } = require('./common');
const { periodsGridClientJS } = require('./periods-grid');

async function handlePeriodsPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildPeriodsPage(company));
}

function buildPeriodsPage(company) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Periods — freeBooks</title>
${commonStyle()}
<style>
  .tabs { display:flex; gap:0; border-bottom:2px solid #1a1a1a; margin-bottom:24px; }
  .tab { padding:8px 20px; cursor:pointer; font-weight:600; font-size:10pt; color:#555; border-bottom:3px solid transparent; margin-bottom:-2px; }
  .tab.active { color:#1a1a1a; border-bottom-color:#1a1a1a; }
  .tab-panel { display:none; }
  .tab-panel.active { display:block; }
  table.edit-table { width:100%; border-collapse:collapse; font-size:10pt; }
  table.edit-table th { text-align:left; font-size:9pt; text-transform:uppercase; color:#555; border-bottom:1px solid #ccc; padding:6px 6px; white-space:nowrap; }
  table.edit-table td { padding:4px 4px; border-bottom:1px solid #f0f0f0; vertical-align:middle; white-space:nowrap; }
  table.edit-table input[type=text], table.edit-table input[type=date], table.edit-table select { width:100%; padding:4px 6px; border:1px solid #ddd; border-radius:3px; font-size:10pt; }
  #tab-periods tbody td { cursor:text; }
  tr.row-dirty > td:first-child { box-shadow: inset 3px 0 0 #d97706; }
  .dirty-val { color:#b45309; }
  tr.row-editing > td { background:#fffbeb; }
  .row-actions { white-space:nowrap; text-align:right; }
  .chip { cursor:pointer; padding:2px 8px; border:1px solid #ccc; border-radius:3px; font-size:10pt; user-select:none; }
  .chip:hover { background:#f0f0f0; }
  .pe-ro { color:#888; }
  /* Filing + checklist child rows (tree expansion) */
  tr[data-child-of] td { background:#fcfcfc; font-size:9.5pt; color:#333; cursor:default; }
  .fl-kind { color:#888; font-size:8.5pt; text-transform:uppercase; letter-spacing:.03em; margin-right:6px; }
  .st-badge { display:inline-block; padding:1px 8px; border-radius:9px; font-size:8.5pt; font-weight:600; text-transform:uppercase; letter-spacing:.02em; }
  .st-draft { background:#fef3c7; color:#92400e; }
  .st-filed { background:#dcfce7; color:#166534; }
  .due-past { color:#b91c1c; font-weight:600; }
  .due-override { color:#1a73d8; }
  .ck-pass { color:#166534; font-weight:600; }
  .ck-fail { color:#b91c1c; font-weight:600; }
  .ck-detail { color:#888; font-style:italic; margin-left:8px; }
  .fl-artifacts a { color:#1a73d8; text-decoration:none; margin-right:10px; font-size:9pt; }
  .fl-artifacts a:hover { text-decoration:underline; }
</style>
</head>
<body>${navBar(company, 'periods')}
<div class="page">
  <div class="header"><h1>📅 Periods</h1></div>

  <div class="tabs">
    <div class="tab active" data-tab="periods" onclick="showTab('periods')">Periods</div>
    <div class="tab" data-tab="deadlines" onclick="showTab('deadlines')">Deadlines</div>
  </div>

  <!-- PERIODS TAB — shared grid + row expansion (filings + close checklist) -->
  <div id="tab-periods" class="tab-panel active">
    <table class="edit-table" id="periods-table">
      <thead><tr><th>Period Name</th><th>Start Date</th><th>End Date</th><th>Locked</th><th></th></tr></thead>
      <tbody id="periods-body"></tbody>
    </table>
  </div>

  <!-- DEADLINES TAB — flat computed calendar (filing × interval, all periods) -->
  <div id="tab-deadlines" class="tab-panel">
    <table class="edit-table" id="deadlines-table">
      <thead><tr><th>Filing</th><th>Period</th><th>Authority</th><th>Due Date</th><th>State</th><th></th></tr></thead>
      <tbody id="deadlines-body"></tbody>
    </table>
  </div>
</div>
${layoutEnd()}
<script>
var COMPANY = ${JSON.stringify(company)};

function postAction(action, body, idemKey) {
  var headers = { 'Content-Type': 'application/json' };
  if (idemKey) headers['Idempotency-Key'] = idemKey;
  return fetch('/api/action', { method: 'POST', headers: headers,
    body: JSON.stringify(Object.assign({ action: action, companyId: COMPANY }, body)) })
    .then(function (r) { return r.json(); });
}

// ── Tabs (h/l strip precedence per §2: common.js owns h/l on tabbed pages) ──
var tabLoaded = {};
function showTab(t) {
  var cur = document.querySelector('.tab-panel.active');
  var curTab = cur ? cur.id.replace('tab-', '') : '';
  if (curTab && curTab !== t) {
    if (window.FB && FB.list && FB.list.anyDirty()) {
      FB.list.guard(function() { showTab(t); });
      return;
    }
  }
  document.querySelectorAll('.tab').forEach(function(el) { el.classList.toggle('active', el.dataset.tab === t); });
  document.querySelectorAll('.tab-panel').forEach(function(el) { el.classList.remove('active'); });
  document.getElementById('tab-' + t).classList.add('active');
  if (window.FB && FB.keys) {
    var hintEl = document.getElementById('sb-hints');
    if (hintEl) FB.keys.renderHints(t === 'periods' ? 'periods' : 'periods-deadlines', hintEl, { layout: 'list' });
  }
  if (!tabLoaded[t]) {
    tabLoaded[t] = true;
    if (t === 'periods') loadPeriods();
    if (t === 'deadlines') loadDeadlines();
  }
}

// ── Tree children: filings + close checklist per period row ─────────────────
// Lazy per period, cached per _key; first touch fetches both actions in
// parallel and re-renders (bills-tree pattern). Child row kinds:
//   'filing'    — a filing instance (filing.list)
//   'checklist' — a close-checklist item (period.close_check)
var periodChildCache = {};

function periodsChildren(row) {
  var k = row._key;
  var c = periodChildCache[k];
  if (c && c.fetched) {
    return c.filings.map(filingChildRow).concat(c.checks.map(checklistChildRow));
  }
  if (!c) {
    periodChildCache[k] = { filings: [], checks: [], fetched: false, fetching: true };
    fetchPeriodChildren(row);
  }
  return [];
}

function fetchPeriodChildren(row) {
  var k = row._key;
  Promise.all([
    postAction('filing.list', { periodId: k }),
    postAction('period.close_check', { periodId: k })
  ]).then(function (res) {
    var entry = periodChildCache[k];
    entry.filings = (res[0] && res[0].data && res[0].data.filings) || (res[0] && res[0].filings) || [];
    entry.checks = (res[1] && res[1].data && res[1].data.items) || (res[1] && res[1].items) || [];
    entry.fetched = true; entry.fetching = false;
    periodsList.render();
  }).catch(function (e) {
    periodChildCache[k] = { filings: [], checks: [], fetched: true, fetching: false };
    FB.status.show('Failed to load period details: ' + (e && e.message || e), true);
    periodsList.render();
  });
}

function filingChildRow(f) { return Object.assign({ _kind: 'filing' }, f); }
function checklistChildRow(c) { return Object.assign({ _kind: 'checklist' }, c); }

// Grid has 5 columns (name/start/end/locked/actions); children span the
// layout with their own cells (bills-tree contract: childRowHtml owns the
// inner <td> HTML, the framework owns the <tr> shell).
function periodsChildRowHtml(parent, child) {
  if (child._kind === 'filing') {
    var stateBadge = child.state === 'filed'
      ? '<span class="st-badge st-filed" title="filed ' + esc(String(child.filed_at || '').slice(0, 10)) + '">Filed</span>'
      : '<span class="st-badge st-draft">Draft</span>';
    var due = child.due_date ? esc(String(child.due_date).slice(0, 10)) : '—';
    var today = new Date().toISOString().slice(0, 10);
    var dueCls = (child.due_date && child.state !== 'filed' && child.due_date < today) ? ' class="due-past"' : '';
    var ovr = child.due_overridden ? ' <span class="due-override" title="manual override">*</span>' : '';
    var arts = (child.artifacts || []).map(function (a) {
      return '<a href="' + esc(a.href) + '"' + (a.kind === 'download' ? ' download' : ' target="_blank"')
        + ' onclick="event.stopPropagation()">' + esc(a.label) + '</a>';
    }).join('');
    return '<td colspan="2"><span class="fl-kind">' + (child.period_kind === 'vat_period' ? 'VAT' : 'Filing') + '</span>'
      + esc(child.name) + (child.period_kind === 'vat_period'
        ? ' <span class="pe-ro">' + esc(child.interval_start) + ' → ' + esc(child.interval_end) + '</span>' : '')
      + ' <span class="pe-ro">· ' + esc(child.authority || '') + '</span></td>'
      + '<td' + dueCls + '>' + due + ovr + '</td>'
      + '<td>' + stateBadge + '</td>'
      + '<td class="fl-artifacts">' + arts
      + (child.state !== 'filed'
        ? ' <a class="chip" title="mark filed (w)" data-act="period-filing-file" data-filing="' + esc(child.filing_id)
          + (child.period_kind === 'vat_period' ? '@' + esc(child.interval_start) : '') + '" data-period="' + esc(child.period_id) + '">filed</a>'
        : '')
      + '</td>';
  }
  // checklist
  var icon = child.pass ? '<span class="ck-pass">✓</span>' : '<span class="ck-fail">✗</span>';
  var manualChip = (child.kind === 'manual' && !child.pass)
    ? ' <a class="chip" title="attest (w)" data-act="period-check-attest" data-item="' + esc(child.id) + '" data-period="' + esc(parent._key) + '">attest</a>'
    : '';
  return '<td colspan="2"><span class="fl-kind">Check</span>' + icon + ' ' + esc(child.label) + '</td>'
    + '<td colspan="2"><span class="ck-detail">' + esc(child.detail || '') + '</span></td>'
    + '<td>' + manualChip + '</td>';
}

// w on child rows: filed toggle + manual attestation. Both write through
// period.upsert tax_attrs (no new write surface, §5.10) — read the period's
// current tax_attrs, patch the sub-key, upsert the period unchanged otherwise.
document.addEventListener('click', function (e) {
  var chip = e.target.closest('a[data-act="period-filing-file"],a[data-act="period-check-attest"]');
  if (!chip) return;
  e.preventDefault(); e.stopPropagation();
  var periodId = chip.dataset.period;
  postAction('period.list', {}).then(function (res) {
    var rows = (res && res.data) || res || [];
    var p = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].period_id === periodId) { p = rows[i]; break; }
    if (!p) { FB.status.show('Period not found: ' + periodId, true); return; }
    var taxAttrs = p.tax_attrs || {};
    if (typeof taxAttrs === 'string') { try { taxAttrs = JSON.parse(taxAttrs); } catch (x) { taxAttrs = {}; } }
    if (chip.dataset.act === 'period-filing-file') {
      taxAttrs.filings = taxAttrs.filings || {};
      taxAttrs.filings[chip.dataset.filing] = { filed_at: new Date().toISOString().slice(0, 10) };
    } else {
      taxAttrs.checklist = taxAttrs.checklist || {};
      taxAttrs.checklist[chip.dataset.item] = true;
    }
    return postAction('period.upsert', { period: {
      period_id: p.period_id, period_name: p.period_id,
      start_date: String(p.start_date).slice(0, 10), end_date: String(p.end_date).slice(0, 10),
      locked: !!p.locked, tax_attrs: taxAttrs
    } }).then(function () {
      FB.status.show(chip.dataset.act === 'period-filing-file' ? 'Marked filed.' : 'Attested.');
      delete periodChildCache[periodId];
      periodsList.render();
      loadDeadlines(true);
    });
  }).catch(function (err) { FB.status.show('Write failed: ' + (err && err.message || err), true); });
});

${periodsGridClientJS({
  keysId: 'periods',
  activeExpr: "!!document.getElementById('tab-periods') && document.getElementById('tab-periods').classList.contains('active')",
  tree: true,
  onChromeBody: ''
})}

// ── Deadlines tab (read-only v1; override editing via w = v2) ───────────────
function loadDeadlines(force) {
  var tb = document.getElementById('deadlines-body');
  if (!tb || (tb.dataset.loaded && !force)) return;
  postAction('filing.list', {}).then(function (res) {
    var filings = (res && res.data && res.data.filings) || (res && res.filings) || [];
    var today = new Date().toISOString().slice(0, 10);
    filings.sort(function (a, b) { return String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')); });
    tb.innerHTML = filings.map(function (f) {
      var due = f.due_date ? esc(String(f.due_date).slice(0, 10)) : '—';
      var past = f.due_date && f.state !== 'filed' && f.due_date < today;
      var badge = f.state === 'filed'
        ? '<span class="st-badge st-filed">Filed</span>' : '<span class="st-badge st-draft">Draft</span>';
      return '<tr><td>' + esc(f.name) + (f.period_kind === 'vat_period'
          ? ' <span class="pe-ro">' + esc(f.interval_start) + ' → ' + esc(f.interval_end) + '</span>' : '') + '</td>'
        + '<td>' + esc(f.period_id) + '</td>'
        + '<td>' + esc(f.authority || '') + '</td>'
        + '<td' + (past ? ' class="due-past"' : '') + '>' + due + (f.due_overridden ? ' <span class="due-override" title="manual override">*</span>' : '') + '</td>'
        + '<td>' + badge + '</td><td></td></tr>';
    }).join('') || '<tr><td colspan="6" class="pe-ro">No filings for this company.</td></tr>';
    tb.dataset.loaded = '1';
  }).catch(function (e) {
    FB.status.show('Failed to load deadlines: ' + (e && e.message || e), true);
  });
}

showTab('periods');
</script>
</body>
</html>`;
}

module.exports = { handlePeriodsPage };
