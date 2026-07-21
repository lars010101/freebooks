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
var vendorAcctActiveInput = null;
var vendorCcyActiveInput = null;
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
  if (!allVendors.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#aaa;padding:32px">No vendors yet. Press <b>a</b> to add one.</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  allVendors.forEach(function(v, i) {
    tbody.appendChild(buildVendorDisplayRow(v, i));
  });
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
  if (vendorSelRow < 0) return;
  var tr = document.querySelector('#vendors-body tr[data-idx="' + vendorSelRow + '"]');
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
      input.oninput = function(){ vendorCcyActiveInput = input; payVendorCcyInput(input); };
      input.onblur  = function(){ hidePayVendorCcyDd(); };
    }
    if (col === 3 || col === 4) {
      input.oninput = function(){ vendorAcctActiveInput = input; payVendorAcctInput(input); };
      input.onblur  = function(){ hidePayVendorAcctDd(); };
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
  allVendors.push({ vendor_id: '', name: '', default_currency: '', payment_terms_days: 30,
    default_expense_account: '', default_ap_account: '', is_active: true });
  renderVendorTable();
  vendorSelRow = allVendors.length - 1;
  updateVendorCursor();
  var tbody = document.getElementById('vendors-body');
  if (tbody && tbody.lastElementChild) tbody.lastElementChild.scrollIntoView({ block: 'nearest' });
  enterVendorRowEdit(vendorSelRow);
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
  var ddOpen = function() {
    return !!(document.getElementById('pay-vendor-acct-dd') || document.getElementById('pay-vendor-ccy-dd'));
  };
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
          if (vendorSelRow < 0) vendorSelRow = 0;
          else if (vendorSelRow < allVendors.length - 1) vendorSelRow++;
          updateVendorCursor();
        } },
      { key: 'k', mode: 'NORMAL', hint: 'navigate', hintBar: true, swallow: hasRows,
        run: function() {
          if (vendorSelRow > 0) vendorSelRow--;
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
          if (allVendors.length) { vendorSelRow = 0; updateVendorCursor(); }
        } },
      { key: 'Enter', mode: 'NORMAL', hint: 'edit', hintBar: true, swallow: hasRows,
        run: function() { if (vendorSelRow >= 0) enterVendorRowEdit(vendorSelRow); } },
      { key: 'i', mode: 'NORMAL', hint: 'edit', hintBar: true, swallow: hasRows,
        run: function() { if (vendorSelRow >= 0) enterVendorRowEdit(vendorSelRow); } },
      { key: 'a', mode: 'NORMAL', hint: 'add', hintBar: true,
        run: function() { vendorAddNew(); } },
      { key: 'x', mode: 'NORMAL', hint: 'delete', hintBar: true, swallow: hasRows,
        run: function() { vendorDeleteSelected(); } },
      { key: '~', mode: 'NORMAL', hint: 'toggle active', hintBar: true, swallow: hasRows,
        run: function() { vendorToggleActive(); } },
      // ── INSERT: autocomplete dropdown open ──
      { key: 'ArrowDown', mode: 'INSERT', when: ddOpen,
        run: function() {
          if (document.getElementById('pay-vendor-acct-dd')) moveVendorAcctDd(1); else moveVendorCcyDd(1);
        } },
      { key: 'ArrowUp', mode: 'INSERT', when: ddOpen,
        run: function() {
          if (document.getElementById('pay-vendor-acct-dd')) moveVendorAcctDd(-1); else moveVendorCcyDd(-1);
        } },
      { key: 'Enter', mode: 'INSERT', when: ddOpen,
        run: function() {
          if (document.getElementById('pay-vendor-acct-dd')) selectVendorAcctDdItem(); else selectVendorCcyDdItem();
        } },
      { key: 'Tab', mode: 'INSERT', when: ddOpen,
        run: function() {
          if (document.getElementById('pay-vendor-acct-dd')) selectVendorAcctDdItem(); else selectVendorCcyDdItem();
        } },
      { key: 'Escape', mode: 'INSERT', when: ddOpen,
        run: function() {
          var d1 = document.getElementById('pay-vendor-acct-dd'); if (d1) d1.remove();
          var d2 = document.getElementById('pay-vendor-ccy-dd'); if (d2) d2.remove();
          vendorAcctActiveInput = null;
        } },
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

// ========== DRAFT VENDOR DROPDOWN (shared with bills tab) ==========
function draftVendorInput(input) {
  var q = input.value.trim().toLowerCase();
  var dd = document.getElementById('pay-draft-vendor-dd');
  if (dd) dd.remove();
  if (!q) return;
  var matches = allVendors.filter(function(v) {
    return (v.name || '').toLowerCase().includes(q);
  }).slice(0, 12);
  if (!matches.length) return;
  var div = document.createElement('div');
  div.id = 'pay-draft-vendor-dd';
  div.style.cssText = 'position:fixed;background:#fff;border:1px solid #ccc;z-index:9999;max-height:200px;overflow-y:auto;font-size:0.8125rem;box-shadow:0 2px 6px rgba(0,0,0,.2)';
  matches.forEach(function(v, i) {
    var item = document.createElement('div');
    item.dataset.vendorId = v.vendor_id || '';
    item.dataset.idx = String(i);
    item.textContent = v.name || '';
    item.style.cssText = 'padding:8px 12px;cursor:pointer;white-space:nowrap';
    item.onmouseover = function() { clearDraftVendorDdFocus(); item.classList.add('dd-active'); item.style.background = '#e8f0fe'; };
    item.onmouseout = function() { item.classList.remove('dd-active'); item.style.background = ''; };
    item.onmousedown = function(e) { e.preventDefault(); };
    item.onclick = function() {
      input.dataset.vendorId = v.vendor_id || '';
      input.dataset.vendorName = v.name || '';
      input.dataset.apAccount = v.default_ap_account || companyDefaultAp || '';
      input.dataset.expenseAccount = v.default_expense_account || companyDefaultExpense || '';
      input.value = v.name || '';
      var tr = input.closest('tr');
      if (tr) {
        var ccyInputs = tr.querySelectorAll('input');
        if (ccyInputs[4]) ccyInputs[4].value = (v.default_currency || BASE_CURRENCY).toUpperCase();
      }
      var dd2 = document.getElementById('pay-draft-vendor-dd');
      if (dd2) dd2.remove();
    };
    div.appendChild(item);
  });
  var rect = input.getBoundingClientRect();
  div.style.left = rect.left + 'px';
  div.style.top = (rect.bottom + 2) + 'px';
  div.style.minWidth = rect.width + 'px';
  document.body.appendChild(div);
}

function moveDraftVendorDd(dir) {
  var dd = document.getElementById('pay-draft-vendor-dd');
  if (!dd) return;
  var items = Array.from(dd.querySelectorAll('div[data-vendor-id]'));
  var cur = dd.querySelector('.dd-active');
  var curIdx = cur ? parseInt(cur.dataset.idx) : -1;
  var nextIdx = Math.max(0, Math.min(items.length - 1, curIdx + dir));
  items.forEach(function(el) { el.classList.remove('dd-active'); el.style.background = ''; });
  var next = items[nextIdx];
  if (next) { next.classList.add('dd-active'); next.style.background = '#e8f0fe'; next.scrollIntoView({ block: 'nearest' }); }
}

function clearDraftVendorDdFocus() {
  var dd = document.getElementById('pay-draft-vendor-dd');
  if (!dd) return;
  dd.querySelectorAll('.dd-active').forEach(function(el) { el.classList.remove('dd-active'); el.style.background = ''; });
}

function draftCcyInput(input) {
  var q = input.value.trim().toUpperCase();
  var dd = document.getElementById('pay-draft-ccy-dd');
  if (dd) dd.remove();
  if (!q || !vendorCurrenciesList.length) return;
  var matches = vendorCurrenciesList.filter(function(c){
    var code = (c.code || '').toUpperCase();
    return code.startsWith(q) || (c.name || '').toLowerCase().includes(q.toLowerCase());
  }).slice(0, 10);
  if (!matches.length) return;
  var div = document.createElement('div');
  div.id = 'pay-draft-ccy-dd';
  div.style.cssText = 'position:fixed;background:#fff;border:1px solid #ccc;z-index:9999;max-height:200px;overflow-y:auto;font-size:0.8125rem;box-shadow:0 2px 6px rgba(0,0,0,.2)';
  matches.forEach(function(c) {
    var item = document.createElement('div');
    item.textContent = (c.code || '').toUpperCase() + ' \\u2014 ' + (c.name || '');
    item.style.cssText = 'padding:8px 12px;cursor:pointer;white-space:nowrap';
    item.onmouseover = function() { item.style.background = '#e8f0fe'; };
    item.onmouseout  = function() { item.style.background = ''; };
    item.onmousedown = function(e) { e.preventDefault(); };
    item.onclick = function() {
      input.value = (c.code || '').toUpperCase();
      input.classList.remove('req');
      var dd2 = document.getElementById('pay-draft-ccy-dd');
      if (dd2) dd2.remove();
    };
    div.appendChild(item);
  });
  var rect = input.getBoundingClientRect();
  div.style.left = rect.left + 'px';
  div.style.top = (rect.bottom + 2) + 'px';
  div.style.minWidth = '160px';
  document.body.appendChild(div);
}

function moveDraftCcyDd(dir) {
  var dd = document.getElementById('pay-draft-ccy-dd');
  if (!dd) return;
  var items = Array.from(dd.querySelectorAll('div'));
  var cur = dd.querySelector('.dd-active');
  var curIdx = items.indexOf(cur);
  var nextIdx = Math.max(0, Math.min(items.length - 1, (curIdx < 0 ? (dir > 0 ? 0 : items.length - 1) : curIdx + dir)));
  items.forEach(function(el) { el.classList.remove('dd-active'); el.style.background = ''; });
  var next = items[nextIdx];
  if (next) { next.classList.add('dd-active'); next.style.background = '#e8f0fe'; next.scrollIntoView({ block: 'nearest' }); }
}

// ── Currency autocomplete (vendor tab) ───────────────────────────────
function payVendorCcyInput(input) {
  loadVendorCurrencies();
  vendorCcyActiveInput = input;
  var q = input.value.trim().toUpperCase();
  var dd = document.getElementById('pay-vendor-ccy-dd');
  if (dd) dd.remove();
  if (!q) return;
  var matches = vendorCurrenciesList.filter(function(c){
    return (c.code||'').toUpperCase().startsWith(q) || (c.name||'').toUpperCase().includes(q);
  }).slice(0, 10);
  if (!matches.length) return;
  var div = document.createElement('div');
  div.id = 'pay-vendor-ccy-dd';
  div.style.cssText = 'position:fixed;background:#fff;border:1px solid #ccc;z-index:9999;max-height:220px;overflow-y:auto;font-size:11px;box-shadow:0 2px 6px rgba(0,0,0,.2);min-width:200px';
  matches.forEach(function(c, i){
    var item = document.createElement('div');
    item.dataset.ccyCode = c.code;
    item.dataset.idx = String(i);
    item.textContent = c.code + '  \\u2014  ' + (c.name || '');
    item.style.cssText = 'padding:6px 10px;cursor:pointer;white-space:nowrap';
    item.onmouseover = function(){ clearVendorCcyDdFocus(); item.classList.add('dd-active'); item.style.background='#e8f0fe'; };
    item.onmouseout  = function(){ item.classList.remove('dd-active'); item.style.background=''; };
    item.onmousedown = function(e){ e.preventDefault(); };
    item.onclick = function(){
      input.value = c.code;
      var dd2 = document.getElementById('pay-vendor-ccy-dd');
      if (dd2) dd2.remove();
    };
    div.appendChild(item);
  });
  var rect = input.getBoundingClientRect();
  div.style.left = rect.left + 'px';
  div.style.top  = (rect.bottom + 2) + 'px';
  document.body.appendChild(div);
}

function clearVendorCcyDdFocus() {
  var dd = document.getElementById('pay-vendor-ccy-dd');
  if (!dd) return;
  dd.querySelectorAll('.dd-active').forEach(function(el){ el.classList.remove('dd-active'); el.style.background=''; });
}

function moveVendorCcyDd(dir) {
  var dd = document.getElementById('pay-vendor-ccy-dd');
  if (!dd) return;
  var items = dd.querySelectorAll('[data-ccy-code]');
  if (!items.length) return;
  var cur = dd.querySelector('.dd-active');
  var curIdx = cur ? parseInt(cur.dataset.idx) : -1;
  var nextIdx = Math.max(0, Math.min(items.length - 1, curIdx + dir));
  clearVendorCcyDdFocus();
  var next = items[nextIdx];
  next.classList.add('dd-active'); next.style.background = '#e8f0fe';
  next.scrollIntoView({ block: 'nearest' });
}

function selectVendorCcyDdItem() {
  var dd = document.getElementById('pay-vendor-ccy-dd');
  if (!dd) return false;
  var cur = dd.querySelector('.dd-active') || dd.querySelector('[data-ccy-code]');
  if (!cur) return false;
  if (vendorCcyActiveInput) vendorCcyActiveInput.value = cur.dataset.ccyCode;
  dd.remove();
  vendorCcyActiveInput = null;
  return true;
}

function hidePayVendorCcyDd() {
  setTimeout(function(){ var dd = document.getElementById('pay-vendor-ccy-dd'); if (dd) dd.remove(); }, 150);
}

// ── Account autocomplete (vendor tab) ───────────────────────────────
function clearVendorAcctDdFocus() {
  var dd = document.getElementById('pay-vendor-acct-dd');
  if (!dd) return;
  dd.querySelectorAll('.dd-active').forEach(function(el){ el.classList.remove('dd-active'); el.style.background=''; });
}

function moveVendorAcctDd(dir) {
  var dd = document.getElementById('pay-vendor-acct-dd');
  if (!dd) return;
  var items = dd.querySelectorAll('[data-acct-code]');
  if (!items.length) return;
  var cur = dd.querySelector('.dd-active');
  var curIdx = cur ? parseInt(cur.dataset.idx) : -1;
  var nextIdx = Math.max(0, Math.min(items.length - 1, curIdx + dir));
  clearVendorAcctDdFocus();
  var next = items[nextIdx];
  next.classList.add('dd-active'); next.style.background = '#e8f0fe';
  next.scrollIntoView({ block: 'nearest' });
}

function selectVendorAcctDdItem() {
  var dd = document.getElementById('pay-vendor-acct-dd');
  if (!dd) return false;
  var cur = dd.querySelector('.dd-active') || dd.querySelector('[data-acct-code]');
  if (!cur) return false;
  if (vendorAcctActiveInput) {
    vendorAcctActiveInput.value = cur.dataset.acctCode;
    vendorAcctActiveInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
  dd.remove(); vendorAcctActiveInput = null;
  return true;
}

function payVendorAcctInput(input) {
  loadVendorAccounts();
  vendorAcctActiveInput = input;
  var q = input.value.trim().toLowerCase();
  var dd = document.getElementById('pay-vendor-acct-dd');
  if (dd) dd.remove();
  if (!q) return;
  var matches = vendorAccountsList.filter(function(a){
    return (a.account_code||'').toLowerCase().includes(q) || (a.account_name||'').toLowerCase().includes(q);
  }).slice(0, 12);
  if (!matches.length) return;
  var div = document.createElement('div');
  div.id = 'pay-vendor-acct-dd';
  div.style.cssText = 'position:fixed;background:#fff;border:1px solid #ccc;z-index:9999;max-height:200px;overflow-y:auto;font-size:11px;box-shadow:0 2px 6px rgba(0,0,0,.2)';
  matches.forEach(function(a, mi){
    var item = document.createElement('div');
    item.dataset.acctCode = a.account_code;
    item.dataset.idx = String(mi);
    item.textContent = a.account_code + ' \\u2014 ' + a.account_name;
    item.style.cssText = 'padding:6px 10px;cursor:pointer;white-space:nowrap;font-size:11px';
    item.onmouseover = function(){ clearVendorAcctDdFocus(); item.classList.add('dd-active'); item.style.background='#e8f0fe'; };
    item.onmouseout  = function(){ item.classList.remove('dd-active'); item.style.background=''; };
    item.onmousedown = function(e){ e.preventDefault(); };
    item.onclick = function(){
      if (vendorAcctActiveInput) {
        vendorAcctActiveInput.value = a.account_code;
        vendorAcctActiveInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      var d = document.getElementById('pay-vendor-acct-dd');
      if (d) d.remove();
      vendorAcctActiveInput = null;
    };
    div.appendChild(item);
  });
  var rect = input.getBoundingClientRect();
  div.style.left = rect.left + 'px';
  div.style.top  = (rect.bottom + 2) + 'px';
  div.style.minWidth = rect.width + 'px';
  document.body.appendChild(div);
}

function hidePayVendorAcctDd() {
  setTimeout(function(){ var dd = document.getElementById('pay-vendor-acct-dd'); if (dd) dd.remove(); }, 150);
}
`;
}

module.exports = { vendorsTabJS };
