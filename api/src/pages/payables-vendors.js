'use strict';

function vendorsTabJS() {
  return `
// ========== VENDOR STATE ==========
var vendorAccountsList = [];
var vendorAcctActiveInput = null;
var vendorCurrenciesList = [];
var allVendors = [];
var vendorSelRow = -1;
window.fbVendorSelRow = -1;
var vendorSelCol = 0;
var vendorCellEdit = false;
var vendorCellPreEdit = null;
var vendorDirtyRows = {};
var VENDOR_COL_EDIT_MAX = 4; // cols 0-4 editable; col 5 (Active) = toggle only

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
      vendorDirtyRows = {};
      renderVendorTable();
      vendorSelRow = allVendors.length ? 0 : -1;
      vendorSelCol = 0;
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
    td.addEventListener('click', function() {
      if (vendorCellEdit && (vendorSelRow !== i || vendorSelCol !== col)) commitVendorCell(true);
      vendorSelRow = i; vendorSelCol = col;
      updateVendorCursor();
    });
    td.addEventListener('dblclick', function() {
      vendorSelRow = i; vendorSelCol = col;
      updateVendorCursor();
      if (col === 5) { vendorToggleActive(); return; }
      if (!vendorCellEdit) enterVendorCellEdit();
    });
    tr.appendChild(td);
  });
  return tr;
}

function updateVendorCursor() {
  window.fbVendorSelRow = vendorSelRow;
  document.querySelectorAll('#vendors-body tr.vrow-selected').forEach(function(r){ r.classList.remove('vrow-selected'); });
  document.querySelectorAll('#vendors-body td.vcell-selected').forEach(function(td){ td.classList.remove('vcell-selected'); });
  document.querySelectorAll('tr.nav-row-focus').forEach(function(r){ r.classList.remove('nav-row-focus'); });
  if (vendorSelRow < 0) return;
  var tr = document.querySelector('#vendors-body tr[data-idx="' + vendorSelRow + '"]');
  if (!tr) return;
  tr.classList.add('vrow-selected');
  var td = tr.querySelector('td[data-col="' + vendorSelCol + '"]');
  if (td) td.classList.add('vcell-selected');
  tr.scrollIntoView({ block: 'nearest' });
}

function getSelectedTd() {
  if (vendorSelRow < 0) return null;
  var tr = document.querySelector('#vendors-body tr[data-idx="' + vendorSelRow + '"]');
  if (!tr) return null;
  return tr.querySelector('td[data-col="' + vendorSelCol + '"]');
}

function enterVendorCellEdit() {
  if (vendorCellEdit) return;
  if (vendorSelRow < 0 || vendorSelCol > VENDOR_COL_EDIT_MAX) return;
  var td = getSelectedTd();
  if (!td) return;
  var v = allVendors[vendorSelRow];
  if (!v) return;
  vendorCellEdit = true;
  td.classList.add('vcell-editing');
  var colVals = [v.name || '', v.default_currency || '', String(v.payment_terms_days || 30),
    v.default_expense_account || '', v.default_ap_account || ''];
  vendorCellPreEdit = colVals[vendorSelCol];
  var input = document.createElement('input');
  if (vendorSelCol === 2) {
    input.type = 'number'; input.min = 0;
    input.style.cssText = 'width:60px;text-align:center;font-family:inherit;font-size:inherit';
  } else {
    input.type = 'text';
    if (vendorSelCol === 0) input.style.cssText = 'width:100%;min-width:160px;font-family:inherit;font-size:inherit';
    if (vendorSelCol === 1) { input.maxLength = 3; input.style.cssText = 'width:48px;text-align:center;text-transform:uppercase;font-family:inherit;font-size:inherit'; }
    if (vendorSelCol === 3 || vendorSelCol === 4) input.style.cssText = 'width:110px;font-family:inherit;font-size:inherit';
  }
  input.setAttribute('autocomplete', 'off');
  input.value = colVals[vendorSelCol];
  if (vendorSelCol === 1) {
    input.oninput = function(){ payVendorCcyInput(input); };
    input.onblur  = function(){ hidePayVendorCcyDd(); };
  }
  if (vendorSelCol === 3 || vendorSelCol === 4) {
    input.oninput = function(){ vendorAcctActiveInput = input; payVendorAcctInput(input); };
    input.onblur  = function(){ hidePayVendorAcctDd(); };
  }
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  input.select();
}

function commitVendorCell(save) {
  if (!vendorCellEdit) return;
  vendorCellEdit = false;
  var td = getSelectedTd();
  if (!td) return;
  td.classList.remove('vcell-editing');
  var dd1 = document.getElementById('pay-vendor-acct-dd'); if (dd1) dd1.remove();
  var dd2 = document.getElementById('pay-vendor-ccy-dd');  if (dd2) dd2.remove();
  var input = td.querySelector('input');
  var newVal = input ? input.value.trim() : vendorCellPreEdit;
  if (!save) { newVal = vendorCellPreEdit; }
  else {
    if (vendorSelCol === 1 && newVal && vendorCurrenciesList.length) {
      var ccyUp = newVal.toUpperCase();
      var valid = vendorCurrenciesList.some(function(c){ return (c.code||'').toUpperCase() === ccyUp; });
      if (!valid) { vendorMsg('Unknown currency: ' + ccyUp, 'err'); newVal = vendorCellPreEdit; save = false; }
    }
    if (save) {
      var v = allVendors[vendorSelRow];
      if (v) {
        if (vendorSelCol === 0) v.name = newVal;
        else if (vendorSelCol === 1) v.default_currency = newVal.toUpperCase() || null;
        else if (vendorSelCol === 2) v.payment_terms_days = parseInt(newVal) || 30;
        else if (vendorSelCol === 3) v.default_expense_account = newVal || null;
        else if (vendorSelCol === 4) v.default_ap_account = newVal || null;
        vendorDirtyRows[vendorSelRow] = true;
      }
    }
  }
  renderVendorCell(td, vendorSelCol, allVendors[vendorSelRow] || {});
  td.classList.add('vcell-selected');
}

function renderVendorCell(td, col, v) {
  if (col === 0) { td.innerHTML = vendorCell(v.name || ''); td.style.cssText = ''; }
  else if (col === 1) { td.textContent = v.default_currency || '\\u2014'; td.style.cssText = 'text-align:center;color:#666'; }
  else if (col === 2) { td.textContent = (v.payment_terms_days || 30) + '\\u202fd'; td.style.cssText = 'text-align:center;color:#444'; }
  else if (col === 3) { td.textContent = v.default_expense_account || '\\u2014'; td.style.cssText = ''; }
  else if (col === 4) { td.textContent = v.default_ap_account || '\\u2014'; td.style.cssText = ''; }
  else if (col === 5) {
    td.innerHTML = v.is_active !== false
      ? '<span class="badge" style="background:#f0fff4;color:#2a8a2a">Active</span>'
      : '<span class="badge" style="background:#f0f0f0;color:#888">Inactive</span>';
    td.style.cssText = 'text-align:center';
  }
}

function saveVendorRowIfDirty(rowIdx) {
  if (!vendorDirtyRows[rowIdx]) return;
  var v = allVendors[rowIdx];
  if (!v) return;
  if (!v.name) { vendorMsg('Vendor name required.', 'err'); return; }
  delete vendorDirtyRows[rowIdx];
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'vendor.upsert', companyId: COMPANY, vendor: {
      vendor_id: v.vendor_id || null, name: v.name,
      default_currency: v.default_currency || null,
      payment_terms_days: v.payment_terms_days || 30,
      default_expense_account: v.default_expense_account || null,
      default_ap_account: v.default_ap_account || null,
      is_active: v.is_active !== false
    }}) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var d = res.data || res;
      if (d.error || res.error) { vendorMsg(d.error || res.error, 'err'); vendorDirtyRows[rowIdx] = true; return; }
      if (d.vendorId && !v.vendor_id) {
        allVendors[rowIdx].vendor_id = d.vendorId;
        var tr = document.querySelector('#vendors-body tr[data-idx="' + rowIdx + '"]');
        if (tr) tr.dataset.vendorId = d.vendorId;
      }
      vendorMsg('Saved.', 'ok');
      setTimeout(function(){ vendorMsg('', ''); }, 2000);
    })
    .catch(function(e){ vendorMsg(e.message, 'err'); vendorDirtyRows[rowIdx] = true; });
}

function vendorMoveRow(dir) {
  if (vendorCellEdit) commitVendorCell(true);
  if (dir < 0) {
    if (vendorSelRow < 0) return;
    if (vendorSelRow === 0) { saveVendorRowIfDirty(0); vendorSelRow = -1; window.fbVendorSelRow = -1; updateVendorCursor(); return; }
  } else {
    if (vendorSelRow < 0) { vendorSelRow = 0; updateVendorCursor(); return; }
    if (vendorSelRow === allVendors.length - 1) { saveVendorRowIfDirty(vendorSelRow); vendorSelRow = -1; window.fbVendorSelRow = -1; updateVendorCursor(); return; }
  }
  saveVendorRowIfDirty(vendorSelRow);
  vendorSelRow = Math.max(0, Math.min(allVendors.length - 1, vendorSelRow + dir));
  updateVendorCursor();
}

function vendorMoveCol(dir) {
  if (vendorCellEdit) commitVendorCell(true);
  vendorSelCol = Math.max(0, Math.min(5, vendorSelCol + dir));
  updateVendorCursor();
}

function vendorAddNew() {
  if (vendorCellEdit) commitVendorCell(true);
  saveVendorRowIfDirty(vendorSelRow);
  allVendors.push({ vendor_id: '', name: '', default_currency: '', payment_terms_days: 30,
    default_expense_account: '', default_ap_account: '', is_active: true });
  renderVendorTable();
  vendorSelRow = allVendors.length - 1;
  vendorSelCol = 0;
  updateVendorCursor();
  var tbody = document.getElementById('vendors-body');
  if (tbody && tbody.lastElementChild) tbody.lastElementChild.scrollIntoView({ block: 'nearest' });
  enterVendorCellEdit();
}

function vendorToggleActive() {
  if (vendorCellEdit) commitVendorCell(true);
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
      if (d.error || res.error) { v.is_active = !newActive; vendorMsg(d.error || res.error, 'err'); return; }
      var tr = document.querySelector('#vendors-body tr[data-idx="' + vendorSelRow + '"]');
      var activeTd = tr && tr.querySelector('td[data-col="5"]');
      if (activeTd) renderVendorCell(activeTd, 5, v);
      vendorMsg(newActive ? 'Marked active.' : 'Marked inactive.', 'ok');
      setTimeout(function(){ vendorMsg('', ''); }, 1500);
    })
    .catch(function(e){ v.is_active = !newActive; vendorMsg(e.message, 'err'); });
}

function vendorDeleteSelected() {
  if (vendorCellEdit) commitVendorCell(false);
  var v = allVendors[vendorSelRow];
  if (!v) return;
  if (!v.vendor_id) {
    allVendors.splice(vendorSelRow, 1);
    delete vendorDirtyRows[vendorSelRow];
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
      if (d.error || res.error) { vendorMsg(d.error || res.error, 'err'); return; }
      allVendors.splice(vendorSelRow, 1);
      delete vendorDirtyRows[vendorSelRow];
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
  var VENDOR_KEYS = ['j','k','i','a','d','~','Enter','Escape','Tab','ArrowDown','ArrowUp'];
  document.addEventListener('keydown', function(e) {
    var panel = document.getElementById('pay-panel-vendors');
    if (!panel || panel.style.display === 'none') return;
    // Capture phase: stop common.js tab-switch handler from also consuming these keys
    if (VENDOR_KEYS.indexOf(e.key) !== -1 && (vendorCellEdit || vendorSelRow >= 0)) {
      e.stopImmediatePropagation();
    }

    if (vendorCellEdit) {
      var acctDd = document.getElementById('pay-vendor-acct-dd');
      var ccyDd  = document.getElementById('pay-vendor-ccy-dd');
      if (acctDd) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveVendorAcctDd(1); return; }
        if (e.key === 'ArrowUp')   { e.preventDefault(); moveVendorAcctDd(-1); return; }
        if (e.key === 'Enter')     { e.preventDefault(); selectVendorAcctDdItem(); return; }
        if (e.key === 'Escape')    { e.preventDefault(); acctDd.remove(); vendorAcctActiveInput = null; return; }
        if (e.key === 'Tab')       { if (selectVendorAcctDdItem()) e.preventDefault(); return; }
        return;
      }
      if (ccyDd) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveVendorCcyDd(1); return; }
        if (e.key === 'ArrowUp')   { e.preventDefault(); moveVendorCcyDd(-1); return; }
        if (e.key === 'Enter')     { e.preventDefault(); selectVendorCcyDdItem(); return; }
        if (e.key === 'Escape')    { e.preventDefault(); ccyDd.remove(); return; }
        if (e.key === 'Tab')       { if (selectVendorCcyDdItem()) e.preventDefault(); return; }
        return;
      }
      if (e.key === 'Enter') { e.preventDefault(); commitVendorCell(true); return; }
      if (e.key === 'Escape') { e.preventDefault(); commitVendorCell(false); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        commitVendorCell(true);
        var nextCol = Math.min(VENDOR_COL_EDIT_MAX, vendorSelCol + 1);
        if (nextCol === vendorSelCol) return;
        vendorSelCol = nextCol;
        updateVendorCursor();
        enterVendorCellEdit();
        return;
      }
      return; // all other keys pass through to input
    }

    // Browse mode
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.key === 'j') { e.preventDefault(); vendorMoveRow(1); }
    else if (e.key === 'k') { e.preventDefault(); vendorMoveRow(-1); }
    else if (e.key === 'i') {
      e.preventDefault();
      if (vendorSelCol === 5) vendorToggleActive();
      else if (vendorSelRow >= 0) enterVendorCellEdit();
    }
    else if (e.key === 'a') { e.preventDefault(); vendorAddNew(); }
    else if (e.key === 'd') { e.preventDefault(); vendorDeleteSelected(); }
    else if (e.key === '~') { e.preventDefault(); vendorToggleActive(); }
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
      input.dataset.apAccount = v.default_ap_account || '201100';
      input.dataset.expenseAccount = v.default_expense_account || '400000';
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
  var input = document.querySelector('#vendors-body td.vcell-editing input');
  if (input) input.value = cur.dataset.ccyCode;
  dd.remove();
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
