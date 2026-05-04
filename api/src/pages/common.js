'use strict';
const { queryPositional } = require('../db');

function makeQuery() {
  return function query(sql, params = []) {
    return queryPositional(sql, params);
  };
}

// ── CSS ───────────────────────────────────────────────────────────────────────
function commonStyle() {
  return `<style>
/* ---- Reset & base ---- */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg:          #f2f4f7;
  --surface:     #ffffff;
  --border:      #e4e8ee;
  --text:        #18243a;
  --text-muted:  #6b7a95;
  --text-faint:  #a0aec0;
  --sb-bg:       #18293f;
  --sb-text:     rgba(220,228,242,.72);
  --sb-active-bg: rgba(255,255,255,.11);
  --sb-active-text: #ffffff;
  --sb-hover-bg: rgba(255,255,255,.06);
  --tb-bg:       #f9fafc;
  --tb-border:   #e4e8ee;
  --tb-text:     #18243a;
  --accent:      #18293f;
}
[data-theme="dark"] {
  --bg:          #0e1520;
  --surface:     #18243a;
  --border:      #253348;
  --text:        #dce4f2;
  --text-muted:  #7a8faa;
  --text-faint:  #4a5e78;
  --sb-bg:       #0e1520;
  --sb-text:     rgba(220,228,242,.65);
  --sb-active-bg: rgba(255,255,255,.10);
  --sb-active-text: #ffffff;
  --sb-hover-bg: rgba(255,255,255,.05);
  --tb-bg:       #18243a;
  --tb-border:   #253348;
  --tb-text:     #dce4f2;
  --accent:      #3d6494;
}

html, body { height:100%; }
body {
  font-family: 'Helvetica Neue', Arial, sans-serif;
  font-size: 12pt;
  color: var(--text);
  background: var(--bg);
}

/* ---- App shell ---- */
#app-shell {
  display: flex;
  height: 100vh;
  overflow: hidden;
}

/* ---- Sidebar ---- */
#sidebar {
  width: 220px;
  flex-shrink: 0;
  background: var(--sb-bg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width .2s ease;
  z-index: 100;
}
#sidebar.sb-collapsed { width: 52px; }

.sb-header {
  padding: 20px 16px 18px;
  border-bottom: 1px solid rgba(255,255,255,.07);
  flex-shrink: 0;
}
.sb-co-name {
  font-size: 13.5pt;
  font-weight: 700;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: opacity .15s;
  letter-spacing: -.01em;
}
.sb-co-sub {
  font-size: 8pt;
  color: rgba(220,228,242,.38);
  margin-top: 3px;
  white-space: nowrap;
  transition: opacity .15s;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.sb-co-caret { font-size: 7pt; }
#sidebar.sb-collapsed .sb-co-name,
#sidebar.sb-collapsed .sb-co-sub { opacity: 0; }

.sb-nav {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 10px 0;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,.1) transparent;
}
.sb-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 16px;
  color: var(--sb-text);
  text-decoration: none;
  font-size: 10.5pt;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  background: none;
  border: none;
  width: 100%;
  text-align: left;
  transition: background .12s;
  letter-spacing: .005em;
}
.sb-item:hover { background: var(--sb-hover-bg); color: #fff; }
.sb-item.sb-active { background: var(--sb-active-bg); color: var(--sb-active-text); }
.sb-item.sb-disabled { opacity: .35; pointer-events: none; cursor: default; }
.sb-icon { font-size: 13pt; line-height: 1; flex-shrink: 0; width: 20px; text-align: center; }
.sb-label { transition: opacity .15s, width .15s; overflow: hidden; }
#sidebar.sb-collapsed .sb-label { opacity: 0; width: 0; }

/* Tooltip on collapsed hover */
#sidebar.sb-collapsed .sb-item { position: relative; }
#sidebar.sb-collapsed .sb-item:hover::after {
  content: attr(data-label);
  position: fixed;
  left: 60px;
  background: #333;
  color: #fff;
  padding: 5px 10px;
  border-radius: 4px;
  font-size: 9pt;
  white-space: nowrap;
  z-index: 200;
  pointer-events: none;
}

.sb-footer {
  border-top: 1px solid rgba(255,255,255,.07);
  padding: 8px 0;
  flex-shrink: 0;
}

/* ---- Top bar ---- */
#main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

#top-bar {
  height: 52px;
  background: var(--tb-bg);
  border-bottom: 1px solid var(--tb-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  flex-shrink: 0;
  gap: 16px;
  z-index: 90;
}

.tb-left {
  display: flex;
  align-items: center;
  gap: 0;
  flex: 1;
  min-width: 0;
}
.tb-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

/* Company switcher */
.tb-company {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10pt;
  font-weight: 700;
  color: var(--tb-text);
  cursor: pointer;
  padding: 5px 10px;
  border-radius: 5px;
  border: 1px solid transparent;
  white-space: nowrap;
  flex-shrink: 0;
  position: relative;
  user-select: none;
}
.tb-company:hover { border-color: var(--border); background: var(--bg); }
.tb-company-caret { font-size: 8pt; color: var(--text-muted); margin-left: 2px; }
.tb-company-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,.12);
  min-width: 200px;
  z-index: 300;
  padding: 4px 0;
}
.tb-company-opt {
  display: block;
  padding: 9px 16px;
  font-size: 10pt;
  color: var(--text);
  text-decoration: none;
  cursor: pointer;
}
.tb-company-opt:hover { background: var(--bg); }

/* Section divider between company and nav items */
.tb-divider {
  width: 1px;
  height: 20px;
  background: var(--border);
  margin: 0 12px;
  flex-shrink: 0;
}

/* Top bar nav links */
.tb-nav-link {
  display: inline-flex;
  align-items: center;
  padding: 6px 12px;
  font-size: 10pt;
  color: var(--text-muted);
  text-decoration: none;
  border-radius: 5px;
  white-space: nowrap;
  font-weight: 500;
}
.tb-nav-link:hover { color: var(--text); background: var(--bg); }
.tb-nav-link.tb-nav-active { color: var(--text); font-weight: 600; background: var(--bg); }
.tb-nav-link.tb-disabled { opacity:.4; pointer-events:none; }

/* Top bar action buttons */
.tb-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 14px;
  border-radius: 5px;
  font-size: 9.5pt;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  text-decoration: none;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
}
.tb-btn:hover { background: var(--bg); }
.tb-btn.tb-btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.tb-btn.tb-btn-primary:hover { opacity: .88; }
.tb-icon-btn {
  width: 32px; height: 32px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13pt;
  color: var(--text-muted);
}
.tb-icon-btn:hover { background: var(--bg); color: var(--text); }

/* ---- Page main ---- */
#page-main {
  flex: 1;
  overflow-y: auto;
  background: var(--bg);
}

/* ---- .page content wrapper ---- */
.page {
  padding: 36px 48px;
  max-width: 1100px;
  color: var(--text);
}
.page h1 { font-size: 22pt; font-weight: 700; letter-spacing: -.02em; }
.sub { color: var(--text-muted); font-size: 10pt; margin-top: 4px; }

/* ---- Legacy compat ---- */
.header { margin-bottom: 28px; }
.header h1 { font-size: 20pt; font-weight: 700; }
.header .sub { color: var(--text-muted); font-size: 10pt; margin-top: 4px; }
.company-list { list-style: none; margin-top: 8px; }
.company-list li { border-bottom: 1px solid var(--border); }
.company-list a { display: block; padding: 12px 0; color: var(--text); text-decoration: none; font-size: 12pt; }
.company-list a:hover { color: var(--text-muted); }
.company-list .id { font-size: 9pt; color: var(--text-faint); }
</style>
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
      nav: `${sep}
        ${navLink('P&amp;L', `/${company}?report=pl`, false)}
        ${navLink('Balance Sheet', `/${company}?report=bs`, false)}
        ${navLink('Cash Flow', `/${company}?report=cf`, false)}
        ${navLink('Equity', `/${company}?report=equity`, false)}`,
      actions: ''
    },
    bank: {
      nav: `${sep}
        ${navLink('Reconcile', `/${company}/bank`, activeKey === 'bank')}
        ${navLink('Mappings', `/${company}/settings?tab=bank-mappings`, false)}`,
      actions: `${actionBtn('+ New Statement', `/${company}/bank#import`)}`
    },
    payables: {
      nav: `${sep}
        ${navLink('Bills', `/${company}/payables`, true)}
        ${navLink('Vendors', '#', false, true)}
        ${navLink('AP Aging', `/${company}/payables/aging`, false)}`,
      actions: `${actionBtn('+ New Bill', `/${company}/bill/new`)}`
    },
    receivables: {
      nav: `${sep}
        ${navLink('Invoices', '#', false, true)}
        ${navLink('Customers', '#', false, true)}
        ${navLink('AR Aging', '#', false, true)}`,
      actions: `${actionBtn('+ New Invoice', '#', false)}`
    },
    reports: {
      nav: `${sep}
        ${navLink('P&amp;L', `/${company}?report=pl`, false)}
        ${navLink('Balance Sheet', `/${company}?report=bs`, false)}
        ${navLink('Cash Flow', `/${company}?report=cf`, false)}
        ${navLink('Equity', `/${company}?report=equity`, false)}`,
      actions: ''
    },
    auditor: {
      nav: `${sep}
        ${navLink('Trial Balance', '#', false, true)}
        ${navLink('General Ledger', '#', false, true)}
        ${navLink('Journal', '#', false, true)}
        ${navLink('Integrity Check', '#', false, true)}`,
      actions: ''
    },
    settings: {
      nav: `${sep}
        ${navLink('Company', `/${company}/settings?tab=company`, false)}
        ${navLink('Periods', `/${company}/settings?tab=periods`, false)}
        ${navLink('COA', `/${company}/settings?tab=coa`, false)}
        ${navLink('GST / VAT', `/${company}/settings?tab=tax`, false)}
        ${navLink('Journals', `/${company}/settings?tab=journals`, false)}
        ${navLink('FX Rates', `/${company}/settings?tab=fx`, false)}`,
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
    { key: 'payables',    icon: '📋', label: 'Expenses',    href: `/${company}/payables` },
    { key: 'receivables', icon: '📄', label: 'Sales',       href: '#',                   disabled: true },
    { key: 'settings',    icon: '⚙',  label: 'Settings',    href: `/${company}/settings` },
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

  return `<div id="app-shell">
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
      <button class="sb-item" id="fb-theme-btn" onclick="fbToggleTheme()" data-label="Toggle theme">
        <span class="sb-icon" id="fb-theme-icon">☀</span>
        <span class="sb-label" id="fb-theme-label">Light mode</span>
      </button>
      <button class="sb-item" id="fb-collapse-btn" onclick="fbToggleSidebar()" data-label="Expand">
        <span class="sb-icon" id="fb-collapse-icon">«</span>
        <span class="sb-label">Collapse</span>
      </button>
    </div>
  </aside>

  <div id="main-area">
    <header id="top-bar">
      <div class="tb-left">
        <div class="tb-company" onclick="fbToggleCompany(event)" id="tb-company-btn">
          <span id="tb-company-name">${company}</span>
          <span class="tb-company-caret">▾</span>
          <div class="tb-company-dropdown" id="tb-company-dropdown" style="display:none"></div>
        </div>
        ${ctx.nav}
      </div>
      <div class="tb-right">
        ${ctx.actions}
        <a href="/${company}/journal/new" class="tb-btn tb-btn-primary">+ New JV</a>
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
<script>
(function() {
  // ── Theme ──
  function fbApplyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    var icon = document.getElementById('fb-theme-icon');
    var lbl  = document.getElementById('fb-theme-label');
    if (icon) icon.textContent = t === 'dark' ? '🌙' : '☀';
    if (lbl)  lbl.textContent  = t === 'dark' ? 'Dark mode' : 'Light mode';
  }
  window.fbToggleTheme = function() {
    var cur = document.documentElement.getAttribute('data-theme') || 'light';
    var next = cur === 'dark' ? 'light' : 'dark';
    localStorage.setItem('fb-theme', next);
    fbApplyTheme(next);
  };
  fbApplyTheme(localStorage.getItem('fb-theme') || 'light');

  // ── Sidebar collapse ──
  function fbApplySidebar(collapsed) {
    var sb = document.getElementById('sidebar');
    var icon = document.getElementById('fb-collapse-icon');
    var btn = document.getElementById('fb-collapse-btn');
    if (!sb) return;
    if (collapsed) {
      sb.classList.add('sb-collapsed');
      if (icon) icon.textContent = '»';
      if (btn)  btn.setAttribute('data-label', 'Expand');
    } else {
      sb.classList.remove('sb-collapsed');
      if (icon) icon.textContent = '«';
      if (btn)  btn.setAttribute('data-label', 'Collapse');
    }
  }
  window.fbToggleSidebar = function() {
    var collapsed = !document.getElementById('sidebar').classList.contains('sb-collapsed');
    localStorage.setItem('fb-sidebar-collapsed', collapsed ? '1' : '0');
    fbApplySidebar(collapsed);
  };
  fbApplySidebar(localStorage.getItem('fb-sidebar-collapsed') === '1');

  // ── Company switcher ──
  window.fbToggleCompany = function(e) {
    e.stopPropagation();
    var dd = document.getElementById('tb-company-dropdown');
    if (!dd) return;
    var open = dd.style.display !== 'none';
    dd.style.display = open ? 'none' : '';
    if (!open && !dd._loaded) {
      dd._loaded = true;
      fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action:'company.list' }) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        var cos = res.data || res || [];
        if (!Array.isArray(cos) || !cos.length) { dd.innerHTML='<div class="tb-company-opt" style="color:#888">No other companies</div>'; return; }
        dd.innerHTML = cos.map(function(c){
          return '<a class="tb-company-opt" href="/'+c.company_id+'">'+c.name+'<br><small style="color:#aaa;font-size:8pt">'+c.company_id+'</small></a>';
        }).join('');
      })
      .catch(function(){ dd.innerHTML='<div class="tb-company-opt" style="color:#cc2222">Error loading</div>'; });
    }
  };
  document.addEventListener('click', function() {
    var dd = document.getElementById('tb-company-dropdown');
    if (dd) dd.style.display = 'none';
  });
})();
</script>`;
}

module.exports = { makeQuery, commonStyle, navBar, layoutEnd };
