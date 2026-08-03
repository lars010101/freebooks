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

// A4 §4.7 — unfold preview. The underlag panel is a child row of each
// posted batch. attachment.list is fetched LAZILY on first unfold and
// cached per entity key; the bare list.render() path (fb-list) re-renders
// the section when the fetch resolves. No new keys/verbs — Enter unfolds
// via the existing tree mechanism; this just adds a child row to that
// unfold. R6: the panel is read-only display.
var _attCache = {}; // entityKey → undefined(unfetched) | '__pending' | Array<att>
function fetchUnderlag(entityKey, entityType, entityId) {
  if (_attCache[entityKey] !== undefined) return;     // fetched or in-flight
  _attCache[entityKey] = '__pending';
  postAction('attachment.list', { entityType: entityType, entityId: entityId })
    .then(function (res) {
      _attCache[entityKey] = (res && Array.isArray(res.data)) ? res.data : [];
      list.render();                                   // bare render preserves cursor
    })
    .catch(function () { _attCache[entityKey] = []; list.render(); });
}
// Render the underlag panel body for an _attSection child. Reuses the shared
// FB.attachments.rowHtml (fb-attachments.js) so the markup matches every other
// attachment surface; each row links to the existing GET /api/attachments/:id
// route (target _blank — same pattern as journal-new.js). attachment.list
// returns uploaded_at; rowHtml expects created_at, so map it.
function underlagPanelHtml(entityKey) {
  var cached = _attCache[entityKey];
  var body;
  if (cached === '__pending' || cached === undefined) {
    body = '<span class="fb-att-empty">Loading source documents\\u2026</span>';
  } else if (!cached.length) {
    body = FB.attachments.emptyHtml('No source documents attached');
  } else {
    body = cached.map(function (a) {
      return FB.attachments.rowHtml({
        attachment_id: a.attachment_id, filename: a.filename,
        file_size: a.file_size, created_at: a.uploaded_at
      });
    }).join('');
  }
  return '<div class="jrnl-att-head">Source documents</div>' + body;
}

// ── Data: posted batches (grouped from journal.list line rows) ──────────────
function fetchRows() {
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
    // Posted batches: underlag re-pointed to entity_type='journal' at approve
    // (A4 §4.7). Show the underlag panel on unfold for BFL 5 kap
    // traceability. Lazy-fetched; no badge on the folded row.
    kids.push({ _key: row._key + ':att', _childOf: row._key, _attSection: 'batch:' + row.batch_id, _attEntityType: 'journal', _attEntityId: row.batch_id });
    fetchUnderlag('batch:' + row.batch_id, 'journal', row.batch_id);
    (row._lines || []).forEach(function (l, i) { kids.push(lineChild(row, l, i)); });
    return kids;
  },
  childRowHtml: function (parent, child) {
    if (child._attSection) return '<td colspan="8" class="jrnl-att">' + underlagPanelHtml(child._attSection) + '</td>';
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
