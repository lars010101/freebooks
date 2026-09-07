'use strict';
// exchange-rates.js — IA restructure 2 (2026-08-27).
// Split out from master-data.js: standalone Exchange Rates page (no tabs).
// Carries the rate grid, currency picker, date-range toolbar, and ECB fetch.
const { makeQuery, commonStyle, navBar, layoutEnd } = require('./common');

async function handleExchangeRatesPage(req, res) {
  const { company } = req.params;
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildExchangeRatesPage(company));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function buildExchangeRatesPage(company) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Exchange Rates - freeBooks</title>
${commonStyle()}
<style>
  table.edit-table { width:100%; border-collapse:collapse; font-size:0.8125rem; }
  table.edit-table th { text-align:left; font-size:0.75rem; text-transform:uppercase; color:var(--text-muted); border-bottom:1px solid var(--border); padding:6px 6px; white-space:nowrap; }
  table.edit-table td { padding:4px 6px; border-bottom:1px solid var(--border); vertical-align:middle; white-space:nowrap; }
  table.edit-table input[type=text], table.edit-table input[type=date], table.edit-table select { width:100%; padding:4px 6px; border:1px solid var(--border); border-radius:3px; font-size:0.8125rem; background:var(--surface); color:var(--text); }
  table.edit-table .ro { background:var(--bg); color:var(--text-muted); padding:4px 6px; border-radius:3px; display:block; }
  .pe-ro { color:var(--text-muted); }
  tr.row-dirty > td:first-child { box-shadow: inset 3px 0 0 var(--warning); }
  .dirty-val { color:var(--warning); }
  tr.row-editing > td { background:var(--warning-bg); }
  .row-actions { white-space:nowrap; text-align:right; }
  .tb-select { padding:4px 6px; border:1px solid var(--border); border-radius:4px; font-size:0.8125rem; }
  .tb-date-input { padding:4px 6px; border:1px solid var(--border); border-radius:4px; font-size:0.8125rem; }
  .fb-toomany-row td { text-align:center; color:var(--text-muted); padding:24px; }
  .fb-add-row .fb-add-cell { color:var(--text-muted); cursor:pointer; padding:6px; text-align:center; }
</style>
</head>
<body>${navBar(company, 'exchange-rates')}
<div class="page">
  <div class="header">
    <h1>💱 Exchange Rates</h1>
  </div>

  <!-- Currency picker + date-range toolbar (default-period spec).
       The picker is persistent — switching currencies is a normal action. -->
  <div class="tb-controls-row" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:16px;">
    <select id="fx-foreign-currency" class="tb-select" style="min-width:130px" onchange="onFxForeignCurrencyChange()" title="Foreign currency">
      <option value="" disabled selected>Loading\u2026</option>
    </select>
  </div>
  <table class="edit-table" id="fx-rates-table">
    <thead><tr><th>Date</th><th>From</th><th>To</th><th style="text-align:right">Rate</th><th>Source</th><th></th></tr></thead>
    <tbody id="fx-rates-body"></tbody>
  </table>
</div>

<script>
var COMPANY = '${company}';

function showMsg(id, msg, isErr) {
  if (window.FB && FB.status) FB.status.show(msg, isErr);
}

// ========== EXCHANGE RATES — FB.list ==========
var fxList = FB.list.create({
  keysId: 'md-fxrates',
  active: function() { return true; }, // standalone page — always active
  tbody: 'fx-rates-body',
  companyId: function() { return COMPANY; },
  columns: [
    { field: 'date', type: 'date', width: 120, filterType: 'date' },
    { field: 'from_currency', type: 'text', width: 60, uppercase: true, attach: attachCcyDd, filterType: 'list' },
    { field: 'to_currency', type: 'text', width: 60, uppercase: true, attach: attachCcyDd, filterType: 'list' },
    { field: 'rate', type: 'number', step: '0.000001', width: 100,
      display: function(v) { return (v !== null && v !== undefined && v !== '') ? Number(v).toFixed(6) : '<span class="pe-ro">—</span>'; }, filterType: 'amount' },
    { field: 'source', ro: 'always', filterType: 'list' }
  ],
  blank: function() { return { date: new Date().toISOString().slice(0, 10), from_currency: '', to_currency: '', rate: '', source: 'manual' }; },
  isBlank: function(b) { return !b.from_currency && !b.to_currency && !b.rate; },
  same: function(b, s) {
    return String(b.date) === String(s.date) && b.from_currency === s.from_currency
      && b.to_currency === s.to_currency && Number(b.rate) === Number(s.rate);
  },
  validate: function(d) {
    if (!d.date || !d.from_currency || !d.to_currency) return 'Date, from and to required';
    if (!(Number(d.rate) > 0)) return 'Rate must be greater than 0';
    return null;
  },
  firstField: function() { return 'from_currency'; },
  track: 'fx-rate',
  actions: [
    { key: 'f', label: '📡 Fetch Rates', handler: function (api) { fetchFromEcb(); } }
  ],
  list: { action: 'fx.rates.list',
    body: function() {
      var fcSel = document.getElementById('fx-foreign-currency');
      var foreignCurrency = fcSel ? fcSel.value : '';
      if (!foreignCurrency) return {};
      var st = FB.period.get();
      return {
        foreignCurrency: foreignCurrency,
        baseCurrency: window._companyCurrency || '',
        dateFrom: st.start || '',
        dateTo: st.end || '',
        threshold: FB.list.threshold
      };
    },
    tooManyMessage: function(total) {
      return total.toLocaleString() + ' rates for this currency \\u2014 narrow the date range above to see this list.';
    },
    map: function(r) { return { date: r.date ? String(r.date).slice(0, 10) : '', from_currency: r.from_currency || '', to_currency: r.to_currency || '', rate: Number(r.rate), source: r.source || 'manual', _key: String(r.date).slice(0, 10) + '|' + r.from_currency + '|' + r.to_currency + '|' + (r.source || 'manual') }; } },
  save: { action: 'fx.rates.save',
    body: function(d) {
      var r = { date: d.date, from_currency: d.from_currency, to_currency: d.to_currency, rate: Number(d.rate) };
      if (!d._isNew && d._key) {
        var p = String(d._key).split('|');
        if (p.length === 4) r.original = { date: p[0], from_currency: p[1], to_currency: p[2], source: p[3] };
      }
      return { rates: [r] };
    },
    focusKey: function(d) { return d._key; } },
  del: { action: 'fx.rates.delete',
    body: function(d) { return { date: d.date, from_currency: d.from_currency, to_currency: d.to_currency, source: d.source }; },
    confirm: function() { return 'Delete this rate?'; } }
});

function loadBaseCurrencies() {
  var compCcy = window._companyCurrency || '';
  var displayEl = document.getElementById('current-base-currency');
  if (displayEl && compCcy) {
    displayEl.textContent = 'Base currency: ' + compCcy;
  }
}

// ========== FX CURRENCY PICKER GATE + DATE-RANGE INIT ==========
// (default-period spec) — the page no longer loads unconditionally. A
// persistent currency picker (<select #fx-foreign-currency>) must be
// resolved first: options come from the company's tracked foreign currencies
// (distinct partner default_currency values, excluding the base currency).
// Once a currency is chosen, the date range is resolved (URL params →
// default-period → setup-state fallback) and fxList.load() fires.
var _fxCurrenciesLoaded = false;

function loadFxRates() {
  loadBaseCurrencies();
  if (!_fxCurrenciesLoaded) {
    loadTrackedForeignCurrencies(function (currencies) {
      _fxCurrenciesLoaded = true;
      populateFxCurrencyPicker(currencies);
      _gateFxRatesLoad();
    });
  } else {
    _gateFxRatesLoad();
  }
}

// Fetch foreign currencies with non-zero balance-sheet exposure via the
// fx.exposed_currencies action (fx-tracked-currency-scoping-spec §6).
// Exposure is derived from journal entries, not configured — the list
// populates automatically when a bill or JV creates a foreign-currency
// balance on a monetary (Asset/Liability) account.  Sorted A→Z by the server.
function loadTrackedForeignCurrencies(cb) {
  fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'fx.exposed_currencies', companyId: COMPANY }) })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      var currencies = (res && Array.isArray(res.currencies)) ? res.currencies : [];
      cb(currencies);
    })
    .catch(function () { cb([]); });
}

// Populate the persistent currency picker. If no foreign currencies are
// tracked, show a setup message and do NOT call fx.rates.list.
function populateFxCurrencyPicker(currencies) {
  var sel = document.getElementById('fx-foreign-currency');
  if (!sel) return;
  if (!currencies.length) {
    sel.innerHTML = '<option value="" disabled selected>No currencies configured</option>';
    renderFxSetupState('No foreign-currency balances yet. This list populates once a bill or journal entry creates one.');
    return;
  }
  var currentVal = sel.value;
  sel.innerHTML = '<option value="" disabled selected>Select currency\u2026</option>'
    + currencies.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
  // Restore previous selection if still valid (e.g. after ECB fetch reload).
  if (currentVal && currencies.indexOf(currentVal.toUpperCase()) >= 0) sel.value = currentVal;
  if (!sel.value) {
    renderFxSetupState('Select a currency to view exchange rates.');
  }
}

// Gate: only load rates when a currency is selected AND the global Period
// Selector has resolved (FB.period.get().start/end). Otherwise wait —
// FB.period.onChange will trigger when the period resolves.
function _gateFxRatesLoad() {
  var sel = document.getElementById('fx-foreign-currency');
  if (!sel || !sel.value) return;
  var st = FB.period.get();
  if (st.start && st.end) {
    fxList.load();
  }
  // else: FB.period hasn't resolved yet — onChange will trigger.
}

// onchange handler for the persistent currency picker — switching currencies
// is a normal action (the picker never disappears).
function onFxForeignCurrencyChange() {
  var sel = document.getElementById('fx-foreign-currency');
  if (!sel || !sel.value) {
    renderFxSetupState('Select a currency to view exchange rates.');
    return;
  }
  var st = FB.period.get();
  if (st.start && st.end) {
    fxList.load();
  }
  // else: FB.period hasn't resolved yet — onChange will trigger.
}

// Setup-state spanning row — same pattern as FB.list's renderTooMany: one
// <tr><td colspan> with the message + the add row (display-only).
// fxList has 5 columns + 1 actions column = 6.
function renderFxSetupState(msg) {
  var tb = document.getElementById('fx-rates-body');
  if (!tb) return;
  tb.innerHTML = '<tr class="fb-toomany-row"><td colspan="6">' + esc(msg) + '</td></tr>'
    + '<tr class="fb-add-row"><td class="fb-add-cell" colspan="6">+ Add entry</td></tr>';
}

function fetchFromEcb() {
  var baseCcy = window._companyCurrency || '';
  if (!baseCcy) { showMsg('msg-fxrates', 'Please set company currency first', true); return; }
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'fx.fetch_rates', companyId: COMPANY, baseCurrency: baseCcy }) })
    .then(function(r){ return r.json(); }).then(function(r){
      if (r.error || (r.data && r.data.error)) {
        showMsg('msg-fxrates', r.error || r.data.error, true);
      } else {
        showMsg('msg-fxrates', 'Fetched ' + (r.data.rateCount || 0) + ' rates from ' + (r.data.provider || 'provider'), false);
        loadFxRates();
      }
    }).catch(function(e){ showMsg('msg-fxrates', e.message, true); });
}

// ========== CURRENCY LIST (FB.dropdown source) ==========
var currencyList = [];
function loadCurrencyList() {
  fetch('/db/currencies.json')
    .then(function(r){ return r.json(); })
    .then(function(currencies){ currencyList = currencies; })
    .catch(function(e){ console.error('Failed to load currencies:', e); });
}

function attachCcyDd(input) {
  if (!input || !window.FB || !FB.dropdown) return;
  FB.dropdown.attach(input, {
    keys: true,
    source: function (q) {
      q = (q || '').toLowerCase();
      return currencyList.filter(function (c) {
        return c.code.toLowerCase().indexOf(q) >= 0 || (c.name || '').toLowerCase().indexOf(q) >= 0;
      }).map(function (c) { return { primary: c.code, secondary: c.name, data: c }; });
    },
    onPick: function (it, inp) {
      inp.value = it.primary;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

// ========== COMPANY BASE CURRENCY (for ECB fetch + rate list body) ==========
function loadCompanyCurrency() {
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'company.attr.list', companyId: COMPANY }) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      var data = res.data || res;
      var rows = Array.isArray(data) ? data : (data.rows || []);
      var byKey = {};
      rows.forEach(function(r) { byKey[r.key] = r; });
      window._companyCurrency = byKey.currency ? byKey.currency.value : '';
      loadBaseCurrencies();
    })
    .catch(function(){});
}

// ========== UNSAVED CHANGES PROTECTION ==========
window.onbeforeunload = function(e) {
  if (window.FB && FB.list && FB.list.anyDirty()) {
    var msg = 'You have unsaved changes.';
    e.returnValue = msg;
    return msg;
  }
};

// ========== INIT ==========
(function() {
  loadCurrencyList();
  loadCompanyCurrency();
  loadFxRates();
  // Reload rates when the global period changes (global-period-selector-chrome-spec §5).
  FB.period.onChange(function () { _gateFxRatesLoad(); });
})();
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleExchangeRatesPage };
