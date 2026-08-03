'use strict';
/**
 * freeBooks — Journal register
 *
 * The posted journal register: posted batches grouped client-side from
 * journal.list line rows (date DESC). Read-only — posted lines are immutable
 * (reversal is the edit path).
 *
 * The review queue (agent-proposed batches: status filter, y/x approve-reject
 * verbs, the nav badge, the A4 underlag badge/preview) moved to the unified
 * Inbox at /:company/inbox per spec §10 (2026-08-03). This page is the pure
 * posted register; Enter unfolds a batch's lines read-only (framework
 * openFocused); Esc never writes.
 */

const { commonStyle, navBar, layoutEnd } = require('./common');

async function handleJournalPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildJournalPage(company));
}

function buildJournalPage(company) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Journal — freeBooks</title>
${commonStyle()}
<style>
  table.jrnl-table { width:100%; border-collapse:collapse; font-size:10pt; }
  table.jrnl-table th { text-align:left; font-size:9pt; text-transform:uppercase; color:#555; border-bottom:1px solid #ccc; padding:6px 6px; }
  table.jrnl-table td { padding:4px 6px; border-bottom:1px solid #f0f0f0; vertical-align:middle; }
  .amt { text-align:right; font-variant-numeric:tabular-nums; }
  .jrnl-meta td, td.jrnl-meta { color:#888; font-size:8.5pt; font-style:italic; background:#fafafa; }
  tr[data-child-of] td { background:#fcfcfc; font-size:9.5pt; color:#333; }
  .st-badge { display:inline-block; padding:1px 8px; border-radius:9px; font-size:8.5pt; font-weight:600; text-transform:uppercase; letter-spacing:.02em; }
  .st-posted { background:#e8f5e9; color:#2e7d32; }
  #queue-note { margin:0 0 10px; font-size:9.5pt; color:#777; }
</style>
</head>
<body>${navBar(company, 'journal')}
<div class="page">
  <div class="header">
    <div>
      <h1>Journal</h1>
      <p class="sub">${company} · posted register</p>
    </div>
  </div>

  <p id="queue-note"></p>

  <table class="jrnl-table">
    <thead>
      <tr>
        <th>Date</th><th>Reference</th><th>Description</th>
        <th style="text-align:right">Debit</th><th style="text-align:right">Credit</th>
        <th>Source</th><th>Status</th><th></th>
      </tr>
    </thead>
    <tbody id="jrnl-tbody"></tbody>
  </table>
</div>

<script>
var COMPANY = ${JSON.stringify(company)};

function postAction(action, body, idemKey) {
  var headers = { 'Content-Type': 'application/json' };
  if (idemKey) headers['Idempotency-Key'] = idemKey;
  return fetch('/api/action', {
    method: 'POST', headers: headers,
    body: JSON.stringify(Object.assign({ action: action, companyId: COMPANY }, body))
  }).then(function (r) { return r.json(); });
}

function fmtAmt(v) {
  var n = Number(v || 0);
  return n ? '<span class="amt">' + n.toFixed(2) + '</span>' : '';
}
function fmtDate(v) { return esc(String(v || '').slice(0, 10)); }

function statusBadge(row) {
  return '<span class="st-badge st-posted">Posted</span>';
}

// ── Data: posted batches (grouped from journal.list line rows) ──────────────
function fetchRows() {
  return postAction('journal.list', { limit: 500, sortBy: 'date', sortDir: 'DESC' })
    .then(function (res) { return groupBatches((res && res.data) || []); });
}

function groupBatches(lines) {
  var order = [], byBatch = {};
  lines.forEach(function (l) {
    var b = l.batch_id || ('row-' + (l.entry_id || Math.random()));
    if (!byBatch[b]) { byBatch[b] = []; order.push(b); }
    byBatch[b].push(l);
  });
  return order.map(function (b) {
    var ls = byBatch[b];
    var dr = 0, cr = 0, ref = '', desc = '', src = '';
    ls.forEach(function (l) {
      dr += Number(l.debit || 0); cr += Number(l.credit || 0);
      if (!ref && l.reference) ref = l.reference;
      if (!desc && l.description) desc = l.description;
      if (!src && l.source) src = l.source;
    });
    return {
      _key: 'batch:' + b, _kind: 'batch', batch_id: b,
      date: ls[0].date, reference: ref, description: desc,
      lineCount: ls.length, totalDebit: Math.round(dr * 100) / 100, totalCredit: Math.round(cr * 100) / 100,
      source: src, status: 'posted', _lines: ls
    };
  });
}

function lineChild(row, l, i) {
  return {
    _key: row._key + ':L' + i, _childOf: row._key,
    account_code: l.account_code || '', description: l.description || '',
    debit: l.debit || 0, credit: l.credit || 0
  };
}

// ── The register (one FB.list; read-only; tree unfold everywhere) ──────────
var list = FB.list.create({
  keysId: 'journal',
  tbody: 'jrnl-tbody',
  companyId: function () { return COMPANY; },
  tree: true,
  canAdd: false,
  editable: function () { return false; },   // register — reversal is the edit path
  columns: [
    { field: 'date', filterType: 'date', label: 'Date',
      display: function (v) { return '<span style="white-space:nowrap">' + fmtDate(v) + '</span>'; } },
    { field: 'reference', filterType: 'text', label: 'Reference' },
    { field: 'description', filterType: 'text', label: 'Description' },
    { field: 'totalDebit', align: 'right', filterType: 'amount', label: 'Debit',
      display: function (v) { return fmtAmt(v); } },
    { field: 'totalCredit', align: 'right', filterType: 'amount', label: 'Credit',
      display: function (v) { return fmtAmt(v); } },
    { field: 'source', filterType: 'list', label: 'Source' },
    { field: 'status', filterType: 'list', label: 'Status',
      display: function (v, r) { return statusBadge(r); } }
  ],
  list: { fetch: fetchRows, map: function (row) { return row; } },
  // Children resolve synchronously: posted batches were grouped at load. A
  // batch's first child is the muted meta line (batch id).
  children: function (row) {
    var kids = [];
    kids.push({ _key: row._key + ':meta', _childOf: row._key, _meta: 'Batch ' + esc(row.batch_id || '') });
    (row._lines || []).forEach(function (l, i) { kids.push(lineChild(row, l, i)); });
    return kids;
  },
  childRowHtml: function (parent, child) {
    if (child._meta) return '<td colspan="7" class="jrnl-meta">' + esc(child._meta) + '</td><td></td>';
    return '<td></td>'
      + '<td>' + esc(child.account_code) + '</td>'
      + '<td>' + esc(child.description) + '</td>'
      + '<td class="amt">' + fmtAmt(child.debit) + '</td>'
      + '<td class="amt">' + fmtAmt(child.credit) + '</td>'
      + '<td colspan="2"></td><td></td>';
  },
  onLoaded: function (saved) {
    var note = document.getElementById('queue-note');
    note.textContent = saved.length === 0
      ? 'No posted batches — the register is empty'
      : saved.length + ' posted batch' + (saved.length === 1 ? '' : 'es') + ' (Enter unfolds lines)';
  },
  hint: 'Journal register: posted batches (Enter unfolds lines). Review queue moved to the Inbox (g i).'
});

list.load();
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleJournalPage };
