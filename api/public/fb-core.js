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
  //     run:    fn(e)                   — the action
  //   }]
  // }
  // Unmatched keys fall through untouched: in INSERT they type into inputs;
  // in NORMAL they reach common.js's global handler (h/l/{/}/etc.), exactly
  // as the pre-FB capture/bubble split behaved.
  var _sets = {};
  var _order = [];

  function _matchBinding(set, e, m) {
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
    for (var i = 0; i < _order.length; i++) {
      var set = _sets[_order[i]];
      if (!set) continue;
      if (set.active && !set.active()) continue;
      var m = set.getMode ? set.getMode() : 'NORMAL';
      // Typing in a field: NORMAL-mode verbs stay inert (INSERT bindings
      // legitimately fire from inputs — that is where INSERT lives).
      if (m === 'NORMAL' && _isEditableTarget(e)) continue;
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
    // set (journal/bank/settings/dashboard) → silent no-op.
    if (e.key === '?') {
      var cur = _activeSet();
      if (!cur) return;
      var cm = cur.set.getMode ? cur.set.getMode() : 'NORMAL';
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
    var base = KEY_LABELS[b.key] || b.key;
    if (b.when && (b.key === 'Enter' || b.key === ' ')) {
      try {
        if (b.when({ key: b.key, ctrlKey: true })) return 'Ctrl+' + base;
        if (b.when({ key: b.key, metaKey: true })) return 'Cmd+' + base;
      } catch (e) { /* probing a when() must never break hint rendering */ }
    }
    return base;
  }

  // ── `?` help overlay (roadmap P1-6) ───────────────────────────────────────
  // Which-key-style overlay of the ACTIVE binding set — EXHAUSTIVE (every
  // binding carrying a hint, NORMAL and INSERT sections), where the sidebar
  // panel is the curated hintBar subset. Same table, same grouping → cannot
  // drift from dispatch. The keyboard trigger lives in _dispatch (NORMAL
  // mode + not-typing guard); help.open() is the mouse-parity entry point
  // (topbar `?` button) and is deliberately not mode-gated — read-only
  // documentation, closable with Esc like any overlay.
  var help = (function () {
    var _el = null;
    var _prevFocus = null;

    function _rows(groups) {
      return groups.map(function (g) {
        return '<div class="fb-hint-row"><kbd>' + esc(g.keys) + '</kbd><span>' + esc(g.hint) + '</span></div>';
      }).join('');
    }

    function open() {
      if (_el) return true;
      var cur = _activeSet();
      if (!cur) return false; // no FB.keys set on this page — silent no-op
      var hinted = cur.set.bindings.filter(function (b) { return !!b.hint; });
      if (!hinted.length) return false;
      var normal = hinted.filter(function (b) { return (b.mode || 'NORMAL') === 'NORMAL'; });
      var insert = hinted.filter(function (b) { return (b.mode || 'NORMAL') === 'INSERT'; });
      var footer = _rows([{ keys: '?', hint: 'close' }, { keys: 'Esc', hint: 'close' }]);
      _prevFocus = document.activeElement;
      _el = document.createElement('div');
      _el.id = 'fb-keys-overlay';
      _el.innerHTML =
        '<div class="fb-keys-panel" role="dialog" aria-label="Keyboard shortcuts">' +
          '<div class="fb-keys-title">Keyboard shortcuts <span class="fb-keys-page">' + esc(cur.name) + '</span></div>' +
          '<div class="fb-keys-cols">' +
            '<div class="fb-keys-col"><div class="fb-keys-mode">NORMAL</div>' +
              (normal.length ? _rows(_groupHints(normal)) : '<div class="fb-hint-row fb-keys-none">—</div>') +
            '</div>' +
            '<div class="fb-keys-col"><div class="fb-keys-mode">INSERT</div>' +
              (insert.length ? _rows(_groupHints(insert)) : '<div class="fb-hint-row fb-keys-none">—</div>') +
            '</div>' +
          '</div>' +
          '<div class="fb-keys-footer">' + footer + '</div>' +
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
    // True when any registered set is currently active — common.js uses this
    // to suspend its legacy focus-driven mode tracking on migrated pages.
    hasActive: function () {
      for (var i = 0; i < _order.length; i++) {
        var set = _sets[_order[i]];
        if (set && set.active && set.active()) return true;
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
    // `?` keyboard-shortcut overlay (P1-6) — exhaustive which-key view of the
    // active binding set. Keyboard trigger is in _dispatch; this is the
    // programmatic/mouse-parity handle (topbar `?` button).
    help: help
  };

  // ── generic row navigation (for tabs as they migrate) ─────────────────────
  // Sticky boundaries (no deselect at top/bottom), focus class management,
  // scroll-into-view. Bills keeps its bespoke cursor (fold-aware scrolling);
  // this is the target API for Vendors/Bank/Journal list migrations.
  var nav = {
    create: function (opts) {
      // opts: rows() → [el], focusClass (default 'nav-row-focus'),
      //       onFocus(el) optional hook, scrollIntoView opts override
      var focusClass = opts.focusClass || 'nav-row-focus';
      var cur = null;

      function set(el) {
        if (cur) cur.classList.remove(focusClass);
        cur = el || null;
        if (!cur) return;
        cur.classList.add(focusClass);
        cur.scrollIntoView({ block: 'nearest' });
        if (opts.onFocus) opts.onFocus(cur);
      }

      return {
        set: set,
        clear: function () { set(null); },
        current: function () { return cur; },
        move: function (dir) {
          var rows = opts.rows();
          if (!rows.length) return;
          var i = rows.indexOf(cur);
          if (i === -1) { set(dir > 0 ? rows[0] : rows[rows.length - 1]); return; }
          var n = i + dir;
          if (n < 0 || n >= rows.length) return; // sticky at boundaries
          set(rows[n]);
        },
        first: function () { var r = opts.rows(); if (r.length) set(r[0]); },
        last: function () { var r = opts.rows(); if (r.length) set(r[r.length - 1]); }
      };
    }
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
        if (document.activeElement !== input) return; // background sets (blur handlers etc.) never open the dd
        var q = input.value.trim();
        if (!q) { _close(inst); return; } // empty query closes (ArrowDown re-opens full list)
        _openWith(inst, q);
      });
      input.addEventListener('blur', function () { setTimeout(function () { _close(inst); }, 150); });
      // opts.keys: self-bind the behavior-contract keys on the input — for
      // pages that do not route through FB.keys (journal-new, bank,
      // bank-import, settings). FB.keys pages leave this off and wire
      // move/pick/close via their binding tables instead.
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

    return {
      attach: attach,
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

  window.FB = {
    util: { esc: esc, escAttr: esc, fmtDate: fmtDate, today: today },
    mode: mode,
    keys: keys,
    nav: nav,
    dropdown: dropdown
  };

  // Legacy global so template-string pages can drop their local esc copies.
  window.esc = esc;
})();
