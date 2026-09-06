/* fb-core.js — shared UI core (roadmap P1-3)
 *
 * Single source of truth for:
 *   FB.mode  — one vim-mode store (NORMAL/INSERT) with change listeners.
 *   FB.keys  — one capture-phase key dispatcher driven by per-page binding
 *              tables. The same table drives dispatch, hint rendering
 *              (FB.keys.renderHints) and the `?` which-key overlay
 *              (FB.keys.help, roadmap P1-6), so hints cannot drift from
 *              behavior.
 *   FB.nav   — generic row-navigation helper for list tabs (adopted as each
 *              tab migrates; Bills keeps its tuned cursor for now).
 *   FB.util  — esc/escAttr/fmtDate/today. `window.esc` is exposed as a legacy
 *              global so template-string pages can drop their local copies.
 *
 * Load order: included in <head> (see api/src/pages/common.js commonStyle()),
 * so it is available to every inline page script regardless of position.
 */
(function () {
  'use strict';

  // ── utils ─────────────────────────────────────────────────────────────────
  // House-standard escaper: safe in text nodes AND double-quoted attributes.
  // Renders identically to the old &-<-only variants in text content.
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Bills-format date: 'YYYY-MM-DD' → 'DD Mon YYYY' (the Payables standard).
  function fmtDate(d) {
    if (!d) return '—';
    var s = String(d).slice(0, 10);
    var parts = s.split('-');
    if (parts.length !== 3) return s;
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return parts[2] + ' ' + months[parseInt(parts[1], 10) - 1] + ' ' + parts[0];
  }

  function today() { return new Date().toISOString().slice(0, 10); }

  // ── mode store ────────────────────────────────────────────────────────────
  var _mode = 'NORMAL';
  var _modeListeners = [];

  var mode = {
    get: function () { return _mode; },
    set: function (v) {
      v = String(v || 'NORMAL').toUpperCase();
      if (v !== 'INSERT') v = 'NORMAL'; // two modes only, per the agreed model
      if (v === _mode) return;
      _mode = v;
      for (var i = 0; i < _modeListeners.length; i++) {
        try { _modeListeners[i](v); } catch (e) { /* listener must not break dispatch */ }
      }
    },
    // fn is called immediately with the current mode, then on every change —
    // subscribers always converge on the truth regardless of load order.
    onChange: function (fn) {
      _modeListeners.push(fn);
      try { fn(_mode); } catch (e) {}
    }
  };

  // ── key dispatcher ────────────────────────────────────────────────────────
  // A binding set:
  // {
  //   active:   fn() → bool            — is this set live right now? (e.g. tab visible)
  //   getMode:  fn() → 'NORMAL'|'INSERT'
  //   bindings: [{
  //     key:    'j' | 'Enter' | 'Escape' | ' ' | ...   (KeyboardEvent.key)
  //     mode:   'NORMAL' | 'INSERT'
  //     hint:   'navigate'              — shown by renderHints (adjacent same-hint
  //                                       keys group as "j/k navigate")
  //     hintBar: true                   — include in the footer hint bar
  //     when:   fn(e) → bool            — runtime predicate; fail = binding skipped
  //     swallow: bool | fn(e) → bool    — stopImmediatePropagation (default true)
  //     preventDefault: bool            — default true
  //     paletteEligible: bool           — default true; false = omit from
  //                                       : palette (movement/chrome keys)
  //     run:    fn(e)                   — the action
  //   }]
  // }
  // Unmatched keys fall through untouched: in INSERT they type into inputs;
  // in NORMAL they reach common.js's global handler (h/l/{/}/etc.), exactly
  // as the pre-FB capture/bubble split behaved.
  var _sets = {};
  var _order = [];
  // K2: pushed modal scopes (LIFO). While non-empty the TOP scope owns
  // dispatch exclusively — see _dispatch. FB.modal is the consumer.
  var _scopeStack = [];

  // K3c: soft-nav key lifecycle. The core baseline is captured once at IIFE
  // end (before any page script registers). resetPage() removes everything
  // registered AFTER that snapshot — i.e. all page-level key sets — so the
  // arriving page starts clean. Teardown callbacks (document-listener
  // removal etc.) fire first, then sets are cleared, then the g-prefix and
  // gg-hook state is reset. common.js fbNavigate calls this after the
  // #page-main swap and BEFORE re-executing scripts.
  var _pageResetCbs = [];
  var _baselineOrder = null; // captured at IIFE end — see bottom of file

  function _matchBinding(set, e, m) {
    // Modifier guard: Ctrl/Cmd/Alt are browser/OS shortcut prefixes —
    // a single-letter binding (e.g. 'R' for reversal) must NOT fire when
    // the user intends Ctrl+Shift+R (reload), Cmd+R, Alt+R, etc.
    if (e.ctrlKey || e.metaKey || e.altKey) return null;
    for (var i = 0; i < set.bindings.length; i++) {
      var b = set.bindings[i];
      if (b.key !== e.key) continue;
      if ((b.mode || 'NORMAL') !== m) continue;
      if (b.when && !b.when(e)) continue;
      return b;
    }
    return null;
  }

  function _isEditableTarget(e) {
    var t = e.target || {};
    return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || !!t.isContentEditable;
  }

  // ── K1: g-prefix go-to map + company switcher (docs/keyboard-ux-spec.md) ──
  // ONE pending-`g` state lives here (the legacy copies in common.js and
  // fb-list.js are deleted). Semantics:
  //   g            arm the 500 ms window (only when no active set claims `g`)
  //   g g          scroll #page-main to top + fire onGG hooks (list first-row)
  //   g <letter>   navigate to the registry route carrying that gKey
  //   g w          toggle the company switcher (own key scope while open;
  //                moved off `c` — calendar-reminders-documents-spec.md §2
  //                gives Calendar that key as a higher-frequency jump)
  //   g <other>    cancel — the key proceeds through normal dispatch untouched
  var _gPending = false, _gTimer = null;
  var _onGG = [];

  function _company() { return location.pathname.split('/')[1] || ''; }

  function _gResolve(key) {
    if (key === 'g') return { type: 'gg' };
    if (key === 'w') return { type: 'switcher' };
    var R = window.FB_ROUTES || [];
    for (var i = 0; i < R.length; i++) {
      if (R[i].gKey === key) return { type: 'route', route: R[i].route, absolute: !!R[i].absolute };
    }
    return null;
  }

  function _gGo(act) {
    if (act.type === 'gg') {
      // Hooks first (they set the first-row cursor and scroll it into view),
      // THEN force absolute top on the next frame — otherwise the row paint's
      // scrollIntoView('nearest') cancels the smooth page scroll mid-flight
      // and gg lands near, not AT, the top (magnus K1 review 2026-07-28).
      for (var i = 0; i < _onGG.length; i++) { try { _onGG[i](); } catch (e) {} }
      requestAnimationFrame(function () {
        var pm = document.getElementById('page-main');
        if (pm) pm.scrollTo(0, 0);
        window.scrollTo(0, 0);
      });
      return;
    }
    if (act.type === 'switcher') { switcher.toggle(); return; }
    if (act.absolute || !window.fbNavigate) {
      window.location.href = act.absolute ? act.route : act.route.replace(':company', _company());
      return;
    }
    window.fbNavigate(act.route.replace(':company', _company()));
  }

  // True when an active set has a NORMAL binding for `key` — page claims beat
  // the g-prefix arm (context-override doctrine).
  function _setClaims(key) {
    for (var i = 0; i < _order.length; i++) {
      var set = _sets[_order[i]];
      if (!set) continue;
      if (set.active && !set.active()) continue;
      var m = set.getMode ? set.getMode() : 'NORMAL';
      if (m !== 'NORMAL') continue;
      for (var k = 0; k < set.bindings.length; k++) {
        if (set.bindings[k].key === key && (set.bindings[k].mode || 'NORMAL') === 'NORMAL') return true;
      }
    }
    return false;
  }

  // Company switcher (g w). Reuses fbToggleCompany's data path (common.js) —
  // no duplicated fetch/render. While open it owns every key (help-overlay
  // precedent): j/k highlight (sticky ends), Enter follows the anchor exactly
  // like the mouse, Esc closes, g w toggles closed.
  var switcher = (function () {
    var _idx = -1;
    var _sgPending = false, _sgTimer = null;

    function _dd() { return document.getElementById('tb-company-dropdown'); }
    function isOpen() {
      var d = _dd();
      return !!(d && d.style.display !== 'none');
    }
    function _opts() {
      var d = _dd();
      return d ? Array.prototype.slice.call(d.querySelectorAll('a.tb-company-opt')) : [];
    }
    function _highlight(i) {
      var os = _opts();
      _idx = i;
      os.forEach(function (o, k) { o.classList.toggle('tb-company-focus', k === i); });
      if (os[i] && os[i].scrollIntoView) os[i].scrollIntoView({ block: 'nearest' });
    }
    function toggle() {
      if (!window.fbToggleCompany) return;
      window.fbToggleCompany(null, function (opened) {
        if (opened) _highlight(0);
        else _idx = -1;
      });
    }
    function _close() { if (isOpen()) toggle(); }
    function key(k) {
      var os = _opts();
      if (k === 'Escape') { _close(); return; }
      if (k === 'j' || k === 'ArrowDown') { if (os.length) _highlight(Math.min(_idx + 1, os.length - 1)); return; }
      if (k === 'k' || k === 'ArrowUp') { if (os.length) _highlight(Math.max(_idx - 1, 0)); return; }
      if (k === 'Enter') {
        var o = os[_idx >= 0 ? _idx : 0];
        if (o) o.click(); // plain anchor — exactly the mouse path
        return;
      }
      // g w toggles closed (mirror of the open sequence)
      if (k === 'g') {
        _sgPending = true; clearTimeout(_sgTimer);
        _sgTimer = setTimeout(function () { _sgPending = false; }, 500);
        return;
      }
      if (k === 'w' && _sgPending) { _sgPending = false; clearTimeout(_sgTimer); _close(); }
    }
    return { toggle: toggle, isOpen: isOpen, key: key };
  })();

  // The set that currently owns dispatch: first registered set whose active()
  // passes (a set without active() is always live, mirroring _dispatch). The
  // help overlay and the `?` trigger resolve their binding table through this
  // — same source of truth as dispatch, so the overlay cannot go stale.
  function _activeSet() {
    for (var i = 0; i < _order.length; i++) {
      var set = _sets[_order[i]];
      if (set && (!set.active || set.active())) return { name: _order[i], set: set };
    }
    return null;
  }

  function _dispatch(e) {
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
    // Help overlay open: close on ANY key and let it fall through to normal
    // dispatch so the user can immediately act on what they read (e.g. press
    // `g i` to go to Inbox — the `g` closes the overlay and arms the g-prefix,
    // `i` navigates). Modifier-only keys don't reach here (early return above).
    if (help.isOpen()) {
      help.close();
      // Fall through — do NOT stopImmediatePropagation or preventDefault.
      // The key proceeds through normal dispatch as if the overlay wasn't
      // open. The overlay is already gone, so the user sees their key take
      // effect immediately.
    }
    // K2: a pushed modal scope owns dispatch exclusively — page sets, the
    // switcher, the g-prefix and common.js all stay inert until it pops.
    // Unmatched keys are swallowed (stopImmediatePropagation) but NOT
    // preventDefault'ed, so typing into a modal input still works.
    if (_scopeStack.length) {
      var topSet = _sets[_scopeStack[_scopeStack.length - 1]];
      if (topSet) {
        var tm = topSet.getMode ? topSet.getMode() : 'NORMAL';
        var tb = _matchBinding(topSet, e, tm);
        e.stopImmediatePropagation();
        if (tb) {
          if (tb.preventDefault !== false) e.preventDefault();
          if (tb.run) tb.run(e);
        }
        return;
      }
    }
    // K1: the company switcher owns every key while open (help-overlay
    // precedent) — page bindings and common.js stay inert until it closes.
    if (switcher.isOpen()) {
      e.stopImmediatePropagation();
      e.preventDefault();
      switcher.key(e.key);
      return;
    }
    // Global Period Selector (global-period-selector-chrome-spec.md §8): the
    // popover owns every key while open — same "owns every key" doctrine as
    // the switcher above. Only ArrowUp/ArrowDown defer to native behavior
    // when focus is actually inside the Start/End date inputs (they step a
    // date segment there); j/k/p/n/Enter/Escape are never meaningful
    // characters inside a date input, so they fire regardless of focus —
    // a fast custom-date-then-quickset (type dates, press `n`, focus still
    // in the End field) must not silently no-op.
    if (period.isOpen()) {
      var pk = e.key;
      var isPeriodKey = pk === 'Enter' || pk === 'Escape' || pk === 'j' || pk === 'k'
        || pk === 'p' || pk === 'n' || pk === 'ArrowUp' || pk === 'ArrowDown';
      if (isPeriodKey && !((pk === 'ArrowUp' || pk === 'ArrowDown') && _isEditableTarget(e))) {
        e.stopImmediatePropagation();
        e.preventDefault();
        period.key(pk);
        return;
      }
    }
    // K1: g-prefix go-to map. The second key of an armed sequence resolves
    // here; a non-matching key cancels the prefix and falls through to
    // normal dispatch untouched.
    if (_gPending) {
      _gPending = false;
      clearTimeout(_gTimer);
      var gAct = _gResolve(e.key);
      if (gAct) {
        e.stopImmediatePropagation();
        e.preventDefault();
        _gGo(gAct);
        return;
      }
    }
    // Arm the prefix on a bare `g` in NORMAL mode — unless an active page
    // set claims `g` itself (context-override doctrine).
    if (e.key === 'g' && !e.ctrlKey && !e.altKey && !e.metaKey
        && !_isEditableTarget(e) && !_setClaims('g')) {
      var gcur = _activeSet();
      var gmode = gcur && gcur.set.getMode ? gcur.set.getMode() : 'NORMAL';
      if (gmode === 'NORMAL') {
        _gPending = true;
        clearTimeout(_gTimer);
        _gTimer = setTimeout(function () { _gPending = false; }, 500);
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
      }
    }
    // Bare `p` opens the Global Period Selector (§8) — unless an active page
    // set claims `p` itself (context-override doctrine, mirrors `g` above).
    // `P`/`p` were fully retired from Bills/bank-import 2026-09-01/02
    // (bill-post-payment-consolidation-spec.md), freeing `p` app-wide.
    if (e.key === 'p' && !e.ctrlKey && !e.altKey && !e.metaKey
        && !_isEditableTarget(e) && !_setClaims('p')) {
      var pcur = _activeSet();
      var pmode = pcur && pcur.set.getMode ? pcur.set.getMode() : 'NORMAL';
      if (pmode === 'NORMAL') {
        e.stopImmediatePropagation();
        e.preventDefault();
        period.open();
        return;
      }
    }
    for (var i = 0; i < _order.length; i++) {
      var set = _sets[_order[i]];
      if (!set) continue;
      if (set.active && !set.active()) continue;
      var m = set.getMode ? set.getMode() : 'NORMAL';
      // Typing in a field: NORMAL-mode verbs stay inert (INSERT bindings
      // legitimately fire from inputs — that is where INSERT lives).
      // Carve-out (magnus 2026-08-02): while a dropdown overlay is open,
      // NORMAL bindings may match from a focused select — a mouse-opened
      // overlay keeps DOM focus on the select but never flips the mode
      // (dropdowns never alter NORMAL/INSERT), so its arrows/Enter/Tab/Esc
      // bindings live in NORMAL and must reach dispatch.
      if (m === 'NORMAL' && _isEditableTarget(e) && !dropdown.isOpen()) continue;
      var b = _matchBinding(set, e, m);
      if (!b) continue;
      var swallow = (typeof b.swallow === 'function') ? b.swallow(e) : (b.swallow !== false);
      if (swallow) e.stopImmediatePropagation();
      if (b.preventDefault !== false) e.preventDefault();
      if (b.run) b.run(e);
      return;
    }
    // `?` (Shift+/) opens the which-key overlay — after page bindings so a
    // page could claim the key (none do). NORMAL mode only, and never while
    // typing in a field: the same guard that keeps NORMAL verbs inert, so a
    // literal `?` in a description field stays text. No active hint-bearing
    // No active hint-bearing set (journal/settings/dashboard) → silent no-op.
    if (e.key === '?') {
      var cur = _activeSet();
      var cm = (cur && cur.set.getMode) ? cur.set.getMode() : 'NORMAL';
      if (cm !== 'NORMAL' || _isEditableTarget(e)) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      help.open();
    }
  }

  document.addEventListener('keydown', _dispatch, true); // capture: before common.js bubble handler

  var KEY_LABELS = { 'Escape': 'Esc', ' ': 'Space', 'ArrowDown': '↓', 'ArrowUp': '↑' };

  // Shared hint grouping (sidebar hint panel AND the `?` overlay): consecutive
  // bindings that share one hint collapse into a single row ("j/k navigate"),
  // so both surfaces speak the same labels. Modifier-gated bindings get an
  // explicit prefix ("Ctrl+Enter post") so the label tells the truth.
  function _groupHints(bs) {
    var groups = [];
    for (var i = 0; i < bs.length; i++) {
      var cur = bs[i];
      var keysLabel = _keyLabel(cur);
      while (i + 1 < bs.length && bs[i + 1].hint === cur.hint) {
        i++;
        keysLabel += '/' + _keyLabel(bs[i]);
      }
      groups.push({ keys: keysLabel, hint: cur.hint });
    }
    return groups;
  }

  function _keyLabel(b) {
    return KEY_LABELS[b.key] || b.key;
  }

  // ── `?` help overlay (roadmap P1-6) ───────────────────────────────────────
  // Which-key-style overlay of the ACTIVE binding set — EXHAUSTIVE (every
  // binding carrying a hint, NORMAL and INSERT sections), where the sidebar
  // panel is the curated hintBar subset. Same table, same grouping → cannot
  // drift from dispatch. The keyboard trigger lives in _dispatch (NORMAL
  // mode + not-typing guard); help.open() is the mouse-parity entry point
  // (topbar `?` button) and is deliberately not mode-gated — read-only
  // documentation, closable with Esc like any overlay.
  // #149: a NAV section at the bottom shows g-key destinations from
  // window.FB_ROUTES — relocated from : palette. Same source of truth as
  // _gResolve(), so g-keys and help can never drift.
  var help = (function () {
    var _el = null;
    var _prevFocus = null;

    function _rows(groups) {
      return groups.map(function (g) {
        return '<div class="fb-hint-row"><kbd>' + esc(g.keys) + '</kbd><span>' + esc(g.hint) + '</span></div>';
      }).join('');
    }

    function _cap(s) {
      return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
    }

    function open() {
      if (_el) return true;
      var cur = _activeSet();
      var hinted = cur ? cur.set.bindings.filter(function (b) { return !!b.hint; }) : [];
      // Filter out j/k/h/l — they are already in NAVIGATION. Same shortcut
      // should never appear in two places. Capitalize first letter of each hint.
      var navKeys = { 'j': 1, 'k': 1, 'h': 1, 'l': 1 };
      var normal = hinted.filter(function (b) {
        return (b.mode || 'NORMAL') === 'NORMAL' && !navKeys[b.key];
      }).map(function (b) {
        var c = Object.assign({}, b);
        c.hint = _cap(b.hint);
        return c;
      });
      // Navigation section — static chrome constants + g-map entries.
      // Static rows are NOT derived from any binding table.
      var navStatic = [
        { keys: '/', hint: 'Search' },
        { keys: 'h/l', hint: 'Move left / right' },
        { keys: 'j/k', hint: 'Move up / down' },
        { keys: 'gg/G', hint: 'Move to first / last row' }
      ];
      var navRows = _rows(navStatic);
      // g-map entries from window.FB_ROUTES, each hint prefixed with "Go to "
      var R = window.FB_ROUTES || [];
      var gRows = [];
      R.forEach(function (r) {
        if (!r.gKey) return;
        gRows.push({ keys: 'g ' + r.gKey, hint: 'Go to ' + r.label });
      });
      if (gRows.length) navRows += _rows(gRows);
      // Actions heading = the active set's name (capitalized), not "ACTIONS".
      var actionsHeading = cur ? _cap(cur.name) : 'Actions';
      _prevFocus = document.activeElement;
      _el = document.createElement('div');
      _el.id = 'fb-keys-overlay';
      _el.innerHTML =
        '<div class="fb-keys-panel" role="dialog" aria-label="Keyboard shortcuts">' +
          '<div class="fb-keys-title">Keyboard shortcuts</div>' +
          '<div class="fb-keys-main">' +
            '<div class="fb-keys-nav">' +
              '<div class="fb-keys-mode">NAVIGATION</div>' + navRows +
            '</div>' +
            '<div class="fb-keys-actions">' +
              '<div class="fb-keys-mode">' + esc(actionsHeading) + '</div>' +
              (normal.length ? _rows(_groupHints(normal)) : '<div class="fb-hint-row fb-keys-none">—</div>') +
            '</div>' +
          '</div>' +
        '</div>';
      _el.addEventListener('click', function (ev) { if (ev.target === _el) close(); });
      document.body.appendChild(_el);
      if (_prevFocus && _prevFocus.blur) _prevFocus.blur();
      return true;
    }

    function close() {
      if (!_el) return;
      _el.remove();
      _el = null;
      if (_prevFocus && _prevFocus.focus && document.contains(_prevFocus)) {
        try { _prevFocus.focus(); } catch (e) {}
      }
      _prevFocus = null;
    }

    return {
      open: open,
      close: close,
      isOpen: function () { return !!_el; },
      toggle: function () { if (_el) close(); else open(); }
    };
  })();

  // ── FB.search — `/` global search (global-search-spec.md) ──────────────────
  // `/` is the only summon key now. Pressing it leaves the bar blank and
  // opens the dropdown straight into recently-viewed (§2) — there is no
  // scope-choice step. Typing immediately runs a global search across every
  // entity type, grouped by category (§3), with the category matching the
  // current page/tab (PAGE_SCOPE_MAP/TAB_SCOPE_MAP below) sorted first —
  // scoping is a ranking hint, not something the user picks. Journal merges
  // entries and ledger-view reports (GL/TB/voucher-register/line-items) into
  // one group, including a synthesized General Ledger link whenever the
  // query also matches an account (§4), and Statements matches a small
  // static list with zero network round-trip (§5). `Enter` drills one level
  // at a time (§6). Power users can still force a specific entity type by
  // typing its prefix directly ("journal search: …", etc.), and `//` and the
  // legacy `/p:`/`/a:`/`/j:`/`/b:` letter-prefixes still work too (§7).
  var search = (function () {
    var _input = null;
    var _el = null;
    var _items = [];        // flat, navigable rows — mixed kinds, see below
    var _activeIdx = -1;
    var _wired = false;
    var _active = false;
    var _debounce = null;
    var _lastReq = 0;
    var _bareEmpty = false; // true while showing the empty-state (recently-viewed) list
    var _expanded = {};     // catKey → true, reset every fresh query
    var _lastCategories = {}; // last computed category set, reused when expanding

    function _company() { return location.pathname.split('/')[1] || ''; }

    // ── static report registry — zero network, zero debounce (§5) ──────────
    var STATEMENT_REPORTS = [
      { id: 'pl', label: 'Profit & Loss', route: '/statements?t=pl' },
      { id: 'bs', label: 'Balance Sheet', route: '/statements?t=bs' },
      { id: 'cf', label: 'Cash Flow', route: '/statements?t=cf' },
      { id: 'sce', label: 'Statement of Equity', route: '/statements?t=sce' }
    ];
    var JOURNAL_REPORTS = [
      { id: 'voucher-register', label: 'Transactions', route: '/journal?t=voucher-register' },
      { id: 'journal', label: 'Line items', route: '/journal?t=journal' },
      { id: 'tb', label: 'Trial Balance', route: '/journal?t=tb' },
      { id: 'gl', label: 'General Ledger', route: '/journal?t=gl' },
      { id: 'integrity', label: 'Integrity', route: '/accounting?tab=integrity' }
    ];
    function _staticMatch(list, q) {
      var lower = q.toLowerCase();
      return list.filter(function (r) { return r.label.toLowerCase().indexOf(lower) !== -1; })
        .map(function (r) { return { type: 'result', id: r.id, label: r.label, route: r.route }; });
    }

    // ── recently-viewed — localStorage, per company, cap 3 (§2.1) ──────────
    function _recentKey() { return 'fb-recent-' + _company(); }
    function _recentList() {
      try {
        var arr = JSON.parse(localStorage.getItem(_recentKey()) || '[]');
        return Array.isArray(arr) ? arr : [];
      } catch (e) { return []; }
    }
    // Public write API — called by detail-view pages on open (bill-detail.js,
    // journal-voucher.js view-existing-batch path, …).
    function pushRecent(entry) {
      if (!entry || !entry.id || !entry.route || !entry.label) return;
      try {
        var list = _recentList().filter(function (r) { return !(r.id === entry.id && r.type === entry.type); });
        list.unshift({ type: entry.type, id: entry.id, label: entry.label, route: entry.route });
        localStorage.setItem(_recentKey(), JSON.stringify(list.slice(0, 3)));
      } catch (e) { /* private mode / quota — recently-viewed just stays empty */ }
    }

    // ── bar parsing (§1, §2, §7) ─────────────────────────────────────────────
    var SCOPE_PREFIXES = [
      { key: 'page-filter', text: 'filter current page: ' },
      { key: 'journal',     text: 'journal search: ' },
      { key: 'account',     text: 'accounts search: ' },
      { key: 'partner',     text: 'partners search: ' },
      { key: 'bill',        text: 'bills search: ' },
      { key: 'statements',  text: 'statements search: ' }
    ];

    // Returns { scope, query } for anything this module owns, or null.
    // An explicit prefix (typed directly, without pressing `/` first) always
    // wins and forces that entity type — legacy `/`-grammar and the
    // SCOPE_PREFIXES shortcuts both still work as power-user overrides (§7).
    // Otherwise, once search mode is active (via `/`, which leaves the bar
    // blank), the whole box is just the query, scoped 'all' — there's no
    // scope-choice step to parse for.
    function _parseBar(value) {
      if (value) {
        if (value.charAt(0) === '/') {
          if (value.charAt(1) === '/') return { scope: 'page-filter', query: value.slice(2) };
          var parsed = (window.FB && FB.command && FB.command.parseSearchScope)
            ? FB.command.parseSearchScope(value) : { scope: null, query: value.slice(1) };
          return { scope: parsed.scope || 'all', query: parsed.query };
        }
        var lower = value.toLowerCase();
        for (var i = 0; i < SCOPE_PREFIXES.length; i++) {
          if (lower.indexOf(SCOPE_PREFIXES[i].text) === 0) {
            return { scope: SCOPE_PREFIXES[i].key, query: value.slice(SCOPE_PREFIXES[i].text.length) };
          }
        }
      }
      if (_active) return { scope: 'all', query: value || '' };
      return null;
    }

    function _listVisible() { return !!(window.FB && FB.list && FB.list.visible && FB.list.visible()); }

    // Current page/tab → a single ranking hint (not a user-facing choice):
    // which entity type's category should be sorted first in a global
    // result set. Narrowest wins — tab beats page.
    var PAGE_SCOPE_MAP = { payables: 'bill', journal: 'journal', accounting: 'account', statements: 'statements' };
    // (pageKey, tab-panel id minus "tab-" prefix) → scopeKey.
    // Aging is the same bills data, just bucketed by due date (same relationship
    // GL has to journal entries) — same 'bill' scope as the Bills tab itself.
    // Control (ap-control) is a one-number GL-vs-subledger reconciliation, not
    // a list of records — nothing to search for there, same category as
    // Integrity — deliberately not mapped.
    var TAB_SCOPE_MAP = {
      'payables:bills':   'bill',
      'payables:vendors': 'partner',
      'payables:aging':   'bill',
      'accounting:coa':   'account'
    };
    function _activeRoute() {
      var path = window.location.pathname;
      var routes = window.FB_ROUTES || [];
      for (var i = 0; i < routes.length; i++) {
        var r = routes[i];
        if (!r.route) continue;
        var pattern = r.route.replace('/:company', '/[^/]+');
        if (r.absolute) { if (path === r.route) return r; }
        else if (new RegExp('^' + pattern + '/?$').test(path)) return r;
      }
      return null;
    }
    // Narrowest-first: the active tab's scope if it names one, else the
    // page's own default scope, else null (no ranking hint — e.g. Dashboard).
    function _priorityScope() {
      var route = _activeRoute();
      var pageKey = route && route.key;
      if (!pageKey) return null;
      var panel = document.querySelector('.tab-panel.active');
      var tabId = panel && panel.id ? panel.id.replace(/^tab-/, '') : null;
      var tabScope = tabId && TAB_SCOPE_MAP[pageKey + ':' + tabId];
      return tabScope || PAGE_SCOPE_MAP[pageKey] || null;
    }

    // ── DOM shell (fb-palette CSS reused, unchanged from before) ───────────
    function _open() {
      if (_el) return;
      _el = document.createElement('div');
      _el.className = 'fb-palette';
      var wrap = _input.closest('.tb-search-wrap') || _input.parentElement;
      if (wrap) wrap.style.position = wrap.style.position || 'relative';
      (wrap || document.body).appendChild(_el);
    }
    function _close() {
      if (_el) { _el.remove(); _el = null; }
      _items = []; _activeIdx = -1; _active = false; _bareEmpty = false;
    }
    // Hides the dropdown without leaving search mode — used whenever the
    // query goes back to empty (typed-then-deleted) but `/` is still "held":
    // subsequent keystrokes should still be treated as a query.
    function _hide() {
      if (_el) { _el.remove(); _el = null; }
      _items = []; _activeIdx = -1; _bareEmpty = false;
    }

    // ── empty-state rows (§2) — recently-viewed only; no scope choice ───────
    function _buildEmptyItems() {
      var rows = [];
      var recent = _recentList();
      recent.forEach(function (r, i) {
        rows.push({ kind: 'recent', label: r.label, route: r.route, sectionLabel: i === 0 ? 'Recently viewed' : null });
      });
      return rows;
    }

    function _renderEmpty() {
      _bareEmpty = true;
      _items = _buildEmptyItems();
      _activeIdx = _items.length ? 0 : -1;
      _open();
      _render();
    }

    // ── typed-state categories (§3, §4, §5) ─────────────────────────────────
    var TYPE_LABELS_PLURAL = { statements: 'Statements', journal: 'Journal', account: 'Accounts', partner: 'Partners', bill: 'Bills' };
    var DEFAULT_CATEGORY_ORDER = ['statements', 'journal', 'account', 'partner', 'bill'];
    // A global ('all') result set sorts the category matching the current
    // page/tab first — the ranking hint that replaced the old scope picker.
    // Scoped fetches (a single category) are unaffected — order is moot.
    function _categoryOrder() {
      var p = _priorityScope();
      if (!p) return DEFAULT_CATEGORY_ORDER;
      return [p].concat(DEFAULT_CATEGORY_ORDER.filter(function (k) { return k !== p; }));
    }

    // `items` is grouped when its entries are { key, label, items: [...] }
    // sub-groups (currently only Journal — real entries vs. GL vs. other
    // report matches are different *kinds* of thing, not one flat list).
    function _isGroupedItems(items) {
      return items.length > 0 && !!items[0] && Array.isArray(items[0].items);
    }

    // One category's raw item list → the flat, possibly-expanded rows §6
    // describes: a single item collapses into itself (no header, no expand
    // step); 2+ items render as a header (expands on activation) plus, once
    // expanded, one indented row per item. Grouped categories (§ this
    // revision) get one extra nesting level: the top header expands into
    // sub-category headers (own counts, own expand step), which expand into
    // the actual leaf rows, indented one level further.
    function _flattenCategory(key, items) {
      var out = [];
      if (!items.length) return out;

      if (_isGroupedItems(items)) {
        // No single-item collapse here, unlike the flat case below — the
        // sub-group label (Transactions vs. General Ledger, …) carries real
        // information about *what kind* of match this is, which a bare leaf
        // row doesn't convey on its own. Grouped categories always show the
        // full chain: top header → sub-group header → leaf, even for one hit.
        var total = items.reduce(function (n, g) { return n + g.items.length; }, 0);
        var topExpanded = !!_expanded[key];
        out.push({ kind: 'category', catKey: key, label: TYPE_LABELS_PLURAL[key] + ': ' + total + ' items', items: items, expanded: topExpanded });
        if (topExpanded) {
          items.forEach(function (g) {
            var subKey = key + '>' + g.key;
            var subExpanded = !!_expanded[subKey];
            out.push({ kind: 'subcategory', catKey: subKey, label: g.label + ': ' + g.items.length + ' items', items: g.items, expanded: subExpanded, indented: true });
            if (subExpanded) {
              g.items.forEach(function (it) { out.push(Object.assign({ kind: 'leaf', catKey: subKey, indent2: true }, it)); });
            }
          });
        }
        return out;
      }

      if (items.length === 1) {
        out.push(Object.assign({ kind: 'leaf', catKey: key }, items[0]));
        return out;
      }
      var expanded = !!_expanded[key];
      out.push({ kind: 'category', catKey: key, label: TYPE_LABELS_PLURAL[key] + ': ' + items.length + ' items', items: items, expanded: expanded });
      if (expanded) items.forEach(function (it) { out.push(Object.assign({ kind: 'leaf', catKey: key, indented: true }, it)); });
      return out;
    }

    function _flattenAll(categories) {
      var out = [];
      _categoryOrder().forEach(function (key) {
        if (!categories[key]) return;
        out = out.concat(_flattenCategory(key, categories[key]));
      });
      return out;
    }

    // Build Journal's sub-groups (§ this revision — "let there always be a
    // tree structure"): real entry hits and the report-name matches they
    // could be confused with are different *kinds* of result, not one flat
    // list. entryHits/staticHits are already {label, route[, id]} shaped;
    // accountHits are raw search.js account rows, synthesized into GL links
    // here — no "General Ledger — " prefix on the leaf anymore, since the
    // sub-group header already says "General Ledger" (§4.1's old prefix is
    // now redundant once there's a real second level).
    function _buildJournalGroups(entryHits, staticHits, accountHits) {
      var staticById = {};
      staticHits.forEach(function (s) { staticById[s.id] = s; });
      var groups = [];

      var txItems = entryHits.slice();
      if (staticById['voucher-register']) txItems.push({ type: 'result', label: staticById['voucher-register'].label, route: staticById['voucher-register'].route });
      if (txItems.length) groups.push({ key: 'transactions', label: 'Transactions', items: txItems });

      var glItems = accountHits.map(function (a) { return { type: 'result', label: a.label, route: '/journal?t=gl&account=' + encodeURIComponent(a.id) }; });
      if (staticById['gl']) glItems.push({ type: 'result', label: staticById['gl'].label, route: staticById['gl'].route });
      if (glItems.length) groups.push({ key: 'gl', label: 'General Ledger', items: glItems });

      ['tb', 'journal', 'integrity'].forEach(function (rid) {
        if (staticById[rid]) groups.push({ key: rid, label: staticById[rid].label, items: [{ type: 'result', label: staticById[rid].label, route: staticById[rid].route }] });
      });
      return groups;
    }

    function _renderTyped(scope, query) {
      _expanded = {}; // fresh query — start collapsed
      var categories = {};

      if (scope === 'statements') {
        categories.statements = _staticMatch(STATEMENT_REPORTS, query);
        _lastCategories = categories;
        _items = _flattenAll(categories);
        _activeIdx = _items.length ? 0 : -1;
        _open(); _render();
        return; // no network — §5
      }

      if (scope === 'page-filter') {
        _items = [{ kind: 'page-filter', label: 'Filter current page', query: query }];
        _activeIdx = 0;
        _open(); _render();
        return;
      }

      // journal / account / partner / bill / all — everything else needs the backend.
      // (Instant pre-fetch pass — static report-label matches only; real
      // entry/account hits land once _fetchAndMerge's network call resolves.)
      if (scope === 'all') categories.statements = _staticMatch(STATEMENT_REPORTS, query);
      if (scope === 'all' || scope === 'journal') categories.journal = _buildJournalGroups([], _staticMatch(JOURNAL_REPORTS, query), []);

      _lastCategories = categories;
      _items = _flattenAll(categories);
      _activeIdx = _items.length ? 0 : -1;
      _open(); _render();

      if (_debounce) { clearTimeout(_debounce); _debounce = null; }
      _debounce = setTimeout(function () { _fetchAndMerge(scope, query, false); }, 150);
    }

    function _fetchOne(backendScope, q) {
      var url = '/api/' + encodeURIComponent(_company()) + '/search?q=' + encodeURIComponent(q) + '&scope=' + encodeURIComponent(backendScope);
      // Journal entries are period-relevant (unlike accounts/partners, which
      // are master data) — scope the search to the currently selected period
      // by default. The server falls back to all periods if nothing matches
      // in-period, so a real reference never dead-ends.
      if ((backendScope === 'journal' || backendScope === 'all') && typeof period !== 'undefined') {
        var p = period.get();
        if (p && p.start && p.end) url += '&start=' + encodeURIComponent(p.start) + '&end=' + encodeURIComponent(p.end);
      }
      return fetch(url).then(function (r) { return r.json(); }).then(function (res) {
        return (!res || !res.ok || !Array.isArray(res.results)) ? [] : res.results;
      }).catch(function () { return []; });
    }

    // §4.1: scope='all' already returns accounts (unioned by the backend),
    // so no extra call is needed there. scope='journal' does NOT return
    // accounts — a parallel scope='account' fetch is needed purely to
    // synthesize the GL link; Accounts is never shown as its own category
    // in a journal-scoped view.
    function _fetchAndMerge(scope, query, autoSelect) {
      var req = ++_lastReq;
      var calls = [_fetchOne(scope === 'all' ? 'all' : scope, query)];
      if (scope === 'journal') calls.push(_fetchOne('account', query));

      Promise.all(calls).then(function (results) {
        if (req !== _lastReq) return; // stale
        var primary = results[0];
        var accountHits = scope === 'all' ? primary.filter(function (r) { return r.type === 'account'; }) : (results[1] || []);
        var toResult = function (r) { return { type: 'result', label: r.label, route: r.route }; };

        var categories = {};
        if (scope === 'all') {
          categories.statements = _staticMatch(STATEMENT_REPORTS, query);
          categories.journal = _buildJournalGroups(
            primary.filter(function (r) { return r.type === 'journal'; }).map(toResult),
            _staticMatch(JOURNAL_REPORTS, query),
            accountHits
          );
          categories.account = primary.filter(function (r) { return r.type === 'account'; }).map(toResult);
          categories.partner = primary.filter(function (r) { return r.type === 'partner'; }).map(toResult);
          categories.bill = primary.filter(function (r) { return r.type === 'bill'; }).map(toResult);
        } else if (scope === 'journal') {
          categories.journal = _buildJournalGroups(primary.map(toResult), _staticMatch(JOURNAL_REPORTS, query), accountHits);
        } else {
          // account / partner / bill — single-category scoped view.
          categories[scope] = primary.map(toResult);
        }

        _lastCategories = categories;
        _items = _flattenAll(categories);
        _activeIdx = _items.length ? 0 : -1;
        _render();
        if (autoSelect && _items.length) _activate(_activeIdx);
      });
    }

    // ── rendering ────────────────────────────────────────────────────────────
    function _render() {
      if (!_el) return;
      if (!_items.length) {
        _el.innerHTML = '<div class="fb-palette-empty">' + (_bareEmpty ? 'type to search' : 'no results') + '</div>';
        return;
      }
      var html = '';
      var lastSection;
      _items.forEach(function (c, i) {
        if (c.sectionLabel && c.sectionLabel !== lastSection) html += '<div class="fb-palette-group"></div>';
        if ('sectionLabel' in c) lastSection = c.sectionLabel;
        var cls = 'fb-palette-row' + (i === _activeIdx ? ' fb-palette-active' : '') + (c.indent2 ? ' fb-palette-indented2' : (c.indented ? ' fb-palette-indented' : ''));
        html += '<div class="' + cls + '" data-i="' + i + '"><span class="fb-palette-label">' + esc(c.label) + '</span></div>';
      });
      _el.innerHTML = html;
      Array.prototype.forEach.call(_el.querySelectorAll('.fb-palette-row'), function (row) {
        row.onmousedown = function (e) { e.preventDefault(); };
        row.onclick = function () { _activate(Number(row.dataset.i)); };
        row.onmouseover = function () { _activeIdx = Number(row.dataset.i); _render(); };
      });
      var act = _el.querySelector('.fb-palette-active');
      if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
    }

    function _move(d) {
      if (!_items.length) return;
      var i = _activeIdx + d;
      if (i < 0) i = 0;
      if (i > _items.length - 1) i = _items.length - 1;
      _activeIdx = i;
      _render();
    }

    // ── selection / commit (§2, §6) ─────────────────────────────────────────
    // One entry point for both click and Enter — dispatches on row kind.
    // §6: a collapsed multi-item category expands (one level, highlight
    // moves to its first child); everything else commits and closes.
    function _activate(idx) {
      var item = _items[idx];
      if (!item) return;
      if (item.kind === 'recent' || item.kind === 'leaf') {
        _close(); if (_input) { _input.value = ''; _input.blur(); }
        var url = '/' + _company() + item.route;
        if (window.fbNavigate) window.fbNavigate(url); else window.location.href = url;
        return;
      }
      if (item.kind === 'page-filter') {
        _close(); if (_input) { _input.value = ''; _input.blur(); }
        var inst = _listVisible() ? window.FB.list.visible() : null;
        if (inst) inst.applyFilterExpr(item.query);
        return;
      }
      // Grouped categories/sub-categories never pre-collapse (see
      // _flattenCategory), so any row of this kind always has something to
      // expand into — no length guard needed here anymore. Activating an
      // already-expanded header toggles it back closed.
      if (item.kind === 'category' || item.kind === 'subcategory') {
        var willExpand = !_expanded[item.catKey];
        _expanded[item.catKey] = willExpand;
        _items = _flattenAll(_lastCategories);
        var headerIdx = -1;
        for (var hi = 0; hi < _items.length; hi++) {
          if ((_items[hi].kind === 'category' || _items[hi].kind === 'subcategory') && _items[hi].catKey === item.catKey) { headerIdx = hi; break; }
        }
        _activeIdx = headerIdx >= 0 ? (willExpand ? headerIdx + 1 : headerIdx) : 0;
        _render();
      }
    }

    // Decide whether the current input value should trigger search mode.
    // Active (via `/`) or an explicit prefix typed directly, always. Returns
    // true if search mode consumed the event (so common.js should skip its
    // fallback path). The dropdown itself only ever shows once there's a
    // query to show results for — an empty box just hides it (§2 revision:
    // `/` no longer pops the empty-state list open by itself).
    function onInput(value) {
      var parsed = _parseBar(value);
      if (!parsed) { if (_active) _close(); return false; }
      if (!_active) _active = true;
      if (!parsed.query) { _hide(); return true; }
      _bareEmpty = false;
      _renderTyped(parsed.scope, parsed.query);
      return true;
    }

    // Called by common.js on keydown. Returns true if handled.
    function onKeydown(e) {
      // Bootstrap: search mode isn't active yet (no `/` pressed) — only an
      // explicit legacy-prefix value typed directly, plus ArrowDown, opens
      // it early. Every other key is someone else's to handle.
      if (!_active) {
        var parsed0 = _parseBar(_input ? _input.value : '');
        if (!parsed0 || e.key !== 'ArrowDown') return false;
        e.preventDefault(); e.stopImmediatePropagation();
        _active = true;
        _renderEmpty();
        return true;
      }
      // Active: the dropdown may currently be hidden (blank bar right after
      // `/` — §2 revision shows nothing until a query is typed). ArrowDown
      // surfaces the recently-viewed list on demand in that case; otherwise
      // it moves the selection as usual.
      if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopImmediatePropagation();
        if (!_el) _renderEmpty(); else _move(1);
        return true;
      }
      if (e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); _move(-1); return true; }
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopImmediatePropagation();
        if (_items.length) _activate(_activeIdx >= 0 ? _activeIdx : 0);
        else submit();
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation();
        _close(); if (_input) { _input.value = ''; _input.blur(); }
        return true;
      }
      return false;
    }

    // Called by common.js when `/` is pressed (§1) — bar stays blank and
    // focused, no dropdown. Nothing shows until a query is typed (onInput)
    // or the recently-viewed list is explicitly requested (ArrowDown).
    function enter() {
      if (!_input) return;
      _input.value = '';
      _input.focus();
      _active = true;
    }

    // Force an immediate fetch (bypassing debounce), auto-selecting the
    // first result on completion — used by common.js's Enter-before-active
    // race fallback.
    function submit() {
      var value = _input ? _input.value : '';
      var parsed = _parseBar(value);
      if (!parsed || !parsed.query) return;
      if (!_active) _active = true;
      if (parsed.scope === 'statements' || parsed.scope === 'page-filter') { _renderTyped(parsed.scope, parsed.query); return; }
      _fetchAndMerge(parsed.scope, parsed.query, true);
    }

    // True if `value` is text this module owns. Used by common.js's Enter
    // safety net for the brief window before search mode is active — an
    // explicit prefix typed directly (SCOPE_PREFIXES or legacy `/`-grammar).
    function looksLikeSearch(value) { return !!_parseBar(value); }

    function wire(input) {
      if (_wired || !input) return;
      _wired = true;
      _input = input;
    }

    return {
      wire: wire,
      onInput: onInput,
      onKeydown: onKeydown,
      enter: enter,
      submit: submit,
      looksLikeSearch: looksLikeSearch,
      pushRecent: pushRecent,
      isActive: function () { return _active; },
      close: _close
    };
  })();

  var keys = {
    register: function (name, def) {
      _sets[name] = def;
      if (_order.indexOf(name) === -1) _order.push(name);
    },
    unregister: function (name) {
      delete _sets[name];
      var i = _order.indexOf(name);
      if (i >= 0) _order.splice(i, 1);
    },
    // K2: modal scope stack. push() registers a set AND makes it the
    // exclusive dispatch owner until pop() (see _dispatch). Consumer:
    // FB.modal; any future overlay that must shadow page keys uses this.
    push: function (name, def) {
      keys.register(name, def);
      if (_scopeStack.indexOf(name) === -1) _scopeStack.push(name);
    },
    pop: function (name) {
      var i = _scopeStack.indexOf(name);
      if (i >= 0) _scopeStack.splice(i, 1);
      keys.unregister(name);
    },
    // True when any registered set is currently active — common.js uses this
    // to suspend its legacy focus-driven mode tracking on migrated pages.
    // Semantics mirror _dispatch: a set with NO active fn is always live
    // (K5 crawl caught dashboard/bill-detail sets reporting inactive).
    hasActive: function () {
      for (var i = 0; i < _order.length; i++) {
        var set = _sets[_order[i]];
        if (set && (!set.active || set.active())) return true;
      }
      return false;
    },
    // Bindings flagged for the hint bar, in registration order.
    hints: function (name) {
      var set = _sets[name];
      if (!set) return [];
      return set.bindings.filter(function (b) { return b.hintBar && b.hint; });
    },
    // Renders hints from the binding table itself — never hand-maintained.
    // layout 'inline' (default): "j/k navigate  ·  Enter fold  ·  …" single line.
    // layout 'list': one row per hint (<div class="fb-hint-row"><kbd>…</kbd>
    // <span>…</span></div>) — used by the sidebar hint panel (#sb-hints).
    renderHints: function (name, el, opts) {
      if (!el) return;
      var layout = opts && opts.layout === 'list' ? 'list' : 'inline';
      var groups = _groupHints(keys.hints(name));
      if (layout === 'list') {
        el.innerHTML = groups.map(function (g) {
          return '<div class="fb-hint-row"><kbd>' + esc(g.keys) + '</kbd><span>' + esc(g.hint) + '</span></div>';
        }).join('');
      } else {
        el.textContent = groups.map(function (g) { return g.keys + ' ' + g.hint; }).join('  ·  ');
      }
    },
    // K3c: soft-nav key lifecycle. Called by common.js fbNavigate after the
    // #page-main content swap and BEFORE re-executing page scripts. Fires
    // registered teardown callbacks (removing document-level listeners etc.),
    // then removes every key set registered after the core baseline (all
    // page-level sets), clears the modal scope stack, and resets the g-prefix
    // + gg-hook state. The arriving page's scripts then register fresh.
    resetPage: function () {
      for (var i = 0; i < _pageResetCbs.length; i++) {
        try { _pageResetCbs[i](); } catch (e) { /* teardown must not break reset */ }
      }
      _pageResetCbs = [];
      // K5: trim page-level coverage providers — keep only providers that
      // declared { core: true } at registration (common.js's attach/dd
      // provider). Page-level providers (fb-form/fb-list/FB.nav.create) are
      // dropped so a departed page's row getters can't stale-match selectors
      // on the arriving page. Mutate in place so coverage._p (which
      // references _covProviders) stays valid — reassigning would orphan it.
      var _kept = _covProviders.filter(function (p) { return p && p.__fbCore === true; });
      _covProviders.length = 0;
      Array.prototype.push.apply(_covProviders, _kept);
      var baseline = _baselineOrder || [];
      for (var j = _order.length - 1; j >= 0; j--) {
        if (baseline.indexOf(_order[j]) === -1) {
          delete _sets[_order[j]];
          _order.splice(j, 1);
        }
      }
      _scopeStack = [];
      _gPending = false;
      clearTimeout(_gTimer);
      _onGG = [];
    },
    // Register a teardown callback fired by resetPage(). FB.form uses this to
    // remove its per-create document-level focusin/focusout listeners.
    onPageReset: function (fn) { _pageResetCbs.push(fn); },
    // `?` keyboard-shortcut overlay (P1-6) — exhaustive which-key view of the
    // active binding set. Keyboard trigger is in _dispatch; this is the
    // programmatic/mouse-parity handle (topbar `?` button).
    help: help,
    // K5: snapshot of every registered binding set — the coverage crawl's
    // proof that every route has live keybindings. Returns one entry per set
    // (registration order) with its active state and a flattened binding list
    // (key, mode, hint, hintBar, hasSwallow). The crawl asserts ≥1 active set
    // with ≥1 NORMAL binding per route without exercising any keys.
    audit: function () {
      return _order.map(function (name) {
        var set = _sets[name];
        if (!set) return { name: name, active: false, bindings: [] };
        return {
          name: name,
          active: !set.active || !!set.active(),
          bindings: (set.bindings || []).map(function (b) {
            return {
              key: b.key,
              mode: b.mode || 'NORMAL',
              hint: b.hint || null,
              hintBar: !!b.hintBar,
              hasSwallow: !!b.swallow
            };
          })
        };
      });
    }
  };

  // ── K5: coverage-root registry ────────────────────────────────────────────
  // Each interactive surface (FB.form zones, FB.list tables, FB.nav row sets,
  // shared attach panels, open dropdown menus) registers a provider that
  // returns its root element(s). FB.coverage.roots() flattens every
  // provider's result — each guarded in try/catch so one crashing provider
  // cannot blank the whole set. The K5 crawl walks every visible interactive
  // control inside #page-main and asserts each is either contained in a
  // coverage root, is a native text-entry field (INSERT-mode typing), or is
  // ratified by a documented exemption — proving the keyboard manages every
  // visible control.
  //
  // resetPage clears page-level providers (form/list/nav, registered per page
  // load) but preserves providers that declared { core: true } (common.js's
  // attach/dd provider, registered once at chrome load). Explicit levels, not
  // a captured baseline — a lazy baseline would bake the INITIAL page's
  // providers in permanently, letting a departed page's row getters
  // stale-match selectors on later pages and falsely "cover" controls.
  var _covProviders = [];

  var coverage = {
    _p: _covProviders,
    // opts.core: chrome-level providers (common.js) survive resetPage;
    // page-level (default — fb-form/fb-list/FB.nav.create) are dropped.
    addProvider: function (fn, opts) {
      if (opts && opts.core === true) fn.__fbCore = true;
      _covProviders.push(fn);
    },
    roots: function () {
      var out = [];
      for (var i = 0; i < _covProviders.length; i++) {
        try {
          var r = _covProviders[i]() || [];
          out = out.concat(r);
        } catch (e) { /* one crashing provider must not blank the set */ }
      }
      return out;
    }
  };

  // ── generic row navigation (for tabs as they migrate) ─────────────────────
  // Sticky boundaries (no deselect at top/bottom), focus class management,
  // scroll-into-view. Bills keeps its bespoke cursor (fold-aware scrolling);
  // this is the target API for Vendors/Bank/Journal list migrations.
  var nav = {
    create: function (opts) {
      // opts: rows() → [el], focusClass (default 'nav-row-focus'),
      //       onFocus(el) optional hook, scrollIntoView opts override
      //   OR: grid() → [[el]] — 2D spatial nav (magnus 2026-07-28): move()
      //       goes across GROUPS preserving the column (vim goal-column),
      //       moveH() goes within the group. Dashboard cards/report links.
      var focusClass = opts.focusClass || 'nav-row-focus';
      var cur = null;

      function groups() { return opts.grid ? (opts.grid() || []).filter(function (g) { return g.length; }) : null; }

      // K5: register a page-level coverage provider returning the nav's row
      // elements. FB.nav.create is called by page scripts (journal, etc.),
      // so this is page-level — cleared by resetPage on soft-nav.
      coverage.addProvider(function () {
        try {
          if (opts.grid) { var gs = groups() || []; return [].concat.apply([], gs); }
          return opts.rows() || [];
        } catch (e) { return []; }
      });

      function set(el) {
        if (cur) cur.classList.remove(focusClass);
        cur = el || null;
        if (!cur) return;
        cur.classList.add(focusClass);
        cur.scrollIntoView({ block: 'nearest' });
        if (opts.onFocus) opts.onFocus(cur);
      }
      function locate() {
        var gs = groups();
        for (var g = 0; g < gs.length; g++) {
          var c = gs[g].indexOf(cur);
          if (c >= 0) return { g: g, c: c };
        }
        return null;
      }

      return {
        set: set,
        clear: function () { set(null); },
        current: function () { return cur; },
        move: function (dir) {
          var gs = groups();
          if (gs) {
            if (!gs.length) return;
            var pos = locate();
            if (!pos) { set(dir > 0 ? gs[0][0] : gs[gs.length - 1][0]); return; }
            var ng = pos.g + dir;
            if (ng < 0) ng = 0;                       // sticky top
            if (ng > gs.length - 1) ng = gs.length - 1; // sticky bottom
            set(gs[ng][Math.min(pos.c, gs[ng].length - 1)]);
            return;
          }
          var rows = opts.rows();
          if (!rows.length) return;
          var i = rows.indexOf(cur);
          if (i === -1) { set(dir > 0 ? rows[0] : rows[rows.length - 1]); return; }
          var n = i + dir;
          if (n < 0 || n >= rows.length) return; // sticky at boundaries
          set(rows[n]);
        },
        // Horizontal step within the current grid group (no-op for rows()).
        moveH: function (dir) {
          var gs = groups();
          if (!gs || !gs.length) return;
          var pos = locate();
          if (!pos) { set(gs[0][0]); return; }
          var nc = pos.c + dir;
          if (nc < 0) nc = 0;                            // sticky left
          if (nc > gs[pos.g].length - 1) nc = gs[pos.g].length - 1; // sticky right
          set(gs[pos.g][nc]);
        },
        first: function () { var gs = groups(); if (gs && gs.length) { set(gs[0][0]); return; } var r = opts.rows(); if (r.length) set(r[0]); },
        last: function () { var gs = groups(); if (gs && gs.length) { var g = gs[gs.length - 1]; set(g[g.length - 1]); return; } var r = opts.rows(); if (r.length) set(r[r.length - 1]); }
      };
    },
    // K1: fb-list instances register their gg first-row behavior here; the
    // unified g-prefix machine fires every hook after scrolling #page-main to
    // top. Hooks must no-op when their list's panel is hidden.
    onGG: function (fn) { _onGG.push(fn); }
  };

  // ── FB.dropdown — the one validated autocomplete (roadmap P2-1) ───────────
  // Replaces nine hand-rolled dropdowns plus every <datalist> in data-entry
  // rows. Styling lives in common.css (.fb-dd*) so it follows the app theme.
  // Behavior contract (docs/payables-ux-spec.md §FB.dropdown): contains-match
  // on code AND name, cap 12, one open app-wide, sticky ends, Enter picks,
  // Tab picks-and-advances (native traversal), Esc closes dd before row-save,
  // ArrowDown on an empty focused field opens the full list.
  var dropdown = (function () {
    var _open = null; // at most one open instance app-wide

    function _close(inst) {
      if (!inst || !inst.el) return;
      inst.el.remove();
      inst.el = null;
      inst.activeIdx = -1;
      if (_open === inst) _open = null;
    }

    function _setActive(inst, i) {
      if (!inst.el) return;
      var rows = inst.el.children;
      for (var k = 0; k < rows.length; k++) rows[k].classList.toggle('fb-dd-active', k === i);
      inst.activeIdx = i;
      if (i >= 0 && rows[i]) rows[i].scrollIntoView({ block: 'nearest' });
    }

    function _render(inst) {
      var el = document.createElement('div');
      el.className = 'fb-dd';
      inst.items.forEach(function (it, i) {
        var row = document.createElement('div');
        row.className = 'fb-dd-item';
        var p = document.createElement('span');
        p.className = 'fb-dd-primary';
        p.textContent = it.primary;
        row.appendChild(p);
        if (it.secondary) {
          var s = document.createElement('span');
          s.className = 'fb-dd-secondary';
          s.textContent = it.secondary;
          row.appendChild(s);
        }
        row.onmouseover = function () { _setActive(inst, i); };
        row.onmousedown = function (e) { e.preventDefault(); }; // input keeps focus
        row.onclick = function () { _pick(inst, i); };
        el.appendChild(row);
      });
      var rect = inst.input.getBoundingClientRect();
      el.style.left = rect.left + 'px';
      el.style.top = (rect.bottom + 2) + 'px';
      el.style.minWidth = Math.max(rect.width, inst.minWidth) + 'px';
      document.body.appendChild(el);
      inst.el = el;
    }

    function _openWith(inst, query) {
      _close(_open);
      var matches = (inst.source(query) || []).slice(0, inst.cap);
      if (!matches.length) return;
      inst.items = matches;
      inst.activeIdx = -1;
      _render(inst);
      _open = inst;
    }

    function _pick(inst, i) {
      if (!inst || !inst.el || !inst.items.length) return false;
      if (i == null || i < 0) i = inst.activeIdx >= 0 ? inst.activeIdx : 0;
      var it = inst.items[i];
      _close(inst);
      if (it) {
        // Suppress the attach input-listener for the duration of onPick: page
        // callbacks commonly set input.value and dispatch a synthetic 'input'
        // to reuse their sync logic — that must not re-open the dropdown.
        inst.suppress = true;
        try { inst.onPick(it, inst.input); } finally { inst.suppress = false; }
      }
      return !!it;
    }

    // attach(input, { source(q) -> [{primary, secondary?, data?}], onPick(item, input), cap?, minWidth? })
    function attach(input, opts) {
      var inst = {
        input: input,
        source: opts.source,
        onPick: opts.onPick || function () {},
        cap: opts.cap || 12,
        minWidth: opts.minWidth || 160,
        items: [], el: null, activeIdx: -1, suppress: false
      };
      input.addEventListener('input', function () {
        if (inst.suppress) return; // programmatic set from our own onPick
        if (input.tagName === 'SELECT') return; // select value changes never open the overlay (native pick parity)
        if (document.activeElement !== input) return; // background sets (blur handlers etc.) never open the dd
        var q = input.value.trim();
        if (!q) { _close(inst); return; } // empty query closes (ArrowDown re-opens full list)
        _openWith(inst, q);
      });
      input.addEventListener('blur', function () { setTimeout(function () { _close(inst); }, 150); });
      // opts.keys: self-bind the behavior-contract keys on the input — for
      // pages that do not route through FB.keys (journal-voucher, settings).
      // FB.keys pages leave this off and wire move/pick/close via their
      // binding tables instead.
      if (opts.keys) {
        input.addEventListener('keydown', function (e) {
          var mine = (_open === inst) && inst.el;
          if (mine) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              var n = inst.items.length;
              var i = inst.activeIdx + (e.key === 'ArrowDown' ? 1 : -1);
              if (i < 0) i = 0;
              if (i > n - 1) i = n - 1; // sticky at both ends
              _setActive(inst, i);
              e.preventDefault();
            } else if (e.key === 'Enter') {
              if (_pick(inst)) e.preventDefault();
            } else if (e.key === 'Tab') {
              _pick(inst); // pick-and-advance: native traversal proceeds
            } else if (e.key === 'Escape') {
              _close(inst);
              e.stopPropagation(); // page handler sees only the SECOND Esc
            }
          } else if (e.key === 'ArrowDown' && !input.value.trim()) {
            _openWith(inst, ''); // full list on ArrowDown-over-empty
            e.preventDefault();
          }
        });
      }
      input.__fbdd = inst;
      return inst;
    }

    // attachSelect(select, { onPick?, cap?, minWidth? }) — the dropdown
    // overlay for native <select> cells (magnus 2026-07-28): ArrowDown shows
    // the FULL option list instead of blind-stepping the cell value. Pick
    // sets select.value and fires change, so page onchange handlers drive
    // everything downstream (report loads, period date fills, …).
    function attachSelect(select, opts) {
      opts = opts || {};
      var inst = attach(select, {
        source: function () {
          return Array.prototype.slice.call(select.options)
            .filter(function (o) { return !o.disabled; })
            .map(function (o) { return { primary: o.text, data: o.value }; });
        },
        onPick: function (item) {
          select.value = item.data;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          // K3e restoration (magnus 2026-08-02): a mouse-opened overlay runs
          // in NORMAL (dropdowns never alter the mode); once the pick closes
          // the overlay, the anchor must not keep DOM focus in NORMAL — a
          // lingering focused select is a second visible selector and locks
          // NORMAL keys behind the editable-target guard. INSERT picks keep
          // focus (keyboard field flow continues; ddFromNormal restores
          // NORMAL right after this returns).
          if (window.FB && FB.mode && FB.mode.get() === 'NORMAL' && select.blur) select.blur();
          if (opts.onPick) opts.onPick(item.data, select);
        },
        cap: opts.cap || 12,
        minWidth: opts.minWidth
      });
      // One menu for mouse AND keyboard (magnus 2026-07-30): suppress the native
      // OS popup on click and open the FB overlay instead — same white menu the
      // keyboard path (ArrowDown / i) opens. preventDefault blocks the popup and
      // the focus grab, so focus explicitly; 'click' still fires for fb-form's
      // cell-cursor mouse parity. OPEN FIRST, THEN focus (2026-08-02): focusin
      // fires synchronously out of select.focus() → fb-form paint() → its K3e
      // no-focus-in-NORMAL enforcement, which spares a control whose overlay is
      // open (ae.__fbdd.el). Focusing first would blur the select before the
      // overlay exists, and the blur-close would kill the menu 150ms later.
      select.addEventListener('mousedown', function (e) {
        e.preventDefault();
        _openWith(inst, '');
        select.focus();
      });
      return inst;
    }

    return {
      attach: attach,
      attachSelect: attachSelect,
      isOpen: function () { return !!_open; },
      attachable: function (el) { return !!(el && el.__fbdd); },
      openFull: function (el) { if (el && el.__fbdd) _openWith(el.__fbdd, ''); },
      move: function (dir) {
        if (!_open || !_open.el) return;
        var n = _open.items.length;
        var i = _open.activeIdx + dir;
        if (i < 0) i = 0;
        if (i > n - 1) i = n - 1; // sticky at both ends — no wraparound
        _setActive(_open, i);
      },
      pick: function () { return _open ? _pick(_open) : false; },
      close: function () { _close(_open); }
    };
  })();

  // ── FB.modal — the one keyboard-complete modal (K2, docs/keyboard-ux-spec §7) ──
  // Contract: Esc = cancel (NEVER confirms), backdrop click = cancel, button
  // letter keys are per-modal (leave-guard uses w/u mirroring the write/revert
  // doctrine), destructive actions use type-to-confirm (GitHub pattern: exact
  // string match arms the danger button; Enter inside the input activates it;
  // the danger button carries NO letter key — deliberate friction).
  // While open, a pushed FB.keys scope owns dispatch exclusively (page sets,
  // switcher, g-prefix, common.js inert). getMode returns INSERT while the
  // type-confirm input is focused, so typing a name containing 'w'/'u'/'~'
  // never fires a verb.
  var modal = (function () {
    var _el = null, _prevFocus = null, _scope = null, _seq = 0, _onCancel = null;

    function isOpen() { return !!_el; }

    function close() {
      if (_scope) { keys.pop(_scope); _scope = null; }
      if (_el) { _el.remove(); _el = null; }
      _onCancel = null;
      if (_prevFocus && _prevFocus.focus && document.contains(_prevFocus)) {
        try { _prevFocus.focus(); } catch (e) {}
      }
      _prevFocus = null;
    }

    function _cancel() {
      var cb = _onCancel;
      close();
      if (cb) { try { cb(); } catch (e) {} }
    }

    // opts: {
    //   title, body (HTML — callers escape user data),
    //   buttons: [{ label, danger?, primary?, key?, hint?, requiresConfirm?, onClick(api) }],
    //   typeConfirm: { match, label? },  // exact-match arms requiresConfirm buttons
    //   noteInput:  { required?: bool, label?, placeholder? },  // A3j §4.4: a free-text
    //                // note input. When required:true it arms requiresConfirm buttons
    //                // ONLY when non-empty (the reject-note doctrine); Enter in the
    //                // input submits the first armed requiresConfirm button. When
    //                // required:false the input is optional and buttons stay armed
    //                // (approve's optional note). confirmValue() returns the note.
    //   onCancel                         // Esc + backdrop (never a confirm)
    // }
    // api: { close(), error(text), confirmValue(), btn(i) }
    function open(opts) {
      close(); // one modal app-wide
      _prevFocus = document.activeElement;
      _onCancel = opts.onCancel || null;
      _el = document.createElement('div');
      _el.className = 'fb-modal-overlay';
      var html = '<div class="fb-modal" role="dialog" aria-modal="true">'
        + '<div class="fb-modal-title">' + esc(opts.title || '') + '</div>'
        + (opts.body ? '<div class="fb-modal-body">' + opts.body + '</div>' : '');
      if (opts.typeConfirm) {
        html += '<div class="fb-modal-body" style="margin-top:10px">'
          + '<label for="fb-modal-tc" style="display:block;font-size:9pt;color:#555;margin-bottom:4px">'
          + esc(opts.typeConfirm.label || ('Type ' + opts.typeConfirm.match + ' to confirm')) + '</label>'
          + '<input type="text" id="fb-modal-tc" autocomplete="off" spellcheck="false" '
          + 'style="width:100%;padding:6px 9px;border:1px solid #ccc;border-radius:4px;font-size:10pt;font-family:monospace;box-sizing:border-box">'
          + '</div>';
      }
      // A3j §4.4: free-text note input (approve's optional note; reject's
      // REQUIRED note — required:true arms requiresConfirm buttons only when
      // non-empty, Enter submits the first armed button). Same input element
      // family as typeConfirm so the existing arm/Enter/getMode machinery keys
      // off `input` below; the two are mutually exclusive (a modal uses either
      // exact-match typeConfirm or free-text noteInput, never both).
      if (opts.noteInput) {
        var nLabel = opts.noteInput.label || (opts.noteInput.required ? 'Note (required)' : 'Note (optional)');
        html += '<div class="fb-modal-body" style="margin-top:10px">'
          + '<label for="fb-modal-tc" style="display:block;font-size:9pt;color:#555;margin-bottom:4px">'
          + esc(nLabel) + '</label>'
          + '<input type="text" id="fb-modal-tc" autocomplete="off" spellcheck="false" '
          + 'placeholder="' + esc(opts.noteInput.placeholder || '') + '" '
          + 'style="width:100%;padding:6px 9px;border:1px solid #ccc;border-radius:4px;font-size:10pt;box-sizing:border-box">'
          + '</div>';
      }
      html += '<div class="fb-modal-err" style="display:none"></div>'
        + '<div class="fb-modal-btns">'
        + opts.buttons.map(function (b, i) {
            return '<button type="button" class="' + (b.primary ? 'btn-primary' : 'btn-sm') + (b.danger ? ' danger' : '')
              + '" data-i="' + i + '">' + esc(b.label)
              + (b.key ? ' <kbd style="opacity:.55;font-size:8pt">' + esc(b.key) + '</kbd>' : '')
              + '</button>';
          }).join('')
        + '</div></div>';
      _el.innerHTML = html;
      _el.addEventListener('click', function (ev) { if (ev.target === _el) _cancel(); });
      document.body.appendChild(_el);

      var errBox = _el.querySelector('.fb-modal-err');
      var input = _el.querySelector('#fb-modal-tc');
      var btnEls = Array.prototype.slice.call(_el.querySelectorAll('.fb-modal-btns button'));

      // _armed: typeConfirm = exact-match; noteInput.required = non-empty arms;
      // noteInput absent or required:false = always armed (optional note).
      function _armed() {
        if (opts.noteInput) {
          if (opts.noteInput.required) return !!(input && input.value.trim() !== '');
          return true;
        }
        if (!opts.typeConfirm) return true;
        return !!(input && input.value === opts.typeConfirm.match);
      }
      function _refresh() {
        btnEls.forEach(function (btn) {
          var b = opts.buttons[Number(btn.dataset.i)];
          if (b.requiresConfirm) btn.disabled = !_armed();
        });
      }
      var api = {
        close: close,
        error: function (text) {
          if (!errBox) return;
          errBox.textContent = text || '';
          errBox.style.display = text ? '' : 'none';
        },
        confirmValue: function () { return input ? input.value : null; },
        btn: function (i) { return btnEls[i] || null; }
      };

      btnEls.forEach(function (btn) {
        btn.addEventListener('click', function () { opts.buttons[Number(btn.dataset.i)].onClick(api); });
      });

      var bindings = [
        { key: 'Escape', mode: 'NORMAL', run: _cancel },
        { key: 'Escape', mode: 'INSERT', run: _cancel }
      ];
      if (input) {
        bindings.push({ key: 'Enter', mode: 'INSERT', run: function () {
          for (var i = 0; i < opts.buttons.length; i++) {
            var b = opts.buttons[i];
            if (b.requiresConfirm) { if (_armed()) b.onClick(api); return; }
          }
        } });
      }
      opts.buttons.forEach(function (b) {
        if (b.key) bindings.push({ key: b.key, mode: 'NORMAL', hint: b.hint, run: function () { b.onClick(api); } });
      });
      _scope = 'fb-modal-' + (++_seq);
      keys.push(_scope, {
        getMode: function () { return (input && document.activeElement === input) ? 'INSERT' : 'NORMAL'; },
        bindings: bindings
      });

      if (input) { input.addEventListener('input', _refresh); _refresh(); input.focus(); }
      else if (btnEls[0]) { btnEls[0].focus(); }
      return api;
    }

    return { open: open, close: close, isOpen: isOpen };
  })();

  // ── FB.status — the ONE transient-feedback channel (agreed 2026-07-23) ──
  // Every "Saved"/error message app-wide writes to the single topbar slot
  // (#tb-status-msg). NEVER auto-dismisses: a message stays until the next one
  // replaces it. Per-screen msg spans are retired. Distinct from the 🔔
  // (persistent alerts, fx-automation-spec §7): transient feedback vs
  // persistent notifications are two channels, two lifetimes.
  // topbar-chrome-spec §3: auto-dismiss ~5s + instant dismiss on navigation.
  // Reverses the 2026-07-23 never-dismiss rule — a message stays 5s then
  // collapses the banner; a new message replaces + restarts the timer.
  var _statusTimer = null;
  var status = {
    // sev: true | 'err' → red; 'warn' → amber; falsy → green confirmation /
    // neutral text. Auto-dismisses after 5s (topbar-chrome-spec §3).
    show: function (text, sev) {
      var el = document.getElementById('tb-status-msg');
      if (!el) return;
      var banner = document.getElementById('fb-status-banner');
      if (_statusTimer) { clearTimeout(_statusTimer); _statusTimer = null; }
      el.textContent = text || '';
      el.className = 'tb-status-msg'
        + ((sev === true || sev === 'err') ? ' err' : (sev === 'warn' ? ' warn' : (text ? ' ok' : '')));
      if (text && banner) {
        banner.classList.add('fb-banner-visible');
        _statusTimer = setTimeout(function () { status.show(''); }, 5000);
      } else if (banner) {
        banner.classList.remove('fb-banner-visible');
      }
    },
    clear: function () { status.show(''); },
    dismiss: function () {
      if (_statusTimer) { clearTimeout(_statusTimer); _statusTimer = null; }
      status.show('');
    }
  };

  // ── K3d: iframe key-forwarding util ─────────────────────────────────────
  // Pages that render same-origin content in an <iframe> (e.g. reports-hub
  // #report-frame) must call this so parent keybindings survive focus inside
  // the frame. Without it, clicking into the iframe moves focus into the
  // iframe document → the parent receives NO keydowns → every FB binding
  // appears dead. The util attaches a keydown listener inside the iframe
  // document: if the iframe event target is editable (input/textarea/select/
  // contentEditable) it lets the field handle it; otherwise it re-dispatches
  // an equivalent KeyboardEvent on the PARENT document and preventDefaults in
  // the iframe. Guards against double-attach on reloads via a marker property.
  function forwardIframeKeys(iframe) {
    if (!iframe) return;
    var doc;
    try { doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document); }
    catch (e) { return; }       // cross-origin — cannot touch
    if (!doc) return;
    if (doc._fbKeysForwarded) return; // already attached (reload guard)
    doc._fbKeysForwarded = true;
    doc.addEventListener('keydown', function (e) {
      var t = e.target || {};
      var editable = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
        || t.tagName === 'SELECT' || !!t.isContentEditable;
      if (editable) return;     // let the field handle it natively
      // Re-dispatch on the PARENT document so the FB.keys capture-phase
      // dispatcher receives an equivalent keydown.
      var synth = new KeyboardEvent('keydown', {
        key: e.key, code: e.code, bubbles: true, cancelable: true
      });
      document.dispatchEvent(synth);
      e.preventDefault();
    });
  }

  // K3c: capture the core baseline — every key set registered so far belongs
  // to the chrome (none, at this point — pages haven't run yet). resetPage()
  // removes everything registered AFTER this snapshot. Captured here (end of
  // the core IIFE) rather than at var-declaration so any future chrome-level
  // registrations are covered.
  _baselineOrder = _order.slice();

  // ── Global Period Selector (global-period-selector-chrome-spec §3) ─────────
  // One shared Period-or-Custom control in the top bar. Dimmed (not hidden,
  // not disabled) on pages where the date dimension doesn't apply
  // (dateRelevance='none'). _resolve is the pure resolution engine hoisted from
  // reports-hub.js — no DOM reads/writes, no localStorage; returns a data
  // object the caller applies via set(). localStorage is NEVER used for initial
  // auto-selection (hard-won lesson from reports-hub.js v7 — stale 2025
  // periods). It is written only on manual pick / Custom date commit, and read
  // for in-session continuity (a manual pick on one page carries to the next
  // date-relevant page in the same session), validated against the current
  // periods list so a deleted period cannot resurface.
  var _pState = { mode: 'period', periodId: null, start: '', end: '' };
  var _pRelevance = 'range';        // 'range' | 'asOf' | 'none'
  var _pListeners = [];
  // True once period.set() has resolved a real value at least once (via
  // period._init() on a full page load). Soft-nav (fbNavigate) re-runs the
  // arriving page's script — which re-registers an onChange listener — but
  // never re-runs period._init() (that's gated to DOMContentLoaded), so the
  // one period.set() that would have fired it already happened before the
  // listener existed. onChange uses this flag to replay the current state
  // to late subscribers instead of leaving them waiting for an event that
  // will never come (bills tab stuck on "Loading…" after a company-switch
  // round trip or any other soft-nav arrival — Magnus 2026-09-03).
  var _pInitialized = false;
  var _pPeriods = [];               // fetched defined periods (desc by start_date)
  var _pPopoverOpen = false;
  var _pStateBeforeOpen = null;      // snapshot for Escape-to-abort
  var _pHighlightIdx = -1;           // keyboard/mouse row highlight — index into
                                      // _pPeriods, or _pPeriods.length for "Custom"

  function _pTrigger() { return document.getElementById('tb-period-trigger'); }
  function _pPopover() { return document.getElementById('tb-period-popover'); }

  // No placeholder text ("Period") when there's nothing resolved yet \u2014 most
  // visibly, no periods configured at all leaves _pState permanently blank
  // (period._init's fetch chain has nothing to resolve to), and a trigger
  // reading "Period" forever reads as a stuck/broken control rather than an
  // empty one (Magnus, 2026-09-03). Blank instead.
  function _pLabel() {
    if (!_pState.start && !_pState.end) return '';
    if (_pState.mode === 'period') {
      for (var i = 0; i < _pPeriods.length; i++) {
        if (_pPeriods[i].period_id === _pState.periodId) {
          return _pPeriods[i].period_name || (_pState.start + ' \u2013 ' + _pState.end);
        }
      }
    }
    if (_pState.start && _pState.end) return _pState.start + ' \u2013 ' + _pState.end;
    if (_pState.end) return 'as of ' + _pState.end;
    return '';
  }

  function _pRenderTrigger() {
    var el = _pTrigger();
    if (el) el.textContent = _pLabel();
  }

  function _pPersist() {
    try {
      localStorage.setItem('fb-period-mode', _pState.mode);
      localStorage.setItem('fb-period-id', _pState.periodId || '');
      localStorage.setItem('fb-period-start', _pState.start || '');
      localStorage.setItem('fb-period-end', _pState.end || '');
    } catch (e) { /* private mode */ }
  }

  function _pReadLs(periods) {
    // Read localStorage for in-session continuity. Validated: period mode
    // requires the periodId to still exist in the current periods list (a
    // deleted/stale period is discarded — prevents the stale-2025 bug).
    // Returns a state object or null (nothing stored / stale).
    try {
      var mode = localStorage.getItem('fb-period-mode') || '';
      var pid = localStorage.getItem('fb-period-id') || '';
      var s = localStorage.getItem('fb-period-start') || '';
      var e = localStorage.getItem('fb-period-end') || '';
      if (!s && !e) return null;
      if (mode === 'period' && pid) {
        for (var i = 0; i < periods.length; i++) {
          if (periods[i].period_id === pid) {
            return { mode: 'period', periodId: pid, start: s, end: e };
          }
        }
        return null; // period no longer exists — stale, discard
      }
      if (s && e) return { mode: 'custom', periodId: null, start: s, end: e };
      if (e) return { mode: 'custom', periodId: null, start: '', end: e };
      return null;
    } catch (e) { return null; }
  }

  function _pFire() {
    for (var i = 0; i < _pListeners.length; i++) {
      try { _pListeners[i](_pState); } catch (e) { /* listener must not break */ }
    }
    try { document.dispatchEvent(new CustomEvent('fb:period-change', { detail: _pState })); }
    catch (e) { /* CustomEvent may be unavailable in old engines */ }
  }

  function _pApplyDim() {
    var el = _pTrigger();
    if (el) el.classList.toggle('tb-period-dimmed', _pRelevance === 'none');
  }

  // Rows: defined periods (desc by start_date, per §3.4) first, "Custom" last
  // (§3.2's own diagram always specified Custom last -- the prior <select>-
  // based rendering put it first; this build corrects that drift).
  function _pBuildPopover() {
    var pop = _pPopover();
    if (!pop) return;
    var rows = '';
    for (var i = 0; i < _pPeriods.length; i++) {
      var p = _pPeriods[i];
      var s = String(p.start_date).slice(0, 10);
      rows += '<div class="tb-period-row" onmouseover="FB.period._rowHover(' + i + ')" onclick="FB.period._rowPick(' + i + ',event)">'
        + esc(p.period_name || s) + '</div>';
    }
    rows += '<div class="tb-period-row" onmouseover="FB.period._rowHover(' + _pPeriods.length + ')" onclick="FB.period._rowPick(' + _pPeriods.length + ',event)">Custom</div>';
    var html = '<div class="tb-period-list">' + rows + '</div>';
    // Start/End (or As-of) only render once Custom is the ACTIVE mode -- not
    // unconditionally under the list -- so picking a defined period never
    // shows date fields, and Custom's own row is reachable by keyboard/mouse
    // without the date inputs sitting in between it and the rest of the list
    // (2026-09-03: the always-visible dates blocked reaching rows below them
    // and broke the "Custom is a second step" model this control should have).
    if (_pState.mode !== 'custom') {
      pop.innerHTML = html;
      _pInitHighlight();
      _pSyncPopover();
      return;
    }
    if (_pRelevance !== 'asOf') {
      html += '<div class="tb-period-custom">'
        + '<label>Start</label> <input type="date" id="tb-period-start" onchange="FB.period._onCustomDate()">'
        + '<span class="tb-period-dash">\u2013</span>'
        + '<label>End</label> <input type="date" id="tb-period-end" onchange="FB.period._onCustomDate()">'
        + '</div>';
    } else {
      html += '<div class="tb-period-custom">'
        + '<label>As of</label> <input type="date" id="tb-period-end" onchange="FB.period._onCustomDate()">'
        + '</div>';
    }
    pop.innerHTML = html;
    _pInitHighlight();
    _pSyncPopover();
  }

  function _pRows() {
    var pop = _pPopover();
    return pop ? Array.prototype.slice.call(pop.querySelectorAll('.tb-period-row')) : [];
  }

  // Highlight starts on the row matching the currently active state (the
  // "Custom" row when mode is custom) -- not always row 0 -- so keyboard nav
  // and p/n quickset (which acts on the ACTIVE period, never the highlight)
  // start from a highlight that agrees with what's actually applied.
  function _pInitHighlight() {
    var idx = _pPeriods.length;
    if (_pState.mode === 'period') {
      for (var i = 0; i < _pPeriods.length; i++) {
        if (_pPeriods[i].period_id === _pState.periodId) { idx = i; break; }
      }
    }
    _pHighlightIdx = idx;
  }

  function _pSetHighlight(i) {
    var rows = _pRows();
    if (!rows.length) { _pHighlightIdx = -1; return; }
    if (i < 0) i = 0;
    if (i > rows.length - 1) i = rows.length - 1; // sticky at both ends
    for (var k = 0; k < rows.length; k++) rows[k].classList.toggle('tb-period-row-active', k === i);
    _pHighlightIdx = i;
    if (rows[i].scrollIntoView) rows[i].scrollIntoView({ block: 'nearest' });
  }

  function _pMoveHighlight(dir) { _pSetHighlight(_pHighlightIdx + dir); }

  // Row pick (mouse click AND keyboard Enter route through this). Picking a
  // defined period applies + closes immediately (§3.2 "close on select").
  // Picking Custom switches mode and keeps the popover open for date entry --
  // it has never auto-closed, even when reached by keyboard (§3.2).
  function _pRowPick(i) {
    var rows = _pRows();
    if (i < 0 || i >= rows.length) return;
    if (i === _pPeriods.length) {
      _pState.mode = 'custom';
      _pState.periodId = null;
      _pPersist();
      _pRenderTrigger();
      _pFire();
      _pBuildPopover(); // reveal the Start/End inputs now that mode is custom
      var se = document.getElementById('tb-period-start');
      if (se) se.focus();
      return;
    }
    var p = _pPeriods[i];
    _pState = { mode: 'period', periodId: p.period_id, start: String(p.start_date).slice(0, 10), end: String(p.end_date).slice(0, 10) };
    _pPersist();
    _pRenderTrigger();
    _pFire();
    _pClosePopover();
  }

  // Calendar-unit detection for Custom-range quickset (p/n while mode is
  // 'custom'): only an EXACT year/month/week(Mon-Sun)/day range shifts by
  // that unit. An arbitrary range (deliberate scope cut, 2026-09-03) is a
  // no-op rather than falling back to a same-length day-shift -- a silent,
  // unexplained shift on a range the user typed by hand would be more
  // surprising than nothing happening.
  function _customUnit(s, e) {
    if (!s || !e) return null;
    var sd = new Date(s + 'T00:00:00Z'), ed = new Date(e + 'T00:00:00Z');
    if (isNaN(sd.getTime()) || isNaN(ed.getTime())) return null;
    if (s === e) return 'day';
    if (sd.getUTCMonth() === 0 && sd.getUTCDate() === 1
        && ed.getUTCMonth() === 11 && ed.getUTCDate() === 31
        && sd.getUTCFullYear() === ed.getUTCFullYear()) return 'year';
    var lastDay = new Date(Date.UTC(sd.getUTCFullYear(), sd.getUTCMonth() + 1, 0)).getUTCDate();
    if (sd.getUTCDate() === 1 && ed.getUTCDate() === lastDay
        && sd.getUTCFullYear() === ed.getUTCFullYear() && sd.getUTCMonth() === ed.getUTCMonth()) return 'month';
    var diffDays = Math.round((ed.getTime() - sd.getTime()) / 86400000);
    if (diffDays === 6 && sd.getUTCDay() === 1) return 'week'; // Monday-start
    return null;
  }

  // dir: -1 = previous (p), +1 = next (n).
  function _shiftCustom(dir) {
    var unit = _customUnit(_pState.start, _pState.end);
    if (!unit) return; // arbitrary range -- no-op, popover stays open
    var sd = new Date(_pState.start + 'T00:00:00Z');
    var ns, ne;
    var fmt = function (d) { return d.toISOString().slice(0, 10); };
    if (unit === 'year') {
      ns = new Date(Date.UTC(sd.getUTCFullYear() + dir, 0, 1));
      ne = new Date(Date.UTC(sd.getUTCFullYear() + dir, 11, 31));
    } else if (unit === 'month') {
      ns = new Date(Date.UTC(sd.getUTCFullYear(), sd.getUTCMonth() + dir, 1));
      ne = new Date(Date.UTC(ns.getUTCFullYear(), ns.getUTCMonth() + 1, 0));
    } else if (unit === 'week') {
      ns = new Date(sd.getTime() + dir * 7 * 86400000);
      ne = new Date(ns.getTime() + 6 * 86400000);
    } else { // day
      ns = new Date(sd.getTime() + dir * 86400000);
      ne = ns;
    }
    _pState = { mode: 'custom', periodId: null, start: fmt(ns), end: fmt(ne) };
    _pPersist();
    _pRenderTrigger();
    _pFire();
    _pClosePopover();
  }

  // p/n quickset: acts on whichever period/range is currently ACTIVE, never
  // the popover highlight. dir: -1 = previous (p), +1 = next (n).
  function _pQuickset(dir) {
    if (_pState.mode === 'period') {
      var idx = -1;
      for (var i = 0; i < _pPeriods.length; i++) {
        if (_pPeriods[i].period_id === _pState.periodId) { idx = i; break; }
      }
      if (idx === -1) return;
      var newIdx = idx - dir; // _pPeriods is sorted DESC -- lower index = more recent
      if (newIdx < 0 || newIdx > _pPeriods.length - 1) return; // no earlier/later period -- no-op
      _pRowPick(newIdx);
    } else if (_pState.mode === 'custom') {
      _shiftCustom(dir);
    }
  }

  function _pSyncPopover() {
    var se = document.getElementById('tb-period-start');
    var ee = document.getElementById('tb-period-end');
    if (se) se.value = _pState.start || '';
    if (ee) ee.value = _pState.end || '';
    _pSetHighlight(_pHighlightIdx);
  }

  function _pClosePopover() {
    _pPopoverOpen = false;
    var pop = _pPopover();
    if (pop) { pop.hidden = true; pop.style.display = 'none'; }
  }

  var period = {
    // → { mode, periodId, start, end } — current resolved state
    get: function () {
      return { mode: _pState.mode, periodId: _pState.periodId, start: _pState.start, end: _pState.end };
    },
    // Programmatic set (drill-through, URL restoration). Does NOT persist to
    // localStorage — only manual picks persist (§3.3).
    set: function (state) {
      if (!state) return;
      _pState = {
        mode: state.mode === 'custom' ? 'custom' : 'period',
        periodId: state.periodId || null,
        start: state.start || '',
        end: state.end || ''
      };
      _pRenderTrigger();
      _pInitialized = true;
      _pFire();
    },
    // 'range' | 'asOf' | 'none' — per-tab/per-report override (§4.2).
    // 'none' → dimmed (opacity, NOT pointer-events:none, NOT disabled).
    setRelevance: function (level) {
      _pRelevance = level === 'asOf' ? 'asOf' : (level === 'none' ? 'none' : 'range');
      _pApplyDim();
      if (_pPopoverOpen) _pBuildPopover();
    },
    getRelevance: function () { return _pRelevance; },
    // Subscribe to period changes. Also fires as 'fb:period-change' on document.
    // A late subscriber (page arriving via soft-nav, after the one real
    // period.set() already fired) gets the current state replayed immediately
    // instead of waiting forever for a set() that won't happen again.
    onChange: function (cb) {
      _pListeners.push(cb);
      if (_pInitialized) {
        try { cb(_pState); } catch (e) { /* listener must not break */ }
      }
    },
    // Open unconditionally (bare `p` in NORMAL mode, §8) — never toggles
    // closed; only Escape/Enter/a row pick/outside-click close it.
    open: function () {
      if (_pPopoverOpen) return;
      var pop = _pPopover();
      if (!pop) return;
      _pStateBeforeOpen = { mode: _pState.mode, periodId: _pState.periodId, start: _pState.start, end: _pState.end };
      _pBuildPopover();
      pop.hidden = false;
      pop.style.display = '';
      _pPopoverOpen = true;
    },
    isOpen: function () { return _pPopoverOpen; },
    // Open/close the period selector popover (trigger onclick — click toggles;
    // the `p` key always opens, see open() above).
    togglePopover: function (event) {
      if (event) event.stopPropagation();
      if (_pPopoverOpen) { _pClosePopover(); return; }
      period.open();
    },
    // Mouse hover over a row — keyboard highlight mirrors :hover (§8).
    _rowHover: function (i) { _pSetHighlight(i); },
    // Mouse click on a row — same pick path as keyboard Enter (§8).
    // stopPropagation is required, not cosmetic: picking Custom rebuilds the
    // popover's innerHTML (to reveal the date inputs) while this click is
    // still bubbling — that detaches the clicked row from the DOM, and the
    // document-level outside-click listener (which checks `pop.contains
    // (e.target)`) would otherwise see a detached target, conclude the click
    // was outside, and close the popover it was just told to keep open.
    _rowPick: function (i, event) { if (event) event.stopPropagation(); _pRowPick(i); },
    // Keyboard dispatch while the popover is open (_dispatch in fb-core.js,
    // mirrors the company switcher's `key()` contract, §8). Unrecognized
    // keys are a no-op — the popover swallows them regardless (see call site).
    key: function (k) {
      if (k === 'Escape') {
        if (_pStateBeforeOpen) period.set(_pStateBeforeOpen);
        _pClosePopover();
        return;
      }
      if (k === 'Enter') {
        if (_pHighlightIdx === _pPeriods.length && _pState.mode === 'custom') {
          // Already in custom mode with the Custom row highlighted (dates
          // may have just been edited) — commit and close, same as clicking
          // outside. _pRowPick's Custom branch is for the FIRST switch into
          // custom (reveals the inputs, stays open) — not this case.
          period._onCustomDate();
          _pClosePopover();
        } else if (_pHighlightIdx >= 0 && _pHighlightIdx <= _pPeriods.length) {
          _pRowPick(_pHighlightIdx);
        } else {
          _pClosePopover();
        }
        return;
      }
      if (k === 'j' || k === 'ArrowDown') { _pMoveHighlight(1); return; }
      if (k === 'k' || k === 'ArrowUp') { _pMoveHighlight(-1); return; }
      if (k === 'p') { _pQuickset(-1); return; }
      if (k === 'n') { _pQuickset(1); return; }
    },
    // Custom Start/End commit on change (blur or Enter). Popover stays open (§3.2).
    _onCustomDate: function () {
      var se = document.getElementById('tb-period-start');
      var ee = document.getElementById('tb-period-end');
      var s = se ? se.value : '';
      var e = ee ? ee.value : '';
      _pState = { mode: 'custom', periodId: null, start: s, end: e };
      _pPersist();
      _pRenderTrigger();
      _pFire();
    },
    // PURE resolution engine (§3.5). No DOM, no localStorage. Returns a state
    // object if URL params matched, or null if no URL params to resolve from.
    // Caller (init) then handles localStorage → default-period → periods[0].
    _resolve: function (urlParams, periods) {
      function fmtD(d) {
        if (!d) return '';
        var str = String(d);
        if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
        var dt = new Date(d);
        return isNaN(dt) ? str.slice(0, 10) : dt.toISOString().slice(0, 10);
      }
      var periodParam = urlParams.get('period') || '';
      var startParam = urlParams.get('start') || '';
      var endParam = urlParams.get('end') || '';
      var dateFromParam = urlParams.get('dateFrom') || '';
      var dateToParam = urlParams.get('dateTo') || '';

      // 1. ?period= matching (exact name, substring, q1-q4, h1/h2, ytd)
      if (periodParam && periods.length) {
        var tok = periodParam.trim().toLowerCase();
        for (var i = 0; i < periods.length; i++) {
          if ((periods[i].period_name || '').toLowerCase() === tok) {
            return { mode: 'period', periodId: periods[i].period_id, start: fmtD(periods[i].start_date), end: fmtD(periods[i].end_date) };
          }
        }
        for (var i2 = 0; i2 < periods.length; i2++) {
          if ((periods[i2].period_name || '').toLowerCase().indexOf(tok) !== -1) {
            return { mode: 'period', periodId: periods[i2].period_id, start: fmtD(periods[i2].start_date), end: fmtD(periods[i2].end_date) };
          }
        }
        if (/^q[1-4]$/.test(tok)) {
          for (var i3 = 0; i3 < periods.length; i3++) {
            var pn = (periods[i3].period_name || '').toLowerCase();
            if (pn.indexOf(tok) !== -1) {
              return { mode: 'period', periodId: periods[i3].period_id, start: fmtD(periods[i3].start_date), end: fmtD(periods[i3].end_date) };
            }
          }
          var qn = parseInt(tok.slice(1), 10);
          var qStart = [0, 3, 6, 9][qn - 1];
          var qEnd = qStart + 2;
          var year = String(periods[0].start_date).slice(0, 4);
          for (var i4 = 0; i4 < periods.length; i4++) {
            var ps4 = String(periods[i4].start_date).slice(0, 10);
            var pe4 = String(periods[i4].end_date).slice(0, 10);
            var psm4 = parseInt(ps4.slice(5, 7), 10);
            var pem4 = parseInt(pe4.slice(5, 7), 10);
            if (ps4.slice(0, 4) === year && psm4 >= qStart + 1 && pem4 <= qEnd + 1) {
              return { mode: 'period', periodId: periods[i4].period_id, start: fmtD(ps4), end: fmtD(pe4) };
            }
          }
        }
        if (/^h[12]$/.test(tok)) {
          var half = parseInt(tok.slice(1), 10);
          var yearH = String(periods[0].start_date).slice(0, 4);
          for (var i5 = 0; i5 < periods.length; i5++) {
            var hs5 = String(periods[i5].start_date).slice(0, 10);
            var he5 = String(periods[i5].end_date).slice(0, 10);
            var hsm5 = parseInt(hs5.slice(5, 7), 10);
            var hem5 = parseInt(he5.slice(5, 7), 10);
            if (hs5.slice(0, 4) === yearH && half === 1 && hsm5 >= 1 && hem5 <= 6) {
              return { mode: 'period', periodId: periods[i5].period_id, start: fmtD(hs5), end: fmtD(he5) };
            }
            if (hs5.slice(0, 4) === yearH && half === 2 && hsm5 >= 7 && hem5 <= 12) {
              return { mode: 'period', periodId: periods[i5].period_id, start: fmtD(hs5), end: fmtD(he5) };
            }
          }
        }
        if (tok === 'ytd') {
          var earliest = periods[0], latest = periods[0];
          for (var i6 = 0; i6 < periods.length; i6++) {
            if (String(periods[i6].start_date) < String(earliest.start_date)) earliest = periods[i6];
            if (String(periods[i6].end_date) > String(latest.end_date)) latest = periods[i6];
          }
          return { mode: 'custom', periodId: null, start: fmtD(earliest.start_date), end: fmtD(latest.end_date) };
        }
      }

      // 2. ?start=/?end= drill-through restoration (with period-matching fallback)
      if (startParam && endParam) {
        for (var i7 = 0; i7 < periods.length; i7++) {
          var ss7 = fmtD(periods[i7].start_date), se7 = fmtD(periods[i7].end_date);
          if (ss7 === startParam && se7 === endParam) {
            return { mode: 'period', periodId: periods[i7].period_id, start: ss7, end: se7 };
          }
        }
        return { mode: 'custom', periodId: null, start: startParam, end: endParam };
      }
      if (endParam) {  // end-only (asOf reports)
        return { mode: 'custom', periodId: null, start: '', end: endParam };
      }

      // 3. ?dateFrom=/?dateTo= (bills/exchange-rates return-context seam)
      if (dateFromParam && dateToParam) {
        for (var i8 = 0; i8 < periods.length; i8++) {
          var ds8 = fmtD(periods[i8].start_date), de8 = fmtD(periods[i8].end_date);
          if (ds8 === dateFromParam && de8 === dateToParam) {
            return { mode: 'period', periodId: periods[i8].period_id, start: ds8, end: de8 };
          }
        }
        return { mode: 'custom', periodId: null, start: dateFromParam, end: dateToParam };
      }

      return null; // no URL params to resolve from
    },
    // Auto-init: fetch periods, resolve (URL → localStorage → default-period →
    // periods[0]), set, apply page-level relevance from the route registry.
    _init: function (company, activeKey) {
      var urlParams = new URLSearchParams(window.location.search);

      // Apply page-level dateRelevance from the route registry (§3.6).
      if (window.FB_ROUTES) {
        for (var i = 0; i < window.FB_ROUTES.length; i++) {
          if (window.FB_ROUTES[i].key === activeKey) {
            if (window.FB_ROUTES[i].dateRelevance) period.setRelevance(window.FB_ROUTES[i].dateRelevance);
            break;
          }
        }
      }

      fetch('/api/' + company + '/periods')
        .then(function (r) { return r.json(); })
        .then(function (raw) {
          var periods = (Array.isArray(raw) ? raw : (raw.data || [])).slice().sort(function (a, b) {
            return String(b.start_date) > String(a.start_date) ? 1 : -1;
          });
          _pPeriods = periods;

          // Step 1: URL params (explicit navigation intent — always wins)
          var resolved = period._resolve(urlParams, periods);
          if (resolved) { period.set(resolved); return; }

          // Step 2: localStorage (in-session continuity, validated against
          // current periods list — stale periods are discarded)
          var lsState = _pReadLs(periods);
          if (lsState) { period.set(lsState); return; }

          // Step 3: latest posted-transaction period
          if (periods.length) {
            fetch('/api/' + company + '/reports/default-period')
              .then(function (r) { return r.json(); })
              .then(function (res) {
                if (res && res.period_id) {
                  for (var pi = 0; pi < periods.length; pi++) {
                    if (periods[pi].period_id === res.period_id) {
                      period.set({ mode: 'period', periodId: periods[pi].period_id,
                        start: String(periods[pi].start_date).slice(0, 10),
                        end: String(periods[pi].end_date).slice(0, 10) });
                      return;
                    }
                  }
                }
                // Step 4: fallback — latest defined period (periods[0])
                var p0 = periods[0];
                period.set({ mode: 'period', periodId: p0.period_id,
                  start: String(p0.start_date).slice(0, 10),
                  end: String(p0.end_date).slice(0, 10) });
              })
              .catch(function () {
                var p0c = periods[0];
                period.set({ mode: 'period', periodId: p0c.period_id,
                  start: String(p0c.start_date).slice(0, 10),
                  end: String(p0c.end_date).slice(0, 10) });
              });
          }
        })
        .catch(function () {
          // periods fetch failed — try localStorage, else leave empty
          var lsState = _pReadLs([]);
          if (lsState) period.set(lsState);
        });
    }
  };

  // Close period popover on outside click (like the notif dropdown).
  document.addEventListener('click', function (e) {
    if (!_pPopoverOpen) return;
    var pop = _pPopover();
    var trg = _pTrigger();
    if (pop && pop.contains(e.target)) return;
    if (trg && trg.contains(e.target)) return;
    _pClosePopover();
  });

  // Full keyboard contract while the popover is open (j/k/arrows navigate,
  // Enter picks, Escape aborts, p/n quickset) is wired through _dispatch —
  // see the `period.isOpen()` block near the top of this file, alongside the
  // company switcher's equivalent. Kept here previously as a standalone
  // Enter/Escape-only listener; folded in 2026-09-03 so one mechanism owns
  // the popover's keys instead of two.

  // Auto-init on DOMContentLoaded: resolve company + active route from the
  // app-shell and the current URL path.
  document.addEventListener('DOMContentLoaded', function () {
    var shell = document.getElementById('app-shell');
    var company = shell && shell.dataset ? shell.dataset.company : null;
    if (!company) return;
    // Resolve active route key from the current path against FB_ROUTES.
    var activeKey = '';
    var path = window.location.pathname;
    if (window.FB_ROUTES) {
      for (var i = 0; i < window.FB_ROUTES.length; i++) {
        var r = window.FB_ROUTES[i];
        if (!r.route) continue;
        // Match :company-prefixed routes (e.g. /:company/payables → /acme/payables)
        var pattern = r.route.replace('/:company', '/[^/]+');
        if (r.absolute) {
          if (path === r.route) { activeKey = r.key; break; }
        } else if (new RegExp('^' + pattern + '/?$').test(path)) {
          activeKey = r.key; break;
        }
      }
    }
    period._init(company, activeKey);
  });

  window.FB = {
    util: { esc: esc, escAttr: esc, fmtDate: fmtDate, today: today, forwardIframeKeys: forwardIframeKeys },
    mode: mode,
    keys: keys,
    coverage: coverage,
    nav: nav,
    dropdown: dropdown,
    search: search,
    modal: modal,
    status: status,
    switcher: switcher,
    period: period
  };

  // Legacy global so template-string pages can drop their local esc copies.
  window.esc = esc;

  // ── A5 §10.4: Inbox queue badge ───────────────────────────────────────────
  // The sidebar Inbox item carries the pending Class A count — the monitoring
  // surface: the human sees there is work without opening anything. Refreshed
  // on every page boot (soft-nav re-renders the page) and on the
  // 'fb:queue-changed' window event (the Inbox page fires it after
  // approve/reject). R6: the badge is read-only state; all eligibility
  // decisions stay server-side. (Moved from the Journal sidebar item per
  // spec §10, 2026-08-03 — the Journal list is the pure posted register.)
  // topbar-chrome-spec §4: retargeted from #sb-inbox-badge (dead sidebar element)
  // to the bell. Combines inbox count + notif count on one visible badge number.
  var _inboxCount = 0;
  var _notifCount = 0;
  function _updateBellBadge() {
    var badge = document.getElementById('tb-notif-badge');
    if (!badge) return;
    var total = _inboxCount + _notifCount;
    badge.textContent = total > 99 ? '99+' : String(total);
    badge.hidden = total === 0;
  }
  function _refreshInboxBadge() {
    var shell = document.getElementById('app-shell');
    var company = shell && shell.dataset ? shell.dataset.company : null;
    if (!company) return;
    fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'inbox.list', companyId: company, status: 'proposed', limit: 100 }) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        _inboxCount = (res && res.ok && res.data && Array.isArray(res.data.items)) ? res.data.items.length : 0;
        _updateBellBadge();
      })
      .catch(function () { _inboxCount = 0; _updateBellBadge(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _refreshInboxBadge);
  else _refreshInboxBadge();
  window.addEventListener('fb:queue-changed', _refreshInboxBadge);

  // ── fx-automation-spec §7: Notifications bell badge + dropdown ──────────
  // The topbar bell shows unread count; click opens a dropdown list.
  // Clicking a row marks it read. Refreshed on page boot.
  function _refreshNotifBadge() {
    var badge = document.getElementById('tb-notif-badge');
    if (!badge) return;
    var shell = document.getElementById('app-shell');
    var company = shell && shell.dataset ? shell.dataset.company : null;
    if (!company) return;
    fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'notifications.list', companyId: company }) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        _notifCount = (res && res.ok && res.data && typeof res.data.unread_count === 'number') ? res.data.unread_count : 0;
        _updateBellBadge();
      })
      .catch(function () { _notifCount = 0; _updateBellBadge(); });
  }

  function _toggleNotifDropdown() {
    var dd = document.getElementById('tb-notif-dropdown');
    if (!dd) return;
    if (!dd.hidden) { dd.hidden = true; return; }
    dd.hidden = false;
    var shell = document.getElementById('app-shell');
    var company = shell && shell.dataset ? shell.dataset.company : null;
    if (!company) return;
    fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'notifications.list', companyId: company, all: false }) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        var items = (res && res.ok && res.data && res.data.notifications) || [];
        // topbar-chrome-spec §4: "Inbox — N pending" section above notifications
        var html = '';
        if (_inboxCount > 0) {
          html += '<div class="tb-notif-inbox" id="tb-notif-inbox-link">Inbox — ' + _inboxCount + ' pending</div>';
        }
        if (items.length === 0) {
          html += '<div class="tb-notif-empty">No unread notifications.</div>';
          dd.innerHTML = html;
        } else {
          html += '<h4>Notifications <a id="tb-notif-markall">Mark all read</a></h4>';
          items.forEach(function (n) {
            var ts = n.created_at ? String(n.created_at).slice(0, 16).replace('T', ' ') : '';
            html += '<div class="tb-notif-item" data-id="' + esc(n.id) + '"'
              + (n.link_url ? ' data-link="' + esc(n.link_url) + '"' : '') + '>'
              + '<div class="notif-kind">' + esc(n.kind || '') + '</div>'
              + '<div class="notif-msg">' + esc(n.message || '') + '</div>'
              + '<div class="notif-time">' + esc(ts) + '</div>'
              + '</div>';
          });
          dd.innerHTML = html;
          // Wire mark-all-read
          var markAll = document.getElementById('tb-notif-markall');
          if (markAll) markAll.onclick = function () {
            fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'notifications.mark_read', companyId: company, all: true }) })
              .then(function () { _refreshNotifBadge(); _toggleNotifDropdown(); });
          };
          // Wire per-item click → mark read, then navigate if the item carries
          // a link_url ("go look at this" alerts — bill-due, reconciliation).
          dd.querySelectorAll('.tb-notif-item').forEach(function (item) {
            item.onclick = function () {
              var id = item.dataset.id;
              var link = item.dataset.link;
              fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'notifications.mark_read', companyId: company, ids: [id] }) })
                .then(function () {
                  _refreshNotifBadge();
                  if (link) { dd.hidden = true; window.fbNavigate(link); }
                  else { item.style.opacity = '0.4'; }
                });
            };
          });
        }
        // Wire inbox link (§4) — present in both empty and non-empty cases
        var _il = document.getElementById('tb-notif-inbox-link');
        if (_il) _il.onclick = function () { dd.hidden = true; window.fbNavigate('/' + company + '/inbox'); };
      })
      .catch(function () { dd.innerHTML = '<div class="tb-notif-empty">Failed to load.</div>'; });
  }

  // Wire the bell button (deferred: fb-core.js loads in <head>, before the
  // topbar button exists in the DOM — see _wireDlButton/_wireNewMenu below).
  function _wireNotifButton() {
    var notifBtn = document.getElementById('tb-notif-btn');
    if (notifBtn) notifBtn.addEventListener('click', function (e) { e.preventDefault(); _toggleNotifDropdown(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _wireNotifButton);
  else _wireNotifButton();

  // ── chat-with-ai-spec.md §4: topbar chat icon + status dot ──────────────
  // Click navigates to the chat page. The dot is computed once per app-shell
  // load and re-checked every 5 minutes while the tab stays open — this is
  // a genuinely new polling pattern in the shell (nothing else here runs on
  // an interval; the spec flags this explicitly rather than implying it
  // hooks into something that already existed).
  function _refreshChatDot() {
    var dot = document.getElementById('tb-chat-dot');
    var company = document.getElementById('app-shell') && document.getElementById('app-shell').dataset.company;
    if (!dot || !company) return;
    Promise.all([
      fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'agent.status', companyId: company }) }).then(function (r) { return r.json(); }).catch(function () { return null; }),
      fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ai.test_connection', companyId: company }) }).then(function (r) { return r.json(); }).catch(function () { return null; })
    ]).then(function (results) {
      var agentRunning = !!(results[0] && results[0].data && results[0].data.running);
      var llmOk = !!(results[1] && results[1].data && results[1].data.ok);
      dot.hidden = false;
      dot.className = 'tb-chat-dot ' + (!agentRunning ? 'off' : (llmOk ? 'ok' : 'warn'));
    });
  }
  function _wireChatButton() {
    var chatBtn = document.getElementById('tb-chat-btn');
    if (chatBtn) chatBtn.addEventListener('click', function (e) {
      e.preventDefault();
      var company = document.getElementById('app-shell') && document.getElementById('app-shell').dataset.company;
      if (company && window.fbNavigate) window.fbNavigate('/' + company + '/chat');
    });
    _refreshChatDot();
    var chatDotTimer = setInterval(_refreshChatDot, 5 * 60 * 1000);
    if (chatDotTimer.unref) chatDotTimer.unref();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _wireChatButton);
  else _wireChatButton();
  // Close dropdown on outside click
  document.addEventListener('click', function (e) {
    var dd = document.getElementById('tb-notif-dropdown');
    if (!dd || dd.hidden) return;
    if (!dd.contains(e.target) && e.target.id !== 'tb-notif-btn' && !e.target.closest('#tb-notif-btn')) {
      dd.hidden = true;
    }
  });

  // ── ia-restructure-3-spec.md §6.3: unified topbar download icon ─────────
  // One icon, present on every page (defined here, not per-page). SIE is
  // company+period scoped — always offered when the company's jurisdiction
  // permits it, independent of which page/tab is active (checked once per
  // page load via a tiny dedicated endpoint, since navBar() is built
  // synchronously and isn't worth making async everywhere for this one
  // flag). CSV/PDF are per-page/tab scoped — a page sets/clears
  // window.__fbDownloadCsv / window.__fbDownloadPdfUrl whenever its active
  // tab changes; both are functions (not static values) so they always
  // reflect current state (period, filters) at click time, not load time.
  //   window.__fbDownloadCsv = function() → {filename, csv} | null
  //   window.__fbDownloadPdfUrl = function() → url string | null
  // A tab/page with neither set simply omits those two menu rows.
  var _sieEnabled = false;
  // Wired on DOMContentLoaded since fb-core.js loads in <head> (before body).
  function _initSieEnabled() {
    var shell = document.getElementById('app-shell');
    var company = shell && shell.dataset ? shell.dataset.company : null;
    if (!company) return;
    fetch('/api/' + company + '/sie-status')
      .then(function (r) { return r.json(); })
      .then(function (res) { _sieEnabled = !!(res && res.enabled); })
      .catch(function () { _sieEnabled = false; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _initSieEnabled);
  else _initSieEnabled();

  function _downloadBlob(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  function _dlExportSie() {
    var shell = document.getElementById('app-shell');
    var company = shell && shell.dataset ? shell.dataset.company : null;
    var st = (window.FB && FB.period) ? FB.period.get() : {};
    if (!company || !st.start || !st.end) { if (window.FB && FB.status) FB.status.show('Select a period first.', true); return; }
    var a = document.createElement('a');
    a.href = '/api/' + company + '/report?type=sie&start=' + encodeURIComponent(st.start) + '&end=' + encodeURIComponent(st.end);
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
  function _dlExportCsv() {
    if (typeof window.__fbDownloadCsv !== 'function') return;
    var r = window.__fbDownloadCsv();
    if (!r || !r.csv) { if (window.FB && FB.status) FB.status.show('Nothing to export yet.', true); return; }
    _downloadBlob(r.filename || 'export.csv', r.csv, 'text/csv');
  }
  function _dlExportPdf() {
    if (typeof window.__fbDownloadPdfUrl !== 'function') return;
    var url = window.__fbDownloadPdfUrl();
    if (!url) { if (window.FB && FB.status) FB.status.show('Nothing to print yet.', true); return; }
    window.open(url, '_blank');
  }

  function _toggleDlDropdown() {
    var dd = document.getElementById('tb-dl-dropdown');
    var btn = document.getElementById('tb-dl-btn');
    if (!dd) return;
    if (!dd.hidden) { dd.hidden = true; return; }
    var hasCsv = typeof window.__fbDownloadCsv === 'function';
    var hasPdf = typeof window.__fbDownloadPdfUrl === 'function';
    var rows = [];
    if (hasPdf) rows.push('<button class="tb-dl-item" id="tb-dl-pdf">🖨 Print / PDF</button>');
    if (hasCsv) rows.push('<button class="tb-dl-item" id="tb-dl-csv">⬇ CSV</button>');
    if (_sieEnabled) rows.push('<button class="tb-dl-item" id="tb-dl-sie" title="SIE 4 ledger export (Gredor/Bolagsverket)">⬇ SIE</button>');
    if (!rows.length) { if (btn) btn.title = 'Nothing to download here'; return; }
    dd.innerHTML = rows.join('');
    dd.hidden = false;
    var pdfBtn = document.getElementById('tb-dl-pdf'); if (pdfBtn) pdfBtn.onclick = function () { dd.hidden = true; _dlExportPdf(); };
    var csvBtn = document.getElementById('tb-dl-csv'); if (csvBtn) csvBtn.onclick = function () { dd.hidden = true; _dlExportCsv(); };
    var sieBtn = document.getElementById('tb-dl-sie'); if (sieBtn) sieBtn.onclick = function () { dd.hidden = true; _dlExportSie(); };
  }
  // Wired on DOMContentLoaded since fb-core.js loads in <head> (before body).
  function _wireDlButton() {
    var dlBtn = document.getElementById('tb-dl-btn');
    if (dlBtn) dlBtn.addEventListener('click', function (e) { e.preventDefault(); _toggleDlDropdown(); });
    document.addEventListener('click', function (e) {
      var dd = document.getElementById('tb-dl-dropdown');
      if (!dd || dd.hidden) return;
      if (!dd.contains(e.target) && e.target.id !== 'tb-dl-btn' && !e.target.closest('#tb-dl-btn')) dd.hidden = true;
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _wireDlButton);
  else _wireDlButton();

  // ── topbar-chrome-spec §5: `+` New menu — fixed operational-only list ────
  // Deliberately not catalog-driven: this is the short list of things
  // someone reaches for constantly (record a transaction), not every
  // create-capable route in the app — master-data/setup actions (new
  // account, new partner, etc.) live on their own pages, not here.
  // Wired on DOMContentLoaded since fb-core.js loads in <head> (before body).
  var NEW_MENU_ITEMS = [
    { label: 'Journal Entry', route: '/journal/voucher' },
    { label: 'Bill from Supplier', route: '/bill/edit' },
    { label: 'Invoice to Customer', disabled: true }, // AR not built yet
    { label: 'Payment', route: '/payment/new' }
  ];
  function _populateNewMenu() {
    var dd = document.getElementById('tb-new-dropdown');
    if (!dd) return;
    var html = '';
    NEW_MENU_ITEMS.forEach(function (item, i) {
      if (item.disabled) {
        html += '<div class="tb-new-item tb-new-item-disabled" title="Coming soon">' + esc(item.label) + '</div>';
      } else {
        html += '<div class="tb-new-item" data-i="' + i + '">' + esc(item.label) + '</div>';
      }
    });
    dd.innerHTML = html;
    dd.querySelectorAll('.tb-new-item[data-i]').forEach(function (el) {
      el.onclick = function () {
        var item = NEW_MENU_ITEMS[Number(el.dataset.i)];
        if (item && item.route && window.fbNavigate) window.fbNavigate('/' + _company() + item.route);
        dd.hidden = true;
      };
    });
  }
  function _wireNewMenu() {
    var newBtn = document.getElementById('tb-new-btn');
    if (!newBtn) return;
    newBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var dd = document.getElementById('tb-new-dropdown');
      if (!dd) return;
      if (!dd.hidden) { dd.hidden = true; return; }
      _populateNewMenu();
      dd.hidden = false;
    });
    // Close `+` menu on outside click
    document.addEventListener('click', function (e) {
      var dd = document.getElementById('tb-new-dropdown');
      if (!dd || dd.hidden) return;
      if (!dd.contains(e.target) && e.target.id !== 'tb-new-btn' && !e.target.closest('#tb-new-btn')) {
        dd.hidden = true;
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _wireNewMenu);
  else _wireNewMenu();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _refreshNotifBadge);
  else _refreshNotifBadge();
})();
