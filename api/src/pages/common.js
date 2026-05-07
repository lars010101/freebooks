'use strict';
const { queryPositional } = require('../db');

function makeQuery() {
  return function query(sql, params = []) {
    return queryPositional(sql, params);
  };
}

// ── CSS ───────────────────────────────────────────────────────────────────────
function commonStyle() {
  return `<link rel="stylesheet" href="/public/common.css">
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

  const ctx = {
    dashboard: {
      nav: ``,
      actions: `
        ${actionBtn('+ Bill', `/${company}/bill/new`, false)}
        <span class="tb-btn" style="opacity:.4;cursor:default" title="Invoicing coming soon">+ Invoice</span>
        ${actionBtn('+ Statement', `/${company}/bank/import`, false)}`
    },
    bank: {
      nav: ``,
      actions: `${actionBtn('+ Statement', `/${company}/bank/import`)}`
    },
    payables: {
      nav: ``,
      actions: `${actionBtn('+ Bill', `/${company}/bill/new`)}`
    },
    receivables: {
      nav: ``,
      actions: `${actionBtn('+ Invoice', '#', false)}`
    },
    reports: {
      nav: ``,
      actions: ''
    },
    auditor: {
      nav: ``,
      actions: ''
    },
    settings: {
      nav: ``,
      actions: ''
    },
    newjv: {
      nav: '',
      actions: ''
    }
  };

  return ctx[activeKey] || { nav: '', actions: '' };
}

// ── Main layout function ───────────────────────────────────────────────────────
function navBar(company, activeKey) {
  const sidebarItems = [
    { key: 'dashboard',   icon: '📊', label: 'Dashboard',   href: `/${company}` },
    { key: 'bank',        icon: '🏦', label: 'Bank',        href: `/${company}/bank` },
    { key: 'payables',    icon: '📋', label: 'Payables',     href: `/${company}/payables` },
    { key: 'receivables', icon: '📄', label: 'Receivables',  href: `/${company}/receivables` },
    { key: 'reports',     icon: '📈', label: 'Reports',      href: `/${company}/reports` },
    { key: 'settings',    icon: '⚙',  label: 'Settings',     href: `/${company}/settings` },
  ];

  const navHtml = sidebarItems.map(item => {
    const isActive = item.key === activeKey || (activeKey === 'newjv' && item.key === 'dashboard');
    const cls = ['sb-item', isActive ? 'sb-active' : '', item.disabled ? 'sb-disabled' : ''].filter(Boolean).join(' ');
    const tag = item.disabled ? 'span' : 'a';
    const href = item.disabled ? '' : ` href="${item.href}"`;
    return `<${tag}${href} class="${cls}" data-label="${item.label}">
        <span class="sb-icon">${item.icon}</span>
        <span class="sb-label">${item.label}</span>
      </${tag}>`;
  }).join('\n      ');

  const ctx = topBarContext(company, activeKey);

  // Prefetch adjacent sidebar pages for fast { } navigation
  const activeIdx = sidebarItems.findIndex(i => i.key === activeKey || (activeKey === 'newjv' && i.key === 'dashboard'));
  let prefetchHtml = '';
  if (activeIdx > 0) prefetchHtml += `<link rel="prefetch" href="${sidebarItems[activeIdx - 1].href}">`;
  if (activeIdx >= 0 && activeIdx < sidebarItems.length - 1) prefetchHtml += `<link rel="prefetch" href="${sidebarItems[activeIdx + 1].href}">`;

  return `${prefetchHtml}
<div id="app-shell" data-company="${company}">
  <aside id="sidebar">
    <div class="sb-header" onclick="fbToggleCompany(event)" style="cursor:pointer" title="Switch company">
      <div class="sb-co-name">${company}</div>
      <div class="sb-co-sub">freeBooks <span class="sb-co-caret">▾</span></div>
      <div class="tb-company-dropdown" id="tb-company-dropdown" style="display:none;left:12px;top:auto;margin-top:6px"></div>
    </div>
    <nav class="sb-nav">
      ${navHtml}
    </nav>
    <div class="sb-footer">
      <div class="sb-footer-row">
        <button class="sb-icon-action" id="fb-theme-btn" onclick="fbToggleTheme()" title="Toggle theme">
          <span id="fb-theme-icon">☀</span>
        </button>
        <button class="sb-icon-action" id="fb-collapse-btn" onclick="fbToggleSidebar()" title="Collapse sidebar">
          <span id="fb-collapse-icon">«</span>
        </button>
      </div>
      <div id="fb-vim-mode">NORMAL</div>
    </div>
  </aside>

  <div id="main-area">
    <header id="top-bar">
      <div class="tb-left">
        <div class="tb-global-controls">
          <div class="tb-search-wrap">
            <input type="text" id="tb-global-search" class="tb-search" placeholder="⌘  Search (/) or Command (:) …" autocomplete="off" tabindex="-1">
          </div>
          <span id="tb-status-msg" class="tb-status-msg"></span>
        </div>
      </div>
      <div class="tb-right">
        ${ctx.actions}
        <a href="/${company}/journal/new" class="tb-btn">+ Journal Entry</a>
        <button class="tb-icon-btn" title="Notifications">🔔</button>
        <button class="tb-icon-btn" title="Help">?</button>
      </div>
    </header>
    <main id="page-main">`;
}

// ── Layout close ──────────────────────────────────────────────────────────────
function layoutEnd() {
  return `    </main>
  </div>
</div>
<script src="/public/common.js"></script>`;
}

module.exports = { makeQuery, commonStyle, navBar, layoutEnd };
