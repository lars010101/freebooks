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

// ── Filings tab (§9 — submission status, due-date overrides, expand-rows) ───
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
      var fkey = esc(f.key || '');
      var periodId = esc(f.period_id || '');
      var kind = f.period_kind || 'fiscal_year';
      var filingId = f.filing_id || '';
      var methods = f.methods || null;
      var submittedAttachments = f.submitted_attachments || [];
      var isFiled = f.state === 'filed';

      // Artifact links (draft rows: SRU downloads for ink2; SIE for AR)
      var artifacts = ((f.artifacts || []).map(function (a) {
        return '<a href="' + esc(a.href) + '" target="_blank" rel="noopener" class="chip">' + esc(a.label) + '</a>';
      }).join(' '));

      // Submitted attachment links (filed rows: frozen copies)
      var frozenLinks = submittedAttachments.map(function (sa) {
        return '<a href="/api/attachment/' + esc(sa.attachment_id) + '" target="_blank" rel="noopener" class="chip">' + esc(sa.filename || 'file') + '</a>';
      }).join(' ');

      // Actions cell
      var actions = '';
      if (isFiled) {
        actions = frozenLinks + ' <a class="chip" data-act="filing-unsubmit" data-key="' + fkey + '" data-period="' + periodId + '">Unsubmit</a>';
      } else {
        if (filingId === 'ink2') {
          actions = artifacts + ' <label class="chip" style="cursor:pointer">Upload PDF<input type="file" style="display:none" data-act="filing-upload" data-key="' + fkey + '" data-period="' + periodId + '" accept=".pdf"></label>'
            + ' <a class="chip" data-act="filing-submit" data-key="' + fkey + '" data-period="' + periodId + '" data-filing-id="' + esc(filingId) + '" data-methods="' + esc((methods || []).join(',')) + '">Mark Submitted</a>';
        } else if (filingId === 'annual-report') {
          actions = '<label class="chip" style="cursor:pointer">Upload PDF<input type="file" style="display:none" data-act="filing-upload" data-key="' + fkey + '" data-period="' + periodId + '" accept=".pdf"></label>'
            + ' <a class="chip" data-act="filing-submit" data-key="' + fkey + '" data-period="' + periodId + '" data-filing-id="' + esc(filingId) + '" data-methods="pdf">Mark Submitted</a>';
        } else if (filingId === 'vat-return') {
          actions = '<a class="chip" data-act="filing-submit" data-key="' + fkey + '" data-period="' + periodId + '" data-filing-id="' + esc(filingId) + '">Mark Submitted</a>';
        } else {
          actions = artifacts || '<span class="pe-ro">—</span>';
        }
      }

      // Due date cell (click-to-edit inline)
      var dueCell = '<td' + (past ? ' class="due-past"' : '') + '>'
        + '<span class="due-val" data-act="due-edit" data-key="' + fkey + '">' + due + '</span>'
        + (f.due_overridden ? ' <span class="due-override" title="manual override">*</span>' : '')
        + '</td>';

      // Expand-row toggle chips
      var expandChips = '';
      if (filingId === 'annual-report') {
        expandChips += ' <a class="chip" data-act="expand-facts" data-key="' + fkey + '" data-period="' + periodId + '">Facts ▸</a>';
      }
      if (filingId === 'ink2') {
        expandChips += ' <a class="chip" data-act="expand-pf" data-key="' + fkey + '" data-period="' + periodId + '">Periodiseringsfond ▸</a>';
      }

      var row = '<tr data-fkey="' + fkey + '">'
        + '<td>' + esc(f.name) + (kind === 'vat_period'
            ? ' <span class="pe-ro">' + esc(f.interval_start) + ' → ' + esc(f.interval_end) + '</span>' : '') + '</td>'
        + '<td>' + periodId + '</td>'
        + '<td>' + esc(f.authority || '') + '</td>'
        + dueCell
        + '<td>' + badge + '</td>'
        + '<td class="row-actions">' + actions + expandChips + '</td>'
        + '</tr>';

      // Expand-rows (hidden by default, toggled by chip)
      if (filingId === 'annual-report') {
        row += '<tr class="expand-row" data-expand="facts" data-key="' + fkey + '" style="display:none">'
          + '<td colspan="6" id="facts-panel-' + fkey.replace(/[^a-z0-9]/gi, '') + '"></td></tr>';
      }
      if (filingId === 'ink2') {
        row += '<tr class="expand-row" data-expand="pf" data-key="' + fkey + '" style="display:none">'
          + '<td colspan="6" id="pf-panel-' + fkey.replace(/[^a-z0-9]/gi, '') + '"></td></tr>';
      }

      return row;
    }).join('') || '<tr><td colspan="6" class="pe-ro">No filings for this company.</td></tr>';
    tb.dataset.loaded = '1';
  }).catch(function (e) {
    FB.status.show('Failed to load filings: ' + (e && e.message || e), true);
  });
}

// Inline due-date edit (click → <input type=date> → save on blur/enter)
document.addEventListener('click', function (e) {
  var span = e.target.closest('[data-act="due-edit"]');
  if (!span) return;
  var key = span.dataset.key;
  var current = span.textContent.trim();
  var input = document.createElement('input');
  input.type = 'date';
  input.value = current !== '—' ? current : '';
  input.style.cssText = 'width:120px;padding:2px 4px;border:1px solid #ddd;border-radius:3px;font-size:10pt';
  span.replaceWith(input);
  input.focus();
  function saveDue() {
    var val = input.value || null;
    postAction('filing.set_due_override', { key: key, dueDate: val }).then(function () {
      FB.status.show('Due date ' + (val ? 'saved' : 'cleared') + '.');
      loadFilings(true);
    }).catch(function (err) { FB.status.show('Save failed: ' + (err && err.message || err), true); });
  }
  input.addEventListener('blur', saveDue);
  input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') saveDue(); ev.stopPropagation(); });
});

// Mark Submitted handler
document.addEventListener('click', function (e) {
  var chip = e.target.closest('[data-act="filing-submit"]');
  if (!chip) return;
  e.preventDefault(); e.stopPropagation();
  var key = chip.dataset.key;
  var periodId = chip.dataset.period;
  var filingId = chip.dataset.filingId;
  var methodsStr = chip.dataset.methods || '';
  var uploadedFiles = window._filingUploads && window._filingUploads[key];
  var method = null;
  if (filingId === 'vat-return') {
    method = null;
  } else if (uploadedFiles && uploadedFiles.length) {
    method = 'pdf';
  } else if (methodsStr.indexOf('sru') >= 0) {
    method = 'sru';
  } else if (methodsStr.indexOf('pdf') >= 0) {
    FB.status.show('Upload a PDF first, then Mark Submitted.', true);
    return;
  }
  postAction('filing.mark_submitted', { periodId: periodId, key: key, method: method, attachmentId: uploadedFiles && uploadedFiles[0] }).then(function (r) {
    FB.status.show('Filed.');
    if (window._filingUploads) delete window._filingUploads[key];
    loadFilings(true);
  }).catch(function (err) {
    FB.status.show('Submit failed: ' + ((err && err.error && err.error.message) || err && err.message || err), true);
  });
});

// Unsubmit handler
document.addEventListener('click', function (e) {
  var chip = e.target.closest('[data-act="filing-unsubmit"]');
  if (!chip) return;
  e.preventDefault(); e.stopPropagation();
  var key = chip.dataset.key;
  var periodId = chip.dataset.period;
  if (!confirm('Clear submitted status? (Attachments are preserved.)')) return;
  postAction('filing.unmark_submitted', { periodId: periodId, key: key }).then(function () {
    FB.status.show('Unsubmitted.');
    loadFilings(true);
  }).catch(function (err) { FB.status.show('Unsubmit failed: ' + (err && err.message || err), true); });
});

// Upload PDF handler (file input change)
document.addEventListener('change', function (e) {
  var input = e.target.closest('[data-act="filing-upload"]');
  if (!input) return;
  e.stopPropagation();
  var key = input.dataset.key;
  var periodId = input.dataset.period;
  var file = input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function () {
    var b64 = reader.result.split(',')[1];
    postAction('attachment.upload', {
      entityType: 'filing', entityId: key,
      filename: file.name, contentBase64: b64, contentType: file.type || 'application/pdf',
    }).then(function (r) {
      var attId = (r && r.data && r.data.attachment_id) || (r && r.attachment_id);
      window._filingUploads = window._filingUploads || {};
      window._filingUploads[key] = [attId];
      FB.status.show('Uploaded ' + file.name + '. Click Mark Submitted.');
    }).catch(function (err) { FB.status.show('Upload failed: ' + (err && err.message || err), true); });
  };
  reader.readAsDataURL(file);
});

// Expand-row toggles: Facts ▸ and Periodiseringsfond ▸
document.addEventListener('click', function (e) {
  var chip = e.target.closest('[data-act="expand-facts"]');
  if (!chip) return;
  e.preventDefault(); e.stopPropagation();
  var key = chip.dataset.key;
  var periodId = chip.dataset.period;
  var safeKey = key.replace(/[^a-z0-9]/gi, '');
  var panel = document.getElementById('facts-panel-' + safeKey);
  var expandRow = panel ? panel.parentElement : null;
  if (!expandRow) return;
  if (expandRow.style.display === 'none') {
    expandRow.style.display = '';
    renderFactsPanel(panel, key, periodId);
  } else {
    expandRow.style.display = 'none';
  }
});

document.addEventListener('click', function (e) {
  var chip = e.target.closest('[data-act="expand-pf"]');
  if (!chip) return;
  e.preventDefault(); e.stopPropagation();
  var key = chip.dataset.key;
  var periodId = chip.dataset.period;
  var safeKey = key.replace(/[^a-z0-9]/gi, '');
  var panel = document.getElementById('pf-panel-' + safeKey);
  var expandRow = panel ? panel.parentElement : null;
  if (!expandRow) return;
  if (expandRow.style.display === 'none') {
    expandRow.style.display = '';
    renderPfPanel(panel, key, periodId);
  } else {
    expandRow.style.display = 'none';
  }
});

function renderFactsPanel(panel, key, periodId) {
  postAction('period.list', {}).then(function (res) {
    var rows = (res && res.data) || res || [];
    var p = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].period_id === periodId) { p = rows[i]; break; }
    var ta = (p && p.tax_attrs) || {};
    if (typeof ta === 'string') { try { ta = JSON.parse(ta); } catch (x) { ta = {}; } }
    var facts = ta.ar_facts || {};
    panel.innerHTML = '<div style="padding:12px">'
      + '<h3 style="font-size:11pt;margin:0 0 12px">Annual Report Facts</h3>'
      + '<table class="edit-table" style="max-width:700px">'
      + '<tr><td>Board members (one per line)</td><td><textarea id="facts-board" rows="3" style="width:300px">' + esc((facts.board_members || []).map(function(m){return m.name + (m.role ? ' (' + m.role + ')':'');}).join('\\n')) + '</textarea></td></tr>'
      + '<tr><td>Shares total</td><td><input type="number" id="facts-shares" value="' + (facts.shares_total || 0) + '" style="width:120px"></td></tr>'
      + '<tr><td>Quota value</td><td><input type="number" id="facts-quota" value="' + (facts.quota_value || 1) + '" style="width:120px"></td></tr>'
      + '<tr><td>Proposed dividend</td><td><input type="number" id="facts-dividend" value="' + (facts.proposed_dividend || 0) + '" style="width:120px"></td></tr>'
      + '<tr><td>Employees (avg)</td><td><input type="number" id="facts-emp-avg" value="' + (facts.employees_avg || 0) + '" style="width:120px"></td></tr>'
      + '<tr><td>Employees (men)</td><td><input type="number" id="facts-emp-men" value="' + (facts.employees_men || 0) + '" style="width:120px"></td></tr>'
      + '<tr><td>Employees (women)</td><td><input type="number" id="facts-emp-women" value="' + (facts.employees_women || 0) + '" style="width:120px"></td></tr>'
      + '<tr><td>Salaries total</td><td><input type="number" id="facts-sal" value="' + (facts.salaries_total || 0) + '" style="width:120px"></td></tr>'
      + '<tr><td>Board salaries</td><td><input type="number" id="facts-sal-board" value="' + (facts.salaries_board || 0) + '" style="width:120px"></td></tr>'
      + '<tr><td>Social total</td><td><input type="number" id="facts-social" value="' + (facts.social_total || 0) + '" style="width:120px"></td></tr>'
      + '<tr><td>Pension total</td><td><input type="number" id="facts-pension" value="' + (facts.pension_total || 0) + '" style="width:120px"></td></tr>'
      + '<tr><td>Verksamhet</td><td><textarea id="facts-verksamhet" rows="2" style="width:400px">' + esc(facts.verksamhet || '') + '</textarea></td></tr>'
      + '<tr><td>Handelser (events)</td><td><textarea id="facts-handelser" rows="2" style="width:400px">' + esc(facts.handelser_ar || '') + '</textarea></td></tr>'
      + '<tr><td>Pledged assets</td><td><textarea id="facts-pledged" rows="2" style="width:400px">' + esc(facts.pledged || '') + '</textarea></td></tr>'
      + '<tr><td>Subsequent events</td><td><textarea id="facts-subsequent" rows="2" style="width:400px">' + esc(facts.subsequent || '') + '</textarea></td></tr>'
      + '</table>'
      + '<div style="margin-top:12px"><a class="chip" data-act="facts-save" data-key="' + esc(key) + '" data-period="' + esc(periodId) + '">Save</a></div>'
      + '</div>';
  }).catch(function (err) { panel.innerHTML = '<div style="padding:12px;color:#b91c1c">Failed: ' + esc(err && err.message || err) + '</div>'; });
}

document.addEventListener('click', function (e) {
  var chip = e.target.closest('[data-act="facts-save"]');
  if (!chip) return;
  e.preventDefault(); e.stopPropagation();
  var key = chip.dataset.key;
  var periodId = chip.dataset.period;
  var boardText = (document.getElementById('facts-board') || {}).value || '';
  var boardMembers = boardText.split('\\n').map(function (l) { var m = l.trim().match(/^(.+?)\\s*\\((.+?)\\)\\s*$/); return m ? { name: m[1], role: m[2] } : { name: l.trim(), role: '' }; }).filter(function (m) { return m.name; });
  var patch = {
    ar_facts: {
      board_members: boardMembers,
      shares_total: Number((document.getElementById('facts-shares') || {}).value || 0),
      quota_value: Number((document.getElementById('facts-quota') || {}).value || 1),
      proposed_dividend: Number((document.getElementById('facts-dividend') || {}).value || 0),
      employees_avg: Number((document.getElementById('facts-emp-avg') || {}).value || 0),
      employees_men: Number((document.getElementById('facts-emp-men') || {}).value || 0),
      employees_women: Number((document.getElementById('facts-emp-women') || {}).value || 0),
      salaries_total: Number((document.getElementById('facts-sal') || {}).value || 0),
      salaries_board: Number((document.getElementById('facts-sal-board') || {}).value || 0),
      social_total: Number((document.getElementById('facts-social') || {}).value || 0),
      pension_total: Number((document.getElementById('facts-pension') || {}).value || 0),
      verksamhet: (document.getElementById('facts-verksamhet') || {}).value || '',
      handelser_ar: (document.getElementById('facts-handelser') || {}).value || '',
      pledged: (document.getElementById('facts-pledged') || {}).value || '',
      subsequent: (document.getElementById('facts-subsequent') || {}).value || '',
    },
  };
  postAction('filing.save_period_attrs', { periodId: periodId, patch: patch }).then(function () {
    FB.status.show('Facts saved.');
  }).catch(function (err) { FB.status.show('Save failed: ' + (err && err.message || err), true); });
});

function renderPfPanel(panel, key, periodId) {
  postAction('period.list', {}).then(function (res) {
    var rows = (res && res.data) || res || [];
    var p = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].period_id === periodId) { p = rows[i]; break; }
    var ta = (p && p.tax_attrs) || {};
    if (typeof ta === 'string') { try { ta = JSON.parse(ta); } catch (x) { ta = {}; } }
    var tranches = ta.periodiseringsfond || [];
    var lossCf = ta.loss_cf != null ? ta.loss_cf : '';
    var currentYear = new Date().getUTCFullYear();
    var html = '<div style="padding:12px">'
      + '<h3 style="font-size:11pt;margin:0 0 12px">Periodiseringsfond</h3>'
      + '<table class="edit-table" style="max-width:600px" id="pf-tranches-table">'
      + '<thead><tr><th>Year</th><th>Amount</th><th>Reversed</th><th></th></tr></thead><tbody>';
    tranches.forEach(function (t, idx) {
      var dueWarn = (t.year + 6) <= currentYear && !t.reversed;
      html += '<tr data-pf-idx="' + idx + '">'
        + '<td><input type="number" class="pf-year" value="' + (t.year || '') + '" style="width:80px"></td>'
        + '<td><input type="number" class="pf-amount" value="' + (t.amount || 0) + '" style="width:120px"></td>'
        + '<td><input type="checkbox" class="pf-reversed"' + (t.reversed ? ' checked' : '') + '></td>'
        + '<td>' + (dueWarn ? '<span class="due-past">Due to reverse</span>' : '') + '</td>'
        + '</tr>';
    });
    html += '</tbody></table>'
      + '<div style="margin-top:8px"><a class="chip" data-act="pf-add">Add tranche</a></div>'
      + '<h3 style="font-size:11pt;margin:16px 0 8px">Loss carryforward override</h3>'
      + '<input type="number" id="pf-losscf" value="' + esc(String(lossCf)) + '" style="width:120px" placeholder="manual override">'
      + '<div style="margin-top:12px"><a class="chip" data-act="pf-save" data-key="' + esc(key) + '" data-period="' + esc(periodId) + '">Save</a></div>'
      + '</div>';
    panel.innerHTML = html;
  }).catch(function (err) { panel.innerHTML = '<div style="padding:12px;color:#b91c1c">Failed: ' + esc(err && err.message || err) + '</div>'; });
}

document.addEventListener('click', function (e) {
  var chip = e.target.closest('[data-act="pf-add"]');
  if (!chip) return;
  e.preventDefault(); e.stopPropagation();
  var table = document.getElementById('pf-tranches-table');
  if (!table) return;
  var tb2 = table.querySelector('tbody');
  var idx = tb2.children.length;
  var tr = document.createElement('tr');
  tr.setAttribute('data-pf-idx', idx);
  tr.innerHTML = '<td><input type="number" class="pf-year" style="width:80px"></td>'
    + '<td><input type="number" class="pf-amount" style="width:120px" value="0"></td>'
    + '<td><input type="checkbox" class="pf-reversed"></td><td></td>';
  tb2.appendChild(tr);
});

document.addEventListener('click', function (e) {
  var chip = e.target.closest('[data-act="pf-save"]');
  if (!chip) return;
  e.preventDefault(); e.stopPropagation();
  var key = chip.dataset.key;
  var periodId = chip.dataset.period;
  var table = document.getElementById('pf-tranches-table');
  if (!table) return;
  var tranches = [];
  table.querySelectorAll('tbody tr').forEach(function (tr) {
    var year = Number(tr.querySelector('.pf-year').value || 0);
    var amount = Number(tr.querySelector('.pf-amount').value || 0);
    var reversed = tr.querySelector('.pf-reversed').checked;
    if (year) tranches.push({ year: year, amount: amount, reversed: reversed });
  });
  var lossCf = document.getElementById('pf-losscf');
  var patch = { periodiseringsfond: tranches };
  if (lossCf && lossCf.value !== '') patch.loss_cf = Number(lossCf.value);
  postAction('filing.save_period_attrs', { periodId: periodId, patch: patch }).then(function () {
    FB.status.show('Saved.');
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
