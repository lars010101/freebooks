'use strict';
/**
 * freeBooks — Fiscal page (IA-spec step 4, §5.10, ratified 2026-08-04)
 *
 * The human's only recurring finalize surface. One section absorbs what other
 * packages split across tax centers and year-end modules: every filing relates
 * to a reporting interval, every interval lives under a period. All content is
 * jurisdiction-pack-driven — no filing row, checklist item, or due date is
 * hardcoded.
 *
 * Tabs: Periods · Filings · Close Checklist (h/l switch; tab-strip precedence
 * per §2).
 *
 * Periods tab: the shared periods grid (pages/periods-grid.js — the former
 * Settings tab config, lifted) in FLAT mode (tree:false — no row expansion).
 * The grid is a plain editable periods list: w writes via period.upsert,
 * u reverts, Esc never saves, period names immutable on saved rows.
 *
 * Filings tab: flat computed calendar (filing × interval across all periods),
 * read-only v1. Override editing via ~ is v2 (settings key deadline_overrides
 * already consumed by filing.list).
 *
 * Close Checklist tab: flat table of close-checklist items across ALL periods
 * (period.close_check: engine + pack closeChecklist[] ops). Columns: Period,
 * Item, Pass/Fail, Detail. Manual attestation items are toggleable via the ~
 * toggle verb (chip click or ~ key on the focused row). Both write through
 * period.upsert tax_attrs — no new write surface (§5.10).
 *
 * Advisory, not blocking: the checklist never blocks locking. Lock/unlock
 * stays human-only (R2 — agents can never lock).
 */

const { commonStyle, navBar, layoutEnd } = require('./common');
const { periodsGridClientJS } = require('./periods-grid');

async function handleFiscalPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildFiscalPage(company));
}

function buildFiscalPage(company) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Fiscal — freeBooks</title>
${commonStyle()}
<style>
  .tabs { display:flex; gap:0; border-bottom:2px solid #1a1a1a; margin-bottom:24px; }
  .tab { padding:8px 20px; cursor:pointer; font-weight:600; font-size:10pt; color:#555; border-bottom:3px solid transparent; margin-bottom:-2px; }
  .tab.active { color:#1a1a1a; border-bottom-color:#1a1a1a; }
  .tab-panel { display:none; }
  .tab-panel.active { display:block; }
  table.edit-table { width:100%; border-collapse:collapse; font-size:10pt; }
  table.edit-table th { text-align:left; font-size:9pt; text-transform:uppercase; color:#555; border-bottom:1px solid #ccc; padding:6px 6px; white-space:nowrap; }
  table.edit-table td { padding:4px 6px; border-bottom:1px solid #f0f0f0; vertical-align:middle; white-space:nowrap; }
  table.edit-table input[type=text], table.edit-table input[type=date], table.edit-table select { width:100%; padding:4px 6px; border:1px solid #ddd; border-radius:3px; font-size:10pt; }
  #tab-periods tbody td { cursor:text; }
  tr.row-dirty > td:first-child { box-shadow: inset 3px 0 0 #d97706; }
  .dirty-val { color:#b45309; }
  tr.row-editing > td { background:#fffbeb; }
  .row-actions { white-space:nowrap; text-align:right; }
  .chip { cursor:pointer; padding:2px 8px; border:1px solid #ccc; border-radius:3px; font-size:10pt; user-select:none; }
  .chip:hover { background:#f0f0f0; }
  a.chip { display:inline-block; color:#1a1a1a; text-decoration:none; margin-left:6px; }
  a.chip:first-child { margin-left:0; }
  .pe-ro { color:#888; }
  .st-badge { display:inline-block; padding:1px 8px; border-radius:9px; font-size:8.5pt; font-weight:600; text-transform:uppercase; letter-spacing:.02em; }
  .st-draft { background:#fef3c7; color:#92400e; }
  .st-filed { background:#dcfce7; color:#166534; }
  .due-past { color:#b91c1c; font-weight:600; }
  .due-override { color:#1a73d8; }
  .ck-pass { color:#166534; font-weight:600; }
  .ck-fail { color:#b91c1c; font-weight:600; }
  .ck-detail { color:#888; font-style:italic; }
  .ck-row-focused > td { background:#fffbeb; }
  .ck-kind { color:#888; font-size:8.5pt; text-transform:uppercase; letter-spacing:.03em; margin-right:6px; }
</style>
</head>
<body>${navBar(company, 'fiscal')}
<div class="page">
  <div class="header"><h1>📅 Fiscal</h1></div>

  <div class="tabs">
    <div class="tab active" data-tab="periods" onclick="showTab('periods')">Periods</div>
    <div class="tab" data-tab="filings" onclick="showTab('filings')">Filings</div>
    <div class="tab" data-tab="checklist" onclick="showTab('checklist')">Close Checklist</div>
  </div>

  <!-- PERIODS TAB — shared flat grid (no row expansion) -->
  <div id="tab-periods" class="tab-panel active">
    <table class="edit-table" id="periods-table">
      <thead><tr><th>Period Name</th><th>Start Date</th><th>End Date</th><th>Locked</th><th>FX</th><th></th></tr></thead>
      <tbody id="periods-body"></tbody>
    </table>
  </div>

  <!-- FILINGS TAB — flat computed calendar (filing × interval, all periods) -->
  <div id="tab-filings" class="tab-panel">
    <table class="edit-table" id="filings-table">
      <thead><tr><th>Filing</th><th>Period</th><th>Authority</th><th>Due Date</th><th>State</th><th></th></tr></thead>
      <tbody id="filings-body"></tbody>
    </table>
  </div>

  <!-- CLOSE CHECKLIST TAB — flat table across all periods -->
  <div id="tab-checklist" class="tab-panel">
    <table class="edit-table" id="checklist-table">
      <thead><tr><th>Period</th><th>Item</th><th>Pass/Fail</th><th>Detail</th><th></th></tr></thead>
      <tbody id="checklist-body"></tbody>
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
    var hintEl = document.getElementById('sb-hint');
    if (hintEl) {
      var hintSet = t === 'periods' ? 'periods' : (t === 'checklist' ? 'fiscal-checklist' : 'fiscal-filings');
      FB.keys.renderHints(hintSet, hintEl, { layout: 'list' });
    }
  }
  if (!tabLoaded[t]) {
    tabLoaded[t] = true;
    if (t === 'periods') loadPeriods();
    if (t === 'filings') loadFilings();
    if (t === 'checklist') loadChecklist();
  }
}

${periodsGridClientJS({
  keysId: 'periods',
  activeExpr: "!!document.getElementById('tab-periods') && document.getElementById('tab-periods').classList.contains('active')",
  onChromeBody: ''
})}

// ── Filings tab (read-only v1; override editing via ~ = v2) ─────────────────
function loadFilings(force) {
  var tb = document.getElementById('filings-body');
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
      var artifacts = ((f.artifacts || []).map(function (a) {
        return '<a href="' + esc(a.href) + '" target="_blank" rel="noopener" class="chip">' + esc(a.label) + '</a>';
      }).join(' ')) || '<span class="pe-ro">—</span>';
      return '<tr><td>' + esc(f.name) + (f.period_kind === 'vat_period'
          ? ' <span class="pe-ro">' + esc(f.interval_start) + ' → ' + esc(f.interval_end) + '</span>' : '') + '</td>'
        + '<td>' + esc(f.period_id) + '</td>'
        + '<td>' + esc(f.authority || '') + '</td>'
        + '<td' + (past ? ' class="due-past"' : '') + '>' + due + (f.due_overridden ? ' <span class="due-override" title="manual override">*</span>' : '') + '</td>'
        + '<td>' + badge + '</td><td class="row-actions">' + artifacts + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="pe-ro">No filings for this company.</td></tr>';
    tb.dataset.loaded = '1';
  }).catch(function (e) {
    FB.status.show('Failed to load filings: ' + (e && e.message || e), true);
  });
}

// ── Close Checklist tab — flat table across all periods ────────────────────
// Fetch period.list, then period.close_check for each period, assemble flat
// rows: { period_id, id, label, kind, pass, detail, auto }.
var checkRows = [];
var focusedCheckIdx = -1;

function loadChecklist(force) {
  var tb = document.getElementById('checklist-body');
  if (!tb || (tb.dataset.loaded && !force)) return;
  tb.innerHTML = '<tr><td colspan="5" class="pe-ro">Loading…</td></tr>';
  checkRows = [];
  focusedCheckIdx = -1;
  postAction('period.list', {}).then(function (res) {
    var periods = (res && res.data) || res || [];
    if (!periods.length) { renderChecklist(); return; }
    var done = 0;
    periods.forEach(function (p) {
      var pid = p.period_id || p.period_name;
      postAction('period.close_check', { periodId: pid }).then(function (r) {
        var items = (r && r.data && r.data.items) || (r && r.items) || [];
        items.forEach(function (it) {
          checkRows.push(Object.assign({ period_id: pid }, it));
        });
      }).catch(function () {
        // a period may have no checklist / fail — skip silently
      }).then(function () {
        done++;
        if (done === periods.length) renderChecklist();
      });
    });
  }).catch(function (e) {
    FB.status.show('Failed to load close checklist: ' + (e && e.message || e), true);
    tb.innerHTML = '<tr><td colspan="5" class="pe-ro">Failed to load.</td></tr>';
  });
}

function renderChecklist() {
  var tb = document.getElementById('checklist-body');
  if (!tb) return;
  if (!checkRows.length) {
    tb.innerHTML = '<tr><td colspan="5" class="pe-ro">No close checklist items.</td></tr>';
    tb.dataset.loaded = '1';
    return;
  }
  tb.innerHTML = checkRows.map(function (c, i) {
    var icon = c.pass ? '<span class="ck-pass">✓</span>' : '<span class="ck-fail">✗</span>';
    var kind = c.kind === 'manual' ? 'Manual' : (c.auto ? 'Auto' : (c.kind || ''));
    var action = '';
    if (c.kind === 'manual') {
      action = ' <a class="chip" title="toggle attestation (~)" data-act="period-check-attest"'
        + ' data-item="' + esc(c.id) + '" data-period="' + esc(c.period_id) + '" data-idx="' + i + '">'
        + (c.pass ? 'unattest' : 'attest') + '</a>';
    }
    var focusCls = (i === focusedCheckIdx) ? ' class="ck-row-focused"' : '';
    return '<tr' + focusCls + ' data-check-idx="' + i + '" tabindex="0">'
      + '<td>' + esc(c.period_id) + '</td>'
      + '<td><span class="ck-kind">' + esc(kind) + '</span>' + esc(c.label) + '</td>'
      + '<td>' + icon + '</td>'
      + '<td><span class="ck-detail">' + esc(c.detail || '') + '</span></td>'
      + '<td>' + action + '</td></tr>';
  }).join('');
  tb.dataset.loaded = '1';
}

// Track focus on checklist rows (click / keyboard navigation).
document.addEventListener('click', function (e) {
  var tr = e.target.closest('#checklist-body tr[data-check-idx]');
  if (tr) {
    focusedCheckIdx = parseInt(tr.dataset.checkIdx, 10);
    renderChecklist();
  }
});

// ~ toggle verb: chip click OR ~ key on the focused manual row. Both write
// through period.upsert tax_attrs (no new write surface, §5.10) — read the
// period's current tax_attrs, patch the checklist sub-key (flip), upsert the
// period unchanged otherwise. True toggle: pass → fail → pass.
function toggleCheck(idx) {
  var c = checkRows[idx];
  if (!c || c.kind !== 'manual') return;
  var periodId = c.period_id;
  var itemId = c.id;
  postAction('period.list', {}).then(function (res) {
    var rows = (res && res.data) || res || [];
    var p = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].period_id === periodId) { p = rows[i]; break; }
    if (!p) { FB.status.show('Period not found: ' + periodId, true); return; }
    var taxAttrs = p.tax_attrs || {};
    if (typeof taxAttrs === 'string') { try { taxAttrs = JSON.parse(taxAttrs); } catch (x) { taxAttrs = {}; } }
    taxAttrs.checklist = taxAttrs.checklist || {};
    // toggle: currently pass → unset; currently fail → set true
    if (taxAttrs.checklist[itemId] === true) delete taxAttrs.checklist[itemId];
    else taxAttrs.checklist[itemId] = true;
    return postAction('period.upsert', { period: {
      period_id: p.period_id, period_name: p.period_id,
      start_date: String(p.start_date).slice(0, 10), end_date: String(p.end_date).slice(0, 10),
      locked: !!p.locked, tax_attrs: taxAttrs
    } }).then(function () {
      FB.status.show(taxAttrs.checklist[itemId] === true ? 'Attested.' : 'Unattested.');
      loadChecklist(true);
    });
  }).catch(function (err) { FB.status.show('Write failed: ' + (err && err.message || err), true); });
}

// Chip click handler for manual attestation (~ toggle verb).
document.addEventListener('click', function (e) {
  var chip = e.target.closest('a[data-act="period-check-attest"]');
  if (!chip) return;
  e.preventDefault(); e.stopPropagation();
  var idx = parseInt(chip.dataset.idx, 10);
  if (!isNaN(idx)) toggleCheck(idx);
});

// ~ keyboard binding for the Close Checklist tab.
if (window.FB && FB.keys) {
  FB.keys.register('fiscal-checklist', {
    active: function () {
      var el = document.getElementById('tab-checklist');
      return !!(el && el.classList.contains('active'));
    },
    bindings: [
      { key: '~', mode: 'NORMAL', hint: 'attest', hintBar: true,
        run: function () {
          if (focusedCheckIdx < 0) { FB.status.show('Select a manual checklist row first.', true); return; }
          toggleCheck(focusedCheckIdx);
        } }
    ]
  });
}

// j/k navigation for the checklist tab (focus rows).
if (window.FB && FB.keys) {
  FB.keys.register('fiscal-checklist-nav', {
    active: function () {
      var el = document.getElementById('tab-checklist');
      return !!(el && el.classList.contains('active'));
    },
    bindings: [
      { key: 'j', mode: 'NORMAL', hint: 'next', run: function () { moveCheckFocus(1); } },
      { key: 'k', mode: 'NORMAL', hint: 'prev', run: function () { moveCheckFocus(-1); } }
    ]
  });
}
function moveCheckFocus(delta) {
  if (!checkRows.length) return;
  focusedCheckIdx = Math.max(0, Math.min(checkRows.length - 1, (focusedCheckIdx < 0 ? 0 : focusedCheckIdx + delta)));
  renderChecklist();
  var tr = document.querySelector('#checklist-body tr[data-check-idx="' + focusedCheckIdx + '"]');
  if (tr) tr.focus();
}

showTab('periods');
</script>
</body>
</html>`;
}

module.exports = { handleFiscalPage };
