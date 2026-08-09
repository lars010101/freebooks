'use strict';
const { queryPositional } = require('../db');
const fs = require('fs');
const path = require('path');
const { ROUTES } = require('../nav-registry');
const { REPORT_REGISTRY } = require('../report-registry');

function makeQuery() {
  return function query(sql, params = []) {
    return queryPositional(sql, params);
  };
}

// ── Relevance flags (settings-ux-spec §7 item 9 + fx-automation-spec §1) ────
// Single server-side read of the two visibility flags that gate whole UI
// surfaces app-wide. Page handlers await this and pass the result into their
// templates for server-side conditional rendering (no async client hiding,
// no flash of gated content). Defaults: vatRegistered=true, fxTracking='auto'
// — unknown/absent values render the full UI (the safe superset) so a fresh
// company with no settings row yet isn't accidentally stripped.
//
// Returns { vatRegistered, fxTracking, baseCurrency }:
//   vatRegistered — boolean (companies.vat_registered; false hides all tax/VAT
//     surface area on documents and reports);
//   fxTracking    — 'auto' | 'off' (settings.fx_tracking; 'off' locks currency
//     fields to base currency and hides FX revaluation entry points);
//   baseCurrency  — companies.currency (the lock target when fxTracking='off').
async function getRelevanceFlags(companyId) {
  if (!companyId) return { vatRegistered: true, fxTracking: 'auto', baseCurrency: '' };
  try {
    const { query } = require('../db');
    const [co] = await query(
      `SELECT vat_registered, currency AS base_currency
       FROM (SELECT *, ROW_NUMBER() OVER(PARTITION BY company_id ORDER BY created_at DESC) AS rn FROM companies) t
       WHERE company_id = @cid AND rn = 1`,
      { cid: String(companyId) }
    );
    const sRows = await query(
      `SELECT key, value FROM settings WHERE company_id = @cid`,
      { cid: String(companyId) }
    );
    const settings = {};
    for (const r of sRows) settings[r.key] = r.value;
    return {
      vatRegistered: !co || co.vat_registered !== false && co.vat_registered !== 0,
      fxTracking: settings.fx_tracking === 'off' ? 'off' : 'auto',
      baseCurrency: (co && co.base_currency) || ''
    };
  } catch (e) {
    return { vatRegistered: true, fxTracking: 'auto', baseCurrency: '' };
  }
}

// Serialize flags for embedding as window.__fbFlags in a page bootstrap.
// Editor logic that needs the flags at runtime (e.g. bill editor deciding
// whether to render the VAT column dynamically) reads window.__fbFlags.
function flagsBootstrapJson(flags) {
  const f = flags || {};
  return JSON.stringify({
    vatRegistered: f.vatRegistered !== false,
    fxTracking: f.fxTracking === 'off' ? 'off' : 'auto',
    baseCurrency: f.baseCurrency || ''
  });
}

// ── Asset versioning ──────────────────────────────────────────────────────────
// ?v= tracks each public file's mtime, so the buster changes exactly when the
// file does — manual date bumps get forgotten and stale fb-core.js breaks pages
// (wireHeader throws → no focus, no dropdowns). maxAge:0+etag on /public makes
// this belt-and-braces, but it also defeats proxy/service-worker caches.
function assetV(file) {
  try { return fs.statSync(path.join(__dirname, '..', '..', 'public', file)).mtimeMs; }
  catch (e) { return Date.now(); }
}

// ── CSS ───────────────────────────────────────────────────────────────────────
function commonStyle() {
  return `<link rel="stylesheet" href="/public/common.css?v=${assetV('common.css')}">
<script src="/public/fb-core.js?v=${assetV('fb-core.js')}"></script>
<script src="/public/fb-command.js?v=${assetV('fb-command.js')}"></script>
<script src="/public/fb-list.js?v=${assetV('fb-list.js')}"></script>
<script src="/public/fb-form.js?v=${assetV('fb-form.js')}"></script>
<script src="/public/fb-attachments.js?v=${assetV('fb-attachments.js')}"></script>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📒</text></svg>">`;
}

// ── Top-bar context items per section ─────────────────────────────────────────
function topBarContext(company, activeKey) {
  // Returns { nav: html, actions: html }
  const sep = `<div class="tb-divider"></div>`;

  function navLink(label, href, active, disabled) {
    const cls = ['tb-nav-link', active ? 'tb-nav-active' : '', disabled ? 'tb-disabled' : ''].filter(Boolean).join(' ');
    return `<a href="${href}" class="${cls}">${label}</a>`;
  }
  function actionBtn(label, href, primary) {
    return `<a href="${href}" class="tb-btn${primary ? ' tb-btn-primary' : ''}">${label}</a>`;
  }

  void actionBtn; // retained for potential future static slots

  const ctx = {
    dashboard:  { nav: ``, actions: '' },
    bank:       { nav: ``, actions: '' },
    payables:   { nav: ``, actions: '' },
    reports:    { nav: ``, actions: '' },
    auditor:    { nav: ``, actions: '' },
    settings:   { nav: ``, actions: '' },
    newjv:      { nav: '',  actions: '' }
  };

  return ctx[activeKey] || { nav: '', actions: '' };
}

// ── Main layout function ───────────────────────────────────────────────────────
// The route registry (api/src/nav-registry.js) is injected as window.FB_ROUTES
// so fb-core's g-prefix map and the palette nav source consume the same table.
function navBar(company, activeKey) {
  const ctx = topBarContext(company, activeKey);

  // Inject the route registry for fb-core consumption (g-map + palette).
  const routesJson = JSON.stringify(ROUTES);
  const reportIds = REPORT_REGISTRY.map(r => r.id);

  // Company switcher dropdown — detached from the (deleted) sidebar; lives in
  // the app-shell so fbToggleCompany(event) can still open it from the status
  // line or the g c keyboard shortcut.
  return `<script>window.FB_ROUTES = ${routesJson}; window.FB_REPORT_IDS = ${JSON.stringify(reportIds)};</script>
<div id="app-shell" data-company="${company}">
  <div class="tb-company-dropdown" id="tb-company-dropdown" style="display:none"></div>
  <div id="main-area">
    <header id="top-bar">
      <div class="tb-left">
        <div class="tb-global-controls">
          <div class="tb-search-wrap">
            <input type="text" id="tb-global-search" class="tb-search" placeholder="Search (/) or Command (:) — leading / filters this list …" autocomplete="off" tabindex="-1">
          </div>
          <span id="tb-status-msg" class="tb-status-msg"></span>
        </div>
      </div>
      <div class="tb-right">
        <span id="tb-dyn-slots"></span>
        ${ctx.actions}
        <a href="/${company}/journal/new" class="tb-btn tb-btn-quiet">+ Journal Entry</a>
        <button class="tb-icon-btn" id="tb-notif-btn" title="Notifications">🔔<span id="tb-notif-badge" class="tb-notif-badge" hidden></span></button>
        <button class="tb-icon-btn" id="tb-help-btn" title="Keyboard shortcuts (?)">?</button>
      </div>
    </header>
    <div id="tb-notif-dropdown" class="tb-notif-dropdown" hidden></div>
    <main id="page-main">`;
}

// ── Layout close ──────────────────────────────────────────────────────────────
function layoutEnd() {
  return `    </main>
    <footer id="fb-status-line">
      <span class="fb-sl-company" onclick="fbToggleCompany(event)" title="Switch company (g c)"></span>
      <span class="fb-sl-sep">·</span>
      <span class="fb-sl-period" id="fb-sl-period"></span>
      <span class="fb-sl-sep">·</span>
      <span class="fb-sl-inbox" id="fb-sl-inbox">0 pending</span>
      <span class="fb-sl-spacer"></span>
      <span id="fb-vim-mode">NORMAL</span>
    </footer>
  </div>
</div>
<script src="/public/common.js?v=${assetV('common.js')}"></script>`;
}

module.exports = { makeQuery, commonStyle, navBar, layoutEnd, getRelevanceFlags, flagsBootstrapJson };
