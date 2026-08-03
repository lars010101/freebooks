'use strict';
/**
 * freeBooks — Inbox (A5 §10: the unified action review queue)
 *
 * One FB.list of action items awaiting a human decision — the human's input
 * channel (the complement of event.list, the agent's). v1 fans out to
 * journal_proposals only (Class A — pre-ledger approvals); Class B types
 * (bills due, bank-import lines, …) slot in per §10.7 as their modules land.
 *
 * This page reuses the §4.4 queue idiom VERBATIM (status-filtered list + y/x
 * row verbs + note-on-reject + Enter-unfold + A4 underlag badge/preview +
 * fb:queue-changed window event), moved here from the Journal list per spec
 * §10 (2026-08-03). The Journal list is now the pure posted register.
 *
 * Data: postAction('inbox.list', { status, limit }) → { items: [...] }.
 *   statusState 'proposed' (default — the queue) | 'rejected' (the graveyard;
 *   void doctrine — rejected stays out of the default view). The list-level
 *   `f` action cycles the filter (framework-native toolbar + key), exactly as
 *   the Journal list did.
 *
 * Group rendering: items group by item.type under a collapsible group header
 * row (label 'Journal proposals' for type journal_proposal, plus count). Header
 * Enter/click folds/unfolds its rows; fold state is client-side per type. v1
 * has one type — the structure is generic so Class B types slot in later.
 *
 * Row verbs (FB.list rowVerbs — fb-list-ux-spec §13):
 *   y = approve (confirm modal: date, line count, total debit, optional note)
 *   x = reject  (required note — the proposer reads it via event.list)
 * Enter unfolds lines read-only (framework openFocused); Esc never writes.
 */

const { commonStyle, navBar, layoutEnd } = require('./common');

async function handleInboxPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildInboxPage(company));
}

function buildInboxPage(company) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Inbox — freeBooks</title>
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
  .st-rejected { background:#f0f0f0; color:#888; }
  /* No .st-posted here — the inbox is the review queue, never the register. */
  #queue-note { margin:0 0 10px; font-size:9.5pt; color:#777; }
  .chip { cursor:pointer; text-decoration:none; }
  /* A5 §10.4 — collapsible group header row. One per item.type (v1: only
     journal_proposal). Muted, like .jrnl-meta; the fold caret lives in the
     actions cell (mouse parity for the Enter key verb). */
  tr.inbx-group td { background:#fafafa; font-weight:700; font-size:9.5pt; color:#444; cursor:pointer; }
  tr.inbx-group td .inbx-grp-count { color:#888; font-weight:600; font-size:8.5pt; margin-left:6px; }
  /* A4 §4.7 — underlag (source-document) count badge + no-underlag warning.
     Folded PROPOSED rows carry the count beside the status badge (the row's
     existing badge idiom — .st-badge sizing). Zero attachments render a
     visible "no underlag" warning marker so the reviewer cannot miss the gap
     (R7 warn-not-block). Rejected/posted rows show no underlag badge. */
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
<body>${navBar(company, 'inbox')}
<div class="page">
  <div class="header">
    <div>
      <h1>Inbox</h1>
      <p class="sub">${company} · review queue</p>
    </div>
  </div>

  <p id="queue-note"></p>

  <table class="jrnl-table">
    <thead>
      <tr>
        <th>Date</th><th>Reference</th><th>Description</th>
        <th style="text-align:right">Amount</th><th>Source</th><th>Proposed by</th><th>Status</th><th></th>
      </tr>
    </thead>
    <tbody id="jrnl-tbody"></tbody>
  </table>
</div>

<script>
var COMPANY = ${JSON.stringify(company)};

// Queue status filter: 'proposed' (default — the queue) | 'rejected'
// (explicit filter view; void doctrine — spec §4.4/§10.4). Rejected rows stay
// out of the default view, same doctrine as void.
var statusState = 'proposed';

// Group fold state — client-side per item.type (A5 §10.4). v1 has one type
// (journal_proposal); the map is generic so Class B types slot in later.
// Absent key = UNFOLDED (the default — the queue's rows are visible).
var groupFold = {};

// Human-readable group labels per item.type. Class B types add entries here
// as their modules land (§10.7). Unknown types fall back to the raw type.
var GROUP_LABELS = {
  journal_proposal: 'Journal proposals'
};

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
  if (s === 'rejected') return '<span class="st-badge st-rejected" title="' + esc(row.review_note || '') + '\">Rejected</span>';
  return ''; // inbox is the review queue — no posted badge here
}

// A4 §4.7 — folded-row underlag indicator. Only PROPOSED items carry it (the
// review surface); rejected items show nothing. attachment_count > 0 → "📎 N"
// count badge; 0 → a visible "no underlag" warning marker (R7: warn-not-block
// — the reviewer must not miss the gap, but the proposal is still approvable).
function underlagBadge(row) {
  if (row._kind !== 'proposal' || row.status !== 'proposed') return '';
  var n = Number(row.attachment_count || 0);
  if (n > 0) return '<span class="ul-badge" title="' + n + ' underlag attached\">\\uD83D\\uDCCE ' + n + '</span>';
  return '<span class="ul-warn" title=\"No source document (underlag) attached — egen verifikation permitted (BFL 5 kap)\">no underlag</span>';
}

// A4 §4.7 — unfold preview. The underlag panel is a child row of each
// PROPOSED item. attachment.list is fetched LAZILY on first unfold (the queue
// is a review surface, not every item needs its underlag on load) and cached
// per proposalId; the bare list.render() path re-renders the section when the
// fetch resolves. No new keys/verbs — Enter unfolds via the existing tree
// mechanism; this just adds a child row to that unfold. R6: the panel is
// read-only display; the existing y/x flow is untouched.
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
// route (target _blank). attachment.list returns uploaded_at; rowHtml expects
// created_at, so map it.
function underlagPanelHtml(proposalId) {
  var cached = _attCache[proposalId];
  var body;
  if (cached === '__pending' || cached === undefined) {
    body = '<span class="fb-att-empty">Loading underlag\\u2026</span>';
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

// ── Data: inbox.list (Class A — journal_proposals; Class B types append per
//    module as they land, §10.7). Each item is enriched with its parsed lines
//    via journal.proposal.get so unfold and the approve modal are synchronous.
//    The Object.assign merge keeps the list row's attachment_count (the get
//    response does not carry it — §4.7). The cache holds the flat item list;
//    buildRows() interleaves group headers and folds per type. ──────────────
var _cache = null;      // Array<item> | null (null = stale → re-fetch)
function fetchRows() {
  if (_cache) return Promise.resolve(buildRows(_cache));
  return postAction('inbox.list', { status: statusState, limit: 100 })
    .then(function (res) {
      var items = (res && res.data && Array.isArray(res.data.items)) ? res.data.items : [];
      // Enrich each item with its parsed lines (children + modal summary).
      // The queue is small; one get per row pre-warms the children cache so
      // unfold and the approve modal are synchronous afterwards.
      return Promise.all(items.map(function (it) {
        return postAction('journal.proposal.get', { proposalId: it.payload_ref })
          .then(function (g) {
            var d = (g && g.data) || {};
            if (!Array.isArray(d.lines)) d.lines = [];
            // Merge onto the item: getProposal has the lines but NOT the A4
            // attachment_count — the item carries it (§4.7 badge).
            return Object.assign(it, d);
          })
          .catch(function () { it.lines = []; return it; });
      }));
    })
    .then(function (enriched) { _cache = enriched; return buildRows(enriched); });
}

// Group items by item.type under a collapsible group header row. v1 has one
// type (journal_proposal); the loop is generic so Class B types slot in. Fold
// state is per type (groupFold); a folded group emits its header only.
function buildRows(items) {
  var order = [], byType = {};
  items.forEach(function (it) {
    var t = it.type || 'unknown';
    if (!byType[t]) { byType[t] = []; order.push(t); }
    byType[t].push(mapItem(it));
  });
  var out = [];
  order.forEach(function (t) {
    var folded = !!groupFold[t];
    out.push(groupHeader(t, byType[t].length, folded));
    if (!folded) out = out.concat(byType[t]);
  });
  return out;
}

function groupHeader(type, count, folded) {
  return {
    _key: 'group:' + type, _kind: 'group', _groupType: type,
    _groupLabel: GROUP_LABELS[type] || type, _groupCount: count, _folded: folded
  };
}

function mapItem(it) {
  var lines = Array.isArray(it.lines) ? it.lines : [];
  var dr = 0, cr = 0;
  lines.forEach(function (l) { dr += Number(l.debit || 0); cr += Number(l.credit || 0); });
  return {
    _key: 'prop:' + it.payload_ref, _kind: 'proposal',
    proposal_id: it.payload_ref,
    type: it.type,
    date: it.date, reference: it.reference || '',
    description: it.description || it.summary || '',
    amount: it.amount,
    lineCount: lines.length, totalDebit: Math.round(dr * 100) / 100, totalCredit: Math.round(cr * 100) / 100,
    source: it.source || 'agent', status: it.status,
    created_by: it.created_by || '', request_id: it.request_id || '',
    reviewed_by: it.reviewed_by || '', review_note: it.review_note || '',
    currency: lines.length ? (lines[0].currency || '') : '',
    // A4 §4.7: per-item attachment_count (inbox.list join) drives the folded
    // underlag badge / no-underlag warning marker.
    attachment_count: Number(it.attachment_count || 0),
    _lines: lines
  };
}

function lineChild(row, l, i) {
  return {
    _key: row._key + ':L' + i, _childOf: row._key,
    account_code: l.account_code || '', description: l.description || '',
    debit: l.debit || 0, credit: l.credit || 0
  };
}

// ── Group fold toggle (header Enter/click — A5 §10.4) ───────────────────────
function toggleGroupFold(row) {
  if (!row || row._kind !== 'group') return;
  groupFold[row._groupType] = !groupFold[row._groupType];
  list.render();   // cache stays valid — buildRows re-reads groupFold
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
              _cache = null;          // invalidate → re-fetch on next load
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
  _cache = null;             // status changed → re-fetch
  FB.status.show('Queue filter: ' + statusState, false);
  list.load();
}

// ── The queue (one FB.list; grouped; tree unfold everywhere) ────────────────
var list = FB.list.create({
  keysId: 'inbox',
  tbody: 'jrnl-tbody',
  companyId: function () { return COMPANY; },
  tree: true,
  canAdd: false,
  editable: function () { return false; },   // review is accept-or-reject; no in-place edit
  columns: [
    { field: 'date', filterType: 'date', label: 'Date',
      display: function (v, r) {
        if (r._kind === 'group') return '<span>' + esc(r._groupLabel) + '</span>'
          + '<span class="inbx-grp-count">' + r._groupCount + '</span>';
        return '<span style="white-space:nowrap">' + fmtDate(v) + '</span>';
      } },
    { field: 'reference', filterType: 'text', label: 'Reference',
      display: function (v, r) { return r._kind === 'group' ? '' : (v != null && v !== '' ? esc(String(v)) : '<span class="pe-ro">—</span>'); } },
    { field: 'description', filterType: 'text', label: 'Description',
      display: function (v, r) { return r._kind === 'group' ? '' : (v != null && v !== '' ? esc(String(v)) : '<span class="pe-ro">—</span>'); } },
    { field: 'amount', align: 'right', filterType: 'amount', label: 'Amount',
      display: function (v, r) { return r._kind === 'group' ? '' : fmtAmt(r.amount); } },
    { field: 'source', filterType: 'list', label: 'Source',
      display: function (v, r) { return r._kind === 'group' ? '' : (v != null && v !== '' ? esc(String(v)) : '<span class="pe-ro">—</span>'); } },
    { field: 'created_by', filterType: 'text', label: 'Proposed by',
      display: function (v, r) { return r._kind === 'group' ? '' : (v != null && v !== '' ? esc(String(v)) : '<span class="pe-ro">—</span>'); } },
    { field: 'status', filterType: 'list', label: 'Status',
      display: function (v, r) { return r._kind === 'group' ? '' : (statusBadge(r) + underlagBadge(r)); } }
  ],
  list: { fetch: fetchRows, map: function (row) { return row; } },
  rowStyle: function (r) { return r._kind === 'group' ? 'background:#fafafa' : ''; },
  // Children resolve synchronously: item lines were enriched at load. An item's
  // first child is the muted meta line (proposer + request id / rejection
  // triple); a PROPOSED item also gets the A4 underlag preview child row.
  children: function (row) {
    if (row._kind === 'group') return [];
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
      + '<td colspan="3"></td><td></td>';
  },
  rowVerbs: [
    // A5 §10.4 — group header fold (Enter/click). Prepended ahead of the
    // built-in tree Enter (openFocused); the when-guard declines on item rows
    // so Enter keeps its unfold meaning there.
    { key: 'Enter', label: 'fold group',
      when: function (row) { return row._kind === 'group'; },
      affordance: function (r) { return '<a class="chip" title="fold/unfold group (Enter)" data-act="verb:Enter">' + (r._folded ? '&#9656;' : '&#9662;') + '</a>'; },
      run: function (api, row) { toggleGroupFold(row); } },
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
    var items = saved.filter(function (r) { return r._kind === 'proposal'; });
    if (statusState === 'proposed') {
      note.textContent = items.length === 0
        ? 'Nothing to review — agent-proposed journal batches will appear here'
        : items.length + ' proposed batch' + (items.length === 1 ? '' : 'es') + ' awaiting review (y approve · x reject · Enter unfold)';
    } else {
      note.textContent = 'Rejected proposals (' + items.length + ') — f returns to the queue';
    }
  },
  hint: 'Inbox: action items awaiting review, grouped by type (y approve, x reject, Enter unfolds lines, Enter on a group header folds it). f toggles the rejected graveyard.'
});

list.load();
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleInboxPage };
