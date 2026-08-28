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
 * Space/click folds/unfolds its rows (magnus 2026-08-28: Space-only, see
 * below — was Enter/click); fold state is client-side per type. v1
 * has one type — the structure is generic so Class B types slot in later.
 *
 * Row verbs (FB.list rowVerbs — fb-list-ux-spec §13):
 *   w = approve (confirm modal: date, line count, total debit, optional note;
 *       moved off `y` 2026-08-28 — same "commit" key as everywhere else)
 *   x = reject  (required note — the proposer reads it via event.list)
 *   Enter = open bill (Class B bill-due rows only — moved off `o`)
 * Space unfolds a proposal's lines read-only; Enter is a no-op on proposal
 * rows (nothing to edit or open there — magnus 2026-08-28, was "Enter
 * unfolds", duplicating Space). Esc never writes.
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
  /* Class B bill-due badges (§10.7 item 4). Overdue = red (urgent); Due = amber. */
  .st-overdue { background:#fee2e2; color:#b91c1c; border:1px solid #fca5a5; }
  .st-due     { background:#fef3c7; color:#92400e; }
  /* Per-row type glyph (§10.4): muted prefix in the Date column so a row
     keeps its type context when the group header scrolls away. */
  .inbx-type-glyph { font-size:10pt; margin-right:4px; opacity:.6; }
  #queue-note { margin:0 0 10px; font-size:9.5pt; color:#777; }
  .chip { cursor:pointer; text-decoration:none; }
  /* A5 §10.4 — collapsible group header row. One per item.type (v1: only
     journal_proposal). Muted, like .jrnl-meta; the fold caret lives in the
     actions cell (mouse parity for the Enter key verb). */
  tr.inbx-group td { background:#fafafa; font-weight:700; font-size:9.5pt; color:#444; cursor:pointer; }
  tr.inbx-group td .inbx-grp-count { color:#888; font-weight:600; font-size:8.5pt; margin-left:6px; }
  /* A4 §4.7 — source-document count badge + no-source-document warning.
     Folded PROPOSED rows carry the count beside the status badge (the row's
     existing badge idiom — .st-badge sizing). Zero attachments render a
     visible ⚠️ warning icon so the reviewer cannot miss the gap
     (R7 warn-not-block). Rejected/posted rows show no badge. */
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
        <th style="text-align:right">Amount</th><th>Source</th><th>Created by</th><th>Status</th><th></th>
      </tr>
    </thead>
    <tbody id="jrnl-tbody"></tbody>
  </table>
</div>

<script>
var COMPANY = ${JSON.stringify(company)};

// Queue status filter: 'proposed' (default — Class A queue) | 'rejected'
// (graveyard) | 'bills' (Class B — bills due/overdue, §10.2: "a filter/section,
// not the default"). The list-level f action cycles all three (§10.4).
var statusState = 'proposed';

// Group fold state — client-side per item.type (A5 §10.4). v1 has one type
// (journal_proposal); the map is generic so Class B types slot in later.
// Absent key = UNFOLDED (the default — the queue's rows are visible).
var groupFold = {};

// Human-readable group labels per item.type. Class B types add entries here
// as their modules land (§10.7). Unknown types fall back to the raw type.
var GROUP_LABELS = {
  journal_proposal: 'Journal proposals',
  bill_due: 'Bills due for payment'
};

// Per-row type glyph (§10.4). Muted emoji prefix in the Date column so a
// row retains its type context when the group header scrolls away.
var TYPE_GLYPHS = {
  journal_proposal: '\\uD83D\\uDCD2', // 📒
  bill_due: '\\uD83D\\uDCBC'          // 📋
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
  // Class B bill-due (§10.7 item 4): overdue = red, due = amber.
  if (s === 'overdue') return '<span class="st-badge st-overdue">Overdue</span>';
  if (s === 'due') return '<span class="st-badge st-due">Due</span>';
  return ''; // inbox is the review queue — no posted badge here
}

// A4 §4.7 — folded-row source-document indicator. Only PROPOSED items carry
// it (the review surface); rejected items show nothing. attachment_count > 0
// → "📎 N" count badge; 0 → a visible ⚠️ warning icon (R7: warn-not-block — the
// reviewer must not miss the gap, but the proposal is still approvable).
// Additional inline warning icons for persisted warnings (no_underlag, VAT).
function underlagBadge(row) {
  if (row._kind !== 'proposal' || row.status !== 'proposed') return '';
  var n = Number(row.attachment_count || 0);
  var html = '';
  if (n > 0) {
    html += '<span class="ul-badge" title="' + n + ' source document(s) attached">\\uD83D\\uDCCE ' + n + '</span>';
  } else {
    html += '<span class="ul-warn" title="No source document attached — egen verifikation permitted (BFL 5 kap)">\\u26A0</span>';
  }
  // Inline per-row warning icons from persisted warnings array.
  var warns = Array.isArray(row.warnings) ? row.warnings : [];
  // no_underlag is already rendered as the .ul-warn icon above when count=0;
  // skip duplicating it. Show it only when attachment_count > 0 but the warning
  // still exists (edge case — should not normally happen).
  if (n > 0 && warns.indexOf('no_underlag') !== -1) {
    html += '<span class="ul-warn" title="No source document attached">\\u26A0</span>';
  }
  // VAT-related warnings: any string starting with 'vat_' or containing 'vat'.
  var hasVat = warns.some(function (w) {
    return String(w).indexOf('vat_') === 0 || String(w).toLowerCase().indexOf('vat') !== -1;
  });
  if (hasVat) {
    html += '<span class="ul-warn" title="VAT tolerance flag">\\u26A0</span>';
  }
  return html;
}

// A4 §4.7 — unfold preview. The underlag panel is a child row of each
// PROPOSED item. attachment.list is fetched LAZILY on first unfold (the queue
// is a review surface, not every item needs its underlag on load) and cached
// per proposalId; the bare list.render() path re-renders the section when the
// fetch resolves. No new keys/verbs — Space unfolds via the existing tree
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

// ── Data: inbox.list (Class A — journal_proposals; Class B — bill_due items
//    per §10.7 item 4). Class A items are enriched with parsed lines via
//    journal.proposal.get so unfold and the approve modal are synchronous.
//    Class B bill items carry all their data inline (no enrichment needed).
//    The Object.assign merge keeps the list row's attachment_count (the get
//    response does not carry it — §4.7). The cache holds the flat item list;
//    buildRows() interleaves group headers and folds per type. ──────────────
var _cache = null;      // Array<item> | null (null = stale → re-fetch)
function fetchRows() {
  if (_cache) return Promise.resolve(buildRows(_cache));
  return postAction('inbox.list', { status: statusState, limit: 100 })
    .then(function (res) {
      var items = (res && res.data && Array.isArray(res.data.items)) ? res.data.items : [];
      // Enrich Class A items with parsed lines (children + modal summary).
      // Class B bill-due items skip enrichment — they carry all data inline.
      return Promise.all(items.map(function (it) {
        if (it.type !== 'journal_proposal') return it;
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
  // Class B bill-due (§10.7 item 4): no lines, no proposal get enrichment.
  // The item carries all data inline from inbox.list's queryBillsDue.
  if (it.type === 'bill_due') {
    return {
      _key: 'bill:' + it.payload_ref, _kind: 'bill',
      bill_id: it.payload_ref,
      type: it.type,
      date: it.date, reference: it.reference || '',
      description: it.description || it.summary || '',
      amount: it.amount, currency: it.currency || '',
      counterparty: it.counterparty || '',
      status: it.status, // 'overdue' or 'due'
      created_by: it.created_by || '', request_id: it.request_id || '',
    };
  }
  // Class A — journal_proposal (enriched with lines).
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
    // source-document badge / no-source-document warning icon.
    attachment_count: Number(it.attachment_count || 0),
    // Persisted warnings array (from journal_proposals.warnings JSON column).
    warnings: Array.isArray(it.warnings) ? it.warnings : [],
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
  // Three-state cycle (§10.4): proposed → rejected → bills → proposed.
  // Class B ('bills') is a filter section, not the default (§10.2).
  statusState = statusState === 'proposed' ? 'rejected'
    : statusState === 'rejected' ? 'bills'
    : 'proposed';
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
        // Per-row type glyph (§10.4): muted prefix so the row carries its
        // type context even when the group header has scrolled away.
        var glyph = TYPE_GLYPHS[r.type] || '';
        return '<span style="white-space:nowrap">' + (glyph ? '<span class="inbx-type-glyph">' + glyph + '</span>' : '') + fmtDate(v) + '</span>';
      } },
    { field: 'reference', filterType: 'text', label: 'Reference',
      display: function (v, r) { return r._kind === 'group' ? '' : (v != null && v !== '' ? esc(String(v)) : '<span class="pe-ro">—</span>'); } },
    { field: 'description', filterType: 'text', label: 'Description',
      display: function (v, r) {
        if (r._kind === 'group') return '';
        // For bill rows, show counterparty as the description if description is empty
        var text = v != null && v !== '' ? String(v) : (r.counterparty ? r.counterparty : '');
        return text !== '' ? esc(text) : '<span class="pe-ro">—</span>';
      } },
    { field: 'amount', align: 'right', filterType: 'amount', label: 'Amount',
      display: function (v, r) {
        if (r._kind === 'group') return '';
        // Bill rows show currency suffix for clarity (amount is outstanding).
        if (r._kind === 'bill' && r.amount) {
          return '<span class="amt">' + Number(r.amount).toFixed(2) + (r.currency ? ' ' + esc(r.currency) : '') + '</span>';
        }
        return fmtAmt(r.amount);
      } },
    { field: 'source', filterType: 'list', label: 'Source',
      display: function (v, r) {
        if (r._kind === 'group') return '';
        // Bill rows: source is the counterparty (partner), not agent/human.
        if (r._kind === 'bill') return r.counterparty ? esc(String(r.counterparty)) : '<span class="pe-ro">—</span>';
        return v != null && v !== '' ? esc(String(v)) : '<span class="pe-ro">—</span>';
      } },
    { field: 'created_by', filterType: 'text', label: 'Created by',
      display: function (v, r) { return r._kind === 'group' ? '' : (v != null && v !== '' ? esc(String(v)) : '<span class="pe-ro">—</span>'); } },
    { field: 'status', filterType: 'list', label: 'Status',
      display: function (v, r) {
        if (r._kind === 'group') return '';
        // Bill rows: badge only (no underlag badge — Class B).
        if (r._kind === 'bill') return statusBadge(r);
        return statusBadge(r) + underlagBadge(r);
      } }
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
    if (row._kind === 'bill') {
      // Class B bill-due unfold: a single meta child row with partner + bill info.
      // No underlag, no journal lines — the bill's own row is the source of truth.
      var billMeta = esc(row.counterparty || '')
        + (row.reference ? ' · ref ' + esc(row.reference) : '')
        + (row.currency ? ' · ' + esc(row.currency) : '')
        + (row.created_by ? ' · created by ' + esc(row.created_by) : '');
      kids.push({ _key: row._key + ':meta', _childOf: row._key, _meta: billMeta });
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
    // A5 §10.4 — fold is Space-only, everywhere (magnus 2026-08-28: Enter no
    // longer folds on any tree page — see fb-list.js openFocused). Enter is
    // a no-op on proposal rows (nothing to edit or open there; Space still
    // unfolds a proposal's lines for review) and "open bill" on bill rows —
    // see below.
    // Moved off the old y key (magnus 2026-08-28) — approve IS the same
    // "commit" action w means everywhere else (write on Chart of Accounts,
    // post on Bills/Journal Voucher): it's what turns this row into a
    // permanent ledger entry. w is never otherwise reachable on Inbox rows
    // (they're never dirty — no in-place edit — so the built-in FB.list w
    // binding, which only matches a dirty row, never fires here).
    { key: 'w', label: 'approve',
      when: function (row) { return row._kind === 'proposal' && row.status === 'proposed'; },
      affordance: function () { return '<a class="chip chip-ok" title="approve (w)" data-act="verb:w">&#10003;</a>'; },
      run: function (api, row) { review(row, 'approve'); } },
    { key: 'x', label: 'reject',
      when: function (row) { return row._kind === 'proposal' && row.status === 'proposed'; },
      affordance: function () { return '<a class="chip chip-cancel" title="reject (x)" data-act="verb:x">&#10005;</a>'; },
      run: function (api, row) { review(row, 'reject'); } },
    // Class B bill-due (§10.7 item 4): Enter opens the bill's native surface
    // (Payables). The inbox is read-only; the bill is worked in its own page.
    // Moved off the old o key (magnus 2026-08-28) — Enter has nothing else
    // to do on a bill-due row (not editable), so it's the natural key for
    // this rather than a separate chord.
    { key: 'Enter', label: 'open bill',
      when: function (row) { return row._kind === 'bill'; },
      affordance: function () { return '<a class="chip" title="open in Payables (Enter)" data-act="verb:Enter">&#8599;</a>'; },
      run: function (api, row) {
        // Navigate to the Payables page where the bill lives.
        window.location.href = '/' + COMPANY + '/payables';
      } }
  ],
  actions: [
    { key: 'f', label: 'filter: proposed↔rejected↔bills', handler: function () { cycleStatusFilter(); } }
  ],
  onLoaded: function (saved) {
    var note = document.getElementById('queue-note');
    var items = saved.filter(function (r) { return r._kind === 'proposal' || r._kind === 'bill'; });
    if (statusState === 'proposed') {
      note.textContent = items.length === 0
        ? 'Nothing to review — agent-proposed journal batches will appear here'
        : items.length + ' proposed batch' + (items.length === 1 ? '' : 'es') + ' awaiting review (w approve · x reject · Space unfolds)';
    } else if (statusState === 'rejected') {
      note.textContent = 'Rejected proposals (' + items.length + ') — f returns to the queue';
    } else {
      // Class B bills view
      var bills = items.filter(function (r) { return r._kind === 'bill'; });
      var overdue = bills.filter(function (r) { return r.status === 'overdue'; }).length;
      note.textContent = bills.length + ' bill' + (bills.length === 1 ? '' : 's') + ' due for payment'
        + (overdue ? ' (' + overdue + ' overdue)' : '')
        + ' — Enter opens in Payables · f returns to the queue';
    }
  },
  hint: 'Inbox: action items awaiting review, grouped by type (w approve, x reject, Enter opens a bill-due row in Payables, Space folds/unfolds). f cycles filters: proposed → rejected → bills.'
});

list.load();
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleInboxPage };
