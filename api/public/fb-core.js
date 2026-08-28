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
  //   g c          toggle the company switcher (own key scope while open)
  //   g <other>    cancel — the key proceeds through normal dispatch untouched
  var _gPending = false, _gTimer = null;
  var _onGG = [];

  function _company() { return location.pathname.split('/')[1] || ''; }

  function _gResolve(key) {
    if (key === 'g') return { type: 'gg' };
    if (key === 'c') return { type: 'switcher' };
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

  // Company switcher (g c). Reuses fbToggleCompany's data path (common.js) —
  // no duplicated fetch/render. While open it owns every key (help-overlay
  // precedent): j/k highlight (sticky ends), Enter follows the anchor exactly
  // like the mouse, Esc closes, g c toggles closed.
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
      // g c toggles closed (mirror of the open sequence)
      if (k === 'g') {
        _sgPending = true; clearTimeout(_sgTimer);
        _sgTimer = setTimeout(function () { _sgPending = false; }, 500);
        return;
      }
      if (k === 'c' && _sgPending) { _sgPending = false; clearTimeout(_sgTimer); _close(); }
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
    // Help overlay open: swallow EVERY key — page bindings and common.js's
    // bubble handler stay inert until it closes (Esc / `?` / backdrop click).
    if (help.isOpen()) {
      e.stopImmediatePropagation();
      e.preventDefault();
      if (e.key === 'Escape' || e.key === '?') help.close();
      return;
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

    // #149: NAV rows for the ? overlay — reads window.FB_ROUTES (the same
    // registry _gResolve uses). Renders 'g r — Reports' style rows for every
    // entry with a gKey (sidebar routes with go-to-map letters). Entries
    // without a gKey are still reachable via the
    // sidebar; only g-key destinations belong in this section.
    function _navRows() {
      var R = window.FB_ROUTES || [];
      var rows = [];
      R.forEach(function (r) {
        if (!r.gKey) return;
        rows.push({ keys: 'g ' + r.gKey, hint: r.label });
      });
      if (!rows.length) return '';
      return _rows(rows);
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
        { keys: ':', hint: 'Command' },
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

  // ── FB.palette — `:` written commands (roadmap P1-10) ────────────────────
  // The topbar input hosts two modes: `/` search (per-page filtering,
  // unchanged) and `:` command. Mode is set by HOW you got there (keyboard
  // `:` → command; click → search — magnus decision 2), not by content.
  // Commands derive from two sources, no hand-written registry:
  //   page verbs — NORMAL-mode hinted bindings of the active FB.keys set,
  //                filtered: movement/chrome bindings opt out via
  //                paletteEligible: false; business verbs covered by an
  //                explicit `:` alias (scoped pageVerb+scope in ALIASES)
  //                are deduped — the alias is the sole : citizen.
  //   api        — catalog entries carrying a palette disposition (execute
  //                via POST /api/action + Idempotency-Key; navigate → form).
  // #149: NAV rows (registry routes, "Go to X") were dropped from : and
  // relocated to the ? help overlay's NAV section. ? is the keyboard
  // teacher now; : is for typed commands and API actions only.
  // Ranking = localStorage recency, then fuzzy exactness.
  var palette = (function () {
    var _input = null;
    var _command = false;      // mode: false = search, true = command
    var _el = null;            // dropdown element
    var _items = [];           // current matches
    var _activeIdx = -1;
    var _catalog = null;       // /api/actions manifest (fetched once)
    var _reports = null;      // /api/:company/reports/registry (fetched once)
    var _wired = false;

    // v7: grammar mode — prefix-based engagement, ghost text in input.
    // The moment the typed prefix unambiguously matches one alias, engage
    // that alias's grammar + itemSource. No space-gate.
    var _currentHint = null;     // current grammar hint text, or null
    var _engagedAlias = null;    // currently engaged alias name, or null
    var _billSlot = 0;           // :bill advance-on-selection slot index
    var _partners = null;        // partner list cache for :bill itemSource
    var _ghostEl = null;         // ghost text overlay element

    // Prefix-based grammar detection: if the first token (everything before
    // the first space, or the whole query if no space) is a unique prefix of
    // exactly one alias, engage that alias. If it matches multiple aliases,
    // don't engage — show the matching commands instead.
    function _detectGrammar(q) {
      var firstSpace = q.indexOf(' ');
      var firstTok = (firstSpace < 0 ? q : q.slice(0, firstSpace)).trim().toLowerCase();
      if (!firstTok) return null;
      if (firstTok === 'post!' || firstTok === 'pay!') firstTok = firstTok.slice(0, -1);
      if (window.FB && FB.command && FB.command.ALIASES && FB.command.ALIASES[firstTok]) {
        return { alias: firstTok, grammar: FB.command.grammarFor(firstTok), exact: true };
      }
      // Prefix match: how many aliases start with this token?
      var matches = [];
      if (window.FB && FB.command && FB.command.ALIASES) {
        Object.keys(FB.command.ALIASES).forEach(function (name) {
          if (FB.command.ALIASES[name].palette === false) return;
          if (name.indexOf(firstTok) === 0) matches.push(name);
        });
      }
      if (matches.length === 1) {
        var alias = matches[0];
        return { alias: alias, grammar: FB.command.grammarFor(alias), exact: false, typedLen: firstTok.length };
      }
      return null; // 0 or 2+ matches → no engagement, show command list
    }

    // v7: hint renders as ghost text in the input, not as a dropdown header.
    function _renderHint(grammar) {
      _currentHint = grammar;
      _updateGhost();
    }

    // Ghost text overlay: show the remaining hint after what's typed.
    // Creates a transparent overlay positioned over the input showing the
    // typed text as invisible spacing + the remaining hint in grey.
    function _ensureGhost() {
      if (_ghostEl) return;
      _ghostEl = document.createElement('div');
      _ghostEl.className = 'fb-ghost-hint';
      // Position relative to the input, not the wrapper — we need to match
      // the input's exact position so the ghost text starts at the cursor.
      var inputStyle = window.getComputedStyle(_input);
      _ghostEl.style.font = inputStyle.font;
      _ghostEl.style.padding = inputStyle.padding;
      _ghostEl.style.border = inputStyle.border;
      _ghostEl.style.letterSpacing = inputStyle.letterSpacing;
      // Position the ghost at the input's exact location
      var rect = _input.getBoundingClientRect();
      var wrap = _input.closest('.tb-search-wrap') || _input.parentElement;
      if (wrap) {
        var wrapRect = wrap.getBoundingClientRect();
        _ghostEl.style.top = (rect.top - wrapRect.top) + 'px';
        _ghostEl.style.left = (rect.left - wrapRect.left) + 'px';
        _ghostEl.style.width = rect.width + 'px';
        _ghostEl.style.height = rect.height + 'px';
      }
      if (wrap) wrap.appendChild(_ghostEl);
    }
    function _removeGhost() {
      if (_ghostEl) { _ghostEl.remove(); _ghostEl = null; }
    }
    // ── Grammar-segment parser (for dynamic ghost text progression) ───────────
    // Parses a grammar hint string (e.g. '<amount> <account> [from <account>]
    // [due <date>] [!]') into ordered segment objects that can be consumed
    // against the user's typed tokens.  Segment types:
    //   placeholder  — <amount>, consumes 1 user token (any value)
    //   keyword      — bare word (from/due/on/...), consumed only on exact match
    //   optional     — [from <account>], sub-segments entered on keyword match
    //   alternatives — [vat <amt>|net <amt>|rc] or top-level a | b
    //   bang         — [!], consumed if user typed '!'

    // Split a grammar string by top-level '|' (depth-0, outside [] and <>).
    function _splitTopLevelAlts(s) {
      var result = [], depth = 0, start = 0;
      for (var k = 0; k < s.length; k++) {
        if (s[k] === '[' || s[k] === '<') depth++;
        else if (s[k] === ']' || s[k] === '>') depth--;
        else if (s[k] === '|' && depth === 0) {
          result.push(s.slice(start, k).trim());
          start = k + 1;
        }
      }
      result.push(s.slice(start).trim());
      return result;
    }

    function _parseGrammarSegments(grammar) {
      var s = grammar.trim();
      // Top-level alternatives (e.g. :token 'create <name> | revoke <name>')
      var alts = _splitTopLevelAlts(s);
      if (alts.length > 1) {
        return [{
          type: 'alternatives',
          options: alts.map(function (a) {
            return { subSegments: _parseGrammarSegments(a), raw: a };
          }),
          raw: s
        }];
      }
      var segments = [];
      var i = 0;
      while (i < s.length) {
        while (i < s.length && s[i] === ' ') i++;
        if (i >= s.length) break;
        if (s[i] === '<') {
          var end = s.indexOf('>', i);
          if (end === -1) end = s.length - 1;
          segments.push({ type: 'placeholder', raw: s.slice(i, end + 1) });
          i = end + 1;
        } else if (s[i] === '[') {
          var endB = s.indexOf(']', i);
          if (endB === -1) endB = s.length - 1;
          var inner = s.slice(i + 1, endB).trim();
          var rawG = s.slice(i, endB + 1);
          var innerAlts = inner.split('|');
          if (innerAlts.length > 1) {
            segments.push({
              type: 'alternatives',
              options: innerAlts.map(function (a) {
                return { subSegments: _parseGrammarSegments(a.trim()), raw: a.trim() };
              }),
              raw: rawG
            });
          } else if (inner === '!') {
            segments.push({ type: 'bang', raw: rawG });
          } else {
            segments.push({ type: 'optional', subSegments: _parseGrammarSegments(inner), raw: rawG });
          }
          i = endB + 1;
        } else {
          // Bare keyword — read until whitespace, '<', or '['
          var j = i;
          while (j < s.length && s[j] !== ' ' && s[j] !== '<' && s[j] !== '[') j++;
          segments.push({ type: 'keyword', raw: s.slice(i, j) });
          i = j;
        }
      }
      return segments;
    }

    // Tokenize the argument portion (after the alias), respecting double-quotes.
    function _tokenizeArgs(str) {
      var tokens = [];
      var i = 0, s = str.trim();
      while (i < s.length) {
        while (i < s.length && s[i] === ' ') i++;
        if (i >= s.length) break;
        if (s[i] === '"') {
          var end = s.indexOf('"', i + 1);
          if (end === -1) { tokens.push(s.slice(i + 1)); i = s.length; }
          else { tokens.push(s.slice(i + 1, end)); i = end + 1; }
        } else {
          var sp = s.indexOf(' ', i);
          if (sp === -1) { tokens.push(s.slice(i)); i = s.length; }
          else { tokens.push(s.slice(i, sp)); i = sp; }
        }
      }
      return tokens;
    }

    // Consume user tokens against grammar segments.  Returns the remaining
    // (unconsumed) segments.  cursor = { idx, trailingSpace } is mutable.
    // The last token is "in-progress" when the input has no trailing space;
    // an in-progress token that fails to match a keyword/optional group stops
    // matching (shows remaining) instead of skipping the group.
    function _consumeSegments(segments, tokens, cursor) {
      for (var si = 0; si < segments.length; si++) {
        var seg = segments[si];
        if (cursor.idx >= tokens.length) return segments.slice(si);
        var inProgress = (cursor.idx === tokens.length - 1) && !cursor.trailingSpace;
        var tok = tokens[cursor.idx];

        if (seg.type === 'placeholder') {
          cursor.idx++;
        } else if (seg.type === 'keyword') {
          if (tok === seg.raw) cursor.idx++;
          else return segments.slice(si); // required keyword — always stop
        } else if (seg.type === 'optional') {
          var firstSub = seg.subSegments[0];
          if (firstSub && firstSub.type === 'keyword' && tok === firstSub.raw) {
            var subRem = _consumeSegments(seg.subSegments, tokens, cursor);
            if (subRem.length > 0) return subRem.concat(segments.slice(si + 1));
          } else if (inProgress && firstSub && firstSub.type === 'keyword' &&
                     firstSub.raw.indexOf(tok) === 0) {
            // In-progress token is a prefix of this group's keyword → stop
            return segments.slice(si);
          }
          // else skip (completed token, or in-progress not matching this group)
        } else if (seg.type === 'bang') {
          if (tok === '!') cursor.idx++;
          else if (inProgress && '!'.indexOf(tok) === 0) return segments.slice(si);
          // else skip
        } else if (seg.type === 'alternatives') {
          var matched = false, isPrefix = false;
          for (var oi = 0; oi < seg.options.length; oi++) {
            var opt = seg.options[oi];
            var fo = opt.subSegments[0];
            if (fo && fo.type === 'keyword') {
              if (tok === fo.raw) {
                var optRem = _consumeSegments(opt.subSegments, tokens, cursor);
                if (optRem.length > 0) return optRem.concat(segments.slice(si + 1));
                matched = true;
                break;
              }
              if (inProgress && fo.raw.indexOf(tok) === 0) isPrefix = true;
            }
          }
          if (matched) continue;
          if (inProgress && isPrefix) return segments.slice(si);
          // else skip (optional)
        }
      }
      return [];
    }

    // Join remaining segments back into a grammar hint string.
    function _segmentsToHint(segments) {
      var parts = [];
      for (var i = 0; i < segments.length; i++) parts.push(segments[i].raw);
      return parts.join(' ');
    }

    function _updateGhost() {
      if (!_currentHint || !_engagedAlias) { _removeGhost(); return; }
      _ensureGhost();
      var typed = _input ? _input.value : '';

      // Extract the alias portion (before first space, after ':').
      var afterColon = typed.charAt(0) === ':' ? typed.slice(1) : typed;
      var firstSpace = afterColon.indexOf(' ');
      var typedAlias = firstSpace < 0 ? afterColon : afterColon.slice(0, firstSpace);

      var ghost;
      if (typedAlias !== _engagedAlias) {
        // Alias-name completion mode (typed prefix like :po for :post):
        // show the rest of the alias name + full grammar via literal matching.
        var fullText = ':' + _engagedAlias + ' ' + _currentHint;
        var typedLower = typed.toLowerCase();
        var fullLower = fullText.toLowerCase();
        if (fullLower.indexOf(typedLower) === 0) ghost = fullText.slice(typed.length);
        else ghost = _currentHint;
      } else {
        // Grammar progression mode: consume typed tokens against segments.
        var argsStr = firstSpace < 0 ? '' : afterColon.slice(firstSpace + 1);
        var endsWithSpace = typed.length > 0 && typed.charAt(typed.length - 1) === ' ';
        var tokens = _tokenizeArgs(argsStr);
        var segments = _parseGrammarSegments(_currentHint);
        var cursor = { idx: 0, trailingSpace: endsWithSpace };
        var remaining = _consumeSegments(segments, tokens, cursor);
        var remStr = _segmentsToHint(remaining);
        ghost = (remStr && !endsWithSpace) ? ' ' + remStr : remStr;
      }

      // Build the ghost: invisible text matching the input content (same width)
      // followed by the grey ghost text. Both use the same font metrics as
      // the input (set in _ensureGhost) so alignment is exact.
      _ghostEl.innerHTML =
        '<span style="visibility:hidden">' + esc(typed) + '</span>' +
        '<span style="color:var(--text-muted);opacity:0.45">' + esc(ghost) + '</span>';
    }

    function _renderItems(items) {
      _items = items;
      _activeIdx = items.length ? 0 : -1;
      _render();
    }

    // Engage grammar mode — show ghost text + populate dropdown from itemSource.
    function _engageGrammar(g) {
      _engagedAlias = g.alias;
      _currentHint = g.grammar;
      _updateGhost();
      if (!_el && _command) _open();
      var alias = (window.FB && FB.command && FB.command.ALIASES) ? FB.command.ALIASES[g.alias] : null;
      var slotIndex = _slotIndex(g.alias);
      var itemSource = (alias && alias.itemSource) ? alias.itemSource[slotIndex] : null;
      if (itemSource) {
        var partial = _slotPartial(g.alias, slotIndex);
        var items = itemSource(partial);
        _renderItems(items);
      } else {
        _renderItems([]);
      }
    }

    function _disengageGrammar() {
      _engagedAlias = null;
      _currentHint = null;
      _removeGhost();
    }

    // v7: slot detection — scoped by alias shape, not one general solution.
    // :report — token count only (first space = type/period boundary, §5.1).
    // :show — always slot 0 (single slot).
    // :bill — advance-on-selection via _billSlot variable, starts at 0.
    // IMPORTANT: the user may have typed only a PREFIX of the alias (e.g. ":sh"
    // for "show"). We strip the typed prefix, not the full alias name.
    function _slotIndex(alias) {
      if (alias === 'bill') return _billSlot;
      var q = _rawQuery();
      // Strip the first token (whatever the user actually typed as the alias prefix)
      var firstSpace = q.indexOf(' ');
      var typedAlias = (firstSpace < 0 ? q : q.slice(0, firstSpace));
      var afterAlias = q.slice(typedAlias.length).replace(/^\s*/, '');
      if (afterAlias.trim() === '') return 0;
      if (alias === 'report') {
        var fs = afterAlias.indexOf(' ');
        return fs < 0 ? 0 : 1;
      }
      return 0; // :show and others — single slot
    }

    // Get the text the user has typed for the current slot.
    // Strips the typed alias prefix (not the full alias name) from the query.
    function _slotPartial(alias, slotIndex) {
      var q = _rawQuery();
      var firstSpace = q.indexOf(' ');
      var typedAlias = (firstSpace < 0 ? q : q.slice(0, firstSpace));
      var afterAlias = q.slice(typedAlias.length).replace(/^\s*/, '');
      if (alias === 'report') {
        if (slotIndex === 0) {
          // text after alias up to first space (or end)
          var sp = afterAlias.indexOf(' ');
          return sp < 0 ? afterAlias : afterAlias.slice(0, sp);
        }
        // slot 1: everything after the first space
        var sp1 = afterAlias.indexOf(' ');
        return sp1 < 0 ? '' : afterAlias.slice(sp1 + 1);
      }
      // :show, :new, :bill slot 0 — everything after the typed alias prefix
      return afterAlias;
    }

    function _executeGrammar() {
      var q = _rawQuery();
      var result = FB.command.parse(':' + q);
      _exitCommand();
      if (result.type === 'unknown') {
        var el = document.getElementById('tb-status-msg');
        if (el) { el.textContent = result.error; el.className = 'tb-status-msg err'; }
        return;
      }
      if (result.type === 'empty') return;
      if (result.type === 'alias' || result.type === 'raw') _executeParsed(result);
    }

    function _executeParsed(result) {
      var parsed = result.parsed || {};
      var co = _company();
      if (parsed.warnings && parsed.warnings.length) {
        var el = document.getElementById('tb-status-msg');
        if (el) { el.textContent = parsed.warnings.join('; '); el.className = 'tb-status-msg warn'; }
      }
      if (parsed.pageVerb) {
        if (window.fbKeyActions && typeof window.fbKeyActions[parsed.pageVerb] === 'function') {
          window.fbKeyActions[parsed.pageVerb]();
        }
        return;
      }
      if (parsed.route) {
        var url = parsed.absolute ? parsed.route : '/' + co + parsed.route;
        // v7: if it's a report route without a period, inject the default period
        if (url.indexOf('/reports?t=') !== -1 && url.indexOf('&period=') === -1 && _defaultPeriod) {
          url += '&period=' + encodeURIComponent(_defaultPeriod);
        }
        if (parsed.prefill) {
          try { sessionStorage.setItem('fb-cmd-prefill', JSON.stringify(parsed.prefill)); } catch (e) {}
        }
        if (parsed.absolute || !window.fbNavigate) window.location.href = url;
        else window.fbNavigate(url);
        return;
      }
      if (parsed.commitMode === 'client' && parsed.clientFn) {
        var fn = window[parsed.clientFn];
        if (typeof fn === 'function') {
          fn.apply(null, parsed.clientArgs || []);
          localStorage.setItem('fb-theme', parsed.clientArgs[0]);
          var stc = document.getElementById('tb-status-msg');
          if (stc) { stc.textContent = 'theme: ' + parsed.clientArgs[0]; stc.className = 'tb-status-msg ok'; }
        }
        return;
      }
      if (parsed.commitMode === 'direct' && parsed.action) {
        var idk = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random();
        var body = { action: parsed.action, companyId: co };
        if (parsed.params) Object.assign(body, parsed.params);
        fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idk },
          body: JSON.stringify(body)
        }).then(function (r) { return r.json(); }).then(function (res) {
          var st = document.getElementById('tb-status-msg');
          if (!st) return;
          if (res && res.ok === false) { st.textContent = ((res.error && res.error.message) || 'error'); st.className = 'tb-status-msg err'; }
          else { st.textContent = (result.alias || result.action) + ' — done'; st.className = 'tb-status-msg ok'; }
        }).catch(function () {
          var st2 = document.getElementById('tb-status-msg');
          if (st2) { st2.textContent = 'request failed'; st2.className = 'tb-status-msg err'; }
        });
        return;
      }
      if (parsed.commitMode === 'confirm' && parsed.action) {
        var idk2 = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random();
        var body2 = { action: parsed.action, companyId: co };
        if (parsed.params) Object.assign(body2, parsed.params);
        fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idk2 },
          body: JSON.stringify(body2)
        }).then(function (r) { return r.json(); }).then(function (res) {
          var st = document.getElementById('tb-status-msg');
          if (!st) return;
          if (res && res.ok === false) { st.textContent = ((res.error && res.error.message) || 'error'); st.className = 'tb-status-msg err'; }
          else { st.textContent = (result.alias || result.action) + ' — done'; st.className = 'tb-status-msg ok'; }
        }).catch(function () {
          var st3 = document.getElementById('tb-status-msg');
          if (st3) { st3.textContent = 'request failed'; st3.className = 'tb-status-msg err'; }
        });
        return;
      }
      if (parsed.action) {
        window.fbNavigate('/' + co + '/journal/voucher');
      }
    }

    var RECENT_KEY = 'fb.palette.recent';
    var CAP = 18;
    var SECTION_CAP = 20;  // v7: raised — flat list, no per-section grouping

    function _company() { return location.pathname.split('/')[1] || ''; }

    // ── sources ─────────────────────────────────────────────────────────────
    function _pageVerbs() {
      var cur = _activeSet();
      if (!cur) return [];
      var seen = {}, out = [];
      cur.set.bindings.forEach(function (b) {
        if ((b.mode || 'NORMAL') !== 'NORMAL') return;
        if (!b.hint || seen[b.hint]) return;
        // #149: movement/chrome bindings opt out via paletteEligible: false.
        // Business-action verbs also opt out when an explicit `:` alias
        // already covers them (scoped by binding-set name) — the alias is
        // the sole : citizen, the raw key stays taught via ?.
        if (b.paletteEligible === false) return;
        if (_aliasCovers(cur.name, b.key)) return;
        seen[b.hint] = true;
        out.push({
          id: 'page:' + cur.name + ':' + b.hint,
          label: b.hint, key: _keyLabel(b), scope: 'page',
          exec: function () { b.run({ key: b.key }); }
        });
      });
      return out;
    }

    // #149: check whether a scoped `:` alias already covers this binding.
    // ALIASES entries may carry { pageVerb: 'y', scope: 'inbox' }; the binding
    // is suppressed only when BOTH the key AND the binding-set name match —
    // vim-convention key reuse across pages must not cause false suppression.
    function _aliasCovers(setName, key) {
      var A = (window.FB && FB.command && FB.command.ALIASES) || {};
      for (var name in A) {
        var a = A[name];
        if (a && a.pageVerb && a.pageVerb === key && a.scope === setName) return true;
      }
      return false;
    }

    // #148: build palette items from FB.command.ALIASES — these are the
    // `:`-prefixed typed commands (bill, post, pay, …) that need argument
    // entry. They are the primary citizens of the `:` dropdown; page verbs
    // with direct key bindings (Bug #4) are now excluded.
    // v7: bare : shows only high-volume inline commands, ordered by frequency.
    // Low-volume functions (lock, unlock, partner, rate, token, void) are
    // managed through their proper screens, not the command bar.
    var INLINE_ALIASES = ['bill', 'pay', 'post', 'report', 'show', 'new'];
    var ALIAS_AREA = {
      bill:   'Payables',
      pay:    'Bank',
      post:   'Journal',
      report: 'Reports'
      // show and new: no area label
    };

    function _aliasCommands() {
      var A = (window.FB && FB.command && FB.command.ALIASES) || {};
      var out = [];
      INLINE_ALIASES.forEach(function (name) {
        if (!A[name]) return;
        if (A[name].palette === false) return;
        out.push({
          id: 'alias:' + name,
          label: name,
          pageLabel: ALIAS_AREA[name] || '',
          key: '',
          scope: 'alias',
          keepOpen: true,
          exec: function () {
            _input.value = ':' + name + ' ';
            _input.focus();
            _input.setSelectionRange(_input.value.length, _input.value.length);
            var g = _detectGrammar(name + ' ');
            if (g) _engageGrammar(g);
            else _query_default(name + ' ');
          }
        });
      });
      return out;
    }

    function _apiCommands() {
      if (!_catalog) return [];
      var out = [];
      // navigate entries: dedupe by exact route string — all actions sharing a
      // route surface as one palette row (same label, same nav behavior).
      var seenRoute = {};
      Object.keys(_catalog).forEach(function (name) {
        var meta = _catalog[name] || {};
        if (meta.palette === 'execute') {
          out.push({
            id: 'api:' + name, label: meta.label || meta.description || name, key: '', scope: 'api',
            isNavigate: false,
            exec: function () { _runApi(name); }
          });
        } else if (meta.palette === 'navigate' && meta.route) {
          if (seenRoute[meta.route]) return;  // first action for this route wins
          seenRoute[meta.route] = true;
          out.push({
            id: 'api:' + name, label: meta.label || meta.description || name, key: '', scope: 'api',
            isNavigate: true, create: !!meta.create,
            exec: function () {
              if (meta.absolute) window.location.href = meta.route; // company-less (e.g. /setup)
              else window.fbNavigate('/' + _company() + meta.route);
            }
          });
        }
      });
      return out.sort(function (a, b) {
        return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
      });
    }

    // K1: registry routes (window.FB_ROUTES) — 'Go to …' rows. Dedupe is
    // carried by the registry itself: routes already covered by an
    // action-catalog navigate entry (journal/voucher, new-company)
    // keep palette:false there, so no runtime dedupe is needed here.
    function _routeCommands() {
      var R = window.FB_ROUTES || [];
      var out = [];
      R.forEach(function (r) {
        if (!r.palette) return;
        out.push({
          id: 'nav:' + r.key,
          label: 'Go to ' + r.label,
          key: r.gKey ? 'g ' + r.gKey : '',
          scope: 'nav',
          exec: function () {
            var href = r.absolute ? r.route : r.route.replace(':company', _company());
            if (r.absolute || !window.fbNavigate) window.location.href = href;
            else window.fbNavigate(href);
          }
        });
      });
      return out;
    }

    function _fetchCatalog() {
      if (_catalog) return;
      fetch('/api/actions').then(function (r) { return r.json(); }).then(function (res) {
        if (res && res.actions) { _catalog = res.actions; if (_el) _query_default(_rawQuery()); }
      }).catch(function () { /* palette works page-verbs-only without it */ });
    }

    // Lazy fetch — called on demand by reportTypes() itemSource, not on every command entry.
    var _reportsFetching = false;
    function _fetchReportsOnce() {
      if (_reports || _reportsFetching) return;
      var co = _company();
      if (!co) return;
      _reportsFetching = true;
      fetch('/api/' + co + '/reports/registry').then(function (r) { return r.json(); }).then(function (res) {
        _reportsFetching = false;
        if (Array.isArray(res)) { _reports = res; if (_el && _currentHint) _engageGrammar(_detectGrammar(_rawQuery()) || { alias: 'report', grammar: _currentHint }); }
      }).catch(function () { _reportsFetching = false; });
    }

    // v7: bare : shows all aliases + execute actions — flat list, no headers,
    // no "New…" collapse. :new is its own alias with its own itemSource.
    function _isNavigate(c) { return c.scope === 'api' && c.isNavigate === true; }

    function _defaultItems() {
      // v7: bare : shows only the 6 inline aliases — no execute actions,
      // no create-shortcuts, no navigate entries.
      return _aliasCommands();
    }

    // Derive a human-readable page name from a route for display in the dropdown.
    // /settings?tab=vat → "Settings", /payables?tab=partners → "Payables", etc.
    function _pageLabelFor(route) {
      if (!route) return '';
      if (route.indexOf('/settings') === 0) return 'Settings';
      if (route.indexOf('/accounting') === 0) return 'Accounting';
      if (route.indexOf('/exchange-rates') === 0) return 'Exchange Rates';
      if (route.indexOf('/payables') === 0) return 'Payables';
      if (route.indexOf('/statements') === 0) return 'Statements';
      if (route.indexOf('/books') === 0) return 'Books';
      if (route.indexOf('/fiscal') === 0) return 'Fiscal';
      if (route.indexOf('/journal') === 0) return 'Journal';
      if (route.indexOf('/bill') === 0) return 'Payables';
      return '';
    }

    // ── §4: showTargets() — navigate-only, non-create, non-reports ──────────
    function showTargets(partial) {
      var out = [];
      if (_catalog) {
        Object.keys(_catalog).forEach(function (name) {
          var meta = _catalog[name] || {};
          if (meta.palette !== 'navigate' || !meta.route) return;
          if (meta.create) return;                      // exclude create-shortcuts
          if (meta.route.indexOf('/books') === 0) return; // exclude books
          if (meta.route.indexOf('/statements') === 0) return; // exclude statements
          if (meta.absolute) return;                     // exclude setup/add company
          if (meta.route.indexOf('/setup') === 0) return; // exclude setup
          if (meta.label && /^close /i.test(meta.label)) return; // exclude "Close period"
          var lbl = meta.label || name;
          var page = _pageLabelFor(meta.route);
          out.push({
            id: 'nav:' + name,
            label: lbl,
            group: page || 'Other',
            route: meta.route,
            scope: 'nav',
            exec: function () {
              window.fbNavigate('/' + _company() + meta.route);
            }
          });
        });
      }
      // Dedupe by route
      var seen = {};
      out = out.filter(function (c) {
        if (seen[c.route]) return false;
        seen[c.route] = true;
        return true;
      });
      // Sort by group, then by label
      out.sort(function (a, b) {
        if (a.group !== b.group) return a.group < b.group ? -1 : 1;
        return a.label < b.label ? -1 : 1;
      });
      if (partial) {
        out = out.filter(function (c) {
          return c.label.toLowerCase().indexOf(partial.toLowerCase()) !== -1 ||
                 (c.group && c.group.toLowerCase().indexOf(partial.toLowerCase()) !== -1);
        });
      }
      return out;
    }

    // v7: newTargets() — create-shortcuts from the catalog. Navigates to forms.
    function newTargets(partial) {
      var out = [];
      if (_catalog) {
        Object.keys(_catalog).forEach(function (name) {
          var meta = _catalog[name] || {};
          if (meta.palette !== 'navigate' || !meta.route) return;
          if (!meta.create) return;  // only create-shortcuts
          out.push({
            id: 'nav:' + name,
            label: meta.label || name,
            pageLabel: _pageLabelFor(meta.route),
            route: meta.route,
            absolute: !!meta.absolute,
            scope: 'nav',
            exec: function () {
              if (meta.absolute) window.location.href = meta.route;
              else window.fbNavigate('/' + _company() + meta.route);
            }
          });
        });
      }
      // Dedupe by route (bill.create and bill.draft.save share /bill/edit, etc.)
      var seen = {};
      out = out.filter(function (c) {
        if (seen[c.route]) return false;
        seen[c.route] = true;
        return true;
      });
      if (partial) {
        out = out.filter(function (c) {
          return c.label.toLowerCase().indexOf(partial.toLowerCase()) !== -1 ||
                 (c.pageLabel && c.pageLabel.toLowerCase().indexOf(partial.toLowerCase()) !== -1);
        });
      }
      return out;
    }

    // ── §5: reportTypes() — source from /api/:company/reports/registry ─────
    var _defaultPeriod = null;
    var _defaultPeriodFetching = false;
    function _fetchDefaultPeriod() {
      if (_defaultPeriod !== null || _defaultPeriodFetching) return;
      var co = _company();
      if (!co) return;
      _defaultPeriodFetching = true;
      fetch('/api/' + co + '/reports/default-period').then(function (r) { return r.json(); }).then(function (res) {
        _defaultPeriodFetching = false;
        if (res && res.period_id) _defaultPeriod = res.period_id;
      }).catch(function () { _defaultPeriodFetching = false; });
    }

    function reportTypes(partial) {
      if (!_reports) {
        _fetchReportsOnce();
        return [];
      }
      _fetchDefaultPeriod(); // lazy fetch, cached
      var items = _reports.map(function (r) {
        return {
          id: 'report:' + r.id,
          label: r.label,
          reportId: r.id,
          scope: 'api',
          exec: function () {
            // If no period typed, use the default period (latest posted txn).
            // parseReport handles the URL construction via FB.command.parse().
            var q = _rawQuery();
            var afterReport = q.slice(q.indexOf(' ') + 1);
            var hasPeriod = afterReport && afterReport.trim() && afterReport.indexOf(' ') >= 0;
            var url = '/' + _company() + '/reports?t=' + r.id;
            if (hasPeriod) {
              // period was typed — use it
              var periodTok = afterReport.slice(afterReport.indexOf(' ') + 1);
              url += '&period=' + encodeURIComponent(periodTok);
            } else if (_defaultPeriod) {
              // no period — use the default (latest posted transaction period)
              url += '&period=' + encodeURIComponent(_defaultPeriod);
            }
            window.fbNavigate(url);
          }
        };
      });
      if (partial) {
        items = items.filter(function (c) {
          return c.label.toLowerCase().indexOf(partial.toLowerCase()) !== -1 ||
                 c.reportId.toLowerCase().indexOf(partial.toLowerCase()) !== -1;
        });
      }
      return items;
    }

    // ── §6: partnerMatches() — reuse partner data for :bill slot 0 ──────────
    function partnerMatches(partial) {
      var partners = window.fbPartnerData;
      if (!partners && _partners) partners = _partners;
      if (!partners) {
        // Fetch via action RPC (partner.list) — no direct GET endpoint exists.
        _fetchPartners();
        return [];
      }
      var list = partners;
      if (partial) {
        list = partners.filter(function (p) {
          var nm = (p.name || '').toLowerCase();
          return nm.indexOf(partial.toLowerCase()) !== -1;
        });
      }
      return list.map(function (p) {
        return {
          id: 'partner:' + (p.partner_id || p.id || p.name),
          label: p.name,
          scope: 'partner',
          keepOpen: true,
          exec: function () {
            // §7: advance-on-selection — commit partner label into input, advance to slot 1.
            _input.value = ':bill ' + p.name + ' ';
            _input.focus();
            _input.setSelectionRange(_input.value.length, _input.value.length);
            _billSlot = 1;
            _currentHint = FB.command.grammarFor('bill');
            _renderItems([]);  // no items for amount slot (free text)
          }
        };
      });
    }

    function _fetchPartners() {
      if (_partners) return;
      var co = _company();
      if (!co) return;
      fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'partner.list', companyId: co })
      }).then(function (r) { return r.json(); }).then(function (res) {
        if (res && !res.ok === false && Array.isArray(res.result)) { _partners = res.result; if (_el && _currentHint) _engageGrammar(_detectGrammar(_rawQuery()) || { alias: 'bill', grammar: _currentHint }); }
        else if (Array.isArray(res)) { _partners = res; if (_el && _currentHint) _engageGrammar(_detectGrammar(_rawQuery()) || { alias: 'bill', grammar: _currentHint }); }
      }).catch(function () {});
    }

    // Wire itemSource functions to ALIASES (§3.3) — called at wire() and enterCommand()
    function _wireItemSources() {
      var A = (window.FB && FB.command && FB.command.ALIASES) || {};
      if (A.show) A.show.itemSource = [showTargets];
      if (A.new) A.new.itemSource = [newTargets];
      if (A.report) A.report.itemSource = [reportTypes, null];
      if (A.bill) A.bill.itemSource = [partnerMatches, null, null, null];
    }

    // ── fuzzy matching + ranking ────────────────────────────────────────────
    function _fuzzy(q, text) {
      q = q.toLowerCase(); text = String(text || '').toLowerCase();
      if (!q) return 0;
      var ti = 0, score = 0, last = -2;
      for (var qi = 0; qi < q.length; qi++) {
        var at = text.indexOf(q[qi], ti);
        if (at === -1) return null;
        score += (at - ti);
        if (at === last + 1) score -= 1;      // consecutive bonus
        last = at; ti = at + 1;
      }
      if (text.indexOf(q) === 0) score -= 10; // prefix bonus
      return score;
    }

    function _recent() {
      try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (e) { return []; }
    }
    function _pushRecent(id) {
      var r = _recent().filter(function (x) { return x !== id; });
      r.unshift(id);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(r.slice(0, 20))); } catch (e) {}
    }

    function _match(q, candidates) {
      var recent = _recent();
      // #148: Score and cap each scope independently, then concatenate in
      // ALIAS → API order. Page verbs (Bug #4) and nav rows are no longer in
      // the `:` dropdown — page verbs have direct key bindings (`w`, `p`, …)
      // and are taught via the `?` overlay; aliases need typed arguments and
      // API actions have no keyboard shortcut.
      //
      // v6 (§2): callers pass a pre-filtered candidate list (_verbCandidates)
      // so navigate-non-create entries are excluded from bare : in every state.
      var groups;
      if (candidates) {
        // Group the provided candidates by scope for independent scoring/capping
        var byScope = {};
        candidates.forEach(function (c) {
          var s = c.scope || 'api';
          if (!byScope[s]) byScope[s] = [];
          byScope[s].push(c);
        });
        groups = [
          { items: byScope['alias'] || [], scope: 'alias' },
          { items: byScope['api'] || [], scope: 'api' }
        ];
        // Include any other scopes that might be present (e.g. 'group')
        Object.keys(byScope).forEach(function (s) {
          if (s !== 'alias' && s !== 'api') groups.push({ items: byScope[s], scope: s });
        });
      } else {
        groups = [
          { items: _aliasCommands(), scope: 'alias' },
          { items: _apiCommands(), scope: 'api' }
        ];
      }
      var result = [];
      groups.forEach(function (g) {
        var scored = [];
        g.items.forEach(function (c) {
          var s = _fuzzy(q, c.label);
          var sk = c.key ? _fuzzy(q, c.key) : null;
          if (s === null) s = sk;
          else if (sk !== null) s = Math.min(s, sk);
          if (s === null) return;
          var ri = recent.indexOf(c.id);
          // Recent items get a flat -1000 bonus (not -100-ri) so they sort
          // first as a group, but alphabetical tiebreak still applies within
          // the group. Without this, each recent item got a unique score
          // (-100, -101, …) that defeated the alphabetical tiebreak.
          var recBonus = ri >= 0 ? -1000 : 0;
          scored.push({ c: c, score: recBonus + s, rec: ri >= 0 });
        });
        scored.sort(function (a, b) {
          if (a.score === b.score) return a.c.label.localeCompare(b.c.label, undefined, { sensitivity: 'base' });
          return a.score - b.score;
        });
        result = result.concat(scored.slice(0, SECTION_CAP).map(function (x) { return x.c; }));
      });
      return result;
    }

    // ── dropdown UI ─────────────────────────────────────────────────────────
    function _open() {
      if (_el || !_input) return;
      _el = document.createElement('div');
      _el.className = 'fb-palette';
      var wrap = _input.closest('.tb-search-wrap') || _input.parentElement;
      if (wrap) wrap.style.position = wrap.style.position || 'relative';
      (wrap || document.body).appendChild(_el);
    }
    function _close() { if (_el) { _el.remove(); _el = null; } _activeIdx = -1; _items = []; }

    function _render() {
      if (!_el) return;
      if (!_items.length) {
        _el.innerHTML = '<div class="fb-palette-empty">no matching commands</div>';
        return;
      }
      // v7: If items have a `group` property, render grouped with headers.
      // Otherwise flat list.
      var hasGroups = _items.some(function (c) { return c.group; });
      var html = '';
      if (hasGroups) {
        var lastGroup = null;
        _items.forEach(function (c, i) {
          if (c.group !== lastGroup) {
            html += '<div class="fb-palette-group">' + esc(c.group) + '</div>';
            lastGroup = c.group;
          }
          html += '<div class="fb-palette-row fb-palette-indented' + (i === _activeIdx ? ' fb-palette-active' : '') + '" data-i="' + i + '">' +
            '<span class="fb-palette-label">' + esc(c.label) + '</span>' +
            (c.key ? '<kbd>' + esc(c.key) + '</kbd>' : '') +
          '</div>';
        });
      } else {
        _items.forEach(function (c, i) {
          html += '<div class="fb-palette-row' + (i === _activeIdx ? ' fb-palette-active' : '') + '" data-i="' + i + '">' +
            '<span class="fb-palette-label">' + esc(c.label) + '</span>' +
            (c.pageLabel ? '<span class="fb-palette-page">' + esc(c.pageLabel) + '</span>' : '') +
            (c.key ? '<kbd>' + esc(c.key) + '</kbd>' : '') +
          '</div>';
        });
      }
      _el.innerHTML = html;
      Array.prototype.forEach.call(_el.querySelectorAll('.fb-palette-row'), function (row) {
        row.onmousedown = function (e) { e.preventDefault(); };
        row.onclick = function () { _execute(_items[Number(row.dataset.i)]); };
        row.onmouseover = function () { _activeIdx = Number(row.dataset.i); _render(); };
      });
      var act = _el.querySelector('.fb-palette-active');
      if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
    }

    function _move(d) {
      if (!_items.length) return;
      var i = _activeIdx + d;
      if (i < 0) i = 0;
      if (i > _items.length - 1) i = _items.length - 1; // sticky, vim doctrine
      _activeIdx = i;
      _render();
    }

    function _rawQuery() {
      var v = _input ? _input.value : '';
      return v.charAt(0) === ':' ? v.slice(1) : v;
    }
    function _query_default(q) {
      // v7: unified query path — flat list, no collapse/expand.
      if (!_el && _command) _open();
      if (q !== '') {
        _items = _match(q.trim(), _defaultItems());
      } else {
        _items = _defaultItems();
      }
      _activeIdx = _items.length ? 0 : -1;
      _render();
    }

    function _execute(item) {
      if (!item) return;
      _pushRecent(item.id);
      // #148: alias items set keepOpen:true so selecting them does NOT exit
      // command mode — the input is filled with `:name ` and grammar mode
      // engages so the user continues typing arguments.
      if (!item.keepOpen) _exitCommand();
      item.exec();
    }

    function _runApi(name) {
      var idk = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random();
      fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idk },
        body: JSON.stringify({ action: name, companyId: _company() })
      }).then(function (r) { return r.json(); }).then(function (res) {
        var el = document.getElementById('tb-status-msg');
        if (!el) return;
        if (res && res.ok === false) el.textContent = name + ': ' + ((res.error && res.error.message) || 'error');
        else el.textContent = name + ' — done';
      }).catch(function () {});
    }

    // ── mode transitions ────────────────────────────────────────────────────
    function enterCommand() {
      if (!_input) return;
      _command = true;
      _wireItemSources();
      _fetchCatalog();
      _input.value = ':';
      _input.focus();
      _input.setSelectionRange(1, 1);
      _open();
      _query_default('');
    }
    function _exitCommand() {
      _command = false;
      _disengageGrammar();
      _billSlot = 0;
      _close();
      if (_input) { _input.value = ''; _input.blur(); }
    }

    // ── wiring (called once from common.js with the persistent topbar input) ─
    function wire(input) {
      if (_wired || !input) return;
      _wired = true;
      _input = input;
      _wireItemSources();
      // Capture phase: command-mode keys must beat the input's other bubble
      // listeners (Enter-blurs / Esc-clears) — those stay for search mode.
      input.addEventListener('keydown', function (e) {
        if (!_command) return;
        if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); e.stopImmediatePropagation(); _move(1); }
        else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); e.stopImmediatePropagation(); _move(-1); }
        else if (e.key === 'Enter') {
          e.preventDefault(); e.stopImmediatePropagation();
          // Grammar mode: select highlighted item, or parse the full input
          if (_engagedAlias) {
            if (_items.length && _activeIdx >= 0) _execute(_items[_activeIdx]);
            else _executeGrammar();
          } else {
            // If the typed prefix matches one alias, selecting it engages grammar
            var g = _detectGrammar(_rawQuery());
            if (g && !g.exact) {
              // Prefix match — complete the alias name and engage
              _input.value = ':' + g.alias + ' ';
              _input.focus();
              _input.setSelectionRange(_input.value.length, _input.value.length);
              _engageGrammar(g);
            } else if (g && g.exact) {
              _engageGrammar(g);
            } else {
              _execute(_items[_activeIdx >= 0 ? _activeIdx : 0]);
            }
          }
        }
        else if (e.key === 'Escape') {
          e.preventDefault(); e.stopImmediatePropagation();
          _exitCommand();
        }
        else if (e.key === 'Tab') {
          // v7: Tab completes the alias prefix if there's a unique match
          if (!_engagedAlias) {
            var g2 = _detectGrammar(_rawQuery());
            if (g2 && !g2.exact) {
              e.preventDefault();
              _input.value = ':' + g2.alias + ' ';
              _input.focus();
              _input.setSelectionRange(_input.value.length, _input.value.length);
              _engageGrammar(g2);
            }
          }
        }
      }, true);
      input.addEventListener('input', function () {
        if (!_command) {
          if (_input.value.charAt(0) === ':') {
            _command = true;
            _wireItemSources();
            _fetchCatalog();
            _open();
            var q0 = _rawQuery();
            var g0 = _detectGrammar(q0);
            if (g0) _engageGrammar(g0);
            else { _disengageGrammar(); _query_default(q0); }
          }
          return;
        }
        if (_input.value.charAt(0) !== ':') {
          _command = false; _close(); _disengageGrammar(); _billSlot = 0; return;
        }
        var q = _rawQuery();
        var g = _detectGrammar(q);
        if (g) {
          _engageGrammar(g);
        } else {
          _disengageGrammar();
          _billSlot = 0;
          _query_default(q);
        }
      });
      input.addEventListener('blur', function () {
        if (!_command) return;
        // Small delay so a row click (mousedown-prevented, so blur shouldn't
        // fire — belt and braces) can still execute first.
        setTimeout(function () { if (_command) _exitCommand(); }, 150);
      });
      input.addEventListener('focus', function () {
        // Mouse/keyboard entry that isn't enterCommand is always search mode
        // (magnus decision 2) — no ':'-prefix detection on typed content.
        if (!_command) _close();
      });
    }

    return {
      wire: wire,
      enterCommand: enterCommand,
      isCommand: function () { return _command; },
      isOpen: function () { return !!_el; },
      newTargets: newTargets,
      preloadCatalog: _fetchCatalog
    };
  })();

  // ── FB.search — `/` global search (command-bar-ux-spec.md §4) ──────────────
  // The topbar input hosts two `/` modes: `/` global search (always, with
  // an optional "Filter current page" row when a FB.list is visible) and `:`
  // command mode (owned by FB.palette). This module owns the global-search
  // dropdown: fetches from GET /api/:company/search, renders the synthetic
  // "Filter current page" row first when a FB.list is visible, and groups
  // the rest of the results by entity type with headers showing hit counts
  // (using the same fb-palette-* CSS as the command palette).
  var search = (function () {
    var _input = null;
    var _el = null;
    var _items = [];
    var _activeIdx = -1;
    var _wired = false;
    var _active = false;       // true while a search dropdown is open
    var _debounce = null;
    var _lastReq = 0;

    function _company() { return location.pathname.split('/')[1] || ''; }

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
      _items = [];
      _activeIdx = -1;
      _active = false;
    }

    var TYPE_LABELS = {
      partner: 'Partner', account: 'Account', journal: 'Journal', bill: 'Bill'
    };
    // Plural labels used for group headers (e.g. "Partners (3)").
    var TYPE_LABELS_PLURAL = {
      partner: 'Partners', account: 'Accounts', journal: 'Journals', bill: 'Bills'
    };
    // Sort order for grouping: page-filter always first, then by entity type.
    var TYPE_ORDER = { 'page-filter': 0, partner: 1, account: 2, journal: 3, bill: 4 };

    // Build the synthetic "Filter current page" row. `query` is the text after
    // the `/` (and any scope prefix) — what we hand to inst.applyFilterExpr().
    function _pageFilterItem(query) {
      return {
        type: 'page-filter', id: 'page-filter',
        label: 'Filter current page', route: null, typeLabel: '',
        query: query
      };
    }

    // Derive the page-filter query from the current input value (always
    // reflects what the user has typed right now, not the possibly-stale
    // query captured when a fetch was kicked off).
    function _currentFilterQuery() {
      var v = _input ? _input.value : '';
      if (v.charAt(0) !== '/') return '';
      var parsed = (FB.command && FB.command.parseSearchScope)
        ? FB.command.parseSearchScope(v)
        : { scope: null, query: v.slice(1) };
      return parsed.query || '';
    }

    function _listVisible() {
      return !!(window.FB && FB.list && FB.list.visible && FB.list.visible());
    }

    // Compose the final _items array: optional page-filter row first, then
    // fetched results sorted by TYPE_ORDER so grouping in _render works.
    function _composeItems(fetched) {
      var sorted = fetched.slice().sort(function (a, b) {
        var oa = TYPE_ORDER[a.type] != null ? TYPE_ORDER[a.type] : 99;
        var ob = TYPE_ORDER[b.type] != null ? TYPE_ORDER[b.type] : 99;
        return oa - ob;
      });
      if (_listVisible()) return [_pageFilterItem(_currentFilterQuery())].concat(sorted);
      return sorted;
    }

    function _render() {
      if (!_el) return;
      if (!_items.length) {
        _el.innerHTML = '<div class="fb-palette-empty">no results</div>';
        return;
      }
      // Group items by type with headers showing hit counts. The page-filter
      // row (type 'page-filter') is rendered first with NO group header.
      var counts = {};
      _items.forEach(function (c) { counts[c.type] = (counts[c.type] || 0) + 1; });
      var html = '';
      var lastType = null;
      _items.forEach(function (c, i) {
        if (c.type !== 'page-filter' && c.type !== lastType) {
          var plural = TYPE_LABELS_PLURAL[c.type] || c.type;
          var cnt = counts[c.type] || 0;
          html += '<div class="fb-palette-group">' + esc(plural) + ' (' + cnt + ')</div>';
          lastType = c.type;
        }
        html += '<div class="fb-palette-row' + (i === _activeIdx ? ' fb-palette-active' : '') + '" data-i="' + i + '">' +
          '<span class="fb-palette-label">' + esc(c.label) + '</span>' +
          '<span class="fb-palette-page">' + esc(c.typeLabel) + '</span>' +
        '</div>';
      });
      _el.innerHTML = html;
      Array.prototype.forEach.call(_el.querySelectorAll('.fb-palette-row'), function (row) {
        row.onmousedown = function (e) { e.preventDefault(); };
        row.onclick = function () { _select(Number(row.dataset.i)); };
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

    function _select(idx) {
      var item = _items[idx];
      if (!item) return;
      // "Filter current page" — apply the page-level list filter instead of
      // navigating. The query carried on the item is the text after `/`.
      if (item.type === 'page-filter') {
        _close();
        if (_input) { _input.value = ''; _input.blur(); }
        var inst = _listVisible() ? (window.FB.list.visible()) : null;
        if (inst) inst.applyFilterExpr(item.query);
        return;
      }
      _close();
      if (_input) { _input.value = ''; _input.blur(); }
      var url = '/' + _company() + item.route;
      if (window.fbNavigate) window.fbNavigate(url);
      else window.location.href = url;
    }

    // Decide whether the current input value should trigger search mode.
    // `/` ALWAYS does global search now — returns {scope, query} when the
    // value starts with `/`, or null otherwise (so common.js can ignore
    // non-`/` input). Never returns null for a `/`-prefixed value.
    function _resolveMode(value) {
      if (value.charAt(0) !== '/') return null;
      var parsed = (FB.command && FB.command.parseSearchScope)
        ? FB.command.parseSearchScope(value)
        : { scope: null, query: value.slice(1) };
      // Explicit scope prefix (/p:, /a:, /j:, /b:) → that scope.
      // No prefix → global "all" search (regardless of FB.list visibility).
      return { scope: parsed.scope || 'all', query: parsed.query };
    }

    // Core fetch + render. autoSelect=true (used by submit()) navigates to
    // the first result on completion; false just renders the dropdown.
    function _doFetch(scope, q, autoSelect) {
      if (_debounce) { clearTimeout(_debounce); _debounce = null; }
      var req = ++_lastReq;
      var url = '/api/' + encodeURIComponent(_company()) + '/search?q=' +
        encodeURIComponent(q) + '&scope=' + encodeURIComponent(scope);
      fetch(url).then(function (r) { return r.json(); }).then(function (res) {
        if (req !== _lastReq) return; // stale response
        var fetched = (!res || !res.ok || !Array.isArray(res.results)) ? [] : res.results.map(function (r2) {
          return {
            type: r2.type,
            id: r2.id,
            label: r2.label,
            route: r2.route,
            typeLabel: TYPE_LABELS[r2.type] || r2.type
          };
        });
        _items = _composeItems(fetched);
        _activeIdx = _items.length ? 0 : -1;
        _render();
        if (autoSelect && _items.length) _select(_activeIdx >= 0 ? _activeIdx : 0);
      }).catch(function () {
        if (req !== _lastReq) return;
        _items = _composeItems([]); _activeIdx = _items.length ? 0 : -1; _render();
      });
    }

    // Debounced fetch used by onInput() during live typing.
    function _fetch(scope, q) {
      if (_debounce) { clearTimeout(_debounce); _debounce = null; }
      _debounce = setTimeout(function () { _doFetch(scope, q, false); }, 150);
    }

    // Called by common.js on every input event. Returns true if search mode
    // consumed the event (so common.js should skip its page-filter path).
    // `/` ALWAYS does global search now; when a FB.list is visible the
    // "Filter current page" row is shown immediately (no debounce — it's a
    // local action) and global results are appended when the fetch returns.
    function onInput(value) {
      var mode = _resolveMode(value);
      if (!mode) {
        if (_active) _close();
        return false;
      }
      // Activate search mode.
      if (!_active) { _active = true; _open(); }
      // Show the page-filter row (if a FB.list is visible) immediately —
      // it does not need the backend. With an empty query this is the only
      // row; selecting it clears the list filter.
      _items = _composeItems([]);
      _activeIdx = _items.length ? 0 : -1;
      _render();
      if (mode.query.length < 1) return true;
      _fetch(mode.scope, mode.query);
      return true;
    }

    // Called by common.js on keydown when value starts with `/`. Returns
    // true if search mode handled the key.
    function onKeydown(e) {
      if (!_active) return false;
      if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
        e.preventDefault(); e.stopImmediatePropagation(); _move(1); return true;
      }
      if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
        e.preventDefault(); e.stopImmediatePropagation(); _move(-1); return true;
      }
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopImmediatePropagation();
        if (_items.length) _select(_activeIdx >= 0 ? _activeIdx : 0);
        // Fetch pending (debounce not yet fired): bypass it and auto-select
        // the first result on completion.
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

    // Called by common.js when the `/` key is pressed (analogous to
    // palette.enterCommand for `:`). Sets the value to '/', focuses, and
    // positions the cursor after the slash. Does NOT open the dropdown —
    // there is nothing to search yet.
    function enter() {
      if (!_input) return;
      _input.value = '/';
      _input.focus();
      _input.setSelectionRange(1, 1);
    }

    // Called by common.js when Enter is pressed and the value starts with '/'.
    // Forces an immediate fetch (bypassing debounce) and auto-selects the
    // first result on completion. Also called from onKeydown() when search
    // IS active but the fetch is still pending (items empty) — same debounce
    // race fix. With the new always-global design, the first result is the
    // page-filter row when a FB.list is visible (so Enter filters the page),
    // otherwise the first global result.
    function submit() {
      var value = _input ? _input.value : '';
      if (!value || value.charAt(0) !== '/') return;
      var parsed = (FB.command && FB.command.parseSearchScope)
        ? FB.command.parseSearchScope(value)
        : { scope: null, query: value.slice(1) };
      var scope = parsed.scope || 'all';
      var query = parsed.query;
      if (!query) return; // nothing to search yet
      // Activate search mode (force, even if a FB.list is visible).
      if (!_active) { _active = true; _open(); }
      _doFetch(scope, query, true);
    }

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
  var _pPeriods = [];               // fetched defined periods (desc by start_date)
  var _pPopoverOpen = false;

  function _pTrigger() { return document.getElementById('tb-period-trigger'); }
  function _pPopover() { return document.getElementById('tb-period-popover'); }

  function _pLabel() {
    if (!_pState.start && !_pState.end) return 'Period';
    if (_pState.mode === 'period') {
      for (var i = 0; i < _pPeriods.length; i++) {
        if (_pPeriods[i].period_id === _pState.periodId) {
          return _pPeriods[i].period_name || (_pState.start + ' \u2013 ' + _pState.end);
        }
      }
    }
    if (_pState.start && _pState.end) return _pState.start + ' \u2013 ' + _pState.end;
    if (_pState.end) return 'as of ' + _pState.end;
    return 'Period';
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

  function _pBuildPopover() {
    var pop = _pPopover();
    if (!pop) return;
    var opts = '<option value="custom">Custom</option>';
    for (var i = 0; i < _pPeriods.length; i++) {
      var p = _pPeriods[i];
      var s = String(p.start_date).slice(0, 10), e = String(p.end_date).slice(0, 10);
      var val = s + '|' + e;
      var pid = p.period_id || val;
      opts += '<option value="' + esc(val) + '" data-pid="' + esc(String(pid)) + '">' + esc(p.period_name || s) + '</option>';
    }
    var html = '<select id="tb-period-select" class="tb-select" onchange="FB.period._onPick()">' + opts + '</select>';
    // Custom dates: range → Start + End; asOf → End only (Start never rendered)
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
    _pSyncPopover();
  }

  function _pSyncPopover() {
    var sel = document.getElementById('tb-period-select');
    if (!sel) return;
    if (_pState.mode === 'custom') {
      sel.value = 'custom';
    } else {
      var val = _pState.start + '|' + _pState.end;
      sel.value = val;
      if (sel.value !== val) sel.value = 'custom';
    }
    var se = document.getElementById('tb-period-start');
    var ee = document.getElementById('tb-period-end');
    if (se) se.value = _pState.start || '';
    if (ee) ee.value = _pState.end || '';
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
    onChange: function (cb) { _pListeners.push(cb); },
    // Open/close the period selector popover (trigger onclick).
    togglePopover: function (event) {
      if (event) event.stopPropagation();
      var pop = _pPopover();
      if (!pop) return;
      if (_pPopoverOpen) { _pClosePopover(); return; }
      _pBuildPopover();
      pop.hidden = false;
      pop.style.display = '';
      _pPopoverOpen = true;
    },
    // Period-dropdown pick — closes popover immediately, fires change (§3.2).
    _onPick: function () {
      var sel = document.getElementById('tb-period-select');
      if (!sel) return;
      var val = sel.value;
      if (val === 'custom') {
        // Switch to custom mode — keep existing dates, popover stays open.
        _pState.mode = 'custom';
        _pState.periodId = null;
        _pPersist();
        _pRenderTrigger();
        _pFire();
        return;
      }
      var pts = val.split('|');
      var s = pts[0], e = pts[1];
      var pid = null;
      var opt = sel.options[sel.selectedIndex];
      if (opt) pid = opt.getAttribute('data-pid') || null;
      _pState = { mode: 'period', periodId: pid, start: s, end: e };
      _pPersist();
      _pRenderTrigger();
      _pFire();
      _pClosePopover();
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
    util: { esc: esc, escAttr: esc, fmtDate: fmtDate, today: today, forwardIframeKeys: forwardIframeKeys, newTargets: (palette && palette.newTargets) ? palette.newTargets : function() { return []; } },
    mode: mode,
    keys: keys,
    coverage: coverage,
    nav: nav,
    dropdown: dropdown,
    palette: palette,
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
            html += '<div class="tb-notif-item" data-id="' + esc(n.id) + '">'
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
          // Wire per-item click → mark read
          dd.querySelectorAll('.tb-notif-item').forEach(function (item) {
            item.onclick = function () {
              var id = item.dataset.id;
              fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'notifications.mark_read', companyId: company, ids: [id] }) })
                .then(function () { _refreshNotifBadge(); item.style.opacity = '0.4'; });
            };
          });
        }
        // Wire inbox link (§4) — present in both empty and non-empty cases
        var _il = document.getElementById('tb-notif-inbox-link');
        if (_il) _il.onclick = function () { dd.hidden = true; window.fbNavigate('/' + company + '/inbox'); };
      })
      .catch(function () { dd.innerHTML = '<div class="tb-notif-empty">Failed to load.</div>'; });
  }

  // Wire the bell button
  var notifBtn = document.getElementById('tb-notif-btn');
  if (notifBtn) notifBtn.addEventListener('click', function (e) { e.preventDefault(); _toggleNotifDropdown(); });
  // Close dropdown on outside click
  document.addEventListener('click', function (e) {
    var dd = document.getElementById('tb-notif-dropdown');
    if (!dd || dd.hidden) return;
    if (!dd.contains(e.target) && e.target.id !== 'tb-notif-btn' && !e.target.closest('#tb-notif-btn')) {
      dd.hidden = true;
    }
  });

  // ── topbar-chrome-spec §5: `+` New menu — reuses newTargets() ─────
  // Wired on DOMContentLoaded since fb-core.js loads in <head> (before body).
  function _populateNewMenu() {
    var dd = document.getElementById('tb-new-dropdown');
    if (!dd) return;
    var getNT = (window.FB && FB.util && FB.util.newTargets) ? FB.util.newTargets : function () { return []; };
    var items = getNT();
    if (!items.length) {
      // Catalog not loaded yet — trigger fetch and retry shortly
      dd.innerHTML = '<div class="tb-new-empty">Loading…</div>';
      if (window.FB && FB.palette && FB.palette.preloadCatalog) FB.palette.preloadCatalog();
      setTimeout(_populateNewMenu, 300);
      return;
    }
    var html = '';
    items.forEach(function (item) {
      var route = item.route || '';
      var label = item.label || item.id || '';
      html += '<div class="tb-new-item" data-route="' + esc(route) + '">' + esc(label) + '</div>';
    });
    dd.innerHTML = html;
    dd.querySelectorAll('.tb-new-item').forEach(function (el) {
      el.onclick = function () {
        var match = items.filter(function (i) { return i.route === el.dataset.route; });
        if (match.length && match[0].exec) match[0].exec();
        dd.hidden = true;
      };
    });
  }
  function _wireNewMenu() {
    var newBtn = document.getElementById('tb-new-btn');
    if (!newBtn) return;
    // Preload the action catalog so newTargets() returns items on first click
    if (window.FB && FB.palette && FB.palette.preloadCatalog) FB.palette.preloadCatalog();
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
