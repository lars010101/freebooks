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
 *   onCommit?: fn(cellEl, api) — invoked on INSERT Enter commit-and-advance
 *              for input cells (before advancing) and on commitSelect
 *              (native select commit). NOT on Esc (never writes), NOT on
 *              button cells (their click handlers self-trigger). Use for
 *              run-on-any-commit side effects (e.g. reports reload).
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
    var CELL_BTN_CLS = 'fb-form-cursor-btn';

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
      document.querySelectorAll('.' + CELL_BTN_CLS).forEach(function (el) { el.classList.remove(CELL_BTN_CLS); });
      var rows = zoneRows(cur.z);
      var rowEl = rows[cur.r];
      if (!rowEl) return;
      rowEl.classList.add(ROW_CLS);
      if (rowEl.scrollIntoView) rowEl.scrollIntoView({ block: 'nearest' });
      var cs = rowCells(cur.z, rowEl);
      var cell = cs[cur.c];
      if (cell) {
        // Buttons get a RING cursor (CELL_BTN_CLS), not the fill — a toggle
        // button's own active state carries a fill color and the two must
        // stay distinguishable (magnus 2026-07-28; common.css).
        cell.classList.add(cell.tagName === 'BUTTON' ? CELL_BTN_CLS : CELL_CLS);
        if (cell.scrollIntoView) cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      // K3e enforcement (magnus 2026-07-28): in NORMAL, NO form element may
      // hold DOM focus — a focused button/select lingers as a second visible
      // "selector" beside the vim cursor and re-fires on native Space/Enter.
      // Mouse parity is unaffected: click still dispatches after the blur.
      // Exception (magnus 2026-08-02): a control whose FB.dropdown overlay is
      // OPEN keeps its focus — the overlay is the one visible selector and its
      // lifecycle anchors on that focus (blur-close). Focus is stripped when
      // the overlay closes (attachSelect onPick blur / the NORMAL ddOpen Esc
      // binding), restoring this invariant.
      if (!editing) {
        var ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'BUTTON')
            && !(ae.__fbdd && ae.__fbdd.el)) {
          outer: for (var zi = 0; zi < zones().length; zi++) {
            var frs = zoneRows(zi);
            for (var ri = 0; ri < frs.length; ri++) {
              if (frs[ri] && frs[ri].contains && frs[ri].contains(ae)) { ae.blur(); break outer; }
            }
          }
        }
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
      // Button cells activate (click) rather than enter INSERT — generic, so
      // any page declaring a button cell gets Enter/i = click (spec §8).
      // NO el.focus(): DOM focus on the button would linger in NORMAL as a
      // second visible "selector" next to the vim cursor, and native
      // Space/Enter-on-focused-button would double-fire (magnus 2026-07-28).
      if (el.tagName === 'BUTTON') { el.click(); paint(); return; }
      // Native <select> (no FB.dropdown attached): ALWAYS enter INSERT and
      // step options with j/k / arrows — the OS popup (el.showPicker) is
      // never opened from the keyboard. Rationale (2026-07-28, discovered via
      // pw-reports-cells): showPicker is user-activation-dependent, so the
      // same keypress took different paths across runs; the open popup owns
      // keys natively (j/k/typeahead, not vim stepping) and can't be driven
      // in tests; and _focusin had already flipped the mode store to INSERT,
      // contradicting the "stay NORMAL" design. Programmatic stepping is
      // deterministic in every browser, keeps j/k semantics (no typeahead
      // hijack), and is headless-testable. Mouse click still opens the
      // native popup (browser default — mouse parity unchanged).
      // setMode BEFORE focus (2026-08-02): focusin fires synchronously out of
      // el.focus() → paint() → K3e no-focus-in-NORMAL enforcement. focusin no
      // longer flips the mode for SELECTs (dropdowns never alter the mode),
      // so editing must already be true or K3e blurs the cell we are entering.
      setMode(true);
      el.focus();
      if (el.select) el.select();
      selSnap = (el.tagName === 'SELECT') ? { el: el, idx: el.selectedIndex } : null;
      paint();
    }

    function exitEdit() {
      // Esc/cancel: a native select reverts to its pre-edit option and fires
      // NO change (dropdown-cancel parity — keyboard-ux-spec §8).
      if (selSnap && selSnap.el) { selSnap.el.selectedIndex = selSnap.idx; }
      selSnap = null;
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
      cur.z = flat[n].z; cur.r = flat[n].r;
      // Column is PRESERVED across vertical moves (vim j/k keep the goal
      // column; magnus 2026-07-28 — k from a credit cell must land on the
      // credit cell above, not snap back to debit). clamp() handles rows
      // with fewer cells.
      clamp(); paint();
    }

    // NORMAL Tab/Shift+Tab: move the cursor cell-by-cell through the whole
    // form (K3e originally clamped to the current row — magnus 2026-07-28:
    // Tab must drop from header into the line grid fluidly). Cursor only —
    // no focus, no INSERT (NORMAL owns the cursor, K3e). Sticky at the
    // absolute first/last cell.
    function stepCell(d) {
      var flat = flatRows();
      if (!flat.length) return;
      var fi = flat.findIndex(function (p) { return p.z === cur.z && p.r === cur.r; });
      if (fi === -1) fi = 0;
      var ncells = rowCells(cur.z, zoneRows(cur.z)[cur.r]).length;
      var ci = cur.c + d;
      if (ci >= 0 && ci < ncells) { cur.c = ci; paint(); return; }
      var nfi = fi + (d > 0 ? 1 : -1);
      if (nfi < 0) nfi = 0;
      if (nfi > flat.length - 1) nfi = flat.length - 1;
      var t = flat[nfi];
      var tcells = rowCells(t.z, zoneRows(t.z)[t.r]).length;
      cur = { z: t.z, r: t.r, c: d > 0 ? 0 : Math.max(0, tcells - 1) };
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
    // Shift+Tab in INSERT: retreat to the previous cell — left, wrapping to
    // the previous row's last cell; sticky at the first cell.
    function retreat() {
      var flat = flatRows();
      var idx = flat.findIndex(function (p) { return p.z === cur.z && p.r === cur.r; });
      if (idx === -1) return;
      if (cur.c > 0) cur.c--;
      else if (idx > 0) {
        cur.z = flat[idx - 1].z; cur.r = flat[idx - 1].r;
        cur.c = Math.max(0, rowCells(cur.z, zoneRows(cur.z)[cur.r]).length - 1);
      }
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

    // Native <select> cells (no FB.dropdown attached) get fb-list-style INSERT
    // option nav: j/k step, Enter commits (fires onchange), Esc reverts. The
    // snapshot lets Esc cancel without firing — dropdown-cancel parity (§8).
    var selSnap = null; // {el, idx} set on edit() of a native select
    // Set when a dropdown overlay was opened from NORMAL (ArrowDown on an
    // attachable select cell): pick/Esc then returns the form to NORMAL.
    var ddFromNormal = false;
    function nativeSelect(el) { return !!el && el.tagName === 'SELECT' && !ddOpen(); }
    function stepSelect(d) {
      var el = curCellEl();
      if (!nativeSelect(el)) return;
      var opts = el.options, n = opts.length;
      if (!n) return;
      var i = el.selectedIndex;
      for (var s = 0; s < n; s++) {   // skip disabled options (e.g. placeholders)
        i += d;
        if (i > n - 1) i = n - 1;
        if (i < 0) i = 0;
        if (!opts[i].disabled) break;
      }
      if (opts[i] && !opts[i].disabled) el.selectedIndex = i;
    }
    function commitSelect() {
      var el = curCellEl();
      if (!el || el.tagName !== 'SELECT') return;
      // Mode-preserving commit (magnus global rule 2026-07-28): selecting a
      // value must not flip NORMAL/INSERT. selSnap is only set when the edit
      // was entered explicitly from NORMAL (i/Enter) — then commit returns
      // to NORMAL. When the select was reached mid-INSERT (Tab traversal,
      // cursor-follows-focus), commit keeps INSERT so the field flow
      // continues uninterrupted.
      var explicitEdit = !!selSnap;
      selSnap = null;                 // committed — don't restore on the exit
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (cfg.onCommit) cfg.onCommit(el, api);
      if (explicitEdit) exitEdit();
    }

    var bindings = [
      // ── NORMAL ──
      { key: 'j', mode: 'NORMAL', hint: 'navigate', hintBar: true, paletteEligible: false, run: function () { moveRow(1); } },
      { key: 'k', mode: 'NORMAL', hint: 'navigate', hintBar: true, paletteEligible: false, run: function () { moveRow(-1); } },
      { key: 'h', mode: 'NORMAL', hint: 'cell', hintBar: true, paletteEligible: false, run: function () { moveCol(-1); } },
      { key: 'l', mode: 'NORMAL', hint: 'cell', hintBar: true, paletteEligible: false, run: function () { moveCol(1); } },
      // ── NORMAL: dropdown overlay open (mouse-opened — magnus 2026-08-02:
      // dropdowns never alter NORMAL/INSERT, so the overlay can now be open
      // in NORMAL with DOM focus on the select). The overlay owns these keys
      // in whichever mode it was opened from; mirrors the INSERT ddOpen
      // block below. Placed BEFORE the plain NORMAL Tab/Enter/ArrowDown
      // bindings so the open overlay wins. Dispatches from a focused select
      // rely on the fb-core editable-target guard carve-out. ──
      { key: 'ArrowDown', mode: 'NORMAL', when: ddOpen, run: function () { FB.dropdown.move(1); } },
      { key: 'ArrowUp', mode: 'NORMAL', when: ddOpen, run: function () { FB.dropdown.move(-1); } },
      { key: 'Enter', mode: 'NORMAL', when: ddOpen, run: function () { FB.dropdown.pick(); } },
      { key: 'Tab', mode: 'NORMAL', when: ddOpen, swallow: false, preventDefault: false,
        run: function () { FB.dropdown.pick(); } },
      { key: 'Escape', mode: 'NORMAL', when: ddOpen, run: function () {
          FB.dropdown.close();
          // K3e restoration: the overlay is gone, so the anchor select must
          // not keep DOM focus in NORMAL (paint() only blurs on cursor move).
          var ae = document.activeElement;
          if (ae && ae.tagName === 'SELECT' && ae.blur) ae.blur();
        } },
      // K3e: Tab in NORMAL moves the cursor cell next/prev WITHOUT entering
      // INSERT. preventDefault (default for bindings) stops native focus
      // movement, so no focusin→setMode(true) fires. INSERT is entered only
      // via i/Enter (keyboard) or click (mouse parity). In INSERT, Tab stays
      // native traversal + cursor-follows-focus (the INSERT Tab binding
      // below has preventDefault:false). active() guards ensure this binding
      // only claims Tab when the form is live and has cells.
      { key: 'Tab', mode: 'NORMAL', run: function (e) { stepCell(e.shiftKey ? -1 : 1); } },
      // Space activates the focused button cell (toggle parity with ~/Enter —
      // magnus 2026-07-28). No mode change: click() does not focus, so
      // focusin/setMode never fire (global rule: toggles never flip modes).
      { key: ' ', mode: 'NORMAL', when: function () { var el = curCellEl(); return !!el && el.tagName === 'BUTTON'; },
        run: function () { var el = curCellEl(); el.click(); paint(); } },
      { key: 'i', mode: 'NORMAL', hint: 'edit', hintBar: true, paletteEligible: false, run: edit },
      { key: 'Enter', mode: 'NORMAL', hint: 'edit', hintBar: true, paletteEligible: false, run: edit },
      // ArrowDown/ArrowUp on an attachable (FB.dropdown) select cell in
      // NORMAL: open the FULL option list (magnus 2026-07-28 — "drop down
      // the full list, not just switch the cell value"). The overlay owns
      // keys via the ddOpen INSERT bindings; pick/Esc returns to NORMAL.
      { key: 'ArrowDown', mode: 'NORMAL', when: function () { var el = curCellEl(); return !!(el && el.__fbdd); },
        run: function () { ddFromNormal = true; setMode(true); FB.dropdown.openFull(curCellEl()); } },
      { key: 'ArrowUp', mode: 'NORMAL', when: function () { var el = curCellEl(); return !!(el && el.__fbdd); },
        run: function () { ddFromNormal = true; setMode(true); FB.dropdown.openFull(curCellEl()); } },
      // K3d: ArrowDown/ArrowUp on a native <select> cell in NORMAL behave
      // like i/Enter — enter INSERT and j/k-step (text/date inputs' arrows
      // stay native; the when guard only passes for native select cells).
      { key: 'ArrowDown', mode: 'NORMAL', when: function () { return nativeSelect(curCellEl()); }, run: edit },
      { key: 'ArrowUp', mode: 'NORMAL', when: function () { return nativeSelect(curCellEl()); }, run: edit },
      { key: 'G', mode: 'NORMAL', paletteEligible: false, run: function () {
          var flat = flatRows();
          if (!flat.length) return;
          var last = flat[flat.length - 1];
          cur = { z: last.z, r: last.r, c: 0 };
          clamp(); paint();
          // Absolute bottom, next frame — vim G shows the END of the document
          // (footer/totals included), not merely the last row in view. The
          // rAF lets the cursor paint settle so its scrollIntoView can't
          // cancel this (fb-list 'G' parity; magnus K1 review 2026-07-28).
          requestAnimationFrame(function () {
            var pm = document.getElementById('page-main');
            if (pm) pm.scrollTo(0, pm.scrollHeight);
            window.scrollTo(0, document.documentElement.scrollHeight);
          });
        } },
      // ── INSERT: dropdown open (fb-list parity — guarded bindings first) ──
      { key: 'ArrowDown', mode: 'INSERT', when: ddOpen, run: function () { FB.dropdown.move(1); } },
      { key: 'ArrowUp', mode: 'INSERT', when: ddOpen, run: function () { FB.dropdown.move(-1); } },
      { key: 'Enter', mode: 'INSERT', when: ddOpen, run: function () {
          FB.dropdown.pick();
          // Opened from NORMAL (ArrowDown on a select cell): pick closes the
          // loop back to NORMAL — the traversal session is over (2026-07-28).
          if (ddFromNormal) { ddFromNormal = false; setMode(false); }
        } },
      { key: 'Tab', mode: 'INSERT', when: ddOpen, swallow: false, preventDefault: false,
        run: function () { FB.dropdown.pick(); } },
      { key: 'Escape', mode: 'INSERT', when: ddOpen, run: function () {
          FB.dropdown.close();
          if (ddFromNormal) { ddFromNormal = false; setMode(false); }
        } },
      // ── INSERT: dropdown closed ──
      { key: 'ArrowDown', mode: 'INSERT',
        when: function (e) { return !ddOpen() && FB.dropdown && FB.dropdown.attachable(e.target); },
        run: function (e) { FB.dropdown.openFull(e.target); } },
      // ── INSERT: native <select> (no FB.dropdown) — j/k step options, Enter
      // commits the change (fires onchange), Esc reverts without firing (§8).
      { key: 'j', mode: 'INSERT', when: function (e) { return nativeSelect(e.target); }, run: function () { stepSelect(1); } },
      { key: 'k', mode: 'INSERT', when: function (e) { return nativeSelect(e.target); }, run: function () { stepSelect(-1); } },
      // K3d: ArrowDown/ArrowUp in INSERT on a native <select> = aliases for j/k
      { key: 'ArrowDown', mode: 'INSERT', when: function (e) { return nativeSelect(e.target); }, run: function () { stepSelect(1); } },
      { key: 'ArrowUp', mode: 'INSERT', when: function (e) { return nativeSelect(e.target); }, run: function () { stepSelect(-1); } },
      { key: 'Enter', mode: 'INSERT', when: function (e) { return nativeSelect(e.target); }, run: commitSelect },
      { key: 'Enter', mode: 'INSERT',
        // multi-line fields (CSV paste) own Enter natively — no advance.
        // BUTTON cells: Enter CLICKS (magnus 2026-07-28 — advancing past a
        // button without activating it made Enter-on-toggle feel broken);
        // the cursor stays put and mode is unchanged.
        when: function (e) { return !e.target || e.target.tagName !== 'TEXTAREA'; },
        run: function (e) {
          var el = curCellEl();
          if (el && el.tagName === 'BUTTON') { el.click(); return; }
          if (el && cfg.onCommit) cfg.onCommit(el, api);
          advance(e);
        } },
      { key: 'Tab', mode: 'INSERT',
        // Programmatic traversal (2026-07-28, supersedes K3e's "native
        // traversal"): headless Chromium does NOT traverse focus for
        // CDP-synthesized Tabs — the keydown reached the input unprevented
        // and focus never moved, leaving mode/cursor desynced and making
        // INSERT Tab flows untestable. fb-form owns Tab in both modes now;
        // cursor-follows-focus keeps cursor/focus synced on each focus().
        when: function () { return !ddOpen(); },
        run: function (e) { if (e.shiftKey) retreat(); else advance(); } },
      { key: 'Escape', mode: 'INSERT', hint: 'exit edit', hintBar: true, paletteEligible: false, run: exitEdit }
    ];

    if (cfg.verbs) {
      ['add', 'delete', 'write', 'quit'].forEach(function (name) {
        var v = cfg.verbs[name];
        if (!v) return;
        bindings.push({ key: v.key, mode: 'NORMAL', hint: v.hint, hintBar: true,
          paletteEligible: v.paletteEligible !== undefined ? v.paletteEligible : true,
          when: v.when ? function (e) { return v.when(api, e); } : undefined,
          run: function () { v.run(api); } });
      });
    }

    // Tab strips own h/l — common.js's bubble handler clicks the adjacent
    // .tab, but FB.keys capture bindings win over it. A form living on a
    // TABBED page (e.g. Settings) must not claim
    // h/l, or tab switching dies there (magnus 2026-08-02). Horizontal cell
    // movement on those pages stays on Tab/Shift+Tab. Forms on pages without
    // a tab strip (journal-voucher, reports-hub, new-company) keep h/l cell nav.
    // Excluded at create (not via when:) so the sidebar hints stay truthful.
    if (document.querySelector('.tabs .tab')) {
      bindings = bindings.filter(function (b) {
        return !(b.mode === 'NORMAL' && (b.key === 'h' || b.key === 'l'));
      });
    }

    // Cursor follows focus: mouse click and native Tab both land here (mouse
    // parity — clicking a cell moves the cursor and enters INSERT).
    var _focusin = function (e) {
      var t = e.target;
      if (!t || !(t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON')) return;
      for (var zi = 0; zi < zones().length; zi++) {
        var rs = zoneRows(zi);
        for (var ri = 0; ri < rs.length; ri++) {
          var cs = rowCells(zi, rs[ri]);
          var ci = cs.indexOf(t);
          if (ci >= 0) {
            cur = { z: zi, r: ri, c: ci };
            // Buttons activate (click), they don't edit — keep NORMAL so the
            // next h/l/Enter behaves as a NORMAL verb (mouse parity with edit()).
            // Dropdowns (SELECT) never alter NORMAL/INSERT mode either
            // (magnus 2026-08-02): a mouse click opens the FB.dropdown overlay
            // or the native popup; the mode stays whatever it was. Keyboard
            // entry (i/Enter/ArrowDown) still enters INSERT via edit()/openFull.
            if (t.tagName !== 'BUTTON' && t.tagName !== 'SELECT') setMode(true);
            paint();
            return;
          }
        }
      }
    };
    var _focusout = function (e) {
      var next = e.relatedTarget;
      if (next && (next.tagName === 'INPUT' || next.tagName === 'SELECT' || next.tagName === 'TEXTAREA' || next.tagName === 'BUTTON')) return;
      if (editing) setMode(false); // left the form entirely — back to NORMAL
    };
    document.addEventListener('focusin', _focusin);
    document.addEventListener('focusout', _focusout);
    // K3c: register a teardown so soft-nav (fbNavigate → FB.keys.resetPage)
    // removes these document-level listeners. Without this, each create()
    // call on a soft-nav destination would stack another pair and the stale
    // listeners from the departing page would keep interfering.
    if (FB.keys.onPageReset) FB.keys.onPageReset(function () {
      document.removeEventListener('focusin', _focusin);
      document.removeEventListener('focusout', _focusout);
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
      // K3c: defense-in-depth active() guard. If the page doesn't supply one,
      // default to checking whether ANY zone still has a row in the document
      // (K4 fix: zone 0 alone was wrong — journal-voucher's reversal zone and
      // journal-voucher's reversal zone is empty in its default state, which
      // made the guard kill those forms outright). After a soft-nav content
      // swap, ALL of the departing page's rows are gone → active() returns
      // false → the set yields dispatch. Belt-and-braces alongside
      // resetPage(); either mechanism alone fixes key-deadness.
      active: cfg.active || function () {
        var zs = zones();
        for (var zi = 0; zi < zs.length; zi++) {
          var rs = zoneRows(zi);
          if (rs.length > 0 && document.contains(rs[0])) return true;
        }
        return false;
      },
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

    // K5: register a page-level coverage provider returning every row element
    // from every zone. Each zone's rows() is guarded in try/catch so one
    // crashing zone cannot blank the form's coverage. Page-level — cleared by
    // resetPage on soft-nav (the arriving page's form re-registers).
    if (FB.coverage) FB.coverage.addProvider(function () {
      var out = [];
      (cfg.zones || []).forEach(function (z) {
        try {
          var rs = z.rows ? (z.rows() || []) : [];
          for (var ri = 0; ri < rs.length; ri++) out.push(rs[ri]);
        } catch (e) { /* one zone must not blank the form's coverage */ }
      });
      return out;
    });

    clamp(); paint();
    return api;
  }

  window.FB = window.FB || {};
  FB.form = { create: create };
})();
