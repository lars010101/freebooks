'use strict';
const { makeQuery, commonStyle, navBar, layoutEnd } = require('./common');

async function handleSettingsPage(req, res) {
  const { company } = req.params;
  // IA-spec step 4 (§5.10, 2026-08-04): Periods promoted to a top-level
  // section; the Settings Periods tab was removed. Old deep links redirect.
  if (req.query && req.query.tab === 'periods') {
    return res.redirect(302, '/' + company + '/periods');
  }
  // 2026-08-11 IA restructure: COA, Tax Codes, Journals, Exchange Rates moved
  // to Master Data. Deep links redirect there.
  if (req.query && ['coa', 'vat', 'journals', 'fxrates'].includes(req.query.tab)) {
    return res.redirect(302, '/' + company + '/master-data?tab=' + req.query.tab);
  }
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildSettingsPage(company));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}


function buildSettingsPage(company) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Settings - freeBooks</title>
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
  table.edit-table .ro { background:#f5f5f5; color:#888; padding:4px 6px; border-radius:3px; display:block; }
  .field-row { display:flex; flex-direction:column; gap:4px; margin-bottom:14px; }
  .field-row label { font-weight:600; font-size:10pt; color:#555; }
  .field-row input[type=text], .field-row select { padding:7px 10px; border:1px solid #ccc; border-radius:4px; font-size:10pt; max-width:300px; }
  .msg { margin-top:10px; font-size:10pt; }
  .msg.ok { color:#2a8a2a; }
  .msg.err { color:#cc2222; }
  .pe-ro { color:#888; }
  tr.row-dirty > td:first-child { box-shadow: inset 3px 0 0 #d97706; }
  .dirty-val { color:#b45309; }
  tr.row-editing > td { background:#fffbeb; }
  .row-actions { white-space:nowrap; text-align:right; }
  .type-badge { display:inline-block; padding:1px 7px; border-radius:3px; font-size:9pt; font-weight:600; }
  table.edit-table .action-btn { padding:4px 12px; border:1px solid #ccc; border-radius:3px; background:#f5f5f5; cursor:pointer; font-size:10pt; }
  table.edit-table .action-btn:hover { background:#e8e8e8; }
  table.edit-table .action-btn:disabled { color:#888; cursor:default; }
</style>
</head>
<body>${navBar(company, 'settings')}
<div class="page">
  <div class="header">
    <h1>⚙ Settings</h1>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="showTab('company')">Company<span id="tab-dot-company" style="display:none;color:#d97706"> ●</span></div>
    <div class="tab" onclick="showTab('postrules')">Posting Rules<span id="tab-dot-postrules" style="display:none;color:#d97706"> ●</span></div>
    <div class="tab" onclick="showTab('ai')">AI<span id="tab-dot-ai" style="display:none;color:#d97706"> ●</span></div>
  </div>

  <!-- 2026-08-11 IA restructure: COA, Tax Codes, Journals, Exchange Rates moved
       to the new Master Data page (/:company/master-data). Deep links redirect. -->

  <!-- COMPANY TAB — FB.list attribute/value grid (settings-ux-spec §7 item 1
       rev. 3, supersedes the slim record form). One FIXED row per company
       attribute (canAdd: false — no add, no delete; every row is critical).
       Columns Attribute | Value | Type; only the Value cell edits, with a
       per-row editor (text/number/checkbox/select) resolved from the
       server-sent row shape. w writes ONE attribute via company.attr.save
       (server-authoritative validation); u reverts; Esc never saves. -->
  <div id="tab-company" class="tab-panel active">
    <table class="edit-table" id="company-attrs-table">
      <thead><tr><th>Attribute</th><th>Value</th><th>Type</th><th></th></tr></thead>
      <tbody id="company-attrs-body"></tbody>
    </table>

    <!-- DANGER ZONE — settings-ux-spec §7 item 1 rev 2026-07-27 final.
         Deletes the CURRENT company via company.delete. Server guards:
         last-company refusal + posted-books (journal entries) refusal. On
         success the client redirects to the first surviving company. -->
    <div id="company-danger-zone" class="company-danger-zone"
         style="margin-top:28px;padding:14px 18px;border:1px solid #cc2222;border-radius:6px;background:#fff5f5">
      <div style="font-weight:700;color:#cc2222;font-size:10pt;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px">Danger Zone</div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap">
        <div style="font-size:10pt;color:#333">Delete this company and all of its books. This is permanent and cannot be undone.</div>
        <button type="button" class="btn-sm danger" id="cr-delete-btn" onclick="companyDanger.confirmDelete()">Delete this company</button>
      </div>
    </div>
  </div>

  <!-- POSTING RULES TAB — fields that govern automatic calculation during posting:
       FX conversion rate sourcing and VAT match tolerance. Split from Company
       (settings-ux-spec: Company tab is entity-only; posting rules are separate). -->
  <div id="tab-postrules" class="tab-panel">
    <table class="edit-table" id="postrules-attrs-table">
      <thead><tr><th>Attribute</th><th>Value</th><th>Type</th><th></th></tr></thead>
      <tbody id="postrules-attrs-body"></tbody>
    </table>
  </div>

  <!-- AI TAB — flattened attribute grid (settings-ai-flattened-spec.md).
       Same FB.list pattern as Company tab: Attribute | Value | Type, per-row
       edit/commit, tab-level dirty dot. No page-level Save button.
       Test connection and Agent status are tracked as issues #179/#180. -->
  <div id="tab-ai" class="tab-panel">
    <table class="edit-table" id="ai-attrs-table">
      <thead><tr><th>Attribute</th><th>Value</th><th>Type</th><th></th></tr></thead>
      <tbody id="ai-attrs-body"></tbody>
    </table>
  </div>

</div>

<script>
var COMPANY = '${company}';
var VAT_NAMES = { SG:'GST', SE:'VAT' };

// ========== DIRTY STATE MANAGER (all tabs) ==========
var dirtyTabs = new Set();
var tabLoaded = {};
function markDirty(tab) {
  dirtyTabs.add(tab);
  var btn = document.getElementById('btn-save-' + tab);
  if (btn) btn.disabled = false;
}
function resetDirty(tab) {
  dirtyTabs.delete(tab);
  var btn = document.getElementById('btn-save-' + tab);
  if (btn) btn.disabled = true;
}

function showTab(t) {
  var cur = document.querySelector('.tab-panel.active');
  var curTab = cur ? cur.id.replace('tab-','') : '';
  if (curTab && curTab !== t) {
    // Modal doctrine (docs/settings-ux-spec.md §4): dirty rows in ANY FB.list
    // tab route through the Save/Discard/Stay modal. Buffers are page-global,
    // so the guard fires when leaving ANY tab.
    if (window.FB && FB.list && FB.list.anyDirty()) {
      FB.list.guard(function(){ showTab(t); });
      return;
    }
    if (dirtyTabs.has(curTab)) {
      if (!confirm('You have unsaved changes. Discard?')) return;
      resetDirty(curTab);
    }
  }
  var tabs = ['company','postrules','ai'];
  document.querySelectorAll('.tab').forEach(function(el,i){ el.classList.toggle('active', tabs[i]===t); });
  document.querySelectorAll('.tab-panel').forEach(function(el){ el.classList.remove('active'); });
  document.getElementById('tab-'+t).classList.add('active');
  var hintEl = document.getElementById('sb-hints');
  if (hintEl) {
    if (t === 'company') renderCompanyHints();
    else if (t === 'postrules') renderPostRulesHints();
    else if (t === 'ai') renderAiHints();
    else hintEl.innerHTML = '';
  }
  if (!tabLoaded[t]) {
    tabLoaded[t] = true;
    if (t === 'company')  { loadCompanyAttrs(); }
    if (t === 'postrules') { loadPostRulesAttrs(); }
    if (t === 'ai')       { loadAiSettings(); }
  }
}

function showMsg(id, msg, isErr) {
  // The ONE status channel (2026-07-23): the topbar slot via FB.status.
  // Per-screen spans retired; never auto-dismisses — a message stays until
  // the next one replaces it. The id arg is accepted for back-compat.
  if (window.FB && FB.status) FB.status.show(msg, isErr);
}

function wireDirty(tr, tab) {
  var els = tr.querySelectorAll('input,select');
  els.forEach(function(el){
    var prev = el.oninput;
    el.oninput = function(e){ if (prev) prev.call(this, e); markDirty(tab); };
    var prevC = el.onchange;
    el.onchange = function(e){ if (prevC) prevC.call(this, e); markDirty(tab); };
  });
}

// ========== COMPANY ATTRIBUTES — FB.list (settings-ux-spec §7 item 1 rev. 3) =========
// One FIXED row per company attribute: canAdd false, no delete — every row is
// critical. The server owns the attribute registry (company.attr.list returns
// labels, display strings and per-row editor shapes); the client renders what
// it is given. Only the Value cell edits — the editor type comes from the row
// (column editor fn, fb-list rev 2026-07-27). w writes ONE attribute via
// company.attr.save — validation is server-authoritative (Magnus: these are
// highly sensitive settings; front-end checks are advisory only). Company ID
// is a read-only row (editable false). The danger zone stays an action below.
var companyAttrs = FB.list.create({
  keysId: 'settings-company',
  active: function() { var p = document.getElementById('tab-company'); return !!(p && p.classList.contains('active')); },
  tbody: 'company-attrs-body',
  companyId: function() { return COMPANY; },
  canAdd: false,
  hint: 'Fixed rows — one per company attribute. Only the Value cell edits (i); w writes one attribute, u reverts, Esc cancels. Validation happens on the server at write time. FX API Key: a blank edit keeps the stored key.',
  columns: [
    { field: 'label', type: 'text', width: 190, ro: 'always', label: 'Attribute',
      display: function(v) { return '<span style="font-weight:600">' + esc(v) + '</span>'; } },
    { field: 'value', type: 'text', width: 300, label: 'Value',
      display: function(v, d) {
        if (!d._dirty) return esc(d.display != null ? String(d.display) : '');
        // Dirty preview: render the buffer value in the row's own terms.
        var ed = d.editor || {};
        if (ed.type === 'checkbox') return v ? 'Yes' : 'No';
        if (ed.type === 'select') {
          var opts = ed.options || [];
          for (var i = 0; i < opts.length; i++) {
            var o = opts[i], ov = (typeof o === 'string') ? o : o.value;
            if (ov === v) return esc((typeof o === 'string') ? (o || '- none -') : o.label);
          }
          return esc(String(v));
        }
        if (ed.type === 'number') {
          return d._key === 'vat_tolerance_pct' ? esc(Number(v).toFixed(2) + '%') : esc(String(Number(v)));
        }
        return (v !== '' && v != null) ? esc(String(v)) : '<span class="pe-ro">—</span>';
      },
      editor: function(d) { return d.editor || { type: 'text' }; } },
    { field: 'type_label', type: 'text', width: 70, ro: 'always', label: 'Type', filterType: null,
      display: function(v) { return '<span class="pe-ro">' + esc(v) + '</span>'; } }
  ],
  editable: function(d) { return !d.readonly; },
  same: function(b, s) { return b.value === s.value; },
  validate: function() { return null; }, // server-authoritative (settings-ux-spec §7 item 1 rev. 3)
  firstField: function() { return 'value'; },
  track: 'company-attr',
  list: { action: 'company.attr.list',
    map: function(r) { return { label: r.label, value: r.value, display: r.display, type_label: r.type, editor: r.editor, readonly: !!r.readonly, _key: r.key }; } },
  save: { action: 'company.attr.save',
    body: function(d) { return { key: d._key, value: d.value }; },
    focusKey: function(d) { return d._key; } },
  onChrome: function(dirty) {
    var dot = document.getElementById('tab-dot-company');
    if (dot) dot.style.display = dirty ? '' : 'none';
    if (dirty) markDirty('company'); else resetDirty('company');
  },
  onLoaded: function(rows) {
    // Side-effects the rest of the page reads from the current company:
    // the danger zone addresses the company by name.
    var byKey = {};
    rows.forEach(function(r) { byKey[r._key] = r; });
    companyDanger.setCompany(
      byKey.company_id ? byKey.company_id.value : COMPANY,
      byKey.company_name ? byKey.company_name.value : COMPANY
    );
  }
});

function loadCompanyAttrs(focusKey) { return companyAttrs.load(focusKey); }
function renderCompanyHints() {
  var el = document.getElementById('sb-hints');
  if (el) companyAttrs.renderHints(el);
}

// ========== COMPANY DANGER ZONE (delete) =========
// Action, not a grid row. Routes the CURRENT company through company.delete;
// the styled fb-modal surfaces the irreversibility confirmation and, on
// INVALID_STATE, the server's explanatory message (last-company / posted-books
// refusals). Identity comes from the attribute grid's onLoaded.
var companyDanger = (function () {
  var current = { id: null, name: '' };

  function setCompany(id, name) { current = { id: id, name: name }; }

  // K2: FB.modal type-to-confirm (keyboard-ux-spec §7) — an exact company-name
  // match arms the danger button; Enter inside the input activates it; the
  // button carries NO letter key (deliberate friction); Esc/backdrop cancel.
  function confirmDelete() {
    if (!current.id) { showMsg('msg-company', 'No company loaded', true); return; }
    var name = current.name || current.id;
    FB.modal.open({
      title: 'Delete "' + name + '"?',
      body: 'This will permanently delete the company and all of its books (accounts, periods, journals, bills, settings, …). <strong>This cannot be undone.</strong>',
      typeConfirm: { match: name, label: 'Type the company name (' + name + ') to confirm' },
      buttons: [
        { label: 'Delete company', danger: true, requiresConfirm: true, onClick: function (api) { doDelete(api); } },
        { label: 'Cancel', onClick: function (api) { api.close(); } }
      ]
    });
  }

  function doDelete(api) {
    var confirmBtn = api.btn(0);
    var cancelBtn = api.btn(1);
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Deleting…'; }
    if (cancelBtn) { cancelBtn.disabled = true; }
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'company.delete', companyId: current.id }) })
      .then(function (r){ return r.json(); })
      .then(function (res){
        var d = res.data || res;
        if (res.error || d.error) {
          // Surface the server's message inside the modal (last-company /
          // posted-books refusals explain themselves). Re-enable the buttons
          // so the user can dismiss or retry.
          var errText = (res.error && res.error.message) || res.error || (d.error && d.error.message) || d.error;
          api.error(String(errText));
          if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Delete company'; }
          if (cancelBtn) { cancelBtn.disabled = false; }
          return;
        }
        var remaining = (d && Array.isArray(d.remaining)) ? d.remaining : [];
        var next = remaining[0];
        api.close();
        if (next) {
          // Switch the active company and redirect to the survivor's settings.
          try { localStorage.setItem('freebooks_company', next); } catch (e) {}
          window.location.href = '/' + next + '/settings';
        } else {
          // No survivors — shouldn't happen (server refuses the last company),
          // but degrade gracefully back to the new-company page.
          window.location.href = '/setup/new-company';
        }
      })
      .catch(function (e){ 
        api.error(e.message);
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Delete company'; }
        if (cancelBtn) { cancelBtn.disabled = false; }
      });
  }

  return { setCompany: setCompany, confirmDelete: confirmDelete };
})();

// ========== UNSAVED CHANGES PROTECTION ==========
window.onbeforeunload = function(e) {
  if (dirtyTabs.size > 0) {
    var msg = 'You have unsaved changes.';
    e.returnValue = msg;
    return msg;
  }
};


// ========== POSTING RULES TAB — FB.list =========
// Split from Company (settings-ux-spec): Multi-Currency, FX Provider, FX API
// Key, VAT Tolerance (flat/%) — fields that govern automatic calculation
// during posting. Same FB.list pattern as Company/AI tabs. Each row edits
// and saves independently via posting_rules.attr.save (server-authoritative).
var postRulesAttrs = FB.list.create({
  keysId: 'settings-postrules',
  active: function() { var p = document.getElementById('tab-postrules'); return !!(p && p.classList.contains('active')); },
  tbody: 'postrules-attrs-body',
  companyId: function() { return COMPANY; },
  canAdd: false,
  hint: 'Fixed rows — posting rules that govern FX conversion and VAT tolerance during posting. Only the Value cell edits (i); w writes one attribute, u reverts, Esc cancels. Validation happens on the server at write time. FX API Key: a blank edit keeps the stored key.',
  columns: [
    { field: 'label', type: 'text', width: 190, ro: 'always', label: 'Attribute',
      display: function(v) { return '<span style="font-weight:600">' + esc(v) + '</span>'; } },
    { field: 'value', type: 'text', width: 300, label: 'Value',
      display: function(v, d) {
        if (!d._dirty) return esc(d.display != null ? String(d.display) : '');
        var ed = d.editor || {};
        if (ed.type === 'checkbox') return v ? 'Yes' : 'No';
        if (ed.type === 'select') {
          var opts = ed.options || [];
          for (var i = 0; i < opts.length; i++) {
            var o = opts[i], ov = (typeof o === 'string') ? o : o.value;
            if (ov === v) return esc((typeof o === 'string') ? (o || '- none -') : o.label);
          }
          return esc(String(v));
        }
        if (ed.type === 'number') {
          return d._key === 'vat_tolerance_pct' ? esc(Number(v).toFixed(2) + '%') : esc(String(Number(v)));
        }
        return (v !== '' && v != null) ? esc(String(v)) : '<span class="pe-ro">—</span>';
      },
      editor: function(d) { return d.editor || { type: 'text' }; } },
    { field: 'type_label', type: 'text', width: 70, ro: 'always', label: 'Type', filterType: null,
      display: function(v) { return '<span class="pe-ro">' + esc(v) + '</span>'; } }
  ],
  editable: function(d) { return !d.readonly; },
  same: function(b, s) { return b.value === s.value; },
  validate: function() { return null; },
  firstField: function() { return 'value'; },
  track: 'postrules-attr',
  list: { action: 'posting_rules.attr.list',
    map: function(r) { return { label: r.label, value: r.value, display: r.display, type_label: r.type, editor: r.editor, readonly: !!r.readonly, _key: r.key }; } },
  save: { action: 'posting_rules.attr.save',
    body: function(d) { return { key: d._key, value: d.value }; },
    focusKey: function(d) { return d._key; },
    // Show "Downloading FX rates..." in the status bar before the save
    // round-trip when this edit triggers a blocking FX scan server-side.
    onSaveStart: function(d) {
      var triggers = (d._key === 'multi_currency' && (d.value === true || d.value === 'true')) ||
                     (d._key === 'fx_provider' && d.value !== 'manual');
      if (triggers && window.FB && FB.status) FB.status.show('Downloading FX rates...', false);
    },
    // The save response carries fxScanResult when a scan ran.
    onSaved: function(d, res) {
      // When multi_currency is toggled, re-fetch the posting rules to
      // update the Exchange Rates tab visibility on the Master Data page.
      // The Settings page itself has no FX tab (IA restructure moved it
      // to Master Data), so we just ensure the value is correct for the
      // next navigation. The Master Data page re-evaluates on every load.
      var r = res && res.fxScanResult;
      if (!r) return null; // no scan — default 'Saved'
      if (r.error) return 'FX scan failed: ' + r.error;
      var fetched = r.fetched || 0, notified = r.notified || 0;
      return 'FX rates downloaded: ' + fetched + (notified ? ' (' + notified + ' gap notification' + (notified === 1 ? '' : 's') + ')' : '');
    } },
  onChrome: function(dirty) {
    var dot = document.getElementById('tab-dot-postrules');
    if (dot) dot.style.display = dirty ? '' : 'none';
    if (dirty) markDirty('postrules'); else resetDirty('postrules');
  }
});

function loadPostRulesAttrs(focusKey) { return postRulesAttrs.load(focusKey); }
function renderPostRulesHints() {
  var el = document.getElementById('sb-hints');
  if (el) postRulesAttrs.renderHints(el);
}

// ========== AI TAB — FB.list (settings-ai-flattened-spec.md) =========
// Flattened from grouped sections into a single Attribute/Value/Type grid,
// mirroring the Company tab pattern. Each row edits and saves independently
// via ai.attr.save (server-authoritative validation). The Test connection
// row (#179) is type "Action": readonly, renders a button in the Value cell
// that fires ai.test_connection — no edit/commit cycle. Agent status is
// deferred (#180).
var aiAttrs = FB.list.create({
  keysId: 'settings-ai',
  active: function() { var p = document.getElementById('tab-ai'); return !!(p && p.classList.contains('active')); },
  tbody: 'ai-attrs-body',
  companyId: function() { return COMPANY; },
  canAdd: false,
  columns: [
    { field: 'label', type: 'text', width: 190, ro: 'always', label: 'Attribute',
      display: function(v) { return '<span style="font-weight:600">' + esc(v) + '</span>'; } },
    { field: 'value', type: 'text', width: 300, label: 'Value',
      display: function(v, d) {
        // Action row (#179): render a button instead of text. The row is
        // readonly so editable() returns false — it never enters edit mode;
        // the click is wired separately in onLoaded below.
        if (d.editor && d.editor.type === 'action') {
          return '<button type="button" class="action-btn" data-action="' + esc(d.editor.action || '') + '" data-key="' + esc(d._key || '') + '">Test connection</button>';
        }
        if (!d._dirty) return esc(d.display != null ? String(d.display) : '');
        var ed = d.editor || {};
        if (ed.type === 'checkbox') return v ? 'Yes' : 'No';
        if (ed.type === 'number') return esc(String(Number(v)));
        return (v !== '' && v != null) ? esc(String(v)) : '<span class="pe-ro">—</span>';
      },
      editor: function(d) { return d.editor || { type: 'text' }; } },
    { field: 'type_label', type: 'text', width: 70, ro: 'always', label: 'Type', filterType: null,
      display: function(v) { return '<span class="pe-ro">' + esc(v) + '</span>'; } }
  ],
  editable: function(d) { return !d.readonly; },
  same: function(b, s) { return b.value === s.value; },
  validate: function() { return null; },
  firstField: function() { return 'value'; },
  track: 'ai-attr',
  list: { action: 'ai.attr.list',
    map: function(r) { return { label: r.label, value: r.value, display: r.display, type_label: r.type, editor: r.editor, readonly: !!r.readonly, _key: r.key }; } },
  save: { action: 'ai.attr.save',
    body: function(d) { return { key: d._key, value: d.value }; },
    focusKey: function(d) { return d._key; } },
  rowVerbs: [
    { key: 'Enter', label: 'test', hint: 'Run test connection',
      when: function(d) { return d.editor && d.editor.type === 'action'; },
      affordance: function(d) { return ''; },
      run: function(api, d) {
        var btn = document.querySelector('#ai-attrs-body button.action-btn[data-key="' + esc(d._key) + '"]');
        if (btn && !btn.disabled) btn.click();
      } }
  ],
  onLoaded: function() {
    // Wire up any Action-type buttons in the AI grid (#179). Each button
    // posts ai.test_connection and reports the outcome through FB.status.
    var tbody = document.getElementById('ai-attrs-body');
    if (!tbody) return;
    var btns = tbody.querySelectorAll('button.action-btn[data-action="ai.test_connection"]');
    for (var i = 0; i < btns.length; i++) {
      (function(btn) {
        if (btn.dataset.wired) return;
        btn.dataset.wired = '1';
        btn.addEventListener('click', function() {
          if (btn.disabled) return;
          var orig = 'Test connection';
          btn.disabled = true;
          btn.textContent = 'Testing…';
          fetch('/api/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'ai.test_connection', companyId: COMPANY })
          }).then(function(r) { return r.json(); }).then(function(res) {
            // The API wrapper sends { ok: true, data: result } for any action
            // that doesn't throw — res.ok just means "action executed", not
            // "connection succeeded". The test_connection action returns its
            // own { ok, error, models } inside data. Check d.ok, not res.ok.
            var d = res.data || res;
            if (d && d.ok) {
              var models = (d.models && d.models.length) ? ' (' + d.models.length + ' models)' : '';
              if (window.FB && FB.status) FB.status.show('✓ Connected' + models, false);
            } else {
              if (window.FB && FB.status) FB.status.show('✗ ' + ((d && d.error) || res.error || 'Connection failed'), true);
            }
          }).catch(function(e) {
            if (window.FB && FB.status) FB.status.show('✗ Connection failed: ' + (e && e.message || e), true);
          }).then(function() {
            btn.disabled = false;
            btn.textContent = orig;
          });
        });
      })(btns[i]);
    }
  },
  onChrome: function(dirty) {
    var dot = document.getElementById('tab-dot-ai');
    if (dot) dot.style.display = dirty ? '' : 'none';
    if (dirty) markDirty('ai'); else resetDirty('ai');
  }
});

function loadAiSettings(focusKey) { return aiAttrs.load(focusKey); }
function renderAiHints() {
  var el = document.getElementById('sb-hints');
  if (el) aiAttrs.renderHints(el);
}

// ========== HANDLE ?tab= URL PARAM ==========
(function() {
  var params = new URLSearchParams(window.location.search);
  var tab = params.get('tab');
  // Load the Company AND Posting Rules attribute grids EAGERLY even when
  // ?tab= deep-links elsewhere: relevance flags are derived from their rows.
  tabLoaded['company'] = true;
  loadCompanyAttrs();
  tabLoaded['postrules'] = true;
  loadPostRulesAttrs();
  showTab(tab || 'company');
})();
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleSettingsPage };
