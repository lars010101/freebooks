'use strict';
const { queryPositional } = require('../db');
const fs = require('fs');
const path = require('path');
const { ROUTES } = require('../nav-registry');

function makeQuery() {
  return function query(sql, params = []) {
    return queryPositional(sql, params);
  };
}

// ── Relevance flags (settings-ux-spec §7 item 9 + fx-automation-spec §1) ────
// Single server-side read of the two visibility flags that gate whole UI
// surfaces app-wide. Page handlers await this and pass the result into their
// templates for server-side conditional rendering (no async client hiding,
// no flash of gated content). Defaults: vatRegistered=true, fxTracking='true'
// — unknown/absent values render the full UI (the safe superset) so a fresh
// company with no settings row yet isn't accidentally stripped.
//
// Returns { vatRegistered, fxTracking, baseCurrency }:
//   vatRegistered — boolean (companies.vat_registered; false hides all tax/VAT
//     surface area on documents and reports);
//   fxTracking    — 'true' | 'false' (settings.fx_tracking; 'false' locks currency
//     fields to base currency and hides FX revaluation entry points);
//   baseCurrency  — companies.currency (the lock target when fxTracking='false').
//   centersConfigured — boolean (true when ≥1 active row exists in `centers`
//     for this company; gates the Cost Center/Profit Center JV columns, per
//     journal-voucher-field-fixes-spec §2.1 — detected, not toggled).
async function getRelevanceFlags(companyId) {
  if (!companyId) return { vatRegistered: true, fxTracking: 'false', whtTracking: 'false', baseCurrency: '', centersConfigured: false, jurisdiction: '' };
  try {
    const { query } = require('../db');
    const [co] = await query(
      `SELECT vat_registered, currency AS base_currency, jurisdiction
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
    // §2.1: lightweight EXISTS — does this company have ≥1 active center?
    // Gates JV Cost Center/Profit Center column visibility (detected, not a
    // settings flag). Computed once here, baked into the page the same way
    // vatRegistered/fxTracking already are.
    const [centerRow] = await query(
      `SELECT 1 FROM centers WHERE company_id = @cid AND is_active = true LIMIT 1`,
      { cid: String(companyId) }
    );
    return {
      vatRegistered: !co || co.vat_registered !== false && co.vat_registered !== 0,
      fxTracking: settings.fx_tracking === 'true' ? 'true' : 'false',
      whtTracking: settings.wht_tracking === 'true' ? 'true' : 'false',
      baseCurrency: (co && co.base_currency) || '',
      jurisdiction: (co && co.jurisdiction) || '',
      centersConfigured: !!centerRow
    };
  } catch (e) {
    return { vatRegistered: true, fxTracking: 'false', whtTracking: 'false', baseCurrency: '', centersConfigured: false, jurisdiction: '' };
  }
}

// Serialize flags for embedding as window.__fbFlags in a page bootstrap.
// Editor logic that needs the flags at runtime (e.g. bill editor deciding
// whether to render the VAT column dynamically) reads window.__fbFlags.
function flagsBootstrapJson(flags) {
  const f = flags || {};
  return JSON.stringify({
    vatRegistered: f.vatRegistered !== false,
    fxTracking: f.fxTracking === 'false' ? 'false' : 'true',
    whtTracking: f.whtTracking === 'true' ? 'true' : 'false',
    baseCurrency: f.baseCurrency || '',
    centersConfigured: f.centersConfigured === true,
    // Jurisdiction-aware number formatting (docs/UI.md — negative numbers,
    // decimals, thousands separators): FB.util.fmtAmt reads this.
    jurisdiction: f.jurisdiction || ''
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
  // Returns { nav: html } — actions slot deleted (topbar-chrome-spec §8:
  // every actions value was already '' — dead code, removed outright).
  const sep = `<div class="tb-divider"></div>`;

  function navLink(label, href, active, disabled) {
    const cls = ['tb-nav-link', active ? 'tb-nav-active' : '', disabled ? 'tb-disabled' : ''].filter(Boolean).join(' ');
    return `<a href="${href}" class="${cls}">${label}</a>`;
  }
  void sep; void navLink; // retained for potential future static slots

  const ctx = {
    inbox:       { nav: `` },
    payables:    { nav: `` },
    statements:  { nav: `` },
    journal:     { nav: `` },
    calendar:    { nav: `` },
    documents:   { nav: `` },
    settings:    { nav: `` },
    accounting:  { nav: `` },
    'exchange-rates': { nav: `` },
    newjv:       { nav: '' }
  };

  return ctx[activeKey] || { nav: '' };
}

// ── Main layout function ───────────────────────────────────────────────────────
// The route registry (api/src/nav-registry.js) is injected as window.FB_ROUTES
// so fb-core's g-prefix map and the palette nav source consume the same table.
function navBar(company, activeKey) {
  const ctx = topBarContext(company, activeKey);

  // Inject the route registry for fb-core consumption (g-map + palette).
  const routesJson = JSON.stringify(ROUTES);

  // Company switcher dropdown — detached from the (deleted) sidebar; lives in
  // the app-shell so fbToggleCompany(event) can still open it from the status
  // line or the g w keyboard shortcut.
  return `<script>window.FB_ROUTES = ${routesJson};</script>
<div id="app-shell" data-company="${company}">
  <div class="tb-company-dropdown" id="tb-company-dropdown" style="display:none"></div>
  <div id="main-area">
    <header id="top-bar">
      <div class="tb-left">
        <button class="tb-company-trigger" onclick="fbToggleCompany(event)" title="Switch company (g w)" aria-label="Switch company">
          <span class="tb-mark" id="tb-company-mark"></span>
          <span class="fb-sl-company"></span>
          <span class="tb-company-caret">▾</span>
        </button>
        <div class="tb-divider"></div>
        <span id="tb-period-trigger" class="tb-period-trigger" onclick="FB.period.togglePopover(event)" title="Period selector">Period</span>
      </div>
      <div class="tb-right">
        <div class="tb-search-wrap">
          <svg class="tb-search-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.4"/><path d="M11.5 11.5L15 15" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          <input type="text" id="tb-global-search" class="tb-search" placeholder="Type / to search" autocomplete="off" tabindex="-1">
        </div>
        <button class="tb-icon-btn tb-chat-btn" id="tb-chat-btn" title="Chat with AI" aria-label="Chat with AI"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2a7 7 0 00-7 7c0 1.8.7 3.4 1.9 4.6L5 21l5.6-2A7 7 0 1012 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg><span id="tb-chat-dot" class="tb-chat-dot" hidden></span></button>
        <button class="tb-icon-btn" id="tb-new-btn" title="New" aria-label="New"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
        <div id="tb-new-dropdown" class="tb-new-dropdown" hidden></div>
        <button class="tb-icon-btn" id="tb-notif-btn" title="Notifications" aria-label="Notifications"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 8a6 6 0 0112 0c0 4 1.5 5.5 1.5 5.5H4.5S6 12 6 8z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9.5 17.5a2.5 2.5 0 005 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span id="tb-notif-badge" class="tb-notif-badge" hidden></span></button>
        <button class="tb-icon-btn" id="tb-dl-btn" title="Download (SIE / CSV / PDF)" aria-label="Download"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v11m0 0l-4.5-4.5M12 14l4.5-4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
        <button class="tb-icon-btn" id="fb-density-btn" title="Switch density" aria-label="Switch density" onclick="fbToggleDensity()"><span id="fb-density-icon"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5h16M4 10h16M4 15h16M4 20h16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span></button>
        <button class="tb-icon-btn" id="fb-theme-btn" title="Switch theme" aria-label="Switch theme" onclick="fbToggleTheme()"><span id="fb-theme-icon"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.6"/></svg></span></button>
        <button class="tb-icon-btn" id="tb-help-btn" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M9.3 9.5a2.7 2.7 0 115.1 1.2c-.6.9-1.7 1.2-1.7 2.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="16.3" r="0.9" fill="currentColor"/></svg></button>
      </div>
    </header>
    <div id="fb-status-banner" class="fb-status-banner">
      <div class="fb-banner-inner">
        <span id="tb-status-msg" class="tb-status-msg"></span>
      </div>
    </div>
    <div id="tb-notif-dropdown" class="tb-notif-dropdown" hidden></div>
    <div id="tb-dl-dropdown" class="tb-dl-dropdown" hidden></div>
    <div id="tb-period-popover" class="tb-period-popover" hidden></div>
    <main id="page-main">`;
}

// ── Layout close ──────────────────────────────────────────────────────────────
function layoutEnd() {
  return `    </main>
  </div>
</div>
<script src="/public/common.js?v=${assetV('common.js')}"></script>`;
}

module.exports = { makeQuery, commonStyle, navBar, layoutEnd, getRelevanceFlags, flagsBootstrapJson };
