'use strict';

function vendorsTabJS() {
  return `
// ========== VENDOR STATE ==========
// Migrated onto fb-core (P1-3, 2026-07-22): mode lives in FB.mode, keys are an
// FB.keys binding table (which also generates the sidebar hints), and the
// interaction model is the Bills standard — row-level selection (j/k, sticky
// boundaries), i/Enter opens the WHOLE ROW for editing (all fields become
// inputs), Tab traverses (sticky at the ends), Esc saves (no cancel path;
// an empty new row discards), x deletes, ~ toggles active. h/l are NOT bound
// here — they fall through to common.js and switch tabs, same as Bills.
var vendorAccountsList = [];
var vendorCurrenciesList = [];
var allVendors = [];
var vendorSelRow = -1;
window.fbVendorSelRow = -1;   // read by common.js's j/k deferral
var vendorEditRow = -1;       // allVendors index currently in INSERT (-1 = none)
var _vendorSaving = false;    // re-entrant Esc guard while an upsert is in flight
var _vgPending = false, _vgTimer = null;

function loadVendors() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'vendor.list', companyId: COMPANY }) })
  .then(function(r){ return r.json(); })
  .then(function(res){
    var rows = res.data || res || [];
    allVendors = Array.isArray(rows) ? rows : [];
  })
  .catch(function(){});
  // also pre-load currencies for draft row CCY validation
  if (!vendorCurrenciesList.length) {
    fetch('/db/currencies.json').then(function(r){ return r.json(); }).then(function(list){
      vendorCurrenciesList = Array.isArray(list) ? list : [];
    }).catch(function(){});
  }
}

function loadVendorAccounts() {
  if (vendorAccountsList.length) return;
  fetch('/api/' + COMPANY + '/accounts').then(function(r){ return r.json(); }).then(function(rows){
    vendorAccountsList = Array.isArray(rows) ? rows : [];
  }).catch(function(){});
}

function loadVendorCurrencies() {
  if (vendorCurrenciesList.length) return;
  fetch('/db/currencies.json').then(function(r){ return r.json(); }).then(function(list){
    vendorCurrenciesList = Array.isArray(list) ? list : [];
  }).catch(function(){});
}

function loadVendorTable() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'vendor.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var rows = res.data || res;
      allVendors = Array.isArray(rows) ? rows : [];
      renderVendorTable();
      vendorSelRow = allVendors.length ? 0 : -1;
      updateVendorCursor();
    }).catch(function(e){ vendorMsg('Error loading vendors: ' + e.message, 'err'); });
}

function renderVendorTable() {
  var tbody = document.getElementById('vendors-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  // P2: ghost row pinned-top is the single create affordance (o focuses it,
  // mouse clicks into it). It is NOT part of allVendors — exists purely in DOM.
  tbody.appendChild(buildVendorGhostRow());
  if (!allVendors.length) {
    var emptyTr = document.createElement('tr');
    emptyTr.innerHTML = '<td colspan="6" style="text-align:center;color:#aaa;padding:24px">No vendors yet.</td>';
    tbody.appendChild(emptyTr);
    return;
  }
  allVendors.forEach(function(v, i) {
    tbody.appendChild(buildVendorDisplayRow(v, i));
  });
}

// Ghost row: persistent FADED display-only entry-row pinned under thead. It is
// not open to entry — i (while the cursor is on it) or a click transforms it
// into a real (unsaved) vendor row in INSERT at the top of the list.
function buildVendorGhostRow() {
  var tr = document.createElement('tr');
  tr.className = 'fb-ghost-row';
  tr.dataset.ghost = '1';
  tr.style.cursor = 'text';
  tr.innerHTML = '<td><span class="fb-ghost-ph">Vendor name</span></td>'
    + '<td style="text-align:center"><span class="fb-ghost-ph">CCY</span></td>'
    + '<td style="text-align:center"><span class="fb-ghost-ph">Terms</span></td>'
    + '<td><span class="fb-ghost-ph">Expense account</span></td>'
    + '<td><span class="fb-ghost-ph">AP account</span></td>'
    + '<td style="text-align:center"><span class="badge fb-ghost-badge">Active</span></td>';
  tr.addEventListener('click', function() { vendorAddNew(); });
  return tr;
}

function buildVendorDisplayRow(v, i) {
  var tr = document.createElement('tr');
  tr.dataset.vendorId = v.vendor_id || '';
  tr.dataset.idx      = String(i);
  tr.style.cursor = 'pointer';

  var activeBadge = v.is_active !== false
    ? '<span class="badge" style="background:#f0fff4;color:#2a8a2a">Active</span>'
    : '<span class="badge" style="background:#f0f0f0;color:#888">Inactive</span>';

  var cellContents = [
    vendorCell(v.name),
    esc(v.default_currency || '\\u2014'),
    (v.payment_terms_days || 30) + '\\u202fd',
    esc(v.default_expense_account || '\\u2014'),
    esc(v.default_ap_account || '\\u2014'),
    activeBadge
  ];
  var cellStyles = ['', 'text-align:center;color:#666', 'text-align:center;color:#444',
    '', '', 'text-align:center'];

  cellContents.forEach(function(content, col) {
    var td = document.createElement('td');
    td.dataset.col = String(col);
    td.className = 'vcell';
    td.innerHTML = content;
    if (cellStyles[col]) td.style.cssText = cellStyles[col];
    tr.appendChild(td);
  });
  // Mouse parity: click = select (click-away from an open edit saves first,
  // the mouse Esc equivalent); double-click = enter INSERT (badge: toggle).
  tr.addEventListener('click', function() {
    if (vendorEditRow >= 0 && vendorEditRow !== i) { if (!vendorSaveAndExit()) return; }
    vendorSelRow = i;
    updateVendorCursor();
  });
  tr.addEventListener('dblclick', function(e) {
    var td = e.target && e.target.closest ? e.target.closest('td') : null;
    vendorSelRow = i;
    updateVendorCursor();
    if (td && td.dataset.col === '5') { vendorToggleActive(); return; }
    enterVendorRowEdit(i);
  });
  return tr;
}

function updateVendorCursor() {
  window.fbVendorSelRow = vendorSelRow;
  document.querySelectorAll('#vendors-body tr.bill-row-focus').forEach(function(r){ r.classList.remove('bill-row-focus'); });
  // vendorSelRow === -1 means the cursor sits on the pinned ghost row.
  var tr = vendorSelRow < 0
    ? document.querySelector('#vendors-body tr.fb-ghost-row')
    : document.querySelector('#vendors-body tr[data-idx="' + vendorSelRow + '"]');
  if (!tr) return;
  tr.classList.add('bill-row-focus');
  var pm = document.getElementById('page-main');
  if (pm) {
    var rect = tr.getBoundingClientRect();
    var pmRect = pm.getBoundingClientRect();
    var pad = 8;
    if (rect.top < pmRect.top + pad) {
      pm.scrollBy({ top: rect.top - pmRect.top - pad, behavior: 'instant' });
    } else if (rect.bottom > pmRect.bottom - pad) {
      pm.scrollBy({ top: rect.bottom - pmRect.bottom + pad, behavior: 'instant' });
    }
  } else {
    tr.scrollIntoView({ block: 'nearest' });
  }
}

// ── Row-level INSERT (Bills model): all editable cells become inputs ───────
function enterVendorRowEdit(idx) {
  if (vendorEditRow === idx) return;
  if (vendorEditRow >= 0) { if (!vendorSaveAndExit()) return; }
  var v = allVendors[idx];
  if (!v) return;
  var tr = document.querySelector('#vendors-body tr[data-idx="' + idx + '"]');
  if (!tr) return;
  vendorEditRow = idx;
  vendorSelRow = idx;
  var vals = [v.name || '', v.default_currency || '', String(v.payment_terms_days != null ? v.payment_terms_days : 30),
    v.default_expense_account || '', v.default_ap_account || ''];
  var specs = [
    { cls: 'v-edit-name',    type: 'text',   ph: 'Vendor name' },
    { cls: 'v-edit-ccy',     type: 'text',   ph: '\\u2014', style: 'text-align:center;text-transform:uppercase', maxlength: 3 },
    { cls: 'v-edit-terms',   type: 'number', ph: 'e.g. 30', style: 'text-align:center' },
    { cls: 'v-edit-expense', type: 'text',   ph: '\\u2014' },
    { cls: 'v-edit-ap',      type: 'text',   ph: '\\u2014' }
  ];
  specs.forEach(function(s, col) {
    var td = tr.querySelector('td[data-col="' + col + '"]');
    if (!td) return;
    td.innerHTML = '';
    var input = document.createElement('input');
    input.className = 'draft-input ' + s.cls;
    input.type = s.type;
    if (s.style) input.style.cssText = s.style;
    if (s.maxlength) input.maxLength = s.maxlength;
    input.placeholder = s.ph;
    input.setAttribute('autocomplete', 'off');
    input.value = vals[col];
    if (col === 1) {
      // CCY dropdown (FB.dropdown): contains-match on code or name.
      loadVendorCurrencies();
      FB.dropdown.attach(input, {
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
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    }
    if (col === 3 || col === 4) {
      // Account dropdown (FB.dropdown): contains-match on code or name.
      loadVendorAccounts();
      FB.dropdown.attach(input, {
        source: function(q) {
          q = (q || '').trim().toLowerCase();
          return vendorAccountsList.filter(function(a) {
            if (!q) return true;
            return (a.account_code || '').toLowerCase().indexOf(q) >= 0 ||
                   (a.account_name || '').toLowerCase().indexOf(q) >= 0;
          }).map(function(a) {
            return { primary: a.account_code, secondary: a.account_name || '', data: { code: a.account_code } };
          });
        },
        onPick: function(item, inp) {
          inp.value = item.data.code;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    }
    td.appendChild(input);
  });
  FB.mode.set('INSERT');
  updateVendorCursor();
  var first = tr.querySelector('input.v-edit-name');
  if (first) { first.focus(); first.select(); }
}

// Esc / Enter / click-away: validate → upsert → back to display row.
// Returns false when validation failed (caller stays put, still INSERT).
// Async: the row stays in INSERT until the server answers; a second Esc
// during the flight is ignored (_vendorSaving).
function vendorSaveAndExit() {
  if (vendorEditRow < 0 || _vendorSaving) return true;
  var idx = vendorEditRow;
  var v = allVendors[idx];
  var tr = document.querySelector('#vendors-body tr[data-idx="' + idx + '"]');
  if (!v || !tr) { vendorEditRow = -1; FB.mode.set('NORMAL'); return true; }
  var nameInp  = tr.querySelector('input.v-edit-name');
  var ccyInp   = tr.querySelector('input.v-edit-ccy');
  var termsInp = tr.querySelector('input.v-edit-terms');
  var expInp   = tr.querySelector('input.v-edit-expense');
  var apInp    = tr.querySelector('input.v-edit-ap');
  var name = nameInp ? nameInp.value.trim() : '';
  // Empty NEW vendor row: discard (Bills empty-draft doctrine — Esc never
  // creates something from nothing).
  if (!v.vendor_id && !name) {
    allVendors.splice(idx, 1);
    vendorEditRow = -1;
    FB.mode.set('NORMAL');
    renderVendorTable();
    vendorSelRow = Math.min(idx, allVendors.length - 1);
    updateVendorCursor();
    return true;
  }
  if (!name) {
    vendorMsg('Vendor name required.', 'err');
    if (nameInp) { nameInp.classList.add('req'); nameInp.focus(); }
    return false;
  }
  var ccy = ccyInp ? ccyInp.value.trim().toUpperCase() : '';
  if (ccy && vendorCurrenciesList.length) {
    var valid = vendorCurrenciesList.some(function(c){ return (c.code || '').toUpperCase() === ccy; });
    if (!valid) {
      vendorMsg('Unknown currency: ' + ccy, 'err');
      if (ccyInp) { ccyInp.classList.add('req'); ccyInp.focus(); }
      return false;
    }
  }
  var vendor = {
    vendor_id: v.vendor_id || null,
    name: name,
    default_currency: ccy || null,
    payment_terms_days: parseInt(termsInp && termsInp.value, 10) || 30,
    default_expense_account: expInp ? (expInp.value.trim() || null) : null,
    default_ap_account: apInp ? (apInp.value.trim() || null) : null,
    is_active: v.is_active !== false
  };
  _vendorSaving = true;
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'vendor.upsert', companyId: COMPANY, vendor: vendor }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      _vendorSaving = false;
      var d = res.data || res;
      if (d.error || res.error) {
        vendorMsg((d.error && d.error.message) || d.error || res.error, 'err');
        return; // stay in INSERT; inputs untouched
      }
      if (d.vendorId && !vendor.vendor_id) vendor.vendor_id = d.vendorId;
      allVendors[idx] = vendor;
      vendorEditRow = -1;
      FB.mode.set('NORMAL');
      _renderVendorRowDisplay(idx);
      // Do NOT reset vendorSelRow here: a click-away save may have moved the
      // selection during the async flight — stomping it would yank the cursor
      // back to the just-saved row. updateVendorCursor re-applies the
      // highlight to the rebuilt row element (same idx) or the moved-to row.
      updateVendorCursor();
      vendorMsg('Saved.', 'ok');
      setTimeout(function(){ vendorMsg('', ''); }, 2000);
    })
    .catch(function(e){ _vendorSaving = false; vendorMsg(e.message, 'err'); });
  return true;
}

function _renderVendorRowDisplay(idx) {
  var old = document.querySelector('#vendors-body tr[data-idx="' + idx + '"]');
  if (!old) { renderVendorTable(); return; }
  old.parentNode.replaceChild(buildVendorDisplayRow(allVendors[idx], idx), old);
}

function vendorAddNew() {
  if (vendorEditRow >= 0) { if (!vendorSaveAndExit()) return; }
  // P2 pinned-top: new vendor enters at the head of the list (where the ghost
  // row sits), sorts into place on next reload. Creates count for topbar ranking.
  allVendors.unshift({ vendor_id: '', name: '', default_currency: '', payment_terms_days: 30,
    default_expense_account: '', default_ap_account: '', is_active: true });
  renderVendorTable();
  vendorSelRow = 0;
  updateVendorCursor();
  enterVendorRowEdit(0);
  if (window.FB && FB.track) FB.track.create('vendor');
}

function vendorToggleActive() {
  if (vendorEditRow >= 0) return; // NORMAL-mode verb only
  var v = allVendors[vendorSelRow];
  if (!v) return;
  if (!v.vendor_id) { vendorMsg('Save the vendor first before toggling.', 'err'); return; }
  var newActive = v.is_active === false;
  v.is_active = newActive;
  var vendor = { vendor_id: v.vendor_id, name: v.name, default_currency: v.default_currency,
    payment_terms_days: v.payment_terms_days, default_expense_account: v.default_expense_account,
    default_ap_account: v.default_ap_account, is_active: newActive };
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'vendor.upsert', companyId: COMPANY, vendor: vendor }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var d = res.data || res;
      if (d.error || res.error) { v.is_active = !newActive; vendorMsg((d.error && d.error.message) || d.error || res.error, 'err'); return; }
      _renderVendorRowDisplay(vendorSelRow);
      updateVendorCursor();
      vendorMsg(newActive ? 'Marked active.' : 'Marked inactive.', 'ok');
      setTimeout(function(){ vendorMsg('', ''); }, 1500);
    })
    .catch(function(e){ v.is_active = !newActive; vendorMsg(e.message, 'err'); });
}

function vendorDeleteSelected() {
  if (vendorEditRow >= 0) return; // NORMAL-mode verb only
  var v = allVendors[vendorSelRow];
  if (!v) return;
  if (!v.vendor_id) {
    allVendors.splice(vendorSelRow, 1);
    renderVendorTable();
    vendorSelRow = Math.min(vendorSelRow, allVendors.length - 1);
    updateVendorCursor(); return;
  }
  if (!confirm('Delete vendor "' + (v.name || v.vendor_id) + '"?')) return;
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'vendor.delete', companyId: COMPANY, vendorId: v.vendor_id }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var d = res.data || res;
      if (d.error || res.error) { vendorMsg((d.error && d.error.message) || d.error || res.error, 'err'); return; }
      allVendors.splice(vendorSelRow, 1);
      renderVendorTable();
      vendorSelRow = Math.min(vendorSelRow, allVendors.length - 1);
      updateVendorCursor();
      vendorMsg('Deleted.', 'ok');
      setTimeout(function(){ vendorMsg('', ''); }, 1500);
    })
    .catch(function(e){ vendorMsg(e.message, 'err'); });
}

function vendorMsg(msg, type) {
  var el = document.getElementById('msg-vendors');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'err' ? '#cc2222' : type === 'ok' ? '#2a8a2a' : '#888';
}

function registerVendorKeyActions() {
  function isVendorsTabActive() {
    var panel = document.getElementById('pay-panel-vendors');
    return !!panel && panel.style.display !== 'none';
  }
  var ddOpen = function() { return FB.dropdown.isOpen(); };
  var hasRows = function() { return allVendors.length > 0; };
  var _editTr = function() {
    return vendorEditRow >= 0 ? document.querySelector('#vendors-body tr[data-idx="' + vendorEditRow + '"]') : null;
  };
  var onLastInput = function() {
    var tr = _editTr();
    return !!(tr && document.activeElement === tr.querySelector('input.v-edit-ap'));
  };
  var onFirstInput = function() {
    var tr = _editTr();
    return !!(tr && document.activeElement === tr.querySelector('input.v-edit-name'));
  };
  // NOTE on order: FB.keys takes the FIRST binding whose key+mode+when match,
  // so dropdown-specific INSERT bindings precede the general ones.
  FB.keys.register('vendors', {
    active: isVendorsTabActive,
    getMode: function() { return FB.mode.get(); },
    bindings: [
      // ── NORMAL ──
      { key: 'j', mode: 'NORMAL', hint: 'navigate', hintBar: true, swallow: hasRows,
        run: function() {
          if (vendorSelRow < 0) vendorSelRow = 0; // ghost → first vendor
          else if (vendorSelRow < allVendors.length - 1) vendorSelRow++;
          updateVendorCursor();
        } },
      { key: 'k', mode: 'NORMAL', hint: 'navigate', hintBar: true, swallow: hasRows,
        run: function() {
          if (vendorSelRow >= 0) vendorSelRow--; // row 0 → ghost (-1)
          updateVendorCursor();
        } },
      { key: 'G', mode: 'NORMAL', swallow: hasRows,
        run: function() { if (allVendors.length) { vendorSelRow = allVendors.length - 1; updateVendorCursor(); } } },
      { key: 'g', mode: 'NORMAL', swallow: hasRows,
        run: function() {
          if (!_vgPending) {
            _vgPending = true;
            clearTimeout(_vgTimer);
            _vgTimer = setTimeout(function(){ _vgPending = false; }, 500);
            return;
          }
          _vgPending = false;
          clearTimeout(_vgTimer);
          vendorSelRow = -1; updateVendorCursor(); // gg → ghost row (top)
        } },
      { key: 'Enter', mode: 'NORMAL', hint: 'edit', hintBar: true,
        run: function() {
          if (vendorSelRow < 0) { vendorAddNew(); return; } // Enter on ghost = create
          enterVendorRowEdit(vendorSelRow);
        } },
      { key: 'i', mode: 'NORMAL', hint: 'edit', hintBar: true,
        run: function() {
          if (vendorSelRow < 0) { vendorAddNew(); return; } // i on ghost = create
          enterVendorRowEdit(vendorSelRow);
        } },
      { key: 'x', mode: 'NORMAL', hint: 'delete', hintBar: true, swallow: hasRows,
        run: function() { vendorDeleteSelected(); } },
      { key: '~', mode: 'NORMAL', hint: 'toggle active', hintBar: true, swallow: hasRows,
        run: function() { vendorToggleActive(); } },
      // ── INSERT: autocomplete dropdown open ──
      { key: 'ArrowDown', mode: 'INSERT', when: ddOpen,
        run: function() { FB.dropdown.move(1); } },
      { key: 'ArrowUp', mode: 'INSERT', when: ddOpen,
        run: function() { FB.dropdown.move(-1); } },
      { key: 'Enter', mode: 'INSERT', when: ddOpen,
        run: function() { FB.dropdown.pick(); } },
      // Tab = pick-and-advance: pick the active item, then let native Tab
      // traversal continue — except at the sticky ends (last/first input),
      // where traversal stays blocked.
      { key: 'Tab', mode: 'INSERT', when: ddOpen, swallow: false, preventDefault: false,
        run: function(e) { FB.dropdown.pick(); if (e.shiftKey ? onFirstInput() : onLastInput()) e.preventDefault(); } },
      { key: 'Escape', mode: 'INSERT', when: ddOpen,
        run: function() { FB.dropdown.close(); } },
      // ── INSERT: dropdown closed — ArrowDown on a dropdown field opens the full list ──
      { key: 'ArrowDown', mode: 'INSERT', when: function(e) { return !ddOpen() && FB.dropdown.attachable(e.target); },
        run: function(e) { FB.dropdown.openFull(e.target); } },
      // ── INSERT: general ──
      { key: 'Escape', mode: 'INSERT', hint: 'save', hintBar: true,
        run: function() { vendorSaveAndExit(); } },
      { key: 'Enter', mode: 'INSERT',
        run: function() { vendorSaveAndExit(); } },
      // Tab: sticky at the ends (last input Tab / first input Shift+Tab stay
      // put — no accidental focus escape); native traversal between inputs.
      { key: 'Tab', mode: 'INSERT', when: function(e) { return !e.shiftKey && onLastInput(); },
        run: function() {} },
      { key: 'Tab', mode: 'INSERT', when: function(e) { return e.shiftKey && onFirstInput(); },
        run: function() {} },
      { key: 'Tab', mode: 'INSERT', swallow: false, preventDefault: false,
        run: function() {} }
    ]
  });
  // Hover suppression while a row is being edited (matches bills tbody).
  FB.mode.onChange(function(m) {
    var tb = document.getElementById('vendors-body');
    if (tb) tb.classList.toggle('insert-mode', m === 'INSERT' && vendorEditRow >= 0);
  });
}

`;
}

module.exports = { vendorsTabJS };
