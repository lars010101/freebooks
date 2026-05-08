
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


(function() {
  window.fbNavigate = function(url) {
    fetch(url)
      .then(function(r) { return r.text(); })
      .then(function(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var newMain = doc.getElementById('page-main');
        var oldMain = document.getElementById('page-main');
        if (!newMain || !oldMain) { window.location.href = url; return; }

        // Swap <head> page-specific styles
        document.querySelectorAll('head style').forEach(function(s) { s.remove(); });
        doc.querySelectorAll('head style').forEach(function(s) {
          var ns = document.createElement('style');
          ns.textContent = s.textContent;
          document.head.appendChild(ns);
        });

        // Swap page-main content
        oldMain.innerHTML = newMain.innerHTML;

        // Re-execute inline scripts inside #page-main
        oldMain.querySelectorAll('script').forEach(function(s) {
          var ns = document.createElement('script');
          ns.textContent = s.textContent;
          s.replaceWith(ns);
        });

        // Re-execute body-level inline scripts outside #page-main (e.g. reports-hub)
        doc.querySelectorAll('body script').forEach(function(s) {
          if (s.src) return; // skip external scripts like common.js
          if (newMain && newMain.contains(s)) return; // already handled above
          var ns = document.createElement('script');
          ns.textContent = s.textContent;
          document.body.appendChild(ns);
          ns.remove();
        });

        // Update sidebar active state — use server-set sb-active from incoming doc
        var sbItems = Array.from(document.querySelectorAll('.sb-nav a[href]'));
        sbItems.forEach(function(el) { el.classList.remove('sb-active'); });
        var incomingActive = doc.querySelector('.sb-nav a.sb-active');
        if (incomingActive) {
          var activeHref = incomingActive.getAttribute('href');
          var matchItem = sbItems.find(function(el) { return el.getAttribute('href') === activeHref; });
          if (matchItem) matchItem.classList.add('sb-active');
        } else {
          // Fallback: longest-match by URL
          var active = sbItems.reduce(function(best, el) {
            var href = el.getAttribute('href');
            if (!href) return best;
            if (url === href || url.startsWith(href + '/')) {
              if (!best || href.length > best.getAttribute('href').length) return el;
            }
            return best;
          }, null);
          if (active) active.classList.add('sb-active');
        }

        // Update top-bar right section
        var newTbRight = doc.querySelector('.tb-right');
        var oldTbRight = document.querySelector('.tb-right');
        if (newTbRight && oldTbRight) oldTbRight.innerHTML = newTbRight.innerHTML;

        // Call page-specific init if registered
        if (typeof window.fbPageInit === 'function') window.fbPageInit();

        // Push history
        history.pushState({ fbUrl: url }, '', url);
      })
      .catch(function() { window.location.href = url; });
  };

  // Handle browser back/forward
  window.addEventListener('popstate', function(e) {
    var target = (e.state && e.state.fbUrl) || window.location.pathname;
    window.fbNavigate(target);
  });

  // Intercept sidebar link clicks → SPA navigation (same as { } keyboard nav)
  document.addEventListener('click', function(e) {
    var a = e.target.closest('.sb-nav a[href]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href.startsWith('#') || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    window.fbNavigate(href);
  });
})();

(function() {
  // ── Vim-modal keyboard navigation ──
  // Modes: normal (default) | insert (typing in a field)
  // Escape        → Normal mode (blur); or page fbKeyActions.escape if already in normal mode
  // i             → Insert mode (focus first input in page-main)
  // { / }         → sidebar prev/next item (navigate pages)
  // h / l         → horizontal submenu tab prev/next
  // j / k         → table row prev/next (with visual focus)
  // Enter         → activate focused row (follow link or click)
  // a             → page-registered "new" action (e.g. New Bill)
  // d             → page-registered "delete" action on focused row
  // e             → page-registered "edit" action
  // /             → focus global search
  // : or Ctrl+K   → command palette
  // gg            → scroll to top
  // G             → scroll to bottom
  //
  // Pages register handlers via: window.fbKeyActions = { new, delete, edit }

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
    var type = ((e.target || {}).type || '').toLowerCase();
    var textInput = tag === 'TEXTAREA' ||
      (tag === 'INPUT' && type !== 'checkbox' && type !== 'radio' &&
       type !== 'button' && type !== 'submit' && type !== 'reset' && type !== 'file');
    if (textInput) fbSetVimMode('insert');
  });
  document.addEventListener('focusout', function(e) {
    var tag = (e.target || {}).tagName || '';
    var type = ((e.target || {}).type || '').toLowerCase();
    var textInput = tag === 'TEXTAREA' ||
      (tag === 'INPUT' && type !== 'checkbox' && type !== 'radio' &&
       type !== 'button' && type !== 'submit' && type !== 'reset' && type !== 'file');
    if (textInput) {
      setTimeout(function() {
        var ae = document.activeElement;
        var aeTag = (ae || {}).tagName || '';
        var aeType = ((ae || {}).type || '').toLowerCase();
        var aeTextInput = aeTag === 'TEXTAREA' ||
          (aeTag === 'INPUT' && aeType !== 'checkbox' && aeType !== 'radio' &&
           aeType !== 'button' && aeType !== 'submit' && aeType !== 'reset' && aeType !== 'file');
        if (!aeTextInput) fbSetVimMode('normal');
      }, 50);
    }
  });

  var _gPending = false, _gTimer = null;

  document.addEventListener('keydown', function(e) {
    var ae = document.activeElement || {};
    var tag = (ae.tagName || '').toUpperCase();
    var inInput = tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable;

    // ── Escape: exit to Normal mode; or page escape action if already in normal mode ──
    if (e.key === 'Escape') {
      document.querySelectorAll('tr.nav-row-focus').forEach(function(r) { r.classList.remove('nav-row-focus'); });
      if (inInput) {
        ae.blur();
        fbSetVimMode('normal');
      } else if (window.fbKeyActions && typeof window.fbKeyActions['escape'] === 'function') {
        window.fbKeyActions['escape']();
      }
      return;
    }

    // ── / → global search ──
    if (!inInput && e.key === '/') {
      e.preventDefault();
      var s = document.getElementById('tb-global-search');
      if (s) { s.focus(); s.select(); }
      return;
    }

    // ── : or Ctrl+K → focus search bar in command mode ──
    if ((!inInput && e.key === ':') || (e.ctrlKey && e.key === 'k')) {
      e.preventDefault();
      var sc = document.getElementById('tb-global-search');
      if (sc) { sc.value = ':'; sc.focus(); sc.setSelectionRange(1, 1); }
      return;
    }

    // ── Normal-mode-only keys below ──
    if (inInput) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    // ── gg → scroll to top ──
    if (e.key === 'g' && !_gPending) {
      _gPending = true;
      clearTimeout(_gTimer);
      _gTimer = setTimeout(function() { _gPending = false; }, 500);
      e.preventDefault();
      return;
    }
    if (_gPending && e.key === 'g') {
      _gPending = false;
      clearTimeout(_gTimer);
      e.preventDefault();
      var pm = document.getElementById('page-main');
      if (pm) pm.scrollTo({ top: 0, behavior: 'smooth' });
      else window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (_gPending) {
      _gPending = false;
      clearTimeout(_gTimer);
      return;
    }

    // ── G → scroll to bottom ──
    if (e.shiftKey && e.key === 'G') {
      e.preventDefault();
      var pm = document.getElementById('page-main');
      if (pm) pm.scrollTo({ top: pm.scrollHeight, behavior: 'smooth' });
      else window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      return;
    }

    // Reset g pending flag if it was set (but not matching gg)
    if (_gPending) {
      _gPending = false;
      clearTimeout(_gTimer);
    }

    // ── i → Insert mode: edit focused nav row, or focus first input in page-main ──
    if (e.key === 'i') {
      e.preventDefault();
      // If a nav row is focused and page registered 'edit', delegate to it
      if (window.fbKeyActions && typeof window.fbKeyActions['edit'] === 'function') {
        var focusedNavRow = document.querySelector('tr.nav-row-focus, .attach-row.nav-attach-focus, .nav-meta-item.nav-meta-focus');
        if (focusedNavRow) { window.fbKeyActions['edit'](); return; }
      }
      // Generic: focus first input in page (vim insert mode)
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
      fbNavigate(sbItems[sbNewIdx].getAttribute('href'));
      return;
    }

    // ── h / l → horizontal submenu tab navigation ──
    if (e.key === 'h' || e.key === 'l') {
      var vendorPanel = document.getElementById('pay-panel-vendors');
      if (vendorPanel && vendorPanel.style.display !== 'none' && typeof window.fbVendorSelRow !== 'undefined' && window.fbVendorSelRow >= 0) {
        return;
      }
      if (window.fbBillCursorMid) { return; }
      var tabs = Array.from(document.querySelectorAll('.tabs .tab'));
      if (!tabs.length) {
        var hlKey = e.key; // 'h' or 'l'
        if (window.fbKeyActions && typeof window.fbKeyActions[hlKey] === 'function') {
          e.preventDefault();
          window.fbKeyActions[hlKey]();
        }
        return;
      }
      var tabActiveIdx = -1;
      tabs.forEach(function(t, i) { if (t.classList.contains('active')) tabActiveIdx = i; });
      var tabNewIdx = e.key === 'l' ? tabActiveIdx + 1 : tabActiveIdx - 1;
      if (tabNewIdx >= 0 && tabNewIdx < tabs.length) { e.preventDefault(); tabs[tabNewIdx].click(); }
      return;
    }

    // ── j / k → table row navigation ──
    if (e.key === 'j' || e.key === 'k') {
      // Vendor cell nav owns j/k when active
      var vendorPanelJK = document.getElementById('pay-panel-vendors');
      if (vendorPanelJK && vendorPanelJK.style.display !== 'none' && typeof window.fbVendorSelRow !== 'undefined' && window.fbVendorSelRow >= 0) {
        return;
      }
      if (window.fbBillNav) { return; }
      // Allow page to intercept j/k (e.g. for mixed table+div navigation)
      if (window.fbKeyActions && typeof window.fbKeyActions[e.key] === 'function') {
        e.preventDefault();
        window.fbKeyActions[e.key]();
        return;
      }
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
      if (rowNewIdx === 0) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        rows[rowNewIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      return;
    }

    // ── Enter → activate focused row ──
    if (e.key === 'Enter') {
      var focusedRow = document.querySelector('tr.nav-row-focus');
      if (focusedRow) {
        e.preventDefault();
        var link = focusedRow.querySelector('a[href]');
        if (link) { fbNavigate(link.getAttribute('href')); }
        else { focusedRow.click(); }
      }
      return;
    }

    // ── a / d → vendor cell nav owns these when active ──
    var vendorPanelAD = document.getElementById('pay-panel-vendors');
    var vendorActive = vendorPanelAD && vendorPanelAD.style.display !== 'none';

    // ── a → page-registered "new" action ──
    if (e.key === 'a') {
      if (vendorActive) return;
      if (window.fbKeyActions && typeof window.fbKeyActions['new'] === 'function') {
        e.preventDefault();
        window.fbKeyActions['new']();
      }
      return;
    }

    // ── d → delete focused row (page-registered) ──
    if (e.key === 'd') {
      if (vendorActive) return;
      if (window.fbKeyActions && typeof window.fbKeyActions['delete'] === 'function') {
        e.preventDefault();
        var focusedRowD = document.querySelector('tr.nav-row-focus');
        window.fbKeyActions['delete'](focusedRowD);
      }
      return;
    }

    // ── e → reserved (was edit; use i instead) ──
    if (e.key === 'e') { return; }
  });

  // Wire up tb-global-search: Enter dispatches commands when value starts with ':'
  document.addEventListener('DOMContentLoaded', function() {
    var gs = document.getElementById('tb-global-search');
    if (!gs) return;
    gs.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { gs.value = ''; gs.blur(); return; }
      if (e.key === 'Enter') {
        var val = gs.value.trim();
        gs.value = ''; gs.blur();
        if (val.startsWith(':')) {
          if (window.fbCmdDispatch) { window.fbCmdDispatch(val); }
          else { console.log('Command:', val); }
        }
        // else: search handled by page-level oninput handler
      }
    });
  });

  // fbOpenCmdPalette kept as no-op (replaced by search bar command mode)
  window.fbOpenCmdPalette = window.fbOpenCmdPalette || function() {
    var company = document.getElementById('app-shell') ? document.getElementById('app-shell').dataset.company : '';
    var cmds = [
      { label: '+ New Journal Entry',  action: function(){ fbNavigate('/' + company + '/journal/new'); } },
      { label: '+ New Bill',           action: function(){ fbNavigate('/' + company + '/bill/new'); } },
      { label: '\u2192 Dashboard',          action: function(){ fbNavigate('/' + company); } },
      { label: '\u2192 Bank',               action: function(){ fbNavigate('/' + company + '/bank'); } },
      { label: '\u2192 Payables',           action: function(){ fbNavigate('/' + company + '/payables'); } },
      { label: '\u2192 Reports',            action: function(){ fbNavigate('/' + company + '/reports'); } },
      { label: '\u2192 Settings',           action: function(){ fbNavigate('/' + company + '/settings'); } },
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
