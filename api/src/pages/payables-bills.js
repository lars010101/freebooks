'use strict';

function billsTabJS() {
  return `
// ========== BILLS STATE ==========
var allBills = [];
var allPeriods = []; // loaded on init for popup period check
var filteredBills = [];
var today = new Date().toISOString().slice(0,10);
var in7days = new Date(Date.now() + 7*24*3600*1000).toISOString().slice(0,10);
var PAGE_SIZE = 20;
var currentPage = 1;
var sortState = { col: null, dir: 'asc' };
var colFilters = {};
var taxCodeMap = {}; // vat_code -> description
var taxCodeRateMap = {}; // vat_code -> { rate, is_reverse_charge } (for GST default computation)

// Company-level default AP/expense account codes, loaded from settings on page
// init. Blank ('') when unset — used as fallbacks in place of the old hardcoded
// '201100' (AP) and '400000' (expense) defaults. Vendor defaults still override
// these; see _loadCompanyDefaults() and the vendor-selection handler.
var companyDefaultAp = '';
var companyDefaultExpense = '';

var draftLines = {}; // { draftKey: [{desc, amount, vatCode}] } -- source of truth for draft child rows

var treeState = {
  open: new Set(),
  isOpen: function(billId) { return this.open.has(String(billId)); },
  toggle: function(billId) {
    billId = String(billId);
    if (this.open.has(billId)) this.open.delete(billId);
    else this.open.add(billId);
  },
  setOpen: function(billId) { this.open.add(String(billId)); },
  setClose: function(billId) { this.open.delete(String(billId)); }
};

var cursor = {
  rowEl: null,
  col: 0,
  // mode is backed by FB.mode (single store — P1-3 shared core); see the
  // Object.defineProperty + FB.mode.onChange wiring right after this object.

  set: function(rowEl, col) {
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    document.querySelectorAll('tr.bill-row-focus').forEach(function(r){ r.classList.remove('bill-row-focus'); });
    document.querySelectorAll('tr.nav-row-focus').forEach(function(r){ r.classList.remove('nav-row-focus'); });
    this.rowEl = rowEl || null;
    this.col = (col != null) ? col : 0;
    if (!rowEl) { return; }
    rowEl.classList.add('bill-row-focus');
    // cursor.col is kept (clamped) for the transitional per-cell INSERT model;
    // NORMAL mode no longer highlights a single cell (row-only selection).
    var cells = rowEl.querySelectorAll('td');
    if (this.col >= cells.length) this.col = cells.length - 1;
    var pm = document.getElementById('page-main');
    var rows = this.getVisibleRows();
    if (pm && rows.length && rows[0] === rowEl) {
      pm.scrollTo(0, 0);
    } else if (pm) {
      var rect = rowEl.getBoundingClientRect();
      var pmRect = pm.getBoundingClientRect();
      var pad = 8;
      if (rect.top < pmRect.top + pad) {
        pm.scrollBy({ top: rect.top - pmRect.top - pad, behavior: 'instant' });
      } else if (rect.bottom > pmRect.bottom - pad) {
        pm.scrollBy({ top: rect.bottom - pmRect.bottom + pad, behavior: 'instant' });
      }
    } else {
      rowEl.scrollIntoView({ block: 'nearest' });
    }
  },

  clear: function() { this.set(null, 0); },

  getVisibleRows: function() {
    var tbody = document.getElementById('bills-tbody');
    if (!tbody) return [];
    return Array.from(tbody.querySelectorAll('tr[data-row-type="parent"], tr[data-row-type="child"]'));
  },

  currentIndex: function() {
    if (!this.rowEl) return -1;
    return this.getVisibleRows().indexOf(this.rowEl);
  }
};

// cursor.mode is backed by FB.mode (P1-3 single mode store): all existing
// cursor.mode reads/writes transparently hit the shared store. The INSERT
// tbody class follows via listener (was the old property setter side-effect).
Object.defineProperty(cursor, 'mode', {
  get: function() { return FB.mode.get(); },
  set: function(v) { FB.mode.set(v); }
});
FB.mode.onChange(function(v) {
  var tbody = document.getElementById('bills-tbody');
  if (!tbody) return;
  if (v === 'INSERT') tbody.classList.add('insert-mode'); else tbody.classList.remove('insert-mode');
  _applyCcyColVisibility(); // CCY column returns while editing (CCY input)
});

var billAccountsList = [];

var AVATAR_COLORS = ['#4f6ef7','#e05c5c','#2bac72','#e09d3a','#9b59c4','#17a2b8','#e07840','#5c7ae0'];

// ========== ACCOUNT AUTOCOMPLETE (bills tab) ==========
function loadBillAccounts() {
  if (billAccountsList.length) return;
  fetch('/api/' + COMPANY + '/accounts')
    .then(function(r) { return r.json(); })
    .then(function(rows) {
      billAccountsList = Array.isArray(rows) ? rows : [];
    })
    .catch(function() {});
}

// ── FB.dropdown sources (P2-1) ─────────────────────────────────────────────
// Account codes (AP + expense): contains-match on code AND name.
function _acctSource(q) {
  q = (q || '').trim().toLowerCase();
  return billAccountsList.filter(function(a) {
    if (!q) return true;
    return (a.account_code || '').toLowerCase().indexOf(q) >= 0 ||
           (a.account_name || '').toLowerCase().indexOf(q) >= 0;
  }).map(function(a) {
    return { primary: a.account_code, secondary: a.account_name || '', data: { code: a.account_code } };
  });
}
function _attachAcctDropdown(input) {
  if (!input) return;
  FB.dropdown.attach(input, {
    source: _acctSource,
    onPick: function(item, inp) {
      inp.value = item.data.code;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}
// VAT codes: '— None —' plus every code in taxCodeMap (contains-match).
function _vatSource(q) {
  q = (q || '').trim().toLowerCase();
  var items = [];
  if (!q || 'none'.indexOf(q) >= 0) items.push({ primary: '— None —', data: { code: '' } });
  Object.keys(taxCodeMap).forEach(function(code) {
    var name = taxCodeMap[code] || '';
    if (!q || code.toLowerCase().indexOf(q) >= 0 || name.toLowerCase().indexOf(q) >= 0) {
      items.push({ primary: code, secondary: name, data: { code: code } });
    }
  });
  return items;
}
// Wire a VAT-code input: FB.dropdown + commit-on-pick/blur-if-changed.
// commit() runs the builder-specific sync + GST recompute + parent total.
function _attachVatDropdown(input, commit) {
  if (!input) return;
  input.dataset.lastCode = input.value.trim();
  function _commit() {
    input.dataset.lastCode = input.value.trim();
    commit();
  }
  FB.dropdown.attach(input, {
    source: _vatSource,
    onPick: function(item, inp) { inp.value = item.data.code; _commit(); }
  });
  input.addEventListener('input', function() { input.classList.remove('req'); });
  input.addEventListener('blur', function() {
    if (input.value.trim() !== (input.dataset.lastCode || '')) _commit();
  });
}
// Save-time guard: every line's VAT code must be blank or a known tax code.
function _validateDraftVatCodes(parentTr) {
  var bad = null;
  Array.from(parentTr.parentNode.querySelectorAll('tr[data-parent-key="' + (parentTr.dataset.draftKey || parentTr.dataset.billId) + '"] input.child-vat')).forEach(function(inp) {
    var v = inp.value.trim();
    if (v && !taxCodeMap[v]) { bad = bad || inp; inp.classList.add('req'); }
  });
  if (bad) billEditMsg('Invalid VAT code "' + bad.value.trim() + '" — pick from the dropdown', 'err');
  return !bad;
}

// ========== KEYBOARD HANDLER (FB.keys binding table — P1-3 shared core) ==========
// All bills-tab keys are declared in ONE binding table (_bindings). The table
// drives both dispatch (FB.keys — a single capture-phase listener installed by
// fb-core, running before common.js's bubble handler) and the footer hint bar
// (FB.keys.renderHints), so hints cannot drift from behavior. Unlisted keys
// fall through: in INSERT they type into inputs ("inert" = no nav action, NOT
// preventDefault); in NORMAL they reach common.js (h/l tabs, {/} pages,
// / search, : palette). NORMAL verbs are auto-inert while typing in an input
// (FB.keys editable-target guard).
var kbd = {
  _lastMoveTime: 0,
  _gPending: false,
  _gTimer: null,

  register: function() {
    FB.keys.register('bills', {
      active: this._isBillsTabActive,
      getMode: function() { return cursor.mode; },
      bindings: this._bindings()
    });
    // Input tracking: add kb-active on keydown, remove on mousemove
    // Hover highlight is disabled when kb-active is present or cursor is in INSERT mode
    if (!window._fbInputTrackerSetup) {
      window._fbInputTrackerSetup = true;
      document.addEventListener('keydown', function() {
        var t = document.getElementById('bills-tbody');
        if (t) t.classList.add('kb-active');
      }, true);
      document.addEventListener('mousemove', function() {
        var t = document.getElementById('bills-tbody');
        if (t) t.classList.remove('kb-active');
      }, true);
    }
  },

  _isBillsTabActive: function() {
    var bills_panel = document.getElementById('pay-panel-bills');
    if (!bills_panel) return false;
    return bills_panel.style.display !== 'none';
  },

  _bindings: function() {
    var self = this;
    var draftRow = function() { return !!(cursor.rowEl && cursor.rowEl.dataset.draft === 'true'); };
    var ddOpen = function() { return FB.dropdown.isOpen(); };
    var hasRows = function() { return cursor.getVisibleRows().length > 0; };
    return [
      // ── NORMAL: navigation ──
      // j/k swallow only when rows exist; otherwise common.js may try (it
      // no-ops on the bills tab via fbBillNav — preserved old semantics).
      { key: 'j', mode: 'NORMAL', hint: 'navigate', hintBar: true,
        swallow: hasRows, run: function() { self._move(1); } },
      { key: 'k', mode: 'NORMAL', hint: 'navigate', hintBar: true,
        swallow: hasRows, run: function() { self._move(-1); } },
      { key: 'Enter', mode: 'NORMAL', hint: 'fold', hintBar: true,
        run: function() { self._normalEnter(); } },
      { key: ' ', mode: 'NORMAL',
        run: function() { self._toggleFold(); } },
      { key: 'G', mode: 'NORMAL',
        run: function() { var rows = cursor.getVisibleRows(); if (rows.length) cursor.set(rows[rows.length - 1], 0); } },
      { key: 'g', mode: 'NORMAL',
        run: function() { self._gg(); } },
      // ── NORMAL: actions ──
      { key: 'i', mode: 'NORMAL', hint: 'edit', hintBar: true,
        run: function() { self._normalEdit(); } },
      { key: 'o', mode: 'NORMAL', hint: 'new bill', hintBar: true,
        run: function() { createDraftBill(cursor.rowEl || null); } },
      { key: 'O', mode: 'NORMAL',
        run: function() { if (!cursor.rowEl) createDraftBill(null); else insertDraftParentRow(cursor.rowEl, true); } },
      { key: 'a', mode: 'NORMAL', hint: 'add line', hintBar: true,
        run: function() { self._normalAddLine(); } },
      { key: 'x', mode: 'NORMAL', hint: 'delete', hintBar: true,
        run: function() { self._deleteCurrent(); } },
      { key: 'p', mode: 'NORMAL', hint: 'post', hintBar: true,
        run: function() { self._normalPost(); } },
      // ── INSERT (draft bill editing) ──
      { key: 'Escape', mode: 'INSERT', when: ddOpen,
        run: function() { FB.dropdown.close(); } },
      { key: 'Escape', mode: 'INSERT', hint: 'save/cancel', hintBar: true,
        run: function() { self._insertEscape(); } },
      { key: 'Enter', mode: 'INSERT',
        run: function() { self._insertEnter(); } },
      // ── INSERT: dropdown open ──
      { key: 'ArrowDown', mode: 'INSERT', when: ddOpen,
        run: function() { FB.dropdown.move(1); } },
      { key: 'ArrowUp', mode: 'INSERT', when: ddOpen,
        run: function() { FB.dropdown.move(-1); } },
      { key: 'Tab', mode: 'INSERT', when: ddOpen, swallow: false, preventDefault: false,
        run: function() { FB.dropdown.pick(); } },
      // ── INSERT: dropdown closed — ArrowDown on a dropdown field opens the full list ──
      { key: 'ArrowDown', mode: 'INSERT', when: function(e) { return !ddOpen() && FB.dropdown.attachable(e.target); },
        run: function(e) { FB.dropdown.openFull(e.target); } },
      // Draft rows: native Tab traverses the bill's inputs — not swallowed,
      // not prevented (matches the old early-return).
      { key: 'Tab', mode: 'INSERT', when: draftRow, swallow: false, preventDefault: false,
        run: function() {} },
      // Non-draft INSERT: Tab blocked (old behavior).
      { key: 'Tab', mode: 'INSERT',
        run: function() {} }
    ];
  },

  _move: function(dir) {
    var now = Date.now(); if (now - this._lastMoveTime < 40) return; this._lastMoveTime = now;
    var rows = cursor.getVisibleRows();
    var idx = cursor.currentIndex();
    if (dir > 0) {
      // Seamless bill-boundary crossing: no blocking from child -> next parent.
      if (idx === -1 && rows.length) cursor.set(rows[0], 0);
      else if (idx >= 0 && idx < rows.length - 1) cursor.set(rows[idx + 1], 0);
    } else {
      // Seamless bill-boundary crossing: no blocking from child -> previous parent.
      if (idx > 0) cursor.set(rows[idx - 1], 0);
      // Sticky at top: idx === 0 -> no-op (no deselect)
    }
  },

  _gg: function() {
    if (!this._gPending) {
      this._gPending = true;
      clearTimeout(this._gTimer);
      var self = this;
      this._gTimer = setTimeout(function() { self._gPending = false; }, 500);
      return;
    }
    // Double g: scroll to top + highlight first row
    this._gPending = false;
    clearTimeout(this._gTimer);
    var rows = cursor.getVisibleRows();
    if (rows.length) cursor.set(rows[0], 0);
  },

  // Esc on a draft bill: save (or discard if empty) and exit to NORMAL.
  _insertEscape: function() {
    // For draft bills, save and exit INSERT mode directly
    if (cursor.rowEl && cursor.rowEl.dataset.draft === 'true') {
      FB.dropdown.close();
      // Blur active input
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      // Find parent row
      var parentRow = cursor.rowEl;
      if (parentRow.dataset.rowType === 'child') {
        // Find parent row for child
        var pKey = parentRow.dataset.parentKey || parentRow.dataset.parentId;
        parentRow = pKey ? (document.querySelector('tr[data-row-type="parent"][data-draft-key="' + pKey + '"]') || document.querySelector('tr[data-row-type="parent"][data-bill-id="' + pKey + '"]')) : null;
      }
      if (parentRow && parentRow.dataset.draft === 'true') {
        // Check if bill is completely empty — if so, discard instead of saving
        if (_isDraftEmpty(parentRow)) {
          _discardDraftBill(parentRow);
          // _discardDraftBill already sets cursor to next row or clears it.
          // Don't call cursor.set(parentRow) — parentRow is already removed from DOM.
          cursor.mode = 'NORMAL';
          return;
        } else {
          saveDraftToDb(parentRow);
        }
      }
      cursor.mode = 'NORMAL';
      // Restore row highlight
      if (parentRow && parentRow.parentNode) cursor.set(parentRow, 0);
      return;
    }
    // Non-draft INSERT mode is no longer possible (bill-level INSERT only
    // for drafts). Nothing to exit.
  },

  // Enter in INSERT: pick open dropdown item; FX-check on the CCY field;
  // else advance to next input; else (last input) exit INSERT.
  _insertEnter: function() {
    if (cursor.rowEl && cursor.rowEl.dataset.draft === 'true') {
      if (FB.dropdown.isOpen()) { FB.dropdown.pick(); return; }
      var ae = document.activeElement;
      // FX rate check on Enter in the CCY field (spec §FX Handling). Was dead
      // since P1-3 — FB.keys swallows Enter at capture before input handlers —
      // so it lives here now.
      if (ae && ae.classList && ae.classList.contains('draft-ccy-input')) {
        var entCcy = ae.value.trim().toUpperCase();
        if (entCcy && entCcy !== BASE_CURRENCY.toUpperCase()) {
          var pInps = cursor.rowEl.querySelectorAll('input');
          var entDate = pInps[1] ? pInps[1].value : '';
          billEditMsg('FX: checking rate for ' + entCcy + '…', '');
          _getFxRate(entCcy, entDate).then(function(rate) {
            if (rate !== null) {
              billEditMsg('FX: 1 ' + entCcy + ' = ' + rate + ' ' + BASE_CURRENCY, 'ok');
            } else {
              billEditMsg('FX: no rate for ' + entCcy + ' on ' + (entDate || 'this date') + '. Add in Settings.', 'err');
            }
            setTimeout(function() { billEditMsg('', ''); }, 4000);
          });
          return;
        }
      }
      var draftInputs = Array.from(cursor.rowEl.querySelectorAll('input.draft-input'));
      var dIdx = draftInputs.indexOf(ae);
      if (dIdx >= 0 && dIdx < draftInputs.length - 1) {
        draftInputs[dIdx + 1].focus();
      } else { if (ae) ae.blur(); cursor.mode = 'NORMAL'; }
      return;
    }
    // Non-draft INSERT is no longer possible — nothing to exit.
  },

  // Helper: check if the current row's bill is editable (not void/paid/posted)
  _isRowEditable: function() {
    if (!cursor.rowEl) return false;
    var row = cursor.rowEl;
    // Draft rows (data-draft='true') are always editable
    if (row.dataset.draft === 'true') return true;
    // For non-draft rows, check the parent bill's status
    var statusRow = row;
    if (row.dataset.rowType === 'child') {
      var pKey = row.dataset.parentKey || row.dataset.parentId;
      statusRow = pKey
        ? (document.querySelector('tr[data-row-type="parent"][data-draft-key="' + pKey + '"]') ||
           document.querySelector('tr[data-row-type="parent"][data-bill-id="' + pKey + '"]'))
        : null;
      if (!statusRow) return false;
    }
    var st = statusRow.dataset.status || '';
    // Only draft status is editable; void/paid/posted/partial are read-only
    return st === 'draft';
  },

  // Enter = fold toggle (parent) or collapse parent (child); saves draft if applicable
  _normalEnter: function() {
    if (!cursor.rowEl) return;
    if (cursor.rowEl.dataset.rowType === 'parent') {
      var isDraftParent = cursor.rowEl.dataset.draft === 'true';
      var foldKey = isDraftParent ? cursor.rowEl.dataset.draftKey : cursor.rowEl.dataset.billId;
      var foldIsOpen = foldKey ? treeState.isOpen(foldKey) : false;
      // Save when folding a raw unsaved draft (not when opening it)
      if (isDraftParent && foldIsOpen) {
        saveDraftToDb(cursor.rowEl);
      }
      this._toggleFold();
    } else if (cursor.rowEl.dataset.rowType === 'child') {
      var childParentKey = cursor.rowEl.dataset.parentKey || cursor.rowEl.dataset.parentId;
      var childParentRow = childParentKey
        ? (document.querySelector('tr[data-row-type="parent"][data-draft-key="' + childParentKey + '"]') ||
           document.querySelector('tr[data-row-type="parent"][data-bill-id="' + childParentKey + '"]'))
        : null;
      if (childParentRow) {
        // Save when returning from child to parent on a raw unsaved draft
        if (childParentRow.dataset.draft === 'true') {
          saveDraftToDb(childParentRow);
        }
        this._closeFold(childParentRow);
        cursor.set(childParentRow, 0);
      }
    }
  },

  _normalEdit: function() {
    if (!this._isRowEditable()) {
      billEditMsg('Cannot edit — bill is not a draft', 'err');
      setTimeout(function() { billEditMsg('', ''); }, 2000);
      return;
    }
    // Bill-level INSERT: open the entire draft bill for editing.
    // Works from any row (parent or child) of a raw draft (data-draft='true').
    // Parent and child rows already have inputs rendered, so we just enter
    // INSERT mode and focus the first parent input — same as createDraftBill.
    if (cursor.rowEl && cursor.rowEl.dataset.draft === 'true') {
      var parentRow = cursor.rowEl;
      if (parentRow.dataset.rowType === 'child') {
        var pKey = parentRow.dataset.parentKey || parentRow.dataset.parentId;
        parentRow = pKey ? (document.querySelector('tr[data-row-type="parent"][data-draft-key="' + pKey + '"]') || document.querySelector('tr[data-row-type="parent"][data-bill-id="' + pKey + '"]')) : null;
      }
      if (parentRow) {
        var firstInp = parentRow.querySelector('input, select');
        if (firstInp) { cursor.mode = 'INSERT'; cursor.set(parentRow, 0); firstInp.focus(); }
      }
      return;
    }
    // Saved draft (status='draft' in DB, but data-draft was deleted by
    // convertDraftRowToDisplay).  Re-render the bill into editable mode.
    if (cursor.rowEl && cursor.rowEl.dataset.status === 'draft') {
      var savedParent = cursor.rowEl;
      if (savedParent.dataset.rowType === 'child') {
        var spId = savedParent.dataset.parentKey || savedParent.dataset.parentId;
        savedParent = spId ? (document.querySelector('tr[data-row-type="parent"][data-draft-key="' + spId + '"]') || document.querySelector('tr[data-row-type="parent"][data-bill-id="' + spId + '"]')) : null;
      }
      if (savedParent && savedParent.dataset.status === 'draft') {
        convertDisplayToDraft(savedParent);
      }
      return;
    }
  },

  // a = always add a child row (works from parent or child cursor position)
  _normalAddLine: function() {
    if (cursor.rowEl && !this._isRowEditable()) {
      billEditMsg('Cannot add lines — bill is not a draft', 'err');
      setTimeout(function() { billEditMsg('', ''); }, 2000);
      return;
    }
    if (cursor.rowEl) {
      insertDraftChildRow(cursor.rowEl, false);
    }
  },

  // p = post bill from any row (NORMAL mode only)
  _normalPost: function() {
    var pRow = cursor.rowEl;
    if (!pRow) return;
    if (pRow.dataset.rowType === 'child') {
      var pKey = pRow.dataset.parentKey || pRow.dataset.parentId;
      pRow = pKey
        ? (document.querySelector('tr[data-row-type="parent"][data-draft-key="' + pKey + '"]') ||
           document.querySelector('tr[data-row-type="parent"][data-bill-id="' + pKey + '"]'))
        : null;
    }
    if (pRow && (pRow.dataset.draft === 'true' || pRow.dataset.status === 'draft')) {
      _postDirect(pRow);
    }
  },

  _getParentRow: function() {
    if (!cursor.rowEl) return null;
    if (cursor.rowEl.dataset.rowType === 'parent') return cursor.rowEl;
    if (cursor.rowEl.dataset.rowType === 'child') {
      var pid = cursor.rowEl.dataset.parentId || cursor.rowEl.dataset.parentKey;
      return pid
        ? (document.querySelector('tr[data-row-type="parent"][data-bill-id="' + pid + '"]') ||
           document.querySelector('tr[data-row-type="parent"][data-draft-key="' + pid + '"]'))
        : null;
    }
    return null;
  },

  // Unified fold toggle
  _toggleFold: function() {
    var pr = this._getParentRow(); if (!pr) return;
    var key = pr.dataset.draft === 'true' ? pr.dataset.draftKey : pr.dataset.billId;
    if (treeState.isOpen(key)) this._closeFold(pr); else this._openFold(pr);
  },

  _openFold: function(parentRow) {
    parentRow = parentRow || this._getParentRow(); if (!parentRow) return;
    if (parentRow.dataset.draft === 'true') {
      var draftKey = parentRow.dataset.draftKey;
      if (!draftKey) return;
      if (treeState.isOpen(draftKey)) return;
      treeState.setOpen(draftKey);
      if (!draftLines[draftKey]) draftLines[draftKey] = [];
      if (!draftLines[draftKey].length) draftLines[draftKey].push({ desc: '', amount: 0, vatCode: '' });
      renderDraftChildRows(parentRow, draftLines[draftKey]);
      return;
    }
    var billId = parentRow.dataset.billId;
    if (treeState.isOpen(billId)) return;
    treeState.setOpen(billId);
    toggleBillLines(billId, parentRow);
  },

  _closeFold: function(parentRow) {
    parentRow = parentRow || this._getParentRow(); if (!parentRow) return;
    if (parentRow.dataset.draft === 'true') {
      var draftKey = parentRow.dataset.draftKey;
      if (!draftKey) return;
      if (!treeState.isOpen(draftKey)) return;
      if (cursor.rowEl && cursor.rowEl.dataset.rowType === 'child') cursor.set(parentRow, 0);
      treeState.setClose(draftKey);
      document.querySelectorAll('tr[data-parent-key="' + draftKey + '"]').forEach(function(r) { r.remove(); });
      return;
    }
    var billId = parentRow.dataset.billId;
    if (!treeState.isOpen(billId)) return;
    if (cursor.rowEl && cursor.rowEl.dataset.rowType === 'child') cursor.set(parentRow, 0);
    treeState.setClose(billId);
    toggleBillLines(billId, parentRow);
  },

  // dd: delete current row
  _deleteCurrent: function() {
    if (!cursor.rowEl) return;
    var rowType = cursor.rowEl.dataset.rowType;
    if (rowType === 'child') {
      var parentKey = cursor.rowEl.dataset.parentKey || cursor.rowEl.dataset.parentId;
      if (cursor.rowEl.dataset.draft === 'true' && parentKey && draftLines[parentKey]) {
        var lineIdx = parseInt(cursor.rowEl.dataset.lineIdx);
        if (!isNaN(lineIdx)) draftLines[parentKey].splice(lineIdx, 1);
      }
      cursor.rowEl.remove();
      var vrows = cursor.getVisibleRows();
      if (vrows.length) cursor.set(vrows[Math.min(cursor.currentIndex(), vrows.length - 1)] || vrows[0], 0);
      else cursor.clear();
      if (parentKey) {
        var pr3 = document.querySelector('tr[data-row-type="parent"][data-draft-key="' + parentKey + '"]') ||
                  document.querySelector('tr[data-row-type="parent"][data-bill-id="' + parentKey + '"]');
        if (pr3) recalcParentAmount(pr3);
      }
    } else if (rowType === 'parent') {
      var isDraft2 = cursor.rowEl.dataset.draft === 'true' || cursor.rowEl.dataset.status === 'draft';
      if (isDraft2) {
        var dk = cursor.rowEl.dataset.draftKey;
        // Remove child rows (both keyed by draftKey and billId for saved drafts)
        var billIdDraft = cursor.rowEl.dataset.billId;
        if (dk) { delete draftLines[dk]; treeState.setClose(dk); document.querySelectorAll('tr[data-parent-key="' + dk + '"]').forEach(function(r) { r.remove(); }); }
        if (billIdDraft) { document.querySelectorAll('tr[data-parent-id="' + billIdDraft + '"]').forEach(function(r) { r.remove(); }); }
        var nxtRows = cursor.getVisibleRows();
        var nxtIdx = nxtRows.indexOf(cursor.rowEl);
        cursor.rowEl.remove();
        var afterRows = cursor.getVisibleRows();
        if (afterRows.length) cursor.set(afterRows[Math.max(0, nxtIdx - 1)] || afterRows[0], 0); else cursor.clear();
        _refreshCcyVisibility(); // currency mix may have changed with this draft gone
        // If saved draft (has bill_id), delete from DB
        if (billIdDraft) {
          fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'bill.draft.delete', companyId: COMPANY, billId: billIdDraft }) })
            .then(function(r) { return r.json(); })
            .then(function(res) { var d = res.data || res; if (res.error || d.error) billEditMsg('Delete failed: ' + (res.error || d.error), 'err'); })
            .catch(function(e) { billEditMsg('Error: ' + e.message, 'err'); });
        }
      } else {
        var billId2 = cursor.rowEl.dataset.billId;
        var vendor2 = cursor.rowEl.dataset.vendor || billId2;
        var status2 = cursor.rowEl.dataset.status || '';
        if (!billId2) return;
        if (status2 === 'void') { billEditMsg('Bill is already void — cannot be modified.', 'err'); return; }
        if (status2 === 'paid') { billEditMsg('Bill is fully paid — reversal must be done via a credit note or payment reversal.', 'err'); return; }
        var confirmMsg = status2 === 'partial'
          ? 'Bill from "' + vendor2 + '" is partially paid. Reversing will void the bill but will not reverse the payment. Continue?'
          : 'Reverse bill from "' + vendor2 + '"? A reversal journal entry will be created. This cannot be undone.';
        if (!confirm(confirmMsg)) return;
        fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'bill.void', companyId: COMPANY, billId: billId2 }) })
          .then(function(r) { return r.json(); })
          .then(function(res) {
            var d = res.data || res;
            if (res.error || d.error) { billEditMsg('Cannot void: ' + (res.error || d.error), 'err'); }
            else { loadAllBills(); }
          }).catch(function(e) { billEditMsg('Error: ' + e.message, 'err'); });
      }
    }
  },

};

// ========== STATUS MESSAGE ==========
function billEditMsg(msg, type) {
  var el = document.getElementById('tb-status-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'err' ? '#cc2222' : type === 'ok' ? '#2a8a2a' : type === 'warn' ? '#b8860b' : '#888';
  el.style.fontWeight = msg ? '700' : '';
}

// ========== PAGE INIT ==========
// Fetch company-level default AP/expense account codes from settings and stash
// them in companyDefaultAp / companyDefaultExpense. These replace the old
// hardcoded '201100'/'400000' fallbacks. Blank when the company hasn't
// configured defaults — drafts then render with data-ap-account="" etc. and the
// backend surfaces a clear "required" validation error at post time.
function _loadCompanyDefaults() {
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'settings.get', companyId: COMPANY }) })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      var s = (res && res.data) ? res.data : (res || {});
      companyDefaultAp = (s.default_ap_account || '').trim();
      companyDefaultExpense = (s.default_expense_account || '').trim();
    })
    .catch(function (e) {
      // Non-fatal: leave defaults blank (blank fallback behaviour).
      console.warn('Could not load company default accounts:', e && e.message);
    });
}

function fbPageInitPayables() {
  loadVendors();
  loadAllBills();
  loadPeriods();
  initBillsTable();
  registerBillKeyActions();
  registerVendorKeyActions();
  kbd.register();
  // Sidebar hint panel is generated from the same binding table that drives
  // dispatch (P1-3/P1-6: single source of truth — cannot go stale).
  renderPayHints('bills');
  loadBillAccounts();
  _loadCompanyDefaults();
  window.fbBillNav = true;

  fetch('/api/' + COMPANY + '/vat-codes')
    .then(function(r){ return r.json(); })
    .then(function(codes){
      if (Array.isArray(codes)) {
        codes.forEach(function(c){
          taxCodeMap[c.vat_code] = c.description || c.vat_code;
          taxCodeRateMap[c.vat_code] = { rate: Number(c.rate) || 0, is_reverse_charge: !!c.is_reverse_charge };
        });
      }
    })
    .catch(function(){});
}
window.addEventListener('DOMContentLoaded', fbPageInitPayables);
window.fbPageInit = fbPageInitPayables;

function initBillsTable() {
  var tbody = document.getElementById('bills-tbody');
  if (tbody) {
    tbody.addEventListener('click', function(e) {
      if (e.target.closest('a.ref-link')) return;
      if (e.target.closest('.badge')) return;
      if (e.target.closest('input, select, textarea')) return; // don't toggle fold when clicking inputs
      var parentTr = e.target.closest('tr[data-row-type="parent"]');
      if (parentTr) {
        // If in INSERT mode, click-outside saves and selects clicked row
        if (cursor.mode === 'INSERT') {
          _saveAndExitInsert();
        }
        var billId = parentTr.dataset.billId;
        if (billId) toggleBillLines(billId, parentTr);
      }
    });
    // Double-click to enter INSERT on editable (draft) rows
    tbody.addEventListener('dblclick', function(e) {
      if (e.target.closest('a.ref-link')) return;
      if (e.target.closest('.badge')) return;
      var tr = e.target.closest('tr');
      if (!tr) return;
      // Find parent row if on a child
      var parentRow = tr;
      if (tr.dataset.rowType === 'child') {
        var pKey = tr.dataset.parentKey || tr.dataset.parentId;
        parentRow = pKey ? (document.querySelector('tr[data-row-type="parent"][data-draft-key="' + pKey + '"]') || document.querySelector('tr[data-row-type="parent"][data-bill-id="' + pKey + '"]')) : null;
      }
      if (!parentRow) return;
      // Only editable if draft status
      var statusRow = parentRow;
      if (parentRow.dataset.status !== 'draft' && parentRow.dataset.draft !== 'true') return;
      cursor.set(parentRow, 0);
      // Trigger the 'i' handler logic
      if (parentRow.dataset.draft === 'true') {
        var firstInp = parentRow.querySelector('input, select');
        if (firstInp) { cursor.mode = 'INSERT'; firstInp.focus(); }
      } else if (parentRow.dataset.status === 'draft') {
        convertDisplayToDraft(parentRow);
      }
    });
  }

  document.querySelectorAll('.data-table th[data-col]').forEach(function(th) {
    var col = th.dataset.col;
    var label = th.querySelector('.th-label');
    var sortIcon = th.querySelector('.th-sort');
    var filterBtn = th.querySelector('.th-filter-btn');

    if (label && sortIcon && th.classList.contains('sortable')) {
      th.addEventListener('click', function(e) {
        if (e.target.closest('.th-filter-btn')) return;
        if (sortState.col === col) {
          sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
        } else {
          sortState.col = col;
          sortState.dir = 'asc';
        }
        document.querySelectorAll('.data-table th[data-col] .th-sort').forEach(function(ic) { ic.textContent = ''; ic.classList.remove('on'); });
        sortIcon.textContent = sortState.dir === 'asc' ? '▲' : '▼';
        sortIcon.classList.add('on');
        applyFilters();
      });
    }

    if (filterBtn) {
      filterBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        openColFilter(th, col);
      });
    }
  });
}

function toggleBillLines(billId, parentTr) {
  var existing = document.querySelector('tr[data-row-type="child"][data-parent-id="' + billId + '"]');

  if (existing) {
    var toRemove = document.querySelectorAll('tr[data-row-type="child"][data-parent-id="' + billId + '"]');
    toRemove.forEach(function(r) { r.remove(); });
    parentTr.classList.remove('row-expanded');
    treeState.setClose(billId);
    return;
  }

  parentTr.classList.add('row-loading');
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'bill.lines', companyId: COMPANY, billId: billId }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    var lines = res.data || res || [];
    if (!Array.isArray(lines)) lines = [];
    parentTr.classList.remove('row-loading');
    parentTr.classList.add('row-expanded');
    treeState.setOpen(billId);

    var insertAfter = parentTr;
    if (!lines.length) {
      var emptyTr = document.createElement('tr');
      emptyTr.dataset.rowType = 'child';
      emptyTr.dataset.parentId = billId;
      emptyTr.className = 'child-row';
      emptyTr.innerHTML = '<td colspan="7" class="child-desc" style="color:#aaa;font-style:italic">No line items</td>';
      insertAfter.insertAdjacentElement('afterend', emptyTr);
      return;
    }

    // Draft bills: lines are stored as-is in draft_lines JSON (description + amount + vat_code per line).
    // Render directly without the expense/GST split used for posted bills.
    var isDraft = parentTr.dataset.status === 'draft';
    if (isDraft) {
      lines.forEach(function(line) {
        var tr = document.createElement('tr');
        tr.dataset.rowType = 'child';
        tr.dataset.parentId = billId;
        tr.dataset.entryId = line.entry_id || '';
        tr.className = 'child-row';
        tr.innerHTML = '<td colspan="4" class="child-desc">' + esc(line.description || '') + '</td>'
          + '<td class="amt" style="text-align:right;font-variant-numeric:tabular-nums">' + Number(line.amount || 0).toFixed(2) + '</td>'
          + '<td class="child-spacer"></td>'
          + '<td style="font-size:0.75rem;cursor:pointer;width:50px" title="Edit tax code">' + esc(line.vat_code || '') + '</td>';
        insertAfter.insertAdjacentElement('afterend', tr);
        insertAfter = tr;
      });
      return;
    }

    // Posted bills: journal entries are split into expense lines and GST lines.
    var expenseLines = lines.filter(function(l){ return !l.vat_code; });
    var gstLines     = lines.filter(function(l){ return !!l.vat_code; });

    expenseLines.forEach(function(line, idx) {
      var pairedGst = gstLines[idx] || null;
      var tr = document.createElement('tr');
      tr.dataset.rowType = 'child';
      tr.dataset.parentId = billId;
      tr.dataset.entryId = line.entry_id || '';
      tr.dataset.fullDesc = line.description || '';
      tr.dataset.accountCode = line.account_code || '';
      tr.dataset.vatCode = line.vat_code || '';
      tr.dataset.gstVatCode = pairedGst ? (pairedGst.vat_code || '') : '';
      tr.dataset.gstEntryId = pairedGst ? (pairedGst.entry_id || '') : '';
      tr.className = 'child-row';

      var rawDesc = line.description || '';
      var sepIdx = rawDesc.lastIndexOf(' / ');
      var desc = sepIdx !== -1 ? rawDesc.slice(sepIdx + 3).trim() : rawDesc;

      var gstCode = pairedGst ? (pairedGst.vat_code || '') : '';
      tr.innerHTML = '<td colspan="4" class="child-desc">' + esc(desc) + '</td>'
        + '<td class="amt" style="text-align:right;font-variant-numeric:tabular-nums">' + Number(line.amount || 0).toFixed(2) + '</td>'
        + '<td class="child-spacer"></td>'
        + '<td style="font-size:0.75rem;cursor:pointer;width:50px" title="Edit tax code">' + esc(gstCode) + '</td>';

      insertAfter.insertAdjacentElement('afterend', tr);
      insertAfter = tr;
    });

    gstLines.forEach(function(line) {
      var gstTr = document.createElement('tr');
      gstTr.dataset.rowType = 'child';
      gstTr.dataset.parentId = billId;
      gstTr.dataset.entryId = line.entry_id || '';
      gstTr.className = 'child-row child-gst-row';

      var codeDesc = taxCodeMap[line.vat_code];
      var gstLabel = codeDesc ? esc(line.vat_code) + ': ' + esc(codeDesc) : esc(line.vat_code || 'GST/VAT');

      gstTr.innerHTML = '<td colspan="4" class="child-desc" style="color:#888;font-style:italic">' + gstLabel + '</td>'
        + '<td class="amt" style="text-align:right;font-variant-numeric:tabular-nums;color:#888">' + Number(line.amount || 0).toFixed(2) + '</td>'
        + '<td class="child-spacer"></td>'
        + '<td></td>';

      insertAfter.insertAdjacentElement('afterend', gstTr);
      insertAfter = gstTr;
    });
  })
  .catch(function(e){
    parentTr.classList.remove('row-loading');
    console.error('Error loading lines:', e);
  });
}

// ========== COLUMN FILTER ==========
function openColFilter(th, col) {
  var existing = document.getElementById('col-filter-dd');
  if (existing) { existing.remove(); if (existing.dataset.col === col) return; }

  if (th.classList.contains('col-filtered')) {
    delete colFilters[col];
    th.classList.remove('col-filtered');
    applyFilters();
    return;
  }

  var filterType = th.dataset.filterType || 'list';
  var dd = document.createElement('div');
  dd.id = 'col-filter-dd';
  dd.className = 'col-filter-dd';
  dd.dataset.col = col;

  if (filterType === 'date') {
    var inp = document.createElement('input');
    inp.type = 'date';
    inp.style.cssText = 'display:block;width:160px;padding:7px 9px;border:1px solid #ccc;border-radius:4px;font-size:0.8125rem;box-sizing:border-box;';
    if (colFilters[col]) inp.value = colFilters[col];
    inp.addEventListener('change', function() {
      var v = inp.value;
      if (v) { colFilters[col] = v; th.classList.add('col-filtered'); }
      else { delete colFilters[col]; th.classList.remove('col-filtered'); }
      dd.remove();
      applyFilters();
    });
    dd.appendChild(inp);
    setTimeout(function() { if (inp.showPicker) inp.showPicker(); }, 50);

  } else if (filterType === 'text') {
    var inp2 = document.createElement('input');
    inp2.type = 'text';
    inp2.placeholder = 'Type to filter…';
    inp2.value = colFilters[col] || '';
    inp2.style.width = '100%';
    inp2.style.padding = '9px';
    inp2.style.border = '1px solid #ccc';
    inp2.style.borderRadius = '4px';
    inp2.style.fontSize = '0.8125rem';
    inp2.style.boxSizing = 'border-box';
    inp2.style.marginBottom = '0';
    var debounceTimer = null;
    inp2.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        clearTimeout(debounceTimer);
        var v = inp2.value.trim();
        if (v) { colFilters[col] = v; th.classList.add('col-filtered'); }
        else { delete colFilters[col]; th.classList.remove('col-filtered'); }
        dd.remove();
        applyFilters();
      } else if (e.key === 'Escape') {
        dd.remove();
      }
    });
    dd.appendChild(inp2);

  } else if (filterType === 'amount') {
    var lbl3 = document.createElement('label');
    lbl3.textContent = 'Amount filter';
    var opSel = document.createElement('select');
    opSel.innerHTML = '<option value="=">=  Equal to</option><option value=">">&gt;  Greater than</option><option value="<">&lt;  Less than</option>';
    if (colFilters[col]) opSel.value = colFilters[col].op;
    var inp3 = document.createElement('input');
    inp3.type = 'number';
    inp3.placeholder = '0.00';
    inp3.step = '0.01';
    inp3.min = '0';
    if (colFilters[col]) inp3.value = colFilters[col].val;
    inp3.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        var v = inp3.value.trim();
        if (v !== '') {
          colFilters[col] = { op: opSel.value, val: Number(v) };
          th.classList.add('col-filtered');
        } else {
          delete colFilters[col];
          th.classList.remove('col-filtered');
        }
        dd.remove();
        applyFilters();
      }
    });
    dd.appendChild(lbl3);
    dd.appendChild(opSel);
    dd.appendChild(inp3);
    setTimeout(function() { inp3.focus(); }, 50);

  } else {
    var vals = [];
    if (col === 'currency') {
      allBills.forEach(function(b) {
        var v = b.currency || BASE_CURRENCY;
        v = String(v);
        if (vals.indexOf(v) === -1) vals.push(v);
      });
    } else {
      allBills.forEach(function(b) {
        var v = b[col];
        if (v == null || v === '') return;
        v = String(v);
        if (vals.indexOf(v) === -1) vals.push(v);
      });
    }
    if (col === 'status') {
      var hasOverdue = allBills.some(function(b) {
        var due = b.due_date ? String(b.due_date).slice(0,10) : null;
        return (b.status === 'posted' || b.status === 'partial') && due && due < today;
      });
      if (hasOverdue && vals.indexOf('overdue') === -1) vals.push('overdue');
    }
    vals.sort();
    var clearItem = document.createElement('div');
    clearItem.className = 'col-filter-dd-item col-filter-dd-clear';
    clearItem.textContent = 'All (clear filter)';
    clearItem.addEventListener('click', function() {
      delete colFilters[col]; th.classList.remove('col-filtered'); dd.remove(); applyFilters();
    });
    dd.appendChild(clearItem);
    vals.forEach(function(v) {
      var item = document.createElement('div');
      item.className = 'col-filter-dd-item' + (colFilters[col] === v ? ' active' : '');
      var dispV = col === 'status' ? (v === 'posted' ? 'Open' : v.charAt(0).toUpperCase() + v.slice(1)) : v;
      item.textContent = dispV;
      item.addEventListener('click', function() {
        colFilters[col] = v; th.classList.add('col-filtered'); dd.remove(); applyFilters();
      });
      dd.appendChild(item);
    });
  }

  var rect = th.getBoundingClientRect();
  dd.style.top = (rect.bottom + 4) + 'px';
  dd.style.left = Math.max(4, rect.right - 200) + 'px';
  document.body.appendChild(dd);

  var firstInput = dd.querySelector('input, select');
  if (firstInput) setTimeout(function() { firstInput.focus(); }, 10);

  function onOutsideClick(e) {
    if (!dd.contains(e.target)) { cleanup(); }
  }
  function onEscape(e) {
    if (e.key === 'Escape') { e.stopPropagation(); cleanup(); }
  }
  function cleanup() {
    dd.remove();
    document.removeEventListener('click', onOutsideClick);
    document.removeEventListener('keydown', onEscape, true);
  }
  setTimeout(function() {
    document.addEventListener('click', onOutsideClick);
    document.addEventListener('keydown', onEscape, true);
  }, 0);
}

// ========== DRAFT BILL CREATION ==========

// Wire Tab wrapping on child row inputs so that:
//  - Tab on the last child's GST select creates a new child row if current row has data
//  - Shift+Tab on the first child's desc input wraps to the parent CCY input
//  - Tab/Shift+Tab between intermediate fields uses browser default (natural tab order)
// Also manages the "+" add-row icon: only shown on the last child row.
function _wireChildRowTab(childRowEl, parentRowEl) {
  var parentKey = parentRowEl.dataset.draftKey || parentRowEl.dataset.billId;
  if (!parentKey) return;
  var descInp = childRowEl.querySelector('input.child-desc');
  var amtInp  = childRowEl.querySelectorAll('input')[2];
  var gstSel  = childRowEl.querySelector('input.child-vat');
  function handleChildTab(e) {
    if (e.key !== 'Tab') return;
    var allChildren = Array.from(document.querySelectorAll('tr[data-parent-key="' + parentKey + '"]'));
    if (!allChildren.length) return;
    var isFirst = allChildren[0] === childRowEl;
    var isLast = allChildren[allChildren.length - 1] === childRowEl;
    if (!e.shiftKey) {
      // Forward Tab on last child's last field (VAT input):
      //   - If this row has data (desc or amount), create a new child row and focus it
      //   - If this row is empty, stay (sticky — don't create empty rows)
      if (isLast && e.target === gstSel) {
        e.preventDefault();
        var hasData = (descInp && descInp.value.trim()) || (amtInp && parseFloat(amtInp.value) > 0);
        if (hasData) {
          createDraftLine(childRowEl); // creates new child row below and focuses its desc input
        }
      }
    } else {
      // Shift+Tab: if first child's first field (desc input), go to parent CCY input
      if (isFirst && e.target === descInp) {
        e.preventDefault();
        var parentInputs = parentRowEl.querySelectorAll('input');
        var ccyInp = parentInputs[4];
        if (ccyInp) ccyInp.focus();
      }
    }
  }
  if (descInp) descInp.addEventListener('keydown', handleChildTab);
  if (amtInp)  amtInp.addEventListener('keydown', handleChildTab);
  if (gstSel)  gstSel.addEventListener('keydown', handleChildTab);
}

// Manage the "+" add-row icon on child rows: only the last child row gets it.
// Fades when the last child row is empty (no data entered yet).
// Call after creating/removing/reordering child rows, and on input changes.
function refreshAddRowIcons(parentRowEl) {
  var parentKey = parentRowEl.dataset.draftKey || parentRowEl.dataset.billId;
  if (!parentKey) return;
  var allChildren = Array.from(document.querySelectorAll('tr[data-parent-key="' + parentKey + '"]'));
  allChildren.forEach(function(cr, idx) {
    var lastCell = cr.querySelector('td.child-spacer') || cr.querySelector('td:last-child');
    if (!lastCell) return;
    if (idx === allChildren.length - 1) {
      // Last row: add + icon if not already present
      var existingBtn = lastCell.querySelector('.btn-add-row');
      if (!existingBtn) {
        lastCell.innerHTML = '<button class="btn-add-row" onclick="addRowFromIcon(this)" title="Add line (a)" style="border:none;background:transparent;cursor:pointer;font-size:16px;padding:2px 6px;color:#5b8def">+</button>';
        existingBtn = lastCell.querySelector('.btn-add-row');
      }
      // Fade + icon if this row is empty (no desc and no amount)
      if (existingBtn) {
        var descInp = cr.querySelector('input.child-desc');
        var amtInp = cr.querySelectorAll('input')[2];
        var hasData = (descInp && descInp.value.trim()) || (amtInp && parseFloat(amtInp.value) > 0);
        if (hasData) {
          existingBtn.style.opacity = '1';
          existingBtn.style.color = '#5b8def';
        } else {
          existingBtn.style.opacity = '0.3';
          existingBtn.style.color = '#999';
        }
      }
    } else {
      // Non-last row: remove + icon if present
      var btn = lastCell.querySelector('.btn-add-row');
      if (btn) lastCell.innerHTML = '';
    }
  });
}

// Mouse click handler for + icon on child rows
function addRowFromIcon(btnEl) {
  var row = btnEl.closest ? btnEl.closest('tr') : btnEl.parentElement;
  while (row && row.tagName !== 'TR') row = row.parentElement;
  if (!row) return;
  // Check if this row has data before creating a new one
  var descInp = row.querySelector('input.child-desc');
  var amtInp = row.querySelectorAll('input')[2];
  var hasData = (descInp && descInp.value.trim()) || (amtInp && parseFloat(amtInp.value) > 0);
  if (hasData) {
    createDraftLine(row);
    var parentKey = row.dataset.parentKey || row.dataset.parentId;
    var parentRow = document.querySelector('tr[data-row-type="parent"][data-draft-key="' + parentKey + '"]') ||
                   document.querySelector('tr[data-row-type="parent"][data-bill-id="' + parentKey + '"]');
    if (parentRow) refreshAddRowIcons(parentRow);
  }
}

// Save icon: active (colored, full opacity) when ANY field has data.
// Inactive (grayscale + faded) only when the bill is completely empty.
// No per-field validation — server-side validateBill is the gatekeeper.
function refreshSaveIcon(parentRowEl) {
  if (!parentRowEl || parentRowEl.dataset.draft !== 'true') return;
  var saveBtn = parentRowEl.querySelector('.btn-save-draft');
  if (!saveBtn) return;
  // Check if any parent-row input has content (vendor, date, due, ref — NOT ap/ccy which are pre-filled)
  var parentInputs = parentRowEl.querySelectorAll('input');
  var hasInput = false;
  for (var i = 0; i < parentInputs.length; i++) {
    var inp = parentInputs[i];
    // Skip AP account (index 4) and CCY (index 5) — both pre-filled from defaults
    if (i === 4 || i === 5) continue;
    if (inp.value.trim()) { hasInput = true; break; }
  }
  // Also check child rows for any description or amount
  if (!hasInput) {
    var draftKey = parentRowEl.dataset.draftKey;
    var childRows = document.querySelectorAll('tr[data-parent-key="' + draftKey + '"][data-draft="true"]');
    for (var j = 0; j < childRows.length; j++) {
      var childInputs = childRows[j].querySelectorAll('input');
      // childInputs: [0]=desc, [1]=expense-acct (pre-filled), [2]=amount, [3]=gst
      if (childInputs[0] && childInputs[0].value.trim()) { hasInput = true; break; }
      if (childInputs[2] && childInputs[2].value.trim()) { hasInput = true; break; }
    }
  }
  if (hasInput) {
    saveBtn.style.opacity = '1';
    saveBtn.style.filter = 'none';
  } else {
    saveBtn.style.opacity = '0.3';
    saveBtn.style.filter = 'grayscale(1)';
  }
}

// Render draft child rows from draftLines array
function renderDraftChildRows(parentRow, linesList) {
  var draftKey = parentRow.dataset.draftKey;
  var parentInputs = parentRow.querySelectorAll('input');
  var insertAfter = parentRow;
  linesList.forEach(function(line, idx) {
    var tr = document.createElement('tr');
    tr.dataset.rowType = 'child';
    tr.dataset.draft = 'true';
    tr.dataset.parentKey = draftKey;
    tr.dataset.lineIdx = String(idx);
    tr.className = 'child-row';
    tr.innerHTML = '<td colspan="3"><input class="draft-input child-desc" placeholder="Line item description" /></td>'
      + '<td><input class="draft-input child-expense-acct" placeholder="Expense Acct" title="Expense account code" /></td>'
      + '<td class="amt"><input class="draft-input" type="number" step="0.01" placeholder="0.00" style="text-align:right" /></td>'
      + '<td class="child-spacer"></td>'
      + '<td style="white-space:nowrap"><input class="draft-input child-vat" placeholder="— None —" title="VAT code" style="width:72px" />'
      + '<input class="draft-input child-gst" type="number" step="0.01" placeholder="GST" style="display:none;width:72px;margin-top:2px;text-align:right" title="Supplier-stated VAT amount" /></td>';
    var descInp = tr.querySelector('input.child-desc');
    var expInp  = tr.querySelector('input.child-expense-acct');
    var amtInp  = tr.querySelectorAll('input')[2];
    var gstSel  = tr.querySelector('input.child-vat');
    var gstInp  = tr.querySelector('input.child-gst');
    if (descInp) descInp.value = line.desc || '';
    if (expInp)  expInp.value  = line.expenseAccount || companyDefaultExpense || '';
    if (amtInp)  amtInp.value  = line.amount ? String(line.amount) : '';
    if (gstSel)  gstSel.value  = line.vatCode || '';
    _attachAcctDropdown(expInp);
    // Initialise GST amount input from saved override or computed default
    _initChildGst(tr, line);
    function syncLine() {
      if (draftLines[draftKey] && draftLines[draftKey][idx] !== undefined) {
        draftLines[draftKey][idx].desc            = descInp ? descInp.value.trim() : '';
        draftLines[draftKey][idx].expenseAccount  = expInp ? expInp.value.trim() : '';
        draftLines[draftKey][idx].amount          = parseFloat(amtInp ? amtInp.value : 0) || 0;
        draftLines[draftKey][idx].vatCode         = gstSel ? gstSel.value.trim() : '';
        if (gstInp) draftLines[draftKey][idx].vatAmountOverride = gstInp.value !== '' ? (parseFloat(gstInp.value) || null) : null;
      }
    }
    _attachVatDropdown(gstSel, function() { syncLine(); _recomputeChildGst(tr, draftLines[draftKey] ? draftLines[draftKey][idx] : null); updateParentDraftAmount(parentRow); });
    var _saveTimer = null;
    if (descInp) { descInp.addEventListener('blur', function() { syncLine(); }); descInp.addEventListener('input', function() { syncLine(); updateParentDraftAmount(parentRow); refreshAddRowIcons(parentRow); refreshSaveIcon(parentRow); }); }
    if (expInp)  { expInp.addEventListener('blur',  function() { syncLine(); }); expInp.addEventListener('input',  function() { syncLine(); refreshSaveIcon(parentRow); }); }
    if (amtInp)  { amtInp.addEventListener('blur',  function() { syncLine(); }); amtInp.addEventListener('input',  function() { syncLine(); _recomputeChildGst(tr, draftLines[draftKey] ? draftLines[draftKey][idx] : null); updateParentDraftAmount(parentRow); refreshAddRowIcons(parentRow); refreshSaveIcon(parentRow); }); }
    if (gstInp)  gstInp.addEventListener('input', function() { syncLine(); updateParentDraftAmount(parentRow); });
    _wireChildRowTab(tr, parentRow);
    insertAfter.insertAdjacentElement('afterend', tr);
    insertAfter = tr;
  });
  refreshAddRowIcons(parentRow);
}

// Initialise the GST amount input for a child row from a saved line object.
// If the line has a vatAmountOverride (and the code is not reverse charge),
// restore it; otherwise compute the default from amount × rate.
function _initChildGst(tr, lineObj) {
  var gstSel = tr.querySelector('input.child-vat');
  var gstInp = tr.querySelector('input.child-gst');
  var amtInp = tr.querySelectorAll('input')[2];
  if (!gstSel || !gstInp) return;
  var code = gstSel.value;
  var info = code ? taxCodeRateMap[code] : null;
  if (!code || !info) {
    gstInp.style.display = 'none';
    gstInp.value = '';
    return;
  }
  gstInp.style.display = '';
  var hasOverride = lineObj && lineObj.vatAmountOverride != null && !isNaN(Number(lineObj.vatAmountOverride));
  if (info.is_reverse_charge) {
    var amtRc = parseFloat(amtInp ? amtInp.value : 0) || 0;
    gstInp.value = (Math.round(amtRc * Number(info.rate) * 100) / 100).toFixed(2);
    gstInp.readOnly = true;
    gstInp.title = 'Reverse charge — VAT is self-assessed (override disabled)';
    gstInp.style.backgroundColor = '#f0f0f0';
    if (lineObj) lineObj.vatAmountOverride = null;
  } else if (hasOverride) {
    gstInp.value = Number(lineObj.vatAmountOverride).toFixed(2);
    gstInp.readOnly = false;
    gstInp.title = 'Supplier-stated VAT amount (override computed value)';
    gstInp.style.backgroundColor = '';
  } else {
    _recomputeChildGst(tr, lineObj);
  }
}

// Recompute the GST amount from amount × rate and update the input. Called on
// amount / VAT-code changes. Resets vatAmountOverride to null (recomputed =
// default, not an override).
function _recomputeChildGst(tr, lineObj) {
  var gstSel = tr.querySelector('input.child-vat');
  var gstInp = tr.querySelector('input.child-gst');
  var amtInp = tr.querySelectorAll('input')[2];
  if (!gstSel || !gstInp) return;
  var code = gstSel.value;
  var info = code ? taxCodeRateMap[code] : null;
  if (!code || !info) {
    gstInp.style.display = 'none';
    gstInp.value = '';
    if (lineObj) lineObj.vatAmountOverride = null;
    return;
  }
  var amount = parseFloat(amtInp ? amtInp.value : 0) || 0;
  var computed = Math.round(amount * Number(info.rate) * 100) / 100;
  gstInp.style.display = '';
  gstInp.value = computed.toFixed(2);
  if (info.is_reverse_charge) {
    gstInp.readOnly = true;
    gstInp.title = 'Reverse charge — VAT is self-assessed (override disabled)';
    gstInp.style.backgroundColor = '#f0f0f0';
  } else {
    gstInp.readOnly = false;
    gstInp.title = 'Supplier-stated VAT amount (override computed value)';
    gstInp.style.backgroundColor = '';
  }
  if (lineObj) lineObj.vatAmountOverride = null;
}

// Check if a draft bill has any data entered (any parent field or child row)
function _isDraftEmpty(parentRowEl) {
  if (!parentRowEl || parentRowEl.dataset.draft !== 'true') return false;
  var parentInputs = parentRowEl.querySelectorAll('input');
  for (var i = 0; i < parentInputs.length; i++) {
    // Skip AP account (index 4) and CCY (index 5) — both pre-filled from defaults
    if (i === 4 || i === 5) continue;
    if (parentInputs[i].value.trim()) return false;
  }
  var draftKey = parentRowEl.dataset.draftKey;
  if (draftKey) {
    var childRows = document.querySelectorAll('tr[data-parent-key="' + draftKey + '"][data-draft="true"]');
    for (var j = 0; j < childRows.length; j++) {
      var childInputs = childRows[j].querySelectorAll('input');
      // childInputs: [0]=desc, [1]=expense-acct (pre-filled), [2]=amount, [3]=gst
      if (childInputs[0] && childInputs[0].value.trim()) return false;
      if (childInputs[2] && childInputs[2].value.trim()) return false;
    }
  }
  return true;
}

// Discard a draft bill — remove parent and child rows from DOM, clean up state
function _discardDraftBill(parentRowEl) {
  var draftKey = parentRowEl.dataset.draftKey;
  if (draftKey) {
    delete draftLines[draftKey];
    treeState.setClose(draftKey);
    document.querySelectorAll('tr[data-parent-key="' + draftKey + '"]').forEach(function(r) { r.remove(); });
  }
  var nextRow = null;
  var allRows = document.querySelectorAll('tr[data-row-type="parent"]');
  for (var k = 0; k < allRows.length; k++) {
    if (allRows[k] === parentRowEl) {
      nextRow = allRows[k + 1] || (k > 0 ? allRows[k - 1] : null);
      break;
    }
  }
  parentRowEl.remove();
  if (nextRow) {
    cursor.set(nextRow, 0);
  } else {
    cursor.clear();
    // No rows left — render empty state
    var tbody = document.getElementById('bills-tbody');
    if (tbody && !tbody.querySelector('tr')) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#aaa;padding:32px">No bills found.</td></tr>';
    }
  }
  billEditMsg('', '');
}

// Create a new draft bill below refRow (or at bottom if null), expand immediately
function createDraftBill(refRow) {
  var tbody = document.getElementById('bills-tbody');
  if (!tbody) return;
  var draftKey = 'draft-' + Date.now();
  draftLines[draftKey] = [{ desc: '', amount: 0, vatCode: '', vatAmountOverride: null, expenseAccount: companyDefaultExpense || '' }];
  var tr = document.createElement('tr');
  tr.dataset.rowType = 'parent';
  tr.dataset.draft = 'true';
  tr.dataset.status = 'draft';
  tr.dataset.draftKey = draftKey;
  tr.style.cssText = 'cursor:default';
  var baseCcy = BASE_CURRENCY;
  tr.innerHTML = '<td><div class="vendor-cell"><span class="avatar" style="background:#ccc;width:32px;height:32px;display:flex;align-items:center;justify-content:center">+</span><input class="draft-input draft-vendor-input" placeholder="Vendor" data-vendor-id="" data-vendor-name="" data-ap-account="' + esc(companyDefaultAp) + '" data-expense-account="' + esc(companyDefaultExpense) + '" /></div></td>'
    + '<td><input class="draft-input" type="date" placeholder="Date" /></td>'
    + '<td><input class="draft-input" type="date" placeholder="Due" /></td>'
    + '<td><input class="draft-input" placeholder="Ref" /></td>'
    + '<td style="text-align:right;color:#aaa;font-style:italic" class="draft-total-amount">0.00</td>'
    + '<td><input class="draft-input draft-ccy-input" style="text-align:center;text-transform:uppercase" placeholder="CCY" value="' + baseCcy + '" /></td>'
    + '<td><div class="draft-ap-cell"><input class="draft-input draft-ap-account" placeholder="AP Acct" value="' + esc(companyDefaultAp) + '" title="AP (creditor) account code" /><button class="btn-save-draft" onclick="saveDraftFromIcon(this)" title="Save draft (s)">&#128190;</button></div></td>';
  var insertAfterRow = refRow;
  if (refRow && refRow.dataset.rowType === 'child') {
    var pKey2 = refRow.dataset.parentKey || refRow.dataset.parentId;
    var siblings = pKey2 ? Array.from(document.querySelectorAll('tr[data-parent-key="' + pKey2 + '"]')) : [];
    if (siblings.length) insertAfterRow = siblings[siblings.length - 1];
  } else if (refRow && refRow.dataset.rowType === 'parent') {
    // If the parent's fold is open, find its last child row and insert after it.
    var pKey3 = refRow.dataset.draftKey || refRow.dataset.billId;
    if (pKey3) {
      var children = Array.from(document.querySelectorAll('tr[data-parent-key="' + pKey3 + '"], tr[data-parent-id="' + pKey3 + '"]'));
      if (children.length) insertAfterRow = children[children.length - 1];
    }
  }
  if (insertAfterRow) { insertAfterRow.parentElement.insertBefore(tr, insertAfterRow.nextElementSibling); }
  else { tbody.appendChild(tr); }
  _wireDraftParentEvents(tr);
  treeState.setOpen(draftKey);
  renderDraftChildRows(tr, draftLines[draftKey]);
  refreshSaveIcon(tr); // initial state: grayscale + faded (completely empty bill)
  cursor.set(tr, 0);
  // Auto-enter INSERT on vendor field
  cursor.mode = 'INSERT';
  var vendorInp = tr.querySelector('input.draft-vendor-input');
  if (vendorInp) setTimeout(function() { vendorInp.focus(); vendorInp.select(); }, 0);
  // Scroll parent into view only if not fully visible (preserves top-of-page position)
  setTimeout(function() { tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 10);
}

// Append new empty child line below current child row
function createDraftLine(childRow) {
  var parentKey = childRow.dataset.parentKey || childRow.dataset.parentId;
  if (!parentKey) return;
  var parentRow = document.querySelector('tr[data-row-type="parent"][data-draft-key="' + parentKey + '"]') ||
                  document.querySelector('tr[data-row-type="parent"][data-bill-id="' + parentKey + '"]');
  if (!parentRow) return;
  if (!draftLines[parentKey]) draftLines[parentKey] = [];
  var newIdx = draftLines[parentKey].length;
  draftLines[parentKey].push({ desc: '', amount: 0, vatCode: '', vatAmountOverride: null, expenseAccount: companyDefaultExpense || '' });
  var siblings = Array.from(document.querySelectorAll('tr[data-parent-key="' + parentKey + '"]'));
  var insertAfterEl = siblings.length ? siblings[siblings.length - 1] : parentRow;
  var tr = document.createElement('tr');
  tr.dataset.rowType = 'child';
  tr.dataset.draft = 'true';
  tr.dataset.parentKey = parentKey;
  tr.dataset.lineIdx = String(newIdx);
  tr.className = 'child-row';
  tr.innerHTML = '<td colspan="3"><input class="draft-input child-desc" placeholder="Line item description" /></td>'
    + '<td><input class="draft-input child-expense-acct" placeholder="Expense Acct" title="Expense account code" /></td>'
    + '<td class="amt"><input class="draft-input" type="number" step="0.01" placeholder="0.00" style="text-align:right" /></td>'
    + '<td class="child-spacer"></td>'
    + '<td style="white-space:nowrap"><input class="draft-input child-vat" placeholder="— None —" title="VAT code" style="width:72px" />'
    + '<input class="draft-input child-gst" type="number" step="0.01" placeholder="GST" style="display:none;width:72px;margin-top:2px;text-align:right" title="Supplier-stated VAT amount" /></td>';
  var gstSel2 = tr.querySelector('input.child-vat');
  var descInp2 = tr.querySelector('input.child-desc');
  var expInp2  = tr.querySelector('input.child-expense-acct');
  var amtInp2  = tr.querySelectorAll('input')[2];
  var gstInp2  = tr.querySelector('input.child-gst');
  if (expInp2) expInp2.value = companyDefaultExpense || '';
  _attachAcctDropdown(expInp2);
  _initChildGst(tr, draftLines[parentKey][newIdx]);
  function syncLine2() {
    if (draftLines[parentKey] && draftLines[parentKey][newIdx] !== undefined) {
      draftLines[parentKey][newIdx].desc           = descInp2 ? descInp2.value.trim() : '';
      draftLines[parentKey][newIdx].expenseAccount = expInp2 ? expInp2.value.trim() : '';
      draftLines[parentKey][newIdx].amount         = parseFloat(amtInp2 ? amtInp2.value : 0) || 0;
      draftLines[parentKey][newIdx].vatCode        = gstSel2 ? gstSel2.value.trim() : '';
      if (gstInp2) draftLines[parentKey][newIdx].vatAmountOverride = gstInp2.value !== '' ? (parseFloat(gstInp2.value) || null) : null;
    }
  }
  _attachVatDropdown(gstSel2, function() { syncLine2(); _initChildGst(tr, draftLines[parentKey][newIdx]); updateParentDraftAmount(parentRow); });
  var _t2 = null;
  if (descInp2) { descInp2.addEventListener('blur', function() { syncLine2(); }); descInp2.addEventListener('input', function() { syncLine2(); updateParentDraftAmount(parentRow); refreshAddRowIcons(parentRow); refreshSaveIcon(parentRow); }); }
  if (expInp2)  { expInp2.addEventListener('blur',  function() { syncLine2(); }); expInp2.addEventListener('input',  function() { syncLine2(); refreshSaveIcon(parentRow); }); }
  if (amtInp2)  { amtInp2.addEventListener('blur',  function() { syncLine2(); }); amtInp2.addEventListener('input',  function() { syncLine2(); updateParentDraftAmount(parentRow); refreshAddRowIcons(parentRow); refreshSaveIcon(parentRow); }); }
  if (gstInp2)  gstInp2.addEventListener('input',  function() { syncLine2(); updateParentDraftAmount(parentRow); });
  _wireChildRowTab(tr, parentRow);
  insertAfterEl.insertAdjacentElement('afterend', tr);
  cursor.set(tr, 0);
  refreshAddRowIcons(parentRow);
  // Focus the new row's desc input so the user can immediately start typing
  var newDescInp = tr.querySelector('input.child-desc');
  if (newDescInp) newDescInp.focus();
}

// Save current draft bill and exit INSERT mode (used by click-outside save)
function _saveAndExitInsert() {
  if (cursor.mode !== 'INSERT') return;
  if (cursor.rowEl) {
    var parentRow = cursor.rowEl;
    if (parentRow.dataset.rowType === 'child') {
      var pKey = parentRow.dataset.parentKey || parentRow.dataset.parentId;
      parentRow = pKey ? (document.querySelector('tr[data-row-type="parent"][data-draft-key="' + pKey + '"]') || document.querySelector('tr[data-row-type="parent"][data-bill-id="' + pKey + '"]')) : null;
    }
    if (parentRow && parentRow.dataset.draft === 'true') {
      FB.dropdown.close();
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      if (_isDraftEmpty(parentRow)) {
        _discardDraftBill(parentRow);
        cursor.mode = 'NORMAL';
        return;
      } else {
        saveDraftToDb(parentRow);
      }
    }
  }
  cursor.mode = 'NORMAL';
}

// Lookup FX rate for a draft bill (background, no UI). Returns a Promise.
function _getFxRate(ccy, billDate) {
  if (!ccy || !billDate || ccy.toUpperCase() === BASE_CURRENCY.toUpperCase()) {
    return Promise.resolve(null);
  }
  return fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'fx.rates.get', companyId: COMPANY, fromCurrency: ccy, toCurrency: BASE_CURRENCY, date: billDate }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    var d = res.data || res;
    return (d && d.rate != null) ? d.rate : null;
  })
  .catch(function(){ return null; });
}

// Update the CCY input's tooltip with the FX rate (non-base currency only)
function _updateCcyTooltip(tr, ccyInputEl, dateInputEl) {
  if (!ccyInputEl) return;
  var ccy = ccyInputEl.value.trim().toUpperCase();
  var billDate = dateInputEl ? dateInputEl.value : '';
  if (!ccy || ccy === BASE_CURRENCY.toUpperCase()) {
    ccyInputEl.setAttribute('title', ccy);
    return;
  }
  ccyInputEl.setAttribute('title', ccy + ' — checking rate\u2026');
  _getFxRate(ccy, billDate).then(function(rate) {
    if (rate !== null) {
      ccyInputEl.setAttribute('title', ccy + ' \u2192 ' + BASE_CURRENCY + ': ' + rate);
    } else {
      ccyInputEl.setAttribute('title', ccy + ' — no rate found for ' + (billDate || 'this date') + '. Add in Settings \u2192 Exchange Rates.');
    }
  });
}

// Wire all parent-row input events onto a draft parent TR
function _wireDraftParentEvents(tr) {
  var vendorInput = tr.querySelector('input.draft-vendor-input');
  var draftInputs2 = tr.querySelectorAll('input');
  var dateInputEl  = draftInputs2[1];
  var dueInputEl   = draftInputs2[2];
  var ccyInputEl   = draftInputs2[4]; // DOM order: vendor,date,due,ref,CCY,AP
  // (was draftInputs2[5] before P2-1 — a swap bug that put the currency
  //  dropdown on the AP field and left CCY with no dropdown at all)
  if (vendorInput) {
    // Vendor dropdown (FB.dropdown): pick sets id/name/account datasets and
    // the row CCY from the vendor default (same side-effects as the old dd).
    FB.dropdown.attach(vendorInput, {
      source: function(q) {
        q = (q || '').trim().toLowerCase();
        return allVendors.filter(function(v) {
          if (!q) return true;
          return (v.name || '').toLowerCase().indexOf(q) >= 0;
        }).map(function(v) {
          return { primary: v.name || '', data: { v: v } };
        });
      },
      onPick: function(item, inp) {
        var v = item.data.v;
        inp.dataset.vendorId = v.vendor_id || '';
        inp.dataset.vendorName = v.name || '';
        inp.dataset.apAccount = v.default_ap_account || companyDefaultAp || '';
        inp.dataset.expenseAccount = v.default_expense_account || companyDefaultExpense || '';
        inp.value = v.name || '';
        if (ccyInputEl) ccyInputEl.value = (v.default_currency || BASE_CURRENCY).toUpperCase();
        refreshSaveIcon(tr);
      }
    });
    vendorInput.addEventListener('input', function() { refreshSaveIcon(tr); });
    vendorInput.addEventListener('keydown', function(e) {
      if (e.key === 'Tab' && e.shiftKey) {
        // Shift+Tab from vendor input → wrap to last child's VAT input (bottom of bill)
        var childKey = tr.dataset.draftKey || tr.dataset.billId;
        if (childKey) {
          var childRows = document.querySelectorAll('tr[data-parent-key="' + childKey + '"]');
          if (childRows.length) {
            var lastChild = childRows[childRows.length - 1];
            var lastGst = lastChild.querySelector('input.child-vat');
            if (lastGst) { e.preventDefault(); lastGst.focus(); }
          }
        }
      }
    });
    vendorInput.addEventListener('blur', function() {
      setTimeout(function() {
        var name = vendorInput.value.trim();
        if (!name) return;
        if (vendorInput.dataset.vendorName) {
          var v = allVendors.find(function(x){ return x.vendor_id === vendorInput.dataset.vendorId; });
          if (v && ccyInputEl && !ccyInputEl.value) { ccyInputEl.value = (v.default_currency || BASE_CURRENCY).toUpperCase(); ccyInputEl.dispatchEvent(new Event('input')); }
          return;
        }
        // Try to resolve typed name against master data; if no match, leave the
        // typed value intact (save-time / server-side validation will gate it).
        var match = allVendors.find(function(x){ return (x.name||'').toLowerCase() === name.toLowerCase(); });
        if (match) {
          vendorInput.dataset.vendorId = match.vendor_id || '';
          vendorInput.dataset.vendorName = match.name || '';
          vendorInput.dataset.apAccount = match.default_ap_account || companyDefaultAp || '';
          vendorInput.dataset.expenseAccount = match.default_expense_account || companyDefaultExpense || '';
          vendorInput.value = match.name;
          if (ccyInputEl && !ccyInputEl.value) { ccyInputEl.value = (match.default_currency || BASE_CURRENCY).toUpperCase(); ccyInputEl.dispatchEvent(new Event('input')); }
        }
      }, 200);
    });
  }
  if (dueInputEl) {
    dueInputEl.addEventListener('blur', function() {
      refreshSaveIcon(tr);
    });
    dueInputEl.addEventListener('input', function() { refreshSaveIcon(tr); });
  }
  if (ccyInputEl) {
    // Currency dropdown (FB.dropdown): contains-match on code or name.
    FB.dropdown.attach(ccyInputEl, {
      source: function(q) {
        q = (q || '').trim().toLowerCase();
        return vendorCurrenciesList.filter(function(c) {
          if (!q) return true;
          return (c.code || '').toLowerCase().indexOf(q) >= 0 ||
                 (c.name || '').toLowerCase().indexOf(q) >= 0;
        }).map(function(c) {
          return { primary: (c.code || '').toUpperCase(), secondary: c.name || '', data: { code: (c.code || '').toUpperCase() } };
        });
      },
      onPick: function(item, inp) {
        inp.value = item.data.code;
        inp.classList.remove('req');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    ccyInputEl.addEventListener('input', function() {
      var v = ccyInputEl.value.trim().toUpperCase();
      var dk = tr.dataset.draftKey;
      if (dk) {
        document.querySelectorAll('tr[data-parent-key="' + dk + '"] td[data-child-ccy]').forEach(function(td) {
          td.textContent = v;
        });
      }
    });
    ccyInputEl.addEventListener('keydown', function(e) {
      if (e.key === 'Tab' && !e.shiftKey) {
        // Tab from CCY → first child row description input (cross to child row)
        var firstChild = document.querySelector('tr[data-parent-key="' + tr.dataset.draftKey + '"] input.child-desc');
        if (firstChild) { e.preventDefault(); firstChild.focus(); }
      }
    });
    ccyInputEl.addEventListener('blur', function() {
      var v = ccyInputEl.value.trim().toUpperCase();
      if (v) ccyInputEl.value = v;
    });
  }
  var refInputEl = draftInputs2[3];
  var apInputEl  = draftInputs2[5]; // AP is the 6th input (after CCY) — see ccyInputEl note above
  if (dateInputEl) dateInputEl.addEventListener('blur', function() { refreshSaveIcon(tr); _updateCcyTooltip(tr, ccyInputEl, dateInputEl); });
  if (dateInputEl) dateInputEl.addEventListener('input', function() { refreshSaveIcon(tr); });
  // Tab from ref -> AP account (natural tab order then continues AP -> CCY)
  if (refInputEl && apInputEl) {
    refInputEl.addEventListener('keydown', function(e) {
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); apInputEl.focus(); }
    });
  }
  if (apInputEl) { _attachAcctDropdown(apInputEl); apInputEl.addEventListener('input', function() { refreshSaveIcon(tr); }); }
  // Update CCY tooltip with FX rate info on ccy change
  if (ccyInputEl) {
    ccyInputEl.addEventListener('blur', function() {
      setTimeout(function() { _updateCcyTooltip(tr, ccyInputEl, dateInputEl); }, 200);
    });
  }
  // No focusin handler here — bill-row-focus should persist during INSERT mode
  // to keep the parent row visually distinct from child rows.
}

function insertDraftParentRow(refRow, above) {
  var tbody = document.getElementById('bills-tbody');
  if (!tbody) return;
  var draftKey = 'draft-' + Date.now();
  draftLines[draftKey] = [];
  var tr = document.createElement('tr');
  tr.dataset.rowType = 'parent';
  tr.dataset.draft = 'true';
  tr.dataset.status = 'draft';
  tr.dataset.draftKey = draftKey;
  tr.style.cssText = 'cursor:default';
  var baseCcy = BASE_CURRENCY;
  tr.innerHTML = '<td><div class="vendor-cell"><span class="avatar" style="background:#ccc;width:32px;height:32px;display:flex;align-items:center;justify-content:center">+</span><input class="draft-input draft-vendor-input" placeholder="Vendor" data-vendor-id="" data-vendor-name="" data-ap-account="' + esc(companyDefaultAp) + '" data-expense-account="' + esc(companyDefaultExpense) + '" /></div></td>'
    + '<td><input class="draft-input" type="date" placeholder="Date" /></td>'
    + '<td><input class="draft-input" type="date" placeholder="Due" /></td>'
    + '<td><input class="draft-input" placeholder="Ref" /></td>'
    + '<td style="text-align:right;color:#aaa;font-style:italic" class="draft-total-amount">0.00</td>'
    + '<td><input class="draft-input draft-ccy-input" style="text-align:center;text-transform:uppercase" placeholder="CCY" value="' + baseCcy + '" /></td>'
    + '<td><div class="draft-ap-cell"><input class="draft-input draft-ap-account" placeholder="AP Acct" value="' + esc(companyDefaultAp) + '" title="AP (creditor) account code" /><span class=\"badge\" style=\"background:#e8e4d0;color:#7a6a00;flex-shrink:0\" title=\"Press p to post draft bill\">Draft</span></div></td>';
  if (refRow && above) {
    refRow.parentElement.insertBefore(tr, refRow);
  } else if (refRow) {
    refRow.parentElement.insertBefore(tr, refRow.nextElementSibling);
  } else {
    tbody.appendChild(tr);
  }
  _wireDraftParentEvents(tr);
  cursor.set(tr, 0);
  cursor.mode = 'INSERT';
  var vendorInputFocus = tr.querySelector('input.draft-vendor-input');
  if (vendorInputFocus) vendorInputFocus.focus();
}

function updateParentDraftAmount(draftParentTr) {
  var lookupKey = draftParentTr.dataset.draftKey || draftParentTr.dataset.billId;
  var total = 0;
  if (lookupKey) {
    Array.from(document.querySelectorAll('tr[data-parent-key="' + lookupKey + '"]')).forEach(function(cr) {
      var inputs = cr.querySelectorAll('input');
      var a = cr.querySelector('input.child-desc') ? inputs[2] : null;
      var net = parseFloat(a && a.value) || 0;
      var gstInp = cr.querySelector('input.child-gst');
      var gst = (gstInp && gstInp.value !== '' && !gstInp.readOnly) ? (parseFloat(gstInp.value) || 0) : 0;
      total += net + gst;
    });
  }
  var amtCell = draftParentTr.querySelector('.draft-total-amount');
  if (amtCell) { amtCell.textContent = total.toFixed(2); }
  draftParentTr.dataset.amount = String(total);
}

// Alias used by _deleteCurrent
var recalcParentAmount = updateParentDraftAmount;

function insertDraftChildRow(childRow, above) {
  var tbody = document.getElementById('bills-tbody');
  if (!tbody) return;
  var parentTr = null;
  if (childRow.dataset.rowType === 'parent') {
    parentTr = childRow;
  } else if (childRow.dataset.parentId) {
    parentTr = document.querySelector('tr[data-row-type="parent"][data-bill-id="' + childRow.dataset.parentId + '"]');
  } else if (childRow.dataset.parentKey) {
    parentTr = document.querySelector('tr[data-row-type="parent"][data-draft-key="' + childRow.dataset.parentKey + '"]');
  }
  if (!parentTr) return;
  var draftKey = parentTr.dataset.draftKey || parentTr.dataset.billId;
  var parentInputs = parentTr.querySelectorAll('input');
  var tr = document.createElement('tr');
  tr.dataset.rowType = 'child';
  tr.dataset.draft = 'true';
  tr.dataset.parentKey = draftKey;
  tr.className = 'child-row';
  tr.innerHTML = '<td colspan="3"><input class="draft-input child-desc" placeholder="Line item description" /></td>'
    + '<td><input class="draft-input child-expense-acct" placeholder="Expense Acct" title="Expense account code" /></td>'
    + '<td class="amt"><input class="draft-input" type="number" step="0.01" placeholder="0.00" style="text-align:right" /></td>'
    + '<td class="child-spacer"></td>'
    + '<td style="white-space:nowrap"><input class="draft-input child-vat" placeholder="— None —" title="VAT code" style="width:72px" />'
    + '<input class="draft-input child-gst" type="number" step="0.01" placeholder="GST" style="display:none;width:72px;margin-top:2px;text-align:right" title="Supplier-stated VAT amount" /></td>';
  if (above) {
    childRow.parentElement.insertBefore(tr, childRow);
  } else {
    childRow.parentElement.insertBefore(tr, childRow.nextElementSibling);
  }
  var parentTrRef = parentTr;
  var descInpRef = tr.querySelector('input.child-desc');
  var expInpRef  = tr.querySelector('input.child-expense-acct');
  var amtInpRef  = tr.querySelectorAll('input')[2];
  var gstSelRef  = tr.querySelector('input.child-vat');
  var gstInpRef  = tr.querySelector('input.child-gst');
  if (expInpRef) expInpRef.value = companyDefaultExpense || '';
  _attachAcctDropdown(expInpRef);
  _attachVatDropdown(gstSelRef, function() { _initChildGst(tr, null); updateParentDraftAmount(parentTrRef); });
  if (descInpRef) { descInpRef.addEventListener('input', function() { updateParentDraftAmount(parentTrRef); refreshAddRowIcons(parentTrRef); refreshSaveIcon(parentTrRef); }); }
  if (expInpRef)  { expInpRef.addEventListener('input',  function() { refreshSaveIcon(parentTrRef); }); }
  if (amtInpRef)  { amtInpRef.addEventListener('input',  function() { updateParentDraftAmount(parentTrRef); refreshAddRowIcons(parentTrRef); refreshSaveIcon(parentTrRef); }); }
  if (gstInpRef)  { gstInpRef.addEventListener('input',  function() { updateParentDraftAmount(parentTrRef); }); }
  _wireChildRowTab(tr, parentTrRef);
  cursor.set(tr, 0);
  cursor.mode = 'INSERT';
  var descInput = tr.querySelector('input.child-desc');
  descInput.focus();
  refreshAddRowIcons(parentTrRef);
}

// ========== CONVERT DRAFT ROW TO DISPLAY ==========
// Re-render a saved draft (display text) back into editable input mode.
// Called when user presses 'i' on a saved draft bill.
function convertDisplayToDraft(parentRow) {
  var billId = parentRow.dataset.billId;
  if (!billId) return;
  var vendor = parentRow.dataset.vendor || '';
  var billDate = parentRow.dataset.date || '';
  var dueDate = parentRow.dataset.dueDate || '';
  var vendorRef = parentRow.dataset.vendorRef || '';
  var currency = (parentRow.dataset.currency || BASE_CURRENCY).toUpperCase();
  var apAccount = parentRow.dataset.apAccount || companyDefaultAp || '';
  var expenseAccount = parentRow.dataset.expenseAccount || companyDefaultExpense || '';
  var draftKey = parentRow.dataset.draftKey || billId;

  // Look up vendor ID from master data by name
  var vendorObj = allVendors.find(function(v) { return v.name === vendor; });
  var vendorId = vendorObj ? vendorObj.vendor_id : '';

  // Remove existing display child rows (from toggleBillLines expansion)
  document.querySelectorAll('tr[data-parent-id="' + billId + '"]').forEach(function(r) { r.remove(); });
  // Also remove any leftover draft children (shouldn't exist, but clean up)
  document.querySelectorAll('tr[data-parent-key="' + draftKey + '"]').forEach(function(r) { r.remove(); });

  // Re-render parent row with inputs, pre-filled with saved values
  parentRow.dataset.draft = 'true';
  parentRow.dataset.draftKey = draftKey;
  parentRow.style.cursor = 'default';
  parentRow.innerHTML = '<td><div class="vendor-cell"><span class="avatar" style="background:#ccc;width:32px;height:32px;display:flex;align-items:center;justify-content:center">+</span><input class="draft-input draft-vendor-input" placeholder="Vendor" data-vendor-id="' + esc(vendorId) + '" data-vendor-name="' + esc(vendor) + '" data-ap-account="' + esc(apAccount) + '" data-expense-account="' + esc(expenseAccount) + '" /></div></td>'
    + '<td><input class="draft-input" type="date" placeholder="Date" value="' + billDate + '" /></td>'
    + '<td><input class="draft-input" type="date" placeholder="Due" value="' + dueDate + '" /></td>'
    + '<td><input class="draft-input" placeholder="Ref" value="' + esc(vendorRef) + '" /></td>'
    + '<td style="text-align:right;color:#aaa;font-style:italic" class="draft-total-amount">0.00</td>'
    + '<td><input class="draft-input draft-ccy-input" style="text-align:center;text-transform:uppercase" placeholder="CCY" value="' + currency + '" /></td>'
    + '<td><div class="draft-ap-cell"><input class="draft-input draft-ap-account" placeholder="AP Acct" value="' + esc(apAccount) + '" title="AP (creditor) account code" /><button class="btn-save-draft" onclick="saveDraftFromIcon(this)" title="Save draft">&#128190;</button></div></td>';

  // Set vendor input value (escaped in innerHTML for attributes, raw for .value)
  var vInp = parentRow.querySelector('input.draft-vendor-input');
  if (vInp) vInp.value = vendor;

  // Wire parent input events
  _wireDraftParentEvents(parentRow);

  // Open fold and fetch draft lines
  treeState.setOpen(draftKey);
  parentRow.classList.add('row-expanded');
  draftLines[draftKey] = [{ desc: '', amount: 0, vatCode: '', vatAmountOverride: null, expenseAccount: expenseAccount || companyDefaultExpense || '' }];

  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'bill.lines', companyId: COMPANY, billId: billId }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    var lines = res.data || res || [];
    if (!Array.isArray(lines)) lines = [];
    var draftLineData = lines.map(function(l) {
      return { desc: l.description || '', amount: parseFloat(l.amount) || 0, vatCode: l.vat_code || '',
        vatAmountOverride: (l.vat_amount_override != null && !isNaN(Number(l.vat_amount_override))) ? Number(l.vat_amount_override) : null,
        expenseAccount: l.account_code || l.expense_account || expenseAccount || companyDefaultExpense || '' };
    });
    if (!draftLineData.length) draftLineData = [{ desc: '', amount: 0, vatCode: '', vatAmountOverride: null, expenseAccount: expenseAccount || companyDefaultExpense || '' }];
    draftLines[draftKey] = draftLineData;
    renderDraftChildRows(parentRow, draftLineData);
    updateParentDraftAmount(parentRow);
    refreshSaveIcon(parentRow);
    // Enter INSERT mode, focus first input
    cursor.mode = 'INSERT';
    cursor.set(parentRow, 0);
    var firstInp = parentRow.querySelector('input, select');
    if (firstInp) firstInp.focus();
  })
  .catch(function(e) { billEditMsg(e.message || 'Failed to load draft lines', 'err'); });
}

function convertDraftRowToDisplay(draftParentTr, billId) {
  var inputs = draftParentTr.querySelectorAll('input');
  var vendorInput = draftParentTr.querySelector('input.draft-vendor-input');
  var dateInput = inputs[1], dueInput = inputs[2], refInput = inputs[3], ccyInput = inputs[4], apInput = inputs[5];
  var vendor = vendorInput ? (vendorInput.dataset.vendorName || vendorInput.value) : '';
  var billDate = dateInput ? dateInput.value : '';
  var dueDate = dueInput ? dueInput.value : '';
  var vendorRef = refInput ? refInput.value.trim() : '';
  var currency = ccyInput ? (ccyInput.value.trim().toUpperCase() || BASE_CURRENCY) : BASE_CURRENCY;
  var draftKeyC = draftParentTr.dataset.draftKey;
  // Compute gross amount (net + supplier-stated VAT) to match updateParentDraftAmount
  // and _gatherInlineBillData. Previously this summed only the net input, which made
  // the display cell AND dataset.amount net-only — so saveDraftBill stored net-only
  // on the next display-mode save and listBills then rendered net-only on reload.
  // Convention (mirrors updateParentDraftAmount line 1717-1719): the child-gst input
  // holds a supplier-stated override when !readOnly; reverse-charge (readOnly) and
  // empty rows contribute 0. Default computed VAT also has readOnly=false, so it is
  // included.
  var amount = 0;
  if (draftKeyC) Array.from(document.querySelectorAll('tr[data-parent-key="' + draftKeyC + '"]')).forEach(function(cr) {
    var a = cr.querySelectorAll('input')[2];
    var net = parseFloat(a && a.value) || 0;
    var gIn = cr.querySelector('input.child-gst');
    var gst = (gIn && gIn.value !== '' && !gIn.readOnly) ? (parseFloat(gIn.value) || 0) : 0;
    amount += net + gst;
  });
  var draftKey = draftParentTr.dataset.draftKey;

  draftParentTr.dataset.billId = billId;
  if (draftKey) treeState.setClose(draftKey);
  treeState.setClose(billId); // collapsed after save
  draftParentTr.dataset.vendor = vendor;
  draftParentTr.dataset.date = billDate;
  draftParentTr.dataset.dueDate = dueDate;
  draftParentTr.dataset.vendorRef = vendorRef;
  draftParentTr.dataset.amount = String(amount);
  draftParentTr.dataset.currency = currency;
  draftParentTr.dataset.status = 'draft';
  var savedVendorInput = draftParentTr.querySelector('input.draft-vendor-input');
  var savedApInput = draftParentTr.querySelector('input.draft-ap-account');
  draftParentTr.dataset.apAccount = (savedApInput && savedApInput.value.trim()) || (savedVendorInput && savedVendorInput.dataset.apAccount) || companyDefaultAp || '';
  if (savedVendorInput) {
    draftParentTr.dataset.expenseAccount = savedVendorInput.dataset.expenseAccount || companyDefaultExpense || '';
  }
  delete draftParentTr.dataset.draft;
  draftParentTr.style.cursor = 'pointer';

  var isOverdue = dueDate && dueDate < today;
  var dueCls = isOverdue ? ' class="overdue-date"' : '';
  var rowUrl = '/' + COMPANY + '/bill/' + billId;
  draftParentTr.innerHTML = '<td>' + vendorCell(vendor) + '</td>'
    + '<td style="white-space:nowrap" title="' + esc(String(billDate||'').slice(0,10)) + '">' + fmtDateShort(billDate) + '</td>'
    + '<td style="white-space:nowrap" title="' + esc(String(dueDate||'').slice(0,10)) + '"><span' + dueCls + '>' + fmtDateShort(dueDate) + '</span></td>'
    + '<td><a href="' + rowUrl + '" class="ref-link" onclick="event.stopPropagation()">' + esc(vendorRef) + '</a></td>'
    + '<td class="amt" style="text-align:right;font-variant-numeric:tabular-nums">' + Number(amount).toFixed(2) + '</td>'
    + '<td class="ccy-cell" style="font-size:0.75rem;color:#666;width:50px" id="ccy-' + esc(billId) + '">' + esc(currency) + '</td>'
    + '<td><span class="badge" style="background:#e8e4d0;color:#7a6a00" title="Press p to post draft bill">Draft</span></td>';

  // Populate CCY tooltip with FX rate for non-base currency
  if (currency && currency.toUpperCase() !== BASE_CURRENCY.toUpperCase()) {
    var ccyCellEl = document.getElementById('ccy-' + esc(billId));
    if (ccyCellEl) {
      ccyCellEl.setAttribute('title', currency + ' — checking rate\u2026');
      _getFxRate(currency, billDate).then(function(rate) {
        if (rate !== null) {
          ccyCellEl.setAttribute('title', currency + ' \u2192 ' + BASE_CURRENCY + ': ' + rate);
        } else {
          ccyCellEl.setAttribute('title', currency + ' — no rate found for ' + billDate + '. Add in Settings \u2192 Exchange Rates.');
        }
      });
    }
  }

  if (draftKey) {
    // Remove draft child rows from DOM — fold is collapsed after save.
    // When user expands, toggleBillLines will fetch from server (draft_lines).
    var childRows = Array.from(document.querySelectorAll('tr[data-parent-key="' + draftKey + '"][data-draft="true"]'));
    childRows.forEach(function(childTr) { childTr.remove(); });
  }

  cursor.mode = 'NORMAL';
  var lastCol = draftParentTr.querySelectorAll('td').length - 1;
  cursor.set(draftParentTr, lastCol);
  draftParentTr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  _refreshCcyVisibility(); // currency may have changed during the edit
}

// ========== SAVE DRAFT FROM ICON ==========
function saveDraftFromIcon(btnEl) {
  var row = btnEl.closest ? btnEl.closest('tr') : btnEl.parentElement;
  while (row && row.tagName !== 'TR') row = row.parentElement;
  if (!row) return;
  var parentRow = null;
  if (row.dataset.rowType === 'parent') {
    parentRow = row;
  } else {
    var pk = row.dataset.parentKey || row.dataset.parentId;
    if (pk) {
      parentRow = document.querySelector('tr[data-row-type="parent"][data-draft-key="' + pk + '"]') ||
                  document.querySelector('tr[data-row-type="parent"][data-bill-id="' + pk + '"]');
    }
  }
  if (parentRow && parentRow.dataset.draft === 'true') saveDraftToDb(parentRow);
}

// ========== SAVE DRAFT TO DB ==========
function saveDraftToDb(draftParentTr) {
  var vendorInput = draftParentTr.querySelector('input.draft-vendor-input');
  var inputs = draftParentTr.querySelectorAll('input');
  var dateInput = inputs[1], dueInput = inputs[2], refInput = inputs[3], ccyInput = inputs[4];

  if (!vendorInput && draftParentTr.dataset.billId) {
    var dispBillId = draftParentTr.dataset.billId;
    var dispKey = draftParentTr.dataset.draftKey || dispBillId;
    var dispLines = Array.from(document.querySelectorAll('tr[data-parent-key="' + dispKey + '"]')).filter(function(cr){ return !!cr.querySelector('input.child-desc'); }).filter(function(cr) {
      var dIn = cr.querySelector('input.child-desc'); var aIn = cr.querySelectorAll('input')[2];
      return (dIn && dIn.value.trim()) || (aIn && parseFloat(aIn.value) > 0);
    }).map(function(cr) {
      var dIn = cr.querySelector('input.child-desc'); var aIn = cr.querySelectorAll('input')[2]; var gSel = cr.querySelector('input.child-vat');
      var gIn = cr.querySelector('input.child-gst');
      var eIn = cr.querySelector('input.child-expense-acct');
      var expAcct = eIn ? eIn.value.trim() : (draftParentTr.dataset.expenseAccount || companyDefaultExpense || '');
      var vatOverride = (gIn && gIn.value !== '' && !gIn.readOnly) ? (parseFloat(gIn.value) || null) : null;
      return { description: dIn?dIn.value.trim():'', expense_account: expAcct,
        amount: parseFloat(aIn&&aIn.value)||0, vat_code: gSel?(gSel.value.trim()||null):null, currency: draftParentTr.dataset.currency||BASE_CURRENCY,
        vat_amount_override: vatOverride };
    });
    var apInputA = draftParentTr.querySelector('input.draft-ap-account');
    var apAcctA = apInputA ? apInputA.value.trim() : (draftParentTr.dataset.apAccount || companyDefaultAp || '');
    if (!_validateDraftVatCodes(draftParentTr)) return;
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
      action:'bill.draft.save', companyId:COMPANY, bill:{ bill_id:dispBillId,
        vendor:draftParentTr.dataset.vendor, vendor_ref:draftParentTr.dataset.vendorRef,
        date:draftParentTr.dataset.date, due_date:draftParentTr.dataset.dueDate,
        amount:parseFloat(draftParentTr.dataset.amount)||0, currency:draftParentTr.dataset.currency||BASE_CURRENCY,
        ap_account:apAcctA, expense_account:draftParentTr.dataset.expenseAccount||companyDefaultExpense||'',
        lines:dispLines }}) })
    .then(function(r){ return r.json(); }).then(function(res){
      if (res && res.error) { billEditMsg(res.error, 'err'); return; }
      updateParentDraftAmount(draftParentTr);
      billEditMsg('Line saved.', 'ok');
      setTimeout(function(){ billEditMsg('', ''); }, 2000);
    }).catch(function(e){ billEditMsg(e.message || 'Save failed', 'err'); });
    return;
  }

  var vendorName = vendorInput && vendorInput.dataset.vendorName;
  if (!vendorName) { billEditMsg('Select vendor from dropdown before saving', 'err'); return; }
  var billDate = dateInput && dateInput.value;
  if (!billDate) { billEditMsg('Bill date required', 'err'); return; }
  var dueDate = dueInput && dueInput.value;
  if (!dueDate) { billEditMsg('Due date required', 'err'); return; }
  if (dueDate < billDate) { billEditMsg('Due date must be ≥ bill date', 'err'); return; }
  if (!_validateDraftVatCodes(draftParentTr)) return;
  var draftKeyAmt = draftParentTr.dataset.draftKey;
  var totalAmt = 0;
  if (draftKeyAmt) {
    var _amtRows = Array.from(document.querySelectorAll('tr[data-parent-key="' + draftKeyAmt + '"]'));
    if (_amtRows.length > 0) {
      _amtRows.forEach(function(cr) {
        var a = cr.querySelectorAll('input')[2]; var net = parseFloat(a && a.value) || 0;
        var gIn = cr.querySelector('input.child-gst');
        var gst = (gIn && gIn.value !== '' && !gIn.readOnly) ? (parseFloat(gIn.value) || 0) : 0;
        totalAmt += net + gst;
      });
    } else if (draftLines[draftKeyAmt]) {
      draftLines[draftKeyAmt].forEach(function(l){ totalAmt += (parseFloat(l.amount) || 0) + (l.vatAmountOverride != null && !isNaN(Number(l.vatAmountOverride)) ? Number(l.vatAmountOverride) : 0); });
    }
  }

  var existingBillId = draftParentTr.dataset.billId || null;
  var apInputMain = draftParentTr.querySelector('input.draft-ap-account');
  var apAcctMain = apInputMain ? apInputMain.value.trim() : (vendorInput ? (vendorInput.dataset.apAccount || companyDefaultAp || '') : (companyDefaultAp || ''));
  var payload = {
    action: 'bill.draft.save',
    companyId: COMPANY,
    bill: {
      bill_id: existingBillId,
      vendor: vendorName,
      vendor_ref: refInput ? refInput.value.trim() : '',
      date: billDate,
      due_date: dueInput ? dueInput.value : null,
      amount: totalAmt,
      currency: ccyInput ? (ccyInput.value.trim().toUpperCase() || BASE_CURRENCY) : BASE_CURRENCY,
      ap_account: apAcctMain,
      expense_account: vendorInput ? (vendorInput.dataset.expenseAccount || companyDefaultExpense || '') : (companyDefaultExpense || ''),
      lines: (function() {
        var dk = draftKeyAmt;
        if (!dk) return null;
        var expAcct2 = vendorInput ? (vendorInput.dataset.expenseAccount || companyDefaultExpense || '') : (companyDefaultExpense || '');
        var ccy2 = ccyInput ? (ccyInput.value.trim().toUpperCase() || BASE_CURRENCY) : BASE_CURRENCY;
        // Primary: DOM child rows — reads current input values directly, reliable regardless of syncLine state.
        // Filter out empty rows (no description AND no amount) — they are discarded at save time.
        var childRows2 = Array.from(document.querySelectorAll('tr[data-parent-key="' + dk + '"]')).filter(function(cr){ return !!cr.querySelector('input.child-desc'); });
        if (childRows2.length) {
          return childRows2.filter(function(cr) {
            var dIn = cr.querySelector('input.child-desc');
            var aIn = cr.querySelectorAll('input')[2];
            return (dIn && dIn.value.trim()) || (aIn && parseFloat(aIn.value) > 0);
          }).map(function(cr) {
            var dIn = cr.querySelector('input.child-desc');
            var aIn = cr.querySelectorAll('input')[2];
            var gSel = cr.querySelector('input.child-vat');
            var gIn = cr.querySelector('input.child-gst');
            var eIn = cr.querySelector('input.child-expense-acct');
            var lineExp = eIn ? eIn.value.trim() : (expAcct2 || '');
            var vatOverride = (gIn && gIn.value !== '' && !gIn.readOnly) ? (parseFloat(gIn.value) || null) : null;
            return { description: dIn ? dIn.value.trim() : '', expense_account: lineExp, currency: ccy2,
              amount: parseFloat(aIn && aIn.value) || 0, vat_code: gSel ? (gSel.value.trim() || null) : null,
              vat_amount_override: vatOverride };
          });
        }
        // Fallback: draftLines — used when fold was closed (DOM rows removed) before auto-save timer fired.
        if (draftLines[dk] && draftLines[dk].some(function(l){ return l.desc || l.amount > 0; })) {
          return draftLines[dk].filter(function(l){ return l.desc || l.amount > 0; }).map(function(l){
            return { description: l.desc || '', expense_account: l.expenseAccount || expAcct2 || '', currency: ccy2,
              amount: l.amount || 0, vat_code: l.vatCode || null,
              vat_amount_override: (l.vatAmountOverride != null && !isNaN(Number(l.vatAmountOverride))) ? Number(l.vatAmountOverride) : null };
          });
        }
        return null;
      })()
    }
  };

  billEditMsg('Saving draft…', '');
  fetch('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (res.error) { billEditMsg(res.error, 'err'); return; }
      var data = res.data || res;
      if (draftParentTr.dataset.draft === 'true') {
        convertDraftRowToDisplay(draftParentTr, data.billId);
      }
      billEditMsg('Bill saved as DRAFT.', 'ok');
      setTimeout(function() { billEditMsg('', ''); }, 3000);
    })
    .catch(function(e) { billEditMsg(e.message, 'err'); });
}

// ========== INLINE JOURNAL PREVIEW (replaces popup) ==========

// Resolve the bill data + lines from the DOM for inline drafts.
function _gatherInlineBillData(draftParentTr) {
  var vendorInput = draftParentTr.querySelector('input.draft-vendor-input');
  var inputs = draftParentTr.querySelectorAll('input');
  var dateInput = inputs[1], dueInput = inputs[2], refInput = inputs[3], ccyInput = inputs[4], apInput = inputs[5];
  var vendorName = vendorInput && vendorInput.dataset.vendorName;
  if (!vendorName && vendorInput) vendorName = vendorInput.value.trim();
  var apAccount = apInput ? apInput.value.trim() : (vendorInput && (vendorInput.dataset.apAccount || companyDefaultAp || ''));
  var expAcct   = vendorInput && (vendorInput.dataset.expenseAccount || companyDefaultExpense || '');
  var billDate  = dateInput && dateInput.value;
  var dueDate   = dueInput && dueInput.value;
  var refCode   = refInput ? refInput.value.trim() : '';
  var ccy       = ccyInput && (ccyInput.value.trim().toUpperCase() || BASE_CURRENCY);
  var draftKey  = draftParentTr.dataset.draftKey;
  var totalAmt = 0;
  var lines = [];
  if (draftKey) {
    var childRows = Array.from(document.querySelectorAll('tr[data-parent-key="' + draftKey + '"]'));
    childRows.forEach(function(cr) {
      var descInput = cr.querySelector('input.child-desc');
      var amtInputC = cr.querySelectorAll('input')[2];
      var gstSelect = cr.querySelector('input.child-vat');
      var expIn     = cr.querySelector('input.child-expense-acct');
      var lineExp   = expIn ? expIn.value.trim() : (expAcct || '');
      var desc = descInput ? descInput.value.trim() : '';
      var amt = parseFloat(amtInputC && amtInputC.value) || 0;
      var vatCode = gstSelect ? gstSelect.value.trim() : '';
      var gIn = cr.querySelector('input.child-gst');
      var vatOverride = (gIn && gIn.value !== '' && !gIn.readOnly) ? (parseFloat(gIn.value) || null) : null;
      var gst = vatOverride != null ? vatOverride : 0;
      totalAmt += amt + gst;
      lines.push({ description: desc, expense_account: lineExp, amount: amt, vat_code: vatCode || null, vat_amount_override: vatOverride });
    });
  }
  return {
    vendor: vendorName, vendor_ref: refCode, date: billDate, due_date: dueDate,
    amount: totalAmt, currency: ccy, ap_account: apAccount, expense_account: expAcct,
    lines: lines,
  };
}

// ========== DIRECT POST (no preview step) ==========
// Pressing p on a draft posts directly. Two cases:
//   1. Inline draft (never saved, has vendor input): gather data + send bill.create (creates AND posts).
//   2. Saved draft re-edited inline (has billId, no vendor input): save draft first, then bill.draft.post.
function _postDirect(draftParentTr) {
  if (!draftParentTr) return;
  var hasVendorInput = !!draftParentTr.querySelector('input.draft-vendor-input');
  var savedBillId = draftParentTr.dataset.billId;

  if (hasVendorInput) {
    // Inline draft: gather + bill.create
    var bill = _gatherInlineBillData(draftParentTr);
    if (!bill.vendor) { billEditMsg('Vendor required — select from dropdown', 'err'); return; }
    if (!bill.date) { billEditMsg('Bill date is required', 'err'); return; }
    if (!bill.due_date) { billEditMsg('Due date is required', 'err'); return; }
    if (bill.due_date < bill.date) { billEditMsg('Due date must be ≥ bill date', 'err'); return; }
    if (!bill.vendor_ref) { billEditMsg('Invoice reference (Ref) is required before posting', 'err'); return; }
    if (!bill.amount || bill.amount <= 0) { billEditMsg('Total amount must be > 0', 'err'); return; }
    if (!bill.lines || !bill.lines.length) { billEditMsg('At least one line item is required', 'err'); return; }
    if (!_validateDraftVatCodes(draftParentTr)) return;
    var apIn = draftParentTr.querySelector('input.draft-ap-account');
    if (apIn) bill.ap_account = apIn.value.trim() || bill.ap_account;
    // Per-line expense accounts and vat_amount_override are already part of bill.lines via _gatherInlineBillData.
    _sendPost({ action: 'bill.create', companyId: COMPANY, bill: bill }, draftParentTr);
    return;
  }

  // Saved draft re-edited inline: persist changes via saveDraftToDb, then post.
  if (!savedBillId) { billEditMsg('No draft to post', 'err'); return; }
  billEditMsg('Saving draft before post…', '');
  // Reuse the display-draft save path by temporarily setting draft=true is not needed;
  // saveDraftToDb detects saved-draft inline edit via dataset.billId && !vendorInput.
  // We post after the save resolves by chaining.
  var apInputP = draftParentTr.querySelector('input.draft-ap-account');
  var apAcctP = apInputP ? apInputP.value.trim() : (draftParentTr.dataset.apAccount || companyDefaultAp || '');
  // Build the save payload inline (mirrors saveDraftToDb display-draft branch) so we can
  // chain the post after a successful save without re-reading DOM state.
  var dispKey = draftParentTr.dataset.draftKey || savedBillId;
  var dispLines = Array.from(document.querySelectorAll('tr[data-parent-key="' + dispKey + '"]'))
    .filter(function(cr){ return !!cr.querySelector('input.child-desc'); })
    .filter(function(cr) {
      var dIn = cr.querySelector('input.child-desc'); var aIn = cr.querySelectorAll('input')[2];
      return (dIn && dIn.value.trim()) || (aIn && parseFloat(aIn.value) > 0);
    }).map(function(cr) {
      var dIn = cr.querySelector('input.child-desc'); var aIn = cr.querySelectorAll('input')[2];
      var gSel = cr.querySelector('input.child-vat'); var gIn = cr.querySelector('input.child-gst');
      var eIn = cr.querySelector('input.child-expense-acct');
      var expAcct = eIn ? eIn.value.trim() : (draftParentTr.dataset.expenseAccount || companyDefaultExpense || '');
      var vatOverride = (gIn && gIn.value !== '' && !gIn.readOnly) ? (parseFloat(gIn.value) || null) : null;
      return { description: dIn ? dIn.value.trim() : '', expense_account: expAcct,
        amount: parseFloat(aIn && aIn.value) || 0, vat_code: gSel ? (gSel.value.trim() || null) : null,
        currency: draftParentTr.dataset.currency || BASE_CURRENCY, vat_amount_override: vatOverride };
    });

  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    action: 'bill.draft.save', companyId: COMPANY, bill: {
      bill_id: savedBillId, vendor: draftParentTr.dataset.vendor, vendor_ref: draftParentTr.dataset.vendorRef,
      date: draftParentTr.dataset.date, due_date: draftParentTr.dataset.dueDate,
      amount: parseFloat(draftParentTr.dataset.amount) || 0, currency: draftParentTr.dataset.currency || BASE_CURRENCY,
      ap_account: apAcctP, expense_account: draftParentTr.dataset.expenseAccount || companyDefaultExpense || '',
      lines: dispLines
    }
  }) })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (res && res.error) { billEditMsg('Save failed: ' + res.error, 'err'); return; }
      _sendPost({ action: 'bill.draft.post', companyId: COMPANY, billId: savedBillId, bill: { ap_account: apAcctP } }, draftParentTr);
    })
    .catch(function(e) { billEditMsg('Save failed: ' + (e.message || 'error'), 'err'); });
}

// Shared POST dispatcher used by both inline-create and saved-draft paths.
function _sendPost(payload, draftParentTr) {
  billEditMsg('Posting…', '');
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      var d = res.data || res;
      if (res.error || (d && d.error) || (d && d.errors && d.errors.length) || (d && d.created === false)) {
        var err = res.error || (d && d.error) || (d && d.errors && d.errors.join('; ')) || 'Post failed';
        billEditMsg('Error: ' + err, 'err');
        return;
      }
      // Success: remove the draft row and its children, then reload
      var dKey = draftParentTr.dataset.draftKey;
      if (dKey) document.querySelectorAll('tr[data-parent-key="' + dKey + '"]').forEach(function(r){ r.remove(); });
      if (draftParentTr.parentNode) draftParentTr.remove();
      cursor.mode = 'NORMAL';
      loadAllBills();
      // P1-5: backend tolerance warnings (e.g. supplier-stated VAT differs
      // from computed) must reach the user — status bar only, no new chrome.
      var warnings = (d && Array.isArray(d.warnings)) ? d.warnings.filter(function(w){ return !!w; }) : [];
      if (warnings.length) {
        billEditMsg('Posted with warning: ' + warnings.join('; '), 'warn');
        setTimeout(function() { billEditMsg('', ''); }, 6000);
      } else {
        billEditMsg('Bill posted successfully.', 'ok');
        setTimeout(function() { billEditMsg('', ''); }, 2500);
      }
    })
    .catch(function(e) { billEditMsg('Error: ' + (e.message || 'Post failed'), 'err'); });
}

function registerBillKeyActions() {
  window.fbKeyActions = {
    'new': function() { /* a/o key handled by the bills FB.keys bindings */ },
    'delete': function(row) {
      var billId = row.dataset.billId;
      var vendor = row.dataset.vendor || billId;
      if (!billId) return;
      if (!confirm('Void bill from "' + vendor + '"? This will reverse the bill and cannot be undone.')) return;
      fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bill.void', companyId: COMPANY, billId: billId }) })
        .then(function(r) { return r.json(); })
        .then(function(res) {
          var d = res.data || res;
          if (res.error || d.error) {
            alert('Cannot void: ' + (res.error || d.error));
          } else {
            loadAllBills();
          }
        })
        .catch(function(e) { alert('Error: ' + e.message); });
    }
  };
}

// ========== DATA LOADING ==========
function loadPeriods() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'period.list', companyId: COMPANY }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    var rows = res.data || res || [];
    allPeriods = Array.isArray(rows) ? rows : [];
  }).catch(function(){});
}

function loadAllBills() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'bill.list', companyId: COMPANY }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    var rows = res.data || res || [];
    if (!Array.isArray(rows)) rows = [];
    allBills = rows;
    applyFilters();
    loadFxRatesForKpi(function(rateMap) { computeKpis(rows, rateMap); });
  })
  .catch(function(e){ showMsg('Error loading bills: ' + e.message); });
}

function loadFxRatesForKpi(callback) {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action: 'fx.rates.list', companyId: COMPANY }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    var rates = res.data || res || [];
    if (!Array.isArray(rates)) rates = [];
    var rateMap = {};
    rates.forEach(function(r) {
      if (!r.from_currency || !r.to_currency || !r.rate) return;
      var key = r.from_currency + '_' + r.to_currency;
      if (!rateMap[key] || String(r.rate_date||'') > String(rateMap[key].date||'')) {
        rateMap[key] = { rate: Number(r.rate), date: r.rate_date };
      }
    });
    callback(rateMap);
  })
  .catch(function(){ callback({}); });
}

function convertToBase(amt, currency, rateMap) {
  if (!currency || currency === BASE_CURRENCY) return amt;
  var key = currency + '_' + BASE_CURRENCY;
  if (rateMap[key]) return amt * rateMap[key].rate;
  var invKey = BASE_CURRENCY + '_' + currency;
  if (rateMap[invKey] && rateMap[invKey].rate) return amt / rateMap[invKey].rate;
  return amt;
}

// ========== KPI FUNCTIONS ==========
function computeKpis(bills, rateMap) {
  rateMap = rateMap || {};
  var outstandingAmt = 0, outstandingN = 0;
  var overdueAmt = 0, overdueN = 0;
  var upcomingAmt = 0, upcomingN = 0;
  bills.forEach(function(b) {
    var active = b.status === 'posted' || b.status === 'partial';
    if (!active) return;
    var amt = convertToBase(Number(b.amount || 0), b.currency, rateMap);
    var due = b.due_date ? String(b.due_date).slice(0,10) : null;
    var isOverdue = due && due < today;
    outstandingAmt += amt; outstandingN++;
    if (isOverdue) { overdueAmt += amt; overdueN++; }
    else if (due && due <= in7days) { upcomingAmt += amt; upcomingN++; }
  });
  setText('kpi-outstanding', fmtAmt(outstandingAmt));
  setText('kpi-outstanding-count', outstandingN + ' bill' + (outstandingN !== 1 ? 's' : ''));
  setText('kpi-overdue', fmtAmt(overdueAmt));
  setText('kpi-overdue-count', overdueN + ' bill' + (overdueN !== 1 ? 's' : ''));
  setText('kpi-upcoming', fmtAmt(upcomingAmt));
  setText('kpi-upcoming-count', upcomingN + ' bill' + (upcomingN !== 1 ? 's' : ''));
}

function fmtAmt(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
}

function setText(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ========== FILTER / SORT / RENDER ==========
function applyFilters() {
  filteredBills = allBills.filter(function(b) {
    if (colFilters.status) {
      if (colFilters.status === 'overdue') {
        var due = b.due_date ? String(b.due_date).slice(0,10) : null;
        var active = b.status === 'posted' || b.status === 'partial';
        if (!active || !due || due >= today) return false;
      } else {
        if (b.status !== colFilters.status) return false;
      }
    }
    if (colFilters.vendor) {
      if (String(b.vendor || '').toLowerCase().indexOf(colFilters.vendor.toLowerCase()) === -1) return false;
    }
    if (colFilters.date && String(b.date || '').slice(0,10) !== colFilters.date) return false;
    if (colFilters.due_date && String(b.due_date || '').slice(0,10) !== colFilters.due_date) return false;
    if (colFilters.vendor_ref) {
      if (String(b.vendor_ref || '').toLowerCase().indexOf(colFilters.vendor_ref.toLowerCase()) === -1) return false;
    }
    if (colFilters.currency) {
      if ((b.currency || BASE_CURRENCY) !== colFilters.currency) return false;
    }
    if (colFilters.amount) {
      var bAmt = Number(b.amount || 0);
      var fAmt = Number(colFilters.amount.val);
      var fOp  = colFilters.amount.op;
      if (fOp === '=' && bAmt !== fAmt) return false;
      if (fOp === '>' && bAmt <= fAmt) return false;
      if (fOp === '<' && bAmt >= fAmt) return false;
    }
    return true;
  });

  if (sortState.col) {
    var col = sortState.col, dir = sortState.dir;
    filteredBills = filteredBills.slice().sort(function(a, b) {
      var av = a[col] == null ? '' : a[col];
      var bv = b[col] == null ? '' : b[col];
      if (col === 'amount') { av = Number(av); bv = Number(bv); }
      else if (col === 'currency') { av = String(av); bv = String(bv); }
      else { av = String(av).toLowerCase(); bv = String(bv).toLowerCase(); }
      if (av < bv) return dir === 'asc' ? -1 : 1;
      if (av > bv) return dir === 'asc' ? 1 : -1;
      return 0;
    });
  }

  currentPage = 1;
  renderPage();
}

// Conditional CCY column: when every visible bill shares one currency the
// column carries no information — hide it (agreed 2026-07-21). It returns
// automatically in INSERT mode (the CCY input lives there) and whenever the
// list is mixed. EXCEPTION (2026-07-22): never hide while a currency filter
// is active — the column's ≡ is the only way to SEE and CLEAR that filter;
// hiding it trapped users (had to reload to get foreign bills back).
// _refreshCcyVisibility is DOM-driven (reads the currently rendered parent
// rows) so it stays correct after in-place row removals (x delete), row
// conversions (Esc save), and full re-renders alike.
var _singleCcy = false;
function _applyCcyColVisibility() {
  var tbl = document.getElementById('bills-table');
  if (!tbl) return;
  var hide = _singleCcy && !colFilters.currency && cursor.mode !== 'INSERT';
  tbl.classList.toggle('single-ccy', hide);
  // Column widths are owned by CSS (col.col-* classes + .single-ccy
  // re-weighting rules) — no JS width juggling here.
}
function _refreshCcyVisibility() {
  var ccys = {};
  var rows = document.querySelectorAll('#bills-tbody tr[data-row-type="parent"]');
  rows.forEach(function(tr) { ccys[tr.dataset.currency || ''] = 1; });
  _singleCcy = rows.length > 0 && Object.keys(ccys).length === 1;
  _applyCcyColVisibility();
}

function renderPage() {
  cursor.clear();
  var rows = filteredBills;

  if (!rows.length) {
    showMsg('No bills found.');
    document.getElementById('pagination-row').style.display = 'none';
    _refreshCcyVisibility();
    return;
  }

  var html = '';
  rows.forEach(function(b) {
    var due = b.due_date ? String(b.due_date).slice(0,10) : null;
    var active = b.status === 'posted' || b.status === 'partial';
    var isOverdue = active && due && due < today;
    var dueCls = isOverdue ? ' class="overdue-date"' : '';
    var rowUrl = '/' + COMPANY + '/bill/' + b.bill_id;
    html += '<tr data-row-type="parent" data-bill-id="' + esc(String(b.bill_id)) + '" data-vendor="' + esc(b.vendor||'') + '" data-date="' + esc(b.date||'') + '" data-due-date="' + esc(due || '') + '" data-vendor-ref="' + esc(b.vendor_ref || '') + '" data-amount="' + String(b.amount || 0) + '" data-currency="' + esc(b.currency || BASE_CURRENCY) + '" data-status="' + esc(b.status || '') + '" data-expense-account="' + esc(b.expense_account || '') + '" data-ap-account="' + esc(b.ap_account || '') + '" style="cursor:pointer">'
      + '<td>' + vendorCell(b.vendor) + '</td>'
      + '<td style="white-space:nowrap" title="' + esc(String(b.date||'').slice(0,10)) + '">' + fmtDateShort(b.date) + '</td>'
      + '<td style="white-space:nowrap" title="' + esc(due || '') + '"><span' + dueCls + '>' + fmtDateShort(due) + '</span></td>'
      + '<td><a href="' + rowUrl + '" class="ref-link" onclick="event.stopPropagation()">' + esc(b.vendor_ref || '') + '</a></td>'
      + '<td class="amt" style="text-align:right;font-variant-numeric:tabular-nums">' + Number(b.amount||0).toFixed(2) + '</td>'
      + '<td class="ccy-cell" style="font-size:0.75rem;color:#666;width:50px" id="ccy-' + esc(String(b.bill_id)) + '" data-bill-date="' + esc(String(b.date||'').slice(0,10)) + '" data-bill-ccy="' + esc(b.currency || BASE_CURRENCY) + '">' + esc(b.currency || BASE_CURRENCY) + '</td>'
      + '<td>' + statusBadge(b.status, due) + '</td>'
      + '</tr>';
  });
  var tbody = document.getElementById('bills-tbody');
  if (!tbody) return;
  tbody.innerHTML = html;
  document.getElementById('pagination-row').style.display = 'none';
  _refreshCcyVisibility();

  // Populate CCY tooltips with FX rates for non-base currency display rows
  tbody.querySelectorAll('td[id^="ccy-"]').forEach(function(cell) {
    var ccy = cell.getAttribute('data-bill-ccy') || '';
    var billDate = cell.getAttribute('data-bill-date') || '';
    if (ccy && ccy.toUpperCase() !== BASE_CURRENCY.toUpperCase()) {
      cell.setAttribute('title', ccy + ' — checking rate\u2026');
      _getFxRate(ccy, billDate).then(function(rate) {
        if (rate !== null) {
          cell.setAttribute('title', ccy + ' \u2192 ' + BASE_CURRENCY + ': ' + rate);
        } else {
          cell.setAttribute('title', ccy + ' — no rate found for ' + (billDate || 'this date') + '. Add in Settings \u2192 Exchange Rates.');
        }
      });
    }
  });

  // Auto-select first row after bills load, so j/k navigation works on initial entry
  if (!cursor.rowEl) {
    var firstRow = tbody.querySelector('tr[data-row-type="parent"], tr[data-row-type="child"]');
    if (firstRow) cursor.set(firstRow, 0);
  }
}

function renderPagination(totalPages) {
  var btns = '';
  btns += '<button class="page-btn" onclick="goPage(' + (currentPage-1) + ')" ' + (currentPage===1?'disabled':'') + '>Prev</button>';
  var lo = Math.max(1, currentPage-2), hi = Math.min(totalPages, currentPage+2);
  if (lo > 1) btns += '<button class="page-btn" onclick="goPage(1)">1</button>' + (lo>2?'<span style="padding:0 4px;color:#aaa">&hellip;</span>':'');
  for (var p = lo; p <= hi; p++) {
    btns += '<button class="page-btn' + (p===currentPage?' active':'') + '" onclick="goPage(' + p + ')">' + p + '</button>';
  }
  if (hi < totalPages) btns += (hi<totalPages-1?'<span style="padding:0 4px;color:#aaa">&hellip;</span>':'') + '<button class="page-btn" onclick="goPage(' + totalPages + ')">' + totalPages + '</button>';
  btns += '<button class="page-btn" onclick="goPage(' + (currentPage+1) + ')" ' + (currentPage===totalPages?'disabled':'') + '>Next</button>';
  document.getElementById('pag-btns').innerHTML = btns;
}

function goPage(p) {
  currentPage = p;
  renderPage();
  window.scrollTo(0,0);
}

// ========== UTILITY FUNCTIONS ==========
function vendorCell(name) {
  if (!name) return '<span style="color:#aaa">—</span>';
  var initials = name.trim().split(/\\s+/).map(function(w){ return w[0]; }).slice(0,2).join('').toUpperCase();
  var color = AVATAR_COLORS[Math.abs(hashStr(name)) % AVATAR_COLORS.length];
  return '<div class="vendor-cell">'
    + '<span class="avatar" style="background:' + color + '">' + esc(initials) + '</span>'
    + '<span>' + esc(name) + '</span>'
    + '</div>';
}

function hashStr(s) {
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function fmtDate(d) {
  if (!d) return '—';
  var s = String(d).slice(0,10);
  var parts = s.split('-');
  if (parts.length !== 3) return s;
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return parts[2] + ' ' + months[parseInt(parts[1],10)-1] + ' ' + parts[0];
}

// Compact list-row date: elide the year when it is the current calendar year
// ("21 Jul"); full "21 Jul 2025" otherwise. The full ISO date sits in the
// cell's title (hover tooltip) — density without losing the unambiguous
// month-name format. Agreed with magnus 2026-07-21.
function fmtDateShort(d) {
  if (!d) return '—';
  var s = String(d).slice(0, 10);
  var yr = new Date().toISOString().slice(0, 4);
  if (s.slice(0, 4) === yr) return fmtDate(s).replace(' ' + yr, '');
  return fmtDate(s);
}

function statusBadge(status, dueDate) {
  var isOverdue = (status === 'posted' || status === 'partial') && dueDate && String(dueDate).slice(0,10) < today;
  if (isOverdue) return '<span class="badge" style="background:#fff0f0;color:#cc2222">Overdue</span>';
  if (status === 'draft')   return '<span class="badge" style="background:#e8e4d0;color:#7a6a00;cursor:pointer">Draft</span>';
  if (status === 'posted')  return '<span class="badge" style="background:#e8eeff;color:#2255cc">Open</span>';
  if (status === 'partial') return '<span class="badge" style="background:#fff3e0;color:#cc7700">Partial</span>';
  if (status === 'paid')    return '<span class="badge" style="background:#f0fff4;color:#2a8a2a">Paid</span>';
  if (status === 'void')    return '<span class="badge" style="background:#f0f0f0;color:#888">Void</span>';
  return '<span class="badge" style="background:#f0f0f0;color:#888">' + esc(status||'') + '</span>';
}

function showMsg(msg) {
  var el = document.getElementById('bills-tbody');
  if (!el) return;
  el.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#aaa;padding:32px">' + esc(msg) + '</td></tr>';
}

// esc now comes from fb-core.js (window.esc) — P1-3 shared core

// ========== TAB SWITCHER ==========
function showPayTab(t) {
  // Leaving Vendors with a row open in INSERT: save-or-discard it first
  // (tab switch is the click-away/Esc equivalent — one save doctrine).
  if (t !== 'vendors' && typeof vendorEditRow !== 'undefined' && vendorEditRow >= 0) {
    vendorSaveAndExit();
  }
  window.fbBillNav = (t === 'bills');
  ['bills','vendors'].forEach(function(id) {
    document.getElementById('pay-panel-' + id).style.display = (id === t) ? '' : 'none';
    var tabEl = document.getElementById('pay-tab-' + id);
    if (tabEl) tabEl.classList.toggle('active', id === t);
  });
  renderPayHints(t);
  // Clear stale highlights from both systems when switching tabs
  document.querySelectorAll('tr.nav-row-focus, tr.bill-row-focus').forEach(function(r){
    r.classList.remove('nav-row-focus', 'bill-row-focus');
  });
  if (t === 'vendors') { loadVendorTable(); loadVendorAccounts(); loadVendorCurrencies(); }
  // When returning to bills, restore cursor to its previous position so the
  // highlight and scroll position match.  Without this the stale cursor.rowEl
  // silently points at a row that is off-screen, and the first j/k press
  // causes a disorienting jump.
  if (t === 'bills' && cursor.rowEl && cursor.rowEl.parentNode) {
    cursor.set(cursor.rowEl, cursor.col);
  }
}

// Sidebar keyboard hints for the active Payables tab. Both tabs render from
// their FB.keys binding tables (cannot drift from behavior).
function renderPayHints(tab) {
  var el = document.getElementById('sb-hints');
  if (!el) return;
  FB.keys.renderHints(tab === 'vendors' ? 'vendors' : 'bills', el, { layout: 'list' });
}
`;
}

module.exports = { billsTabJS };
