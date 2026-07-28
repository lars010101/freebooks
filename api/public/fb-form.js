/* fb-form.js — the one form machine (K3, docs/keyboard-ux-spec §8)
 *
 * Model B (ratified 2026-07-28): NORMAL rest state + Tab/Shift+Tab inside
 * edits — explicitly NOT QBO always-insert. Same doctrine as FB.list, for
 * document screens: navigate in NORMAL, Enter/`i` edits the cell under the
 * cursor (INSERT), Esc returns to NORMAL (never writes), verbs are single
 * keys, and the global chrome (g-map, palette, {?/}, ?) stays alive because a
 * NORMAL state exists.
 *
 * A form = ordered zones (e.g. header fields + a line grid). Each zone
 * exposes rows; each row exposes cells (inputs/selects). The framework owns:
 *   cursor (zone,row,col) — j/k rows, h/l cells, sticky at all boundaries
 *   mode transitions      — i/Enter edit, Esc exit, Enter advances (fb-list parity)
 *   dropdown key routing  — identical INSERT contract as fb-list (move/pick/
 *                           close/open-full), so pages must NOT pass keys:true
 *                           to FB.dropdown (that is for non-FB.keys pages)
 *   focus sync            — mouse click / Tab moves the cursor (mouse parity)
 *   hints                 — FB.keys table drives ?, sidebar hints, palette verbs
 *
 * Pages declare config + verbs only — no per-page key handlers.
 *
 * cfg: {
 *   formId:   string                    — FB.keys set name (+ hint render id)
 *   active?:  fn() → bool               — set liveness (default always)
 *   zones:    [{ id, rows: fn() → [el], cells?: fn(rowEl) → [input] }]
 *             default cells(): visible, enabled input/select/textarea in row
 *   verbs?:   { add?, delete?, write?, quit? } each { key, hint, run(api) }
 *   extraBindings?: fn(api) → [binding] — prepended (screen verbs win)
 * }
 * api: { formId, cur, moveTo(zi,ri,ci,edit), edit(), exitEdit(), refresh(),
 *        mode() }
 */
(function () {
  'use strict';

  function create(cfg) {
    var cur = { z: 0, r: 0, c: 0 };
    var editing = false;
    var ROW_CLS = 'fb-form-row-focus';
    var CELL_CLS = 'fb-form-cursor';

    function zones() { return cfg.zones; }
    function zoneRows(zi) {
      if (zi < 0 || zi >= zones().length) return [];
      return zones()[zi].rows() || [];
    }
    function rowCells(zi, rowEl) {
      var z = zones()[zi];
      if (z.cells) return z.cells(rowEl) || [];
      return Array.prototype.slice.call(rowEl.querySelectorAll('input,select,textarea'))
        .filter(function (el) { return !el.disabled && el.type !== 'hidden'; });
    }

    // Flattened row space: (z,r) pairs in zone order — j/k traverse it as one
    // column, sticky at the form's first/last row.
    function flatRows() {
      var out = [];
      for (var zi = 0; zi < zones().length; zi++) {
        var rs = zoneRows(zi);
        for (var ri = 0; ri < rs.length; ri++) out.push({ z: zi, r: ri });
      }
      return out;
    }

    function clamp() {
      if (cur.z >= zones().length) cur.z = zones().length - 1;
      if (cur.z < 0) cur.z = 0;
      var rs = zoneRows(cur.z);
      if (!rs.length) {
        // Current zone emptied (e.g. reversal panel closed): fall to the
        // FIRST non-empty zone in document order (visual top of the form).
        var zi = -1;
        for (var i = 0; i < zones().length; i++) { if (zoneRows(i).length) { zi = i; break; } }
        if (zi === -1) { cur = { z: 0, r: 0, c: 0 }; return; }
        cur.z = zi; cur.r = 0; cur.c = 0;
        rs = zoneRows(zi);
      }
      // Deleted row under the cursor → same index, next row slides up
      // (vim semantics — never teleport to the top of the form).
      if (cur.r >= rs.length) cur.r = rs.length - 1;
      if (cur.r < 0) cur.r = 0;
      var cs = rowCells(cur.z, rs[cur.r]);
      if (!cs.length) cur.c = 0;
      else if (cur.c >= cs.length) cur.c = cs.length - 1;
      if (cur.c < 0) cur.c = 0;
    }

    function paint() {
      document.querySelectorAll('.' + ROW_CLS).forEach(function (el) { el.classList.remove(ROW_CLS); });
      document.querySelectorAll('.' + CELL_CLS).forEach(function (el) { el.classList.remove(CELL_CLS); });
      var rows = zoneRows(cur.z);
      var rowEl = rows[cur.r];
      if (!rowEl) return;
      rowEl.classList.add(ROW_CLS);
      if (rowEl.scrollIntoView) rowEl.scrollIntoView({ block: 'nearest' });
      var cs = rowCells(cur.z, rowEl);
      var cell = cs[cur.c];
      if (cell) {
        cell.classList.add(CELL_CLS);
        if (cell.scrollIntoView) cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }

    function setMode(insert) {
      if (editing === insert) return;
      editing = insert;
      if (window.FB && FB.mode) FB.mode.set(insert ? 'INSERT' : 'NORMAL');
      window.fbEditActive = insert; // common.js edit-active guard (settings-ux-spec §2)
    }

    function curCellEl() {
      var rows = zoneRows(cur.z);
      if (!rows[cur.r]) return null;
      return rowCells(cur.z, rows[cur.r])[cur.c] || null;
    }

    function edit() {
      var el = curCellEl();
      if (!el) return;
      el.focus();
      if (el.select) el.select();
      setMode(true);
      paint();
    }

    function exitEdit() {
      var ae = document.activeElement;
      if (ae && ae.blur) ae.blur();
      setMode(false);
      paint();
    }

    function moveRow(d) {
      var flat = flatRows();
      if (!flat.length) return;
      var idx = flat.findIndex(function (p) { return p.z === cur.z && p.r === cur.r; });
      if (idx === -1) idx = 0;
      var n = idx + d;
      if (n < 0) n = 0;                       // sticky top
      if (n > flat.length - 1) n = flat.length - 1; // sticky bottom
      cur.z = flat[n].z; cur.r = flat[n].r; cur.c = 0;
      clamp(); paint();
    }

    function moveCol(d) {
      var rows = zoneRows(cur.z);
      var rowEl = rows[cur.r];
      if (!rowEl) return;
      var n = cur.c + d;
      var max = rowCells(cur.z, rowEl).length - 1;
      if (n < 0) n = 0;                       // sticky left
      if (n > max) n = max;                   // sticky right
      cur.c = n;
      paint();
    }

    // Enter in INSERT: advance to the next cell (fb-list advanceField parity) —
    // right, wrapping to the next row's first cell; sticky at the last cell.
    function advance() {
      var flat = flatRows();
      var idx = flat.findIndex(function (p) { return p.z === cur.z && p.r === cur.r; });
      if (idx === -1) return;
      var rowEl = zoneRows(cur.z)[cur.r];
      var ncells = rowCells(cur.z, rowEl).length;
      if (cur.c < ncells - 1) cur.c++;
      else if (idx < flat.length - 1) { cur.z = flat[idx + 1].z; cur.r = flat[idx + 1].r; cur.c = 0; }
      paint();
      var el = curCellEl();
      if (el) el.focus();
    }

    function moveTo(zi, ri, ci, doEdit) {
      cur = { z: zi, r: ri, c: ci };
      clamp(); paint();
      if (doEdit) edit();
    }

    var ddOpen = function () { return !!(window.FB && FB.dropdown && FB.dropdown.isOpen()); };

    var bindings = [
      // ── NORMAL ──
      { key: 'j', mode: 'NORMAL', hint: 'navigate', hintBar: true, run: function () { moveRow(1); } },
      { key: 'k', mode: 'NORMAL', hint: 'navigate', hintBar: true, run: function () { moveRow(-1); } },
      { key: 'h', mode: 'NORMAL', hint: 'cell', hintBar: true, run: function () { moveCol(-1); } },
      { key: 'l', mode: 'NORMAL', hint: 'cell', hintBar: true, run: function () { moveCol(1); } },
      { key: 'i', mode: 'NORMAL', hint: 'edit', hintBar: true, run: edit },
      { key: 'Enter', mode: 'NORMAL', hint: 'edit', hintBar: true, run: edit },
      { key: 'G', mode: 'NORMAL', run: function () {
          var flat = flatRows();
          if (!flat.length) return;
          var last = flat[flat.length - 1];
          cur = { z: last.z, r: last.r, c: 0 };
          clamp(); paint();
        } },
      // ── INSERT: dropdown open (fb-list parity — guarded bindings first) ──
      { key: 'ArrowDown', mode: 'INSERT', when: ddOpen, run: function () { FB.dropdown.move(1); } },
      { key: 'ArrowUp', mode: 'INSERT', when: ddOpen, run: function () { FB.dropdown.move(-1); } },
      { key: 'Enter', mode: 'INSERT', when: ddOpen, run: function () { FB.dropdown.pick(); } },
      { key: 'Tab', mode: 'INSERT', when: ddOpen, swallow: false, preventDefault: false,
        run: function () { FB.dropdown.pick(); } },
      { key: 'Escape', mode: 'INSERT', when: ddOpen, run: function () { FB.dropdown.close(); } },
      // ── INSERT: dropdown closed ──
      { key: 'ArrowDown', mode: 'INSERT',
        when: function (e) { return !ddOpen() && FB.dropdown && FB.dropdown.attachable(e.target); },
        run: function (e) { FB.dropdown.openFull(e.target); } },
      { key: 'Enter', mode: 'INSERT',
        // multi-line fields (CSV paste) own Enter natively — no advance
        when: function (e) { return !e.target || e.target.tagName !== 'TEXTAREA'; },
        run: advance },
      { key: 'Tab', mode: 'INSERT', swallow: false, preventDefault: false, run: function () {} },
      { key: 'Escape', mode: 'INSERT', hint: 'exit edit', hintBar: true, run: exitEdit }
    ];

    if (cfg.verbs) {
      ['add', 'delete', 'write', 'quit'].forEach(function (name) {
        var v = cfg.verbs[name];
        if (!v) return;
        bindings.push({ key: v.key, mode: 'NORMAL', hint: v.hint, hintBar: true,
          when: v.when ? function (e) { return v.when(api, e); } : undefined,
          run: function () { v.run(api); } });
      });
    }

    // Cursor follows focus: mouse click and native Tab both land here (mouse
    // parity — clicking a cell moves the cursor and enters INSERT).
    document.addEventListener('focusin', function (e) {
      var t = e.target;
      if (!t || !(t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      for (var zi = 0; zi < zones().length; zi++) {
        var rs = zoneRows(zi);
        for (var ri = 0; ri < rs.length; ri++) {
          var cs = rowCells(zi, rs[ri]);
          var ci = cs.indexOf(t);
          if (ci >= 0) {
            cur = { z: zi, r: ri, c: ci };
            setMode(true);
            paint();
            return;
          }
        }
      }
    });
    document.addEventListener('focusout', function (e) {
      var next = e.relatedTarget;
      if (next && (next.tagName === 'INPUT' || next.tagName === 'SELECT' || next.tagName === 'TEXTAREA')) return;
      if (editing) setMode(false); // left the form entirely — back to NORMAL
    });

    var api = {
      formId: cfg.formId,
      cur: function () { return { z: cur.z, r: cur.r, c: cur.c }; },
      moveTo: moveTo,
      edit: edit,
      exitEdit: exitEdit,
      refresh: function () { clamp(); paint(); },
      mode: function () { return editing ? 'INSERT' : 'NORMAL'; },
      cellEl: curCellEl,
      zoneRows: zoneRows,
      rowCells: rowCells
    };

    var all = cfg.extraBindings ? cfg.extraBindings(api).concat(bindings) : bindings;
    FB.keys.register(cfg.formId, {
      active: cfg.active || undefined,
      getMode: function () { return editing ? 'INSERT' : 'NORMAL'; },
      bindings: all
    });

    // gg first-row hook for fb-core's unified g-prefix machine (K1).
    if (FB.nav && FB.nav.onGG) FB.nav.onGG(function () {
      var el = zoneRows(cur.z)[cur.r];
      if (el && !el.offsetParent) return; // hidden form/page — no-op
      var flat = flatRows();
      if (!flat.length) return;
      cur = { z: flat[0].z, r: flat[0].r, c: 0 };
      paint();
    });

    clamp(); paint();
    return api;
  }

  window.FB = window.FB || {};
  FB.form = { create: create };
})();
