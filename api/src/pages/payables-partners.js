'use strict';

function partnersTabJS() {
  return `
// ========== PARTNERS — FB.list (P3 consolidated) ==========
// The Partners register is a declarative FB.list config. The framework owns the
// add row, nav (j/k incl. add row, gg/G), edit lifecycle (i/Enter/click),
// dirty buffers (w writes, u reverts, Esc exits WITHOUT saving — fixing the
// old Esc-auto-saves doctrine violation), x delete with confirm, and the
// shared leave-guard modal. Screen-specific extras (~ toggle active) are
// declared via extraBindings.
var partnerAccountsList = [];
var partnerCurrenciesList = [];
window.allPartners = []; // read by payables-bills.js bill partner dropdown

function loadPartnerAccounts() {
  if (partnerAccountsList.length) return;
  fetch('/api/' + COMPANY + '/accounts').then(function(r){ return r.json(); }).then(function(rows){
    partnerAccountsList = Array.isArray(rows) ? rows : [];
  }).catch(function(){});
}
function loadPartnerCurrencies() {
  if (partnerCurrenciesList.length) return;
  fetch('/db/currencies.json').then(function(r){ return r.json(); }).then(function(list){
    partnerCurrenciesList = Array.isArray(list) ? list : [];
  }).catch(function(){});
}

function partnerAttachCcy(inp) {
  loadPartnerCurrencies();
  FB.dropdown.attach(inp, {
    source: function(q) {
      q = (q || '').trim().toLowerCase();
      return partnerCurrenciesList.filter(function(c) {
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
function partnerAttachAcct(inp) {
  loadPartnerAccounts();
  FB.dropdown.attach(inp, {
    source: function(q) {
      q = (q || '').trim().toLowerCase();
      return partnerAccountsList.filter(function(a) {
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

function partnerMsg(msg, type) {
  var el = document.getElementById('msg-partners');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'err' ? '#cc2222' : type === 'ok' ? '#2a8a2a' : '#888';
}

function partnerActiveBadge(v) {
  return v !== false
    ? '<span class="badge" style="background:#f0fff4;color:#2a8a2a">Active</span>'
    : '<span class="badge" style="background:#f0f0f0;color:#888">Inactive</span>';
}

var partnersList = FB.list.create({
  keysId: 'partners',
  active: function() {
    var panel = document.getElementById('pay-panel-partners');
    return !!panel && panel.style.display !== 'none';
  },
  tbody: 'partners-body',
  companyId: function() { return COMPANY; },
  focusClass: 'bill-row-focus',
  onFocus: function(tr) {
    // common.js's j/k deferral reads this: >= 0 means partner nav owns j/k.
    window.fbPartnerSelRow = (tr && !tr.classList.contains('fb-add-row')) ? +tr.dataset.idx : -1;
  },
  columns: [
    { field: 'name', type: 'text', width: 180 },
    { field: 'default_currency', type: 'text', width: 40, align: 'center', uppercase: true, attach: partnerAttachCcy, filterType: 'list' },
    { field: 'payment_terms_days', type: 'number', width: 55, align: 'center', filterType: 'amount' },
    { field: 'default_expense_account', type: 'text', width: 130, attach: partnerAttachAcct },
    { field: 'default_ap_account', type: 'text', width: 130, attach: partnerAttachAcct },
    { field: 'is_vendor', type: 'checkbox', align: 'center', width: 50, display: function(v) { return v !== false ? 'V' : '\u2014'; } },
    { field: 'is_customer', type: 'checkbox', align: 'center', width: 50, display: function(v) { return v === true ? 'C' : '\u2014'; } },
    { field: 'is_active', type: 'checkbox', align: 'center', ro: 'always', display: partnerActiveBadge }
  ],
  blank: function() { return { name: '', default_currency: '', payment_terms_days: 30, default_expense_account: '', default_ap_account: '', is_vendor: true, is_customer: false, is_active: true }; },
  isBlank: function(b) { return !b.name; },
  same: function(b, s) {
    return b.name === (s.name || '')
      && b.default_currency === (s.default_currency || '')
      && b.payment_terms_days === (s.payment_terms_days != null ? s.payment_terms_days : 30)
      && b.default_expense_account === (s.default_expense_account || '')
      && b.default_ap_account === (s.default_ap_account || '')
      && (b.is_vendor !== false) === (s.is_vendor !== false)
      && (b.is_customer === true) === (s.is_customer === true);
  },
  validate: function(d) {
    if (!d.name) return 'Partner name required.';
    if (d.default_currency && partnerCurrenciesList.length) {
      var ok = partnerCurrenciesList.some(function(c){ return (c.code || '').toUpperCase() === d.default_currency; });
      if (!ok) return 'Unknown currency: ' + d.default_currency;
    }
    return null;
  },
  firstField: function() { return 'name'; },
  track: 'partner',
  list: { action: 'partner.list',
    map: function(v) { return { partner_id: v.partner_id, name: v.name || '', default_currency: v.default_currency || '', payment_terms_days: v.payment_terms_days != null ? v.payment_terms_days : 30, default_expense_account: v.default_expense_account || '', default_ap_account: v.default_ap_account || '', is_active: v.is_active !== false, _key: v.partner_id }; } },
  // payables-bills.js's bill partner dropdown reads the raw allPartners array.
  onLoaded: function(saved) { window.allPartners = saved; },
  save: { action: 'partner.upsert',
    body: function(d) { return { partner: { partner_id: d._isNew ? null : d._key, name: d.name, default_currency: d.default_currency || null, payment_terms_days: parseInt(d.payment_terms_days, 10) || 30, default_expense_account: d.default_expense_account || null, default_ap_account: d.default_ap_account || null, is_active: d.is_active !== false } }; },
    focusKey: function(d, res) { return d._isNew ? (res.partnerId || d._key) : d._key; } },
  del: { action: 'partner.delete',
    body: function(d) { return { partnerId: d._key }; },
    confirm: function(d) { return 'Delete partner "' + (d.name || d._key) + '"?'; } },
  extraBindings: function(api) {
    return [
      { key: '~', mode: 'NORMAL', hint: 'toggle active', hintBar: true,
        when: function() { var d = api.focusedRow(); return !!(d && !d._isNew); },
        run: function() {
          var d = api.focusedRow();
          if (!d || d._isNew) return;
          var v = { partner_id: d._key, name: d.name, default_currency: d.default_currency || null,
            payment_terms_days: d.payment_terms_days != null ? d.payment_terms_days : 30,
            default_expense_account: d.default_expense_account || null,
            default_ap_account: d.default_ap_account || null,
            is_active: d.is_active === false };
          fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ action:'partner.upsert', companyId: COMPANY, partner: v }) })
            .then(function(r){ return r.json(); })
            .then(function(res){
              var dd = res.data || res;
              if (dd.error || res.error) { partnerMsg((dd.error && dd.error.message) || dd.error || res.error, 'err'); return; }
              partnerMsg(v.is_active ? 'Marked active.' : 'Marked inactive.', 'ok');
              setTimeout(function(){ partnerMsg('', ''); }, 1500);
              api.load(d._key);
            })
            .catch(function(e){ partnerMsg(e.message, 'err'); });
        } }
    ];
  }
});

// ── Compat shims for payables-bills.js init/showPayTab ──────────────────────
function loadPartners() { partnersList.load(); loadPartnerCurrencies(); }
function loadPartnerTable() { partnersList.load(); }
function registerPartnerKeyActions() { /* keys registered by FB.list at creation */ }

// Hover suppression while a row is being edited (matches bills tbody).
FB.mode.onChange(function(m) {
  var tb = document.getElementById('partners-body');
  if (tb) tb.classList.toggle('insert-mode', m === 'INSERT');
});

// Deep-link: ?tab=partners opens the Partners tab directly (palette navigate
// entries target it — magnus K1 review 2026-07-28). Runs at the end of the
// combined script block: showPayTab (billsTabJS) + vendorsList both exist.
if ((new URLSearchParams(window.location.search)).get('tab') === 'partners') {
  showPayTab('partners');
}
`;
}

module.exports = { partnersTabJS };
