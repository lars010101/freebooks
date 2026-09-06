'use strict';
const { commonStyle, navBar, layoutEnd, getRelevanceFlags } = require('./common');

async function handleJournalVoucherPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Relevance flags (settings-ux-spec §7 item 9): vatRegistered=false drops the
  // Tax Code column + the vat-codes fetch — journal lines carry no tax tags.
  const flags = await getRelevanceFlags(company);
  res.send(buildJournalVoucherPage(company, flags));
}


function buildJournalVoucherPage(company, flags) {
  const vatOn = !flags || flags.vatRegistered !== false;
  const fxOn = !!(flags && flags.fxTracking === 'true');
  const baseCcy = (flags && flags.baseCurrency) || '';
  // §2.1: Cost Center/Profit Center columns are visible when the company has
  // ≥1 active center configured (detected server-side by getRelevanceFlags,
  // not a settings toggle). Same baked-in pattern as vatOn/fxOn.
  const centersOn = !!(flags && flags.centersConfigured);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Journal Voucher — freeBooks</title>
${commonStyle()}
<style>
  table.jv-table { width:100%; border-collapse:collapse; font-size:10pt; }
  table.jv-table th { text-align:left; font-size:9pt; text-transform:uppercase; color:#555; border-bottom:1px solid #ccc; padding:6px 6px; }
  table.jv-table td { padding:3px 4px; border-bottom:1px solid #f0f0f0; vertical-align:middle; }
  table.jv-table input[type=text], table.jv-table input[type=number], table.jv-table select { padding:4px 6px; border:1px solid #ddd; border-radius:3px; font-size:10pt; }
  /* K4: shared attachment-queue rows (fb-attachments.js classes) */
  .fb-attach-row { display:flex; justify-content:space-between; align-items:center; padding:3px 6px; border-bottom:1px solid #f5f5f5; border-radius:3px; }
  .fb-attach-row .fb-att-meta { color:#888; font-size:8.5pt; }
  .fb-attach-row .fb-att-del { border:none; background:none; cursor:pointer; color:#cc4444; font-size:11pt; padding:0 4px; }
  .fb-attach-row.fb-form-row-focus { background:#1a1a1a !important; color:#fff; }
  .fb-attach-row.fb-form-row-focus .fb-att-meta { color:rgba(255,255,255,.6); }
  .fb-attach-row.fb-form-row-focus .fb-att-del { color:#ff8888; }
  /* + Add attachment row (2026-09-06, retires A) — fb-list add-row parity */
  .fb-att-add-btn { border:none; background:none; cursor:pointer; color:#888; font-size:9.5pt; padding:2px 0; text-align:left; width:100%; }
  .fb-attach-row.fb-form-row-focus .fb-att-add-btn { color:#fff; }
  /* A1 (magnus 2026-07-28): read-only original-entry rows shown above the
     swapped reversal rows. Plain-text <td>s (no inputs) — grayed + italic. */
  .jv-orig-hdr td, .jv-orig-line td { color:#999; background:#f5f5f5; font-style:italic; }
  /* Status badges (Journal Voucher form) */
  .st-badge { display:inline-block; padding:1px 8px; border-radius:9px; font-size:8.5pt; font-weight:600; text-transform:uppercase; letter-spacing:.02em; }
  .st-new { background:#e3f2fd; color:#1565c0; }
  .st-posted { background:#e8f5e9; color:#2e7d32; }
  .st-reversed { background:#ffebee; color:#c62828; }
  /* Normalize disabled/readonly header fields to the same gray background
     so posted/view-mode fields don't get browser-default mismatched shades. */
  .header-fields input:disabled, .header-fields select:disabled,
  .header-fields input[readonly] { background:#f5f5f5 !important; }
  /* Posted/view mode: flatten header fields to plain text — no borders,
     no input backgrounds. Matches the read-only line items below. */
  .header-fields.jv-flat-readonly input,
  .header-fields.jv-flat-readonly select { border:none !important; background:transparent !important; box-shadow:none !important; outline:none !important; padding:4px 0 !important; font-size:10pt; -webkit-appearance:none; -moz-appearance:none; appearance:none; }
  .header-fields.jv-flat-readonly input[type="date"]::-webkit-inner-spin-button,
  .header-fields.jv-flat-readonly input[type="date"]::-webkit-clear-button,
  .header-fields.jv-flat-readonly input[type="date"]::-webkit-calendar-picker-indicator { display:none !important; }
  .header-fields.jv-flat-readonly select::-ms-expand { display:none; }
  .header-fields.jv-flat-readonly input:disabled,
  .header-fields.jv-flat-readonly select:disabled,
  .header-fields.jv-flat-readonly input[readonly] { background:transparent !important; color:#333; -webkit-text-fill-color:#333; opacity:1; padding:4px 0 !important; }
</style>
</head>
<body>${navBar(company, 'newjv')}
<div class="page">
  <div class="header" style="display:flex;justify-content:space-between;align-items:flex-start">
    <div>
      <h1>Journal Voucher</h1>
      <p class="sub">
        <span id="jv-status-badge" class="st-badge st-new">New</span>
      </p>
    </div>
    <button class="btn-sm" id="btn-reversal-mode" onclick="toggleReversalMode()" style="margin-top:8px">⟲ Reversal</button>
  </div>

  <!-- Reversal search panel (hidden by default) -->
  <div id="reversal-panel" style="display:none;margin-bottom:16px;padding:14px;background:#f8f4ff;border:1px solid #c9b8e8;border-radius:6px">
    <div style="font-weight:600;margin-bottom:8px;color:#5a3ea0">Find entry to reverse</div>
    <input type="text" id="reversal-search" placeholder="Search by reference or description…"
      oninput="onReversalSearch(this.value)"
      style="width:400px;padding:7px 10px;border:1px solid #c9b8e8;border-radius:4px;font-size:10pt">
    <div id="reversal-results" style="margin-top:6px;max-height:200px;overflow-y:auto;background:#fff;border:1px solid #ddd;border-radius:4px;display:none"></div>
  </div>

  <div class="header-fields">
    <label>Date <input type="date" id="entry-date"></label>
    <label>Journal <select id="entry-journal" style="width:180px;height:32px;padding:4px 6px"><option value="">— loading —</option></select></label>
    <label>Doc Nr <input type="text" id="jv-reference" readonly style="width:80px;border:1px solid #ddd;border-radius:3px;padding:4px 6px;font-size:10pt"></label>
    <label>Description <input type="text" id="entry-desc" placeholder="e.g. Salary payment" style="width:400px"></label>
    ${fxOn
      ? '<label>CCY <input type="text" id="entry-ccy" maxlength="3" autocomplete="off" style="text-transform:uppercase;width:60px" value="' + baseCcy + '"></label>'
      : '<input type="hidden" id="entry-ccy" value="' + baseCcy + '">'}
    <label class="fx-rate-field" style="display:none">FX Rate <input type="number" id="entry-fx-rate" step="0.000001" style="width:90px"></label>
  </div>

  <table class="jv-table">
    <thead>
      <tr>
        <th>Account</th><th class=\"num\">Debit</th><th class=\"num\">Credit</th>
        <th>Line Description</th>${vatOn ? '<th>Tax Code</th><th class=\"num\">VAT</th>' : ''}${centersOn ? '<th>Cost Center</th><th>Profit Center</th>' : ''}<th></th>
      </tr>
    </thead>
    <tbody id="lines-body"></tbody>
  </table>

  <div class="totals">
    <div>Debits: <span id="total-dr">0.00</span></div>
    <div>Credits: <span id="total-cr">0.00</span></div>
    <div>VAT: <span id="total-vat">0.00</span></div>
    <div>Diff: <span id="total-diff" style="color:#cc2222">0.00</span></div>
  </div>

  <div style="margin-top:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
    <button class="btn-sm" onclick="addLine()">+ Add Line</button>
    <button class="btn-primary" id="btn-post" onclick="postEntry()">Post Entry</button>
    <span id="status-msg" style="font-size:10pt"></span>
  </div>

  <div id="jv-pre-attach-section" style="margin-top:14px;padding:12px;border:1px solid #e8e8e8;border-radius:4px;background:#fafafa">
    <div style="font-size:10pt;font-weight:600;margin-bottom:6px">📎 Attachments</div>
    <input type="file" id="jv-pre-attach-input" style="display:none" accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt" onchange="addJvAttachment(this)" multiple>
    <div id="jv-pending-list" style="font-size:9.5pt"></div>
  </div>

  <div id="jv-attachment-panel" style="display:none;margin-top:14px;padding:12px;border:1px solid #e0e0e0;border-radius:4px;background:#fafafa">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <span style="font-size:10pt;font-weight:600">📎 Attachments for this entry</span>
      <label style="cursor:pointer;padding:4px 12px;border:1px solid #ccc;border-radius:3px;background:#fff;font-size:9.5pt">
        + Attach
        <input type="file" id="jv-attach-input" style="display:none" accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt" onchange="uploadJvAttachment(this)">
      </label>
    </div>
    <div id="jv-attachments-list" style="font-size:9.5pt">
      <span style="color:#aaa;font-size:9pt">No attachments yet</span>
    </div>
  </div>
</div>
<script>
  var COMPANY = '${company}';
  var VAT_ON = ${vatOn ? 'true' : 'false'};
  var BASE_CCY = '${baseCcy}';
  var FX_ON = ${fxOn ? 'true' : 'false'};
  var CENTERS_ON = ${centersOn ? 'true' : 'false'};
  var accountsMap = {};
  var vatCodes = [];
  var centers = [];
  var currencies = [];
  var currentBatchId = null;
  var pendingJvAttachments = [];
  // View mode (?batch=<id>): a posted batch loaded read-only. FROM_REPORT
  // (§10.4) reroutes quit back to the originating report instead of the
  // company root.
  var VIEW_BATCH = new URLSearchParams(window.location.search).get('batch');
  var FROM_REPORT = new URLSearchParams(window.location.search).get('from');
  var RPT_START = new URLSearchParams(window.location.search).get('rpt_start') || '';
  var RPT_END = new URLSearchParams(window.location.search).get('rpt_end') || '';
  var viewBatchLines = null, viewBatchRef = '', viewBatchDate = '', viewBatchDesc = '';
  var viewBatchReversed = false;

  // ── Status badge + reference field ───────────────────────────────────
  // jvStatus: 'new' | 'posted' | 'reversed' (client-side inferred).
  function updateStatusBadge(status) {
    var el = document.getElementById('jv-status-badge');
    if (!el) return;
    el.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    el.className = 'st-badge st-' + status;
  }
  function setReference(ref) {
    var el = document.getElementById('jv-reference');
    if (el) el.value = ref || '';
  }

  // ── §1.2 FX Rate behavior ───────────────────────────────────────────────
  // Resolve the FX rate for the currently-selected header currency against
  // BASE_CCY. Hides + clears the field when ccy is blank or the base; shows
  // it and (if empty) pre-fills via fx.rates.get for a foreign currency.
  // Mirrors bill-edit.js's be-ccy resolution pattern.
  function resolveFxRate() {
    var ccyEl = document.getElementById('entry-ccy');
    if (!ccyEl) return;
    var ccy = ccyEl.value.trim().toUpperCase();
    var frf = document.querySelector('.fx-rate-field');
    var rateEl = document.getElementById('entry-fx-rate');
    if (!ccy || ccy === BASE_CCY) {
      if (frf) frf.style.display = 'none';
      if (rateEl) rateEl.value = '';
      return;
    }
    if (frf) frf.style.display = '';
    if (rateEl && !rateEl.value) {
      fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          action: 'fx.rates.get', companyId: COMPANY,
          body: { fromCurrency: ccy, toCurrency: BASE_CCY, date: document.getElementById('entry-date').value }
        }) })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          // fx.rates.get returns { rate } (or null when no rate for date)
          var r = res && (res.data && res.data.rate != null ? res.data.rate : res.rate);
          if (r != null && rateEl && !rateEl.value) rateEl.value = r;
          // If null, leave field empty — postEntry validation will block post
        })
        .catch(function () { /* leave empty — validation will block */ });
    }
  }

  fetch('/api/' + COMPANY + '/accounts')
    .then(r => r.json())
    .then(rows => {
      rows.forEach(a => { accountsMap[a.account_code] = a.account_name; });
      if (VIEW_BATCH) initViewMode();   // accounts needed for line names
      else applyPrefill();
    });

  if (VAT_ON)
  fetch('/api/' + COMPANY + '/vat-codes')
    .then(r => r.json())
    .then(rows => {
      if (!Array.isArray(rows)) return;
      vatCodes = rows.filter(v => v.is_active !== false);
      document.querySelectorAll('.tax-select').forEach(sel => populateTaxSelect(sel));
    });

  // Load journals into dropdown
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'journals.list', companyId: COMPANY }) })
    .then(r => r.json())
    .then(res => {
      var journals = res.data || res;
      var sel = document.getElementById('entry-journal');
      if (!Array.isArray(journals) || journals.length === 0) {
        sel.innerHTML = '<option value="">— no journals —</option>';
        return;
      }
      sel.innerHTML = '<option value="">— select journal —</option>'
        + journals.map(j => '<option value="'+j.journal_id+'">'+j.code+' — '+j.name+'</option>').join('');
      // Default to MISC if available
      var miscOpt = Array.from(sel.options).find(o => o.text.startsWith('MISC'));
      if (miscOpt) sel.value = miscOpt.value;
    })
    .catch(() => {
      document.getElementById('entry-journal').innerHTML = '<option value="">— unavailable —</option>';
    });

  // §2: fetch cost centers once on page load (centers array is consumed by
  // attachCenterDd's source function). Re-attach to any .cc-input already in
  // the DOM (initial blank lines + reversal-prefilled rows).
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'center.list', companyId: COMPANY }) })
    .then(r => r.json())
    .then(res => { centers = (res.data || res) || []; })
    .then(() => {
      document.querySelectorAll('.cc-input').forEach(function (el) { attachCenterDd(el, 'Cost'); });
      document.querySelectorAll('.pc-input').forEach(function (el) { attachCenterDd(el, 'Profit'); });
    })
    .catch(() => { /* centers stays empty — autocomplete degrades gracefully */ });

  function populateTaxSelect(sel) {
    var current = sel.value;
    sel.innerHTML = '<option value="">\u2014 none \u2014</option>'
      + vatCodes.map(v => '<option value="'+v.vat_code+'"'+(v.vat_code===current?' selected':'')+'>'+v.vat_code+' \u2014 '+v.description+'</option>').join('');
  }

  // ── Account autocomplete (FB.dropdown) ────────────────────────────────────
  function getAccountList() {
    return Object.keys(accountsMap).map(code => ({ code, name: accountsMap[code] }));
  }

  function pickAccount(acct, input) {
    input.value = acct.code + ' — ' + acct.name;
    input.dataset.code = acct.code;
  }

  function attachAcctDd(input) {
    if (!window.FB || !FB.dropdown) return;
    FB.dropdown.attach(input, {
      // No keys:true — this is an FB.keys page (FB.form, K3); dropdown keys
      // route through the form's INSERT bindings (fb-list parity).
      minWidth: 280,
      source: function (q) {
        q = (q || '').toLowerCase();
        return getAccountList().filter(function (a) {
          return a.code.toLowerCase().indexOf(q) >= 0 || a.name.toLowerCase().indexOf(q) >= 0;
        }).map(function (a) { return { primary: a.code, secondary: a.name, data: a }; });
      },
      onPick: function (it, inp) { pickAccount(it.data, inp); }
    });
  }

  // ── §2.2/§2.3 Cost Center + Profit Center autocomplete (FB.dropdown) ────────
  // Single parameterized helper: type is 'Cost' or 'Profit', filtered on
  // c.center_type === type. Capitalized — centers.js's deriveProfitCenter
  // checks !== 'Cost' on stored/validated values; matching lowercase 'cost'
  // as bill-edit.js does would match nothing against real data (spec §2.2
  // divergence note).
  function attachCenterDd(input, type) {
    if (!input || !window.FB || !FB.dropdown) return;
    FB.dropdown.attach(input, {
      minWidth: 180,
      source: function (q) {
        q = (q || '').toLowerCase();
        return centers.filter(function (c) { return c.center_type === type; })
          .filter(function (c) {
            return (c.center_id || '').toLowerCase().indexOf(q) >= 0
              || (c.name || '').toLowerCase().indexOf(q) >= 0;
          })
          .map(function (c) { return { primary: c.center_id, secondary: c.name, data: c }; });
      },
      onPick: function (it, inp) { inp.value = it.primary; }
    });
  }

  // ── §2.4 Mutual exclusivity — Cost Center vs Profit Center ────────────────
  // journal.post's precedence silently overwrites profit_center when both
  // fields are filled (cost-side derivation wins). Prevent the user from
  // ever having both populated: typing in either clears + disables the other;
  // clearing a field re-enables its counterpart.
  function attachCenterExclusivity(ccInput, pcInput) {
    if (!ccInput || !pcInput) return;
    ccInput.addEventListener('input', function () {
      if (ccInput.value.trim()) { pcInput.value = ''; pcInput.disabled = true; }
      else { pcInput.disabled = false; }
    });
    pcInput.addEventListener('input', function () {
      if (pcInput.value.trim()) { ccInput.value = ''; ccInput.disabled = true; }
      else { ccInput.disabled = false; }
    });
  }
  // ──────────────────────────────────────────────────────────────────────────

  function addLine() {
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td><input type="text" class="acct-input" style="width:200px" placeholder="Code or name…"></td>'
      +'<td><input type="number" class="debit-input" min="0" step="0.01" oninput="updateTotals()" style="width:100px"></td>'
      +'<td><input type="number" class="credit-input" min="0" step="0.01" oninput="updateTotals()" style="width:100px"></td>'
      +'<td><input type="text" class="desc-input" style="width:160px" placeholder="optional"></td>'
      +(VAT_ON ? '<td><select class="tax-select" style="width:120px" onchange="updateTotals()"><option value="">\u2014 none \u2014</option></select></td>' : '')
      +(VAT_ON ? '<td class="vat-display" style="width:70px;text-align:right;color:#555">0.00</td>' : '')
      +(CENTERS_ON ? '<td><input type="text" class="cc-input" style="width:120px" placeholder="Cost center"></td>' : '')
      +(CENTERS_ON ? '<td><input type="text" class="pc-input" style="width:120px" placeholder="Profit center"></td>' : '')
      +'<td><button class="btn-sm danger" onclick="this.parentElement.parentElement.remove(); updateTotals()">&times;</button></td>';
    document.getElementById('lines-body').appendChild(tr);
    if (VAT_ON) populateTaxSelect(tr.querySelector('.tax-select'));
    var codeIn = tr.querySelector('.acct-input');
    attachAcctDd(codeIn);
    // §2.2/§2.3: attach center autocompletes + mutual exclusivity (only when
    // the columns are rendered, i.e. CENTERS_ON).
    if (CENTERS_ON) {
      var ccInput = tr.querySelector('.cc-input');
      var pcInput = tr.querySelector('.pc-input');
      attachCenterDd(ccInput, 'Cost');
      attachCenterDd(pcInput, 'Profit');
      attachCenterExclusivity(ccInput, pcInput);
    }
    // §3.2: exact code typed directly (no dropdown pick) → resolve to
    // "CODE — Name" display form on blur. If the dropdown already set
    // dataset.code, leave as-is. Unknown text is left untouched —
    // postEntry's "Unknown account(s)" validation will catch it.
    codeIn.addEventListener('blur', function () {
      var v = codeIn.value.trim();
      if (!v) { delete codeIn.dataset.code; return; }
      if (accountsMap[v]) {
        pickAccount({ code: v, name: accountsMap[v] }, codeIn);
      } else if (codeIn.dataset.code) {
        // Already resolved via dropdown — leave as-is
      }
      // else: unknown — postEntry validation will catch it
    });
    return tr;
  }

  function updateTotals() {
    var dr = 0, cr = 0, vatDebit = 0, vatCredit = 0;
    document.querySelectorAll('#lines-body tr').forEach(tr => {
      // A1: skip read-only original-entry rows (no .debit-input/.credit-input)
      var dEl = tr.querySelector('.debit-input');
      var cEl = tr.querySelector('.credit-input');
      if (!dEl || !cEl) return;
      var d = parseFloat(dEl.value || 0);
      var c = parseFloat(cEl.value || 0);
      dr += d;
      cr += c;

      // P2-4a: computed VAT per line (tax-exclusive — amount × rate).
      // The balance indicator reflects the POSTED batch (net + VAT GL lines =
      // gross offset): diff = (dr + vatDebit) − (cr + vatCredit).
      var vatEl = tr.querySelector('.vat-display');
      var taxSel = tr.querySelector('.tax-select');
      var lineVat = 0;
      if (VAT_ON && taxSel && taxSel.value) {
        var vc = vatCodes.find(function (v) { return v.vat_code === taxSel.value; });
        if (vc) {
          var rate = Number(vc.rate) || 0;
          var amt = d || c || 0;
          lineVat = Math.round(amt * rate * 100) / 100;
          if (vc.is_reverse_charge) {
            vatDebit += lineVat;   // DR input VAT
            vatCredit += lineVat;  // CR output VAT (self-balancing)
          } else {
            if (d > 0) vatDebit += lineVat; else vatCredit += lineVat;
          }
        }
      }
      if (vatEl) vatEl.textContent = lineVat.toFixed(2);
    });
    document.getElementById('total-dr').textContent = dr.toFixed(2);
    document.getElementById('total-cr').textContent = cr.toFixed(2);
    var totalVat = Math.round((vatDebit + vatCredit) * 100) / 100;
    var vatTotalEl = document.getElementById('total-vat');
    if (vatTotalEl) vatTotalEl.textContent = totalVat.toFixed(2);
    // P2-4a §4.2: balance reflects the posted batch — net + VAT = gross.
    var diff = Math.round(((dr + vatDebit) - (cr + vatCredit)) * 100) / 100;
    var diffEl = document.getElementById('total-diff');
    diffEl.textContent = diff.toFixed(2);
    diffEl.style.color = diff === 0 ? '#2a8a2a' : '#cc2222';
    document.getElementById('btn-post').disabled = diff !== 0;
  }

  function loadJvAttachments() {
    if (!currentBatchId) return;
    var listEl = document.getElementById('jv-attachments-list');
    if (!listEl) return;
    fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'attachment.list', companyId: COMPANY, entityType: 'journal', entityId: currentBatchId }) })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        var items = res.data || res || [];
        if (!Array.isArray(items) || !items.length) {
          listEl.innerHTML = '<span style="color:#aaa;font-size:9pt">No attachments yet</span>';
          return;
        }
        listEl.innerHTML = items.map(function(a) {
          var kb = (a.file_size / 1024).toFixed(1);
          return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #eee">'
            + '<a href="/api/attachments/' + a.attachment_id + '" target="_blank" style="color:#1a1a1a;text-decoration:none;font-size:9.5pt">'
            + '\ud83d\udcc4 ' + a.filename + ' <span style="color:#888;font-size:8.5pt">(' + kb + ' KB)</span></a>'
            + '<button onclick="deleteJvAttachment(\\'' + a.attachment_id + '\\')" '
            + 'style="border:none;background:none;cursor:pointer;color:#cc4444;font-size:11pt;padding:0 4px">&times;</button>'
            + '</div>';
        }).join('');
      }).catch(function(){});
  }

  function uploadJvAttachment(input) {
    if (!input.files || !input.files[0] || !currentBatchId) return;
    var file = input.files[0];
    input.value = '';
    var listEl = document.getElementById('jv-attachments-list');
    listEl.innerHTML = '<span style="color:#888">Uploading ' + file.name + '\u2026</span>';
    var fd = new FormData();
    fd.append('companyId', COMPANY);
    fd.append('entityType', 'journal');
    fd.append('entityId', currentBatchId);
    fd.append('file', file);
    fetch('/api/upload', { method: 'POST', body: fd })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        if (res.error || !res.ok) { alert('Upload failed: ' + (res.error || 'unknown')); loadJvAttachments(); return; }
        loadJvAttachments();
      })
      .catch(function(e) { alert('Upload failed: ' + e.message); loadJvAttachments(); });
  }

  function deleteJvAttachment(attachmentId) {
    if (!confirm('Remove attachment?')) return;
    fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'attachment.delete', companyId: COMPANY, attachmentId: attachmentId }) })
      .then(function(r) { return r.json(); })
      .then(function() { loadJvAttachments(); })
      .catch(function(){});
  }

  function postEntry() {
    var date      = document.getElementById('entry-date').value;
    var journalId = document.getElementById('entry-journal').value;
    var desc      = document.getElementById('entry-desc').value.trim();
    if (!date) { showStatus('Date is required', true); return; }
    if (!journalId) { showStatus('Select a journal', true); return; }

    // §1.3: currency + fx_rate are header-level — read once, stamp per line.
    var currency = document.getElementById('entry-ccy') ? document.getElementById('entry-ccy').value.trim().toUpperCase() : BASE_CCY;
    var fxRate   = document.getElementById('entry-fx-rate') ? document.getElementById('entry-fx-rate').value : null;
    // §5 validation: foreign currency with no rate → block post
    if (FX_ON && currency && currency !== BASE_CCY && !fxRate) {
      showStatus('Exchange rate required for ' + currency, true);
      return;
    }

    var lines = Array.from(document.querySelectorAll('#lines-body tr'))
      // A1: skip read-only original-entry rows (no inputs) before mapping
      .filter(function(tr) { return !tr.classList.contains('jv-orig-line') && !tr.classList.contains('jv-orig-hdr'); })
      .map(tr => ({
      date,
      account_code:  tr.querySelector('.acct-input').dataset.code
        || tr.querySelector('.acct-input').value.trim().split(' \u2014 ')[0],
      debit:         parseFloat(tr.querySelector('.debit-input').value  || 0),
      credit:        parseFloat(tr.querySelector('.credit-input').value || 0),
      description:   tr.querySelector('.desc-input').value.trim() || desc || null,
      vat_code:      (function(){ var s = tr.querySelector('.tax-select'); return s ? (s.value || null) : null; })(),
      cost_center:   tr.querySelector('.cc-input') ? (tr.querySelector('.cc-input').value.trim() || null) : null,
      profit_center: tr.querySelector('.pc-input') ? (tr.querySelector('.pc-input').value.trim() || null) : null,
      currency,
      fx_rate:       fxRate ? Number(fxRate) : undefined,
    })).filter(l => l.account_code && (l.debit > 0 || l.credit > 0));
    // Validate codes
    var badCodes = lines.filter(l => !accountsMap[l.account_code]).map(l => l.account_code);
    if (badCodes.length) { showStatus('Unknown account(s): ' + badCodes.join(', '), true); return; }

    if (lines.length < 2) { showStatus('At least 2 lines required', true); return; }

    document.getElementById('btn-post').disabled = true;
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'journal.post', companyId: COMPANY, journalId, lines }) })
      .then(r => r.json())
      .then(res => {
        var d = res.data || res;
        if (res.error || d.errors) {
          showStatus((d.errors || [res.error]).join('; '), true);
          document.getElementById('btn-post').disabled = false;
        } else {
          showStatus('Posted \u2713  ' + (d.reference || d.batchId), false);
          currentBatchId = d.batchId;
          pendingJvAttachments = [];
          renderJvPendingList();
          document.getElementById('jv-attachment-panel').style.display = '';
          document.getElementById('jv-attachments-list').innerHTML = '<span style="color:#aaa;font-size:9pt">No attachments yet</span>';
          uploadPendingJvAttachments(d.batchId).then(function() { if (currentBatchId) loadJvAttachments(); });
          // Stay on the posted JV: render it read-only with status + reference
          // instead of resetting to a blank form.
          renderPostedVoucher(d);
        }
      })
      .catch(e => { showStatus(e.message, true); document.getElementById('btn-post').disabled = false; });
  }

  function showStatus(msg, isErr) {
    var el = document.getElementById('status-msg');
    el.textContent = msg;
    el.style.color = isErr ? '#cc2222' : '#2a8a2a';
  }

  document.getElementById('entry-date').value = new Date().toISOString().slice(0, 10);
  // §1.2: Currency blur/change and Date change re-resolve the FX rate field.
  var ccyField = document.getElementById('entry-ccy');
  if (ccyField) {
    ccyField.addEventListener('blur', resolveFxRate);
    ccyField.addEventListener('change', resolveFxRate);
  }
  var dateField = document.getElementById('entry-date');
  if (dateField) {
    dateField.addEventListener('change', function () {
      // Only re-resolve if a foreign currency is already set
      var c = document.getElementById('entry-ccy');
      if (c && c.value.trim().toUpperCase() && c.value.trim().toUpperCase() !== BASE_CCY) {
        resolveFxRate();
      }
    });
  }
  if (!VIEW_BATCH) { addLine(); addLine(); }
  updateTotals();

  // ── Prefill from :post command (stored in sessionStorage by fb-core.js) ─────
  // :post <amount> <account> [from <account>] [due <date>]
  //   → { amount, account, fromAccount, date }
  // Populates date, then sets line 1 debit to <account> and line 2 credit
  // to <fromAccount> (or leaves line 2 blank when fromAccount is null).
  function applyPrefill() {
    var raw = null;
    try { raw = sessionStorage.getItem('fb-cmd-prefill'); } catch (e) { return; }
    if (!raw) return;
    try { sessionStorage.removeItem('fb-cmd-prefill'); } catch (e) {}
    var pf;
    try { pf = JSON.parse(raw); } catch (e) { return; }
    if (!pf || typeof pf !== 'object') return;

    if (pf.date) document.getElementById('entry-date').value = pf.date;

    var rows = document.querySelectorAll('#lines-body tr');
    if (rows.length < 2) { addLine(); addLine(); }
    rows = document.querySelectorAll('#lines-body tr');

    // Line 1: debit the target account
    var r0 = rows[0];
    var codeIn0 = r0.querySelector('.acct-input');
    if (codeIn0 && pf.account) {
      codeIn0.value = pf.account;
      codeIn0.dispatchEvent(new Event('input'));
    }
    var debitIn0 = r0.querySelector('.debit-input');
    if (debitIn0 && pf.amount != null) debitIn0.value = pf.amount;

    // Line 2: credit the source account (from)
    var r1 = rows[1];
    if (r1 && pf.fromAccount) {
      var codeIn1 = r1.querySelector('.acct-input');
      if (codeIn1) {
        codeIn1.value = pf.fromAccount;
        codeIn1.dispatchEvent(new Event('input'));
      }
      var creditIn1 = r1.querySelector('.credit-input');
      if (creditIn1 && pf.amount != null) creditIn1.value = pf.amount;
    }

    updateTotals();
  }

  // ── View mode (?batch=<id>) ─────────────────────────────────────────
  // Loads a posted batch read-only. Reversal is pre-targeted at the viewed
  // batch (no search step). Quit returns to FROM_REPORT when set (§10.4).
  function setCreateControls(visible) {
    var addBtn = document.querySelector('button[onclick="addLine()"]');
    var postBtn = document.getElementById('btn-post');
    [addBtn, postBtn].forEach(function (b) { if (b) b.style.display = visible ? '' : 'none'; });
  }

  function renderViewMode() {
    var dateEl = document.getElementById('entry-date');
    dateEl.value = viewBatchDate;
    dateEl.disabled = true;
    var jSel = document.getElementById('entry-journal');
    jSel.disabled = true;
    var descEl = document.getElementById('entry-desc');
    descEl.value = viewBatchDesc;
    descEl.readOnly = true;
    // §3.5: show currency read-only for posted/viewed foreign-currency vouchers
    var ccyEl = document.getElementById('entry-ccy');
    if (ccyEl) {
      ccyEl.value = (viewBatchLines[0] && viewBatchLines[0].currency) || BASE_CCY;
      ccyEl.readOnly = true;
    }
    document.querySelector('.header-fields').classList.add('jv-flat-readonly');
    document.title = 'Journal Voucher — freeBooks';
    updateStatusBadge(viewBatchReversed ? 'reversed' : 'posted');
    setReference(viewBatchRef);
    var body = document.getElementById('lines-body');
    body.innerHTML = '';
    var dr = 0, cr = 0;
    viewBatchLines.forEach(function (l) {
      dr += parseFloat(l.debit || 0); cr += parseFloat(l.credit || 0);
      var tr = document.createElement('tr');
      tr.className = 'jv-view-line';
      tr.innerHTML = '<td>' + esc(l.account_code || '') + ' \u2014 ' + esc(accountsMap[l.account_code] || '') + '</td>'
        + '<td class="num">' + (parseFloat(l.debit || 0) || 0).toFixed(2) + '</td>'
        + '<td class="num">' + (parseFloat(l.credit || 0) || 0).toFixed(2) + '</td>'
        + '<td>' + esc(l.description || '') + '</td>'
        + (VAT_ON ? '<td>' + esc(l.vat_code || '') + '</td>' : '')
        + (VAT_ON ? '<td class="num">' + (parseFloat(l.vat_amount || 0) || 0).toFixed(2) + '</td>' : '')
        + (CENTERS_ON ? '<td>' + esc(l.cost_center || '') + '</td>' : '')
        + (CENTERS_ON ? '<td>' + esc(l.profit_center || '') + '</td>' : '')
        + '<td></td>';
      body.appendChild(tr);
    });
    document.getElementById('total-dr').textContent = dr.toFixed(2);
    document.getElementById('total-cr').textContent = cr.toFixed(2);
    var viewVat = Math.round(viewBatchLines.reduce(function (s, l) { return s + parseFloat(l.vat_amount || 0); }, 0) * 100) / 100;
    var viewVatEl = document.getElementById('total-vat');
    if (viewVatEl) viewVatEl.textContent = viewVat.toFixed(2);
    var diff = Math.round((dr - cr) * 100) / 100;
    var diffEl = document.getElementById('total-diff');
    diffEl.textContent = diff.toFixed(2);
    diffEl.style.color = diff === 0 ? '#2a8a2a' : '#cc2222';
    setCreateControls(false);
    currentBatchId = VIEW_BATCH;
    document.getElementById('jv-pre-attach-section').style.display = 'none';
    document.getElementById('jv-attachment-panel').style.display = '';
    loadJvAttachments();
  }

  // ── Post-stay mode ──────────────────────────────────────────────────
  // After a successful post, render the posted lines read-only (same as
  // view mode) using the post-response data instead of a separate fetch.
  // Updates status → Posted, sets the reference, disables all inputs.
  function renderPostedVoucher(d) {
    var postedLines = d.rows || [];
    var postedRef = d.reference || '';
    var dateEl = document.getElementById('entry-date');
    dateEl.disabled = true;
    var jSel = document.getElementById('entry-journal');
    jSel.disabled = true;
    var descEl = document.getElementById('entry-desc');
    descEl.readOnly = true;
    // §3.5: show currency read-only for posted vouchers
    var ccyEl = document.getElementById('entry-ccy');
    if (ccyEl) {
      ccyEl.value = (postedLines[0] && postedLines[0].currency) || BASE_CCY;
      ccyEl.readOnly = true;
    }
    document.querySelector('.header-fields').classList.add('jv-flat-readonly');
    updateStatusBadge('posted');
    setReference(postedRef);
    var body = document.getElementById('lines-body');
    body.innerHTML = '';
    var dr = 0, cr = 0;
    postedLines.forEach(function (l) {
      dr += parseFloat(l.debit || 0); cr += parseFloat(l.credit || 0);
      var tr = document.createElement('tr');
      tr.className = 'jv-view-line';
      tr.innerHTML = '<td>' + esc(l.account_code || '') + ' \u2014 ' + esc(accountsMap[l.account_code] || '') + '</td>'
        + '<td class="num">' + (parseFloat(l.debit || 0) || 0).toFixed(2) + '</td>'
        + '<td class="num">' + (parseFloat(l.credit || 0) || 0).toFixed(2) + '</td>'
        + '<td>' + esc(l.description || '') + '</td>'
        + (VAT_ON ? '<td>' + esc(l.vat_code || '') + '</td>' : '')
        + (VAT_ON ? '<td class="num">' + (parseFloat(l.vat_amount || 0) || 0).toFixed(2) + '</td>' : '')
        + (CENTERS_ON ? '<td>' + esc(l.cost_center || '') + '</td>' : '')
        + (CENTERS_ON ? '<td>' + esc(l.profit_center || '') + '</td>' : '')
        + '<td></td>';
      body.appendChild(tr);
    });
    document.getElementById('total-dr').textContent = dr.toFixed(2);
    document.getElementById('total-cr').textContent = cr.toFixed(2);
    var postedVat = Math.round(postedLines.reduce(function (s, l) { return s + parseFloat(l.vat_amount || 0); }, 0) * 100) / 100;
    var vatEl = document.getElementById('total-vat');
    if (vatEl) vatEl.textContent = postedVat.toFixed(2);
    var diff = Math.round((dr - cr) * 100) / 100;
    var diffEl = document.getElementById('total-diff');
    diffEl.textContent = diff.toFixed(2);
    diffEl.style.color = diff === 0 ? '#2a8a2a' : '#cc2222';
    setCreateControls(false);
    document.getElementById('jv-pre-attach-section').style.display = 'none';
    document.getElementById('jv-attachment-panel').style.display = '';
    jvForm.refresh();
  }

  function initViewMode() {
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'journal.get', companyId: COMPANY, batchId: VIEW_BATCH }) })
      .then(function (r) { return r.json(); })
      .then(function (resp) {
        var lines = resp.data || resp;
        if (!Array.isArray(lines) || !lines.length) { showStatus('Batch not found', true); return; }
        viewBatchLines = lines;
        viewBatchRef = lines[0].reference || '';
        viewBatchDate = lines[0].date ? String(lines[0].date).slice(0, 10) : '';
        viewBatchDesc = lines[0].description || viewBatchRef || '';
        viewBatchReversed = !!lines[0].reversed_by;
        renderViewMode();
        // global-search-spec.md §2.1 — recently-viewed objects for the empty-state
        // dropdown. A bare doc number is meaningless out of context (same gap
        // fixed for search results, search.js's _searchJournals) — echo date/
        // description/amount too so the row is identifiable at a glance.
        if (window.FB && FB.search && FB.search.pushRecent) {
          var recentAmount = 0;
          viewBatchLines.forEach(function (l) { recentAmount += parseFloat(l.debit || 0); });
          var recentBits = ['DOC ' + (viewBatchRef || VIEW_BATCH)];
          if (viewBatchDate) recentBits.push(viewBatchDate);
          if (viewBatchDesc && viewBatchDesc !== viewBatchRef) recentBits.push(viewBatchDesc);
          if (recentAmount) recentBits.push(recentAmount.toFixed(2));
          FB.search.pushRecent({ type: 'journal', id: VIEW_BATCH,
            label: recentBits.join('  '),
            route: '/journal/voucher?batch=' + encodeURIComponent(VIEW_BATCH) });
        }
      })
      .catch(function (e) { showStatus(e.message, true); });
  }

  // Reversal entered from view mode: skip the search panel and populate the
  // swapped rows directly from the already-loaded batch data.
  function toggleViewReversalMode() {
    reversalMode = !reversalMode;
    var btn = document.getElementById('btn-reversal-mode');
    btn.textContent = reversalMode ? '\u2715 Cancel Reversal' : '\u27f2 Reversal';
    btn.style.background = reversalMode ? '#f0e8ff' : '';
    document.getElementById('reversal-panel').style.display = 'none';
    if (reversalMode) {
      var dateEl = document.getElementById('entry-date');
      dateEl.disabled = false;
      document.getElementById('entry-journal').disabled = false;
      document.getElementById('entry-desc').readOnly = false;
      document.querySelector('.header-fields').classList.remove('jv-flat-readonly');
      setCreateControls(true);
      applyReversalLines(VIEW_BATCH, viewBatchRef, viewBatchLines);
    } else {
      renderViewMode();
    }
  }

  // ── Reversal mode ──────────────────────────────────────────────────
  var reversalMode = false;
  var reversalSearchTimer = null;

  // K3: keyboard navigation for reversal results — ArrowUp/Down inside the
  // search input move the highlight (sticky), Enter picks (FB.dropdown
  // contract feel), Esc peels back to NORMAL via the form's general binding.
  var reversalRows = [];
  var revIdx = -1;
  function paintReversal() {
    reversalRows.forEach(function (d, i) { d.style.background = (i === revIdx) ? '#f0f4ff' : ''; });
    if (reversalRows[revIdx] && reversalRows[revIdx].scrollIntoView) reversalRows[revIdx].scrollIntoView({ block: 'nearest' });
  }
  function moveReversal(d) {
    if (!reversalRows.length) return;
    revIdx += d;
    if (revIdx < 0) revIdx = 0;
    if (revIdx > reversalRows.length - 1) revIdx = reversalRows.length - 1;
    paintReversal();
  }
  function pickReversal() {
    if (revIdx >= 0 && reversalRows[revIdx]) reversalRows[revIdx].click();
  }

  function toggleReversalMode() {
    if (VIEW_BATCH && viewBatchLines) return toggleViewReversalMode();
    reversalMode = !reversalMode;
    document.getElementById('reversal-panel').style.display = reversalMode ? '' : 'none';
    document.getElementById('btn-reversal-mode').textContent = reversalMode ? '\u2715 Cancel Reversal' : '\u27f2 Reversal';
    document.getElementById('btn-reversal-mode').style.background = reversalMode ? '#f0e8ff' : '';
    if (!reversalMode) {
      document.getElementById('reversal-search').value = '';
      document.getElementById('reversal-results').style.display = 'none';
      document.getElementById('entry-desc').value = '';
      document.getElementById('lines-body').innerHTML = '';
      addLine(); addLine();
      updateTotals();
    }
  }

  function onReversalSearch(q) {
    clearTimeout(reversalSearchTimer);
    var res = document.getElementById('reversal-results');
    // Min query length 1 (magnus 2026-07-28 — single chars silently showed
    // nothing at min-2; an empty box hides results instead).
    if (q.trim().length < 1) { res.style.display = 'none'; reversalRows = []; revIdx = -1; return; }
    reversalSearchTimer = setTimeout(function() {
      fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action:'journal.search', companyId: COMPANY, q: q.trim() }) })
        .then(r => r.json())
        .then(function(resp) {
          var rows = resp.data || resp;
          res.innerHTML = '';
          if (!Array.isArray(rows) || !rows.length) {
            res.innerHTML = '<div style="padding:8px 12px;color:#888;font-size:10pt">No matching entries</div>';
            res.style.display = '';
            reversalRows = []; revIdx = -1;
            return;
          }
          rows.forEach(function(r) {
            var d = document.createElement('div');
            d.style.cssText = 'padding:8px 12px;cursor:pointer;border-bottom:1px solid #f0f0f0;font-size:10pt';
            var ref = r.reference || r.batch_id;
            var date = r.date ? String(r.date).slice(0,10) : '';
            d.innerHTML = '<span style="font-weight:600">' + ref + '</span>'
              + '<span style="color:#888;margin-left:10px">' + date + '</span>'
              + (r.description ? '<span style="color:#555;margin-left:10px">' + r.description + '</span>' : '');
            d.onmouseenter = function() { d.style.background='#f0f4ff'; };
            d.onmouseleave = function() { d.style.background=''; };
            d.onclick = function() { loadReversalEntry(r.batch_id, ref); };
            res.appendChild(d);
          });
          res.style.display = '';
          reversalRows = Array.from(res.children);
          revIdx = 0;
          paintReversal();
        });
    }, 300);
  }

  function applyReversalLines(batchId, ref, lines) {
    // Set date to today
    var today = new Date();
    var todayStr = today.getFullYear() + '-'
      + String(today.getMonth()+1).padStart(2,'0') + '-'
      + String(today.getDate()).padStart(2,'0');
    var dateEl = document.getElementById('entry-date');
    dateEl.value = '';
    dateEl.value = todayStr;
    dateEl.dispatchEvent(new Event('input'));
    dateEl.dispatchEvent(new Event('change'));
    // Set description
    document.getElementById('entry-desc').value = 'Reversal: ' + ref;
    // Match journal via journal_id already present on the fetched row —
    // no string-parsing, works for old- and new-format reference alike.
    var jId = (lines[0] && lines[0].journal_id) || '';
    if (jId) {
      var jSel = document.getElementById('entry-journal');
      jSel.value = jId;
    }
    // §3.4: pre-fill Currency + FX Rate from the original batch (header-level,
    // uniform across lines per §1.1). Without this, reversing a foreign-
    // currency entry silently drops back to base currency and posts the
    // reversal at fx_rate=1.0 — the exact failure §1.4 exists to prevent.
    var ccy = (lines[0] && lines[0].currency) || BASE_CCY;
    var rate = (lines[0] && lines[0].fx_rate) || null;
    if (document.getElementById('entry-ccy')) document.getElementById('entry-ccy').value = ccy;
    if (ccy !== BASE_CCY && document.getElementById('entry-fx-rate') && rate) {
      document.getElementById('entry-fx-rate').value = rate;
      var frf = document.querySelector('.fx-rate-field');
      if (frf) frf.style.display = '';
    } else if (ccy === BASE_CCY) {
      var frf2 = document.querySelector('.fx-rate-field');
      if (frf2) frf2.style.display = 'none';
    }
    // Clear existing lines and populate reversed
    document.getElementById('lines-body').innerHTML = '';
    // A1 (magnus 2026-07-28): render the ORIGINAL (un-swapped) lines as
    // read-only grayed rows ABOVE the swapped reversal rows, so the
    // reviewer can see what's being reversed at a glance. These rows
    // carry no inputs (plain text <td>s) → inherently read-only,
    // excluded from the lines zone (rows() :not() filter) and from
    // post (postEntry/updateTotals guard rows without inputs).
    var thCount = document.querySelectorAll('.jv-table thead th').length;
    var hdrTr = document.createElement('tr');
    hdrTr.className = 'jv-orig-hdr';
    hdrTr.innerHTML = '<td colspan="' + thCount + '">Original entry (read-only)</td>';
    document.getElementById('lines-body').appendChild(hdrTr);
    lines.forEach(function(l) {
      var otr = document.createElement('tr');
      otr.className = 'jv-orig-line';
      otr.innerHTML = '<td>' + esc(l.account_code || '') + ' \u2014 ' + esc(accountsMap[l.account_code] || '') + '</td>'
        + '<td class="num">' + (parseFloat(l.debit || 0) || 0).toFixed(2) + '</td>'
        + '<td class="num">' + (parseFloat(l.credit || 0) || 0).toFixed(2) + '</td>'
        + '<td>' + esc(l.description || '') + '</td>'
        + (VAT_ON ? '<td></td><td></td>' : '')
        + (CENTERS_ON ? '<td>' + esc(l.cost_center || '') + '</td>' : '')
        + (CENTERS_ON ? '<td>' + esc(l.profit_center || '') + '</td>' : '')
        + '<td></td>';
      document.getElementById('lines-body').appendChild(otr);
    });
    lines.forEach(function(l) {
      var tr = addLine();
      var acctInput = tr.querySelector('.acct-input');
      pickAccount({ code: l.account_code || '', name: accountsMap[l.account_code] || '' }, acctInput);
      var debitIn = tr.querySelector('.debit-input');
      var creditIn = tr.querySelector('.credit-input');
      // Swap debit ↔ credit
      debitIn.value  = parseFloat(l.credit || 0) || '';
      creditIn.value = parseFloat(l.debit  || 0) || '';
      var descIn = tr.querySelector('.desc-input');
      descIn.value = l.description || '';
      // §2: pre-fill cost center + profit center if present on the original line
      var ccIn = tr.querySelector('.cc-input');
      if (ccIn && l.cost_center) ccIn.value = l.cost_center;
      var pcIn = tr.querySelector('.pc-input');
      if (pcIn && l.profit_center) pcIn.value = l.profit_center;
    });
    updateTotals();
    showStatus('Reversal loaded — review and post', false);
    // A2 (magnus 2026-07-28): land the cursor on the header date cell
    // (NORMAL) so the reviewer isn't stranded in the search input.
    // Blur the search + collapse results so the reversal zone rows()
    // is empty and the cursor isn't stuck there; j/k from the date
    // cell moves down into the line grid.
    var rs = document.getElementById('reversal-search');
    if (rs) rs.blur();
    jvForm.moveTo(1, 0, 0, false);
    jvForm.refresh();
  }

  function loadReversalEntry(batchId, ref) {
    document.getElementById('reversal-results').style.display = 'none';
    fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'journal.get', companyId: COMPANY, batchId: batchId }) })
      .then(r => r.json())
      .then(function(resp) {
        var lines = resp.data || resp;
        if (!Array.isArray(lines) || !lines.length) { showStatus('Entry not found', true); return; }
        applyReversalLines(batchId, ref, lines);
      })
      .catch(function(e) { showStatus(e.message, true); });
  }

  function addJvAttachment(input) {
    if (!input.files || !input.files.length) return;
    for (var i = 0; i < input.files.length; i++) pendingJvAttachments.push(input.files[i]);
    input.value = '';
    renderJvPendingList();
  }

  function removeJvAttachment(idx) {
    pendingJvAttachments.splice(idx, 1);
    renderJvPendingList();
  }

  function renderJvPendingList() {
    var el = document.getElementById('jv-pending-list');
    if (!el) return;
    // K4 (updated 2026-09-06): shared .fb-attach-row classes — the queue is a
    // FB.form zone, so j/k paint the cursor row and x deletes (data-att-id =
    // staged index, read by the delete verb). The add row is pinned last,
    // FB.list-style — its button is the zone's only actual cell (see the
    // 'attachments' zone's cells() below), so i/Enter or a click opens the
    // file picker; A is retired.
    el.innerHTML = pendingJvAttachments.map(function(f, i) {
      var kb = (f.size / 1024).toFixed(1);
      return '<div class="fb-attach-row" data-att-id="' + i + '">'
        + '<span class="fb-att-name">\ud83d\udcc4 ' + f.name + ' <span class="fb-att-meta">(' + kb + ' KB)</span></span>'
        + '<button class="fb-att-del" onclick="removeJvAttachment(' + i + ')" title="delete (x)">&times;</button>'
        + '</div>';
    }).join('') + '<div class="fb-attach-row fb-attach-add">'
      + '<button type="button" class="fb-att-add-btn" onclick="document.getElementById(\\'jv-pre-attach-input\\').click()">+ Add attachment</button>'
      + '</div>';
  }

  async function uploadPendingJvAttachments(batchId) {
    if (!pendingJvAttachments.length) return;
    for (var i = 0; i < pendingJvAttachments.length; i++) {
      var fd = new FormData();
      fd.append('companyId', COMPANY);
      fd.append('entityType', 'journal');
      fd.append('entityId', batchId);
      fd.append('file', pendingJvAttachments[i]);
      try { await fetch('/api/upload', { method: 'POST', body: fd }); } catch(e) {}
    }
    pendingJvAttachments = [];
  }

  // ── FB.form (K3, keyboard-ux-spec §8) — the one form machine; this page ──
  // declares config + verbs only. Zones: reversal panel (present only in
  // reversal mode) → header fields → the JV line grid.
  var jvForm = FB.form.create({
    formId: 'journal-voucher',
    zones: [
      { id: 'reversal', rows: function () { return reversalMode ? [document.getElementById('reversal-panel')] : []; } },
      { id: 'header',   rows: function () { return [document.querySelector('.header-fields')]; } },
      // K4 (updated 2026-09-06): the pending-attachment queue is a form zone —
      // j/k reach it, x removes the cursor row via the delete verb. Real
      // attachment rows are cell-less (x deletes them directly, i/Enter is a
      // no-op); the pinned "+ Add attachment" row is the one exception — its
      // button IS the zone's cell, so i/Enter or a click opens the file
      // picker, retiring A as a separate key.
      { id: 'attachments', rows: function () { return Array.from(document.querySelectorAll('#jv-pending-list .fb-attach-row')); },
        cells: function (rowEl) {
          var btn = rowEl.querySelector('.fb-att-add-btn');
          return btn ? [btn] : [];
        } },
      { id: 'lines',    rows: function () { return Array.from(document.querySelectorAll('#lines-body tr:not(.jv-orig-line):not(.jv-orig-hdr)')); } }
    ],
    verbs: {
      add: { key: 'a', hint: 'add line', run: function (api) {
        if (VIEW_BATCH && !reversalMode) return;   // read-only in view mode
        addLine(); updateTotals();
        api.moveTo(3, api.zoneRows(3).length - 1, 0, true);
      } },
      delete: { key: 'x', hint: 'delete',
        when: function (api) { var z = api.cur().z; return z === 2 || z === 3; },
        run: function (api) {
          if (VIEW_BATCH && !reversalMode) return;
          if (api.cur().z === 2) {
            // attachments zone — remove the staged file (K4); the add row
            // has no data-att-id, so this is also its guard against
            // deleting itself.
            var row = api.zoneRows(2)[api.cur().r];
            if (!row || row.classList.contains('fb-attach-add')) return;
            removeJvAttachment(parseInt(row.dataset.attId, 10));
            api.refresh();
            return;
          }
          var tr = api.zoneRows(3)[api.cur().r];
          if (!tr) return;
          tr.remove(); updateTotals(); api.refresh();
        } },
      write: { key: 'w', hint: 'post', run: function () {
        if (VIEW_BATCH && !reversalMode) return;
        var btn = document.getElementById('btn-post');
        if (btn.disabled) { showStatus('Out of balance — see Diff', true); return; }
        postEntry();
      } },
      // No dedicated key any more — Esc in NORMAL invokes this directly
      // (fb-form.js unifies the Esc doctrine: INSERT Esc exits a field edit,
      // NORMAL Esc exits the whole form). 'q' is retired. Reversal mode's own
      // Esc (extraBindings below, cancel-the-reversal) is prepended and wins
      // over this while reversalMode is true — this only fires at rest.
      quit: { hint: 'quit', run: function () {
        var url = FROM_REPORT ? '/' + COMPANY + '/journal?t=' + FROM_REPORT : '/' + COMPANY;
        if (FROM_REPORT && RPT_START && RPT_END) {
          url += '&start=' + encodeURIComponent(RPT_START) + '&end=' + encodeURIComponent(RPT_END);
        }
        fbNavigate(url);
      } }
    },
    extraBindings: function (api) {
      function searchFocused() { return document.activeElement === document.getElementById('reversal-search'); }
      return [
        // A retired (2026-09-06) — the pending-attachment queue's own
        // "+ Add attachment" row (fb-attach-add) now does this job, reached
        // by j/k like any other row and activated by i/Enter/click.
        // x on the header zone starts a reversal (2026-09-06, retires R).
        // Header (z===1) never overlaps the delete verb's own guard
        // (z===2||3, line/attachment rows only), so this can't collide with
        // "delete the focused line" no matter where the cursor is. Guarded
        // on !reversalMode so this is enter-only — once reversing, pressing
        // x on the header again does nothing; Esc is the only way out
        // (below), never a second x.
        { key: 'x', mode: 'NORMAL', hint: 'reversal', hintBar: true,
          when: function () { return !reversalMode && api.cur().z === 1; },
          run: function () {
            toggleReversalMode();
            api.refresh();
            if (reversalMode && !VIEW_BATCH) { var s = document.getElementById('reversal-search'); if (s) s.focus(); }
          } },
        { key: 'ArrowDown', mode: 'INSERT', when: searchFocused, run: function () { moveReversal(1); } },
        { key: 'ArrowUp', mode: 'INSERT', when: searchFocused, run: function () { moveReversal(-1); } },
        // Enter inside the search always stays local (never advances the form)
        { key: 'Enter', mode: 'INSERT', when: searchFocused, run: pickReversal },
        // A3 (magnus 2026-07-28, updated 2026-09-06): Esc contract — INSERT
        // Esc from the search ONLY exits edit → NORMAL (reversal stays
        // active); NORMAL Esc cancels reversal — the only way out, by
        // design (x on the header only ever enters, never toggles off).
        // x-on-header → (INSERT in search) Esc → NORMAL (still active) →
        // Esc → cancels reversal. This extraBinding is prepended ahead of
        // fb-form's own NORMAL-mode Esc (which quits the page via the
        // 'quit' verb), so it wins outright while reversalMode is true;
        // when reversalMode is false its when-guard fails and Esc falls
        // through to that quit binding instead.
        { key: 'Escape', mode: 'INSERT', when: searchFocused, run: function () {
            api.exitEdit();         // blur + NORMAL — reversal stays active
            api.refresh();
          } },
        { key: 'Escape', mode: 'NORMAL', when: function () { return reversalMode; },
          run: function () {
            toggleReversalMode();   // off — resets search/desc/lines
            api.refresh();          // reversal zone emptied → cursor to header
          } }
      ];
    }
  });
  FB.keys.renderHints('journal-voucher', document.getElementById('sb-hints'), { layout: 'list' });
  // Test/introspection handle (read-only): lets the committed regression
  // suite (tests/reversal.mjs) assert cursor zone/mode/reversal state without
  // poking closures. No behavior change.
  window.__jn = {
    cur: function () { return jvForm.cur(); },
    mode: function () { return jvForm.mode(); },
    reversal: function () { return reversalMode; }
  };
<\/script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleJournalVoucherPage };
