'use strict';

function vendorsTabJS() {
  return `
// ========== VENDORS — FB.list (P3 consolidated) ==========
// The Vendors register is a declarative FB.list config. The framework owns the
// add row, nav (j/k incl. add row, gg/G), edit lifecycle (i/Enter/click),
// dirty buffers (w writes, u reverts, Esc exits WITHOUT saving — fixing the
// old Esc-auto-saves doctrine violation), x delete with confirm, and the
// shared leave-guard modal. Screen-specific extras (~ toggle active) are
// declared via extraBindings.
var vendorAccountsList = [];
var vendorCurrenciesList = [];
window.allVendors = []; // read by payables-bills.js bill vendor dropdown

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

function vendorAttachCcy(inp) {
  loadVendorCurrencies();
  FB.dropdown.attach(inp, {
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
    onPick: function(item, input) {
      input.value = item.data.code;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}
function vendorAttachAcct(inp) {
  loadVendorAccounts();
  FB.dropdown.attach(inp, {
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
    onPick: function(item, input) {
      input.value = item.data.code;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

function vendorMsg(msg, type) {
  var el = document.getElementById('msg-vendors');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'err' ? '#cc2222' : type === 'ok' ? '#2a8a2a' : '#888';
}

function vendorActiveBadge(v) {
  return v !== false
    ? '<span class="badge" style="background:#f0fff4;color:#2a8a2a">Active</span>'
    : '<span class="badge" style="background:#f0f0f0;color:#888">Inactive</span>';
}

var vendorsList = FB.list.create({
  keysId: 'vendors',
  active: function() {
    var panel = document.getElementById('pay-panel-vendors');
    return !!panel && panel.style.display !== 'none';
  },
  tbody: 'vendors-body',
  msg: 'msg-vendors',
  companyId: function() { return COMPANY; },
  focusClass: 'bill-row-focus',
  onFocus: function(tr) {
    // common.js's j/k deferral reads this: >= 0 means vendor nav owns j/k.
    window.fbVendorSelRow = (tr && !tr.classList.contains('fb-add-row')) ? +tr.dataset.idx : -1;
  },
  columns: [
    { field: 'name', type: 'text', width: 180 },
    { field: 'default_currency', type: 'text', width: 40, align: 'center', uppercase: true, attach: vendorAttachCcy },
    { field: 'payment_terms_days', type: 'number', width: 55, align: 'center' },
    { field: 'default_expense_account', type: 'text', width: 130, attach: vendorAttachAcct },
    { field: 'default_ap_account', type: 'text', width: 130, attach: vendorAttachAcct },
    { field: 'is_active', type: 'checkbox', align: 'center', ro: 'always', display: vendorActiveBadge }
  ],
  blank: function() { return { name: '', default_currency: '', payment_terms_days: 30, default_expense_account: '', default_ap_account: '', is_active: true }; },
  isBlank: function(b) { return !b.name; },
  same: function(b, s) {
    return b.name === (s.name || '')
      && b.default_currency === (s.default_currency || '')
      && b.payment_terms_days === (s.payment_terms_days != null ? s.payment_terms_days : 30)
      && b.default_expense_account === (s.default_expense_account || '')
      && b.default_ap_account === (s.default_ap_account || '');
  },
  validate: function(d) {
    if (!d.name) return 'Vendor name required.';
    if (d.default_currency && vendorCurrenciesList.length) {
      var ok = vendorCurrenciesList.some(function(c){ return (c.code || '').toUpperCase() === d.default_currency; });
      if (!ok) return 'Unknown currency: ' + d.default_currency;
    }
    return null;
  },
  firstField: function() { return 'name'; },
  track: 'vendor',
  list: { action: 'vendor.list',
    map: function(v) { return { vendor_id: v.vendor_id, name: v.name || '', default_currency: v.default_currency || '', payment_terms_days: v.payment_terms_days != null ? v.payment_terms_days : 30, default_expense_account: v.default_expense_account || '', default_ap_account: v.default_ap_account || '', is_active: v.is_active !== false, _key: v.vendor_id }; } },
  // payables-bills.js's bill vendor dropdown reads the raw allVendors array.
  onLoaded: function(saved) { window.allVendors = saved; },
  save: { action: 'vendor.upsert',
    body: function(d) { return { vendor: { vendor_id: d._isNew ? null : d._key, name: d.name, default_currency: d.default_currency || null, payment_terms_days: parseInt(d.payment_terms_days, 10) || 30, default_expense_account: d.default_expense_account || null, default_ap_account: d.default_ap_account || null, is_active: d.is_active !== false } }; },
    focusKey: function(d, res) { return d._isNew ? (res.vendorId || d._key) : d._key; } },
  del: { action: 'vendor.delete',
    body: function(d) { return { vendorId: d._key }; },
    confirm: function(d) { return 'Delete vendor "' + (d.name || d._key) + '"?'; } },
  extraBindings: function(api) {
    return [
      { key: '~', mode: 'NORMAL', hint: 'toggle active', hintBar: true,
        when: function() { var d = api.focusedRow(); return !!(d && !d._isNew); },
        run: function() {
          var d = api.focusedRow();
          if (!d || d._isNew) return;
          var v = { vendor_id: d._key, name: d.name, default_currency: d.default_currency || null,
            payment_terms_days: d.payment_terms_days != null ? d.payment_terms_days : 30,
            default_expense_account: d.default_expense_account || null,
            default_ap_account: d.default_ap_account || null,
            is_active: d.is_active === false };
          fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ action:'vendor.upsert', companyId: COMPANY, vendor: v }) })
            .then(function(r){ return r.json(); })
            .then(function(res){
              var dd = res.data || res;
              if (dd.error || res.error) { vendorMsg((dd.error && dd.error.message) || dd.error || res.error, 'err'); return; }
              vendorMsg(v.is_active ? 'Marked active.' : 'Marked inactive.', 'ok');
              setTimeout(function(){ vendorMsg('', ''); }, 1500);
              api.load(d._key);
            })
            .catch(function(e){ vendorMsg(e.message, 'err'); });
        } }
    ];
  }
});

// ── Compat shims for payables-bills.js init/showPayTab ──────────────────────
function loadVendors() { vendorsList.load(); loadVendorCurrencies(); }
function loadVendorTable() { vendorsList.load(); }
function registerVendorKeyActions() { /* keys registered by FB.list at creation */ }

// Hover suppression while a row is being edited (matches bills tbody).
FB.mode.onChange(function(m) {
  var tb = document.getElementById('vendors-body');
  if (tb) tb.classList.toggle('insert-mode', m === 'INSERT');
});
`;
}

module.exports = { vendorsTabJS };
