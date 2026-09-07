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
 *       on proposal rows; post (confirm modal, no note) on bill_draft rows
 *       (Option C amendment — "approve is the post", different action
 *       underneath: bill.draft.post, not journal.approve)
 *   x = reject on proposal rows (required note — the proposer reads it via
 *       event.list); deletes off disk on orphan rows — the app's regular
 *       delete verb, native confirm, no modal; discards on bill_draft rows
 *       (bill.draft.delete, confirm modal, no note)
 *   v = view/download (Class B orphan_file items, calendar-reminders-
 *       documents-spec.md §5.5 — orphaned_files is the source of truth)
 *   y/x = approve/reject (Class B partner_proposal and mapping_suggestion
 *       items — no note field; neither table has a review_note column)
 *   d = discard (Class B input_rejection items, bank-matching-spec §11.2).
 *       r (retry: correct the data + re-run the cascade) is spec'd but has
 *       no backing action or edit UI yet — shown disabled, not omitted.
 * Enter unfolds lines read-only (framework openFocused); Esc never writes.
 *
 * bill_draft (Class A, Option C amendment) merges into the default
 * 'proposed' view server-side (inbox.js), same as period_unclosed — it
 * converges on the same y/x/Enter-unfold idiom as journal_proposal, so it
 * gets no filter state of its own. mapping_suggestion and input_rejection
 * are genuine Class B filter states (bank-matching-spec §10.4/§11.2) — both
 * had complete server implementations (and, for mapping_suggestion, test
 * coverage) that were never wired into this page's f-cycle until now.
 *
 * bill-due and reconciliation-alert items (formerly here as Class B 'bills'/
 * 'reconciliation' filter views) moved to the notifications bell
 * (bills-due-scanner.js / reconciliation-scanner.js) — neither carried an
 * in-place decision, only an "open elsewhere" verb, so they belong with the
 * bell's other go-look-at-this alerts, not this decide-here queue.
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
  table.jrnl-table { width:100%; border-collapse:collapse; font-size:0.8125rem; }
  table.jrnl-table th { text-align:left; font-size:0.75rem; text-transform:uppercase; color:var(--text-muted); border-bottom:1px solid var(--border); padding:6px 6px; }
  table.jrnl-table td { padding:4px 6px; border-bottom:1px solid var(--border); vertical-align:middle; }
  .amt { text-align:right; font-variant-numeric:tabular-nums; }
  .jrnl-meta td, td.jrnl-meta { color:var(--text-muted); font-size:0.6875rem; font-style:italic; background:var(--bg); }
  tr[data-child-of] td { background:var(--bg); font-size:0.75rem; color:var(--text-muted); }
  /* Status badges use the shared .badge component (common.css) — see statusBadge() below */
  /* Per-row type glyph (§10.4): muted prefix in the Date column so a row
     keeps its type context when the group header scrolls away. */
  .inbx-type-glyph { font-size:0.8125rem; margin-right:4px; opacity:.6; }
  #queue-note { margin:0 0 10px; font-size:0.75rem; color:var(--text-muted); }
  /* .chip/.chip-ok/.chip-cancel/.chip-disabled are the shared action-icon
     chip component (common.css) — this page's local copy never actually
     coloured .chip-ok/.chip-cancel (no rule existed anywhere), so every
     approve/reject/view/delete/discard icon below rendered uncoloured. */
  /* input_rejection 'r' (retry) — reserved verb slot, no backing action yet
     (§11.2). Shown muted/not-allowed rather than omitted. */
  /* A5 §10.4 — collapsible group header row. One per item.type (v1: only
     journal_proposal). Muted, like .jrnl-meta; the fold caret lives in the
     actions cell (mouse parity for the Enter key verb). */
  tr.inbx-group td { background:var(--bg); font-weight:700; font-size:0.75rem; color:var(--text-muted); cursor:pointer; }
  tr.inbx-group td .inbx-grp-count { color:var(--text-muted); font-weight:600; font-size:0.6875rem; margin-left:6px; }
  /* A4 §4.7 — source-document count badge + no-source-document warning.
     Folded PROPOSED rows carry the count beside the status badge (the row's
     existing badge idiom — .st-badge sizing). Zero attachments render a
     visible ⚠️ warning icon so the reviewer cannot miss the gap
     (R7 warn-not-block). Rejected/posted rows show no badge. */
  .ul-badge { display:inline-block; margin-left:6px; padding:1px 7px; border-radius:9px;
    font-size:0.6875rem; font-weight:600; background:var(--info-bg); color:var(--info); white-space:nowrap; }
  .ul-warn  { display:inline-block; margin-left:6px; padding:1px 7px; border-radius:9px;
    font-size:0.6875rem; font-weight:700; background:var(--danger-bg); color:var(--danger); white-space:nowrap;
    border:1px solid var(--danger-border); }
  /* Unfold preview (§4.7): the underlag panel renders as a child row holding
     shared fb-attachments rows (FB.attachments.rowHtml), each linking to the
     existing GET /api/attachments/:id route. */
  tr[data-child-of] td.jrnl-att { background:var(--bg); padding:6px 10px; }
  .jrnl-att-head { font-size:0.6875rem; font-weight:700; text-transform:uppercase; letter-spacing:.03em;
    color:var(--text-muted); margin:0 0 4px; }
  .jrnl-att .fb-attach-row { padding:3px 0; }
  .jrnl-att .fb-att-empty { color:var(--text-faint); font-size:0.75rem; font-style:italic; }
  /* calendar-reminders-documents-spec.md §6 — Inbox upload: a front door
     into the same attachment.uploaded-event pipeline the agent-inbox
     folder-drop already feeds (agent-loop.js processEvent), so a human can
     hand the agent a bank statement / bill / receipt without touching the
     filesystem. */
  #inbox-upload-panel { display:none; margin:0 0 14px; padding:12px; border:1px solid var(--border); border-radius:4px; background:var(--bg); }
  #inbox-upload-panel.open { display:block; }
  #inbox-upload-panel select, #inbox-upload-panel input { padding:4px 8px; border:1px solid var(--border); border-radius:3px; font-size:0.8125rem; margin-right:8px; }
  .header { display:flex; justify-content:space-between; align-items:flex-start; }
  #inbox-agent-status { font-size:0.75rem; color:var(--text-muted); cursor:pointer; user-select:none; margin:2px 0 10px; }
</style>
</head>
<body>${navBar(company, 'inbox')}
<div class="page page-wide">
  <div class="header">
    <div>
      <h1>Inbox</h1>
      <p class="sub">${company} · review queue</p>
    </div>
    <a class="fb-tag" data-act="inbox-upload-toggle">+ Upload document</a>
  </div>

  <div id="inbox-agent-status" onclick="loadAgentStatus()">Checking agent status…</div>

  <div id="inbox-upload-panel">
    <select id="inbox-upload-type">
      <option value="bank_statement">Bank Statement</option>
      <option value="bill">Bill</option>
      <option value="journal_proposal">Receipt</option>
    </select>
    <input type="file" id="inbox-upload-file">
    <a class="fb-tag" data-act="inbox-upload-save">Save</a>
    <a class="fb-tag" data-act="inbox-upload-cancel">Cancel</a>
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
// (graveyard) | 'orphans' | 'partners' (Class B — §10.2: "a filter/section,
// not the default"). The list-level f action cycles all four (§10.4).
var statusState = 'proposed';

// Group fold state — client-side per item.type (A5 §10.4). v1 has one type
// (journal_proposal); the map is generic so Class B types slot in later.
// Absent key = UNFOLDED (the default — the queue's rows are visible).
var groupFold = {};

// Human-readable group labels per item.type. Class B types add entries here
// as their modules land (§10.7). Unknown types fall back to the raw type.
var GROUP_LABELS = {
  journal_proposal: 'Journal proposals',
  bill_draft: 'Bill drafts',
  orphan_file: 'Orphaned files',
  partner_proposal: 'Partner proposals',
  mapping_suggestion: 'Mapping rule suggestions',
  input_rejection: 'Input rejections'
};

// Per-row type glyph (§10.4). Muted emoji prefix in the Date column so a
// row retains its type context when the group header scrolls away.
var TYPE_GLYPHS = {
  journal_proposal: '\\uD83D\\uDCD2',    // 📒
  bill_draft: '\\uD83D\\uDCCB',          // 📋
  orphan_file: '\\uD83D\\uDCC1',         // 📁
  partner_proposal: '\\uD83E\\uDD1D',    // 🤝
  mapping_suggestion: '\\uD83D\\uDD00',  // 🔀
  input_rejection: '\\uD83D\\uDEAB'      // 🚫
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

// Agent-loop / feed-watcher pipeline status (moved here from Chat with AI —
// this is the queue those two processes feed, not a chat concern). Reads
// agent.status's actual response shape ({running, feedWatcher:{running}}) —
// mirrors fb-core.js's topbar chat-dot check, not the mismatched field names
// chat.js's own status strip used to read.
function fmtAgentStatus(d) {
  if (!d) return 'Agent status unavailable';
  var parts = ['Agent: ' + (d.running ? 'Running' : 'Stopped')];
  if (d.feedWatcher) parts.push('Feed watcher: ' + (d.feedWatcher.running ? 'Running' : 'Stopped'));
  return parts.join(' \\u00b7 ');
}
function loadAgentStatus() {
  var el = document.getElementById('inbox-agent-status');
  el.textContent = 'Checking agent status…';
  postAction('agent.status', {}).then(function (res) {
    el.textContent = fmtAgentStatus((res && res.data) || null);
  }).catch(function () { el.textContent = 'Agent status unavailable'; });
}
loadAgentStatus();

function fmtAmt(v) {
  var n = Number(v || 0);
  return n ? '<span class="amt">' + n.toFixed(2) + '</span>' : '';
}
function fmtDate(v) { return esc(String(v || '').slice(0, 10)); }

function statusBadge(row) {
  var s = row.status || '';
  if (s === 'proposed') return '<span class="badge badge-warning">Proposed</span>';
  if (s === 'rejected') return '<span class="badge badge-danger" title="' + esc(row.review_note || '') + '\">Rejected</span>';
  // Class A bill drafts (Option C amendment): reuse the proposed styling —
  // it's an awaiting-decision state, same family as journal proposals.
  if (s === 'draft') return '<span class="badge badge-warning">Draft</span>';
  // Class B orphaned files (§5.5) / open input rejections: needs attention.
  if (s === 'orphaned') return '<span class="badge badge-danger">Orphaned</span>';
  if (s === 'open') return '<span class="badge badge-danger">Open</span>';
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

// issue #226 — folded-row fuzzy-duplicate indicator for partner_proposal
// items. Non-blocking (warn-not-block, same doctrine as underlagBadge above):
// the reviewer sees the candidate name + similarity but approve/reject stay
// both available either way.
function duplicateBadge(row) {
  if (row._kind !== 'partner' || !row.duplicate_warning) return '';
  var d = row.duplicate_warning;
  var pct = Math.round((Number(d.similarity) || 0) * 100);
  var kindLabel = d.kind === 'proposal' ? 'another pending proposal' : 'an existing partner';
  return '<span class="ul-warn" title="Possibly a duplicate of ' + esc(d.name) + ' (' + kindLabel + ', ' + pct + '% similar) — review before approving">\\u26A0 possible duplicate</span>';
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

// ── Data: inbox.list (Class A — journal_proposals; Class B — orphan_file,
//    partner_proposal). Class A items are enriched with parsed lines via
//    journal.proposal.get so unfold and the approve modal are synchronous.
//    Class B items carry all their data inline (no enrichment needed).
//    The Object.assign merge keeps the list row's attachment_count (the get
//    response does not carry it — §4.7). The cache holds the flat item list;
//    buildRows() interleaves group headers and folds per type. ──────────────
var _cache = null;      // Array<item> | null (null = stale → re-fetch)
function fetchRows() {
  if (_cache) return Promise.resolve(buildRows(_cache));
  return postAction('inbox.list', { status: statusState, limit: 100 })
    .then(function (res) {
      var items = (res && res.data && Array.isArray(res.data.items)) ? res.data.items : [];
      // Enrich journal_proposal items with parsed lines (children + modal
      // summary). Every other type — bill_draft, orphan_file,
      // partner_proposal, mapping_suggestion, input_rejection — skips
      // enrichment; they carry all data inline.
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
  // bill_due and reconciliation_alert used to map here; both moved to the
  // notifications bell (bills-due-scanner.js / reconciliation-scanner.js).
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
  // Class B — partner proposals (partner-proposal-spec §5): agent-proposed
  // vendors/customers awaiting approve/reject. No lines, no enrichment — the
  // item carries everything inline from inbox.list's queryPartnerProposals.
  if (it.type === 'partner_proposal') {
    return {
      _key: 'partner:' + it.payload_ref, _kind: 'partner',
      proposal_id: it.payload_ref,
      type: it.type,
      date: it.date, reference: it.reference || '',
      description: it.summary || it.description || '',
      amount: null, currency: '', source: it.source || 'agent',
      counterparty: it.counterparty || '',
      status: it.status, // 'proposed'
      created_by: it.created_by || '', request_id: '',
      // issue #226: a non-blocking fuzzy-duplicate hint {name,similarity,kind}
      // found at propose time. null when no fuzzy candidate was found.
      duplicate_warning: it.duplicate_warning || null,
    };
  }
  // Class A — bill drafts (Option C amendment): agent-created bill drafts
  // awaiting human post/discard. No lines, no enrichment — the item carries
  // everything inline from inbox.list's queryBillDrafts.
  if (it.type === 'bill_draft') {
    return {
      _key: 'draft:' + it.payload_ref, _kind: 'draft',
      bill_id: it.payload_ref,
      type: it.type,
      date: it.date, reference: it.reference || '',
      description: it.description || '',
      amount: it.amount, currency: it.currency || '',
      counterparty: it.counterparty || '', source: it.source || 'agent',
      status: it.status, // 'draft'
      created_by: it.created_by || '', request_id: '',
    };
  }
  // Class B — mapping-rule suggestions (bank-matching-spec §10.2): agent-
  // proposed bank_mappings rules awaiting approve/reject. No lines, no
  // enrichment — the item carries everything inline from
  // inbox.list's queryMappingSuggestions.
  if (it.type === 'mapping_suggestion') {
    return {
      _key: 'sugg:' + it.payload_ref, _kind: 'suggestion',
      suggestion_id: it.payload_ref,
      type: it.type,
      date: it.date, reference: it.reference || '',
      description: it.summary || it.description || '',
      amount: null, currency: '', source: it.source || 'agent',
      counterparty: '',
      status: it.status, // 'proposed'
      created_by: it.created_by || '', request_id: '',
    };
  }
  // Class B — input rejections (bank-matching-spec §11.2): statement lines
  // with missing critical data. No lines, no enrichment — the item carries
  // everything inline from inbox.list's queryInputRejections. 'r' (retry —
  // correct the data + re-run the cascade) has no backing action yet; only
  // 'x' (discard) is wired (see the row-verb definitions below).
  if (it.type === 'input_rejection') {
    return {
      _key: 'rej:' + it.payload_ref, _kind: 'rejection',
      rejection_id: it.payload_ref,
      type: it.type,
      date: it.date, reference: it.reference || '',
      description: it.summary || it.description || '',
      amount: null, currency: '', source: it.source || 'agent',
      counterparty: '',
      status: it.status, // 'open'
      created_by: it.created_by || '', request_id: '',
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
    body: '<div style="font-size:0.8125rem;color:var(--text);line-height:1.7">'
      + '<div><b>Date:</b> ' + fmtDate(row.date) + '</div>'
      + '<div><b>Lines:</b> ' + row.lineCount + ' &nbsp; <b>Total debit:</b> ' + Number(row.totalDebit).toFixed(2) + (row.currency ? ' ' + esc(row.currency) : '') + '</div>'
      + (row.reference ? '<div><b>Reference:</b> ' + esc(row.reference) + '</div>' : '')
      + (row.description ? '<div><b>Description:</b> ' + esc(row.description) + '</div>' : '')
      + '<div style="margin-top:6px;color:var(--text-muted);font-size:0.75rem">Proposed by ' + esc(row.created_by || '?')
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

// ── Approve / reject a partner proposal (row verbs — partner-proposal-spec
// §5). Simpler than the journal-batch modal: partner_proposals has no
// review_note column (§3.2 schema — only reviewed_by/reviewed_at), so there
// is no note field here, unlike the journal review() modal above. ─────────
function reviewPartner(row, verdict) {
  var approve = verdict === 'approve';
  var idemKey = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('rev-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  var inFlight = false;
  FB.modal.open({
    title: (approve ? 'Approve' : 'Reject') + ' partner proposal',
    body: '<div style="font-size:0.8125rem;color:var(--text);line-height:1.7">'
      + '<div><b>' + esc(row.counterparty || row.reference || '') + '</b></div>'
      + (row.description ? '<div>' + esc(row.description) + '</div>' : '')
      + '<div style="margin-top:6px;color:var(--text-muted);font-size:0.75rem">Proposed by ' + esc(row.created_by || '?') + '</div>'
      + '</div>',
    buttons: [
      { label: approve ? 'Approve' : 'Reject', primary: approve, danger: !approve,
        requiresConfirm: true, key: 'Enter', hint: approve ? 'approve' : 'reject',
        onClick: function (mapi) {
          if (inFlight) return; inFlight = true;
          postAction('partner.proposal.' + verdict, { proposalId: row.proposal_id }, idemKey)
            .then(function (res) {
              if (!res || res.ok === false || res.error) {
                inFlight = false;
                mapi.error((res && res.error && res.error.message) || 'Request failed'); return;
              }
              mapi.close();
              FB.status.show(approve ? 'Approved — added to partners' : 'Proposal rejected', false);
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
// x is the app's regular delete verb (matches bill-edit.js/payables-
// bills.js's void, fb-list.js's default row delete) — a permanent,
// irreversible disk delete, so it goes through FB.modal (docs/UI.md
// Components) rather than a bare confirm(). The operator downloads first
// via v if they want a copy — no app-managed quarantine/restore path.
function deleteOrphan(row) {
  FB.modal.open({
    title: 'Permanently delete this file from disk?',
    body: esc(row.reference),
    buttons: [
      { label: 'Cancel', onClick: function (api) { api.close(); } },
      { label: 'Delete', danger: true, onClick: function (api) {
          api.close();
          postAction('orphan.delete', { orphanId: row.orphan_id }).then(function (res) {
            if (!res || res.ok === false || res.error) {
              FB.status.show((res && res.error && res.error.message) || 'Delete failed', true); return;
            }
            FB.status.show('Deleted.', false);
            _cache = null; list.load();
          }).catch(function (e) { FB.status.show('Delete failed: ' + (e && e.message || e), true); });
        } }
    ]
  });
}

// ── Post / discard a bill draft (row verb — Option C amendment) ─────────
// Class A: a bill draft's journal entries post via bill.draft.post, not
// journal.approve — "approve is the post" doctrine, same as journal
// proposals, just a different action underneath. No note field (mirrors
// reviewPartner — partner_proposals/bill drafts have no review_note column).
function reviewDraft(row, verb) {
  var post = verb === 'post';
  var idemKey = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('rev-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  var inFlight = false;
  FB.modal.open({
    title: (post ? 'Post' : 'Discard') + ' bill draft',
    body: '<div style="font-size:0.8125rem;color:var(--text);line-height:1.7">'
      + '<div><b>' + esc(row.counterparty || row.reference || '') + '</b></div>'
      + (row.description ? '<div>' + esc(row.description) + '</div>' : '')
      + (row.amount ? '<div>' + Number(row.amount).toFixed(2) + (row.currency ? ' ' + esc(row.currency) : '') + '</div>' : '')
      + '<div style="margin-top:6px;color:var(--text-muted);font-size:0.75rem">Created by ' + esc(row.created_by || '?') + '</div>'
      + '</div>',
    buttons: [
      { label: post ? 'Post' : 'Discard', primary: post, danger: !post,
        requiresConfirm: true, key: 'Enter', hint: post ? 'post' : 'discard',
        onClick: function (mapi) {
          if (inFlight) return; inFlight = true;
          postAction(post ? 'bill.draft.post' : 'bill.draft.delete', { billId: row.bill_id }, idemKey)
            .then(function (res) {
              if (!res || res.ok === false || res.error) {
                inFlight = false;
                mapi.error((res && res.error && res.error.message) || 'Request failed'); return;
              }
              mapi.close();
              FB.status.show(post ? 'Posted.' : 'Draft discarded.', false);
              window.dispatchEvent(new Event('fb:queue-changed'));
              _cache = null; list.load();
            })
            .catch(function (e) { inFlight = false; mapi.error(e.message); });
        } },
      { label: 'Cancel', onClick: function (mapi) { mapi.close(); } }
    ],
    onCancel: function () {} // Esc/backdrop — never writes
  });
}

// ── Approve / reject a mapping-rule suggestion (row verb — bank-matching-
// spec §10.4) ─────────────────────────────────────────────────────────────
// Lighter-weight than journal-batch review — no note field, mirrors
// reviewPartner exactly (mapping_suggestions has no review_note column).
function reviewSuggestion(row, verdict) {
  var approve = verdict === 'approve';
  var idemKey = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('rev-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  var inFlight = false;
  FB.modal.open({
    title: (approve ? 'Approve' : 'Reject') + ' mapping suggestion',
    body: '<div style="font-size:0.8125rem;color:var(--text);line-height:1.7">'
      + '<div>' + esc(row.description || row.reference || '') + '</div>'
      + '<div style="margin-top:6px;color:var(--text-muted);font-size:0.75rem">Suggested by ' + esc(row.created_by || '?') + '</div>'
      + '</div>',
    buttons: [
      { label: approve ? 'Approve' : 'Reject', primary: approve, danger: !approve,
        requiresConfirm: true, key: 'Enter', hint: approve ? 'approve' : 'reject',
        onClick: function (mapi) {
          if (inFlight) return; inFlight = true;
          postAction('mapping.suggestion.' + verdict, { suggestionId: row.suggestion_id }, idemKey)
            .then(function (res) {
              if (!res || res.ok === false || res.error) {
                inFlight = false;
                mapi.error((res && res.error && res.error.message) || 'Request failed'); return;
              }
              mapi.close();
              FB.status.show(approve ? 'Rule approved.' : 'Suggestion rejected.', false);
              window.dispatchEvent(new Event('fb:queue-changed'));
              _cache = null; list.load();
            })
            .catch(function (e) { inFlight = false; mapi.error(e.message); });
        } },
      { label: 'Cancel', onClick: function (mapi) { mapi.close(); } }
    ],
    onCancel: function () {}
  });
}

// ── Discard an input rejection (row verb — bank-matching-spec §11.2) ────
// 'x' only — 'r' (retry: correct the data + re-run the cascade) has no
// backing action yet (no edit UI, no input_rejection.retry action). Goes
// through FB.modal, matching deleteOrphan's pattern for a one-shot delete.
function discardRejection(row) {
  FB.modal.open({
    title: 'Discard this rejection?',
    body: 'The statement line will not be proposed.<br>' + esc(row.description),
    buttons: [
      { label: 'Cancel', onClick: function (api) { api.close(); } },
      { label: 'Discard', danger: true, onClick: function (api) {
          api.close();
          postAction('input_rejection.discard', { rejectionId: row.rejection_id }).then(function (res) {
            if (!res || res.ok === false || res.error) {
              FB.status.show((res && res.error && res.error.message) || 'Discard failed', true); return;
            }
            FB.status.show('Discarded.', false);
            _cache = null; list.load();
          }).catch(function (e) { FB.status.show('Discard failed: ' + (e && e.message || e), true); });
        } }
    ]
  });
}

function cycleStatusFilter() {
  // Six-state cycle: proposed → rejected → orphans → partners → suggestions
  // → rejections → proposed. Class B ('orphans', 'partners', 'suggestions',
  // 'rejections') are filter sections, not the default (§10.2). bill_draft
  // is Class A and merged into the default 'proposed' view server-side, so
  // it needs no filter state of its own. 'bills'/'reconciliation' moved to
  // the notifications bell — neither carried an in-place decision, only an
  // "open elsewhere" verb.
  statusState = statusState === 'proposed' ? 'rejected'
    : statusState === 'rejected' ? 'orphans'
    : statusState === 'orphans' ? 'partners'
    : statusState === 'partners' ? 'suggestions'
    : statusState === 'suggestions' ? 'rejections'
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
        var text = v != null && v !== '' ? String(v) : '';
        return text !== '' ? esc(text) : '<span class="pe-ro">—</span>';
      } },
    { field: 'amount', align: 'right', filterType: 'amount', label: 'Amount',
      display: function (v, r) { return r._kind === 'group' ? '' : fmtAmt(r.amount); } },
    { field: 'source', filterType: 'list', label: 'Source',
      display: function (v, r) {
        if (r._kind === 'group') return '';
        return v != null && v !== '' ? esc(String(v)) : '<span class="pe-ro">—</span>';
      } },
    { field: 'created_by', filterType: 'text', label: 'Created by',
      display: function (v, r) { return r._kind === 'group' ? '' : (v != null && v !== '' ? esc(String(v)) : '<span class="pe-ro">—</span>'); } },
    { field: 'status', filterType: 'list', label: 'Status',
      display: function (v, r) {
        if (r._kind === 'group') return '';
        return statusBadge(r) + underlagBadge(r) + duplicateBadge(r);
      } }
  ],
  list: { fetch: fetchRows, map: function (row) { return row; } },
  rowStyle: function (r) { return r._kind === 'group' ? 'background:var(--bg)' : ''; },
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
    if (row._kind === 'partner') {
      // Class B partner proposal: a single meta child row — proposer, plus
      // the fuzzy-duplicate hint (issue #226) when present.
      // No lines, no underlag — the partner_proposals row is the source of truth.
      var partnerMeta = 'Proposed by ' + (row.created_by || '?');
      if (row.duplicate_warning) {
        var dw = row.duplicate_warning;
        var dwPct = Math.round((Number(dw.similarity) || 0) * 100);
        partnerMeta += ' — possible duplicate of "' + dw.name + '" (' + dwPct + '% similar)';
      }
      kids.push({ _key: row._key + ':meta', _childOf: row._key, _meta: partnerMeta });
    }
    if (row._kind === 'draft') {
      // Class A bill draft: a single meta child row with partner + bill info.
      // No underlag, no journal lines — the bill's own row is the source of truth.
      var draftMeta = esc(row.counterparty || '')
        + (row.reference ? ' · ref ' + esc(row.reference) : '')
        + (row.currency ? ' · ' + esc(row.currency) : '')
        + (row.created_by ? ' · created by ' + esc(row.created_by) : '');
      kids.push({ _key: row._key + ':meta', _childOf: row._key, _meta: draftMeta });
    }
    if (row._kind === 'suggestion') {
      // Class B mapping-rule suggestion: a single meta child row — proposer.
      // No lines, no underlag — mapping_suggestions is the source of truth.
      kids.push({ _key: row._key + ':meta', _childOf: row._key, _meta: 'Suggested by ' + (row.created_by || '?') });
    }
    if (row._kind === 'rejection') {
      // Class B input rejection: a single meta child row — flagged by.
      // No lines, no underlag — input_rejections is the source of truth.
      kids.push({ _key: row._key + ':meta', _childOf: row._key, _meta: 'Flagged by ' + (row.created_by || '?') });
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
      affordance: function () { return '<a class="chip chip-ok" title="approve (y)" aria-label="Approve" data-act="verb:y">&#10003;</a>'; },
      run: function (api, row) { review(row, 'approve'); } },
    { key: 'x', label: 'reject',
      when: function (row) { return row._kind === 'proposal' && row.status === 'proposed'; },
      affordance: function () { return '<a class="chip chip-cancel" title="reject (x)" aria-label="Reject" data-act="verb:x">&#10005;</a>'; },
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
    // Class B orphaned files (calendar-reminders-documents-spec.md §5.5):
    // v = view/download, x = delete (off disk). No app-managed quarantine —
    // download via v first if a copy is wanted, then delete.
    { key: 'v', label: 'view',
      when: function (row) { return row._kind === 'orphan'; },
      affordance: function () { return '<a class="chip" title="view (v)" aria-label="View" data-act="verb:v">&#128065;</a>'; },
      run: function (api, row) { window.open('/api/orphaned-file/' + row.orphan_id, '_blank'); } },
    { key: 'x', label: 'delete',
      when: function (row) { return row._kind === 'orphan'; },
      affordance: function () { return '<a class="chip chip-cancel" title="delete (x)" aria-label="Delete" data-act="verb:x">&#10005;</a>'; },
      run: function (api, row) { deleteOrphan(row); } },
    // Class B partner proposals (partner-proposal-spec §5): y/x mirror the
    // journal-batch review verbs but call partner.proposal.approve/reject
    // via reviewPartner()'s own (note-free) modal.
    { key: 'y', label: 'approve',
      when: function (row) { return row._kind === 'partner' && row.status === 'proposed'; },
      affordance: function () { return '<a class="chip chip-ok" title="approve (y)" aria-label="Approve" data-act="verb:y">&#10003;</a>'; },
      run: function (api, row) { reviewPartner(row, 'approve'); } },
    { key: 'x', label: 'reject',
      when: function (row) { return row._kind === 'partner' && row.status === 'proposed'; },
      affordance: function () { return '<a class="chip chip-cancel" title="reject (x)" aria-label="Reject" data-act="verb:x">&#10005;</a>'; },
      run: function (api, row) { reviewPartner(row, 'reject'); } },
    // Class A bill drafts (Option C amendment): y posts, x discards — same
    // "approve is the post" doctrine as journal proposals, different action.
    { key: 'y', label: 'post',
      when: function (row) { return row._kind === 'draft'; },
      affordance: function () { return '<a class="chip chip-ok" title="post (y)" aria-label="Post" data-act="verb:y">&#10003;</a>'; },
      run: function (api, row) { reviewDraft(row, 'post'); } },
    { key: 'x', label: 'discard',
      when: function (row) { return row._kind === 'draft'; },
      affordance: function () { return '<a class="chip chip-cancel" title="discard (x)" aria-label="Discard" data-act="verb:x">&#10005;</a>'; },
      run: function (api, row) { reviewDraft(row, 'delete'); } },
    // Class B mapping-rule suggestions (bank-matching-spec §10.4): y/x mirror
    // the partner-proposal review verbs but call mapping.suggestion.approve/
    // reject via reviewSuggestion()'s own (note-free) modal.
    { key: 'y', label: 'approve',
      when: function (row) { return row._kind === 'suggestion' && row.status === 'proposed'; },
      affordance: function () { return '<a class="chip chip-ok" title="approve (y)" aria-label="Approve" data-act="verb:y">&#10003;</a>'; },
      run: function (api, row) { reviewSuggestion(row, 'approve'); } },
    { key: 'x', label: 'reject',
      when: function (row) { return row._kind === 'suggestion' && row.status === 'proposed'; },
      affordance: function () { return '<a class="chip chip-cancel" title="reject (x)" aria-label="Reject" data-act="verb:x">&#10005;</a>'; },
      run: function (api, row) { reviewSuggestion(row, 'reject'); } },
    // Class B input rejections (bank-matching-spec §11.2): x = discard, wired
    // to input_rejection.discard — same key as every other row kind's
    // discard/reject verb on this page. r = retry is spec'd (correct the
    // data, re-run the cascade) but has no backing action or edit UI yet —
    // shown disabled rather than omitted, so the reserved slot is visible
    // instead of silently missing.
    { key: 'x', label: 'discard',
      when: function (row) { return row._kind === 'rejection'; },
      affordance: function () { return '<a class="chip chip-cancel" title="discard (x)" aria-label="Discard" data-act="verb:x">&#10005;</a>'; },
      run: function (api, row) { discardRejection(row); } },
    { key: 'r', label: 'retry (not yet built)',
      when: function (row) { return row._kind === 'rejection'; },
      affordance: function () { return '<span class="chip chip-disabled" title="retry: correct the data + re-run — not yet built" aria-label="Retry (not yet built)">&#8635;</span>'; },
      run: function () { FB.status.show('Retry is not built yet — discard (x) and re-submit corrected data instead.', true); } }
  ],
  actions: [
    { key: 'f', label: 'filter: proposed↔rejected↔orphans↔partners↔suggestions↔rejections', handler: function () { cycleStatusFilter(); } }
  ],
  onLoaded: function (saved) {
    var note = document.getElementById('queue-note');
    if (statusState === 'proposed') {
      var proposals = saved.filter(function (r) { return r._kind === 'proposal'; });
      var drafts = saved.filter(function (r) { return r._kind === 'draft'; });
      note.textContent = (proposals.length === 0 && drafts.length === 0)
        ? 'Nothing to review — agent-proposed journal batches and bill drafts will appear here'
        : proposals.length + ' proposed batch' + (proposals.length === 1 ? '' : 'es')
          + (drafts.length ? ' · ' + drafts.length + ' bill draft' + (drafts.length === 1 ? '' : 's') : '')
          + ' awaiting review (y approve/post · x reject/discard · Enter unfold)';
    } else if (statusState === 'rejected') {
      var rejected = saved.filter(function (r) { return r._kind === 'proposal'; });
      note.textContent = 'Rejected proposals (' + rejected.length + ') — f returns to the queue';
    } else if (statusState === 'orphans') {
      // Class B orphaned files view
      var orphans = saved.filter(function (r) { return r._kind === 'orphan'; });
      note.textContent = orphans.length + ' orphaned file' + (orphans.length === 1 ? '' : 's')
        + ' — v view · x delete · f cycles filters';
    } else if (statusState === 'partners') {
      // Class B partner proposals view (partner-proposal-spec §5)
      var partners = saved.filter(function (r) { return r._kind === 'partner'; });
      note.textContent = partners.length === 0
        ? 'No partner proposals awaiting review — f cycles filters'
        : partners.length + ' partner proposal' + (partners.length === 1 ? '' : 's') + ' awaiting review'
          + ' — y approve · x reject · f cycles filters';
    } else if (statusState === 'suggestions') {
      // Class B mapping-rule suggestions view (bank-matching-spec §10.4)
      var suggestions = saved.filter(function (r) { return r._kind === 'suggestion'; });
      note.textContent = suggestions.length === 0
        ? 'No mapping suggestions awaiting review — f cycles filters'
        : suggestions.length + ' mapping suggestion' + (suggestions.length === 1 ? '' : 's') + ' awaiting review'
          + ' — y approve · x reject · f cycles filters';
    } else {
      // Class B input rejections view (bank-matching-spec §11.2)
      var rejections = saved.filter(function (r) { return r._kind === 'rejection'; });
      note.textContent = rejections.length === 0
        ? 'No input rejections — f returns to the queue'
        : rejections.length + ' input rejection' + (rejections.length === 1 ? '' : 's')
          + ' — d discard (r retry not yet built) · f returns to the queue';
    }
  },
  hint: 'Inbox: action items awaiting review, grouped by type (y approve/post, x reject/discard, v/x view/delete an orphaned file, d discard an input rejection, Enter unfolds lines or folds a group). f cycles filters: proposed → rejected → orphans → partners → suggestions → rejections.'
});

list.load();
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleInboxPage };
