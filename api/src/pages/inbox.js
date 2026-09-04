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
 *   x = reject on proposal rows (required note — the proposer reads it via
 *       event.list); deletes off disk on orphan rows — the app's regular
 *       delete verb, native confirm, no modal
 *   o = open bill (Class B bill-due items — navigates to Payables)
 *   v = view/download (Class B orphan_file items, calendar-reminders-
 *       documents-spec.md §5.5 — orphaned_files is the source of truth)
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
  /* calendar-reminders-documents-spec.md §6 — Inbox upload: a front door
     into the same attachment.uploaded-event pipeline the agent-inbox
     folder-drop already feeds (agent-loop.js processEvent), so a human can
     hand the agent a bank statement / bill / receipt without touching the
     filesystem. */
  #inbox-upload-panel { display:none; margin:0 0 14px; padding:12px; border:1px solid #ddd; border-radius:4px; background:#fafafa; }
  #inbox-upload-panel.open { display:block; }
  #inbox-upload-panel select, #inbox-upload-panel input { padding:4px 8px; border:1px solid #ddd; border-radius:3px; font-size:10pt; margin-right:8px; }
  .header { display:flex; justify-content:space-between; align-items:flex-start; }
</style>
</head>
<body>${navBar(company, 'inbox')}
<div class="page page-wide">
  <div class="header">
    <div>
      <h1>Inbox</h1>
      <p class="sub">${company} · review queue</p>
    </div>
    <a class="chip" data-act="inbox-upload-toggle">+ Upload document</a>
  </div>

  <div id="inbox-upload-panel">
    <select id="inbox-upload-type">
      <option value="bank_statement">Bank Statement</option>
      <option value="bill">Bill</option>
      <option value="journal_proposal">Receipt</option>
    </select>
    <input type="file" id="inbox-upload-file">
    <a class="chip" data-act="inbox-upload-save">Save</a>
    <a class="chip" data-act="inbox-upload-cancel">Cancel</a>
  </div>

  <p id="queue-note"></p>

  <table class="jrnl-table">
    <thead>
      <tr>
        <th>Date</th><th>Doc No</th><th>Description</th>
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
  bill_due: 'Bills due for payment',
  orphan_file: 'Orphaned files'
};

// Per-row type glyph (§10.4). Muted emoji prefix in the Date column so a
// row retains its type context when the group header scrolls away.
var TYPE_GLYPHS = {
  journal_proposal: '\\uD83D\\uDCD2', // 📒
  bill_due: '\\uD83D\\uDCBC',         // 📋
  orphan_file: '\\uD83D\\uDCC1'       // 📁
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

// ── Upload (calendar-reminders-documents-spec.md §6) ─────────────────────────
// A front door into the same attachment.uploaded event that a folder-drop
// (feed-watcher.js) already produces — agent-loop.js's processEvent dispatches
// on entityType regardless of how the attachment arrived, so this needs no
// new backend action, just the existing attachment.upload with a fresh id.
document.addEventListener('click', function (e) {
  if (e.target.closest('[data-act="inbox-upload-toggle"]')) {
    document.getElementById('inbox-upload-panel').classList.toggle('open');
  }
  if (e.target.closest('[data-act="inbox-upload-cancel"]')) {
    document.getElementById('inbox-upload-panel').classList.remove('open');
    document.getElementById('inbox-upload-file').value = '';
  }
});

document.addEventListener('click', function (e) {
  if (!e.target.closest('[data-act="inbox-upload-save"]')) return;
  var fileInput = document.getElementById('inbox-upload-file');
  var file = fileInput.files[0];
  var entityType = document.getElementById('inbox-upload-type').value;
  if (!file) { FB.status.show('Choose a file first.', true); return; }
  var reader = new FileReader();
  reader.onload = function () {
    var b64 = reader.result.split(',')[1];
    var entityId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2));
    postAction('attachment.upload', {
      entityType: entityType, entityId: entityId,
      filename: file.name, contentBase64: b64, contentType: file.type || 'application/octet-stream',
    }).then(function (res) {
      if (!res || res.ok === false || res.error) {
        FB.status.show('Upload failed: ' + ((res && res.error && res.error.message) || 'unknown error'), true);
        return;
      }
      FB.status.show('Uploaded ' + file.name + ' — the agent will pick it up shortly.');
      document.getElementById('inbox-upload-panel').classList.remove('open');
      fileInput.value = '';
    }).catch(function (err) { FB.status.show('Upload failed: ' + (err && err.message || err), true); });
  };
  reader.readAsDataURL(file);
});

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
  // Class B orphaned files (§5.5): reuse the overdue red — needs attention.
  if (s === 'orphaned') return '<span class="st-badge st-overdue">Orphaned</span>';
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
  // Class B orphaned files (calendar-reminders-documents-spec.md §5.5): no
  // lines, no enrichment — the orphaned_files row carries everything.
  if (it.type === 'orphan_file') {
    return {
      _key: 'orphan:' + it.payload_ref, _kind: 'orphan',
      orphan_id: it.payload_ref,
      type: it.type,
      date: it.date, reference: it.reference || '',
      description: it.description || '',
      amount: null, currency: '', source: 'system',
      counterparty: '',
      status: it.status, // 'orphaned'
      created_by: '', request_id: '',
    };
  }
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
    // bank-match-bill-settlement-spec §4.4: present only for bank-match
    // proposals tagging a foreign-currency bill. {billId, mode, blocked,
    // blockedReason?} — mode ('full'|'partial') is human-toggleable via the
    // ~ verb; blocked means required FX setup is missing and approval must
    // be refused.
    settlement: it.settlement || null,
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
  // Thread D (bank-match-bill-settlement-spec §4.4): a bank-match proposal
  // missing required FX setup must not even reach the approve modal — refuse
  // via the banner, same surface as any other action error.
  if (approve && row.settlement && row.settlement.blocked) {
    FB.status.show(row.settlement.blockedReason || 'Missing FX setup — cannot approve this proposal.', true);
    return;
  }
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

// ── Delete orphaned file (row verb — Class B, calendar-reminders-documents-
// spec.md §5.5) ────────────────────────────────────────────────────────
// x is the app's regular delete verb (matches bill-detail.js/payables-
// bills.js's void, fb-list.js's default row delete): one action, native
// confirm, no modal. The operator downloads first via v if they want a
// copy — no app-managed quarantine/restore path.
function deleteOrphan(row) {
  if (!confirm('Permanently delete this file from disk?\\n' + row.reference)) return;
  postAction('orphan.delete', { orphanId: row.orphan_id }).then(function (res) {
    if (!res || res.ok === false || res.error) {
      FB.status.show((res && res.error && res.error.message) || 'Delete failed', true); return;
    }
    FB.status.show('Deleted.', false);
    _cache = null; list.load();
  }).catch(function (e) { FB.status.show('Delete failed: ' + (e && e.message || e), true); });
}

function cycleStatusFilter() {
  // Four-state cycle: proposed → rejected → bills → orphans → proposed.
  // Class B ('bills', 'orphans') are filter sections, not the default (§10.2).
  statusState = statusState === 'proposed' ? 'rejected'
    : statusState === 'rejected' ? 'bills'
    : statusState === 'bills' ? 'orphans'
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
    { field: 'reference', filterType: 'text', label: 'Doc No',
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
    // A5 §10.4 — group header fold is now Space-only (the built-in tree
    // binding). Enter falls through to the built-in openFocused (edit/detail).
    { key: 'y', label: 'approve',
      when: function (row) { return row._kind === 'proposal' && row.status === 'proposed'; },
      affordance: function () { return '<a class="chip chip-ok" title="approve (y)" data-act="verb:y">&#10003;</a>'; },
      run: function (api, row) { review(row, 'approve'); } },
    { key: 'x', label: 'reject',
      when: function (row) { return row._kind === 'proposal' && row.status === 'proposed'; },
      affordance: function () { return '<a class="chip chip-cancel" title="reject (x)" data-act="verb:x">&#10005;</a>'; },
      run: function (api, row) { review(row, 'reject'); } },
    // Thread D / bank-match-bill-settlement-spec §4.4: the human-controlled
    // Full/Partial settlement toggle for bank-match proposals tagging a
    // foreign-currency bill. ~ is the app's universal toggle verb
    // (keyboard-ux-spec §5) — immediate persist, no staged/dirty-write step,
    // matching payables-partners.js's active-toggle pattern. No other click
    // buttons control this decision; approve/reject stay untouched by it.
    { key: '~', label: 'toggle full/partial settlement',
      when: function (row) { return row._kind === 'proposal' && row.status === 'proposed' && !!row.settlement; },
      affordance: function (row) {
        var mode = row.settlement && row.settlement.mode === 'partial' ? 'Partial' : 'Full';
        var cls = row.settlement && row.settlement.blocked ? 'chip chip-cancel' : 'chip';
        return '<a class="' + cls + '" title="toggle full/partial settlement (~)" data-act="verb:~">' + mode + '</a>';
      },
      run: function (api, row) {
        postAction('bank.match.toggleSettlement', { proposalId: row.proposal_id, billId: row.settlement.billId })
          .then(function (res) {
            if (!res || res.ok === false || res.error) {
              FB.status.show((res && res.error && res.error.message) || 'Toggle failed', true);
              return;
            }
            FB.status.show('Settlement set to ' + (res.data && res.data.mode === 'partial' ? 'partial' : 'full') + '.', false);
            _cache = null;   // lines/amount changed server-side — re-fetch
            list.load();
          })
          .catch(function (e) { FB.status.show('Toggle failed: ' + (e && e.message || e), true); });
      } },
    // Class B bill-due (§10.7 item 4): 'o' opens the bill's native surface
    // (Payables). The inbox is read-only; the bill is worked in its own page.
    { key: 'o', label: 'open bill',
      when: function (row) { return row._kind === 'bill'; },
      affordance: function () { return '<a class="chip" title="open in Payables (o)" data-act="verb:o">&#8599;</a>'; },
      run: function (api, row) {
        // Navigate to the Payables page where the bill lives.
        window.location.href = '/' + COMPANY + '/payables';
      } },
    // Class B orphaned files (calendar-reminders-documents-spec.md §5.5):
    // v = view/download, x = delete (off disk). No app-managed quarantine —
    // download via v first if a copy is wanted, then delete.
    { key: 'v', label: 'view',
      when: function (row) { return row._kind === 'orphan'; },
      affordance: function () { return '<a class="chip" title="view (v)" data-act="verb:v">&#128065;</a>'; },
      run: function (api, row) { window.open('/api/orphaned-file/' + row.orphan_id, '_blank'); } },
    { key: 'x', label: 'delete',
      when: function (row) { return row._kind === 'orphan'; },
      affordance: function () { return '<a class="chip chip-cancel" title="delete (x)" data-act="verb:x">&#10005;</a>'; },
      run: function (api, row) { deleteOrphan(row); } }
  ],
  actions: [
    { key: 'f', label: 'filter: proposed↔rejected↔bills↔orphans', handler: function () { cycleStatusFilter(); } }
  ],
  onLoaded: function (saved) {
    var note = document.getElementById('queue-note');
    var items = saved.filter(function (r) { return r._kind === 'proposal' || r._kind === 'bill'; });
    if (statusState === 'proposed') {
      note.textContent = items.length === 0
        ? 'Nothing to review — agent-proposed journal batches will appear here'
        : items.length + ' proposed batch' + (items.length === 1 ? '' : 'es') + ' awaiting review (y approve · x reject · Enter unfold)';
    } else if (statusState === 'rejected') {
      note.textContent = 'Rejected proposals (' + items.length + ') — f returns to the queue';
    } else if (statusState === 'bills') {
      // Class B bills view
      var bills = items.filter(function (r) { return r._kind === 'bill'; });
      var overdue = bills.filter(function (r) { return r.status === 'overdue'; }).length;
      note.textContent = bills.length + ' bill' + (bills.length === 1 ? '' : 's') + ' due for payment'
        + (overdue ? ' (' + overdue + ' overdue)' : '')
        + ' — o opens in Payables · Enter unfolds · f cycles filters';
    } else {
      // Class B orphaned files view
      var orphans = items.filter(function (r) { return r._kind === 'orphan'; });
      note.textContent = orphans.length + ' orphaned file' + (orphans.length === 1 ? '' : 's')
        + ' — v view · x delete · f returns to the queue';
    }
  },
  hint: 'Inbox: action items awaiting review, grouped by type (y approve, x reject, o open bill, v/x view/delete an orphaned file, Enter unfolds lines or folds a group). f cycles filters: proposed → rejected → bills → orphans.'
});

list.load();
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleInboxPage };
