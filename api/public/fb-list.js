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
 *              filterType 'text' (the DEFAULT for every non-checkbox column) |
 *                       'date' | 'amount' | 'list' | null (opt-out).
 *                       On list init, any column whose filterType is still
 *                       undefined gets 'text' — except checkbox columns,
 *                       which default to null (no boolean filter UI). The
 *                       special types 'list'/'date'/'amount' must be
 *                       declared explicitly; filterType: null opts out.
 *                       Drives the ≡ header dropdown + the '/field:value'
 *                       command-box qualifier for this column (spec §8).
 *              sortable true → this column's header is click-sortable
 *                       (asc → desc → none cycle; `none` restores server /
 *                       `saved` order via re-render, never a re-fetch).
 *                       Default OFF (only Bills declares it). Single-column:
 *                       sorting one column clears any other. Mouse-only (no
 *                       verb); j/k/G/gg operate on the sorted+filtered seq.
 *                       View concern: sorts the filtered set, never mutates
 *                       `saved`; suspended while any row/bill is dirty (same
 *                       doctrine as the filter bypass). Tree: parents are
 *                       sorted, children follow their parent.
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
 *   ── tree mode (opt-in, Bills) ──
 *   tree       boolean — enable parent/child rows + fold state (default false).
 *   children(row) → child rows for a parent (may fetch; framework caches per-_key).
 *   foldKey(row)/isFolded(row)/fold(row,open) — fold-state hooks (default _key).
 *   childRowHtml(parent, child, idx) — view-mode HTML for a child <tr> (Task 2).
 *   editChildRowHtml(parent, child, idx) — edit-mode HTML for a child <tr>
 *              (default: reuse childRowHtml). Framework owns the <tr> shell.
 *   harvestChild(tr) → line object from a child <tr>'s inputs (Task 3). Required
 *              for tree edit; when absent, child fields are not harvested.
 *   addChild(row) — the `a` verb: append a child to the focused draft bill (T4).
 *   extraInsertBindings(api) → [INSERT bindings] prepended ahead of the general
 *              INSERT set (tree screens with pay-row-style sub-modes) (Task 4).
 *
 * Instance: { load, render, anyDirty, mounted, writeAllDirty, discardAll,
 *            renderHints, setFilter, nav }
 */
(function () {
  'use strict';

  var instances = []; // live lists — the shared leave-guard consults these

  function el(id) { return document.getElementById(id); }
  // The ONE status channel (2026-07-23): topbar slot via FB.status — per-screen
  // msg spans are retired; cfg.msg is accepted for back-compat but unused.
  function showMsg(id, text, isErr) { if (window.FB && FB.status) FB.status.show(text, isErr); }

  function create(cfg) {
    // Replace any prior instance with the same keysId (soft-nav re-execution).
    for (var z = instances.length - 1; z >= 0; z--) {
      if (instances[z].keysId === cfg.keysId) instances.splice(z, 1);
    }

    // Sensible default: every column is filterable by default. Columns with
    // no declared filterType get 'text' (the substring dropdown); checkbox
    // columns default to null — the framework has no boolean filter UI yet,
    // so a text box against a checkbox would be noise. Screens opt out of an
    // individual column by declaring filterType: null (the existing
    // truthiness checks throughout this module honor it). Only the special
    // types ('list'/'date'/'amount') need an explicit declaration. (2026-07-24)
    cfg.columns.forEach(function (c) {
      if (c.filterType === undefined) {
        c.filterType = c.type === 'checkbox' ? null : 'text';
      }
    });

    // ── Tree mode opt-in (2026-07-24, Bills → FB.list) ──
    // tree: true enables parent/child rows: merged() flattens parents + open
    // children; fold state is keyed by row._key; childRowHtml renders children.
    // Flat lists (tree falsy) are untouched — the default.
    cfg.tree = !!cfg.tree;
    if (cfg.tree) {
      // children(row) → child rows for a parent (may fetch; framework caches
      // per-_key). Default: no children (a tree with only parents = flat).
      if (!cfg.children) cfg.children = function (row) { return []; };
      // Fold-state hooks — default: a `_key`-keyed `folded` map storing CLOSED
      // state (truthy = folded/closed; absent key = open). fold(row, open)
      // takes OPEN semantics — callers pass intent, the map stores the inverse.
      if (!cfg.foldKey) cfg.foldKey = function (row) { return row._key; };
      if (!cfg.isFolded) cfg.isFolded = function (row) { return folded[cfg.foldKey(row)]; };
      if (!cfg.fold) cfg.fold = function (row, open) { folded[cfg.foldKey(row)] = !open; };
      // editChildRowHtml(parent, child, idx) → edit-mode HTML for a child <tr>.
      // Default: reuse the view-mode childRowHtml (screens with editable child
      // fields override). The framework owns the <tr> shell + data attributes.
      if (!cfg.editChildRowHtml && cfg.childRowHtml)
        cfg.editChildRowHtml = cfg.childRowHtml;
      // harvestChild(tr) → line object from a child <tr>'s inputs (Task 3).
      // Required for tree edit; when absent the framework leaves the child
      // line's fields as-is in the bill buffer (no input harvest). Screens
      // with editable child fields (Bills) provide it.
    }

    var saved = [];
    var dirty = {};
    var editIdx = -1;
    var editKey = null; // _key of the in-edit row — filters must never hide it (2026-07-23)
    var newN = 0;
    var filterQ = '';
    var nav = null;
    var _gPending = false, _gTimer = null; // gg sequence
    var ADD_ROW = '_add_row'; // render(focusKey) sentinel: focus the add row
    var folded = {}; // tree: foldKey → closed-state (truthy=folded; absent=open); flat lists never read this
    var sortState = { field: null, dir: null }; // Task 5b: single-col sort; dir 'asc'|'desc'|null (none = server order)

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
    // Tree mode (cfg.tree): parents + their OPEN children flattened in sequence;
    // folded parents emit no children. Each child carries `_childOf` (parent
    // _key) and inherits the parent's `_dirty` so a dirty bill's children stay
    // amber and bypass filters as a unit. Children are produced by
    // cfg.children(row) — lazy fetch + caching is the screen's responsibility
    // (Bills caches bill.lines per _key); the framework calls it per render.
    function baseRows() {
      var out = saved.map(function (s) {
        var d = dirty[s._key];
        if (d) return Object.assign({}, d, { _dirty: true, _key: s._key, _isNew: false });
        return Object.assign({}, s, { _dirty: false, _key: s._key, _isNew: false });
      });
      Object.keys(dirty).forEach(function (k) {
        var d = dirty[k];
        if (d && d.isNew) out.push(Object.assign({}, d, { _dirty: true, _key: k, _isNew: true }));
      });
      return out;
    }
    function rowByKey(key) {
      for (var i = 0; i < saved.length; i++) {
        if (saved[i]._key === key) {
          var d = dirty[key];
          return d ? Object.assign({}, saved[i], d, { _key: key, _isNew: false, _dirty: true }) : saved[i];
        }
      }
      if (dirty[key] && dirty[key].isNew) return Object.assign({}, dirty[key], { _key: key, _isNew: true, _dirty: true });
      return null;
    }
    function childrenOf(r) {
      if (!cfg.tree) return [];
      var kids = cfg.children(r) || [];
      return Array.isArray(kids) ? kids : [];
    }
    function merged() {
      var base = baseRows();
      var out;
      if (cfg.tree) {
        out = [];
        base.forEach(function (r) {
          out.push(r);
          if (!cfg.isFolded(r)) {
            var kids = childrenOf(r);
            for (var ci = 0; ci < kids.length; ci++) {
              out.push(Object.assign({}, kids[ci], { _childOf: r._key, _dirty: r._dirty }));
            }
          }
        });
      } else {
        out = base;
      }
      // Edit/dirty rows ALWAYS bypass filters (2026-07-23): a row in edit
      // mode — including the freshly created add-entry row — must never be
      // hidden by the active filter. After w it re-submits to the filter.
      function keepRow(r) { return r._dirty || (editKey !== null && r._key === editKey); }
      if (cfg.tree) {
        // ── Tree filter semantics (Task 5) ──
        // Column filters (≡ dropdowns) + the topbar query evaluate on PARENT
        // rows ONLY — parents carry the column fields; children don't. A child
        // follows its parent's visibility: it is kept iff its parent survived
        // filtering. The flatten above guarantees parents precede their
        // children in `out`, so parentOk is already settled by the time we
        // reach a child. Fold state is untouched by filtering. A
        // dirty/editing bill bypasses AS A UNIT: the parent's `_dirty` flag
        // (inherited by its children in the flatten) and the editKey keep the
        // whole bill — parent + every line — visible. Because the flatten only
        // emits children of parents present in `out`, a parent the filter drops
        // takes its children with it; no stale child rows leak into the DOM
        // (render() rebuilds tbody from this list). colMatches / the box-expr
        // grammar are unchanged — they already operate on a row's column fields;
        // in tree mode they are only ever called on parents (below).
        function keepBill(r) {
          if (r._dirty) return true;                       // dirty bill (parent OR its children)
          if (editKey !== null && (r._key === editKey || r._childOf === editKey)) return true;
          return false;
        }
        if (filterQ || hasColFilters()) {
          var parentOk = {}; // parent _key → true when the parent survived
          out = out.filter(function (r) {
            if (r._childOf) return !!parentOk[r._childOf] || keepBill(r); // child follows parent
            if (keepBill(r)) { parentOk[r._key] = true; return true; }    // unit bypass
            var pass = true;
            if (filterQ && cfg.filter) pass = !!cfg.filter(r, filterQ);
            else if (filterQ) {
              // spec §8 auto default: cross-column substring; terms AND-combine.
              var terms = filterQ.toLowerCase().split(/\s+/).filter(Boolean);
              pass = terms.every(function (t) {
                return cfg.columns.some(function (c) {
                  var v = r[c.field];
                  return v !== null && v !== undefined && String(v).toLowerCase().indexOf(t) >= 0;
                });
              });
            }
            if (pass && hasColFilters()) pass = applyColFilters(r); // parents only
            if (pass) parentOk[r._key] = true;
            return pass;
          });
        }
      } else {
        if (filterQ && cfg.filter) out = out.filter(function (r) { return keepRow(r) || cfg.filter(r, filterQ); });
        else if (filterQ) {
          // spec §8 auto default: no screen predicate → case-insensitive
          // cross-column substring; whitespace terms AND-combine.
          var terms = filterQ.toLowerCase().split(/\s+/).filter(Boolean);
          out = out.filter(function (r) {
            if (keepRow(r)) return true;
            return terms.every(function (t) {
              return cfg.columns.some(function (c) {
                var v = r[c.field];
                return v !== null && v !== undefined && String(v).toLowerCase().indexOf(t) >= 0;
              });
            });
          });
        }
        if (hasColFilters()) out = out.filter(function (r) { return keepRow(r) || applyColFilters(r); });
      }
      // ── View sort (Task 5b) — optional per-column `sortable`. Composes with
      // filters (sorts the filtered set); never mutates `saved`. Suspended
      // while any row/bill is dirty (same doctrine as the filter bypass —
      // dirty data is never reordered out from under the user). Single-key
      // (one column at a time). Tree: parents sorted, children follow.
      if (sortState.field && sortState.dir && !anyDirty()) {
        out = cfg.tree ? applyViewSortTree(out) : applyViewSort(out);
      }
      return out;
    }
    function anyDirty() { return editIdx >= 0 || Object.keys(dirty).length > 0; }
    function mounted() { return !!tbody(); }
    function syncChrome() { if (cfg.onChrome) cfg.onChrome(anyDirty()); }

    // ── Fold (tree) ──
    // toggleFold flips a parent's fold state and re-renders. On unfold, if the
    // screen's cfg.children fetches lazily (Bills: bill.lines), the fetch fires
    // inside merged()→childrenOf on the re-render; the screen re-renders again
    // when data resolves. Space (Task 4) and the ▸/▾ caret (mouse parity) both
    // route through here.
    function toggleFold(row) {
      if (!cfg.tree || !row) return;
      cfg.fold(row, !cfg.isFolded(row));
      render(row._key);
    }

    // ── Tree edit resolution (Task 3) ──
    // In tree mode, editing a row means editing the WHOLE bill. A child row
    // resolves to its parent; the parent's index in merged() is its editIdx.
    // Returns { parent: <row>, parentIdx: <int> } or null (not editable / gone).
    function billParentOf(d) {
      if (!cfg.tree || !d) return null;
      var parent, m, i;
      if (d._childOf) {
        parent = rowByKey(d._childOf);
        if (!parent) return null;
      } else {
        parent = d;
      }
      m = merged();
      for (i = 0; i < m.length; i++) {
        if (m[i]._key === parent._key && !m[i]._childOf) return { parent: parent, parentIdx: i };
      }
      return null;
    }
    // DOM: the open child <tr>s that follow a parent <tr> (data-child-of match).
    function childTrsFor(parentTr, parentKey) {
      var out = [], sib = parentTr && parentTr.nextElementSibling;
      while (sib) {
        if (!sib.classList || !sib.classList.contains('fb-add-row')) {
          if (sib.dataset && sib.dataset.childOf === String(parentKey)) out.push(sib);
          else break; // a non-child row ends this bill's block
        }
        sib = sib.nextElementSibling;
      }
      return out;
    }

    // ── Column filters (spec §8) ─────────────────────────────────────────
    // One filter state, two views: per-column ≡ dropdowns (mouse) and the
    // topbar '/…' expression (keyboard) render the SAME state. `colFilters`
    // maps a column field → { op, value }; `filterQ` is the plain-text
    // cross-column query. Both are AND-combined in merged(); edit/dirty rows
    // always bypass (never hidden while edited).
    var colFilters = {};
    var toolbarEl = null;
    var headersWired = false;
    var ddEl = null;
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
        th.setAttribute('data-field', col.field); // canonical field ref (sort + filter)
        // Sortable header (Task 5b): ensure a .th-sort arrow span exists AFTER
        // the label and wire the asc→desc→none cycle. Guarded by class so a
        // re-wire on persistent ths doesn't stack handlers / duplicate spans.
        if (col.sortable && !th.classList.contains('fb-th-sortable')) {
          th.classList.add('fb-th-sortable');
          if (!th.querySelector('.th-sort')) {
            var sp = document.createElement('span');
            sp.className = 'th-sort';
            th.appendChild(sp); // appended after the label; collapses when empty
          }
          (function (thEl, field) {
            thEl.addEventListener('click', function (e) {
              if (e.target.closest && e.target.closest('.fb-filter-btn')) return; // filter btn owns its clicks
              if (editIdx >= 0) exitEdit(); // never lose a dirty buffer to a mouse sort
              cycleSort(field);
            });
          })(th, col.field);
        }
        if (!col.filterType || th.querySelector('.fb-filter-btn')) continue;
        th.classList.add('fb-th-filterable');
        th.setAttribute('tabindex', '0');
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
      syncSortHeaders();
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

    // ── Per-column sort (Task 5b) ──
    // Optional, per-column `sortable: true`. Single-key sort: clicking a
    // sortable header cycles asc → desc → none; `none` clears the sort and
    // restores server (`saved`) order — a re-render, NEVER a re-fetch. The
    // ▲/▼ arrow renders AFTER the label in a `.th-sort` span and collapses
    // when inactive (`.th-sort:empty{display:none}`). Mouse-only (no verb);
    // j/k/G/gg operate on the sorted+filtered sequence. Sort is a VIEW
    // concern: it composes with filters (sorts the filtered set), never
    // mutates `saved`, and is suspended while any row/bill is dirty (same
    // doctrine as the filter bypass — dirty data is never reordered out from
    // under the user). Tree: parents are sorted; children follow their parent.
    function syncSortHeaders() {
      var table = tbody() && tbody().closest('table');
      if (!table) return;
      cfg.columns.forEach(function (col) {
        if (!col.sortable) return;
        var th = table.querySelector('thead th[data-field="' + col.field + '"]');
        if (!th) return;
        var ic = th.querySelector('.th-sort');
        if (!ic) return;
        ic.textContent = (sortState.field === col.field && sortState.dir)
          ? (sortState.dir === 'asc' ? '\u25B2' : '\u25BC') : ''; // ▲ / ▼ / '' (collapses)
      });
    }
    function cycleSort(field) {
      if (sortState.field !== field) { sortState.field = field; sortState.dir = 'asc'; }
      else if (sortState.dir === 'asc') sortState.dir = 'desc';
      else { sortState.field = null; sortState.dir = null; } // none → restore server order
      syncSortHeaders();
      render();
    }
    function sortCmp(col, dir, a, b) {
      var av = a[col.field], bv = b[col.field];
      if (col.type === 'number') { av = Number(av); bv = Number(bv); }
      else { av = String(av == null ? '' : av).toLowerCase(); bv = String(bv == null ? '' : bv).toLowerCase(); }
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return 0;
    }
    function applyViewSort(arr) {
      var col = colByName(sortState.field);
      if (!col) return arr;
      var dir = sortState.dir === 'desc' ? -1 : 1;
      var indexed = arr.map(function (r, i) { return [r, i]; });
      indexed.sort(function (a, b) {
        var c = sortCmp(col, dir, a[0], b[0]);
        return c !== 0 ? c : (a[1] - b[1]); // stable tiebreak (ES5 safety)
      });
      return indexed.map(function (p) { return p[0]; });
    }
    function applyViewSortTree(arr) {
      var col = colByName(sortState.field);
      if (!col) return arr;
      var dir = sortState.dir === 'desc' ? -1 : 1;
      // Group the flat sequence into parent-blocks (a parent + its trailing
      // children); sort blocks by the PARENT's key; children stay attached to
      // their parent (order within a block unchanged).
      var blocks = [], cur = null;
      for (var i = 0; i < arr.length; i++) {
        var r = arr[i];
        if (!r._childOf) { cur = { parent: r, kids: [] }; blocks.push(cur); }
        else if (cur) cur.kids.push(r);
      }
      var ib = blocks.map(function (b, i) { return [b, i]; });
      ib.sort(function (a, b) {
        var c = sortCmp(col, dir, a[0].parent, b[0].parent);
        return c !== 0 ? c : (a[1] - b[1]);
      });
      var out = [];
      ib.forEach(function (p) { out.push(p[0].parent); p[0].kids.forEach(function (k) { out.push(k); }); });
      return out;
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

    // ── Actions bar (list-level verbs, spec §8) ──
    function ensureToolbar() {
      var table = tbody() && tbody().closest('table');
      if (!table || !table.parentNode || !cfg.actions || !cfg.actions.length) return;
      if (toolbarEl) return;
      // Re-exec safety: drop a stale toolbar left immediately before this table.
      var prev = table.previousElementSibling;
      if (prev && prev.classList.contains('fb-list-toolbar')) prev.remove();
      toolbarEl = document.createElement('div');
      toolbarEl.className = 'fb-list-toolbar';
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
      table.parentNode.insertBefore(toolbarEl, table);
    }

    // ── Topbar mirror (spec §8, unified-search model 2026-07-23) ──
    // The topbar global search is THE one filter input: a value starting with
    // '/' is a screen-limited filter expression for the visible FB.list. This
    // mirrors filter state into it (when the user is not typing in it) so the
    // ≡ dropdowns and the topbar are two views of the same state.
    function syncTopbar() {
      var gs = document.getElementById('tb-global-search');
      if (!gs || document.activeElement === gs) return;
      if (anyFilterActive()) gs.value = '/' + buildBoxExpr();
      else if (gs.value.charAt(0) === '/') gs.value = '';
    }
    function clearAllFilters() {
      colFilters = {}; filterQ = '';
      onFilterChanged();
    }
    function onFilterChanged() { render(); syncHeaderState(); syncSortHeaders(); syncTopbar(); }

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
      // Tree: a child row delegates its cell layout to cfg.childRowHtml. The
      // framework owns the <tr> shell (data-idx for nav, data-child-of, dirty
      // class) so the screen only writes cell HTML. Children render a different
      // layout from parents (Bills: description / expense-account / amount /
      // VAT-code / GST-amount) per the ratified contract.
      if (cfg.tree && d._childOf) {
        var parent = rowByKey(d._childOf);
        var inner = cfg.childRowHtml ? cfg.childRowHtml(parent, d, i) : '';
        return '<tr data-idx="' + i + '" data-child-of="' + esc(String(d._childOf)) + '"'
          + (d._dirty ? ' class="row-dirty"' : '') + '>' + inner + '</tr>';
      }
      var cells = cfg.columns.map(function (c, ci) {
        var v = c.display ? c.display(d[c.field], d) : defaultDisplay(d[c.field]);
        if (d._dirty) v = '<span class="dirty-val">' + v + '</span>';
        // Tree: fold caret leads the first cell (▸ folded / ▾ open). Mouse
        // parity for Space; inert on the add row (rendered separately).
        var caret = (cfg.tree && ci === 0)
          ? '<span class="fb-fold" data-fold="1" title="fold (Space)">' + (cfg.isFolded(d) ? '&#9656;' : '&#9662;') + '</span>'
          : '';
        return '<td data-field="' + c.field + '"' + (c.align === 'center' ? ' style="text-align:center"' : '') + '>' + caret + v + '</td>';
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
      if (cfg.actions) ensureToolbar();
      var m = merged();
      tb.innerHTML = m.map(rowHtml).join('') + addRowHtml(); // add row pinned bottom
      rows().forEach(function (tr) {
        tr.addEventListener('click', function (e) {
          // Tree: ▸/▾ caret toggles fold (mouse parity for Space). Stops
          // propagation so the same click does not also enter edit.
          if (cfg.tree && e.target.closest && e.target.closest('.fb-fold')) {
            e.stopPropagation();
            var fd = merged()[+tr.dataset.idx];
            if (fd) toggleFold(fd);
            return;
          }
          if (nav) nav.set(tr);
          var td = e.target.closest('td');
          if (!td || td.classList.contains('row-actions')) return;
          var d = merged()[+tr.dataset.idx];
          if (cfg.tree && d && d._childOf) {
            // Tree (Task 3): a child click opens the whole bill — gate on the
            // parent's editability, not the child's (children have no status).
            var pp = rowByKey(d._childOf);
            if (pp && cfg.editable && !cfg.editable(pp)) return;
          } else if (cfg.editable && d && !cfg.editable(d)) return; // read-only row
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

    // ── Tree whole-bill edit (Task 3) ──
    // Entering edit on any row of a draft bill opens the WHOLE bill: the parent
    // row is rewritten as header inputs (editCell machinery) and each open
    // child row is rewritten via cfg.editChildRowHtml. editIdx tracks the
    // PARENT's index in merged(); editKey = parent._key. Esc never saves.
    function enterEditTree(idx, field, d0) {
      var res = billParentOf(d0);
      if (!res) return;
      var parent = res.parent, parentIdx = res.parentIdx;
      if (cfg.editable && !cfg.editable(parent)) return; // posted bill: read-only
      if (editIdx >= 0) exitEdit(); // click-away: keep the prior bill's dirty buffer
      if (editKey === parent._key) return; // already editing this bill
      // Whole-bill doctrine: unfold so every child line is editable in place.
      if (cfg.isFolded(parent)) { cfg.fold(parent, true); render(parent._key); }
      var tr = rows()[parentIdx];
      if (!tr) return;
      editIdx = parentIdx;
      editKey = parent._key;
      // Parent row → header inputs (same editCell machinery as flat lists).
      tr.innerHTML = cfg.columns.map(function (c) {
        return '<td data-field="' + c.field + '"' + (c.align === 'center' ? ' style="text-align:center"' : '') + '>' + editCell(c, parent) + '</td>';
      }).join('')
        + '<td class="row-actions"><a class="chip chip-ok" title="write (w)" data-act="write">✓</a> '
        + '<a class="chip chip-cancel" title="exit (Esc)" data-act="exit">✕</a></td>';
      tr.classList.add('row-editing');
      if (parent._isNew) hideAddRow(tbody()); // add row transforms INTO the edit row
      // Open child rows → edit-mode HTML (cfg.editChildRowHtml). The framework
      // owns the <tr> shell (data-idx/data-child-of); the screen writes cells.
      var kids = childrenOf(parent);
      var kidTrs = childTrsFor(tr, parent._key);
      for (var ci = 0; ci < kidTrs.length && ci < kids.length; ci++) {
        var inner = cfg.editChildRowHtml ? cfg.editChildRowHtml(parent, kids[ci], ci) : '';
        kidTrs[ci].innerHTML = inner;
        kidTrs[ci].classList.add('row-editing');
        // cfg.attachChild(tr, parent, idx) — post-build hook for child-row
        // dropdowns/behaviors (mirrors the column-level `attach` hook).
        if (cfg.attachChild) cfg.attachChild(kidTrs[ci], parent, ci);
      }
      wireChips(tbody());
      cfg.columns.forEach(function (c) {
        if (c.attach && editable(c, parent)) {
          var inp = tr.querySelector('.fb-e-' + c.field);
          if (inp) c.attach(inp, tr);
        }
      });
      if (window.FB && FB.mode) FB.mode.set('INSERT');
      window.fbEditActive = true;
      var f = (field && cfg.columns.some(function (c) { return c.field === field && editable(c, parent); }))
        ? field : cfg.firstField(parent._isNew);
      var target = tr.querySelector('.fb-e-' + f) || tr.querySelector('input,select');
      if (target) { target.focus(); if (target.select) target.select(); }
      syncChrome();
    }

    function enterEdit(idx, field) {
      if (editIdx === idx && !cfg.tree) return;
      var d0 = merged()[idx];
      if (!d0) return;
      // Tree: edit the WHOLE bill — resolve child → parent (Task 3).
      if (cfg.tree) return enterEditTree(idx, field, d0);
      if (cfg.editable && !cfg.editable(d0)) return; // read-only row (e.g. ECB rate)
      if (editIdx >= 0) exitEdit(); // click-away: exit, dirty buffer kept
      var d = merged()[idx];
      var tr = rows()[idx];
      if (!d || !tr) return;
      editIdx = idx;
      editKey = d._key;
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
    // Tree (Task 3): harvest the WHOLE bill — parent header inputs PLUS each
    // open child row's inputs (cfg.harvestChild) — into ONE bill buffer keyed
    // by the parent _key, carrying { lines: [...], _isBill: true }.
    function exitEditTree() {
      var d = merged()[editIdx]; // the parent (editIdx tracks the parent)
      var tr = rows()[editIdx];
      var key = d ? d._key : null;
      var vanished = false;
      if (d && tr) {
        var buf = {};
        cfg.columns.forEach(function (c) {
          var inp = tr.querySelector('.fb-e-' + c.field);
          if (!inp) { buf[c.field] = d[c.field]; return; } // ro column: keep
          if (c.type === 'checkbox') buf[c.field] = inp.checked;
          else if (c.type === 'number') buf[c.field] = parseFloat(inp.value) || 0;
          else if (c.type === 'select') buf[c.field] = c.nullable ? (inp.value || null) : inp.value;
          else { var v = inp.value.trim(); buf[c.field] = c.uppercase ? v.toUpperCase() : v; }
        });
        // Lines: harvest each open child <tr> (screen-provided cfg.harvestChild).
        var lines = [];
        if (cfg.harvestChild) {
          var kidTrs = childTrsFor(tr, d._key);
          for (var i = 0; i < kidTrs.length; i++) lines.push(cfg.harvestChild(kidTrs[i]));
        }
        buf.lines = lines;
        buf._isBill = true;
        if (d._isNew) {
          if (!cfg.isBlank(buf)) dirty[d._key] = Object.assign(buf, { isNew: true });
          else { delete dirty[d._key]; vanished = true; } // nothing from nothing
        } else {
          var s = null;
          for (var j = 0; j < saved.length; j++) if (saved[j]._key === d._key) s = saved[j];
          if (s && cfg.same(buf, s)) delete dirty[d._key];
          else dirty[d._key] = Object.assign(buf, { isNew: false });
        }
      }
      editIdx = -1;
      editKey = null;
      if (window.FB && FB.mode) FB.mode.set('NORMAL');
      window.fbEditActive = false;
      render(vanished ? ADD_ROW : key);
      syncChrome();
    }

    function exitEdit() {
      if (editIdx < 0) return;
      if (cfg.tree) return exitEditTree();
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
      editKey = null;
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
      // Tree (Task 3): resolve to the bill; write the WHOLE bill (header +
      // lines) in ONE cfg.save call. The buffer lives at dirty[parent._key].
      if (cfg.tree) {
        var res = billParentOf(d);
        if (!res) return Promise.resolve(true);
        var bill = dirty[res.parent._key];
        if (!bill) return Promise.resolve(true);
        var berr = cfg.validate(bill);
        if (berr) { msg(berr, true); return Promise.resolve(false); }
        return post(cfg.save.action, cfg.save.body(bill)).then(function (r2) {
          var dd2 = r2.data || r2;
          if ((dd2 && dd2.error) || r2.error) { msg(dd2.error || r2.error, true); return false; } // stays dirty
          delete dirty[res.parent._key];
          msg('Saved', false);
          load(cfg.save.focusKey ? cfg.save.focusKey(bill, dd2) : res.parent._key);
          return true;
        }).catch(function (e) { msg(e.message, true); return false; });
      }
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
      // Tree (Task 3): revert the WHOLE bill buffer keyed by the parent.
      if (cfg.tree) {
        var res = billParentOf(d);
        if (!res) return;
        var wasNew = dirty[res.parent._key] && dirty[res.parent._key].isNew;
        delete dirty[res.parent._key];
        render(wasNew ? ADD_ROW : res.parent._key);
        syncChrome();
        return;
      }
      delete dirty[d._key];
      render(d._isNew ? ADD_ROW : d._key); // discarded new row → cursor on the add row
      syncChrome();
    }

    function deleteFocused() {
      var idx = focusedIdx();
      if (idx < 0) return;
      var d = merged()[idx];
      if (!d) return;
      // Tree (Task 3): x on any row of a draft deletes the WHOLE bill.
      if (cfg.tree) {
        var res = billParentOf(d);
        if (!res) return;
        var parent = res.parent;
        if (parent._isNew) { delete dirty[parent._key]; render(ADD_ROW); syncChrome(); return; }
        if (!cfg.del) return;
        if (cfg.deletable && !cfg.deletable(parent)) return;
        if (!confirm(cfg.del.confirm(parent))) return;
        post(cfg.del.action, cfg.del.body(parent)).then(function (r2) {
          var dd = r2.data || r2;
          if ((dd && dd.error) || r2.error) { msg(dd.error || r2.error, true); return; }
          delete dirty[parent._key];
          load();
        }).catch(function (e) { msg(e.message, true); });
        return;
      }
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
      dirty[key] = Object.assign(cfg.blank(), { isNew: true, _isBill: !!cfg.tree });
      // Tree (Task 3): open the new bill's fold so its child lines render and
      // the whole-bill edit unit shows parent + first child inputs.
      if (cfg.tree) cfg.fold({ _key: key }, true);
      render(key);
      // New rows append at the bottom, right where the add row was. Look the
      // index up by key — an active filter could otherwise mis-target row 0.
      var m = merged(), idx = -1;
      for (var i = 0; i < m.length; i++) if (m[i]._key === key && !m[i]._childOf) { idx = i; break; }
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
    // Local focusedRow (Task 4): the focused merged() row, or null on the add
    // row / empty list. Tree bindings (Space fold, `a` add-child) resolve the
    // focused bill through this; the add row yields null (Space/`a` inert there).
    function focusedRow() { var i = focusedIdx(); return i >= 0 ? merged()[i] : null; }
    function editFocused() {
      var tr = nav && nav.current();
      if (tr && tr.classList.contains('fb-add-row')) { newRow(); return; } // i on the add row = create
      var idx = focusedIdx();
      var d = idx >= 0 ? merged()[idx] : null;
      // Tree (Task 3): edit resolves to the bill; a posted bill is a no-op
      // (editable false on the parent). Enter on a child opens the whole bill.
      if (cfg.tree) {
        var res = d ? billParentOf(d) : null;
        if (res && cfg.editable && !cfg.editable(res.parent)) return; // posted: no-op
        enterEdit(idx >= 0 ? idx : 0);
        return;
      }
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

    // ── `a` verb: add a child line to the focused draft bill (Task 4) ──
    // cfg.addChild(parent) returns a blank line object (screen provides the
    // shape). The framework harvests the bill's current DOM inputs into the
    // dirty buffer (without vanishing a blank new bill), appends the line,
    // re-renders, re-enters edit, and focuses the new (last) child's first
    // field. If the bill is not yet in edit mode, `a` enters edit first (opens
    // the fold + fetches children for a saved draft); the user presses `a`
    // again once the children are rendered. Inert on posted bills.
    function addChildLine() {
      if (!cfg.tree) return;
      var d = focusedRow();
      if (!d) return;
      var res = billParentOf(d);
      if (!res) return;
      var parent = res.parent;
      if (cfg.editable && !cfg.editable(parent)) return; // posted: no-op
      if (!cfg.addChild) { editFocused(); return; }       // no line-shape hook → just enter edit
      var key = parent._key;
      // Not yet editing this bill → enter edit (opens fold, fetches children).
      if (editIdx < 0 || editKey !== key) { editFocused(); return; }
      var tr = rows()[editIdx];
      if (!tr) return;
      // Harvest current parent + child inputs into the buffer (always keep —
      // never vanish a bill the user is actively adding a line to).
      var buf = {};
      cfg.columns.forEach(function (c) {
        var inp = tr.querySelector('.fb-e-' + c.field);
        if (!inp) { buf[c.field] = parent[c.field]; return; } // ro column: keep
        if (c.type === 'checkbox') buf[c.field] = inp.checked;
        else if (c.type === 'number') buf[c.field] = parseFloat(inp.value) || 0;
        else if (c.type === 'select') buf[c.field] = c.nullable ? (inp.value || null) : inp.value;
        else { var v = inp.value.trim(); buf[c.field] = c.uppercase ? v.toUpperCase() : v; }
      });
      var lines = [];
      if (cfg.harvestChild) {
        var kidTrs = childTrsFor(tr, key);
        for (var i = 0; i < kidTrs.length; i++) lines.push(cfg.harvestChild(kidTrs[i]));
      }
      lines.push(cfg.addChild(parent));
      buf.lines = lines;
      buf._isBill = true;
      dirty[key] = Object.assign(buf, { isNew: !!parent._isNew });
      // Clear edit state (we'll re-enter) to avoid exitEdit re-harvesting.
      editIdx = -1; editKey = null;
      if (window.FB && FB.mode) FB.mode.set('NORMAL');
      window.fbEditActive = false;
      cfg.fold(parent, true); // ensure the new child renders
      render(key);
      var m = merged(), idx = -1;
      for (var j = 0; j < m.length; j++) if (m[j]._key === key && !m[j]._childOf) { idx = j; break; }
      if (idx < 0) return;
      enterEdit(idx, cfg.firstField(parent._isNew));
      // Focus the last child's first input (the newly appended line).
      var ptr = rows()[idx];
      if (ptr) {
        var ks = childTrsFor(ptr, key);
        var last = ks[ks.length - 1];
        if (last) { var f = last.querySelector('input,select'); if (f) { f.focus(); if (f.select) f.select(); } }
      }
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
      // G/gg: cursor to bottom/top AND page to absolute bottom/top (Bills parity —
      // scrollIntoView 'nearest' alone under-scrolls long lists in #page-main).
      { key: 'G', mode: 'NORMAL', run: function () {
          nav.last(); // bottom = add row
          var pm = document.getElementById('page-main');
          if (pm) pm.scrollTo(0, pm.scrollHeight);
        } },
      { key: 'g', mode: 'NORMAL', run: function () {
          if (_gPending) {
            _gPending = false; clearTimeout(_gTimer); nav.first();
            var pm = document.getElementById('page-main');
            if (pm) pm.scrollTo(0, 0);
            return;
          }
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
      // Esc peels one layer at a time (never writes): open filter dropdown →
      // close it; active filters → clear them; otherwise inert (falls through).
      bindings.push({ key: 'Escape', mode: 'NORMAL', when: function () { return !!ddEl; }, run: closeColDropdown });
      bindings.push({ key: 'Escape', mode: 'NORMAL', when: anyFilterActive, run: clearAllFilters });
      bindings.push({ key: 'c', mode: 'NORMAL', hint: 'clear filters', hintBar: true, when: anyFilterActive, run: clearAllFilters });
    }
    if (cfg.actions) {
      cfg.actions.forEach(function (a) {
        bindings.push({ key: a.key, mode: 'NORMAL', hint: a.label, hintBar: true, run: function () { if (editIdx >= 0) exitEdit(); a.handler(api); } });
      });
    }
    if (cfg.tree) {
      // Space = FOLD (vim fold semantics, Task 4): toggles the bill under the
      // cursor — on a parent folds that bill, on a child folds its parent;
      // inert on the add row (focusedRow() returns null there). Mouse parity
      // is the ▸/▾ caret in rowHtml. Enter = edit everywhere is already wired
      // (Task 3 — editFocused resolves child→parent; posted bills no-op).
      bindings.push({ key: ' ', mode: 'NORMAL', hint: 'fold', hintBar: true,
        when: function () { return !!focusedRow(); },
        run: function () {
          var d = focusedRow();
          if (d) toggleFold(d._childOf ? rowByKey(d._childOf) : d);
        } });
      // `a` = add child line to the focused draft bill (Task 4). cfg.addChild
      // provides the blank line shape; the framework appends it + focuses the
      // new child's first field. Guarded on the parent's editability (drafts).
      bindings.push({ key: 'a', mode: 'NORMAL', hint: 'add line', hintBar: true,
        when: function () {
          var d = focusedRow();
          if (!d) return false;
          var p = d._childOf ? rowByKey(d._childOf) : d;
          return !!(p && (!cfg.editable || cfg.editable(p)));
        },
        run: addChildLine });
    }
    function registerKeys() {
      if (!(window.FB && FB.keys)) return;
      nav = FB.nav.create({ rows: navRows, focusClass: cfg.focusClass || 'nav-row-focus', onFocus: cfg.onFocus || undefined });
      if (FB.keys.unregister) FB.keys.unregister(cfg.keysId);
      var all = bindings.slice();
      if (cfg.extraInsertBindings) {
        // Prepend the screen's INSERT bindings ahead of the GENERAL INSERT set
        // (the unguarded INSERT Escape/Enter/Tab at the tail of `bindings`), so
        // tree sub-modes (Bills' inline pay row) win over field-advance. The
        // dropdown bindings (guarded by `when: ddOpen`) stay first — dropdown
        // parity is preserved. (Task 4.)
        var ei = cfg.extraInsertBindings(api) || [];
        var gi = -1;
        for (var bi = 0; bi < all.length; bi++) {
          if (all[bi].mode === 'INSERT' && !all[bi].when) { gi = bi; break; }
        }
        if (gi < 0) gi = all.length;
        Array.prototype.splice.apply(all, [gi, 0].concat(ei));
      }
      if (cfg.extraBindings) all = all.concat(cfg.extraBindings(api));
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
      hasFilterSurface: hasFilterSurface,
      anyFilterActive: anyFilterActive,
      visible: function () { var t = tbody(); return !!(t && t.offsetParent); },
      // Topbar-routed filter expression (unified-search model): parse + apply
      // without touching the topbar input the user is typing in.
      applyFilterExpr: function (str) {
        parseBoxExpr(str || '');
        render();
        syncHeaderState();
      },
      filterExpr: function () { return buildBoxExpr(); },
      setFilter: function (q) {
        filterQ = q || ''; // plain-text portion only — column filters are preserved
        if (editIdx >= 0) { editIdx = -1; editKey = null; if (window.FB && FB.mode) FB.mode.set('NORMAL'); window.fbEditActive = false; }
        render();
        syncHeaderState();
        syncTopbar();
        syncChrome();
      },
      nav: function () { return nav; },
      focusedRow: focusedRow,
      addChild: addChildLine, // tree: same flow as the `a` verb (Tab-spawn uses it)
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
      if (editIdx >= 0) { editIdx = -1; editKey = null; if (window.FB && FB.mode) FB.mode.set('NORMAL'); window.fbEditActive = false; }
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
    guard: function (proceed) { openLeaveModal(proceed); },
    // Unified-search routing (2026-07-23): the topbar global search routes
    // '/…' expressions to the currently visible filterable list instance.
    visible: function () {
      for (var i = 0; i < instances.length; i++) {
        var inst = instances[i];
        if (inst.mounted() && inst.visible() && inst.hasFilterSurface()) return inst;
      }
      return null;
    }
  };
})();
