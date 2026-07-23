/**
 * fb-list.js — FB.list: the ONE editable-list component (P3 consolidation).
 *
 * Every flat list in the app (Settings registers, Vendors, …) is the same
 * machine:
 *   - a pinned ghost row (the single create slot) saying "Edit me to add new
 *     entry", opened with i / Enter / click — never open for entry itself
 *   - saved rows overlaid with dirty buffers (merged view, new pinned top)
 *   - row-level INSERT edit (i / Enter / click), Esc exits — never saves
 *   - w writes a dirty row, u reverts it, x deletes (confirm for saved rows)
 *   - j/k nav includes the ghost row (sticky at top)
 *   - a shared leave-guard modal when navigating away with unsaved rows
 *
 * A screen declares columns + actions; the framework owns ALL behavior.
 *
 * Config:
 *   keysId     FB.keys registration name ('settings-periods')
 *   active     fn → bool: is this list's tab visible
 *   tbody      element id of the table body
 *   msg        element id for status/error messages (optional)
 *   companyId  fn → company id for /api/action payloads
 *   columns    [{ field, type, width, align, ro, uppercase, step, options,
 *                 nullable, display, attach }]
 *              field    buffer property name (also data-field + input class)
 *              type     'text' (default) | 'date' | 'number' | 'checkbox' | 'select'
 *              ro       'saved' → read-only when editing a SAVED row (key col)
 *                       'always' → display-only in BOTH modes (badges, source)
 *              options  select values: ['a','b'] or [{value,label}]; '' = '- none -'
 *              nullable select: '' harvests as null
 *              display  fn(value, row) → HTML for view mode (default: esc or —)
 *              attach   fn(input, tr) — post-build hook (FB.dropdown, etc.)
 *   blank()    → new-row buffer defaults
 *   isBlank(b) → true when a NEW buffer is untouched (vanishes on Esc)
 *   same(b, s) → true when buffer matches saved row (dirty dropped)
 *   validate(d)→ error string | null
 *   editable(d)→ bool (default true); false = row never enters edit (ECB rates)
 *   deletable(d)→ bool (default true); false = x is a no-op on that row
 *   rowStyle(d)→ cssText for the <tr> (e.g. opacity for ECB rows)
 *   firstField(isNew) → field to focus when entering edit
 *   track      FB.track.create name for creates (optional)
 *   label      ghost-row text (default 'Edit me to add new entry')
 *   list       { action } | { url } + map(raw) → saved row incl. _key
 *   save       { action, body(d) → payload extras, focusKey(d, res) → key }
 *   del        { action, body(d) → payload extras, confirm(d) → string } | null
 *   onChrome   fn(anyDirty) — tab dot / dirty-tab bookkeeping (optional)
 *   onFocus    fn(tr) — nav focus hook (compat globals; optional)
 *   focusClass nav highlight class (default 'nav-row-focus')
 *   extraBindings fn(api) → [bindings] appended to the NORMAL set (optional)
 *   filter     fn(row, q) → bool (optional; enables setFilter)
 *
 * Instance: { load, render, anyDirty, mounted, writeAllDirty, discardAll,
 *            renderHints, setFilter, nav }
 */
(function () {
  'use strict';

  var instances = []; // live lists — the shared leave-guard consults these

  function el(id) { return document.getElementById(id); }
  function showMsg(id, text, isErr) {
    var m = el(id);
    if (!m) return;
    m.textContent = text || '';
    m.style.color = isErr ? '#cc2222' : '#2a8a2a';
  }

  function create(cfg) {
    // Replace any prior instance with the same keysId (soft-nav re-execution).
    for (var z = instances.length - 1; z >= 0; z--) {
      if (instances[z].keysId === cfg.keysId) instances.splice(z, 1);
    }

    var saved = [];
    var dirty = {};
    var editIdx = -1;
    var ghostN = 0;
    var filterQ = '';
    var nav = null;

    function tbody() { return el(cfg.tbody); }
    function rows() { return Array.from(tbody().querySelectorAll('tr:not(.fb-ghost-row)')); }
    function navRows() { return Array.from(tbody().querySelectorAll('tr')); }
    function msg(t, e) { showMsg(cfg.msg, t, e); }

    function post(action, extra) {
      return fetch('/api/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ action: action, companyId: cfg.companyId() }, extra || {}))
      }).then(function (r) { return r.json(); });
    }

    // ── Model ────────────────────────────────────────────────────────────
    // Saved rows overlaid with their dirty buffers; dirty-new pinned top.
    function merged() {
      var out = saved.map(function (s) {
        var d = dirty[s._key];
        if (d) return Object.assign({}, d, { _dirty: true, _key: s._key, _isNew: false });
        return Object.assign({}, s, { _dirty: false, _key: s._key, _isNew: false });
      });
      Object.keys(dirty).forEach(function (k) {
        var d = dirty[k];
        if (d && d.isNew) out.unshift(Object.assign({}, d, { _dirty: true, _key: k, _isNew: true }));
      });
      if (filterQ && cfg.filter) out = out.filter(function (r) { return cfg.filter(r, filterQ); });
      return out;
    }
    function anyDirty() { return editIdx >= 0 || Object.keys(dirty).length > 0; }
    function mounted() { return !!tbody(); }
    function syncChrome() { if (cfg.onChrome) cfg.onChrome(anyDirty()); }

    // ── Render ───────────────────────────────────────────────────────────
    // The ghost row is a GRAYED-OUT REPLICA of the live edit row: same inputs
    // (disabled), selects at their defaults, checkbox, grayed ✓/✕. While a new
    // row is being created the ghost IS the edit row (navy) — on exit it fades
    // back to the grayed replica.
    function ghostCell(c, d, isFirstText) {
      var val = d[c.field];
      if (c.ro === 'always') return c.display ? c.display(val, d) : defaultDisplay(val);
      var cls = 'fb-e-' + c.field;
      var w = c.width ? ' style="width:' + c.width + 'px"' : '';
      if (c.type === 'checkbox') {
        return '<input type="checkbox" class="' + cls + '" disabled' + (val ? ' checked' : '') + '>';
      }
      if (c.type === 'date') {
        return '<input type="date" class="' + cls + '" disabled' + w + '>';
      }
      if (c.type === 'number') {
        return '<input type="number" class="' + cls + '" value="' + (val != null ? val : 0) + '" disabled'
          + (c.step ? ' step="' + c.step + '"' : '') + w + '>';
      }
      if (c.type === 'select') {
        var opts = (c.options || []).map(function (o) {
          var v = typeof o === 'string' ? o : o.value;
          var label = typeof o === 'string' ? (o || '- none -') : o.label;
          return '<option value="' + esc(v) + '"' + (v === (val || '') ? ' selected' : '') + '>' + esc(label) + '</option>';
        }).join('');
        return '<select class="' + cls + '" disabled' + w + '>' + opts + '</select>';
      }
      return '<input type="text" class="' + cls + '" value="" disabled' + w
        + (isFirstText ? ' placeholder="' + esc(cfg.label || 'Edit me to add new entry') + '"' : '') + '>';
    }
    function ghostHtml() {
      var d = Object.assign(cfg.blank(), { _isNew: true });
      var firstTextSeen = false;
      var tds = cfg.columns.map(function (c) {
        var isFirstText = false;
        if (!firstTextSeen && (!c.type || c.type === 'text')) { isFirstText = true; firstTextSeen = true; }
        return '<td data-field="' + c.field + '"' + (c.align === 'center' ? ' style="text-align:center"' : '') + '>' + ghostCell(c, d, isFirstText) + '</td>';
      }).join('');
      return '<tr class="fb-ghost-row" style="cursor:text">' + tds
        + '<td class="row-actions"><a class="chip chip-ok fb-ghost-chip" tabindex="-1">✓</a> '
        + '<a class="chip chip-cancel fb-ghost-chip" tabindex="-1">✕</a></td></tr>';
    }
    function hideGhost(tb) {
      var g = tb.querySelector('.fb-ghost-row');
      if (g) g.style.display = 'none';
    }
    function defaultDisplay(v) {
      return (v !== null && v !== undefined && v !== '') ? esc(String(v)) : '<span class="pe-ro">—</span>';
    }
    function rowHtml(d, i) {
      var cells = cfg.columns.map(function (c) {
        var v = c.display ? c.display(d[c.field], d) : defaultDisplay(d[c.field]);
        if (d._dirty) v = '<span class="dirty-val">' + v + '</span>';
        return '<td data-field="' + c.field + '"' + (c.align === 'center' ? ' style="text-align:center"' : '') + '>' + v + '</td>';
      }).join('');
      var actions = d._dirty
        ? '<a class="chip chip-ok" title="write (w)" data-act="write">✓</a> <a class="chip chip-cancel" title="revert (u)" data-act="revert">✕</a>'
        : '';
      return '<tr' + (d._dirty ? ' class="row-dirty"' : '') + ' data-idx="' + i + '" data-key="' + esc(String(d._key)) + '"'
        + (cfg.rowStyle ? ' style="' + cfg.rowStyle(d) + '"' : '') + '>'
        + cells + '<td class="row-actions">' + actions + '</td></tr>';
    }
    function wireChips(tb) {
      Array.from(tb.querySelectorAll('[data-act]')).forEach(function (a) {
        a.addEventListener('click', function (e) {
          e.stopPropagation();
          var tr = a.closest('tr');
          var i = +tr.dataset.idx;
          if (a.dataset.act === 'write') writeAt(i);
          else if (a.dataset.act === 'revert') revertAt(i);
          else if (a.dataset.act === 'exit') exitEdit();
        });
      });
    }
    function render(focusKey) {
      var tb = tbody();
      if (!tb) return;
      var m = merged();
      tb.innerHTML = ghostHtml() + m.map(rowHtml).join('');
      rows().forEach(function (tr) {
        tr.addEventListener('click', function (e) {
          if (nav) nav.set(tr);
          var td = e.target.closest('td');
          if (!td || td.classList.contains('row-actions')) return;
          var d = merged()[+tr.dataset.idx];
          if (cfg.editable && d && !cfg.editable(d)) return; // read-only row
          enterEdit(+tr.dataset.idx, td.dataset.field || undefined);
        });
      });
      wireChips(tb);
      var g = tb.querySelector('.fb-ghost-row');
      if (g) g.addEventListener('click', function () { newRow(); });
      if (nav) {
        var target = focusKey != null ? tb.querySelector('tr[data-key="' + focusKey + '"]') : null;
        nav.set(target || navRows()[0] || null); // default: ghost row (top)
      }
    }

    // ── Edit ─────────────────────────────────────────────────────────────
    function editCell(c, d) {
      var val = d[c.field];
      if (c.ro === 'always') return c.display ? c.display(val, d) : defaultDisplay(val);
      if (c.ro === 'saved' && !d._isNew) {
        return '<span class="pe-ro">' + esc(val == null ? '' : String(val)) + '</span>';
      }
      var cls = 'fb-e-' + c.field;
      var w = c.width ? ' style="width:' + c.width + 'px"' : '';
      if (c.type === 'checkbox') {
        return '<input type="checkbox" class="' + cls + '"' + (val ? ' checked' : '') + '>';
      }
      if (c.type === 'date') {
        return '<input type="date" class="' + cls + '" value="' + esc(val || '') + '"' + w + '>';
      }
      if (c.type === 'number') {
        return '<input type="number" class="' + cls + '" value="' + (val != null ? val : 0) + '"'
          + (c.step ? ' step="' + c.step + '"' : '') + w + '>';
      }
      if (c.type === 'select') {
        var opts = (c.options || []).map(function (o) {
          var v = typeof o === 'string' ? o : o.value;
          var label = typeof o === 'string' ? (o || '- none -') : o.label;
          return '<option value="' + esc(v) + '"' + (v === (val || '') ? ' selected' : '') + '>' + esc(label) + '</option>';
        }).join('');
        return '<select class="' + cls + '"' + w + '>' + opts + '</select>';
      }
      return '<input type="text" class="' + cls + '" value="' + esc(val == null ? '' : String(val)) + '"' + w
        + (c.uppercase ? ' oninput="this.value=this.value.toUpperCase()"' : '') + '>';
    }
    function editable(c, d) { return !(c.ro === 'saved' && !d._isNew) && c.ro !== 'always'; }

    function enterEdit(idx, field) {
      if (editIdx === idx) return;
      var d0 = merged()[idx];
      if (!d0) return;
      if (cfg.editable && !cfg.editable(d0)) return; // read-only row (e.g. ECB rate)
      if (editIdx >= 0) exitEdit(); // click-away: exit, dirty buffer kept
      var d = merged()[idx];
      var tr = rows()[idx];
      if (!d || !tr) return;
      editIdx = idx;
      tr.innerHTML = cfg.columns.map(function (c) {
        return '<td data-field="' + c.field + '"' + (c.align === 'center' ? ' style="text-align:center"' : '') + '>' + editCell(c, d) + '</td>';
      }).join('')
        + '<td class="row-actions"><a class="chip chip-ok" title="write (w)" data-act="write">✓</a> '
        + '<a class="chip chip-cancel" title="exit (Esc)" data-act="exit">✕</a></td>';
      wireChips(tbody());
      tr.classList.add('row-editing');
      if (d._isNew) hideGhost(tbody()); // ghost transforms INTO the edit row
      cfg.columns.forEach(function (c) {
        if (c.attach && editable(c, d)) {
          var inp = tr.querySelector('.fb-e-' + c.field);
          if (inp) c.attach(inp, tr);
        }
      });
      if (window.FB && FB.mode) FB.mode.set('INSERT');
      window.fbEditActive = true;
      var f = (field && cfg.columns.some(function (c) { return c.field === field && editable(c, d); }))
        ? field : cfg.firstField(d._isNew);
      var target = tr.querySelector('.fb-e-' + f) || tr.querySelector('input,select');
      if (target) { target.focus(); if (target.select) target.select(); }
      syncChrome();
    }

    // Esc: harvest inputs into the dirty buffer — NEVER saves. An untouched
    // new row vanishes; a saved row restored to its values drops its buffer.
    function exitEdit() {
      if (editIdx < 0) return;
      var d = merged()[editIdx];
      var tr = rows()[editIdx];
      if (d && tr) {
        var buf = {};
        cfg.columns.forEach(function (c) {
          var inp = tr.querySelector('.fb-e-' + c.field);
          if (!inp) { buf[c.field] = d[c.field]; return; } // ro column: keep
          if (c.type === 'checkbox') buf[c.field] = inp.checked;
          else if (c.type === 'number') buf[c.field] = parseFloat(inp.value) || 0;
          else if (c.type === 'select') buf[c.field] = c.nullable ? (inp.value || null) : inp.value;
          else {
            var v = inp.value.trim();
            buf[c.field] = c.uppercase ? v.toUpperCase() : v;
          }
        });
        if (d._isNew) {
          if (!cfg.isBlank(buf)) dirty[d._key] = Object.assign(buf, { isNew: true });
          else delete dirty[d._key]; // nothing from nothing
        } else {
          var s = null;
          for (var i = 0; i < saved.length; i++) if (saved[i]._key === d._key) s = saved[i];
          if (s && cfg.same(buf, s)) delete dirty[d._key];
          else dirty[d._key] = Object.assign(buf, { isNew: false });
        }
      }
      var key = d ? d._key : null;
      editIdx = -1;
      if (window.FB && FB.mode) FB.mode.set('NORMAL');
      window.fbEditActive = false;
      render(key);
      syncChrome();
    }

    // ── Write / revert / delete / new ────────────────────────────────────
    function writeAt(idx) {
      if (editIdx >= 0) exitEdit();
      var d = merged()[idx];
      if (!d || !d._dirty) return Promise.resolve(true);
      var err = cfg.validate(d);
      if (err) { msg(err, true); return Promise.resolve(false); }
      return post(cfg.save.action, cfg.save.body(d)).then(function (res) {
        var dd = res.data || res;
        if ((dd && dd.error) || res.error) { msg(dd.error || res.error, true); return false; } // stays dirty
        delete dirty[d._key];
        msg('Saved', false);
        load(cfg.save.focusKey ? cfg.save.focusKey(d, dd) : d._key);
        return true;
      }).catch(function (e) { msg(e.message, true); return false; });
    }

    function revertAt(idx) {
      if (editIdx >= 0) exitEdit();
      var d = merged()[idx];
      if (!d || !d._dirty) return;
      delete dirty[d._key];
      render(d._isNew ? null : d._key);
      syncChrome();
    }

    function deleteFocused() {
      var idx = focusedIdx();
      if (idx < 0) return;
      var d = merged()[idx];
      if (!d) return;
      if (d._isNew) { delete dirty[d._key]; render(); syncChrome(); return; }
      if (!cfg.del) return;
      if (cfg.deletable && !cfg.deletable(d)) return; // read-only row (e.g. ECB rate)
      if (!confirm(cfg.del.confirm(d))) return;
      post(cfg.del.action, cfg.del.body(d)).then(function (res) {
        var dd = res.data || res;
        if ((dd && dd.error) || res.error) { msg(dd.error || res.error, true); return; } // verbatim (INVALID_STATE etc.)
        delete dirty[d._key];
        load();
      }).catch(function (e) { msg(e.message, true); });
    }

    function newRow() {
      if (editIdx >= 0) exitEdit();
      var key = '_new_' + (++ghostN);
      dirty[key] = Object.assign(cfg.blank(), { isNew: true });
      render(key);
      enterEdit(0, cfg.firstField(true)); // new rows unshift to index 0 (pinned top)
      if (window.FB && FB.track && cfg.track) FB.track.create(cfg.track);
    }

    // ── Load ─────────────────────────────────────────────────────────────
    function load(focusKey) {
      if (!tbody()) return Promise.resolve();
      var p = cfg.list.url
        ? fetch(cfg.list.url()).then(function (r) { return r.json(); })
        : post(cfg.list.action, cfg.list.body ? cfg.list.body() : {});
      return p.then(function (rowsRaw) {
        var rowsData = rowsRaw.data || rowsRaw;
        saved = (Array.isArray(rowsData) ? rowsData : []).map(cfg.list.map);
        render(focusKey);
        syncChrome();
        if (cfg.onLoaded) cfg.onLoaded(saved);
      }).catch(function (e) { console.error('FB.list load:', e); });
    }

    // ── Cursor + field movement ──────────────────────────────────────────
    function focusedIdx() {
      var tr = nav && nav.current();
      if (!tr || tr.classList.contains('fb-ghost-row')) return -1;
      var i = +tr.dataset.idx;
      return isNaN(i) ? -1 : i;
    }
    function focusedDirty() {
      var idx = focusedIdx();
      var d = idx >= 0 ? merged()[idx] : null;
      return !!(d && d._dirty);
    }
    function editFocused() {
      var tr = nav && nav.current();
      if (tr && tr.classList.contains('fb-ghost-row')) { newRow(); return; } // i on ghost = create
      var idx = focusedIdx();
      var d = idx >= 0 ? merged()[idx] : null;
      if (d && cfg.editable && !cfg.editable(d)) return; // read-only row
      enterEdit(idx >= 0 ? idx : 0);
    }
    function advanceField() {
      var tr = rows()[editIdx];
      if (!tr) return;
      var inputs = Array.from(tr.querySelectorAll('input,select'));
      var i = inputs.indexOf(document.activeElement);
      if (i >= 0 && i < inputs.length - 1) { inputs[i + 1].focus(); if (inputs[i + 1].select) inputs[i + 1].select(); }
    }
    function tabSticky(e) {
      var tr = rows()[editIdx];
      if (!tr) return false;
      var inputs = Array.from(tr.querySelectorAll('input,select'));
      if (!inputs.length) return false;
      var i = inputs.indexOf(document.activeElement);
      return e.shiftKey ? i === 0 : i === inputs.length - 1;
    }

    // ── Keys ─────────────────────────────────────────────────────────────
    function firstEditInput() {
      var tr = rows()[editIdx];
      return tr ? tr.querySelector('input,select') : null;
    }
    function lastEditInput() {
      var tr = rows()[editIdx];
      if (!tr) return null;
      var inputs = tr.querySelectorAll('input,select');
      return inputs.length ? inputs[inputs.length - 1] : null;
    }
    var ddOpen = function () { return !!(window.FB && FB.dropdown && FB.dropdown.isOpen()); };
    var bindings = [
      { key: 'j', mode: 'NORMAL', hint: 'navigate', hintBar: true, run: function () { nav.move(1); } },
      { key: 'k', mode: 'NORMAL', hint: 'navigate', hintBar: true, run: function () { nav.move(-1); } },
      { key: 'i', mode: 'NORMAL', hint: 'edit', hintBar: true, run: editFocused },
      { key: 'Enter', mode: 'NORMAL', hint: 'edit', hintBar: true, run: editFocused },
      { key: 'w', mode: 'NORMAL', hint: 'write', hintBar: true, when: focusedDirty, run: function () { var i = focusedIdx(); if (i >= 0) writeAt(i); } },
      { key: 'u', mode: 'NORMAL', hint: 'revert', hintBar: true, when: focusedDirty, run: function () { var i = focusedIdx(); if (i >= 0) revertAt(i); } },
      // ── INSERT: dropdown open (dropdown-specific bindings precede general ones —
      // FB.keys takes the FIRST binding whose key+mode+when match) ──
      { key: 'ArrowDown', mode: 'INSERT', when: ddOpen, run: function () { FB.dropdown.move(1); } },
      { key: 'ArrowUp', mode: 'INSERT', when: ddOpen, run: function () { FB.dropdown.move(-1); } },
      { key: 'Enter', mode: 'INSERT', when: ddOpen, run: function () { FB.dropdown.pick(); } },
      { key: 'Tab', mode: 'INSERT', when: ddOpen, swallow: false, preventDefault: false,
        run: function (e) {
          FB.dropdown.pick();
          if (e.shiftKey ? document.activeElement === firstEditInput() : document.activeElement === lastEditInput()) e.preventDefault();
        } },
      { key: 'Escape', mode: 'INSERT', when: ddOpen, run: function () { FB.dropdown.close(); } },
      // ── INSERT: dropdown closed — ArrowDown on a dropdown field opens the list ──
      { key: 'ArrowDown', mode: 'INSERT', when: function (e) { return !ddOpen() && FB.dropdown && FB.dropdown.attachable(e.target); },
        run: function (e) { FB.dropdown.openFull(e.target); } },
      // ── INSERT: general ──
      { key: 'Escape', mode: 'INSERT', hint: 'exit edit', hintBar: true, run: exitEdit },
      { key: 'Enter', mode: 'INSERT', run: advanceField },
      { key: 'Tab', mode: 'INSERT', when: tabSticky, run: function () {} },
      { key: 'Tab', mode: 'INSERT', swallow: false, preventDefault: false, run: function () {} }
    ];
    if (cfg.del) {
      bindings.splice(4, 0, { key: 'x', mode: 'NORMAL', hint: 'delete', hintBar: true, run: deleteFocused });
    }
    function registerKeys() {
      if (!(window.FB && FB.keys)) return;
      nav = FB.nav.create({ rows: navRows, focusClass: cfg.focusClass || 'nav-row-focus', onFocus: cfg.onFocus || undefined });
      if (FB.keys.unregister) FB.keys.unregister(cfg.keysId);
      var all = cfg.extraBindings ? bindings.concat(cfg.extraBindings(api)) : bindings;
      FB.keys.register(cfg.keysId, {
        active: cfg.active,
        getMode: function () { return editIdx >= 0 ? 'INSERT' : 'NORMAL'; },
        bindings: all
      });
    }
    wireLeaveGuard();

    var api = {
      keysId: cfg.keysId,
      load: load,
      render: render,
      anyDirty: anyDirty,
      mounted: mounted,
      renderHints: function (hintEl) { if (window.FB && FB.keys) FB.keys.renderHints(cfg.keysId, hintEl, { layout: 'list' }); },
      setFilter: function (q) {
        filterQ = q || '';
        if (editIdx >= 0) { editIdx = -1; if (window.FB && FB.mode) FB.mode.set('NORMAL'); window.fbEditActive = false; }
        render();
        syncChrome();
      },
      nav: function () { return nav; },
      focusedRow: function () { var i = focusedIdx(); return i >= 0 ? merged()[i] : null; },
      writeAllDirty: writeAllDirty,
      discardAll: discardAll
    };
    registerKeys();
    instances.push(api);
    return api;

    // Write every dirty row in sequence (leave-guard Save). Resolves true
    // only when ALL writes succeeded.
    function writeAllDirty() {
      var keys = Object.keys(dirty);
      var chain = Promise.resolve(true);
      keys.forEach(function (k) {
        chain = chain.then(function (ok) {
          if (!ok) return false;
          var m = merged();
          for (var i = 0; i < m.length; i++) if (m[i]._key === k) return writeAt(i);
          return true;
        });
      });
      return chain;
    }

    function discardAll() {
      if (editIdx >= 0) { editIdx = -1; if (window.FB && FB.mode) FB.mode.set('NORMAL'); window.fbEditActive = false; }
      dirty = {};
      render();
      syncChrome();
    }
  }

  // ── Shared leave-guard (spec §4): one modal for every FB.list on the page ──
  var leaveWired = false;
  function dirtyInstances() {
    return instances.filter(function (i) { return i.mounted() && i.anyDirty(); });
  }
  function closeLeaveModal() {
    var ov = document.getElementById('fb-list-leave-overlay');
    if (ov) ov.remove();
  }
  function openLeaveModal(proceed) {
    closeLeaveModal();
    var ov = document.createElement('div');
    ov.id = 'fb-list-leave-overlay';
    ov.className = 'fb-modal-overlay';
    ov.innerHTML = '<div class="fb-modal">'
      + '<div class="fb-modal-title">Unsaved changes</div>'
      + '<div class="fb-modal-body">Rows have unsaved changes.</div>'
      + '<div class="fb-modal-err" id="fb-list-leave-err"></div>'
      + '<div class="fb-modal-btns">'
      + '<button class="btn-sm danger" id="fbl-discard">Discard</button>'
      + '<button class="btn-sm" id="fbl-stay">Stay</button>'
      + '<button class="btn-primary" id="fbl-save">Save</button>'
      + '</div></div>';
    ov.addEventListener('click', function (e) { if (e.target === ov) closeLeaveModal(); });
    document.body.appendChild(ov);
    document.getElementById('fbl-stay').onclick = closeLeaveModal;
    document.getElementById('fbl-discard').onclick = function () {
      dirtyInstances().forEach(function (i) { i.discardAll(); });
      closeLeaveModal();
      proceed();
    };
    document.getElementById('fbl-save').onclick = function () {
      var chain = Promise.resolve(true);
      dirtyInstances().forEach(function (i) {
        chain = chain.then(function (ok) { return ok ? i.writeAllDirty() : false; });
      });
      chain.then(function (ok) {
        if (ok) { closeLeaveModal(); proceed(); }
        else document.getElementById('fb-list-leave-err').textContent = 'Some rows could not be saved — fix them or Discard.';
      });
    };
  }
  function wireLeaveGuard() {
    if (leaveWired) return;
    leaveWired = true;
    // Leave-veto for {/} page navigation (common.js consults this before fbNavigate).
    window.fbBeforeTabSwitch = function (href) {
      if (!dirtyInstances().length) return true;
      openLeaveModal(function () { fbNavigate(href); });
      return false;
    };
    // Sidebar link clicks get the same treatment — mouse parity for {/}.
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('.sb-nav a[href]') : null;
      if (!a) return;
      if (dirtyInstances().length) {
        e.preventDefault();
        e.stopPropagation();
        openLeaveModal(function () { fbNavigate(a.getAttribute('href')); });
      }
    }, true);
  }

  window.FB = window.FB || {};
  FB.list = {
    create: create,
    // Page-level guard API: in-page tab switches use the same modal as page nav.
    anyDirty: function () { return dirtyInstances().length > 0; },
    guard: function (proceed) { openLeaveModal(proceed); }
  };
})();
