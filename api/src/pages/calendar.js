'use strict';
/**
 * freeBooks — Calendar page (calendar-reminders-documents-spec.md, ratified 2026-08-29)
 *
 * Renamed from Fiscal (fiscal-filings-lifecycle-spec.md's Filings tab and its
 * submission-tracking write surface are superseded — see the spec's §4.2 for
 * what was dropped and why). gKey moved from `f` to `c`, freed by the company
 * switcher moving to `g w` (nav-registry.js).
 *
 * Tabs: Periods · Reminders · Close Checklist (h/l switch; tab-strip precedence
 * per §2). Close Checklist's permanent home is still undecided (spec §0.2) —
 * carried over here unchanged, not redesigned.
 *
 * Periods tab: the shared periods grid (pages/periods-grid.js) in FLAT mode
 * (tree:false — no row expansion). w writes via period.upsert, u reverts, Esc
 * never saves, period names immutable on saved rows. The FX status column is
 * gone (spec §3) — FX gaps now surface only through the notification bell,
 * which fx-scanner.js already feeds regardless of this page.
 *
 * Reminders tab: flat list — jurisdiction-pack descriptors seeded once into
 * `reminders` (spec §4.3) plus free-standing user-added rows, both editable
 * in place (due date, done/not-done). No submission mechanics, no per-filing
 * method branching, no frozen-snapshot machinery — the read-only SRU/SIE
 * download chips are the one thing kept from the superseded Filings tab.
 *
 * Close Checklist tab: unchanged from the superseded spec — flat table of
 * close-checklist items across ALL periods (period.close_check). Manual
 * attestation items toggle via ~ (chip click or key), writing through
 * period.upsert tax_attrs.
 */

const { commonStyle, navBar, layoutEnd } = require('./common');
const { periodsGridClientJS } = require('./periods-grid');

async function handleCalendarPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildCalendarPage(company));
}

function buildCalendarPage(company) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Calendar — freeBooks</title>
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
  .due-past { color:#b91c1c; font-weight:600; }
  .rem-done { color:#166534; }
  .ck-pass { color:#166534; font-weight:600; }
  .ck-fail { color:#b91c1c; font-weight:600; }
  .ck-detail { color:#888; font-style:italic; }
  .ck-row-focused > td { background:#fffbeb; }
  .ck-kind { color:#888; font-size:8.5pt; text-transform:uppercase; letter-spacing:.03em; margin-right:6px; }
  .rem-source { color:#888; font-size:8.5pt; text-transform:uppercase; letter-spacing:.03em; }
  #reminder-add-row input { padding:3px 6px; border:1px solid #ddd; border-radius:3px; font-size:10pt; }
</style>
</head>
<body>${navBar(company, 'calendar')}
<div class="page">
  <div class="header"><h1>📅 Calendar</h1></div>

  <div class="tabs">
    <div class="tab active" data-tab="periods" onclick="showTab('periods')">Periods</div>
    <div class="tab" data-tab="reminders" onclick="showTab('reminders')">Reminders</div>
    <div class="tab" data-tab="checklist" onclick="showTab('checklist')">Close Checklist</div>
  </div>

  <!-- PERIODS TAB — shared flat grid (no row expansion) -->
  <div id="tab-periods" class="tab-panel active">
    <table class="edit-table" id="periods-table">
      <thead><tr><th>Period Name</th><th>Start Date</th><th>End Date</th><th>Locked</th><th></th></tr></thead>
      <tbody id="periods-body"></tbody>
    </table>
  </div>

  <!-- REMINDERS TAB — jurisdiction-pack imports + user-added, done/not-done -->
  <div id="tab-reminders" class="tab-panel">
    <table class="edit-table" id="reminders-table">
      <thead><tr><th>Reminder</th><th>Period</th><th>Authority</th><th>Due Date</th><th>Status</th><th></th></tr></thead>
      <tbody id="reminders-body"></tbody>
      <tfoot><tr id="reminder-add-row"><td colspan="6"><a class="chip" data-act="reminder-add-show">+ Add reminder</a></td></tr></tfoot>
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
      var hintSet = t === 'periods' ? 'periods' : (t === 'checklist' ? 'fiscal-checklist' : 'calendar-reminders');
      FB.keys.renderHints(hintSet, hintEl, { layout: 'list' });
    }
  }
  if (!tabLoaded[t]) {
    tabLoaded[t] = true;
    if (t === 'periods') loadPeriods();
    if (t === 'reminders') loadReminders();
    if (t === 'checklist') loadChecklist();
  }
}

${periodsGridClientJS({
  keysId: 'periods',
  activeExpr: "!!document.getElementById('tab-periods') && document.getElementById('tab-periods').classList.contains('active')",
  onChromeBody: ''
})}

// ── Reminders tab (calendar-reminders-documents-spec.md §4) ─────────────────
function loadReminders(force) {
  var tb = document.getElementById('reminders-body');
  if (!tb || (tb.dataset.loaded && !force)) return;
  postAction('reminder.list', {}).then(function (res) {
    var reminders = (res && res.data && res.data.reminders) || (res && res.reminders) || [];
    var today = new Date().toISOString().slice(0, 10);
    tb.innerHTML = reminders.map(function (r) {
      var due = r.due_date ? esc(String(r.due_date).slice(0, 10)) : '—';
      var past = r.due_date && !r.done && r.due_date < today;
      var artifacts = (r.artifacts || []).map(function (a) {
        return '<a href="' + esc(a.href) + '" target="_blank" rel="noopener" class="chip">' + esc(a.label) + '</a>';
      }).join(' ');
      var dueCell = '<td' + (past ? ' class="due-past"' : '') + '>'
        + '<span class="due-val" data-act="reminder-due-edit" data-id="' + esc(r.reminder_id) + '">' + due + '</span>'
        + '</td>';
      var statusCell = '<td><label class="chip" style="cursor:pointer">'
        + '<input type="checkbox" data-act="reminder-done-toggle" data-id="' + esc(r.reminder_id) + '"' + (r.done ? ' checked' : '') + '> '
        + (r.done ? '<span class="rem-done">Done</span>' : 'Not done') + '</label></td>';
      var actions = artifacts;
      if (r.source === 'user') {
        actions += ' <a class="chip" data-act="reminder-delete" data-id="' + esc(r.reminder_id) + '" data-label="' + esc(r.label) + '">Delete</a>';
      }
      return '<tr data-id="' + esc(r.reminder_id) + '">'
        + '<td><span class="rem-source">' + (r.source === 'user' ? 'Manual' : 'Pack') + '</span> ' + esc(r.label) + '</td>'
        + '<td>' + esc(r.period_id || '') + '</td>'
        + '<td>' + esc(r.authority || '') + '</td>'
        + dueCell
        + statusCell
        + '<td class="row-actions">' + (actions || '<span class="pe-ro">—</span>') + '</td>'
        + '</tr>';
    }).join('') || '<tr><td colspan="6" class="pe-ro">No reminders for this company.</td></tr>';
    tb.dataset.loaded = '1';
  }).catch(function (e) {
    FB.status.show('Failed to load reminders: ' + (e && e.message || e), true);
  });
}

// Inline due-date edit (click → <input type=date> → save on blur/enter)
document.addEventListener('click', function (e) {
  var span = e.target.closest('[data-act="reminder-due-edit"]');
  if (!span) return;
  var id = span.dataset.id;
  var current = span.textContent.trim();
  var input = document.createElement('input');
  input.type = 'date';
  input.value = current !== '—' ? current : '';
  input.style.cssText = 'width:120px;padding:2px 4px;border:1px solid #ddd;border-radius:3px;font-size:10pt';
  span.replaceWith(input);
  input.focus();
  function saveDue() {
    if (!input.value) { loadReminders(true); return; }
    postAction('reminder.set_due', { reminderId: id, dueDate: input.value }).then(function () {
      FB.status.show('Due date saved.');
      loadReminders(true);
    }).catch(function (err) { FB.status.show('Save failed: ' + (err && err.message || err), true); });
  }
  input.addEventListener('blur', saveDue);
  input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') saveDue(); ev.stopPropagation(); });
});

// Done/not-done toggle
document.addEventListener('change', function (e) {
  var box = e.target.closest('[data-act="reminder-done-toggle"]');
  if (!box) return;
  postAction('reminder.set_done', { reminderId: box.dataset.id, done: box.checked }).then(function () {
    loadReminders(true);
  }).catch(function (err) { FB.status.show('Save failed: ' + (err && err.message || err), true); });
});

// Delete (user-added rows only)
document.addEventListener('click', function (e) {
  var chip = e.target.closest('[data-act="reminder-delete"]');
  if (!chip) return;
  e.preventDefault(); e.stopPropagation();
  if (!confirm('Delete reminder "' + chip.dataset.label + '"?')) return;
  postAction('reminder.delete', { reminderId: chip.dataset.id }).then(function () {
    FB.status.show('Deleted.');
    loadReminders(true);
  }).catch(function (err) { FB.status.show('Delete failed: ' + ((err && err.error && err.error.message) || err && err.message || err), true); });
});

// + Add reminder — a small inline form in place of the add-row chip
document.addEventListener('click', function (e) {
  var chip = e.target.closest('[data-act="reminder-add-show"]');
  if (!chip) return;
  var row = document.getElementById('reminder-add-row');
  row.innerHTML = '<td colspan="6">'
    + '<input type="text" id="reminder-new-label" placeholder="Label" style="width:220px">'
    + ' <input type="date" id="reminder-new-due">'
    + ' <a class="chip" data-act="reminder-add-save">Save</a>'
    + ' <a class="chip" data-act="reminder-add-cancel">Cancel</a>'
    + '</td>';
  document.getElementById('reminder-new-label').focus();
});
document.addEventListener('click', function (e) {
  if (e.target.closest('[data-act="reminder-add-cancel"]')) { loadReminders(true); resetAddRow(); }
});
function resetAddRow() {
  document.getElementById('reminder-add-row').innerHTML = '<td colspan="6"><a class="chip" data-act="reminder-add-show">+ Add reminder</a></td>';
}
document.addEventListener('click', function (e) {
  if (!e.target.closest('[data-act="reminder-add-save"]')) return;
  var label = (document.getElementById('reminder-new-label') || {}).value || '';
  var due = (document.getElementById('reminder-new-due') || {}).value || '';
  if (!label.trim() || !due) { FB.status.show('Label and due date required.', true); return; }
  postAction('reminder.create', { label: label.trim(), dueDate: due }).then(function () {
    FB.status.show('Reminder added.');
    resetAddRow();
    loadReminders(true);
  }).catch(function (err) { FB.status.show('Save failed: ' + (err && err.message || err), true); });
});

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
// through period.upsert tax_attrs (no new write surface) — read the
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

module.exports = { handleCalendarPage };
