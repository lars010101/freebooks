'use strict';
const { commonStyle, navBar, layoutEnd } = require('./common');

async function handleAdminPage(req, res) {
  const { company } = req.params;
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildAdminPage(company));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function buildAdminPage(company) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Admin - freeBooks</title>
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
  .pe-ro { color:#888; }

  /* Operations tab — card grid */
  .ops-grid { display:flex; flex-wrap:wrap; gap:16px; margin-top:8px; }
  .ops-card { border:1px solid #e8e8e8; border-radius:8px; padding:20px 24px; background:#fff; cursor:pointer; min-width:240px; max-width:320px; }
  .ops-card.fb-nav-focus { outline:2px solid #1a1a1a; outline-offset:2px; }
  .ops-card-title { font-weight:700; font-size:11pt; margin-bottom:4px; }
  .ops-card-desc { font-size:9pt; color:#888; }
  .ops-card.disabled { opacity:0.5; cursor:default; }
  .ops-card.disabled .ops-card-title:after { content: ' — Coming soon'; font-weight:400; color:#aaa; font-size:9pt; }
</style>
</head>
<body>${navBar(company, 'admin')}
<div class="page">
  <div class="header">
    <h1>🛠 Admin</h1>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="showTab('companies')">Companies</div>
    <div class="tab" onclick="showTab('operations')">Operations</div>
  </div>

  <!-- COMPANIES TAB -->
  <div id="tab-companies" class="tab-panel active">
    <table class="edit-table" id="companies-table">
      <thead><tr><th>Name</th><th>Company ID</th><th>Jurisdiction</th><th>Currency</th></tr></thead>
      <tbody id="companies-body">
        <tr><td colspan="4" style="text-align:center;color:#aaa;padding:32px">Loading&#8230;</td></tr>
      </tbody>
    </table>
  </div>

  <!-- OPERATIONS TAB -->
  <div id="tab-operations" class="tab-panel">
    <div class="ops-grid" id="ops-grid">
      <div class="ops-card disabled" data-action="test-llm">
        <div class="ops-card-title">Test LLM Connection</div>
        <div class="ops-card-desc">Coming soon</div>
      </div>
    </div>
  </div>

</div>

<script>
var COMPANY = '${company}';
var tabLoaded = {};

function showTab(t) {
  var cur = document.querySelector('.tab-panel.active');
  var curTab = cur ? cur.id.replace('tab-','') : '';
  if (curTab && curTab !== t) {
    if (window.FB && FB.list && FB.list.anyDirty()) {
      FB.list.guard(function(){ showTab(t); });
      return;
    }
  }
  var tabs = ['companies','operations'];
  document.querySelectorAll('.tab').forEach(function(el,i){ el.classList.toggle('active', tabs[i]===t); });
  document.querySelectorAll('.tab-panel').forEach(function(el){ el.classList.remove('active'); });
  document.getElementById('tab-'+t).classList.add('active');
  var hintEl = document.getElementById('sb-hints');
  if (hintEl) {
    if (t === 'companies') FB.keys.renderHints('admin-companies', hintEl);
    else if (t === 'operations') FB.keys.renderHints('admin-ops', hintEl, { layout: 'list' });
    else hintEl.innerHTML = '';
  }
  if (!tabLoaded[t]) {
    tabLoaded[t] = true;
    if (t === 'companies') loadCompanies();
    if (t === 'operations') initOpsNav();
  }
}

function showMsg(id, msg, isErr) {
  if (window.FB && FB.status) FB.status.show(msg, isErr);
}

// ========== COMPANIES — FB.list (read-mostly browse + switch) =========
var companiesList = FB.list.create({
  keysId: 'admin-companies',
  active: function() { var p = document.getElementById('tab-companies'); return !!(p && p.classList.contains('active')); },
  tbody: 'companies-body',
  companyId: function() { return COMPANY; },
  canAdd: false,
  canDelete: false,
  canRename: false,
  columns: [
    { field: 'company_name', type: 'text', width: 200, ro: 'always' },
    { field: 'company_id', type: 'text', width: 120, ro: 'always' },
    { field: 'jurisdiction', type: 'text', width: 80, ro: 'always' },
    { field: 'currency', type: 'text', width: 60, ro: 'always' }
  ],
  blank: function() { return null; },
  isBlank: function() { return true; },
  same: function() { return true; },
  validate: function() { return null; },
  track: 'company',
  list: { action: 'company.list',
    map: function(c) { return { company_name: c.company_name || '', company_id: c.company_id || '', jurisdiction: c.jurisdiction || '', currency: c.currency || c.base_currency || '', _key: c.company_id }; } },
  // Row click / Enter: switch company then redirect to Inbox
  onActivate: function(d) {
    if (!d || !d._key) return;
    try { localStorage.setItem('freebooks_company', d._key); } catch (e) {}
    window.location.href = '/' + d._key;
  },
  actions: [
    { key: 'o', label: '+ New company', handler: function (api) {
      window.location.href = '/setup/new-company';
    } }
  ]
});

function loadCompanies() { companiesList.load(); }

// ========== OPERATIONS TAB — FB.nav card grid =========
var opsNav;

function initOpsNav() {
  opsNav = FB.nav.create({
    focusClass: 'fb-nav-focus',
    grid: function () {
      return [Array.from(document.querySelectorAll('.ops-card')).filter(function (el) { return el.offsetParent !== null; })];
    }
  });
  FB.keys.register('admin-ops', {
    bindings: [
      { key: 'j', mode: 'NORMAL', hint: 'navigate', hintBar: true, paletteEligible: false,
        swallow: function () { return opsNav.current(); },
        run: function () { opsNav.move(1); } },
      { key: 'k', mode: 'NORMAL', hint: 'navigate', hintBar: true, paletteEligible: false,
        swallow: function () { return opsNav.current(); },
        run: function () { opsNav.move(-1); } },
      { key: 'h', mode: 'NORMAL', hint: 'left', hintBar: true, paletteEligible: false,
        swallow: function () { return opsNav.current(); },
        run: function () { opsNav.moveH(-1); } },
      { key: 'l', mode: 'NORMAL', hint: 'right', hintBar: true, paletteEligible: false,
        swallow: function () { return opsNav.current(); },
        run: function () { opsNav.moveH(1); } },
      { key: 'Enter', mode: 'NORMAL', hint: 'run', hintBar: true, paletteEligible: false,
        swallow: function () { return opsNav.current(); },
        run: function () {
          var el = opsNav.current();
          if (!el) return;
          if (el.classList.contains('disabled')) { showMsg('ops', 'Coming soon', false); return; }
          var action = el.getAttribute('data-action');
          if (action === 'test-llm') { showMsg('ops', 'Coming soon', false); }
        } },
      { key: 'Escape', mode: 'NORMAL', hint: 'clear focus', hintBar: true, paletteEligible: false,
        swallow: function () { return !!opsNav.current(); },
        run: function () { opsNav.clear(); } }
    ]
  });
}

// ========== HANDLE ?tab= URL PARAM ==========
(function() {
  var params = new URLSearchParams(window.location.search);
  var tab = params.get('tab');
  showTab(tab || 'companies');
})();
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleAdminPage };
