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
  mode: 'NORMAL',

  set: function(rowEl, col) {
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    document.querySelectorAll('tr.bill-row-focus').forEach(function(r){ r.classList.remove('bill-row-focus'); });
    document.querySelectorAll('td.bill-cell-focus').forEach(function(td){ td.classList.remove('bill-cell-focus'); });
    this.rowEl = rowEl || null;
    this.col = (col != null) ? col : 0;
    if (!rowEl) { window.fbBillCursorMid = false; return; }
    rowEl.classList.add('bill-row-focus');
    var cells = rowEl.querySelectorAll('td');
    if (this.col >= cells.length) this.col = cells.length - 1;
    if (cells[this.col]) cells[this.col].classList.add('bill-cell-focus');
    window.fbBillCursorMid = (this.col < cells.length - 1);
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

var billAccountsList = [];
var billAcctActiveInput = null;

var billEditState = {
  rowEl: null,
  tdEl: null,
  col: 0,
  origHtml: null,
  origValue: null,
  fieldType: null  // 'text' | 'date' | 'account'
};

var AVATAR_COLORS = ['#4f6ef7','#e05c5c','#2bac72','#e09d3a','#9b59c4','#17a2b8','#e07840','#5c7ae0'];

// ========== ACCOUNT AUTOCOMPLETE (bills tab) ==========
function loadBillAccounts() {
  if (billAccountsList.length) return;
  fetch('/api/' + COMPANY + '/accounts')
    .then(function(r) { return r.json(); })
    .then(function(rows) { billAccountsList = Array.isArray(rows) ? rows : []; })
    .catch(function() {});
}

function billAcctInput(input) {
  billAcctActiveInput = input;
  var q = input.value.trim().toLowerCase();
  var dd = document.getElementById('pay-bill-acct-dd');
  if (dd) dd.remove();
  if (!q) return;
  var matches = billAccountsList.filter(function(a) {
    return (a.account_code || '').toLowerCase().includes(q) || (a.account_name || '').toLowerCase().includes(q);
  }).slice(0, 12);
  if (!matches.length) return;
  var div = document.createElement('div');
  div.id = 'pay-bill-acct-dd';
  div.style.cssText = 'position:fixed;background:#fff;border:1px solid #ccc;z-index:9999;max-height:200px;overflow-y:auto;font-size:11px;box-shadow:0 2px 6px rgba(0,0,0,.2)';
  matches.forEach(function(a, mi) {
    var item = document.createElement('div');
    item.dataset.acctCode = a.account_code;
    item.dataset.idx = String(mi);
    item.textContent = a.account_code + ' \\u2014 ' + a.account_name;
    item.style.cssText = 'padding:6px 10px;cursor:pointer;white-space:nowrap;font-size:11px';
    item.onmouseover = function() { clearBillAcctDdFocus(); item.classList.add('dd-active'); item.style.background = '#e8f0fe'; };
    item.onmouseout  = function() { item.classList.remove('dd-active'); item.style.background = ''; };
    item.onmousedown = function(e) { e.preventDefault(); };
    item.onclick = function() {
      if (billAcctActiveInput) billAcctActiveInput.value = a.account_code;
      var d = document.getElementById('pay-bill-acct-dd');
      if (d) d.remove();
      billAcctActiveInput = null;
    };
    div.appendChild(item);
  });
  var rect = input.getBoundingClientRect();
  div.style.left = rect.left + 'px';
  div.style.top = (rect.bottom + 2) + 'px';
  div.style.minWidth = rect.width + 'px';
  document.body.appendChild(div);
}

function clearBillAcctDdFocus() {
  var dd = document.getElementById('pay-bill-acct-dd');
  if (!dd) return;
  dd.querySelectorAll('.dd-active').forEach(function(el) { el.classList.remove('dd-active'); el.style.background = ''; });
}

function moveBillAcctDd(dir) {
  var dd = document.getElementById('pay-bill-acct-dd');
  if (!dd) return;
  var items = dd.querySelectorAll('[data-acct-code]');
  if (!items.length) return;
  var cur = dd.querySelector('.dd-active');
  var curIdx = cur ? parseInt(cur.dataset.idx) : -1;
  var nextIdx = Math.max(0, Math.min(items.length - 1, curIdx + dir));
  clearBillAcctDdFocus();
  var next = items[nextIdx];
  next.classList.add('dd-active'); next.style.background = '#e8f0fe';
  next.scrollIntoView({ block: 'nearest' });
}

function selectBillAcctDdItem() {
  var dd = document.getElementById('pay-bill-acct-dd');
  if (!dd) return false;
  var cur = dd.querySelector('.dd-active') || dd.querySelector('[data-acct-code]');
  if (!cur) return false;
  if (billAcctActiveInput) billAcctActiveInput.value = cur.dataset.acctCode;
  dd.remove();
  billAcctActiveInput = null;
  return true;
}

function hideBillAcctDd() {
  setTimeout(function() { var dd = document.getElementById('pay-bill-acct-dd'); if (dd) dd.remove(); }, 150);
}

// ========== KEYBOARD HANDLER ==========
var kbd = {
  _registered: false,
  _lastMoveTime: 0,
  _ddPending: false,
  _ddTimer: null,

  register: function() {
    if (window._fbBillKbdHandler) {
      document.removeEventListener('keydown', window._fbBillKbdHandler);
    }
    var self = this;
    window._fbBillKbdHandler = function(e) { self._handle(e); };
    document.addEventListener('keydown', window._fbBillKbdHandler);
  },

  _isBillsTabActive: function() {
    var bills_panel = document.getElementById('pay-panel-bills');
    if (!bills_panel) return false;
    return bills_panel.style.display !== 'none';
  },

  _handle: function(e) {
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
    if (!this._isBillsTabActive()) return;

    // INSERT mode: intercept control keys only
    if (cursor.mode === 'INSERT') {
      if (e.key === 'Escape') { e.preventDefault(); exitBillCellEdit(false); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (cursor.rowEl && cursor.rowEl.dataset.draft === 'true') {
          var vDd = document.getElementById('pay-draft-vendor-dd');
          var cDd = document.getElementById('pay-draft-ccy-dd');
          if (vDd && vDd.querySelector('.dd-active')) {
            vDd.querySelector('.dd-active').click();
            var draftInps2 = Array.from(cursor.rowEl.querySelectorAll('input.draft-input, select.draft-input'));
            if (draftInps2[1]) draftInps2[1].focus();
            return;
          }
          if (cDd && cDd.querySelector('.dd-active')) { cDd.querySelector('.dd-active').click(); return; }
          var draftInputs = Array.from(cursor.rowEl.querySelectorAll('input.draft-input, select.draft-input'));
          var ae = document.activeElement;
          var dIdx = draftInputs.indexOf(ae);
          if (dIdx >= 0 && dIdx < draftInputs.length - 1) {
            draftInputs[dIdx + 1].focus();
          } else { if (ae) ae.blur(); cursor.mode = 'NORMAL'; }
          return;
        }
        exitBillCellEdit(true); return;
      }
      if (e.key === 'Tab') {
        if (cursor.rowEl && cursor.rowEl.dataset.draft === 'true') {
          return; // let native Tab work for draft rows
        }
        e.preventDefault(); return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        var dir2 = e.key === 'ArrowDown' ? 1 : -1;
        if (document.getElementById('pay-draft-vendor-dd')) { e.preventDefault(); moveDraftVendorDd(dir2); return; }
        if (document.getElementById('pay-draft-ccy-dd'))    { e.preventDefault(); moveDraftCcyDd(dir2); return; }
      }
      return; // all other keys go to input/select
    }

    var tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;

    var rows = cursor.getVisibleRows();
    var idx = cursor.currentIndex();

    if (e.key === 'j') {
      e.preventDefault();
      var now = Date.now(); if (now - this._lastMoveTime < 40) return; this._lastMoveTime = now;
      if (idx === -1 && rows.length) { cursor.set(rows[0], 0); }
      else if (idx >= 0 && idx < rows.length - 1) {
        // Block j from crossing bill boundary (child -> next parent)
        if (cursor.rowEl && cursor.rowEl.dataset.rowType === 'child' && rows[idx + 1].dataset.rowType === 'parent') { return; }
        cursor.set(rows[idx + 1], 0);
      }
      return;
    }

    if (e.key === 'k') {
      e.preventDefault();
      var now2 = Date.now(); if (now2 - this._lastMoveTime < 40) return; this._lastMoveTime = now2;
      if (idx > 0) {
        // Block k from crossing bill boundary (child -> prev parent)
        if (cursor.rowEl && cursor.rowEl.dataset.rowType === 'child' && rows[idx - 1].dataset.rowType === 'parent') { return; }
        cursor.set(rows[idx - 1], 0);
      }
      else if (idx === 0) { cursor.clear(); }
      return;
    }

    if (e.key === 'l') {
      e.preventDefault();
      if (cursor.rowEl) {
        var cells = cursor.rowEl.querySelectorAll('td');
        cursor.set(cursor.rowEl, Math.min(cursor.col + 1, cells.length - 1));
      }
      return;
    }

    if (e.key === 'h') {
      e.preventDefault();
      if (cursor.rowEl && cursor.col > 0) { cursor.set(cursor.rowEl, cursor.col - 1); }
      return;
    }

    if (e.key === '~') {
      e.preventDefault();
      if (cursor.rowEl && cursor.rowEl.dataset.rowType === 'parent') {
        var st = cursor.rowEl.dataset.status || '';
        if (st === 'draft') { openPostReviewPopup(cursor.rowEl); }
      }
      return;
    }

    // Enter = fold toggle (parent) or collapse parent (child)
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!cursor.rowEl) return;
      if (cursor.rowEl.dataset.rowType === 'parent') {
        this._toggleFold();
      } else if (cursor.rowEl.dataset.rowType === 'child') {
        var childParentKey = cursor.rowEl.dataset.parentKey || cursor.rowEl.dataset.parentId;
        var childParentRow = childParentKey
          ? (document.querySelector('tr[data-row-type="parent"][data-draft-key="' + childParentKey + '"]') ||
             document.querySelector('tr[data-row-type="parent"][data-bill-id="' + childParentKey + '"]'))
          : null;
        if (childParentRow) {
          this._closeFold(childParentRow);
          cursor.set(childParentRow, 0);
        }
      }
      return;
    }

    if (e.key === 'i') {
      e.preventDefault();
      if (cursor.rowEl && cursor.rowEl.dataset.draft === 'true') {
        if (cursor.rowEl.dataset.rowType === 'parent') {
          var firstInp = cursor.rowEl.querySelector('input, select');
          if (firstInp) { cursor.mode = 'INSERT'; firstInp.focus(); }
          return;
        }
        var draftTds = cursor.rowEl.querySelectorAll('td');
        var draftTd = draftTds[cursor.col];
        if (draftTd) {
          var draftInp = draftTd.querySelector('input, select');
          if (draftInp) {
            cursor.mode = 'INSERT';
            document.querySelectorAll('tr.bill-row-focus').forEach(function(r){ r.classList.remove('bill-row-focus'); });
            document.querySelectorAll('td.bill-cell-focus').forEach(function(td){ td.classList.remove('bill-cell-focus'); });
            draftInp.focus();
          }
        }
        return;
      }
      if (cursor.rowEl) {
        var tds2 = cursor.rowEl.querySelectorAll('td');
        var tdFocus = tds2[cursor.col];
        if (tdFocus) enterBillCellEdit(cursor.rowEl, cursor.col);
      }
      return;
    }

    // o = new draft bill (on parent) or new child line (on child)
    if (e.key === 'o') {
      e.preventDefault();
      if (cursor.rowEl && cursor.rowEl.dataset.rowType === 'child') {
        createDraftLine(cursor.rowEl);
      } else {
        createDraftBill(cursor.rowEl || null);
      }
      return;
    }

    if (e.key === 'O') {
      e.preventDefault();
      if (!cursor.rowEl) { createDraftBill(null); }
      else { insertDraftParentRow(cursor.rowEl, true); }
      return;
    }

    if (e.key === 'a') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (cursor.rowEl) {
        var isDraftParent = cursor.rowEl.dataset.rowType === 'parent' &&
          (cursor.rowEl.dataset.draft === 'true' || cursor.rowEl.dataset.status === 'draft');
        var isDraftChild = cursor.rowEl.dataset.rowType === 'child' &&
          (cursor.rowEl.dataset.draft === 'true' || cursor.rowEl.dataset.status === 'draft');
        if (isDraftParent) { insertDraftChildRow(cursor.rowEl, false); }
        else if (isDraftChild) { insertDraftChildRow(cursor.rowEl, false); }
      }
      return;
    }

    // dd = delete line (child) or delete/void bill (parent)
    if (e.key === 'd') {
      e.preventDefault();
      if (this._ddPending) {
        clearTimeout(this._ddTimer);
        this._ddPending = false;
        this._deleteCurrent();
      } else {
        this._ddPending = true;
        var self = this;
        this._ddTimer = setTimeout(function() { self._ddPending = false; }, 500);
      }
      return;
    }

    // p = post bill from any row
    if (e.key === 'p') {
      e.preventDefault();
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
        if (pRow.dataset.status === 'draft' && !pRow.dataset.draft) pRow.dataset.draft = 'true';
        openPostReviewPopup(pRow);
      }
      return;
    }

    if (e.key === 'G') {
      e.preventDefault();
      if (rows.length) cursor.set(rows[rows.length - 1], 0);
      return;
    }

    if (e.key === ' ') {
      e.preventDefault();
      this._toggleFold();
      return;
    }

    if (e.key === 'g') { e.preventDefault(); }
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
        // If saved draft (has bill_id), delete from DB
        if (billIdDraft) {
          fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'bill.delete', companyId: COMPANY, billId: billIdDraft }) })
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

  _expandAll: function() {
    var tbody = document.getElementById('bills-tbody'); if (!tbody) return;
    tbody.querySelectorAll('tr[data-row-type="parent"]').forEach(function(pr) {
      if (pr.dataset.draft === 'true') return;
      var billId = pr.dataset.billId;
      var hasChildren = !!tbody.querySelector('tr[data-row-type="child"][data-parent-id="' + billId + '"]');
      if (!hasChildren) { treeState.setOpen(billId); toggleBillLines(billId, pr); }
    });
  },

  _collapseAll: function() {
    var tbody = document.getElementById('bills-tbody'); if (!tbody) return;
    if (cursor.rowEl && cursor.rowEl.dataset.rowType === 'child') {
      var pid = cursor.rowEl.dataset.parentId;
      var pr2 = tbody.querySelector('tr[data-row-type="parent"][data-bill-id="' + pid + '"]');
      if (pr2) cursor.set(pr2, 0);
    }
    tbody.querySelectorAll('tr[data-row-type="parent"]').forEach(function(pr) {
      if (pr.dataset.draft === 'true') return;
      var billId = pr.dataset.billId;
      var hasChildren = !!tbody.querySelector('tr[data-row-type="child"][data-parent-id="' + billId + '"]');
      if (hasChildren) { treeState.setClose(billId); toggleBillLines(billId, pr); }
    });
  }
};

// ========== CELL EDITING ==========
function enterBillCellEdit(rowEl, col) {
  if (cursor.mode === 'INSERT') return;

  var statusRow = (rowEl.dataset.rowType === 'parent')
    ? rowEl
    : document.querySelector('tr[data-row-type="parent"][data-bill-id="' + rowEl.dataset.parentId + '"]');
  if (statusRow && statusRow.dataset.status === 'void') {
    billEditMsg('Cannot edit a voided bill', 'err');
    setTimeout(function() { billEditMsg('', ''); }, 2500);
    return;
  }

  var tds = rowEl.querySelectorAll('td');
  var tdEl = tds[col];
  if (!tdEl) return;

  var rowType = rowEl.dataset.rowType;
  var isGst = rowEl.classList.contains('child-gst-row');
  var fieldType = null;
  var currentValue = '';

  if (rowType === 'parent') {
    if (col === 2) {
      fieldType = 'date';
      currentValue = rowEl.dataset.dueDate || '';
    } else if (col === 3) {
      fieldType = 'text';
      currentValue = rowEl.dataset.vendorRef || '';
    } else {
      return;
    }
  } else if (rowType === 'child' && !isGst) {
    if (col === 0) {
      fieldType = 'text';
      currentValue = tdEl.textContent.trim();
    } else if (col === 3) {
      if (!rowEl.dataset.gstEntryId) return;
      var parentBillTr = document.querySelector('tr[data-row-type="parent"][data-bill-id="' + rowEl.dataset.parentId + '"]');
      var billStatus = parentBillTr ? parentBillTr.dataset.status : '';
      if (billStatus !== 'draft') return;
      fieldType = 'vatcode';
      currentValue = rowEl.dataset.gstVatCode || '';
    } else {
      return;
    }
  } else {
    return;
  }

  billEditState.rowEl = rowEl;
  billEditState.tdEl = tdEl;
  billEditState.col = col;
  billEditState.origHtml = tdEl.innerHTML;
  billEditState.origValue = currentValue;
  billEditState.fieldType = fieldType;
  cursor.mode = 'INSERT';

  tdEl.classList.remove('bill-cell-focus');
  tdEl.classList.add('vcell-editing');

  if (fieldType === 'vatcode') {
    var sel = document.createElement('select');
    sel.style.cssText = 'width:100%;font-size:0.75rem;font-family:inherit;border:none;outline:none;background:transparent;box-sizing:border-box;';
    var emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '(no tax)';
    if (!currentValue) emptyOpt.selected = true;
    sel.appendChild(emptyOpt);
    Object.keys(taxCodeMap).forEach(function(code) {
      var opt = document.createElement('option');
      opt.value = code;
      opt.textContent = code + ': ' + taxCodeMap[code];
      if (code === currentValue) opt.selected = true;
      sel.appendChild(opt);
    });
    tdEl.innerHTML = '';
    tdEl.appendChild(sel);
    sel.focus();
    return;
  }

  var input = document.createElement('input');
  if (fieldType === 'date') {
    input.type = 'date';
    input.style.cssText = 'width:100%;font-size:inherit;font-family:inherit;border:none;outline:none;background:transparent;box-sizing:border-box;';
  } else {
    input.type = 'text';
    input.style.cssText = 'width:100%;font-size:inherit;font-family:inherit;border:none;outline:none;background:transparent;box-sizing:border-box;';
  }
  input.setAttribute('autocomplete', 'off');
  input.value = currentValue;
  tdEl.innerHTML = '';
  tdEl.appendChild(input);
  input.focus();
  input.select();
}

function exitBillCellEdit(save) {
  if (cursor.mode !== 'INSERT') return;
  cursor.mode = 'NORMAL';

  var dd = document.getElementById('pay-bill-acct-dd');
  if (dd) dd.remove();

  var rowEl = billEditState.rowEl;
  var tdEl = billEditState.tdEl;
  var col = billEditState.col;

  if (!rowEl || !tdEl) { billEditState.rowEl = null; return; }

  if (rowEl && rowEl.dataset.draft === 'true') {
    if (document.activeElement) document.activeElement.blur();
    cursor.mode = 'NORMAL';
    if (!save) {
      var draftKey = rowEl.dataset.draftKey;
      var inputs = rowEl.querySelectorAll('input');
      var allEmpty = Array.from(inputs).every(function(inp){ return !inp.value.trim(); });
      if (allEmpty && draftKey) {
        document.querySelectorAll('tr[data-parent-key="' + draftKey + '"]').forEach(function(r){ r.remove(); });
        rowEl.remove();
        cursor.clear();
        tdEl.classList.remove('vcell-editing');
        billEditState.rowEl = null;
        return;
      }
    }
    tdEl.classList.remove('vcell-editing');
    billEditState.rowEl = null;
    return;
  }

  var el = tdEl.querySelector('input, select');
  var newValue = el ? el.value.trim() : billEditState.origValue;

  tdEl.classList.remove('vcell-editing');

  if (!save || newValue === billEditState.origValue) {
    tdEl.innerHTML = billEditState.origHtml;
    cursor.set(rowEl, col);
    billEditState.rowEl = null;
    return;
  }

  var rowType = rowEl.dataset.rowType;
  if (rowType === 'parent') {
    if (col === 2) {
      rowEl.dataset.dueDate = newValue;
      var today2 = new Date().toISOString().slice(0, 10);
      var isOverdue = newValue && newValue < today2;
      tdEl.innerHTML = '<span' + (isOverdue ? ' class="overdue-date"' : '') + '>' + fmtDate(newValue) + '</span>';
    } else if (col === 3) {
      rowEl.dataset.vendorRef = newValue;
      var rowUrl = '/' + COMPANY + '/bill/' + rowEl.dataset.billId;
      tdEl.innerHTML = '<a href="' + rowUrl + '" class="ref-link" onclick="event.stopPropagation()">' + esc(newValue || rowEl.dataset.billId) + '</a>';
    }
  } else if (rowType === 'child') {
    if (col === 0) {
      tdEl.textContent = newValue;
    } else if (col === 3) {
      rowEl.dataset.gstVatCode = newValue;
      tdEl.textContent = newValue;
    }
  }

  cursor.set(rowEl, col);

  var billId = rowType === 'parent' ? rowEl.dataset.billId : rowEl.dataset.parentId;
  if (rowType === 'parent') {
    var payload = { action: 'bill.update', companyId: COMPANY, billId: billId };
    if (col === 2) payload.due_date = newValue;
    if (col === 3) payload.vendor_ref = newValue;
    fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload) })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        if (res.error) { billEditMsg(res.error, 'err'); }
        else { billEditMsg('Saved.', 'ok'); setTimeout(function() { billEditMsg('', ''); }, 2500); }
      })
      .catch(function(e) { billEditMsg(e.message, 'err'); });
  } else if (rowType === 'child') {
    var entryId = (col === 3) ? rowEl.dataset.gstEntryId : rowEl.dataset.entryId;
    var ep = { action: 'journal.entry.update', companyId: COMPANY, entryId: entryId };
    if (col === 0) {
      var fullDesc = rowEl.dataset.fullDesc || '';
      var si = fullDesc.lastIndexOf(' / ');
      var prefix = si !== -1 ? fullDesc.slice(0, si) : null;
      ep.description = prefix ? (prefix + ' / ' + newValue) : newValue;
      rowEl.dataset.fullDesc = ep.description;
    } else if (col === 3) {
      ep.vat_code = newValue;
    }
    fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ep) })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        if (res.error) { billEditMsg(res.error, 'err'); }
        else { billEditMsg('Saved.', 'ok'); setTimeout(function() { billEditMsg('', ''); }, 2500); }
      })
      .catch(function(e) { billEditMsg(e.message, 'err'); });
  }

  billEditState.rowEl = null;
}

function billEditMsg(msg, type) {
  var el = document.getElementById('tb-status-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'err' ? '#cc2222' : type === 'ok' ? '#2a8a2a' : '#888';
  el.style.fontWeight = msg ? '700' : '';
}

// ========== PAGE INIT ==========
function fbPageInitPayables() {
  loadVendors();
  loadAllBills();
  loadPeriods();
  initBillsTable();
  registerBillKeyActions();
  registerVendorKeyActions();
  kbd.register();
  loadBillAccounts();
  window.fbCmdDispatch = function(cmd) {
    billEditMsg('Unknown command: ' + cmd, 'err'); setTimeout(function(){ billEditMsg('',''); }, 2000);
  };
  window.fbBillNav = true;
  window.fbBillCursorMid = false;

  fetch('/api/' + COMPANY + '/vat-codes')
    .then(function(r){ return r.json(); })
    .then(function(codes){
      if (Array.isArray(codes)) {
        codes.forEach(function(c){ taxCodeMap[c.vat_code] = c.description || c.vat_code; });
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
      var parentTr = e.target.closest('tr[data-row-type="parent"]');
      if (parentTr) {
        var billId = parentTr.dataset.billId;
        if (billId) toggleBillLines(billId, parentTr);
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
        sortIcon.textContent = sortState.dir === 'asc' ? '\\u25b2' : '\\u25bc';
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
        + '<td style="text-align:right;font-variant-numeric:tabular-nums">' + Number(line.amount || 0).toFixed(2) + '</td>'
        + '<td class="child-ccy">' + esc(line.currency || '') + '</td>'
        + '<td style="font-size:0.75rem;cursor:pointer" title="Edit tax code">' + esc(gstCode) + '</td>';

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
        + '<td style="text-align:right;font-variant-numeric:tabular-nums;color:#888">' + Number(line.amount || 0).toFixed(2) + '</td>'
        + '<td class="child-ccy" style="color:#888">' + esc(line.currency || '') + '</td>'
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
    inp2.placeholder = 'Type to filter\\u2026';
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

// Render draft child rows from draftLines array
function renderDraftChildRows(parentRow, linesList) {
  var draftKey = parentRow.dataset.draftKey;
  var parentInputs = parentRow.querySelectorAll('input');
  var parentCcy = (parentInputs[4] && parentInputs[4].value) || parentRow.dataset.currency || BASE_CURRENCY;
  var insertAfter = parentRow;
  linesList.forEach(function(line, idx) {
    var tr = document.createElement('tr');
    tr.dataset.rowType = 'child';
    tr.dataset.draft = 'true';
    tr.dataset.parentKey = draftKey;
    tr.dataset.lineIdx = String(idx);
    tr.style.cssText = 'background:#fffef5';
    tr.innerHTML = '<td colspan="4"><input class="draft-input child-desc" placeholder="Line item description" /></td>'
      + '<td><input class="draft-input" type="number" step="0.01" placeholder="0.00" style="text-align:right" /></td>'
      + '<td style="font-size:0.75rem;color:#888">' + parentCcy + '</td>'
      + '<td><select class="draft-input" style="background:#fffef5"><option value="">\\u2014 None \\u2014</option></select></td>';
    var descInp = tr.querySelector('input.child-desc');
    var amtInp  = tr.querySelectorAll('input')[1];
    var gstSel  = tr.querySelector('select');
    Object.keys(taxCodeMap).forEach(function(code) {
      var opt = document.createElement('option');
      opt.value = code; opt.textContent = code + ': ' + taxCodeMap[code];
      if (code === line.vatCode) opt.selected = true;
      gstSel.appendChild(opt);
    });
    if (descInp) descInp.value = line.desc || '';
    if (amtInp)  amtInp.value  = line.amount ? String(line.amount) : '';
    function syncLine() {
      if (draftLines[draftKey] && draftLines[draftKey][idx] !== undefined) {
        draftLines[draftKey][idx].desc    = descInp ? descInp.value.trim() : '';
        draftLines[draftKey][idx].amount  = parseFloat(amtInp ? amtInp.value : 0) || 0;
        draftLines[draftKey][idx].vatCode = gstSel ? gstSel.value : '';
      }
    }
    var _saveTimer = null;
    if (descInp) { descInp.addEventListener('blur', function() { syncLine(); autoSaveChildRow(tr, parentRow); }); descInp.addEventListener('input', function() { syncLine(); updateParentDraftAmount(parentRow); }); }
    if (amtInp)  { amtInp.addEventListener('blur',  function() { syncLine(); autoSaveChildRow(tr, parentRow); }); amtInp.addEventListener('input',  function() { syncLine(); updateParentDraftAmount(parentRow); }); }
    if (gstSel)  gstSel.addEventListener('change',  function() { syncLine(); autoSaveChildRow(tr, parentRow); });
    insertAfter.insertAdjacentElement('afterend', tr);
    insertAfter = tr;
  });
}

// Create a new draft bill below refRow (or at bottom if null), expand immediately
function createDraftBill(refRow) {
  var tbody = document.getElementById('bills-tbody');
  if (!tbody) return;
  var draftKey = 'draft-' + Date.now();
  draftLines[draftKey] = [{ desc: '', amount: 0, vatCode: '' }];
  var tr = document.createElement('tr');
  tr.dataset.rowType = 'parent';
  tr.dataset.draft = 'true';
  tr.dataset.status = 'draft';
  tr.dataset.draftKey = draftKey;
  tr.style.cssText = 'cursor:default';
  var baseCcy = BASE_CURRENCY;
  tr.innerHTML = '<td><div class="vendor-cell"><span class="avatar" style="background:#ccc;width:32px;height:32px;display:flex;align-items:center;justify-content:center">+</span><input class="draft-input draft-vendor-input" placeholder="Vendor" style="margin-left:10px" data-vendor-id="" data-vendor-name="" data-ap-account="201100" data-expense-account="400000" /></div></td>'
    + '<td><input class="draft-input" type="date" placeholder="Date" /></td>'
    + '<td><input class="draft-input" type="date" placeholder="Due" /></td>'
    + '<td><input class="draft-input" placeholder="Ref" /></td>'
    + '<td style="text-align:right;color:#aaa;font-style:italic;padding:8px 18px" class="draft-total-amount">0.00</td>'
    + '<td><input class="draft-input" style="width:50px;text-align:center;text-transform:uppercase" placeholder="CCY" value="' + baseCcy + '" /></td>'
    + '<td><span class="badge" style="background:#e8e4d0;color:#7a6a00;cursor:pointer" onclick="openPostReviewPopup(this.parentElement.parentElement)" title="Click to post draft bill">Draft</span></td>';
  var insertAfterRow = refRow;
  if (refRow && refRow.dataset.rowType === 'child') {
    var pKey2 = refRow.dataset.parentKey || refRow.dataset.parentId;
    var siblings = pKey2 ? Array.from(document.querySelectorAll('tr[data-parent-key="' + pKey2 + '"]')) : [];
    if (siblings.length) insertAfterRow = siblings[siblings.length - 1];
  }
  if (insertAfterRow) { insertAfterRow.parentElement.insertBefore(tr, insertAfterRow.nextElementSibling); }
  else { tbody.appendChild(tr); }
  _wireDraftParentEvents(tr);
  treeState.setOpen(draftKey);
  renderDraftChildRows(tr, draftLines[draftKey]);
  cursor.set(tr, 0);
  // Auto-enter INSERT on vendor field
  cursor.mode = 'INSERT';
  var vendorInp = tr.querySelector('input.draft-vendor-input');
  if (vendorInp) setTimeout(function() { vendorInp.focus(); vendorInp.select(); }, 0);
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
  draftLines[parentKey].push({ desc: '', amount: 0, vatCode: '' });
  var siblings = Array.from(document.querySelectorAll('tr[data-parent-key="' + parentKey + '"]'));
  var insertAfterEl = siblings.length ? siblings[siblings.length - 1] : parentRow;
  var tr = document.createElement('tr');
  tr.dataset.rowType = 'child';
  tr.dataset.draft = 'true';
  tr.dataset.parentKey = parentKey;
  tr.dataset.lineIdx = String(newIdx);
  tr.style.cssText = 'background:#fffef5';
  var parentCcy = parentRow.dataset.currency || BASE_CURRENCY;
  tr.innerHTML = '<td colspan="4"><input class="draft-input child-desc" placeholder="Line item description" /></td>'
    + '<td><input class="draft-input" type="number" step="0.01" placeholder="0.00" style="text-align:right" /></td>'
    + '<td style="font-size:0.75rem;color:#888">' + parentCcy + '</td>'
    + '<td><select class="draft-input" style="background:#fffef5"><option value="">\\u2014 None \\u2014</option></select></td>';
  var gstSel2 = tr.querySelector('select');
  Object.keys(taxCodeMap).forEach(function(code) {
    var opt = document.createElement('option'); opt.value = code; opt.textContent = code + ': ' + taxCodeMap[code]; gstSel2.appendChild(opt);
  });
  var descInp2 = tr.querySelector('input.child-desc');
  var amtInp2  = tr.querySelectorAll('input')[1];
  function syncLine2() {
    if (draftLines[parentKey] && draftLines[parentKey][newIdx] !== undefined) {
      draftLines[parentKey][newIdx].desc    = descInp2 ? descInp2.value.trim() : '';
      draftLines[parentKey][newIdx].amount  = parseFloat(amtInp2 ? amtInp2.value : 0) || 0;
      draftLines[parentKey][newIdx].vatCode = gstSel2 ? gstSel2.value : '';
    }
  }
  var _t2 = null;
  if (descInp2) { descInp2.addEventListener('blur', function() { syncLine2(); autoSaveChildRow(tr, parentRow); }); descInp2.addEventListener('input', function() { syncLine2(); updateParentDraftAmount(parentRow); }); }
  if (amtInp2)  { amtInp2.addEventListener('blur',  function() { syncLine2(); autoSaveChildRow(tr, parentRow); }); amtInp2.addEventListener('input',  function() { syncLine2(); updateParentDraftAmount(parentRow); }); }
  if (gstSel2)  gstSel2.addEventListener('change',  function() { syncLine2(); autoSaveChildRow(tr, parentRow); });
  insertAfterEl.insertAdjacentElement('afterend', tr);
  cursor.set(tr, 0);
}

// Wire all parent-row input events onto a draft parent TR
function _wireDraftParentEvents(tr) {
  var vendorInput = tr.querySelector('input.draft-vendor-input');
  var draftInputs2 = tr.querySelectorAll('input');
  var dateInputEl  = draftInputs2[1];
  var dueInputEl   = draftInputs2[2];
  var ccyInputEl   = draftInputs2[4];
  if (vendorInput) {
    vendorInput.addEventListener('input', function() { draftVendorInput(vendorInput); });
    vendorInput.addEventListener('blur', function() {
      setTimeout(function() { var dd = document.getElementById('pay-draft-vendor-dd'); if (dd) dd.remove(); }, 150);
      setTimeout(function() {
        var name = vendorInput.value.trim();
        if (!name) return;
        if (vendorInput.dataset.vendorName) {
          vendorInput.classList.remove('req');
          var v = allVendors.find(function(x){ return x.vendor_id === vendorInput.dataset.vendorId; });
          if (v && ccyInputEl && !ccyInputEl.value) ccyInputEl.value = (v.default_currency || BASE_CURRENCY).toUpperCase();
          autoSaveDraftIfReady(tr); return;
        }
        var match = allVendors.find(function(x){ return (x.name||'').toLowerCase() === name.toLowerCase(); });
        if (!match) { billEditMsg('Vendor not in master data \\u2014 select from dropdown', 'err'); vendorInput.classList.add('req'); vendorInput.value = ''; vendorInput.dataset.vendorName = ''; return; }
        vendorInput.dataset.vendorId = match.vendor_id || '';
        vendorInput.dataset.vendorName = match.name || '';
        vendorInput.dataset.apAccount = match.default_ap_account || '201100';
        vendorInput.dataset.expenseAccount = match.default_expense_account || '400000';
        vendorInput.value = match.name;
        vendorInput.classList.remove('req');
        if (ccyInputEl && !ccyInputEl.value) ccyInputEl.value = (match.default_currency || BASE_CURRENCY).toUpperCase();
        autoSaveDraftIfReady(tr);
      }, 200);
    });
  }
  if (dueInputEl) {
    dueInputEl.addEventListener('blur', function() {
      var dueVal = dueInputEl.value;
      var dateVal = dateInputEl ? dateInputEl.value : '';
      if (dueVal && dateVal && dueVal < dateVal) { billEditMsg('Due date must be \\u2265 bill date', 'err'); dueInputEl.classList.add('req'); dueInputEl.value = ''; return; }
      if (dueVal) dueInputEl.classList.remove('req');
      autoSaveDraftIfReady(tr);
    });
  }
  if (ccyInputEl) {
    ccyInputEl.addEventListener('input', function() { draftCcyInput(ccyInputEl); });
    ccyInputEl.addEventListener('keydown', function(e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveDraftCcyDd(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); moveDraftCcyDd(-1); return; }
      if (e.key === 'Tab' && !e.shiftKey) {
        // Tab from CCY -> first child desc input
        var firstChild = document.querySelector('tr[data-parent-key="' + tr.dataset.draftKey + '"] input.child-desc');
        if (firstChild) { e.preventDefault(); firstChild.focus(); }
      }
    });
    ccyInputEl.addEventListener('blur', function() {
      setTimeout(function() { var dd = document.getElementById('pay-draft-ccy-dd'); if (dd) dd.remove(); }, 150);
      var v = ccyInputEl.value.trim().toUpperCase();
      if (v && vendorCurrenciesList.length) {
        var valid = vendorCurrenciesList.some(function(c){ return (c.code||'').toUpperCase() === v; });
        if (!valid) {
          billEditMsg('"' + v + '" is not a valid currency code — select from the dropdown', 'err');
          ccyInputEl.value = '';
          ccyInputEl.classList.add('req');
          return;
        }
        ccyInputEl.classList.remove('req'); ccyInputEl.value = v;
      }
      autoSaveDraftIfReady(tr);
    });
  }
  var refInputEl = draftInputs2[3];
  if (dateInputEl) dateInputEl.addEventListener('blur', function() { autoSaveDraftIfReady(tr); });
  if (refInputEl)  refInputEl.addEventListener('blur',  function() { autoSaveDraftIfReady(tr); });
  // Tab from ref -> skip read-only amount, go to CCY
  if (refInputEl && ccyInputEl) {
    refInputEl.addEventListener('keydown', function(e) {
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); ccyInputEl.focus(); }
    });
  }
  tr.addEventListener('focusin', function(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
      document.querySelectorAll('tr.bill-row-focus').forEach(function(r){ r.classList.remove('bill-row-focus'); });
      document.querySelectorAll('td.bill-cell-focus').forEach(function(td){ td.classList.remove('bill-cell-focus'); });
    }
  });
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
  tr.innerHTML = '<td><div class="vendor-cell"><span class="avatar" style="background:#ccc;width:32px;height:32px;display:flex;align-items:center;justify-content:center">+</span><input class="draft-input draft-vendor-input" placeholder="Vendor" style="margin-left:10px" data-vendor-id="" data-vendor-name="" data-ap-account="201100" data-expense-account="400000" /></div></td>'
    + '<td><input class="draft-input" type="date" placeholder="Date" /></td>'
    + '<td><input class="draft-input" type="date" placeholder="Due" /></td>'
    + '<td><input class="draft-input" placeholder="Ref" /></td>'
    + '<td style="text-align:right;color:#aaa;font-style:italic;padding:8px 18px" class="draft-total-amount">0.00</td>'
    + '<td><input class="draft-input" style="width:50px;text-align:center;text-transform:uppercase" placeholder="CCY" value="' + baseCcy + '" /></td>'
    + '<td><span class="badge" style="background:#e8e4d0;color:#7a6a00;cursor:pointer" onclick="openPostReviewPopup(this.parentElement.parentElement)" title="Click to post draft bill">Draft</span></td>';
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
      var a = cr.querySelector('input.child-desc') ? cr.querySelectorAll('input')[1] : null; total += parseFloat(a && a.value) || 0;
    });
  }
  var amtCell = draftParentTr.querySelector('.draft-total-amount');
  if (amtCell) { amtCell.textContent = total.toFixed(2); return; }
  var tds = draftParentTr.querySelectorAll('td');
  if (tds[4]) tds[4].textContent = total.toFixed(2);
  draftParentTr.dataset.amount = String(total);
}

// Alias used by _deleteCurrent
var recalcParentAmount = updateParentDraftAmount;

function autoSaveChildRow(childRow, parentTr) {
  // Validate + highlight; recalc parent total; then try save (deferred focus check)
  var descInput = childRow.querySelector('input.child-desc');
  var amtInput  = childRow.querySelectorAll('input')[1];
  var gstSelect = childRow.querySelector('select');
  var desc = descInput && descInput.value.trim();
  var amt  = parseFloat(amtInput && amtInput.value) || 0;
  if (descInput) descInput.classList.toggle('req', !desc);
  if (amtInput)  amtInput.classList.toggle('req', !(amt > 0));
  updateParentDraftAmount(parentTr);
  autoSaveDraftIfReady(parentTr); // deferred — only saves when focus leaves entire bill
}

function autoSaveDraftIfReady(draftParentTr) {
  // Defer so focus has settled — only save if the user has left the draft bill entirely
  var draftKey = draftParentTr.dataset.draftKey || draftParentTr.dataset.billId;
  setTimeout(function() {
    if (draftParentTr.contains(document.activeElement)) return; // still in parent row
    // Also check sibling child rows (they are <tr> siblings, not DOM children of parent)
    if (draftKey) {
      var childRows = document.querySelectorAll('tr[data-parent-key="' + draftKey + '"]');
      for (var ci = 0; ci < childRows.length; ci++) {
        if (childRows[ci].contains(document.activeElement)) return;
      }
    }
    var vendorInput = draftParentTr.querySelector('input.draft-vendor-input');
    var inputs = draftParentTr.querySelectorAll('input');
    var dateInput = inputs[1], dueInput = inputs[2], refInput = inputs[3], ccyInput = inputs[4];
    if (!vendorInput || !vendorInput.dataset.vendorName) return;
    if (!dateInput || !dateInput.value) return;
    if (!dueInput || !dueInput.value) return;
    if (!refInput || !refInput.value.trim()) return;
    if (!ccyInput || !ccyInput.value.trim()) return;
    saveDraftToDb(draftParentTr);
  }, 200);
}

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
  var parentCcy = (parentInputs[4] && parentInputs[4].value) || parentTr.dataset.currency || BASE_CURRENCY;
  var tr = document.createElement('tr');
  tr.dataset.rowType = 'child';
  tr.dataset.draft = 'true';
  tr.dataset.parentKey = draftKey;
  tr.style.cssText = 'background:#fffef5';
  tr.innerHTML = '<td colspan="4"><input class="draft-input child-desc" placeholder="Line item description" /></td>'
    + '<td><input class="draft-input" type="number" step="0.01" placeholder="0.00" style="text-align:right" /></td>'
    + '<td style="font-size:0.75rem;color:#888">' + parentCcy + '</td>'
    + '<td><select class="draft-input" style="background:#fffef5"><option value="">\\u2014 None \\u2014</option></select></td>';
  var gstSelect = tr.querySelector('select');
  Object.keys(taxCodeMap).forEach(function(code) {
    var opt = document.createElement('option');
    opt.value = code;
    opt.textContent = code + ': ' + taxCodeMap[code];
    gstSelect.appendChild(opt);
  });
  if (above) {
    childRow.parentElement.insertBefore(tr, childRow);
  } else {
    childRow.parentElement.insertBefore(tr, childRow.nextElementSibling);
  }
  var parentTrRef = parentTr;
  var descInpRef = tr.querySelector('input.child-desc');
  var amtInpRef  = tr.querySelectorAll('input')[1];
  var gstSelRef  = tr.querySelector('select');
  if (descInpRef) { descInpRef.addEventListener('blur', function() { autoSaveChildRow(tr, parentTrRef); }); descInpRef.addEventListener('input', function() { updateParentDraftAmount(parentTrRef); }); }
  if (amtInpRef)  { amtInpRef.addEventListener('blur',  function() { autoSaveChildRow(tr, parentTrRef); }); amtInpRef.addEventListener('input',  function() { updateParentDraftAmount(parentTrRef); }); }
  if (gstSelRef)  gstSelRef.addEventListener('change',  function() { autoSaveChildRow(tr, parentTrRef); });
  cursor.set(tr, 0);
  cursor.mode = 'INSERT';
  var descInput = tr.querySelector('input.child-desc');
  descInput.focus();
}

// ========== CONVERT DRAFT ROW TO DISPLAY ==========
function convertDraftRowToDisplay(draftParentTr, billId) {
  var inputs = draftParentTr.querySelectorAll('input');
  var vendorInput = draftParentTr.querySelector('input.draft-vendor-input');
  var dateInput = inputs[1], dueInput = inputs[2], refInput = inputs[3], ccyInput = inputs[4];
  var vendor = vendorInput ? (vendorInput.dataset.vendorName || vendorInput.value) : '';
  var billDate = dateInput ? dateInput.value : '';
  var dueDate = dueInput ? dueInput.value : '';
  var vendorRef = refInput ? refInput.value.trim() : '';
  var currency = ccyInput ? (ccyInput.value.trim().toUpperCase() || BASE_CURRENCY) : BASE_CURRENCY;
  var draftKeyC = draftParentTr.dataset.draftKey;
  var amount = 0;
  if (draftKeyC) Array.from(document.querySelectorAll('tr[data-parent-key="' + draftKeyC + '"]')).forEach(function(cr) { var a = cr.querySelectorAll('input')[1]; amount += parseFloat(a && a.value) || 0; });
  var draftKey = draftParentTr.dataset.draftKey;

  draftParentTr.dataset.billId = billId;
  draftParentTr.dataset.vendor = vendor;
  draftParentTr.dataset.date = billDate;
  draftParentTr.dataset.dueDate = dueDate;
  draftParentTr.dataset.vendorRef = vendorRef;
  draftParentTr.dataset.amount = String(amount);
  draftParentTr.dataset.currency = currency;
  draftParentTr.dataset.status = 'draft';
  var savedVendorInput = draftParentTr.querySelector('input.draft-vendor-input');
  if (savedVendorInput) {
    draftParentTr.dataset.apAccount = savedVendorInput.dataset.apAccount || '201100';
    draftParentTr.dataset.expenseAccount = savedVendorInput.dataset.expenseAccount || '400000';
  }
  delete draftParentTr.dataset.draft;
  draftParentTr.style.cursor = 'pointer';

  var isOverdue = dueDate && dueDate < today;
  var dueCls = isOverdue ? ' class="overdue-date"' : '';
  var rowUrl = '/' + COMPANY + '/bill/' + billId;
  draftParentTr.innerHTML = '<td>' + vendorCell(vendor) + '</td>'
    + '<td style="white-space:nowrap">' + fmtDate(billDate) + '</td>'
    + '<td style="white-space:nowrap"><span' + dueCls + '>' + fmtDate(dueDate) + '</span></td>'
    + '<td><a href="' + rowUrl + '" class="ref-link" onclick="event.stopPropagation()">' + esc(vendorRef) + '</a></td>'
    + '<td style="text-align:right;font-variant-numeric:tabular-nums">' + Number(amount).toFixed(2) + '</td>'
    + '<td style="font-size:0.75rem;color:#666;text-align:center;width:50px">' + esc(currency) + '</td>'
    + '<td><span class="badge" style="background:#e8e4d0;color:#7a6a00;cursor:pointer" onclick="openPostReviewForSavedDraft(this.parentElement.parentElement)" title="Click to post draft bill">Draft</span></td>';

  if (draftKey) {
    var childRows = Array.from(document.querySelectorAll('tr[data-parent-key="' + draftKey + '"][data-draft="true"]'));
    childRows.forEach(function(childTr) {
      var descInput = childTr.querySelector('input.child-desc');
      var amtInputC = childTr.querySelectorAll('input')[1];
      var gstSelect = childTr.querySelector('select');
      var desc = descInput ? descInput.value.trim() : '';
      var childAmt = parseFloat(amtInputC ? amtInputC.value : 0) || 0;
      var gstCode = gstSelect ? gstSelect.value : '';

      delete childTr.dataset.draft;
      childTr.dataset.parentId = billId;

      childTr.innerHTML = '<td colspan="4" class="child-desc">' + esc(desc) + '</td>'
        + '<td style="text-align:right">' + Number(childAmt).toFixed(2) + '</td>'
        + '<td class="child-ccy" style="font-size:0.75rem;color:#aaa">' + esc(currency) + '</td>'
        + '<td></td>';
      var gstTd = childTr.querySelector('td:last-child');
      var sel = document.createElement('select');
      sel.style.cssText = 'font-size:0.75rem;border:1px solid #ddd;border-radius:3px;padding:2px 4px;background:#fff;max-width:120px;';
      var emptyOpt = document.createElement('option'); emptyOpt.value = ''; emptyOpt.textContent = '\\u2014 None \\u2014'; sel.appendChild(emptyOpt);
      Object.keys(taxCodeMap).forEach(function(code) {
        var opt = document.createElement('option');
        opt.value = code; opt.textContent = code;
        if (code === gstCode) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', function() { autoSaveDraftIfReady(draftParentTr); });
      gstTd.appendChild(sel);
    });
  }

  cursor.mode = 'NORMAL';
  var lastCol = draftParentTr.querySelectorAll('td').length - 1;
  cursor.set(draftParentTr, lastCol);
  draftParentTr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ========== SAVE DRAFT TO DB ==========
function saveDraftToDb(draftParentTr) {
  var vendorInput = draftParentTr.querySelector('input.draft-vendor-input');
  var inputs = draftParentTr.querySelectorAll('input');
  var dateInput = inputs[1], dueInput = inputs[2], refInput = inputs[3], ccyInput = inputs[4];

  if (!vendorInput && draftParentTr.dataset.billId) {
    var dispBillId = draftParentTr.dataset.billId;
    var dispKey = draftParentTr.dataset.draftKey || dispBillId;
    var dispLines = Array.from(document.querySelectorAll('tr[data-parent-key="' + dispKey + '"]')).filter(function(cr){ return !!cr.querySelector('input.child-desc'); }).map(function(cr) {
      var dIn = cr.querySelector('input.child-desc'); var aIn = cr.querySelectorAll('input')[1]; var gSel = cr.querySelector('select');
      return { description: dIn?dIn.value.trim():'', expense_account: draftParentTr.dataset.expenseAccount||'400000',
        amount: parseFloat(aIn&&aIn.value)||0, vat_code: gSel?(gSel.value||null):null, currency: draftParentTr.dataset.currency||BASE_CURRENCY };
    });
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
      action:'bill.draft.save', companyId:COMPANY, bill:{ bill_id:dispBillId,
        vendor:draftParentTr.dataset.vendor, vendor_ref:draftParentTr.dataset.vendorRef,
        date:draftParentTr.dataset.date, due_date:draftParentTr.dataset.dueDate,
        amount:parseFloat(draftParentTr.dataset.amount)||0, currency:draftParentTr.dataset.currency||BASE_CURRENCY,
        ap_account:draftParentTr.dataset.apAccount||'201100', expense_account:draftParentTr.dataset.expenseAccount||'400000',
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
  if (dueDate < billDate) { billEditMsg('Due date must be \\u2265 bill date', 'err'); return; }
  var draftKeyAmt = draftParentTr.dataset.draftKey;
  var totalAmt = 0;
  if (draftKeyAmt) {
    Array.from(document.querySelectorAll('tr[data-parent-key="' + draftKeyAmt + '"]')).forEach(function(cr) {
      var a = cr.querySelectorAll('input')[1]; totalAmt += parseFloat(a && a.value) || 0;
    });
  }

  var existingBillId = draftParentTr.dataset.billId || null;
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
      ap_account: vendorInput ? (vendorInput.dataset.apAccount || '201100') : '201100',
      expense_account: vendorInput ? (vendorInput.dataset.expenseAccount || '400000') : '400000',
      lines: (function() {
        var dk = draftKeyAmt;
        if (!dk) return null;
        var expAcct2 = vendorInput ? (vendorInput.dataset.expenseAccount || '400000') : '400000';
        var ccy2 = ccyInput ? (ccyInput.value.trim().toUpperCase() || BASE_CURRENCY) : BASE_CURRENCY;
        var childRows2 = Array.from(document.querySelectorAll('tr[data-parent-key="' + dk + '"]')).filter(function(cr){ return !!cr.querySelector('input.child-desc'); });
        return childRows2.map(function(cr) {
          var dIn = cr.querySelector('input.child-desc');
          var aIn = cr.querySelectorAll('input')[1];
          var gSel = cr.querySelector('select');
          return { description: dIn ? dIn.value.trim() : '', expense_account: expAcct2, currency: ccy2,
            amount: parseFloat(aIn && aIn.value) || 0, vat_code: gSel ? (gSel.value || null) : null };
        });
      })()
    }
  };

  billEditMsg('Saving draft\\u2026', '');
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

// ========== POST REVIEW POPUP ==========
function openPostReviewPopup(draftParentTr) {
  var isDbDraft = draftParentTr.dataset.billId && !draftParentTr.querySelector('input.draft-vendor-input');

  var vendorName, apAccount, expAcct, billDate, dueDate, totalAmt, ccy, refCode;
  var lines = [];

  if (isDbDraft) {
    vendorName = draftParentTr.dataset.vendor;
    billDate = draftParentTr.dataset.billDate || draftParentTr.dataset.date;
    dueDate = draftParentTr.dataset.dueDate || draftParentTr.dataset.due_date;
    totalAmt = parseFloat(draftParentTr.dataset.amount) || 0;
    ccy = draftParentTr.dataset.currency || BASE_CURRENCY;
    refCode = draftParentTr.dataset.vendorRef || '';
    apAccount = '201100';
    expAcct = '400000';
    lines.push({ description: '', expense_account: expAcct, amount: totalAmt, vat_code: null });
  } else {
    var vendorInputs = draftParentTr.querySelectorAll('input');
    var vendorInput = draftParentTr.querySelector('input.draft-vendor-input');
    var dateInput = vendorInputs[1];
    var dueInput = vendorInputs[2];
    var refInput = vendorInputs[3];
    var ccyInput = vendorInputs[4];
    vendorName = vendorInput && vendorInput.dataset.vendorName;
    apAccount = vendorInput && (vendorInput.dataset.apAccount || '201100');
    if (!vendorName && vendorInput) vendorName = vendorInput.value.trim();
    expAcct = vendorInput && (vendorInput.dataset.expenseAccount || '400000');
    billDate = dateInput && dateInput.value;
    dueDate = dueInput && dueInput.value;
    var draftKeyT = draftParentTr.dataset.draftKey;
    totalAmt = 0;
    if (draftKeyT) Array.from(document.querySelectorAll('tr[data-parent-key="' + draftKeyT + '"]')).forEach(function(cr) { var a = cr.querySelectorAll('input')[1]; totalAmt += parseFloat(a && a.value) || 0; });
    ccy = ccyInput && (ccyInput.value.trim().toUpperCase() || BASE_CURRENCY);
    refCode = refInput ? refInput.value.trim() : '';
    if (!vendorName) { billEditMsg('Vendor required \\u2014 select from dropdown', 'err'); return; }
    var vendorNameSet = vendorInput && vendorInput.dataset.vendorName;
    if (!vendorNameSet) { billEditMsg('Select vendor from dropdown (must exist in vendor master)', 'err'); return; }

    var draftKey = draftParentTr.dataset.draftKey;
    var childRows = Array.from(document.querySelectorAll('tr[data-parent-key="' + draftKey + '"]'));
    if (childRows.length > 0) {
      childRows.forEach(function(cr) {
        var descInput = cr.querySelector('input.child-desc');
        var amtInputC = cr.querySelectorAll('input')[1];
        var gstSelect = cr.querySelector('select');
        var desc = descInput ? descInput.value.trim() : '';
        var amt = parseFloat(amtInputC && amtInputC.value) || 0;
        var vatCode = gstSelect ? gstSelect.value : '';
        lines.push({ description: desc, expense_account: expAcct, amount: amt, vat_code: vatCode || null });
      });
    } else {
      lines.push({ description: '', expense_account: expAcct, amount: totalAmt, vat_code: null });
    }
  }

  if (!vendorName) { billEditMsg('Vendor required', 'err'); return; }
  if (!refCode) { billEditMsg('Invoice reference (Ref) is required before posting', 'err'); return; }
  if (!billDate) { billEditMsg('Bill date is required', 'err'); return; }
  if (!dueDate) { billEditMsg('Due date is required', 'err'); return; }
  if (dueDate < billDate) { billEditMsg('Due date must be \\u2265 bill date', 'err'); return; }
  if (!isDbDraft) {
    var draftKeyP = draftParentTr.dataset.draftKey;
    if (draftKeyP) {
      var childRowsP = Array.from(document.querySelectorAll('tr[data-parent-key="' + draftKeyP + '"]'));
      var hasCompleteChild = childRowsP.some(function(cr) {
        var dIn = cr.querySelector('input.child-desc'); var aIn = cr.querySelectorAll('input')[1]; var gSel = cr.querySelector('select');
        return dIn && dIn.value.trim() && aIn && parseFloat(aIn.value) > 0 && gSel && gSel.value;
      });
      if (!hasCompleteChild) { billEditMsg('Add at least one complete line item (description, amount, tax code) before posting', 'err'); return; }
    }
  }
  if (!totalAmt || totalAmt <= 0) { billEditMsg('Total amount must be > 0', 'err'); return; }

  if (allPeriods.length) {
    var bd = billDate.slice(0, 10);
    var coveringPeriod = allPeriods.find(function(p) {
      return !p.locked && p.start_date <= bd && p.end_date >= bd;
    });
    if (!coveringPeriod) {
      var lockedMatch = allPeriods.find(function(p) { return p.start_date <= bd && p.end_date >= bd; });
      if (lockedMatch) { billEditMsg('Bill date falls in a locked period: ' + lockedMatch.period_name, 'err'); }
      else { billEditMsg('Bill date does not fall within any defined period', 'err'); }
      return;
    }
  }
  window._prvDraftTr = draftParentTr;
  window._prvLines = lines;
  window._prvMeta = { vendor: vendorName, vendor_ref: refCode, date: billDate, due_date: dueDate, amount: totalAmt, currency: ccy, ap_account: apAccount, expense_account: expAcct };
  var overlay = document.createElement('div');
  overlay.id = 'post-review-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10000;display:flex;align-items:center;justify-content:center';
  var popupContent = '<div style="background:#fff;border-radius:8px;padding:24px;max-width:600px;max-height:80vh;overflow-y:auto;box-shadow:0 10px 40px rgba(0,0,0,.3)">'
    + '<h2 style="margin:0 0 16px;font-size:1.25rem">Post Bill</h2>'
    + '<div style="margin-bottom:16px">'
    + '<div style="display:flex;gap:24px;font-size:0.875rem;margin-bottom:12px">'
    + '<div><span style="color:#666">Vendor:</span> <strong>' + esc(vendorName) + '</strong></div>'
    + '<div><span style="color:#666">Date:</span> <strong>' + fmtDate(billDate) + '</strong></div>'
    + '</div>'
    + '<div style="display:flex;gap:24px;font-size:0.875rem">'
    + '<div><span style="color:#666">Amount:</span> <strong>' + Number(totalAmt).toFixed(2) + ' ' + ccy + '</strong></div>'
    + '<div><span style="color:#666">Due:</span> <strong>' + fmtDate(window._prvMeta.due_date) + '</strong></div>'
    + '</div>'
    + '</div>'
    + '<div id="post-review-error" style="color:#cc2222;margin-bottom:12px;display:none"></div>'
    + '<table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:0.875rem">'
    + '<thead><tr style="border-bottom:1px solid #ddd"><th style="text-align:left;padding:8px 0">Account</th><th style="text-align:right;padding:8px 0">Debit</th><th style="text-align:right;padding:8px 0">Credit</th></tr></thead>'
    + '<tbody id="post-review-lines"></tbody>'
    + '</table>'
    + '<div style="display:flex;gap:10px;justify-content:flex-end">'
    + '<button onclick="closePostReviewPopup()" style="padding:8px 16px;background:#f0f0f0;border:1px solid #ccc;border-radius:4px;cursor:pointer">Cancel</button>'
    + '<button onclick="confirmPost()" style="padding:8px 16px;background:#1a1a1a;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:600">Post</button>'
    + '</div>'
    + '</div>';
  overlay.innerHTML = popupContent;
  document.body.appendChild(overlay);
  var linesTable = document.getElementById('post-review-lines');
  lines.forEach(function(line) {
    var tr = document.createElement('tr');
    var acctName = billAccountsList.find(function(a) { return a.account_code === line.expense_account; });
    var acctNameStr = acctName ? acctName.account_name : line.expense_account;
    tr.innerHTML = '<td style="padding:6px 0"><span style="color:#2255cc">'
      + esc(line.expense_account) + ' \\u2014 ' + esc(acctNameStr) + '</span></td>'
      + '<td style="text-align:right;padding:6px 0">' + Number(line.amount).toFixed(2) + '</td>'
      + '<td style="text-align:right;padding:6px 0">\\u2014</td>';
    linesTable.appendChild(tr);
  });
  var crTr = document.createElement('tr');
  crTr.style.borderTop = '1px solid #ddd';
  var crAcctName = billAccountsList.find(function(a) { return a.account_code === apAccount; });
  var crAcctNameStr = crAcctName ? crAcctName.account_name : apAccount;
  crTr.innerHTML = '<td style="padding:6px 0;font-weight:600"><span style="color:#2255cc;font-weight:600">'
    + esc(apAccount) + ' \\u2014 ' + esc(crAcctNameStr) + '</span></td>'
    + '<td style="text-align:right;padding:6px 0">\\u2014</td>'
    + '<td style="text-align:right;padding:6px 0;font-weight:600">' + Number(totalAmt).toFixed(2) + '</td>';
  linesTable.appendChild(crTr);
}

function confirmPost() {
  var meta = window._prvMeta;
  var lines = window._prvLines;
  var draftTr = window._prvDraftTr;
  var savedBillId = draftTr && draftTr.dataset.billId;

  var action, payload;
  if (savedBillId) {
    action = 'bill.draft.post';
    payload = { action: action, companyId: COMPANY, billId: savedBillId, bill: { lines: lines, ap_account: meta.ap_account } };
  } else {
    action = 'bill.create';
    payload = { action: action, companyId: COMPANY, bill: {
      vendor: meta.vendor, vendor_ref: meta.vendor_ref, date: meta.date, due_date: meta.due_date,
      amount: meta.amount, currency: meta.currency, ap_account: meta.ap_account, lines: lines
    }};
  }

  fetch('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (res.error || (res.data && res.data.error)) {
        var err = res.error || (res.data && res.data.error);
        var errDiv = document.getElementById('post-review-error');
        if (errDiv) { errDiv.style.display = 'block'; errDiv.textContent = 'Error: ' + err; }
        return;
      }
      closePostReviewPopup();
      if (window._prvDraftTr) {
        var dKey = window._prvDraftTr.dataset.draftKey;
        if (dKey) document.querySelectorAll('tr[data-parent-key="' + dKey + '"]').forEach(function(r){ r.remove(); });
        window._prvDraftTr.remove();
      }
      loadAllBills();
      billEditMsg('Bill posted successfully.', 'ok');
      setTimeout(function() { billEditMsg('', ''); }, 2500);
    })
    .catch(function(e) {
      var errDiv = document.getElementById('post-review-error');
      if (errDiv) { errDiv.style.display = 'block'; errDiv.textContent = 'Error: ' + e.message; }
    });
}

function closePostReviewPopup() {
  var overlay = document.getElementById('post-review-overlay');
  if (overlay) overlay.remove();
  window._prvDraftTr = null;
  window._prvLines = null;
  window._prvMeta = null;
}

function openPostReviewForSavedDraft(parentTr) {
  if (!parentTr || parentTr.dataset.status !== 'draft') return;
  parentTr.dataset.draft = 'true';
  openPostReviewPopup(parentTr);
}

function registerBillKeyActions() {
  window.fbKeyActions = {
    'new': function() { /* a/o key handled by kbd._handle */ },
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

function renderPage() {
  cursor.clear();
  var rows = filteredBills;

  if (!rows.length) {
    showMsg('No bills found.');
    document.getElementById('pagination-row').style.display = 'none';
    return;
  }

  var html = '';
  rows.forEach(function(b) {
    var due = b.due_date ? String(b.due_date).slice(0,10) : null;
    var active = b.status === 'posted' || b.status === 'partial';
    var isOverdue = active && due && due < today;
    var dueCls = isOverdue ? ' class="overdue-date"' : '';
    var rowUrl = '/' + COMPANY + '/bill/' + b.bill_id;
    html += '<tr data-row-type="parent" data-bill-id="' + esc(String(b.bill_id)) + '" data-vendor="' + esc(b.vendor||'') + '" data-date="' + esc(b.date||'') + '" data-due-date="' + esc(due || '') + '" data-vendor-ref="' + esc(b.vendor_ref || '') + '" data-amount="' + String(b.amount || 0) + '" data-currency="' + esc(b.currency || BASE_CURRENCY) + '" data-status="' + esc(b.status || '') + '" style="cursor:pointer">'
      + '<td>' + vendorCell(b.vendor) + '</td>'
      + '<td style="white-space:nowrap">' + fmtDate(b.date) + '</td>'
      + '<td style="white-space:nowrap"><span' + dueCls + '>' + fmtDate(due) + '</span></td>'
      + '<td><a href="' + rowUrl + '" class="ref-link" onclick="event.stopPropagation()">' + esc(b.vendor_ref || '') + '</a></td>'
      + '<td style="text-align:right;font-variant-numeric:tabular-nums">' + Number(b.amount||0).toFixed(2) + '</td>'
      + '<td style="font-size:0.75rem;color:#666;text-align:center;width:50px">' + esc(b.currency || BASE_CURRENCY) + '</td>'
      + '<td>' + (b.status === 'draft' ? '<span onclick="openPostReviewForSavedDraft(this.parentElement.parentElement)" style="cursor:pointer">' + statusBadge(b.status, due) + '</span>' : statusBadge(b.status, due)) + '</td>'
      + '</tr>';
  });
  var tbody = document.getElementById('bills-tbody');
  if (!tbody) return;
  tbody.innerHTML = html;
  document.getElementById('pagination-row').style.display = 'none';
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
  if (!name) return '<span style="color:#aaa">\\u2014</span>';
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
  if (!d) return '\\u2014';
  var s = String(d).slice(0,10);
  var parts = s.split('-');
  if (parts.length !== 3) return s;
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return parts[2] + ' ' + months[parseInt(parts[1],10)-1] + ' ' + parts[0];
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

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ========== TAB SWITCHER ==========
function showPayTab(t) {
  window.fbBillNav = (t === 'bills');
  ['bills','vendors'].forEach(function(id) {
    document.getElementById('pay-panel-' + id).style.display = (id === t) ? '' : 'none';
    var tabEl = document.getElementById('pay-tab-' + id);
    if (tabEl) tabEl.classList.toggle('active', id === t);
  });
  if (t === 'vendors') { loadVendorTable(); loadVendorAccounts(); loadVendorCurrencies(); }
}
`;
}

module.exports = { billsTabJS };
