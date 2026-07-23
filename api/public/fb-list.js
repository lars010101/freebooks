/**
 * fb-list.js — FB.list: the ONE editable-list component (P3 consolidation).
 *
 * Every flat list in the app (Settings registers, Vendors, …) is the same
 * machine:
 *   - an add row (the single create slot) pinned at the BOTTOM of the list,
 *     saying "+ Add entry" — opened with i / Enter / click, reachable with
 *     j (sticky past the last data row) and G; never open for entry itself
 *   - saved rows overlaid with dirty buffers (merged view, new rows bottom)
 *   - row-level INSERT edit (i / Enter / click), Esc exits — never saves
 *   - w writes a dirty row, u reverts it, x deletes (confirm for saved rows)
 *   - j/k nav includes the add row (sticky at bottom); gg/G jump top/bottom
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
 *                 nullable, display, attach, filterType }]
 *              field    buffer property name (also data-field + input class)
 *              type     'text' (default) | 'date' | 'number' | 'checkbox' | 'select'
 *              ro       'saved' → read-only when editing a SAVED row (key col)
 *                       'always' → display-only in BOTH modes (badges, source)
 *              options  select values: ['a','b'] or [{value,label}]; '' = '- none -'
 *              nullable select: '' harvests as null
 *              display  fn(value, row) → HTML for view mode (default: esc or —)
 *              attach   fn(input, tr) — post-build hook (FB.dropdown, etc.)
 *              filterType 'text'|'date'|'amount'|'list' — opts into the ≡ header
 *                       dropdown + command-box qualifier for this column (spec §8)
 *              label    optional column header label (used by the ≡ tooltip)
 *   blank()    → new-row buffer defaults
 *   isBlank(b) → true when a NEW buffer is untouched (vanishes on Esc)
 *   same(b, s) → true when buffer matches saved row (dirty dropped)
 *   validate(d)→ error string | null
 *   editable(d)→ bool (default true); false = row never enters edit (ECB rates)
 *   deletable(d)→ bool (default true); false = x is a no-op on that row
 *   rowStyle(d)→ cssText for the <tr> (e.g. opacity for ECB rows)
 *   firstField(isNew) → field to focus when entering edit
 *   track      FB.track.create name for creates (optional)
 *   label      add-row text (default '+ Add entry')
 *   list       { action } | { url } + map(raw) → saved row incl. _key
 *   save       { action, body(d) → payload extras, focusKey(d, res) → key }
 *   del        { action, body(d) → payload extras, confirm(d) → string } | null
 *   onChrome   fn(anyDirty) — tab dot / dirty-tab bookkeeping (optional)
 *   onFocus    fn(tr) — nav focus hook (compat globals; optional)
 *   focusClass nav highlight class (default 'nav-row-focus')
 *   extraBindings fn(api) → [bindings] appended to the NORMAL set (optional)
 *   filter     fn(row, q) → bool (optional; enables setFilter + plain-text box mode)
 *   hint       string — register note rendered in the sidebar under keyboard
 *              help (the only sanctioned location for per-register notes)
 *   actions    [{ key, label, handler(api) }] — list-level verbs; each gets a
 *              NORMAL-mode key binding + a small mouse-parity button above the
 *              table (title shows the key). Must not edit existing rows.
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
    var newN = 0;
    var filterQ = '';
    var nav = null;
    var _gPending = false, _gTimer = null; // gg sequence
    var ADD_ROW = '_add_row'; // render(focusKey) sentinel: focus the add row

    function tbody() { return el(cfg.tbody); }
    function rows() { return Array.from(tbody().querySelectorAll('tr:not(.fb-add-row)')); }
    function navRows() { return Array.from(tbody().querySelectorAll('tr')); }
    function msg(t, e) { showMsg(cfg.msg, t, e); }

    function post(action, extra) {
      return fetch('/api/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ action: action, companyId: cfg.companyId() }, extra || {}))
      }).then(function (r) { return r.json(); });
    }

    // ── Model ────────────────────────────────────────────────────────────
    // Saved rows overlaid with their dirty buffers; dirty-new appended at the
    // bottom (the add-row slot — new entries grow from the bottom).
    function merged() {
      var out = saved.map(function (s) {
        var d = dirty[s._key];
        if (d) return Object.assign({}, d, { _dirty: true, _key: s._key, _isNew: false });
        return Object.assign({}, s, { _dirty: false, _key: s._key, _isNew: false });
      });
      Object.keys(dirty).forEach(function (k) {
        var d = dirty[k];
        if (d && d.isNew) out.push(Object.assign({}, d, { _dirty: true, _key: k, _isNew: true }));
      });
      if (filterQ && cfg.filter) out = out.filter(function (r) { return cfg.filter(r, filterQ); });
      if (hasColFilters()) out = out.filter(applyColFilters);
      return out;
    }
    function anyDirty() { return editIdx >= 0 || Object.keys(dirty).length > 0; }
    function mounted() { return !!tbody(); }
    function syncChrome() { if (cfg.onChrome) cfg.onChrome(anyDirty()); }

    // ── Column filters + command box (spec §8) ───────────────────────────
    // One filter state, two views: per-column ≡ dropdowns (mouse) and a `/`
    // command box (keyboard) render the SAME state. `colFilters` maps a
    // column field → { op, value }; `filterQ` is the plain-text cross-column
    // query (drives the screen's existing filter(row,q) predicate). Editing
    // either view re-renders the other. Both are AND-combined in merged().
    var colFilters = {};
    var boxOpen = false;
    var toolbarEl = null, boxInput = null;
    var headersWired = false;
    var ddEl = null;
    var _boxTimer = null;
    // Drop any stray dropdown left by a prior instance on soft-nav re-exec.
    Array.prototype.forEach.call(document.querySelectorAll('.fb-col-filter-dd'), function (e) { e.remove(); });

    function colByName(field) {
      for (var i = 0; i < cfg.columns.length; i++) if (cfg.columns[i].field === field) return cfg.columns[i];
      return null;
    }
    function filterableCols() { return cfg.columns.filter(function (c) { return c.filterType; }); }
    function hasFilterSurface() { return !!cfg.filter || filterableCols().length > 0; }
    function hasColFilters() { return Object.keys(colFilters).length > 0; }
    function anyFilterActive() { return !!filterQ || hasColFilters(); }

    // ── Predicates ──
    function colMatches(row, col, f) {
      var v = row[col.field];
      if (col.filterType === 'text') {
        return String(v == null ? '' : v).toLowerCase().indexOf(String(f.value).toLowerCase()) !== -1;
      }
      if (col.filterType === 'list') {
        return String(v == null ? '' : v) === String(f.value);
      }
      if (col.filterType === 'date') {
        var dv = String(v == null ? '' : v).slice(0, 10);
        var fv = String(f.value).slice(0, 10);
        if (!dv || !fv) return false;
        if (f.op === '<') return dv < fv;
        if (f.op === '>') return dv > fv;
        if (f.op === '<=') return dv <= fv;
        if (f.op === '>=') return dv >= fv;
        return dv === fv; // 'on'
      }
      if (col.filterType === 'amount') {
        var nv = Number(v);
        if (!isFinite(nv)) return false;
        var av = Number(f.value);
        if (!isFinite(av)) return false;
        switch (f.op) {
          case '>': return nv > av;
          case '<': return nv < av;
          case '=': return nv === av;
          case '>=': return nv >= av;
          case '<=': return nv <= av;
        }
        return false;
      }
      return true;
    }
    function applyColFilters(row) {
      for (var f in colFilters) {
        var col = colByName(f);
        if (col && !colMatches(row, col, colFilters[f])) return false;
      }
      return true;
    }

    // ── Box expression <-> state ──
    // Plain tokens (no field:) join into filterQ; `field:value` qualifiers map
    // to colFilters. Operator syntax: amount:>100, amount:<=50, date:<2026-07,
    // date:>=2026-01-01. Quoted values keep spaces: vendor:"Acme Corp".
    function tokenize(str) {
      var out = [], i = 0, s = String(str || ''), n = s.length, cur = '';
      function push() { if (cur) { out.push(cur); cur = ''; } }
      while (i < n) {
        var ch = s[i];
        if (ch === '"') { i++; while (i < n && s[i] !== '"') { cur += s[i]; i++; } i++; continue; }
        if (/\s/.test(ch)) { push(); while (i < n && /\s/.test(s[i])) i++; continue; }
        cur += ch; i++;
      }
      push();
      return out;
    }
    function buildBoxExpr() {
      var parts = [];
      if (filterQ) parts.push(filterQ);
      Object.keys(colFilters).forEach(function (f) {
        var cf = colFilters[f], col = colByName(f);
        if (!col || !cf) return;
        if (col.filterType === 'text' || col.filterType === 'list') parts.push(f + ':' + cf.value);
        else parts.push(f + ':' + cf.op + cf.value);
      });
      return parts.join(' ');
    }
    function parseBoxExpr(str) {
      colFilters = {};
      var plain = [];
      tokenize(str).forEach(function (tok) {
        var ci = tok.indexOf(':');
        if (ci <= 0) { plain.push(tok); return; }
        var field = tok.slice(0, ci), rest = tok.slice(ci + 1);
        var col = colByName(field);
        if (!col || !col.filterType) { plain.push(tok); return; }
        if (col.filterType === 'amount') {
          var m = rest.match(/^([<>]=?|=)(.+)$/);
          if (!m) { plain.push(tok); return; }
          var v = Number(m[2]);
          if (!isFinite(v)) { plain.push(tok); return; }
          colFilters[field] = { op: m[1], value: v };
        } else if (col.filterType === 'date') {
          var dm = rest.match(/^(<=|>=|<|>)(.+)$/);
          colFilters[field] = { op: dm ? dm[1] : '=', value: dm ? dm[2] : rest };
        } else {
          colFilters[field] = { op: col.filterType === 'list' ? '=' : '~', value: rest };
        }
      });
      filterQ = plain.join(' ');
    }

    // ── Header ≡ buttons ──
    function wireHeaders() {
      if (headersWired) return;
      var table = tbody() && tbody().closest('table');
      if (!table) return;
      var ths = table.querySelectorAll('thead th');
      for (var i = 0; i < cfg.columns.length && i < ths.length; i++) {
        var col = cfg.columns[i], th = ths[i];
        if (!col.filterType || th.querySelector('.fb-filter-btn')) continue;
        th.classList.add('fb-th-filterable');
        th.setAttribute('tabindex', '0');
        th.setAttribute('data-field', col.field);
        (function (thEl, field, label) {
          var btn = document.createElement('span');
          btn.className = 'fb-filter-btn';
          btn.innerHTML = '&#8801;';
          btn.setAttribute('role', 'button');
          btn.setAttribute('title', 'Filter by ' + label);
          btn.addEventListener('click', function (e) {
            e.stopPropagation(); e.preventDefault();
            if (editIdx >= 0) exitEdit(); // never lose a dirty buffer to a mouse filter
            openColDropdown(thEl, field);
          });
          thEl.appendChild(btn);
        })(th, col.field, col.label || col.field);
      }
      headersWired = true;
      syncHeaderState();
    }
    function filterSummary(col, cf) {
      if (col.filterType === 'text' || col.filterType === 'list') return String(cf.value);
      return cf.op + ' ' + cf.value;
    }
    function syncHeaderState() {
      var table = tbody() && tbody().closest('table');
      if (!table) return;
      cfg.columns.forEach(function (col) {
        var th = table.querySelector('thead th[data-field="' + col.field + '"]');
        if (!th) return;
        var active = !!colFilters[col.field];
        th.classList.toggle('fb-col-filtered', active);
        var btn = th.querySelector('.fb-filter-btn');
        if (btn) {
          btn.classList.toggle('fb-filter-active', active);
          btn.setAttribute('title', active
            ? (col.label || col.field) + ': ' + filterSummary(col, colFilters[col.field])
            : 'Filter by ' + (col.label || col.field));
        }
      });
    }

    // ── Column filter dropdown (mouse path) ──
    function closeColDropdown() {
      if (ddEl) { ddEl.remove(); ddEl = null; }
      document.removeEventListener('mousedown', onDdOutside, true);
    }
    function onDdOutside(e) { if (ddEl && !ddEl.contains(e.target)) closeColDropdown(); }
    function openColDropdown(th, field) {
      closeColDropdown();
      var col = colByName(field);
      if (!col) return;
      // Clicking ≡ on an already-filtered column clears it (bills UX).
      if (colFilters[field]) { delete colFilters[field]; onFilterChanged(); return; }
      var dd = document.createElement('div');
      dd.className = 'fb-col-filter-dd';
      dd.dataset.field = field;
      var ft = col.filterType;

      if (ft === 'text') {
        var inp = document.createElement('input');
        inp.type = 'text'; inp.placeholder = 'Type to filter…'; inp.className = 'fb-cf-input';
        function textApply() {
          var v = inp.value.trim();
          if (v) colFilters[field] = { op: '~', value: v };
          closeColDropdown(); onFilterChanged();
        }
        inp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') textApply();
          else if (e.key === 'Escape') { e.stopPropagation(); closeColDropdown(); }
        });
        dd.appendChild(inp);
        setTimeout(function () { inp.focus(); }, 10);

      } else if (ft === 'date') {
        var opSel = document.createElement('select');
        opSel.className = 'fb-cf-op';
        opSel.innerHTML = '<option value="=">on</option><option value="<">before</option><option value=">">after</option>';
        var dInp = document.createElement('input');
        dInp.type = 'date'; dInp.className = 'fb-cf-input';
        function dateApply() {
          if (dInp.value) colFilters[field] = { op: opSel.value, value: dInp.value };
          closeColDropdown(); onFilterChanged();
        }
        dInp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') dateApply();
          else if (e.key === 'Escape') { e.stopPropagation(); closeColDropdown(); }
        });
        dInp.addEventListener('change', dateApply);
        dd.appendChild(opSel); dd.appendChild(dInp);
        setTimeout(function () { dInp.focus(); if (dInp.showPicker) dInp.showPicker(); }, 10);

      } else if (ft === 'amount') {
        var aOp = document.createElement('select');
        aOp.className = 'fb-cf-op';
        aOp.innerHTML = '<option value=">">&gt;</option><option value="<">&lt;</option><option value="=">=</option><option value=">=">&ge;</option><option value="<=">&le;</option>';
        var aInp = document.createElement('input');
        aInp.type = 'number'; aInp.step = '0.01'; aInp.placeholder = '0.00'; aInp.className = 'fb-cf-input';
        function amtApply() {
          if (aInp.value !== '') {
            var v = Number(aInp.value);
            if (isFinite(v)) colFilters[field] = { op: aOp.value, value: v };
          }
          closeColDropdown(); onFilterChanged();
        }
        aInp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') amtApply();
          else if (e.key === 'Escape') { e.stopPropagation(); closeColDropdown(); }
        });
        dd.appendChild(aOp); dd.appendChild(aInp);
        setTimeout(function () { aInp.focus(); }, 10);

      } else if (ft === 'list') {
        var vals = [];
        saved.forEach(function (r) {
          var v = r[col.field];
          if (v == null || v === '') return;
          v = String(v);
          if (vals.indexOf(v) === -1) vals.push(v);
        });
        vals.sort();
        var wrap = document.createElement('div');
        wrap.className = 'fb-cf-list';
        var clear = document.createElement('div');
        clear.className = 'fb-cf-item fb-cf-clear';
        clear.textContent = 'All (clear filter)';
        clear.addEventListener('click', function () { delete colFilters[field]; closeColDropdown(); onFilterChanged(); });
        wrap.appendChild(clear);
        vals.forEach(function (v) {
          var it = document.createElement('div');
          it.className = 'fb-cf-item';
          it.textContent = v;
          it.addEventListener('click', function () {
            colFilters[field] = { op: '=', value: v };
            closeColDropdown(); onFilterChanged();
          });
          wrap.appendChild(it);
        });
        dd.appendChild(wrap);
      }

      var rect = th.getBoundingClientRect();
      dd.style.position = 'fixed';
      dd.style.top = (rect.bottom + 4) + 'px';
      dd.style.left = Math.max(4, rect.right - 220) + 'px';
      document.body.appendChild(dd);
      ddEl = dd;
      setTimeout(function () { document.addEventListener('mousedown', onDdOutside, true); }, 0);
    }

    // ── Command box (keyboard path) + actions bar ──
    function ensureToolbar() {
      var table = tbody() && tbody().closest('table');
      if (!table || !table.parentNode) return;
      if (toolbarEl) return;
      // Re-exec safety: drop a stale toolbar left immediately before this table.
      var prev = table.previousElementSibling;
      if (prev && prev.classList.contains('fb-list-toolbar')) prev.remove();
      toolbarEl = document.createElement('div');
      toolbarEl.className = 'fb-list-toolbar';
      var box = document.createElement('div');
      box.className = 'fb-cmd-box';
      boxInput = document.createElement('input');
      boxInput.type = 'text';
      boxInput.className = 'fb-cmd-input';
      boxInput.placeholder = '/ filter — terms + field:value  (amount:>100, date:<2026-07)';
      boxInput.setAttribute('aria-label', 'Filter command box');
      wireBoxInput();
      box.appendChild(boxInput);
      toolbarEl.appendChild(box);
      if (cfg.actions && cfg.actions.length) {
        var acts = document.createElement('div');
        acts.className = 'fb-list-actions';
        cfg.actions.forEach(function (a) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'fb-list-action-btn';
          b.textContent = a.label;
          b.title = a.label + ' (' + a.key + ')';
          b.addEventListener('click', function () { if (editIdx >= 0) exitEdit(); a.handler(api); });
          acts.appendChild(b);
        });
        toolbarEl.appendChild(acts);
      }
      table.parentNode.insertBefore(toolbarEl, table);
      syncBox();
    }
    function syncBox() {
      if (!boxInput || !toolbarEl) return;
      if (!boxOpen) boxInput.value = buildBoxExpr();
      toolbarEl.classList.toggle('fb-filters-active', anyFilterActive());
      toolbarEl.style.display = (boxOpen || anyFilterActive()) ? '' : 'none';
    }
    function prefillForSlash() {
      var table = tbody() && tbody().closest('table');
      if (!table) return null;
      var ae = document.activeElement;
      if (ae && ae.tagName === 'TH' && table.contains(ae)) {
        var f = ae.getAttribute('data-field');
        if (f) return f + ':';
      }
      return null;
    }
    function openBox(prefill) {
      ensureToolbar();
      if (!boxInput) return;
      boxOpen = true;
      boxInput.value = (prefill != null) ? prefill : buildBoxExpr();
      syncBox();
      boxInput.focus();
      var len = boxInput.value.length;
      try { boxInput.setSelectionRange(len, len); } catch (e) {}
    }
    function closeBox() {
      boxOpen = false;
      syncBox();
      if (boxInput && document.activeElement === boxInput) boxInput.blur();
    }
    function applyBoxLive() {
      parseBoxExpr(boxInput.value);
      render();
      syncHeaderState();
      syncBox();
    }
    function wireBoxInput() {
      boxInput.addEventListener('input', function () {
        clearTimeout(_boxTimer);
        _boxTimer = setTimeout(applyBoxLive, 150);
      });
      boxInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); clearTimeout(_boxTimer); applyBoxLive(); closeBox(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeBox(); }
      });
      boxInput.addEventListener('focus', function () { boxOpen = true; syncBox(); });
    }
    function clearAllFilters() {
      colFilters = {}; filterQ = ''; boxOpen = false;
      onFilterChanged();
    }
    function onFilterChanged() { render(); syncHeaderState(); syncBox(); }

    // ── Render ───────────────────────────────────────────────────────────
    // The ADD ROW is the single create affordance, pinned at the BOTTOM of the
    // list (QuickBooks/Xero "+ Add line" pattern): a plain muted text row, not
    // a grayed input replica. Reachable by click, j (sticky past the last data
    // row) and G. While a new row is being created the add row IS the edit row
    // (navy) — on exit it reappears at the bottom.
    function addRowHtml() {
      return '<tr class="fb-add-row"><td class="fb-add-cell" colspan="' + (cfg.columns.length + 1) + '">'
        + esc(cfg.label || '+ Add entry') + '</td></tr>';
    }
    function hideAddRow(tb) {
      var g = tb.querySelector('.fb-add-row');
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
      wireHeaders();
      if (cfg.actions || filterableCols().length) ensureToolbar();
      var m = merged();
      tb.innerHTML = m.map(rowHtml).join('') + addRowHtml(); // add row pinned bottom
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
      var g = tb.querySelector('.fb-add-row');
      if (g) g.addEventListener('click', function () { newRow(); });
      if (nav) {
        var target = focusKey === ADD_ROW ? g
          : (focusKey != null ? tb.querySelector('tr[data-key="' + focusKey + '"]') : null);
        nav.set(target || navRows()[0] || null); // default: first row
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
      if (d._isNew) hideAddRow(tbody()); // the add row transforms INTO the edit row
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
      var vanished = false; // untouched new row discarded → cursor returns to the add row
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
          else { delete dirty[d._key]; vanished = true; } // nothing from nothing
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
      render(vanished ? ADD_ROW : key);
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
      render(d._isNew ? ADD_ROW : d._key); // discarded new row → cursor on the add row
      syncChrome();
    }

    function deleteFocused() {
      var idx = focusedIdx();
      if (idx < 0) return;
      var d = merged()[idx];
      if (!d) return;
      if (d._isNew) { delete dirty[d._key]; render(ADD_ROW); syncChrome(); return; }
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
      var key = '_new_' + (++newN);
      dirty[key] = Object.assign(cfg.blank(), { isNew: true });
      render(key);
      // New rows append at the bottom, right where the add row was. Look the
      // index up by key — an active filter could otherwise mis-target row 0.
      var m = merged(), idx = -1;
      for (var i = 0; i < m.length; i++) if (m[i]._key === key) { idx = i; break; }
      if (idx >= 0) enterEdit(idx, cfg.firstField(true));
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
      if (!tr || tr.classList.contains('fb-add-row')) return -1;
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
      if (tr && tr.classList.contains('fb-add-row')) { newRow(); return; } // i on the add row = create
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
      { key: 'G', mode: 'NORMAL', run: function () { nav.last(); } }, // bottom = add row
      { key: 'g', mode: 'NORMAL', run: function () {
          if (_gPending) { _gPending = false; clearTimeout(_gTimer); nav.first(); return; }
          _gPending = true;
          clearTimeout(_gTimer);
          _gTimer = setTimeout(function () { _gPending = false; }, 500);
        } },
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
    if (hasFilterSurface()) {
      bindings.push({ key: '/', mode: 'NORMAL', hint: 'filter box', hintBar: true, run: function () { openBox(prefillForSlash()); } });
      bindings.push({ key: 'c', mode: 'NORMAL', hint: 'clear filters', hintBar: true, when: anyFilterActive, run: clearAllFilters });
    }
    if (cfg.actions) {
      cfg.actions.forEach(function (a) {
        bindings.push({ key: a.key, mode: 'NORMAL', hint: a.label, hintBar: true, run: function () { if (editIdx >= 0) exitEdit(); a.handler(api); } });
      });
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
      renderHints: function (hintEl) {
        if (window.FB && FB.keys) FB.keys.renderHints(cfg.keysId, hintEl, { layout: 'list' });
        // spec §8: the only sanctioned home for register notes — a small note
        // appended under the tab's keyboard help, framework-automatic.
        if (cfg.hint && hintEl) {
          var old = hintEl.querySelector('.fb-hint-note');
          if (old) old.remove();
          var note = document.createElement('div');
          note.className = 'fb-hint-note';
          note.textContent = cfg.hint;
          hintEl.appendChild(note);
        }
      },
      clearFilters: clearAllFilters,
      openFilterBox: function (prefill) { openBox(prefill || null); },
      setFilter: function (q) {
        filterQ = q || ''; // plain-text portion only — column filters are preserved
        if (editIdx >= 0) { editIdx = -1; if (window.FB && FB.mode) FB.mode.set('NORMAL'); window.fbEditActive = false; }
        render();
        syncHeaderState();
        syncBox();
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
