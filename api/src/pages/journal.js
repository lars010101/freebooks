'use strict';
/**
 * freeBooks — Journal register (A3j §4.4: the review queue lives here)
 *
 * One FB.list register: agent/human-proposed journal batches (status
 * PROPOSED, pinned on top, then date desc) above posted batches (grouped
 * client-side from journal.list line rows). Read-only register — posted
 * lines are immutable (reversal is the edit path) and proposals are never
 * edited in place (the proposer owns pre-approval edits via journal.propose
 * upsert; a human who wants changes rejects with a note).
 *
 * Row verbs (FB.list rowVerbs — fb-list-ux-spec §13):
 *   y = approve (confirm modal: date, line count, total debit, optional note)
 *   x = reject  (required note — the proposer reads it via event.list)
 * Enter unfolds lines read-only (framework openFocused); Esc never writes.
 * The `f` list-level action cycles the queue status filter (proposed ↔
 * rejected) — rejected rows stay out of the default view (void doctrine).
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
  .st-proposed { background:#fef3c7; color:#92400e; }
  .st-posted { background:#e8f5e9; color:#2e7d32; }
  .st-rejected { background:#f0f0f0; color:#888; }
  #queue-note { margin:0 0 10px; font-size:9.5pt; color:#777; }
  .chip { cursor:pointer; text-decoration:none; }
  /* A4 §4.7 — underlag (source-document) count badge + no-underlag warning.
     Folded PROPOSED rows carry the count beside the status badge (the row's
     existing badge idiom — .st-badge sizing). Zero attachments render a
     visible "no underlag" warning marker so the reviewer cannot miss the gap
     (R7 warn-not-block). Posted batches show no underlag badge. */
  .ul-badge { display:inline-block; margin-left:6px; padding:1px 7px; border-radius:9px;
    font-size:8.5pt; font-weight:600; background:#eef2ff; color:#3730a3; white-space:nowrap; }
  .ul-warn  { display:inline-block; margin-left:6px; padding:1px 7px; border-radius:9px;
    font-size:8.5pt; font-weight:700; background:#fee2e2; color:#b91c1c; white-space:nowrap;
    border:1px solid #fca5a5; }
  /* Unfold preview (§4.7): the underlag panel renders as a child row holding
     shared fb-attachments rows (FB.attachments.rowHtml), each linking to the
     existing GET /api/attachments/:id route. */
  tr[data-child-of] td.jrnl-att { background:#fafafa; padding:6px 10px; }
  .jrnl-att-head { font-size:8.5pt; font-weight:700; text-transform:uppercase; letter-spacing:.03em;
    color:#555; margin:0 0 4px; }
  .jrnl-att .fb-attach-row { padding:3px 0; }
  .jrnl-att .fb-att-empty { color:#aaa; font-size:9pt; font-style:italic; }
</style>
</head>
<body>${navBar(company, 'journal')}
<div class="page">
  <div class="header">
    <div>
      <h1>Journal</h1>
      <p class="sub">${company} · register + review queue</p>
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

// Queue status filter: 'proposed' (default — the queue) | 'rejected'
// (explicit filter view; void doctrine — spec §4.4). Posted proposals leave
// this table as ordinary posted batches (the register below).
var statusState = 'proposed';

function postAction(action, body, idemKey) {
  var headers = { 'Content-Type': 'application/json' };
  // Phase A hardening: optional Idempotency-Key so a retried confirm replays
  // the stored response instead of double-posting.
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
  var s = row.status || '';
  if (s === 'proposed') return '<span class="st-badge st-proposed">Proposed</span>';
  if (s === 'rejected') return '<span class="st-badge st-rejected" title="' + esc(row.review_note || '') + '">Rejected</span>';
  return '<span class="st-badge st-posted">Posted</span>';
}

// A4 §4.7 — folded-row underlag indicator. Only PROPOSED proposals carry it
// (the review surface); posted batches show nothing. attachment_count > 0 →
// "📎 N" count badge; 0 → a visible "no underlag" warning marker (R7: warn-
// not-block — the reviewer must not miss the gap, but the proposal is still
// approvable).
function underlagBadge(row) {
  if (row._kind !== 'proposal' || row.status !== 'proposed') return '';
  var n = Number(row.attachment_count || 0);
  if (n > 0) return '<span class="ul-badge" title="' + n + ' underlag attached">\uD83D\uDCCE ' + n + '</span>';
  return '<span class="ul-warn" title="No source document (underlag) attached — egen verifikation permitted (BFL 5 kap)">no underlag</span>';
}

// A4 §4.7 — unfold preview. The underlag panel is a child row of each
// PROPOSED proposal. attachment.list is fetched LAZILY on first unfold (the
// queue is a review surface, not every proposal needs its underlag on load)
// and cached per proposalId; the bare list.render() path (fb-list) re-renders
// the section when the fetch resolves. No new keys/verbs — Enter unfolds via
// the existing tree mechanism; this just adds a child row to that unfold.
// R6: the panel is read-only display; the existing y/x flow is untouched.
var _attCache = {}; // proposalId → undefined(unfetched) | '__pending' | Array<att>
function fetchUnderlag(proposalId) {
  if (_attCache[proposalId] !== undefined) return;     // fetched or in-flight
  _attCache[proposalId] = '__pending';
  postAction('attachment.list', { entityType: 'journal_proposal', entityId: proposalId })
    .then(function (res) {
      _attCache[proposalId] = (res && Array.isArray(res.data)) ? res.data : [];
      list.render();                                   // bare render preserves cursor
    })
    .catch(function () { _attCache[proposalId] = []; list.render(); });
}
// Render the underlag panel body for an _attSection child. Reuses the shared
// FB.attachments.rowHtml (fb-attachments.js) so the markup matches every other
// attachment surface; each row links to the existing GET /api/attachments/:id
// route (target _blank — same pattern as journal-new.js). attachment.list
// returns uploaded_at; rowHtml expects created_at, so map it.
function underlagPanelHtml(proposalId) {
  var cached = _attCache[proposalId];
  var body;
  if (cached === '__pending' || cached === undefined) {
    body = '<span class="fb-att-empty">Loading underlag\u2026</span>';
  } else if (!cached.length) {
    body = FB.attachments.emptyHtml('No underlag attached');
  } else {
    body = cached.map(function (a) {
      return FB.attachments.rowHtml({
        attachment_id: a.attachment_id, filename: a.filename,
        file_size: a.file_size, created_at: a.uploaded_at
      });
    }).join('');
  }
  return '<div class="jrnl-att-head">Underlag</div>' + body;
}

// ── Data: proposals (queue) + posted batches (grouped from line rows) ──────
function fetchRows() {
  var propReq = postAction('journal.proposal.list', { status: statusState, limit: 100 })
    .then(function (res) {
      var rows = (res && res.data) || [];
      // Enrich each proposal with its parsed lines (children + modal summary).
      // The queue is small; one get per row pre-warms the children cache so
      // unfold and the approve modal are synchronous afterwards.
      return Promise.all(rows.map(function (p) {
        return postAction('journal.proposal.get', { proposalId: p.proposal_id })
          .then(function (g) {
            var d = (g && g.data) || {};
            if (!Array.isArray(d.lines)) d.lines = [];
            // Merge onto the list row: getProposal has the lines but NOT the
            // A4 attachment_count — the list row carries it (§4.7 badge).
            return Object.assign(p, d);
          })
          .catch(function () { p.lines = []; return p; });
      }));
    });
  var postedReq = postAction('journal.list', { limit: 500, sortBy: 'date', sortDir: 'DESC' })
    .then(function (res) { return (res && res.data) || []; });
  return Promise.all([propReq, postedReq]).then(function (rs) {
    var proposals = rs[0].map(mapProposal);      // pinned above posted (already date desc from the action)
    var batches = groupBatches(rs[1]);           // journal.list is date DESC
    return proposals.concat(batches);
  });
}

function mapProposal(p) {
  var lines = Array.isArray(p.lines) ? p.lines : [];
  var dr = 0, cr = 0;
  lines.forEach(function (l) { dr += Number(l.debit || 0); cr += Number(l.credit || 0); });
  return {
    _key: 'prop:' + p.proposal_id, _kind: 'proposal',
    proposal_id: p.proposal_id,
    date: p.date, reference: p.reference || '', description: p.description || '',
    lineCount: lines.length, totalDebit: Math.round(dr * 100) / 100, totalCredit: Math.round(cr * 100) / 100,
    source: p.source || 'agent', status: p.status,
    created_by: p.created_by || '', request_id: p.request_id || '',
    reviewed_by: p.reviewed_by || '', review_note: p.review_note || '',
    currency: lines.length ? (lines[0].currency || '') : '',
    // A4 §4.7: per-row attachment_count from journal.proposal.list (stage 1+2
    // join) drives the folded underlag badge / no-underlag warning marker.
    attachment_count: Number(p.attachment_count || 0),
    _lines: lines
  };
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

// ── Approve / reject (row verbs — the queue idiom, spec §4.4–4.5) ──────────
function review(row, verdict) {
  var approve = verdict === 'approve';
  // Phase A hardening: one Idempotency-Key per modal open = a retried confirm
  // replays the stored response instead of double-posting. The inFlight flag
  // guards the button between the click and the first response so a double-tap
  // cannot fire two concurrent requests (the second would race the first).
  var idemKey = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('rev-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  var inFlight = false;
  FB.modal.open({
    title: (approve ? 'Approve' : 'Reject') + ' proposed journal batch',
    body: '<div style="font-size:10pt;color:#333;line-height:1.7">'
      + '<div><b>Date:</b> ' + fmtDate(row.date) + '</div>'
      + '<div><b>Lines:</b> ' + row.lineCount + ' &nbsp; <b>Total debit:</b> ' + Number(row.totalDebit).toFixed(2) + (row.currency ? ' ' + esc(row.currency) : '') + '</div>'
      + (row.reference ? '<div><b>Reference:</b> ' + esc(row.reference) + '</div>' : '')
      + (row.description ? '<div><b>Description:</b> ' + esc(row.description) + '</div>' : '')
      + '<div style="margin-top:6px;color:#777;font-size:9pt">Proposed by ' + esc(row.created_by || '?')
      + (row.request_id ? ' · req ' + esc(row.request_id) : '') + '</div>'
      + '</div>',
    noteInput: {
      required: !approve,
      label: approve ? 'Note (optional)' : 'Note (required — the proposer reads this via event.list)',
      placeholder: approve ? 'Optional review note' : 'Why is this batch rejected?'
    },
    buttons: [
      { label: approve ? 'Approve' : 'Reject', primary: approve, danger: !approve,
        requiresConfirm: true, key: 'Enter', hint: approve ? 'approve' : 'reject',
        onClick: function (mapi) {
          if (inFlight) return; inFlight = true;
          var note = mapi.confirmValue();
          postAction('journal.' + verdict, { proposalId: row.proposal_id, note: (note && note.trim()) || undefined }, idemKey)
            .then(function (res) {
              if (!res || res.ok === false || res.error) {
                inFlight = false;
                mapi.error((res && res.error && res.error.message) || 'Request failed'); return;
              }
              var d = res.data || {};
              mapi.close();
              FB.status.show(approve
                ? 'Approved — posted ' + (d.reference || d.batchId || '')
                : 'Proposal rejected', false);
              window.dispatchEvent(new Event('fb:queue-changed'));
              list.load();
            })
            .catch(function (e) { inFlight = false; mapi.error(e.message); });
        } },
      { label: 'Cancel', onClick: function (mapi) { mapi.close(); } }
    ],
    onCancel: function () {} // Esc/backdrop — never writes
  });
}

function cycleStatusFilter() {
  statusState = statusState === 'proposed' ? 'rejected' : 'proposed';
  FB.status.show('Queue filter: ' + statusState, false);
  list.load();
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
      display: function (v, r) { return statusBadge(r) + underlagBadge(r); } }
  ],
  list: { fetch: fetchRows, map: function (row) { return row; } },
  // Children resolve synchronously: proposal lines were enriched at load,
  // posted batches were grouped at load. A proposal's first child is the
  // muted meta line (proposer + request id / rejection triple).
  children: function (row) {
    var kids = [];
    if (row._kind === 'proposal') {
      var meta = row.status === 'rejected'
        ? 'Rejected by ' + (row.reviewed_by || '?') + (row.review_note ? ' — ' + row.review_note : '')
        : 'Proposed by ' + (row.created_by || '?') + (row.request_id ? ' · req ' + row.request_id : '');
      kids.push({ _key: row._key + ':meta', _childOf: row._key, _meta: meta });
      // A4 §4.7: underlag unfold preview — a child row holding the bound
      // attachments. Lazy-fetched on first unfold (see fetchUnderlag).
      if (row.status === 'proposed') {
        kids.push({ _key: row._key + ':att', _childOf: row._key, _attSection: row.proposal_id });
        fetchUnderlag(row.proposal_id);
      }
    }
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
  rowVerbs: [
    { key: 'y', label: 'approve',
      when: function (row) { return row._kind === 'proposal' && row.status === 'proposed'; },
      affordance: function () { return '<a class="chip chip-ok" title="approve (y)" data-act="verb:y">✓</a>'; },
      run: function (api, row) { review(row, 'approve'); } },
    { key: 'x', label: 'reject',
      when: function (row) { return row._kind === 'proposal' && row.status === 'proposed'; },
      affordance: function () { return '<a class="chip chip-cancel" title="reject (x)" data-act="verb:x">✕</a>'; },
      run: function (api, row) { review(row, 'reject'); } }
  ],
  actions: [
    { key: 'f', label: 'filter: ' + 'proposed↔rejected', handler: function () { cycleStatusFilter(); } }
  ],
  onLoaded: function (saved) {
    var note = document.getElementById('queue-note');
    var proposals = saved.filter(function (r) { return r._kind === 'proposal'; });
    if (statusState === 'proposed') {
      note.textContent = proposals.length === 0
        ? 'Nothing to review — agent-proposed journal batches will appear here'
        : proposals.length + ' proposed batch' + (proposals.length === 1 ? '' : 'es') + ' awaiting review (y approve · x reject · Enter unfold)';
    } else {
      note.textContent = 'Rejected proposals (' + proposals.length + ') — f returns to the queue';
    }
  },
  hint: 'Journal register: proposed batches pinned on top (y approve, x reject, Enter unfolds lines). f toggles rejected view.'
});

list.load();
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleJournalPage };
