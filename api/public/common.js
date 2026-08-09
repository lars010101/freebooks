
(function() {
  // ── P0-2 transitional: error-envelope normalizer ─────────────────────────
  // Server now returns failures as HTTP 4xx/5xx with
  //   { ok:false, error:{ code, message, details? } }
  // Legacy handlers expect `res.error` to be a STRING (they assign it to
  // textContent) and read data via `res.data || res`. Rewriting the body here
  // keeps all of them working: error object → message string (details.errors
  // joined when present — that array carried the specific messages pre-P0-2).
  // TRANSITIONAL: remove once all call sites migrate to an envelope-native
  // fbApi helper (roadmap P1-3 shared UI core).
  var _fbOrigFetch = window.fetch.bind(window);
  window.fetch = function(url, opts) {
    var isApi = typeof url === 'string' && (url.indexOf('/api/') === 0 || url === '/api');
    if (!isApi) return _fbOrigFetch(url, opts);
    return _fbOrigFetch(url, opts).then(function(r) {
      return r.json().catch(function() { return null; }).then(function(body) {
        if (body && body.ok === false && body.error && typeof body.error === 'object') {
          var e = body.error;
          body.error = (e.details && Array.isArray(e.details.errors) && e.details.errors.length)
            ? e.details.errors.join('; ')
            : (e.message || ('Request failed (' + r.status + ')'));
        }
        return { ok: r.ok, status: r.status, headers: r.headers,
                 json: function() { return Promise.resolve(body); },
                 text: function() { return Promise.resolve(JSON.stringify(body)); } };
      });
    });
  };

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
        var el = document.querySelector('.fb-sl-company');
        if (el) el.textContent = co.company_name || co.name;
      }
    })
    .catch(function(){});
  })();

  // ── Company switcher ──
  // onReady(opened) is optional — invoked after the open path completes
  // (sync when already loaded, async after the company.list fetch resolves).
  // `opened` is true when the dropdown is now open, false when it was closed.
  // Used by the g c keyboard switcher (fb-core.js) to set the initial
  // highlight once the option rows exist.
  window.fbToggleCompany = function(e, onReady) {
    if (e) e.stopPropagation();
    var dd = document.getElementById('tb-company-dropdown');
    if (!dd) { if (onReady) onReady(false); return; }
    var open = dd.style.display !== 'none';
    dd.style.display = open ? 'none' : '';
    if (open) { if (onReady) onReady(false); return; }
    if (!dd._loaded) {
      dd._loaded = true;
      var coId2 = (document.getElementById('app-shell') || {}).dataset && document.getElementById('app-shell').dataset.company;
      fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action:'company.list', companyId: coId2 || '' }) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        var cos = res.data || res || [];
        if (!Array.isArray(cos) || !cos.length) { dd.innerHTML='<div class="tb-company-opt" style="color:#888">No other companies</div>'; }
        else {
          dd.innerHTML = cos.map(function(c){
            return '<a class="tb-company-opt" href="/'+c.company_id+'">'+(c.company_name||c.name||c.company_id)+'<br><small style="color:#aaa;font-size:8pt">'+c.company_id+'</small></a>';
          }).join('');
        }
        // settings-ux-spec §7 item 1 rev 2026-07-27: company creation moved off
        // the (deleted) all-companies grid into the switcher dropdown — a
        // divider + a "+ New company" link at the bottom pointing at the
        // existing /setup/new-company page.
        var div = document.createElement('div');
        div.className = 'tb-company-divider';
        div.style.cssText = 'border-top:1px solid #e0e0e0;margin:6px 0';
        dd.appendChild(div);
        var link = document.createElement('a');
        link.className = 'tb-company-opt';
        link.href = '/setup/new-company';
        link.innerHTML = '+ New company';
        link.style.cssText = 'color:#1a1a1a;font-weight:600';
        dd.appendChild(link);
        if (onReady) onReady(true);
      })
      .catch(function(){ dd.innerHTML='<div class="tb-company-opt" style="color:#cc2222">Error loading</div>'; if (onReady) onReady(true); });
    } else {
      if (onReady) onReady(true);
    }
  };
  document.addEventListener('click', function() {
    var dd = document.getElementById('tb-company-dropdown');
    if (dd) dd.style.display = 'none';
  });
})();


(function() {
  // Leave-veto chokepoint (magnus review 2026-07-28): EVERY soft navigation
  // consults the dirty-guard hook here — g-map navigation, palette rows, and
  // palette navigate rows all funnel through fbNavigate, so wiring the veto
  // at this level closes the g-map/palette bypass for good. Guard-confirmed
  // continuations pass { force: true } to skip the re-check (the modal's
  // save/discard already ran).
  window.fbNavigate = function(url, opts) {
    if (!(opts && opts.force) && typeof window.fbBeforeTabSwitch === 'function'
        && window.fbBeforeTabSwitch(url) === false) return;
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

        // Push history BEFORE re-executing page scripts (magnus 2026-07-28):
        // arriving pages read window.location.search at script time (?tab=
        // deep-links on bank/settings/payables) — pushing after re-execution
        // left them reading the DEPARTED page's query, silently no-op'ing
        // every soft-nav deep-link.
        history.pushState({ fbUrl: url }, '', url);

        // K3c: reset FB.keys page state so the departing page's key sets and
        // document listeners don't own dispatch on the arriving page. Must
        // happen AFTER the content swap (teardown callbacks may inspect the
        // DOM) and BEFORE re-executing scripts (the arriving page registers
        // fresh sets).
        if (window.FB && FB.keys && FB.keys.resetPage) FB.keys.resetPage();

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

        // Update top-bar right section
        var newTbRight = doc.querySelector('.tb-right');
        var oldTbRight = document.querySelector('.tb-right');
        if (newTbRight && oldTbRight) oldTbRight.innerHTML = newTbRight.innerHTML;
        // Re-render dynamic slots + track the arrival as a visit
        if (window.FB && FB.track && typeof fbSectionOfPath === 'function') FB.track.visit(fbSectionOfPath(url));
        if (typeof window.fbRenderTopSlots === 'function') window.fbRenderTopSlots(url);

        // Call page-specific init if registered
        if (typeof window.fbPageInit === 'function') window.fbPageInit();
      })
      .catch(function() { window.location.href = url; });
  };

  // Handle browser back/forward
  window.addEventListener('popstate', function(e) {
    var target = (e.state && e.state.fbUrl) || window.location.pathname;
    window.fbNavigate(target);
  });

  // ── P2: usage tracking + dynamic topbar slots ────────────────────────────
  // FB.track: all-time counters in localStorage (no decay — user can clear cache).
  //   visit:<section>   — page loads (and soft-nav arrivals) per section
  //   create:<action>   — successful create executions (screen-level, tracked on save)
  // Dynamic topbar: [+][screen₁] [+][screen₂] ranked by visits, current section
  // skipped (sub-screens count as parent: bill-edit/detail → payables).
  // Each pair = create shortcut (the object's create route) + screen nav chip.
  (function() {
    var LS_KEY = 'fb-usage';
    function read() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; } }
    function write(d) { try { localStorage.setItem(LS_KEY, JSON.stringify(d)); } catch (e) {} }

    // section of a path: /co/bill/edit → payables; /co/journal/new → journal-new
    window.fbSectionOfPath = function (path) {
      var m = String(path || '').match(/^\/[^/]+\/([^/?]+)/);
      if (!m) return 'dashboard';
      var seg = m[1];
      if (seg === 'bill') return 'payables';
      if (seg === 'journal') return 'journal-new';
      return seg; // payables, reports, settings, opening-balances
    };
    function sectionOf(path) { return window.fbSectionOfPath(path); }

    window.FB = window.FB || {};
    FB.track = {
      visit: function (section) { var d = read(); var k = 'visit:' + section; d[k] = (d[k] || 0) + 1; write(d); },
      create: function (action) { var d = read(); var k = 'create:' + action; d[k] = (d[k] || 0) + 1; write(d); },
      _all: read
    };

    // Create route per section (plus-icon target) — only sections with a create object
    var CREATE_ROUTES = {
      'payables':   { label: 'Bill',      path: '/bill/edit' },
      'settings':   { label: 'Account',   path: '/settings?tab=coa&new=1' }
    };
    var SECTION_LABELS = {
      'dashboard': 'Dashboard', 'payables': 'Payables',
      'reports': 'Reports', 'settings': 'Settings',
      'opening-balances': 'Opening Balances', 'journal-new': 'Journal Entry'
    };

    function company() { return (document.getElementById('app-shell') || {}).dataset ? document.getElementById('app-shell').dataset.company : ''; }

    window.fbRenderTopSlots = function (pathOverride) {
      var host = document.getElementById('tb-dyn-slots');
      if (!host) return;
      var d = read(), cur = sectionOf(pathOverride || location.pathname), co = company();
      var ranked = Object.keys(SECTION_LABELS)
        .map(function (s) { return { s: s, n: d['visit:' + s] || 0 }; })
        .filter(function (x) { return x.n > 0 && x.s !== cur && x.s !== 'journal-new'; })
        .sort(function (a, b) { return b.n - a.n; });
      // Cold start: no visits yet → seed with payables + reports
      if (!Object.keys(d).some(function (k) { return k.indexOf('visit:') === 0; })) {
        ranked = [{ s: 'payables' }, { s: 'reports' }];
      }
      var html = '';
      ranked.slice(0, 2).forEach(function (x) {
        var href = '/' + co + (x.s === 'dashboard' ? '' : '/' + x.s);
        var cr = CREATE_ROUTES[x.s];
        if (cr) html += '<a class="tb-btn tb-btn-quiet tb-dyn-plus" title="New ' + cr.label + '" href="/' + co + cr.path + '">+</a>';
        html += '<a class="tb-btn tb-btn-quiet tb-dyn-chip" href="' + href + '">' + SECTION_LABELS[x.s] + '</a>';
      });
      host.innerHTML = html;
    };

    // Track initial load + render slots
    FB.track.visit(sectionOf(location.pathname));
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', window.fbRenderTopSlots);
    else window.fbRenderTopSlots();
  })();

})();

(function() {
  // ── Vim-modal keyboard navigation ──
  // Modes: normal (default) | insert (typing in a field)
  // Escape        → Normal mode (blur); or page fbKeyActions.escape if already in normal mode
  // i             → Insert mode (focus first input in page-main)
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

  // P1-3: the mode indicator reads FB.mode (the single mode store, fb-core.js).
  // fbSetVimMode is kept as the legacy entry point for unmigrated pages.
  window.fbSetVimMode = function(mode) {
    if (window.FB) FB.mode.set(mode);
  };
  if (window.FB) {
    FB.mode.onChange(function(m) {
      var el = document.getElementById('fb-vim-mode');
      if (!el) return;
      el.textContent = m === 'INSERT' ? 'INSERT' : 'NORMAL';
      el.className = m === 'INSERT' ? 'insert' : '';
    });
  }

  // Auto-track mode on focus in/out — legacy behavior for unmigrated pages.
  // Suspended when an FB.keys binding set is active (migrated pages own their
  // mode transitions explicitly; focus tracking would fight cursor.mode).
  document.addEventListener('focusin', function(e) {
    if (window.FB && FB.keys.hasActive()) return;
    var tag = (e.target || {}).tagName || '';
    var type = ((e.target || {}).type || '').toLowerCase();
    var textInput = tag === 'TEXTAREA' ||
      (tag === 'INPUT' && type !== 'checkbox' && type !== 'radio' &&
       type !== 'button' && type !== 'submit' && type !== 'reset' && type !== 'file');
    if (textInput) fbSetVimMode('insert');
  });
  document.addEventListener('focusout', function(e) {
    if (window.FB && FB.keys.hasActive()) return;
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

  // gg and G scroll are now owned by fb-core.js (K1 g-prefix unification):
  // fb-core's capture-phase handler runs first and claims `g` (gg = top,
  // g<letter> = go-to map). G (Shift+G) scroll-to-bottom stays here as the
  // bubble-phase fallback for pages without an FB.list set (which owns G on
  // list pages). The legacy _gPending state is deleted — one pending state
  // lives in fb-core now.

  document.addEventListener('keydown', function(e) {
    var ae = document.activeElement || {};
    var tag = (ae.tagName || '').toUpperCase();
    var inInput = tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable;

    // ── Escape: exit to Normal mode; or page escape action if already in normal mode ──
    if (e.key === 'Escape') {
      // On FB.keys-migrated pages the active binding set owns Escape semantics
      // and the FB.nav cursor — do NOT strip row highlights behind its back
      // (stripping left an invisible cursor; boundary-sticky j/k then looked dead).
      if (!(window.FB && FB.keys.hasActive && FB.keys.hasActive())) {
        document.querySelectorAll('tr.nav-row-focus').forEach(function(r) { r.classList.remove('nav-row-focus'); });
      }
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

    // ── : or Ctrl+K → command mode on the topbar input (P1-10) ──
    if ((!inInput && e.key === ':') || (e.ctrlKey && e.key === 'k')) {
      e.preventDefault();
      if (window.FB && FB.palette) FB.palette.enterCommand();
      return;
    }

    // ── Normal-mode-only keys below ──
    if (inInput) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    // gg / g-prefix go-to map: owned by fb-core.js (capture phase, K1).
    // `g` is swallowed there before reaching this bubble handler, so it never
    // arrives here. G (Shift+G) scroll-to-bottom stays below as the fallback.

    // ── G → scroll to bottom ──
    if (e.shiftKey && e.key === 'G') {
      e.preventDefault();
      var pm = document.getElementById('page-main');
      if (pm) pm.scrollTo({ top: pm.scrollHeight, behavior: 'smooth' });
      else window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      return;
    }

    // ── Edit-active guard (docs/settings-ux-spec.md §2) ─────────────────────
    // While any page has a row edit open (window.fbEditActive), ALL read-mode
    // verbs are inert — regardless of focus. Closes the checkbox/select-focus
    // hole the text-input guard cannot see (e.g. Locked checkbox mid-edit).
    if (window.fbEditActive && (e.key === 'i' || e.key === 'h' || e.key === 'l' || e.key === 'j' || e.key === 'k')) {
      e.preventDefault();
      return;
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

    // ── h / l → horizontal submenu tab navigation ──
    if (e.key === 'h' || e.key === 'l') {
      // Hidden tabs (display:none — e.g. relevance-flag-gated Settings tabs)
      // are skipped: invisible means not navigable.
      var tabs = Array.from(document.querySelectorAll('.tabs .tab')).filter(function(t){ return t.offsetParent !== null || getComputedStyle(t).display !== 'none'; });
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
      // Partner cell nav owns j/k when active
      var partnerPanelJK = document.getElementById('pay-panel-partners');
      if (partnerPanelJK && partnerPanelJK.style.display !== 'none' && typeof window.fbPartnerSelRow !== 'undefined' && window.fbPartnerSelRow >= 0) {
        return;
      }
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

    // ── a / d → partner cell nav owns these when active ──
    var partnerPanelAD = document.getElementById('pay-panel-partners');
    var partnerActive = partnerPanelAD && partnerPanelAD.style.display !== 'none';

    // ── a → page-registered "new" action ──
    if (e.key === 'a') {
      if (partnerActive) return;
      if (window.fbKeyActions && typeof window.fbKeyActions['new'] === 'function') {
        e.preventDefault();
        window.fbKeyActions['new']();
      }
      return;
    }

    // ── A (shift-a) → page-registered "attach" action (K4: A = attach
    // everywhere, keyboard-ux-spec §8). Only pages with attachments register
    // fbKeyActions.attach; elsewhere A is inert. FB.keys pages swallow the
    // key at capture before this legacy bubble path runs.
    if (e.key === 'A') {
      if (partnerActive) return;
      if (window.fbKeyActions && typeof window.fbKeyActions['attach'] === 'function') {
        e.preventDefault();
        window.fbKeyActions['attach']();
      }
      return;
    }

    // ── d → delete focused row (page-registered) ──
    if (e.key === 'd') {
      if (partnerActive) return;
      if (window.fbKeyActions && typeof window.fbKeyActions['delete'] === 'function') {
        var focusedRowD = document.querySelector('tr.nav-row-focus');
        if (!focusedRowD) return; // nothing focused — previously crashed on null.dataset
        e.preventDefault();
        window.fbKeyActions['delete'](focusedRowD);
      }
      return;
    }

    // ── e → reserved (was edit; use i instead) ──
    if (e.key === 'e') { return; }
  });

  // tb-global-search: Enter blurs, Escape clears+blurs in SEARCH mode; in
  // COMMAND mode FB.palette's capture-phase handler owns Enter/Esc/arrows
  // (P1-10). Filtering itself is each page's oninput handler.
  document.addEventListener('DOMContentLoaded', function() {
    var gs = document.getElementById('tb-global-search');
    if (gs) {
      if (window.FB && FB.palette) FB.palette.wire(gs);
      // Unified search/filter (2026-07-23): ONE input — a value starting with
      // '/' is a screen-limited filter expression routed to the visible FB.list
      // (terms + field:value qualifiers); anything else is the global search.
      // `/` focuses the box (above), so `//` starts a screen filter.
      var lastWasFilter = false;
      gs.addEventListener('input', function() {
        if (!(window.FB && FB.list && FB.list.visible)) return;
        var inst = FB.list.visible();
        var isFilter = gs.value.charAt(0) === '/';
        if (isFilter && inst) inst.applyFilterExpr(gs.value.slice(1));
        else if (lastWasFilter && inst && inst.anyFilterActive()) inst.clearFilters();
        lastWasFilter = isFilter;
      });
      gs.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
          gs.value = ''; gs.blur(); lastWasFilter = false;
          if (window.FB && FB.list && FB.list.visible) {
            var inst = FB.list.visible();
            if (inst && inst.anyFilterActive()) inst.clearFilters();
          }
        }
        if (e.key === 'Enter') { gs.blur(); }
      });
    }

    // Topbar `?` button — mouse parity for the `?` keyboard overlay (P1-6).
    // No-op on pages without an FB.keys binding set (help.toggle returns
    // false silently there).
    var helpBtn = document.getElementById('tb-help-btn');
    if (helpBtn) {
      helpBtn.addEventListener('click', function() {
        if (window.FB && FB.keys && FB.keys.help) FB.keys.help.toggle();
      });
    }
  });

  // K5: core-baseline coverage provider — attachment panels/queues and any
  // open FB.dropdown menu. common.js is an external script loaded once (not
  // re-executed on soft-nav), so this provider is registered once and
  // survives resetPage (it falls within the lazy baseline captured on the
  // first resetPage call). The attach markup classes span every page that
  // renders attachments: .attach-row (bill-detail), .fb-attach-row
  // (journal-new staged queue), .be-attach-row (bill-edit). The provider
  // returns the PARENT containers so every interactive control inside an
  // attachment panel is covered. The open .fb-dd dropdown element is also a
  // coverage root (its items are keyboard-managed via FB.dropdown).
  if (window.FB && FB.coverage) {
    FB.coverage.addProvider(function () {
      var out = [];
      try {
        document.querySelectorAll('.attach-row, .fb-attach-row, .be-attach-row').forEach(function (r) {
          var p = r.parentElement;
          if (p && out.indexOf(p) === -1) out.push(p);
        });
      } catch (e) { /* attach markup absent — no-op */ }
      try {
        var dd = document.querySelector('.fb-dd');
        if (dd && out.indexOf(dd) === -1) out.push(dd);
      } catch (e) { /* dropdown absent — no-op */ }
      return out;
    }, { core: true });
  }
})();
