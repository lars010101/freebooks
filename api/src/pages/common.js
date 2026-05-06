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
  /* Typography scale — rem-based, respects browser/OS accessibility settings */
  font-size: 100%;
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
  font-size: 1rem;
  line-height: 1.6;
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
  font-size: 1.125rem;
  font-weight: 700;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: opacity .15s;
  letter-spacing: -.01em;
}
.sb-co-sub {
  font-size: 0.75rem;
  color: rgba(220,228,242,.38);
  margin-top: 3px;
  white-space: nowrap;
  transition: opacity .15s;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.sb-co-caret { font-size: 0.625rem; }
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
  padding: 14px 18px;
  color: var(--sb-text);
  text-decoration: none;
  font-size: 0.917rem;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  background: none;
  border: none;
  width: 100%;
  text-align: left;
  transition: background .12s;
  letter-spacing: .01em;
}
.sb-item:hover { background: var(--sb-hover-bg); color: #fff; }
.sb-item.sb-active { background: var(--sb-active-bg); color: var(--sb-active-text); }
.sb-item.sb-disabled { opacity: .35; pointer-events: none; cursor: default; }
.sb-icon { font-size: 1.083rem; line-height: 1; flex-shrink: 0; width: 20px; text-align: center; }
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
  font-size: 0.75rem;
  white-space: nowrap;
  z-index: 200;
  pointer-events: none;
}

.sb-footer {
  border-top: 1px solid rgba(255,255,255,.07);
  padding: 8px 0;
  flex-shrink: 0;
}

/* ---- Vim mode indicator ---- */
#fb-vim-mode {
  font-size: 9px;
  font-family: 'SF Mono', 'Fira Mono', monospace;
  color: rgba(220,228,242,.35);
  letter-spacing: .08em;
  text-transform: uppercase;
  padding: 1px 8px 0;
  white-space: nowrap;
  overflow: hidden;
  transition: color .15s;
  user-select: none;
}
#fb-vim-mode.insert { color: #4ade80; }
#sidebar.sb-collapsed #fb-vim-mode { opacity: 0; }

/* ---- Table row keyboard focus ---- */
tr.nav-row-focus > td {
  background: var(--accent) !important;
  color: #fff !important;
  outline: none;
}
tr.nav-row-focus > td a { color: #fff !important; }

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

/* Company switcher dropdown (sidebar) */
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
  font-size: 0.833rem;
  color: var(--text);
  text-decoration: none;
  cursor: pointer;
}
.tb-company-opt:hover { background: var(--bg); }

/* Section divider between nav items */
.tb-divider {
  width: 1px;
  height: 20px;
  background: var(--border);
  margin: 0 12px;
  flex-shrink: 0;
}

/* Top bar search */
.tb-search {
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg);
  color: var(--text-muted);
  font-size: 0.875rem;
  width: 220px;
  outline: none;
  cursor: not-allowed;
}

/* Global search + command palette */
.tb-global-controls { display:flex; align-items:center; gap:8px; flex:1; max-width:480px; }
.tb-search-wrap { flex:1; }
.tb-search { width:100%; padding:6px 12px; border:1px solid var(--border); border-radius:6px; font-size:0.875rem; background:var(--surface-alt,#f5f5f5); color:var(--text); outline:none; cursor:text; }
.tb-search:focus { border-color:var(--accent,#1a1a1a); background:var(--surface,#fff); }
.tb-cmd-btn { padding:6px 12px; border:1px solid var(--border); border-radius:6px; font-size:0.875rem; background:var(--surface-alt,#f5f5f5); color:var(--text); cursor:pointer; white-space:nowrap; }
.tb-cmd-btn:hover { background:var(--border); }

/* Top bar nav links */
.tb-nav-link {
  display: inline-flex;
  align-items: center;
  padding: 6px 14px;
  font-size: 0.875rem;
  color: var(--text-muted);
  text-decoration: none;
  border-radius: 5px;
  white-space: nowrap;
  font-weight: 600;
  letter-spacing: .01em;
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
  font-size: 0.875rem;
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
  font-size: 1.083rem;
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
.page h1 { font-size: clamp(1.375rem, 1.5vw + 1rem, 1.833rem); font-weight: 700; letter-spacing: -.02em; }
.sub { color: var(--text-muted); font-size: 0.833rem; margin-top: 4px; }

/* ---- Legacy compat ---- */
.header { margin-bottom: 28px; }
.header h1 { font-size: clamp(1.25rem, 1.25vw + 0.875rem, 1.667rem); font-weight: 700; }
.header .sub { color: var(--text-muted); font-size: 0.833rem; margin-top: 4px; }
.company-list { list-style: none; margin-top: 8px; }
.company-list li { border-bottom: 1px solid var(--border); }
.company-list a { display: block; padding: 12px 0; color: var(--text); text-decoration: none; font-size: 1rem; }
.company-list a:hover { color: var(--text-muted); }
.company-list .id { font-size: 0.75rem; color: var(--text-faint); }

/* ---- Sidebar footer icon row ---- */
.sb-footer-row {
  display: flex;
  padding: 6px 10px;
  gap: 4px;
}
.sb-icon-action {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px;
  background: none;
  border: none;
  border-radius: 5px;
  color: var(--sb-text);
  cursor: pointer;
  font-size: 1.083rem;
  transition: background .12s;
}
.sb-icon-action:hover { background: var(--sb-hover-bg); color: #fff; }
/* Hide theme icon when collapsed — only show expand/collapse */
#sidebar.sb-collapsed #fb-theme-btn { display: none; }

/* ---- Report controls (top bar) ---- */
.tb-label {
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .05em;
  color: var(--text-muted);
  margin-right: 2px;
  white-space: nowrap;
}
.tb-select {
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg);
  color: var(--text);
  font-size: 0.875rem;
  cursor: pointer;
  outline: none;
  height: 32px;
  appearance: auto;
  -webkit-appearance: auto;
}
.tb-date-input {
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg);
  color: var(--text);
  font-size: 0.875rem;
  width: 136px;
  outline: none;
  height: 32px;
}
.tb-toggle-btn {
  padding: 5px 11px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface);
  color: var(--text-muted);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  height: 32px;
  white-space: nowrap;
}
.tb-toggle-btn.tb-active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.tb-toggle-btn:hover:not(.tb-active) { background: var(--bg); color: var(--text); }
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

  return `<div id="app-shell" data-company="${company}">
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
            <input type="text" id="tb-global-search" class="tb-search" placeholder="🔍  Search…" autocomplete="off" tabindex="-1">
          </div>
          <button class="tb-cmd-btn" id="tb-cmd-palette-btn" title="Command palette (: or Ctrl+K)" onclick="fbOpenCmdPalette()">⌘ Commands</button>
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
<script>
(function() {
  // ── Theme ──
  function fbApplyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    var icon = document.getElementById('fb-theme-icon');
    var btn  = document.getElementById('fb-theme-btn');
    if (icon) icon.textContent = t === 'dark' ? '🌙' : '☀';
    if (btn)  btn.title = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }
  window.fbToggleTheme = function() {
    var cur = document.documentElement.getAttribute('data-theme') || 'light';
    var next = cur === 'dark' ? 'light' : 'dark';
    localStorage.setItem('fb-theme', next);
    fbApplyTheme(next);
  };
  fbApplyTheme(localStorage.getItem('fb-theme') || 'light');

  // ── Load company display name ──
  (function() {
    var coId = (document.getElementById('app-shell') || {}).dataset && document.getElementById('app-shell').dataset.company;
    if (!coId) return;
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'company.list', companyId: coId }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var cos = res.data || res || [];
      if (!Array.isArray(cos)) return;
      var co = cos.find(function(c){ return c.company_id === coId; });
      if (co && (co.company_name || co.name)) {
        var el = document.querySelector('.sb-co-name');
        if (el) el.textContent = co.company_name || co.name;
      }
    })
    .catch(function(){});
  })();

  // ── Sidebar collapse ──
  function fbApplySidebar(collapsed) {
    var sb = document.getElementById('sidebar');
    var icon = document.getElementById('fb-collapse-icon');
    var btn = document.getElementById('fb-collapse-btn');
    if (!sb) return;
    if (collapsed) {
      sb.classList.add('sb-collapsed');
      if (icon) icon.textContent = '»';
      if (btn)  btn.title = 'Expand sidebar';
    } else {
      sb.classList.remove('sb-collapsed');
      if (icon) icon.textContent = '«';
      if (btn)  btn.title = 'Collapse sidebar';
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
      var coId2 = (document.getElementById('app-shell') || {}).dataset && document.getElementById('app-shell').dataset.company;
      fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action:'company.list', companyId: coId2 || '' }) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        var cos = res.data || res || [];
        if (!Array.isArray(cos) || !cos.length) { dd.innerHTML='<div class="tb-company-opt" style="color:#888">No other companies</div>'; return; }
        dd.innerHTML = cos.map(function(c){
          return '<a class="tb-company-opt" href="/'+c.company_id+'">'+(c.company_name||c.name||c.company_id)+'<br><small style="color:#aaa;font-size:8pt">'+c.company_id+'</small></a>';
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
</script>
<script>
(function() {
  // ── Vim-modal keyboard navigation ──
  // Modes: normal (default) | insert (typing in a field)
  // Escape        → Normal mode (blur inputs, clear row focus)
  // i             → Insert mode (focus first input in page-main)
  // { / }         → sidebar prev/next item (navigate pages)
  // h / l         → horizontal submenu tab prev/next
  // j / k         → table row prev/next (with visual focus)
  // Enter         → activate focused row (follow link or click)
  // /             → focus global search
  // : or Ctrl+K   → command palette
  // g + letter    → jump navigation (gd=Dashboard, gb=Bank, etc.)

  var _fbVimMode = 'normal';
  window.fbSetVimMode = function(mode) {
    _fbVimMode = mode;
    var el = document.getElementById('fb-vim-mode');
    if (!el) return;
    el.textContent = mode === 'insert' ? 'INSERT' : 'NORMAL';
    el.className = mode === 'insert' ? 'insert' : '';
  };

  // Auto-track mode on focus in/out
  document.addEventListener('focusin', function(e) {
    var tag = (e.target || {}).tagName || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') fbSetVimMode('insert');
  });
  document.addEventListener('focusout', function(e) {
    var tag = (e.target || {}).tagName || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      setTimeout(function() {
        var ae = document.activeElement;
        var aeTag = (ae || {}).tagName || '';
        if (aeTag !== 'INPUT' && aeTag !== 'TEXTAREA' && aeTag !== 'SELECT') fbSetVimMode('normal');
      }, 50);
    }
  });

  var _gPending = false, _gTimer = null;

  document.addEventListener('keydown', function(e) {
    var ae = document.activeElement || {};
    var tag = (ae.tagName || '').toUpperCase();
    var inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae.isContentEditable;

    // ── Escape: always exit to Normal mode ──
    if (e.key === 'Escape') {
      document.querySelectorAll('tr.nav-row-focus').forEach(function(r) { r.classList.remove('nav-row-focus'); });
      if (inInput) { ae.blur(); }
      fbSetVimMode('normal');
      return;
    }

    // ── / → global search ──
    if (!inInput && e.key === '/') {
      e.preventDefault();
      var s = document.getElementById('tb-global-search');
      if (s) { s.focus(); s.select(); }
      return;
    }

    // ── : or Ctrl+K → command palette ──
    if ((!inInput && e.key === ':') || (e.ctrlKey && e.key === 'k')) {
      e.preventDefault();
      fbOpenCmdPalette();
      return;
    }

    // ── Normal-mode-only keys below ──
    if (inInput) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    // ── g prefix navigation ──
    if (e.key === 'g' && !_gPending) {
      _gPending = true;
      clearTimeout(_gTimer);
      _gTimer = setTimeout(function() { _gPending = false; }, 1000);
      e.preventDefault();
      return;
    }
    if (_gPending) {
      _gPending = false;
      clearTimeout(_gTimer);
      var company = (document.getElementById('app-shell') || {}).dataset && document.getElementById('app-shell').dataset.company;
      if (!company) return;
      var navMap = { d: '/' + company, b: '/' + company + '/bank', p: '/' + company + '/payables', v: '/' + company + '/receivables', r: '/' + company + '/reports', s: '/' + company + '/settings' };
      if (navMap[e.key]) { e.preventDefault(); window.location.href = navMap[e.key]; }
      return;
    }

    // ── i → Insert mode: focus first input in page-main ──
    if (e.key === 'i') {
      e.preventDefault();
      var first = document.querySelector('#page-main input:not([type=hidden]):not([disabled]), #page-main textarea:not([disabled])');
      if (first) { first.focus(); fbSetVimMode('insert'); }
      return;
    }

    // ── { / } → sidebar navigation ──
    if (e.key === '{' || e.key === '}') {
      var sbItems = Array.from(document.querySelectorAll('.sb-nav a[href]'));
      if (!sbItems.length) return;
      var sbActiveIdx = sbItems.findIndex(function(el) { return el.classList.contains('sb-active'); });
      if (sbActiveIdx === -1) sbActiveIdx = 0;
      var sbNewIdx = e.key === '}' ? sbActiveIdx + 1 : sbActiveIdx - 1;
      sbNewIdx = Math.max(0, Math.min(sbItems.length - 1, sbNewIdx));
      e.preventDefault();
      window.location.href = sbItems[sbNewIdx].getAttribute('href');
      return;
    }

    // ── h / l → horizontal submenu tab navigation ──
    if (e.key === 'h' || e.key === 'l') {
      var tabs = Array.from(document.querySelectorAll('.tabs .tab'));
      if (!tabs.length) return;
      var tabActiveIdx = -1;
      tabs.forEach(function(t, i) { if (t.classList.contains('active')) tabActiveIdx = i; });
      var tabNewIdx = e.key === 'l' ? tabActiveIdx + 1 : tabActiveIdx - 1;
      if (tabNewIdx >= 0 && tabNewIdx < tabs.length) { e.preventDefault(); tabs[tabNewIdx].click(); }
      return;
    }

    // ── j / k → table row navigation ──
    if (e.key === 'j' || e.key === 'k') {
      var rows = Array.from(document.querySelectorAll('table tbody tr'));
      if (!rows.length) return;
      var focusedIdx = rows.findIndex(function(r) { return r.classList.contains('nav-row-focus'); });
      var rowNewIdx;
      if (focusedIdx === -1) {
        rowNewIdx = e.key === 'j' ? 0 : rows.length - 1;
      } else {
        rowNewIdx = e.key === 'j' ? focusedIdx + 1 : focusedIdx - 1;
      }
      rowNewIdx = Math.max(0, Math.min(rows.length - 1, rowNewIdx));
      e.preventDefault();
      rows.forEach(function(r) { r.classList.remove('nav-row-focus'); });
      rows[rowNewIdx].classList.add('nav-row-focus');
      rows[rowNewIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }

    // ── Enter → activate focused row ──
    if (e.key === 'Enter') {
      var focusedRow = document.querySelector('tr.nav-row-focus');
      if (focusedRow) {
        e.preventDefault();
        var link = focusedRow.querySelector('a[href]');
        if (link) { window.location.href = link.getAttribute('href'); }
        else { focusedRow.click(); }
      }
    }
  });

  window.fbOpenCmdPalette = window.fbOpenCmdPalette || function() {
    var company = document.getElementById('app-shell') ? document.getElementById('app-shell').dataset.company : '';
    var cmds = [
      { label: '+ New Journal Entry',  action: function(){ window.location.href = '/' + company + '/journal/new'; } },
      { label: '+ New Bill',           action: function(){ window.location.href = '/' + company + '/bill/new'; } },
      { label: '\u2192 Dashboard',          action: function(){ window.location.href = '/' + company; } },
      { label: '\u2192 Bank',               action: function(){ window.location.href = '/' + company + '/bank'; } },
      { label: '\u2192 Payables',           action: function(){ window.location.href = '/' + company + '/payables'; } },
      { label: '\u2192 Reports',            action: function(){ window.location.href = '/' + company + '/reports'; } },
      { label: '\u2192 Settings',           action: function(){ window.location.href = '/' + company + '/settings'; } },
    ];
    var existing = document.getElementById('fb-cmd-modal');
    if (existing) { existing.remove(); return; }
    var overlay = document.createElement('div');
    overlay.id = 'fb-cmd-modal';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9000;background:rgba(0,0,0,.4);display:flex;align-items:flex-start;justify-content:center;padding-top:15vh';
    overlay.onclick = function(e){ if(e.target===overlay) overlay.remove(); };
    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.2);width:420px;max-width:90vw;overflow:hidden';
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = 'Type a command\u2026';
    inp.style.cssText = 'width:100%;padding:14px 18px;font-size:1rem;border:none;border-bottom:1px solid #e8e8e8;outline:none;box-sizing:border-box';
    var list = document.createElement('div');
    function renderList(q) {
      list.innerHTML = '';
      cmds.filter(function(c){ return !q || c.label.toLowerCase().includes(q.toLowerCase()); }).forEach(function(c) {
        var item = document.createElement('div');
        item.textContent = c.label;
        item.style.cssText = 'padding:12px 18px;cursor:pointer;font-size:0.9375rem;border-bottom:1px solid #f5f5f5';
        item.onmouseover = function(){ item.style.background='#f0f4ff'; };
        item.onmouseout  = function(){ item.style.background=''; };
        item.onclick = function(){ overlay.remove(); c.action(); };
        list.appendChild(item);
      });
    }
    renderList('');
    inp.oninput = function(){ renderList(inp.value); };
    inp.onkeydown = function(e){
      if(e.key==='Escape') overlay.remove();
      if(e.key==='Enter') {
        var first = list.querySelector('div');
        if(first) first.click();
      }
    };
    box.appendChild(inp);
    box.appendChild(list);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    setTimeout(function(){ inp.focus(); }, 50);
  };
})();
</script>`;
}

module.exports = { makeQuery, commonStyle, navBar, layoutEnd };
